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
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, KNOWLEDGE_DIR } from './config.js';
import { log } from './log.js';
import { backupKnowledge } from './backup.js';
import { phrase } from './llm.js';

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

/**
 * 这条知识跟当前这句话沾不沾边。
 *
 * 判据：**标题的连续片段出现在消息里**。
 * 标题就是主题名（「OP获取链接」「大坝豆圣别名」「上浮的含义」），本身就带着查它的那个词。
 *
 * ⚠️⚠️ 2026-09-17：**第一版按标点拆标题，中文标题拆不开，等于没用**。
 *    探针抓到的：「大坝豆圣是谁」对不上标题「大坝豆圣别名」
 *    —— 因为它不含"大坝豆圣别名"这一整串，而我的拆分只得到这一整串。
 *    所以改成**滑窗**：把标题切成所有 3~6 字的连续片段，任一命中就算沾边。
 *
 * ⚠️ 从 **2 字**起滑窗（第一版从 3 字起，探针立刻抓到：「上浮是什么意思」对不上标题
 *    「上浮的含义」—— 因为"上浮"只有 2 字，3 字起的滑窗全落空了）。
 *    代价是「机器人应答风格」这类标题里的"机器"会经常误命中，但那**只多带一条**
 *    （约 200 字）；而漏掉一条她会**直接答错**。两边代价不对称，所以取宽的。
 *    **宁可多带一条，也不能漏。**
 */
function entryMatches(entry, text) {
  const hay = String(text).toLowerCase();
  const title = String(entry.title ?? '').trim();
  if (title.length < 2) return false;
  // 标题本身很短（2~3 字）时直接整串比，别滑窗
  if (title.length <= 3) return hay.includes(title.toLowerCase());

  for (let len = Math.min(6, title.length); len >= 2; len--) {
    for (let i = 0; i + len <= title.length; i++) {
      if (hay.includes(title.slice(i, i + len).toLowerCase())) return true;
    }
  }
  return false;
}

/** 把一条知识渲染成给模型看的样子 */
const fmtEntry = (e) => `## ${e.title}\n\n${e.body}`;

/**
 * 给模型看的正文（只有条目部分，不含注释和维护说明）。
 *
 * ⚠️⚠️ 2026-09-17：**加了"按需挑"**（原来是无条件全带上，那份 12.4K）。
 *
 *    用户的担心是「上下文太长偶尔会漏掉某一条规则」—— 一份 12.4K 的补充知识
 *    一直挂在提示词里，既稀释了真正该看的规则，也容易让话题被带偏。
 *    而且它是**最高优先级、会覆盖别人**的，一直挂着反而会压住更该说的话。
 *
 *    · **给了 `text`** → 只带**沾边**的那几条（一条都不沾边就返回空串）；
 *    · **没给 `text`** → 照旧全带上（兼容老调用点和界面预览）。
 *
 * @param {string} [text] 对方说的话（用来挑相关条目）
 */
export function learnedText(text = '') {
  const entries = parseEntries(extractBlock(read()));
  if (!entries.length) return '';

  const t = String(text ?? '').trim();
  // 没给文本 = 老行为（全带）。⚠️ 界面上的"预览/统计"就是靠这条路径。
  if (!t) return entries.map(fmtEntry).join('\n\n');

  const hit = entries.filter((e) => entryMatches(e, t));
  // ⚠️ 一条都没命中就返回空串 —— 返回全部的话，这次改造等于白做。
  if (!hit.length) return '';
  return hit.map(fmtEntry).join('\n\n');
}

/**
 * 教学该进哪一份知识库 —— **让模型分**。
 *
 * ⚠️ 2026-09-30 用户要求：「**以后学习到的知识也直接通过模型自动分到不同资料库**」。
 *
 * ⚠️ 为什么用模型而不是关键词表：教学进来的是**自然语言**
 *    （「东心乡盖楼要谁批」「开了 voxy 会怎么样」），关键词分不准；
 *    而且每加一条新教学就要维护一次规则表，久了没人维护。
 *
 * ⚠️⚠️ **失败一律回落 `other`**（= 写进 `learned.md`）——
 *    宁可位置不理想，也**绝不能因为分类失败把这条知识丢掉**。
 */
