# -*- coding: utf-8 -*-
"""诊断：把 QQ 消息区里那些「灰字提示」的 className 打出来。

为什么需要：戳一戳、禁言、撤回、入群 这类提示在 QQ NT 里**不是普通消息气泡**，
它们的 className 和正文气泡不同；`qq-read.py` 只收 `message-container`，
所以这些提示目前全被漏掉（戳一戳因此收不到）。

这个脚本不猜，直接把树里所有带 container / tip / gray / notice 的节点
连同 Name（也就是显示出来的字）一起打出来，照着实测结果写解析。

用法（在 seat 里跑）：
    python qq-probe-classes.py --hwnd 132512
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


def walk(root, max_depth=34):
    out = []
    stack = [(root, 0)]
    while stack:
        c, d = stack.pop()
        if d > max_depth:
            continue
        out.append((d, c))
        try:
            kids = c.GetChildren()
        except Exception:
            kids = []
        for k in kids:
            stack.append((k, d + 1))
    return out


KEY = ("container", "tip", "gray", "notice", "system", "reminder", "divider")


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

    # 会话标题，用来确认读的是哪个会话
    header = ""
    for d, c in nodes:
        k = cls_of(c)
        if "chat-header" in k:
            nm = name_of(c)
            if nm:
                header = nm

    hits = []
    seen = set()
    for d, c in nodes:
        k = cls_of(c)
        nm = name_of(c)
        low = k.lower()
        if not any(x in low for x in KEY):
            continue
        key = (k, nm[:60])
        if key in seen:
            continue
        seen.add(key)
        hits.append({"depth": d, "cls": k[:90], "name": nm[:120]})

    print(
        json.dumps(
            {"ok": True, "session": header, "nodes": len(nodes), "hits": hits},
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
