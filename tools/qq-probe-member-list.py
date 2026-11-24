# -*- coding: utf-8 -*-
"""诊断：群成员列表里的项长什么样（className / Name / rect）。

为什么要用成员列表：消息区的头像 `BoundingRectangle` 对**文件消息**会给出
过期/错位的坐标（实测：谷雨那条 45轮.txt 的 avatar 报 [497,107,529,139]，
中心 [513,123] 落在了 QQ 的搜索框上 ⇒ 右键点空，菜单里自然没有「戳一戳」）。
群成员列表则**一直可见、位置稳定**，比滚动区可靠。
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
    want = arg("want", "谷雨")
    try:
        w = auto.ControlFromHandle(int(hwnd))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:80]}, ensure_ascii=False))
        return 1
    if w is None:
        print(json.dumps({"ok": False, "error": "window_null"}, ensure_ascii=False))
        return 1

    hits = []
    seen = set()
    for d, c in walk(w, 34):
        k = cls_of(c)
        nm = name_of(c)
        low = k.lower()
        if "member" not in low:
            continue
        sig = (k, nm)
        if sig in seen:
            continue
        seen.add(sig)
        hits.append({"depth": d, "cls": k[:80], "name": nm[:40], "rect": rc(c)})

    # 目标昵称出现在哪几个元素上
    target = []
    for d, c in walk(w, 34):
        nm = name_of(c)
        if nm == want:
            target.append({"depth": d, "cls": cls_of(c)[:80], "rect": rc(c)})

    print(json.dumps({"ok": True, "members": hits[:40], "target": target[:20]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
