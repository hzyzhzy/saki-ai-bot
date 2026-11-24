/**
 * 「思考链」记录 —— webui 那个页面的数据源。
 *
 * 用户要求（2026-11-11）：
 *   「做一个思考链的页面放在功能模块下，展示近期所有有过思考链的消息和它的思考过程，
 *     越新的消息越在上面，每一个消息是一个卡片。最上面是回这个消息的原因，然后是消息原文，
 *     然后是思考内容，最后是回复内容。要能实时出现，比如思考内容要逐行输出在页面上。」
 *
 * ## 结构（每条 = 一个卡片）
 *   { id, at, gid, who, from, msgText, reason, think, reply, stage }
 *   · `reason`  为什么回这条（mode + 上下文拼出来的人话）
 *   · `msgText` 触发它的那句原文
 *   · `think`   思考链（**流式追加**，页面逐行滚出来）
 *   · `reply`   最后发出去的正文
 *
 * ## 只在内存里跑，落盘是"顺便"
 *   ⚠️ 思考链是**逐 token 追加**的，如果每来一块就写盘，磁盘会被打爆 ✗
 *   ⇒ 追加只在内存 + 广播；**一条跑完（或失败）才落盘一次**。
 *   ⇒ 机器人重启时从 `state/think-log.json` 读回最近这些条（页面不至于一片空白）。
 *
 * ## 订阅
 *   webui 用 SSE 订阅：`subscribe(fn)` 拿 `{type, ...}` 事件。
 *   事件类型：`start`（新卡片）/ `think`（思考增量）/ `reply`（正文增量）/ `end`（收尾）
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ROOT, stateDir } from './config.js';

const MAX = 120;
const FILE = join(stateDir(), 'think-log.json');

/** 最新的在最前面 */
let list = [];
const subs = new Set();
let seq = 1;

function load() {
  try {
    if (!existsSync(FILE)) return;
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    if (Array.isArray(j?.items)) {
      // ⚠️⚠️ 2026-11-13 改（用户：「**为什么全都进去了，明明根本没有回复出来**」）：
      //    原来把"重启前没跑完的"标成 `cut` 留在列表里 —— 结果满屏都是"中断（重启）"、
      //    回复一栏空着，看着像她收了一堆消息却一条没回 ✗
      //    ⇒ **没跑完的直接不回填**（那些消息根本没生成过正文，不是"有过思考链的消息"）。
      list = j.items.filter((x) => x && x.id && x.stage !== 'thinking' && x.stage !== 'replying' && x.stage !== 'cut').slice(0, MAX);
      for (const e of list) {
        if (e.stage !== 'done' && e.stage !== 'failed') e.stage = 'done';
      }
    }
  } catch {
    /* 第一次没有这个文件 */
  }
}
load();

function save() {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ items: list }, null, 1), 'utf8');
    renameSync(tmp, FILE);
  } catch {
    /* 落盘失败不影响主流程 */
  }
}

function emit(type, payload) {
  for (const fn of subs) {
    try {
      fn({ type, ...payload });
    } catch {
      /* 单个订阅者出错不影响别人 */
    }
  }
}

/** 开一张新卡片（决定要回这条消息时调） */
export function start(meta = {}) {
  const id = `t${seq++}-${Date.now().toString(36)}`;
  const e = {
    id,
    at: Date.now(),
    gid: String(meta.gid ?? ''),
    who: String(meta.who ?? ''),
    from: String(meta.from ?? ''),
    msgText: String(meta.msgText ?? '').slice(0, 1200),
    // ⚠️ 2026-11-15 加（用户：「如果是合并回复的话都要显示出来」）：
    //    连发合并时 `event._sources` 里是**每一条的原话 + 说话人**（`{userId,name,text}`）。
    //    原来卡片只显示 `from` + `msgText`（= 合并后的那一坨），
    //    看不出"她这一条到底在回谁、回了哪几句" ⇒ 界面上没法和上下文对照 ✗
    //    ⇒ 每条一行的原话单独存一份，页面按条渲染。
    quoted: Array.isArray(meta.quoted)
      ? meta.quoted
          .filter((x) => x && (x.text || x.name))
          .slice(0, 20)
          .map((x) => ({ name: String(x.name ?? ''), text: String(x.text ?? '').slice(0, 400) }))
      : [],
    reason: String(meta.reason ?? '').slice(0, 600),
    think: '',
    /* ⚠️⚠️ 2026-11-19 加（用户：「**要能完全图形化切开每轮输出，和 dsh 一样，不能用字符切开**」）——
     *   `rounds` = **按轮分块**的思考内容，页面一轮渲染一个块（轮次徽标 + 左侧色条 + 工具 chip）。
     *
     *   ⚠️ 为什么不再用分隔线字符串：`──── 第 2 轮思考 ────` 混在正文里，
     *     页面只能整段 `<pre>` 显示 ⇒ 看起来还是一坨文本，分不出哪句属于哪轮 ✗
     *   ⚠️ `think` 仍然保留（= 所有轮拼起来），给"导出 / 老页面 / 兼容"用 ✓ */
    rounds: [],
    reply: '',
    stage: 'thinking',
  };
  list.unshift(e);
  if (list.length > MAX) list.length = MAX;
  emit('start', { item: e });
  return id;
}

