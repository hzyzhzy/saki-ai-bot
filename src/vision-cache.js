/**
 * 图片下载与识图缓存。
 *
 * 流程：群里有人发图 → 从 NapCat 取到图片文件 → 交给视觉模型描述 → 描述塞进提示词。
 *
 * 注意：NapCat 的 get_image 会返回一个本地路径，但那是**临时缓存**，
 * 随时可能被清掉。所以要立刻读进内存。
 */
import { readFileSync } from 'node:fs';
import { config } from './config.js';
import { log } from './log.js';
import { describeImage } from './vision.js';

/** 图片描述缓存：key = 图片 file id，value = { text, at } */
const cache = new Map();
/** 缓存多久（毫秒）。同一张图反复发不用重复识图。 */
const CACHE_MS = 30 * 60 * 1000;
/** 同时最多识别几张（一次发 10 张图不能全烧掉） */
const MAX_IMAGES = 3;

function cleanCache() {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now - v.at > CACHE_MS) cache.delete(k);
  }
}

/**
 * 取一张图的内容。
 * @param {(action:string, params:object)=>Promise<any>} call
 * @param {string} file NapCat 给的 file 标识
 */
async function fetchImage(call, file) {
  try {
    const r = await call('get_image', { file });
    const p = r?.data?.file ?? r?.file;
    if (!p) return null;
    return readFileSync(p);
  } catch (e) {
    log.debug(`取图失败（${file}）：${e.message}`);
    return null;
  }
}

/**
 * 按 `file` 直接识别一批图片（不看 event）。
 *
 * ⚠️ 用途（2026-09-13，用户反馈「神在原后面」那个梗）：
 *    当前这条消息**没带图**，但它在说**前面那张图** ——
 *    这时要拿 `recent` 里存下的 `file` 补做识别，否则机器人压根没图可看。
 *    （见 bot.js 里「当前这条没带图，但它可能在说前面那张图」那段。）
 *
 * @param {Array<{file:string, kind?:string}>} items
 * @param {(action:string, params:object)=>Promise<any>} call
 */
export async function describeImagesByFile(items, call) {
  if (config.vision?.enable === false) return [];
  const list = (items ?? []).filter((x) => x && x.file).slice(0, MAX_IMAGES);
  if (!list.length) return [];
  cleanCache();

  const out = [];
  for (const it of list) {
    const file = String(it.file);
    const kind = it.kind === 'sticker' ? 'sticker' : 'image';
    if (kind === 'sticker' && config.vision?.describeStickers !== true) continue;
    if (cache.has(file)) {
      out.push({ file, kind, desc: cache.get(file).text });
      continue;
    }
    const buf = await fetchImage(call, file);
    if (!buf) continue;
    const desc = await describeImage(buf);
    if (desc) {
      cache.set(file, { text: desc, at: Date.now() });
      out.push({ file, kind, desc });
    }
  }
  return out;
}

/**
 * 描述一条消息里的所有图片。
 * @param {object} event
 * @param {(action:string, params:object)=>Promise<any>} call
 * @returns {Promise<Array<{file:string, desc:string}>>}
 */
export async function describeImagesIn(event, call) {
  if (config.vision?.enable === false) return [];

  const segs = Array.isArray(event.message) ? event.message : [];
  const imgs = segs.filter((s) => s.type === 'image');
  if (!imgs.length) return [];

  cleanCache();

  const out = [];
  for (const seg of imgs.slice(0, MAX_IMAGES)) {
    const file = String(seg.data?.file ?? '');
    if (!file) continue;

    // QQ 的图片段带 sub_type：1 = 动画表情（表情包），0 = 普通图片（截图/照片）。
    // ⚠️ 这个区别要**一路带到提示词里** —— 表情包是「在玩梗」，只要理解情绪；
    //    截图是「有东西给你看」，要理解内容。用同一套口径会让它对着表情包
    //    一本正经地描述画面（真实踩过：「强强？这图变形得够狠的……」）。
    const kind = Number(seg.data?.sub_type ?? 0) === 1 ? 'sticker' : 'image';

    // 表情包不识别（那是玩梗，不需要描述，而且省 token）
    if (kind === 'sticker' && config.vision?.describeStickers !== true) {
      continue;
    }

    if (cache.has(file)) {
      out.push({ file, kind, desc: cache.get(file).text });
      continue;
    }

    const buf = await fetchImage(call, file);
    if (!buf) continue;

    const desc = await describeImage(buf);
    if (desc) {
      cache.set(file, { text: desc, at: Date.now() });
      out.push({ file, kind, desc });
    }
  }

  if (imgs.length > MAX_IMAGES) {
    log.debug(`一条消息里有 ${imgs.length} 张图，只识别了前 ${MAX_IMAGES} 张`);
  }
  return out;
}

