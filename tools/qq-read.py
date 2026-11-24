"""
读 QQ 当前会话的消息（结构化），输出 JSON —— 给 OneBot 协议端轮询用。

## 靠什么认（实测 QQ NT 9.9.33 的 UIA 结构，别靠坐标猜）
  一条消息的完整外壳是 **message-container**：
    message-container message-container--mix-or-markdown
      avatar-span                    ← ★ 它的 Name **就是发送者昵称**（最可靠）
      user-name                      ← 昵称的另一个副本 + 等级徽章（LV/2/青铜）
      message-content__wrapper
        msg-content-container container--self / container--others   ← ★ 自己/别人
          message-content mix-message__inner
            <TextControl>            ← 正文、@、[图片] 等
      message__timestamp no-copy     ← 时间（有时在这层，有时在子层）

  ⚠️ 之前只按 msg-content-container（气泡）解析，昵称拿不到（昵称在气泡外面），
     所以大量消息 who 是空。改成按 message-container 解析就对了。

## 用法
  python tools/qq-read.py --hwnd H [--limit 30] [--group "群名"]
  输出 {"ok":true,"group":"...","count":N,"messages":[{who,text,self,at,y}]}
"""

import json
import re
import sys
import time

import uiautomation as auto

# ⚠️ 2026-11-17：**判断"@ 的是不是自己"用的名字**（`--me` 可改，默认 Saki）。
#    原来是"消息里含 @ 就算 @ 我"，导致 @ 别人的消息也被当成在叫她 ✗
ME_NAME = "Saki"

auto.SetGlobalSearchTimeout(6.0)

CLS_HEADER = "chat-header__contact-name"
TIME_RE = re.compile(r"^(\d{1,2}:\d{2}|昨天|前天|星期[一二三四五六日天]|\d{1,2}月\d{1,2}日)$")
BADGE_RE = re.compile(r"^(LV|\d{1,3}|青铜|白银|黄金|铂金|钻石|星耀|王者|大师|传说)$")


def arg(name, default=None):
    a = sys.argv
    if "--" + name in a:
        i = a.index("--" + name)
        if i + 1 < len(a):
            return a[i + 1]
    return default


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


def rect_of(c):
    try:
        return c.BoundingRectangle
    except Exception:
        return None


def walk(c, d=0, md=34, acc=None):
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


def walk_ordered(c, md=14):
    """**保持文档顺序**的深度遍历（兄弟按出现先后）。

    ⚠️ 2026-11-15 踩的坑：`walk()` 用的是栈（`pop()` = LIFO）⇒ **兄弟顺序被反转**。
    这对"收集所有文本再拼接"没影响，但对**有顺序语义**的东西是致命的：
    戳一戳那条灰字提示的顺序本来应该是 `[动作=戳了戳, 对象=你]`，
    用 `walk()` 收出来变成了 `[你, 戳了戳]` ⇒ 解析成「对象=戳了戳、动作=你」✗
    （实测输出：`who="谷雨" action="你" target="戳了戳"`。）
    """
    acc = []

    def rec(x, d):
        if d > md:
            return
        acc.append((d, x))
        try:
            kids = x.GetChildren()
        except Exception:
            kids = []
        for k in kids:
            rec(k, d + 1)

    rec(c, 0)
    return acc


