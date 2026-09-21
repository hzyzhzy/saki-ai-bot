/**
 * 加载 knowledge/ 目录下的 markdown 知识文件，供系统提示词使用。
 * 改完文件重启机器人即生效。
 */
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, KNOWLEDGE_DIR, config, personaId, personaDir } from './config.js';
import { log } from './log.js';
import { learnedText, listEntries } from './learned.js';
import { animeWorks } from './persona.js';
// ⚠️ 2026-09-17 加：群友常**@着某人**问「介绍一下他」，而文本里**没有名字** ——
//    得靠 at 段的 QQ 号反查出群名片，才能判断"这是在说资料里的某个人"。
import * as names from './names.js';

/** ⚠️ 走 `config.js` 的 `KNOWLEDGE_DIR`（测试可以用 `QQBOT_KNOWLEDGE_DIR` 整份搬走） */
const DIR = KNOWLEDGE_DIR;
/** 学习档案单独处理（优先级更高），不参与下面的通用拼接 */
const LEARNED = 'learned.md';
/**
 * ⚠️ **群资料库**目录（2026-09-15 晚加，<主人> 要求）：
 *    `knowledge/groups/<群号>.md` —— **只在该群里注入**。
 *
 *    为什么要分群（用户原话）：「最开始的群只玩 mc，但是这个 699 开头的群，
 *    群友玩的游戏很多、活跃人数也多」—— 一份大杂烩会让 A 群的知识污染 B 群的回答。
 *    ⚠️ 目录放在 `knowledge/` 下面（不是同级），这样 `readdirSync(DIR)` 那份
 *       "全局知识"列表**天然看不见它**（不递归），不会混进去。
 */
const GROUP_DIR = join(DIR, 'groups');

/**
 * 动画库（`knowledge/anime/<库名>.md`）—— 2026-09-21 从"一个共用 `anime.md`"改过来。
 *
 * ⚠️ **不再自动全读**：一个库进不进她的提示词，由**人设声明的库名**决定
 *    （`identity.anime.works`，见 `persona.animeWorks()`）。
 *    为什么：换角色之后她不该还认识上一个角色的作品 ——
 *    「anime 库只有 bangdream 的内容」时，这份库就是**邦邦的库**，
 *    下一份库（别的作品）该是另一个文件、另一套世界观。
 * ⚠️ 所以这个目录**不能被当成 knowledge/ 根目录下的普通 md 扫进来** ——
 *    它是"库池"，扫进来就会全量注入，等于没改。（`readdirSync` 只取 `.md`，
 *    子目录天然不会被扫到 ✓ 但新增库时也别往根目录丢。）
 * ⚠️ 人设**没声明任何一个** = 一个都不读（不是"读全部"）。
 */
const ANIME_DIR = join(DIR, 'anime');
/**
 * 私聊记忆目录（2026-09-17 加）。
 *
 * 用户要求：「**机器人和群友的私聊也应该和群里一样，记下性格和事件**」（附了私聊截图）。
 * 在此之前 `observe.js` 第 104 行直接 `if (message_type !== 'group') return;` ——
 * 私聊里说过的话**一个字都不留**，所以她跟人私聊永远是"每次从零开始"。
 *
 * ⚠️ 这里**故意复用同一张 `groupFiles` 表**，key 用 `dm:<QQ号>`：
 *    `selectFor()` / `knowledgeText()` 只认一个 `groupId` 参数，不关心它长什么样，
 *    所以私聊记忆能白蹭整套注入逻辑（含「别的群标签块要摘掉」那套）。
 *    另起一套并行的表只会让两边慢慢长歪。
 *
 * ⚠️⚠️ `knowledge/` 整个目录都在 live 的 `.gitignore` 里、导出时也被排除 ——
 *    所以**真实的私聊内容不会进公开仓库**（这条比什么都重要）。
 */
const DM_DIR = join(DIR, 'dm');
/** 群号 → { name, content }（`name` 是给人看的相对路径 `groups/<群号>.md`） */
let groupFiles = new Map();

/**
 * ⚠️⚠️ 「数据文件」**不进聊天提示词**（2026-09-15 加）。
 *
 * 有些 md 不是给聊天看的，是**给功能当数据用的**：
 *   · `life-events.md` —— 一级日常事件库（53 条）
 *   · `holidays.md`     —— 节日表（36 个节日）
 * 它们由 `src/life.js` / `src/holiday.js` **自己直接读盘**，
 * 混进聊天知识库纯属添乱：既白占提示词，又会让机器人**照着事件原文念**。
 *
 * 踩过的证据：加完这两个文件，启动日志立刻变成
 * 「已加载知识库 **7** 个文件：…, holidays.md, …, life-events.md, …」——
 * 它们被当成普通人设/资料库了。
 *
 * ⚠️ 判据**写在文件里**，不是写死文件名 —— 以后再加这类文件不用改代码。
 *    在文件里任意位置放一条这样的声明即可：
 *        `<!-- 声明：数据文件，不进聊天知识 -->`
 */
const DATA_MARK = '数据文件，不进聊天知识';

/**
 * ⚠️⚠️ **共享文件里的「群标签块」**（2026-09-15 晚加）。
 *
 * ```
 * <!-- 群:200000006 -->
 * ……这段只给 699 群看……
 * <!-- /群 -->
 * ```
 *
 * 语义：
 *   · 标着 `群:<群号>` 的块**只在该群**注入；别的群看这段等于不存在（＝**屏蔽**）；
 *   · 群自己已经有 `groups/<群号>.md` 时，共享文件里标着它群号的块**会被丢掉**
 *     —— 免得同一段内容注入两遍（复制过去之后原文还留着，就是这种情况）。
 *
 * 为什么要这么设计：用户要求「把 699 的群信息**复制出来、不是剪切出来**做一个新资料库」，
 * 同时又要求「**正确屏蔽错误群资料库**」。两者要同时满足，就不能靠"删原文"，
 * 只能靠"原文打上归属标记"。
 */
