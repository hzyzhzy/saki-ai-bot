/**
 * 一级随机事件 —— 「祥子今天身上发生的一件小事」。
 *
 * ## 它在这一整套里的位置
 *
 * ```
 * life-events.md（可编辑的事件库 + 时段表）
 *        ↓  按**当前时段**抽一条
 *   plan()   排程：随机 + 冷却 + 每天上限 + 0-7 点不发
 *        ↓
 *   compose()  交给模型，按人设 + **最近的故事线**说成一句群消息
 *        ↓
 *   commit()   记已发 + 排下一次；同时把这件事写进 storyline
 * ```
 *
 * ## 三条设计约束（都不是随手定的）
 *
 * **① 事件库只写「发生了什么」，不写台词。**
 *    这个项目踩过一次：提示词里放了例句，模型逐字抄（TODO 的 K 节）。
 *
 * **② 节奏是「随机 + 冷却」，不是纯随机**（用户 2026-09-15 明确补的）。
 *    纯随机撒点会撞出两条隔八分钟的消息 —— 那比定时还假。
 *    所以：每天先定目标条数 → 在允许时段里**分段随机**取点 →
 *    且**两条之间强制最小间隔**（`cooldownMs`，默认 90 分钟）。
 *
 * **③ 掉线期间不许"迟到补发"。**
 *    这个号每几小时就被踢一次（实测 09-13 / 09-14 各 6 次），
 *    而"午饭被偷"这件事在晚上十点发出来非常怪。
 *    所以错过超过 `lateToleranceMs`（默认 30 分钟）就**直接跳过、重排**。
 *
 * ## 落盘
 *
 * `state/life.json`（`QQBOT_LIFE_FILE` 可改，测试用），原子写。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config, ROOT, KNOWLEDGE_DIR, paramsFor } from './config.js';
import { log } from './log.js';
import { phrase } from './llm.js';
import * as storyline from './storyline.js';
import * as holiday from './holiday.js';
import { personaText, castBlock, personaDataFile } from './knowledge.js';
import * as persona from './persona.js';

// ⚠️ 2026-09-21：事件库是**角色专属**的（换个角色"今天遇到什么事"完全不同），
//    所以跟着人设包走（`personas/<id>/life-events.md`）。
//    `personaDataFile()` = 人设包优先、共用 `knowledge/` 回落。
const FILE = personaDataFile('life-events.md');

const STATE_FILE = process.env.QQBOT_LIFE_FILE
  ? join(ROOT, process.env.QQBOT_LIFE_FILE)
  : join(ROOT, 'state', 'life.json');

// ─────────────────────────────────────────────────────────────
// 事件库解析
// ─────────────────────────────────────────────────────────────

/** @type {Array<{name:string, startMin:number, endMin:number, templates:Array<{w:number,text:string,tags:string[]}>}>} */
let slots = [];
let loadedAt = 0;

/** 把 `HH:MM` 变成"当天第几分钟" */
function toMin(hh, mm) {
  return Number(hh) * 60 + Number(mm);
}

/**
 * 解析 `knowledge/life-events.md`。
 *
 * 只认两种行（其余一律忽略，所以你可以在里面随便写注释）：
 *   `### 名字 07:00-09:00`        ← 时段
 *   `- 权重 | 事件内容 #标签`      ← 事件（权重 1-5，`#标签` 可有可无、可多个）
 */
export function parse(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('>') || line.startsWith('<!--')) continue;
    if (line.startsWith('<!--')) continue;

    const h = /^#{3,4}\s*(.+?)\s+(\d{1,2}):(\d{2})\s*[-~～]\s*(\d{1,2}):(\d{2})\s*$/.exec(line);
    if (h) {
      cur = {
        name: h[1].trim(),
        startMin: toMin(h[2], h[3]),
        endMin: toMin(h[4], h[5]),
        templates: [],
      };
      // ⚠️ 24:00 收尾 → 1440 分钟，正常
      if (cur.endMin <= cur.startMin) cur.endMin = 24 * 60;
      out.push(cur);
      continue;
    }
    const t = /^-\s*(?:\[(\d)\]|(\d))\s*\|\s*(.+)$/.exec(line);
    if (t && cur) {
      let body = t[3].trim();
      const tags = [];
      body = body.replace(/#([^\s#|]+)/g, (_, tag) => {
        tags.push(String(tag));
        return '';
      });
      body = body.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!body) continue;
      const w = Math.min(5, Math.max(1, Number(t[1] ?? t[2]) || 1));
      cur.templates.push({ w, text: body, tags });
    }
  }
  return out.filter((s) => s.templates.length);
}

/** 读盘（知识库热重载后由 `reload()` 调） */
export function reload() {
  try {
    slots = parse(readFileSync(FILE, 'utf8'));
    loadedAt = Date.now();
    log.debug(
      `日常事件库：${slots.length} 个时段 / ${slots.reduce((n, s) => n + s.templates.length, 0)} 条事件`,
    );
  } catch (e) {
    log.warn(`日常事件库读不到（${e.message}），一级事件将不发`);
    slots = [];
  }
  // 节日表跟着一起重载（两个都是知识库文件，改完一起生效）
  try {
    holiday.reload();
  } catch (e) {
    log.debug(`节日表重载失败：${e.message}`);
  }
}

