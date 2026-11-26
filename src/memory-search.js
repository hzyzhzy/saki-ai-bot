/**
 * 「翻记忆」—— 让她自己按原话去翻以前的东西。
 *
 * 为什么不用向量库：一个人 / 一个群的生活，量没到那个份上。
 * 把原文留着、需要时按字面线索去找，比切碎了再拼回来更准，也少一道会出错的环节。
 * （同一条判断在 dsh-world 那边也是这么做的：memory_find 按原文找，不建索引。）
 *
 * ⚠️ 边界，别越：
 *   · **只搜"她自己知道的"** —— 当前群的资料库、共享群记忆、主人资料、学习档案、会话历史、
 *     近期群聊原文。不碰别的群的资料库（那属于别的群的事，翻出来就是串味）。
 *   · **只读**：一个字都不写盘。
 *   · 一次最多 8 条、每条 200 字摘录 —— 多了会把这一轮的上下文挤爆（这是它唯一的代价）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config, KNOWLEDGE_DIR, knowledgePrivateDir } from './config.js';
import { getHistory } from './history.js';
import * as recent from './recent.js';

const CLIP = 200;
const MAX = 8;
// 同一个来源最多占 3 条 —— 否则一个"群记忆"就能把 8 条全吃掉，别的来源一条都露不出来
const PER_SOURCE = 3;

/** 文件 → { 标题, 正文 }（读不到就是空） */
function readMd(dir, name, title) {
  const p = join(dir, name);
  if (!existsSync(p)) return [];
  try {
    const text = readFileSync(p, 'utf8');
    return [{ source: title, kind: 'file', text }];
  } catch {
    return [];
  }
}

/** 当前这个群 / 这个人能看的记忆文件清单（**不含别的群**） */
function memoryFiles(gid) {
  const out = [];
  // ① 本号的知识目录（群记忆、主人资料、学习档案都在这儿）
  const kdir = knowledgePrivateDir();
  out.push(...readMd(kdir, 'group-memory.md', '群记忆'));
  out.push(...readMd(kdir, 'owner.md', '主人的资料'));
  out.push(...readMd(kdir, 'learned.md', '她学过的（被纠正过的错）'));
  // ② 当前群自己的资料库
  const g = String(gid ?? '').trim();
  if (g && /^\d+$/.test(g)) {
    out.push(...readMd(join(kdir, 'groups'), `${g}.md`, `群 ${g} 自己的资料`));
    if (kdir !== KNOWLEDGE_DIR) out.push(...readMd(join(KNOWLEDGE_DIR, 'groups'), `${g}.md`, `群 ${g} 自己的资料`));
  }
  // ③ 她的日记（最近 7 篇 —— 她自己写的，"翻记忆"应该翻得到）
  try {
    const ddir = join(kdir, 'diary');
    const names = readdirSync(ddir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .slice(0, 7);
    for (const f of names) out.push(...readMd(ddir, f, `她的日记 ${f.replace(/\.md$/, '')}`));
  } catch {
    /* 还没写过日记 */
  }
  return out;
}

/** 从一段长文本里切出命中点附近的一小段（前后各留些，别从半句开始） */
function excerpt(text, q, size = CLIP) {
  const i = text.indexOf(q);
  if (i < 0) return '';
  const start = Math.max(0, i - Math.floor(size / 3));
  const end = Math.min(text.length, start + size);
  let s = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) s = `…${s}`;
  if (end < text.length) s = `${s}…`;
  return s;
}

function ago(ms) {
  const d = Date.now() - Number(ms || 0);
  if (!Number.isFinite(d) || d <= 0) return '';
  const m = Math.round(d / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

/**
 * 翻记忆。
 *
 * @param {{q?:string, gid?:string, scope?:string}} opts
 *   `q` 要找的字（原话里的词、人名、地名都行）
 *   `scope`：'memory'（默认，记忆文件）| 'chat'（聊天原文）| 'all'
 * @returns {{ok:boolean, items?:Array, text?:string, reason?:string}}
 */
export function findMemory({ q, gid = '', scope = 'memory' } = {}) {
  const key = String(q ?? '').trim();
  if (!key) return { ok: false, reason: '没说找什么' };
  const sc = ['memory', 'chat', 'all'].includes(String(scope)) ? String(scope) : 'memory';
  const needle = key.toLowerCase();
  const items = [];

  // ── ① 记忆文件（群记忆 / 主人资料 / 学习档案 / 本群资料库）──
  if (sc === 'memory' || sc === 'all') {
    for (const f of memoryFiles(gid)) {
      const lines = f.text.split(/\r?\n/);
      let taken = 0;
      for (const line of lines) {
        if (taken >= PER_SOURCE) break;
        if (!line.toLowerCase().includes(needle)) continue;
        const t = line.replace(/^[-*>·\s]+/, '').trim();
        if (t.length < 4) continue;
        items.push({ source: f.source, when: '', text: t.slice(0, CLIP) });
        taken++;
        if (items.length >= MAX) break;
      }
      if (items.length >= MAX) break;
    }
  }

  // ── ② 聊天原文：近期群聊 + 这个群的会话历史 ──
  if (items.length < MAX && (sc === 'chat' || sc === 'all')) {
    try {
      const list = recent.recentItems(String(gid ?? ''), 200) ?? [];
      let taken = 0;
      for (const m of list) {
        if (taken >= PER_SOURCE) break;
        const t = String(m?.text ?? '');
        if (!t.toLowerCase().includes(needle)) continue;
        items.push({ source: `群里的聊天`, when: ago(m?.time), text: t.slice(0, CLIP) });
        taken++;
        if (items.length >= MAX) break;
      }
    } catch {
      /* 近期缓冲读不到就算了 */
    }
  }
  if (items.length < MAX && (sc === 'chat' || sc === 'all')) {
    try {
      const h = getHistory(`group:${String(gid ?? '')}`, { rounds: 200 }) ?? [];
      let taken = 0;
      for (const t of h) {
        if (taken >= PER_SOURCE) break;
        const s = String(t ?? '');
        if (!s.toLowerCase().includes(needle)) continue;
        const cut = excerpt(s, key) || s.slice(0, CLIP);
        items.push({ source: '以前的对话', when: '', text: cut });
        taken++;
        if (items.length >= MAX) break;
      }
    } catch {
      /* 历史读不到就算了 */
    }
  }

  // 同一段话在两个地方都出现时只留一条（文件和历史经常重复）
  const seen = new Set();
  const uniq = items.filter((x) => {
    const k = x.text.slice(0, 40);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (!uniq.length) return { ok: true, items: [], text: '' };
  return { ok: true, items: uniq };
}

/** 把结果拼成"材料"，交给 `runReadTool` 塞回上下文 */
export function formatMemory(result, q) {
  if (!result?.ok) return '';
  const items = result.items ?? [];
  if (!items.length) return `（翻了一遍，「${q}」这件事她这边没有记录 —— 别编，就说想不起来了）`;
  const lines = items.map((x, i) => `${i + 1}. 【${x.source}${x.when ? ` · ${x.when}` : ''}】${x.text}`);
  return [
    `她自己翻出来的旧记录（找的是「${q}」，共 ${items.length} 条，**原文，别改写成别的事**）：`,
    ...lines,
    '',
    '⚠️ 只照这些说；没翻到的部分就说想不起来 / 记不清了，别补。',
  ].join('\n');
}
