/**
 * 学习档案：机器人在群里被群主教到的知识存这里。
 *
 * 设计要点：
 *   - 内容插在 `<!-- LEARNED:BEGIN -->` 和 `<!-- LEARNED:END -->` 之间
 *   - 每个条目是一个 `## 主题`，教同一主题会**覆盖**旧的（群主选的行为）
 *   - 但它**不会删除** `hzymtr-server.md` 里的原文，
 *     而是在提示词里声明「learned.md 优先级更高」来实现覆盖
 *   - 每次改动都在「修改记录」里留一行 + 保存被覆盖的旧内容，教错了能回滚
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, KNOWLEDGE_DIR } from './config.js';
import { log } from './log.js';
import { backupKnowledge } from './backup.js';

const FILE = join(KNOWLEDGE_DIR, 'learned.md');
const BEGIN = '<!-- LEARNED:BEGIN -->';
const END = '<!-- LEARNED:END -->';
/** 单条知识最大长度，防止有人灌长文 */
const MAX_FACT = 2000;

function read() {
  try {
    return readFileSync(FILE, 'utf8');
  } catch (e) {
    log.error(`读取 learned.md 失败: ${e.message}`);
    return '';
  }
}

function write(content) {
  // ⚠️ 改之前先备份 —— 这台机器上没有 git，教错了 / 模型抽错了没法回滚
  //    （真实踩过：把分享卡片里的玩笑话抽成了知识）。
  backupKnowledge(FILE);
  // 先写临时文件再改名，避免写一半断电留下坏文件
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, FILE);
}

/** 取出两个标记之间的正文 */
function extractBlock(text) {
  const i = text.indexOf(BEGIN);
  const j = text.indexOf(END);
  if (i === -1 || j === -1 || j < i) return '';
  return text.slice(i + BEGIN.length, j);
}

/** 把正文按 `## 主题` 切成条目 */
function parseEntries(block) {
  const entries = [];
  const re = /^##\s+(.+?)\s*$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(block)) !== null) {
    marks.push({ title: m[1].trim(), start: m.index, bodyStart: m.index + m[0].length });
  }
  for (let k = 0; k < marks.length; k++) {
    const end = k + 1 < marks.length ? marks[k + 1].start : block.length;
    entries.push({
      title: marks[k].title,
      body: block.slice(marks[k].bodyStart, end).trim(),
    });
  }
  return entries;
}

function renderEntries(entries) {
  if (!entries.length) return '';
  return (
    '\n' +
    entries
      .map((e) => `## ${e.title}\n\n${e.body}`)
      .join('\n\n') +
    '\n\n'
  );
}

/** 读出现有全部条目 */
export function listEntries() {
  const text = read();
  return parseEntries(extractBlock(text));
}

/** 给模型看的正文（只有条目部分，不含注释和维护说明） */
export function learnedText() {
  const text = read();
  const block = extractBlock(text);
  const entries = parseEntries(block);
  if (!entries.length) return '';
  return entries.map((e) => `## ${e.title}\n\n${e.body}`).join('\n\n');
}

/**
 * 新增或覆盖一个主题。
 * @param {string} topic 主题名（同名的会被覆盖）
 * @param {string} fact 内容
 * @param {{by?:string, byName?:string, where?:string}} meta 来源信息
 * @returns {{ok:boolean, replaced:boolean, error?:string, topic:string}}
 */
export function learn(topic, fact, meta = {}) {
  const t = String(topic ?? '').trim();
  const f = String(fact ?? '').trim();

  if (!t) return { ok: false, error: '主题为空', topic: t };
  if (!f) return { ok: false, error: '内容为空', topic: t };
  if (t.length > 60) return { ok: false, error: '主题太长（限 60 字）', topic: t };
  if (f.length > MAX_FACT) return { ok: false, error: `内容太长（限 ${MAX_FACT} 字）`, topic: t };

  const text = read();
  if (!text.includes(BEGIN) || !text.includes(END)) {
    return { ok: false, error: 'learned.md 缺少标记行，已被破坏', topic: t };
  }

  const block = extractBlock(text);
  const entries = parseEntries(block);

  // 同名主题覆盖；否则追加
  const idx = entries.findIndex((e) => e.title === t);
  const replaced = idx !== -1;
  const oldBody = replaced ? entries[idx].body : '';

  const stamped = `${f}\n\n> 由 ${meta.byName ?? meta.by ?? '未知'} 于 ${now()} 通过 ${
    meta.where ?? '群聊'
  } 教学录入。`;
  const entry = { title: t, body: stamped };

  if (replaced) entries[idx] = entry;
  else entries.push(entry);

  // 重建文件
  let out = text.slice(0, text.indexOf(BEGIN) + BEGIN.length);
  out += renderEntries(entries);
  out += text.slice(text.indexOf(END));

  // 记一笔修改记录（插在「修改记录」标题后面，最新的在最上面）
  const logLine = `- ${now()} **${replaced ? '覆盖' : '新增'}**「${t}」 by ${
    meta.byName ?? meta.by ?? '?'
  }${oldBody ? `\n  - 被覆盖的旧内容：${oldBody.split('\n')[0].slice(0, 120)}` : ''}`;
  out = insertChangeLog(out, logLine);

  try {
    write(out);
    log.info(`learned.md ${replaced ? '覆盖' : '新增'}主题「${t}」（${f.length} 字）`);
    return { ok: true, replaced, topic: t };
  } catch (e) {
    log.error(`写入 learned.md 失败: ${e.message}`);
    return { ok: false, error: e.message, topic: t };
  }
}