/**
 * **预览一条**（<主人> 2026-09-15：「日常事件也加一个预览和立即发送」）。
 *
 * ⚠️ 和 `plan()` 的区别：**完全不碰状态** —— 不掷今天的计划、不排下次时间、
 *    不记账、不写故事线。它只是"按现在这个时段抽一条、润色出来给你看"。
 * ⚠️ 会**调一次模型**（润色那一步），所以界面上要写清楚。
 *
 * @param {number} [now]
 * @returns {Promise<{ok:boolean, reason?:string, slot?:string, event?:string, text?:string, unclean?:boolean}>}
 */
export async function preview(now = Date.now(), groupId = '') {
  const gid = gkOf(groupId);
  if (cfgFor(gid).enable === false) return { ok: false, reason: '这个群的日常事件没开' };
  const slot = slotAt(now);
  if (!slot) return { ok: false, reason: '现在这个时刻没有对应时段（0-7 点不发）' };
  const { pool, off, holidayEvents } = poolFor(slot, now, gid);
  if (!pool.length) return { ok: false, reason: `「${slot.name}」这个时段没有可用事件` };
  const tpl = pickFrom(pool, Math.random);
  let text = '';
  try {
    text = await compose({ template: tpl, slot: slot.name, off, holidayEvents });
  } catch (e) {
    log.debug(`预览润色失败：${e.message}`);
  }
  return {
    ok: true,
    slot: slot.name,
    event: tpl.text,
    // 润色失败就退回事件原文（和真发时一样，别让预览看起来"坏了"）
    text: text || tpl.text,
    /** 这条是"没润色成功、用的原文"吗（界面上标一下） */
    unclean: !text,
  };
}

export function templateCount() {
  return slots.reduce((n, s) => n + s.templates.length, 0);
}

/** 现在落在哪个时段（`HH:MM` 边界：start ≤ now < end） */
export function slotAt(now = Date.now()) {
  const d = new Date(now);
  const m = toMin(d.getHours(), d.getMinutes());
  return slots.find((s) => m >= s.startMin && m < s.endMin) ?? null;
}

/** 按时段权重抽一条（`rng` 可注入，测试用） */
function pickTemplate(slot, rng) {
  const total = slot.templates.reduce((n, t) => n + t.w, 0);
  let r = rng() * total;
  for (const t of slot.templates) {
    r -= t.w;
    if (r <= 0) return t;
  }
  return slot.templates[slot.templates.length - 1];
}

/**
 * 今天能用的候选事件 = 当前时段的日常事件 **±** 节日专属事件。
 *
 * 三条规则：
 *  1. **放假的日子**（`holiday.on().off`）→ 屏蔽 `#学校` / `#通勤`，
 *     不然会出现"放假还去上课"。
 *  2. 节日的**专属事件**按权重一起进池子（它们会带上节日名当标签，
 *     所以以后能顺着故事线关联到"上次元日我在店里加班"）。
 *  3. 中国节日**不进池子** —— 她不会自己过（见 holiday.js 顶部）。
 */
function poolFor(slot, now, gid = '') {
  let pool = slot.templates.slice();
  let off = false;
  let events = [];
  try {
    // ⚠️ 2026-09-16：「节日生效」也**按群**（全局那张卡删了，界面上在「按群设定」里设）。
    //    `holiday.enabled()` 保留当总闸（config.life.holidays，默认开）。
    if (cfgFor(gid).holidays !== false && holiday.enabled()) {
      const h = holiday.on(now);
      off = h.off;
      events = h.events ?? [];
      if (off) {
        const before = pool.length;
        pool = pool.filter((t) => !t.tags.some((x) => x === '学校' || x === '通勤'));
        if (pool.length < before) log.debug(`[日常] 今天放假，屏蔽了 ${before - pool.length} 条学校/通勤事件`);
      }
      pool = pool.concat(events);
    }
  } catch (e) {
    log.debug(`节日判断失败（当普通日子）：${e.message}`);
  }
  // 全被屏蔽完了（比如早上只有学校/通勤）→ 退回原始池子，宁可出得普通也别不出
  if (!pool.length) pool = slot.templates.slice();
  return { pool, off, holidayEvents: events.length };
}

/** 按权重从池子里抽一条 */
function pickFrom(pool, rng) {
  const total = pool.reduce((n, t) => n + t.w, 0);
  let r = rng() * total;
  for (const t of pool) {
    r -= t.w;
    if (r <= 0) return t;
  }
  return pool[pool.length - 1];
}

// ─────────────────────────────────────────────────────────────
// 状态（⚠️ 2026-09-16 起 **按群分桶**）
// ─────────────────────────────────────────────────────────────
//
// 用户要求：「把日常事件的节奏设置和二级事件的参数也加一个下拉群菜单分群调节，
//   …**不同群的数据一定不要混在一起**」。
//
// 所以：**每个群各有自己的** `{ day, target, fired, lastFireAt, nextAt, recent }` ——
//   · 参数（每天几条、两条之间隔多久、时段）走 `paramsFor('life', 群号)`
//   · 计数 / 排程 **各群各算**（A 群发过一条，不该让 B 群少发一条）
// ⚠️ 没给群号时落到 `''` 这个桶（老用法 / 测试），语义和 `quest.js` 的 `gbucket('')` 一致。

