"""QQ 客户端操作（Python + uiautomation）—— 每一步都验证，不靠"没报错"。

## 五个必须知道的实测事实（都是踩出来的）
  1. **会话项在 depth 16** —— 读 10 层什么都拿不到（PowerShell 那条通道就这么栽的）。
  2. **切群必须 `SetActive()` 再 `InvokePattern.Invoke`**；但**已在目标群就绝不能再点**
     （再点会关掉会话，界面变无会话）。切群本身 0.06s。
  3. **输入框是 ProseMirror（contenteditable）**：没有 ValuePattern，
     `LegacyIAccessible.SetValue` 永远 ELEMENTNOTAVAILABLE ⇒ 只能键盘/粘贴。
  4. **`SetFocus()` 返回成功 ≠ 焦点到位**。不确认就粘贴，内容进不去，
     输入框一直空、发送按钮一直 `send--disabled`、消息根本发不出去，
     而旧代码还会打印「已粘贴」「输入框已清空 ✅ 发送成功」——全是假象。
     ⇒ 必须 `ensure_editor_focus()` 轮询 `GetFocusedControl()` 直到真的是输入框。
  5. **发送按钮真身**：`ButtonControl` + cls 含 `send-msg` + name='发送'
     （外面套一层 `send send--disabled` 的 GroupControl，别认那层）。
     按钮会因重绘瞬失（`-2147220992`），**每次重试都重新读树重新找**。

## 用法
  python tools/qq-py.py send   --hwnd H --group "群名" --text "..."
  python tools/qq-py.py switch --hwnd H --group "群名"
  python tools/qq-py.py focus  --hwnd H
  python tools/qq-py.py tree   --hwnd H [--depth 22]
  python tools/qq-py.py session --hwnd H
"""

import os
import sys
import time

import uiautomation as auto

auto.SetGlobalSearchTimeout(4.0)

CLS_ITEM = "recent-contact-item"
CLS_HEADER = "chat-header__contact-name"
CLS_EDITOR = "ExEditor-qq-msg-editor"
CLS_INFO = ("item__info", "list-item__info")


def arg(name, default=None):
    a = sys.argv
    if "--" + name in a:
        i = a.index("--" + name)
        if i + 1 < len(a):
            return a[i + 1]
    return default


def flag(name):
    """**不带值的开关**（`--dry` / `--no-switch` / `--verify`）在不在命令行里。

    ⚠️⚠️⚠️ 2026-11-20 加（发错群事故的深层根因）——
    `arg()` 是"取参数值"的：它要求 `--名字` **后面跟一个值**。
    而这三个开关都**不带值**，于是：
      · 开关在命令行**末尾** ⇒ 返回 None ⇒ **条件永远假** ⇒ 开关彻底失效 ✗
      · 开关在中途 ⇒ 会把**下一个参数**当成它的值 ⇒ 吃掉参数 ✗
    实测后果（2026-11-20 00:03 发错群）：
      `--no-switch` 一直失效 ⇒ 每次发送都走"自己切群"那条路
      ⇒ `do_switch` 静默失败时就把消息发到上一个群 ✗✗✗
    ⇒ 开关一律用 `flag()`，取值才用 `arg()` ✓
    """
    return ("--" + name) in sys.argv


def cls_of(c):
    try:
        return c.ClassName or ""
    except Exception:
        return ""


def name_of(c):
    try:
        return (c.Name or "").strip()
    except Exception:
        return ""


def walk(c, d=0, md=22, acc=None):
    if acc is None:
        acc = []
    if d > md:
        return acc
    try:
        ch = c.GetChildren()
    except Exception:
        return acc
    for x in ch:
        acc.append((d, x))
        walk(x, d + 1, md, acc)
    return acc


def find_one(nodes, keyword):
    for d, c in nodes:
        if keyword in cls_of(c):
            return c
    return None


def find_editor(win, nodes=None, tries=15, interval=0.2, depth=24):
    """找输入框；查不到就隔一会儿重读树，最多等 tries*interval 秒。

    ⚠️ 为什么要重试：**切群之后 QQ 会把整个聊天区重建**，输入框有几帧根本不在树里。
    实测（2026-11-17 23:0x）切群明明成功（标题已对上），紧接着读树却
    `ExEditor-qq-msg-editor` 直接缺席 ⇒ 一次查找就判 `❌ 找不到输入框`，
    把"其实下一秒就绪"的发送当成失败 ✗
    """
    if nodes is not None:
        ed = find_one(nodes, CLS_EDITOR)
        if ed is not None:
            return ed
    for i in range(tries):
        time.sleep(interval)
        try:
            ed = find_one(tree(win, depth), CLS_EDITOR)
        except Exception:
            ed = None
        if ed is not None:
            if i:
                print("  （输入框等了 %d 次才出现，%.1fs）" % (i + 1, (i + 1) * interval))
            return ed
    return None


def find_info(c, depth=0):
    if depth > 4:
        return None
    try:
        ch = c.GetChildren()
    except Exception:
        return None
    for x in ch:
        if any(k in cls_of(x) for k in CLS_INFO):
            return x
        g = find_info(x, depth + 1)
        if g is not None:
            return g
    return None


