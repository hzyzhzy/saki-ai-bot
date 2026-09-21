/**
 * 故事线（storyline）—— 「**祥子**这条世界线上一路发生过什么」。
 *
 * ## 它和 `observe.js` 的分工（别搞混）
 *
 * | 模块 | 记的是谁的事 |
 * | --- | --- |
 * | `observe.js` | **别人**是什么样的人（群友的性格、群里的大事） |
 * | `storyline.js` | **祥子**身上发生过什么 ← 本文件 |
 *
 * 一级随机事件（拼好饭被偷）、二级剧情（分阶段的任务）、
 * 群友改变剧情的建议 —— **全部写到这里**。
 * 它是「续写世界线」唯一的事实来源：下一件事要从这里找缘由。
 *
 * ## ⚠️⚠️ 2026-09-15：**一个群一份**（<主人> 要求）
 *
 * 用户原话：「我建议先可以直接**一群设一个故事线知识库**，然后参数也可以分群设定。
 *  **知识库调用时一定要分清**就行了。然后再做故事线卡片。」
 *
 * 所以现在盘上长这样（**按群分桶**）：
 * ```json
 * { "groups": { "200000001": { "nextId": 4, "entries": [...], "lastCompressAt": 0 } } }
 * ```
 * 每个群是**独立的一条世界线**：它自己的日常、它自己的主线、它自己的压缩进度。
 * 所以：
 *   · **每个读故事线的地方都必须把 `groupId` 传进来** —— 传错就等于让 A 群看着 B 群的历史说话；
 *   · 压缩、裁剪、锁定校验**都是按桶做的**（A 群压缩不许碰 B 群的条目）；
 *   · 「二级不许删」这条铁律**每个桶各自成立**。
 *
 * ⚠️ 旧格式（顶层直接一个 `entries`）**不再读** —— 用户 2026-09-15 明确说
 *    「先删除，还在测试中」。`load()` 看到旧格式会把原文件**备份一份**再忽略它，
 *    免得哪天真想要还找不回来（备份名 `storyline.legacy-<时间戳>.json`）。
 *
 * ## ⚠️⚠️ 一条不许破的铁律（用户明确要求）
 *
 * > 二级事件「**写进故事线之后不能被删除，只能最小限度精简**」。
 *
 * 落地方式（**每个群各一份**）：
 *   · `tier === 2` 的条目一律 `locked: true`；
 *   · `compress()` 里 **locked 条目只许改短，绝不许消失**；
 *   · 压完要**逐条核对 id**，**少一条就把整次压缩作废、不写盘**
 *     （照 `observe.js` 那套"少了整次作废"的做法）。
 *   ⚠️ 这条不能只写在提示词里求模型别删。模型一定会想删。
 *      **判据必须在代码里**，模型只是建议。
 *
 * ## 落盘
 *
 * `state/storyline.json`（`QQBOT_STORYLINE_FILE` 可改，测试用），原子写。
 * ⚠️ 必须落盘：二级剧情可能跨几小时，而这个号**每几小时就被踢一次登录**
 *    （实测 09-13 / 09-14 各 6 次）。不落盘一掉线剧情就断。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, ROOT } from './config.js';
import { log } from './log.js';
import { streamChat } from './llm.js';
import * as persona from './persona.js';

/** 把流式输出收成一段文本（和 observe.js 一样） */
async function collect(messages, opts) {
  let out = '';
  for await (const d of streamChat(messages, undefined, opts)) out += d;
  return out;
}

const STATE_FILE = process.env.QQBOT_STORYLINE_FILE
  ? join(ROOT, process.env.QQBOT_STORYLINE_FILE)
  : join(ROOT, 'state', 'storyline.json');

/** 重要度 1~5，只影响**一级**条目的压缩优先级；二级一律锁定 */
export const MIN_IMP = 1;
export const MAX_IMP = 5;

/** 一条故事线最多留多少（一级的；二级不参与裁剪） */
function keepTier1() {
  return Math.max(20, Number(config.storyline?.keepTier1) || 80);
}

/**
 * 桶：每个群一条独立的世界线。
 *
 * @typedef {{nextId:number, entries:Array<object>, lastCompressAt:number}} Bucket
 * @type {Map<string, Bucket>}
 */
let buckets = new Map();