const stats = { fired: 0, skipped: 0, lastError: '', lastFireAt: 0 };

const emptyBucket = () => ({ day: '', target: 0, fired: 0, lastFireAt: 0, nextAt: 0, recent: [] });
/** 群号 → 状态桶 */
let buckets = new Map();

const gkOf = (gid) => String(gid ?? '').trim();

function readBucket(v) {
  return {
    day: String(v?.day ?? ''),
    target: Number(v?.target) || 0,
    fired: Number(v?.fired) || 0,
    lastFireAt: Number(v?.lastFireAt) || 0,
    nextAt: Number(v?.nextAt) || 0,
    recent: Array.isArray(v?.recent) ? v.recent.slice(-20) : [],
  };
}

/** 拿某个群的状态桶（`create` 时会顺手建一个） */
function bucketOf(gid, create = false) {
  const k = gkOf(gid);
  let b = buckets.get(k);
  if (!b && create) {
    b = emptyBucket();
    buckets.set(k, b);
  }
  return b ?? null;
}

function loadState() {
  try {
    if (!existsSync(STATE_FILE)) return;
    const j = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (j?.byGroup && typeof j.byGroup === 'object') {
      buckets = new Map(Object.entries(j.byGroup).map(([k, v]) => [String(k), readBucket(v)]));
      return;
    }
    // ⚠️⚠️ 老形状（分群之前）：顶层就是那一份状态，而且当时是**所有 1 档群共用**的
    //    —— 同一件事一次性发到所有群，这里只记一次。
    //    所以迁移时要**复制给每个 1 档群**（而不是只留一份）：
    //    不然分群之后每个群都从 0 开始，今天会一口气补发好几轮。
    const old = readBucket(j);
    if (!old.day && !old.fired) return;
    buckets.set('', old);
    for (const g of targetGroups()) buckets.set(g, { ...old, recent: [...(old.recent ?? [])] });
    // 老文件备份一份（和好感度分群时一个套路）
    try {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      writeFileSync(
        join(ROOT, 'state', `life.备份-分群前-${stamp}.json`),
        JSON.stringify(j, null, 2),
        'utf8',
      );
    } catch {}
    log.info(
      `[日常] 状态从"全局一份"迁到**分群**：${buckets.size} 个桶` +
        '（1 档群各继承了今天的进度，不会重复发）',
    );
    save();
  } catch (e) {
    log.debug(`一级事件状态读取失败（当作空的）：${e.message}`);
  }
}

function save() {
  try {
    mkdirSync(join(ROOT, 'state'), { recursive: true });
    const byGroup = {};
    for (const [k, b] of buckets) byGroup[k] = b;
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ byGroup }, null, 2), 'utf8');
    renameSync(tmp, STATE_FILE);
  } catch (e) {
    log.warn(`一级事件状态写盘失败：${e.message}`);
  }
}

/**
 * **这个群**的日常事件参数 = 内置默认 + `groupParams["<群号>"].life` 的覆盖。
 *
 * ⚠️⚠️ 分群参数**必须走这里**。直接读 `config.life` 的话，界面上按群设的值
 *    一个都不会生效（用户 2026-09-16 专门强调：「修改的参数**一定要能真正保存**」）。
 */
