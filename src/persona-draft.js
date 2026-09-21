/**
 * 人设自动起草（P3，2026-09-21 加；2026-09-22 改成"按模板逐字段填"）。
 *
 * 用户要的东西：「加新人设时能**直接从网上搜集**好完整资料，直接填入之前的模板」，
 * 「自动化的关键就在这里，我希望尽量少地使用人力」。
 * 后来又补了一句关键的话：
 *   「联网**按模板**把人设填好就行了，**直接联网填容易填漏**」
 * ⇒ 所以现在是：
 *   ① **字段清单的唯一来源是 `personas/_template/identity.json`** ——
 *      模板加字段，这里自动跟上（不用改代码）；
 *   ② 提示词里把**每个字段**连同它的说明一起列给模型，明确"一个都不许省"；
 *   ③ 拿到结果后**按模板结构 merge**（模型没给的字段落回模板默认值）
 *      ⇒ **结构永远齐全**，不会出现"少了 shortName 结果状态标题变空"这种事。
 *
 * ## 它**只起草，不落盘**
 *
 * 落盘是界面上"预览 → 逐节改 → 点保存"之后的事（走 `persona-admin`）。
 *
 * ## 三条用户定死的规矩
 *
 * 1. **不给真人做人设**（隐私 + 平台规则）—— 模型先判断，不是虚构角色就 `blocked`。
 * 2. **动画库**：界面上选「复用已有的 / 新建一个 / 不用」——
 *    · 复用 ⇒ 只**声明**引用（`anime.works`），**绝不往那份库写东西**；
 *    · 新建 ⇒ 才让模型起草库内容，保存时写进 `knowledge/anime/<新库名>.md`。
 * 3. **`persona.md` 限长**（用户 2026-09-21：「对，限长」）—— 硬上限 `MAX_PERSONA_CHARS`。
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';
import { log } from './log.js';
import { streamChat } from './llm.js';
import { searchSmart, moegirlSearch, searchBlock } from './search.js';
import { parseJson } from './storyline.js';

/** ⚠️ `persona.md` 的**硬上限**（用户 2026-09-21 定：「对，限长」） */
export const MAX_PERSONA_CHARS = 3000;
/** `voices.md` 的上限 */
export const MAX_VOICES_CHARS = 2000;
/** 新建动画库时，库文件的上限 */
export const MAX_ANIME_CHARS = 4000;

const bad = (msg) => {
  const e = new Error(msg);
  e.bad = true;
  return e;
};

/**
 * **字段清单的唯一来源**：`personas/_template/identity.json`。
 *
 * ⚠️ 这个文件里的值是**说明文字**（"角色全名（例：初音未来）"这种）——
 *    它同时被用来①生成给模型看的字段表 ②保证草稿结构齐全。
 *    ⇒ 以后往模板加字段，起草这边**自动跟上**，不用改代码。
 */
export function templateIdentity() {
  const f = join(ROOT, 'personas', '_template', 'identity.json');
  try {
    return JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    log.warn(`读 _template/identity.json 失败（起草时会没有字段清单）：${e.message}`);
    return {};
  }
}

/** 照模板生成"空骨架"：结构一样、值清空（`_说明` 这种给人看的键不要） */
function shapeOf(v) {
  if (Array.isArray(v)) return [];
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (k.startsWith('_')) continue;
      o[k] = shapeOf(x);
    }
    return o;
  }
  if (typeof v === 'boolean') return false;
  return '';
}

/** 把模板里的说明文字拉平成「路径：说明」的清单（给模型看的字段表） */
function hintLines(v, prefix = '') {
  const out = [];
  if (Array.isArray(v)) {
    if (v.length && typeof v[0] === 'string') out.push(`${prefix}（数组）：${v.join(' ／ ')}`);
    else if (v.length && v[0] && typeof v[0] === 'object') out.push(...hintLines(v[0], `${prefix}[]`));
    else out.push(`${prefix}（数组）：没有就留空数组`);
    return out;
  }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k.startsWith('_')) continue;
      out.push(...hintLines(x, prefix ? `${prefix}.${k}` : k));
    }
    return out;
  }
  out.push(`${prefix}：${v === '' ? '（字符串）' : v}`);
  return out;
}

/** 按模板结构**合并**模型的输出 —— 模型没给的键落回 shape 的默认值 */
function mergeShape(shape, got) {
  if (Array.isArray(shape)) return Array.isArray(got) ? got : shape;
  if (shape && typeof shape === 'object') {
    const o = {};
    const g = got && typeof got === 'object' && !Array.isArray(got) ? got : {};
    for (const [k, x] of Object.entries(shape)) o[k] = k in g ? mergeShape(x, g[k]) : x;
    return o;
  }
  if (typeof shape === 'boolean') return typeof got === 'boolean' ? got : shape;
  return typeof got === 'string' ? got : typeof got === 'number' ? String(got) : shape;
}

