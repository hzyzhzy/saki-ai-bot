/**
 * 口癖库（按号一份，动态，两段结构）。
 *
 * ⚠️ 为什么两段（2026-11-27 用户要求）：
 *   「已有口癖不能动，下面独立开一个动态段，也要能增删改，比如同词口癖就完善使用方法」
 *   · `PHRASES` 段 = **人工底本**：确认过的词，自动学习**一个字都不许动**（只有人能改）；
 *   · `PHRASES-AUTO` 段 = **自动段**：群观察每批往这里补；同一个词只**完善用法**、不重复起行。
 *   ⇒ 好处：自动学习再怎么跑，也污染不了你已经确认的那批词。
 *
 * ⚠️ 为什么单独一个库：口癖是**会变的** —— 半年前没人说「牛魔」。写死在 `lite.md` /
 *    `persona.md` 里只能靠人手动改、还得改三遍 ✗ ⇒ 改成按号的动态库，
 *    每次拼提示词**现读**（`prompt-lite.js` → `phrasesBlock()`）⇒ 改完立刻生效 ✓
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { knowledgePrivateDir } from './config.js';
import { log } from './log.js';
import { backupKnowledge } from './backup.js';

const BEGIN = '<!-- PHRASES:BEGIN -->';
const END = '<!-- PHRASES:END -->';
const AUTO_BEGIN = '<!-- PHRASES-AUTO:BEGIN -->';
const AUTO_END = '<!-- PHRASES-AUTO:END -->';
/** 两段各自的上限（自动段更容易膨胀） */
const MAX_MANUAL = 80;
const MAX_AUTO = 60;
/** 一条"怎么用"最长多少字 */
const MAX_HOW = 140;

export function phrasesFile() {
  return join(knowledgePrivateDir(), 'phrases.md');
}

const HEADER = `# 口癖库（她自己的说法库 · 动态）

> ⚠️ 这是**动态库**：拆成上下两段 ——
> · **上面那段（人工底本）**：确认过的词，**自动学习一个字都不许动**，只有你能改；
> · **下面那段（自动攒的）**：群观察每批往这里补，同词只**完善用法**、不重复加一条。
> 你在界面改完**立刻生效**（每次拼提示词都现读，不用重启）。
> 一行一条：\`词 ｜ 怎么用\`。⚠️ **过时了就删** —— 口癖会随时代变。
`;

const wrap = (manual, auto) =>
  `${HEADER}\n${BEGIN}\n${manual ? `\n${manual}\n\n` : ''}${END}\n\n` +
  `## 自动攒的（群观察每批往这里加）\n\n` +
  `> ⚠️ 这一段由**群观察**维护：新词追加在这里；**同一个词只会完善用法，不会再起一行**。\n` +
  `> 上面那段（人工底本）里的词，这里不会再出现 —— 自动流程**一个字都不改它**。\n\n` +
  `${AUTO_BEGIN}\n${auto ? `\n${auto}\n\n` : ''}${AUTO_END}\n`;

/** 取某一段的正文（按**整行**认标记：说明里会提到标记原文） */
function readSeg(text, beginMark, endMark) {
  const lines = String(text ?? '').split('\n');
  let bi = -1;
  let body = [];
  for (const raw of lines) {
    const l = raw.replace(/\r$/, '');
    if (bi < 0) {
      if (l.includes(beginMark)) bi = body.length; // 只用来标记"开始收"
      continue;
    }
    if (l.includes(endMark)) return body.join('\n').trim();
    body.push(l);
  }
  return '';
}

function splitSegs() {
  try {
    const text = readFileSync(phrasesFile(), 'utf8');
    return {
      manual: readSeg(text, BEGIN, END),
      auto: readSeg(text, AUTO_BEGIN, AUTO_END),
    };
  } catch {
    return { manual: '', auto: '' };
  }
}

/** 人工底本 */
export function readBody() {
  return splitSegs().manual;
}

/** 自动段 */
export function readAuto() {
  return splitSegs().auto;
}

const parseLines = (body) =>
  body
    .split('\n')
    .map((l) => l.replace(/^\s*[-*·]\s*/, '').trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^(.{1,24}?)[｜|]\s*(.+)$/.exec(line);
      return m ? { word: m[1].trim(), how: m[2].trim() } : { word: line, how: '' };
    });

/** 全部条目（人工 + 自动，人工在前） */
export function listPhrases() {
  const { manual, auto } = splitSegs();
  return [...parseLines(manual), ...parseLines(auto)];
}

/** 人工底本里的词（自动流程不许碰这些） */
export function manualWords() {
  return new Set(parseLines(readBody()).map((x) => x.word));
}