function find(id) {
  return list.find((x) => x.id === id) ?? null;
}

/**
 * 思考链增量（**逐块**，页面靠它逐行滚）。
 *
 * @param {string} id
 * @param {string} chunk
 * @param {number} [round=1] 这是**第几轮生成**的思考（工具回合每重跑一次就 +1）
 *   ⚠️ 2026-11-19 加：页面靠它把内容**分到不同的图形块**里（每轮一块），
 *      不再依赖写进文本的分隔线 —— 分隔线那种"字符切开"看着还是一坨 ✗
 */
export function appendThink(id, chunk, round = 1) {
  const e = find(id);
  if (!e || !chunk) return;
  const text = String(chunk);
  const n = Math.max(1, Number(round) || 1);
  if (!Array.isArray(e.rounds)) e.rounds = [];
  // 缺哪一轮就补上（跳号也补，页面按 n 渲染）
  while (e.rounds.length < n) e.rounds.push({ n: e.rounds.length + 1, think: '' });
  e.rounds[n - 1].think += text;
  e.think += text;
  // 上限 20000 字（和 llm.js 那个上限一个口径，防止吃爆内存）
  if (e.think.length > 20000) e.think = e.think.slice(-20000);
  emit('think', { id, chunk: text, round: n });
}

/** 正文增量（主聊天是流式的，能同步看到在写什么） */
export function appendReply(id, chunk) {
  const e = find(id);
  if (!e || !chunk) return;
  if (e.stage === 'thinking') e.stage = 'replying';
  e.reply += String(chunk);
  emit('reply', { id, chunk: String(chunk) });
}

/**
 * ⚠️ 2026-11-20 加：**清空正文**（每一轮开写之前调）
 *
 *   用户截图：「**思考链那里一直是还没开始写回复，而且还是不能逐字显示**」
 *   ⇒ 正文要流式写（`appendReply`），但生成**可能是多轮**的：
 *     第一轮写了半截、被工具回合丢掉、第二轮重写 ⇒ 不先清空的话，
 *     页面上会把两版草稿**拼成一坨** ✗
 *   ⇒ 每轮开写前 `clearReply()`，前端收到 `reset:true` 就把那栏清掉 ✓
 */
export function clearReply(id) {
  const e = find(id);
  if (!e) return;
  e.reply = '';
  emit('reply', { id, chunk: '', reset: true });
}

