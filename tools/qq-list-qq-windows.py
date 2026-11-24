# -*- coding: utf-8 -*-
"""列出 QQ 进程的所有可见顶层窗口（Win32 版）。

⚠️ 不能用 UIA 的 `GetRootControl().GetChildren()` —— 在 seat 会话里实测返回**空**。
"""

import ctypes
import json
import sys
from ctypes import wintypes


def arg(name, default=""):
    a = sys.argv
    for i, x in enumerate(a):
        if x == "--" + name and i + 1 < len(a):
            return a[i + 1]
    return default


def main():
    pid = int(arg("pid", "0") or 0)
    if not pid:
        print(json.dumps({"ok": False, "error": "要 --pid"}, ensure_ascii=False))
        return 1

    u = ctypes.windll.user32
    out = []
    proto = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

    def cb(hwnd, _lp):
        p = wintypes.DWORD()
        u.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
        if int(p.value) != pid:
            return True
        vis = bool(u.IsWindowVisible(hwnd))
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
    print(json.dumps({"ok": True, "pid": pid, "count": len(out), "windows": out}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