/**
 * 自动学习写进来的入口。
 *
 * 规则（用户定的）：
 *  ① 词在**人工底本**里 ⇒ **一个字都不改**、也不重复加（直接跳过）；
 *  ② 词在**自动段**里 ⇒ **完善用法**（新的说法比旧的更细就替换，否则什么都不做）；
 *  ③ 新词 ⇒ 追加到**自动段**。
 * @param {Array<{word:string, how?:string}>} items
 */
export function addPhrases(items = []) {
  const manual = parseLines(readBody());
  const auto = parseLines(readAuto());
  const manualSet = new Set(manual.map((x) => x.word));
  const autoMap = new Map(auto.map((x) => [x.word, x]));

  let addedCount = 0;
  let improved = 0;
  for (const it of items) {
    const w = String(it?.word ?? '')
      .replace(/^[-*·\s]+/, '')
      .trim();
    const h = String(it?.how ?? '').trim().slice(0, MAX_HOW);
    if (!w || w.length > 24) continue;
    // ① 人工底本：不许动
    if (manualSet.has(w)) continue;
    const cur = autoMap.get(w);
    if (cur) {
      // ② 同词：完善用法（只在新的更细、且不是重复时替换）
      if (h && h !== cur.how && !cur.how.includes(h)) {
        cur.how = h.length > cur.how.length ? h : `${cur.how}；${h}`.slice(0, MAX_HOW);
        improved += 1;
      }
      continue;
    }
    // ③ 新词
    autoMap.set(w, { word: w, how: h });
    addedCount += 1;
  }
  if (!addedCount && !improved) return { ok: true, added: 0, improved: 0 };

  const list = [...autoMap.values()].slice(-MAX_AUTO);
  const manualBody = manual
    .slice(0, MAX_MANUAL)
    .map((x) => `- ${x.word}${x.how ? ` ｜ ${x.how}` : ''}`)
    .join('\n');
  const autoBody = list.map((x) => `- ${x.word}${x.how ? ` ｜ ${x.how}` : ''}`).join('\n');

  const file = phrasesFile();
  try {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) backupKnowledge(file);
    writeFileSync(file, wrap(manualBody, autoBody), 'utf8');
  } catch (e) {
    log.warn(`[口癖库] 写盘失败：${e.message}`);
    return { ok: false, error: e.message, added: 0, improved: 0 };
  }
  return { ok: true, added: addedCount, improved };
}

/**
 * 给提示词用的那一段（**每次现读** ⇒ 界面上改完立刻生效）。
 * 空库返回空串（别塞空标题）。人工底本在前、自动段在后，标题分开说清楚。
 */
export function phrasesBlock() {
  const { manual, auto } = splitSegs();
  const m = parseLines(manual)
    .map((x) => `- ${x.word}${x.how ? ` ｜ ${x.how}` : ''}`)
    .join('\n');
  const a = parseLines(auto)
    .map((x) => `- ${x.word}${x.how ? ` ｜ ${x.how}` : ''}`)
    .join('\n');
  if (!m && !a) return '';
  let out = '\n# 说话先照这些词来（你和群里这些人的口癖 · 动态库）\n\n';
  out += '想夸、想吐槽、想接一句、想把话推回去 —— **先从下面挑一个词**，\n';
  out += '别自己现造形容词（那样出来的就是「规矩立得挺认真」这种说明书腔）。\n';
  out += '一次一两个，别堆；🚫 别把它当清单念、也别解释这个词是什么意思。过时的词就别用了。\n';
  /* ⚠️⚠️ 2026-11-27 加（用户：「句末不说**捏**了，而且口癖库里也没看到这个了」）——
   *   这一段写在提示词**最末尾**、口气最像"标准答案"⇒ 她连句末语气词也来这里找，
   *   库里没有「捏」就干脆不加了（而人设里那节明写着"配得上就加"）✗
   *   ⇒ 明写边界：**这个库只管短词**，语气词不归它管，别因为表里没有就不说 ✓ */
  out += '⚠️ **这个库只管"短词"**（夸 / 吐槽 / 推回去的那种）。\n';
  out += '句末语气词**不在这里**（捏 / 呢 / 嘛 / 诶 / 嗷 / 呗 / 呀）—— 那是你自己的说话习惯，\n';
  out += '照人设里那节判断该不该加，**别因为这张表里没有就不加** ✗\n';
  if (m) out += `\n${m}\n`;
  if (a) out += `\n（下面这些是最近群里新起来的说法）\n${a}\n`;
  return out;
}
