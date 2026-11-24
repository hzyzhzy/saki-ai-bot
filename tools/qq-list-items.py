# -*- coding: utf-8 -*-
"""诊断：`qq-py.py` 的会话项名字到底取成了什么（切群匹配不上就是这里的问题）。"""

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


def walk(c, md=12):
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


def find_info(c, depth=0):
    if depth > 6:
        return None
    try:
        for x in c.GetChildren():
            k = cls_of(x)
            if "item__info" in k:
                return x
            r = find_info(x, depth + 1)
            if r is not None:
                return r
    except Exception:
        pass
    return None


def main():
    hwnd = arg("hwnd")
    w = auto.ControlFromHandle(int(hwnd))
    if w is None:
        print(json.dumps({"ok": False, "error": "window_null"}, ensure_ascii=False))
        return 1

    nodes = walk(w, 34)
    out = []
    for d, c in nodes:
        if CLS_ITEM not in cls_of(c):
            continue
        i = find_info(c)
        texts = []
        if i is not None:
            for dd, x in walk(i, 6):
                if (x.ControlTypeName or "") == "TextControl":
                    nm = name_of(x)
                    if nm:
                        texts.append(nm)
        joined = "".join(texts)
        out.append({"joined": joined, "texts": texts[:6], "cls": cls_of(c)[:60]})

    print(json.dumps({"ok": True, "count": len(out), "items": out}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
