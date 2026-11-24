/**
 * 对外发送的**总闸**：余额没了就别再往群里说话。
 *
 * ## 为什么单独一个模块
 *   · `llm.js` 要知道"撞到 402 了"（它最先发现），
 *   · `bot.js` 的 `sendText()` 要知道"能不能发"（所有外发路径的最后一道），
 *   · `balance.js` 要知道"充值了、可以恢复"（它每 2 分钟查一次余额）。
 *   这三家互相 import 会成环（balance → llm → balance），所以把**标志位**单独放这儿，
 *   谁都能读、只有明确的三个时机能写。
 *
 * ## 什么时候闭麦（任一条成立）
 *   ① 模型接口返回 **402（余额不足）/ 401（凭据失效）** —— `markExhausted()`，
 *      这条最要紧：余额查询接口本身也可能查不到（今天 18:23 之后就一直没更新），
 *      光靠"查到的余额 ≤ 0"根本拦不住 ✗
 *   ② 余额接口**查到**的数字 ≤ 0。
 *
 * ## 什么时候恢复
 *   余额接口查到 **> 0** ⇒ `markAlive()`（充值之后 2 分钟内自动恢复，不用重启）✓
 *
 * ⚠️ 只管**对外发送**（群消息 / 私聊 / 说说 / 评论…都会从 `sendText` 或 `call('send_*')` 出去）。
 *   日志、本地状态照常写 —— 停了之后还要能查是什么时候停的。
 */

let exhausted = false;
let reason = '';
let at = 0;

/** 闭麦：撞到 402/401 时调用 */
export function markExhausted(why = '') {
  const first = !exhausted;
  exhausted = true;
  reason = String(why || reason || '余额不足').slice(0, 120);
  at = Date.now();
  return first; // true = 这次才刚闭麦（调用方可以顺势只打一条日志）
}

/** 恢复：余额查到 > 0 时调用 */
export function markAlive() {
  const was = exhausted;
  exhausted = false;
  reason = '';
  at = 0;
  return was; // true = 刚从闭麦恢复
}

export function isExhausted() {
  return exhausted;
}

export function muteInfo() {
  return { exhausted, reason, at };
}
