#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
saki 的配音：IndexTTS-2.5（B站开源）本地推理，**带情感控制**。

## 为什么不用 edge-tts
edge-tts 只有音色、没有情绪（语气永远是平的），做吐槽视频听着像念稿。
IndexTTS-2.5 把**音色和情感解耦**了：
  · 音色  ← `--voice` 那段参考音频（3~10 秒）
  · 情感  ← `emo_text` 一句话描述（"带着调侃和不耐烦"）
             或 `emo_vector` 8 维向量 [高兴,愤怒,悲伤,害怕,厌恶,忧郁,惊讶,平静]
  · 强度  ← `--alpha`（0~1，官方建议 0.6 左右最自然）

## 用法
  # 由 tools/bili-narrate.mjs 调用；也可单独跑
  uv run --project C:\\IndexTTS python tools/saki-tts.py \
      --json lines.json --voice ref.wav --outdir out/

lines.json 形如：
  [{"text":"…","emo":"带着调侃和不耐烦","alpha":0.65},
   {"text":"…","vec":[0.5,0,0,0,0.2,0,0,0.3]}]     # vec 优先于 emo

输出：stdout 最后一行是 `SAKI-TTS {json}`，含每句的 wav 路径与时长（秒）。
"""
import argparse
import json
import os
import sys
import wave

# ⚠️⚠️ 必须在 import torch **之前**设，否则不生效（2026-10-20 实测）：
# 8 GB 显存跑 IndexTTS-2.5 会把显存吃满 ⇒ **Windows 的 WDDM 把显存分页到内存**
# ⇒ 每次访存都走 PCIe ⇒ 一句 3 秒音频要跑 **29 分钟**（RTF 520）。
# 加上这个 + 关掉 use_qwen_emo（省 1.1 GB）之后：**18 秒**（RTF 5.2），快 96 倍 ✓
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
os.environ.setdefault("OMP_NUM_THREADS", "8")

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def wav_duration(path):
    try:
        with wave.open(path, "rb") as w:
            return w.getnframes() / float(w.getframerate())
    except Exception:
        return 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", required=True, help="台词清单（JSON 文件）")
    ap.add_argument("--voice", required=True, help="参考音色 wav/mp3（3~10 秒最稳）")
    ap.add_argument("--outdir", required=True, help="输出目录")
    ap.add_argument("--model-dir", default=r"C:\IndexTTS\checkpoints")
    ap.add_argument("--alpha", type=float, default=0.65, help="情感强度 0~1")
    ap.add_argument("--break-ms", type=int, default=0, help="句间静音（0=交给 ffmpeg 拼）")
    ap.add_argument("--cpu", action="store_true", help="强制 CPU（极慢，只在没有显卡时用）")
    ap.add_argument(
        "--emo-text",
        action="store_true",
        help=(
            "允许加载 QwenEmotion（1.1 GB）把 emo 文字转成情绪向量。"
            "⚠️ 默认关闭：8 GB 显存加载它会把显存吃满 ⇒ WDDM 分页 ⇒ 慢 96 倍。"
            "优先让台词直接给 vec（8 维情绪向量）"
        ),
    )
    args = ap.parse_args()

    # 依赖装完之前跑这个脚本会 import 失败，给出可读的提示
    try:
        import torch
        from indextts.infer_v2_5 import IndexTTS2
    except Exception as e:  # noqa: BLE001
        print(f"❌ 导入失败：{e}")
        print("   先装依赖：cd C:\\IndexTTS && uv sync --extra webui")
        sys.exit(1)

    with open(args.json, "r", encoding="utf-8") as f:
        lines = json.load(f)
    if not lines:
        print("❌ 台词清单是空的")
        sys.exit(2)

    os.makedirs(args.outdir, exist_ok=True)

    use_cuda = torch.cuda.is_available() and not args.cpu
    print(f"设备：{'cuda:' + torch.cuda.get_device_name(0) if use_cuda else 'CPU（会很慢）'}")

    # 需要 emo_text（从文字推情绪）时才加载 QwenEmotion 小模型 —— **默认不加载**，
    # 它 1.1 GB，在 8 GB 卡上会把显存吃满（见文件头的 96 倍教训）。
    need_emo_text = bool(args.emo_text) and any(
        item.get("emo") and not item.get("vec") for item in lines
    )
    if any(item.get("emo") and not item.get("vec") for item in lines) and not need_emo_text:
        print("⚠️ 有台词只给了 emo 文字、没给 vec ⇒ 这次不加载情绪模型，"
              "会退回「从文本自推情绪」（未开即按中性处理）。要精确情绪请给 vec，"
              "或加 --emo-text（会慢很多）")
    tts = IndexTTS2(
        cfg_path=os.path.join(args.model_dir, "config.yaml"),
        model_dir=args.model_dir,
        use_bf16=use_cuda,
        device=None if use_cuda else "cpu",
        use_cuda_kernel=False,   # 没装 nvcc，走纯 python kernel
        use_qwen_emo=bool(need_emo_text),
    )

    results = []
    for i, item in enumerate(lines):
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        out = os.path.join(args.outdir, f"v{i}.wav")
        kw = dict(
            spk_audio_prompt=args.voice,
            text=text,
            output_path=out,
            lang=item.get("lang") or "ZH",
        )
        vec = item.get("vec")
        if vec:
            kw["emo_vector"] = [float(x) for x in vec]
            kw["use_random"] = False
        elif item.get("emo"):
            kw["use_emo_text"] = True
            kw["emo_text"] = str(item["emo"])
            kw["emo_alpha"] = float(item.get("alpha", args.alpha))
        else:
            # 没给情绪：**默认压一个「平静偏冷」**。
            # ⚠️ 不压不行（2026-10-20 用户听感）：「参考音频自己的语气会整个带过来」——
            #    游戏语音那段「交谈2」比较元气，直接合成出来「太兴奋」，不像她平时的冷淡。
            #    所以默认给 平静 0.83 + 一点点厌恶（吐槽的底色），把情绪拉平 ✓
            kw["emo_vector"] = [0.05, 0.0, 0.0, 0.0, 0.12, 0.0, 0.0, 0.83]
            kw["use_random"] = False

        try:
            tts.infer(verbose=False, **kw)
        except Exception as e:  # noqa: BLE001
            print(f"❌ 第 {i + 1} 句失败：{type(e).__name__}: {e}")
            sys.exit(3)

        if not os.path.isfile(out):
            print(f"❌ 第 {i + 1} 句没产出文件")
            sys.exit(3)
        dur = wav_duration(out)
        results.append({"i": i, "file": out, "dur": round(dur, 3), "text": text})
        print(f"  {i + 1}. {dur:.1f}s  {text}")

    total = sum(r["dur"] for r in results)
    print(f"合计 {total:.1f} 秒")
    print("SAKI-TTS " + json.dumps({"items": results, "total": round(total, 3)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
