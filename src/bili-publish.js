/**
 * B站**全自动投稿**（2026-10-22 用户定，A 档 = 生成 + 直接发布）
 *
 * ## 用户原话（这一版就是照着这些改的）
 *   「A，设置一个时间段，每天随机在这段时间制作发送。**由 agent 来做视频、封面、简介全部 agent 完成**。
 *     群里有趣事就发送群里有趣的聊天内容，类型就和刚才做的那个一样，如果没有就自己搜寻
 *     设置好的题材制作视频，如果连续两天都是群里的内容，下一天就必须自己制作题材视频。
 *     然后和手动转发视频一样也加一个自定义输入题材然后制作视频发送的选项。
 *     在功能卡片里新增一个 b 站投稿设置页，所有设置都放在里面」
 *   「加一个，每条视频都要有 live2d 和 saki 自己的台词和语音」
 *   「**改一下，题材不是定死的，分区也不是定死的**，而是输入和 b 站分享的那些标签一样**划定范围**就可以了，
 *     **由 agent 自己搜寻当下比较火的题材创作并自己选好分区**，**只有分享群内趣事这个题材是定死的**，
 *     脚本也是之前写好的，**但是时长也是由 agent 自己决定的**」
 *   「**不是交给模型，是直接交给做视频的 agent，全部统一一起搞**」
 *
 * ## 所以这个文件**只做四件事**（⚠️ 一行内容判断都不许往这里加）
 *   ① **什么时候做**：每天在 `windowStart~windowEnd` 里随机挑一个时刻，一天只做一次
 *   ② **把活整个交给"做视频的 agent"** —— 一段任务说明 + `runTask()`，
 *      题材 / 时长 / 分区 / 台词 / 语音 / 动作 / 群聊挑哪几条 / 封面 / 标题 / 简介 / 上传，
 *      **全部由那个 agent 一条龙干完**（它的作业手册：`docs/bili-agent手册.md`）
 *   ③ **事后硬校验**：Live2D 录像在不在、配音有没有 ≥4 段、成片是不是空文件 ——
 *      不合格就当失败（用户要求「每条视频都要有 live2d 和 saki 自己的台词和语音」）
 *   ④ **记账 + 通知主人**：成功失败都发一条私聊（全自动最怕"挂了没人知道"）
 *
 * ## ⚠️⚠️ 为什么这里**不再调模型**
 *   2026-10-22 之前这一版是"脚本里塞几个 LLM 调用"（自己定题材、自己写台词）。
 *   用户否掉了：「不是交给模型，是直接交给做视频的 agent，全部统一一起搞」——
 *   因为选题要**联网看当下什么在火**、台词要跟**动作/群聊画面**配得上、
 *   标题简介要跟**封面**配得上，这些是一件事，拆成几个独立的小调用反而各说各话 ✗
 *   ⇒ 现在只有**一个** agent 从头干到尾，它自己决定中间每一步 ✓
 *
 * ## ⚠️ 唯一定死的题材
 *   「分享群内趣事」—— 这条走**之前写好的那套流程**（群聊内容当画面底部滚动），
 *   不用 agent 重新发明。是否走这条由 **agent 自己判断**（`streakGroup` 规则由这里告诉它）。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync, rmSync } from 'node:fs';
// ⚠️ 2026-10-21：抓 BV 号要跑子进程（见 grabBvid）
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import yaml from 'js-yaml';
import { config, ROOT, stateDir, CONFIG_FILE, personaId } from './config.js';
import { log } from './log.js';
import { runTask, busyTask } from './agent-bridge.js';
// ⚠️ 2026-10-22：短期共享记忆（发了视频要记一笔，她聊天和 B站回复都读它）
import * as shortMemory from './short-memory.js';
/* ⚠️ 2026-10-22 加：B 站这边的人设段改成**读人设包**（见 `voiceBlock()`）——
 *    `persona.js` 只依赖 config/log，不会和这里形成循环 ✓ */
import * as persona from './persona.js';

const TOOLS = join(ROOT, 'tools');
const OUT_DIR = join(ROOT, 'logs', 'bili', 'auto');
const MANUAL = join(ROOT, 'docs', 'bili-agent手册.md');
/** 给做视频那个 agent 的时间上限（配音 2 分 + 出片 3 分 + 上传 2 分 + 余量） */
const AGENT_TIMEOUT_MS = 45 * 60 * 1000;

/** 配置（config.yml 的 `biliPublish` 段；界面「B站投稿设置」页写的也是它） */
export function settings() {
  const c = config.biliPublish || {};
  return {
    enable: c.enable === true,
    windowStart: String(c.windowStart || '20:00'),
    windowEnd: String(c.windowEnd || '23:00'),
    group: String(c.group || ''),
    /** ⚠️ 题材**不是**清单，这里只是"她能聊的范围"（用户 2026-10-22 改口） */
    scope: Array.isArray(c.scope) && c.scope.length
      ? c.scope.map(String).filter(Boolean)
      : ['AI', '二次元', '游戏服务器 / MC', '日常吐槽', '打工 / 兼职'],
    /** 时长由 agent 定；这里只有上限（下限 20 秒写死） */
    durationMax: Math.max(25, Math.min(120, Number(c.durationMax) || 60)),
    /** 兜底分区（agent 自己挑；它挑的名字不在清单里时才用这个） */
    zone: String(c.zone || '生活'),
    zone2: String(c.zone2 || '日常'),
    tags: Array.isArray(c.tags) ? c.tags : ['AI', '日常', 'vlog'],
    groupMaxStreak: Math.max(1, Number(c.groupMaxStreak) || 2),
    notifyOwner: c.notifyOwner !== false,
  };
}

/* ── 状态（一天只跑一次、连续群聊天数、历史记录） ── */
const statePath = () => join(stateDir(), 'bili-publish.json');
export function loadState() {
  try {
    const j = JSON.parse(readFileSync(statePath(), 'utf8'));
    return {
      lastDay: '', nextAt: 0, streakGroup: 0, done: {}, history: [], usedTopics: [],
      /** 指定某天直接发**现成文件**（用户 2026-10-22：「明天投稿的视频先定为今天做的桌面上那个」）
       *  形如 `{ day: '2026-10-22', video: 'E:\\Desktop\\xxx.mp4', note: '' }` */
      queued: null,
      running: false, ...j,
    };
  } catch {
    return {
      lastDay: '', nextAt: 0, streakGroup: 0, done: {}, history: [], usedTopics: [],
      queued: null, running: false,
    };
  }
}
function saveState(s) {
  try {
    mkdirSync(dirname(statePath()), { recursive: true });
    // ⚠️ 必须用 Node 写（PowerShell 的 utf8 会带 BOM ⇒ JSON.parse 直接崩）
    writeFileSync(statePath(), JSON.stringify(s, null, 2), 'utf8');
  } catch (e) { log.warn(`[B站投稿] 存状态失败：${e.message}`); }
}

