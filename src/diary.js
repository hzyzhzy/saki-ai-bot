/**
 * 日记：她自己在夜里写的一篇，一天一篇 —— 长期记忆（dsh-world 那套的「日记」）。
 *
 * ⚠️ 谁写：**她自己写**（模型用她的口吻），不是代码拼一份流水账。
 *    代码只负责"把今天值得回想的事摆给她看"，写完存盘、不再改。
 * ⚠️ 写给谁看：只给她自己（和主人翻）。它**不是台词** —— 注入提示词时也是"这是你以前写的"，
 *    不会让她照着念（写的时候也明确不许写成"总结报告/安慰人的话"）。
 * ⚠️ 存在哪：`knowledge/accounts/<QQ>/diary/YYYY-MM-DD.md`（每号自己的）。
 *    记忆页能翻能改，`memory-search`（翻记忆）也能查到。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { knowledgePrivateDir } from './config.js';
import { log } from './log.js';
import { phrase } from './llm.js';
import * as recent from './recent.js';

const DIRNAME = 'diary';

/** `diary/` 目录（不存在就建） */
export function diaryDir() {
  const d = join(knowledgePrivateDir(), DIRNAME);
  try {
    mkdirSync(d, { recursive: true });
  } catch {
    /* 建不了就让读的那一头返回空 */
  }
  return d;
}

const pad = (n) => String(n).padStart(2, '0');
export const dayOf = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const weekdayOf = (d = new Date()) => '日一二三四五六'[d.getDay()];

/** 列出最近的日记（新的在前） */
export function listDiaries(limit = 60) {
  const dir = join(knowledgePrivateDir(), DIRNAME);
  const out = [];
  let names = [];
  try {
    names = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
  } catch {
    return out;
  }
  names.sort().reverse();
  for (const f of names.slice(0, limit)) {
    const p = join(dir, f);
    let text = '';
    let st = null;
    try {
      text = readFileSync(p, 'utf8');
      st = statSync(p);
    } catch {
      continue;
    }
    const date = f.replace(/\.md$/, '');
    // 正文 = 去掉标题行之后的文字（列表里只显示第一句）
    const body = text
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('# '))
      .join('\n')
      .trim();
    out.push({
      name: `${DIRNAME}/${f}`,
      date,
      label: date,
      desc: body.split('\n')[0].slice(0, 80),
      size: st.size,
      mtime: (() => {
        const d = new Date(st.mtimeMs);
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      })(),
    });
  }
  return out;
}

/** 读某一篇（`2026-11-27`） */
export function readDiary(date) {
  const p = join(knowledgePrivateDir(), DIRNAME, `${date}.md`);
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/** 最近一篇日记的正文（给"她还记得昨天写过什么"用；没有就空串） */
export function latestDiary() {
  const [first] = listDiaries(1);
  if (!first) return '';
  const text = readDiary(first.date);
  return text ? { date: first.date, text } : '';
}

/**
 * 今天的材料：他自己那边今天发生的事 + 各群最近的对话。
 * ⚠️ 只给"她回想得起来的"：不给日志、不给工具调用过程（那些对她没意义）。
 */
function gatherMaterials(date, gids = []) {
  const parts = [];

  // ① 主人近况里**今天**那几条（`- 2026-11-27 05:05 ｜ …`）
  try {
    const owner = readFileSync(join(knowledgePrivateDir(), 'owner.md'), 'utf8');
    const b = owner.indexOf('<!-- OWNER-RECENT:BEGIN');
    const e = owner.indexOf('<!-- OWNER-RECENT:END');
    if (b >= 0 && e > b) {
      const today = owner
        .slice(b, e)
        .split('\n')
        .filter((l) => l.includes(date))
        .map((l) => l.replace(/^\s*[-*·]\s*/, '').trim())
        .filter(Boolean);
      if (today.length) parts.push(`# 他今天在做的事\n${today.slice(0, 8).join('\n')}`);
    }
  } catch {
    /* 没有 owner.md 就算了 */
  }

  // ② 各群最近的对话（她在场的那几句）
  const lines = [];
  for (const gid of gids) {
    let items = [];
    try {
      items = recent.recentItems(String(gid), 14) ?? [];
    } catch {
      items = [];
    }
    for (const m of items) {
      const t = String(m?.text ?? '').trim();
      if (!t) continue;
      const who = String(m?.name ?? '').trim() || '某人';
      lines.push(`[群${gid}] ${who}：${t.slice(0, 120)}`);
      if (lines.length >= 40) break;
    }
    if (lines.length >= 40) break;
  }
  if (lines.length) parts.push(`# 今天群里说的话（节选）\n${lines.join('\n')}`);

  return parts.join('\n\n').slice(0, 6000);
}

const SYS = (name) => `你在写「${name}」自己的日记 —— 只给自己看，不会发给任何人。

把它写成**她自己的回想**：今天看到的事、谁说了什么、她当时在想什么。

要求：
· 4~8 行，第一人称，像随手记下来的一段，不要分段小标题、不要列条目。
· 写**具体的人和事**（谁说了什么、哪件让她记住了）；别写「今天很开心」「收获很多」这种空话。
· ⚠️ **只写材料里出现的人和事** —— 去了哪、吃了什么、路上遇到谁，材料里没有就别编
  （日记会进她的长期记忆，编出来的细节以后会被她当成真事）。
· 不用总结今天的对话，也不用交代"我做了什么工作"。
· 不安慰人、不给建议、不做点评 —— 这不是回复谁，这是日记。
· 今天没什么值得写的，就写一两行，别硬编。
· 不要提「模型」「提示词」「记忆系统」这类词，也不要写自己的设定说明。
· 只输出日记正文。`;

/**
 * 写今天的日记。
 * @param {{force?:boolean, date?:string, gids?:string[], now?:Date, phrase?:Function}} opts
 *   `phrase` 只是给测试注入用的（省一次云端调用）
 * @returns {Promise<{ok:boolean, date?:string, chars?:number, file?:string, reason?:string}>}
 */
export async function writeDiary(opts = {}) {
  const now = opts.now ?? new Date();
  const date = opts.date ?? dayOf(now);
  const dir = diaryDir();
  const file = join(dir, `${date}.md`);
  if (!opts.force && existsSync(file)) return { ok: false, reason: '今天已经写过' };

  const materials = gatherMaterials(date, opts.gids ?? []);
  if (!materials.trim()) return { ok: false, reason: '今天没有可写的材料' };

  let name = '我';
  try {
    const persona = await import('./persona.js');
    name = persona.displayName?.() || persona.charName?.() || '我';
  } catch {
    /* 人设读不到就用「我」 */
  }

  const gen = typeof opts.phrase === 'function' ? opts.phrase : phrase;
  const raw = await gen({
    system: SYS(name),
    user: `今天是 ${date}（星期${weekdayOf(now)}）。\n\n${materials}`,
    maxTokens: 520,
  });
  const body = String(raw ?? '')
    .trim()
    // ⚠️ 模型偶尔会自己加一层 markdown 标题，去掉（文件头那个 `# 日期` 由代码写）
    .replace(/^#+\s*[^\n]*\n+/, '')
    .trim();
  if (!body) return { ok: false, reason: '模型没写出来' };

  writeFileSync(file, `# ${date} 星期${weekdayOf(now)}\n\n${body}\n`, 'utf8');
  log.info(`[日记] 写了 ${date}（${body.length} 字）→ ${DIRNAME}/${date}.md`);
  return { ok: true, date, chars: body.length, file: `${DIRNAME}/${date}.md` };
}
