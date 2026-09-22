/**
 * 表情包素材库。
 *
 * 模型在回复里写 `[表情:爆炸]` 这样的标记，机器人就发对应的图。
 * 素材和用途写在 library/index.json，图片放 library/ 下。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';
import { log } from './log.js';

const DIR = join(ROOT, 'library');
const INDEX = join(DIR, 'index.json');

/** @type {{tag:string,file:string,when:string,desc:string}[]} */
let faces = [];

function load() {
  try {
    const j = JSON.parse(readFileSync(INDEX, 'utf8'));
    faces = (j.faces ?? []).filter((f) => f.tag && f.file);
    // 只保留文件真实存在的
    const missing = faces.filter((f) => !existsSync(join(DIR, f.file)));
    if (missing.length) {
      log.warn(`表情库有 ${missing.length} 个文件不存在，已跳过：${missing.map((f) => f.file).join(', ')}`);
      faces = faces.filter((f) => existsSync(join(DIR, f.file)));
    }
    log.info(`已加载表情库 ${faces.length} 张：${faces.map((f) => f.tag).join(' / ')}`);
  } catch (e) {
    if (e.code !== 'ENOENT') log.error(`加载表情库失败: ${e.message}`);
    faces = [];
  }
}

load();

export function faceCount() {
  return faces.length;
}

export function faceTags() {
  return faces.map((f) => f.tag);
}

/** 正式库里所有图片文件名（收集器用来避免重复收集） */
export function faceFiles() {
  return faces.map((f) => f.file);
}

/**
 * 取某张表情的绝对路径。
 *
 * ⚠️ 同一个 tag **允许对应多张图**（用户要求：「疑惑这种肯定需要很多张，
 *    要不然老是发一样的图也不行」）。
 *    所以这里**不是**取第一张，而是把所有同 tag 的图收集起来**随机选一张**。
 *
 * 想固定发某一张，就把 tag 写细一点（「疑惑」「疑惑2」）—— 只有同名才随机。
 */
export function facePath(tag) {
  const t = String(tag ?? '').trim();
  // ⚠️⚠️ 2026-09-19（用户报：**斗图复读**时群里出现了一行字面 `[表情包]`）：
  //    他**连发 3 张同样的表情** → 她去复读那个表情，但她**只会照着上下文里的写法写**
  //    （别人的图在她上下文里就显示成「[表情包]」）→ 而库里没有叫「表情包」的 tag
  //    → 解析不出来 → 这五个字就字面发到群里了 ✗
  //    ⚠️ 修法：这些**类别名**直接理解成「**随便来一张**」—— 复读本来就是"跟着发个表情"。
  //    🚫 **千万别改成"不发"**：那等于把她复读表情包的能力弄没了（我第一版就是这么错的，
  //       用户当场纠正：「你还直接改成不发了」）。
  if (/^(表情包|表情|图片|照片|动图|动画表情|贴纸|颜文字|gif|sticker|emoji|img|image)$/i.test(t)) {
    const all = faces.map((f) => join(DIR, f.file)).filter((p) => existsSync(p));
    if (!all.length) return null;
    return all[Math.floor(Math.random() * all.length)];
  }
  const list = faces.filter((x) => x.tag === t);
  if (!list.length) return null;
  const ok = list.map((f) => join(DIR, f.file)).filter((p) => existsSync(p));
  if (!ok.length) return null;
  return ok[Math.floor(Math.random() * ok.length)];
}

/** 某个 tag 下有几张备选 */
export function faceVariants(tag) {
  return faces.filter((x) => x.tag === tag).length;
}

/**
 * 按 tag 分组：同 tag 的合并成一条，附上备选张数。
 * 管理界面和清单都用它，避免同一个 tag 在清单里重复出现好几行。
 */
export function faceGroups() {
  const map = new Map();
  for (const f of faces) {
    if (!map.has(f.tag)) map.set(f.tag, []);
    map.get(f.tag).push(f);
  }
  return [...map.entries()].map(([tag, list]) => ({
    tag,
    count: list.length,
    file: list[0].file,
    who: list[0].who ?? '',
    when: list[0].when ?? '',
    desc: list[0].desc ?? '',
    variants: list,
  }));
}

/**
 * 给模型看的清单：tag + 图里是谁（认得出才写）+ 适用场合（不给文件名）。
 *
 * ⚠️ 刻意写得很紧凑 —— 表情多了以后，每条都写全「（角色不确定）」和长句子，
 *    光这一块就两千多字，会把提示词里真正重要的规则挤掉（用户反馈过太长）。
 *    做法：
 *      - 认得出角色的才写名字；**没写名字 = 我认不出**（人设里有对应说明）
 *      - 「适用场合」压成一句话
 *      - **按 tag 合并**：同一个 tag 有多张备选的，只列一行并标出张数
 *        （这样模型知道「疑惑」有好几张，但它只需要写 `[表情:疑惑]`，
 *          具体发哪张由 facePath 随机挑）
 */
