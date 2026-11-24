# -*- coding: utf-8 -*-
"""诊断：把控件树里**所有图片相关的控件**打出来（类名 + 屏幕矩形 + 所属消息容器）。

## 现场（2026-11-17 20:23）
`qq-read.py --limit 60` 读 示例服务器 2026 只有 15 条，其中**只有 1 个 `kind=image`**
（Anon 的，`rect=[446,-453,770,-303]`，已滚出视口）。
但用户截图显示 **<主人> 发的房间照片明显在视口内**，而且紧接着还有人评论「这是什么梦想中的房间吗」。
⇒ `parse_message` 没把它识别成图片消息（或者那个容器根本没被当成 message-container）。

## 这个脚本查什么
1. 树里所有类名含 `pic` / `img` / `image` / `photo` 的控件，带 rect
2. 每个 `message-container` 的类名清单（看那个图消息的容器长什么样）
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


def rect_of(c):
    try:
        r = c.BoundingRectangle
        return [r.left, r.top, r.right, r.bottom]
    except Exception:
        return None


def main():
    hwnd = int(arg("hwnd", "0") or 0)
    if not hwnd:
        print(json.dumps({"ok": False, "error": "要 --hwnd"}, ensure_ascii=False))
        return 1
    win = auto.ControlFromHandle(hwnd)
    if win is None:
        print(json.dumps({"ok": False, "error": "window_null"}, ensure_ascii=False))
        return 1

    nodes = walk(win, 32)

    # ① 所有图片相关控件
    pics = []
    for d, c in nodes:
        k = cls_of(c)
        kl = k.lower()
        if any(w in kl for w in ("pic", "img", "image", "photo")):
            pics.append(
                {
                    "cls": k[:70],
                    "name": name_of(c)[:20],
                    "rect": rect_of(c),
                    "ctrl": c.ControlTypeName,
                }
            )

    # ② 每个 message-container 的类名第一段（看那个图消息的容器长什么样）
    containers = []
    for d, c in nodes:
        k = cls_of(c)
        if "message-container" not in k:
            continue
        inner = []
        seen = set()
        for dd, x in walk(c, 8):
            kk = cls_of(x)
            if not kk:
                continue
            first = kk.split()[0] if " " in kk else kk
            if first in seen:
                continue
            seen.add(first)
            inner.append(first)
        containers.append(
            {
                "container_cls": k.split()[0] if " " in k else k,
                "rect": rect_of(c),
                "first_classes": inner[:14],
            }
        )

    print(
        json.dumps(
            {
                "ok": True,
                "win_rect": rect_of(win),
                "pics": pics[:40],
                "pic_count": len(pics),
                "containers": containers[:20],
                "container_count": len(containers),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
