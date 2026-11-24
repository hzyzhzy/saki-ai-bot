# qq-quote.py —— 在客户端里「引用某条消息 + 打字 + 发送」
"""
## 为什么需要它
客户端方案没有 OneBot 的「引用回复」：
QQ 里对应的是**右键某条消息 → 菜单「引用」→ 输入框出现引用框 → 打字 → 发送**。

## 实测结构（2026-11-21，QQ NT 9.9.33）
- 右键**头像** ⇒ 群成员菜单（屏蔽/举报/加好友/查看资料/戳一戳/TA/发送消息）
- 右键**整行容器**（含空白）⇒ 只有「清屏」
- 右键**气泡本身**（`message-content` / `msg-content-container`）⇒ **消息菜单** ✓
    `删除 / 打开文件夹 / 另存为 / 引用 / 多选 / 收藏 / 转发 / 复制 / 添加到表情`
  ⇒ **必须点在气泡上**，点空白就变成"清屏" ✗

## 用法
    python qq-quote.py --hwnd 394768 --quote "要引用谁/哪句" --text "要说的话"
    python qq-quote.py --hwnd 394768 --quote-probe        # 只列候选消息，不动手

⚠️ `--quote` 先按**昵称**匹配，匹配不到再按**内容片段**匹配（都是"最后一条命中的"，
   因为引用通常指向最近那句）。
⚠️ 不点发送 = 安全；`--text` 给了才真发。
"""

import ctypes
import json
import sys
import time

import uiautomation as auto


def arg(name, default=''):
    a = sys.argv
    for i, x in enumerate(a):
        if x == '--' + name and i + 1 < len(a):
            return a[i + 1]
    return default


def has(name):
    return ('--' + name) in sys.argv


def cls_of(c):
    try:
        return c.ClassName or ''
    except Exception:
        return ''


def name_of(c):
    try:
        return (c.Name or '').strip()
    except Exception:
        return ''


def rect_of(c):
    try:
        r = c.BoundingRectangle
        return [r.left, r.top, r.right, r.bottom]
    except Exception:
        return None


def walk(c, md):
    out = []
    stack = [(0, c)]
    while stack:
        d, x = stack.pop()
        if d > md:
            continue
        out.append((d, x))
        try:
            for ch in x.GetChildren():
                stack.append((d + 1, ch))
        except Exception:
            pass
    return out


def right_click(x, y):
    u = ctypes.windll.user32
    u.SetCursorPos(int(x), int(y))
    time.sleep(0.12)
    u.mouse_event(0x0008, 0, 0, 0, 0)  # RIGHTDOWN
    time.sleep(0.04)
    u.mouse_event(0x0010, 0, 0, 0, 0)  # RIGHTUP
    time.sleep(1.0)


def esc():
    u = ctypes.windll.user32
    u.keybd_event(0x1B, 0, 0, 0)
    time.sleep(0.04)
    u.keybd_event(0x1B, 0, 2, 0)
    time.sleep(0.35)


def find_menu_item(win, key):
    """在主窗口树里找右键菜单项（菜单在渲染层，不在顶层窗口）。"""
    for d, c in walk(win, 30):
        if 'q-context-menu-item' in cls_of(c) and name_of(c) == key:
            return c
    return None