def parse_gray_tip(c):
    """解析一条**灰字提示**（`gray-tip-message`）。

    ## 为什么单独解析（2026-11-15 实测）
    戳一戳在界面上**不是消息气泡**，而是一条灰字提示：
    ```
    gray-tip-message no-copy
      gray-tip-message__inner babble
        gray-tip-action-sidebar-wrapper babble
          gray-tip-action-sidebar-button      | 撤回     ← 悬停才出现，忽略
        gray-tip-element gray-tip-content
          gray-tip-action                     | 谷雨     ← 谁做的
            (无 cls)                          | 谷雨     ← 同一人名的副本，要去重
          (无 cls)                            | 戳了戳   ← 动作文案（用户可自定义！）
          gray-tip-img                        ← 动作图标（有它 = 带图标的动作）
          (无 cls)                            | 你       ← 作用对象
    ```
    ⇒ 它**不在 `message-container` 里**，所以原来那个只收 message-container 的循环
      一条都读不到（实测：戳成功、界面也有提示，`qq-read.py` 返回的 8 条里一条都没有）✗

    ⚠️⚠️ **顺序只能按屏幕坐标判，不能靠树里的顺序**（2026-11-15 实测踩了三次）：
    同一条提示，树里的 `GetChildren()` 顺序和视觉顺序**不一样**，
    用栈遍历还会再反转一次 ⇒ 解析结果成了「动作=你、对象=戳了戳」✗

    ⚠️⚠️⚠️ **`gray-tip-action` 不是"固定的某个角色"** —— 它只是"可点击的那个人"，
    位置随语境变（两种都实测到了）：
    ```
    ① 我戳别人（测试群）：              ② 别人戳我（示例服务器 群）：
       你          left=627  发起人       <主人>(gray-tip-action)  left=615  发起人
       (图标)      left=641               (图标)                left=640
       戳了戳      left=659  动作         捏了捏                left=658  动作
       谷雨(gray-tip-action) left=695 目标  你                  left=694  目标
                                          的脸                  left=706  后缀
    ```
    ⇒ **唯一可靠的判据是"谁在最左边谁是发起人"**：把所有带 Name 的元素
      （**包括 `gray-tip-action`**）按 `rect.left` 排，依次是
      `[发起人] [动作] [目标] [后缀…]`。
    ⚠️ 前两版分别把 `gray-tip-action` 当成"目标"和"发起人"，各错一半 ——
      因为它在①里在最右、在②里在最左 ✗
    ⚠️ 这正是「别人戳了她却没反应」的直接原因：`target` 取错 ⇒ `toMe=false` ⇒ 不推事件。

    ⚠️ **动作文案不能当判据**：用户可以把「戳一戳」改成「捏一捏」之类，
       所以这里只做**结构化拆分**，是不是"戳"交给上面判断（`hasIcon` + `toMe`）。
    """
    items = []
    has_icon = False
    for d, x in walk_ordered(c, 14):
        k = cls_of(x)
        nm = name_of(x)
        if "gray-tip-img" in k:
            has_icon = True
            continue
        if "gray-tip-action-sidebar" in k:
            continue
        if not nm:
            continue
        r = rect_of(x)
        left = r.left if r is not None else 10**9
        items.append((left, len(items), nm))
    items.sort()
    names = []
    for _, _, nm in items:
        if names and names[-1] == nm:
            continue
        names.append(nm)
    who = names[0] if names else ""
    action = names[1] if len(names) > 1 else ""
    target = names[2] if len(names) > 2 else ""
    # 目标后面剩下的都算"后缀"（实测「捏了捏 / 你 / 的脸」⇒ suffix=的脸）
    suffix = "".join(names[3:]) if len(names) > 3 else ""
    return {
        "who": who,
        "action": action,
        "target": target,
        "suffix": suffix,
        "text": (who + action + target + suffix).strip(),
        "hasIcon": has_icon,
        "toMe": target.strip() in ("你", "Saki", "saki"),
        "fromMe": who.strip() in ("你", "Saki", "saki"),
    }


def _file_meta(container):
    """从 `file-message` 容器里取 (文件名, 大小文本, 是否已下载完)。

    ⚠️ 文件名在 `file-name` 的**子节点**里，而且会被拆成几段、树里的顺序是反的
       （实测 `nfig.txt` 在前、`export_co` 在后）⇒ 必须**按屏幕 left 排序**再拼。
    """
    parts = []
    size_text = ""
    downloading = False
    for d, x in walk_ordered(container, 18):
        k = cls_of(x)
        nm = name_of(x)
        if "file-name" in k:
            for dd, y in walk_ordered(x, 8):
                t = name_of(y)
                if not t:
                    continue
                r = rect_of(y)
                parts.append((r.left if r is not None else 10**9, len(parts), t))
            continue
        if "file-status-mask--show" in k:
            downloading = True
        if nm and not size_text and any(u in nm for u in ("KB", "MB", "GB", "B ")):
            if any(ch.isdigit() for ch in nm):
                size_text = nm
    parts.sort()
    return "".join(t for _, _, t in parts), size_text, (not downloading)


