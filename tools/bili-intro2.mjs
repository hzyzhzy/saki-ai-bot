/**
 * B站第一条视频：**saki 自我介绍**（竖屏 1080×1920）
 *
 * 与 `bili-intro.mjs` 的区别：
 *   那个是"卡片翻页"（纯文字 + 头像），没有真实群聊画面；
 *   这个是用户 2026-10-20 要的版本 —— **中间放真实的 QQ 群录屏**，
 *   上下是标题栏 + 字幕，全程 saki 自己配音。
 *
 * 素材来源：
 *   · 录屏帧：`tools/qq-window-record.ps1`（PrintWindow 后台截帧，不打扰用户）
 *   · 配音：`tools/saki-say.mjs --file intro_lines.json`（IndexTTS + 祥子音色）
 *
 * 用法：
 *   node tools/bili-intro2.mjs --frames logs/bili/qqrec/20261020-xxxx --voice logs/bili/intro_voice
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG =
  process.env.BILI_FFMPEG || 'C:\\Users\\<主人>\\AppData\\Roaming\\bilibili\\ffmpeg\\ffmpeg.exe';
const FONT = 'C\\:/Windows/Fonts/msyh.ttc'; // drawtext 里冒号要转义

const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const say = (s) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${s}`);

const FRAMES = resolve(arg('frames', ''));
const VOICE = resolve(arg('voice', join(ROOT, 'logs', 'bili', 'intro_voice')));
const FPS = Number(arg('fps', '20')) || 20;
const OUT = resolve(arg('out', join(ROOT, 'logs', 'bili', 'intro_qq.mp4')));
const SUBTITLES = resolve(arg('subs', join(ROOT, 'logs', 'bili', 'intro_lines.json')));

if (!FRAMES || !existsSync(FRAMES)) {
  say(`❌ 找不到录屏帧目录：${FRAMES}`);
  process.exit(1);
}
const frames = readdirSync(FRAMES).filter((f) => /\.jpe?g$/i.test(f)).sort();
if (!frames.length) {
  say('❌ 帧目录是空的');
  process.exit(1);
}
say(`录屏帧 ${frames.length} 张（${(frames.length / FPS).toFixed(1)} 秒）`);

/* ── ① 配音：读每个 wav 的时长 ─────────────────── */
const wavs = existsSync(VOICE)
  ? readdirSync(VOICE).filter((f) => /^v\d+\.wav$/i.test(f)).sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)))
  : [];
if (!wavs.length) {
  say(`❌ ${VOICE} 里没有 v0.wav / v1.wav…`);
  process.exit(1);
}
const durOf = (p) => {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', p], { encoding: 'utf8' });
  const m = String(r.stderr || '').match(/Duration: (\d+):(\d+):([\d.]+)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
};
const pieces = wavs.map((f) => {
  const p = join(VOICE, f);
  return { f: p, dur: durOf(p) };
});
const GAP = 0.35; // 句间停顿
const totalAudio = pieces.reduce((a, b) => a + b.dur + GAP, 0);
say(`配音 ${pieces.length} 句，约 ${totalAudio.toFixed(1)} 秒`);

/* ── ② 拼音频 ─────────────────────────────────── */
const work = resolve(arg('work', join(ROOT, 'logs', 'bili', `intro2-work-${Date.now()}`)));
mkdirSync(work, { recursive: true });
const gapFile = join(work, 'gap.wav');
spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
  '-i', 'anullsrc=r=24000:cl=mono', '-t', String(GAP), gapFile], { encoding: 'utf8' });

const listLines = [];
pieces.forEach((p, i) => {
  listLines.push(`file '${p.f.replace(/\\/g, '/')}'`);
  if (i < pieces.length - 1) listLines.push(`file '${gapFile.replace(/\\/g, '/')}'`);
});
const listFile = join(work, 'list.txt');
writeFileSync(listFile, listLines.join('\n'), 'utf8');
const voiceFile = join(work, 'voice.m4a');
const cr = spawnSync(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile,
  '-ar', '24000', '-ac', '1', '-c:a', 'aac', '-b:a', '192k', voiceFile], { encoding: 'utf8', timeout: 180000 });
if (cr.status !== 0) {
  say(`❌ 拼音频失败：${String(cr.stderr || '').split('\n').slice(-3).join(' | ')}`);
  process.exit(2);
}

/* ── ③ 字幕条（按句算起止时间）────────────────── */
let subtitles = [];
try {
  subtitles = JSON.parse(readFileSync(SUBTITLES, 'utf8')).map((x) => String(x.text ?? x).trim());
} catch {
  say('⚠️ 没读到字幕来源，字幕只用编号');
}

