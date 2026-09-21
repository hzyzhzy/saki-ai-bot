/**
 * 人设身份：把「她是谁」从代码里抽出来的**唯一出口**（2026-09-21 加）。
 *
 * 数据来自 `personas/<id>/identity.json`，结构见 `personas/README.md`。
 *
 * ## 两类字段，用途完全不同 —— 别混
 *
 *   · **结构化字段**（`selfName` / `callNames` / `nicknames` / `ambiguity` …）
 *     → 给**逻辑**用：判断"这句话是在叫她吗"、"是不是中文歧义"。
 *       换人设时这些跟着换，代码一个字都不用动。
 *
 *   · **整句文案**（`prompt.*`）
 *     → 给**提示词**用，**整句替换**。
 *       ⚠️⚠️ **不要在代码里拼字段** —— 不同角色的自我介绍**结构本来就不一样**
 *       （有人有"外号都照应"这条规矩，有人没有），拼出来只会是个谁也不像的
 *       平均角色，那正是"掉人味"的典型死法。
 *
 * ## 两条硬约束
 *
 *   · **不缓存成死值**：`persona.id` 能在界面上热切换、`identity.json` 也能手改，
 *     所以靠 **mtime + 大小**判断要不要重读（界面保存后会走 `reload()`）。
 *   · **缺 `identity.json` 不崩**：那种情况下她只是"没有名字"，
 *     不该整个机器人起不来。但要**警告** —— 不然会变成"换了人设没反应"
 *     那种最难查的静默失败。
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { personaDir, personaId } from './config.js';
import { log } from './log.js';

let cache = null;
let cacheKey = '';
let warned = false;

function load() {
  const dir = personaDir();
  const file = join(dir, 'identity.json');
  let key = `${dir}|missing`;
  try {
    if (existsSync(file)) {
      const st = statSync(file);
      key = `${dir}|${st.mtimeMs}|${st.size}`;
    }
  } catch {
    /* stat 失败就按"文件没有"处理，下面会走兜底 */
  }
  if (cache && cacheKey === key) return cache;
  cacheKey = key;

  if (key.endsWith('|missing')) {
    if (!warned) {
      warned = true;
      log.warn(
        `人设包「${personaId()}」里没有 identity.json —— 名字/外号/称呼会用空值，` +
          `她会"没有名字"。照 personas/_template/identity.json 建一个：${file}`,
      );
    }
    cache = {};
    return cache;
  }
  try {
    // ⚠️ 剥 BOM：记事本/PowerShell 写出来的 JSON 常带 BOM，JSON.parse 会直接报错
    cache = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    warned = false;
  } catch (e) {
    log.error(`identity.json 读不了（${e.message}）—— 当作空，检查 JSON 格式：${file}`);
    cache = {};
  }
  return cache;
}

/** 人设包换了 / 文件被改了之后调它（界面保存后走这条） */
export function reload() {
  cache = null;
  cacheKey = '';
  warned = false;
  load();
  return status();
}

const str = (v, fb = '') => (typeof v === 'string' && v.trim() ? v.trim() : fb);
const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);

/** 整个对象（一般不用它，用下面那些访问器） */
export const identity = () => load();

export const selfName = () => str(load().selfName);
export const charName = () => str(load().name);
export const displayName = () => str(load().displayName);
/**
 * **昵称形式**的名字（2026-09-21 加）。
 *
 * 用途：状态标题那种"捧场**小祥**""客服**小祥**" —— 那里用的**不是**自称（`Saki`）、
 * 也不是全名，而是群里最常叫的那个短名字。用 `selfName()` 去填会变成"捧场 Saki"，改味。
 *
 * ⚠️ 三级回落：`shortName` → `selfName` → `name`。留空也不会让标题缺字。
 */
export const shortName = () => str(load().shortName) || str(load().selfName) || str(load().name);

/**
 * **剧情 / 叙述里用的名字**（2026-09-21 加）。
 *
 * 用途：剧情提示词里那种「视角是**祥子**」「**祥子**在群里说的第一句」——
 * 那里用的是**第三人称叙述名**，既不是自称（`Saki`）也不是群里的昵称（`小祥`）。
 *
 * ⚠️ 用 `shortName()` 去填会变成「视角是**小祥**」——**文案就改了**。
 *    （2026-09-21 核对 git diff 时当场发现的：逐字核对这一步是有用的。）
 * ⚠️ 两级回落：`narrativeName` → `shortName`（没配就用昵称，至少不会缺字）。
 */