def parse_message(container):
    """从一个 message-container 里抽 who / text / self / at / kind。

    ## 消息类型（kind）怎么认 —— 实测 QQ NT 9.9.33 的 className
      · `pic-element`（还带 `pic-element--gif` / `--png` 这种后缀）
          ⇒ 图片。**图片的 fileid 在 className 的第一段**，例如
            `f2vnRVay8ztZBnqxSA7L pic-element pic-element--gif`
            而 Name 只是「图片」两个字 —— 所以取 fileid 要读 className。
      · `file-message--content` / `normal-file file-element` / `file-name`
          ⇒ 文件消息，文件名在 `file-name` 的子树里。
      · 表情 / 系统消息 / 引用 目前只按文本特征粗分（见下）。
    """
    who = ""
    text_parts = []
    is_self = False
    in_quote = [False]  # 正在遍历引用块（块内的文本不进正文）
    at_flag = False
    at_all = []          # 这条消息里 @ 到的所有人（排查用，也让适配器能自己再判一遍）
    kind = "text"
    extra = {}

    # ⚠️⚠️ 2026-11-17：**文件消息的判据在容器上**（`message-container … file-message`）。
    #    原来只认 `file-name` 这个 GroupControl 的 Name（它是空的）⇒ 永远识别不到 ✗
    if "file-message" in cls_of(container):
        kind = "file"
        _fname, _fsize, _fready = _file_meta(container)
        extra["fileName"] = _fname
        if _fsize:
            extra["fileSize"] = _fsize
        extra["fileReady"] = _fready

    # ⚠️ `group-member-label` 里装的是「等级徽章 + 群名片」（LV/13/小祥小祥小祥）——
    #    整块跳过，否则群名片会被当成正文的一部分（实测 `text` 变成「小祥小祥小祥 闭环测试」）。
    def collect(node, depth=0, in_label=False):
        nonlocal who, is_self, at_flag, kind, extra, at_all
        if depth > 10:
            return
        try:
            children = node.GetChildren()
        except Exception:
            return
        for cc in children:
            k = cls_of(cc)
            nm = name_of(cc)
            skip = in_label or ("group-member-label" in k)
            # ① 昵称：avatar-span 的 Name 最可靠（它不受徽章影响）
            if not who and "avatar-span" in k and nm:
                who = nm
            # ② self / others 标记
            if "container--self" in k:
                is_self = True
            # ②.5 引用块（2026-11-17 加）：`reply-element` 里是被引用的那条消息
            #      ⚠️ 它的文本**不能混进正文** —— 否则正文会变成"引用内容 + 我说的话"，
            #      看起来像她在复述别人的话（今天刚因为复述/回灌栽过一次）
            if "reply-element" in k:
                in_quote[0] = True
                inner = []
                for dd, q in walk(cc, 0, 5):
                    if (q.ControlTypeName or "") == "TextControl":
                        t = name_of(q)
                        if t:
                            inner.append(t)
                if inner:
                    extra["quote"] = " ".join(inner)[:120]
                in_quote[0] = False
                continue

            # ③ 图片：fileid 在 className 第一段
            if "pic-element" in k:
                kind = "image"
                parts = k.split()
                if parts and len(parts[0]) >= 10 and " " not in parts[0]:
                    extra["fileId"] = parts[0]
                for sub in ("gif", "png", "jpg", "jpeg", "webp"):
                    if "pic-element--" + sub in k:
                        extra["format"] = sub
                        break
                if not extra.get("format"):
                    extra["format"] = "image"
                # ⚠️ 2026-11-16：**屏幕矩形**（补看图片要靠它裁屏）。
                #    客户端方案拿不到 QQ 的图片文件，只能按这块区域截下来。
                #    top < 0 = 已经滚出视口 ⇒ 截不到（调用方会退回占位文本）。
                if "rect" not in extra:
                    try:
                        rr = cc.BoundingRectangle
                        extra["rect"] = [rr.left, rr.top, rr.right, rr.bottom]
                    except Exception:
                        pass
            # ④ 文件：file-name 子树里的文本就是文件名
            if "file-name" in k and nm and not extra.get("fileName"):
                # 只有在上面那段没拿到文件名时才用它（`file-name` 通常 Name 为空）
                kind = "file"
                extra["fileName"] = nm
            # ⑤ 正文：TextControl，剔掉徽章/时间/标签区
            if not skip and (cc.ControlTypeName or "") == "TextControl" and nm:
                if BADGE_RE.match(nm) or TIME_RE.match(nm):
                    pass
                elif nm == who and len(nm) <= 24:
                    pass  # 昵称副本
                else:
                    if "@" in nm:
                        # ⚠️⚠️ 2026-11-17 修（用户：「所有@消息都被自动补充成@Saki了，
                        #    直接和以前@别人的消息一律不回的规则撞了」）：
                        #    原来只有 `at_flag = True` —— **消息里任何一个 @ 都算"在 @ 我"** ✗
                        #    ⇒ `@<主人> 你好` 也置真，配上适配器那个伪造前缀
                        #      就变成"@ 别人的消息她也回"，和既有规则正面冲突。
                        #    ⇒ 只有 @ 到的名字里含**自己**（默认 Saki）才算；
                        #      所有 @ 到的名字都留着（`atNames`），排查用。
                        at_all.append(nm)
                        if ME_NAME and ME_NAME.lower() in nm.lower():
                            at_flag = True
                    text_parts.append(nm)
            collect(cc, depth + 1, skip)

    collect(container)

    # 去重相邻重复（同一个文本常被父子各暴露一次）
    dedup = []
    for t in text_parts:
        if dedup and dedup[-1] == t:
            continue
        dedup.append(t)
    text = " ".join(dedup).strip()

    # ⑥ 按文本特征补判（图片/文件有时没有文本，靠占位符）
    if kind == "text":
        if "[图片]" in text:
            kind = "image"
        elif "[表情]" in text or "/:" in text:
            kind = "face"
        elif text.startswith("[") and text.endswith("]") and len(text) < 12:
            kind = "system"

    return {
        "who": who,
        "text": text,
        "self": is_self,
        "at": at_flag,
        "atNames": at_all,
        "kind": kind,
        **extra,
    }


