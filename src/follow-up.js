/**
 * 「说完一句又想补充」—— 让机器人能自己接自己（2026-09-13 用户要求）。
 *
 * 用户原话：
 *   「在机器人回复一条消息之后**不用暂停 llm**，可以加个判定，
 *    如果机器人说完这句话之后**还想补充**，可以继续生成并接着发送，
 *    这样就更接近真人了。但是**不能每次都发补充消息，要和真人一样自然**，
 *    然后**限制最多自己接自己五条消息**」
 *
 * ## ⚠️ 为什么这件事必须"克制"
 *
 * 长回复本身就会被 `chunking` **拆成好几条**发出去。如果追补又每次都发，
 * 群里就是**一连串短消息刷屏** —— 那比"只回一条"更像机器人，不像人。
 *
 * 真人的"补充"有个很明确的特征：
 *   · **偶尔**发生（十次里两三次），不是每次
 *   · 补充的是**真的想起来了**（"啊对了…"「等一下，还有个事」），不是把话拆开说
 *   · **一条就够**，最多两条；连着补五条那是刷屏
 *
 * 所以这里的策略是**双重节制**：
 *   ① **概率闸**：不是每次都问模型（省调用，也保证"偶尔"）
 *   ② **模型闸**：问了它，它也可以说「没有要补的」（`无`）
 *   ③ **硬上限**：一次回复内最多追补 `maxPerReply`（默认 5，用户指定）
 *   ④ **绝对不能**：主回复以**问句**结尾时不许追补
 *      （刚问完人就自问自答，很怪）
 *
 * ## ⚠️ 和 `maxChain` 的区别（别搞混）
 *
 * | | 管什么 | 在哪 |
 * | --- | --- | --- |
 * | `maxChain`（bot.js 的 `strictnessParams`） | **跨回复**的"连续接话"上限 —— 防它接话接个没完 | 一条消息进来时判 |
 * | `maxPerReply`（本文件） | **一次回复内**自己能补几条 | 一条回复发完后判 |
 */
import { config } from './config.js';
import { log } from './log.js';
import * as persona from './persona.js';

// ⚠️ 配置键是 **`selfFollowUp`**（不是 `followUp`）——
//    `chat.followUp` 是另一件事（**对话延续**：别人又说话了要不要接着聊）。
const cfg = () => config.selfFollowUp ?? {};

/** 默认上限：用户指定「最多自己接自己五条消息」 */
export const MAX_PER_REPLY = 5;

/**
 * 第 2 条及以后的追补还要不要再试一次的概率（默认 0.5）。
 *
 * ⚠️ 为什么还要再砍一刀：概率闸（`shouldConsider`）只管"要不要问"，
 *    而模型被问了之后**倾向于硬编一句**。真连着补五条就是刷屏，
 *    所以过了第一关之后，每多补一条，继续补的意愿就该减半。
 *
 * ⚠️ 可用 `selfFollowUp.continueProbability` 覆盖 —— **测试要用**。
 *    否则"上限 5 条"这条断言就是 flaky 的（有时补 1 条有时补 3 条），
 *    而偶发失败的测试比没有测试更糟：会让人去查不存在的 bug。
 *    （第一版把这道随机留在 `bot.js` 里直接调 `Math.random()`，
 *      跑回归就挂了 3 项 —— 正好踩在这个坑上。）
 */
export const CONTINUE_P = 0.5;

/**
 * 随机数来源 —— **测试专用**（生产代码别碰）。
 *
 * ⚠️ 为什么需要：这条链上有**两道随机**（概率闸 + 续补概率），
 *    不固定住的话自动化测试就没法验"上限"。
 *    同类的口子还有 `recent.__storeForTest()` / `spend.reload()`。
 */
let rand = Math.random;
export function __setRandom(fn) {
  rand = typeof fn === 'function' ? fn : Math.random;
}

/**
 * 第 `index` 条追补还值不值得试？
 *
 * · `index === 0`：**第一条**（已经过了概率闸）→ 直接 true
 * · `index > 0`：按 `continueProbability`（默认 `CONTINUE_P`）掷一次
 *
 * @param {number} index 从 0 开始
 * @returns {boolean}
 */
export function shouldContinue(index) {
  const i = Number(index) || 0;
  if (i <= 0) return true;
  if (cfg().enable === false) return false;
  const p = Number(cfg().continueProbability ?? CONTINUE_P);
  return rand() < p;
}

