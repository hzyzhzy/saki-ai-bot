/**
 * B站视频**全流程一条命令**（用户 2026-10-21：「下次直接交给无头 agent 一步完成」）
 *
 * 分工（重要，别改错了）：
 *   · **决策由模型（agent）做** —— 动作编排、群聊挑选，都是"理解人话"，写死脚本必错 ✗
 *   · **执行由脚本做** —— 配音、口型轨、录制、抠图、合成、自检
 *   · 这个管线只负责**按顺序把它们串起来**，不做任何内容判断
 *
 * 用法：
 *   node tools/bili-pipeline.mjs                                  # 全套（配音已存在时跳过 TTS）
 *   node tools/bili-pipeline.mjs --force-tts                      # 重新配音
 *   node tools/bili-pipeline.mjs --group 200000001 --lines logs/bili/intro_lines.json
 *   node tools/bili-pipeline.mjs --skip-tts --skip-record         # 只重合成
 *
 * 产出：
 *   logs/bili/intro_voice/v*.wav     配音
 *   logs/bili/mouth.json             口型轨
 *   logs/bili/actions.json           动作表（模型编的）
 *   logs/bili/chat_picked.json       群聊挑选（模型挑的）
 *   logs/bili/l2d_take/              Live2D 绿幕录屏 + meta.json
 *   logs/bili/final.mp4              成片
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes('--' + n);
const say = (s) => console.log(`\n[pipeline] ${s}`);

const GROUP = arg('group', '200000001');
const LINES = resolve(arg('lines', join(ROOT, 'logs', 'bili', 'intro_lines.json')));
const VOICE_DIR = resolve(arg('voice', join(ROOT, 'logs', 'bili', 'intro_voice')));
const OUT = resolve(arg('out', join(ROOT, 'logs', 'bili', 'final.mp4')));
const L2D_H = arg('l2d-h', '800');
const SECONDS = arg('seconds', '40');
// 【视频规格先定】总时长（秒）。配音和动作都要卡到它，而不是反过来 ✗
const DURATION = Number(arg('duration', '38'));
const VOICE_FIT = resolve(arg('voice-fit', join(ROOT, 'logs', 'bili', 'intro_voice_fit')));

const step = (name, args, { allowFail = false } = {}) => {
  say(`▶ ${name}`);
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    if (allowFail) { say(`⚠️ ${name} 失败（已忽略）：exit ${r.status}`); return false; }
    say(`❌ ${name} 失败（exit ${r.status}），停止`);
    process.exit(r.status || 1);
  }
  return true;
};

const t0 = Date.now();

/* ① 配音 ──────────────────────────────────────── */
const wavs = existsSync(VOICE_DIR)
  ? readdirSync(VOICE_DIR).filter((f) => /^v\d+\.wav$/i.test(f))
  : [];
if (has('skip-tts')) {
  say(`① 配音：跳过（已有 ${wavs.length} 段）`);
} else if (wavs.length && !has('force-tts')) {
  say(`① 配音：已有 ${wavs.length} 段，跳过（要重配加 --force-tts）`);
} else {
  // ⚠️ 文件名由 tools/saki-tts.py 写死成 v0.wav / v1.wav …（第 113 行 f"v{i}.wav"）
  step('① 配音（IndexTTS）', [join(ROOT, 'tools', 'saki-say.mjs'),
    '--file', LINES, '--outdir', VOICE_DIR]);
}

/* ①.5 音频整形：把配音卡到目标时长（视频规格优先） ──
 * ⚠️ 顺序很关键：**先定时长 D，再压配音**。
 *   老流程是「配音多长视频就多长」，台词一写长视频就没边了 ✗ */
step('①.5 音频整形到 ' + DURATION + 's（超了加速、短了补静音）', [join(ROOT, 'tools', 'fit-audio.mjs'),
  '--voice', VOICE_DIR, '--duration', String(DURATION), '--out', VOICE_FIT]);

/* ② 口型轨 ────────────────────────────────────── */
step('② 口型轨（按配音算张嘴量）', [join(ROOT, 'tools', 'mouth-track.mjs'),
  '--voice', VOICE_FIT, '--out', join(ROOT, 'logs', 'bili', 'mouth.json')]);

/* ③④ 决策类产物（**必须由 agent 产出**，用户 2026-10-21：「挑选应该由 agent 挑选」）──
 * ⚠️ 这里**故意不自动调模型**：
 *    · 脚本里塞个 prompt 调一次模型 = 一次性、无上下文、看不到台词风格、也不知道哪些内容
 *      不适合上 B 站（实测挑出来的聊天里带脏话、带刷屏重复）✗
 *    · 正确的是 agent 自己读完候选、按台词主题挑，并把挑选依据写进产出文件 ✓
 *    · tools/pick-actions.mjs / pick-chat.mjs 只当**起草工具**，agent 必须复核/改写
 */
const ACTIONS = join(ROOT, "logs", "bili", "actions.json");
const CHATPICK = join(ROOT, "logs", "bili", "chat_picked.json");

