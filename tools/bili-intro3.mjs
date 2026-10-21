/**
 * B站视频：**saki 自我介绍**（竖屏 1080×1920，聊天记录由 HTML 还原 + 按台词滚动）
 *
 * ## 为什么要 HTML 重画（用户 2026-10-20 定）
 *   直接录真 QQ 窗口有两个死穴：
 *     ① 内容不受控（滚出来俄乌新闻、骂人话，B站不能过审）
 *     ② 没法跟台词对齐（只能匀速滚）
 *   ⇒ 用 HTML **一模一样地还原** NTQQ 聊天面板，内容和滚动时机全部由脚本决定 ✓
 *
 * ## 画面结构（从真截图 1005x902 反推的比例）
 *   · 顶部群名栏（浅蓝渐变）：群名 + 人数
 *   · 消息区：头像 / 昵称+等级标签 / 气泡 / 时间 / 引用 / 撤回 / 图片 / 语音 / 文件
 *   · 底部输入框（让画面更像"正在用 QQ"）
 *
 * ## 用法
 *   node tools/bili-intro3.mjs --out logs/bili/intro_html.mp4
 *   node tools/bili-intro3.mjs --group 200000001 --lines logs/bili/intro_lines.json
 */
import { chromium } from 'playwright-core';
import { wrapSub } from './lib/subtitle-wrap.mjs';
import { filterMessages, keyOf } from './lib/chat-filter.mjs';
import { buildAss } from './lib/ass-subtitle.mjs';
import { tmpdir } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME =
  process.env.BILI_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const FFMPEG =
  process.env.BILI_FFMPEG || 'C:\\Users\\<主人>\\AppData\\Roaming\\bilibili\\ffmpeg\\ffmpeg.exe';
const FONT = 'C\\:/Windows/Fonts/msyh.ttc';