const stats = {
  added: 0,
  compressRuns: 0,
  lastError: '',
  lastPruned: 0,
  /** 上次"检查要不要压"的时间（只在内存里就够 —— 决策依据是每个桶落盘的 lastCompressAt） */
  lastCheckedAt: 0,
};
/** 正在压缩的群（按桶各自锁，别互相挡着） */
const compressing = new Set();

/** 群号统一成字符串键；空就是"没指定群"那个桶（测试会用） */
const key = (groupId) => String(groupId ?? '').trim();

function emptyBucket() {
  return { nextId: 1, entries: [], lastCompressAt: 0 };
}

/** 拿一个桶（没有就就地建一个空的，**不落盘** —— 落盘交给 save()） */
function bucketOf(groupId, create = false) {
  const k = key(groupId);
  let b = buckets.get(k);
  if (!b && create) {
    b = emptyBucket();
    buckets.set(k, b);
  }
  return b;
}

/** 把盘上读到的一条洗干净（locked 由 tier 决定，**不从盘上读**） */
function cleanEntry(e) {
  return {
    id: Number(e?.id) || 0,
    at: Number(e?.at) || 0,
    tier: Number(e?.tier) === 2 ? 2 : 1,
    imp: Math.min(MAX_IMP, Math.max(MIN_IMP, Number(e?.imp) || 3)),
    text: String(e?.text ?? '').trim(),
    tags: Array.isArray(e?.tags) ? e.tags.map(String).slice(0, 6) : [],
    // ⚠️ locked 由 tier 决定，**不从盘上读** —— 免得手改文件就能把二级条目解锁
    locked: Number(e?.tier) === 2,
    questId: String(e?.questId ?? ''),
    stage: Number(e?.stage) || 0,
  };
}

/** 读一个桶的原始 JSON */
function loadBucket(raw) {
  const b = emptyBucket();
  const arr = Array.isArray(raw?.entries) ? raw.entries : [];
  b.entries = arr.map(cleanEntry).filter((e) => e.text && e.id).sort((a, c) => a.at - c.at);
  b.nextId = Math.max(1, Number(raw?.nextId) || 0, ...b.entries.map((e) => e.id + 1));
  b.lastCompressAt = Number(raw?.lastCompressAt) || 0;
  return b;
}

function load() {
  buckets = new Map();
  try {
    if (!existsSync(STATE_FILE)) return;
    const j = JSON.parse(readFileSync(STATE_FILE, 'utf8'));

    // ⚠️ 旧格式：顶层直接一个 entries[]（分群之前的样子）。**不再读**，但先备份一份。
    if (!j?.groups && Array.isArray(j?.entries)) {
      const bak = STATE_FILE.replace(/\.json$/i, `.legacy-${Date.now()}.json`);
      try {
        copyFileSync(STATE_FILE, bak);
        log.warn(
          `[故事线] 读到**分群之前**的旧格式（${j.entries.length} 条）—— 按 <主人> 的要求不再使用，` +
            `已备份到 ${bak.replace(ROOT, '.').replace(/\\/g, '/')}`,
        );
      } catch (e) {
        log.warn(`[故事线] 旧格式备份失败（当作没读到）：${e.message}`);
      }
      // ⚠️ **当场把文件改写成新格式**（空的分群结构）。
      //    不写的话，盘上一直是旧样子 → **每次重启都会再备份一遍**，越攒越多（踩过：一下攒了 2 份）。
      buckets = new Map();
      save();
      return;
    }

    for (const [gid, raw] of Object.entries(j?.groups ?? {})) {
      const b = loadBucket(raw);
      if (b.entries.length || b.lastCompressAt) buckets.set(String(gid), b);
    }
    const total = [...buckets.values()].reduce((s, b) => s + b.entries.length, 0);
    const locked = [...buckets.values()].reduce((s, b) => s + b.entries.filter((e) => e.locked).length, 0);
    log.debug(`故事线：载入 ${buckets.size} 个群 / ${total} 条（其中锁定 ${locked} 条）`);
  } catch (e) {
    log.debug(`故事线读取失败（当作空的）：${e.message}`);
  }
}

