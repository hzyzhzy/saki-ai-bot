/**
 * 把配音**整形到目标总时长**（用户 2026-10-21：「先用聊天记录视频的总时长去限制讲话语音和动作的时长」）
 *
 * 为什么方向要反过来：
 *   老流程是「配音多长，视频就多长」⇒ 台词写长一点视频就无限长，
 *   而聊天滚动/动作编排都得去凑配音 ✗
 *   正确顺序：**先定视频时长 D**（B站竖屏短视频通常 30~60 秒），
 *   再把配音压/补到 D，动作和聊天都按 D 排 ✓
 *
 * 做什么：
 *   · 配音总长 L > D ⇒ 每段 `atempo` 加速 L/D 倍（不变调，只听得出稍快；>1.3 倍会明显，会警告）
 *   · L < D ⇒ 末尾补静音到 D（画面继续保持滚动，不会突然停）
 *   · 输出到新目录，**不动原始配音**（可反复试不同时长）
 *   · 顺带写 durations.json（每段裁后时长），供 cue / 口型轨复用
 *
 * 用法：
 *   node tools/fit-audio.mjs --voice logs/bili/intro_voice --duration 38 \
 *        --out logs/bili/intro_voice_fit --gap 0.35
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.BILI_FFMPEG || 'C:\\Users\\<主人>\\AppData\\Roaming\\bilibili\\ffmpeg\\ffmpeg.exe';
const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const say = (s) => console.log(`[fit] ${s}`);

const VOICE_DIR = resolve(arg('voice', join(ROOT, 'logs', 'bili', 'intro_voice')));
const OUT_DIR = resolve(arg('out', join(ROOT, 'logs', 'bili', 'intro_voice_fit')));
const DURATION = Number(arg('duration', '38'));
const GAP = Number(arg('gap', '0.35'));

const durOf = (p) => {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', p], { encoding: 'utf8' });
  const m = String(r.stderr || '').match(/Duration: (\d+):(\d+):([\d.]+)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
};

const wavs = readdirSync(VOICE_DIR)
  .filter((f) => /^v\d+\.wav$/i.test(f))
  .sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
if (!wavs.length) { say('❌ 配音目录里没有 v*.wav'); process.exit(2); }
if (!DURATION || DURATION < 5) { say('❌ --duration 要给个合理值（秒）'); process.exit(2); }

const durs = wavs.map((f) => durOf(join(VOICE_DIR, f)));
const L = durs.reduce((a, b) => a + b, 0) + GAP * (durs.length - 1);
say(`原配音 ${L.toFixed(2)}s / 目标 ${DURATION}s`);

mkdirSync(OUT_DIR, { recursive: true });
// 清掉上一次的产物，免得混进旧文件
for (const f of readdirSync(OUT_DIR)) if (/^v\d+\.wav$/i.test(f)) rmSync(join(OUT_DIR, f), { force: true });

let speed = 1;
let outDurs = durs;
if (L > DURATION + 0.02) {
  /* ── 太长：加速 ──
   * atempo 只改时长不改音高 ✓；但倍数超过 1.3 人耳能觉察到"赶"，
   * 那种情况说明台词本身写太长，应该回头删字（这里只警告，不擅自改内容） */
  speed = L / DURATION;
  if (speed > 1.3) {
    say(`⚠️ 需要加速 ${speed.toFixed(2)}× —— 已经明显了。` +
        `建议回去把台词删短（每句少 1~2 个分句），而不是硬加速`);
  }
  say(`加速 ${speed.toFixed(3)}× 把配音压到 ${DURATION}s`);
  wavs.forEach((f, i) => {
    const r = spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
      '-i', join(VOICE_DIR, f),
      '-af', `atempo=${speed.toFixed(4)}`,
      '-ar', '24000', '-ac', '1', join(OUT_DIR, f)], { encoding: 'utf8' });
    if (r.status !== 0) { say(`❌ ${f} 加速失败：${String(r.stderr).slice(-200)}`); process.exit(3); }
  });
  outDurs = wavs.map((f) => durOf(join(OUT_DIR, f)));
} else if (L < DURATION - 0.02) {
  /* ── 太短：末尾补静音 ──
   * 补在**最后一段后面**，这样画面还能继续滚动；字幕停在最后一句 */
  const pad = DURATION - L;
  say(`配音比目标短 ${pad.toFixed(2)}s ⇒ 末尾补静音`);
  wavs.forEach((f, i) => {
    const last = i === wavs.length - 1;
    const r = spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
      '-i', join(VOICE_DIR, f),
      /* ⚠️ 本机 ffmpeg 3.0.1 的 apad 没有 pad_dur（只有 pad_len / whole_len），
       * 用 pad_dur 会直接 "Option not found" 失败 ⇒ 先统一重采样到 24000，
       * 再按样本数补静音（pad_len 的单位是样本）✓ */
      ...(last ? ['-af', `aresample=24000,apad=pad_len=${Math.round(pad * 24000)}`] : []),
      '-ar', '24000', '-ac', '1', join(OUT_DIR, f)], { encoding: 'utf8' });
    if (r.status !== 0) { say(`❌ ${f} 处理失败：${String(r.stderr).slice(-200)}`); process.exit(3); }
  });
  outDurs = wavs.map((f) => durOf(join(OUT_DIR, f)));
} else {
  say('长度正好，只做格式统一（24000Hz 单声道）');
  wavs.forEach((f) => {
    spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
      '-i', join(VOICE_DIR, f), '-ar', '24000', '-ac', '1', join(OUT_DIR, f)], { encoding: 'utf8' });
  });
  outDurs = wavs.map((f) => durOf(join(OUT_DIR, f)));
}

const total = outDurs.reduce((a, b) => a + b, 0) + GAP * (outDurs.length - 1);
writeFileSync(join(OUT_DIR, 'durations.json'), JSON.stringify({
  source: VOICE_DIR, duration: DURATION, gap: GAP, speed: +speed.toFixed(4),
  totalDur: +total.toFixed(3), durs: outDurs.map((x) => +x.toFixed(3)),
}, null, 2), 'utf8');

say(`✅ ${OUT_DIR}`);
say(`   整形后总长 ${total.toFixed(2)}s（目标 ${DURATION}s，${speed === 1 ? '未加速' : speed.toFixed(3) + '×'}）`);
say(`   每段：${outDurs.map((x) => x.toFixed(2)).join(' / ')}`);
if (Math.abs(total - DURATION) > 0.15) {
  say(`⚠️ 还是差了 ${(total - DURATION).toFixed(2)}s（aac/编码取整），合成时以实际为准`);
}