const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const say = (s) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${s}`);

const GROUP = arg('group', '200000001');
const ROOM = arg('room', '玩手机把小祥骗进来了'); // 群名（可用 --room 覆盖）
const LINES_FILE = resolve(arg('lines', join(ROOT, 'logs', 'bili', 'intro_lines.json')));
const VOICE_DIR = resolve(arg('voice', join(ROOT, 'logs', 'bili', 'intro_voice')));
const OUT = resolve(arg('out', join(ROOT, 'logs', 'bili', 'intro_html.mp4')));
const W = 1080;
const H = 1920;
// 输出帧率：源（Chrome 录屏/webm）都是 VFR，必须统一成 CFR 才不跳帧
const FPS_OUT = Number(arg('fps-out', '25'));
const PANEL_H = 1450; // 聊天面板高度（上下留标题栏和字幕）

/* ── ① 台词 + 配音时长 ────────────────────────── */
const lines = JSON.parse(readFileSync(LINES_FILE, 'utf8')).map((x) =>
  typeof x === 'string' ? { text: x } : { text: String(x.text || '').trim(), vec: x.vec || null },
);
const durOf = (p) => {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', p], { encoding: 'utf8' });
  const m = String(r.stderr || '').match(/Duration: (\d+):(\d+):([\d.]+)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
};
const wavs = readdirSync(VOICE_DIR)
  .filter((f) => /^v\d+\.wav$/i.test(f))
  .sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));

/* ⚠️⚠️ IndexTTS 每段 wav **开头自带 0.19~0.28 秒静音**（2026-10-21 实测 v0~v7 全部如此）
 *   ⇒ 字幕按 cue.start 亮起，声音却要等 0.2 秒才响 =「声音比字幕慢一点」（用户原话）
 *
 * 修法：**音频一个字节都不动**，只把**字幕的起点**按每段实测的开口延迟往后推。
 *   · 为什么不裁音频：`silenceremove` 切完开头容易留爆音，而且 ffmpeg 3.0.1 没有
 *     `start_silence`（想留 20ms 缓冲都做不到），阈值一换长度就不一样 ✗
 *   · 为什么不解析 `silencedetect` 日志：这版 ffmpeg 的日志格式/级别不稳定，
 *     实测拿不到（8 段全返回 0）✗ ⇒ 改成**直接读 PCM 样本**找第一个超过阈值的点 ✓
 *   · 为什么推字幕而不是推动作：音频拼接顺序/时长都没变 ⇒ cue 的累计时间轴仍然精确，
 *     只加一个本段的偏移，**不会累积漂移** ✓ */
const firstSoundSec = (p, threshDb = -45) => {
  const r = spawnSync(FFMPEG, ['-v', 'quiet', '-i', p,
    '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { maxBuffer: 128 * 1024 * 1024 });
  const buf = r.stdout;
  if (!buf || !buf.length) return 0;
  const thresh = 32768 * Math.pow(10, threshDb / 20);
  for (let i = 0; i + 1 < buf.length; i += 2) {
    if (Math.abs(buf.readInt16LE(i)) > thresh) return (i / 2) / 8000;
  }
  return 0;
};
const wavPaths = wavs.map((f) => join(VOICE_DIR, f));
const leads = wavPaths.map((p) => firstSoundSec(p));
const durs = wavPaths.map(durOf);
const GAP = 0.35;
say(`开头静音（秒）：${leads.map((x) => x.toFixed(3)).join(' / ')}`);
let cursor = 0;
const cues = lines.map((l, i) => {
  const dur = durs[i] || 3;
  const lead = leads[i] || 0;
  // 音频里这一段从 cursor 开始，静音 lead 秒后才开口 ⇒ 字幕起点挪到 cursor+lead ✓
  const c = { start: cursor + lead, end: cursor + dur, dur, text: l.text };
  cursor += dur + GAP;
  return c;
});
const totalDur = cursor;
say(`台词 ${lines.length} 句 / 配音 ${totalDur.toFixed(1)} 秒`);

/* ── ② 群消息 ─────────────────────────────────────
 * 过滤规则在 tools/lib/chat-filter.mjs（**和 tools/pick-chat.mjs 共用一份**：
 * 那边让模型挑的是"候选列表下标"，这边必须按同一份下标取，各写一份必然错位 ✗）
 * 「哪条消息契合台词」由模型判（tools/pick-chat.mjs），这里只按挑好的下标取 ✓
 */
const rj = JSON.parse(readFileSync(join(ROOT, 'state', 'recent.json'), 'utf8'));
const all = (rj.groups || {})[GROUP] || [];
if (!all.length) {
  say(`❌ 群 ${GROUP} 没有记录`);
  process.exit(1);
}
const cand = filterMessages(all);
let picked = cand;
const CHAT_PICKED = arg('chat-picked', '');
if (CHAT_PICKED) {
  const p = resolve(CHAT_PICKED);
  if (!existsSync(p)) { say('❌ 挑好的群聊清单不存在：' + p); process.exit(1); }
  const kp = JSON.parse(readFileSync(p, 'utf8'));
  if (String(kp.group) !== String(GROUP)) {
    say(`❌ ${p} 是群 ${kp.group} 的，和 --group ${GROUP} 不一致`);
    process.exit(1);
  }
  if (Array.isArray(kp.keys) && kp.keys.length) {
    /* ⚠️⚠️ 必须按**指纹**取，不能按下标：
     *   候选来自 `all.slice(-170)`，而群消息一直在进 ⇒ 窗口会滑动，
     *   实测两次都是 143 条、数量校验看不出来，但**内容全变了**
     *   ⇒ 按下标取会取到别的消息（明明剔掉了「房租该交了」，成片里照样出现 ✗）
     *   指纹 = messageId；没有 id 的（自己发的）用清洗后的正文 ✓ */
    const byKey = new Map();
    for (const m of cand) byKey.set(keyOf(m), m);
    picked = kp.keys.map((k) => byKey.get(String(k))).filter(Boolean);
    const lost = kp.keys.length - picked.length;
    say(`按 agent 挑选（指纹匹配）：${picked.length}/${kp.keys.length} 条对上`);
    if (lost > 0) say(`⚠️ ${lost} 条已经滑出候选窗口（那几条用不上，其余正常）`);
  } else if (Array.isArray(kp.keep)) {
    // 老格式（按候选下标）—— 只为兼容旧文件，别再用它挑新的
    say('⚠️ 旧格式（按候选下标）：群消息一更新就会错位，请重挑成 keys 格式');
    const keep = new Set(kp.keep.map(Number));
    picked = cand.filter((_, i) => keep.has(i));
    say(`按下标兼容模式取：${picked.length} 条`);
  }
}
say(`可用消息 ${picked.length} 条 / 候选 ${cand.length} 条`);

const isSelf = (uid) => String(uid) === '__self__';
// 引用消息 id → 原话（真 QQ 的引用框显示被引用的内容，不是一串数字）
const quotedText = new Map();
for (const m of all) {
  if (m.messageId != null) {
    quotedText.set(String(m.messageId), String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 40));
  }
}
// ⚠️ 用**真实昵称**（用户 2026-10-20：「要做的一模一样」）——
//    脱敏成「群友A/B」一眼就看出是假的；QQ 号本来也没显示，昵称保留更真实 ✓
const nick = (m) => {
  const uid = String(m.userId || '');
  if (isSelf(uid)) return '客服 Saki';
  const info = memberMap.get(uid);
  return (info && (info.card || info.nickname)) || String(m.name || '').trim() || '群友';
};
// 等级标签：**必须用真实群成员数据**（协议端 get_group_member_list 拉下来的）
// ⚠️ 别按 uid 哈希编 —— 那样"标签和第一个人对不上"（用户 2026-10-20 指出的）
const MEMBERS_FILE = join(ROOT, 'logs', 'bili', `members_${GROUP}.json`);
const memberMap = new Map();
// ⚠️ 读不到就**直接不录**（用户 2026-10-20：「以后自动制作视频发送的时候不要出这种问题」）
//    以前只是警告然后接着录 ⇒ 等级标签全空/瞎编 ⇒ 白做一条 ✗
try {
  const raw = readFileSync(MEMBERS_FILE, 'utf8').replace(/^\uFEFF/, ''); // 去可能的 BOM
  const arr = JSON.parse(raw);
  for (const it of arr) {
    memberMap.set(String(it.user_id), {
      level: Number(it.level) || 0,
      title: String(it.title || '').trim(),
      card: String(it.card || '').trim(),
      role: String(it.role || 'member'),
    });
  }
} catch (e) {
  say('❌ 读不到群成员数据：' + MEMBERS_FILE);
  say('   等级标签必须用真实数据（不能瞎编）⇒ 这次不录。');
  say('   先跑 get_group_member_list → 存成 members_' + GROUP + '.json（⚠️ 别带 BOM）');
  say('   详见 docs/bili-视频自检.md');
  process.exit(2);
}
if (memberMap.size === 0) {
  say('❌ 群成员数据是空的 ⇒ 不录（等级标签会全空）');
  process.exit(2);
}
say(`成员数据 ${memberMap.size} 条（真实等级）`);
const lvOf = (m) => {
  const uid = String(m.userId || '');
  const real = memberMap.get(uid) || memberMap.get(SELF_QQ) && isSelf(uid) ? memberMap.get(SELF_QQ) : null;
  const info = memberMap.get(uid) || (isSelf(uid) ? memberMap.get(SELF_QQ) : null);
  if (!info) return { lv: 0, tag: '', cls: 'lv-gray' };
  const lv = info.level;
  // 颜色按真实身份分：群主/管理 → 橙；100 级 Dev 通道 → 橙；30 级以上 → 绿；其余蓝灰
  const cls = info.role === 'owner' || info.role === 'admin' || lv >= 100 ? 'lv-orange' : lv >= 30 ? 'lv-green' : 'lv-gray';
  return { lv, tag: info.title || '', cls };
};

/* ── ③ 生成 HTML ─────────────────────────────── */
// 用户 2026-10-20：**顶部群名栏和底部输入框直接用真截图的死贴图**，
// 头像也要**真实头像 + 圆形**。所以从真截图裁了两块、按 QQ 号下了头像。
const CHROME_DIR = join(ROOT, 'logs', 'bili', 'chrome');
const AVATAR_DIR = join(ROOT, 'logs', 'bili', 'avatars');
const SELF_QQ = arg('self-qq', '10000002'); // saki 主号，用自己的头像
const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/');
const TOPBAR = join(CHROME_DIR, 'topbar.png');
const INPUTBAR = join(CHROME_DIR, 'inputbar.png');
if (!existsSync(TOPBAR) || !existsSync(INPUTBAR)) {
  say('❌ 缺顶部栏/输入框贴图（logs/bili/chrome/）');
  process.exit(1);
}
// ⚠️ 贴图按 1080 宽等比缩放 ⇒ 容器高度 = 缩放后的实际高度
//    参考图换成用户给的 884x1368 那张（比例正确）：顶部栏 80 高、输入框 300 高
const REF_W = 884;
const SCALE = W / REF_W;
const TOP_H = Math.round(80 * SCALE);
const INPUT_H = Math.round(308 * SCALE);
// 所有字号/间距都按同一个 SCALE 换算，保证和真 QQ 一个比例
const S = (n) => Math.round(n * SCALE);

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// 头像：按 QQ 号取真图，没有就退回渐变色块
const avatarOf = (m, n) => {
  const uid = String(m.userId || '');
  const qq = isSelf(uid) ? SELF_QQ : uid;
  const p = join(AVATAR_DIR, `${qq}.jpg`);
  if (existsSync(p)) return `<img class="av" src="${fileUrl(p)}" alt="">`;
  const cnCh = n.match(/[\u4e00-\u9fa5]/);
  const initial = cnCh ? cnCh[0] : (n.match(/[A-Za-z0-9]/) || ['群'])[0];
  return `<div class="av av-fallback" style="background:hsl(${(n.charCodeAt(0) * 53) % 360} 45% 62%)">${esc(initial)}</div>`;
};

const msgHtml = picked
  .map((m, i) => {
    const me = isSelf(m.userId);
    const n = nick(m);
    const { lv, tag, cls } = lvOf(m);
    // 头像：真 QQ 是图片，这里用渐变块 + 昵称首字
    // ⚠️ 首字要**优先取中文**：很多昵称以符号开头（「✟ʚAAA月之森…」），
    //    直接取第一个字母会全都变成「A」，一眼假 ✗
    const cnCh = n.match(/[\u4e00-\u9fa5]/);
    const initial = me
      ? 'S'
      : cnCh
        ? cnCh[0]
        : (n.match(/[A-Za-z0-9]/) || ['群'])[0];
    const avColor = `hsl(${(n.charCodeAt(0) * 53) % 360} 45% 62%)`;
    const raw = String(m.text || '').trim();
    const isImg = Array.isArray(m.imageFiles) && m.imageFiles.length;
    // 引用：原文里带 [引用#xxx]
    const qm = raw.match(/\[引用#([^\]]+)\]\s*([\s\S]*)/);
    const qTxt = qm
      ? quotedText.get(String(qm[1]).trim()) ||
        quotedText.get(String(qm[1]).replace(/^-/, '').trim()) ||
        '引用了一条消息'
      : '';
    const quote = qm ? `<div class="quote">${esc(qTxt)}</div>` : '';
    const body = (qm ? qm[2] : raw).replace(/\[引用#[^\]]*\]/g, '').trim();
    const isVoice = /\[语音\]/.test(body);
    const isFile = /\[文件[:：]/.test(body);
    const txt = body
      .replace(/\[QQ表情\]/g, '')
      .replace(/\[表情包\]/g, '')
      .replace(/\[图片\]/g, '')
      .replace(/\[合并转发\]/g, '［合并转发］')
      .replace(/\[语音\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    let content = '';
    if (isImg && !txt) {
      content = `<div class="imgph" style="background:linear-gradient(135deg,hsl(${(n.charCodeAt(0) * 47) % 360} 45% 78%),hsl(${(n.charCodeAt(0) * 47 + 40) % 360} 40% 68%))">［图片］</div>`;
    } else if (isVoice) {
      content = `<div class="voice">▸ 语音</div>`;
    } else if (isFile) {
      content = `<div class="filebox">📄 ${esc((body.match(/\[文件[:：]([^\]]+)\]/) || [])[1] || '文件')}</div>`;
    } else {
      content = `<div class="bubble">${quote}${esc(txt || '［图片］')}</div>`;
    }

    // 时间分隔：真 QQ 是"隔一段就显示一次"，不是只有第一条
    const timeTag =
      i % 6 === 0
        ? `<div class="time">${new Date(Number(m.time) || Date.now()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</div>`
        : '';

    // 真实头像（圆形）；me 时 DOM 顺序是「气泡列 → 头像」，
    // 所以 .me 里**不能**再 row-reverse，否则头像会跑到左边 ✗
    const avHtml = avatarOf(m, n);
    return `${timeTag}
<div class="msg ${me ? 'me' : ''}" data-i="${i}">
  ${me ? '' : avHtml}
  <div class="col">
    ${me ? '' : `<div class="meta"><span class="lv ${cls}">LV${lv} ${tag}</span><span class="nm">${esc(n)}</span></div>`}
    ${content}
  </div>
  ${me ? avHtml : ''}
</div>`;
  })
  .join('\n');

// 开局先铺多少条消息（不然第 0 秒画面是空的）
// 整段里分几次滑动。⚠️ 8 次时每次要滑 450px/0.6s ⇒ 25fps 下每帧位移 30px，看着**跳** ✗
// 改成 16 次（每段滑半屏、时长 1 秒以上）⇒ 每帧位移 ~8px，才是顺滑的滑动 ✓
const STOPS = 16;

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: ${W}px; height: ${PANEL_H}px; overflow: hidden;
    background: linear-gradient(180deg, #dff5fd 0%, #dcf3fe 45%, #e8f2fd 100%); }
  body { font-family: "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif; }

  .panel { width: 100%; height: 100%; display: flex; flex-direction: column;
    background: linear-gradient(180deg, #dff5fd 0%, #dcf3fe 45%, #e8f2fd 100%); }

  /* 顶部群名栏：直接用真截图的**死贴图**（用户 2026-10-20 要求一模一样） */
  .top { height: ${TOP_H}px; flex: 0 0 ${TOP_H}px; overflow: hidden; }
  .top img { width: 100%; display: block; }

  /* ⚠️ 右边留出 Live2D 的位置（2026-10-21）：人物半身约 556px 宽、压在右半边，
   *   不留白的话自己的蓝色气泡（靠右）会被人物整个盖住、字全看不见 ✗
   *   ⇒ 聊天列只占左侧 ~560px，人物在右侧，互不遮挡 ✓ */
  .feed { flex: 1; overflow: hidden; padding: ${S(18)}px ${S(520)}px ${S(46)}px ${S(20)}px; position: relative; }

  .time { text-align: center; font-size: ${S(13)}px; color: #9aa9b8; margin: ${S(14)}px 0 ${S(12)}px; }

  .msg { display: flex; gap: ${S(11)}px; margin-bottom: ${S(16)}px; align-items: center;
    opacity: 0; transform: translateY(10px); transition: opacity .3s ease, transform .3s ease; }
  .msg.on { opacity: 1; transform: translateY(0); }
  /* ⚠️ 自己消息**整行要靠右**：只把 .col 内部右对齐不够，flex 容器还是左对齐 ✗ */
  .msg.me { justify-content: flex-end; }
  /* ⚠️ 自己消息**不要** row-reverse：头像在 DOM 尾部，正常 flex 就落在右侧 ✓ */

  /* 头像：真实头像 + **圆形**（真 QQ 就是圆的） */
  .av { width: ${S(38)}px; height: ${S(38)}px; border-radius: 50%; flex: 0 0 ${S(38)}px; object-fit: cover; display: block; }
  .av-fallback { display: flex; align-items: center; justify-content: center;
    font-size: ${S(14)}px; font-weight: 700; color: #fff; }
  .col { display: flex; flex-direction: column; gap: ${S(5)}px; max-width: ${S(600)}px; flex: 0 1 auto; }
  .msg.me .col { align-items: flex-end; }

  .meta { display: flex; align-items: center; gap: ${S(7)}px; padding: 0 2px; }
  .lv { display: inline-flex; align-items: center; font-size: ${S(12)}px; color: #fff; padding: 1px ${S(5)}px; border-radius: ${S(3)}px; line-height: 1.25; }
  /* 真 QQ 的等级标签有颜色区分：Dev 通道橙、活跃绿、普通蓝灰 */
  .lv-orange { background: linear-gradient(90deg,#ffb26b,#ff9f43); }
  .lv-green { background: linear-gradient(90deg,#7fd6a8,#45bd83); }
  .lv-gray { background: #b6c0cd; }
  .nm { font-size: ${S(15)}px; color: #8a94a2; line-height: 1.25; }

  .bubble { font-size: ${S(22)}px; line-height: 1.45; color: #1c1c1c; background: #fff;
    padding: ${S(11)}px ${S(15)}px; border-radius: ${S(9)}px; box-shadow: 0 1px 4px rgba(20,40,70,.06);
    word-break: break-word; }
  .msg.me .bubble { background: linear-gradient(135deg, #63aef2, #4a9eff); color: #fff; }

  .quote { font-size: ${S(15)}px; color: #8a94a2; border-left: 2px solid #d5dee8;
    padding: 2px 0 2px 14px; margin-bottom: 10px; }

  .imgph { width: 380px; height: 300px; border-radius: 12px; display: flex;
    align-items: center; justify-content: center; color: #fff; font-size: 24px;
    box-shadow: 0 2px 10px rgba(20,40,70,.10); }

  .voice { background: #fff; border-radius: 14px; padding: 20px 30px; font-size: 28px;
    color: #4a9eff; box-shadow: 0 2px 8px rgba(20,40,70,.07); }
  .msg.me .voice { background: linear-gradient(135deg, #63aef2, #4a9eff); color: #fff; }

  .filebox { background: #fff; border-radius: 14px; padding: 22px 26px; font-size: 26px;
    color: #3a4553; box-shadow: 0 2px 8px rgba(20,40,70,.07); }

  .sys { text-align: center; font-size: ${S(12)}px; color: #a3adb9; margin: ${S(10)}px 0; }

  /* 底部输入栏：直接用真截图的**死贴图**（用户 2026-10-20 要求一模一样） */
  .inputbar { flex: 0 0 ${INPUT_H}px; height: ${INPUT_H}px; overflow: hidden; }
  .inputbar img { width: 100%; display: block; }
</style></head><body>
<div class="panel">
  <div class="top"><img src="${fileUrl(TOPBAR)}" alt=""></div>
  <div class="feed" id="feed">${msgHtml}</div>
  <div class="inputbar"><img src="${fileUrl(INPUTBAR)}" alt=""></div>
</div>
<script>
  const feed = document.getElementById('feed');
  const rows = [...document.querySelectorAll('.msg')];
  const TOTAL = ${totalDur.toFixed(3)};

  /* 用户 2026-10-21：「不要加消息弹出动画」+「也不是匀速滑动吧，要模拟手指的滑动」
   * ⇒ 消息**开局就全部可见**（没有透明度/位移过渡），只让画面**像手指拖屏**那样动：
   *    · 曲线用 easeOutCubic（起手快、松手后减速滑行），不是匀速也不是缓入缓出
   *    · 每次滑动时长都不一样（0.45~0.8s 轮换），滑完停住等下一次 —— 匀速会被一眼看穿
   *    · 整段分 ${STOPS} 次（对应 8 句台词），最后一次正好滑到底 ✓ */
  rows.forEach((r) => r.classList.add('on'));

  // ⚠️ 段数**按实际可滚高度算**，不要写死：
  //    写死 16 段时，消息一变长（纯文字里有不少 100+ 字的长句）总高度就翻倍 ⇒
  //    每段从 220px 变成 350px+ ⇒ 25fps 下每帧位移又超标 ⇒ 背景又开始跳 ✗
  //    改成"每段固定滑 ~220px"，内容怎么变都是同一个手感 ✓
  const PX_PER_STOP = 220;
  function stopCount() {
    return Math.max(6, Math.round(maxScroll() / PX_PER_STOP));
  }
  // 每次滑动用多久（秒）—— 故意不均匀，模仿手指快慢
  const DURS = [1.05, 0.9, 1.25, 0.95, 1.15, 0.88, 1.2, 1.0, 1.1, 0.92, 1.22, 0.98, 1.08, 0.86, 1.18, 1.02];

  let t0 = 0, raf = null, running = false;
  // 诊断：每帧记一次滚动位置（只是 push 数组，不开新 rAF 循环，开销可忽略）
  window.__scrollLog = [];

  function maxScroll() { return Math.max(0, feed.scrollHeight - feed.clientHeight); }
  // 手指滑动的感觉：一上来就快，松手后越来越慢（easeOut）
  const easeOut = (x) => 1 - Math.pow(1 - x, 3);

  function scrollToProgress(p) {
    feed.scrollTop = maxScroll() * Math.max(0, Math.min(1, p));
  }

  function tick() {
    if (!running) return;
    const t = (performance.now() - t0) / 1000;
    const SEGS = stopCount();
    const SEG = TOTAL / SEGS;
    const seg = Math.min(SEGS - 1, Math.floor(t / SEG));
    const segT = t - seg * SEG;
    const dur = DURS[seg % DURS.length];
    const p0 = seg / SEGS;
    const p1 = (seg + 1) / SEGS;
    const e = segT >= dur ? 1 : easeOut(segT / dur);
    scrollToProgress(p0 + (p1 - p0) * e);
    window.__scrollLog.push([Math.round(t * 1000), Math.round(feed.scrollTop)]);
    if (t < TOTAL) raf = requestAnimationFrame(tick);
  }

  window.__start = () => {
    if (running) return;
    t0 = performance.now();
    running = true;
    scrollToProgress(0);
    tick();
  };
  window.__stop = () => { running = false; if (raf) cancelAnimationFrame(raf); };

  window.__seek = (p) => {
    window.__stop();
    scrollToProgress(p);
  };

  /* ⚠️⚠️ 逐帧模式（录制就用这个，2026-10-21 最终方案）：
   *   滚动位置**完全由帧号算出来**，不依赖时钟、不依赖录屏采样
   *   ⇒ 时间轴绝对均匀，从原理上不可能跳帧 ✓
   *   之前 recordVideo（内容只 15fps）和 CDP screencast（帧时间戳抖动 -248~302ms）
   *   都是"采样不均"把画面拉歪的 ✗ */
  window.__seekFrame = (i, total) => {
    window.__stop();
    const t = (total <= 1 ? 0 : i / (total - 1)) * TOTAL;
    const SEGS = stopCount();
    const SEG = TOTAL / SEGS;
    const seg = Math.min(SEGS - 1, Math.floor(t / SEG));
    const segT = t - seg * SEG;
    const dur = DURS[seg % DURS.length];
    const e = segT >= dur ? 1 : easeOut(segT / dur);
    scrollToProgress((seg + e) / SEGS);
  };
</script></body></html>`;

const work = resolve(arg('work', join(ROOT, 'logs', 'bili', `intro3-work-${Date.now()}`)));
mkdirSync(work, { recursive: true });
const htmlPath = join(work, 'qq.html');
writeFileSync(htmlPath, html, 'utf8');
say(`HTML 已生成（${picked.length} 条消息，${cues.length} 个滚动点）`);

/* ── ③.5 立绘（伪 Live2D）───────────────────── */
// 用户 2026-10-20：「用上祥子/live2d 形象配合声音」
// 没有真 Live2D 模型 ⇒ 用官方立绘 PNG 做：呼吸上下浮动 + 说话时轻微抖动
const TACHIE = arg('tachie', '');
const tachiePath = TACHIE ? resolve(TACHIE) : '';
if (tachiePath && !existsSync(tachiePath)) {
  say('❌ 立绘文件不存在：' + tachiePath);
  process.exit(1);
}

/* ── ③.6 真 Live2D 绿幕录像（优先于立绘）─────────────────
 * 用户 2026-10-21：「一开始录的时候就只截这一块，先看能不能只把这一小块改成绿色」
 *   +「注意要音画同步」
 *
 * 录制侧（tools/live2d-record.mjs）出的是**整页录屏 + 绿幕**，并写 meta.json：
 *   - trimStart：开头那截（加载模型 + 藏 UI + 刷绿）要裁掉多少秒
 *   - crop     ：canvas 在视频里的矩形（录的是整页，这里只取那一块）
 * 合成侧在这里：
 *   ① 抽帧 → tools/green-key.mjs 算出**人物真实边界**（不然人物小小一个，放大会糊）
 *   ② 裁 canvas → 裁人物 → chromakey 抠绿 → 缩放到目标高度 → overlay
 * ⚠️ 音画同步靠的是三点：录屏时间轴真实（25fps 原生）、trimStart 精确裁头、
 *    动作按台词时间轴点 ⇒ 三条都对上才不会"口型/动作先跑一步"
 * ⚠️ 抠图失效时的退路（用户允许）：--l2d-boxed，不抠绿，直接带框放进去
 */
const L2D_DIR = arg('live2d', '');
const L2D_H = Number(arg('l2d-h', '700'));
const L2D_BOXED = argv.includes('--l2d-boxed') || argv.includes('--boxed');
let l2dMeta = null;
let l2dBbox = null;
if (L2D_DIR) {
  const metaPath = join(L2D_DIR, 'meta.json');
  if (!existsSync(metaPath)) { say('❌ 找不到 ' + metaPath + '（先跑 tools/live2d-record.mjs）'); process.exit(1); }
  l2dMeta = JSON.parse(readFileSync(metaPath, 'utf8'));
  if (!existsSync(l2dMeta.video)) { say('❌ 录像不存在：' + l2dMeta.video); process.exit(1); }

  // 抽 12 帧（裁到 canvas 区域）喂给 green-key 算人物边界
  const probeDir = join(ROOT, 'logs', 'bili', '__l2dprobe');
  rmSync(probeDir, { recursive: true, force: true });
  mkdirSync(probeDir, { recursive: true });
  const c = l2dMeta.crop;
  const pk = spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
    '-ss', String(l2dMeta.trimStart), '-i', l2dMeta.video,
    '-vf', `crop=${c.w}:${c.h}:${c.x}:${c.y},fps=1`, '-frames:v', '12',
    join(probeDir, 'p%02d.png')], { encoding: 'utf8', timeout: 180000 });
  if (pk.status !== 0) { say('❌ 抽帧失败：' + String(pk.stderr).slice(-200)); process.exit(1); }
  const gk = spawnSync(process.execPath, [join(ROOT, 'tools', 'green-key.mjs'), probeDir], { encoding: 'utf8' });
  try {
    l2dBbox = JSON.parse(String(gk.stdout || '{}'));
  } catch { l2dBbox = null; }
  if (!l2dBbox?.cropEven) { say('❌ 算人物边界失败：' + String(gk.stderr || gk.stdout).slice(-300)); process.exit(1); }
  say(`Live2D：trimStart=${l2dMeta.trimStart}s  canvas=${c.w}×${c.h}+${c.x}+${c.y}  ` +
      `人物=${l2dBbox.person.w}×${l2dBbox.person.h} → 缩放到高 ${L2D_H}px` +
      `${L2D_BOXED ? '（带框不抠图）' : '（绿幕抠图）'}`);
}

