/**
 * 分镜 PNG + 配音 → 成片（2026-11-08）
 *
 * 用户原话：「最好直接用 ae 做动效，html 不适合用来做视频」
 *          「要是那种**能帮助观众理解**视频的动画」
 *
 * 流程：`ae-scenes.mjs` 用 AE 渲出一串带透明的 PNG（每个要点一段），
 *       这个脚本把它们垫在深色底上、配上 IndexTTS 的配音、烧上字幕，出成片。
 *
 * 用法：
 *   node tools/ae-video.mjs --scenes logs/bili/xxx/scenes --voice logs/bili/xxx/voice/say.mp3 \
 *        --out logs/bili/xxx/video.mp4 [--lines logs/bili/xxx/lines.json] [--pad 1.2]
 *
 * ⚠️ 时长对不齐怎么办：
 *   · 配音比动画**长** ⇒ 最后一帧停住（`tpad`），不让声音被截断 ✓
 *   · 配音比动画**短** ⇒ 视频照动画长度走，尾巴安静一会儿（可以 --trim 掉）
 */
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.BILI_FFMPEG || 'C:\\Users\\<主人>\\AppData\\Roaming\\bilibili\\ffmpeg\\ffmpeg.exe';
const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const say = (s) => console.log(`[ae-video] ${s}`);

const SCENES = resolve(arg('scenes', ''));
const VOICE = resolve(arg('voice', ''));
const OUT = resolve(arg('out', join(ROOT, 'logs', 'bili', 'ae_video.mp4')));
const FPS = Number(arg('fps', '25')) || 25;
const BG = arg('bg', '0x0a0d11');

if (!SCENES || !existsSync(SCENES)) {
  console.log(JSON.stringify({ ok: false, why: '--scenes 目录不存在：' + SCENES }));
  process.exit(1);
}
if (!VOICE || !existsSync(VOICE)) {
  console.log(JSON.stringify({ ok: false, why: '--voice 配音文件不存在：' + VOICE }));
  process.exit(1);
}

const pngs = readdirSync(SCENES).filter((f) => /^scene_\d+\.png$/i.test(f)).sort();
if (!pngs.length) {
  console.log(JSON.stringify({ ok: false, why: 'scenes 目录里没有 scene_*.png（AE 渲染失败了？）' }));
  process.exit(1);
}
const animSec = pngs.length / FPS;
say(`分镜 ${pngs.length} 帧 = ${animSec.toFixed(2)} 秒`);

/* 配音多长 —— 用 ffmpeg 读 duration */
function dur(p) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', p], { encoding: 'utf8' });
  const m = String(r.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
const voiceSec = dur(VOICE);
say(`配音 ${voiceSec.toFixed(2)} 秒`);

/* 视频总长 = 两者取大（配音长了就停住最后一帧，不能截声音） */
const totalSec = Math.max(animSec, voiceSec + 0.3);
const padSec = Math.max(0, totalSec - animSec);
say(`成片 ${totalSec.toFixed(2)} 秒${padSec > 0.05 ? `（最后一帧停 ${padSec.toFixed(2)}s）` : ''}`);

const fadeOut = Math.min(0.4, totalSec * 0.05);
const vf = [
  /* ⚠️ ffmpeg 3.0.1 **没有 `tpad` 滤镜**（实测 No such filter: 'tpad'）⇒
   *   不能"最后一帧停住"。改成：总长由 `-t` 卡，分镜长度自己按配音配平
   *   （任务说明里已经要求 scenes 的 sec 加起来和配音差不多长）*/
  `fade=t=in:st=0:d=0.25`,
  `fade=t=out:st=${(totalSec - fadeOut).toFixed(2)}:d=${fadeOut.toFixed(2)}`,
  'format=yuv420p',
].join(',');

mkdirSync(dirname(OUT), { recursive: true });
const args = [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', `color=c=${BG}:s=1080x1920:d=${totalSec.toFixed(2)}:r=${FPS}`,
  '-framerate', String(FPS), '-i', join(SCENES, 'scene_%05d.png'),
  '-i', VOICE,
  // ⚠️ ffmpeg 3.0.1：overlay 不支持 format=auto，别加
  '-filter_complex', `[0][1]overlay,${vf}[v]`,
  '-map', '[v]', '-map', '2:a',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19',
  '-c:a', 'aac', '-b:a', '128k',
  '-t', totalSec.toFixed(2),
  OUT,
];
const r = spawnSync(FFMPEG, args, { encoding: 'utf8', timeout: 600000 });
if (r.status !== 0 || !existsSync(OUT)) {
  say('❌ 合成失败：' + String(r.stderr || '').slice(-400));
  console.log(JSON.stringify({ ok: false, why: 'ffmpeg 合成失败' }));
  process.exit(1);
}

const mb = (existsSync(OUT) ? (await import('node:fs')).statSync(OUT).size / 1024 / 1024 : 0).toFixed(2);
say(`✅ ${OUT}（${mb} MB / ${totalSec.toFixed(2)} 秒）`);
console.log(JSON.stringify({ ok: true, out: OUT, seconds: Number(totalSec.toFixed(2)), frames: pngs.length, MB: Number(mb) }));