export function faceMenuText() {
  if (!faces.length) return '';
  return faceGroups()
    .map((g) => {
      // 「（角色不确定）」这种占位不写出来，省字
      const who =
        g.who && !/角色不确定|不确定|未知/.test(g.who) ? g.who.replace(/（.*?）$/, '') : '';
      const when = String(g.when ?? '').replace(/[ ；]+$/g, '').replace(/。$/, '');
      // 有备选就标一下张数，让模型知道这个情绪不是只有一张
      const many = g.count > 1 ? `（${g.count} 张备选）` : '';
      return `[${g.tag}]${who ? `（${who}）` : ''}${many} 用于：${when}`;
    })
    .join('\n');
}

/** 查某张表情的完整信息，用于回答「你为什么发这个」 */
export function faceInfo(tag) {
  const f = faces.find((x) => x.tag === String(tag).trim());
  if (!f) return null;
  return { tag: f.tag, who: f.who, when: f.when, desc: f.desc };
}

/** 所有标签的详细信息，给模型备查 */
export function faceDetailText() {
  if (!faces.length) return '';
  return faces
    .map((f) => `- ${f.tag}：${f.desc}${f.who ? `。图里是${f.who}` : ''}。用在${f.when}`)
    .join('\n');
}

/**
 * 从一段文本里抽出所有 `[表情:xxx]` 标记。
 *
 * ⚠️⚠️ 2026-09-18 放宽：**`[表情:xx]` 和裸的 `[xx]` 都认**。
 *    起因（用户截图）：她回了「行，锅给新号背了 **[得意]**」—— 标记写漏了「表情:」，
 *    于是一个都解析不出来，**原样当文字发到群里**，看着像表情没发出来。
 *    为什么会写漏：`[图片]` / `[表情包]` 是**另一种**标记（描述**别人发的**消息），
 *    模型见过那个格式，就照抄成了 `[得意]`。
 *    ⚠️ 放宽是**安全**的：下面 `if (facePath(tag))` 只让**真在表情库里的 tag** 过去，
 *       所以 `[图片]` / `[表情包]` / `[引用#123]` 这些**照旧不会被当成表情**。
 */
export function pickMarkers(text) {
  const out = [];
  const re = /\[\s*(?:表情\s*[:：]\s*)?([^\]\s]+)\s*\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const tag = m[1].trim();
    if (facePath(tag)) out.push({ tag, index: m.index, raw: m[0] });
  }
  return out;
}

/**
 * 从一段文本里抽出**第一个**拍照标记（2026-09-22 加，同日扩成两种）。
 *
 * ⚠️ 和 `pickMarkers` 是**两套**标记，别混：
 *    · `[表情:标签]` → 从**本地表情库**挑一张现成的图（`pickMarkers`）
 *    · `[拍照:场景]` / `[拍:场景]` → 调**生图 API 现画**一张（这里）
 *
 * ⚠️⚠️ 两种标记的差别是**画面里有没有她**（这是给"理解"那一步的线索，
 *    最终由 `src/photo-plan.js` 判断；标记写得明确时会尊重标记）：
 *
 * | 标记 | 画面 | 参考图 | 典型场景 |
 * | --- | --- | --- | --- |
 * | `[拍照:场景]` / `[拍照]` | **有她**（自拍 / 别人帮她拍） | **要传** | 「拍个自拍」 |
 * | `[拍:场景]` / `[拍]` | **她拍的东西**，她不在画面里 | **不传** | 「拍张月之森校门」 |
 *
 * ⚠️ **可以只写 `[拍照]` 不带场景**（2026-09-22 用户要求「这些要先经过 llm 理解
 *    需要拍什么照片得出」）—— 那种情况下 `scene` 是空串，"拍什么"完全由那次理解决定。
 *
 * 用户原话：「不一定是自拍，比如让祥子拍一张月之森校门的照片就不是自拍，
 * 而且写实的好处就体现出来了」—— 拍景物那条路才是**写实风格**真正发挥的地方。
 *
 * ⚠️ 只取**最先出现的那个**：一条回复拍两张没意义，还白花钱。
 * ⚠️ 场景描述里**可以有空格**（`[拍照:夜里站在便利店门口，举着手机自拍]`）——
 *    所以这里**不能**套 `pickMarkers` 那种 `[^\]\s]+` 的写法（会截断在第一个空格）。
 */