const TARGETS = {
  'server-basic': 'server-basic.md',
  'server-rules': 'server-rules.md',
  'server-world': 'server-world.md',
  'server-people': 'server-people.md',
  other: 'learned.md',
};
const CLASSIFY_SYS = `你在给一个 Minecraft 服务器 QQ 机器人的知识库分类。
把这条知识分到唯一一类，只输出 JSON：{"cat":"..."}

- "server-basic"：服务器本身的事（怎么进服、整合包、启动器、模组、版本、配置要求、报错与排障、群内指令、链接、机器人自己能做什么）
- "server-rules"：规则与权限（玩法规则、建设申请与审批、OP、白名单、存档、踢人封禁）
- "server-world"：世界设定（铁路/地铁/高铁线路、车站、行政区划、地名与别名、集团与公司、建设归属、工程改造）
- "server-people"：人的信息（谁是管理员、谁是谁、身份、别名、QQ 名与游戏 ID 的对应）
- "other"：不属于上面任何一类（机器人自己的行为规则、功能设计、临时通知、说不清的）`;

async function classify(topic, fact) {
  try {
    const raw = await phrase({
      system: CLASSIFY_SYS,
      user: `主题：${topic}\n内容：${fact}`,
      maxTokens: 80,
    });
    const m = /server-basic|server-rules|server-world|server-people|other/.exec(String(raw));
    return m ? m[0] : 'other';
  } catch (e) {
    log.warn(`教学分类失败（回落 learned.md）：${e.message}`);
    return 'other';
  }
}

/**
 * 往**任意一份知识库**里写一条（文件里已有同名 `## 主题` 就覆盖它）。
 *
 * ⚠️ 那几份是**散文式知识库**（不像 `learned.md` 有 BEGIN/END 条目结构），
 *    所以这里按 `## ` 切条、按标题替换；找不到同名标题就追加到文件末尾。
 * ⚠️ 覆盖时只替换"这一条到下一个 `## ` 之前"，其余内容一个字不动。
 */
function upsertIntoFile(fileName, title, body) {
  const file = join(KNOWLEDGE_DIR, fileName);
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    text = `# ${fileName}\n`;
  }
  const block = `## ${title}\n\n${body}`;
  const esc = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^##\\s*${esc}\\s*$`, 'm');
  const m = re.exec(text);
  if (!m) {
    backupKnowledge(file);
    writeFileSync(file, text.replace(/\s*$/, '') + '\n\n' + block + '\n', 'utf8');
    return { replaced: false };
  }
  const start = m.index;
  const rest = text.slice(start + m[0].length);
  const nextRel = rest.search(/^##\s/m);
  const end = nextRel === -1 ? text.length : start + m[0].length + nextRel;
  backupKnowledge(file);
  writeFileSync(
    file,
    text.slice(0, start) + block + '\n\n' + text.slice(end).replace(/^\s+/, ''),
    'utf8',
  );
  return { replaced: true };
}

/**
 * 新增或覆盖一个主题。
 * @param {string} topic 主题名（同名的会被覆盖）
 * @param {string} fact 内容
 * @param {{by?:string, byName?:string, where?:string}} meta 来源信息
 * @returns {{ok:boolean, replaced:boolean, error?:string, topic:string}}
 */
