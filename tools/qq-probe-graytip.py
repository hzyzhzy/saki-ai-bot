# -*- coding: utf-8 -*-
"""诊断：把界面上**所有灰字提示**（`gray-tip-message`）的完整子树打出来。

为什么：戳一戳的提示结构已经摸到了 ——
    gray-tip-message > gray-tip-message__inner > gray-tip-element > 「戳了戳」
但它**只有「戳了戳」三个字**，人名不在这个 TextControl 里（可能是兄弟节点）。
要拼出「谁 戳了谁」，就得看清整个 gray-tip-message 里都有什么。

顺带这个脚本能覆盖：禁言提示、撤回提示、入群提示 —— 它们都是同一类灰字。

用法（在 seat 里跑）：
    python qq-probe-graytip.py --hwnd 132512
"""

import json
import sys

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
        return c.Name or ""
    except Exception:
        return ""


def rect_of(c):
    try:
        r = c.BoundingRectangle
        return [r.left, r.top, r.right, r.bottom]
    except Exception:
        return None


def walk(c, md=34):
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
    if not hwnd:
        print(json.dumps({"ok": False, "error": "要 --hwnd"}, ensure_ascii=False))
        return 1
    try:
        w = auto.ControlFromHandle(int(hwnd))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:80]}, ensure_ascii=False))
        return 1
    if w is None:
        print(json.dumps({"ok": False, "error": "window_null"}, ensure_ascii=False))
        return 1

    nodes = walk(w, 34)

    session = ""
    for d, c in nodes:
        if "chat-header" in cls_of(c):
            nm = name_of(c)
            if nm:
                session = nm

    tips = []
    for d, c in nodes:
        k = cls_of(c)
        if "gray-tip-message" not in k:
            continue
        if "inner" in k:  # 只要根，子层会在下面展开
            continue
        sub = []
        for dd, cc in walk(c, 12):
            nm = name_of(cc)
            cc_cls = cls_of(cc)
            if not nm and not cc_cls:
                continue
            sub.append(
                {
                    "depth": dd,
                    "cls": cc_cls[:80],
                    "name": nm[:100],
                    "rect": rect_of(cc),
                }
            )
        tips.append({"rect": rect_of(c), "parts": sub})

    # 按屏幕位置从上到下排，方便对照
    tips.sort(key=lambda t: (t.get("rect") or [0, 0])[1])

    print(
        json.dumps(
            {"ok": True, "session": session, "count": len(tips), "tips": tips},
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
