/**
 * 梗库的**自动维护**（2026-11-07 加，第二版）。
 *
 * ## 用户要的
 *   「同时也可以不断增删改 meme.md 库，增加 bot 的玩梗技能」
 *   → 补了一句：「**这些都是需要不断学习总结的，不能写死，需要不断更新，
 *     也能防止字数不断扩张**」
 *
 * ## 所以这一版的核心是「累积 + 淘汰 + 设上限」，不是"每轮重写一遍"
 *
 * 每 6 小时跑一次（每个群各跑各的）：
 *
 * 1. **累积**：把这次统计到的候选**并进已有的池子**（不是覆盖）——
 *    老条目只要还在出现就留着，`lastSeen` 更新一下。
 * 2. **淘汰**（三条，缺一条字数就会慢慢涨上去）：
 *    · **30 天没再出现** ⇒ 删（用户要的"增删改"里的"删"）
 *    · **总条数 > `maxItems`（默认 20）** ⇒ 按"最近出现次数"从低到高删
 *    · **总字数 > `maxChars`（默认 2000）** ⇒ 同上，继续删到字数够为止
 * 3. **防写死**：所有阈值都从 `config.chat.memes*` 读，界面能改；
 *    代码里只留兜底默认值 ✓
 *
 * ## 三条硬约束（和第一版一样）
 *   · 只统计**真人**（排除她自己 / 同类池 / 不同类池 / 系统消息）
 *   · 强度**一律 ★**（只认得、默认按字面回、不主动玩）——
 *     没人确认过"这词到底什么意思"，给高了就会把普通词当梗乱接 ✗
 *   · **不编"什么意思 / 怎么接"** —— 编了就是假知识，她会拿假知识硬接 ✗
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { KNOWLEDGE_DIR, config } from './config.js';
import { log } from './log.js';
import * as recent from './recent.js';

const OUT = () => join(KNOWLEDGE_DIR, 'memes-auto.md');
const DAY = 24 * 3600 * 1000;

/** 兜底默认值（都能在 `config.chat` 里覆盖） */
const DEF = {
  maxItems: 20, // 最多收几条
  maxChars: 2000, // 整个文件最多多少字（防止膨胀）
  keepDays: 30, // 多少天没出现就删
 minCount: 5, // 至少出现几次才算梗（2026-09-20 定的标准）
  minWho: 3, // 至少几个人说过
  scanDays: 7, // 往回看几天
};

/** 这些"片段"一定不是梗，直接丢 */
const DROP = [
  /^\d+$/,
  /^[a-zA-Z]{1,4}$/,
  /^(哈哈|hhh|233|草|笑死|确实|好家伙|可以|牛|行|好的?|嗯+|哦+|啊+|对|是)$/i,
  /^(在吗|有人吗|怎么办|为什么|什么|怎么|多少|哪里|是不是|能不能|有没有)$/,
  /* ⚠️ QQ 系统消息（第一版实测就栽在这儿：「戳了你一下」「捏了捏的脸」各 7 次 3 人） */
  /戳了|捏了捏|拍了拍|加入了群|退出了群|撤回了一条|发了|上传了|修改了|开启了/,
  /* 纯代词 / 虚词：高频但没内容，收进去只会"见词就抖机灵" */
  /^(这个|那个|就是|然后|所以|但是|因为|如果|现在|刚才|真的|感觉|应该|可能|已经|还是|没有|不要|知道|觉得)/,
  /(一下|一点|一个|一样|什么|怎么|时候|东西|地方|事情)$/,
];