def name_of_item(c):
    """会话项的名字 = `item__info` 里的**第一个** TextControl（群名 / 人名）。

    ⚠️⚠️ 2026-11-15 修（**这是"消息生成了却发不出去"的真凶**）：
    原来这里拼接了 `item__info` 里**所有**文本 ⇒ 得到的是
    「摘要 + 时间 + 群名」这种大杂烩（实测：`的脸你捏了捏<主人>13:39示例服务器 2026`）。
    于是 `do_switch` 里那句 `group in x[0]` 全靠运气 ——
    群名一变（群里带成员昵称，昵称会变）就「没找到会话 → 切群失败，中止」，
    而 `qq-onebot.mjs` 的 `send_group_msg` 一 abort **消息就永久丢了** ✗
    （现象：思考链卡片上有完整回复，群里一个字都没有。）

    ✅ 正确取法：`item__info` 的**第一个** TextControl 就是群名/备注
    （和 `qq-sessions.py` 的口径一致，见它文件头那段说明）。
    """
    i = find_info(c)
    if i is None:
        return ""
    try:
        for x in i.GetChildren():
            if (x.ControlTypeName or "") == "TextControl":
                nm = (x.Name or "").strip()
                if nm:
                    return nm
    except Exception:
        pass
    return ""


def _fg():
    try:
        import ctypes

        return int(ctypes.windll.user32.GetForegroundWindow())
    except Exception:
        return 0


def _set_fg(h):
    """把窗口拉到前台。

    ⚠️ 这一版加了两个经典绕过手段，因为实测普通手段全部失效：
       · 裸 `SetForegroundWindow` —— 被拒（返回 false）
       · `AttachThreadInput` + `SetForegroundWindow` —— 仍然 False，前台纹丝不动
       · `SetWindowPos(TOPMOST)` + `SetForegroundWindow` —— 仍然 False
       现场：前台一直停在 `659456 'Chrome Legacy Window'`，
       那是 QQ 自己的 renderer 子窗口（不是顶层窗口），键盘事件进不去 ⇒ SendUnicodeChar 返回 0。

    ⇒ 加两个绕过：
       ① **模拟一次 ALT 键**（`keybd_event` VK_MENU 按下抬起）——
          这是解锁 Windows 前台锁的经典技巧：按下 ALT 后系统认为"用户在操作"，
          随后 2 秒内的 SetForegroundWindow 会被允许。
       ② `SwitchToThisWindow`（未文档化但有效，任务栏点击就是走它）。
    """
    try:
        import ctypes

        u = ctypes.windll.user32
        target = int(h)
        if u.GetForegroundWindow() == target:
            return True

        def try_switch():
            fg = u.GetForegroundWindow()
            tid_fg = u.GetWindowThreadProcessId(fg, None) if fg else 0
            tid_me = u.GetCurrentThreadId()
            attached = False
            if tid_fg and tid_fg != tid_me:
                attached = bool(u.AttachThreadInput(tid_me, tid_fg, True))
            u.BringWindowToTop(target)
            u.SetForegroundWindow(target)
            ok = u.GetForegroundWindow() == target
            if attached:
                u.AttachThreadInput(tid_me, tid_fg, False)
            return ok

        if try_switch():
            return True

        # ① 模拟 ALT 解锁前台
        VK_MENU = 0x12
        KEYEVENTF_KEYUP = 0x0002
        u.keybd_event(VK_MENU, 0, 0, 0)
        time.sleep(0.02)
        u.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0)
        time.sleep(0.05)
        if try_switch():
            return True

        # ② SwitchToThisWindow（任务栏点击同款）
        try:
            u.SwitchToThisWindow(target, True)
            time.sleep(0.1)
            if u.GetForegroundWindow() == target:
                return True
        except Exception:
            pass

        # ③ TOPMOST 来回
        u.SetWindowPos(target, -1, 0, 0, 0, 0, 0x0001 | 0x0002)
        u.SetForegroundWindow(target)
        ok = u.GetForegroundWindow() == target
        u.SetWindowPos(target, -2, 0, 0, 0, 0, 0x0001 | 0x0002)
        return ok
    except Exception:
        return False


def tree(win, md=22):
    return walk(win, 0, md)


def name_tokens(s):
    """群名拆词：`谷雨、Stby'Crs、Anon、Saki` → ['谷雨', "Stby'Crs", 'Anon', 'Saki']

    ⚠️ 为什么要拆：**群名里带成员昵称，而昵称和顺序都会变**。
    实测同一个小群：`state/group-names.json` 记的是「Anon、谷雨、Saki」，
    客户端会话列表显示「谷雨、Stby'Crs、Anon、Saki」——
    整串既不相等、也不互相包含 ⇒ 切群直接「没找到会话」⇒ **消息发不出去** ✗
    """
    import re

    parts = re.split(r"[、,，\s·|]+", str(s or "").strip())
    out = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        if re.fullmatch(r"[\W_]+", p):  # 纯符号的碎片（`|`、`-`）丢掉
            continue
        out.append(p)
    return out


def token_match(want, have, min_common=2, ratio=0.6):
    """两边拆词后：公共词 ≥2 个、且覆盖到短的那边 60% 以上 ⇒ 认为是同一个群。"""
    a = set(name_tokens(want))
    b = set(name_tokens(have))
    if len(a) < 2 or not b:
        return False
    common = len(a & b)
    return common >= min_common and common / min(len(a), len(b)) >= ratio


def _pick_item(items, group):
    """在会话项里挑目标：精确 → 包含 → 逐词。挑不到返回 None。

    ⚠️ 逐词那一级是 2026-11-15 加的（见 `name_tokens` 的注释）：
       群名里带成员昵称，昵称/顺序一变整串就对不上 ⇒ 没这一级会「切群失败」⇒ 消息发不出去。
    """
    for x in items:
        if x[0] == group:
            return x
    for x in items:
        if group and (group in x[0] or x[0] in group):
            return x
    for x in items:
        if token_match(group, x[0]):
            return x
    return None


