# -*- coding: utf-8 -*-
"""给某个会话开一个**独立聊天窗口**，返回它的 HWND。

## 为什么必须这么做（这是客户端协议的架构问题，不是 bug）
QQ 主窗口只有一个"当前会话" —— 适配器读它，就永远只能收到**那一个群**的消息。
别的群有人 @她、戳她，一律读不到 ✗

同目录的 QuitBot 走的是 `detached` 模式（见它 `docs/architecture.md` 的「监听与事件」）：
**每个要监听的会话各开一个独立聊天窗口**，每个窗口独立轮询。
独立窗口是独立顶层窗口，有自己的 HWND ⇒ `qq-read.py --hwnd <它>` 直接读 ✓

## 实测（QQ NT 9.9.33）
右键会话项，菜单里有「打开独立聊天窗口」：
    从消息列表中移除 / 群消息设置 / **打开独立聊天窗口** / 标记已读 / 复制群号 / 置顶

## 用法
    python qq-open-detached.py --hwnd 132512 --match 示例服务器
    → {"ok": true, "item": "...", "hwnd": 123456, "title": "示例服务器 2026 (50)", "reused": false}
"""

import json
import sys
import time

import uiautomation as auto

MENU_TEXT = "打开独立聊天窗口"


def arg(name, default=""):
    a = sys.argv
    for i, x in enumerate(a):
        if x == "--" + name and i + 1 < len(a):
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


def walk(c, md=30):
    acc = []
    stack = [(c, 0)]
    while stack:
        x, d = stack.pop()
        if d > md:
            continue
        acc.append((d, x))
        try:
            kids = x.GetChildren()
        except Exception:
            kids = []
        for k in kids:
            stack.append((k, d + 1))
    return acc


def find_info(x, depth=0):
    if depth > 6:
        return None
    try:
        for y in x.GetChildren():
            if "item__info" in cls_of(y):
                return y
            r = find_info(y, depth + 1)
            if r is not None:
                return r
    except Exception:
        pass
    return None


def name_of_item(c):
    info = find_info(c)
    if info is None:
        return ""
    try:
        for t in info.GetChildren():
            if (t.ControlTypeName or "") == "TextControl":
                nm = name_of(t)
                if nm:
                    return nm
    except Exception:
        pass
    return ""


def chat_header(win):
    """独立窗口里读「当前是哪个会话」—— 和主窗口同一个 className"""
    for d, c in walk(win, 30):
        if "chat-header" in cls_of(c):
            nm = name_of(c)
            if nm:
                return nm
    return ""


def qq_windows(pid):
    """QQ 进程的所有可见顶层窗口 —— **用 Win32 EnumWindows**。

    ⚠️⚠️ 不能用 `auto.GetRootControl().GetChildren()`：实测在 seat 会话里它返回**空**
    （虽然 `ControlFromHandle(hwnd)` 能正常拿到控件树）。
    只有 Win32 这条路能同时列出主窗口和独立聊天窗口。
    """
    import ctypes
    from ctypes import wintypes

    u = ctypes.windll.user32
    out = []
    proto = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

    def cb(hwnd, _lp):
        p = wintypes.DWORD()
        u.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
        if int(p.value) != int(pid):
            return True
        if not u.IsWindowVisible(hwnd):
            return True
        n = u.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(n + 1)
        u.GetWindowTextW(hwnd, buf, n + 1)
        cn = ctypes.create_unicode_buffer(256)
        u.GetClassNameW(hwnd, cn, 256)
        r = wintypes.RECT()
        u.GetWindowRect(hwnd, ctypes.byref(r))
        out.append(
            {
                "hwnd": int(hwnd),
                "title": buf.value,
                "cls": cn.value,
                "rect": [r.left, r.top, r.right, r.bottom],
            }
        )
        return True

    u.EnumWindows(proto(cb), 0)
    return out