const GROUP_TAG = /<!--\s*群[:：]\s*(\d+)\s*-->([\s\S]*?)<!--\s*\/群\s*-->/g;

/** 这个群有没有自己的资料库文件 */
export function hasGroupFile(groupId) {
  return groupFiles.has(String(groupId ?? '').trim());
}

/** 群资料库的文件名（`groups/<群号>.md`），没有就返回 '' */
export function groupFileName(groupId) {
  return groupFiles.get(String(groupId ?? '').trim())?.name ?? '';
}

/**
 * 按**当前是哪个群**过滤一段共享知识：把不属于这个群的「群标签块」摘掉，
 * 并把属于它的块**只留正文**（去掉标记本身）。
 *
 * @param {string} content
 * @param {string} groupId 当前群号（空 = 不知道是哪个群 → 所有群标签块都摘掉）
 */
export function scopeForGroup(content, groupId) {
  const gid = String(groupId ?? '').trim();
  return String(content ?? '').replace(GROUP_TAG, (_m, tag, body) => {
    const t = String(tag);
    // 不是这个群的 → 摘掉
    if (!gid || t !== gid) return '';
    // 是这个群的，但它已经有自己的资料库文件 → 这段是"搬家前的原文"，丢掉免得重复
    if (groupFiles.has(t)) return '';
    return body.trim();
  });
}

/** @type {{ name: string, content: string }[]} */
let files = [];
let loadedAt = 0;
/** 被当成数据文件跳过的（给界面/日志看） */
let skippedData = [];

function load() {
  try {
    // ── 收集 md 文件：**人设包优先**，然后是共用的 knowledge/ ────────────
    // ⚠️ 2026-09-21：人设的 md 现在住在 `personas/<id>/`（以前全在 knowledge/）。
    // ⚠️ 同名文件**以人设包为准**（不把两边的内容混起来看）——
    //    否则库里留着一份旧 persona.md，换人设会"换了但没完全换"，最难查。
    const pdir = personaDir();
    const collected = [];
    if (existsSync(pdir)) {
      for (const n of readdirSync(pdir)) {
        if (!n.toLowerCase().endsWith('.md')) continue;
        collected.push({ name: n, file: join(pdir, n), from: 'persona' });
      }
    } else {
      log.warn(`人设包目录不存在（${pdir}）—— 她将没有任何性格设定，去 personas/ 下建一个`);
    }
    for (const n of readdirSync(DIR)) {
      if (!n.toLowerCase().endsWith('.md')) continue;
      if (n.toLowerCase() === LEARNED) continue; // 学习档案单独处理
      if (collected.some((c) => c.name.toLowerCase() === n.toLowerCase())) continue;
      collected.push({ name: n, file: join(DIR, n), from: 'knowledge' });
    }
    // persona 放最前面，其余按文件名排序
    collected.sort((a, b) => {
      const pa = a.name.toLowerCase().startsWith('persona') ? 0 : 1;
      const pb = b.name.toLowerCase().startsWith('persona') ? 0 : 1;
      return pa - pb || a.name.localeCompare(b.name);
    });

    const keep = [];
    skippedData = [];
    for (const it of collected) {
      const content = readFileSync(it.file, 'utf8').trim();
      if (content.includes(DATA_MARK)) {
        skippedData.push(it.name);
        continue;
      }
      keep.push({ name: it.name, content, from: it.from });
    }
    // ── 动画库（`knowledge/anime/<库名>.md`）：**只加载人设声明的那几个** ──
    // ⚠️ 2026-09-21 改：原来是根目录一个共用的 `anime.md`，谁都能读。
    //    现在按 `identity.anime.works` 走 —— 没声明就一份都不读（换角色不串味）。
    //    名字用 `anime/<库名>.md`，和 `groups/<群号>.md` 一个风格。
    const animeKept = [];
    for (const w of animeWorks()) {
      const f = join(ANIME_DIR, `${w}.md`);
      try {
        if (!existsSync(f)) {
          log.warn(`人设声明的动画库「${w}」没有对应文件：${f} —— 这个作品的事她不会懂`);
          continue;
        }
        const content = readFileSync(f, 'utf8').trim();
        if (!content) continue;
        animeKept.push({ name: `anime/${w}.md`, content, from: 'knowledge' });
      } catch (e) {
        log.warn(`读动画库「${w}」失败（当作没有）：${e.message}`);
      }
    }
    files = [...keep, ...animeKept];
    loadedAt = Date.now();

    // ── 群资料库（`knowledge/groups/<群号>.md`）────────────────
    // ── 私聊记忆（`knowledge/dm/<QQ号>.md`）—— 2026-09-17 加，见 DM_DIR 的注释 ──
    const gmap = new Map();
    const scanDir = (dir, keyOf, nameOf) => {
      try {
        if (!existsSync(dir)) return 0;
        let n0 = 0;
        for (const n of readdirSync(dir)) {
          if (!n.toLowerCase().endsWith('.md')) continue;
          const id = n.replace(/\.md$/i, '').trim();
          if (!id) continue;
          const content = readFileSync(join(dir, n), 'utf8').trim();
          if (!content) continue;
          gmap.set(keyOf(id), { name: nameOf(n), content });
          n0++;
        }
        return n0;
      } catch (e) {
        log.warn(`读 ${dir} 失败（当作没有）：${e.message}`);
        return 0;
      }
    };
    scanDir(GROUP_DIR, (id) => id, (n) => `groups/${n}`);
    const dmCount = scanDir(DM_DIR, (id) => `dm:${id}`, (n) => `dm/${n}`);
    groupFiles = gmap;

    // ⚠️ 人设包和共用库**分开报** —— 换人设那一下能不能生效，看这行最直观
    const pFiles = files.filter((f) => f.from === 'persona');
    log.info(
      `人设包「${personaId()}」${pFiles.length} 个文件：` +
        (pFiles.map((f) => f.name).join(', ') || '（空 —— 她不会有任何性格，去 personas/ 下建一个）'),
    );
    log.info(
      `已加载知识库 ${files.length - pFiles.length} 个文件：` +
        `${files.filter((f) => f.from !== 'persona').map((f) => f.name).join(', ')}` +
        (skippedData.length ? `（另有 ${skippedData.length} 个数据文件不进聊天：${skippedData.join(', ')}）` : ''),
    );
    if (animeKept.length) {
      log.info(`动画库 ${animeKept.length} 份（**由人设声明**）：${animeKept.map((f) => f.name).join(', ')}`);
    }
    if (groupFiles.size) {
      log.info(
        `群资料库 ${groupFiles.size - dmCount} 份（**只给对应的群用**）：${[...groupFiles.keys()].filter((k) => !k.startsWith('dm:')).join(', ') || '（无）'}`,
      );
    }
    // ⚠️ 私聊记忆**只报条数，不报 QQ 号** —— 这一行会进日志（用户可能截图分享），
    //    里面混着真实 QQ 号不好看，而且和知识库那行的风格也对不上。
    if (dmCount) log.info(`私聊记忆 ${dmCount} 份（**只在跟那个人私聊时注入**）`);
  } catch (e) {
    log.error(`加载知识库失败: ${e.message}`);
    files = [];
  }
}