def _session_list_scroll(nodes):
    """左侧**会话列表**的滚动容器。

    ⚠️ 只渲染看得见的那十几个会话 —— 目标不在屏上时，不滚过去永远找不到。
    """
    cands = []
    for d, c in nodes:
        k = cls_of(c)
        if "q-scroll-view" not in k:
            continue
        score = 0
        if "ml-container" in k:
            score += 2
        if "recent" in k.lower():
            score += 3
        if "scroll-view--show-scrollbar" in k:
            score -= 1  # 更像右侧成员列表
        cands.append((score, c))
    if not cands:
        return None
    cands.sort(key=lambda x: -x[0])
    return cands[0][1]


def scroll_session_list(win, quiet=False):
    """把会话列表往下滚一屏；返回"这次真的滚动了没有"。"""
    nodes = tree(win)
    sc = _session_list_scroll(nodes)
    if sc is None:
        if not quiet:
            print("  ⚠️ 没找到会话列表的滚动容器")
        return False
    try:
        sp = sc.GetScrollPattern()
        p = sp.VerticalScrollPercent  # ⚠️ ScrollPattern 没有 GetScrollPercent()，这是属性
        v = 0.0
        # ⚠️ `sp.VerticalScrollPercent` **本身就是 float**（不是对象）——
        # 原来写 `p.verticalPercent` 会在 float 上取属性，抛 AttributeError
        if p is not None and isinstance(p, (int, float)) and p >= 0:
            v = float(p)
        if v >= 99.0:
            if not quiet:
                print("  会话列表已经到底了")
            return False
        sp.SetScrollPercent(-1, min(100.0, v + 40.0))
        time.sleep(0.45)
        return True
    except Exception as e:
        if not quiet:
            print("  滚动失败(ScrollPattern)：%s" % str(e)[:60])
    # 退化：真实滚轮（把指针移到列表中间再滚，不动用户桌面 —— 这是 seat 里）
    try:
        r = sc.BoundingRectangle
        cx, cy = (r.left + r.right) // 2, (r.top + r.bottom) // 2
        # ⚠️ auto.WheelDown() **不接受任何参数**（times/x/y 全会抛 TypeError）
        #    今天在 qq-scroll-to-file.py 里踩过同一个坑 ⇒ 先挪指针再循环调用
        import ctypes as _ct
        _ct.windll.user32.SetCursorPos(int(cx), int(cy))
        time.sleep(0.1)
        for _ in range(3):
            auto.WheelDown()
        time.sleep(0.45)
        return True
    except Exception as e:
        if not quiet:
            print("  滚动失败(Wheel)：%s" % str(e)[:60])
    return False


def scroll_session_to_top(win, times=12):
    """把会话列表**滚回顶部** —— 目标群常常在第一屏，而 `scroll_session_list` 是往下滚的。

    2026-11-17：用户「现在已经滑到最下面了，那个群在很上面」—— 原来只往下滚，
    所以越找越远。切群前先拉回顶部。
    """
    nodes = tree(win)
    sc = _session_list_scroll(nodes)
    if sc is None:
        return False
    try:
        r = sc.BoundingRectangle
        cx = (r.left + r.right) // 2
        cy = (r.top + r.bottom) // 2
        import ctypes as _ct

        _ct.windll.user32.SetCursorPos(int(cx), int(cy))
        time.sleep(0.1)
        # ⚠️ auto.WheelUp() 不接受任何参数，只能循环调用
        for _ in range(times):
            auto.WheelUp()
        time.sleep(0.5)
        return True
    except Exception:
        return False


def do_switch(win, group, nodes=None, quiet=False):
    if nodes is None:
        _t = time.time()
        nodes = tree(win)
        print("⏱ 读树: %dms" % round((time.time() - _t) * 1000))
    hdr = find_one(nodes, CLS_HEADER)
    cur = name_of(hdr) if hdr else ""
    if cur and (group in cur or cur in group or token_match(group, cur)):
        if not quiet:
            print("已经在「%s」，不用切" % cur)
        return True, nodes

    try:
        win.SetActive(waitTime=0.02)
    except Exception:
        pass
    time.sleep(0.25)

    # ⚠️⚠️ 2026-11-16 加（用户：「再把给 do_switch 加滚动列表找会话也修了」）：
    #    会话列表只渲染**看得见**的那十几个 ⇒ 目标滚到下面去了就「没找到会话 → 中止」，
    #    而 `send_group_msg` 一中止**消息就永久丢**（卡片有正文、群里没有）。
    #    ⇒ 找不到就**往下滚一屏再找**，最多 8 屏。
    # ⚠️⚠️ 2026-11-17 16:30（用户：「只看在排在最上面可见的群，不翻页，我现在已经翻到最上面了」）：
    #    **不做任何滚动**。会话列表是虚拟滚动（滚出视口的项会从控件树里消失），
    #    "滚+找"要猜方向猜次数，实测能卡 5 分钟不返回。
    #    用户会把列表放在顶部 ⇒ 目标群就在当前屏 ⇒ 直接找可见项，找不到就明确失败。
    tried = 0
    while True:
        nodes = tree(win)
        items = [(name_of_item(c), c) for d, c in nodes if CLS_ITEM in cls_of(c)]
        hit = _pick_item(items, group)
        if hit is not None:
            break
        if True:
            if not quiet:
                print("❌ 没找到会话「%s」（滚了 %d 屏，当前屏上 %d 个）" % (group, tried, len(items)))
                print("   现有：")
                for nm0, _c0 in items:
                    print("     - %r" % (nm0,))
            return False, nodes
        tried += 1
        if not quiet:
            print("  ↕ 会话列表滚第 %d 屏…" % tried)

    nm, c = hit
    if not quiet:
        print("目标: %s" % nm)
    try:
        c.GetPattern(auto.PatternId.InvokePattern).Invoke(waitTime=0.02)
    except Exception as e:
        if not quiet:
            print("⚠️ Invoke 失败: %s" % e)
        return False, nodes

    time.sleep(1.2)
    nodes = tree(win)
    hdr = find_one(nodes, CLS_HEADER)
    actual = name_of(hdr) if hdr else ""
    ok = group in actual or actual in group or token_match(group, actual)
    if not quiet:
        print("验证: 标题=%r ⇒ %s" % (actual, "✅ 对上了" if ok else "❌ 不是目标群"))
    return ok, nodes


