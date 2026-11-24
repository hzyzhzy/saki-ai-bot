# -*- coding: utf-8 -*-
"""点文件卡片右键菜单里的某一项（默认「保存」）。

`保存` 通常直接存到 QQ 的默认下载目录（不起对话框），`另存为` 会弹保存对话框。
先试 `保存` —— 少一层对话框就少一堆不稳定因素。

    python qq-file-click.py --hwnd 132512 --item 保存
"""

import ctypes
import json
import sys
import time
from ctypes import wintypes

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


def walk(c, md=26):
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


def find_file_box(w):
    for d, c in walk(w, 34):
        k = cls_of(c)
        if "message-container" in k and "file-message" in k and "message-container__avatar" not in k:
            return c
    return None


def visible_titles(pid):
    u = ctypes.windll.user32
    out = []
    proto = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

    def cb(hwnd, _lp):
        if not u.IsWindowVisible(hwnd):
            return True
        p = wintypes.DWORD()
        u.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
        if int(p.value) != int(pid):
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
    hwnd = arg("hwnd")
    item_name = arg("item", "保存")
    try:
        w = auto.ControlFromHandle(int(hwnd))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:80]}, ensure_ascii=False))
        return 1
    if w is None:
        print(json.dumps({"ok": False, "error": "window_null"}, ensure_ascii=False))
        return 1

    pid = int(w.ProcessId or 0)

    box = find_file_box(w)
    if box is None:
        print(json.dumps({"ok": False, "error": "这一屏没有文件消息"}, ensure_ascii=False))
        return 1

    try:
        w.SetActive(waitTime=0.2)
        time.sleep(0.35)
    except Exception:
        pass

    before = {x["hwnd"] for x in visible_titles(pid)}

    box.RightClick(waitTime=0.5)
    time.sleep(1.0)

    items = [name_of(x) for d, x in walk(w, 30) if "q-context-menu-item" in cls_of(x)]
    item = None
    for d, x in walk(w, 30):
        if "q-context-menu-item" in cls_of(x) and name_of(x) == item_name:
            item = x
            break
    if item is None:
        for _ in range(2):
            try:
                auto.SendKeys("{Esc}", waitTime=0.1)
            except Exception:
                pass
        print(json.dumps({"ok": False, "error": f"菜单里没有「{item_name}」", "menu": items}, ensure_ascii=False))
        return 1

    try:
        item.GetPattern(auto.PatternId.InvokePattern).Invoke(waitTime=0.2)
        clicked = "invoke"
    except Exception:
        try:
            item.Click(waitTime=0.2)
            clicked = "click"
        except Exception as e:
            print(json.dumps({"ok": False, "error": "点不到:" + str(e)[:50]}, ensure_ascii=False))
            return 1

    time.sleep(2.0)
    after = [x for x in visible_titles(pid) if x["hwnd"] not in before]
    print(json.dumps({"ok": True, "clicked": clicked, "item": item_name, "new_windows": after}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
