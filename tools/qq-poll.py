"""
多群轮询：把"所有会话"里的新消息都读出来 → JSON。

## 为什么需要
  之前 qq-read.py 只读**当前打开的会话**，等于只能收一个群的消息。
  SnowLuma 是协议端推所有群，这是客户端方案最大的功能缺口。

## 怎么做（实测：不 SetActive 也能 Invoke）
  ① 读会话列表（recent-contact-item 在 depth 16）
  ② 逐个 Invoke 过去（**不 SetActive**，0.06 秒一次，完全静默）
  ③ 每个会话读完把消息记下，按「群名+who+text」去重
  ④ 最后切回原来的会话（不打扰用户看到的位置）
  ⑤ 输出 { ok, sessions: [{group, messages}], total }

## 用法
  python tools/qq-poll.py --hwnd H [--limit-per 20] [--only-hint "群名"] [--max 8]
    --only-hint : 只轮询名字含这个串的会话
    --max       : 最多轮询几个会话（默认 8，防止一轮太久）

## 代价
  每个会话约 0.6~1.2 秒（Invoke 0.06 + 读树 0.5~1.1）。
  8 个会话 ≈ 6 秒。所以轮询间隔别小于 10 秒。
"""

import json
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
        i = a.index(name if name.startswith("--") else "--" + name)
        if i + 1 < len(a):
            return a[i + 1]
    return default


def cls_of(c):
    try:
        return c.ClassName or ""
    except Exception:
        return ""


def nm_of(c):
    try:
        return (c.Name or "").strip()
    except Exception:
        return ""


def walk(c, d=0, md=26, acc=None):
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


def find_info(c, dep=0):
    if dep > 4:
        return None
    try:
        ch = c.GetChildren()
    except Exception:
        return None
    for x in ch:
        if any(k in cls_of(x) for k in CLS_INFO):
            return x
        g = find_info(x, dep + 1)
        if g is not None:
            return g
    return None


def item_name(c):
    i = find_info(c)
    if i is None:
        return ""
    t = []
    try:
        for x in i.GetChildren():
            if (x.ControlTypeName or "") == "TextControl" and nm_of(x):
                t.append(nm_of(x))
    except Exception:
        pass
    return "".join(t)


def header(win, nodes=None):
    if nodes is None:
        nodes = walk(win, 0, 24)
    for d, c in nodes:
        if CLS_HEADER in cls_of(c):
            n = nm_of(c)
            if n:
                return n
    return ""


BADGE = __import__("re").compile(r"^(LV|\d{1,3}|青铜|白银|黄金|铂金|钻石|星耀|王者|大师|传说)$")
TIMER = __import__("re").compile(r"^(\d{1,2}:\d{2}|昨天|前天|星期[一二三四五六日天]|\d{1,2}月\d{1,2}日)$")


def parse_messages(win, nodes, limit=20):
    """从一个会话的树里抽消息（和 qq-read.py 同一套规则）"""
    out = []
    for d, c in nodes:
        k = cls_of(c)
        if "message-container" not in k:
            continue
        try:
            top = c.BoundingRectangle.top
        except Exception:
            continue
        who = ""
        parts = []
        is_self = False
        at = False

        def collect(node, depth=0, in_label=False):
            nonlocal who, is_self, at
            if depth > 10:
                return
            try:
                children = node.GetChildren()
            except Exception:
                return
            for cc in children:
                kk = cls_of(cc)
                nmm = nm_of(cc)
                skip = in_label or ("group-member-label" in kk)
                if not who and "avatar-span" in kk and nmm:
                    who = nmm
                if "container--self" in kk:
                    is_self = True
                if not skip and (cc.ControlTypeName or "") == "TextControl" and nmm:
                    if not BADGE.match(nmm) and not TIMER.match(nmm) and not (nmm == who and len(nmm) <= 24):
                        if "@" in nmm:
                            at = True
                        parts.append(nmm)
                collect(cc, depth + 1, skip)

        collect(c)
        dedup = []
        for t in parts:
            if dedup and dedup[-1] == t:
                continue
            dedup.append(t)
        text = " ".join(dedup).strip()
        if text:
            out.append({"who": who, "text": text, "self": is_self, "at": at, "y": top})
    out.sort(key=lambda m: m["y"])
    return out[-limit:]


def _fg():
    """当前前台窗口 hwnd"""
    try:
        import ctypes

        return int(ctypes.windll.user32.GetForegroundWindow())
    except Exception:
        return 0


def _set_fg(h):
    try:
        import ctypes

        ctypes.windll.user32.SetForegroundWindow(int(h))
    except Exception:
        pass


def main():
    hwnd = int(arg("hwnd", "0") or 0)
    limit_per = int(arg("limit-per", "20") or 20)
    max_sessions = int(arg("max", "8") or 8)
    only = arg("only-hint", "") or ""
    if not hwnd:
        print(json.dumps({"ok": False, "error": "要 --hwnd"}))
        return 1

    try:
        win = auto.ControlFromHandle(hwnd)
    except Exception as e:
        print(json.dumps({"ok": False, "error": "窗口不可用:" + str(e)[:60]}))
        return 1
    if win is None:
        print(json.dumps({"ok": False, "error": "window_null"}))
        return 1

    # ⚠️ 记住用户原来的前台窗口。轮询会 Invoke 切会话，而 Invoke 会把 QQ 顶到前台；
    #    不还原 = 用户的窗口被顶掉（实测被投诉「还是切了，而且没有还原」）。
    original_fg = _fg()
    t_all = time.time()
    original = header(win)
    nodes = walk(win, 0, 22)
    items = [(item_name(c), c) for d, c in nodes if CLS_ITEM in cls_of(c)]
    items = [(n, c) for n, c in items if n]
    if only:
        items = [(n, c) for n, c in items if only in n]
    items = items[:max_sessions]

    sessions = []
    for nm, c in items:
        t0 = time.time()
        try:
            c.GetPattern(auto.PatternId.InvokePattern).Invoke(waitTime=0.02)
        except Exception:
            continue
        time.sleep(1.0)  # 等渲染（实测 1.0s 够）
        n2 = walk(win, 0, 26)
        cur = header(win, n2)
        if not cur or (nm[:6] not in cur and cur[:6] not in nm):
            # 切错了，跳过（绝不用错的群名去算群号）
            sessions.append({"group": "", "want": nm, "error": "header_mismatch", "cur": cur})
            continue
        msgs = parse_messages(win, n2, limit_per)
        sessions.append({"group": cur, "messages": msgs, "ms": round((time.time() - t0) * 1000)})

    # 切回原来的会话
    if original:
        for nm, c in items:
            if original[:8] in nm:
                try:
                    c.GetPattern(auto.PatternId.InvokePattern).Invoke(waitTime=0.02)
                    time.sleep(0.6)
                except Exception:
                    pass
                break

    # ⚠️ **必须把前台还给用户原来的窗口** —— 轮询用的 Invoke 会把 QQ 顶到最前，
    #    不还回去就等于「偷偷把你的桌面切了」。
    if original_fg and original_fg != hwnd:
        _set_fg(original_fg)

    total = sum(len(s.get("messages") or []) for s in sessions)
    out = {
        "ok": True,
        "sessions": sessions,
        "count": len(sessions),
        "total": total,
        "original": original,
        "ms": round((time.time() - t_all) * 1000),
    }
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