def ensure_editor_focus(win, ed, tries=14):
    """确保前台是 QQ 主窗口。

    ## 最终定论（第 15 轮实测，别改回去）
       ed.SetFocus() 会把前台从主窗口（1902218）切到 659456 'Chrome Legacy Window'，
       而切走之后 SendUnicodeChar 就打不进去 —— 它返回 1，但输入框里没东西、
       发送按钮仍然是 send--disabled。

       实测对照：
         · 前台=1902218（主窗口） → 不调 SetFocus 直接打 → 内容能进去
         · 调了 SetFocus → 前台变 659456 → 打不进去

    => 正确策略：前台已经是 QQ 主窗口时，直接返回，什么都别调。
       只有前台真的不对时才拉回；SetFocus 只作最后手段，且调完必须再拉回主窗口。
    """
    qq_pid = 0
    qq_hwnd = 0
    try:
        import ctypes

        qq_hwnd = int(win.NativeWindowHandle or 0)
        _p = ctypes.c_uint()
        ctypes.windll.user32.GetWindowThreadProcessId(qq_hwnd, ctypes.byref(_p))
        qq_pid = _p.value
    except Exception:
        pass

    def fg_hwnd():
        try:
            import ctypes

            return int(ctypes.windll.user32.GetForegroundWindow() or 0)
        except Exception:
            return 0

    def fg_is_qq():
        if not qq_pid:
            return True
        h = fg_hwnd()
        if not h:
            return False
        try:
            import ctypes

            _p = ctypes.c_uint()
            ctypes.windll.user32.GetWindowThreadProcessId(h, ctypes.byref(_p))
            return _p.value == qq_pid
        except Exception:
            return False

    # ① 前台已经是 QQ 主窗口 => 只要再确认**焦点在输入框里**。
    #
    # ⚠️⚠️ 2026-11-16（用户：「发送失败」查到这里）：
    #    `auto.SendUnicodeChar(ch)` 是「发给**当前焦点控件**」，**不是**"发给 ed"。
    #    而这里原来是「前台是主窗口 ⇒ 直接 return True」——
    #    **只保证前台对，不保证焦点在输入框**。
    #    于是：前台=主窗口 ✓、焦点却停在某条消息/群公告上
    #    ⇒ SendUnicodeChar 返回 1（说成功）、字符一个没进框
    #    ⇒ 发送按钮根本不渲染 ⇒ 报「发送按钮点不到」✗
    #    （实测：`已输入 6/6 字，框内=''` + 「现有按钮 45 个里没有"发送"」）
    if qq_hwnd and fg_hwnd() == qq_hwnd:
        try:
            fc = auto.GetFocusedControl()
            cur = fc
            for _ in range(8):
                if cur is None:
                    break
                if cur is ed:
                    return True
                k = cls_of(cur)
                if k and ("chat-input" in k or "ql-editor" in k or "ProseMirror" in k):
                    return True
                cur = cur.GetParentControl()
        except Exception:
            pass
        # 焦点不在输入框 ⇒ **真实点一下输入框中心**（seat 里的鼠标，不碰用户桌面）
        try:
            r = ed.BoundingRectangle
            cx2 = (r.left + r.right) // 2
            cy2 = (r.top + r.bottom) // 2
            auto.Click(cx2, cy2, waitTime=0.08)
            time.sleep(0.15)
        except Exception:
            pass
        return True

    # ② 前台是 QQ 的其他窗口 => 用真实鼠标点标题栏把主窗口拉回来
    if fg_is_qq() and qq_hwnd:
        try:
            import ctypes

            u = ctypes.windll.user32
            wr = win.BoundingRectangle
            cx = (wr.left + wr.right) // 2
            cy = wr.top + 20
            pt = ctypes.wintypes.POINT()
            u.GetCursorPos(ctypes.byref(pt))
            ox, oy = pt.x, pt.y
            u.SetCursorPos(cx, cy)
            time.sleep(0.1)
            u.mouse_event(0x0002, 0, 0, 0, 0)
            time.sleep(0.04)
            u.mouse_event(0x0004, 0, 0, 0, 0)
            time.sleep(0.35)
            u.SetCursorPos(ox, oy)
            if fg_hwnd() == qq_hwnd:
                return True
        except Exception:
            pass

    # ③ 兜底：SetFocus + SetForegroundWindow
    for _i in range(min(tries, 5)):
        try:
            ed.SetFocus()
            _set_fg(qq_hwnd)
        except Exception:
            pass
        time.sleep(0.1)
        if fg_hwnd() == qq_hwnd:
            return True
    return fg_is_qq()


def editor_text(ed):
    """读输入框文本。
    ⚠️ **不可靠**：TextPattern 会返回陈旧值 —— 实测输入框明明空了，它仍返回 '@@'。
       只能用来"大致判断有没有内容"，绝不能当"清空成功/失败"的判据。
       可靠判据见 editor_is_empty()。
    """
    try:
        tp = ed.GetPattern(auto.PatternId.TextPattern)
        if tp:
            return (tp.DocumentRange.GetText(-1) or "").strip()
    except Exception:
        pass
    return None