/* ── ④ Playwright 录制 —— 用 **CDP screencast**，不用 recordVideo ──
 * ⚠️⚠️ 为什么弃用 recordVideo（2026-10-21 实测到底）：
 *   · 页面自己滚动是 **158fps、每帧位移 2.1px**（在页面里记录 scrollTop 验证过），完全平滑
 *   · 但 `recordVideo` 出来的内容只有 ~15fps（合成器出新画面慢），却被封装成 25fps
 *     ⇒ 中间塞满重复帧 ⇒ 画面「停一下、窜一下」= 用户说的跳帧 ✗
 *   · `Page.startScreencast` 是 Chrome **主动推每一帧**、带真实时间戳：
 *     实测 headless 下能到 **30fps、帧间隔 33ms（15~51ms）**，比 recordVideo 好一倍 ✓
 * 做法：收帧 → 写 PNG → 用**每帧的真实时间戳**写 concat 列表 → 转成 30fps CFR 视频
 */
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--disable-blink-features=AutomationControlled', '--force-device-scale-factor=1'],
});
const ctx = await browser.newContext({
  viewport: { width: W, height: PANEL_H },
  deviceScaleFactor: 1,
});
const page = await ctx.newPage();

// 收集 screencast 推来的帧（jpeg 更快，帧间隔也更均匀；quality 92 对文字足够）
const scFrames = [];
let cdp = null;
const startScreencast = async () => {
  cdp = await ctx.newCDPSession(page);
  cdp.on('Page.screencastFrame', async (e) => {
    scFrames.push({ ts: e.metadata.timestamp, data: e.data });
    try { await cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }); } catch { /* ignore */ }
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg', quality: 92, maxWidth: W, maxHeight: PANEL_H, everyNthFrame: 1,
  });
};
const stopScreencast = async () => {
  try { if (cdp) await cdp.send('Page.stopScreencast'); } catch { /* ignore */ }
};