const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const hhmm = (s) => {
  const m = String(s).match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** 在窗口内挑一个随机时刻（同一天只挑一次，存进状态） */
/* ── 抓这条稿件的 BV 号（用户要「显示出来发送的视频链接」） ──
 * ⚠️ 2026-10-21 探路结论：
 *   · agent 的回执里**没有 bvid**（它只报"投递成功"）
 *   · 稿件管理页 `member.bilibili.com/platform/upload-manager/article` 的 BV
 *     **只藏在封面那个 `<a href="//www.bilibili.com/video/BV…/">` 里**，页面上看不到那串字 ✗
 *   · 列表按时间倒序 ⇒ **第一张卡片就是刚发的那条** ✓
 *   ⚠️ 要独占 `state/bili-profile`：调用点在上传 agent 退出之后（那时它已经放开了）✓
 */
async function grabBvid() {
  const script = join(ROOT, 'tools', 'bili-latest-bvid.mjs');
  if (!existsSync(script)) return null;
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [script], { cwd: ROOT, windowsHide: true });
    let so = '';
    const timer = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } }, 120000);
    p.stdout.on('data', (d) => { so += String(d); });
    p.on('close', () => { clearTimeout(timer); resolve(so); });
    p.on('error', () => { clearTimeout(timer); resolve(so); });
  });
  for (const line of String(out).trim().split(/\r?\n/).reverse()) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try { return JSON.parse(s); } catch { /* 不是回执 */ }
  }
  return null;
}

/* ── 每天 12:00 清视频缓存（2026-10-21 用户要求） ──
 *
 * ## 用户原话（两次）
 *   ① 「**所有视频缓存要在12点清除**」
 *   ② 「**也不是只删缓存，用不上和已经投上的视频也删了**」
 *      ⇒ 第一版只清 `__*` / `_run_*.log` 太窄了 ✗
 *      ⇒ **已经投到 B站 的成片、以及没派上用场的迭代品，本地一律不用留** ✓
 *        （投过的已经在 B站 上；`history` 里照样留着标题/链接/台词，只是本地文件没了）
 *
 * ## 为什么定 12 点
 *   投稿窗口是 16:00~20:00 ⇒ 12 点清的时候当天还没开始做，删不到正在用的东西 ✓
 *
 * ## 清 / 不清（就这两条）
 *   ✅ 清（超过 1 天的）：
 *      · `logs/bili/` 下**所有**视频/图片/音频文件（mp4/webm/mov/wav/m4a/mp3/png/jpg）
 *      · `logs/bili/auto/<时间戳>/` 整个工作目录
 *      · 顶层的调试残留：`__*`、`_run_*.log`
 *      · 迭代工作目录：`*_work-*`、`__*` 目录
 *   🚫 不清（这些是**素材**，删了要重新下载/生成）：
 *      `avatars` `chrome` `group-voice` `l2dcache` `tachie` `voice-ref` `qqrec`
 *      `pick` `say` `say2` `l2d_take` `intro_take` `intro_voice` `intro_voice_fit`
 *   ⚠️ 还有：**24 小时以内的一律不动**（可能还要用 / 正在跑）
 */

/** 这些子目录是**素材**，不按日期删（删了要重新下/重新生成，代价比空间大） */
const KEEP_DIRS = new Set([
  'avatars', 'chrome', 'group-voice', 'l2dcache', 'tachie', 'voice-ref', 'qqrec',
  'pick', 'say', 'say2', 'l2d_take', 'intro_take', 'intro_voice', 'intro_voice_fit',
]);

/** 会占地方的媒体后缀 */
const MEDIA_RE = /\.(mp4|mov|webm|wav|m4a|mp3|png|jpg|jpeg)$/i;

export function sweepCache({ force = false } = {}) {
  const base = join(ROOT, 'logs', 'bili');
  if (!existsSync(base)) return { ok: true, removed: 0, freedMB: 0, why: '没有 logs/bili' };

  const cutoff = Date.now() - 24 * 3600 * 1000;
  let removed = 0;
  let freed = 0;

  const rmDir = (p) => {
    let size = 0;
    try {
      for (const f of readdirSync(p, { withFileTypes: true })) {
        const q = join(p, f.name);
        if (f.isDirectory()) size += rmDir(q);
        else { try { size += statSync(q).size; rmSync(q, { force: true }); } catch { /* 占着就跳过 */ } }
      }
      rmSync(p, { recursive: true, force: true });
    } catch { /* ignore */ }
    return size;
  };

  /* ① auto/ 下**所有**工作目录（超过 1 天的整个删，不看有没有投过 —— 用户明确要求） */
  const auto = join(base, 'auto');
  if (existsSync(auto)) {
    for (const f of readdirSync(auto, { withFileTypes: true })) {
      if (!f.isDirectory()) continue;
      const p = join(auto, f.name);
      let mt = 0;
      try { mt = statSync(p).mtimeMs; } catch { continue; }
      if (!force && mt > cutoff) continue;
      freed += rmDir(p);
      removed++;
    }
  }

  /* ② 其他**迭代目录**（`*_work-*` / `__*`）；素材目录走白名单跳过 */
  for (const f of readdirSync(base, { withFileTypes: true })) {
    if (!f.isDirectory()) continue;
    if (f.name === 'auto') continue;                 // 上面处理过了
    if (KEEP_DIRS.has(f.name)) continue;             // 素材，别动
    // 只认"明显是跑批留下的"目录；不认识的不碰（宁可占地方）
    if (!/^__/.test(f.name) && !/_work-/.test(f.name)) continue;
    const p = join(base, f.name);
    let mt = 0;
    try { mt = statSync(p).mtimeMs; } catch { continue; }
    if (!force && mt > cutoff) continue;
    freed += rmDir(p);
    removed++;
  }

  /* ③ 顶层**所有媒体文件**（mp4/webm/wav/png/jpg…）—— 投过的也删 */
  for (const f of readdirSync(base, { withFileTypes: true })) {
    if (!f.isFile()) continue;
    const isMedia = MEDIA_RE.test(f.name);
    const isLog = /^_run_.*\.log$/i.test(f.name) || /^__/.test(f.name);
    if (!isMedia && !isLog) continue;               // .json / .md / .txt 这些记录留着
    const p = join(base, f.name);
    let mt = 0; let sz = 0;
    try { mt = statSync(p).mtimeMs; sz = statSync(p).size; } catch { continue; }
    if (!force && mt > cutoff) continue;
    try { rmSync(p, { force: true }); removed++; freed += sz; } catch { /* ignore */ }
  }

  const freedMB = Math.round((freed / 1024 / 1024) * 10) / 10;
  if (removed) log.info(`[B站投稿] 清了视频缓存：${removed} 项，释放 ${freedMB} MB`);
  return { ok: true, removed, freedMB };
}

