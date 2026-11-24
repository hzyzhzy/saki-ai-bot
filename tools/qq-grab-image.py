# -*- coding: utf-8 -*-
"""把界面上某块区域**截下来存成 PNG**（客户端方案补看图片只能用这招）。

## 为什么只能截屏
客户端方案拿不到 QQ 的图片文件：`pic-element` 的 className 第一段虽然像 fileid
（实测 `f2vnRVay8ztZBnqxSA7L`），但那是 QQ 内部 id，和本地缓存目录里的文件名对不上，
UIA 也不暴露原始 URL。⇒ 唯一能拿到"这张图长什么样"的办法就是**按矩形裁屏**。

## 限制（写清楚，别指望它）
1. **图片必须当前在屏幕上可见** —— 滚出视口（rect 的 y 是负数）就截不到，
   调用方要自己判断并退回占位文本。
2. 截到的是**缩略图**（QQ 气泡里显示多大就多大），识图效果比不上原图。
3. 跑在 seat 里（`anode exec`）⇒ 截的是 seat 的桌面，不碰用户自己的屏幕 ✓

## 用法
    python qq-grab-image.py --l 547 --t 120 --r 771 --b 400 --out C:\\Temp\\x.png
"""

import json
import os
import sys
import tempfile


def arg(name, default=""):
    a = sys.argv
    for i, x in enumerate(a):
        if x == "--" + name and i + 1 < len(a):
            return a[i + 1]
    return default


def main():
    try:
        from PIL import ImageGrab
    except Exception as e:
        print(json.dumps({"ok": False, "error": "没有 PIL：" + str(e)[:60]}, ensure_ascii=False))
        return 1

    try:
        l = int(arg("l"))
        t = int(arg("t"))
        r = int(arg("r"))
        b = int(arg("b"))
    except Exception:
        print(json.dumps({"ok": False, "error": "要 --l --t --r --b（整数）"}, ensure_ascii=False))
        return 1

    if r <= l or b <= t:
        print(json.dumps({"ok": False, "error": "矩形是空的（图片已滚出屏幕？）"}, ensure_ascii=False))
        return 1
    if t < 0:
        print(
            json.dumps(
                {"ok": False, "error": "图片在视口上方（t=%d < 0），截不到" % t},
                ensure_ascii=False,
            )
        )
        return 1

    out = arg("out")
    if not out:
        out = os.path.join(tempfile.gettempdir(), "qq-img-%d-%d.png" % (l, t))
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)

    try:
        img = ImageGrab.grab(bbox=(l, t, r, b))
        img.save(out, "PNG")
    except Exception as e:
        print(json.dumps({"ok": False, "error": "截图失败：" + str(e)[:80]}, ensure_ascii=False))
        return 1

    print(
        json.dumps(
            {"ok": True, "path": out, "w": img.width, "h": img.height, "bytes": os.path.getsize(out)},
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
