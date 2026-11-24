# -*- coding: utf-8 -*-
"""诊断：点「打开独立聊天窗口」之后，QQ 进程到底有没有开出新窗口。

上一版失败在"点完没有新窗口"。这次改成：
  · 菜单项用**真实鼠标点击**（不是 `InvokePattern.Invoke()` —— DOM 菜单项上它常常空转）
  · 点完**每 200ms 枚举一次窗口**，持续 5 秒 —— 抓"开了又立刻关"的情况
  · 窗口枚举走 **Win32 EnumWindows**（UIA 的 Root 在 seat 里返回空）

    python qq-probe-detached.py --hwnd 132512 --match "示例服务器 2026"
"""

import ctypes
import json
import sys
import time
from ctypes import wintypes

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


def win32_windows(pid, visible_only=True):
    u = ctypes.windll.user32
    out = []
    proto = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

    def cb(hwnd, _lp):
        p = wintypes.DWORD()
        u.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
        if int(p.value) != int(pid):
            return True
        vis = bool(u.IsWindowVisible(hwnd))
        if visible_only and not vis:
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
                "visible": vis,
                "rect": [r.left, r.top, r.right, r.bottom],
            }
        )
        return True

    u.EnumWindows(proto(cb), 0)
    return out


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


def item_name(c):
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


def main():
    hwnd = arg("hwnd")
    match = arg("match", "")
    try:
        w = auto.ControlFromHandle(int(hwnd))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:80]}, ensure_ascii=False))
        return 1
    if w is None:
        print(json.dumps({"ok": False, "error": "window_null"}, ensure_ascii=False))
        return 1

    pid = int(w.ProcessId or 0)
    before = {x["hwnd"] for x in win32_windows(pid, visible_only=False)}

    nodes = walk(w, 34)
    item = None
    for d, c in nodes:
        if "recent-contact-item" not in cls_of(c):
            continue
        nm = item_name(c)
        if nm and (not match or match in nm):
            item = (nm, c)
            break
    if item is None:
        print(json.dumps({"ok": False, "error": "找不到会话项「%s」" % match}, ensure_ascii=False))
        return 1
    nm, c = item

    try:
        w.SetActive(waitTime=0.2)
        time.sleep(0.3)
    except Exception:
        pass

    c.RightClick(waitTime=0.5)
    time.sleep(0.8)

    menu_item = None
    for d, x in walk(w, 30):
        if "q-context-menu-item" in cls_of(x) and name_of(x) == MENU_TEXT:
            menu_item = x
            break
    if menu_item is None:
        for _ in range(2):
            try:
                auto.SendKeys("{Esc}", waitTime=0.1)
            except Exception:
                pass
        print(json.dumps({"ok": False, "error": "菜单里没有「%s」" % MENU_TEXT}, ensure_ascii=False))
        return 1

    r = menu_item.BoundingRectangle
    cx, cy = (r.left + r.right) // 2, (r.top + r.bottom) // 2

    # 真实鼠标点击
    try:
        auto.Click(cx, cy, waitTime=0.25)
        clicked = "mouse"
    except Exception as e:
        clicked = "mouse失败:" + str(e)[:40]
        try:
            menu_item.GetPattern(auto.PatternId.InvokePattern).Invoke(waitTime=0.2)
            clicked = "invoke"
        except Exception:
            pass

    # 监控 5 秒
    appeared = {}
    for _ in range(25):
        time.sleep(0.2)
        for wd in win32_windows(pid, visible_only=False):
            if wd["hwnd"] in before:
                continue
            appeared[wd["hwnd"]] = wd

    print(
        json.dumps(
            {
                "ok": True,
                "item": nm,
                "clicked": clicked,
                "click_at": [cx, cy],
                "new_windows": list(appeared.values()),
                "after_count": len(win32_windows(pid, visible_only=True)),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
