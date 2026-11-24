# -*- coding: utf-8 -*-
"""诊断：在**整棵树**里找含指定字样的节点，把它和祖先链、兄弟都打出来。

## 为什么前面那版找不到
文件消息的文件名在 UIA 里被**拆成两段**（实测 `export_co` + `nfig.txt`），
而且它可能挂在比 `message-container` 更深的层里 ——
按「含 X 的文本 → 往上找 message-container」这条会漏。

所以这一版：**先找文本**，然后把它的祖先链（10 层）+ 每一层的兄弟都打出来，
不管它挂在哪都能看清楚。

    python qq-probe-text-ancestors.py --hwnd 132512 --match export
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


def walk(c, md=40):
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
    match = arg("match", "")
    try:
        w = auto.ControlFromHandle(int(hwnd))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:80]}, ensure_ascii=False))
        return 1
    if w is None:
        print(json.dumps({"ok": False, "error": "window_null"}, ensure_ascii=False))
        return 1

    nodes = walk(w, 40)

    hits = []
    for d, c in nodes:
        nm = name_of(c)
        if nm and match and match in nm:
            hits.append((d, c, nm))
    if not hits:
        print(json.dumps({"ok": False, "error": f"整棵树里没有含「{match}」的节点"}, ensure_ascii=False))
        return 1

    out = []
    for d, c, nm in hits[:3]:
        chain = []
        cur = c
        for _ in range(10):
            if cur is None:
                break
            chain.append(
                {
                    "cls": cls_of(cur)[:90],
                    "name": name_of(cur)[:50],
                    "type": (cur.ControlTypeName or "")[:26],
                }
            )
            try:
                cur = cur.GetParentControl()
            except Exception:
                cur = None

        # 找到 message-container 那一层之后，把它的整棵子树打出来（兄弟都在里面）
        box = c
        for _ in range(10):
            if box is None:
                break
            if "message-container" in cls_of(box):
                break
            try:
                box = box.GetParentControl()
            except Exception:
                box = None
        sub = []
        if box is not None:
            for dd, x in walk(box, 16):
                sub.append({"d": dd, "cls": cls_of(x)[:80], "name": name_of(x)[:50], "type": (x.ControlTypeName or "")[:24]})

        out.append({"matched": nm, "depth": d, "chain": chain, "box_subtree": sub[:40]})

    print(json.dumps({"ok": True, "hits": len(hits), "detail": out}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