def editor_is_empty(win, ed=None):
    """判断输入框空不空 —— **只看发送按钮的 disabled 状态**。

    ⚠️ 这是唯一可靠的判据：
       QQ 的发送按钮外面套着 `<div class="send send--disabled">`，
       输入框为空时是 `send--disabled`，有内容时是 `send`。
       （实测：输入框空着但 TextPattern 返回 '@@'，只有这个 class 说实话。）
    """
    for d, c in tree(win, 26):
        k = cls_of(c)
        if "send--disabled" in k:
            return True
        if k == "send" or k.startswith("send "):
            # 有 send 但没有 send--disabled ⇒ 有内容
            if "disabled" not in k:
                return False
    # 读不到就保守认定"非空"（让它继续清）
    return False


def find_send_button(win, hwnd=None):
    """找发送按钮。

    ⚠️ **每次都要重新 `ControlFromHandle`**：QQ 在输入框内容变化后会重绘那块，
       上一轮拿到的 `win` 及其子孙元素全部失效 ⇒ `Invoke` 报
       `ELEMENTNOTAVAILABLE (-2147220992)`。实测复用旧句柄连续 4~10 次全失败。
    ⚠️ 读树是 424ms/次（711 节点），所以**只读一次**，别在循环里重读。
    """
    try:
        root = auto.ControlFromHandle(int(hwnd)) if hwnd else win
    except Exception:
        root = win
    if root is None:
        return None
    for d, c in walk(root, 0, 26):
        try:
            if (c.ControlTypeName or "") != "ButtonControl":
                continue
            if name_of(c) == "发送" or "send-msg" in cls_of(c):
                return c
        except Exception:
            continue
    return None


def verify_in_group(win, text, limit=20):
    """在群里搜一下有没有这条消息（用消息气泡里的 TextControl 判断）"""
    needle = (text or "").strip()[:10]
    if not needle:
        return False
    try:
        for d, c in tree(win, 34):
            try:
                if (c.ControlTypeName or "") != "TextControl":
                    continue
                if needle in (c.Name or ""):
                    return True
            except Exception:
                continue
    except Exception:
        pass
    return False


