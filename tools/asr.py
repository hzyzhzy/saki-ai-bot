# -*- coding: utf-8 -*-
"""
把 B站 视频**转成文字**（给主动评论用）。

## 为什么要这个（2026-10-26）

参考 BV1SHnH6FEsR（《DSH 插件判据拆解》）+ `dsh-bili-scroll` 作者在评论区的补充：

> **二、字幕不信官方轨。** ai-zh 轨不是每条都有，我实测过一批热门视频，
> **大半的字幕列表是空的**。所以本地挂了**转写**，硬字幕也能读。

我们原来的做法：只把 `标题 + 简介` 喂给模型 ⇒ 评论容易空泛、像没看过。
挂上转写之后模型**真的知道视频在说什么**，评论才有内容 ✓

## 用法（被 `bili-proactive-comment.mjs` 调用）

    python tools/asr.py --bvid BV1xxx              # 下载 + 转写
    python tools/asr.py --audio D:/x.wav           # 已经有音频

输出一行 JSON（stdout）：{"ok":true,"text":"...","seconds":12.3}

## 三个讲究

1. **只转前 `--max-sec` 秒**（默认 90）—— 够判断"这条在说什么"了，
   全片转写既慢又没必要（视频动辄十几分钟）✓
2. **强制简体**：whisper 的 `zh` 默认吐**繁体**（实测「那這邊沒有…」），
   用 `initial_prompt='以下是普通话的句子。'` 压回来 ✓
3. **优先 CPU**：GPU 要留给 TTS/游戏；base 模型 CPU 转 90 秒约 8~20 秒，能接受 ✓
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

# whisper 解码音频要 ffmpeg —— 这台机器 PATH 里没有，用 bilibili 自带那个
FFMPEG_CANDIDATES = [
    r"<本机用户目录>\AppData\Roaming\bilibili\ffmpeg",
    r"C:\Program Files\ffmpeg\bin",
]


def ensure_ffmpeg():
    if shutil.which("ffmpeg"):
        return True
    for d in FFMPEG_CANDIDATES:
        if os.path.isfile(os.path.join(d, "ffmpeg.exe")):
            os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
            return True
    return False


def find_ytdlp():
    for p in [shutil.which("yt-dlp"), r"<本机用户目录>\miniconda3\Scripts\yt-dlp.exe"]:
        if p and os.path.isfile(p):
            return p
    return None


def download_audio(bvid, out_dir):
    """用 yt-dlp 下**只要音频**（不转码，省时间）"""
    ytdlp = find_ytdlp()
    if not ytdlp:
        raise RuntimeError("找不到 yt-dlp")
    url = "https://www.bilibili.com/video/%s" % bvid
    out = os.path.join(out_dir, "a.%(ext)s")
    r = subprocess.run(
        [ytdlp, "-f", "bestaudio/best", "-o", out, "--no-playlist", url],
        capture_output=True,
        text=True,
        timeout=180,
    )
    if r.returncode != 0:
        raise RuntimeError((r.stderr or "")[-300:])
    for f in os.listdir(out_dir):
        if f.startswith("a."):
            return os.path.join(out_dir, f)
    raise RuntimeError("下载完没找到文件")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bvid", default="")
    ap.add_argument("--audio", default="")
    ap.add_argument("--max-sec", type=float, default=90)
    ap.add_argument("--model", default="base")
    args = ap.parse_args()

    if not args.bvid and not args.audio:
        print(json.dumps({"ok": False, "err": "要么给 --bvid，要么给 --audio"}))
        return

    if not ensure_ffmpeg():
        print(json.dumps({"ok": False, "err": "没有 ffmpeg（whisper 解不了音频）"}))
        return

    t0 = time.time()
    tmp = None
    try:
        audio = args.audio
        if not audio:
            tmp = tempfile.mkdtemp(prefix="asr-")
            audio = download_audio(args.bvid, tmp)

        import whisper

        m = whisper.load_model(args.model)
        r = m.transcribe(
            audio,
            language="zh",
            fp16=False,
            initial_prompt="以下是普通话的句子。",  # 压掉繁体
            condition_on_previous_text=False,
        )
        text = " ".join(str(r.get("text") or "").split())
        # 只保留 max-sec 以内的段落
        segs = [s for s in (r.get("segments") or []) if float(s.get("end", 0)) <= args.max_sec]
        if segs:
            text = " ".join(str(s.get("text") or "").strip() for s in segs if s.get("text"))
            text = " ".join(text.split())
        print(
            json.dumps(
                {
                    "ok": bool(text),
                    "text": text[:2000],
                    "seconds": round(time.time() - t0, 1),
                },
                ensure_ascii=False,
            )
        )
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "err": ("%s: %s" % (type(e).__name__, e))[:300]}, ensure_ascii=False))
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