export const narrativeName = () => str(load().narrativeName) || shortName();
export const selfNames = () => arr(load().selfNames);
export const callNames = () => arr(load().callNames);
export const nicknames = () => arr(load().nicknames);

/**
 * 正则转义 —— 名字是**数据**，里面可能有括号、空格、点，
 * 直接拼进 `new RegExp()` 会拼出一个坏正则（甚至语法错误）。
 * 凡是用 persona 字段拼正则的地方，都必须先过它。
 */
export const escapeRe = (s) => String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * **做判据用的名字原子**（`identity.matchNames`，2026-09-21 加）。
 *
 * 和上面那几个的区别：上面是"**她叫什么**"（给人看的、进提示词的），
 * 这里是"**代码要在句子认出她来**"要匹配的碎片 —— 所以**允许单字和变体**：
 * 例「祥」既能匹配「小祥」也能匹配「祥子」，而 `nicknames` 里不会列一个单字。
 *
 * 谁在用：`mama.js`（「祥妈」「小祥妈妈」算不算在叫她）、
 * `search.js`（搜之前把呼语「小祥，…」剥掉）。
 *
 * ⚠️ 不填就从 `shortName / narrativeName / selfName / name / selfNames` 凑 ——
 *    凑出来的**不含单字**，判据会略严（宁可漏判，不要误判）。
 */
export function matchNames() {
  const it = load();
  const list = arr(it.matchNames);
  if (list.length) return list;
  return [
    ...new Set(
      [str(it.shortName), str(it.narrativeName), str(it.selfName), str(it.name), ...arr(it.selfNames)].filter(Boolean),
    ),
  ];
}

/**
 * 把 `matchNames()` 拼成正则用的分支串（**已转义、长的在前**）。
 *
 * ⚠️ 长的排前面是有意的：`客服小祥` 要排在 `小祥` 前面，
 *    否则 `^(?:小祥|客服小祥)` 在 "客服小祥…" 上会先试短的那个。
 *    （其实是"先试后回溯"，结果一样，但排好序省事也更好读。）
 * ⚠️ 一个名字都没有时返回 `(?!)`（**永不匹配**）——
 *    绝不能返回空串，那会拼出 `(?:)` 这种"匹配空"的写法，
 *    于是任何句子都会被判成"在叫她"。
 */
export function matchNamesAlt() {
  const alt = [...new Set(matchNames())]
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join('|');
  return alt || '(?!)';
}

/**
 * **她不喜欢被叫的称呼 + 希望大家叫她什么**（`identity.renameObjection`）。
 *
 * ⚠️ 用途很窄，别当成"称呼白名单"：只给 `llm.js` 里那条**拦自我纠正**的判据用 ——
 *    她**不该去管别人怎么叫她**（用户 2026-09-13：「别人叫她所有外号都应该没关系」），
 *    只有「我不叫祥子」「别叫我祥子」「叫我 Saki 就行」这种**答非所问的纠正**要拦掉。
 */
export function renameObjection() {
  const r = load().renameObjection;
  const o = r && typeof r === 'object' ? r : {};
  return { dislike: arr(o.dislike), prefer: str(o.prefer) };
}
export const ambiguity = () => (Array.isArray(load().ambiguity) ? load().ambiguity : []);
export const style = () => {
  const s = load().style;
  return s && typeof s === 'object' ? s : {};
};

/**
 * **她引用哪些动画库**（`identity.anime.works`）。
 *
 * 每个名字对应一个文件：`knowledge/anime/<名字>.md`。
 * 这是"换角色不会串味"的关键 —— **没声明的库，她根本读不到**：
 *   · Saki 声明 `bangdream`，所以她看得见邦邦的事；
 *   · 换成别的角色、声明里没有 `bangdream`，那份库里写的东西就**不进她的提示词**。
 *
 * ⚠️ 返回**空数组** = 一个动画库都不读（**不是**"读全部"）——
 *    新人设包没填这个字段时，宁可让她不懂二次元，也别把别人的世界观塞给她。
 * ⚠️ 名字做**文件名白名单**校验（只留字母数字点横线），挡 `../` 那种。
 */