def list_messages(win):
    """返回 [(bubble_center_x, bubble_center_y, 整行文本, 昵称)]，按屏幕从上到下。

    ⚠️ 只收**气泡**（`msg-content-container` / `message-content__wrapper`），
      不收整行 `message-container`（那个含空白，右键会变成"清屏"）✗
    """
    nodes = walk(win, 26)
    out = []
    for d, c in nodes:
        k = cls_of(c)
        if 'msg-content-container' not in k and 'message-content__wrapper' not in k:
            continue
        r = rect_of(c)
        if not r or (r[2] - r[0]) < 30 or (r[3] - r[1]) < 14:
            continue
        # 这条消息里所有文本（拼起来给匹配用）
        txt = []
        nick = ''
        for d2, x in walk(c, 10):
            t = name_of(x)
            if t:
                txt.append(t)
        joined = ' '.join(txt)
        # 昵称：往外层找 avatar-span 的 Name
        try:
            p = c
            for _ in range(6):
                p = p.GetParentControl()
                if p is None:
                    break
                for d3, x3 in walk(p, 8):
                    if 'avatar-span' in cls_of(x3):
                        nick = name_of(x3)
                        break
                if nick:
                    break
        except Exception:
            pass
        out.append(((r[0] + r[2]) // 2, (r[1] + r[3]) // 2, joined, nick, r))
    # ⚠️ 同一条消息会被两个类名各收一次（`msg-content-container` + `message-content__wrapper`，
    #    实测 42 条里一半是重复）⇒ 按 rect 去重（同位置同尺寸算同一条）✓
    seen = set()
    uniq = []
    for it in out:
        key = tuple(it[4])
        if key in seen:
            continue
        seen.add(key)
        uniq.append(it)
    out = uniq
    out.sort(key=lambda t: t[4][1])
    return out


def apply_quote(win, want, log=print):
    """在已打开的会话里**引用某条消息**：右键气泡 → 点「引用」。

    供 `qq-py.py send --quote` 调用（那样"引用 + 打字 + 发送"是一条龙）✓

    @return dict | None —— 成功返回 {nick, text, rect}，失败返回 None（调用方照常发普通消息）
    ⚠️ 不抛异常：引用失败**不该挡住发送** —— 引用是锦上添花，消息本身才是主体 ✓
    """
    try:
        esc()  # 先清掉可能残留的菜单
        msgs = list_messages(win)
        if not msgs:
            log('引用：这个会话里读不到任何消息气泡')
            return None
        # 先按昵称、再按内容；都取**最后一条命中的**（引用一般指向最近那句）
        hit = None
        for cx, cy, txt, nick, r in msgs:
            if nick and want in nick:
                hit = (cx, cy, txt, nick, r)
        if hit is None:
            for cx, cy, txt, nick, r in msgs:
                if want in txt:
                    hit = (cx, cy, txt, nick, r)
        if hit is None:
            log('引用：没找到匹配「%s」的消息' % want[:20])
            return None
        cx, cy, txt, nick, r = hit
        log('引用：右键 [%s] %s @(%d,%d)' % (nick[:10], txt[:20], cx, cy))
        right_click(cx, cy)
        item = find_menu_item(win, '引用')
        if item is None:
            esc()
            log('引用：右键后菜单里没有「引用」（可能点在空白处了）')
            return None
        try:
            item.GetPattern(auto.PatternId.InvokePattern).Invoke(waitTime=0.05)
        except Exception:
            rr = rect_of(item)
            u = ctypes.windll.user32
            u.SetCursorPos((rr[0] + rr[2]) // 2, (rr[1] + rr[3]) // 2)
            time.sleep(0.1)
            u.mouse_event(0x0002, 0, 0, 0, 0)
            time.sleep(0.03)
            u.mouse_event(0x0004, 0, 0, 0, 0)
        time.sleep(0.7)
        return {'nick': nick, 'text': txt[:60], 'rect': r}
    except Exception as e:
        try:
            esc()
        except Exception:
            pass
        log('引用出错（不影响发送）：' + str(e)[:70])
        return None


def main():
    hwnd = arg('hwnd')
    if not hwnd:
        print(json.dumps({'ok': False, 'error': '要 --hwnd'}, ensure_ascii=False))
        return 1
    win = auto.ControlFromHandle(int(hwnd))
    if win is None:
        print(json.dumps({'ok': False, 'error': '窗口不可用'}, ensure_ascii=False))
        return 1

    esc()  # 清掉可能的残留菜单
    msgs = list_messages(win)
    print('候选消息 %d 条（最后 6 条）：' % len(msgs))
    for cx, cy, txt, nick, r in msgs[-6:]:
        print('   [%r] %r  rect=%s' % (nick[:12], txt[:34], r))

    if has('quote-probe'):
        print(json.dumps({'ok': True, 'count': len(msgs)}, ensure_ascii=False))
        return 0

    want = arg('quote')
    if not want:
        print(json.dumps({'ok': False, 'error': '要 --quote（昵称或内容片段）'}, ensure_ascii=False))
        return 1

    # 先按昵称、再按内容；都取**最后一条命中的**
    hit = None
    for cx, cy, txt, nick, r in msgs:
        if nick and want in nick:
            hit = (cx, cy, txt, nick, r)
    if hit is None:
        for cx, cy, txt, nick, r in msgs:
            if want in txt:
                hit = (cx, cy, txt, nick, r)
    if hit is None:
        print(json.dumps({'ok': False, 'error': '没找到匹配的消息：' + want}, ensure_ascii=False))
        return 2

    cx, cy, txt, nick, r = hit
    print('引用目标: [%r] %r  → 右键 (%d,%d)' % (nick[:12], txt[:30], cx, cy))
    right_click(cx, cy)

    item = find_menu_item(win, '引用')
    if item is None:
        esc()
        print(json.dumps({'ok': False, 'error': '菜单里没有「引用」（可能右键点空了）'}, ensure_ascii=False))
        return 3

    # 点「引用」
    try:
        item.GetPattern(auto.PatternId.InvokePattern).Invoke(waitTime=0.05)
        how = 'Invoke'
    except Exception:
        rr = rect_of(item)
        u = ctypes.windll.user32
        mx = (rr[0] + rr[2]) // 2
        my = (rr[1] + rr[3]) // 2
        u.SetCursorPos(mx, my)
        time.sleep(0.1)
        u.mouse_event(0x0002, 0, 0, 0, 0)
        time.sleep(0.03)
        u.mouse_event(0x0004, 0, 0, 0, 0)
        how = 'Click'
    time.sleep(0.8)
    print('已点「引用」（%s）' % how)

    # 验证：输入框附近应出现引用框
    has_quote_box = False
    for d, c in walk(win, 26):
        k = cls_of(c)
        if 'reply' in k.lower() or 'quote' in k.lower():
            has_quote_box = True
            break
    print('输入区出现引用框:', '是' if has_quote_box else '没读到（可能类名不含 reply/quote）')

    text = arg('text')
    if not text:
        print(json.dumps({'ok': True, 'stage': 'quoted_only', 'how': how}, ensure_ascii=False))
        return 0

    print('（下一步该打字 + 发送 —— 交给 qq-py.py 的 --quote 模式）')
    print(json.dumps({'ok': True, 'stage': 'quoted', 'how': how,
                      'target': {'nick': nick, 'text': txt[:40]}}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
