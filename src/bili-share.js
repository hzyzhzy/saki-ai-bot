/**
 * B 站视频分享（2026-10-15 用户要求）。
 *
 * 用户原话：
 *   「这个插件可以让 bot 也能看到 b 站视频，或者能自己分享视频吗」
 *   →「**A**（只发链接，让 QQ 自己展开），**先直接抓 b 站试试**」
 *   →「在发视频频率设置那里加个**看的视频的关键词**，要不然容易转群友都不感兴趣的视频」
 *   →「关键词是**列表**；**只在一档群发**，和日常事件一样有开启按钮，**默认关闭**」
 *   →「也加一个**立刻发送**按钮」
 *   →「**b站分享也要分群调节**」（← 2026-10-15 最后一条，本文件按这个改的）
 *
 * ## ⚠️ 参数**按群**（跟「日常事件」一套路子）
 *
 * 一律走 `paramsFor('biliShare', 群号)`：
 *   内置默认（`config.biliShare`）→ **`groupParams.<群>.biliShare` 的覆盖** ✓
 * 所以**每个群一套**：开关 / 关键词 / 每天条数 / 时段 / 冷却 / 概率 / 搜几条 ✓
 *
 * ⚠️ 状态（今天发了几条、上次何时发的）也**按群**记 —— 不然 A 群发了 B 群就发不了 ✗
 * ⚠️ 但"**发过哪些视频**"（去重池）是**共用**的 —— 同一条视频没必要发两个群 ✓
 *
 * ## ⚠️ 为什么是链接而不是卡片
 *
 * 2026-10-15 实测：`json` 段（小程序卡）和 `share` 段（链接卡）**协议端都回 ok**，
 * 但 QQ 那边显示「**发送者版本过低，无法展示内容**」⇒ 卡片这条路**被 QQ 封了** ✗
 * ⇒ 只能发**纯链接**（+ 官方样式的标题），让 QQ 自己决定要不要展开 ✓（用户选的 A 方案）
 *
 * ## ⚠️ 那"一句话"（一半概率）
 *
 * 用户：「一半概率会触发的 bot 自己对这个视频想说的话」+「**分条发送**」
 *   ⇒ **两条**：先她那句、隔一会儿再发「【标题】 链接」✓
 *   ⚠️ 想不出来 / 模型挂了 ⇒ **只发链接**（绝不发空消息）✓
 *
 * ## ⚠️ 限流（用户当初的顾虑）
 *
 * 用 `bilibili.js` 的 `topicVideos()` —— 走**搜索接口**，那边注释写明"**稳定可用**"
 * （会被限流的是 `space/arc` 那个）；它自带 `buvid3` 反风控 ✓
 * ⇒ 不需要额外做限流处理，但仍然**别太频**（每天 1 条的量 + 冷却）✓
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config, paramsFor, ROOT, stateDir } from './config.js';
import { log } from './log.js';

/** 这个群这一套参数（内置默认 + 按群覆盖）✓ */
function cfgFor(gid) {
  const p = paramsFor('biliShare', gid);
  return p && typeof p === 'object' ? p : {};
}

/** 有没有**任何一个**群开着（`index.js` 用它决定"要不要挂定时器"）✓ */
export function anyEnabled(groups = []) {
  const list = (Array.isArray(groups) ? groups : []).map(String).filter(Boolean);
  // ⚠️ 没传群就退回"号级那份开着吗"（老调用点 / 模拟面板都走这条）✓
  if (!list.length) return config.biliShare?.enable === true;
  return list.some((g) => cfgFor(g).enable === true);
}

/** 这个群的「B 站分享」开着吗 */
export function enabled(gid = '') {
  return cfgFor(gid).enable === true;
}

const STATE_FILE = process.env.QQBOT_BILI_SHARE_FILE
  ? join(ROOT, process.env.QQBOT_BILI_SHARE_FILE)
  : join(stateDir(), 'bili-share.json');

/**
 * 落盘的状态（重启不能忘）：
 *   · `by[群]` = { fired, target, lastAt } —— **按群**记今天几条 / 上次何时发的 ✓
 *   · `sent`  = 发过的 BV（**共用**去重池，最多留 80 条）✓
 */