def cmd_send(hwnd, group, text):
    t_start = time.time()
    hwnd = int(hwnd)
    win = auto.ControlFromHandle(hwnd)
    if win is None:
        print("❌ 拿不到窗口")
        return 1
    original = _fg()
    try:
        nodes = tree(win)
        # ⚠️ 2026-11-17 21:20：`--no-switch` = 调用方已经让 daemon 切好了（握手），
        #    这里只验证 header 对不对，**不再自己切群**（省 3 秒）。
        if flag("no-switch"):
            hdr = ""
            for _d, _c in nodes:
                if "chat-header" in cls_of(_c):
                    hdr = name_of(_c)
                    if hdr:
                        break
            # ⚠️⚠️ 2026-11-20 修（同一天的发错群事故）——
            #    原来是 `if hdr and group not in hdr and ...`：**读不到 header（hdr 为空）
            #    就跳过校验、直接发** ✗ —— 而"读不到 header"恰恰是最危险的时刻
            #    （切群中/渲染中/窗口异常），这时候根本不知道界面停在哪个群。
            #    ⇒ 读不到也中止：宁可这一条发不出去，也绝不发到错的群 ✓
            if not hdr:
                print("❌ --no-switch 但读不到 chat-header（不知道界面在哪）⇒ 中止，宁可不发")
                return 1
            if group not in hdr and hdr not in group:
                print("❌ --no-switch 但界面在「%s」不是「%s」，中止" % (hdr, group))
                return 1
            print("目标: %s（--no-switch，界面已在）" % group)
        else:
            ok, nodes = do_switch(win, group, nodes)
            if not ok:
                print("❌ 切群失败，中止")
                return 1
            # ⚠️⚠️⚠️ 2026-11-20 修（用户：「我靠刚才消息为什么发错群了」，00:03 当场遇到）——
            #    **`do_switch` 返回 ok 不等于真的切过去了**（daemon 那边早记过同样的教训：
            #    「判对了 示例服务器 2026、do_switch 返回成功，但界面还在「湖工」」）。
            #    `--no-switch` 那条路会复查 header，**"自己切群"这条路却只信返回值**
            #    ⇒ 切群静默失败时就把消息**发到上一个群** ✗✗✗
            #    实测触发链：握手超时 → `😐 daemon 没在 3 秒内切好，走老路自己切`
            #    → 走这段 → 没校验 → 发错群。
            #    ⇒ 切完必须复查 header；**对不上就中止**（宁可不发，也绝不发错群）。
            #    ⚠️ 只查一次不够：QQ 切群是异步的，header 要几百毫秒才换 ⇒ 最多重试 6 次
            #      （每 0.3 秒一次，共 1.8 秒），一旦对上就立刻继续 ✓
            _hdr_ok = False
            _hdr = ""
            for _try in range(6):
                _hdr = ""
                for _d, _c in tree(win, 24):
                    if "chat-header" in cls_of(_c):
                        _hdr = name_of(_c)
                        if _hdr:
                            break
                if _hdr and (group in _hdr or _hdr in group):
                    _hdr_ok = True
                    break
                time.sleep(0.3)
            if not _hdr_ok:
                print("❌ 切群没生效（要到「%s」，实际「%s」）⇒ **中止，绝不发到错的群**"
                      % (group, _hdr or "（空）"))
                return 1
            print("目标: %s（自己切群，header 已校验）" % group)

        _t = time.time()
        ed = find_editor(win, nodes)
        print("⏱ 找输入框: %dms" % round((time.time() - _t) * 1000))
        if ed is None:
            print("❌ 找不到输入框（重读树等了 3 秒也没有）")
            return 2

        # ① 焦点确认
        _t = time.time()
        if not ensure_editor_focus(win, ed):
            print("❌ 拿不到输入框焦点（打字会打空，中止）")
            return 3

        # ② 清空输入框
        #    ⚠️ **判据只看发送按钮的 send--disabled**（见 editor_is_empty 的注释）——
        #       用 TextPattern 读回会被陈旧值骗：实际空了却报 '@@'，于是"清不空"永远失败。
        def clear_editor():
            if editor_is_empty(win, ed):
                return True
            ensure_editor_focus(win, ed, tries=5)
            # ① 逐字退格
            txt = editor_text(ed) or ""
            for _i in range(len(txt) + 6):
                try:
                    auto.SendKeys("{Back}", waitTime=0.01)
                except Exception:
                    break
                time.sleep(0.006)
            time.sleep(0.25)
            if editor_is_empty(win, ed):
                return True
            # ② Ctrl+A + Back
            ensure_editor_focus(win, ed, tries=4)
            try:
                auto.SendKeys("{Ctrl}a{Back}", waitTime=0.03)
            except Exception:
                pass
            time.sleep(0.3)
            if editor_is_empty(win, ed):
                return True
            # ③ 切走再切回（彻底重置）
            print("  （切会话重置输入框）")
            for nm, c in [(name_of_item(c), c) for d, c in tree(win, 22) if CLS_ITEM in cls_of(c)]:
                if nm and nm != group:
                    try:
                        c.GetPattern(auto.PatternId.InvokePattern).Invoke(waitTime=0.02)
                        time.sleep(1.2)
                    except Exception:
                        pass
                    break
            try:
                do_switch(win, group, quiet=True)
            except Exception:
                pass
            time.sleep(0.8)
            return editor_is_empty(win, ed)

        print("⏱ 聚焦总: %dms" % round((time.time() - _t) * 1000))
        _t = time.time()
        if not clear_editor():
            print("❌ 输入框清不空，中止以免发错内容")
            return 3
        print("✅ 输入框已清空")

        print("⏱ 清空输入框: %dms" % round((time.time() - _t) * 1000))
        _t = time.time()
        # ⚠️⚠️ 2026-11-21 加**引用**（「引用发送」）——
        #    客户端方案没有 OneBot 的引用回复，只能走 UI：
        #    **右键气泡 → 菜单「引用」→ 输入框上方出现引用条** ⇒ 然后照常打字发送 ✓
        #    ⚠️ 必须点在**气泡**上：右键头像 = 群成员菜单、右键空白 = 只有「清屏」✗
        #    （实测见 `tools/qq-quote.py` 顶部那段说明）
        #    ⚠️ 位置：**清空之后、打字之前** —— 引用条要在输入框空的时候挂上去，
        #      顺序反了会被"清空"连带清掉 ✓
        _quote = arg('quote')
        if _quote:
            try:
                import importlib.util as _ilu

                _qp = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'qq-quote.py')
                _spec = _ilu.spec_from_file_location('qq_quote_mod', _qp)
                _qm = _ilu.module_from_spec(_spec)
                _spec.loader.exec_module(_qm)
                _hit = _qm.apply_quote(win, _quote, log=print)
                if not _hit:
                    print("⚠️ 引用没挂上（找不到目标 / 菜单没有「引用」）⇒ 照常发普通消息")
                else:
                    print("✅ 引用已挂上：%r" % (_hit.get('text', '')[:24],))
            except Exception as _e:
                print("⚠️ 引用出错（照常发普通消息）：" + str(_e)[:80])
        _t = time.time()
        # ③ 逐字输入（QuitBot 的做法）
        #    ⚠️ 不用 `SendKeys(整串)`：实测会重复、会吞字、清不干净。
        #    逐字：每个字符前 confirm 焦点 + 用 SendUnicodeChar（返回插入事件数，0=被阻塞）。
        typed = 0
        try:
            # ⚠️⚠️ 2026-11-17 23:26 **回退提速**（真事故）：
            #    22:18 试过"只在开始时确认焦点"，结果 `SendUnicodeChar` 返回非 0、
            #    但**输入框是空的**（`已输入 7/7 字，框内=''`）⇒ 发送全失败 `exit code 4` ✗
            #    文件头第 15 轮实测早就说过：`SendUnicodeChar` 发给**当前焦点控件**，
            #    焦点一飘它照样返回 1、字一个没进框 ⇒ **每字必须确认**。
            #    慢 1.1 秒，但能发出去更重要。
            for ch in text:
                if not ensure_editor_focus(win, ed, tries=6):
                    print("⚠️ 第 %d 字时焦点丢了（已输入 %d 字）" % (typed + 1, typed))
                    break
                n = auto.SendUnicodeChar(ch)
                if not n:
                    print("⚠️ 第 %d 字被输入流阻塞（已输入 %d 字）" % (typed + 1, typed))
                    time.sleep(0.15)
                    if not ensure_editor_focus(win, ed, tries=6):
                        break
                    n = auto.SendUnicodeChar(ch)
                if n:
                    typed += 1
                time.sleep(0.012)
        except Exception as e:
            print("⚠️ 逐字输入出错: %s" % e)
        # 确认内容真的在里面（⚠️ 用 editor_is_empty，不用 TextPattern）
        # ⚠️ **不要因为这里判定失败就 return 3** —— 实测有假阴性：
        #    `SendUnicodeChar` 返回 0（说被阻塞），但内容其实进去了，
        #    后续点发送照样能发出去（自测里【2】【3】就是这么"假失败"的）。
        #    ⇒ 这里只告警，不中止；真正的判据放在最后"群里能不能搜到"。
        if editor_is_empty(win, ed):
            cur = editor_text(ed) or ""
            print("⚠️ 输入检查没通过（已输入 %d/%d 字，框内=%r）—— 继续尝试发送" % (typed, len(text), cur[:24]))
        else:
            print("✅ 输入已确认落进输入框（%d 字）" % typed)
        time.sleep(0.2)

        # ④ 发送：**点发送按钮**（`InvokePattern.Invoke`）
        #    ⚠️ 实测结论（别再改回回车）：
        #      · `Invoke` 点 send-msg **有效**（群里真能看到消息，已验证）
        #      · `{Enter}` / `{Ctrl}{Enter}` **无效**（输入框内容原样不动，消息不发）
        #    ⚠️ **性能**：读树 424ms/次，所以按钮**只读一次树**找到后复用；
        #      只有 Invoke 报元素瞬失时才重读（最多 3 次，不是 10 次）。
        print("⏱ 打字: %dms" % round((time.time() - _t) * 1000))
        # ⚠️ 2026-11-18 加：`--dry` = **只测到打字完成，不点发送**，测完把输入框清干净。
        #    用来量化"找输入框 / 清空 / 聚焦 / 打字"各段耗时，**不会往任何群里发东西** ✓
        if flag("dry"):
            _t2 = time.time()
            _btn = find_send_button(win, hwnd)
            print("⏱ [dry] 找发送按钮: %dms（%s）" % (
                round((time.time() - _t2) * 1000), "找到了" if _btn else "没找到"))
            _t3 = time.time()
            _ok = clear_editor()
            print("⏱ [dry] 清空输入框: %dms（%s）" % (
                round((time.time() - _t3) * 1000), "空" if _ok else "没清空"))
            print("✅ [dry] 完成，未发送｜总耗时 %.1fs" % (time.time() - t_start))
            return 0

        # ⚠️⚠️⚠️ 2026-11-20 加（用户：「我靠刚才消息为什么发错群了」）——
        #    **点发送前最后确认一次群对不对**。
        #    "清空 + 打字"要 2 秒左右，这期间界面有可能被 daemon 切走
        #    （hold 理论上挡得住，但实测 hold 有空档）。一旦被切走，
        #    框里这段字就会**发到另一个群** ✗✗
        #    前面那两道校验都在**打字之前**，管不到这 2 秒 ⇒ 必须补这一道 ✓
        #    ⚠️ 宁可白打一次（这条发失败），也绝不发错群 ✓
        _hdr_send = ""
        for _d, _c in tree(win, 24):
            if "chat-header" in cls_of(_c):
                _hdr_send = name_of(_c)
                if _hdr_send:
                    break
        if not _hdr_send or (group not in _hdr_send and _hdr_send not in group):
            print("❌ 发送前复查：界面在「%s」不是「%s」⇒ 中止（字已打入，但绝不发错群）"
                  % (_hdr_send or "（读不到）", group))
            try:
                clear_editor()
            except Exception:
                pass
            return 1
        _t = time.time()
        btn = find_send_button(win, hwnd)   # 一次读树
        sent = False
        for attempt in range(6):
            if btn is None:
                time.sleep(0.25)
                btn = find_send_button(win, hwnd)
                if btn is None:
                    continue
            try:
                btn.GetPattern(auto.PatternId.InvokePattern).Invoke(waitTime=0.02)
                print("✅ 点发送按钮（第%d次，InvokePattern，不动鼠标）" % (attempt + 1))
                sent = True
                break
            except Exception as e:
                msg = str(e)
                if ("-2147220992" in msg or "80040200" in msg) and attempt < 3:
                    time.sleep(0.2)
                    btn = find_send_button(win, hwnd)   # 元素失效才重读
                    continue
                print("⚠️ 点按钮失败(%s)" % msg[:40])
                break
        if not sent:
            print("❌ 发送按钮点不到（中止）")
            # ⚠️⚠️ 2026-11-16：**失败时必须能看出"当时界面长什么样"**。
            #    这个错偶发实测有 50% 失败率（同一个群、同样的代码，19:21 成功、19:34 失败），
            #    光看"点不到"根本没法定位是"按钮没渲染"还是"class/名字变了" ✗
            try:
                cand = []
                for d, c in walk(win, 0, 26):
                    if (c.ControlTypeName or "") == "ButtonControl":
                        cand.append({"name": name_of(c)[:20], "cls": cls_of(c)[:50]})
                print("   现有按钮（%d 个）：%s" % (len(cand), cand[:10]))
            except Exception as e:
                print("   列举按钮也失败了：%s" % str(e)[:60])
            # 输入框里到底是什么（内容没进去的话按钮永远是 disabled）
            try:
                ed = None
                for d, c in walk(win, 0, 26):
                    k = cls_of(c)
                    if "chat-input" in k or "ql-editor" in k or "ProseMirror" in k:
                        ed = c
                        break
                print("   输入区 cls=%r 文本=%r" % (cls_of(ed)[:40] if ed is not None else "", (name_of(ed) if ed is not None else "")[:40]))
            except Exception:
                pass
            return 4
        print("⏱ 找发送按钮+点: %dms" % round((time.time() - _t) * 1000))
        # ⚠️⚠️ 2026-11-17 21:15（用户选「①提速」）：
        #    原来点完发送要等 `verify_in_group`（读整棵树找文字，最多 6 次 ≈ 4 秒），
        #    那 4 秒纯粹是"确认"，消息早就发出去了 ⇒ 用户感知的"生成完 5 秒才发出"主要就是它。
        #    ⇒ **默认不再等**，点完就返回成功；要验证加 `--verify`。
        if not flag("verify"):
            dt = time.time() - t_start
            print("✅ 已点发送（不等验证）｜总耗时 %.1fs" % dt)
            return 0

        time.sleep(0.5)

        # ⑤ 验证（只在 --verify 时跑）：真正可靠的判据是"群里能不能搜到"
        #    ⚠️ 不能用"输入框空"当判据：实测 QQ 发完**根本不回清输入框**，
        #       而且 TextPattern 读回是陈旧值（空了还报 '@@'）。
        in_group = False
        for _ in range(6):
            time.sleep(0.4)
            if verify_in_group(win, text):
                in_group = True
                break
        dt = time.time() - t_start
        print("验证: 群里%s ｜总耗时 %.1fs" % ("能找到 ✅" if in_group else "未确认 ⚠️", dt))
        print("结果:", "✅ 发送成功" if in_group else "⚠️ 不确定（建议人工看一眼）")
        return 0 if in_group else 5
    finally:
        if original and original != int(hwnd):
            _set_fg(original)


