# -*- coding: utf-8 -*-
"""诊断：界面上的图片消息能拿到什么（补看图片要靠它）。

客户端方案拿不到 QQ 的图片文件，能拿到的只有 UIA 暴露的东西：
`pic-element` 的 className 第一段是 QQ 内部 fileid、Name 一般是「图片」两个字。
这个脚本把这类元素的**所有属性**和**屏幕矩形**都打出来，
判断能不能：① 用 fileid 去本地缓存目录找原图；② 直接按矩形裁屏。
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


def safe(fn, default=""):
    try:
        v = fn()
        return "" if v is None else str(v)
    except Exception:
        return default


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

    session = ""
    for d, c in nodes:
        if "chat-header" in safe(lambda: c.ClassName):
            nm = safe(lambda: c.Name)
            if nm:
                session = nm

    imgs = []
    for d, c in nodes:
        k = safe(lambda: c.ClassName)
        if "pic-element" not in k:
            continue
        r = None
        try:
            rr = c.BoundingRectangle
            r = [rr.left, rr.top, rr.right, rr.bottom]
        except Exception:
            pass
        imgs.append(
            {
                "depth": d,
                "cls": k[:120],
                "name": safe(lambda: c.Name)[:80],
                "help": safe(lambda: c.HelpText)[:120],
                "type": safe(lambda: c.ControlTypeName),
                "value": safe(lambda: getattr(c, "ValuePattern", lambda: None))[:60],
                "rect": r,
            }
        )

    print(json.dumps({"ok": True, "session": session, "count": len(imgs), "images": imgs}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
