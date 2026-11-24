# -*- coding: utf-8 -*-
"""诊断：把**文件消息**那条的完整子树打出来（className + Name + rect）。

## 为什么需要（2026-11-17 实测）
用户在群里发了个 `export_config.txt`，而 `qq-read.py` 把它读成了
    `kind: 'text'`、文件名还断成 `export_co nfig.txt`
⇒ 说明 `qq-read.py` 里那条判据 `if "file-name" in className` **根本没命中**，
  文件消息的控件结构和代码里假设的不一样 ⇒
  ① `kind` 不是 `file`（所以「读群友发的文件」那条链压根进不去）
  ② `qq-probe-file-menu.py` 也按 `file-element` / `file-name` 找 ⇒ 永远找不到 ✗

先看真实结构，再改解析。

    python qq-probe-file-msg.py --hwnd 132512 --match export_co
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


def rect_of(c):
    try:
        r = c.BoundingRectangle
        return [r.left, r.top, r.right, r.bottom]
    except Exception:
        return None


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

    # 找"包含 match 文本"的 message-container
    box = None
    for d, c in nodes:
        k = cls_of(c)
        if "message-container" not in k or "message-container__avatar" in k:
            continue
        hit = False
        for dd, x in walk(c, 14):
            nm = name_of(x)
            if nm and match and match in nm:
                hit = True
                break
        if hit:
            box = c
            break

    if box is None:
        print(json.dumps({"ok": False, "error": f"没找到含「{match}」的消息容器"}, ensure_ascii=False))
        return 1

    tree = []
    for d, x in walk(box, 16):
        tree.append(
            {
                "d": d,
                "cls": cls_of(x)[:90],
                "name": name_of(x)[:60],
                "type": (x.ControlTypeName or "")[:30],
                "rect": rect_of(x),
            }
        )

    print(json.dumps({"ok": True, "count": len(tree), "tree": tree}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
