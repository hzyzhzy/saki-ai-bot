/**
 * 「她主动凑上去，却说自己不知道」这道闸的回归（2026-10-04 加）。
 *
 * ## 为什么要盯这个
 *   用户原话：
 *     「加一道闸，**只在没提到 saki 和不在连续接话**（也就是**只在主动接话**）时启用，
 *       如果输出的消息是 saki 在说自己不知道，**直接取消发送**」
 *     「注意如果是**在连续和一个人对话**时这个闸就不要启用」
 *
 *   背景（用户截图）：群里有人发了个游戏宣传链接，她**主动插了一句**
 *   自己压根答不上来的话 —— 既没人问她，她也不懂，那条消息对群里就是纯噪音。
 *
 * ## 这个套件盯两件事（**两件一样重要**）
 *   ① 判据认得准（`detectOwnIgnorance`）：她自认不知道的要认出来，
 *      **说别人的**（「你不知道吗」「他答不上来」）和**反问**（「我怎么不知道」）
 *      一个字都不许碰；
 *   ② 闸**只在主动接话时**启用（`Bot.ignoranceGateApplies`）：
 *      @她 / 点名 / 引用 / 私聊 / 连续接话 / **正在跟同一个人连续对话** /
 *      **有人问服务器问题（question）** / **收紧度 0** —— 这几种必须放行。
 *      ⚠️ 拦错了表现为"她突然不说话"（静默失败），比多说一句难查得多。
 *
 * ⚠️ 纯离线：只测纯函数与判定方法，不起进程、不碰真 QQ、不花钱。
 * ⚠️ 必须**单独一个进程**：它 import `src/bot.js`，而 `test/behavior.js` 里
 *    绝不能 import 那个（会让它自己那 6 条"闲聊不接"全变成接 —— 见那个套件的注释）。
 * 用法: node test/ignorance.js
 */
import { Bot, detectOwnIgnorance } from '../src/bot.js';
import * as history from '../src/history.js';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

// ── 判据：该拦的 ────────────────────────────────────────────
console.log('\n【1】她说自己不知道 → 要认出来');
for (const t of [
  '我也不知道诶',
  '这个我不太清楚，你问别人吧',
  '这我可说不准',
  '我答不上来',
  '我没查到相关的',
  '看不清啊，让龟龟杜把图放大点', // ★ 用户截图里的原句（同一个毛病）
  '我不太了解这个',
  '这我不认识',
  '我没看懂',
  '我这边没有相关信息',
  '我也不确定',
  '这事儿我真不清楚',
  '我不记得了',
  '我搜不到',
]) {
  const r = detectOwnIgnorance(t);
  check(!!r, `拦下：${t}`, r ? `→ ${r}` : '（漏了！）');
}

// ── 判据：不许误拦的 ────────────────────────────────────────
console.log('\n【2】不许误拦的（说别人 / 反问 / 正常的话）');
// ⚠️ 这一组和上一组同样重要：拦错了＝她突然不说话，用户只会看到"她没回我"。
for (const t of [
  '我知道你不知道', // 说别人 → 不许拦
  '你也不知道吗',
  '他答不上来',
  '我怎么不知道这事', // 反问 = 我当然知道
  '我看不出有什么问题', // 语义相反：我看没问题
  '我懂了，你说得对',
  '我知道了',
  '这题我会',
  '我明白你的意思',
  '我不太会用这个', // 「不会用」不是"不知道"
  '我想知道这个怎么弄', // 「想知道」不是"不知道"
  '服务器现在开着',
  '不客气',
  '我看了下，是 12 点开',
]) {
  const r = detectOwnIgnorance(t);
  check(!r, `放行：${t}`, r ? `→ 误拦了：${r}` : '');
}

// ── 闸的启用范围 ────────────────────────────────────────────
console.log('\n【3】闸只在"主动接话"时启用');
const EV = { message_type: 'group', group_id: '200000006', user_id: '1001' };
const KEY = history.sessionKey(EV);
const now = Date.now();

/** 造一个"她刚跟某人来回聊着"的对话状态 */
const chattingWith = (uid) => ({
  lastBotReplyTo: String(uid),
  lastBotReplyAt: now - 3000, // 3 秒前她刚说过话
  lastActivityAt: now - 1000,
  startedAt: now - 60000,
  herTurns: 2,
  theirTurns: 2,
  lastSpeaker: 'user',
  followUpChain: 1,
});

const applies = (mode, { conv = null, strictness = 40 } = {}) =>
  Bot.prototype.ignoranceGateApplies.call(
    {
      activeConv: new Map(conv ? [[KEY, conv]] : []),
      // ⚠️ 真实 Bot 上这是方法，而判定里要读它（收紧度 0 → 豁免）⇒ 假 this 也得给
      strictnessOf: () => strictness,
    },
    EV,
    mode,
  );

// ① 主动接话 → 启用（该拦）。⚠️ 群 200000006 的收紧度是 40（>0），所以闸生效
for (const mode of ['chat', 'share', 'sticker', 'echoSticker']) {
  check(applies(mode) === true, `启用：${mode}（没人问她，她自己凑上去）`);
}
// ② 明确召唤 / 私聊（voluntary 为空）→ 不启用
check(applies(null) === false, '不启用：@她 / 点名 / 引用她（voluntary 为空）');
check(applies('') === false, '不启用：voluntary 为空串');
// ③ 用户点名的两个例外
check(applies('followUp') === false, '不启用：连续接话（followUp）');
check(applies('mention') === false, '不启用：有人在聊她（mention = 提到了 saki）');
// ④ ★ 用户 2026-10-04 专门补的那条
check(
  applies('chat', { conv: chattingWith('1001') }) === false,
  '不启用：正在跟**同一个人**连续对话（他接着说）',
);
check(
  applies('chat', { conv: chattingWith('2002') }) === true,
  '仍启用：对话里说话的是**别人**（她插话，仍算主动）',
);
check(
  applies('chat', {
    conv: { ...chattingWith('1001'), lastActivityAt: now - 24 * 60 * 60 * 1000 },
  }) === true,
  '仍启用：跟同一个人的对话早就散了（一天前）',
);
// ⑤ ★ 用户 2026-10-04 追加拍板「要留」：有人问服务器问题时，她说
//    「这个我不清楚，得问服主」是**有用的**（把问题转给能答的人），不算噪音
check(applies('question') === false, '不启用：有人在问服务器问题（question —— 转给服主是有用的）');
// ⑥ ★ 用户 2026-10-04 追加拍板「对齐」：跟 judge 那道 know 硬闸同一口径 ——
//    收紧度 0 是"完全放权、想说就说"那一档，两道闸都不拦
check(applies('chat', { strictness: 0 }) === false, '不启用：收紧度 0（完全放权那一档）');
check(applies('chat', { strictness: 1 }) === true, '仍启用：收紧度 1（刚离开 0 档）');
check(applies('chat', { strictness: 100 }) === true, '仍启用：收紧度 100（最紧）');

// ── 边界 ────────────────────────────────────────────────────
console.log('\n【4】边界：空输入 / 非字符串不许抛错');
for (const v of ['', '   ', null, undefined, 123]) {
  let ok = true;
  let got = '（抛错了）';
  try {
    got = String(detectOwnIgnorance(v));
  } catch (e) {
    ok = false;
    got = e.message;
  }
  check(ok && got === 'null', `安全处理：${JSON.stringify(v)}`, got);
}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures ? 1 : 0);
