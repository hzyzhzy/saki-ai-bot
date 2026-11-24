# -*- coding: utf-8 -*-
"""诊断：会话列表里每一项的**屏幕坐标**，看哪些是"真在视口里"的。

## 为什么要查（2026-11-17 17:17）
daemon 用 `qp.tree(win)` 遍历整棵树，结果**切了 37 个会话**（不只是前 8 个可见的）——
说明滚出视口的项**仍然留在控件树里**，"可见"这个假设不成立。

`BoundingRectangle` 应该能给真实坐标：滚出视口的项 top 会是负数或超出窗口高度。
先把这个分布打出来，再决定过滤条件（用列表容器的 rect 还是窗口 rect）。

    python qq-probe-item-rects.py --hwnd 198002
"""

import json
import sys

import uiautomation as auto

CLS_ITEM = "recent-contact-item"


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
    hwnd = int(arg("hwnd", "0") or 0)
    if not hwnd:
        print(json.dumps({"ok": False, "error": "要 --hwnd"}, ensure_ascii=False))
        return 1
    try:
        win = auto.ControlFromHandle(hwnd)
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:80]}, ensure_ascii=False))
        return 1
    if win is None:
        print(json.dumps({"ok": False, "error": "window_null"}, ensure_ascii=False))
        return 1

    wr = win.BoundingRectangle
    win_rect = [wr.left, wr.top, wr.right, wr.bottom]

    # 找会话列表容器（q-scroll-view 或 session-list 之类）
    list_rect = None
    for d, c in walk(win, 30):
        k = cls_of(c)
        if "recent-contact-list" in k or ("q-scroll-view" in k and "ml-root" not in k):
            r = c.BoundingRectangle
            list_rect = [r.left, r.top, r.right, r.bottom]
            break

    items = []
    for d, c in walk(win, 34):
        if CLS_ITEM not in cls_of(c):
            continue
        nm = item_name(c)
        if not nm:
            continue
        try:
            r = c.BoundingRectangle
            rect = [r.left, r.top, r.right, r.bottom]
        except Exception:
            rect = None
        items.append({"name": nm, "rect": rect})

    print(
        json.dumps(
            {
                "ok": True,
                "win_rect": win_rect,
                "list_rect": list_rect,
                "count": len(items),
                "items": items[:40],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
