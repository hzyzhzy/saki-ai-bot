/**
 * B站**全自动投稿**（2026-10-22 定，A 档 = 生成 + 直接发布）
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
    /** **发布**（上传到 B 站）的时间窗口 */
    windowStart: String(c.windowStart || '20:00'),
    windowEnd: String(c.windowEnd || '23:00'),
    /* ⚠️⚠️ 2026-11-01 加（用户：「**制作视频的时候需要用到 GPU，所以是改做视频的时间**，
     *    投稿视频的时间还是在 16:00~20:00 随机」）
     *
     *    ⇒ 把"做"和"发"拆成**两个时间窗口**：
     *      · `makeStart~makeEnd`     —— **做视频**（选题+配音+录 Live2D+AE 合成，**吃 GPU**）
     *      · `windowStart~windowEnd`  —— **上传+发布**（几乎不占 GPU）
     *
     *    ⚠️ 没配 `makeStart` ⇒ **老行为**（到点一条龙做完就发），不改老用户行为 ✓
     */
    makeStart: String(c.makeStart || ''),
    makeEnd: String(c.makeEnd || ''),
    group: String(c.group || ''),
    /* 2026-11-08：两种片子彻底分开 —— 'self' = 完全自己做（画面用网上素材）；
     * 'group' = 分享群聊（画面是聊天记录）。选哪个就只给它那一种的做法。 */
    mode: c.mode === 'group' ? 'group' : 'self',
 /** ⚠️ 题材**不是**清单，这里只是"她能聊的范围"（2026-10-22 改口） */
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
      /* ⚠️ 2026-11-01 加：**做视频 / 上传发布 拆成两段**之后的时间与交接
       *   · makeAt / publishAt —— 今天定好的两个时刻（`planFor` 写）
       *   · madeAt             —— 视频**做完了**的时刻（0 = 还没做）
       *   · madeWorkDir        —— 成片那个工作目录（上传阶段要去读它的 result.json）
       *   · publishedAt        —— 上传发布完成的时刻
       *   ⚠️ 这四个**必须一起加在 load() 白名单里** —— 少了任何一个，
       *      写进去下次读回来就凭空消失（老坑，见 bili-proactive.js 那段注释）✗
       */
      makeAt: 0, publishAt: 0, madeAt: 0, madeWorkDir: '', publishedAt: 0,
      /* ⚠️ 2026-11-04 加：**当天失败次数**（落盘 ⇒ 重启不忘，见 `bumpFail` 那段注释）
       *   · failDay —— 这个计数是哪一天的
       *   · failN   —— 那天失败了几次（满 `PUB_FAIL_MAX` 就今天不再试）
       *   ⚠️ 这两个也必须加进白名单，不然写进去读不回来（同上面的老坑） */
      failDay: '', failN: 0,
 /** 指定某天直接发**现成文件**（2026-10-22：「明天投稿的视频先定为今天做的桌面上那个」）
       *  形如 `{ day: '2026-10-22', video: 'E:\\Desktop\\xxx.mp4', note: '' }` */
      queued: null,
      /* ⚠️ 2026-10-23 加：**投稿审核通过后要转发到 1 档群**的那批
       *    形如 `{ bvid, title, at, tries, done }` —— 由 `shareTick()` 轮询审核状态 ✓ */
      pendingShare: [],
      running: false, ...j,
    };
  } catch {
    return {
      lastDay: '', nextAt: 0, streakGroup: 0, done: {}, history: [], usedTopics: [],
      queued: null, pendingShare: [], running: false,
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

/* ── 每天 12:00 清视频缓存（2026-10-21 要求） ──
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
  /* ⚠️⚠️ 2026-11-01 改成**两个时间点**（用户：「做视频要用 GPU ⇒ 改做视频的时间；
   *    投稿还是在 16:00~20:00 随机」）
   *   · `makeAt`    —— 开始做视频（吃 GPU）
   *   · `publishAt` —— 开始上传+发布
   * ⚠️ 老状态文件里只有 `nextAt` ⇒ 第一次跑会重算一遍（无害）✓
   * ⚠️ **改了配置当天不重算**是原来就有的行为（`lastDay === day` 就复用）——
   *    所以改完时间**当天不生效**，第二天才按新时间跑。要当天立刻生效就把
   *    `state/bili-publish.json` 的 `lastDay` 清掉（下面 `planFor` 也认这个）✓
   */
  if (st.makeAt && st.publishAt && st.lastDay === day) {
    return { makeAt: st.makeAt, publishAt: st.publishAt };
  }
  const c = settings();
  const pick = (s, e, defA, defB) => {
    const a = hhmm(s) ?? defA;
    const b = hhmm(e) ?? defB;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const at = lo + Math.floor(Math.random() * Math.max(1, hi - lo));
    const d = new Date();
    d.setHours(Math.floor(at / 60), at % 60, Math.floor(Math.random() * 60), 0);
    return d.getTime();
  };
  const publishAt = pick(c.windowStart, c.windowEnd, 1200, 1380); // 20:00~23:00
  // ⚠️ 没配 makeStart ⇒ 老行为：做和发同一个时间点
  /* ⚠️⚠️ 2026-11-01 改（用户：「**做视频不用随机**」）
   *    ⇒ `makeStart` 配了就**固定那个时刻**（08:00 到点就开始），不再在
   *      makeStart~makeEnd 之间随机。`makeEnd` 保留着当**界面上的窗口说明**，不参与计算 ✓
   */
  const makeAt = c.makeStart
    ? (() => {
        const m = hhmm(c.makeStart);
        if (m == null) return publishAt; // 写错了就当没配
        const d = new Date();
        d.setHours(Math.floor(m / 60), m % 60, 0, 0);
        return d.getTime();
      })()
    : publishAt;
  /* ⚠️⚠️ 2026-11-03 修（真 bug，今天才具备触发条件）：
   *    两阶段的交接字段 `madeAt / madeWorkDir / publishedAt` 是**全局单值、按天有效**的，
   *    但原来跨天重排时**没清它们** ⇒ 第二天 tick 进来：
   *      · 阶段① `if (!st.madeAt)` ⇒ 假（还留着昨天的）⇒ **跳过做视频**
   *      · 阶段② `if (!st.publishedAt)` ⇒ 假（昨天的）⇒ **跳过上传**
   *    ⇒ 一整天**静默什么都不做**，日志里一个字都不打 ✗（连"跳过"都不打，最难查的那种）
   *    ∨ 之前几天没撞上，只是因为前几天都在失败、`madeAt` 压根没写进去；
   *      2026-11-03 第一次真成功（madeAt + publishedAt 都写了）⇒ 2026-11-04 必炸
   *    ⇒ 跨天重排时把它们清成 0/''（新的一天从零开始）✓
   *    ⚠️ 当天中途重启**不会**走到这里（`lastDay === day` 直接 return 复用）⇒
   *       早上做好的成片和 `madeWorkDir` 照样留着给 16 点上传用 ✓
   */
  saveState({
    ...st,
    lastDay: day,
    makeAt,
    publishAt,
    nextAt: publishAt,
    madeAt: 0,
    madeWorkDir: '',
    publishedAt: 0,
  });
  const fmt = (t) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
  log.info(
    makeAt === publishAt
      ? `[B站投稿] 今天（${day}）到点就做+发：${fmt(publishAt)}`
      : `[B站投稿] 今天（${day}）：**做视频** ${fmt(makeAt)} ｜ **上传发布** ${fmt(publishAt)}`,
  );
  return { makeAt, publishAt };
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
 * ⚠️⚠️ 2026-10-22反馈：「台词导入了 saki 的人设吗？感觉**活人感还不够强**，
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
 '【玩梗的规矩（2026-10-22 定）】',
 '· **至少 1 处、最多 2 处**（2026-11-06：「视频内容要有梗」—— 一处都没有，这条片子就白做），',
  '  而且必须**自然长在话里**。',
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
export function buildPrompt({ workDir, topic, publish, streak, reuse, makeOnly = false }) {
  const c = settings();
  const group = c.group || '200000001';
  /* 2026-11-08：连续 groupMaxStreak 天没做自制 ⇒ **强制完全自己做**（原有机制，之前被我删没了） */
  const forcedSelf = streak && streak.forced === true;
  const MODE = forcedSelf ? 'self' : c.mode;

  /* ── ① 复用现成视频（用户指定"明天就发这条"）──────────────────────
 * 2026-10-22：「明天投稿的视频先定为今天做的桌面上那个」
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
      /* ⚠️⚠️ 2026-10-26 加的标题硬规则（来源：BV1SHnH6FEsR 的旁白原话）
       *    「他们不点开推荐。**他们只搜五个词**。五个词里我的标题一个都没有
       *      ⇒ 不是没人喜欢，是**没人搜得到**」
       *    ⇒ 标题里**至少要有一个别人会拿去搜的词**，否则这条视频等于没发 ✓ */
      '   ⚠️⚠️ **标题硬规则：里面至少要有一个"别人会拿去搜的词"** ——',
      '   比如具体的东西名（DeepSeek、MC、某个模组名、她要讲的那个软件 / 游戏 / 事件），',
      '   或者一个具体的问题（"为什么会…"、"到底怎么…"）；',
      '   🚫 但**不许硬凑**：真想不出一个能被人搜的词，**说明这个题材本来就不值得做** ——',
      '     回去换个题材，别硬塞无关的热词 ✗',
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
    `⚠️ 先读一遍作业手册：\`${MANUAL}\``,
    '   ⚠️ **手册里关于题材 / 背景 / 标题 / 动作 / 时长 / 群聊挑选的那些规矩，今天不适用** —— 那些你自己定。',
    '',
    '## 零、作业方式（⚠️⚠️ 违反这条，今天一定白做）',
    '',
    '**你是个会被"随进程结束"打断的 agent：任务丢到后台、自己把回合说完 ⇒',
    '  那些后台进程会被一起带走。前面三次"没成片"全是这么死的。**',
    '',
    '- 🚫 **不许**用任何"不等它跑完"的方式起活：`run_in_background`、命令末尾 `&`、',
    '  `start /b`、`nohup`、`spawn(..., {detached:true})`，',
    '  以及「我先启动它，然后这边继续干别的」这种写法 ✗',
    '- ✅ **一条一条前台跑**，等到它自己结束、拿到退出码为止；',
    '  确实想并行（比如片头 + 配音），就**写一个 node 脚本内部并行**，再**整体前台等它** ✓',
    '- ✅ 每一步跑完**先看退出码和产物**（文件在不在、多大）再进下一步：',
    '  `video.mp4` 至少 **3MB**、`voice/v*.wav` **每句一个**、缺任何一个就算失败 ✓',
    '- ⚠️ 跑得久是**正常的**（录 Live2D + 合成十几分钟）—— 就等它，**别嫌慢改成后台** ✗',
    '',
    '## 一、只有一条硬要求：**片子里必须有你自己**',
    '',
    '1. ✅ **必须有你的 Live2D 形象**（半身、会张嘴对口型、有手部/头部动作）—— 没有这条不算成品 ✗',
    '2. ✅ **台词是你自己说的话**（第一人称），并且**配成真人语音**（IndexTTS），不是字幕、不是旁白',
    '3. ✅ **竖屏 1080×1920**',
    '4. 🚫 不碰政治、真人隐私、骂战、低俗',
    '',
    '**除了这四条，别的全部你自己定**：做什么题材、讲什么、多长、说什么、背景放什么、',
    '用不用群里的东西、要不要片头、动作怎么排 —— 都随你。',
    '⚠️ 没人给你列清单，也**别停下来问**（问了也没人答，这条是全自动的）。',
    '',
    ...(MODE === 'self'
      ? [
          '## 题材和画面（**完全自己做**）',
          '',
          `· **只在这几个方向里找**：${(c.scope || []).join(' / ')}`,
          '  🚫 **不要拿群里的事当题材**（那种走另一条路）；',
          '',
          '· ⚠️⚠️ **动手前先问自己一句：这事值得专门做成一条视频吗？**',
          '  视频是拿来**吸引人点开看**的 —— 只是「我今晚刷到一条视频」「我吃了顿饭」这种',
          '  日常小事，发 QQ 空间就够了，不值得占一条视频 ✗',
          '  ✅ 值得做的是这几种之一：',
          '    · 有**信息量**（能教人点什么、说出别人不知道的）',
          '    · 有**冲突或反差**（这事不对劲 / 跟大家以为的相反）',
          '    · 有**你的观点**（你对它有话说，而且是别人说不出你这句话的那种）',
          '    · 够**新奇**（大部分人没见过，看了会"啊这"）',
          '  🚫 反面例子：出门买菜、刷到个视频、吃了顿饭、今天有点累、天气变了 —— 这些都不够，别做',
          '',
          '· **画面**：🚫 **不要聊天记录，也不要"一张死图配讲话"**（那太死板了）。',
          '  要做成**分镜动画** —— 把台词拆成 3~5 个**要点**，每个要点一个画面，写进 `scenes.json`：',
          '  ```json',
          '  [',
          '    {"type":"title","text":"大字","em":"要强调的词","sub":"下面一行小字","sec":3},',
          '    {"type":"compare","left":"左边那句","right":"右边那句","cap":"底下一句","sec":3.5},',
          '    {"type":"list","head":"标题","items":["第一条","第二条","第三条"],"sec":4},',
          '    {"type":"bars","left":{"label":"A","pct":92},"right":{"label":"B","pct":14},"quote":"收尾一句","sec":3.5}',
          '  ]',
          '  ```',
          '  ⚠️ **怎么挑类型**（这一步决定观众能不能看懂，别乱选）：',
          '    · 有**对比**（A 和 B、它跟你、以前跟现在）⇒ `compare`',
          '    · 要**列举**（三条、几种、一串东西）⇒ `list`',
          '    · 有**大小 / 多少 / 长短**的差别 ⇒ `bars`（`pct` 是 0~100 的相对长度）',
          '    · 只是抛一个观点、或者开场 ⇒ `title`',
          '  ⚠️ 每段 `sec` 自己定（2~4 秒），**加起来和配音差不多长**；',
          '  ⚠️ 画面上的字要**短**（大字十几字、列表每条十几个字）—— 别把整句台词搬上去；',
          '  · 出分镜：`node tools/ae-scenes.mjs --scenes scenes.json --out <工作目录>/scenes --keep-open`',
          '    它走 AE 渲染，出来的是一串 1080×1920 带透明的 PNG；',
          '· ⚠️ result.json 里 source 写 "topic"。',
        ]
      : [
          '## 题材和画面（**分享群聊**）',
          '',
          '· **题材**：讲群里今天真发生的一件事（谁在折腾什么、后来怎样），要能讲满 20 秒；',
          '· **画面**：用群里的**聊天记录滚动**，命令**不要**加 --bg（不给它就是这种）；',
          '  · 跟台词无关的聊天整条剔掉；条数少就加 --hold-ratio 0.8；',
          '· ⚠️ result.json 里 source 写 "group"。',
        ]),    '',
    '',
    '⚠️ 唯一别丢的一件事：**说话得像你自己**（台词按下面这段的口气来）：',
    voiceBlock(),
    '',
    '**分区**：从下面清单里挑最贴内容的那一个（名字要一字不差，上传脚本按名字点）：',
    zoneListText(),
    `   （拿不准就用「${c.zone}」；⚠️ 清单可能过时，**以页面上真弹出来的分区为准** ——`,
    '   清单里没有的，就用页面上最贴近的那个，并把它**真实的名字**写进 result.json 的 zone ✓）',
    '',
    '## 二、出片（一条命令，别一步步手搓）',
    '',
    `1. 台词 → \`${join(workDir, 'lines.json')}\`（格式照手册）`,
    '2. 出片：',
    '   ```',
    `   node "${join(TOOLS, 'bili-pipeline.mjs')}" --group ${group} --lines "${join(workDir, 'lines.json')}" \\`,
    `     --voice "${join(workDir, 'voice')}" --duration <你自己定的秒数> --force-tts --auto \\`,
    `     --out "${join(workDir, 'video.mp4')}" --no-desktop`,
    '   ```',
    '   · `--auto` 只会给你一份**动作表和背景的草稿**（`logs/bili/actions.json` / `logs/bili/chat_picked.json`）——',
    '     **不满意就自己改**，改多少、改不改、用不用群聊记录，全你说了算 ✓',
    '   · 想换背景、不要群聊记录、调人物大小：参数在 `bili-pipeline.mjs` / `bili-intro3.mjs` 里，自己看自己调',
    `3. 封面：从成片里截一帧 + 标题字 → \`${join(workDir, 'cover.jpg')}\``,
    '4. 自检：抽帧看**音画同步**、看**有没有张嘴**、看**片尾字幕有没有被裁**、看**人物有没有抽搐/跳帧**',
    '',
    makeOnly
      ? [
          '5. 🚫🚫 **今天到此为止，不要上传**（这台机器白天做片、下午才发）',
          '   - 成片就是 `video.mp4`，封面 `cover.jpg` —— 做到这儿就停；',
          '   - 🚫 **绝对不要调用 `bili-upload.mjs`**（那一步会在 16~20 点由另一个流程做）；',
          '   - ✅ 标题 / 简介 / 标签 / 分区**照常想好写进 result.json**（上传阶段直接用，不再问你）。',
        ].join('\n')
      : [
          '5. 上传：',
          '   ```',
          `   node "${join(TOOLS, 'bili-upload.mjs')}" --video "${join(workDir, 'video.mp4')}" \\`,
          '     --title "…" --desc "…" --zone "<分区名>" --tags "…" \\',
          `     --cover "${join(workDir, 'cover.jpg')}"${publish ? ' --publish' : ''}`,
          '   ```',
          publish
            ? '   （**--publish = 直接发出去**，今天这条是要真发的）'
            : '   （今天是**手动试做**，别带 --publish，只把表单填好、别点发布）',
        ].join('\n'),
    '',
    '## 三、干完必须写这个文件（脚本靠它记账和校验，不写就当失败）',
    `\`${join(workDir, 'result.json')}\`：`,
    '```json',
    '{"ok":true,"source":"group|topic","topic":"今天这条讲什么","title":"B站标题",',
    ' "desc":"简介","tags":["…"],"zone":"vlog","duration":42,',
    ' "video":"<成片绝对路径>","cover":"<封面绝对路径>","uploaded":true,"note":"踩了什么坑/有什么要留意的"}',
    '```',
    '⚠️ 失败了也要写，把 `ok` 设成 false 并用 `note` 写清卡在哪一步（不要只在 stdout 里说）',
    '',
    '## 四、禁止事项',
    '- 🚫 **不许往任何 QQ 群/私聊发消息**（这条是全自动的，你只在机器上干活）',
    '- 🚫 不许把中间产物散落在工作区之外',
    '- 🚫 不许跳过 Live2D、不许用静音/占位配音糊过去',
    '',
    '## 五、今天的状态',
    `- 日期：${dayKey()}`,
    `- 你的工作目录（产物都放这儿）：\`${workDir}\``,
    forcedSelf
      ? `- 🚫 **今天必须完全自己做**：已经连续 ${streak.group} 天没做了（上限 ${c.groupMaxStreak} 天）`
      : '',
    topic ? `- ⚠️ **今天就做这个**：${topic}` : '',
    `- 最近做过的（**只当参考，不用刻意避开**）：${(loadState().usedTopics || []).slice(-6).join(' / ') || '（还没有）'}`,
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
export async function runOnce({ topic = '', publish = true, makeOnly = false } = {}) {
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

  /* ⚠️ 2026-11-05 改：streak **从 history 现算**（失败也算"这天没自制"）——
   *    老算法只在投稿成功时 +1，连续失败时永远是 0，强制自制那条规则从没生效 ✗ */
  const streak = computeStreak(st, { max: c.groupMaxStreak, today: day });
  // 顺手把算出来的值写回状态（界面「连续群聊 N/2 天」看的就是它）
  if (Number(st.streakGroup) !== streak.group) {
    try {
      saveState({ ...loadState(), streakGroup: streak.group });
    } catch {
      /* ignore */
    }
  }

  /* 用户指定了"今天直接发这个现成文件"（2026-10-22：「明天投稿的视频先定为今天做的桌面上那个」）
   * ⚠️ 只认**当天**那条：`queued.day` 对不上就当没有（免得以后哪天又把它发一遍）✗ */
  const q = st.queued;
  const reuse = q && String(q.day || '') === day && q.video && existsSync(String(q.video))
    ? { video: String(q.video), note: String(q.note || '') }
    : null;
  if (q && !reuse) log.info(`[B站投稿] 预设视频对不上今天（${q.day || '?'} / 文件${q.video ? '在' : '不在'}）⇒ 按平常做`);

  try {
    const prompt = buildPrompt({ workDir, topic: String(topic || '').slice(0, 200), publish, streak, reuse, makeOnly });
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

    /* ⚠️⚠️ 2026-11-04 加（用户选了 C：查 agent 为什么 exit 1）
     *    以前这里只记 stdout 的 160 字 ⇒ agent 中途退出（2026-10-30 / 11-01 / 11-04 三次
     *    「没成片」）时**一点线索都没有**，只知道它最后说了句"现在写台词。" ✗
     *    ⇒ 非 0 退出码时：完整 stderr 落进工作目录的 `agent-stderr.log`，
     *      日志里再摘 800 字（够看出是崩了/被限流/还是被 kill）✓
     *    ⚠️ stderr 是它自己的思考+报错，**不发群、不进 history**，只给排查用 ✓
     */
    if (res?.code !== 0) {
      const errTail = String(res?.stderr || '').trim();
      if (errTail) {
        try { writeFileSync(join(workDir, 'agent-stderr.log'), errTail, 'utf8'); } catch { /* ignore */ }
        log.warn(`[B站投稿] agent exit ${res.code}，stderr 尾部：${errTail.slice(-800).replace(/\s+/g, ' ')}`);
      } else {
        log.warn(`[B站投稿] agent exit ${res.code}，**stderr 也是空的**（像是被直接杀掉或静默退出）`);
      }
    }

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
     *   ⇒ 以后 `uploaded` 必须是 true 才算成功（`reuse` 那条路除外：那是直接调上传脚本，有返回值）
     *
     * ⚠️⚠️⚠️ 2026-11-03 修（真事故：**当天视频做好了却没发出去**）：
     *   加了两阶段之后（`makeStart 08:00` 只做片 / `publishAt 16:02` 才上传），
     *   做片那一轮 `runOnce({publish:false, makeOnly:true})` 的提示词**明确要求不上传**，
     *   于是 agent 按规矩写 `"uploaded": false` —— 可这道校验**没排除 makeOnly** ⇒
     *   把"做片成功"判成"失败：视频做好了但没真的上传" ✗
     *   后果（11-03 实测）：`madeAt` 没记 ⇒ 16:02 的发布阶段拿不到工作目录 ⇒
     *   **成片 08:22 就躺在盘上（10.65MB），当天一条都没发**，日志还写着"做视频失败：没成片"。
     *   ⇒ `makeOnly` 这条路上"没上传"是**预期**，不是失败；真正的上传由阶段②的
     *     `runUpload()` 负责，那边有返回值、不看 `uploaded` ✓
     */
    if (!reuse && !makeOnly && r.uploaded !== true) {
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
    /* ⚠️⚠️ 2026-11-06 修（**两阶段从来没自动发成功过，根子就在这一行**）
     *
     *   `tick()` 第一行就是 `if (st.done[day]) return` —— 而这段在**做视频成功**时
     *   就把 `done` 写了 ⇒ 早上 8 点做完片之后，每一轮 tick 都在第一行直接 return
     *   ⇒ **下午 publishAt 那个"上传发布"阶段永远走不到** ✗
     *
     *   实证：11-01 引入两阶段之后，11-02 / 11-04 / 11-05 的失败原因全是
     *   「视频做好了但**没真的上传**」；唯一发出去的那次（11-03）是我手动补发的，
     *   绕过了这段代码 ⇒ 这条流程一次都没自动跑通过。
     *
     *   ⇒ `done` 的语义收紧成「**今天这活彻底结束**」，只有真上传成功才写：
     *     · makeOnly（只做片）⇒ **不写**，等到了发布时刻那轮去上传 ✓
     *     · 真上传成功（`uploaded !== false`）⇒ 写 ✓
     */
    const finishedToday = !makeOnly && r.uploaded !== false;
    if (finishedToday) {
      st2.done = { ...(st2.done || {}), [day]: true };
    } else {
      log.info('[B站投稿] 这次只做了片、没上传 ⇒ **不写 done**，等发布时刻那轮再传');
    }
    // 复用那条已经发掉了 ⇒ 清掉预设（否则哪天忘了，它会把这同一条又发一遍 ✗）
    if (reuse) st2.queued = null;
    /* ⚠️⚠️ 2026-10-23 加（用户：「**加一个每次 Saki 视频审核通过之后自动向 1 档群转发视频链接，
     *    和 b 站视频分享一样**」）
     *
     *    投稿成功 ≠ 能看：B站还要**审核**（刚投的稿件 `state` 是 0，通过才变 1）。
     *    ⇒ 这里先**记一笔待转发**，由 `shareTick()` 轮询审核状态，
     *      过了才把「【标题】 链接?share_source=copy_web」发到所有 1 档群 ✓
     *    ⚠️ 样式照抄 `bili-share.js`（那是用户给过真实样例的：`【标题】 链接` + `share_source=copy_web`）✓
     */
    if (r.uploaded && String(bvid || '')) {
      st2.pendingShare = [
        ...(st2.pendingShare || []),
        { bvid: String(bvid), title: String(r.title || ''), at: Date.now(), tries: 0, done: false },
      ];
    }
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
    return { ok: true, title: r.title || '', video, cover: r.cover || '', workDir };
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
 *    ⚠️⚠️ 2026-11-04 改（用户选了 B 方案）：**这个计数改成落盘**（`failDay` / `failN`）——
 *      原来只放内存、理由是"重启本身就是一次重新试，合理"，但当天就栽了：
 *      2026-11-04 08:06 那次失败后本该整天不再试，结果 17:13 我为了加载别的改动
 *      重启了机器人 ⇒ 内存计数清零 ⇒ 17:13:34 又起来做了一遍视频（白烧 GPU + agent 钱）✗
 *      ⇒ 现在**重启也不会忘**：同一天失败满 `PUB_FAIL_MAX` 次就真的今天不再试 ✓
 *      （想强制重试：把状态文件里的 `failN` 改成 0，或删掉 `state/bili-publish.json` 的 failDay）
 */
let pubFailToday = { day: '', n: 0 };

/** 记一次失败（**落盘**，重启不忘） */
function bumpFail(day) {
  const n = (pubFailToday.day === day ? pubFailToday.n : 0) + 1;
  pubFailToday = { day, n };
  try { saveState({ ...loadState(), failDay: day, failN: n }); } catch { /* 写不进去也不挡住业务 */ }
  return n;
}

/** 清零（今天成功了 / 手动放行） */
function clearFail(day) {
  pubFailToday = { day, n: 0 };
  try { saveState({ ...loadState(), failDay: day, failN: 0 }); } catch { /* ignore */ }
}
/* ⚠️⚠️ 2026-10-22 改（用户：「**没做完不要拉起投稿，做完就立刻拉起就行了**」）
 *    从 2 收紧到 **1** —— 今天失败一次就**不再试**：
 *    · 失败原因通常是"没做出成片"（agent 真要能做完，第一次就做完了）
 *    · 每试一次都要：起 agent（DSH，烧 DeepSeek 的钱）+ 起 Chrome（上传）⇒ 屏幕反复闪
 *    · 「做完就立刻拉起」现在是**天然满足**的：agent 做完成片会**当场自己上传** ✓
 *      （`bili-upload.mjs` 在同一个 agent 会话里跑，不是等下一轮 tick） */
const PUB_FAIL_MAX = 1;

/**
 * **连续几天没做出自制题材**（2026-11-05 新算法，用户选的方案 1）
 *
 * ⚠️⚠️ 老算法（`st.streakGroup`）只在**投稿成功**时才 +1（见 `runOnce` 尾部那种
 *   `if (r.source === 'group') st.streakGroup += 1`）—— 失败不累加 ⇒
 *   连续 7 天没发出视频，那个数**永远停在 0** ⇒ `forced` 永远 false ⇒
 *   任务书里「连续 N 天群聊就必须自制」这条规则**从来没触发过** ✗
 * （2026-11-05：「视频一直做的都是群里的事情，一次自己搜集的题材都没有」）
 *
 * ⇒ 改成**从 history 现算**，不依赖成功路径：
 *   · 按天归并；某天只要有**一条成功且 `source:'topic'`**，就算那天做了自制 ✓
 *   · 其余情况（失败 / 做的是群聊 / 没写 source）一律算"这天没有自制" ✓
 *   · **今天**的记录不算（今天还没做完，不能拿它判断今天）
 * ⚠️ 只数 history 里**有记录的日子**：中间完全没跑的日子不计入
 *   （不然断网三天回来就永久强制自制了）
 */
export function computeStreak(st, { max = 2, today = '' } = {}) {
  const list = Array.isArray(st?.history) ? st.history : [];
  const byDay = new Map();
  for (const h of list) {
    const d = String(h?.day || '');
    if (!d || d === today) continue;
    const prev = byDay.get(d) || { madeTopic: false };
    if (h.ok && String(h.source || '') === 'topic') prev.madeTopic = true;
    byDay.set(d, prev);
  }
  const days = [...byDay.keys()].sort().reverse(); // 最近的在前
  let n = 0;
  for (const d of days) {
    if (byDay.get(d).madeTopic) break;
    n += 1;
    if (n >= 30) break; // 保险丝
  }
  return { group: n, forced: n >= Math.max(1, Number(max) || 2) };
}

/**
 * **只上传发布**（2026-11-01 加）
 *
 * 用户：「做视频用 GPU ⇒ 改做视频的时间；投稿还是 16:00~20:00 随机」
 *   ⇒ 早上那一轮只做成片（不碰上传），到了下午这个函数负责把成片发出去。
 *
 * ⚠️ 不去重做视频、不重新配音 —— 它只是把早上做好的东西上传。
 * ⚠️ 信息全从早上写好的 `result.json` 里读（title/desc/tags/zone/cover 都在）✓
 * @param {string} workDir 早上的工作目录
 */
async function runUpload(workDir) {
  try {
    if (!workDir) return { ok: false, why: '没有成片目录（今天的"做视频"阶段没成功）' };
    const rj = join(workDir, 'result.json');
    if (!existsSync(rj)) return { ok: false, why: `成片目录里没有 result.json：${workDir}` };
    let r = {};
    try { r = JSON.parse(readFileSync(rj, 'utf8')); } catch (e) {
      return { ok: false, why: `result.json 读不了：${e.message}` };
    }
    if (r.ok === false) return { ok: false, why: `早上那一轮就报失败了：${String(r.note || '').slice(0, 140)}` };
    const video = String(r.video || join(workDir, 'video.mp4'));
    if (!existsSync(video)) return { ok: false, why: `成片文件不见了：${video}` };
    const cover = String(r.cover || join(workDir, 'cover.jpg'));
    const c = settings();
    const tags = Array.isArray(r.tags) && r.tags.length ? r.tags.join(',') : (c.tags || []).join(',');

    // ⚠️ 上传要**独占** state/bili-profile，常驻浏览器先让位（同 runOnce 里那段）
    try {
      const bc = await import('./bili-comments.js');
      await bc.release({ pauseMs: 4 * 60 * 1000 });
      await new Promise((x) => setTimeout(x, 5000));
    } catch { /* 没装/没起过都无所谓 */ }

    const args = [
      join(TOOLS, 'bili-upload.mjs'),
      '--video', video,
      '--title', String(r.title || '').slice(0, 80),
      '--desc', String(r.desc || ''),
      '--zone', String(r.zone || c.zone),
      '--tags', tags,
      '--cover', cover,
      '--publish',
    ];
    log.info(`[B站投稿] 上传阶段：${String(r.title || '').slice(0, 40)}（成片 ${video}）`);
    const out = await new Promise((resolve) => {
      const p = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true });
      let so = '';
      let se = '';
      const timer = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } }, 10 * 60 * 1000);
      p.stdout.on('data', (d) => { so += String(d); });
      p.stderr.on('data', (d) => { se += String(d); });
      p.on('close', () => { clearTimeout(timer); resolve({ so, se }); });
      p.on('error', (e) => { clearTimeout(timer); resolve({ so, se: se + e.message }); });
    });

    let up = null;
    for (const line of String(out.so).trim().split(/\r?\n/).reverse()) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try { up = JSON.parse(t); break; } catch { /* 不是回执 */ }
    }
    if (!up) {
      const tail = (out.so + out.se).trim().split(/\r?\n/).slice(-3).join(' ｜ ');
      return { ok: false, why: `上传脚本没给回执：${tail.slice(0, 240)}` };
    }
    if (up.ok !== true) return { ok: false, why: String(up.error || up.why || '上传失败').slice(0, 200) };

    saveState({
      ...loadState(),
      history: [{
        at: new Date().toISOString(), day: dayKey(), ok: true,
        title: String(r.title || ''), video, cover,
        why: `发布阶段上传成功${up.bvid ? ' ｜ ' + up.bvid : ''}`,
      }, ...(loadState().history || [])].slice(0, 60),
    });
    try {
      await notify(
        `B站投稿完成 ✅（下午发布）\n标题：${r.title || '（没写）'}\n` +
        `时长 ${r.duration || '?'}s · 分区 ${r.zone || '?'}` + (up.bvid ? `\n${up.bvid}` : ''),
      );
    } catch { /* 通知失败不影响 */ }
    return { ok: true, title: String(r.title || ''), bvid: String(up.bvid || ''), video };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

export function tick() {
  const c = settings();
  if (!c.enable) return;
  const day = dayKey();
  const st = loadState();
  if (st.done && st.done[day]) return;             // 今天已经做过了
  /* ⚠️ 2026-11-04：失败次数**从状态文件读回**（落盘了）⇒ 重启不会清零 ✓
   *   同一天里取"内存和文件里较大的那个"，防两个写点互相盖掉。 */
  const savedFail = st.failDay === day ? Number(st.failN) || 0 : 0;
  if (pubFailToday.day !== day || pubFailToday.n < savedFail) {
    pubFailToday = { day, n: savedFail };
  }
  if (pubFailToday.n >= PUB_FAIL_MAX) return;      // ⚠️ 今天失败太多次 ⇒ 今天不再试
  /* ⚠️⚠️ 2026-11-01 改成**两阶段**（用户：「制作视频需要用到 GPU ⇒ 改**做视频**的时间，
   *    投稿的时间还是在 16:00~20:00 随机」）
   *
   *   · `makeStart~makeEnd`（默认 08:00~09:00）→ **只做视频**（吃 GPU），成功记 `madeAt`
   *   · `windowStart~windowEnd`（16:00~20:00 随机）→ **只上传发布**，读 `madeWorkDir`
   *
   * ⚠️ 没配 `makeStart` ⇒ `makeAt === publishAt` ⇒ **老行为**（到点一条龙做完就发）✓
   * ⚠️ 两阶段之间靠 `state/bili-publish.json` 的 `madeAt / madeWorkDir / publishedAt` 交接；
   *    重启不会丢（都落盘了）✓
   */
  const plan = planFor(day);
  /* ⚠️ 2026-11-03 加：跨天那一刻 `planFor` 刚把 `madeAt / publishedAt` 清掉，
   *    可上面那份 `st`（L1009 读的）还是**清之前**的快照 ⇒ 这一轮仍会按旧值跳过
   *    （30 秒后的下一轮才正常）。重读一次，省掉那一次无意义的空转 ✓
   */
  Object.assign(st, loadState());
  const now = Date.now();
  if (busy) return;

  // ── 老行为：做和发同一个时刻 ──
  if (plan.makeAt === plan.publishAt) {
    if (now < plan.makeAt) return;
    log.info(`[B站投稿] 到点了，开始今天的自动投稿（今天第 ${pubFailToday.n + 1} 次尝试）`);
    void runOnce({ publish: true })
      .then((r) => {
        if (r && (r.ok || r.why === 'busy' || r.why === 'agent-busy')) {
          if (r.ok) clearFail(day);
          return;
        }
        bumpFail(day);
        log.warn(`[B站投稿] ⛔ 失败（今天第 ${pubFailToday.n} 次）：${(r && r.err) || '没成片'}`);
      })
      .catch((e) => { bumpFail(day); log.warn(`[B站投稿] 出错：${e.message}`); });
    return;
  }

  // ── 阶段①：做视频（吃 GPU，**不上传**）──
  if (!st.madeAt) {
    if (now < plan.makeAt) return;
    /* ⚠️⚠️ 2026-11-01 加（**改完之后当场踩到的**，23:48 那次）：
     *    `makeAt` 是早上 8 点，但进程可能是**晚上**才重启的 ⇒ `now >= makeAt` 永远成立
     *    ⇒ 它**半夜补做视频**：占 GPU 半小时，而且做完 publishAt(19:32) 早过了 ⇒ 立刻发 ✗
     *    ⇒ **过了发布时刻就今天不做了**，等明天 ✓
     *    （代价：开机太晚那天会少一条 —— 比半夜偷偷烧 GPU 强）
     */
    if (now >= plan.publishAt) {
      const at = new Date(plan.publishAt).toLocaleTimeString('zh-CN', { hour12: false });
      if (!tick._lateLogged || tick._lateLogged !== day) {
        tick._lateLogged = day;
        log.info(`[B站投稿] 今天已经过了发布时刻（${at}）⇒ **不再补做视频**（免得半夜占 GPU），等明天 ✓`);
      }
      return;
    }
    log.info(`[B站投稿] 到点了，开始**做视频**（今天第 ${pubFailToday.n + 1} 次尝试）`);
    void runOnce({ publish: false, makeOnly: true })
      .then((r) => {
        if (r && (r.ok || r.why === 'busy' || r.why === 'agent-busy')) {
          if (r.ok) {
            clearFail(day);
            saveState({ ...loadState(), madeAt: Date.now(), madeWorkDir: String(r.workDir || '') });
            const at = new Date(plan.publishAt).toLocaleTimeString('zh-CN', { hour12: false });
            log.info(`[B站投稿] ✅ 视频做好了（${r.workDir || '?'}）⇒ 等 ${at} 上传发布`);
          }
          return;
        }
        bumpFail(day);
        log.warn(`[B站投稿] ⛔ 做视频失败（今天第 ${pubFailToday.n} 次）：${(r && r.err) || '没成片'}`);
      })
      .catch((e) => { bumpFail(day); log.warn(`[B站投稿] 做视频出错：${e.message}`); });
    return;
  }

  // ── 阶段②：上传发布（用早上做好的成片）──
  if (!st.publishedAt) {
    if (now < plan.publishAt) return;
    log.info('[B站投稿] 到点了，开始**上传发布**（用早上做好的成片，不重做）');
    void runUpload(st.madeWorkDir)
      .then((r) => {
        if (r && r.ok) {
          saveState({
            ...loadState(),
            publishedAt: Date.now(),
            done: { ...(loadState().done || {}), [day]: true },
          });
          log.info(`[B站投稿] ✅ 发布完成：${r.title || ''}${r.bvid ? ' ｜ ' + r.bvid : ''}`);
          return;
        }
        bumpFail(day);
        log.warn(`[B站投稿] ⛔ 上传发布失败（今天第 ${pubFailToday.n} 次）：${(r && r.why) || '?'}`);
      })
      .catch((e) => { bumpFail(day); log.warn(`[B站投稿] 上传发布出错：${e.message}`); });
  }
}

/** 给界面看的当前状态 */
/**
 * **投稿审核通过之后，把视频链接转发到所有 1 档群**（2026-10-23 要求）
 *
 * 用户原话：「加一个每次 Saki 视频审核通过之后自动向 1 档群转发视频链接，和 b 站视频分享一样」
 *
 * ## 为什么要轮询，不能投完就发
 *   B站投稿成功 ≠ 能看：刚投的稿件 `state` 是 **0（审核中）**，通过才变 **1**。
 *   投完立刻发出去，群友点开看到的是「该视频正在审核中」✗
 *   ⇒ 每 3 分钟查一次 `x/web-interface/view` 的 `state`，**等于 1 才发** ✓
 *
 * ## 样式（和 `bili-share.js` 一模一样）
 *   `【标题】 https://www.bilibili.com/video/BV…/?share_source=copy_web`
 *   ⚠️ 卡片那条路 QQ 已经封了（「发送者版本过低，无法展示内容」）⇒ 只发链接 + 标题 ✓
 *   ⚠️ `vd_source` 不抄（那是每个人自己的分享追踪码）✓
 *
 * ## 发到哪些群
 *   **1 档群**（`trigger.groupRespondTo[gid] === 1`，且在 `allowGroups` 里）——
 *   跟 `life.isEventGroup()` 同一个判据，别另立标准 ✓
 *
 * ## 兜底
 *   · 12 小时还没过审 ⇒ 放弃（记日志），别永远挂着
 *   · 发过就 `done: true`，**不会重复发** ✓
 */
export async function shareTick(bot) {
  if (!bot) return;
  const st = loadState();
  const list = Array.isArray(st.pendingShare) ? st.pendingShare : [];
  const todo = list.filter((x) => x && !x.done && x.bvid);
  if (!todo.length) return;

  const lv = config.trigger?.groupRespondTo ?? {};
  const allow = (config.trigger?.allowGroups ?? []).map(String);
  const groups = Object.entries(lv)
    .filter(([g, v]) => Number(v) === 1 && (!allow.length || allow.includes(String(g))))
    .map(([g]) => String(g));
  if (!groups.length) {
    log.warn('[B站投稿] 有视频等着转发，可**一个 1 档群都没有** ⇒ 先跳过（去「群与触发」设档位）');
    return;
  }

  const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/203.0.113.10 Safari/537.36';
  let changed = false;

  for (const item of todo) {
    // 挂太久就放弃（12 小时还没过审，多半是没过 / 被退回）
    if (Date.now() - Number(item.at || 0) > 12 * 3600 * 1000) {
      item.done = true;
      item.why = '等了 12 小时还没过审 ⇒ 放弃';
      changed = true;
      log.warn(`[B站投稿] ${item.bvid} 等了 12 小时还没过审 ⇒ 这次不转了`);
      continue;
    }
    /* ⚠️⚠️ 2026-10-23 实测纠正：**别拿 `state === 1` 当"过审"的判据** ✗
     *    现场：昨天 23:19 那条（`BV1kYnH6QELt`）今天还查到 `state=0`，
     *    可它 `stat.view = 32` —— **已经有人在看了**，显然早就放出来了。
     *    ⇒ 这个接口的 `state` 并不是"审核状态"（或者对非本人一律给 0）
     *
     *    真正可靠的信号是**这个视频能不能被公开访问**：
     *      `code === 0` + `data.pages` 有内容 ⇒ 视频页能播 ✓
     *      还在审的稿件，这个接口通常 `code` 是 `-404/-403`，`data` 为空 ✗
     *
     *    ⚠️ 再加一道**时间闸**：投稿后先等 **10 分钟**再开始查 ——
     *      B站现在是"先发后审"，刚传上去就能查到，立刻转发可能在转码/审核窗口里 ✓
     */
    if (Date.now() - Number(item.at || 0) < 10 * 60 * 1000) continue;

    let playable = false;
    let seen = '';
    try {
      const r = await fetch(
        `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(item.bvid)}`,
        { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(15000) },
      );
      const j = await r.json();
      const d = j?.data;
      playable = Number(j?.code) === 0 && Array.isArray(d?.pages) && d.pages.length > 0;
      seen = `code=${j?.code} pages=${Array.isArray(d?.pages) ? d.pages.length : '-'} view=${d?.stat?.view ?? '-'}`;
    } catch (e) {
      playable = false;
      seen = `查询失败：${e.message}`;
    }
    item.tries = (Number(item.tries) || 0) + 1;
    changed = true;

    if (!playable) {
      // ⚠️ 只在前几次和之后每 20 次打日志（不然每 3 分钟一条，日志会被刷满）
      if (item.tries <= 3 || item.tries % 20 === 0) {
        log.info(`[B站投稿] ${item.bvid} 还看不到（${seen}，第 ${item.tries} 次）⇒ 继续等`);
      }
      continue;
    }

    // ✅ 过审了 ⇒ 照 B站分享的样式发到每个 1 档群
    const url = `https://www.bilibili.com/video/${item.bvid}/?share_source=copy_web`;
    const msg = `【${item.title || '新视频'}】 ${url}`;
    let sentAny = false;
    for (const g of groups) {
      try {
        await bot.sendText({ message_type: 'group', group_id: g }, msg);
        sentAny = true;
        log.info(`[B站投稿] ✅ 审核通过 ⇒ 已转发到群 ${g}：${item.bvid}`);
      } catch (e) {
        log.warn(`[B站投稿] 转发到群 ${g} 失败：${e.message}`);
      }
      // ⚠️ 群之间隔一下，别一口气全发出去（看着像刷屏）
      await new Promise((r) => setTimeout(r, 800 + Math.random() * 1200));
    }
    if (sentAny) {
      item.done = true;
      item.sharedAt = Date.now();
    }
  }

  if (changed) saveState({ ...st, pendingShare: list });
}

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