export function pickPhoto(text) {
  const t = String(text ?? '');
  // 交替顺序有讲究：`拍照` 必须排在 `拍` 前面，否则 `[拍照:x]` 会被当成 `[拍:照:x]`
  const m = /\[\s*(拍照|拍)\s*(?:[:：]\s*([^\]]*?))?\s*\]/.exec(t);
  if (!m) return null;
  return {
    scene: String(m[2] ?? '').trim(),
    withSelf: m[1] === '拍照',
    index: m.index,
    raw: m[0],
  };
}

/** 把标记从文本里去掉（发给人看的文字不该带标记） */
export function stripMarkers(text) {
  return (
    String(text ?? '')
      // ① 标准写法：只要长得像就剥（哪怕 tag 已从库里删掉，也别把标记漏出去）
      .replace(/\[\s*表情\s*[:：][^\]]*\]/g, '')
      // ①-b 拍照标记（2026-09-22 加，同日扩成两种）：`[拍照:场景]` / `[拍:场景]` /
      //      **`[拍照]` / `[拍]`（裸标记，没有冒号也没有场景）**
      //      里的场景**可以是一整句**（"夜里站在便利店门口，举着手机自拍"），
      //      套不进下面 ② 那条"裸标签不含空格"的规则 → 不在这儿单独剥，
      //      它就会**字面发到群里**。
      //      ⚠️⚠️ **冒号必须是可选的**（2026-09-22 实测漏进群里了）：
      //        原来写的是 `[:：]`（必需冒号），而用户要求"这些要先经过 llm 理解得出"之后
      //        她只要写**裸标记** `[拍照]` 表示"我想拍"—— 那样就**匹配不上**，
      //        群里直接出现一行 `[拍照]`（用户截图报的）。
      //        ⇒ 解析端（`pickPhoto`）支持裸标记，**剥离端也必须跟着支持**，两处必须同步。
      //      ⚠️ 只匹配 `拍` / `拍照` 开头的，不会误伤 `[拍手]` / `[拍卖]` 这种（后面不是 `]`）。
      //      ⚠️ 和表情同一个原则：**不管这次生图成没成，标记本身永远不许露出去**。
      .replace(/\[\s*拍(?:照)?\s*(?:[:：][^\]]*)?\]/g, '')
      // ② 裸标签：真表情 tag 剥掉；`[图片]` / `[表情包]` 这类**类别名**也剥掉
      //    ⚠️ 这里原来写的注释是「`[图片]` / `[表情包]` 这种要留着」—— **那是旧的、已作废**，
      //       2026-09-19 用户截图之后改成了"一律剥掉"，理由见下面那段。
      // ⚠️⚠️ 2026-09-19（用户截图：她"复读表情包"时，群里直接出现了一行 `[表情包]`）：
      //    `[表情包]` / `[图片]` 是**类别名**，不是表情库里的名字
      //    （库里是「大笑 / 吃瓜 / 得意…」）→ `facePath()` 认不出来 →
      //    上面这条"只剥真表情"的规则就把它**原样留下**，于是字面发到群里 ✗
      //    这些词**只可能是"我想发表情"的意图**（多半还是从别人消息里的
      //    "[表情包]" 学来的），所以**一律剥掉**：要么她写具体名字（`[得意]` → 真发表情），
      //    要么就别留痕迹。⚠️ 剥完如果整条成了空的，那这条就不发了（比发五个字强）。
      .replace(/\[\s*([^\]\s]+)\s*\]/g, (raw, tag) => {
        if (facePath(tag)) return '';
        return /^(表情包|表情|图片|照片|动图|动画表情|贴纸|颜文字|gif|sticker|emoji|img|image)$/i.test(tag)
          ? ''
          : raw;
      })
      // ③ 收掉"剥掉标记之后剩下的空白"（2026-09-22，用户截图问过：
      //    「这个突兀的空格是bug吗，是不是本来应该分句的」）。
      //    「还拍啊 **[拍照]** 行，今天都成你专属模特了」剥完是「还拍啊  行，…」——
      //    那个双空格是标记**两边的空格**都留下来的结果。
      //    ⚠️ 标记是**独立**写出来的 ⇒ 那里本来就是**断句处** ⇒ 双空格收成一个「，」。
      //    ⚠️ 单个空格直接去掉（中文本来不用空格分词）。
      //    ⚠️ 这一步**只动空格，不再碰方括号** —— 免得把 `[图片]` 这类"该留的"又删一遍。
      .replace(/[ \t]{2,}/g, '，')
      .replace(/([\u4e00-\u9fa5])[ \t]+([\u4e00-\u9fa5])/g, '$1$2')
  );
}

export function reload() {
  load();
}
