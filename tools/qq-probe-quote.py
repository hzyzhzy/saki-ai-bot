# -*- coding: utf-8 -*-
"""诊断：**引用消息**（`@Saki 评价` 那条带引用的）在控件树里长什么样。

## 用户报的问题（2026-11-17 18:0x）
截图：有人引用了一条消息（引用了「白子奈丘Shiroko Naoka/SRK_Nankyu 不」+ 一张图），
正文写 `@Saki 评价`。她的回复是「**拿自己名字加个 false 就让我评价，这我评啥啊**」——
说明她**只看到 `@Saki 评价`，看不到被引用的内容** ✗

⇒ `qq-read.py` 的 `parse_message` 没有处理引用。

## 这个脚本做什么
把当前屏幕上每个 `message-container` 里的**控件类名清单**打出来，
再列出所有含 `quote` / `reply` / `refer` / `source` 的类名 —— 用这些去找引用的落点。

    python qq-probe-quote.py --hwnd 198002
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

    nodes = walk(win, 32)

    # ① 所有含 quote/reply/refer/source/block 的类名（引用可能藏在这些里）
    suspects = {}
    for d, c in nodes:
        k = cls_of(c)
        if not k:
            continue
        kl = k.lower()
        if any(w in kl for w in ("quote", "reply", "refer", "source", "cite", "block", "origin")):
            nm = name_of(c)
            suspects[k] = suspects.get(k, 0) + 1
            if nm and len(nm) < 60:
                suspects[k + " | Name=" + nm[:30]] = suspects.get(k, 0)

    # ② 每个 message-container 里的类名清单（只取前 4 条消息，够看结构了）
    containers = []
    for d, c in nodes:
        if "message-container" not in cls_of(c) or "message-container__avatar" in cls_of(c):
            continue
        inner = []
        for dd, x in walk(c, 8):
            k = cls_of(x)
            if k:
                inner.append(k.split()[0] if " " in k else k)
        # 去重保序
        seen = set()
        uniq = []
        for k in inner:
            if k in seen:
                continue
            seen.add(k)
            uniq.append(k)
        containers.append({"classes": uniq[:24]})
        if len(containers) >= 4:
            break

    print(
        json.dumps(
            {
                "ok": True,
                "suspect_classes": suspects,
                "containers": containers,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