export function animeWorks() {
  const a = load().anime;
  const list = a && typeof a === 'object' ? arr(a.works) : [];
  return list.map((x) => String(x).trim()).filter((x) => /^[\w.-]+$/.test(x));
}

/**
 * **问到这些词就该联网搜**（`identity.anime.keywords`）。
 *
 * 作品名、同作品的角色名都写这里 —— 它有两个用处：
 *   ① `search-presearch.js` 判断"这是不是关于她自己企划的问题"（该搜还是该直接答）；
 *   ② 命中就说明该去查最新动态。
 * ⚠️ 跟 `animeWorks()` 是两件事：**那个决定读哪份库，这个决定什么时候去搜。**
 */
export function animeKeywords() {
  const a = load().anime;
  return a && typeof a === 'object' ? arr(a.keywords) : [];
}

/**
 * **这个角色的 QQ 昵称 / 头像**（`identity.qq`，2026-09-21 加）。
 *
 * ⚠️ 用途：**切换人设时自动把真号上的昵称和头像换成这里的值**
 *    （用户原话：「昵称和头像应该就是自动改的，要不然就没意义了」）。
 * ⚠️ `avatar` 是**人设包里的文件名**（相对包根，例 `avatar.png`），
 *    不是 URL —— 头像图片跟着人设包走，换角色就是换文件。
 * ⚠️ 两个都可以留空：留空 = 那一项**不动**（不是清空）。
 */
export function qq() {
  const q = load().qq;
  const o = q && typeof q === 'object' ? q : {};
  return { nickname: str(o.nickname), avatar: str(o.avatar) };
}

/**
 * **她怎么称呼别人**（`identity.address.*`）。
 *
 * ⚠️ 和「别人怎么称呼她」是两回事，后者是顶层那些字段（`selfName` / `nicknames`…）。
 * ⚠️⚠️ 这里只管**叫法**。**"主人是谁"是共用事实**（`config.ownerQQ` + `knowledge/owner.md`），
 *    换人设**不该**动它 —— 换个角色该改的是"你叫他什么"，不是"你主人变成了别人"。
 * ⚠️ `admin` / `member` 留空 = 用群名片（`names.js` 那条路），大多数角色都该是空的。
 */
export const address = () => {
  const a = load().address;
  return a && typeof a === 'object' ? a : {};
};
export const callOwner = () => str(address().owner);
export const callOwnerFormal = () => str(address().ownerFormal);

/**
 * 提示词里的**整句**（`identity.prompt.<key>`）。
 *
 * ⚠️ 取不到时返回**空字符串**，**绝不兜底编一句** —— 编出来的那句不是这个人设说的话。
 *    调用方自己决定没有它怎么办（一般是跳过那一段）。
 */
export function promptText(key) {
  const p = load().prompt;
  return p && typeof p === 'object' ? str(p[key]) : '';
}

/**
 * 读人设包里的**长段提示词**（`personas/<id>/prompt/<name>.md`）。
 *
 * ⚠️ 为什么长段不放 `identity.json`：131 行中文塞进 JSON 要写成 `\n` 转义，
 *    既没法读也没法改，界面上更没法编辑。**短句走 `promptText()`，长段走这里。**
 * ⚠️ 取不到时返回**空字符串**，不兜底编 —— 和 `promptText()` 一个道理：
 *    编出来的那段不是这个人设说的话。
 * ⚠️ 文件名做白名单（只留字母数字点横线），别让它拼出 `../` 去读别处。
 * ⚠️ 不缓存（每次读盘）：换人设、或者用户在界面上改了这个 md，都要立刻生效。
 */
export function promptFile(name) {
  const safe = String(name ?? '').replace(/[^\w.-]/g, '');
  if (!safe) return '';
  const file = join(personaDir(), 'prompt', `${safe}.md`);
  try {
    if (!existsSync(file)) return '';
    return readFileSync(file, 'utf8');
  } catch (e) {
    log.warn(`读人设长段提示词失败（${safe}）：${e.message}`);
    return '';
  }
}

export function status() {
  const it = load();
  return {
    id: personaId(),
    dir: personaDir(),
    loaded: Object.keys(it).length > 0,
    name: str(it.name),
    selfName: str(it.selfName),
    nicknameCount: arr(it.nicknames).length,
    promptKeys: it.prompt && typeof it.prompt === 'object' ? Object.keys(it.prompt) : [],
  };
}