await page.goto('file:///' + htmlPath.replace(/\\/g, '/'), { waitUntil: 'load' });
await page.waitForTimeout(500);

// ⚠️ --preview：**只出图不录制**（用户 2026-10-20：「做完 html 之前自己检查一遍」）
//    先看几张（开头/中间/结尾），确认没问题再去掉 --preview 正式录
if (process.argv.includes('--preview')) {
  for (const [name, p] of [['开头', 0.02], ['中间', 0.5], ['结尾', 0.99]]) {
    await page.evaluate((pp) => window.__seek(pp), p);
    await page.waitForTimeout(700);
    const out = join(ROOT, 'logs', 'bili', `__preview_${name}.png`);
    await page.screenshot({ path: out });
    say('预览：' + out);
  }
  await ctx.close();
  await browser.close();
  say('✅ 预览完成（没录视频）。确认没问题再去掉 --preview 正式跑');
  process.exit(0);
}

/* ── 开始录制 ──
 * 页面自己按 `__start()` 那一刻起算时间（逐条渐现 + 缓慢上滑），
 * 与录屏时间轴同轴 ⇒ 第 N 秒的画面内容和配音第 N 秒对得上 ✓ */
await startScreencast();
const t0 = Date.now();
await startScreencast();
await page.evaluate(() => window.__start());
say(`页面动画已启动（${totalDur.toFixed(1)}s 内逐条滚完，不重放）；screencast 录制中`);

