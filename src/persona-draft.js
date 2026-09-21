/**
 * 人设自动起草（P3，2026-09-21 加）。
 *
 * 用户要的东西：「加新人设时能**直接从网上搜集**好完整资料，直接填入之前的模板」，
 * 而且「**自动化的关键就在这里，我希望尽量少地使用人力**」。
 *
 * ## 它做什么
 *
 * 输入「角色名 + 作品名」→ 联网搜（`search.js`）+ 模型起草 →
 * 产出一份**能直接填进人设包**的 `identity` + `persona.md` + `voices.md`。
 *
 * ## ⚠️ 它**只起草，不落盘**
 *
 * 落盘是界面上"预览 → 逐节改 → 点保存"之后的事（走 `persona-admin`）。
 * 起草一次要花钱、要联网，结果**必须让用户过一眼**再决定要不要。
 *
 * ## 三条用户定死的规矩
 *
 * 1. **不给真人做人设**（隐私 + 平台规则）—— 模型先判断"这是虚构角色吗"，
 *    不是就 `blocked: true` 直接返回。
 * 2. **复用已有的动画库时只读不写** —— 人设里只能**声明**引用哪几个
 *    （`anime.works`，从 `knowledge/anime/` 现有的库里挑），绝不往那份库写东西。
 * 3. **`persona.md` 限长**（用户 2026-09-21 明确要求）—— 它**每次请求都进提示词**，
 *    越长每次越贵，而且中段最容易漏规则。硬上限 `MAX_PERSONA_CHARS`。
 */
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';
import { log } from './log.js';
import { streamChat } from './llm.js';
import { searchSmart, moegirlSearch, searchBlock } from './search.js';
import { parseJson } from './storyline.js';

/** ⚠️ `persona.md` 的**硬上限**（用户 2026-09-21 定：「对，限长」） */
export const MAX_PERSONA_CHARS = 3000;
/** `voices.md` 的上限（它也是进提示词的，只是按需） */
export const MAX_VOICES_CHARS = 2000;

const bad = (msg) => {
  const e = new Error(msg);
  e.bad = true;
  return e;
};

/** 现在有哪些动画库（`knowledge/anime/<名>.md`）—— 起草时**只能从这里面选** */
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

const SYS = `你在给一个 QQ 群机器人**起草一份"人设包"**。

用户会给你：角色名、出自哪部作品、一批**联网搜到的资料**（可能不全、也可能有错）。
你要产出一份 JSON。**只输出 JSON**：不要解释、不要包代码块、不要前后废话。

## 第一步：这是不是一个**虚构角色**

如果是**真人**（现实里的演员 / 艺人 / 主播 / 博主 / 网友…）⇒ 直接输出：
{"blocked": true, "why": "一句话说清"}

⚠️ 这是硬规矩（隐私 + 平台规则）：**不给真人做机器人人设**。
也**不许**把真人"改写"成虚构角色来绕过这条。

## 第二步：资料可能不准

网上的资料**经常有错**（生日、身高、关系、剧情细节都可能错）。所以：
- **只写你有把握的**；拿不准就**留空**，别编；
- ⚠️ 绝不编具体数字、具体台词、具体关系 —— 编出来的人设会在群里露馅。

## 输出格式（严格按这个 JSON，字段名不许改）

{
  "blocked": false,
  "identity": {
    "id": "照抄用户给的 id",
    "name": "角色全名",
    "selfName": "她自己提自己时用哪个词（例：Saki）",
    "displayName": "对外显示的身份（例：客服 Saki）",
    "shortName": "群里最常叫的短名字（例：小祥）",
    "narrativeName": "剧情叙述里的第三人称名（例：祥子）",
    "selfNames": ["判断『是不是在说自己』要用的写法", "中英文都写上"],
    "callNames": ["群友怎么叫她算『点名叫她』"],
    "nicknames": ["所有外号", "别人叫她任何一个都该正常回应"],
    "matchNames": ["判据用的名字原子，允许单字（例：祥）和变体"],
    "ambiguity": [{ "name": "有歧义的名字", "unless": "出现这个词时不算在叫她" }],
    "renameObjection": { "dislike": ["她不喜欢被叫的写法"], "prefer": "希望大家叫她哪个" },
    "work": { "title": "身份 / 职业", "org": "在哪儿做这件事" },
    "anime": {
      "works": ["⚠️ 只能从下面『已有的动画库』里选；一个都不合适就留空数组"],
      "keywords": ["作品名、同作品的角色名 —— 问到这些就该联网搜"]
    },
    "address": { "owner": "平时怎么叫主人（拿不准就留空）", "ownerFormal": "", "ownerRule": "" },
    "style": { "short": true, "tsundere": false, "verbalTics": ["口癖词"] },
    "prompt": {
      "personaLine": "自我介绍那一整句",
      "styleLine": "性格那一整句",
      "quickAside": "只能塞一句时的紧凑版",
      "spokenNames": "群里怎么叫她，**带括号**（例：（「小祥」「客服小祥」「saki」））",
      "attributionTone": "发言前核对归属时提醒的语气，**带括号**",
      "followUpLine": "『说完又想补一句』那次的人格声明（一整句）",
      "castNames": "故事里最常出现的几个人（顿号分隔）",
      "questHomeDirs": "剧情里『家里』这个方向的题材",
      "questPastThreads": "『过去找上门』那类题材",
      "questOtherGroups": "偶尔碰上的其他团 / 旧识"
    }
  },
  "docs": {
    "persona.md": "核心人设正文（**字数硬限制见下**）",
    "voices.md": "示例对话（见下）"
  },
  "notes": ["给用户看的提醒（例：『生日没查到，留空了』『这部作品没有现成的动画库，所以 anime.works 是空的』）"]
}

## persona.md 怎么写（⭐ 有**字数硬上限**）

- ⚠️⚠️ **必须 3000 字以内**（硬限制），**目标 1500~2500 字**。
  实测第一版只写了 498 字，太单薄 —— 最容易漏的是「绝对不能做的事」那类**关键规矩**，
  以及说话方式里的具体尺度。宁可写满一点，也别交一份只有形容词的骨架。
- 但也**别顶满**：它**每次请求都进提示词**，越长每次越贵，而且**中段最容易漏规则**。
- 建议结构：「你是谁」→「说话的方式」→「你的处境」→「绝对不能做的事」。
  ⚠️ 标代码/字段名一律用**中文引号**，别用反引号（这个文件本身在模板字符串里，
  反引号会把字符串提前结束 ⇒ 整个机器人起不来，2026-09-21 真踩了）。
  ⚠️ **铁律放开头和结尾各一次**——这是故意的：长上下文里中间最容易被漏。
- 写**具体、可执行**的规矩（「话短，一般不超过 15 字」「不用『您好』『请查收』」），
  **不要**写空泛的形容（「她很温柔很善良」这种没有用）。
- ⚠️ **别把剧情梗概抄进来** —— 那些该靠联网搜，不该占每次的提示词。

## voices.md 怎么写

贴几段示例对话，覆盖：打招呼 / 被夸 / 被骂 / 被问到不知道的事 / 主动接话 / 拒绝。
每段形如：
群友：早
她：（她会怎么回，写具体）
⚠️ 这是"人味"的关键 —— 比一堆形容词有用得多。控制在 2000 字以内。`;

