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
/**
 * 整体语速（<1 = 放慢）。
 *
 * ⚠️⚠️ 2026-10-22 用户：「感觉 saki 的语速有点快了，**都调慢一点**」
 *   实测上一单 `speed: 1.0963` —— 配音被**加速了 9.6%** 才塞进 40 秒，
 *   听着就是"赶"。两个原因叠在一起：TTS 本身语速偏快 + 这里为了卡时长又加速 ✗
 *
 * 做法（关键是**目标时长也要跟着放宽**，不然刚放慢又被压回去）：
 *   · 每段先按 `pace` 放慢（atempo，**不变调**）
 *   · 目标时长换算成 `DURATION / pace` ⇒ 放慢之后需要的时长
 *   · 于是"是否需要加速"的判据、补静音的量，全都按放慢后的世界算 ✓
 *     最终视频会**长 (1/pace - 1)**，这是放慢语速必然的代价，用户要的就是这个 ✓
 */
const PACE = Math.max(0.7, Math.min(1.2, Number(arg('pace', '0.92')) || 0.92));
/** 折算后的目标时长（放慢之后的世界） */
const TARGET = DURATION / PACE;

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
/** 音频总和（**不含句间静音** —— atempo 只缩音频，GAP 不缩，两个不能混着算） */
const A = durs.reduce((a, b) => a + b, 0);
/** 句间静音总和 */
const G = GAP * (durs.length - 1);
const L = A + G;
/** 放慢之后的可用音频时长（= 目标总时长 - 不缩放的静音） */
const ROOM = TARGET - G;
say(`原配音 ${L.toFixed(2)}s（音频 ${A.toFixed(2)} + 静音 ${G.toFixed(2)}）/ 目标 ${DURATION}s` +
    `（放慢 ${PACE}× ⇒ 折算 ${TARGET.toFixed(2)}s，音频可用 ${ROOM.toFixed(2)}s）`);

mkdirSync(OUT_DIR, { recursive: true });
// 清掉上一次的产物，免得混进旧文件
for (const f of readdirSync(OUT_DIR)) if (/^v\d+\.wav$/i.test(f)) rmSync(join(OUT_DIR, f), { force: true });

/**
 * 最终 atempo。
 *
 * ⚠️⚠️ 这里**必须用 A / ROOM 算，不能再用 L / TARGET**（2026-10-22 踩过）：
 *    L 含句间静音，而 atempo 只缩音频 ⇒ 用 L 算出来会偏小，
 *    实测「目标 43.48s，实际出来 47.03s」（多 3.5 秒）✗
 */
let tempo = PACE;
let pad = 0;
if (A / PACE <= ROOM + 0.02) {
  // 放慢之后还装得下 ⇒ 只放慢（不加速），不够就末尾补静音
  tempo = PACE;
  pad = Math.max(0, ROOM - A / PACE);
} else {
  // 放慢之后装不下 ⇒ 在放慢的基础上压缩回来（tempo > PACE，可能 >1）
  tempo = A / ROOM;
  if (tempo > 1.3) {
    say(`⚠️ 净加速 ${tempo.toFixed(2)}×（放慢 ${PACE} 之后仍要加速）—— 已经明显了。` +
        `建议回去把台词删短（每句少 1~2 个分句），而不是硬加速`);
  }
}
say(`atempo ${tempo.toFixed(4)}（${tempo < 1 ? '放慢' : '加快'} ${Math.round(Math.abs(1 - tempo) * 100)}%）` +
    (pad > 0.02 ? `，末尾补静音 ${pad.toFixed(2)}s` : ''));

wavs.forEach((f, i) => {
  const last = i === wavs.length - 1;
  /* ⚠️ 本机 ffmpeg 3.0.1 的 apad 没有 pad_dur（只有 pad_len / whole_len），
   * 用 pad_dur 会直接 "Option not found" 失败 ⇒ 先重采样到 24000，
   * 再按样本数补静音（pad_len 的单位是样本）✓
   * ⚠️ 顺序：先 atempo，再 aresample，最后 apad —— 反了样本数就对不上 */
  const af = `atempo=${tempo.toFixed(4)},aresample=24000` +
    (last && pad > 0.02 ? `,apad=pad_len=${Math.round(pad * 24000)}` : '');
  const r = spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
    '-i', join(VOICE_DIR, f), '-af', af,
    '-ar', '24000', '-ac', '1', join(OUT_DIR, f)], { encoding: 'utf8' });
  if (r.status !== 0) { say(`❌ ${f} 处理失败：${String(r.stderr).slice(-200)}`); process.exit(3); }
});
const outDurs = wavs.map((f) => durOf(join(OUT_DIR, f)));

const total = outDurs.reduce((a, b) => a + b, 0) + GAP * (outDurs.length - 1);
writeFileSync(join(OUT_DIR, 'durations.json'), JSON.stringify({
  source: VOICE_DIR, duration: DURATION, gap: GAP, pace: PACE,
  target: +TARGET.toFixed(3), tempo: +tempo.toFixed(4),
  totalDur: +total.toFixed(3), durs: outDurs.map((x) => +x.toFixed(3)),
}, null, 2), 'utf8');

say(`✅ ${OUT_DIR}`);
say(`   整形后总长 ${total.toFixed(2)}s（目标 ${DURATION}s ⇒ 放慢后折算 ${TARGET.toFixed(2)}s，` +
    `atempo ${tempo.toFixed(3)}）`);
say(`   每段：${outDurs.map((x) => x.toFixed(2)).join(' / ')}`);
if (Math.abs(total - TARGET) > 0.15) {
  say(`⚠️ 还是差了 ${(total - TARGET).toFixed(2)}s（aac/编码取整），合成时以实际为准`);
}