function save() {
  try {
    mkdirSync(join(ROOT, 'state'), { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    const groups = {};
    for (const [gid, b] of buckets) {
      // 空桶不落盘（别让文件里堆一堆空壳）
      if (!b.entries.length && !b.lastCompressAt) continue;
      groups[gid] = { nextId: b.nextId, entries: b.entries, lastCompressAt: b.lastCompressAt };
    }
    writeFileSync(tmp, JSON.stringify({ groups }, null, 2), 'utf8');
    renameSync(tmp, STATE_FILE);
  } catch (e) {
    log.warn(`故事线写盘失败：${e.message}`);
  }
}

/**
 * 记一条（**必须给 `groupId`**）。
 *
 * ⚠️ **同步函数**（和 `tic.note()` 一样）。踩过：`tic.note` 曾是 `async`，
 *    而调用方当同步用 → `await` 之后的代码静默不执行。这里别重犯。
 *
 * @param {{text:string, groupId?:string|number, tier?:1|2, imp?:number, tags?:string[],
 *          questId?:string, stage?:number, at?:number}} e
 * @returns {object|null} 写进去的那条（被拒时 null）
 */
export function note(e = {}) {
  if (config.storyline?.enable === false) return null;
  const text = String(e.text ?? '').trim();
  if (!text) return null;

  const tier = Number(e.tier) === 2 ? 2 : 1;
  const b = bucketOf(e.groupId, true);
  const item = {
    id: b.nextId++,
    at: Number(e.at) || Date.now(),
    tier,
    imp: Math.min(MAX_IMP, Math.max(MIN_IMP, Number(e.imp) || (tier === 2 ? 5 : 2))),
    text: text.slice(0, 600),
    tags: Array.isArray(e.tags) ? e.tags.map(String).slice(0, 6) : [],
    // ⚠️ 二级 = 锁定，**调用方不能传 locked:false 把它解锁**
    locked: tier === 2,
    questId: String(e.questId ?? ''),
    stage: Number(e.stage) || 0,
  };
  b.entries = [...b.entries, item];
  stats.added++;
  pruneTier1(b);
  save();
  return item;
}

/** 一级条目有上限，二级（locked）**永远不裁**。⚠️ 只动**这一个桶** */
function pruneTier1(b) {
  const locked = b.entries.filter((e) => e.locked);
  const free = b.entries.filter((e) => !e.locked);
  if (free.length <= keepTier1()) return;
  // 先扔"不重要 + 旧"的
  free.sort((a, x) => a.imp - x.imp || a.at - x.at);
  const drop = new Set(free.slice(0, free.length - keepTier1()).map((e) => e.id));
  stats.lastPruned = drop.size;
  b.entries = b.entries.filter((e) => !drop.has(e.id));
  log.debug(`故事线：一级裁掉 ${drop.size} 条（二级 ${locked.length} 条不动）`);
}

/**
 * 某个群最近 n 条（按时间正序返回，给提示词用）。
 *
 * ⚠️ **`groupId` 一定要传对** —— 这是"知识库调用要分清"最要紧的一处。
 */
export function recent(n = 20, groupId = '') {
  const b = bucketOf(groupId);
  if (!b) return [];
  const list = [...b.entries].sort((a, x) => a.at - x.at);
  return list.slice(-Math.max(1, n));
}

/**
 * 某个剧情（quest）写下的全部条目。
 * ⚠️ `groupId` 给了就只在那一个群里找；没给就**所有群**里找（questId 是全局唯一的）。
 */
export function forQuest(questId, groupId = undefined) {
  const id = String(questId ?? '');
  if (!id) return [];
  const pools = groupId === undefined ? [...buckets.values()] : [bucketOf(groupId)].filter(Boolean);
  return pools
    .flatMap((b) => b.entries)
    .filter((e) => e.questId === id)
    .sort((a, b) => a.at - b.at);
}

/** 拼一段给模型看的故事线（按时间正序，**只给这个群的**） */
export function promptBlock(n = 20, groupId = '') {
  const list = recent(n, groupId);
  if (!list.length) return '';
  const lines = list.map((e) => {
    const d = new Date(e.at);
    const when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const tag = e.tier === 2 ? '【主线】' : '';
    return `${when} ${tag}${e.text}`;
  });
  return ['## 你这条世界线上最近发生过的事（时间正序）', '', ...lines].join('\n');
}

/** 有内容的群号（给定时器/界面用） */
export function groups() {
  return [...buckets.keys()];
}

/**
 * 状态。
 * @param {string} [groupId] 给了就是那一个群的数字；不给就是全部群的汇总 + 每个群各一行
 */
export function status(groupId) {
  const base = {
    enable: config.storyline?.enable !== false,
    file: STATE_FILE.replace(ROOT, '.').replace(/\\/g, '/'),
    groups: buckets.size,
    ...stats,
  };
  if (groupId !== undefined && groupId !== null && String(groupId).trim() !== '') {
    const b = bucketOf(groupId);
    const list = b?.entries ?? [];
    return {
      ...base,
      groupId: key(groupId),
      total: list.length,
      locked: list.filter((e) => e.locked).length,
      keepTier1: keepTier1(),
      lastCompressAt: b?.lastCompressAt ?? 0,
    };
  }
  const all = [...buckets.values()].flatMap((b) => b.entries);
  return {
    ...base,
    total: all.length,
    locked: all.filter((e) => e.locked).length,
    keepTier1: keepTier1(),
    /** 每个群各一行（故事线卡片要用） */
    byGroup: [...buckets.entries()]
      .map(([gid, b]) => ({
        groupId: gid,
        total: b.entries.length,
        locked: b.entries.filter((e) => e.locked).length,
        lastCompressAt: b.lastCompressAt,
        chars: b.entries.reduce((s, e) => s + e.text.length, 0),
      }))
      .sort((a, b) => b.total - a.total),
  };
}

// ─────────────────────────────────────────────────────────────
// 压缩：把流水账改写成**轻小说式的章节**（一章 = 一件事）；二级只许精简
// ─────────────────────────────────────────────────────────────

/**
 * 时间戳（喂给模型的那种）。
 *
 * ⚠️ 2026-09-17 加的：以前喂给模型的条目**不带时间** ——
 *    模型既认不出"同一天 / 同一件事"，更写不出章节的日期。
 */
function stamp(at) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 章节标题里的日期 —— **由代码写，不许模型自己编**（用户 2026-09-17：
 * 「每一章要记日期」）。正文里禁止模型写日期，这里拿这一章覆盖的
 * **最早那条**的真实时间拼上去，所以盘上的日期一定是真的。
 */
function dayLabel(at) {
  const d = new Date(at);
  const y = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}年`;
  return `${y}${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 一章正文最多留多少字（比单条宽一点 —— 一章要装下几件事） */
const CHAPTER_MAX = 800;

/**
 * 压缩这一次给模型多大的输出上限。
 *
 * ⚠️ 2026-09-18 加的：主模型默认 `maxTokens` 是 8000，而"把 89 条流水账
 *    改写成章节"的输出比它长 —— 一旦被 `finish_reason: length` 截断，
 *    JSON 就不完整、整次作废（症状是「模型没给可解析的 JSON」）。
 */
const COMPRESS_MAX_TOKENS = 16000;

export const COMPRESS_PROMPT = `你在帮一个角色扮演机器人**整理它的"故事线"**。

这些是「${persona.narrativeName()}」这条世界线上已经发生过的事（她自己的生活小事 + 主线剧情）。
你的任务：把流水账**改写成轻小说式的章节** —— **一章 = 一件事**。
这样以后生成新事件时更好参考，也更省地方。

⚠️⚠️ 五条铁律：

1. **标了"锁定"的条目，一条都不许删、不许合并、不许写进章节里。**
   那些是主线剧情，是世界线的骨架。你**只能**把它们写得更短
   （去掉修辞、心理描写、重复的修饰），**起因 / 转折 / 结果 / 造成的影响必须留着**。
2. **一章 = 一件事**。把讲同一件事（或同一条线索上接连发生的几件事）的普通条目
   合成一章。**不同的事、隔了好几天的条目不许硬凑成一章** ——
   每一章都要经得起"这是哪一天、发生的哪一件事"。
3. **日常章节缺东西时，可以补"合理的连接"**：
   ✅ 为了让一章读得顺、像小说，可以补**不跟已有事实冲突**的小细节 ——
      天气、地点、当时的心情、为什么要那样做、两段之间怎么过渡。
   ❌ 但不许改**已经写下的事实**（谁做了什么、结果是什么），
      不许凭空加**新事件 / 新人物 / 新结局**，不许写成夸张的戏
      （车祸、绝症、超能力这类一律不许）。
   ⚠️ **标了"锁定"的条目一个字都不许补** —— 那是刚跑完的主线，只许变短。
   ⚠️ 补得越少越好：只有缺了它读不通、或者读起来像流水账时才补。
4. **正文里不要写日期**，日期由系统按真实时间替你加，你写了反而会打架。
5. **纯闲聊直接删掉**（放进 drop）：跟服务器、跟${persona.narrativeName()}本人、跟"这机器人在干什么"
   都无关的闲扯（比如「今天天气怎么样」）对以后回答没用。
   ⚠️ 判据（**别偷懒删、也别一条不删**）：**这条以后能让她的回答更准 / 更像吗？**
      能 → 并进章节；不能 → drop。
   ✅ 典型该留：她对群友的要求 / 偏好、她和群友之间的相处事实、群里的大事、
      群友围着她那件事说的话。
   ❌ 典型该删：群友在讨论"这个机器人在干什么"、测试她的功能、
      跟她那件事无关的插科打诨。

### ✍️ 文风：日式轻小说，不是小学生作文

- **短句为主**，长短句交替；一句一个动作或一个念头，别一逗到底。
- **情绪不要直说**：不许写"她非常难过 / 特别开心"——
  用动作、细节、沉默、天气带出来（比如「她把筷子放平，那碗饭没动」）。
- **少用程度副词**：非常、特别、十分、无比、极其 —— 不要堆。
- **对话只写原条目里已经有的**，用「」包起来，**不许自己编新台词**。
- 别用「然后……然后……」「接着……接着……」这种流水账连接；
  用时间推进、场景切换来分段。
- 🚫 **不要只罗列群友的发言**（「喵喵三三连发几条：『找到初华了吗』『…』」
  「她又接一句」这种报菜名）—— 要写成**场景里的对话**：
  谁在场、手上在做什么、这句话是怎么说出口的（哪怕只是转个身、停了一下）。
- ⚠️ 但**不许因为"这种素材不好编进小说"就把它 drop 掉**：
  日常记录是章节的**素材**，默认都要并进某一章（见铁律 5）。
- 每章 **100~250 字**最合适：原条目的意思一个不少，但读起来像小说里的一节。
- 🚫 作文腔一句都不要：「今天真是难忘的一天」「我明白了一个道理」
  「心情久久不能平静」「这让我想起了」。
- ✅ 可以有的：一个具体的动作、一个具体的物件、一句短对白、一段留白。

输出**只用一个 JSON 对象**，不要解释、不要 markdown 代码围栏：

{
  "keep": [
    { "id": 12, "text": "（这条的新写法；锁定条目必须变短或不变）" }
  ],
  "chapters": [
    { "ids": [3, 4, 5], "title": "拼好饭被偷了", "text": "（这一章的正文，叙事体）" }
  ],
  "drop": [7, 8]
}

- keep：**单条**保留的普通条目 + **全部锁定条目**。
- chapters：合并成**一章**的普通条目；ids 里**绝不许**出现锁定条目。
  title 要短（一句话说清这一章是哪件事），正文用叙事体写。
- drop：删掉不要的普通条目 id（**只有点名要删的才会被删**）。
- 既没写进 keep / chapters、也没写进 drop 的普通条目，**会按原文保留** ——
  所以想把几条并成一章，就必须写进 chapters，别指望"不提它就没了"。

⚠️ **keep 里必须包含每一个锁定条目的 id**（一个都不能漏），
漏一个你这次的整理就整个作废。`;

/**
 * 把 JSON **字符串里**的裸控制字符转义掉。
 *
 * ⚠️⚠️ 2026-09-18 踩的：模型写长正文时会在字符串里**直接换行**，
 *    而 JSON 不允许裸换行 → `JSON.parse` 直接失败 →
 *    症状就是「模型没给可解析的 JSON」（明明它有好好输出）。
 *    压缩改成章节体之后正文变长，这个错就浮出来了。
 */
function escapeRawControls(s) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (esc) {
      out += ch;
      esc = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      out += ch;
      continue;
    }
    if (inStr && (ch === '\n' || ch === '\r' || ch === '\t')) {
      out += ch === '\t' ? '\\t' : '\\n';
      continue;
    }
    out += ch;
  }
  return out;
}

/** 容错地抠出 JSON（模型爱加围栏、客套话，还爱在字符串里裸换行）
 *  ⚠️ 导出是给测试和探针用的（`test/storyline.js` 直接盯"裸换行能不能救回来"） */
export function parseJson(raw) {
  let t = String(raw ?? '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  const body = t.slice(i, j + 1);
  try {
    return JSON.parse(body);
  } catch {}
  // 第二道：把字符串里的裸换行 / 制表符转义掉再试一次
  try {
    return JSON.parse(escapeRawControls(body));
  } catch {}
  return null;
}

/**
 * 压缩**一个群**的故事线。
 *
 * ⚠️⚠️ **锁定条目少一条 → 整次作废、不写盘**（用户明确要求二级不能删）。
 *    这个判据**必须在代码里**，不能指望提示词。模型每次都会想删。
 * ⚠️ 只动 `groupId` 那一个桶 —— A 群压缩**绝不许**碰 B 群的条目。
 *
 * @param {{force?:boolean, groupId:string|number}} [opts]
 */
export async function compress(opts = {}) {
  if (config.storyline?.enable === false) return { ok: false, message: '故事线没开' };
  if (config.storyline?.compress?.enable === false) return { ok: false, message: '压缩没开' };

  const gid = key(opts.groupId);
  // ⚠️ 没给群号 → 兜底到 `''`（"没指定群"）那个桶 ——
  //    和 `note()` / `recent()` / `promptBlock()` 保持一致（模块里别搞两套规矩）。
  //    `compressIfDue()` 一定给真群号；这里是给测试和老调用点用的。
  if (!gid) log.debug('[故事线] compress() 没给 groupId → 用"没指定群"那个桶');
  const b = bucketOf(gid);
  if (!b || !b.entries.length) return { ok: false, message: `群 ${gid} 还没有故事线` };
  if (compressing.has(gid)) return { ok: false, message: `群 ${gid} 上一次还在压` };

  const minInterval = Number(config.storyline?.compress?.minIntervalMs) || 3 * 24 * 3600 * 1000;
  if (!opts.force && b.lastCompressAt && Date.now() - b.lastCompressAt < minInterval) {
    return { ok: false, message: `距上次压缩不到 ${Math.round(minInterval / 3600000)} 小时` };
  }
  // ⚠️ 太少的时候压一次纯属浪费（而且模型会想动刚写下的新鲜事）
  const minEntries = Number(config.storyline?.compress?.minEntries) || 8;
  if (b.entries.length < minEntries) {
    return { ok: false, message: `条数太少（${b.entries.length}/${minEntries}），不用压` };
  }
  compressing.add(gid);
  stats.compressRuns++;
  try {
    const before = [{ role: 'system', content: COMPRESS_PROMPT }];
    const rows = [...b.entries]
      .sort((a, x) => a.at - x.at)
      .map((e) => `[id=${e.id}${e.locked ? ' 锁定' : ''} 重要度=${e.imp} 时间=${stamp(e.at)}] ${e.text}`)
      .join('\n');
    before.push({ role: 'user', content: `故事线（共 ${b.entries.length} 条）：\n\n${rows}` });

    // ★★ 关掉思考链（2026-09-18 查清的真因，别删）：
    //    实测 89 条故事线时，flash 的思考链烧掉 **7479/8000** token，
    //    正文只写了 819 字就被 `finish_reason: length` 切断 ——
    //    JSON 不完整 → 整次作废，而症状只是"模型没给可解析的 JSON"，极难查。
    //    关掉之后：6 秒、思考链 0 字、正文 2283 字、`finish_reason: stop`。
    //    压缩只是"整理已有内容"，本来也不需要深推理。
    const raw = await collect(before, {
      maxTokens: COMPRESS_MAX_TOKENS,
      timeoutMs: 150000,
      thinking: { type: 'disabled' },
    });
    const parsed = parseJson(raw);
    if (!parsed) {
      stats.lastError = '模型没给可解析的 JSON';
      // ⚠️ 必须把**原始输出**留一点在日志里 —— 不然下次还是只能看到这一句，
      //    根本分不清是"被截断了"还是"格式错了"（2026-09-18 就卡在这儿）。
      log.warn(
        `[故事线] 群 ${gid} 压缩作废：${stats.lastError}` +
          `（原始输出 ${raw.length} 字；末尾：…${raw.slice(-200).replace(/\s+/g, ' ')}）`,
      );
      return { ok: false, message: stats.lastError };
    }

    const lockedIds = b.entries.filter((e) => e.locked).map((e) => e.id);
    const keep = Array.isArray(parsed.keep) ? parsed.keep : [];
    const keepIds = new Set(keep.map((k) => Number(k?.id)).filter(Boolean));
    // ⚠️ 章节（一章 = 一件事）。`merge` 是**老格式**，照样收 ——
    //    当成"没有标题的章节"处理（老测试/老提示词回的内容还能用）。
    const chapters = [
      ...(Array.isArray(parsed.chapters) ? parsed.chapters : []),
      ...(Array.isArray(parsed.merge) ? parsed.merge : []),
    ];
    const mergedIds = new Set(
      chapters.flatMap((m) => (Array.isArray(m?.ids) ? m.ids.map(Number) : [])),
    );

    // ★★ 这一条是整套东西的命门
    const lostLocked = lockedIds.filter((id) => !keepIds.has(id) && !mergedIds.has(id));
    if (lostLocked.length) {
      stats.lastError = `模型想弄丢锁定条目 ${lostLocked.join(',')}`;
      log.warn(`[故事线] ❌ 群 ${gid} 压缩作废（整次不写盘）：${stats.lastError}`);
      return { ok: false, message: stats.lastError, lostLocked };
    }

    const byId = new Map(b.entries.map((e) => [e.id, e]));

    // drop 掉模型点名要删的（锁定条目忽略）
    const dropIds = new Set(
      (Array.isArray(parsed.drop) ? parsed.drop : []).map(Number).filter(Boolean),
    );
    for (const id of dropIds) if (byId.get(id)?.locked) dropIds.delete(id);

    // ★ 先挑出**真正能成章**的那些：掺了锁定 id 的、正文空的 → 整章丢掉。
    //    ⚠️ 只有"真的成了章"的条目才算被吸收 —— 一章被整章丢掉时，
    //       它里面那些普通条目必须**按原文留下**，不许跟着一起蒸发。
    const okChapters = [];
    for (const m of chapters) {
      const ids = Array.isArray(m?.ids) ? m.ids.map(Number) : [];
      const src = ids.map((i) => byId.get(i)).filter(Boolean);
      if (!src.length || src.some((s) => s.locked)) continue; // 章节里不许掺锁定条目
      const body = String(m?.text ?? '').trim();
      if (!body) continue;
      okChapters.push({ m, ids, src, body });
    }
    const absorbedIds = new Set(okChapters.flatMap((c) => c.ids));

    const next = [];

    // 先按原顺序重建 keep（保住时间正序）
    for (const e of [...b.entries].sort((a, x) => a.at - x.at)) {
      if (dropIds.has(e.id)) continue; // 模型点名要删的
      if (absorbedIds.has(e.id)) continue; // 真的被并进某一章了
      const k = keep.find((x) => Number(x?.id) === e.id);
      if (!k) {
        // ⚠️ 模型**没提到**的普通条目：按原文留着（绝不许静默丢）。
        //    模型漏一条不该等于把那条抹掉 —— 想删就得在 drop 里点名。
        //    （锁定条目走不到这里：上面 lostLocked 那一关早就整次作废了。）
        if (!e.locked) next.push({ ...e });
        continue;
      }
      let text = String(k.text ?? '').trim() || e.text;
      // ⚠️ 锁定条目：只许变短，模型想加长就按原样留着（"最小限度精简"）
      if (e.locked && text.length >= e.text.length) text = e.text;
      next.push({ ...e, text: text.slice(0, 600) });
    }
    // 再放章节（一章 = 一件事；归到这一章里最早那条的时间）
    let chaptersMade = 0;
    for (const { m, src, body } of okChapters) {
      const at = Math.min(...src.map((s) => s.at));
      const title = String(m?.title ?? '').trim();
      // ⚠️ 日期**由代码加**（模型自己写的日期不算数）；
      //    老格式的 merge 没有 title，就只有日期没有标题。
      const head = title ? `【${dayLabel(at)} · ${title}】` : `【${dayLabel(at)}】`;
      next.push({
        id: b.nextId++,
        at,
        tier: 1,
        imp: Math.max(...src.map((s) => s.imp)),
        text: `${head}${body}`.slice(0, CHAPTER_MAX),
        tags: [...new Set(src.flatMap((s) => s.tags))].slice(0, 6),
        locked: false,
        questId: '',
        stage: 0,
      });
      chaptersMade++;
    }
    const finalList = next;

    // 兜底再核一次（上面任何一步写错都不许写盘）
    const finalLocked = new Set(finalList.filter((e) => e.locked).map((e) => e.id));
    const stillLost = lockedIds.filter((id) => !finalLocked.has(id));
    if (stillLost.length) {
      stats.lastError = `压缩后校验又少了 ${stillLost.join(',')}`;
      log.warn(`[故事线] ❌ 群 ${gid} 压缩作废：${stats.lastError}`);
      return { ok: false, message: stats.lastError };
    }

    const beforeChars = b.entries.reduce((s, e) => s + e.text.length, 0);
    b.entries = finalList.sort((a, x) => a.at - x.at);
    b.lastCompressAt = Date.now();
    save();
    const afterChars = b.entries.reduce((s, e) => s + e.text.length, 0);
    log.info(
      `[故事线] 群 ${gid} 压缩完成：${beforeChars} → ${afterChars} 字，` +
        `${finalList.length} 条（写成 ${chaptersMade} 章，锁定 ${lockedIds.length} 条一条没少）`,
    );
    return {
      ok: true,
      groupId: gid,
      before: beforeChars,
      after: afterChars,
      kept: finalList.length,
      locked: lockedIds.length,
      dropped: dropIds.size,
      chapters: chaptersMade,
    };
  } catch (e) {
    stats.lastError = e.message;
    log.warn(`[故事线] 群 ${gid} 压缩出错：${e.message}`);
    return { ok: false, message: e.message };
  } finally {
    compressing.delete(gid);
  }
}

/**
 * 到期就压一次（由定时器/心跳调）。
 *
 * ⚠️ **分群之后这里要挨个群看** —— 每个群有自己的 `lastCompressAt`。
 * ⚠️ `lastCompressAt` 落盘 —— 否则每次重启都归零，一重启就压（踩过，见 observe.js）。
 *
 * @returns {Promise<{ok:boolean, message:string, results?:Array}>}
 */
export async function compressIfDue() {
  const checkMs = Number(config.storyline?.compress?.checkIntervalMs) || 12 * 3600 * 1000;
  if (stats.lastCheckedAt && Date.now() - stats.lastCheckedAt <= checkMs) {
    return { ok: false, message: '还没到检查时间' };
  }
  stats.lastCheckedAt = Date.now();
  if (!buckets.size) return { ok: false, message: '还没有任何群的故事线' };

  const results = [];
  for (const gid of [...buckets.keys()]) {
    try {
      const r = await compress({ groupId: gid });
      results.push({ groupId: gid, ...r });
    } catch (e) {
      results.push({ groupId: gid, ok: false, message: e.message });
    }
  }
  const done = results.filter((r) => r.ok);
  return {
    ok: done.length > 0,
    message: done.length
      ? `${done.length} 个群压缩完成`
      : results.map((r) => `群 ${r.groupId}：${r.message}`).join('；'),
    results,
  };
}

/**
 * 清空某个群的故事线（不给就全清）。
 *
 * ⚠️ 这是给**管理界面**的「清空剧情和故事线」按钮用的生产接口（<主人> 2026-09-15 晚：
 *    「加一个清空上次故事的按钮吧，现在还在测试中」）—— 测试残留的剧情不该留在
 *    她的记忆里，不然下一次开剧情会接着上次那条的思路往下跑。
 *
 * @param {string} [groupId] 不给（或空）＝**所有群**
 * @returns {{groups:number, all:boolean}} 清掉了几个群、是不是全清
 */
export function clear(groupId) {
  const all = groupId === undefined || groupId === null || String(groupId).trim() === '';
  const n = all ? buckets.size : (buckets.has(key(groupId)) ? 1 : 0);
  if (all) {
    buckets = new Map();
  } else {
    buckets.delete(key(groupId));
  }
  stats.compressRuns = 0;
  stats.lastError = '';
  stats.lastCheckedAt = 0;
  save();
  log.info(`[故事线] 清空（${all ? '所有群' : `群 ${groupId}`}，${n} 个群）`);
  return { groups: n, all };
}

/** ⚠️ 测试专用别名（老测试在用；实现就是上面的 `clear`） */
export function __clear(groupId) {
  clear(groupId);
}

/** 配置热重载后调一下（重读阈值等） */
export function reload() {
  load();
}

load();