load();

/**
 * 重新从磁盘加载知识库（热重载）。
 *
 * ⚠️ 为什么必须提供：知识文件是**启动时读进内存**的（`files` 数组）。
 *    管理界面改完文件只写了磁盘，内存里还是旧的 —— 表现就是
 *    「界面说保存成功，但机器人答的还是老内容，重启才好」（真实踩过）。
 *    所以界面保存之后要调这个。
 *
 * @returns {{files:number, names:string[]}}
 */
export function reloadKnowledge() {
  load();
  return { files: files.length, names: files.map((f) => f.name) };
}

/** 是否加载到了知识 */
export function hasKnowledge() {
  return files.length > 0;
}

/**
 * **只取人设**（`persona.md` 的正文）。
 *
 * ⚠️ 为什么单独开一个（2026-09-15）：随机事件/剧情的"润色"用的是 `llm.phrase()`
 *    —— 那个接口**只发 system + user 两条消息**，不会自动带任何知识库。
 *    我一开始在提示词里写了「你的人设细节在系统提示词里，按那个来」，
 *    而实际上**人设压根没进去** —— 那种提示词等于在骗模型，
 *    出来的东西就是一段没有性格的通用文本。
 *
 * 用途：给 `phrase()` 那种"一句话润色"的调用补上人设。
 * 不带服务器库/群记忆 —— 中午丢了份饭不需要 Minecraft 资料。
 */
export function personaText() {
  const f = files.find((x) => isPersona(x.name));
  return f ? String(f.content ?? '') : '';
}

// ─────────────────────────────────────────────────────────────
// 出场人物表（knowledge/cast.md）
// ─────────────────────────────────────────────────────────────
//
// ⚠️⚠️ 2026-09-15 加。用户反馈原话：
//     「刚才跑了几次测试，发现故事几乎全部都是祥子一个人的」
//
//     查下来是两个原因，都不在模型身上：
//       ① knowledge/life-events.md 那 53 条事件**全是独角戏**（只有一条提到初华）
//          → 事件里没别人，模型当然写不出别人；
//       ② src/quest.js 的系统提示词第一句就是「**只写祥子这条线**」，
//          而提示词里**没有任何人物名册** → 模型只能保守地写成独白。
//
//     这个文件补的就是②：告诉生成器「谁可以出现、怎么出现才不离谱」。
//
// ⚠️ 它是**数据文件**（文件头有那条声明），不进聊天提示词 ——
//    混进去只会白占字数，还容易被照着念关系表。
//    **每次调用直接读盘**，所以改完不用重启。

const CAST_FILE = 'cast.md';

/**
 * **角色专属的数据文件**（人物名册、日常事件库、剧情点子）在哪儿。
 *
 * ⚠️ 2026-09-21：这三份以前跟服务器库一起躺在共用的 `knowledge/` 里，
 *    但「换一个角色」它们就完全不成立了 —— 名册是别人的队友、
 *    事件是别人的日常、剧情点子是别人的世界线。所以它们搬进了人设包
 *    （`personas/<id>/cast.md`、`life-events.md`、`quest-ideas.md`）。
 *
 * 这里**人设包优先、共用目录回落**：搬过去之后回落自然不会生效，
 * 但哪天换了人设忘了写这几份，至少不会整个功能失效。
 * ⚠️ 文件名做白名单（只留字母数字点横线），别让它拼出 `../` 去读别处。
 */
export function personaDataFile(name) {
  const safe = String(name ?? '').replace(/[^\w.-]/g, '');
  if (!safe) return '';
  const p = join(personaDir(), safe);
  if (existsSync(p)) return p;
  return join(DIR, safe);
}

/** 比名字时用的宽松形式：去掉标点/空白、转小写（`MyGO!!!!!` → `mygo`） */
function loose(s) {
  return String(s ?? '')
    .replace(/[!！?？。．.,，、\s（）()【】\[\]]/g, '')
    .toLowerCase();
}