/**
 * 该不该问一次"要不要补充"？（概率闸，省调用 + 保证"偶尔"）
 *
 * ⚠️ 这个概率**故意不高** —— 用户的语气是"要和真人一样自然"，
 *    而真人不会每次说完都补一句。
 *
 * @returns {boolean}
 */
export function shouldConsider(seed) {
  if (cfg().enable === false) return false;
  const p = Number(cfg().probability ?? 0.35);
  const r = typeof seed === 'number' ? seed : rand();
  return r < p;
}

/**
 * 主回复是不是**以问句结尾**（那就不该追补 —— 刚问完别自问自答）。
 */
export function endsWithQuestion(text) {
  return /[?？]\s*$/.test(String(text ?? '').trim());
}

/** 模型用来表示"没有要补的"的暗号 */
const NO_MORE = /^(无|没有|没有了|没什么|没了|—|-|\(无\)|（无）)$/;

/**
 * 判断有没有要补充的，有就返回那句话。
 *
 * ⚠️ 用**一次非流式小调用**，而且要求它"没有就说无" ——
 *    这样能拿到一个**确定的否定信号**，而不是靠模型硬编一句废话出来。
 *    （如果让它自由生成，它总会编出点什么，"克制"就没了。）
 *
 * @param {{replied:string, context?:string, index?:number}} p
 * @returns {Promise<string>} 空串 = 不需要补充
 */
export async function askFollowUp(p = {}) {
  const replied = String(p.replied ?? '').trim().slice(0, 400);
  if (!replied) return '';
  // 问句结尾不追补（见 `endsWithQuestion` 的注释）
  if (endsWithQuestion(replied)) return '';

  const llm = await import('./llm.js');
  const idx = Number(p.index ?? 0);

  // ⚠️ 这里**不能用 `llm.phraseMoney()`** —— 那个是专给报账用的，
  //    系统提示词里全是"数字不许改""不要说净赚""方向是领工资"那套铁律，
  //    套在"要不要补一句"上完全不搭（而且它第一句就要求"把数字说出来"）。
  //    所以直接自己拼提示词、走通用的 `phrase()`。
  const sys = [
    persona.promptText('followUpLine'),
    '',
    '## 你现在的任务',
    '你刚在群里说完一段话。真人聊天有个习惯：**说完一句，有时会又想起一件事，再补一句**',
    '（「啊对了…」「等一下」「哦还有」）。现在判断你**有没有这种想补充的冲动**。',
    '',
    '## 铁律',
    '· ⚠️⚠️ **没有要补的就只回一个字：「无」** —— **这是最常见的情况，别硬编**',
    '· ⚠️ **不要把刚才那句话换个说法再说一遍**（那不叫补充）',
    '· ⚠️ **不要为了凑而补**（「总之就是这样」「大概就这些」这种一律算「无」）',
    '· ⚠️ 真有补充的，是**新东西**：想起来的另一件事、另一个角度、或一句真心的嘀咕',
    '· ⚠️ 只补**一句**，20 字以内，不要分点、不要长篇',
    `· 这已经是第 **${idx + 1}** 次补充了 —— **越往后越应该回「无」**（真人补一两句就停）`,
    '· 直接给这句话（或者「无」），不要引号、不要解释',
  ].join('\n');

  const user = [
    p.context ? `# 群里最近的对话\n${String(p.context).slice(0, 800)}\n` : '',
    `# 你刚说完的那段\n${replied}`,
  ]
    .filter(Boolean)
    .join('\n');

  const t = await llm.phrase({ system: sys, user, maxTokens: 120, timeoutMs: 12000 });

  const out = String(t ?? '').trim().replace(/^["'「『]|["'」』]$/g, '');
  if (!out || NO_MORE.test(out)) return '';
  // 兜底：太长说明它又写了一整段（那不是"补充"，而是该走正常回复）
  if (out.length > 60) {
    log.debug(`追补内容太长（${out.length} 字），丢弃`);
    return '';
  }
  return out;
}

/** 给管理界面/自检看 */
export function status() {
  return {
    enable: cfg().enable !== false,
    probability: Number(cfg().probability ?? 0.35),
    maxPerReply: Number(cfg().maxPerReply ?? MAX_PER_REPLY),
    continueProbability: Number(cfg().continueProbability ?? CONTINUE_P),
    betweenMs: cfg().betweenMs ?? [400, 1200],
  };
}
