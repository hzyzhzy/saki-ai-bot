/**
 * 梗库（`knowledge/memes.md`）—— **按需**读取、识别"对方这句话里有没有梗"。
 *
 * ## 用户要求（2026-09-20）
 *
 *   「在 knowledge 里额外加一个文件放梗。这玩意有点难弄：
 *     **得把梗认出来，但也不要把所有同一种词都当玩梗**。」
 *
 * 难点不在"存梗"，在**判断当下到底是不是在玩梗** —— 中文梗大多是普通词
 * （「典」「急了」「上大分」），一旦常驻进提示词，模型就会**看什么都像梗**：
 * 别人正常说「这是经典案例」，她也要抖机灵。所以这个模块的核心是三件事：
 *
 *   ① **没命中就一个字都不注入**（`memesFor` 返回空串）—— 第一道闸；
 *   ② 命中触发词只是"候选"，**还要看有没有玩梗信号**才算真的在玩
 *      （复读、语气词「哈哈/乐/」、反问、和别的梗词同现）；
 *   ③ 注入的那段里**自带总规则**：平时这些词就是普通词、不要主动往梗上扯、
 *      拿不准按字面回；敏感类（键政/调戏）**只认不接**。
 *
 * ⚠️ 文件是**数据文件**（文件头那条声明）→ 不进聊天常驻知识库，只由这里按需读。
 * ⚠️ **每次调用现读盘**，改完 `memes.md` 不用重启。
 *
 * 用法：
 *   import { memesFor } from './memes.js';
 *   const m = memesFor(currentText);
 *   if (m) parts.push(m);   // 贴在提示词靠后的位置（离提问最近）
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KNOWLEDGE_DIR } from './config.js';

/** 强度全角星 → 数字档（★=1，★★=2，★★★=3） */
function starLevel(s) {
  const n = (String(s ?? '').match(/★/g) ?? []).length;
  return n >= 1 && n <= 3 ? n : 0;
}

let cache = null;
let cacheAt = 0;

/** 读盘并解析 `memes.md`（失败/没有 → []） */
function load() {
  let raw = '';
  try {
    raw = readFileSync(join(KNOWLEDGE_DIR, 'memes.md'), 'utf8');
  } catch {
    return [];
  }
  // 看的人用的说明（HTML 注释）解析时丢掉
  const text = raw.replace(/<!--[\s\S]*?-->/g, '');
  const items = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      const name = h[1].trim();
      // 空槽位（「（待补…）」）不算条目
      if (/^（待补/.test(name) || /^\(待补/.test(name)) {
        cur = null;
        continue;
      }
      cur = { name, words: [], ex: [], category: '玩梗', level: 0, body: [] };
      items.push(cur);
      continue;
    }
    if (!cur) continue;
    const t = line.trim();
    if (!t) continue;
    // - 触发词：典 / 典中典 / 这也太典了
    const w = t.match(/^[-*]\s*触发词[:：]\s*(.+)$/);
    if (w) {
      cur.words = w[1]
        .split(/[\/／、,，]/)
        .map((x) => x.trim())
        .filter(Boolean);
      continue;
    }
    const c = t.match(/^[-*]\s*类别[:：]\s*(.+)$/);
    if (c) {
      cur.category = c[1].trim();
      continue;
    }
    const l = t.match(/^[-*]\s*强度[:：]\s*(.+)$/);
    if (l) {
      cur.level = starLevel(l[1]);
      continue;
    }
    // - 排除词：经典 / 词典 / 典礼  ← 命中这些**长词**时不算梗（防误伤的核心）
    const e = t.match(/^[-*]\s*排除词[:：]\s*(.+)$/);
    if (e) {
      cur.ex = e[1]
        .split(/[\/／、,，]/)
        .map((x) => x.trim())
        .filter(Boolean);
      continue;
    }
    cur.body.push(t);
  }
  return items.filter((it) => it.name && it.words.length);
}

/** 取内存里的条目（带 5 秒缓存，避免一轮对话里反复读盘） */
function items() {
  const now = Date.now();
  if (!cache || now - cacheAt > 5000) {
    cache = load();
    cacheAt = now;
  }
  return cache;
}

/** 强制重载（测试用；界面热重载也可以调） */
export function reload() {
  cache = load();
  cacheAt = Date.now();
  return cache.length;
}