// ⚠️ 多录 1.5 秒尾巴：ffmpeg 3.0.1 **没有 tpad 滤镜**，没法事后克隆末帧补时长；
//    而 `-shortest` 会以最短流结束 ⇒ 末尾那句会被切掉（用户 2026-10-21：「最后一句话被裁掉了」）
//    ⇒ 从源头让录屏比配音长一点，`-t totalDur` 永远不会撞到视频流的尽头 ✓
const remain = (totalDur + 1.5) * 1000 - (Date.now() - t0);
if (remain > 0) await page.waitForTimeout(remain);
await stopScreencast();
await page.waitForTimeout(400); // 等最后几帧推完

/* ── 逐帧确定性生成（**这才是录制用的路径**）──
 *   每一帧：`__seekFrame(i, N)` 直接把画面设到"第 i 帧该有的样子"，然后截图。
 *   位置由帧号算出来 ⇒ 时间轴绝对均匀，不可能跳帧 ✓
 *   代价：截图比实时录制慢（850 帧约 1.5 分钟），但结果确定。
 */
const CHAT_MP4 = join(work, 'chat.mp4');
const SHOT_FPS = 25;
const SHOT_N = Math.round((totalDur + 0.5) * SHOT_FPS); // 多给 0.5 秒尾巴
const shotsDir = join(work, 'frames');
mkdirSync(shotsDir, { recursive: true });
say(`逐帧生成 ${SHOT_N} 帧 @ ${SHOT_FPS}fps（大约 ${Math.round(SHOT_N * 0.09)} 秒）…`);
const tShot = Date.now();
for (let i = 0; i < SHOT_N; i++) {
  await page.evaluate(({ i, n }) => window.__seekFrame(i, n), { i, n: SHOT_N });
  await page.screenshot({
    path: join(shotsDir, `f${String(i).padStart(5, '0')}.jpg`),
    type: 'jpeg', quality: 95,
  });
  if (i > 0 && i % 200 === 0) say(`  ${i}/${SHOT_N}…`);
}
say(`逐帧截图完成，用时 ${((Date.now() - tShot) / 1000).toFixed(0)}s`);