function insertChangeLog(text, line) {
  const marker = '## 修改记录';
  const i = text.indexOf(marker);
  if (i === -1) return text + '\n' + line + '\n';
  const after = i + marker.length;
  return text.slice(0, after) + '\n\n' + line + text.slice(after);
}

function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}`;
}

/**
 * 校验一份 `learned.md` 的**正文能不能被解析**（给管理界面直接编辑用）。
 *
 * ⚠️ 为什么必须校验（2026-09-14 用户要求「learned.md 也能修改」）：
 *
 *    这个文件**和别的知识库不一样** —— 它不是纯给模型读的散文，
 *    而是**代码在解析和维护**的：条目必须是 `## 主题`，
 *    而且必须有 `<!-- LEARNED:BEGIN -->` / `END` 两个标记。
 *
 *    界面上一旦把这些改坏（比如标记被删了、`##` 被改成 `#`），
 *    `learn()` / `forget()` / `listEntries()` 会**静默失效**：
 *    `learn()` 会直接返回「learned.md 缺少标记行，已被破坏」，
 *    而群主在群里说「记住：xxx」就没反应了 —— 很难查。
 *
 *    所以保存前先校验，不合格就**拒绝保存并说清原因**，
 *    总比让用户存进去、过几天发现"教了但没记住"要好。
 *
 * @param {string} text 整份文件内容
 * @returns {{ok:boolean, error?:string, entries?:number}}
 */
export function validateFile(text) {
  const t = String(text ?? '');
  const i = t.indexOf(BEGIN);
  const j = t.indexOf(END);
  if (i === -1) return { ok: false, error: `缺少 ${BEGIN} 这一行（这是代码用来定位条目的标记，不能删）` };
  if (j === -1) return { ok: false, error: `缺少 ${END} 这一行` };
  if (j < i) return { ok: false, error: `${END} 跑到 ${BEGIN} 前面了` };

  const block = t.slice(i + BEGIN.length, j);
  const entries = parseEntries(block);

  // ⚠️ 「有内容但没有一条 `## 主题`」= 解析器眼里的**空档案** —— 内容全丢了，
  //    但文件看着还有字，最容易骗过肉眼。
  if (!entries.length && block.replace(/\s/g, '')) {
    return {
      ok: false,
      error: 'BEGIN/END 之间只有文字，但没有一条 `## 主题` —— 这样代码解析不出任何条目（等于内容丢了）。每条知识都要以 `## 主题` 开头',
    };
  }
  const noBody = entries.find((e) => !e.body);
  if (noBody) return { ok: false, error: `条目「${noBody.title}」下面是空的` };
  const badTitle = entries.find((e) => e.title.includes('#'));
  if (badTitle) return { ok: false, error: `主题名里有 #：「${badTitle.title}」` };

  return { ok: true, entries: entries.length };
}

/** 删掉某个主题（群主可以用「忘记：xxx」） */export function forget(topic) {
  const t = String(topic ?? '').trim();
  const text = read();
  const entries = parseEntries(extractBlock(text));
  const idx = entries.findIndex((e) => e.title === t);
  if (idx === -1) return { ok: false, error: `没有找到主题「${t}」` };

  const removed = entries.splice(idx, 1)[0];
  let out = text.slice(0, text.indexOf(BEGIN) + BEGIN.length);
  out += renderEntries(entries);
  out += text.slice(text.indexOf(END));
  out = insertChangeLog(out, `- ${now()} **删除**「${t}」`);
  write(out);
  log.info(`learned.md 删除主题「${t}」`);
  return { ok: true, topic: t, removed: removed.body };
}

export function fileExists() {
  return existsSync(FILE);
}
