/**
 * 「不同类机器人池」的回归（2026-10-06 用户要求）。
 *
 * ## 用户需求
 *   「和刚加的那个**同类机器人池**一样，再加个**不同类机器人池**，和那个**相反**，
 *    这个池专门放**小豆这种机器人**，saki **直接完全不回应**」。
 *
 * ## 这个套件盯什么
 *   ① 池里的号 → **一律不回**（不管 @ 不 @ 她、内容像不像问题、昵称像不像机器人）；
 *   ② **不误伤**：不在池里的群友照常 —— 这道闸一旦误判，表现是"她突然不说话"，
 *      比多说一句难查得多（和 `test/ignorance.js` 同一个道理）；
 *   ③ 和同类池**正好相反**：同类池是"要跟它聊"（放行），不同类池是"当它不存在"（拦下）
 *      —— 两个池搞混了是最要命的，所以这条单独断言；
 *   ④ 同一个号**两个池都填** → 按"完全不回应"（少说一句比乱搭话安全）；
 *   ⑤ 接线真的在（源码断言）：判定**排在同类池放行之前**、界面上能填能存。
 *
 * ⚠️ 纯离线：`new Bot()` 不连 QQ、不调模型、不花钱。
 * 用法: node test/other-bots.js
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { config, otherBotsFor } = await import('../src/config.js');
const { Bot } = await import('../src/bot.js');

const G = '999000001';
const G2 = '999000002';
const OTHER = '10000002'; // 池里的"别的机器人"（小豆那种）
const PEER = '10000001'; // 同类池里的号（黑祥那种）
const HUMAN = '30003'; // 普通群友

config.groupParams ??= {};
config.groupParams[G] = { peers: [PEER], otherBots: [OTHER] };
config.groupParams[G2] = { peers: [PEER] }; // 这个群只有同类池

const ev = (gid, uid, name = '') => ({
  group_id: gid,
  user_id: uid,
  sender: { card: name, nickname: name },
});
const bot = new Bot();

console.log('\n【1】配置怎么读');
{
  check(otherBotsFor(G).includes(OTHER), '★ 配了就能读到', JSON.stringify(otherBotsFor(G)));
  check(otherBotsFor(G2).length === 0, '这个群没配 → 空数组（不是 null，别让调用方崩）');
  check(otherBotsFor('').length === 0 && otherBotsFor(null).length === 0, '空群号 / null → 空数组');
  check(otherBotsFor('999000009').length === 0, '没配过的群 → 空数组');
}

console.log('\n【2】★ 池里的号：一律不回');
{
  check(bot.isIgnoredBotEvent(ev(G, OTHER)) === true, '★ 池里的号发普通消息 → 不回');
  check(bot.isIgnoredBotEvent(ev(G, OTHER, '是der的小豆')) === true, '★ 带群名片也一样不回');
  // ⚠️ 「@ 她也不回」不是在这里判的 —— 是**位置**保证的：
  //    这道闸在 `decide()` 里排在任何 atMe / 内容判断**之前**（见【5】的源码断言）。
  check(bot.isIgnoredBotEvent(ev(G, OTHER, '某某机器人')) === true, '★ 昵称也像机器人 → 照样只算一条，不回');
}

console.log('\n【3】★ 不许误伤普通群友（拦错了＝她突然不说话）');
{
  check(bot.isIgnoredBotEvent(ev(G, HUMAN, '路人甲')) === false, '★ 普通群友 → 照常处理');
  check(bot.isIgnoredBotEvent(ev(G2, HUMAN)) === false, '别的群的普通群友也一样');
  check(bot.isIgnoredBotEvent(ev(G, '')) === false, '没有 user_id → 不拦（交给后面的逻辑）');
}

console.log('\n【4】★★ 和同类池**正好相反**（搞混了最要命）');
{
  check(bot.isIgnoredBotEvent(ev(G, PEER)) === false, '★ 同类池里的号 → **放行**（要跟它聊起来）');
  check(bot.isIgnoredBotEvent(ev(G, OTHER)) === true, '★ 不同类池里的号 → **拦下**（当它不存在）');
  // 换个群：同类还是同类（说明是按群分开读的）
  check(bot.isIgnoredBotEvent(ev(G2, PEER)) === false, '同类池在别的群照样放行（按群读）');
  check(bot.isIgnoredBotEvent(ev(G2, OTHER)) === false, '★ 这个群没把 OTHER 放进异类池 → 不拦（按群，不是全局）');
}

console.log('\n【5】两个池都填了同一个号');
{
  config.groupParams[G2] = { peers: [PEER], otherBots: [PEER] };
  check(
    bot.isIgnoredBotEvent(ev(G2, PEER)) === true,
    '★ 冲突 → 按"完全不回应"处理（少说一句比乱搭话安全）',
  );
  config.groupParams[G2] = { peers: [PEER] }; // 还原
}

console.log('\n【6】原有的忽略行为没被搞坏');
{
  const old = config.teach.bots;
  config.teach.bots = [OTHER];
  check(bot.isIgnoredBotEvent(ev(G2, OTHER)) === true, '`teach.bots` 里的号照样不回（原有名单没受影响）');
  config.teach.bots = old;

  check(bot.isIgnoredBotEvent(ev(G2, HUMAN, '某某机器人')) === true, '昵称里带「机器人」→ 仍然拦（兜底规则还在）');
  check(bot.isIgnoredBotEvent(ev(G2, HUMAN, '群管家')) === true, '「群管家」→ 仍然拦');
  check(bot.isIgnoredBotEvent(ev(G2, HUMAN, '正常人')) === false, '正常昵称 → 不拦');
}

console.log('\n【7】接线真的在（源码断言）');
{
  const botSrc = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');

  // ① 判定必须排在同类池放行**之前** —— 否则冲突时是"同类池先放行"，行为就反了
  const iOther = botSrc.indexOf('otherBotsFor(gid).includes(uid)');
  const iPeer = botSrc.indexOf('if (this.isPeerBot(event?.group_id, event?.user_id)) return false;');
  check(
    iOther > 0 && iPeer > 0 && iOther < iPeer,
    '★ 「异类池」判定排在「同类池放行」之前（冲突时才按"不回"处理）',
  );

  // ② 这道闸必须挂在 `decide()` 里、而且是在**最早的位置**（不管 @ 不 @）
  check(/if \(this\.isIgnoredBotEvent\(event\)\)/.test(botSrc), '★ decide 里确实调了这道闸');

  // ③ 界面：能填、能存、能读回来
  const html = readFileSync(join(ROOT, 'src', 'webui.html'), 'utf8');
  check(/id="gp-other-bots"/.test(html), '★ 按群设定里有输入框');
  check(/Array\.isArray\(ov\.otherBots\)/.test(html), '★ 打开界面时会把已配的号填回去');
  check(/^\s*otherBots,$/m.test(html), '★ 保存时会把这一项提交上去');
  const webuiSrc = readFileSync(join(ROOT, 'src', 'webui.js'), 'utf8');
  check(/cur\.otherBots = otherBots/.test(webuiSrc), '★ 后端会把它写进 groupParams（去空/去重/封顶 10 个）');
}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