// 帧号 = 帧号 ⇒ 用固定帧率直接编码，不需要 concat/时间戳
const rSc = spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
  '-framerate', String(SHOT_FPS), '-i', join(shotsDir, 'f%05d.jpg'),
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
  CHAT_MP4], { encoding: 'utf8', timeout: 300000 });
if (rSc.status !== 0 || !existsSync(CHAT_MP4)) {
  say('❌ 帧序列转视频失败：' + String(rSc.stderr || '').slice(-300));
  process.exit(3);
}
say(`聊天画面：${SHOT_FPS}fps 确定性逐帧 → ${CHAT_MP4}`);
rmSync(shotsDir, { recursive: true, force: true }); // 帧用完就删（占空间）

await ctx.close();
await browser.close();
// 聊天画面是逐帧拼出来的 mp4（CHAT_MP4），不再有 webm
const webm = existsSync(CHAT_MP4) ? CHAT_MP4 : null;
if (!webm) {
  say('❌ 没录到视频');
  process.exit(2);
}
say(`用画面：${webm}`);

/* ── ⑤ 拼音轨 + 字幕 + 合成 ───────────────────── */
const gapFile = join(work, 'gap.wav');
spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
  '-i', 'anullsrc=r=24000:cl=mono', '-t', String(GAP), gapFile], { encoding: 'utf8' });