export async function learn(topic, fact, meta = {}) {
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
  const replacedOld = idx !== -1;
  const oldBody = replacedOld ? entries[idx].body : '';

  const stamped = `${f}\n\n> 由 ${meta.byName ?? meta.by ?? '未知'} 于 ${now()} 通过 ${
    meta.where ?? '群聊'
  } 教学录入。`;

  // ⚠️⚠️ 2026-09-30：**先让模型判断这条该进哪一份**（用户要求
  //    「以后学习到的知识也直接通过模型自动分到不同资料库」）。
  //    分到专题库就直接写那边；说不清 / 分类失败 → 走老路径写进 learned.md。
  const cat = await classify(t, f);
  const target = TARGETS[cat] ?? TARGETS.other;
  const logLine = `- ${now()} **${replacedOld ? '覆盖' : '新增'}**「${t}」 by ${
    meta.byName ?? meta.by ?? '?'
  } → ${target}${oldBody ? `\n  - 被覆盖的旧内容：${oldBody.split('\n')[0].slice(0, 120)}` : ''}`;

  if (target !== 'learned.md') {
    try {
      const r = upsertIntoFile(target, t, stamped);
      insertChangeLog(logLine);
      log.info(
        `教学「${t}」→ ${target}（${r.replaced ? '覆盖' : '新增'}，${f.length} 字，分类 ${cat}）`,
      );
      return { ok: true, replaced: r.replaced, topic: t, file: target, cat };
    } catch (e) {
      // ⚠️ 写专题库失败**不能把知识丢了** —— 往下走老路径，写进 learned.md
      log.error(`写入 ${target} 失败: ${e.message}（回落 learned.md）`);
    }
  }

  const entry = { title: t, body: stamped };
  if (replacedOld) entries[idx] = entry;
  else entries.push(entry);

  // 重建文件
  let out = text.slice(0, text.indexOf(BEGIN) + BEGIN.length);
  out += renderEntries(entries);
  out += text.slice(text.indexOf(END));

  insertChangeLog(logLine);

  try {
    write(out);
    log.info(`learned.md ${replacedOld ? '覆盖' : '新增'}主题「${t}」（${f.length} 字）`);
    return { ok: true, replaced: replacedOld, topic: t, file: 'learned.md', cat };
  } catch (e) {
    log.error(`写入 learned.md 失败: ${e.message}`);
    return { ok: false, error: e.message, topic: t };
  }
}

/**
 * 记一笔变更日志。
 *
 * ⚠️⚠️ 2026-09-30 改（用户说「学到的资料库太混乱，而且占字数也多」）：
 *    这段日志原来**写在 `learned.md` 里**（一个 `## 修改记录` 条目，最新在最上面）——
 *    而 `learned.md` 是**要进聊天提示词**的 ⇒ 一条流水账天天涨
 *    （实测已经 **6310 字，占整份的一半**），可它对回答**一点用都没有**
 *    （里面只有"谁在什么时候教了哪条"）。
 *    ⇒ 改成写 `logs/learned-changelog.md`（logs 不进知识库、也不进版本库）。
 *    ⚠️ 回滚能力不受影响：被覆盖的旧内容仍然存在 `knowledge/_backup/`。
 */
const LOG_FILE = 'logs/learned-changelog.md';
function insertChangeLog(line) {
  try {
    const f = join(ROOT, LOG_FILE);
    const old = existsSync(f)
      ? readFileSync(f, 'utf8')
      : '# learned.md 变更日志\n\n> 机器自动维护，**不进聊天提示词**。最新的在最上面。\n';
    const marker = '> 机器自动维护，**不进聊天提示词**。最新的在最上面。';
    const i = old.indexOf(marker);
    const out =
      i === -1
        ? old + '\n' + line + '\n'
        : old.slice(0, i + marker.length) + '\n\n' + line + old.slice(i + marker.length);
    mkdirSync(join(ROOT, 'logs'), { recursive: true });
    writeFileSync(f, out, 'utf8');
  } catch (e) {
    // ⚠️ 日志写失败**绝不能影响教学本身**
    log.warn(`写变更日志失败（不影响这次教学）：${e.message}`);
  }
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
  insertChangeLog(`- ${now()} **删除**「${t}」`);
  write(out);
  log.info(`learned.md 删除主题「${t}」`);
  return { ok: true, topic: t, removed: removed.body };
}

export function fileExists() {
  return existsSync(FILE);
}
