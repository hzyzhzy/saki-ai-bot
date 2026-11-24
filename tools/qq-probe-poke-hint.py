# -*- coding: utf-8 -*-
"""诊断：把界面上「戳了戳」那条提示的完整结构打出来（自己 + 祖先链）。

为什么需要：`qq-poke.py` 已经能戳出去了（`hint="戳了戳"`），
但 `qq-read.py` **读不到**它 —— 因为戳一戳的提示**不在 `message-container` 里**
（那个循环只收 message-container）。要写解析，就得知道它到底是什么 className、
挂在谁下面、有没有头像（有头像才能知道"谁戳了谁"）。

用法（在 seat 里跑）：
    python qq-probe-poke-hint.py --hwnd 132512
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


def chain_of(c, up=6):
    """自己 + 往上数 6 层（className + Name + rect）"""
    out = []
    cur = c
    for i in range(up):
        if cur is None:
            break
        out.append({"cls": cls_of(cur)[:90], "name": name_of(cur)[:80], "rect": rect_of(cur)})
        try:
            cur = cur.GetParentControl()
        except Exception:
            cur = None
    return out


def main():
    hwnd = arg("hwnd")
    key = arg("key", "戳")
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
    hits = []
    seen = set()
    for d, c in nodes:
        nm = name_of(c)
        if not nm or key not in nm:
            continue
        if len(nm) > 60:
            continue
        sig = (cls_of(c), nm)
        if sig in seen:
            continue
        seen.add(sig)
        hits.append({"depth": d, "cls": cls_of(c)[:90], "name": nm[:100], "rect": rect_of(c)})

    # 对每个命中，把它**父级的子树**也打出来（要看清它旁边有没有头像）
    details = []
    for d, c in nodes:
        nm = name_of(c)
        if not nm or key not in nm or len(nm) > 60:
            continue
        details.append({"chain": chain_of(c, 7)})
        break  # 只展开第一个命中的祖先链

    print(
        json.dumps(
            {"ok": True, "hits": hits, "first_chain": details[0]["chain"] if details else []},
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