const voiceList = [];
durs.forEach((_, i) => {
  voiceList.push(`file '${wavPaths[i].replace(/\\/g, '/')}'`);
  if (i < durs.length - 1) voiceList.push(`file '${gapFile.replace(/\\/g, '/')}'`);
});
const listFile = join(work, 'list.txt');
writeFileSync(listFile, voiceList.join('\n'), 'utf8');
const voiceFile = join(work, 'voice.m4a');
spawnSync(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile,
  '-ar', '24000', '-ac', '1', '-c:a', 'aac', '-b:a', '192k', voiceFile], { encoding: 'utf8', timeout: 180000 });

const escT = (s) =>
  s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/%/g, '\\%');
// 字幕：长句拆行
// 用户 2026-10-21：「字体改大一点并居中」⇒ 字号 38→56，x 用 (w-text_w)/2 居中
// 断行算法在 tools/lib/subtitle-wrap.mjs（合成和自检共用一份，别各写一遍 ✗）
// 交付前先跑 `node tools/subtitle-wrap-test.mjs` 扫一遍拆行结果，不用等 6 分钟合成
const SUB_SIZE = 56;
const subFilters = cues
  .map((c, i) => {
    // 最后一句停到片尾（否则 cue 结束后还有 0.3 秒空白，看着像"最后一句被切了"✗）
    const e = i === cues.length - 1 ? totalDur : Math.min(c.end, totalDur);
    const rows = wrapSub(c.text);
    return rows
      .map((ln, k) => {
        // 行数越多整体越往上抬，最后一行底边稳定在 ~1796 以内
        const y = 1700 - (rows.length - 1) * 80 + k * 80;
        return (
          `drawtext=fontfile='${FONT}':text='${escT(ln)}':fontcolor=white:fontsize=${SUB_SIZE}:` +
          `x=(w-text_w)/2:y=${y}:box=1:boxcolor=0x000000@0.6:boxborderw=24:` +
          `enable='between(t,${c.start.toFixed(2)},${e.toFixed(2)})'`
        );
      })
      .join(',');
  })
  .join(',');
// 字幕渲染方式（用户 2026-10-21：「把字幕生成方式改一下」）
//   ASS 预渲染：**一次排版**，之后每帧只贴图 ⇒ 比 19 条 drawtext 每帧重排快得多 ✓
//   drawtext 保留成 `--sub-drawtext` 的退路（万一 libass 出问题）
const USE_ASS = !argv.includes('--sub-drawtext');
let subChain = subFilters;
if (USE_ASS) {
  const blocks = cues.map((c, i) => ({
    start: c.start,
    // 最后一句停到片尾（否则片尾 0.3 秒空白，像"最后一句被切了"）
    end: i === cues.length - 1 ? totalDur : Math.min(c.end, totalDur),
    rows: wrapSub(c.text),
  }));
  // ⚠️ 一定要写进**纯 ASCII 无空格**的路径：ffmpeg 滤镜参数里空格/中文要额外转义，
  //    而这个项目的目录是「OneDrive - yijia\文档\ds1」—— 直接塞进去必然解析失败 ✗
  const assPath = join(tmpdir(), 'ds1-bili-sub.ass');
  writeFileSync(assPath, buildAss(blocks, { W, H }), 'utf8');
  const esc = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');
  subChain = `ass=filename='${esc}'`;
  say(`字幕：ASS 预渲染（${blocks.reduce((a, b) => a + b.rows.length, 0)} 行）→ ${assPath}`);
} else {
  say('字幕：drawtext 逐条渲染（--sub-drawtext）');
}

// 把每句的拆行结果打出来 —— 交付前扫一眼就知道字幕有没有被拆坏（不用等 6 分钟合成完）
cues.forEach((c, i) => say(`  字幕${i}：${wrapSub(c.text).map((x) => `〔${x}〕`).join('')}`));

const filter = [];
const inputs = ['-y', '-i', webm, '-i', voiceFile];
let hasAvatar = false;

/* ── 片头（**只有"agent 自己搜集题材"那种视频用**，2026-10-22 用户定）──────
 * 用户原话：「群里的趣事类不用变，agent 自己搜集题材做的才要用上 ae」
 * 做法：`tools/ae-intro.mjs` 在 AE 里渲出 1080×1920 的**透明 PNG 序列**，
 *   这里当普通输入读进来，叠在**前 3 秒**（`enable=lt(t,3)`）。
 *   ⚠️ 为什么不是 `concat` 拼在前面：那样整条时间轴（口型、字幕、聊天滚动）都要后移 3 秒，
 *      一改就得全部重算，极易错位 ✗ 叠一层则**时间轴一个字都不动** ✓
 */
const INTRO_DIR = arg('intro', '');
const INTRO_SEC = Number(arg('intro-sec', '3'));
// ⚠️ 片头 PNG 序列的帧率要和 AE 那边一致（`tools/ae-intro.jsx` 现在是 15fps）
const INTRO_FPS = Math.max(1, Number(arg('intro-fps', '15')) || 15);
let introDir = '';
let introPngs = [];
if (INTRO_DIR) {
  const p = resolve(INTRO_DIR);
  introPngs = existsSync(p) ? readdirSync(p).filter((f) => /^intro_\d+\.png$/i.test(f)).sort() : [];
  if (!introPngs.length) say(`⚠️ --intro 指了 ${p}，但里面没有 intro_*.png ⇒ 不做片头`);
  else introDir = p;
}

