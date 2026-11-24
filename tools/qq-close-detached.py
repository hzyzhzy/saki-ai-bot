# -*- coding: utf-8 -*-
"""关掉 QQ 的独立聊天窗口（只留主窗口）。

## 为什么要关
实测（2026-11-16）：独立聊天窗口开着的时候，**`SendUnicodeChar` 会把字打进独立窗口**，
主窗口的输入框一直是空的 —— 但脚本那边打印的是「已输入 6/6 字」，
于是表现成「发送按钮点不到（中止）」，50% 随机失败 ✗

`ensure_editor_focus()` 的判据是「前台是不是 **QQ 进程**的窗口」，
而独立窗口也是 QQ 进程的 ⇒ 它认为焦点没问题，不去拉回主窗口。

    python qq-close-detached.py --pid 34712 --main 132512
    python qq-close-detached.py --pid 34712 --main 132512 --dry   # 只看不关
"""

import ctypes
import json
import sys
from ctypes import wintypes

WM_CLOSE = 0x0010


def arg(name, default=""):
    a = sys.argv
    for i, x in enumerate(a):
        if x == "--" + name and i + 1 < len(a):
            return a[i + 1]
    return default


def list_windows(pid):
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
        out.append({"hwnd": int(hwnd), "title": buf.value, "cls": cn.value})
        return True

    u.EnumWindows(proto(cb), 0)
    return out


def main():
    pid = int(arg("pid", "0") or 0)
    main_hwnd = int(arg("main", "0") or 0)
    dry = "--dry" in sys.argv
    if not pid:
        print(json.dumps({"ok": False, "error": "要 --pid"}, ensure_ascii=False))
        return 1

    u = ctypes.windll.user32
    closed = []
    kept = []
    for w in list_windows(pid):
        # 只关 Chrome_WidgetWin_1 的"聊天窗口"（标题是群名/人名），主窗口和通知图标一律不碰
        if w["cls"] != "Chrome_WidgetWin_1":
            continue
        if main_hwnd and w["hwnd"] == main_hwnd:
            kept.append(w)
            continue
        if not w["title"] or w["title"] == "QQ":
            kept.append(w)
            continue
        if not dry:
            u.PostMessageW(w["hwnd"], WM_CLOSE, 0, 0)
        closed.append(w)

    print(json.dumps({"ok": True, "dry": dry, "closed": closed, "kept": kept}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