/** 每天 12:00 之后跑一次（自己按天去重，重启也不会重复跑） */
export function sweepTick() {
  const st = loadState();
  const day = new Date().toLocaleDateString('zh-CN');
  const now = new Date();
  if (now.getHours() < 12) return;                       // 还没到 12 点
  if (st.lastSweepDay === day) return;                    // 今天清过了
  saveState({ ...st, lastSweepDay: day });
  try { sweepCache(); } catch (e) { log.warn(`[B站投稿] 清缓存失败：${e.message}`); }
}

function planFor(day) {
  const st = loadState();
  if (st.nextAt && st.lastDay === day) return st.nextAt;
  const c = settings();
  const a = hhmm(c.windowStart) ?? 1200; // 20:00
  const b = hhmm(c.windowEnd) ?? 1380;   // 23:00
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const at = lo + Math.floor(Math.random() * Math.max(1, hi - lo));
  const d = new Date();
  d.setHours(Math.floor(at / 60), at % 60, Math.floor(Math.random() * 60), 0);
  const ts = d.getTime();
  saveState({ ...st, lastDay: day, nextAt: ts });
  log.info(`[B站投稿] 今天（${day}）的发布时间定在 ${d.toLocaleTimeString('zh-CN', { hour12: false })}`);
  return ts;
}