const cfgFor = (gid) => paramsFor('life', gid);
/** 没指定群时的参数（老用法；就是内置默认那套） */
const cfg = () => config.life ?? {};
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** 当天 00:00 的时间戳 */
function dayStart(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayKey(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 允许发消息的时间窗（默认 07:00 - 次日 00:00） */
function windowOf(now, gid) {
  const c = cfgFor(gid);
  const s = dayStart(now);
  return {
    start: s + num(c.startHour, 7) * 3600000,
    end: s + num(c.endHour, 24) * 3600000,
  };
}

const cooldownMs = (gid) => Math.max(60000, num(cfgFor(gid).cooldownMs, 90 * 60 * 1000));
const lateToleranceMs = (gid) => Math.max(0, num(cfgFor(gid).lateToleranceMs, 30 * 60 * 1000));

/** 新的一天：定今天的目标条数（min~max 随机），清计数（⚠️ **只动这个群自己的桶**） */
function rollDay(day, now, rng, gid) {
  const c = cfgFor(gid);
  const lo = Math.max(1, num(c.minPerDay, 3));
  const hi = Math.max(lo, num(c.maxPerDay, 5));
  const b = bucketOf(gid, true);
  const recent = b.recent ?? [];
  Object.assign(b, {
    day,
    target: lo + Math.floor(rng() * (hi - lo + 1)),
    fired: 0,
    lastFireAt: 0,
    nextAt: 0,
    recent,
  });
  log.debug(`[日常] ${gkOf(gid) || '(没指定群)'} 新的一天 ${day}：今天计划发 ${b.target} 条`);
}

/**
 * 排下一个时间点。
 *
 * ⚠️ 这是「**随机 + 冷却**」的核心：
 *   · 下界取 max(现在, 上次+冷却, 时段开始) ← **冷却在这里强制生效**
 *   · 上界取"下界 + 剩余窗口/剩余条数" ← **分段随机**，所以不会全挤到最后
 *   · 中间均匀取一个随机数 ← 所以**不是计划表**
 */
function pickNext(now, rng, gid) {
  const b = bucketOf(gid, true);
  const { start, end } = windowOf(now, gid);
  const remaining = Math.max(1, b.target - b.fired);
  const cd = cooldownMs(gid);
  const lo = Math.max(now, (b.lastFireAt || 0) + cd, start);
  // ⚠️⚠️ 最后一条别贴着午夜发（2026-09-15 修）。
  //
  //    踩过的真 bug：原来上界是 `end`，于是最后一条可能被随机推到 23:59 ——
  //    而定时器每 5 分钟才 tick 一次，午夜前的那几次 tick 接不住它，
  //    到 00:00 又出了窗口 → **"今天目标 3 条，实际只发了 2 条"**（回归里 12 天崩了 1 天）。
  //
  //    修法：**最后一条最晚发在「午夜前一个冷却」**（默认 90 分钟 → 22:30）。
  //    这也更自然 —— 没人会在半夜十一点五十九发自己今天的生活。
  const latest = end - cd;
  if (latest <= lo) return end; // 今天实在放不下了（冷却比窗口还长这类极端配置）
  const span = Math.max(60000, (latest - lo) / remaining);
  const hi = Math.min(latest, lo + span);
  return Math.floor(lo + rng() * Math.max(1, hi - lo));
}

/**
 * 把「今天的目标条数」夹回**当前配置**的 [minPerDay, maxPerDay]。
 *
 * ⚠️⚠️ 2026-09-16 加的（用户报的真问题）：
 *   「为什么我改成日常事件每日3条，**现在还是6条**」
 *
 * 根因：当天的计划条数（`b.target`）是**当天第一次检查时随机定下并落盘的**
 * （`rollDay()`），而 `plan()` 只在"跨天"时才重新定 ——
 * 于是**改配置当天完全不生效，要等第二天**。用户看着就是"改了没用"。
 *
 * 修法：每次检查（以及界面查状态）都把 target 夹回当前配置范围：
 *   · **调小 → 立刻压下来**（他改小就是因为嫌吵，要马上安静）
 *   · 调大 → 只在低于下界时才提，不因为改配置就打乱今天的节奏
 *   · 已经发够了（`fired >= target`）→ `plan()` 那边自然就"今天发完了"
 *
 * @returns {boolean} 有没有真的改（没改就是 `false`，不写盘、不打日志）
 */
export function syncTarget(groupId = '') {
  const c = cfgFor(groupId);
  const b = bucketOf(groupId, true);
  const lo = Math.max(1, num(c.minPerDay, 3));
  const hi = Math.max(lo, num(c.maxPerDay, 5));
  const cur = Math.max(1, num(b.target, lo));
  const next = Math.min(Math.max(cur, lo), hi);
  if (next === cur) return false;
  b.target = next;
  save();
  log.info(
    `[日常] ${gkOf(groupId) || '(没指定群)'} 配置改了：**今天**的目标条数 ${cur} → ${next} 条` +
      `（现在的配置是 ${lo}~${hi} 条/天；已发 ${b.fired} 条）`,
  );
  return true;
}

/**
 * 到点了吗？（⚠️ **按群各问各的** —— 每个群一套参数、一套计数、一套排程）
 *
 * @param {number} [now]
 * @param {() => number} [rng] 可注入（测试用固定序列）
 * @param {string} [groupId] 哪个群；不给 = `''` 那个桶（老用法/测试）
 * @returns {{fire:boolean, reason:string, template?:object, slot?:string, nextAt?:number}}
 */
export function plan(now = Date.now(), rng = Math.random, groupId = '') {
  const gid = gkOf(groupId);
  const b = bucketOf(gid, true);
  if (cfgFor(gid).enable === false) return { fire: false, reason: '日常事件没开' };
  if (!slots.length) return { fire: false, reason: '事件库是空的（知识库没读到）' };

  const day = dayKey(now);
  if (b.day !== day) rollDay(day, now, rng, gid);
  // ⚠️ 改了配置要**当天立刻生效**（2026-09-16 用户报的「改成 3 还是 6 条」）
  syncTarget(gid);

  const { start, end } = windowOf(now, gid);
  if (now < start || now >= end) {
    // 0-7 点完全不发（用户明确要求）
    return {
      fire: false,
      reason: `不在允许时段（${num(cfgFor(gid).startHour, 7)}:00 才开始）`,
      nextAt: 0,
    };
  }
  if (b.fired >= b.target) {
    return { fire: false, reason: '今天的条数已经发完了', nextAt: 0 };
  }

  if (!b.nextAt) {
    b.nextAt = pickNext(now, rng, gid);
    save();
  }
  if (now < b.nextAt) {
    return { fire: false, reason: '还没到点', nextAt: b.nextAt };
  }
  // ★ 迟到了就跳过，不补发 —— 免得"午饭被偷"在半夜发出来
  if (now - b.nextAt > lateToleranceMs(gid)) {
    b.skipped = (b.skipped || 0) + 1;
    stats.skipped++;
    b.nextAt = pickNext(now, rng, gid);
    save();
    return { fire: false, reason: '错过了，跳过（不补发）', nextAt: b.nextAt };
  }

  const slot = slotAt(now);
  if (!slot) return { fire: false, reason: '现在这个时刻没有对应时段', nextAt: b.nextAt };

  const { pool, off, holidayEvents } = poolFor(slot, now, gid);
  return {
    fire: true,
    reason: '',
    groupId: gid,
    slot: slot.name,
    template: pickFrom(pool, rng),
    off,
    holidayEvents,
    nextAt: 0,
  };
}

/**
 * 润色成祥子的一句话（**失败返回空串**，调用方退回事件原文）。
 *
 * ⚠️⚠️ 关联往事那一段是「群友的话能影响以后」的落点：
 *    群友教她"外卖改个地址"会被写进故事线（带同一个 `#外卖` 标签），
 *    下次再抽到外卖事件时，这段往事就跟着进提示词 ——
 *    于是模型会写成"改了地址又被偷"，而不是把同一件事重演一遍。
 */
export async function compose(planObj, extra = {}) {
  const tpl = planObj?.template;
  if (!tpl) return '';
  const related = relatedPast(tpl, 4);

  // ⚠️ 2026-09-15：事件里点名了谁，就把谁那一段设定补进提示词。
  //    用户反馈「故事几乎全部都是祥子一个人的」—— 事件文本里写了「睦」「初华」，
  //    但提示词里没有这些人的任何资料，模型只能保守地写成独白。
  //    这里按需注入（**不是**把人设全书塞进去），所以提示词不会涨太多。
  let cast = '';
  try {
    cast = castBlock(tpl.text);
  } catch (e) {
    log.debug(`取出场人物失败：${e.message}`);
  }

  // 今天是什么日子（节日专属事件会带上 `holiday` 字段）
  let todayLine = '';
  try {
    if (holiday.enabled()) {
      const h = holiday.on();
      const isHol = tpl.holiday || (h.local.length && (planObj?.holidayEvents ?? 0) > 0);
      if (isHol || h.noteText) {
        const bits = [];
        if (tpl.holiday) bits.push(`今天是${tpl.holiday}`);
        else if (h.names.length) bits.push(`今天是${h.names.join('、')}`);
        if (h.off) bits.push('（放假，不用上学）');
        if (h.noteText) bits.push(h.noteText);
        todayLine = bits.join('，');
      }
    }
  } catch (e) {
    log.debug(`节日上下文失败：${e.message}`);
  }

  const lines = [
    todayLine ? `今天是：${todayLine}` : '',
    `今天发生的事：${tpl.text}`,
    // ⚠️ 2026-09-15：**别把这个时段提示当句子开头用**。
    //    实测它会把模型带成「下午房东来催房租，回了句知道了」这种
    //    —— 以时间开头、而且**把主语省掉了**（读起来像房东回的话）。
    planObj.slot ? `（时间段：${planObj.slot} —— 只是告诉你这事发生在什么时候，**别拿它当句子开头**）` : '',
    cast
      ? `\n⚠️ **这件事里出场的人**（是你认识的人，按下面的设定来，别写得像陌生人）：\n${cast}`
      : '',
    related.length
      ? `\n⚠️ 和这件事**有关联的往事**（你记得，要体现出前后呼应，别当成第一次）：\n${related
          .map((e) => `· ${e.text}`)
          .join('\n')}`
      : '',
    // ⚠️⚠️ 2026-09-18 加（用户截图：「为什么感觉这个事件有点怪」）：
    //    事件库那条只写了「放学直接去打工，校服都没换」，她扩写成
    //    「围裙一系就开工，**粉笔灰**还在袖口上」——**围裙**（她的工作场所是客服室，
    //    不是后厨/食堂）、**粉笔灰**（那是老师的画风）**全是模型自己加的**，
    //    而且跟人设打架。所以钉一条：事件里没写的东西，别自己补。
    // ⚠️⚠️ 2026-09-18 加（用户截图：她发了一条一级事件「隔了一条马路，立希在对面，
    //    两个人谁也没停」，群友回「不相干」，她答「**行，我编的**，你还真回头核对（」）。
    //    ⚠️ 一级事件是**她今天真的经历的小事**（系统按当前时段抽的）——
    //    设定上**真发生过**，所以**不许说"我编的"**：那既否定了她自己的经历，
    //    也会让群友觉得"原来她说的都是编的"，人设直接塌。
    '⚠️⚠️ **这件事是真的发生过的**（就在今天、那个时段）—— 所以：',
    '   · 🚫 **绝不许说「我编的」「我瞎说的」「随便说的」** —— 那是自己拆自己的台；',
    '   · 群友说「不相干」「这跟刚才聊的没关系」只是在说**话题跳了** ——',
    '     可以「嗯」一声、可以嘴硬（「谁说一定要有关系」）、也可以不理，**但别认成"我编的"**；',
    '   · 被追问细节就照实说（不知道的部分就说不知道），**别改口**。',
    '⚠️ **别自己往上加职业 / 场景的细节**：她的打工地点就是**客服室**（接单、回消息、排班），' +
      '不是后厨、食堂那类地方 —— 所以**别写围裙、餐盘、粉笔灰、讲台**这些。' +
      '事件里没提到的东西就别补；实在要写环境，就写客服室里的桌子、屏幕、排班表。',
    extra.extraHint ? `\n${extra.extraHint}` : '',
  ].filter(Boolean);

  return phrase({
    system: extra.system ?? buildSystem(),
    user: lines.join('\n'),
    maxTokens: 260,
    timeoutMs: 25000,
  });
}

/**
 * 拼这个调用用的 system。
 *
 * ⚠️⚠️ 2026-09-15 修的真问题：**原来人设根本没进提示词**。
 *
 *    `llm.phrase()` 只发 system + user 两条消息，**不会自动带任何知识库** ——
 *    而我第一版在提示词里写了「你自己的人设细节在系统提示词里，按那个来」，
 *    等于在骗模型。出来的就是一段没有性格的通用文本（"今天午饭被偷了，好倒霉"）。
 *
 *    现在把 `persona.md` 真的拼进来。只取人设，不带服务器库/群记忆 ——
 *    中午丢了份饭不需要 Minecraft 资料（而且省提示词）。
 */
function buildSystem() {
  let persona = '';
  try {
    persona = personaText();
  } catch (e) {
    log.debug(`取人设失败：${e.message}`);
  }
  if (!persona) return LIFE_SYSTEM;
  return `${persona}\n\n---\n\n${LIFE_SYSTEM}`;
}

/**
 * 「主群」—— `config.chat.group`。
 *
 * ⚠️ 分群之后（2026-09-15），有几处**只能挑一个群**来用，统一挑主群：
 *   · 润色一级事件时看的"同类往事"（因为**文案是所有群共用一份**，见 `commit()`）；
 *   · 主动私聊（私聊不属于任何群，用她"主战场"那条世界线）。
 */
function mainGroup() {
  return String(config.chat?.group ?? '');
}

/** 和这次事件同类的往事（按标签对上就算） */
function relatedPast(tpl, n = 4) {
  const tags = new Set(tpl.tags ?? []);
  if (!tags.size) return [];
  return storyline
    .recent(60, mainGroup())
    .filter((e) => (e.tags ?? []).some((t) => tags.has(t)) || [...tags].some((t) => e.text.includes(t)))
    .slice(-n);
}

const LIFE_SYSTEM = `你是「${persona.charName()}」（自称 ${persona.selfName()}）。现在要你**主动在群里说一句**，内容是你今天遇到的一件小事。

⚠️ 规矩（按重要性）：

1. **这就是一条群消息**，不是日记、不是独白、不是旁白。
   **视角是你自己**（第一人称，直接说），别加括号动作描写。
   ⚠️ 只是"视角是你" —— **别人当然可以出现，而且该出现就出现**，
   别把每一件事都写成你一个人扛。
2. **长度：一到两句，最好 30 字以内。** 长了就不像随手发的了。
   ⚠️ 但"短"不是目的 —— **先让人看懂**。实在一两句说不清，就多写几个字，
   别为了压字数把"谁、干了什么"都省掉（省掉就变成看不懂的半截话）。
3. ⚠️⚠️ **群里的人不知道这件事**（<主人> 2026-09-15 截图反馈：「这个很明显，群友看不懂在说什么」）。
   这是这条消息**最容易犯的错**，单独列一条：
   · ⚠️⚠️ **每一句都要有主语：你做的动作必须写出「我」。**
     中文口语习惯省主语，但这条是**给群里看**的消息 —— 省了主语就会变成
     "不知道是谁做的"，甚至被读成"是对方做的"（实测「房东来催房租，回了句知道了」
     就被读成**房东**回了句知道了，想说的其实是"我"）。别人的动作就写清是谁。
   · 🚫 **不能只提"那条消息""那个东西""那个事"** —— 群里没人知道你在说哪个；
   · 🚫 **别写成"事件摘要"或旁白**（把给你的设定换个说法复述一遍），那不是说话；
   · ✅ 要像**把刚发生的事讲给群里听**：**谁 + 干了什么 + 结果或者你的反应**，
     一个都不能缺；
   · ⚠️ **别在对白里再套引号**（一句话里塞一句带引号的话，读起来像文档不像聊天）；
   · ⚠️ 代词要能落地：第一次提到的人/东西**说清楚是什么**，后面才可以用"他""那个"。
   · ⚠️ **别省主语**。中文口语爱省主语，但这里省了容易读成"是别人做的" ——
     实测出过「房东来催房租，回了句知道了」这种：读起来像**房东**回了句知道了。
     谁做的动作就写清是谁做的。
4. 语气是**她自己的**：表面淡、底子温柔、偶尔自嘲。**不诉苦**，不卖惨，
   也不许总结升华（「生活还是美好的」这类一律不许）。
5. 🚫 不要用破折号、不要用书名号、不要用 markdown。
   标点只用：。 ， ？ ！ …… ~
   ⚠️ **一律用简体字**，别写繁体（实测出过「音樂祭」这种 —— 混在简体里很扎眼）。
6. 🚫 不要问"你猜怎么着"这种吊人胃口的开场；**直接说事**。
7. 如果给了「有关联的往事」，**要让人看出你记得**（可以更气、可以自嘲"又来"），
   但**别复述往事本身**。
8. 只输出那一句话，**不要引号、不要任何解释**。
9. ⚠️ 上面如果给了「这件事里出场的人」，那就是**真的有人在场** ——
   要么提到她，要么这句话是因为她说的/做的事才说的。**别把给了你的人丢掉不写。**
   称呼按设定来，**别解释她是谁、别加身份说明**（群里没人需要你介绍）。
10. ⚠️⚠️ **听你说话的人是群友，不是那些出场的人。**
   ${persona.promptText('castNames')}她们是**你在跟群友讲的事里的人** ——
   🚫 别写成你在对她们说话、吩咐她们、或者跟她们你一句我一句。
   （真实踩过：<主人> 截图反馈「最后一句有点问题，说话对象应该是群友，
     而不是对${persona.narrativeName()}队友说的」——那次是把给队友下的命令直接发到群里了。）

⚠️ 如果上面给了「今天是：…」，那是**她今天的处境**，要自然融进去
（放假就别提上学；节日就带一点那天她自己的感受）。
⚠️ 上面那些人设条目是你的**事实底子**，不是让你背的 —— 别复述设定，
只按它来说话。`;

/**
 * 记下"发了"，并排下一次。
 *
 * @param {object} planObj `plan()` 返回的对象
 * @param {string} text 真正发出去的话
 * @param {number} [at]
 * @param {{skipStoryline?:boolean}} [opts]
 *   `skipStoryline`：**只消费这个每日槽位，但不写一级故事线**。
 *   ⚠️ 二级剧情用它 —— 槽位被剧情占了，那一级事件其实**没有发生**，
 *      写进去就等于故事线里凭空多了一件没发生过的小事。
 */
/**
 * 记下"发了"，并排下一次。
 *
 * @param {object} planObj `plan()` 返回的对象
 * @param {string} text 真正发出去的话
 * @param {number} [at]
 * @param {{skipStoryline?:boolean, groups?:string[]}} [opts]
 *   `skipStoryline`：**只消费这个每日槽位，但不写一级故事线**。
 *   `groups`：**只给这几个群写故事线**（分群之后用得上：这一格有些群走剧情去了，
 *     它们不该再记一条"日常小事"）。
 */
export function commit(planObj, text, at = Date.now(), opts = {}) {
  // ⚠️ 分群之后：**记到哪个群由 opts.groupId 说了算**（没给就退回 `''` 桶 / planObj 里带的）
  const gid = gkOf(opts.groupId ?? planObj?.groupId ?? '');
  const b = bucketOf(gid, true);
  b.fired = (b.fired || 0) + 1;
  b.lastFireAt = at;
  b.nextAt = 0; // 下次 plan() 会按"上次+冷却"重排
  const line = String(text ?? '').slice(0, 200);
  // ⚠️ 文案为空 = 这一格**没发任何日常**（全被剧情占了）→ 不往 recent 里塞空条目
  if (line) {
    b.recent = [
      ...(b.recent ?? []),
      { at, slot: planObj?.slot ?? '', event: planObj?.template?.text ?? '', text: line },
    ].slice(-20);
  }
  stats.fired++;
  stats.lastFireAt = at;
  save();
  if (opts.skipStoryline) return;
  // 写进故事线（一级，重要度按权重）
  //
  // ⚠️⚠️ 每个群**各记各的**（这个项目里"分群隔离"踩过好几次）：
  //     文案可以是一份、发到几个群，但**每个群都要在自己那条世界线里记一笔**，
  //     否则 B 群的下一件事就看不到"这件事在 B 群也发生过"。
  //     ⚠️ `opts.groups` 给了就只写那几个（有些群这一格走剧情去了）。
  const gs = Array.isArray(opts.groups)
    ? opts.groups.map(String)
    : gid
      ? [gid]
      : targetGroups();
  for (const g of gs) {
    try {
      storyline.note({
        tier: 1,
        imp: planObj?.template?.w ?? 2,
        text: planObj?.template?.text ?? text,
        tags: planObj?.template?.tags ?? [],
        at,
        groupId: g,
      });
    } catch (e) {
      log.debug(`写故事线失败（群 ${g}）：${e.message}`);
    }
  }
  if (!gs.length) log.debug('[日常] 没有要写的群 → 没写故事线');
}

/** 这个事件该发到哪些群 —— 一级群（档位 1）+ 在 `trigger.allowGroups` 里 */
/**
 * 这个事件该发到哪些群 —— 一级群（档位 1）+ 在 `trigger.allowGroups` 里。
 *
 * ⚠️ 2026-09-15 **分群参数**：还能用 `groupParams["<群号>"].life.enable = false`
 *    把**某个群**单独关掉（它就不收日常事件了）。
 *    例：大群不想刷屏、小群想多发几条 —— 用这个，不用动全局。
 */
export function targetGroups() {
  const allow = (config.trigger?.allowGroups ?? []).map(String);
  const lv = config.trigger?.groupRespondTo ?? {};
  return Object.keys(lv)
    .map(String)
    .filter((g) => Number(lv[g]) === 1)
    .filter((g) => !allow.length || allow.includes(g))
    .filter((g) => config.groupParams?.[g]?.life?.enable !== false);
}

/**
 * 这个群**进不进事件系统**（= 是不是 1 档群、而且在白名单里）。
 *
 * ⚠️ <主人> 2026-09-15：「**挡位 2 不能进事件系统，只有 1 才能设置**」。
 *    所以「按群设定」那张表、手动开剧情、以及事件/剧情的分群参数，
 *    **都只认这里返回 true 的群** —— 2 档群只是"她会在那儿说话"，不参与事件系统。
 *    ⚠️ `life.enable=false` 的群**仍然算"进事件系统"**（只是被单独关掉了日常事件），
 *       所以这里用的是**没过滤 enable 的那套判据**。
 */
export function isEventGroup(groupId) {
  const g = String(groupId ?? '').trim();
  if (!g) return false;
  const allow = (config.trigger?.allowGroups ?? []).map(String);
  const lv = config.trigger?.groupRespondTo ?? {};
  if (Number(lv[g]) !== 1) return false;
  return !allow.length || allow.includes(g);
}

export function status(groupId = '') {
  const gid = gkOf(groupId);
  // ⚠️ 界面查状态时也对一次齐 —— 不然界面上显示的还是旧的目标条数（2026-09-16）
  try {
    syncTarget(gid);
  } catch {}
  const b = bucketOf(gid, true);
  const { start, end } = windowOf(Date.now(), gid);
  let today = [];
  let off = false;
  try {
    const h = holiday.on();
    today = h.names;
    off = h.off;
  } catch {}
  return {
    // ⚠️ 这个状态是**哪个群**的（分群之后界面上要显示得清）
    groupId: gid,
    enable: cfgFor(gid).enable !== false,
    slots: slots.length,
    templates: templateCount(),
    loadedAt,
    day: b.day,
    target: b.target,
    fired: b.fired,
    nextAt: b.nextAt,
    lastFireAt: b.lastFireAt,
    today,
    off,
    window: `${num(cfgFor(gid).startHour, 7)}:00-${num(cfgFor(gid).endHour, 24)}:00`,
    cooldownMs: cooldownMs(gid),
    lateToleranceMs: lateToleranceMs(gid),
    nowInWindow: Date.now() >= start && Date.now() < end,
    targets: targetGroups(),
    // ⚠️⚠️ `fired` 一律是「**这个群今天记账了几条**」（= `todayPlan().fired`）。
    //
    //    2026-09-15 修：原来 `...stats` 放在最后，把 `fired` **覆盖**成了
    //    「**这个进程跑了几条**」——于是每次重启，启动日志都显示「今天 0/5 条」，
    //    看着像状态没读进来（我为此查了一轮，还怀疑过状态丢盘）。
    //    进程内的计数改成 `statsFired`，别再叫 `fired`。
    fired: b.fired,
    skipped: stats.skipped,
    statsFired: stats.fired,
    lastError: stats.lastError,
    // ⚠️ 分群之后顺手把**每个群**的进度也带上（界面上那张"按群"的表直接用）
    byGroup: targetGroups().map((g) => {
      const x = bucketOf(g);
      return {
        groupId: g,
        day: x?.day ?? '',
        target: x?.target ?? 0,
        fired: x?.fired ?? 0,
        nextAt: x?.nextAt ?? 0,
      };
    }),
  };
}

/** ⚠️ 测试专用：清空所有群的桶 */
export function __clear() {
  buckets = new Map();
  stats.fired = 0;
  stats.skipped = 0;
  stats.lastError = '';
}

/** ⚠️ 测试专用：重新读盘（用来验证"老格式 → 分群"那次迁移） */
export function __reloadState() {
  buckets = new Map();
  loadState();
}

/** ⚠️ 测试专用：直接塞某个群（默认 `''` 桶）的状态 */
export function __setState(patch = {}, groupId = '') {
  const b = bucketOf(groupId, true);
  Object.assign(b, patch);
}

/** 给管理界面看的：**这个群**今天还剩几条、下次大概什么时候 */
export function todayPlan(groupId = '') {
  const b = bucketOf(groupId, true);
  return {
    groupId: gkOf(groupId),
    day: b.day,
    target: b.target,
    fired: b.fired,
    remaining: Math.max(0, (b.target || 0) - (b.fired || 0)),
    nextAt: b.nextAt || 0,
    recent: (b.recent ?? []).slice(-10).reverse(),
  };
}

reload();
loadState();