/**
 * 起草一份人设。
 *
 * @param {{name:string, work?:string, id:string}} p
 * @param {{signal?:AbortSignal, timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, blocked?:boolean, why?:string, identity?:object,
 *   docs?:object, notes?:string[], sources?:object[], materialChars?:number}>}
 */
export async function draft(p = {}, opts = {}) {
  const name = String(p.name ?? '').trim();
  const work = String(p.work ?? '').trim();
  const id = String(p.id ?? '').trim();
  if (!name) throw bad('先填「角色名」');
  if (!/^[a-z0-9][\w.-]{0,31}$/i.test(id)) throw bad('id 只能字母数字开头（含 . - _），例：miku');

  const libs = availableAnimeLibs();

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
  // 二次元角色 ⇒ 萌娘百科通常是最靠谱的中文来源，单独再搜一次
  if (/[\u4e00-\u9fa5\u3040-\u30ff]/.test(name)) {
    try {
      push(await moegirlSearch(name, 3));
    } catch (e) {
      log.debug(`起草人设：萌娘百科没搜到（不影响）：${e.message}`);
    }
  }
  const material = searchBlock(query, results.slice(0, 12));
  log.info(`起草人设「${name}」：搜到 ${results.length} 条资料（${material.length} 字），交给模型`);

  // ── ② 模型起草 ──
  const user = [
    '# 要做的角色',
    `角色名：${name}`,
    work ? `出自：${work}` : '（用户没填出自哪部作品 —— 你自己判断，拿不准就在 notes 里说）',
    `人设包 id：${id}（identity.id 照抄这个）`,
    '',
    '# 已有的动画库（anime.works 只能从这里面选）',
    libs.length ? libs.join('、') : '（现在一个都没有 ⇒ anime.works 留空数组，并在 notes 里说明）',
    '',
    material,
  ].join('\n');

  const raw = await collect(
    [
      { role: 'system', content: SYS },
      { role: 'user', content: user },
    ],
    // 资料已经在手上，这是"改写"不是"推理" ⇒ 关思考链，快且便宜
    { maxTokens: 8000, thinking: { type: 'disabled' }, signal: opts.signal },
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

  // ── ③ 规范化 + 限长 ──
  const notes = Array.isArray(j.notes) ? j.notes.map((x) => String(x)) : [];
  const identity = j.identity && typeof j.identity === 'object' ? { ...j.identity } : {};
  identity.id = id; // ⚠️ 强制对齐（别让模型自己编一个）

  // anime.works 只允许现有库
  const an = identity.anime && typeof identity.anime === 'object' ? { ...identity.anime } : {};
  const wanted = Array.isArray(an.works) ? an.works.map((x) => String(x).trim()) : [];
  const kept = wanted.filter((w) => libs.includes(w));
  const dropped = wanted.filter((w) => !libs.includes(w));
  an.works = kept;
  identity.anime = an;
  if (dropped.length) {
    notes.push(
      `模型想引用这些动画库但没有现成的文件，已去掉：${dropped.join('、')}` +
        `（现有：${libs.join('、') || '无'}）—— ⚠️ 按规矩**不自动新建库**，要的话自己去建`,
    );
  }

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

  return {
    ok: true,
    blocked: false,
    identity,
    docs,
    notes,
    sources: results.slice(0, 12).map((r) => ({ title: r.title, url: r.url })),
    materialChars: material.length,
  };
}