let st = { day: '', by: {}, sent: [], recent: {} };

function load() {
  try {
    const j = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    st = {
      day: String(j?.day ?? ''),
      by: j?.by && typeof j.by === 'object' ? j.by : {},
      sent: Array.isArray(j?.sent) ? j.sent.map(String).slice(-80) : [],
      // ⚠️ 2026-10-15：按群记「刚分享过什么」（标题 / UP / 简介）
      recent: j?.recent && typeof j.recent === 'object' ? j.recent : {},
    };
  } catch {
    /* 第一次还没有 */
  }
}
function save() {
  try {
    mkdirSync(stateDir(), { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8');
    renameSync(tmp, STATE_FILE);
  } catch (e) {
    log.debug(`[B站分享] 状态写不进去：${e.message}`);
  }
}
load();

/** 某个群的状态格子（没有就建） */
function slot(gid, create = true) {
  const g = String(gid ?? '').trim();
  if (!g) return null;
  if (!st.by[g] && create) st.by[g] = { fired: 0, target: 0, lastAt: 0 };
  return st.by[g] ?? null;
}

function today(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 换天就把**所有群**的计数清掉（⚠️ 每次判定前都要调） */
function rollDay() {
  const t = today();
  if (st.day !== t) {
    st.day = t;
    for (const g of Object.keys(st.by)) {
      st.by[g].fired = 0;
      st.by[g].target = 0;
      st.by[g].lastAt = 0;
    }
    save();
  }
}

/** 这个群今天打算发几条（`minPerDay`~`maxPerDay` 随机，**一天只摇一次**） */
function targetToday(gid) {
  rollDay();
  const s = slot(gid);
  if (!s) return 0;
  if (s.target > 0) return s.target;
  const w = cfgFor(gid);
  const lo = Math.max(0, Number(w.minPerDay) || 0);
  const hi = Math.max(lo, Number(w.maxPerDay) ?? lo);
  s.target = hi > 0 ? lo + Math.floor(Math.random() * (hi - lo + 1)) : lo;
  save();
  return s.target;
}

/**
 * **这个群**现在该不该发（纯判定，不发东西 —— 方便套件测）。
 *
 * @returns {{due:boolean, why:string}}
 */
export function due(gid, now = Date.now()) {
  const g = String(gid ?? '').trim();
  if (!g) return { due: false, why: '没给群号' };
  if (!enabled(g)) return { due: false, why: '这个群没开' };
  rollDay();
  // ① 关键词是空的 ⇒ 没法挑（用户明确要求"要有关键词，否则会转群友不感兴趣的"）
  const kws = keywordsOf(g);
  if (!kws.length) return { due: false, why: '这个群没配关键词（配了才会发）' };
  // ② 今天够了没
  const want = targetToday(g);
  if (want <= 0) return { due: false, why: '这个群今天的条数是 0' };
  const s = slot(g);
  if (!s) return { due: false, why: '没状态' };
  if (s.fired >= want) return { due: false, why: `这个群今天已经发够 ${s.fired}/${want} 条` };
  // ③ 时段（默认 9~23 点；⚠️ 半夜不发）
  const w = cfgFor(g);
  const h = new Date(now).getHours();
  const lo = Math.min(23, Math.max(0, Number(w.startHour ?? 9) || 0));
  const hi = Math.min(24, Math.max(1, Number(w.endHour ?? 23) || 23));
  if (h < lo || h >= hi) return { due: false, why: `不在时段（${lo}~${hi} 点）` };
  // ④ 冷却（两条之间至少隔这么久，默认 4 小时；**按群**算）
  const cool = Math.max(0, Number(w.cooldownMs ?? 4 * 3600 * 1000) || 0);
  if (s.lastAt && now - s.lastAt < cool) {
    return { due: false, why: `冷却中（还要 ${Math.round((cool - (now - s.lastAt)) / 60000)} 分钟）` };
  }
  return { due: true, why: `该发（这个群今天第 ${s.fired + 1}/${want} 条）` };
}

/** 这个群的关键词列表（一行一个；也认逗号/顿号分隔）✓ 去空、去重、太短的丢掉 */
export function keywordsOf(gid = '') {
  const raw = cfgFor(gid).keywords;
  const arr = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\n,，、]/);
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = String(x ?? '').trim();
    // ⚠️ 去重这一步**必须和 `normalizeCfg` 一致** —— 不然"手写 yml 写重了"和
    //    "界面上填重了"会得到不一样的结果（套件【2】抓到的就是这个）✗
    if (k.length < 2 || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/** 所有**开着**并且**今天还没发够**的群（`index.js` 逐群看这个）✓ */
export function pendingGroups(groups = []) {
  return (Array.isArray(groups) ? groups : [])
    .map(String)
    .filter(Boolean)
    .filter((g) => due(g).due);
}

/**
 * 挑一条视频（关键词随机 ⇒ 搜 ⇒ **排除发过的** ⇒ 挑播放量最高的）。
 *
 * @returns {Promise<{title:string, up:string, play:number, url:string, bvid:string, keyword:string}|null>}
 */
export async function pick(gid = '') {
  if (pickerImpl) return pickerImpl(gid);
  return pickReal(gid);
}

/** ⚠️ 套件要能换掉"真去搜 B 站"这一步（不然跑套件会真打接口）✓ 和项目里别的模块一个路子 */
let pickerImpl = null;
export function __setPicker(fn) {
  pickerImpl = typeof fn === 'function' ? fn : null;
}

async function pickReal(gid = '') {
  const kws = keywordsOf(gid);
  if (!kws.length) return null;
  const w = cfgFor(gid);
  const bili = await import('./bilibili.js');
  // ⚠️ 打乱后依次试：某个关键词搜不到（或结果全发过）就换下一个 ✓
  const order = kws.slice().sort(() => Math.random() - 0.5);
  const limit = Math.max(4, Math.min(20, Number(w.maxResults ?? 8) || 8));
  const deny = w.deny ? new RegExp(String(w.deny)) : null;
  for (const kw of order) {
    try {
      const list = await bili.topicVideos(kw, { limit, deny });
      const fresh = list.filter((v) => v.url && !st.sent.includes(bvidOf(v.url)));
      if (!fresh.length) {
        log.info(`[B站分享] 「${kw}」搜到的都发过了，换下一个关键词`);
        continue;
      }
      // ⚠️ 挑**播放量最高的**那条（"播放量像样的" —— 太冷门的转过去群友没兴趣 ✗）
      fresh.sort((a, b) => b.play - a.play);
      const v = fresh[0];
      return {
        title: v.title,
        up: v.up,
        play: v.play,
        url: v.url,
        bvid: bvidOf(v.url),
        keyword: kw,
        // ⚠️ 2026-10-15（用户：「bot 要知道视频大概讲了什么」）—— 简介来自搜索接口，
        //    不用额外打 view 接口（见 bilibili.js 的 biliSearch）
        desc: String(v.desc ?? ''),
      };
    } catch (e) {
      log.warn(`[B站分享] 搜「${kw}」失败：${e.message}`);
    }
  }
  return null;
}

/** 从链接里抠出 BV 号（去重用） */
function bvidOf(url) {
  const m = /(BV[\w]{8,})/.exec(String(url ?? ''));
  return m ? m[1] : String(url ?? '');
}

/**
 * **她自己对这个视频想说的话**（2026-10-15 用户要求：「一半概率会触发」+「分条发送」）。
 *
 * @returns {Promise<string>} 没触发 / 想不出来 ⇒ `''`（那就只发链接那一条）✓
 */
async function myTake(gid, v) {
  const w = cfgFor(gid);
  const chance = Math.min(1, Math.max(0, Number(w.chance ?? 0.5)));
  if (chance <= 0) return '';
  if (Math.random() >= chance) return ''; // ⚠️ 一半概率触发（用户要的"有时候才说"✓）
  if (takeImpl) return takeImpl(gid, v); // 套件用
  try {
    const { phrase } = await import('./llm.js');
    let style = '';
    try {
      const persona = await import('./persona.js');
      style = String(persona.promptText?.('styleLine') ?? '');
    } catch {}
    const system = [
      '有个 QQ 群客服，刚在 B 站刷到一个视频，想把它**分享到群里**，先在群里**顺口说一句**她自己对这个视频的想法，等一下才把标题和链接贴出来。',
      style ? `\n她的说话风格（照这个来）：\n${style}` : '',
      '',
      '⚠️ 硬要求：',
      '- **一句话，12 个字以内** —— 就是随手打的那种，别长',
      '- 可以有态度：好笑 / 无语 / 感兴趣 / 看不上 / 吐槽，都行',
      '- 🚫 **别测评、别安利** —— 不要「值得一看」「强烈推荐」「这个视频讲了」这种',
      '- 🚫 别复述标题、别提"视频""播放量""我刷到""分享"这些字眼',
      '- 🚫 不加引号、不加书名号、不加表情符号，也不要写"我想说"',
      '- 只回那一句话本身，别的什么都别写 ✓',
    ]
      .filter((x) => x !== '')
      .join('\n');
    const user =
      `视频标题：${v.title}\nUP 主：${v.up}\n播放量：${v.play}\n` +
      (v.desc ? `简介：${v.desc}\n` : '') +
      `\n你打算把它**分享到群里给她们看**，先顺口说一句。`;
    const line = String((await phrase({ system, user, maxTokens: 60, timeoutMs: 8000 })) ?? '')
      .replace(/^["'「『]+|["'」』]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return line.slice(0, 40);
  } catch (e) {
    log.debug(`[B站分享] 想自己的话失败（那就只发链接）：${e.message}`);
    return '';
  }
}

/** ⚠️ 套件要能换掉"真去问模型"这一步（不然跑套件会真调模型）✓ */
let takeImpl = null;
export function __setTake(fn) {
  takeImpl = typeof fn === 'function' ? fn : null;
}

/**
 * 跑一次。
 *
 * · **定时那条路**（`force` 不给）：传进来的每个群**各判各的**，谁该发就发谁 ✓
 * · **界面上点「立刻发送」**（`force: true`）：跳过时段/冷却判定，**只发指定的那个群** ✓
 *   （仍然排除发过的、仍然记账 —— 手动发的也是"那个群今天的一条"）
 *
 * @param {object} bot
 * @param {string[]} groups 1 档群（**只在这些群里发**）
 * @param {{force?:boolean, groupId?:string}} [opts]
 * @returns {Promise<{sent:boolean, why:string, url?:string, gid?:string}>}
 */
export async function runOnce(bot, groups = [], { force = false, groupId = '' } = {}) {
  const list = (Array.isArray(groups) ? groups : []).map(String).filter(Boolean);

  // ① 界面上手动点发：**就发它选的那个群**（没给群号才从 1 档群里随便挑）✓
  if (force) {
    const gid = String(groupId ?? '').trim() || list[0] || '';
    if (!gid) return { sent: false, why: '没有 1 档群' };
    return await sendOne(bot, gid, { force: true });
  }

  // ② 定时：逐群看谁该发（顺序随机，免得永远先照顾排前面的群）✓
  if (!list.length) return { sent: false, why: '没有 1 档群' };
  const order = list.slice().sort(() => Math.random() - 0.5);
  let lastWhy = '今天都不用发';
  for (const gid of order) {
    const r = await sendOne(bot, gid, { force: false });
    if (r.sent) return r;
    lastWhy = r.why;
  }
  return { sent: false, why: lastWhy };
}

/** 给一个群发一条（判定 + 挑 + 发 + 记账） */
async function sendOne(bot, gid, { force = false } = {}) {
  const g = String(gid ?? '').trim();
  const d = force ? { due: true, why: '界面上手动点发' } : due(g);
  if (!d.due) return { sent: false, why: d.why, gid: g };

  const v = await pick(g);
  if (!v) return { sent: false, why: '没挑到能发的视频', gid: g };

  // ⚠️ 只发**链接 + 标题**（用户选的 A 方案 —— 卡片发不出去，见文件头那段实测）✗
  //
  // ⚠️⚠️ 2026-10-15 用户给了**真实样例**（他自己复制的一条 B 站分享）：
  //    「【余承东:尊界…】 https://www.bilibili.com/video/BV1ropy6HEGw/?share_source=copy_web&vd_source=4cc0…」
  //    ⇒ 两处照抄：
  //      ① 「**【标题】 链接**」这个样式 ✓
  //      ② 链接带上 **`?share_source=copy_web`** —— 那才是"复制来的分享"的样子 ✓
  //    ⚠️ **`vd_source` 不抄** —— 那是**用户个人**的分享追踪码（每个人不一样）✗

  // ⚠️⚠️ 用户：「再加一个**一半概率**会触发的 bot 自己对这个视频想说的话」+「**分条发送**」
  //    ⇒ **两条**：先一句她自己的话（像随手打的），隔一会儿再甩出「【标题】 链接」✓
  const take = await myTake(g, v);
  if (take) {
    try {
      await bot.sendText({ message_type: 'group', group_id: g }, take);
    } catch (e) {
      log.warn(`[B站分享] 那句想法没发出去（不影响发链接）：${e.message}`);
    }
    // ⚠️ 分条间隔：**像人打完一句再贴链接** —— 带随机抖动，别每次都一个数 ✓
    const gap = Math.max(300, Number(cfgFor(g).gapMs ?? 1500) || 1500);
    await new Promise((r) => setTimeout(r, gap * (0.7 + Math.random() * 0.6)));
  }

  const base = String(v.url ?? '');
  const shareUrl = base.includes('?')
    ? base
    : `${base}${base.endsWith('/') ? '' : '/'}?share_source=copy_web`;
  const text = `【${v.title}】 ${shareUrl}`;
  try {
    await bot.sendText({ message_type: 'group', group_id: g }, text);
  } catch (e) {
    log.warn(`[B站分享] 发到群 ${g} 失败：${e.message}`);
    return { sent: false, why: `发送失败：${e.message}`, gid: g };
  }
  const s = slot(g) ?? { fired: 0, target: 0, lastAt: 0 };
  s.fired += 1;
  s.lastAt = Date.now();
  st.sent = [...st.sent, v.bvid].slice(-80);
  // ⚠️⚠️ 2026-10-15 加（用户：「**bot 要知道她自己在分享视频，也要知道视频大概讲了什么**」）：
  //    把这次分享的内容按群记下来 —— 之后有人问「祥祥你发这个干嘛」，
  //    拼提示词时会通过 `shareNote()` 注入回去 ✓
  st.recent = {
    ...(st.recent ?? {}),
    [g]: {
      bvid: v.bvid,
      title: v.title,
      up: v.up,
      play: v.play,
      desc: String(v.desc ?? ''),
      at: Date.now(),
    },
  };
  save();
  log.info(
    `[B站分享] 群 ${g} 发了第 ${s.fired} 条（关键词「${v.keyword}」｜${v.up}｜${v.play} 播放）：${v.title}`,
  );
  return { sent: true, why: d.why, url: v.url, gid: g, title: v.title };
}

/** 状态（界面上那个"当天状态"用它 —— 按群看）✓ */
export function status(gid = '') {
  rollDay();
  const g = String(gid ?? '').trim();
  const s = g ? slot(g) : null;
  return {
    enable: g ? enabled(g) : config.biliShare?.enable === true,
    keywords: keywordsOf(g),
    fired: s?.fired ?? 0,
    target: g ? targetToday(g) : 0,
    sentCount: st.sent.length,
    lastAt: s?.lastAt ?? 0,
    next: g ? due(g) : { due: false, why: '没给群号' },
  };
}

export function __reset() {
  st = { day: '', by: {}, sent: [], recent: {} };
  save();
}

/**
 * **她刚刚在这个群里分享过什么**（2026-10-15 用户要求）。
 *
 * 用户原话：「**bot 要知道她自己在分享视频，也要知道视频大概讲了什么**」。
 * 起因：她在群里甩了条标着「爱祥」的链接，爱音跑来问「你发这个干嘛呀」，
 * 而她自己**不知道那条是自己分享的、也不知道视频讲的是什么** ✗
 *
 * @param {string} gid
 * @param {number} [withinMs] 多久之内算「刚刚」（默认 6 小时 —— 隔夜了就别再当「刚发的」）
 * @returns {{bvid:string,title:string,up:string,play:number,desc:string,at:number}|null}
 */
export function recentShareFor(gid = '', withinMs = 6 * 3600 * 1000) {
  const g = String(gid ?? '').trim();
  if (!g) return null;
  const r = st.recent?.[g];
  if (!r || !r.title) return null;
  if (Date.now() - Number(r.at ?? 0) > withinMs) return null;
  return r;
}

/** 上一轮 `warmBiliLinks()` 抓到的东西（同一轮内马上用，不跨轮） */
let _lastLinkInfo = [];

/**
 * 把这几段文字里的 B 站链接**先抓一遍**（2026-10-16 加）。
 *
 * 用户截图：「**saki 回应的有点不对，最好 saki 也去看一遍视频的大概再回**」——
 *   群里（群友 / 同类）甩链接时，她原来只知道"有个链接"，不知道视频讲什么 ⇒
 *   只能回「你笑点是不是有点低」这种没接内容的话 ✗
 *
 * ⚠️ **必须在拼提示词之前 await 它**（拼提示词那儿是同步的）。
 * ⚠️ 只抓**没缓存过的**、**只抓最新那一条**（⚠️ 别列多条 —— 用户：「不要对甩过来的视频**计数**，不像人类」✗） —— 它挡在回复前面，别把节奏拖住 ✗
 * ⚠️ 失败就算了（返回空，不影响回话）✓
 */
export async function warmBiliLinks(texts = []) {
  _lastLinkInfo = [];
  try {
    const bili = await import('./bilibili.js');
    const bvs = [];
    for (const t of Array.isArray(texts) ? texts : []) {
      for (const bv of bili.pickVideoIds(t)) if (!bvs.includes(bv)) bvs.push(bv);
      if (bvs.length >= 1) break;
    }
    for (const bv of bvs.slice(0, 1)) {
      const info = await bili.videoInfo(bv);
      if (info) _lastLinkInfo.push(info);
    }
  } catch (e) {
    log.debug(`[B站分享] 预热链接失败：${e.message}`);
  }
  return _lastLinkInfo;
}

/**
 * 把刚抓到的链接信息拼成一段提示词（没有就返回空串）。
 *
 * ⚠️ 跟 `shareNote()` 分工不同：那个说的是"**你自己**分享的"，
 *    这个说的是"**群里刚才那条链接**"（**谁发的都可能**）✓
 */
export function linkNote() {
  if (!_lastLinkInfo.length) return '';
  const lines = _lastLinkInfo.map((v) => {
    const bits = [`《${v.title}》`];
    if (v.up) bits.push(`UP：${v.up}`);
    if (v.desc) bits.push(`简介：${v.desc}`);
    return `- ${bits.join('｜')}`;
  });
  return [
    '',
    '## ⚠️ 群里刚才那条 B 站链接，**你点开看过了**',
    ...lines,
    '',
    '⚠️ 规矩：',
    '- 上面就是**那支视频大概是什么** —— 有人甩链接、或者聊到它的时候，**照这个接** ✓',
    '- 🚫 **别把简介念出来**、别逐条复述、也别写"视频简介说…"这种话 ✗',
    '- ✅ 就当你自己刷到过：可以评一句、可以吐槽、可以只接半句 —— 跟平时说话一样 ✓',
    '',
  ].join('\n');
}

/**
 * 把「你刚分享过这个视频」拼成一段提示词（没分享过就返回空串）。
 *
 * ⚠️ 三条讲究：
 *   · 点明**那是她自己发的** —— 不然她会当成「群友丢过来一条链接」；
 *   · 把**简介**给她 —— 有人问「这视频讲啥的」她答得上来；
 *   · 🚫 但**别让她复述简介** —— 她是随手分享、顺口聊两句，不是念说明书 ✓
 */
export function shareNote(gid = '') {
  const r = recentShareFor(gid);
  if (!r) return '';
  const mins = Math.max(1, Math.round((Date.now() - Number(r.at ?? 0)) / 60000));
  const ago = mins < 60 ? `${mins} 分钟前` : `${Math.round(mins / 60)} 小时前`;
  return [
    '',
    '## ⚠️ 你刚刚自己在这个群里分享过一个视频',
    `（${ago} —— 那条「**【标题】** + 链接」是**你自己**发的，不是群友发的）`,
    `- 标题：${r.title}`,
    r.up ? `- UP 主：${r.up}` : '',
    r.desc ? `- 简介（这视频大概讲什么）：${r.desc}` : '- 简介：这个视频没写简介',
    '',
    '⚠️ 规矩：',
    '- 那是**你自己**分享的（刷到个东西顺手甩群里）—— 别问「谁发的」「这是什么」✗',
    '- 有人问起，就**照上面那点内容**说一句，或者照你的性格含糊过去；',
    '- 🚫 **别复述简介原文**、别安利、别一本正经点评；跟平时在群里说话一个样子 ✓',
    '',
  ]
    .filter((x) => x !== '')
    .join('\n');
}

/**
 * 界面上填的那些值 ⇒ **规范化之后的配置**（夹取范围 + 去空去重）。
 *
 * ⚠️ 抽出来放这儿（而不是写在 webui 里）的理由：**界面和配置文件两条路要同一套规矩** ——
 *    否则手写 yml 的人能填出界面填不出来的值（比如 `maxPerDay: 999`）✗
 *
 * @param {object} body 界面发来的原始值
 * @returns {object} 可以直接写进 `groupParams.<群>.biliShare` 的覆盖项
 */
export function normalizeCfg(body = {}) {
  const b = body && typeof body === 'object' ? body : {};
  // 关键词：数组 / 字符串（换行、逗号、顿号都认）⇒ 去空、去重、封顶 30 个
  const rawKw = Array.isArray(b.keywords) ? b.keywords : String(b.keywords ?? '').split(/[\n,，、]/);
  const seen = new Set();
  const keywords = [];
  for (const x of rawKw) {
    const k = String(x ?? '').trim();
    if (k.length < 2 || k.length > 40 || seen.has(k)) continue;
    seen.add(k);
    keywords.push(k);
    if (keywords.length >= 30) break;
  }
  const num = (v, lo, hi, dflt) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, Math.round(n)));
  };
  let lo = num(b.minPerDay, 0, 20, 1);
  let hi = num(b.maxPerDay, 0, 20, 1);
  if (hi < lo) [lo, hi] = [hi, lo]; // 写反了也不倒着算 ✓
  let sh = num(b.startHour, 0, 23, 9);
  let eh = num(b.endHour, 1, 24, 23);
  if (eh <= sh) eh = Math.min(24, sh + 1);
  return {
    enable: b.enable === true,
    keywords,
    minPerDay: lo,
    maxPerDay: hi,
    startHour: sh,
    endHour: eh,
    // 冷却：最短 10 分钟（再短就是刷屏了），最长 24 小时
    cooldownMs: num(b.cooldownMinutes, 10, 1440, 240) * 60 * 1000,
    maxResults: num(b.maxResults, 4, 20, 8),
    // ⚠️ 界面上填的是**百分比**（0~100），存的是 0~1 ✓（用户说的"一半概率"= 50）
    chance: num(b.chancePercent, 0, 100, 50) / 100,
    deny: String(b.deny ?? '').trim().slice(0, 80),
  };
}

/** 给界面看的**可编辑值**（冷却换算成分钟 —— 界面上填分钟比填毫秒友好）✓ 按群 */
export function uiCfg(gid = '') {
  const w = cfgFor(gid);
  return {
    enable: w.enable === true,
    keywords: keywordsOf(gid),
    minPerDay: Number(w.minPerDay ?? 1),
    maxPerDay: Number(w.maxPerDay ?? 1),
    startHour: Number(w.startHour ?? 9),
    endHour: Number(w.endHour ?? 23),
    cooldownMinutes: Math.round(Number(w.cooldownMs ?? 4 * 3600 * 1000) / 60000),
    maxResults: Number(w.maxResults ?? 8),
    chancePercent: Math.round(Math.min(1, Math.max(0, Number(w.chance ?? 0.5))) * 100),
    deny: String(w.deny ?? ''),
  };
}
