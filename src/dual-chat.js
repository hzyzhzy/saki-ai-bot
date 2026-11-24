/**
 * 2026-11-09（用户：「**现在马上接，bot 自己发的漏洞太多了。而且不是去拦 agent，
 *    只需要 bot 来优化就行了**」）——
 *
 * **双通道对话（只润色，不拦）**：
 *   ① **agent 出内容**（它懂项目、知道改到哪、该发什么）—— `shadow-chat.js` 那条 DSH 会话；
 *   ② **bot 只负责把这句话说成自己的口气**，⚠️ **一个字都不许改意思**；
 *   ③ **agent 没说话**（空 / 超时 / 连不上）⇒ 这一轮 bot 自己回（不然客户没人应答）；
 *   ④ **润色那一步失败** ⇒ **直接用 agent 的原话**发出去（内容比口气重要）✓
 *
 * ⚠️ 这里**故意没有"判定 agent 答非所问 ⇒ 拦下来"**那套（第一版写过、已删）：
 *    用户明确要的是"bot 优化"，不是"代码替 agent 当审查员" —— 判错一次就等于把
 *    客户的活拦下来，比润色得不好糟得多 ✗
 */
import { log } from './log.js';
import { streamChat } from './llm.js';
import { shadowSay } from './shadow-chat.js';

/** 只润色：把 agent 那句换口气说出来，**不动意思** */
const POLISH_SYSTEM = [
  '你在帮人"把一段话按自己的口气说出来"。',
  '',
  '输入会给你两段：',
  '【客户这句话】他刚说的话',
  '【准备回的】懂项目的同事写好的回应',
  '',
  '把你【准备回的】那段，按你平时的口气重说一遍：',
  '1. 短句、口语、不列清单、不用 markdown、不用破折号、句尾少标点 ✓',
  '2. 🚫 **意思一个字都不许改**：要点、条件、它问的问题、它要的东西，一个都不能丢 ✗',
  '3. 🚫 不许加新内容、不许删信息、不许替它决定、不许替它承诺 ✗',
  '4. 长度**不要明显变长**（它两段你就两三句短的）✓',
  '5. 分 1~3 段，段之间空一行 ✓',
  '',
  '只输出重说后的那段话，不要解释、不要加引号、不要写"好的"。',
].join('\n');

/** agent 这一轮什么都没说时的兜底：bot 自己接一句 */
const BOT_OWN_SYSTEM = [
  '你就是那个接单做活的兼职大学生，正在跟客户一对一聊天。',
  '',
  '照你平时的口气说：短句、口语、不列清单、不用 markdown、句尾少标点 ✓',
  '现在**不需要动手做任何事**，就是把这一句回过去 ✓',
  '',
  '⚠️ 他说什么你就接什么 —— 他在抱怨就顺着接，他在退场就别再追着要材料，',
  '   他在开玩笑就陪一句。🚫 别把每句话都当成新订单 ✗',
].join('\n');

async function ask(system, user, maxTokens = 1200) {
  const parts = [];
  for await (const chunk of streamChat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    null,
    { maxTokens, timeoutMs: 60000 },
  )) {
    parts.push(typeof chunk === 'string' ? chunk : '');
  }
  return parts.join('').trim();
}

/**
 * 双通道说一句。
 *
 * @returns {Promise<{
 *   ok:boolean, mode:'polish'|'raw'|'bot-own'|'none', reply:string,
 *   agentReply?:string, why?:string, ms?:number, agentMs?:number, costTag?:string
 * }>}
 */
export async function dualSay({ key, cwd, text, timeoutMs = 120000 } = {}) {
  const t0 = Date.now();
  const customer = String(text ?? '').trim();

  // ① agent 出内容（它懂项目）
  const a = await shadowSay({ key, cwd, text: customer, timeoutMs });
  const agentReply = String(a?.reply ?? '').trim();

  // ③ agent 没说话 ⇒ 这一轮 bot 自己回
  if (!a?.ok || !agentReply) {
    let own = '';
    try {
      own = await ask(BOT_OWN_SYSTEM, customer, 800);
    } catch (e) {
      return {
        ok: false,
        mode: 'none',
        reply: '',
        why: `agent 没说话（${a?.why || '空'}），兜底也失败：${e.message}`,
        ms: Date.now() - t0,
        agentMs: a?.ms,
        costTag: a?.costTag,
      };
    }
    return {
      ok: !!own,
      mode: own ? 'bot-own' : 'none',
      reply: own,
      why: own ? '' : `agent 没说话（${a?.why || '空'}），兜底也没说出来`,
      ms: Date.now() - t0,
      agentMs: a?.ms,
      costTag: a?.costTag,
    };
  }

  // ② bot 只润色（不动意思）
  let polished = '';
  try {
    polished = await ask(POLISH_SYSTEM, `【客户这句话】\n${customer}\n\n【准备回的】\n${agentReply}`);
  } catch (e) {
    log.debug(`[双通道] 润色失败，用 agent 原话：${e.message}`);
  }

  // ④ 润色没出来 ⇒ 用它原话（内容比口气重要）
  if (!polished) {
    return {
      ok: true,
      mode: 'raw',
      reply: agentReply,
      agentReply,
      why: '润色没出来，用原话',
      ms: Date.now() - t0,
      agentMs: a.ms,
      costTag: a.costTag,
    };
  }

  return {
    ok: true,
    mode: 'polish',
    reply: polished,
    agentReply,
    ms: Date.now() - t0,
    agentMs: a.ms,
    costTag: a.costTag,
  };
}