/** 收尾 */
export function finish(id, opts = {}) {
  const e = find(id);
  if (!e) return;
  if (opts.reply !== undefined) e.reply = String(opts.reply ?? '');
  // ⚠️ 2026-11-13（用户要求）：卡片上要显示这条花了多少 token、多少钱
  if (opts.usage) {
    const u = opts.usage;
    e.pt = Number(u.prompt_tokens) || 0;
    e.ct = Number(u.completion_tokens) || 0;
    e.cached = Number(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0) || 0;
    e.rt = Number(u.completion_tokens_details?.reasoning_tokens) || 0;
  }
  if (Number.isFinite(opts.cost)) e.cost = Number(opts.cost);
  // ⚠️⚠️ 2026-11-18 改（用户：「**本地处理的消息能不能也在思考链页面显示出来**」）——
  //    原来这里是「正文和思考都是空的 ⇒ `drop()` 删掉」，理由是"别让页面上一堆（还没开始写）"。
  //    但换了本地小模型之后这条变成**掩盖问题**：
  //      本地 0.5B 上下文只有 2048，`[空间]` / `[日常]` / `phrase()` 那些内部调用
  //      直接把 8 万 token 的提示词发过去 ⇒ 400 / 超时 ⇒ 正文空 ⇒ **页面上一条都看不到**，
  //      看着像"她根本没收到消息"，其实是模型挂了 ✗✗
  //    ⇒ 现在：**带失败原因的（`note`）就留着**，标 `stage='failed'`，页面上能看到"这条挂了、为什么" ✓
  //    只把"什么都没发生"（没回复、没思考、也没失败原因）的删掉，免得满屏空卡 ✓
  if (
    !String(e.reply ?? '').trim() &&
    !String(e.think ?? '').trim() &&
    !String(opts.note ?? '').trim()
  ) {
    drop(e.id);
    return;
  }
  e.stage = opts.failed ? 'failed' : 'done';
  /* ⚠️ 2026-11-21 改（用户截图：卡片标「失败」、回复栏「(还没开始写)」，可群里实际回了 30 字）——
   *   原来只在 `failed && note` 时写 note，**成功后不清** ⇒
   *   重跑成功把 stage 翻回 'done' 时那条旧的失败原因**还挂着**，
   *   卡片变成"成功了、底下却写着为什么失败"，自相矛盾 ✗
   *   ⇒ 成功（没传 failed）时把 note 清空 ✓
   */
  if (opts.failed && opts.note) e.note = String(opts.note).slice(0, 300);
  else if (!opts.failed) e.note = '';
  e.ms = Date.now() - e.at;
  save();
  emit('end', {
    id,
    stage: e.stage,
    reply: e.reply,
    ms: e.ms,
    note: e.note ?? '',
    pt: e.pt ?? 0,
    ct: e.ct ?? 0,
    cached: e.cached ?? 0,
    rt: e.rt ?? 0,
    cost: e.cost ?? null,
  });
}

/** 全部（最新在前） */
export function all() {
  /* ⚠️ 2026-11-19：**给老卡片补 `rounds`**（它们落盘时还没有这个字段）——
   *   页面统一按 `rounds` 渲染，缺了就当成"第 1 轮"整段显示，
   *   不然老卡片会变成空白 ✗（这里**不改存储**，只改返回给页面的那份）✓ */
  return list.map((e) => ({
    ...e,
    rounds:
      Array.isArray(e.rounds) && e.rounds.length
        ? e.rounds
        : [{ n: 1, think: String(e.think ?? '') }],
  }));
}

/** 统计（页面顶部那行小字用） */
export function stats() {
  return { total: list.length, thinking: list.filter((x) => x.stage === 'thinking').length };
}

/** 订阅（webui 的 SSE 用）；返回退订函数 */
export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

/** 清空（页面上那个"清空"按钮用） */
export function clear() {
  list = [];
  save();
  emit('clear', {});
}

/**
 * 造一条**假的**流式记录 —— 只为验证"页面上思考内容会不会逐行滚出来"。
 * ⚠️ 不调模型、不记账、不发任何消息；刷新页面就能看到它滚一遍。
 * ⚠️ 走的是和真实生成**同一条** SSE 通道，所以验过它就等于验了前端。
 */
export async function demo() {
  const id = start({
    gid: '123456789',
    who: '（测试）',
    from: '测试群友',
    msgText: '这条是测试：看看思考链页面会不会把思考内容逐行滚出来',
    reason: '手动触发（只是为了验证页面，不是真的判定）',
  });
  const steps = [
    '先看一眼这句话在问什么。\n',
    '他不是在提问，是在试这个页面。\n',
    '那我随便想两句，让它能一行一行滚出来就行。\n',
    '嗯，差不多了，收。\n',
  ];
  for (const t of steps) {
    appendThink(id, t);
    await new Promise((r) => setTimeout(r, 700));
  }
  await new Promise((r) => setTimeout(r, 400));
  // ⚠️ 2026-11-13：带上**真实量级**的 usage —— 不然页面上的 token/花费那一行是空的，
  //    看着像"这个功能没做"。数值取实际主聊天的一次典型值（12 万提示词、六成缓存）。
  finish(id, {
    reply: '（这是测试记录，不是真回复）',
    usage: { prompt_tokens: 118420, completion_tokens: 96, prompt_cache_hit_tokens: 72400 },
    cost: 0.0432,
  });
  return id;
}

/**
 * 把一张卡片**从列表里删掉**（连内存带落盘）。
 * ⚠️ 用于"这条其实没生成出任何东西"—— 用户要的是**有过思考链的消息**，
 *   一条什么都没产出的记录不配占一张卡片 ✗
 */
export function drop(id) {
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return false;
  list.splice(i, 1);
  save();
  emit('drop', { id });
  return true;
}
