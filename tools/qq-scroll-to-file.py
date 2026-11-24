# -*- coding: utf-8 -*-
"""把消息区往上滚几屏，找一条**文件消息**，并把它右键菜单打出来。

给 `qq-probe-file-menu.py` 打前站：那个脚本只看当前屏，而文件消息常常已经滚上去了。
"""

import ctypes
import json
import sys
import time

import uiautomation as auto


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


def main():
    hwnd = arg("hwnd")
    rounds = int(arg("rounds", "6") or 6)
    try:
        w = auto.ControlFromHandle(int(hwnd))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:80]}, ensure_ascii=False))
        return 1
    if w is None:
        print(json.dumps({"ok": False, "error": "window_null"}, ensure_ascii=False))
        return 1

    try:
        w.SetActive(waitTime=0.2)
        time.sleep(0.3)
    except Exception:
        pass

    panel = None
    for d, c in walk(w, 30):
        if "message-panel" in cls_of(c):
            panel = c
            break
    if panel is None:
        print(json.dumps({"ok": False, "error": "没找到 message-panel"}, ensure_ascii=False))
        return 1

    r = panel.BoundingRectangle
    cx, cy = (r.left + r.right) // 2, (r.top + r.bottom) // 2
    u = ctypes.windll.user32

    found = None
    for i in range(rounds):
        u.SetCursorPos(int(cx), int(cy))
        time.sleep(0.1)
        # ⚠️ `auto.WheelUp()` **不接受 `times` 参数**（实测报
        #    `WheelUp() got an unexpected keyword argument 'times'`）—— 要自己循环
        for _ in range(3):
            auto.WheelUp()
        time.sleep(0.4)
        nodes = walk(w, 34)
        names = []
        for d, c in nodes:
            if "file-name" in cls_of(c):
                nm = name_of(c)
                if nm:
                    names.append(nm)
        if names:
            found = names[-1]
            print(json.dumps({"ok": True, "rounds": i + 1, "files": names[-5:]}, ensure_ascii=False))
            return 0

    print(json.dumps({"ok": False, "error": f"滚了 {rounds} 屏也没找到文件消息"}, ensure_ascii=False))
    return 1


if __name__ == "__main__":
    sys.exit(main())
