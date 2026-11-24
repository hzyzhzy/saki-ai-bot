# -*- coding: utf-8 -*-
"""诊断：右键会话列表里的某一项，看菜单里有没有「打开独立聊天窗口」。

## 为什么要独立窗口
客户端方案只有一个"当前打开的会话" —— 别的群有人 @她，适配器根本读不到 ✗
QuitBot（同目录那个同类项目）的做法是：**给每个要监听的会话开一个独立聊天窗口**，
每个窗口各读各的（docs/architecture.md 里的 `detached` 模式）。
独立窗口是**独立的顶层窗口**，有自己的 HWND ⇒ `qq-read.py --hwnd <那个>` 就能读。

## 这个脚本只做诊断
右键会话项 → 把菜单项名字全打出来，**什么都不点**。

    python qq-probe-session-menu.py --hwnd 132512 --match 示例服务器
"""

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


def name_of_item(c):
    """会话项名字 = `item__info` 里第一个 TextControl（和 qq-py.py 同口径）"""
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


def top_windows():
    out = []
    try:
        for c in auto.GetRootControl().GetChildren():
            out.append(c)
    except Exception:
        pass
    return out


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
        print(json.dumps({"ok": False, "error": "会话列表里没找到匹配「%s」的项" % match}, ensure_ascii=False))
        return 1

    nm, c = target
    before = set()
    for tw in top_windows():
        try:
            before.add(int(tw.NativeWindowHandle or 0))
        except Exception:
            pass

    try:
        c.RightClick(waitTime=0.6)
    except Exception as e:
        print(json.dumps({"ok": False, "error": "右键失败:" + str(e)[:60], "item": nm}, ensure_ascii=False))
        return 1
    time.sleep(0.9)

    items = []
    for d, x in walk(w, 30):
        k = cls_of(x)
        if "q-context-menu-item" in k:
            n2 = name_of(x)
            if n2 and n2 not in items:
                items.append(n2)

    # 顺便看有没有新顶层窗口（菜单有时是独立窗口）
    newwins = []
    for tw in top_windows():
        try:
            h = int(tw.NativeWindowHandle or 0)
        except Exception:
            continue
        if h and h not in before:
            newwins.append({"hwnd": h, "cls": cls_of(tw)[:40], "name": name_of(tw)[:40]})

    for _ in range(2):
        try:
            auto.SendKeys("{Esc}", waitTime=0.15)
        except Exception:
            pass

    print(
        json.dumps(
            {
                "ok": True,
                "item": nm,
                "menu_items": items,
                "has_detached": "打开独立聊天窗口" in items,
                "new_windows": newwins,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