/**
 * 解析 `knowledge/cast.md`。
 *
 * 格式：
 *   `## 名字 / 别名`  一档（别名也能命中事件文本）
 *   `>` 开头的是这一档的说明（**会进剧情提示词**，所以要写"什么频率、什么基调"）
 *   `### 名字`        档里的一个人
 *
 * @returns {{name:string,keys:string[],note:string,members:{name:string,keys:string[],body:string}[]}[]}
 */
export function castBands() {
  let raw = '';
  try {
    raw = readFileSync(personaDataFile(CAST_FILE), 'utf8');
  } catch {
    return [];
  }
  // 文件头那一大段 HTML 注释是写给改文件的人看的，解析时丢掉
  const text = raw.replace(/<!--[\s\S]*?-->/g, '');

  const bands = [];
  let band = null;
  let member = null;
  for (const line of text.split(/\r?\n/)) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      const parts = h2[1].split('/').map((s) => s.trim()).filter(Boolean);
      band = { name: parts[0] ?? h2[1].trim(), keys: parts.length ? parts : [h2[1].trim()], note: '', members: [] };
      bands.push(band);
      member = null;
      continue;
    }
    const h3 = line.match(/^###\s+(.+?)\s*$/);
    if (h3 && band) {
      const parts = h3[1].split('/').map((s) => s.trim()).filter(Boolean);
      member = { name: parts[0] ?? h3[1].trim(), keys: parts.length ? parts : [h3[1].trim()], body: '' };
      band.members.push(member);
      continue;
    }
    if (!band) continue;
    const t = line.trim();
    if (!t) continue;
    if (member) {
      member.body += (member.body ? '\n' : '') + t;
    } else if (/^>/.test(t)) {
      band.note += (band.note ? '\n' : '') + t.replace(/^>\s?/, '');
    }
  }
  return bands;
}

/** 把一档渲染成提示词里的一段；`only` 给了就只渲染那几个人 */
function renderBand(band, only = null) {
  const lines = [`## ${band.name}`];
  if (band.note) lines.push(...band.note.split('\n').map((l) => `> ${l}`));
  for (const m of only ?? band.members) {
    lines.push('', `### ${m.name}`, m.body);
  }
  return lines.join('\n').trim();
}

/**
 * 事件文本里点名了谁，就把谁那一段挑出来。
 *
 * 用途：`life.compose()`。事件写「排练里睦的状态不对」，
 * 模型就得知道「睦」是谁、跟她什么关系 —— 不然会写成一个陌生人。
 *
 * 命中规则：**档名或人名**出现在文本里（宽松比对，`MyGO` 能命中 `MyGO!!!!!`）。
 * 命中档名 → 整档都给；只命中某个人 → 只给那一个人。
 *
 * @param {string} text 事件原文
 * @param {{maxChars?:number}} [opts]
 */
export function castBlock(text, opts = {}) {
  const t = loose(text);
  if (!t) return '';
  const max = Number.isFinite(opts.maxChars) ? opts.maxChars : 3500;
  const out = [];
  let used = 0;
  for (const b of castBands()) {
    const bandHit = b.keys.some((k) => t.includes(loose(k)));
    const hitMembers = b.members.filter((m) => m.keys.some((k) => t.includes(loose(k))));
    if (!bandHit && !hitMembers.length) continue;
    const seg = renderBand(b, bandHit ? null : hitMembers);
    if (used + seg.length > max && out.length) break;
    out.push(seg);
    used += seg.length + 2;
  }
  return out.join('\n\n');
}

/**
 * 一份**紧凑的名册**：档名 + 那一档的说明 + 人名。
 *
 * 用途：`quest.js` 的系统提示词 —— 编剧情时让模型知道"还有谁能出场"。
 * ⚠️ **故意不带每个人的详细说明**（那会让提示词涨好几千字）。
 *    那些细节由 `castBlock()` 按需给；这里只要"有人可用 + 什么频率"。
 */
export function castRosterBrief() {
  const bands = castBands();
  if (!bands.length) return '';
  return bands
    .map((b) => {
      const names = b.members.length ? `\n成员：${b.members.map((m) => m.name).join('、')}` : '';
      return `## ${b.name}${b.note ? `\n${b.note}` : ''}${names}`;
    })
    .join('\n\n');
}

// ── 按需挑选：只把跟这次对话相关的库塞进提示词 ──────────────────
//
// 用户要求（2026-09-11）：「有没有调用知识库的优先级，比如不需要服务器库和
// 群资料库时直接忽略不读，只读最重要的人设库」
//
// 为什么值得做：知识库一共 1.6 万字，
//   persona.md 6,940（43%，**永远要读** —— 它是小祥这个人的性格）
//   hzymtr-server.md 5,533（34%，只有问服务器才需要）
//   group-memory.md 1,665（10%，聊到具体群友才需要）
//   anime.md 1,019（6%，聊二次元才需要）
// 闲聊时后三个基本用不上，白白占着提示词还会稀释真正重要的规则。

/**
 * 这个文件名是「永远要读」的人设库吗。
 *
 * ⚠️⚠️ 2026-09-17 修：**只认 `persona.md` 本身**。
 *
 *    原来写的是 `startsWith('persona')` —— 那会把 `persona-money.md` /
 *    `persona-media.md` 也当成"永远读"的人设，于是**上午拆出去的按需分册
 *    一次都没省下来**（闲聊时它们照样躺在提示词里，白占约 7000 字）。
 *    「拆分 + 按需加载」那件事等于白做了一半。
 *
 *    这个错直到用探针把系统提示词整个打出来才现形：
 *    「今天好累啊」的 `picked.names` 明明白白是「（仅人设）」，
 *    可正文里赫然有「零一、你的『工资』」和「八、你会发表情包」。
 *    ⚠️ 教训：**光看"挑中了哪些"不算验证，要把真正拼出来的提示词看一遍。**
 *
 *    ⚠️ 改成精确匹配之后，那两份分册仍然会**按需**进来 ——
 *       聊到钱走 `needMoney`，带图/表情走 `needMedia`，功能一点没丢。
 */