/* ── 给主人发通知（全自动最怕"挂了没人知道"） ── */
async function notify(text) {
  const c = settings();
  if (!c.notifyOwner) return;
  try {
    const cfgRaw = yaml.load(readFileSync(CONFIG_FILE, 'utf8')) || {};
    const ob = cfgRaw.onebot || {};
    const url = String(process.env.QQBOT_URL || ob.url || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const token = String(process.env.QQBOT_TOKEN || ob.token || '');
    const owner = String(cfgRaw.ownerQQ || '');
    if (!owner) return;
    await fetch(`${url}/send_private_msg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ user_id: Number(owner), message: text }),
    });
  } catch (e) { log.warn(`[B站投稿] 通知发不出去：${e.message}`); }
}

/**
 * B站**现在的真实分区清单**（2026-10-22 用 `bili-upload.mjs --dump-zones` 真机抓的）
 *
 * ⚠️⚠️ 别再照老结构写了 —— B站改过版：
 *   · 老清单里「生活 / 日常」「游戏 / 网络游戏」那套**二级结构已经没了**
 *   · 现在就是 **30 个平铺的一级分区**，没有二级 ⇒ `--zone2` 传了也没用
 *   · 实测老清单里的名字**一个都点不到** ⇒ 每条视频都落到默认区（vlog）✗
 * 抓法（以后 B站再改版就重跑一次）：
 *   `node tools/bili-upload.mjs --video <小视频> --title x --dump-zones`
 *   ⇒ 打一行 ZONES_JSON，照着更新这里
 */
const ZONE_LIST = [
  '娱乐', '影视', '音乐', '舞蹈', '动画', '绘画', '鬼畜', '游戏', '资讯', '知识',
  '人工智能', '科技数码', '汽车', '时尚美妆', '家装房产', '户外潮流', '健身',
  '体育运动', '手工', '美食', '小剧场', '旅游出行', '三农', '动物', '亲子',
  '健康', '情感', 'vlog', '生活兴趣', '生活经验',
];
const zoneListText = () => ZONE_LIST.join('、');

/**
 * 她自己的「声音」—— **直接注入任务说明**，不指望 agent 自己翻人设翻到
 *
 * ⚠️⚠️ 2026-10-22 用户反馈：「台词导入了 saki 的人设吗？感觉**活人感还不够强**，
 *   **可以玩一些自己的梗，但是不要过于频繁**」
 *   上一版只是写了句"先读 personas/saki/persona.md"，等于让 agent 自己去 100KB 的人设里
 *   找语气 —— 实际挑出来的是"观点正确但谁都能说"的句子，活人感就是从这里漏的 ✗
 *   ⇒ 现在把**最能体现她是谁**的那几样直接摆到眼前（口癖、能吃、怪力、做饭、名台词、黑祥），
 *     并明确「梗一条视频最多 1~2 处」。
 *
 * 📌 这份是**从 `personas/saki/persona.md` 里摘的**（L479 口癖「倒」/ L301-305 活细节 /
 *    L197 名台词归属 / L311-319 黑祥）。人设那边改了，这里要跟着改。
 *    ⚠️ 别把整段人设抄进来 —— 那是 100KB，会把它淹掉，反而更不像。
 */
/**
 * **B 站这边要用的"人设那一小段"**（评论回复 / 视频文案 / 投稿说明都用它）。
 *
 * ## ⚠️⚠️⚠️ 2026-10-22 改（用户：「**b站那边评论要用到的人设在新建时也要完善好，
 *    和 QQ 这边一样，之前我说过的机器人味不能出现**」）
 *
 * 原来这里是**写死的一段祥子腔**（下面那个 `SAKI_VOICE`）—— 好处是稳，坏处是
 * **新建一个人设、B 站这边还是祥子**：换号、换角色之后评论照样是「倒」「黑祥」
 * 那一套，等于人设白建了 ✗
 *
 * ⇒ 现在改成**读人设包**：`personas/<当前人设>/prompt/bili-comment.md`
 *   （和 `prompt/qzone-guide.md` 同一个机制，`persona.promptFile()` 读，
 *     **每次现读盘** ⇒ 改完不用重启，换人设立刻生效 ✓）
 *
 * ⚠️ 为什么不直接把整份 `persona.md` 塞进来：那是 **107 KB / 4.6 万字**，
 *    塞进这种"回一句 8~30 字的评论"的提示词里会**把它淹掉**，反而更像机器人 ✗
 *    （老版这里就写着这句话，是对的 —— 所以走"人设包里的**精简版**"这条路）
 * ⚠️ 读不到就**回落**下面那份内置的（老配置 / 没写这个文件的人设包照常能跑），
 *    同时打一行 warn —— 别静默，不然"新建的人设没生效"根本查不出来 ✓
 */
export function voiceBlock() {
  try {
    const t = persona.promptFile('bili-comment');
    if (t && t.trim()) return t.trim();
  } catch { /* ignore */ }
  log.warn(
    `[B站] 人设包里没有 prompt/bili-comment.md（${persona.charName?.() || '?'}）` +
      ' ⇒ B站这边临时用内置的那份（新建人设时记得补上这个文件）',
  );
  return SAKI_VOICE;
}

export const SAKI_VOICE = [
  '【你是谁，怎么说】',
  '· 自称 **Saki**。别人叫你小祥 / 客服小祥 / 祥子，都照常应答，**别纠正称呼**。',
  '· 有点傲娇、话短、自然。**绝不客服腔**（不要「您好」「请查收」「为您统计」）。',
  '· 口癖是「**倒**」（倒是 / 我倒觉得）—— 一条视频里**最多用 1~2 次**，多了就成复读。',
  '',
  '【你身上那些"活人"的地方（一条视频挑一两样用，别全塞）】',
  '· **你是真的能吃**，也真的力气不小（155cm，但别把自己写得娇弱）。',
  '· 家道中落后自己做饭、自己打扫 —— 提起过日子的事，说得具体点（米、锅、碟子、账单）。',
  '· 「**黑祥**」是另一条路上的你，**同一个人、同一个家**（她要是不提，你也别主动提）。',
  '· 名台词「**请把你剩余的人生交给我**」是**你自己说的** —— 别人翻出来就认下（或嘴硬不认），',
  '  🚫 别说成"这是某某说的"（那是把自己的东西往外推）。',
  '· 你自己那半边生活**可以编**（住哪、这会儿在干什么、为什么去不了），越具体越像活人；',
  '  🚫 但已经被写死的事实（服务器数据、群里的名单、别人的真实身份）一个字都不许编。',
  '',
  '【玩梗的规矩（用户 2026-10-22 定）】',
  '· **可以玩，但要克制**：一条视频**最多 1~2 处**，而且必须**自然长在话里**。',
  '· 玩什么：上面"你自己的"那几样（能吃 / 力气 / 做饭 / 傲娇 / 名台词 / 黑祥），一次只碰一样。',
  '· 🚫 别把整条片子做成梗合集；🚫 **别解释梗**（一解释就不好笑了）；',
  '  🚫 别硬拐一个弯去玩梗（观众听得出你在凑）。',
  '· 🚫 圈外热梗、谐音梗少碰 —— 观众不认识就冷场。',
  '',
  '【活人感的硬检验（写完自己过一遍）】',
  '1. 把每句里的"我"换成别人，**还说得通吗**？说得通 ⇒ 这句没她的人味，重写。',
  '2. 每句里**至少有一处具体的东西**：时间、手上的活、天气、身体感觉、某个具体的人或物。',
  '   🚫 全篇都是"其实/我觉得/所以说"这种抽象句，听着就像念稿。',
  '3. 允许不完美：可以有停顿、改口、自嘲、「算了」、「行吧」—— 真人说话不是每句都有结论。',
].join('\n');

/**
 * 组这段任务说明 —— **这是这个文件里唯一"给内容定方向"的地方**，而且只给方向和边界，
 * 具体选什么题材、多长、发哪个分区、说什么话，全部由 agent 自己定 ✓
 */
function buildPrompt({ workDir, topic, publish, streak, reuse }) {
  const c = settings();
  const group = c.group || '200000001';

  /* ── ① 复用现成视频（用户指定"明天就发这条"）──────────────────────
   * 用户 2026-10-22：「明天投稿的视频先定为今天做的桌面上那个」
   * ⇒ 这种日子**不做出片**，只写标题/简介/封面/选分区 + 上传。
   *   ⚠️ 也别让它"顺手优化一下"（转码/裁剪会掉画质，而且用户要的就是这条）✗
   */
  if (reuse) {
    return [
      '# 今天的活：把一条**已经做好的**视频发到 B 站（全自动，没人盯）',
      '',
      '## 零、先说清楚：**今天不做视频**',
      `用户已经指定了成品（2026-10-22 定的），直接用它：\`${reuse.video}\``,
      '⚠️ **原样上传**：不要重做、不要转码、不要裁剪、不要重新配音 —— 用户要的就是这个文件 ✗',
      '',
      `⚠️ 你的作业手册（要看的是"上传 + 自检"那几节，以及踩过的坑）：\`${MANUAL}\``,
      '',
      '## 一、你要做的四件事',
      '1. **标题 / 简介 / 标签** —— 必须是她自己的人设（简介也要有人味，不是文案）：',
      '   她是' + (persona.charName() || '这个角色') + '（自称 ' + (persona.selfName() || '我') + '），在一个 MC 服务器的 QQ 群里兼职当客服；短句、不客套、不客服腔',
      '   ⚠️ 简介**别写"这是旧视频 / 复用的"** 这种话，就当今天发的；',
      '   也别写成"XX 来了！关注我了解更多"那种营销腔 ✗',
      '   想更贴她的口气可以看下面这段（这条不用写台词，只用它来定语气）：',
      voiceBlock(),
      '',
      '2. **分区** —— 从下面清单里挑**最贴内容的那一个**（B站现在是平铺的一级分区，没有二级），名字要一字不差：',
      zoneListText(),
      `   （拿不准就用「${c.zone}」）`,
      '   ⚠️⚠️ **这份清单可能过时**（B站改过分区）—— **以页面上真弹出来的分区为准**：',
      '   清单里没有的名字，就用页面上最贴近的那个，并把它**真实的名字**写进 result.json 的 zone ✓',
      '   （2026-10-22 实测：清单里的「生活/日常」已经没了，实际是 vlog）',
      `3. **封面** —— 从这条视频里截一帧 + 标题字 → \`${join(workDir, 'cover.jpg')}\``,
      '   ⚠️ `drawbox` 的 `t=fill` 在本机 ffmpeg 3.0.1 上不认 ⇒ 用 `t=<高度>`',
      '4. **上传**：',
      '   ```',
      `   node "${join(TOOLS, 'bili-upload.mjs')}" --video "${reuse.video}" \\`,
      '     --title "…" --desc "…" --zone "<分区名>" --tags "…" \\',
      `     --cover "${join(workDir, 'cover.jpg')}"${publish ? ' --publish' : ''}`,
      '   ```',
      publish ? '   （**--publish = 直接发出去**，今天这条是要真发的）' : '   （今天只填表、别点发布）',
      '',
      '## 二、干完必须写这个文件（脚本靠它记账和校验）',
      `\`${join(workDir, 'result.json')}\`：`,
      '```json',
      '{"ok":true,"source":"reuse","topic":"这条讲什么","title":"B站标题","desc":"简介",',
      ' "tags":["…"],"zone":"vlog","duration":34,',
      ` "video":"${reuse.video.replace(/\\/g, '\\\\')}","cover":"<封面绝对路径>","uploaded":true,"note":"…"}`,
      '```',
      '⚠️ 失败也要写，`ok` 设 false 并在 `note` 里写清卡在哪一步。',
      '',
      '## 三、禁止事项',
      '- 🚫 不许往任何 QQ 群/私聊发消息（这是全自动的，你只在机器上干活）',
      `- 🚫 不许动那个成品文件本身（只读它）`,
      '',
      '## 四、今天的状态',
      `- 日期：${dayKey()}`,
      `- 你的工作目录（产物都放这儿）：\`${workDir}\``,
      reuse.note ? `- 用户的备注：${reuse.note}` : '',
      '',
      '干完之后 stdout 只回一句人话：发了什么、标题是什么、发没发出去。',
    ].filter((x) => x !== '').join('\n');
  }

  return [
    '# 今天的活：做一条 B 站短视频并发上去（全自动，没人会在旁边盯）',
    '',
    `⚠️⚠️ **先完整读一遍你的作业手册**：\`${MANUAL}\``,
    '里面是全部流程、固定设定、六步管线、自检清单和踩过的坑。**照它做，别自己另发明一套**。',
    '',
    '## 一、这条视频要满足的硬要求（用户定的，不可变通）',
    '1. **必须有你的 Live2D 形象**（半身、会张嘴对口型、有手部/头部动作）—— 没有这条不算成品 ✗',
    '2. **台词全部是你自己说的话**（第一人称），并且**配成真人语音**（IndexTTS），不是字幕、不是旁白',
    '3. **竖屏 1080×1920**，字幕大、居中',
    '4. **不碰政治、真人隐私、骂战、低俗**',
    '5. ⚠️⚠️ **台词必须是她自己的人设**（用户 2026-10-22 特意补的）：',
    voiceBlock(),
    '',
    '   ⚠️ 下面是给你**深挖**用的资料（要更细的语气就去读，别指望全部塞进提示词）：',
    `   \`personas/${personaId()}/persona.md\`（说话方式 / 名台词归属 / 活细节）、\`knowledge/memes.md\`（接梗用，`,
    '   那是"听懂别人在玩什么梗"，**不等于你可以拿来当自己的梗**）。',
    '   尤其**自制题材**那种最容易写成"科普 / 讲解 / 人生感悟"——那是任何人套上都能说的废话 ✗',
    '',
    '## 二、题材（用户 2026-10-22 改口，别做错）',
    '⚠️ **题材不是定死的**。你只能在这个**范围**里选：',
    ...c.scope.map((s) => `  · ${s}`),
    '',
    '怎么选：',
    '- **自己去搜"当下在火什么"** —— B 站热门榜 / 搜索联想词 / 各方向的真实视频播放量',
    '  （工具：`node "' + TOOLS + '\\bili.mjs" hot` 拿热门榜；`search 关键词` 搜视频；',
    '   `tools/bili-upload.mjs` 旁边的 `src/search.js` 里也有接口，用现成命令最快）',
    '- 从里面挑一个**跟你的身份对得上**的角度：你是在一个 MC 服务器 QQ 群里兼职当客服的祥子，',
    '  平时帮人查东西、写东西，自己也做视频 —— 讲"这个话题你能讲、别人讲不出的东西"',
    '- 🚫 别照抄别人的热门视频，别做新闻搬运',
    '- 🚫 别跟你最近做过的重复（下面"最近做过"里列了）',
    '',
    '**唯一定死的题材是「分享群内趣事」**：',
    `- 群号 \`${group}\`，消息在 \`${join(ROOT, 'state', 'recent.json')}\` 里`,
    '- 群里真有事发生（谁在折腾什么、互相吐槽、聊了个好玩的东西）⇒ 就做这个，',
    '  **用之前已经写好的那套流程**（群聊内容当画面底部滚动的背景），别重新发明',
    /* ⚠️⚠️ 2026-10-21 用户明确要求：「**如果群里没有足够符合条件的聊天记录，
     *   应该直接自己制作视频**」
     *   ⇒ 这里给出**可执行的标准**（不是"感觉不够"），让 agent 一眼能判断：
     *     条数不够 / 全是碎话 / 凑不出能讲 20 秒的事 ⇒ **直接转自制，别硬凑** ✗
     *   ⚠️ 硬凑出来的视频一眼就是凑的（拿"在吗""哈哈哈"拼一条），比不发还伤号 ✓ */
    '- ⚠️⚠️ **素材不够就直接做自制题材，别硬凑**（用户 2026-10-21 定的）：',
    '  · 今天群消息**少于 30 条**，或者**全是**「在吗」「哈哈哈」「草」「+1」这种碎话 / 复读 / 表情；',
    '  · 或者翻来翻去**凑不出一件能讲 20 秒以上的事**（谁在做什么、后来怎样了）；',
    '  ⇒ 只要中一条，**立刻改走上面"自己找题材"**，别拿碎话硬拼一条出来 ✗',
    '  （判据看内容本身，别只看条数 —— 30 条全是"草"也是不够）',
    streak.forced
      ? `- ⚠️⚠️ **今天必须做自制题材**（不是群聊）：已经连续 ${streak.group} 天用的是群聊内容，用户明确要求隔一天必须自制 ✗`
      : (streak.group ? `- （目前连续 ${streak.group} 天用了群聊内容；到 ${c.groupMaxStreak} 天就必须改自制）` : ''),
    '',
    '## 三、时长和分区也由你自己定',
    `- **时长**：按内容实际需要定，**20~${c.durationMax} 秒之间**。别为凑时长灌水，也别硬压。`,
    '  ⚠️ 手册里那条「**先定时长，再压配音**」照旧 —— 定了多长，配音就用 `tools/fit-audio.mjs` 卡到多长',
    '- **分区**：从下面这份清单里挑**最贴内容的那一个**（B站现在是平铺的一级分区，**没有二级**），名字要**一字不差**（上传脚本按名字点）：',
    zoneListText(),
    `  （拿不准就用「${c.zone}」）`,
    '  ⚠️⚠️ **这份清单可能过时**（B站改过分区）——**以页面上真弹出来的分区为准**：',
    '  清单里没有的名字，就用页面上最贴近的那个，并把它**真实的名字**写进 result.json 的 zone ✓',
    '  （2026-10-22 实测：清单里的「生活/日常」已经没了，实际是 vlog）',
    '',
    '## 四、干活的顺序（一条龙，别中途停下等人）',
    `1. 定题材 / 时长 / 分区（读下面"今天的状态"和最近做过的东西）`,
    `2. 写台词 → \`${join(workDir, 'lines.json')}\`（格式照手册）`,
    '3. 出片：一条命令，别一步步手搓（`--auto` 会让管线自己把动作表和群聊记录排出来）',
    '   ```',
    `   node "${join(TOOLS, 'bili-pipeline.mjs')}" --group ${group} --lines "${join(workDir, 'lines.json')}" \\`,
    `     --voice "${join(workDir, 'voice')}" --duration <你定的秒数> --force-tts --auto \\`,
    `     --out "${join(workDir, 'video.mp4')}" --no-desktop`,
    '   ```',
    '   ⚠️ 动作表和群聊挑选是**你来做**：跑完 `--auto` 那个草稿后，**自己读一遍**',
    '   `logs/bili/actions.json` 和 `logs/bili/chat_picked.json`，不对就自己改（手册里有标准）',
    '   ⚠️⚠️ **群聊内容只留和台词相关的**（用户 2026-10-22：「大部分不相关的剔除，只留最多的相关的」）：',
    '   不相干的**整条删掉**，删到只剩真相关的（20 条也行、10 条也行）✗ 别为了凑时长留',
    '   ⚠️ **条数少不会难看** —— 挑少了就在这条命令上加 `--hold-ratio 0.8`（0~1），',
    '   画面滑到那个比例就**停住**，剩下的时间就停在最相关的那几句上（用户明确允许）✓',
    `4. 封面：从录屏截一帧 + 标题字 → \`${join(workDir, 'cover.jpg')}\``,
    '',
    '   ⚠️⚠️ **自制题材（不是群内趣事）必须加 AE 片头**（用户 2026-10-22：',
    '   「群里的趣事类不用变，**agent 自己搜集题材做的才要用上 ae**」）——',
    '   群聊那条**不要**加（它是纪实感，加了反而假）：',
    '   ```',
    `   node "${join(TOOLS, 'ae-intro.mjs')}" --line1 "<大标题 10 字内>" --line2 "<副标题 18 字内>" \\`,
    `     --out "${join(workDir, 'intro')}"`,
    '   ```',
    `   然后把 \`--intro "${join(workDir, 'intro')}"\` 传给**合成**那一步 —— 它会叠在**前 3 秒**，`,
    '   时间轴一个字都不动（不要自己 concat，那样口型/字幕全要重算）✓',
    '   ⚠️ AE 渲一次 1~3 分钟，也可能失败 ⇒ **别卡在这里**：失败就把原因写进 `result.json` 的 `note`，',
    '   没有片头照样发（片头是加分项，不是硬要求）✓',
    '',
    '5. 自检**必须过**（手册"步骤 6"）：抽帧看音画同步、看有没有张嘴、看片尾字幕有没有被裁',
    '6. 上传：',
    '   ```',
    `   node "${join(TOOLS, 'bili-upload.mjs')}" --video "${join(workDir, 'video.mp4')}" \\`,
    '     --title "…" --desc "…" --zone "<分区名>" --tags "…" \\',
    `     --cover "${join(workDir, 'cover.jpg')}"${publish ? ' --publish' : ''}`,
    '   ```',
    publish
      ? '   （**--publish = 直接发出去**，今天这条是要真发的）'
      : '   （今天是**手动试做**，别带 --publish，只把表单填好、别点发布）',
    '',
    '## 五、干完必须写这个文件（脚本靠它记账和校验，不写就当失败）',
    `\`${join(workDir, 'result.json')}\`：`,
    '```json',
    '{"ok":true,"source":"group|topic","topic":"今天这条讲什么","title":"B站标题",',
    ' "desc":"简介","tags":["…"],"zone":"vlog","duration":42,',
    ' "video":"<成片绝对路径>","cover":"<封面绝对路径>","uploaded":true,"note":"踩了什么坑/有什么要留意的"}',
    '```',
    '⚠️ 失败了也要写，把 `ok` 设成 false 并用 `note` 写清卡在哪一步（不要只在 stdout 里说）',
    '',
    '## 六、禁止事项',
    '- 🚫 **不许往任何 QQ 群/私聊发消息**（这条是全自动的，你只在机器上干活）',
    '- 🚫 不许把中间产物散落在工作区之外',
    '- 🚫 不许跳过 Live2D、不许用静音/占位配音糊过去',
    '',
    '## 七、今天的状态',
    `- 日期：${dayKey()}`,
    `- 你的工作目录（产物都放这儿）：\`${workDir}\``,
    topic ? `- ⚠️ **用户指定了题材**：${topic}（就用它，不用自己找）` : '- 题材：按上面第二节自己定',
    `- 最近做过的（别重复）：${(loadState().usedTopics || []).slice(-6).join(' / ') || '（还没有）'}`,
    '',
    '干完之后 stdout 只回一句人话：做了什么、多长、发没发出去。',
  ].join('\n');
}

/* ── 跑一单 ── */
let busy = false;
let currentKill = null;
export function isBusy() { return busy; }

/**
 * 立刻做一条（定时到点 / 界面手动触发）。
 * @param {{topic?:string, publish?:boolean}} opt
 */
export async function runOnce({ topic = '', publish = true } = {}) {
  if (busy) { log.warn('[B站投稿] 上一条还没跑完，跳过'); return { ok: false, why: 'busy' }; }

  // ⚠️ 做视频要跑十几分钟，会**独占** DSH agent（同时只跑一个活）。
  //    别的活正在干（群任务/私聊派活）⇒ 不抢，10 分钟后再看（tick 每 30 秒会再来）。
  const other = busyTask();
  if (other) {
    log.info(`[B站投稿] agent 正在干别的活（${String(other).slice(0, 24)}）⇒ 这一轮先不做`);
    return { ok: false, why: 'agent-busy' };
  }

  busy = true;
  const c = settings();
  const st = loadState();
  const day = dayKey();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const workDir = join(OUT_DIR, stamp);
  mkdirSync(workDir, { recursive: true });

  const streak = { group: Number(st.streakGroup) || 0, forced: (Number(st.streakGroup) || 0) >= c.groupMaxStreak };

  /* 用户指定了"今天直接发这个现成文件"（2026-10-22：「明天投稿的视频先定为今天做的桌面上那个」）
   * ⚠️ 只认**当天**那条：`queued.day` 对不上就当没有（免得以后哪天又把它发一遍）✗ */
  const q = st.queued;
  const reuse = q && String(q.day || '') === day && q.video && existsSync(String(q.video))
    ? { video: String(q.video), note: String(q.note || '') }
    : null;
  if (q && !reuse) log.info(`[B站投稿] 预设视频对不上今天（${q.day || '?'} / 文件${q.video ? '在' : '不在'}）⇒ 按平常做`);

  try {
    const prompt = buildPrompt({ workDir, topic: String(topic || '').slice(0, 200), publish, streak, reuse });
    writeFileSync(join(workDir, 'task.txt'), prompt, 'utf8');
    log.info(`[B站投稿] 把活交给做视频的 agent（工作目录 ${workDir}）${topic ? '｜指定题材：' + topic : ''}`);

    // ⚠️ `permission: danger-full-access`：它要写项目里的 logs/、跑 Playwright 上传 B 站、
    //    读 state/recent.json —— 这些都在 `cwd`（工作目录）之外，
    //    `workspace-write` 会被拒 ⇒ 会表现为"上传那一步莫名其妙失败" ✗
    /* ⚠️⚠️ 2026-10-22：**起 agent 之前先把评论回复的常驻浏览器放掉**
     *   那个常驻 Chrome 占着 `state/bili-profile`，而一个 user-data-dir 只能被一个 Chrome 用
     *   ⇒ 不让位的话，agent 最后上传视频那步 `bili-upload.mjs` 起不来 ✗
     *   （`release()` 还会顺手暂停评论回复 40 分钟，免得它在出片期间把 profile 抢回去） */
    try {
      const bc = await import('./bili-comments.js');
      await bc.release();
    } catch (e) { log.debug(`[B站投稿] 释放常驻浏览器失败（不影响出片）：${e.message}`); }
    const { promise, kill } = runTask(prompt, {
      cwd: workDir,
      rawPrompt: true,
      permission: 'danger-full-access',
      timeoutMs: AGENT_TIMEOUT_MS,
    });
    currentKill = kill;
    const timer = setTimeout(() => {
      log.warn(`[B站投稿] agent 超过 ${Math.round(AGENT_TIMEOUT_MS / 60000)} 分钟没干完 ⇒ 停掉`);
      try { kill(); } catch { /* ignore */ }
    }, AGENT_TIMEOUT_MS);

    const res = await promise;
    clearTimeout(timer);
    currentKill = null;

    const said = String(res?.stdout || '').trim();
    log.info(`[B站投稿] agent 回来了（exit ${res?.code}）：${said.slice(0, 160) || '（没说话）'}`);

    // ① 读它写的 result.json
    let r = {};
    try { r = JSON.parse(readFileSync(join(workDir, 'result.json'), 'utf8')); } catch { /* 下面按缺文件处理 */ }

    // ② 硬校验（用户要求「每条视频都要有 live2d 和 saki 自己的台词和语音」）
    //    ⚠️ 复用现成视频那天（`reuse`）**不查 Live2D/配音** —— 那天根本没跑管线，
    //       查了必然失败。改查：那个文件还在、够大、agent 写了 result.json ✓
    const video = String(r.video || (reuse ? reuse.video : join(workDir, 'video.mp4')));
    const voiceDir = join(workDir, 'voice');
    const wavCount = existsSync(voiceDir)
      ? readdirSync(voiceDir).filter((f) => /^v\d+\.wav$/i.test(f)).length
      : 0;
    const l2dMeta = join(ROOT, 'logs', 'bili', 'l2d_take', 'meta.json');
    const sizeMb = existsSync(video) ? statSync(video).size / 1024 / 1024 : 0;

    if (!existsSync(video)) throw new Error('失败：没有成片' + (r.note ? '（' + r.note + '）' : ''));
    if (sizeMb < 1) throw new Error(`失败：成片只有 ${sizeMb.toFixed(2)}MB（疑似空文件）`);
    if (!reuse) {
      if (!existsSync(l2dMeta)) throw new Error('失败：没有 Live2D 录像（人物缺失）');
      if (wavCount < 4) throw new Error(`失败：配音只有 ${wavCount} 段（她的语音缺失）`);
    }
    if (!existsSync(join(workDir, 'result.json'))) throw new Error('失败：agent 没写 result.json（没法记账/通知）');
    if (r.ok === false) throw new Error('失败：' + String(r.note || 'agent 报的'));
    /* ⚠️⚠️ 2026-10-21 真事故：**"只填表没点发布"被当成了成功** ✗
     *   那天 `result.json` 里明明写着 `"uploaded": false`，note 也说"按用户指示只填表、未点发布"，
     *   但校验只看了 mp4 大小和时长 ⇒ 判成功 ⇒ `done` 记上 ⇒ **一整天都不会再发** ✗✗
     *   ⇒ 以后 `uploaded` 必须是 true 才算成功（`reuse` 那条路除外：那是直接调上传脚本，有返回值） */
    if (!reuse && r.uploaded !== true) {
      throw new Error('失败：视频做好了但**没真的上传**（result.json 里 uploaded=' + String(r.uploaded) + '）' +
        (r.note ? '｜它自己说：' + String(r.note).slice(0, 200) : ''));
    }


    log.info(
      reuse
        ? `[B站投稿] 校验通过（复用现成视频）：${video} ${sizeMb.toFixed(1)}MB ✓`
        : `[B站投稿] 校验通过：Live2D ✓ 配音 ${wavCount} 段 ✓ 成片 ${sizeMb.toFixed(1)}MB ✓` +
          ` 时长 ${r.duration || '?'}s 分区 ${r.zone || '?'}`,
    );

    // ③ 记账
    /* ⚠️⚠️ 2026-10-22：**把台词一起存下来**（用户要求）
     *   「评论上下文如果是自己发的视频，还需要有自己那条视频的台词」
     *   为什么必须存：观众常常是**针对某一句**在评论（"第三句啥意思""这段说得对"），
     *   她手里没有台词就只能瞎编 ✗ ⇒ 存下来，`tools/bili-comment-bot.mjs` 按标题匹配取用 ✓
     *   ⚠️ 只存台词正文（不存 vec，那玩意儿没用还占地方）
     */
    let lines = [];
    try {
      const raw = JSON.parse(readFileSync(join(workDir, 'lines.json'), 'utf8'));
      lines = raw.map((x) => (typeof x === 'string' ? x : String(x.text || ''))).map((s) => s.trim()).filter(Boolean).slice(0, 14);
    } catch { /* 复用现成视频那单没有 lines.json，就空着 */ }
    const st2 = loadState();
    /* ⚠️ 2026-10-21：**抓这条的 BV 号**（用户要求「要显示出来发送的视频链接」）
     *   agent 的回执里只有「投递成功」，**没有 bvid** ✗
     *   而稿件管理页上的 BV **只藏在封面链接的 href 里**（页面上看不到那串字），
     *   所以只能开一次浏览器抓（`tools/bili-latest-bvid.mjs`，列表第一条就是最新那条）✓
     *   ⚠️ 抓不到不算失败（审核中的稿件偶尔还没分配）⇒ 空着，不影响记账 */
    let bvid = '', videoUrl = '';
    try {
      const got = await grabBvid();
      if (got?.bvid) {
        bvid = got.bvid;
        videoUrl = got.url || `https://www.bilibili.com/video/${bvid}/`;
        log.info(`[B站投稿] 这条的链接：${videoUrl}`);
      } else log.warn('[B站投稿] 没抓到 BV（不影响发布，链接以后再补）');
    } catch (e) {
      log.warn(`[B站投稿] 抓 BV 出错：${e.message}`);
    }
    st2.history = [{
      at: new Date().toISOString(), day,
      source: String(r.source || 'topic'),
      topic: String(r.topic || ''),
      title: String(r.title || ''),
      ok: true, video, duration: Number(r.duration) || 0,
      zone: String(r.zone || ''), zone2: String(r.zone2 || ''),
      bvid, url: videoUrl,
      lines,
    }, ...(st2.history || [])].slice(0, 60);
    if (r.source === 'group') st2.streakGroup = (st2.streakGroup || 0) + 1;
    else {
      st2.streakGroup = 0;
      if (r.topic) st2.usedTopics = [...new Set([...(st2.usedTopics || []), String(r.topic)])].slice(-10);
    }
    st2.done = { ...(st2.done || {}), [day]: true };
    // 复用那条已经发掉了 ⇒ 清掉预设（否则哪天忘了，它会把这同一条又发一遍 ✗）
    if (reuse) st2.queued = null;
    saveState(st2);

    /* ⚠️ 2026-10-22：**写进短期共享记忆**（用户要求「最近发了哪些视频」也要在里面）
     *    ⇒ 之后她在群里/在 B站回复时，都知道"自己刚发了什么" ✓ */
    try {
      shortMemory.add(
        'video',
        `发了《${r.title || '（没写标题）'}》，分区 ${r.zone || '?'}，${r.duration || '?'} 秒` +
        `（${r.source === 'group' ? '讲群里的趣事' : '自己找的题材'}${r.topic ? '：' + r.topic : ''}）`,
        { key: `video:${day}:${String(r.title || '').slice(0, 40)}` },
      );
    } catch (e) { log.warn(`[B站投稿] 写短期记忆失败：${e.message}`); }

    await notify(
      `B站投稿完成 ✅\n标题：${r.title || '（没写）'}\n` +
      `来源：${reuse ? '复用的成品（用户指定）' : r.source === 'group' ? '群聊内容' : '自制题材'}` +
      `${r.topic ? '（' + r.topic + '）' : ''}\n` +
      `时长 ${r.duration || '?'}s · 分区 ${r.zone || '?'}${r.zone2 ? '/' + r.zone2 : ''}\n` +
      (r.uploaded ? '已发布' : '已填表未发布') +
      (r.note ? `\n备注：${String(r.note).slice(0, 200)}` : ''),
    );
    return { ok: true, title: r.title || '', video, cover: r.cover || '' };
  } catch (e) {
    log.error(`[B站投稿] ${e.message}`);
    saveState({
      ...loadState(),
      history: [{
        at: new Date().toISOString(), day, ok: false, why: e.message,
      }, ...(loadState().history || [])].slice(0, 60),
    });
    await notify(`B站投稿失败 ❌\n原因：${String(e.message).slice(0, 300)}\n工作目录：${workDir}`);
    return { ok: false, why: e.message };
  } finally {
    busy = false;
    currentKill = null;
  }
}

/* ── 定时入口：index.js 每 30 秒调一次 ── */
/* ⚠️⚠️ 2026-10-22 加（用户：「**为什么刚才 chrome 的窗口一直在自己打开然后关闭**」）
 *
 *    真凶**不是**评论回复，是**投稿**：
 *      [22:32:30] [B站投稿] agent 回来了（exit 1）：… 失败：没有成片
 *      [22:32:37] [B站投稿] 到点了，开始今天的自动投稿   ← **7 秒后又开一轮**
 *
 *    根因：`tick()` 每 **30 秒**跑一次，而**失败不写 `st.done`** ⇒ 立刻又满足条件 ⇒
 *    每 30 秒重跑一遍 agent（agent 内部为了上传视频会起 **Chrome**）⇒
 *    屏幕上看就是 **Chrome 窗口反复打开又关掉** ✗✗
 *
 *    ⇒ 加**当天失败上限**：同一天最多试 **2 次**，第 3 次直接跳过今天 ✓
 *      （失败原因通常是"没做出成片"，隔 30 秒再试一遍也不会变好；
 *        而且每次重试都要烧一次 agent 的钱 —— 今天 20:00-21:00 那 ¥11.74 里就有它）
 *    ⚠️ 这个计数只放内存：重启会清零（重启本身就是一次"重新试"，合理）✓
 */
let pubFailToday = { day: '', n: 0 };
/* ⚠️⚠️ 2026-10-22 改（用户：「**没做完不要拉起投稿，做完就立刻拉起就行了**」）
 *    从 2 收紧到 **1** —— 今天失败一次就**不再试**：
 *    · 失败原因通常是"没做出成片"（agent 真要能做完，第一次就做完了）
 *    · 每试一次都要：起 agent（DSH，烧 DeepSeek 的钱）+ 起 Chrome（上传）⇒ 屏幕反复闪
 *    · 「做完就立刻拉起」现在是**天然满足**的：agent 做完成片会**当场自己上传** ✓
 *      （`bili-upload.mjs` 在同一个 agent 会话里跑，不是等下一轮 tick） */
const PUB_FAIL_MAX = 1;

export function tick() {
  const c = settings();
  if (!c.enable) return;
  const day = dayKey();
  const st = loadState();
  if (st.done && st.done[day]) return;             // 今天已经做过了
  if (pubFailToday.day !== day) pubFailToday = { day, n: 0 };
  if (pubFailToday.n >= PUB_FAIL_MAX) return;      // ⚠️ 今天失败太多次 ⇒ 今天不再试
  const at = planFor(day);
  if (Date.now() < at) return;
  if (busy) return;
  log.info(`[B站投稿] 到点了，开始今天的自动投稿（今天第 ${pubFailToday.n + 1} 次尝试）`);
  void runOnce({ publish: true })
    .then((r) => {
      // ⚠️ `why: 'busy'` 不是失败（是"上一条还在跑，这次跳过"）⇒ 不能算进失败次数 ✗
      if (r && (r.ok || r.why === 'busy' || r.why === 'agent-busy')) {
        if (r.ok) pubFailToday = { day, n: 0 };
        return;
      }
      pubFailToday.n += 1;
      if (pubFailToday.n >= PUB_FAIL_MAX) {
        log.warn(
          `[B站投稿] ⛔ 今天已经失败 ${pubFailToday.n} 次（${(r && r.err) || '没成片'}）⇒ **今天不再试**` +
            `（别再每 30 秒起一次 agent/Chrome）`,
        );
      }
    })
    .catch((e) => {
      pubFailToday.n += 1;
      log.warn(`[B站投稿] 出错（今天第 ${pubFailToday.n} 次）：${e.message}`);
    });
}

/** 给界面看的当前状态 */
export function status() {
  const c = settings();
  const st = loadState();
  const day = dayKey();
  return {
    enable: c.enable,
    window: `${c.windowStart}~${c.windowEnd}`,
    nextAt: st.lastDay === day && st.nextAt ? new Date(st.nextAt).toLocaleString('zh-CN', { hour12: false }) : '（未排）',
    todayDone: !!(st.done && st.done[day]),
    streakGroup: st.streakGroup || 0,
    groupMaxStreak: c.groupMaxStreak,
    running: busy,
    history: (st.history || []).slice(0, 10),
  };
}