/* ── `--auto`：全自动投稿用（2026-10-22 加）────────────────────
 * 用户要求「每天自动生成并上传」+「全部动作流程也由 agent 来做」
 * ⇒ 没人在旁边复核的时候，**由模型现挑**：动作表、群聊记录都重新生成（覆盖旧文件）。
 * ⚠️ 为什么不用"文件不存在才生成"：台词每期都不一样，旧动作表套到新台词上
 *    会出现"说到折腾的时候在点头"这种错位 ✗ ⇒ `--auto` 一律重生成。
 * ⚠️ 动作的时间轴用 **VOICE_FIT**（整形后的最终音轨）算，不是原始配音 ——
 *    fit-audio 可能压过速，用原始时长排动作会整体飘 ✗
 */
if (has('auto')) {
  say('③④ 决策：--auto ⇒ 让模型现挑（动作表 + 群聊记录都重新生成）');
  step('③ 动作表（模型按台词情绪排）', [join(ROOT, 'tools', 'pick-actions.mjs'),
    '--lines', LINES, '--voice', VOICE_FIT, '--out', ACTIONS]);
  step('④ 群聊挑选（模型按台词主题挑）', [join(ROOT, 'tools', 'pick-chat.mjs'),
    '--group', GROUP, '--lines', LINES, '--out', CHATPICK]);
}

const needDecide = (path, what, hint) => {
  if (!existsSync(path)) {
    say(`❌ 缺少 ${what}：${path}`);
    say(`   ⇒ 这一步要 **agent 自己**产出（${hint}）`);
    process.exit(4);
  }
  const age = (Date.now() - statSync(path).mtimeMs) / 60000;
  say(`${what}：${path}（${age < 1 ? "刚生成" : age.toFixed(0) + " 分钟前"}）`);
};

if (has("skip-decide")) {
  say("③④ 决策：跳过（复用已有 actions.json / chat_picked.json）");
  needDecide(ACTIONS, "动作表", "按台词情绪排");
  needDecide(CHATPICK, "群聊挑选", "读候选后按台词主题挑");
} else {
  needDecide(ACTIONS, "动作表", "按台词情绪排；可用 tools/pick-actions.mjs 起草后自己复核");
  needDecide(CHATPICK, "群聊挑选", "读候选后按台词主题挑；可用 tools/pick-chat.mjs 起草后自己复核");
  say("③④ 决策文件已就位（agent 产出，管线不替你挑内容）");
}

/* ⑤ Live2D 绿幕录屏（半身 + 口型 + 动作） ──────── */
const TAKE = join(ROOT, 'logs', 'bili', 'l2d_take');
if (has('skip-record')) {
  say('⑤ Live2D：跳过（用已有录像）');
  if (!existsSync(join(TAKE, 'meta.json'))) { say('❌ 没有已有录像，去掉 --skip-record'); process.exit(1); }
} else {
  step('⑤ Live2D 绿幕录屏', [join(ROOT, 'tools', 'live2d-record.mjs'),
    '--seconds', SECONDS, '--outdir', TAKE,
    '--mouth', join(ROOT, 'logs', 'bili', 'mouth.json'),
    '--actions-file', join(ROOT, 'logs', 'bili', 'actions.json')]);
}

/* ⑥ 字幕自检（先查再合成，省 6 分钟白等） ───────── */
step('⑥ 字幕断行自检', [join(ROOT, 'tools', 'subtitle-wrap-test.mjs'), LINES]);

/* ⑦ 合成 ──────────────────────────────────────── */
step('⑦ 合成成片', [join(ROOT, 'tools', 'bili-intro3.mjs'),
  '--group', GROUP,
  // ⚠️ 必须把台词一起传下去：bili-intro3 默认读 logs/bili/intro_lines.json，
  //    不传就会拿旧台词配新配音（2026-10-21 真踩过：字幕全是上一期的自我介绍）✗
  '--lines', LINES,
  '--voice', VOICE_FIT,
  '--live2d', TAKE,
  '--chat-picked', join(ROOT, 'logs', 'bili', 'chat_picked.json'),
  '--l2d-h', L2D_H,
  // ⚠️ 片头只在**自制题材**那条路加（用户 2026-10-22：「群里的趣事类不用变，
  //    agent 自己搜集题材做的才要用上 ae」）⇒ 透传：给了 --intro 才叠前 3 秒
  ...(arg('intro', '') ? ['--intro', resolve(arg('intro', '')), '--intro-sec', arg('intro-sec', '3')] : []),
  '--out', OUT]);

/* ⑧ 收尾 ──────────────────────────────────────── */
if (!existsSync(OUT)) { say('❌ 没生成成片'); process.exit(1); }
const mb = (readFileSync(OUT).length / 1024 / 1024).toFixed(2);
say(`✅ 成片：${OUT}（${mb} MB）`);
say(`   总耗时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);

// 放到桌面（用户桌面被重定向到 E:\Desktop，别写到 C:）
if (!has('no-desktop')) {
  try {
    const desk = spawnSync('powershell', ['-NoProfile', '-Command',
      "[Environment]::GetFolderPath('Desktop')"], { encoding: 'utf8' }).stdout.trim();
    if (desk) {
      const dst = join(desk, 'saki_第1条.mp4');
      copyFileSync(OUT, dst);
      say(`   已复制到桌面：${dst}`);
    }
  } catch { /* 复制失败不影响成片 */ }
}

say('自检提醒：抽 2 帧核对音画同步 + 片尾字幕，再交付');