function isPersona(name) {
  return String(name).toLowerCase() === 'persona.md';
}

/**
 * 消息里有没有出现**某个知识文件里写过的词**。
 *
 * ⚠️ 为什么需要（2026-09-12）：`selectFor` 原来全靠**手写关键词正则**判断该读哪个库。
 *    结果「邦高祖」这种新外号没写进正则 → anime.md 不进提示词 →
 *    模型只能靠自己训练数据猜，**同一个问题一次对一次错**（真实踩过）。
 *
 *    这个函数把文件里出现过的**专有词**（加粗的词、表格第一列、斜杠分隔的别名）
 *    抠出来，消息里命中了就说明「这个库该读」。
 *    好处：**以后往知识文件里加词条会自动生效**，不用改代码 ——
 *    两个地方要同步维护的东西，迟早会漏一个。
 */
export function mentionsAnyTerm(text, fileName) {
  // ⚠️ 2026-09-15 晚：**群资料库也要能找到** —— 原来只在全局 `files` 里找，
  //    于是「`mentionsAnyTerm(t, 'groups/200000006.md')`」永远 false，
  //    群资料库就只能靠"群/群友"那几个关键词触发（问「明日方舟」不会带进来）。
  const f =
    files.find((x) => x.name === fileName) ??
    [...groupFiles.values()].find((x) => x.name === fileName);
  if (!f) return false;
  return mentionsAnyTermIn(f.content, text);
}