/** 现在有哪些动画库（`knowledge/anime/<名>.md`） */
export function availableAnimeLibs() {
  const dir = join(ROOT, 'knowledge', 'anime');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .map((f) => f.replace(/\.md$/i, ''))
      .sort();
  } catch {
    return [];
  }
}

/** 把流式输出收成一段文本 */
async function collect(messages, opts = {}) {
  let out = '';
  for await (const d of streamChat(messages, opts.signal, opts)) out += d;
  return out;
}

/**
 * 起草一份人设。
 *
 * @param {{name:string, work?:string, id:string,
 *   animeMode?:'reuse'|'new'|'none', animeLib?:string, animeName?:string}} p
 * @param {{signal?:AbortSignal}} [opts]
 */
export async function draft(p = {}, opts = {}) {
  const name = String(p.name ?? '').trim();
  const work = String(p.work ?? '').trim();
  const id = String(p.id ?? '').trim();
  if (!name) throw bad('先填「角色名」');
  if (!/^[a-z0-9][\w.-]{0,31}$/i.test(id)) throw bad('id 只能字母数字开头（含 . - _），例：miku');

  const libs = availableAnimeLibs();
  const mode = ['reuse', 'new', 'none'].includes(p.animeMode) ? p.animeMode : 'none';
  const reuseLib = String(p.animeLib ?? '').trim();
  const newLib = String(p.animeName ?? '').trim().replace(/[^\w.-]/g, '');
  if (mode === 'reuse') {
    if (!libs.includes(reuseLib)) throw bad(`要复用的动画库「${reuseLib}」不存在（现有：${libs.join('、') || '无'}）`);
  }
  if (mode === 'new') {
    if (!newLib) throw bad('要新建的动画库得有名字（小写字母数字，例：bangdream）');
    if (libs.includes(newLib)) throw bad(`动画库「${newLib}」已经存在了 —— 想用它请选「复用已有」`);
  }

  const tpl = templateIdentity();
  if (!Object.keys(tpl).length) throw bad('读不到 personas/_template/identity.json —— 没有字段清单，没法保证不漏字段');
  const shape = shapeOf(tpl);
  const hints = hintLines(tpl);
  const wantAnimeDoc = mode === 'new';

  // ── ① 联网搜 ──
  const query = `${name}${work ? ` ${work}` : ''} 角色 设定`;
  const results = [];
  const seen = new Set();
  const push = (arr) => {
    for (const r of Array.isArray(arr) ? arr : []) {
      const u = String(r?.url ?? '');
      if (!u || seen.has(u)) continue;
      seen.add(u);
      results.push(r);
    }
  };
  try {
    push(await searchSmart(query, { signal: opts.signal }));
  } catch (e) {
    log.warn(`起草人设：搜「${query}」失败（继续，靠模型自己的知识）：${e.message}`);
  }
  if (/[\u4e00-\u9fa5\u3040-\u30ff]/.test(name)) {
    try {
      push(await moegirlSearch(name, 3));
    } catch (e) {
      log.debug(`起草人设：萌娘百科没搜到（不影响）：${e.message}`);
    }
  }

  // 新建库时，额外搜一轮"作品/世界观"的资料（库内容是作品层面的，不是角色层面）
  let libMaterial = '';
  if (wantAnimeDoc) {
    const libQ = `${work || name} 作品 世界观 设定 角色 简介`;
    const libResults = [];
    const seen2 = new Set();
    try {
      for (const r of await searchSmart(libQ, { signal: opts.signal })) {
        const u = String(r?.url ?? '');
        if (!u || seen2.has(u)) continue;
        seen2.add(u);
        libResults.push(r);
      }
    } catch (e) {
      log.warn(`起草动画库：搜「${libQ}」失败：${e.message}`);
    }
    libMaterial = searchBlock(libQ, libResults.slice(0, 10));
    push(libResults);
  }

  const material = searchBlock(query, results.slice(0, 12));
  log.info(
    `起草人设「${name}」：搜到 ${results.length} 条资料（${material.length} 字），` +
      `模板字段 ${hints.length} 个，动画库模式 ${mode}`,
  );

  // ── ② 让模型**按模板逐字段**填 ──
  const sys = [
    '你在给一个 QQ 群机器人**起草一份"人设包"**，然后把它填进用户给的模板里。',
    '',
    '**只输出 JSON**：不要解释、不要包代码块、不要前后废话。',
    '',
    '## 第一步：这是不是一个**虚构角色**',
    '',
    '如果是**真人**（现实里的演员 / 艺人 / 主播 / 博主 / 网友…）⇒ 直接输出：',
    '{"blocked": true, "why": "一句话说清"}',
    '',
    '⚠️ 硬规矩（隐私 + 平台规则）：**不给真人做机器人人设**。',
    '也不许把真人"改写"成虚构角色来绕过。',
    '',
    '## 第二步：验证要的字段，一个都不许省',
    '',
    '⚠️⚠️ 下面这份是**字段清单**（来自模板）。**每个字段都必须出现在你的 JSON 里** ——',
    '这次的教训就是"漏字段"：少一个 `shortName`，群里的状态标题就会空一块。',
    '**不清楚的字段就留空字符串 / 空数组，但键必须在。**',
    '',
    '形状（照这个结构给，值换成这个角色的真实内容）：',
    'SHAPE_PLACEHOLDER',
    '',
    '每个字段是什么（⚠️ 这是**说明**，别照抄进值里）：',
    ...hints.map((h) => `- ${h}`),
    '',
    '## 第三步：资料可能不准',
    '',
    '网上的资料**经常有错**（生日、身高、关系、剧情细节）。所以：',
    '- **只写你有把握的**；拿不准就**留空**，别编；',
    '- ⚠️ 绝不编具体数字、具体台词、具体关系 —— 编出来的人设会在群里露馅。',
    '',
    '## 另外两份文档',
    '',
    'drafts 里的 `persona.md` / `voices.md` 也要给（见下面字数限制）。',
    wantAnimeDoc
      ? '还要给 `animeLib`：这个作品的**动画库**内容（见下面）。'
      : '（这次不需要动画库内容。）',
    '',
    '## persona.md 怎么写（⭐ 有**字数硬上限**）',
    '',
    `- ⚠️⚠️ **必须 ${MAX_PERSONA_CHARS} 字以内**（硬限制），**目标 1500~2500 字**。`,
    '  实测第一版只写了 498 字，太单薄 —— 最容易漏的是「绝对不能做的事」那类**关键规矩**。',
    '- 但也别顶满：它**每次请求都进提示词**，越长每次越贵，而且**中段最容易漏规则**。',
    '- 建议结构：「你是谁」→「说话的方式」→「你的处境」→「绝对不能做的事」。',
    '  ⚠️ **铁律放开头和结尾各一次** —— 这是故意的：长上下文里中间最容易被漏。',
    '- 写**具体、可执行**的规矩（「话短，一般不超过 15 字」），**不要**空泛的形容（「她很温柔」）。',
    '- ⚠️ **别把剧情梗概抄进来** —— 那些该靠联网搜，不该占每次的提示词。',
    '  ⚠️ 标代码/字段名一律用**中文引号**，别用反引号。',
    '',
    '## voices.md 怎么写',
    '',
    '贴几段示例对话，覆盖：打招呼 / 被夸 / 被骂 / 被问到不知道的事 / 主动接话 / 拒绝。',
    `（${MAX_VOICES_CHARS} 字以内）⚠️ 这是"人味"的关键 —— 比一堆形容词有用得多。`,
    wantAnimeDoc
      ? [
          '',
          '## animeLib 怎么写（这个作品的"常识库"）',
          '',
          '⚠️ 这是给**以后所有引用这个库的角色**看的世界观资料，所以写**作品层面**的东西，',
          '不要写成某一个角色的档案：',
          '- 这个作品是什么、有哪些乐队/团体/阵营、主要角色是谁、粉丝常用外号；',
          '- **只写判别要点**（"认出来这是什么"就够），**剧情细节一律靠联网搜**，别往库里堆；',
          '- 用 markdown：`## 一、判别要点` + 表格（关键词 / 是什么 / 别搞混）；',
          `- ⚠️ ${MAX_ANIME_CHARS} 字以内。`,
        ].join('\n')
      : '',
  ]
    .join('\n')
    .replace('SHAPE_PLACEHOLDER', JSON.stringify(shape, null, 2));

  const user = [
    '# 要做的角色',
    `角色名：${name}`,
    work ? `出自：${work}` : '（用户没填出自哪部作品 —— 你自己判断，拿不准就在 notes 里说）',
    `人设包 id：${id}（identity.id 照抄这个）`,
    '',
    '# 动画库怎么处理（**已经定好了，别自己改**）',
    mode === 'reuse'
      ? `复用已有的库「${reuseLib}」⇒ identity.anime.works 就是 ["${reuseLib}"]，**不要**产出 animeLib`
      : mode === 'new'
        ? `新建一个库「${newLib}」⇒ identity.anime.works = ["${newLib}"]，**另外产出 animeLib**（库的正文）`
        : '不用动画库 ⇒ identity.anime.works 留空数组，**不要**产出 animeLib',
    `（现有的库：${libs.join('、') || '无'}）`,
    '',
    '# 输出格式',
    '{"blocked": false, "identity": {…按上面那份形状，**每个键都要有**…},',
    ' "docs": {"persona.md": "…", "voices.md": "…"},' +
      (wantAnimeDoc ? ' "animeLib": "…",' : ''),
    ' "notes": ["给用户看的提醒（例：『生日没查到，留空了』）"]}',
    '',
    material,
    wantAnimeDoc ? `\n# 关于这个作品（写 animeLib 用）\n${libMaterial}` : '',
  ].join('\n');

  const raw = await collect(
    [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    // 资料已经在手上，这是"改写"不是"推理" ⇒ 关思考链，快且便宜
    { maxTokens: 9000, thinking: { type: 'disabled' }, signal: opts.signal },
  );

  let j;
  try {
    j = parseJson(raw);
  } catch (e) {
    throw bad(`模型没给出可解析的 JSON：${e.message}`);
  }
  if (!j || typeof j !== 'object') throw bad('模型没给出 JSON 对象');
  if (j.blocked) {
    return { ok: true, blocked: true, why: String(j.why ?? '这个看起来是真人，不做'), sources: results.slice(0, 12) };
  }

  // ── ③ 按模板 merge ⇒ **结构一定齐全** ──
  const notes = Array.isArray(j.notes) ? j.notes.map((x) => String(x)) : [];
  const identity = mergeShape(shape, j.identity);
  identity.id = id; // ⚠️ 强制对齐（别让模型自己编一个）

  // 动画库由**界面上的选择**决定，不看模型怎么写
  const before = Array.isArray(j.identity?.anime?.works) ? j.identity.anime.works.map(String) : [];
  identity.anime = identity.anime && typeof identity.anime === 'object' ? identity.anime : {};
  identity.anime.works = mode === 'reuse' ? [reuseLib] : mode === 'new' ? [newLib] : [];
  if (before.filter((x) => !identity.anime.works.includes(x)).length) {
    notes.push(`模型本来想引用 ${before.join('、')}，已按你在界面上的选择改成 ${identity.anime.works.join('、') || '（不用）'}`);
  }

  // 看看有哪些字段模型**没给**（给了空的也算没填）—— 直接告诉用户哪里要补
  const empties = [];
  const walkEmpty = (s, g, path = '') => {
    if (Array.isArray(s)) {
      if (!Array.isArray(g) || !g.length) empties.push(path);
      return;
    }
    if (s && typeof s === 'object') {
      for (const [k, x] of Object.entries(s)) walkEmpty(x, g?.[k], path ? `${path}.${k}` : k);
      return;
    }
    if (typeof s === 'string' && !String(g ?? '').trim()) empties.push(path);
  };
  walkEmpty(shape, identity);
  if (empties.length) {
    notes.push(`这些字段模型没填（留空了，建议你过一眼补上）：${empties.join('、')}`);
  }

  // ── ④ 限长 ──
  const docs = {};
  for (const [file, limit] of [
    ['persona.md', MAX_PERSONA_CHARS],
    ['voices.md', MAX_VOICES_CHARS],
  ]) {
    let text = String(j.docs?.[file] ?? '').trim();
    if (!text) {
      notes.push(`模型没给 ${file}，留空了 —— 你自己写一段吧`);
      docs[file] = '';
      continue;
    }
    if (text.length > limit) {
      notes.push(`${file} 超了 ${limit} 字（模型写了 ${text.length} 字），**已截断** —— 建议你过一眼删减`);
      text = `${text.slice(0, limit)}\n\n（⚠️ 到这里被截断了：原文 ${text.length} 字，超过 ${limit} 字上限）`;
    }
    docs[file] = text;
  }
  if (!docs['persona.md']) notes.push('⚠️ 没有 persona.md 的人设等于"没有性格"，一定要补');

  let animeLib = '';
  if (wantAnimeDoc) {
    animeLib = String(j.animeLib ?? '').trim();
    if (!animeLib) notes.push(`模型没给动画库「${newLib}」的正文 —— 保存时会建一个空库，你得自己写`);
    else if (animeLib.length > MAX_ANIME_CHARS) {
      notes.push(`动画库超了 ${MAX_ANIME_CHARS} 字（${animeLib.length} 字），已截断`);
      animeLib = animeLib.slice(0, MAX_ANIME_CHARS);
    }
  }

  return {
    ok: true,
    blocked: false,
    identity,
    docs,
    animeLib,
    animeLibName: mode === 'new' ? newLib : '',
    filledFields: hints.length - empties.length,
    totalFields: hints.length,
    notes,
    sources: results.slice(0, 12).map((r) => ({ title: r.title, url: r.url })),
    materialChars: material.length,
  };
}