def find_existing(pid, want, main_hwnd=0):
    """已经开着（且**窗口标题**对得上）的独立窗口 ⇒ 直接复用。

    ⚠️ 判据必须用**窗口标题**（`name_of(tw)`），不能用 `chat-header`：
    主窗口里也有 `chat-header`（就是它当前显示的那个会话名），
    拿它判断会把主窗口自己当成"独立窗口" ✗
    ⚠️ 更要紧的是**排除主窗口的 hwnd** —— Anode 的窗口列表里，
    主窗口的标题也可能显示成当前会话名（`示例服务器 2026`），光看标题分不出来。
    """
    for tw in qq_windows(pid):
        h = int(tw.get('hwnd') or 0)
        if not h or (main_hwnd and h == int(main_hwnd)):
            continue
        title = (tw.get('title') or '').strip()
        if not title:
            continue
        if want and (want in title or title in want):
            return tw, title
    return None, ""


def main():
    hwnd = arg("hwnd")
    match = arg("match")
    try:
        w = auto.ControlFromHandle(int(hwnd))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:80]}, ensure_ascii=False))
        return 1
    if w is None:
        print(json.dumps({"ok": False, "error": "window_null"}, ensure_ascii=False))
        return 1

    pid = 0
    try:
        pid = int(w.ProcessId or 0)
    except Exception:
        pass

    # ① 已经有开着的独立窗口就直接复用（别重复开）
    ex, ex_hdr = find_existing(pid, match, main_hwnd=int(hwnd))
    if ex is not None:
        h = int((ex or {}).get('hwnd') or 0)
        if h and h != int(hwnd):
            print(
                json.dumps(
                    {"ok": True, "item": match, "hwnd": h, "title": ex_hdr, "reused": True},
                    ensure_ascii=False,
                )
            )
            return 0

    # ② 找会话项
    nodes = walk(w, 34)
    target = None
    for d, c in nodes:
        if "recent-contact-item" not in cls_of(c):
            continue
        nm = name_of_item(c)
        if not nm:
            continue
        if match and match not in nm:
            continue
        target = (nm, c)
        break
    if target is None:
        print(json.dumps({"ok": False, "error": "会话列表里没找到「%s」" % match}, ensure_ascii=False))
        return 1
    item_name, item = target

    before = set()
    for tw in qq_windows(pid):
        before.add(int(tw.get('hwnd') or 0))

    # ③ 右键 → 点「打开独立聊天窗口」
    try:
        item.RightClick(waitTime=0.5)
    except Exception as e:
        print(json.dumps({"ok": False, "error": "右键失败:" + str(e)[:60]}, ensure_ascii=False))
        return 1
    time.sleep(0.8)

    clicked = False
    for d, x in walk(w, 30):
        if "q-context-menu-item" not in cls_of(x):
            continue
        if name_of(x) != MENU_TEXT:
            continue
        try:
            x.GetPattern(auto.PatternId.InvokePattern).Invoke(waitTime=0.3)
            clicked = True
        except Exception:
            try:
                x.Click(waitTime=0.3)
                clicked = True
            except Exception:
                pass
        break

    if not clicked:
        for _ in range(2):
            try:
                auto.SendKeys("{Esc}", waitTime=0.15)
            except Exception:
                pass
        print(json.dumps({"ok": False, "error": "菜单里没点到「%s」" % MENU_TEXT}, ensure_ascii=False))
        return 1

    # ④ 等新窗口出现（最多 8 秒）—— 用**窗口标题**认，不用 chat-header
    found = None
    for _ in range(16):
        time.sleep(0.5)
        for tw in qq_windows(pid):
            h = int(tw.get('hwnd') or 0)
            if not h or h == int(hwnd):
                continue
            title = (tw.get('title') or '').strip()
            if not title or title == "QQ":
                continue
            if match and not (match in title or title in match or title.startswith(item_name[:4])):
                continue
            found = (h, title, h in before)
            break
        if found:
            break

    if not found:
        print(json.dumps({"ok": False, "error": "等不到独立窗口（8 秒）", "item": item_name}, ensure_ascii=False))
        return 1

    h, hdr, was_there = found
    print(
        json.dumps(
            {"ok": True, "item": item_name, "hwnd": h, "title": hdr, "reused": was_there},
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