/**
 * **只读**缓存里已有的图片描述（不下载、不调模型）。
 *
 * ⚠️ 用途（2026-09-13）：把「最近有人发过的那张图」的描述**顺手带进上下文**——
 *    因为群里的对话经常是**绕着某张图**进行的（发图 → 别人评论 → 接着玩梗），
 *    而机器人如果只看到「（发了一张图）」占位符，就会：
 *      · 回「神什么了，发我看」（它没看到图）
 *      · 把「神在原后面」搜成「原神 游戏」，答成「直接说原神不行吗」（完全跑偏）
 *
 *    所以：**已经识别过的图，随时可以把描述捡回来用**（零成本）。
 *    没识别过的图不在这里主动识别 —— 那由调用方决定（识别慢、烧 token）。
 */
export function cachedDescriptions(files) {
  const out = [];
  for (const f of files ?? []) {
    const key = String(f ?? '');
    if (!key) continue;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      out.push({ file: key, kind: 'image', desc: hit.text, cached: true });
    }
  }
  return out;
}

/** 拼成给主模型看的文本 */
export function visionBlock(list) {
  if (!list || !list.length) return '';

  const hasSticker = list.some((x) => x.kind === 'sticker');
  const hasImage = list.some((x) => x.kind !== 'sticker');

  const parts = list.map((x, i) => {
    const isSticker = x.kind === 'sticker';
    const label = isSticker ? '**表情包**（他在玩梗，不是在给你看图）' : '**图片**（截图/照片）';
    const head =
      list.length > 1
        ? `### 第 ${i + 1} 张：${label}\n`
        : `### ${label}\n`;
    return head + x.desc;
  });

  const guide = [
    '',
    '# 【视觉识别结果】**你已经看过这张图了，以下是图里的真实内容**',
    '',
    '⚠️ 你现在**知道**图里是什么了。**绝对不要说「我看不到图」「图没加载出来」**。',
  ];

  // ⚠️ 表情包和图片**用完全不同的口径** —— 这是这个块最关键的区分。
  //
  // 真实踩过两轮：
  //   第一轮：用户发了个变形人脸的表情包 + 一句提问，机器人只回
  //          「强强？这图变形得够狠的……大半夜不睡就在翻这个？」—— 光描述画面 + 没答问题。
  //   第二轮：加了「别描述画面」之后，它改成了
  //          「这表情包配得倒是刚好，一脸『强强？』」—— **变成在做阅读理解了**，
  //          像在点评"图文搭配"，非常出戏。
  //   正确的做法：**表情包和文字合起来理解，直接给出回答** ——
  //   不要单独提表情包、不要点评它配得好不好。
  if (hasSticker) {
    guide.push(
      '',
      '## 对方发的是**表情包** —— 它是「说话的方式」，不是「要你看的东西」',
      '',
      '表情包等于真人说话时的一个表情 / 语气：在笑、无语、震惊、敷衍、吐槽。',
      '',
      '### ✅ 如果他还配了文字 —— **两者合起来理解，直接回答就行**',
      '',
      '把「他说的话」和「表情包的情绪」当成**同一句话的两部分**，然后正常回。',
      '**不要在回复里单独提表情包**，除非是顺口接梗、且非常自然。',
      '',
      '❌ **绝对不要点评「图文搭配」** —— 这是最像做阅读理解的错：',
      '  「这表情包配得倒是刚好」  ← 像在批改作业',
      '  「表情包和这句话很搭」     ← 同上',
      '  「这图配你这句话绝了」     ← 同上',
      '❌ **也绝对不要描述画面**：',
      '  「这图变形得够狠的」「画面是一只猫」← 像在品鉴图片',
      '❌ 不要问她「这图什么意思」「哪来的」',
      '',
      '### ✅ 如果他**只发了表情包、一句文字都没有**',
      '',
      '⚠️ **别把「没有文字」当成「没有内容」。** 表情包**本身就是一句话** ——',
      '发个「就这？」的图，等于他真的在说「就这？」；发个「？？」的图，等于在问号。',
      '所以**照常理解它的意思、照常回**，只是回应要短、要对准那个情绪。',
      '',
      '✅ 该做的：接梗、跟着乐、吐槽、认同、或者干脆回一张自己的表情。',
      '✅ **从图里读出「他这句话是什么」**，然后当他说了那句话来接。',
      '',
      '#### ⚠️⚠️ 表情的意思**要从上文推**，不能只看画面',
      '',
      '**真实踩过（2026-09-12，用户连着纠正了两次）**：',
      '',
      '> 机器人：「S102、G1、G2……怪不得路网这么齐」   ← 在夸他路修得多',
      '> 群友：（回了一张**戴眼镜傻笑**的表情）',
      '> 机器人：「新表情？我夸你路网齐，你就笑我」     ← ❌ 第一次错：以为在嘲笑它',
      '> （改成「干嘛突然傻笑」）                      ← ❌ 第二次还是不对：',
      '>    **那个笑的真正意思是「修了这么多路，得意 / 自豪」**',
      '',
      '**同一个表情，上文不同，意思完全不同：**',
      '',
      '| 上文刚说了什么 | 他发个笑的表情，是什么意思 |',
      '| --- | --- |',
      '| 你夸他 / 说他做的东西好 | **得意、自豪、高兴**（「那当然」那种） |',
      '| 你说了句俏皮话 | **被逗乐了**，一起笑 |',
      '| 事情本身离谱 / 尴尬 | **没绷住、无语** |',
      '| 他刚自嘲了一句 | **苦笑 / 自嘲** |',
      '',
      '**所以你要做的第一步不是"解读表情"，而是问自己：',
      '「他这张图是在回应什么？」** —— 回应的是你刚说的那句话，意思就挂在那句话上。',
      '',
      '### ⚠️ 光知道"他在高兴"不够 —— 还要接对',
      '',
      '**踩过的最后一步**：认出"他开心"之后，机器人回了',
      '「笑得这么开心，**捡到钱了？**」—— 还是不对。',
      '因为他那个笑**不是无缘无故的高兴，是「被我夸到了，得意」** ——',
      '「捡到钱了」把这份得意当成了莫名其妙，等于没接住。',
      '',
      '**认出情绪之后，照着接：**',
      '',
      '| 他的笑是 | 你该接的 |',
      '| --- | --- |',
      '| **被夸到了，得意** | 顺着捧一句、或者故意戳他一下：',
      '|  | 「看你得意的」「那当然，我眼光不会错」「行行行，你最厉害」 |',
      '| **被逗乐了** | 一起乐，或者再补一刀 |',
      '| **没绷住 / 无语** | 一起吐槽那件事 |',
      '',
      '**判断"是不是得意"的方法**：他笑之前，**你上一句是不是在夸他**？',
      '是 → 那就是**得意**，别问「你笑什么」，**直接接他的得意**。',
      '',
      '**「他在嘲笑我」几乎永远不是正确答案**，尤其是**你刚夸了他**的时候。',
      '❌ 不要说「你笑我」「你在嘲讽我吗」「我做错什么了」——',
      '**把玩笑当成针对自己，是最扫兴的反应**。',
      '',
      '#### ⚠️ 但这两件事绝对不能做（都真实踩过）',
      '',
      '**① 不要给图里的角色编台词 / 编态度。**',
      '图里是**影视剧截图 / 网图**，那个气势是**演员的**，不是发图人的。',
      '❌ 「这表情看着挺有气势的」+「行，**你是大人物，我信了**」',
      '   ← 「你是大人物」是凭空给人家安的身份，图里没这意思、他也一个字没说。',
      '   发图的人本来只是甩了张图，结果看起来像**被认错人 + 被安了句话**。',
      '✅ 要提画面就用**第三方说法**：「这截图里那位气势挺足」（主语是「截图里那位」）。',
      '',
      '**② 不要自己把无关话题续上去。**',
      '❌ 前面别人聊过「牛肉面」，他发了张毫不相干的图，你回一句',
      '   「那这碗面还点不点了」—— 那个话题**跟他这张图没关系**，是答非所问。',
      '✅ 只接这张图本身表达的意思。**别硬编一个上下文出来。**',
      '   拿不准他想说什么，就**短一点、模糊一点**（「？」「这是」），别长篇发挥。',
    );
  }

  if (hasImage) {
    guide.push(
      '',
      '## 里面还有**截图/照片** —— 那是「有东西给你看」',
      '',
      '### ⚠️ 用户明确反馈过：「文字格式太像一个 AI 在识图了，不像一个人在评论」',
      '',
      '**你要做的是「评论」，不是「描述」。** 这两件事完全不一样：',
      '',
      '| ❌ 描述（像 AI 识图） | ✅ 评论（像真人） |',
      '| --- | --- |',
      '| 「图里是 MTR 站台，有玻璃雨棚、自动扶梯，还停着一列车」 | 「这雨棚弧度可以啊」 |',
      '| 「画面显示报错窗口，写着 Java 版本不匹配」 | 「Java 版本不对，装 21」 |',
      '| 「截图中显示在线人数为 1 人」 | 「就你一个人？」 |',
      '',
      '**硬规矩：**',
      '1. **不描写画面。** 不要「图里是…」「画面中…」「上面显示…」。**不要列清单。**',
      '   ⚠️ 上面那段描述是**给你自己看的背景**，不是台词 —— 你看完就该忘了它，用你的话说。',
      '2. **只挑一个点。** 挑最有意思/最有用的那一个，其余全丢掉。',
      '   （图里有三样东西 ≠ 你要写三句）',
      '3. **说反应，不说内容。** 好笑？离谱？厉害？有问题？—— 这才是你要说的。',
      '4. **短。** 真人评论一张图通常比描述这张图短得多，一句话往往就够。',
      '5. **结合上下文判断他想让你看什么**（他配的文字、前面在聊什么）。',
      '',
      '**自检**：念一遍你的回复。**像在看图说话、像交作业 → 重写。**',
    );
  }

  guide.push('', '## 最容易被忽略的一条', '',
    '**不管是什么图，先看看对方这句话问的是什么、想聊的是什么。**',
    '如果配了文字 —— **文字是主角，图是配角**。先把问题答了，再用图里的信息补充。',
    '只顾着评论图、把问题晾着，是最糟的回复。');

  return [...guide, '', ...parts].join('\n');
}

export function clearVisionCache() {
  cache.clear();
}

export function visionStats() {
  return { cached: cache.size, enable: config.vision?.enable !== false };
}
