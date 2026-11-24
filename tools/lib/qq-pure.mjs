/**
 * 客户端协议端里那些**无副作用**的纯函数 —— 抽出来是为了能被自测套件单测。
 *
 * ⚠️ 为什么单独一个文件（2026-11-16）：
 *    `tools/qq-onebot.mjs` 是个**脚本**（一 import 就会 `server.listen` 抢 6700），
 *    所以里面的逻辑没法在测试里直接调。把"纯计算"那几样搬出来，
 *    主脚本和 `selftest.mjs` **共用同一份实现**，避免两边各写一套慢慢漂移。
 *
 * ⚠️ 有状态的（依赖 `lastGroups` 的 `nameToGid`）**没搬** —— 那个只能靠行为测
 *    （用旧群名去 `qq-py.py switch`，看能不能切过去）。
 */

/** 群名拆词：`谷雨、Stby'Crs、Anon、Saki` → ['谷雨', "Stby'Crs", 'Anon', 'Saki'] */
export function nameTokens(s) {
  return String(s || '')
    .split(/[、,，\s·|]+/)
    .map((x) => x.trim())
    .filter((x) => x && !/^[\p{P}\p{S}]+$/u.test(x));
}

/**
 * 两个会话名是不是同一个群（按词比）。
 *
 * ⚠️ 为什么不能只比字符串：**群名里带成员昵称，昵称和顺序都会变**。
 *    实测：`state/group-names.json` 记的「Anon、谷雨、Saki」，
 *    客户端会话列表显示「谷雨、Stby'Crs、Anon、Saki」——
 *    整串既不相等、也不互相包含 ⇒ 只比字符串会「找不到会话 → 切群失败」✗
 */
export function tokenMatch(want, have, minCommon = 2, ratio = 0.6) {
  const a = new Set(nameTokens(want));
  const b = new Set(nameTokens(have));
  if (a.size < 2 || b.size === 0) return false;
  let common = 0;
  for (const t of a) if (b.has(t)) common++;
  return common >= minCommon && common / Math.min(a.size, b.size) >= ratio;
}

/**
 * 一条消息的**稳定** `message_id`（同一句话永远同一个号）。
 *
 * ⚠️ 为什么必须是稳定的：`bot.js` 的 `handled.has(mid)` 靠它去重，
 *    实时推送和 `get_group_msg_history` 里的历史**必须用同一个算法**，
 *    否则补看会把刚刚正常收到过的消息再补一遍 ✗
 */
export function msgIdOf(group, m) {
  // ⚠️⚠️ 2026-11-17 回退：**不要带 y**。
  //    试过加 y（以为是"滚动内容的绝对坐标"），实测它是**视口坐标** ——
  //    新消息涌入时整屏上移，同一条 `@Saki` 的 y 从 269→189→109→29→-51 一路变，
  //    id 跟着变 ⇒ 同一条被当成 5 条新消息重推 ⇒ 她连发 6 条吐槽 ✗✗
  //    现在回到 `群|谁|正文`：稳定。
  //    已知代价：同一人**连发两条一字不差**的话，第二条会被当成同一条吞掉
  //    （比"反复重推"轻微得多；真漏了还能靠补看捞）。
  const s = `${group}|${m?.who || ''}|${m?.text || ''}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (Math.abs(h) % 2000000000) + 1000000;
}

/**
 * 昵称 → **稳定的伪 QQ 号**（客户端方案拿不到真号，但至少要能区分不同的人）。
 *
 * ⚠️ 原来 `user_id` 一律填 0 ⇒ 群里所有人在 bot 眼里都是同一个"0 号"：
 *    日志实证 `刚才就在跟他聊（0），接着说` ⇒ "只对某个人不回"就是这么来的。
 */
export function pseudoUid(name) {
  const s = String(name || '').trim();
  if (!s) return 0;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 100000000 + (Math.abs(h) % 900000000);
}

/** 戳一戳的判重 key（同一个人连戳两下也算两条） */
export function tipKey(t) {
  return [t?.who, t?.action, t?.target, t?.suffix].map((x) => String(x ?? '').trim()).join('|');
}