/**
 * 触发词 `w` 在 `t` 里**真的算命中**吗 —— 要排除"它其实是某个长词的一部分"。
 *
 * ⚠️ 这是"不要把普通词当玩梗"的**关键**：中文没有空格，
 *    「典」是「经**典**案例」「词**典**」「**典**礼」的一部分，
 *    光用 `includes` 会把这些**正常表达**全当成梗（而「典」恰恰是最容易被误伤的字）。
 *
 * 判据：找出 `w` 的每一处出现，只要**有一处不在任何排除词内部**，就算命中。
 *   · 「经**典**案例」→ 那处「典」落在排除词「经典」里 → 不算命中 ✓
 *   · 「**典**中典」  → 两处「典」都不在排除词里 → 算命中 ✓
 */
function wordHits(t, it) {
  for (const w of it.words) {
    if (!w) continue;
    let from = 0;
    for (;;) {
      const i = t.indexOf(w, from);
      if (i < 0) break;
      const inside = (it.ex ?? []).some((ex) => {
        if (!ex) return false;
        let j = t.indexOf(ex);
        while (j >= 0) {
          if (i >= j && i + w.length <= j + ex.length) return true;
          j = t.indexOf(ex, j + 1);
        }
        return false;
      });
      if (!inside) return true; // 有一处"独立出现" → 算命中
      from = i + 1;
    }
  }
  return false;
}

/** 这句话里出现了哪些梗（触发词命中、且不是被排除的长词） */
function hitsIn(text) {
  const t = String(text ?? '');
  if (!t) return [];
  const hit = [];
  for (const it of items()) {
    if (wordHits(t, it)) hit.push(it);
  }
  return hit;
}

/** 有没有"这像在玩梗"的旁证信号 */
function hasSignal(text) {
  const t = String(text ?? '');
  if (!t) return false;
  // 复读（连着重复同一个字，如「哈哈哈」「典典典」）
  if (/(.)\1{2,}/.test(t)) return true;
  // 语气词 / 笑声
  if (/哈哈|hhh|233|笑死|乐|hh|😂|🤣|😅|“|”|「|」/.test(t)) return true;
  // 反问 / 挑衅式
  if (/[?？]{1,}$/.test(t) || /是不是|对吧|敢不敢|你行你上/.test(t)) return true;
  // 一句话里同时出现两个及以上梗词 → 更可能是在玩（但要排除"同一梗的多个子词"）
  const names = new Set(hitsIn(t).map((x) => x.name));
  return names.size >= 2;
}

/** 这条在**有信号**时的档位（敏感类恒为 0 —— 只认不接） */
function activeLevel(it, signal) {
  if (/键政|调戏|敏感/.test(it.category)) return 0; // 敏感类：不按强度玩
  if (!signal) return it.level;
  return Math.min(3, it.level + 1); // 有旁证 → 涨一档
}

/**
 * 挑出这句话命中的梗，拼成要注入的提示词块（**没命中就返回空串**）。
 *
 * @param {string} text 对方说的话
 * @param {{max?:number}} [opts]
 * @returns {string}
 */
export function memesFor(text, opts = {}) {
  const t = String(text ?? '').trim();
  if (!t) return '';
  const hits = hitsIn(t);
  if (!hits.length) return '';
  const signal = hasSignal(t);
  const max = Number.isFinite(opts.max) ? opts.max : 3;

  const sensitive = [];
  const playing = [];
  for (const it of hits) {
    if (/键政|调戏|敏感/.test(it.category)) sensitive.push(it);
    else playing.push(it);
  }

  const lines = [
    '## 🎭 他这句话里可能有梗 —— 先判断是不是真在玩，再决定接不接',
    '',
    '- 下面这些词**平时就是普通词**，**绝不要主动往梗上扯、不要解释它是梗**（解释了像在上课）。',
    '- **拿不准就按字面正常回** —— 宁可漏接，也别见词就抖机灵。',
    '- 只有对方明显在调侃 / 接梗 / 复读时才顺着玩；**那句要不要接，看下面每条自己写的说明**。',
    '',
  ];

  for (const it of playing.slice(0, max)) {
    const lv = activeLevel(it, signal);
    const tag =
      lv >= 3 ? '★★★（可以顺着玩、反将一句）' : lv === 2 ? '★★（轻接一下就收，别展开）' : '★（只认得，不主动玩）';
    lines.push(`### 「${it.name}」命中（强度 ${tag}）`);
    if (it.body.length) lines.push(...it.body.map((b) => `- ${b}`));
    lines.push('');
  }

  if (sensitive.length) {
    for (const it of sensitive.slice(0, max)) {
      lines.push(`### 「${it.name}」命中（类别 ${it.category}）—— ⚠️ **只认不接**：不重复、不引申、不顺着说`);
      if (it.body.length) lines.push(...it.body.map((b) => `- ${b}`));
      lines.push('');
    }
  }

  return lines.join('\n').trim();
}