if (L2D_DIR) {
  /* 真 Live2D 绿幕录像：裁 canvas → 裁人物 → 抠绿 → 缩放到目标高度 */
  // ⚠️ -ss 必须是**输入选项**（紧挨着 -i）：它是"解码后丢弃前 X 秒"，帧精确 ✓
  //    写成输出选项（-i 之后）会把整条输出时间轴一起挪，聊天画面和配音全错位 ✗
  inputs.push('-ss', String(l2dMeta.trimStart), '-i', l2dMeta.video);
  const cc = l2dMeta.crop;
  const bb = l2dBbox.cropEven;
  const chain = `crop=${cc.w}:${cc.h}:${cc.x}:${cc.y},crop=${bb.w}:${bb.h}:${bb.x}:${bb.y}`;
  if (L2D_BOXED) {
    // 退路（用户允许）：绿幕抠不干净时，直接带框放进去
    filter.push(
      `[2:v]${chain},scale=-2:${L2D_H}:flags=lanczos,setsar=1,` +
      `pad=iw+18:ih+18:9:9:color=0x1b2430,` +
      `drawbox=x=0:y=0:w=iw:h=ih:color=0x6f9bd1:t=5[av]`
    );
  } else {
    // chromakey 的 similarity 要给余量（视频压缩后边缘不是精确 00FF00）
    // ⚠️ 光靠 chromakey 抠不干净**头发丝**：抗锯齿 + VP9 压缩后的半绿边缘会剩一圈绿边
    //   （用户 2026-10-21：「祥子头发还有点绿边」）
    // ⇒ 再接一步 geq「去绿溢」：把绿分量压到不超过 R/B 的较大值。
    //    只动**偏绿**的像素 ⇒ 祥子的青蓝头发（b>g）、白衬衫（r≈g≈b）、皮肤（r>g>b）都不受影响 ✓
    //    ⚠️ geq 必须在 `format=rgba` 之后，否则 r()/g()/b() 拿到的是 YUV 分量，语义全错
    // 去绿溢的方案（2026-10-21 实测三档出来定的）：
    //   ① `geq` 逐像素压绿 —— 效果最好但**极慢**（34 秒视频吃掉 4.5 分钟，5 秒片段 39.3 秒）
    //   ② `colorchannelmixer` 线性压绿 —— 快（2.2 秒）但**会把白衬衫/皮肤染成紫红** ✗ 不能用
    //   ③ ✅ **把 chromakey 的相似度提到 0.35 + 过渡 0.15** —— 绿边直接被抠掉，
    //      白衬衫和青蓝头发都不受影响，而且**零额外成本**（实测最干净的一档；0.45 会把头发抠成半透明）
    //   `--despill-geq` 保留 geq 作最后退路（换模型色偏严重时再用）
    const CK = '0x00FF00:0.35:0.15';
    const despill = argv.includes('--despill-geq')
      ? `,geq=r='r(X,Y)':g='min(g(X,Y),max(r(X,Y),b(X,Y)))':b='b(X,Y)':a='alpha(X,Y)'`
      : '';
    filter.push(
      `[2:v]${chain},chromakey=${CK},format=rgba${despill},` +
      `scale=-2:${L2D_H}:flags=lanczos,setsar=1[av]`
    );
  }
  hasAvatar = true;
} else if (tachiePath) {
  inputs.push('-i', tachiePath);
  filter.push(`[2:v]scale=-2:620:flags=lanczos,setsar=1[av]`);
  hasAvatar = true;
}

// ⚠️ 片头输入必须加在**人物之后** —— 上面绿幕那段把人物写死成 `[2:v]`，
//    片头插到它前面会让编号整体后移，人物就指到别的东西上了 ✗
let introIdx = -1;
let introRunSec = 0;
if (introDir) {
  introIdx = inputs.filter((x) => x === '-i').length;
  inputs.push('-framerate', String(INTRO_FPS), '-i', join(introDir, 'intro_%05d.png'));
  // 按**实际帧数**算它有多长（AE 的 saveFrameToPng 偶尔少渲几帧，写死 3 秒会露馅）
  introRunSec = Math.min(INTRO_SEC, introPngs.length / INTRO_FPS);
  say(`片头：${introPngs.length} 帧 @${INTRO_FPS}fps → 叠前 ${introRunSec.toFixed(2)} 秒（输入 #${introIdx}）`);
}

// ⚠️ 不要顶部那条 "Saki" 标题栏（用户 2026-10-20：「有点意义不明」）
filter.push(`[0:v]scale=-2:${PANEL_H}:flags=lanczos,setsar=1,pad=${W}:${H}:(ow-iw)/2:0:color=0x0a0d11[bg]`);
if (hasAvatar) {
  // 呼吸：3.4s 一个周期（真人呼吸 15~18 次/分）
  // 半身人物：底部齐着面板底边（像 C 位主播站在画面外），只露上半身
  // ⚠️ 别让它出画：`W-w+30` 会把右侧头发切掉（实测很突兀）⇒ 留 8px 边距
  filter.push(
    `[bg][av]overlay=W-w-8:${PANEL_H}-h+4*sin(2*PI*t/3.4):eval=frame[withch]`,
    `[withch]${subChain}${introIdx >= 0 ? '[vsub]' : '[v]'}`,
  );
} else {
  filter.push(`[bg]${subChain}${introIdx >= 0 ? '[vsub]' : '[v]'}`);
}
// 片头叠在**最上层**（连字幕一起盖住）：前 N 秒是标题卡，之后自动消失 ✓
if (introIdx >= 0) {
  filter.push(
    `[${introIdx}:v]format=rgba,scale=${W}:${H}:flags=lanczos,setsar=1[iv]`,
    `[vsub][iv]overlay=0:0:enable='lt(t,${introRunSec.toFixed(2)})'[v]`,
  );
}
const filterStr = filter.join(';');
say(`字幕 drawtext 条数：${(subFilters.match(/drawtext=/g) || []).length}；前 160 字：${subFilters.slice(0, 160)}`);
say('滤镜链：' + filterStr.slice(0, 400));
const inputs2 = [...inputs,
  '-filter_complex', filter.join(';'), '-map', '[v]', '-map', '1:a',
  '-t', totalDur.toFixed(2),
  '-r', String(FPS_OUT),
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', OUT,
];
// ⚠️ 故意不加 `-shortest`：它以**最短流**结束，聊天录屏比配音短一点就会把最后一句话切掉 ✗
//    时长统一由 `-t totalDur` 决定，短的那条流由 tpad 克隆末帧补齐 ✓
const r = spawnSync(FFMPEG, inputs2, { encoding: 'utf8', timeout: 25 * 60 * 1000 });

if (r.status !== 0 || !existsSync(OUT)) {
  {
    const lines = String(r.stderr || '').split('\n').filter((l) => l.trim());
    const bad = lines.filter((l) => /error|Error|Invalid|No such|Unable|failed|not found|undefined/i.test(l));
    say(`❌ 合成失败（exit ${r.status}）`);
    say('   可疑行：' + (bad.slice(0, 8).join(' ⏎ ') || '（没有明显错误行）'));
    say('   最后 6 行：' + lines.slice(-6).join(' | '));
  }
  process.exit(3);
}
say(`✅ 成片：${OUT}`);
say(`   ${(readFileSync(OUT).length / 1024 / 1024).toFixed(2)} MB / ${totalDur.toFixed(1)} 秒`);
try { rmSync(work, { recursive: true, force: true }); } catch {}