#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""qq-to-anim.py —— 把静态图转成**动图 GIF**，让 QQ 发出去时显示成「表情」而不是「图片」。

## 为什么需要
客户端方案（anode 座位）没有 OneBot 的 `sub_type: 1`（那是 NapCat 特有字段，
用来告诉 QQ "这是表情不是图片"）✗
但实测：**动图 GIF 在 QQ 里更容易被当成表情渲染**（用户：「发动图默认会发送成表情格式」）。

所以规矩是：**表情库里一律存动图**。
- 导入时是静态图（png / jpg / webp / 单帧 gif）⇒ 自动转成 2 帧动图 ✓
- 已经是动图（n_frames > 1）⇒ **原样不动**（不重编码、不掉画质）✓

## 「2 帧动图」怎么造
把那一帧**原样写两次**，间隔 100ms。
⚠️ 为什么不做"1 像素抖动"：那会让画面轻微抖、而且对透明通道 GIF 容易出杂边。
   两帧完全一样最稳，QQ 也会按动图处理（`n_frames > 1` 就够了）✓

## 用法
    python qq-to-anim.py --file "library/xxx.png"      # 原地转换（png → 同名 .gif）
    python qq-to-anim.py --check "library/xxx.gif"     # 只问"是不是动图"，不转

输出最后一行 JSON：
    {"ok": true, "animated": true, "converted": false, "file": "xxx.gif"}
"""

import json
import os
import sys

from PIL import Image


def arg(name, default=''):
    a = sys.argv
    for i, x in enumerate(a):
        if x == '--' + name and i + 1 < len(a):
            return a[i + 1]
    return default


def frames_of(path):
    try:
        im = Image.open(path)
        return int(getattr(im, 'n_frames', 1) or 1), im
    except Exception:
        return 0, None


def to_anim_gif(src, dst, duration_ms=100):
    """静态图 → 2 帧动图 GIF（帧内容完全相同）。返回 True/False。"""
    im = Image.open(src)
    # GIF 只支持调色板 / 有限色 ⇒ 统一转成 RGBA 再量化，透明通道能保住
    try:
        im.seek(0)
    except Exception:
        pass
    im = im.convert('RGBA')

    # 透明背景：GIF 只支持"全透明或全不透明" ⇒ 用调色板 + transparency 索引
    alpha = im.getchannel('A')
    has_alpha = alpha.getextrema()[0] < 250

    frames = [im.copy(), im.copy()]
    # ⚠️⚠️⚠️ 关键（踩了四次才对）：两帧**必须有一点差异**，否则 PIL 存 GIF 合并成单帧 ✗
    #    ⚠️ 差异必须在 **RGB** 上 —— GIF 的 P 模式**没有 alpha**，改 alpha 会被量化抹平 ✗
    #    ⚠️⚠️ 而且差异**必须够大** —— 只把红通道 ±1 时，量化到同一个调色板项就白改了
    #      （实测：47 个里 27 个"转完还是单帧"，全是颜色本身就接近的图）✗
    #    ⇒ 做法：第 2 帧把**左上角 1 个像素**改成**纯黑或纯白**（取和原色反差大的那个）。
    #      1 个像素≈不可见，但色差足够大到一定落在不同调色板项 ✓
    try:
        px2 = frames[1].load()
        r0, g0, b0, a0 = px2[0, 0]
        lum = (r0 + g0 + b0) / 3
        px2[0, 0] = (255, 255, 255, a0) if lum < 128 else (0, 0, 0, a0)
    except Exception:
        pass
    # ⚠️⚠️ 2026-11-21 **简化版**（之前那版带透明处理的完全出不来多帧）——
    #    实测可行的最小写法（PIL 直接验证过能出 2 帧）：
    #      两张 **独立的 P 模式图** + `append_images` + `disposal=1`
    #    ⚠️ 两个坑：
    #      ① 两帧**共用同一个 palette 对象** ⇒ PIL 认成同一帧、只存一张 ✗
    #      ② `disposal=2` + 两帧几乎相同 ⇒ 被优化成单帧 ✗ （用 1）
    #    ⚠️ 透明：不做特殊调色板处理（那版实测不工作）。
    #      静态表情多半是不透明白底/彩底，转换后照常显示；
    #      真有透明需求的，用原来的 png 走正文 `[表情:tag]` 那条路（那条不转格式）。
    def to_pal(fr):
        # 白底铺一层再量化 —— 透明区在 GIF 里会变成白，比变黑好看
        bg = Image.new('RGB', fr.size, (255, 255, 255))
        try:
            bg.paste(fr, (0, 0), fr)
        except Exception:
            bg.paste(fr.convert('RGB'), (0, 0))
        return bg.quantize(colors=256)

    pal0 = to_pal(frames[0])
    pal1 = to_pal(frames[1]).copy()   # copy()：确保是独立对象

    pal0.save(
        dst,
        'GIF',
        save_all=True,
        append_images=[pal1],
        duration=duration_ms,
        loop=0,
        disposal=1,
    )
    n, _ = frames_of(dst)
    return n > 1


def main():
    fp = arg('file')
    if not fp:
        print(json.dumps({'ok': False, 'error': '要 --file'}, ensure_ascii=False))
        return 1
    if not os.path.isfile(fp):
        print(json.dumps({'ok': False, 'error': '文件不存在: ' + fp}, ensure_ascii=False))
        return 1

    n, _im = frames_of(fp)
    if n == 0:
        print(json.dumps({'ok': False, 'error': '读不了这个图: ' + fp}, ensure_ascii=False))
        return 2

    if ('--check' in sys.argv):
        print(json.dumps({'ok': True, 'animated': n > 1, 'frames': n, 'file': fp}, ensure_ascii=False))
        return 0

    if n > 1:
        print(json.dumps({'ok': True, 'animated': True, 'converted': False,
                          'frames': n, 'file': fp}, ensure_ascii=False))
        return 0

    # 静态 ⇒ 转成同名 .gif
    base, _ext = os.path.splitext(fp)
    dst = base + '.gif'
    try:
        ok = to_anim_gif(fp, dst)
    except Exception as e:
        print(json.dumps({'ok': False, 'error': '转换失败: ' + str(e)[:100]}, ensure_ascii=False))
        return 3

    if not ok:
        print(json.dumps({'ok': False, 'error': '转出来还是单帧'}, ensure_ascii=False))
        return 4

    # 原文件（非 gif）删掉，避免库里两份
    try:
        if os.path.abspath(dst) != os.path.abspath(fp):
            os.remove(fp)
    except Exception:
        pass

    print(json.dumps({'ok': True, 'animated': True, 'converted': True,
                      'file': os.path.basename(dst),
                      'bytes': os.path.getsize(dst)}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
