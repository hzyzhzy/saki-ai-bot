/**
 * 「套话句式」的二次改写 —— 把「谁也没X（谁）」这种书面套话换成自然说法。
 *
 * ## 为什么要有它（用户 2026-10-04 要求）
 *
 *   用户原话：「在剧情和事件里 saki **转述的话**里，有大量的『我们谁也没XX』，**要转换一下**」。
 *
 *   这句式（「谁也没喊谁」/「谁也没让谁」）是**互相指代**的书面写法（英文
 *   none of us / neither of us 的味道），中文口语一般说「都没出声」「谁也没开口」。
 *   它在两种文本里反复出现：
 *     · **一级事件** `life.js` —— 她今天发生的小事（发到群里）
 *     · **二级剧情** `quest.js` —— 她**转述给群友**的故事（用户口中的"转述"）
 *
 *   ⚠️ 提示词层**压不住**，而且原因很具体：`life.js` 里那条写的是
 *      「别用『谁也没…』这种套话**开头**」—— 只管句首，
 *      而实测冒出来的**全在句中/句末**：
 *        「远远看见立希在马路对面，**我们谁也没喊谁**。」
 *        「碰上素世，**谁都没停**，就这么走过去了。」
 *      ⇒ 规则压根没覆盖到它。这跟项目里其它几处一个道理：
 *        「两万六千字提示词里的小规矩，模型会忽略」。
 *
 * ## 方案（用户 2026-10-04 拍板：**生成后过一次模型改写**）
 *
 *   **命中才改**（不命中一次都不调用，省钱）——
 *   拿一次 `llm.phrase()`（非流式、关思考、便宜）把这一段换个说法。
 *
 * ## 三条安全绳（宁可说法旧一点，也不能把事实改坏 / 让事件发不出去）
 *
 *   ① **不命中就不调用** —— `looksCliched()` 不中直接原样返回；
 *   ② **长度护栏** —— 结果不足原文一半、或超过两倍 ⇒ 当失败，用原文；
 *   ③ `phrase()` 本身失败/超时返回空串 ⇒ 用原文。
 *
 *   ⚠️ 事件和剧情是**她真经历过的事**，改写不许动事实 —— 提示词里写死了，
 *      但真正兜底的是上面这三条（模型不听话时，最坏结果是"这句套话还在"，
 *      而不是"她今天的事被改成了别的"）。
 */
import { phrase } from './llm.js';
import { log } from './log.js';
import { config } from './config.js';

/** 命中的句式：「谁也没X」「谁都没X」（含「谁也没X谁」那种互指） */
const CLICHE = /谁[也都]没/;

/** 这个开关走环境变量，测试里一律关掉（详见 run-all 的隔离 env） */
function enabled() {
  const env = String(process.env.QQBOT_REWRITE ?? '').trim().toLowerCase();
  if (env === '0' || env === 'off' || env === 'false') return false;
  return config.rewrite?.enable !== false;
}

function cfg() {
  const r = config.rewrite ?? {};
  return {
    timeoutMs: Math.max(3000, Number(r.timeoutMs) || 20000),
    maxTokens: Math.max(60, Math.min(600, Number(r.maxTokens) || 320)),
  };
}

/** 这段文本里有那个套话吗（没有就一次调用都不花） */
export function looksCliched(text) {
  // ⚠️ 2026-10-04：**不设长度下限**。
  //    我第一版写了「太短的不改（< 10 字）」，结果用户点名的
  //    「我们谁也没喊谁」（7 字）、「两个人谁也没让谁」（8 字）**全被挡在外面**
  //    —— 而它们恰恰是最该改的（互指最生硬）。是 test/rewrite.js【1】抓出来的。
  //    真实场景里这句式也几乎不会单独成句（事件/剧情都是几句话的一段）。
  return CLICHE.test(String(text ?? ''));
}

const clip = (t) => String(t ?? '').replace(/\s+/g, ' ').slice(0, 60);

const SYSTEM = [
  '你是中文文字编辑。下面这段是一个**日本高中女生用第一人称**讲的日常小事（她要发到群里）。',
  '这段里用了「谁也没X（谁）」这种**互相指代**的书面套话，读起来像翻译腔。请把它换成自然的中文说法。',
  '',
  '## 铁律',
  '· **事实一个字都不许改**：谁做了什么、去了哪、什么心情、事情的先后，全照原文。',
  '· 🚫 不许加新情节、不许删掉原文有的事、不许换人名、不许改时间地点。',
  '· 只换**说法**：句子数量别变，长度跟原文差不多（±三成以内）。',
  '· 🚫🚫 **改完不许再出现「谁也没」「谁都没」** —— 哪怕只换了后面的动词也不行，',
  '  那正是要换掉的东西（「谁也没说话」→「谁都没开口」这种**不算改**）。',
  '· 保持第一人称和口语感 —— 别变文艺、别堆形容词。',
  '· 标点照旧：句末用 。？！……，🚫 不许用逗号把两句话串成一长串。',
  '',
  '## 改法方向（只是方向，**每次都要用不一样的说法**，别照抄）',
  '· 「我们谁也没喊谁」→「我们都没出声」/「两个人都没打招呼」',
  '· 「谁也没让谁」→「谁也不肯让」/「两边都梗着」',
  '· 「谁也没说话」→「一路都安静着」/「两边都没开口」',
  '· 「谁也没先出门」→「两个人都耗着」/「两边都僵在那儿」',
  '',
  '直接输出改好的**整段**，不要解释、不要引号、不要 markdown。',
].join('\n');

/**
 * 把一段文本里的套话换掉。**任何异常都返回原文**。
 *
 * @param {string} text 已经过 `tidyLifeText` / `ensureSentenceEnds` 的成品文本
 * @param {{where?:string}} [opts] `where` 只用来写日志（「一级事件」/「二级剧情」）
 * @returns {Promise<string>} 改好的文本；没命中/失败 ⇒ 原样返回
 */
export async function naturalize(text, opts = {}) {
  const src = String(text ?? '').trim();
  if (!src) return src;
  if (!enabled() || !looksCliched(src)) return src;

  const c = cfg();
  const where = String(opts.where ?? '').trim();
  let out = '';
  try {
    out = await phrase({
      system: SYSTEM,
      user: `原文：\n${src}\n\n改好的：`,
      maxTokens: c.maxTokens,
      timeoutMs: c.timeoutMs,
    });
  } catch (e) {
    log.warn(`[改写] 调用失败（用原文）：${e.message}`);
    return src;
  }
  out = String(out ?? '').trim();
  if (!out) {
    log.warn('[改写] 没拿到内容（用原文）');
    return src;
  }
  // ⚠️ 长度护栏：模型偶尔会"顺手扩写"或"只回半句"——
  //    事件和剧情宁可用旧的套话，也不能缺一段或长出一倍。
  const lo = Math.floor(src.length * 0.5);
  const hi = Math.ceil(src.length * 2);
  if (out.length < lo || out.length > hi) {
    log.warn(`[改写] 长度异常（${src.length} → ${out.length} 字）→ 用原文`);
    return src;
  }
  log.info(`[改写]${where ? `（${where}）` : ''} 套话换掉了：「${clip(src)}」→「${clip(out)}」`);
  // ⚠️ 改完**还带那个套话**（比如「谁也没说话」→「谁都没开口」这种只换动词的糊弄改法）：
  //    不发回原文（至少它换了说法），但记一条 warn —— 用户要看效果时一眼能数出来有多少。
  if (CLICHE.test(out)) log.warn('[改写] 改完仍带「谁也没/谁都没」（模型没照规矩换掉）');
  return out;
}