def find_qq_hwnd():
    """找 QQ 主窗口句柄 —— **不能写死**，seat 里的 QQ 每次重启句柄都会变。"""
    try:
        for w in auto.GetRootControl().GetChildren():
            try:
                if "Chrome_WidgetWin" not in (w.ClassName or ""):
                    continue
                if not (w.Name or "").startswith("QQ"):
                    continue
                r = w.BoundingRectangle
                if (r.right - r.left) > 400:
                    return int(w.NativeWindowHandle or 0)
            except Exception:
                continue
    except Exception:
        pass
    return 0


def resolve_hwnd(hwnd):
    """传进来的 hwnd 失效（QQ 重启过）就自己找一个。

    ⚠️ 为什么需要：适配器启动时只探测一次 hwnd，而 QQ 重启（含 daemon 自愈重启）
    之后那个句柄就作废了 ⇒ 发送会全部失败在「拿不到窗口」。实测 2026-11-17。
    """
    h = int(hwnd or 0)
    if h:
        try:
            if auto.ControlFromHandle(h) is not None:
                return h
        except Exception:
            pass
        print("⚠️ hwnd=%d 已失效（QQ 可能重启过），自动找新的…" % h, flush=True)
    found = find_qq_hwnd()
    if found:
        print("✅ 自动找到 QQ：hwnd=%d" % found, flush=True)
    return found


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    cmd = sys.argv[1]
    hwnd = resolve_hwnd(arg("hwnd"))
    if not hwnd:
        print("❌ 找不到 QQ 窗口（--hwnd 也没给）")
        return 1
    if cmd == "send":
        return cmd_send(hwnd, arg("group", ""), arg("text", ""))

    win = auto.ControlFromHandle(int(hwnd))
    if win is None:
        print("❌ 拿不到窗口")
        return 1
    if cmd == "switch":
        ok, nodes = do_switch(win, arg("group", ""))
        if not ok:
            for nm, _ in [(name_of_item(c), c) for d, c in nodes if CLS_ITEM in cls_of(c)][:10]:
                print("  现有: " + nm[:40])
        return 0 if ok else 1
    if cmd == "focus":
        nodes = tree(win, 24)
        ed = find_editor(win, nodes)
        if ed is None:
            print("❌ 找不到输入框")
            return 1
        ok = ensure_editor_focus(win, ed)
        print(("✅ 焦点确认到位" if ok else "❌ 拿不到焦点（不动鼠标）"))
        return 0 if ok else 2
    if cmd == "tree":
        depth = int(arg("depth", "22")) or 22
        nodes = tree(win, depth)
        from collections import Counter

        cnt = Counter()
        for d, c in nodes:
            k = cls_of(c).strip()
            if k:
                cnt[k] += 1
        print("节点数(深度%d): %d" % (depth, len(nodes)))
        for k, v in cnt.most_common(12):
            print("  %3d  %s" % (v, k[:65]))
        for kw in (CLS_HEADER, CLS_EDITOR):
            print("  %s: %s" % (kw, "✅" if find_one(nodes, kw) else "❌"))
        print("  发送按钮: %s" % ("✅" if find_send_button(win, hwnd) else "❌"))
        return 0
    if cmd == "session":
        nodes = tree(win, 24)
        hdr = find_one(nodes, CLS_HEADER)
        ed = find_one(nodes, CLS_EDITOR)
        print("会话标题: %r" % (name_of(hdr) if hdr else None))
        print("输入框: %s" % ("✅" if ed else "❌"))
        if ed:
            print("输入框内容: %r" % ((editor_text(ed) or "")[:60],))
        return 0
    if cmd == "verify":
        """在整棵树里搜一段文字（不依赖 --limit），用来自测"消息到底发出去没有"。
        ⚠️ 不要拿"输入框清空"当发送成功的判据 —— 实测 QQ 发完不回清输入框。
        """
        needle = (arg("text", "") or "").strip()
        if not needle:
            print("NOTFOUND（没给 --text）")
            return 2
        found = False
        for d, c in tree(win, 34):
            try:
                if (c.ControlTypeName or "") != "TextControl":
                    continue
                if needle in (c.Name or ""):
                    found = True
                    break
            except Exception:
                continue
        print("FOUND" if found else "NOTFOUND")
        return 0 if found else 1
    print("未知命令: " + cmd)
    return 1


if __name__ == "__main__":
    sys.exit(main())