def main():
    hwnd = arg("hwnd")
    limit = int(arg("limit", "30")) or 30
    want_group = arg("group", "")
    # ⚠️ 2026-11-17：**只有 @ 到"自己"才算 atMe**。
    #    见文件末尾那段「所有 @ 都被当成 @Saki」的说明。
    global ME_NAME
    ME_NAME = arg("me", "Saki") or "Saki"
    if not hwnd:
        print(json.dumps({"ok": False, "error": "要 --hwnd"}))
        return 1

    try:
        w = auto.ControlFromHandle(int(hwnd))
    except Exception as e:
        print(json.dumps({"ok": False, "error": "窗口不可用:" + str(e)[:60]}))
        return 1
    if w is None:
        print(json.dumps({"ok": False, "error": "window_null"}))
        return 1

    # ⚠️⚠️ 2026-11-16 加 `--wake`（**这是"收不到消息"的真凶之一**）：
    #    QQ 窗口**不活跃时不渲染新消息** —— 实测爱音发到群里的消息，
    #    SnowLuma 返回 `retcode 0`，但 Saki 这边界面**二十分钟都没显示**，
    #    UIA 读的控件树里自然也没有 ⇒ 适配器「本轮无新增」，看着像收不到 ✗
    #    只要 `SetActive` 一下，界面立刻渲染（实测：唤醒后马上读到那两条）。
    #    ⇒ 放在这里而不是单独一个脚本：一次 `anode exec` 就够，省一半往返。
    if "--wake" in sys.argv:
        try:
            w.SetActive(waitTime=0.15)
            time.sleep(0.35)
        except Exception:
            pass

    nodes = walk(w, 0, 34)

    group = ""
    for d, c in nodes:
        if CLS_HEADER in cls_of(c):
            nm = name_of(c)
            if nm:
                group = nm

    if want_group and group and want_group not in group:
        print(json.dumps({"ok": False, "error": "不是目标群", "group": group}, ensure_ascii=False))
        return 1

    messages = []
    for d, c in nodes:
        k = cls_of(c)
        if "message-container " not in (k + " ") and not k.startswith("message-container"):
            continue
        r = rect_of(c)
        if r is None:
            continue
        m = parse_message(c)
        # ⚠️⚠️ 2026-11-17 20:30：**纯图片 / 纯文件没有正文，text 是空的** ——
        #    原来这里 `if not m["text"]: continue` 会把它们整条丢掉 ⇒
        #    用户发的房间照片在树里（`pic-element` rect=[436,243,760,451]）却永远读不到 ✗
        #    ⇒ 给占位文本，别丢。
        if not m["text"]:
            kd = m.get("kind") or "text"
            if kd == "image":
                m["text"] = "[图片]"
            elif kd == "file":
                m["text"] = "[文件]"
            else:
                continue
        m["y"] = r.top
        messages.append(m)

    messages.sort(key=lambda m: m["y"])
    messages = messages[-limit:]

    # ── 灰字提示（戳一戳 / 入群 / 撤回…）──
    # ⚠️ 这些**不在 message-container 里**，所以上面那个循环收不到（见 parse_gray_tip 的注释）
    tips = []
    for d, c in nodes:
        k = cls_of(c)
        if "gray-tip-message" not in k or "inner" in k:
            continue
        r = rect_of(c)
        if r is None:
            continue
        t = parse_gray_tip(c)
        if not t["text"]:
            continue
        t["y"] = r.top
        tips.append(t)
    tips.sort(key=lambda t: t["y"])
    tips = tips[-limit:]

    out = {
        "ok": True,
        "group": group,
        "count": len(messages),
        "messages": messages,
        "tips": tips,
        "nodes": len(nodes),
    }
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