// ⚠️ 固定设定自检（docs/bili-固定设定.md）：**不许暴露机器人 / AI 身份**
const BANNED_IDENTITY = /机器人|人工智能|AI助手|大模型|程序|被养|被训练|我是AI/i;
const badSubs = subtitles.filter((t) => BANNED_IDENTITY.test(t));
if (badSubs.length) {
  say('❌ 台词踩了身份红线（不许提机器人/AI/程序），先改台词再合成：');
  badSubs.forEach((t) => say(`   · ${t}`));
  process.exit(4);
}
let cursor = 0;
const cues = pieces.map((p, i) => {
  const start = cursor;
  cursor += p.dur + GAP;
  return { start, end: start + p.dur, text: (subtitles[i] || '').slice(0, 24) };
});

/* ── ④ 合成：录屏 + 背景 + 标题 + 字幕 ─────────── */
const videoDur = (frames.length / FPS).toFixed(2);
const targetDur = Math.min(Number(videoDur), totalAudio + 0.6);
say(`成片时长 ${targetDur.toFixed(1)} 秒`);

// 字幕用 drawtext 逐句 enable，字体走微软雅黑
const esc = (s) =>
  s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/%/g, '\\%');
const subFilters = cues
  .filter((c) => c.start < targetDur && c.text)
  .map((c) => {
    const e = Math.min(c.end, targetDur);
    return `drawtext=fontfile='${FONT}':text='${esc(c.text)}':fontcolor=white:fontsize=38:` +
      `x=(w-text_w)/2:y=h-170:box=1:boxcolor=0x000000@0.55:boxborderw=22:` +
      `enable='between(t,${c.start.toFixed(2)},${e.toFixed(2)})'`;
  })
  .join(',');

const filter = [
  // ⚠️ 这台机器用的是 B站客户端自带 ffmpeg **3.0.1**，`drawbox=...:t=fill` 它不认
  //    （报 "Undefined constant or missing '(' in 'fill'"）⇒ 标题栏改用 color + overlay ✓
  `color=c=0x141a22:s=1080x110:d=${targetDur}[bar]`,
  // 按**高度**缩（按宽 1080 缩会得 1784 高，加偏移就超出 1920 画布）
  // ⚠️ `setsar=1` 不能省：不加的话成片 SAR 是 1049:1050（非方形像素）⇒ B站会拉伸变形 ✗
  // 1450 高 = 给上下留出标题栏和字幕的空间，字幕不再压住聊天内容
  `[0:v]scale=-2:1450:flags=lanczos,setsar=1,pad=1080:1920:(ow-iw)/2:110:color=0x0a0d11[bg]`,
  `[bg][bar]overlay=0:0[barred]`,
  `[barred]drawtext=fontfile='${FONT}':text='Saki':fontcolor=0xf0f2f5:fontsize=52:x=(w-text_w)/2:y=28[ttl]`,
  subFilters ? `[ttl]${subFilters}[v]` : `[ttl]null[v]`,
].join(';');

// ⚠️ 帧名是 `f00000.jpg`（带 f 前缀）—— 直接写 `%05d.jpg` 会找不到文件 ✗
//    从实际文件名推导模式：把数字段换成 %0Nd，位数按原样保留
const framePattern = frames[0].replace(/\d+(?=\.jpe?g$)/i, (m) => `%0${m.length}d`);
say(`帧模式：${framePattern}`);

const r = spawnSync(FFMPEG, [
  '-y',
  '-framerate', String(FPS), '-i', join(FRAMES, framePattern),
  '-i', voiceFile,
  '-filter_complex', filter,
  '-map', '[v]', '-map', '1:a',
  '-t', String(targetDur),
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart',
  OUT,
], { encoding: 'utf8', timeout: 10 * 60 * 1000 });

if (r.status !== 0 || !existsSync(OUT)) {
  say(`❌ 合成失败：${String(r.stderr || '').split('\n').slice(-8).join(' | ')}`);
  say(`   滤镜：${filter}`);
  process.exit(3);
}
say(`✅ 成片：${OUT}`);
say(`   ${(readFileSync(OUT).length / 1024 / 1024).toFixed(2)} MB / ${targetDur.toFixed(1)} 秒`);
say('');
say('下一步（真发才加 --publish）：');
say(`  node tools/bili-upload.mjs --video "${OUT}" --title "…" --desc "…" --declare ai`);
try { rmSync(work, { recursive: true, force: true }); } catch {}