const cfgNum = (k, d) => {
  const v = Number(config.chat?.[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};

/** 把群聊里"高频且跨人"的短语捞出来 */
function scan(gid) {
  const g = String(gid ?? '');
  if (!g) return [];
  let items = [];
  try {
    items = recent.recentItems(g, 400) ?? [];
  } catch {
    return [];
  }
  const days = cfgNum('memesScanDays', DEF.scanDays);
  const since = Date.now() - days * DAY;
  const peers = new Set((config.groupParams?.[g]?.peers ?? []).map(String));
  const others = new Set((config.groupParams?.[g]?.otherBots ?? []).map(String));

  const bag = new Map();
  for (const it of items) {
    if (it?.self === true) continue;
    const uid = String(it?.userId ?? '');
    if (!uid || peers.has(uid) || others.has(uid)) continue;
    const at = Number(it?.time ?? it?.at ?? 0);
    if (at && at < since) continue;
    const raw = String(it?.text ?? '').trim();
    if (!raw || raw.startsWith('[')) continue;
    for (const s of raw.split(/[\s,，。！？!?、~～…\-—()（）\[\]「」【】"'"'':：;；]+/)) {
      const t = s.trim();
      if (t.length < 2 || t.length > 8) continue;
      if (DROP.some((re) => re.test(t))) continue;
      const rec = bag.get(t) ?? { n: 0, who: new Set(), at: 0 };
      rec.n++;
      rec.who.add(uid);
      if (at > rec.at) rec.at = at;
      bag.set(t, rec);
    }
  }
  const minCount = cfgNum('memesMinCount', DEF.minCount);
  const minWho = cfgNum('memesMinWho', DEF.minWho);
  return [...bag.entries()]
    .filter(([, v]) => v.n >= minCount && v.who.size >= minWho)
    .sort((a, b) => b[1].n - a[1].n)
    .map(([t, v]) => ({ text: t, n: v.n, who: v.who.size, at: v.at || Date.now() }));
}

/** 读已有的自动条目（保留 lastSeen / 次数） */
function readAuto() {
  const p = OUT();
  if (!existsSync(p)) return [];
  let raw = '';
  try {
    raw = readFileSync(p, 'utf8');
  } catch {
    return [];
  }
  const items = [];
  const blocks = raw.split(/^##\s+/m).slice(1);
  for (const b of blocks) {
    const name = (b.split(/\r?\n/, 1)[0] || '').trim();
    if (!name) continue;
    const n = Number((b.match(/出现\s*(\d+)\s*次/) || [])[1]) || 0;
    const who = Number((b.match(/(\d+)\s*个人说过/) || [])[1]) || 0;
    const seen = Number((b.match(/最近一次：(\d{4}-\d{2}-\d{2})/) || [])[1]);
    items.push({
      text: name,
      n,
      who,
      at: Number.isFinite(seen) ? new Date(`${(b.match(/最近一次：(\d{4}-\d{2}-\d{2})/) || [])[1]}T00:00:00`).getTime() : 0,
    });
  }
  return items;
}

const ymd = (t) => new Date(Number(t) || Date.now()).toISOString().slice(0, 10);

/**
 * 重算并写回 `memes-auto.md`（累积 + 淘汰 + 上限）。
 * @returns {{total:number, added:number, dropped:number, chars:number}}
 */
export function refresh(gid, opts = {}) {
  if (config.chat?.memesAuto === false) return { total: 0, added: 0, dropped: 0, chars: 0 };
  const g = String(gid ?? '');
  const scanned = scan(g);
  const prev = readAuto();
  const prevMap = new Map(prev.map((x) => [x.text, x]));

  // ── ① 合并：这次扫到的（更新次数/时间）+ 之前有但这次没扫到的（保留，靠 keepDays 淘汰）
  const pool = new Map();
  for (const c of scanned) {
    const old = prevMap.get(c.text);
    pool.set(c.text, { text: c.text, n: c.n, who: c.who, at: c.at || Date.now(), fresh: !old });
  }
  for (const p of prev) {
    if (pool.has(p.text)) continue;
    pool.set(p.text, { ...p, fresh: false });
  }

  // ── ② 淘汰：太久没出现的直接删
  const keepDays = cfgNum('memesKeepDays', DEF.keepDays);
  const before = pool.size;
  for (const [k, v] of [...pool]) {
    if (v.at && Date.now() - v.at > keepDays * DAY) pool.delete(k);
  }
  const expired = before - pool.size;

  // ── ③ 上限：条数 + 总字数（按"次数"从低到高删，删到够为止）
  const maxItems = cfgNum('memesMaxItems', DEF.maxItems);
  const maxChars = cfgNum('memesMaxChars', DEF.maxChars);
  const ranked = [...pool.values()].sort((a, b) => b.n - a.n);
  const render = (list) =>
    list
      .map(
        (c) =>
          `## ${c.text}\n` +
          `- 触发词：${c.text}\n` +
          `- 类别：玩梗\n` +
          `- 强度：★\n` +
          `- 来源：群聊自动统计，出现 ${c.n} 次、${c.who} 个人说过，最近一次：${ymd(c.at)}\n` +
          `- 什么意思：（自动收录，**还没人工确认** —— 拿不准就只当普通词）\n` +
          `- 才算玩梗：（同上，别主动玩）\n` +
          `- 怎么接：**默认按字面回**，对方明显在玩这个才顺一句 ✓\n`,
      )
      .join('\n');

  const head = [
    '<!-- 声明：数据文件，不进聊天知识 -->',
    '# 梗库 · 自动收录（memes-auto）',
    '',
    '> ⚠️ 这个文件由 `src/memes-auto.js` **自动生成**，别手工改（下次刷新会覆盖）。',
    '> 人工维护的条目在 `memes.md`，那个文件**不会被自动改动**。',
    '>',
    '> ⚠️ 强度**一律 ★**（只认得、默认按字面回、不主动玩）——',
    '> 因为"这词到底什么意思"还没人确认过。人工确认过之后再挪去 `memes.md` 提强度 ✓',
    '>',
    `> 📐 上限：最多 ${maxItems} 条 / ${maxChars} 字；${keepDays} 天没再出现就自动删（防膨胀）。`,
    '',
    '---',
    '',
  ].join('\n');

  let list = ranked.slice(0, maxItems);
  while (list.length && head.length + render(list).length > maxChars) list.pop();
  const dropped = ranked.length - list.length;

  try {
    writeFileSync(OUT(), head + render(list), 'utf8');
  } catch (e) {
    log.warn(`[梗库] 写 memes-auto.md 失败：${e.message}`);
    return { total: list.length, added: 0, dropped, chars: 0 };
  }
  const chars = head.length + render(list).length;
  log.info(
    `[梗库] 群 ${g}：收录 ${list.length} 条（新增 ${list.filter((x) => x.fresh).length}、` +
      `过期删 ${expired}、超限删 ${dropped}）｜${chars} 字`,
  );
  return { total: list.length, added: list.filter((x) => x.fresh).length, dropped: dropped + expired, chars };
}

/** 给界面/日志看的 */
export function status(gid) {
  const list = scan(gid);
  const prev = readAuto();
  return { candidates: list.slice(0, 10), autoCount: prev.length };
}
