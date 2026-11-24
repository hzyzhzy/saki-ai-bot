# -*- coding: utf-8 -*-
"""诊断：戳一戳定位为什么总落在 [513,123]。

打印：
  · message-panel 的实际矩形（用来判断"在不在视口里"）
  · 每个候选头像的矩形（谁的、屏幕坐标、算不算在面板内）
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
        return (c.Name or "").strip()
    except Exception:
        return ""


def rc(c):
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
    try:
        w = auto.ControlFromHandle(int(hwnd))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:80]}, ensure_ascii=False))
        return 1
    if w is None:
        print(json.dumps({"ok": False, "error": "window_null"}, ensure_ascii=False))
        return 1

    nodes = walk(w, 34)

    panels = []
    for d, c in nodes:
        if "message-panel" in cls_of(c):
            panels.append({"cls": cls_of(c)[:70], "rect": rc(c)})

    win = {"rect": rc(w), "cls": cls_of(w)}

    cands = []
    for d, c in nodes:
        k = cls_of(c)
        if "message-container" not in k or "message-container__avatar" in k:
            continue
        r = rc(c)
        if r is None:
            continue
        # 这条消息的昵称
        nick = ""
        for dd, x in walk(c, 12):
            if "avatar-span" in cls_of(x):
                nm = name_of(x)
                if nm:
                    nick = nm
                    break
        if nick != "谷雨":
            continue
        av = None
        for dd, x in walk(c, 8):
            kx = cls_of(x)
            if "message-container__avatar" in kx or "avatar-native" in kx:
                av = x
                break
        cands.append(
            {
                "nick": nick,
                "box_rect": r,
                "avatar_rect": rc(av) if av is not None else None,
                "avatar_cls": cls_of(av)[:60] if av is not None else None,
            }
        )

    print(json.dumps({"ok": True, "window": win, "panels": panels, "cands": cands}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