/** `mentionsAnyTerm` 的实际实现（按**内容**判，全局文件和群资料库共用） */
function mentionsAnyTermIn(content, text) {
  const t = String(text ?? '');
  const terms = new Set();
  // 加粗的词（**邦邦**、**户山香澄 / 邦高祖**）
  for (const m of String(content).matchAll(/\*\*(.{2,24}?)\*\*/g)) terms.add(m[1].trim());
  // 表格第一列（| **梦限大 / 梦限大MewType** | ...）
  for (const m of String(content).matchAll(/\|\s*([^|\n]{2,40}?)\s*\|/g)) terms.add(m[1].trim());
  for (const raw of terms) {
    // 一个格子里的「A / B / C」拆开，每个都要能单独命中
    for (const part of String(raw).split(/[\/／、]/)) {
      const p = part.replace(/[*`（）()【】\[\]]/g, '').trim();
      // 太短（1 个字）会误命中，太长不像一个词
      if (p.length < 2 || p.length > 16) continue;
      if (t.includes(p)) return true;
    }
  }
  return false;
}

/** 别人说的话里有没有提到某个群友的名字 */
function mentionsSomeone(text, content) {
  // 从群记忆里把出现过的昵称抠出来，看消息里有没有
  const names = new Set();
  for (const m of content.matchAll(/^###?\s*(.+?)(?:（|\s*$)/gm)) {
    const n = m[1].trim().replace(/[（(].*$/, '');
    if (n && n.length >= 2 && n.length <= 12) names.add(n);
  }
  for (const m of content.matchAll(/\*\*(.{2,10}?)\*\*/g)) names.add(m[1].trim());
  for (const n of names) {
    if (n && text.includes(n)) return true;
  }
  return false;
}

/**
 * 挑出这次该读哪几个库。
 *
 * ⚠️ 原则：**宁多勿漏**。漏了服务器库会让机器人对着真问题胡说，
 *    那比多占 5000 字严重得多。所以只有**明确不是那一类**时才不读。
 *
 * @param {string} text 对方说的话（已剔掉占位符）
 * @param {{role?:string, segments?:Array, groupId?:string}} [opts] 说话的人是谁、消息里有什么、**在哪个群**
 * @returns {{names:string[], skipped:string[]}}
 */
/**
 * 「他是谁」迷你摘要（2026-09-17 用户报的）。
 *
 * 用户原话：「刚才喵喵三三这个人在剧情也说了很多话，**不可能什么印象都没有吧**」。
 *
 * ⚠️ 探针查过的结论（别照直觉猜）：群资料**确实进了提示词**
 *    （`selectFor` 挑中了 `groups/200000006.md`，拼出来 42167 字，里面就有
 *    「| **喵喵三三** | 最活跃的话痨之一… |」那一行）。
 *    她是**在 4 万字的中间没翻到** —— 就是项目里反复踩的「中段迷失」。
 *
 * 所以这里把**被问到的那个人**那一条**单独拎出来**，让调用方放到提示词**靠后**的位置
 * （离用户提问越近，越不容易被漏）。
 *
 * @param {string} text 对方说的话
 * @param {string} groupId
 * @returns {string} 空串 = 这条消息没提到资料里记的人
 */
/**
 * `owner.md` / `relationship.md` 这类**人的资料**（2026-09-19 加）。
 *
 * ⚠️ 为什么需要：`whoIsBrief()` 原来**只扫群资料** `groups/<群号>.md` ——
 *    而「**MEI**（他现实里的朋友；也在群里，是你的好友）」记在 `owner.md` 里，
 *    所以在群里问「还记得 mei 吗」时**永远扫不到** ✗
 *    （用户 9/17 就为同一件事截过图，`persona.md` 里还留着那次的
 *     「我翻了翻，没这个人」/「MEI？……真没什么印象」）。
 *
 * ⚠️ 这两个文件都只有几 K，读起来很便宜；**故意不缓存**（知识库是热重载的，
 *    缓存反而容易读到过期内容，得不偿失）。
 */
const EXTRA_PEOPLE_FILES = ['owner.md', 'relationship.md', 'group-memory.md'];
function extraPeopleContent() {
  let out = '';
  for (const f of EXTRA_PEOPLE_FILES) {
    try {
      const p = join(DIR, f);
      if (existsSync(p)) out += `\n${readFileSync(p, 'utf8')}`;
    } catch {
      /* 读不到就算了，不影响主流程 */
    }
  }
  return out;
}

export function whoIsBrief(text, groupId = '') {
  const t = String(text ?? '');
  if (!t) return '';
  const gf = groupFiles.get(String(groupId ?? '').trim());
  const sources = [];
  if (gf?.content) sources.push(gf.content);
  const extra = extraPeopleContent();
  if (extra) sources.push(extra);
  if (!sources.length) return '';
  const hits = [];
  for (const src of sources) {
    const lines = src.split('\n');
    // ⚠️ 只认**加粗的名字** —— 群资料/人资料里就是这么写的（`| **喵喵三三** | … |`、
    //    `- **MEI**（他现实里的朋友…）`）。
    //    不去猜"哪几个字是人名"，那样误命中率太高（「群里」「大家」都会被当成名字）。
    for (const m of src.matchAll(/\*\*(.{2,12}?)\*\*/g)) {
      const name = m[1].trim();
      // ⚠️⚠️ 2026-09-19：**大小写不敏感**（用户打的是小写「mei」，资料里写的是
      //    「**MEI**」—— 区分大小写的 `includes` 直接判不中，这也是他这次问
      //    「还记得mei吗」却得到「不认识」的直接原因之一）。
      if (!name || !t.toLowerCase().includes(name.toLowerCase())) continue;
      // ⚠️ 2026-09-19：原来只认表格行（`|` 开头），而 `owner.md` 里的人是用
      //    **列表行**写的（`- **MEI**（…）：`）→ 于是 MEI 被过滤掉了 ✗ 两种都收。
      const line = lines.find(
        (l) => l.includes(`**${name}**`) && (l.trim().startsWith('|') || l.trim().startsWith('-')),
      );
      if (line && !hits.includes(line)) hits.push(line.slice(0, 300));
    }
  }
  if (!hits.length) return '';
  return [
    '## 📇 你手里正好有这个群几个人的资料（就在下面，**直接用**）',
    '',
    '| 群友 | 特点 / 怎么打交道 |',
    '| --- | --- |',
    ...hits,
    '',
    '⚠️ 他说到的人**就在上面** —— 照这些说，**别说"不熟""不知道"**。',
    '⚠️ 但**别把整条念出来**（那是档案，不是人话）：挑一两句像"认识这个人"的话就够。',
  ].join('\n');
}

export function selectFor(text, opts = {}) {
  const t = String(text ?? '');
  const role = String(opts.role ?? 'member');
  const segs = opts.segments ?? [];
  const gid = String(opts.groupId ?? '').trim();
  const picked = [];
  const skipped = [];

  const needServer =
    // 说了服务器相关词
    // ⚠️ 2026-09-15 晚补：`超时|连接|加速器|登录|进服` ——
    //    实测「怎么连接超时了，难道要加速器？」原来**一条都不命中** ✗
    //    → 服务器库没注入 → 她只能凭通用知识瞎答（那次的"回滚点"就是这么来的）。
    //    这类"连不上"的说法必须命中，不然最该看这份资料的问题反而看不到。
    /服务器|整合包|模组|存档|白名单|启动器|客户端|报错|崩|进不去|进不了|连不上|超时|连接|加速器|登录|进服|开服|端口|延迟|卡顿|闪退|掉线|op\b|java|forge|neoforge|mtr|沉浸车辆|fcl|pcl|hmcl|光影|资源包|大足|安岛|首都|东心乡|中心铁路|爱发电|付费|购买|远程|内存|显卡|配置|任务|ftb|voxy|地平线|列车|地铁|高铁|线路|建设申请|管理员|腐竹/i.test(
      t,
    ) ||
    // 消息里有文件（多半是整合包/存档相关）
    segs.some((s) => s.type === 'file');
  // ⚠️ 注意：**不要**因为「说话的人是服主/管理员」就无条件读服务器库。
  //    服主也会闲聊（「我想你了」「今天怎么样」），那种时候塞 5500 字服务器资料
  //    纯属浪费，还把真正该看的关系设定挤到后面去（用户反馈「关系不够明显」）。
  //    他真问服务器的事，上面的关键词会命中。
  if (needServer) picked.push('hzymtr-server.md');
  else skipped.push('hzymtr-server.md');

  // ⚠️⚠️ 2026-09-17 修（<主人> 报的：「699 群有群友让机器人介绍另一个群友，但是机器人说不知道。
  //    **应该先对应上名字**，直接调用群知识库来回答」）。
  //    日志里的原样是 `at <- 能介绍一下 嘛` —— **名字是空的**：
  //    群友是 @着那个人问的，而 @ 走的是 **at 段**，`extractText` 出来的文本里没有名字，
  //    于是下面 `mentionsSomeone(text)` 永远不命中 ⇒ 群资料压根没进上下文 ⇒ 她只能说"不知道"。
  //    这里把人名从 at 段反查出来（`names.label` 优先取**这个群的群名片**），拼进判据文本。
  const atNames = (segs ?? [])
    .filter((s) => s.type === 'at')
    .map((s) => String(s.data?.qq ?? ''))
    .filter(Boolean)
    .map((q) => {
      try {
        return names.label(q, gid);
      } catch {
        return '';
      }
    })
    .filter(Boolean);
  // ⚠️ 只在 at 段确实带出人名时才拼，纯文本时 `probe` 就等于 `t`（不会更差）
  const probe = atNames.length ? `${t}　${atNames.join('　')}` : t;

  const gm = files.find((f) => f.name.includes('group-memory'));
  const needGroup =
    !!gm &&
    (/你还记得|上次那个|记得那次|群里|群友|大家|谁是谁|群主|服主|腐竹/.test(probe) ||
      mentionsSomeone(probe, gm.content));
  if (needGroup) picked.push(gm.name);
  else if (gm) skipped.push(gm.name);

  // ── **这个群自己的资料库**（2026-09-15 晚加）──────────────────
  //
  // ⚠️ 只认**当前这个群**的那一份 —— 别的群的资料库**一个都不读**（＝"正确屏蔽"）。
  //    触发判据跟群记忆同一套（群相关词 + 提到里面出现过的人/词），
  //    这样「明日方舟 EX8 怎么打」这种问题在 699 会把 699 那份带进来，
  //    而在 MC 群里（没这份文件）**什么都不会多读**。
  const gf = groupFiles.get(gid);
  if (gf) {
    const needMine =
      /你还记得|上次那个|记得那次|群里|群友|大家|谁是谁|群主|服主|腐竹/.test(probe) ||
      mentionsSomeone(probe, gf.content) ||
      mentionsAnyTerm(probe, gf.name);
    if (needMine) picked.push(gf.name);
    else skipped.push(gf.name);
  }

  // ⚠️ 2026-09-12：**不能只靠关键词表**。
  //    真实踩过：群里问「邦高祖是谁」—— 表里没有「邦邦/邦高祖」，
  //    于是 anime.md **根本没进提示词**，模型只能靠自己训练数据猜，
  //    结果一次答对（户山香澄）、一次答错（说「邦邦里到底谁被叫这个，你直说吧」）。
  //    **同一个问题结果不稳定，就是因为该读的知识没读进来。**
  //
  //    所以加第二条判据：**把 anime.md 里出现过的关键词抠出来，看消息里有没有**。
  //    这样以后往 anime.md 加新词条（比如「邦邦」「邦高祖」）**自动生效**，
  //    不用同时改这个正则 —— 两个地方要同步维护的东西，迟早会漏。
  // ⚠️ 2026-09-21 改：原来是**一个**写死名字的 `anime.md`，现在是**人设声明的那几个**
  //    动画库（`anime/<库名>.md`）**逐个判**：
  //    通用词命中、或者消息里出现了那份库里写过的词 → 带它。
  //    人设一个都没声明时这一节就是空的（不是漏了，是设计如此 —— 换角色不串味）。
  const needAnimeWord =
    /动漫|番剧|新番|动画|漫画|轻小说|乐队|企划|偶像|二次元|看过|追番|角色|声优|梦限大|mygo|mujica|わたなれ|考拉/i.test(
      t,
    );
  for (const lib of files.filter((f) => f.name.startsWith('anime/'))) {
    if (needAnimeWord || mentionsAnyTerm(t, lib.name)) picked.push(lib.name);
    else skipped.push(lib.name);
  }

  // ── `owner.md`：**只有跟主人说话时**才读（2026-09-17 用户定）──────────
  //
  // 用户原话：「**owner.md 不用合并，在我私聊和在群和机器人对话时调用**」。
  //
  // ⚠️⚠️ 在这之前这份文件**从来没被引用过** —— `selectFor` 里根本没有它，
  //    也就是说写进去的东西（比如他朋友 MEI 的那几条）她**根本看不到**。
  //    是探针跑出来的：随便说一句闲话注入 45K 字，里面却没有 owner.md 那 3K。
  //
  // ⚠️ **不能无条件读**：那是主人自己的私人资料（经历、身高、朋友…），
  //    给群友看很怪，也白占提示词（用户一直在减提示词）。
  // ⚠️ `role` 必须由调用方传 `bot.speakerRole()` 的结果 —— 那个函数
  //    对**私聊主人**和**群里主人**都返回 `'owner'`，正好覆盖他要的两种情况；
  //    千万别改成 `event.sender.role`（那是 QQ 的群角色，不是"是不是服主"）。
  const needOwner = String(opts.role ?? '') === 'owner';
  if (needOwner) picked.push('owner.md');
  else skipped.push('owner.md');

  // ── persona 的两份「按需分册」（2026-09-17 从 31.5K 的 persona.md 里切出来的）──
  //
  // ⚠️⚠️ 切它们的**目的不是省 token，是防"中段迷失"**：
  //    规则太多挤在一起时，夹在中间的那些最容易被模型漏掉。
  //    把"只有特定场合才用得上"的两大块拿走，常驻那份的规则密度就降下来了。
  //
  // 触发词**故意写得宽**（宁可多读 4~5K，也别在该用的时候没读到）。
  // ⚠️⚠️ 触发词里**必须包含"红包/转账/代付/礼物"** ——
  //    第一版我漏了它们，探针立刻抓出来：「给我发个红包行不行」没命中
  //    → `persona-money.md` 不进提示词 → **红包禁令根本不在她眼前**
  //    （只剩代码层那道拦截兜着）。这几条都是钱的同义词，一个都不能少。
  const needMoney =
    /工资|薪水|挣|赚|花了|花销|开销|余额|报账|账单|多少钱|钱|充值|充钱|穷|贵|红包|转账|代付|礼物|打赏|赞助|付款|买单/i.test(
      t,
    );
  if (needMoney) picked.push('persona-money.md');
  else skipped.push('persona-money.md');

  const needMedia =
    segs.some((s) => ['image', 'face', 'mface'].includes(String(s?.type))) ||
    /表情|图片|照片|截图|这张图|那张图|发了张|看图|动态|说说|QQ空间/i.test(t);
  if (needMedia) picked.push('persona-media.md');
  else skipped.push('persona-media.md');

  return { names: picked, skipped };
}

/**
 * 当前加载了哪几个动画库（`anime/<库名>.md`）。
 *
 * 给 `bot.js` 那句"**本地库里已经有这个词条就别去搜了**"用 ——
 * 原来那里写死的是 `['anime.md', 'group-memory.md']`，改成人设驱动的库名之后，
 * 它得跟着走，否则换了人设就判断不出来了。
 */
export function animeLibNames() {
  return files.filter((f) => f.name.startsWith('anime/')).map((f) => f.name);
}

/**
 * 拼成一段给模型看的文本。
 *
 * @param {{only?:string[], skip?:string[], groupId?:string}} [opts]
 *   only/skip 用来做「按需加载」——只带相关的库，省提示词。
 *   ⚠️ 不管怎么选，**persona.md 永远带上**（那是小祥这个人）。
 *   `groupId` = 正在跟哪个群说话 —— 用来①摘掉别的群的「群标签块」②带上这个群自己的资料库。
 *
 * learned.md（群主教的）放在最后并显式声明优先级最高 —— 后出现的更靠近用户提问，
 * 模型通常也更重视后面的系统内容。
 */
export function knowledgeText(opts = {}) {
  const only = opts.only ? new Set(opts.only) : null;
  const gid = String(opts.groupId ?? '').trim();

  const chosen = files.filter((f) => {
    if (isPersona(f.name)) return true; // 人设永远读
    if (only) return only.has(f.name);
    return true;
  });

  const parts = [];
  if (chosen.length) {
    // ⚠️ 过一遍"群归属"：不属于这个群的群标签块会被摘掉（内容不会丢，只是不给别的群看）
    parts.push(chosen.map((f) => scopeForGroup(f.content, gid)).filter(Boolean).join('\n\n---\n\n'));
  }
  // ── 这个群自己的资料库：**永远带上**（2026-09-15 晚加）────────────────
  //
  // ⚠️⚠️ 2026-09-17 的教训（我一度把这段删了，被 `test/knowledge-groups.js` 拦下）：
  //
  //    **这份东西是"永远注入"的，不是按需的。** 套件里三条断言专门钉着它：
  //    「699 的提示词里带上了『这个群自己的资料』」「而且真的带上了 699 的人」
  //    「内容仍然在（在它自己那份文件里）」。
  //    道理也说得通：**她得随时认识这个群里的人**，不能等人家报了名字才知道是谁。
  //
  //    ⚠️ 但**必须去重**：`selectFor` 在消息提到群友名时也会挑中它
  //       （那条 `needMine` 判据），那样 `chosen` 里已经有一份 ——
  //       不去重就是**同一份内容塞两遍**（探针抓到的就是这个）。
  const gf = groupFiles.get(gid);
  if (gf && !chosen.some((f) => f.name === gf.name)) {
    parts.push(['# 【这个群自己的资料】', '', gf.content].join('\n'));
  }

  // ★★ 2026-09-17（用户要求）：「**在群聊聊天时也调用正在对话的那个人的私聊库**」。
  //    私聊记忆如果已经归到某个群（`observe.scopeFor()` 的规则），上面那份里就有了，
  //    不用重复；只有**纯好友**（`dm:<QQ号>`）才需要在这里额外带上。
  //    ⚠️ **只带当前说话人这一个人**的 —— 不是所有人的
  //    （那既会撑爆提示词，也是隐私问题：A 的私聊记忆不该让 B 看见）。
  const dmId = String(opts.dmUserId ?? '').trim();
  const dmKey = dmId ? `dm:${dmId}` : '';
  if (dmKey && dmKey !== gid) {
    const dm = groupFiles.get(dmKey);
    if (dm) parts.push(['# 【你跟这个人的私聊记忆】', '', dm.content].join('\n'));
  }

  // ⚠️ 2026-09-17：`learnedText(text)` 现在**按需挑条目**（原来无条件全带 12.4K）。
  //    传 `opts.text` 才会挑；不传（界面预览那种）仍然全带。
  const learned = learnedText(opts.text ?? '');
  if (learned) {
    parts.push(
      [
        '# 【最高优先级】群主后来补充/更正的知识',
        '',
        '以下内容是群主（服务器负责人）后续亲自教给你的，**与上面知识库冲突时，一律以下面为准**。',
        '如果上面写的是旧说法，直接按下面回答，不要说"知识库里没写"，也不要把两套说法都讲给群友。',
        '',
        learned,
      ].join('\n'),
    );
  }
  return parts.join('\n\n---\n\n');
}

export function knowledgeStats() {
  const learned = listEntries();
  const groupNames = [...groupFiles.values()].map((g) => g.name);
  return {
    files: files.length + 1 + groupNames.length,
    /** ⚠️ 这些是"数据文件"，**不进聊天提示词**（给界面显示用） */
    dataFiles: skippedData.slice(),
    names: [...files.map((f) => f.name), ...groupNames, LEARNED],
    /** 群资料库：群号列表 + 每个群的字符数（界面要显示"哪些群有自己的一份"） */
    groupFiles: [...groupFiles.entries()].map(([gid, g]) => ({ groupId: gid, name: g.name, chars: g.content.length })),
    chars:
      files.reduce((n, f) => n + f.content.length, 0) +
      [...groupFiles.values()].reduce((n, g) => n + g.content.length, 0),
    learnedEntries: learned.length,
    learnedTopics: learned.map((e) => e.title),
    loadedAt,
  };
}

// 注意：knowledgeText(opts) 的定义在上面（跟 selectFor 放一起），
// 这里不要再定义一遍 —— 重复定义会让 export 指向后一个，按需加载就失效了。
