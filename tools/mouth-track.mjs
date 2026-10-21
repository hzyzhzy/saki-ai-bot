/**
 * 生成**口型轨道**（lip sync）：按配音算出每帧该张多大嘴
 *
 * 为什么需要：bdon.moe 的 Live2D 只有待机/眨眼/呼吸/物理，**没有口型** ⇒ 说话时嘴不动，
 * 用户 2026-10-21 指出「好像没有张嘴」✗
 * 做法：录制时 hook Cubism core 的 `Model.prototype.update`，每帧 update 之前写入
 * `ParamMouthOpenY`（实测能拿到模型实例，210 个参数）⇒ 嘴跟着音频动 ✓
 *
 * 这个工具只负责算出 `{ fps, values }`：values[i] = 第 i 帧的张嘴量（0~1）
 *
 * 用法：
 *   node tools/mouth-track.mjs --voice logs/bili/intro_voice --gap 0.35 --fps 25 \
 *        --out logs/bili/mouth.json
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.BILI_FFMPEG || 'C:\\Users\\<主人>\\AppData\\Roaming\\bilibili\\ffmpeg\\ffmpeg.exe';

const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const say = (s) => console.log(`[mouth] ${s}`);

const VOICE_DIR = resolve(arg('voice', join(ROOT, 'logs', 'bili', 'intro_voice')));
const GAP = Number(arg('gap', '0.35'));
const FPS = Number(arg('fps', '25'));
const OUT = resolve(arg('out', join(ROOT, 'logs', 'bili', 'mouth.json')));

const durOf = (p) => {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', p], { encoding: 'utf8' });
  const m = String(r.stderr || '').match(/Duration: (\d+):(\d+):([\d.]+)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
};

/** 把一个 wav 拆成每帧一个 RMS 值（0~1，未归一化） */
const rmsTrack = (p, durSec) => {
  const SR = 16000;
  const r = spawnSync(FFMPEG, ['-v', 'quiet', '-i', p,
    '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'], { maxBuffer: 256 * 1024 * 1024 });
  const buf = r.stdout;
  const frames = Math.max(1, Math.round(durSec * FPS));
  const win = Math.floor(SR / FPS); // 每帧的样本数
  const out = new Array(frames).fill(0);
  if (!buf || !buf.length) return out;
  const n = Math.floor(buf.length / 2);
  for (let f = 0; f < frames; f++) {
    const s = f * win;
    const e = Math.min(n, s + win);
    if (e <= s) continue;
    let sum = 0;
    for (let i = s; i < e; i++) {
      const v = buf.readInt16LE(i * 2) / 32768;
      sum += v * v;
    }
    out[f] = Math.sqrt(sum / (e - s));
  }
  return out;
};

const wavs = readdirSync(VOICE_DIR)
  .filter((f) => /^v\d+\.wav$/i.test(f))
  .sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
if (!wavs.length) { say('❌ 配音目录里没有 v*.wav'); process.exit(2); }

const durs = wavs.map((f) => durOf(join(VOICE_DIR, f)));
const audioDur = durs.reduce((a, b) => a + b, 0) + GAP * (durs.length - 1);
// 末尾多给 1.5 秒（与录制时多录的尾巴一致），保证录完不会因为数组不够而突然断嘴
const totalSec = audioDur + 1.5;
const total = Math.ceil(totalSec * FPS);
const values = new Array(total).fill(0);

let cursor = 0;
const track = [];
for (let i = 0; i < wavs.length; i++) {
  const raw = rmsTrack(join(VOICE_DIR, wavs[i]), durs[i]);
  const start = Math.round(cursor * FPS);
  track.push({ i, startSec: +cursor.toFixed(2), dur: +durs[i].toFixed(2), frames: raw.length });
  for (let k = 0; k < raw.length && start + k < total; k++) values[start + k] = raw[k];
  cursor += durs[i] + GAP;
}
say(`配音 ${wavs.length} 段 / ${audioDur.toFixed(2)}s → 轨道 ${total} 帧 @ ${FPS}fps`);

/* ── 归一化：取 95 分位当"最大张嘴"，别被个别爆音带偏 ── */
const sorted = [...values].filter((v) => v > 0).sort((a, b) => a - b);
const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0.1;
const norm = values.map((v) => Math.min(1, v / (p95 || 0.1)));

/* ── 平滑：一阶低通，避免每帧跳变（真人说话嘴也不会瞬变） ── */
const ALPHA = 0.55;
const smooth = [];
let prev = 0;
for (const v of norm) {
  prev = prev * (1 - ALPHA) + v * ALPHA;
  smooth.push(prev);
}

/* ── 去噪：很小的值直接闭紧，否则嘴一直在微微张着很怪 ── */
const FLOOR = 0.12;
const out = smooth.map((v) => (v < FLOOR ? 0 : Math.min(1, (v - FLOOR) / (1 - FLOOR))));

const nonZero = out.filter((v) => v > 0).length;
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  fps: FPS, gap: GAP, audioDur: +audioDur.toFixed(3), totalFrames: total,
  segments: track.map((t) => ({ start: t.startSec, dur: t.dur })),
  values: out.map((v) => +v.toFixed(3)),
}, null, 0), 'utf8');
say(`✅ ${OUT}`);
say(`   张嘴帧 ${nonZero}/${total}（${((nonZero / total) * 100).toFixed(0)}%），p95=${p95.toFixed(3)}`);
say(`   前 40 帧：${out.slice(0, 40).map((v) => v.toFixed(2)).join(' ')}`);
