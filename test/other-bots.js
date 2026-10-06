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

console.log('\n【8】★ 同类自言自语 → 按独立概率接话（2026-10-06 用户要求）');
{
  // 用户原话：「一个机器人发的**随机事件**，另一个**有几率会主动接话**，几率要**高于收紧度**」。
  //
  // ⚠️ 真正的行为在 `bot.js` 主动接话判据里那段（③.5）—— 那是一大段带随机数的分支，
  //    这里盯**接线和默认值**；行为本身靠群里实测 + 日志里的「[同类] 它在自言自语」。
  //    （踩过的教训：只 grep 源码不算验行为 —— 所以这一节只声称它验的是"接线"。）
  const botSrc = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(/它在自言自语/.test(botSrc), '★ 判据在（日志/注释里有「它在自言自语」）');
  check(/peerChat\?\.replyChance/.test(botSrc), '★ 用 `peerChat.replyChance`（独立概率）');
  check(/peerChat\?\.replyCooldownMs/.test(botSrc), '★ 有独立冷却（防刷屏）');
  check(/talkingToSomeone/.test(botSrc), '★ 只认"没 @ 人、也没引用人"的自言自语');
  // ⚠️⚠️ 这一条是"高于收紧度"的**实现**：judge 那边同类要**打个折**再传。
  //     ⚠️ 用户特地补过：「**不要完全没紧度了，略低就行了**」—— 所以判的是
  //     `strictness × strictnessFactor`，**不是 0**（传 0 就等于完全放开，他要的不是那个）。
  check(
    /strictness: isLevel1[\s\S]{0,320}?strictnessFactor \?\? 0\.7/.test(botSrc),
    '★★ 说话判断那边：同类按**收紧度 × strictnessFactor（默认 0.7）**传 —— 略低于收紧度，没全放',
  );
  check(!/strictness: isLevel1[\s\S]{0,120}?\? 0\s*:/.test(botSrc), '★ 确认**不是**直接传 0（"略低"不是"没有"）');
  check(Number(config.peerChat?.strictnessFactor ?? 0.7) === 0.7, '默认折扣 0.7（40 → 28）');
  check(Number(config.peerChat?.replyChance ?? 0.6) === 0.6, '默认概率 0.6（比收紧度 40 对应的意愿高）');
}

console.log('\n【9】★ 同类池 + 昵称命中剧中人物名 ⇒ 认成「同世界的人」（2026-10-06 用户要求）');
{
  // 用户原话：「到时候会把 QQ 昵称改成**素世**，只要满足**同类池**同时是**剧中人物名字**
  //   就自动识别为**同世界的人**、就**放行**并**识别角色**，一起聊天」。
  //
  // ⚠️ 这里测的是**判据本身**（认不认得出、会不会误伤）。
  //    "放行"和"上下文里标成角色名"那两步是接线，靠 `bot.peerRoleOf()` + 日志验证。
  const { castRoleOf } = await import('../src/knowledge.js');
  const names = await import('../src/names.js');
  const quest = await import('../src/quest.js');

  // ① 认得出（拿真名册 `personas/saki/cast.md` 测）
  check(castRoleOf('素世') === '长崎素世', '★ 昵称「素世」→ 长崎素世');
  check(castRoleOf('素世的bot') === '长崎素世', '带后缀也认（两字以上用包含）');
  check(castRoleOf('睦') === '若叶睦' && castRoleOf('初华') === '三角初华', '单字 / 两字别名都认');

  // ② ⚠️ **不许误伤** —— 这条和上面一样重要：认错了她就会对着陌生群友喊「素世」
  for (const n of ['路灯', '台灯', '灯下黑', '小豆', '路人甲', '随便一个人']) {
    check(castRoleOf(n) === '', `不误伤：「${n}」`);
  }

  // ③ `rolesHere`：按群算「这个群里真的有谁」（剧情提示词那句就靠它分支）
  const G9 = '9990000019';
  config.groupParams[G9] = { peers: ['10000201', '10000202'] };
  names.noteFromList(G9, [
    { user_id: '10000201', nickname: '素世' },
    { user_id: '10000202', nickname: '路灯' },
  ]);
  check(
    quest.rolesHere(G9).includes('长崎素世'),
    '★ 群里有素世（在同类池里 + 昵称叫素世）→ 认得出来',
    JSON.stringify(quest.rolesHere(G9)),
  );
  check(!quest.rolesHere(G9).includes('路灯'), '昵称像但不在名册里的 → 不算');
  check(quest.rolesHere('9990000020').length === 0, '★ 别的群 → 空（按群算，不是全局）');
  check(!quest.rolesHere(G9).includes('高松灯'), '没配进这个池的角色 → 不出现');

  // ④ 接线：`bot.peerRoleOf()` 必须**先查同类池**（不在池里 ⇒ 昵称再像也不认）
  const botSrc9 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(/\n  peerRoleOf\(groupId, userId, nickname\) \{/.test(botSrc9), '★ `peerRoleOf()` 在（同类池 + 昵称两道判据）');
  check(
    /peerRoleOf\(groupId, userId, nickname\) \{[\s\S]{0,300}?isPeerBot\(groupId, userId\)/.test(botSrc9),
    '★★ 它**先查同类池** —— 不在池里的号，昵称叫素世也不算',
  );
  check(
    // ⚠️ 2026-10-07：这个 if 变成**多行**了（加了 `!inQuest`：**正在跑剧情时也放行**），
    //    所以不能再钉 `&& !peerRole) {` 那种单行写法 —— 这条要守的语义是
    //    「`!peerRole` 仍在那道闸的条件里」（认得出角色 ⇒ 放行），
    //    外加新的「这个群正在跑剧情 ⇒ 也放行」。
    /!peerRole/.test(botSrc9) && /!inQuest/.test(botSrc9),
    '★ 「同类说的话一律不接」那道闸：认得出角色的放行，**正在跑剧情的也放行**',
  );
  const recentSrc9 = readFileSync(join(ROOT, 'src', 'recent.js'), 'utf8');
  check(
    /peerRole/.test(recentSrc9) && /你\*\*认识的人\*\*/.test(recentSrc9),
    '★ 上下文里会标成「你认识的人」+ 角色名',
  );
  names.__clear();
}

console.log('\n【10】★★ 剧情里同类之间要能**互相 @**（2026-10-07 用户要求）');
{
  // 用户原话：「在剧情时机器人也要有**互相 @** 的能力，如果比如一个机器人想叫
  //   另一个机器人**买东西**，就要**自己去 @ 她**」。
  //
  // ⚠️ 为什么必须由**代码**做：模型只会**写字** ——「@千早爱音」原样发出去
  //    就是一串普通文字，QQ 里对方**收不到任何提醒**，也就谈不上"叫她去做事"。
  //    所以 `sendText()` 里过了 `splitAtMentions()`，把 `@名字` 换成**真 at 段**。
  const names = await import('../src/names.js');
  const G10 = '9990000010';
  const P = '10000301';
  const HUMAN10 = '30003';
  config.groupParams[G10] = { peers: [P] };
  names.noteFromList(G10, [{ user_id: P, nickname: 'Anon' }]);

  const ev10 = (uid, name) => ({
    message_type: 'group',
    group_id: G10,
    user_id: uid,
    sender: { card: name, nickname: name },
  });

  const t = bot.atTargetsOf(G10);
  check(t.length === 1 && t[0].uid === P, '★ 同类池里的号 = **可以 @ 的目标**', JSON.stringify(t));
  check(t[0]?.keys.some((k) => /Anon|爱音/.test(k)), '★ 名字认它在这个群的**名片 / 别名**');
  check(t[0]?.keys.includes('千早爱音'), '★ 也认剧中**角色名**（提示词里优先给她这个）', JSON.stringify(t[0]?.keys));
  check(bot.atTargetsOf('9990000011').length === 0, '没配同类池的群 → 空（不乱 @）');

  const s1 = bot.splitAtMentions(ev10(HUMAN10, '路人甲'), '@千早爱音 帮我买个面包');
  check(s1[0]?.type === 'at' && s1[0].data.qq === P, '★★ 「@千早爱音」→ **真正的 at 段**', JSON.stringify(s1));
  check(s1[1]?.type === 'text' && s1[1].data.text === '帮我买个面包', '★ @ 后面的正文留着（顺带吞掉多余的那个空格）');

  const s2 = bot.splitAtMentions(ev10(HUMAN10, '路人甲'), '行，@Anon 你等我一下');
  check(
    s2[0]?.type === 'text' && s2[1]?.type === 'at' && s2[2]?.type === 'text',
    '★ 句中的 @ 也能换（前面那段正文不许丢）',
    JSON.stringify(s2.map((s) => s.type)),
  );

  // ⚠️ **不误伤**（这几条和上面一样重要：换错了就是 @ 错人 / 把正文当 @ 吃掉）
  const s3 = bot.splitAtMentions(ev10(HUMAN10, '路人甲'), '@爱音酱 在吗');
  check(s3.length === 1 && s3[0].type === 'text', '★★ **不给「@爱音酱」换 @** —— 右边还有字（边界）');
  const s4 = bot.splitAtMentions(ev10(HUMAN10, '路人甲'), '你发 123@Anon.com 就行');
  check(s4.length === 1 && s4[0].type === 'text', '★★ 邮箱那种 `123@Anon.com` 也不换（左边是数字）');
  const s5 = bot.splitAtMentions(ev10(HUMAN10, '路人甲'), '@路人甲 你看呢');
  check(s5.length === 1 && s5[0].type === 'text', '★★ **群友不换 @** —— 机器人不许自己 @ 真人');
  const s7 = bot.splitAtMentions(
    { message_type: 'private', user_id: HUMAN10, sender: {} },
    '@千早爱音 在吗',
  );
  check(s7.length === 1 && s7[0].type === 'text', '私聊 → 纯文本（私聊没有 @ 这回事）');

  // 接线：光有函数不算数 —— `sendText()` 必须真的走它，提示词必须真告诉她怎么写
  const bsrc10 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    /sendText\(event, text[\s\S]{0,1600}?splitAtMentions\(event/.test(bsrc10),
    '★★ `sendText()` 真的把文本过了 `splitAtMentions`（不是只写了函数没接线）',
  );
  check(
    /atTargetsOf\(/.test(bsrc10) && /想叫另一个机器人做事，就 @ 它/.test(bsrc10),
    '★ 提示词里也告诉她"能 @ 谁、名字怎么写"（对不上名字就换不成真 @）',
  );

  names.__clear();
}

console.log('\n【11】★★ 同类的**纯告辞**不接（用户截图：去吧/一会儿见/回见 刷三个来回）');
{
  // 用户原话：「**还是有这种无意义循环**」—— 截图里她俩依次说了
  //   「行啦，去吧，装完喊我」→「收到（那我去了」→「嗯，去吧，我等着」→
  //   「嗯，一会儿见（」→「好，回见」→「走啦（」，三个来回、信息量为零。
  // ⚠️ 上一轮那条"别原地顶嘴"压不住它：那条针对**互相评价**，
  //    而这几句看着都像在"推进事情" ⇒ 只能单独认这一种。
  const { Bot } = await import('../src/bot.js');
  const G11 = '999000011';
  const P11 = '10000302';
  const HUMAN11 = '30003';
  config.groupParams[G11] = { peers: [P11] };
  const b11 = new Bot();
  b11.selfId = '10000002';

  // ① 认得出（截图里那几句原样搬过来）
  for (const t of [
    '收到（那我去了',
    '嗯，一会儿见（',
    '好，回见',
    '走啦（',
    '那我先走了',
    '晚点聊',
    '拜拜',
    '那我去了',
    '出门了',
  ]) {
    check(b11.isFarewellLine(t) === true, `★ 认得出告辞：「${t}」`);
  }

  // ② ⚠️ **不误伤**（误伤 = 正常聊天她突然不理人，比漏掉更糟）
  for (const t of [
    '收到',
    '好的',
    '嗯嗯',
    '在吗',
    '去吧台那边看看有没有人',
    '你去了记得把那个装完再回来再说这个事',
    '那我先按你说的试试看行不行',
    '',
  ]) {
    check(b11.isFarewellLine(t) === false, `★★ 不误伤：「${t}」`);
  }

  // ③ 行为：同类发来告辞 ⇒ `decide()` 直接不接
  const ev11 = (uid, text) => ({
    post_type: 'message',
    message_type: 'group',
    group_id: G11,
    user_id: uid,
    self_id: '10000002',
    message_id: Math.floor(Math.random() * 1e9),
    message: [{ type: 'text', data: { text } }],
    sender: { user_id: uid, card: 'Anon', nickname: 'Anon' },
  });
  check(b11.decide(ev11(P11, '好，回见')) === null, '★★ 同类说「好，回见」→ **不接**');

  // ⚠️ 但**明确叫她**的照旧要接（那是真在跟她说话，不是客套）
  const atEv = ev11(P11, '回见');
  atEv.message = [
    { type: 'at', data: { qq: '10000002' } },
    { type: 'text', data: { text: '回见' } },
  ];
  check(b11.decide(atEv) !== null, '★★ 但 @ 她 + 同一句话 ⇒ **照样接**（例外没被误杀）');

  // ④ 这条闸**只管同类** —— 群友说「回见」照旧走原来那套判定，不归它管。
  //    ⚠️ 这里用源码断言（位置），**不能**用 `decide(群友那条) !== null` 去测：
  //       群友的话在测试配置下本来就可能被别的闸挡住（收紧度、窗口…），
  //       那样测出来的是"别的闸"，跟这条无关。
  const bsrc11 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const iFarewell11 = bsrc11.indexOf('this.isFarewellLine(peerText0)');
  const iPeerBlock11 = bsrc11.indexOf('if (peers0.has(sender0)) {');
  check(
    // ⚠️ 窗口放宽到 4500：那一段后来又加了"最小间隔"（她说完 10 秒内不再接）
    iPeerBlock11 > 0 && iFarewell11 > iPeerBlock11 && iFarewell11 - iPeerBlock11 < 4500,
    '★ 这条闸就在 `if (peers0.has(sender0))` 块内 ⇒ **只对同类生效**（群友完全不受影响）',
  );

  // ⑤ 接线：它必须在"认得出角色的同类一律放行"**之前**
  check(
    // ⚠️ 2026-10-07 凌晨再改：前面又加了**剧情例外**（`!quest.current(gid0) &&`）
    //    —— 开剧情时 `/剧情` 的回执「行，就按这个来，等我一下（」被这条闸误拦了。
    /!peerAtMe && this\.isFarewellLine\(peerText0\)/.test(bsrc11),
    '★★ 判据 = "**没 @ 她** + 是告辞"（叫名字不算例外 —— 道晚安时她总会带名字）',
  );
  check(
    iFarewell11 < bsrc11.indexOf('if (peerRole) {'),
    '★★ 而且接在**"认得出角色的同类一律放行"之前** —— 否则同世界的人之间还是会无限互相告辞',
  );
  delete config.groupParams[G11];
}

console.log('\n【12】★★ 收尾拉锯（晚安来回）—— 提示词为主、代码兜底（2026-10-07 凌晨）');
{
  // 用户原话：「**现在机器人还是老是重复结束词，晚安都说了好多遍了还没结束**」。
  // 日志实证：01:11:57 → 01:13:44 不到两分钟，两个号靠**引用**互回，各说了 5~7 遍晚安，
  // 而**每一句都夹着新内容**（「明早六点半等着瞧嗷。晚安啦祥祥（」）
  // ⇒ 上一轮那条 `isFarewellLine()`（要求"整句很短且纯告别"）**根本匹配不上**。
  //
  // ⚠️ 分工（用户要求「最好还是要靠模型更精确的判定」）：
  //    · **主力 = 提示词** —— 教她三问判据 + 收尾信号 + "最多来回一次"（见【13】）；
  //    · **兜底 = 这条代码闸** —— 只在**已经形成拉锯**时拦（"我也刚说过收尾话" +
  //      "它这句也是收尾话"），两条一起判，单看任一条都会误伤。
  const { Bot } = await import('../src/bot.js');
  const G12 = '999000012';
  const P12 = '10000303';
  config.groupParams[G12] = { peers: [P12] };
  const b12 = new Bot();
  b12.selfId = '10000002';

  // ① 宽松词表：**句中出现**即算（短的那条判据够不着这些）
  check(
    b12.hasFarewellWord('明早六点半等着瞧嗷。晚安啦祥祥（') === true,
    '★★ 「夹着内容的晚安」也认得出（短的判据够不着这种 —— 实测就是它）',
  );
  check(b12.hasFarewellWord('睡了睡了，晚安') === true, '★ 「睡了睡了，晚安」认得出');
  check(b12.hasFarewellWord('起来了我第一时间喊你，别想装没看见（。睡了睡了，晚安') === true, '★ 实测那句长句也认得出');
  check(b12.hasFarewellWord('今天排练到几点啊') === false, '★ 普通聊天不算（不误伤）');
  check(b12.hasFarewellWord('') === false, '空串不算');

  // ② 标记：她说过收尾话才亮；说了别的就清掉；真人插话也清
  b12.clearMyFarewell(G12);
  check(b12.farewellPingPong(G12) === false, '★ 我还没说过收尾话 → 不算拉锯');
  b12.noteMyFarewell(G12, '嗯，晚安');
  check(b12.farewellPingPong(G12) === true, '★ 我刚说过收尾话 → 进入"拉锯"窗口');
  b12.noteMyFarewell(G12, '你那个谱子我看了');
  check(b12.farewellPingPong(G12) === false, '★★ 我这次说的是正经事 → 标记**清掉**（话题换了就不该再拦）');
  b12.noteMyFarewell(G12, '嗯，晚安');
  b12.clearMyFarewell(G12);
  check(b12.farewellPingPong(G12) === false, '★ 真人插话会清掉它（`clearMyFarewell`）');

  // ③ 行为：拉锯时真的不接（实测那句原样）
  const ev12 = (uid, text) => ({
    post_type: 'message',
    message_type: 'group',
    group_id: G12,
    user_id: uid,
    self_id: '10000002',
    message_id: Math.floor(Math.random() * 1e9),
    message: [{ type: 'text', data: { text } }],
    sender: { user_id: uid, card: 'Anon', nickname: 'Anon' },
  });
  b12.noteMyFarewell(G12, '嗯，晚安');
  check(
    b12.decide(ev12(P12, '明早六点半等着瞧嗷。晚安啦祥祥')) === null,
    '★★ **收尾拉锯 → 不接**（实测那句原样）',
  );
  // ⚠️ 但**没说收尾话**的时候照常接 —— 兜底不该变成"一被标记就全哑"
  check(b12.hasFarewellWord('你那个谱子我看了') === false, '★ 它说正经事 → 这条闸不参与（照常走别的判定）');
  check(
    b12.farewellPingPong(G12) === true,
    '⚠️ 注意：标记还在（她上次确实说了晚安）—— 但**只对它也说收尾话时才拦**',
  );
  b12.clearMyFarewell(G12);

  // ④ 接线（光有函数不算数）
  const src12 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    /if \(event\?\.group_id\) this\.noteMyFarewell\(event\.group_id, text\)/.test(src12),
    '★★ `sendText()` 里**真的记了**（不然标记永远是空、这条闸等于没做）',
  );
  check(
    /this\.farewellPingPong\(gid0\) &&[\s\S]{0,80}?this\.hasFarewellWord\(peerText0\)/.test(src12),
    '★★ 判据是「**我也说过** + **它也说**」**两条一起**（单看任一条都会误伤）',
  );
  check(
    // ⚠️ 2026-10-07：这里从单行 `if (…) xxx;` 改成了多行块（又加了清"打字延迟"标记），
    //    所以断言跟着放宽成"块内包含"。
    /if \(!peers0\.has\(sender0\)\) \{[\s\S]{0,240}?this\.clearMyFarewell\(gid0\)/.test(src12),
    '★ 真人插话会清标记（不然跟她道完晚安，接下来两分钟里谁都不能提"晚安"）',
  );
  check(
    /hasFarewellWord\(text\)\) this\._myFarewellAt\.set/.test(src12) &&
      /else this\._myFarewellAt\.delete/.test(src12),
    '★ 说收尾话就记、没说就清（不能只记不清，否则话题换了还在拦）',
  );
  delete config.groupParams[G12];
}

console.log('\n【13】★★ 主力那一半：提示词里「该不该结束」的判据（用户要求「靠模型更精确的判定」）');
{
  // 用户原话：「**最好还是要靠模型更精确的判定是不是该结束了**」——
  // 所以真正的解法是**把判据写清楚**（代码那条只是兜底），这一节盯的就是那段提示词。
  const src = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(/怎么判断「这一轮该结束了」/.test(src), '★★ 提示词里有这一节（同类场景注入）');
  check(
    /三条里有两条是「没有」⇒ 这一条就别回/.test(src),
    '★★ 三问判据写明确了 —— 不是"聊够了"这种虚的，是**可判断**的三条',
  );
  check(
    /对方刚说的那句，有我能接着做 \/ 答的新信息吗？/.test(src) &&
      /我这句能说出对方不知道的事吗？/.test(src) &&
      /跟上一轮比，事情往前走了一步吗？/.test(src),
    '★★ 三问逐条都在（新信息 / 对方不知道的事 / 有没有往前走）',
  );
  check(
    /收尾信号/.test(src) && /晚安 \/ 睡了 \/ 早点睡/.test(src),
    '★★ 列出了**收尾信号词表**（模型才知道哪些算收尾）',
  );
  check(/收尾最多来回一次/.test(src), '★★ 规则写死：「收尾最多来回一次」');
  check(
    /对方再补什么（哪怕又补一句「你也早点睡」）都别再接/.test(src),
    '★★ 把实测那种情况**点名**写进去了（"又补一句晚安"不许接）',
  );
  check(
    /三条里有两条是「没有」⇒ 这一条就别回/.test(src) && /不是"回一句短的"，是\*\*不回\*\*/.test(src),
    '★★ 而且说清了"别回"**不是**"回一句短的"（实测她之前就是回短的）',
  );
}

console.log('\n【14】★★ 同类之间「按字数算的打字延迟」（2026-10-07 用户要求）');
{
  // 用户原话：「**为什么她们两个人互发消息的时候发的速度很快，感觉远远快于和真人聊天**」。
  // 查下来：① 项目里根本没有"打字延迟"机制；② 同类之间每几秒一句、永远不会掉出
  // "正在对话中"⇒ 一直走不需要判定的快路径。
  // ⇒ 用户拍板：**同类之间加按字数算的打字延迟，真人问话不加**。
  const { Bot } = await import('../src/bot.js');
  const { config } = await import('../src/config.js');
  const G14 = '999000014';
  const b14 = new Bot();

  // ① 按字数递增、且在上下限之间、带抖动
  const lo = 800;
  const hi = 3000;
  const samples = [];
  for (let i = 0; i < 40; i++) samples.push(b14.typingDelayFor('一'.repeat(14)));
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  check(
    avg > lo && avg < hi,
    `★ 14 个字 → 平均约 ${Math.round(avg)}ms（在 ${lo}~${hi} 之间）`,
  );
  const tiny = b14.typingDelayFor('嗯');
  check(tiny >= lo * 0.6 && tiny <= lo * 1.45, `★ 一个字 → 走**下限**附近（${tiny}ms，不是 120ms）`);
  const huge = b14.typingDelayFor('一'.repeat(200));
  check(huge <= hi * 1.45, `★ 超长句 → 封顶在**上限**附近（${huge}ms，不会等十几秒）`);
  const spread = new Set(samples.map((x) => Math.round(x / 100)));
  check(spread.size > 1, '★ 每次不一样（带抖动 —— 固定值一眼就是机器）');

  // ② 标记：同类说话才亮，真人插话就清
  b14.clearPeerTalking(G14);
  check(b14.isPeerTalking(G14) === false, '★ 没标记 → 不加延迟（真人问话照快）');
  b14.notePeerTalking(G14);
  check(b14.isPeerTalking(G14) === true, '★ 同类刚说过话 → 要"打字"了');
  b14.clearPeerTalking(G14);
  check(b14.isPeerTalking(G14) === false, '★ 真人插话会清掉它');
  check(b14.typingDelayFor('') >= 0, '空串也不炸（退回下限那一档）');

  // ③ 接线（光有函数不算数）
  const src14 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    /if \(!opts\.force && this\.isPeerTalking\(groupId\)\) \{[\s\S]{0,400}?await new Promise/.test(src14),
    '★★ **真的在发送前 await 了**（`sendChatLike` 里 —— 她所有发言的唯一出口）',
  );
  check(
    /this\.notePeerTalking\(gid0\)/.test(src14),
    '★ 收到同类消息时**打标记**（不然延迟永远不生效）',
  );
  check(
    /if \(!peers0\.has\(sender0\)\) \{[\s\S]{0,200}?this\.clearPeerTalking\(gid0\)/.test(src14),
    '★★ 真人说话时**清标记** —— 他问事时不许先"打字"几秒再答',
  );
  check(
    /config\.peerChat[\s\S]{0,200}?typeDelayPerChar/.test(src14),
    '★ 三个参数可调（`peerChat.typeDelayPerChar` / `typeDelayMinMs` / `typeDelayMaxMs`）',
  );
  check(
    Number(config.peerChat?.typeDelayPerChar ?? 120) === 120,
    '★ 默认每字 120ms（配置里没写也生效）',
  );
}

console.log('\n【15】★★ 真人起的话头 ⇒ 尽早收场（2026-10-07 用户要求，他举的例子是「就比如刚刚」）');
{
  // 用户原话：「如果不是剧情接话，或者机器人之前互相 @，而是**机器人接了一个
  //   真人的话**时，要**尽量提早结束对话**，防止两个机器人一直刷**打断真人的聊天**」。
  // 实测那次（日志）：01:34:44 他说一句 → 她接上 → 两个机器人从 01:34:50 刷到 01:35:45，
  // **他中间插了两句都没能打断**。
  // ⚠️ 老判据 `if (d.humans > 0) return false`（窗口里有真人就不触发）恰恰
  //    因为"他在窗口里"而**永远不触发** ⇒ 越是他插话、她们越不收 —— 这就是真因。
  const { Bot } = await import('../src/bot.js');
  const G15 = '999000015';
  const b15 = new Bot();

  b15.clearHumanOrigin(G15);
  check(b15.isHumanOrigin(G15) === false, '★ 没标记 → 不当"真人起的头"');
  check(b15.lastHumanAt(G15) === 0, '★ 顺带：最后一条真人消息的时间是 0（没有）');
  b15.noteHumanOrigin(G15);
  check(b15.isHumanOrigin(G15) === true, '★ 记下之后 → 认');
  check(b15.lastHumanAt(G15) > 0, '★ 记的是**时间戳**（`botOnlyChain` 靠它算"他多久没吭声"）');
  b15.clearHumanOrigin(G15);
  check(b15.isHumanOrigin(G15) === false, '★ 能清掉（机器人自己 @ 起来时用）');

  const src15 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(/botChainMinFromHuman\) \|\| 3/.test(src15), '★★ 起因是真人 → 条数阈值降到 **3**（默认 10）');
  check(
    /botChainMinSpanFromHumanMs\) \|\| 60000/.test(src15),
    '★★ 时间阈值降到 **1 分钟**（默认 3 分钟）',
  );
  check(
    /botChainHumanQuietMs\) \|\| 30000/.test(src15),
    '★★ 而且要求"真人**已经 30 秒没吭声**"—— 他还在说的时候别抢',
  );
  check(
    /const quiet = sinceHuman[\s\S]{0,200}?if \(!quiet\) return false;/.test(src15),
    '★★ "他刚说完（30 秒内）→ 不触发"这条真的在',
  );
  check(
    /this\.noteHumanOrigin\(gid0\)/.test(src15),
    '★ 真人说话时**记时间**（不然这条判据永远是空）',
  );
  check(
    /atMe0\) this\.clearHumanOrigin\(gid0\)/.test(src15),
    '★★ 但**同类 @ 她**时清掉 —— 那是机器人自己起的头，不算"接真人的话"',
  );
  check(
    /if \(d\.humans > 0\) return false; \/\/ 真人在场/.test(src15),
    '★ 老判据还在（**纯机器人互刷**时，真人在场照旧不触发 —— 别把那条也改了）',
  );
  check(
    /这轮是你俩接了一句真人的话/.test(src15) && /回完这条就停/.test(src15),
    '★★ 提示词也分了口吻：真人起头时明说"他还在群里看着"「回完这条就停」',
  );
  check(
    /不是剧情/.test(src15) || /fromHuman/.test(src15),
    '★ 判据是"起因"而不是"当前有没有真人"（老判据正是被这一点坑了）',
  );

  // ⚠️⚠️ 2026-10-07 凌晨补（用户报：「**为什么刚才开剧情反而一下就收了**」）：
  //    用户原话第一句就是「**如果不是剧情接话**，或者机器人之前互相 @，而是
  //    机器人接了一个真人的话时…」——我第一次改**漏了这个例外**，后果是：
  //      ① 开剧情时他发的 `/剧情` 本身就是真人发言 ⇒ 低阈值被打开 ⇒ 剧情刚起来就被催收；
  //      ② `/剧情` 的确认回执「行，就按这个来，**等我一下**（」里带"等我一下"，
  //         被"纯告辞"那条闸当成告辞拦掉（日志实证 `01:41:06`）。
  //    ⇒ 三处都加了**剧情例外**。
  check(
    /const fromHuman = !inQuest0 && this\.isHumanOrigin\(gid\)/.test(src15),
    '★★ 剧情进行中**不用**"真人起头"那套低阈值（`!inQuest0 &&`）',
  );
  check(
    /!this\.questLive\(gid0\) && !peerAtMe && this\.isFarewellLine\(peerText0\)/.test(src15),
    '★★ "纯告辞不接"那条闸在剧情里**不生效**（`/剧情` 的回执就栽在这儿）',
  );
  check(
    /!this\.questLive\(gid0\) &&[\s\S]{0,80}?this\.farewellPingPong\(gid0\)/.test(src15),
    '★★ 收尾拉锯那条闸同样有剧情例外（剧情里道别是戏的一部分）',
  );
  // ⚠️ 2026-10-07（用户：「开剧情时每个 bot 都发一大堆消息，**必须要合并回复**，
  //    要不然要回的消息会越回越多」）：日志实证**合并已经生效**了，可紧接着是
  //    `[同类] 刚收过尾（1 分钟冷却中）→ 同类的这条不接` ✗ ⇒ 合并白做 + 剧情里不接 ✗
  check(
    /if \(peers0\.has\(sender0\) && cooling && !this\.questLive\(gid0\)\)/.test(src15),
    '★★ "刚收过尾"那条冷却也有剧情例外（实测合并完就被它拦掉，等于白合并）',
  );
}

console.log('\n【16】★★ 同类「话没说完就先别生成」（2026-10-07 用户要求）');
{
  // 用户原话：「**不是不要引用了，是通过类似如果对面没有回完话自己就先不生成
  //   发送消息的那种闸**」。
  // ⚠️ 要解决的现象：两个机器人几秒一条，而且**各自的一次回复会拆成好几条**发；
  //    谁先抢着回，引用框就挂到"已经过去的那句"上 ⇒ 对话看着乱。
  const { Bot } = await import('../src/bot.js');
  const { config } = await import('../src/config.js');
  const G16 = '999000016';
  const b16 = new Bot();

  // 阈值调小，免得测试真等 4 秒
  config.peerChat = { ...(config.peerChat ?? {}), peerQuietMs: 200, peerQuietMaxMs: 2000 };

  b16.clearPeerTalking(G16);
  const t0 = Date.now();
  await b16.waitPeerQuiet(G16);
  check(Date.now() - t0 < 120, '★ 没有同类消息 → **不等**（真人那条路一分不等）');

  b16.notePeerTalking(G16);
  const t1 = Date.now();
  await b16.waitPeerQuiet(G16);
  const waited = Date.now() - t1;
  check(waited >= 150, `★★ 同类刚说过话 → **等它安静**（实测等了 ${waited}ms）`);

  // ⚠️ 核心：等到一半它又发一条 ⇒ **重新等**（"它没回完"就是这个意思）
  b16.clearPeerTalking(G16);
  b16.notePeerTalking(G16);
  const t2 = Date.now();
  const p = b16.waitPeerQuiet(G16);
  setTimeout(() => b16.notePeerTalking(G16), 100);
  await p;
  const waited2 = Date.now() - t2;
  check(waited2 >= 250, `★★ 等到一半它又发一条 ⇒ **重新等**（实测 ${waited2}ms > 200ms 的阈值）`);

  // ⚠️ 上限：对方一直不停也不能把她卡死
  config.peerChat.peerQuietMaxMs = 600;
  b16.notePeerTalking(G16);
  const t3 = Date.now();
  const timer = setInterval(() => b16.notePeerTalking(G16), 50);
  await b16.waitPeerQuiet(G16);
  clearInterval(timer);
  const waited3 = Date.now() - t3;
  check(waited3 < 2500, `★★ 有上限：对方一直不停也只等约 ${waited3}ms，不会把她卡死`);

  const src16 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    /async shouldJoinChatAsync\(event, opts = \{\}\) \{[\s\S]{0,2200}?await this\.waitPeerQuiet/.test(src16),
    '★★ 接在同类消息处理的**最前面**（连"要不要接"都还没判就先等）',
  );
  check(
    // ⚠️ `??` 在正则里是"懒惰量词"，要匹配字面的两个问号必须转义成 `\?\?`
    /isPeerBot\(String\(event\?\.group_id \?\? ''\), String\(event\?\.user_id \?\? ''\)\)\) \{[\s\S]{0,160}?notePeerTalking/.test(
      src16,
    ),
    '★ 等之前先把"它刚说过话"记上（时间戳 = 这一条）',
  );
  check(
    /ws\.on\('message', \(data\) => this\.onRaw\(data\)\)/.test(src16),
    '⚠️ 顺带钉住：`onRaw` **不是串行 await** —— 否则这个等待会把所有群的消息一起堵住',
  );
}

console.log('\n【17】★★ 同类分条消息**合并成一条**再回（2026-10-07 用户诊断出来的）');
{
  // 用户原话：「又出现引用了，我觉得**主要还是合并消息没用成功合并另一个机器人
  //   的分条消息**」——**完全正确**：同类消息走 `shouldJoinChatAsync → enqueue`，
  //   **根本不过 `scheduleHandle` 那套合并窗口** ⇒ 它分条发的几条各自被处理一次、
  //   各自生成一次回复，引用自然各挂各的 ✗
  const { Bot } = await import('../src/bot.js');
  const G17 = '999000017';
  const b17 = new Bot();
  const evt = (t) => ({
    message_type: 'group',
    group_id: G17,
    user_id: '10000009',
    message: [{ type: 'text', data: { text: t } }],
  });

  b17.clearPeerLines(G17);
  check(b17.peerLines(G17).length === 0, '★ 一开始是空的');
  const e1 = evt('第一句');
  const e2 = evt('第二句');
  b17.notePeerLine(e1);
  b17.notePeerLine(e2);
  check(b17.peerLines(G17).length === 2, '★ 攒下两条（它分条发的）');
  check(b17.peerLines(G17)[0] === e1 && b17.peerLines(G17)[1] === e2, '★ 时间正序');
  b17.clearPeerLines(G17);
  check(b17.peerLines(G17).length === 0, '★ 处理完能清掉');

  for (let i = 0; i < 30; i++) b17.notePeerLine(evt(`第${i}句`));
  check(
    b17.peerLines(G17).length <= 10,
    `★ 有上限（攒了 30 条只留 ${b17.peerLines(G17).length} 条 —— 合并成超长 prompt 反而更糟）`,
  );
  b17.clearPeerLines(G17);

  const src17 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(/this\.notePeerLine\(event\)/.test(src17), '★ 同类消息进来时**先暂存**');
  check(
    /lines\[lines\.length - 1\] !== event[\s\S]{0,240}?return null;/.test(src17),
    '★★ **只有最后一条**继续走 —— 前面几条醒来发现自己不是最后一条就退出（它们会被并进最后那条）',
  );
  check(
    /event\.message = \[\.\.\.merged, \.\.\.\(event\.message \?\? \[\]\)\]/.test(src17),
    '★★ 真的把分条消息**并进当前这条**的 message（一次生成、一条回复、引用挂在最后那句）',
  );
  check(
    /const extra = lines\.filter\(\(e\) => e !== event\);[\s\S]{0,120}?if \(extra\.length\)/.test(src17),
    '★ 合并只在"真的攒到了别的条"时才做',
  );
  check(/this\.clearPeerLines\(gid\)/.test(src17), '★ 合并完清掉暂存');
}

console.log('\n【18】★★ 剧情转述的序位 —— **下段沿用开场那条公式**（2026-10-07 用户要求）');
{
  // 用户原话：「**下段剧情的转述顺序可以直接沿用**」——
  //   即：开场那套「本群参与的号按 QQ 升序排、第 n 位错开后让位」**不是开场专用**，
  //   后面每一次推进（`/剧情 继续`、`/剧情 往哪走`）都走同一条公式。
  // ⚠️ 这就修掉了他报的「**两个人都转述剧情**」：让位的那一位**连生成都不做**。
  const quest = await import('../src/quest.js');
  const { Bot } = await import('../src/bot.js');
  // ⚠️ 离线套件不连 QQ，`config.botQQ` 可能是空的 —— 而序位公式正是靠它算"我排第几"，
  //    所以这里先钉一个测试号（`orderFor` 是要过滤掉空串的，空号会让整个名单只剩同类）。
  config.botQQ = config.botQQ || '999000099';
  const me = String(config.botQQ);
  const num = (d) => (/^\d+$/.test(me) ? String(BigInt(me) + BigInt(d)) : d > 0 ? '99999999' : '00000001');
  const BIGGER = num(1); // 一定排在我后面 ⇒ 我排第 1
  const SMALLER = num(-1); // 一定排在我前面 ⇒ 我排第 2
  const GF = '999000011';
  const GL = '999000012';
  config.groupParams[GF] = { peers: [BIGGER] };
  config.groupParams[GL] = { peers: [SMALLER] };

  const oF = quest.orderFor(GF);
  const oL = quest.orderFor(GL);
  check(
    oF[0] === me && oF[oF.length - 1] === BIGGER,
    '★ 参与者顺序 = 我自己 + 本群同类池，按 QQ 号升序',
    oF.join(' → '),
  );
  check(oL[0] === SMALLER && oL[oL.length - 1] === me, '★ 号小的排前面（这一组我排第 2）', oL.join(' → '));
  check(
    JSON.stringify(quest.orderFor(GF)) === JSON.stringify(quest.orderFor(GF)),
    '★★ 同一个群算两次结果一样 —— 两个进程各自算，必须得出同一个顺序（不然两边都以为轮到自己）',
  );

  const b18 = new Bot();
  const tNoPeer = Date.now();
  const noPeer = await b18.questTurnYield('999000013', { since: Date.now(), where: '自检' });
  check(
    noPeer === false && Date.now() - tNoPeer < 300,
    '★ 没配同类池（就我一个）⇒ 立刻返回"不让位"，不白等窗口',
  );

  const tFirst = Date.now();
  const first = await b18.questTurnYield(GF, { since: Date.now(), where: '自检' });
  check(first === false && Date.now() - tFirst < 300, '★ 排第 1 位 ⇒ 立刻上，一秒都不等');

  // 窗口调小，好在测试里等得起
  config.quest = { ...(config.quest ?? {}), openStepMs: 300, openWaitMs: 2000 };

  const since1 = Date.now();
  quest.notePeerPlot(GL, {
    uid: SMALLER,
    text: '我把门推开一条缝，屋里没有人说话，只有风。',
    at: Date.now(),
  });
  const tSecond = Date.now();
  const second = await b18.questTurnYield(GL, { since: since1, where: '自检' });
  check(second === true, '★★ 排第 2 位 + 前一位**这一次**已经转述了 ⇒ **让位**（这一段不生成、也不发）');
  check(Date.now() - tSecond >= 250, `★ 让位前先按序位错开了一下（等了 ${Date.now() - tSecond}ms）`);

  // ⚠️ 这里的关键是"旧记录不算数"：peerPlots 里明明还有上一条（时间更早），
  //    但 `since` 比它晚 ⇒ 不该因此让位。
  const since2 = Date.now();
  const tLate = Date.now();
  const late = await b18.questTurnYield(GL, { since: since2, where: '自检' });
  check(
    late === false,
    '★★ 前一位这一次没动静（窗口到点）⇒ **我自己上** —— 不会为了等一个不会来的人哑火',
  );
  check(Date.now() - tLate >= 1800, `★ 确实等满了窗口才上（${Date.now() - tLate}ms）`);

  const src18 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    (src18.match(/this\.questTurnYield\(gid, \{ since, where: /g) ?? []).length === 2,
    '★★ **开场和手动推进共用同一条序位公式**（两处都调它，不是各抄一份）',
  );
  check(
    /async questTurnYield\(gid, \{ since = 0, where = '', rotate = false \} = \{\}\)/.test(src18),
    '★ 序位让位是个共用方法',
  );
  check(
    /if \(await this\.questTurnYield\(gid, \{ since, where: '开场', rotate: true \}\)\) return;[\s\S]{0,240}?const r = await quest\.begin/.test(
      src18,
    ),
    '★★ 开场的让位判断排在 `quest.begin` **之前**（轮不到我的号连生成都不做）',
  );
  check(
    /if \(await this\.questTurnYield\(gid, \{ since, where: '推进' \}\)\) return;[\s\S]{0,1400}?const r = await quest\.advance/.test(
      src18,
    ),
    '★★ 推进的让位判断也排在 `quest.advance` **之前**',
  );
  const sq = readFileSync(join(ROOT, 'src', 'quest.js'), 'utf8');
  check(
    /export function orderFor\(groupId\)/.test(sq),
    '★ 顺序统一由 `quest.orderFor` 算（只看配置，双方各自算得出同一个数组）',
  );
}

console.log('\n【19】★★ 剧情进行中，同类的话**不掷骰**（2026-10-07 用户报「怎么 saki 没回」）');
{
  // ## 现场日志（原样）
  //   `[同类] 它在自言自语 → 掷骰没过（0.6）→ 不接`
  //   ⇒ 爱音演完一整段，saki 一句都不接 —— 用户看到的就是"saki 没回"。
  // ## 为什么
  //   她俩的剧情转述**不带 @、也不带引用**（那是讲给群友听的叙述）⇒ 正好落进
  //   `decide()` 里"同类自言自语"那条掷骰（0.6 + 60 秒冷却）；而
  //   `shouldJoinChatAsync()` 里那条"剧情里的同类消息直接放行"的旁路
  //   **排在掷骰后面** ⇒ 掷不中就 `return null`，根本走不到那一条 ✗
  // ## 所以盯两件事
  //   ① 顺序：剧情例外必须**排在掷骰之前**（这次的 bug 就是顺序错）；
  //   ② 行为：真塞一条在跑的剧情，同类没 @ 没引用也必须**直接接**。
  const quest19 = await import('../src/quest.js');
  const { Bot } = await import('../src/bot.js');
  const G19 = '999000019';
  const PEER19 = '10000019';
  config.groupParams[G19] = { peers: [PEER19] };
  // ⚠️ `shouldJoinChat()` 头上有几道"这个群收不收主动接话"的闸（灵敏度档位 / 群白名单）——
  //    测试里先把它们摆成**放行**，否则测到的是那几道闸、不是我们关心的这一条。
  config.trigger = {
    ...(config.trigger ?? {}),
    respondTo: 1,
    groupRespondTo: { ...(config.trigger?.groupRespondTo ?? {}), [G19]: 1 },
    allowGroups: [],
  };
  // ⚠️ 前面的段落把 `chat.enable` 关掉过（那是"群里到底接不接话"的总开关）——
  //    这里要放行，否则 `shouldJoinChat()` 第一道闸就返回 null，测的不是我们关心的东西。
  config.chat = { ...(config.chat ?? {}), enable: true };
  const b19 = new Bot();

  const src19 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const iQuest19 = src19.indexOf('剧情进行中 → 同类的话');
  const iRoll19 = src19.indexOf('Math.random() < chance');
  check(
    iQuest19 > 0 && iRoll19 > 0 && iQuest19 < iRoll19,
    '★★ 剧情例外**排在掷骰之前**（顺序错的话它跟没写一样）',
  );
  check(
    /inQuest0 && !talkingToSomeone/.test(src19),
    '★ 判据 = 这个群在跑剧情 + 它没 @ 谁也没引用谁',
  );

  const evt19 = () => ({
    post_type: 'message',
    message_type: 'group',
    group_id: G19,
    user_id: PEER19,
    self_id: String(config.botQQ ?? ''),
    sender: { card: '', nickname: '' },
    message: [
      { type: 'text', data: { text: '她把手搭在门把上，没回头，说这扇门认的不是敲没敲过。' } },
    ],
  });

  // ⚠️ `__set` 只改**内存**、不落盘（`begin` 会写盘 —— other-bots 这个套件
  //    直接 `node test/other-bots.js` 跑时**没有隔离 env**，绝不能写真实剧情）
  quest19.__set({
    byGroup: {
      [G19]: {
        current: {
          id: 'q-19',
          groupId: G19,
          startedAt: Date.now(),
          premise: '门锁死了，门板上写着出去的条件',
          plannedStages: 3,
          stageIndex: 1,
          endedAt: 0,
          stages: [{ i: 1, at: Date.now(), text: '门板上写着条件。' }],
          herMsgIds: [],
          pending: [],
          cast: [],
          humanReplies: 0,
          autoContinues: 0,
        },
        recent: [],
        starts: [],
      },
    },
  });
  check(!!quest19.current(G19), '★ 测试用的剧情已经"在跑"了（塞进内存，不写盘）');
  // ⚠️ 卡点在 `shouldJoinChat()`（同步）——**不是** `decide()`：
  //    真实日志是 `[同类] 它在自言自语 → 掷骰没过 → 不接` 紧接着
  //    `[主动接话] 判定返回：null（不接）`，也就是说这条消息**根本没进 handle**，
  //    所以修在 `shouldJoinChat` 里、断言也必须打在它上面。
  const d19 = b19.shouldJoinChat(evt19());
  check(
    !!d19 && d19.mode === 'chat',
    '★★ 剧情里同类没 @ 没引用 ⇒ **直接接**（不再被 0.6 的骰子拦掉）',
    JSON.stringify(d19),
  );
  check(
    d19?.needJudge === true,
    '★ 仍然带 needJudge（由 `shouldJoinChatAsync` 里那条"剧情里同类直接放行"的旁路兜住）',
  );

  // ③ ⚠️⚠️ **让位方**：自己没开线（序位公式让它根本不 begin），只在群里看到同类在演 ——
  //    用户报的第二半就是「**爱音这次又不回了**」：所有拿 `quest.current()` 当判据的
  //    "剧情例外"在它那边全部失效 ⇒ 一边接话、另一边一声不吭 ✗
  quest19.__set({ byGroup: {} });
  check(!quest19.current(G19), '★ 先确认：我自己这条线是**空的**（让位方的状态）');
  quest19.notePeerPlot(G19, {
    uid: PEER19,
    text: '她把手搭在门把上，没回头，说这扇门认的不是敲没敲过。',
  });
  check(
    b19.questLive(G19),
    '★★ 自己没开线、但"看见同类在演" ⇒ `questLive` 仍然算**剧情进行中**',
  );
  const d19b = b19.shouldJoinChat(evt19());
  check(
    !!d19b && d19b.mode === 'chat',
    '★★ 让位方照样**直接接**（不再出现"一边接、另一边哑"）',
    JSON.stringify(d19b),
  );
  const src19b = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    (src19b.match(/this\.questLive\(/g) ?? []).length >= 6,
    '★★ 那些"剧情里别拦"的判据**统一走 `questLive`**（两边的口径必须一样）',
    `用了 ${(src19b.match(/this\.questLive\(/g) ?? []).length} 处`,
  );
  quest19.__set({ byGroup: {} });
  quest19.__peerPlots().delete(G19);
}

console.log('\n【20】★★ 剧情里的同类消息，不许被"吞消息"的闸拦掉（2026-10-07 用户连报三次"没回"）');
{
  // ## 这一套盯的是"消息被静默丢掉"的那几处（每一处都单独造成过"一声不吭"）
  //   ① 防刷屏的**软闭麦**：演剧情时她一次分条发好几条 ⇒ 必然命中"10 秒 6 条"
  //      ⇒ 60 秒内同类的剧情段**一条都不处理**（日志实证 `[防刷屏] … 闭麦 60 秒`）
  //   ② 触发冷却：她两秒前刚回过一句 ⇒ 下一句剧情被"距上次回复不足 N 秒"吞掉
  //   ③ `decide()` 那处放行**必须带正文**，不然会被当成"只 @ 了没打字"
  //   ④ 剧情记录"起步严、续记宽"：第一段之后短句也要算剧情延续
  const quest20 = await import('../src/quest.js');
  const { Bot } = await import('../src/bot.js');
  const G20 = '999000020';
  const PEER20 = '10000020';
  config.groupParams[G20] = { peers: [PEER20] };
  config.flood = {
    ...(config.flood ?? {}),
    enable: true,
    windowMs: 10000,
    count: 6,
    muteMs: 60000,
  };
  const ev20 = (t = '她把手搭在门把上，没回头。') => ({
    post_type: 'message',
    message_type: 'group',
    group_id: G20,
    user_id: PEER20,
    self_id: String(config.botQQ ?? ''),
    sender: { card: '', nickname: '' },
    message: [{ type: 'text', data: { text: t } }],
  });

  // ① 对照：**没有剧情**时，同类连发照样会被防刷屏闭麦（这条闸本身必须还在）
  quest20.__set({ byGroup: {} });
  quest20.__peerPlots().delete(G20);
  const b20 = new Bot();
  let blocked0 = 0;
  for (let i = 0; i < 7; i++) if (b20.checkFlood(ev20())) blocked0++;
  check(
    blocked0 > 0,
    '★ 对照：没有剧情时，同类连发 6 条 ⇒ **照样闭麦**（闸没被拆掉）',
    `blocked=${blocked0}`,
  );

  // ② 剧情进行中 ⇒ 一条都不闭麦
  const b20b = new Bot();
  quest20.__set({
    byGroup: {
      [G20]: {
        current: {
          id: 'q20',
          groupId: G20,
          startedAt: Date.now(),
          premise: '门锁死了',
          plannedStages: 3,
          stageIndex: 1,
          endedAt: 0,
          stages: [{ i: 1, at: Date.now(), text: '门板上写着条件。' }],
          herMsgIds: [],
          pending: [],
          cast: [],
          humanReplies: 0,
          autoContinues: 0,
        },
        recent: [],
        starts: [],
      },
    },
  });
  let blocked1 = 0;
  for (let i = 0; i < 10; i++) if (b20b.checkFlood(ev20())) blocked1++;
  check(
    blocked1 === 0,
    '★★ 剧情进行中：同类连发 10 条也**不闭麦**（"没回"的第四个真凶）',
    `blocked=${blocked1}`,
  );

  const src20 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    /isPeerBot\(String\(event\?\.group_id \?\? ''\), String\(event\?\.user_id \?\? ''\)\) &&\s*this\.questLive/.test(
      src20,
    ),
    '★★ 触发冷却那道闸也放行"剧情里的同类"（不然她刚回过一句就接不上下一句）',
  );
  check(
    /return \{ mode: 'chat', text: msg\.extractText\(msg\.toSegments\(event\.message\)\) \};/.test(src20),
    '★★ decide 的放行**带上了正文**（不带就会被当成"只 @ 了没打字"）',
  );

  // ③ 剧情记录"起步严、续记宽"
  quest20.__set({ byGroup: {} });
  quest20.__peerPlots().delete(G20);
  check(
    quest20.notePeerPlot(G20, { uid: PEER20, text: '嗯。' }) === false,
    '★ 还没起步过 ⇒ 短句不算（别把闲聊当成剧情）',
  );
  check(
    quest20.notePeerPlot(G20, {
      uid: PEER20,
      text: '她把手搭在门把上，没回头，说这扇门认的不是敲没敲过。',
    }) === true,
    '★ 第一条（长句）记上 —— 严格判据仍然管"起步"',
  );
  check(
    quest20.notePeerPlot(G20, { uid: PEER20, text: '嗯。' }) === true,
    '★★ 起步之后**短句也续记**（不然演到一半一条短句就让整条例外链失效）',
  );
  quest20.__peerPlots().delete(G20);
  quest20.__set({ byGroup: {} });
}

console.log('\n【21】★★ `/清除剧情` 只由**主导那条线的号**执行 + 整链端到端（2026-10-07 用户截图）');
{
  // ## 截图里的问题
  //   让位的那个号（自己**没有**这条剧情线）也执行了清除 ⇒ `quest.purge()` 里
  //   `running` 为空、退到"清 `recent` 里最后一条已结束的" ⇒
  //   **把上上一个剧情清了** ✗（用户原话：「另一个没主导剧情的在清剧情的时候
  //   会清掉上上一个剧情」）
  const quest21 = await import('../src/quest.js');
  const { Bot } = await import('../src/bot.js');
  const src21 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    /const cur0 = quest\.current\(gid\);[\s\S]{0,240}?if \(!mineRunning && this\.questLive\(gid\)\)/.test(src21),
    '★★ 正在演的那条**不是我起的头** ⇒ 我不清（判据 = 我没有在跑的线 + 群里在演剧情）',
  );
  check(
    /this\.muteGroup\(gid, 60000, '收到 \/清除剧情（这条不是我起的头）'\)/.test(src21),
    '★ 但**静默照旧**（两个号都停发一分钟 —— 那是他发这条指令的意图）',
  );
  check(
    /if \(!mineRunning && this\.questLive\(gid\)\)[\s\S]{0,500}?const r = quest\.purge\(gid\);/.test(src21),
    '★★ 这个判断排在 `quest.purge()` **之前**（顺序错就等于没写）',
  );

  // ── 整链端到端：`shouldJoinChatAsync()` 对"剧情里的同类消息"必须放行 ──
  //    这一条把前面几处串起来测：提前记剧情 + 掷骰例外 + 剧情直接放行。
  const G21 = '999000021';
  const PEER21 = '10000021';
  config.groupParams[G21] = { peers: [PEER21] };
  config.peerChat = {
    ...(config.peerChat ?? {}),
    peerQuietMs: 30,
    peerQuietQuestMs: 30,
    peerQuietMaxMs: 300,
    peerReplyCooldownMs: 0,
    peerMinWaitMs: 0,
  };
  const b21 = new Bot();
  quest21.__peerPlots().delete(G21);
  const j21 = await b21.shouldJoinChatAsync({
    post_type: 'message',
    message_type: 'group',
    group_id: G21,
    user_id: PEER21,
    self_id: String(config.botQQ ?? ''),
    sender: { card: '', nickname: '' },
    message: [
      { type: 'text', data: { text: '她把手搭在门把上，没回头，说这扇门认的不是敲没敲过。' } },
    ],
  });
  check(
    !!j21 && j21.mode === 'chat',
    '★★ 整条链（shouldJoinChatAsync）放行"剧情里的同类消息"',
    JSON.stringify(j21),
  );
  check(
    b21.questLive(G21),
    '★★ 而且这一步就**提前记下了**"看见同类在演剧情"（让位方全靠它才知道在演剧情）',
  );
  quest21.__peerPlots().delete(G21);
}

console.log('\n【22】★★ 开场**轮流**（2026-10-07 用户问「为什么这几次都是 saki 开的」）');
{
  // ## 为什么之前总是同一个人开
  //   `quest.orderFor()` 按 QQ 号升序排，是**固定**的 ⇒ 号小的那位永远排第一、
  //   立即开场，另一位每次都让位 —— 不是巧合，是公式把它内定了。
  // ## 现在
  //   上一次是谁起的头，这一次就轮到另一个人：
  //     · 我这一侧 = `quest.lastOwnStartAt()`（`recent` 里只有**我开过的**线）
  //     · 对面那一侧 = `peerPlots.firstAt`
  //     · 谁更晚 ⇒ 谁上次开的 ⇒ 这次它排到最后
  //   ⚠️ 两个进程各自比一次，结论必然一致；都没记录 ⇒ 按号序（行为不变）。
  const quest22 = await import('../src/quest.js');
  const { Bot } = await import('../src/bot.js');
  const G22 = '999000022';
  const meNum22 = String(config.botQQ ?? '999000099');
  // ⚠️ 必须是一个**一定排在我后面**的号（字符串升序）—— 写死 '999000023' 会比我小，
  //    那"我排第 2"本来就要等，断言会看不出轮换的效果。
  const BIG22 = /^\d+$/.test(meNum22) ? String(BigInt(meNum22) + 1n) : '99999999';
  config.botQQ = config.botQQ || '999000099';
  config.groupParams[G22] = { peers: [BIG22] };
  config.quest = { ...(config.quest ?? {}), openStepMs: 150, openWaitMs: 700 };
  const b22 = new Bot();

  quest22.__set({ byGroup: {} });
  quest22.__peerPlots().delete(G22);
  check(quest22.lastOwnStartAt(G22) === 0, '★ 没开过 ⇒ `lastOwnStartAt` = 0');
  let t22 = Date.now();
  const y1 = await b22.questTurnYield(G22, { since: Date.now(), where: '自检', rotate: true });
  check(
    y1 === false && Date.now() - t22 < 200,
    '★★ 第一次（都没记录）：按号序**我直接开**（行为不变）',
    `${Date.now() - t22}ms`,
  );

  // 上次是我开的 ⇒ 这次我排到最后，先让对面
  // ⚠️⚠️ 判据是**共享文件里的 `by`**（两个进程读同一份 ⇒ 结论必然一致）。
  //    以前用「我 starts 的时间 vs 我看到同类剧情首条的时间」——
  //    两边**都**认为自己才是上次的开场者 ⇒ 各自第 3 位 ⇒ 都在等、群里没反应 ✗
  //    （用户 05:12 实测：「**这次完全没反应了**」）
  quest22.__set({ byGroup: {} });
  check(
    quest22.noteSharedPremise(G22, { premise: '上一条的起因', by: meNum22 }) === true,
    '★ 上一条线的开场者记在共享文件里（`by`）',
  );
  check(quest22.sharedOpener(G22) === meNum22, '★★ 读得回来 —— **两个进程读到的是同一份** ⇒ 不会各算各的');
  t22 = Date.now();
  const y2 = await b22.questTurnYield(G22, { since: Date.now(), where: '自检', rotate: true });
  const waited22 = Date.now() - t22;
  check(y2 === false, '★ 对面一直没开 ⇒ 到点**我还是上**（不哑火）');
  check(waited22 >= 500, `★★ 但**先让了对面一轮**才上（等了 ${waited22}ms，不是立刻开）`);

  // 上次是**对面**开的 ⇒ 这次我优先
  quest22.noteSharedPremise(G22, { premise: '上一条的起因', by: BIG22 });
  quest22.__peerPlots().delete(G22);
  t22 = Date.now();
  const y4 = await b22.questTurnYield(G22, { since: Date.now(), where: '自检', rotate: true });
  check(
    y4 === false && Date.now() - t22 < 200,
    '★★ 上次是**对面**开的 ⇒ 这次**轮到我直接开**（真的在轮流）',
    `${Date.now() - t22}ms`,
  );
  quest22.clearSharedPremise(G22);

  const src22 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(/where: '开场', rotate: true/.test(src22), '★★ 开场那一路传了 `rotate: true`');
  check(
    /const lastOpener = quest\.sharedOpener\(gid\);/.test(src22),
    '★★★ 轮换判据用**共享文件里的 `by`**（不是各自比时间 —— 那版让两边都以为"上次是我"）',
  );
  check(
    !/where: '推进', rotate/.test(src22),
    '★★ 推进**不轮换**（同一个人把一条线演连贯，只按号序让位）',
  );
  // ⚠️⚠️ 用户实测踩到的（「**怎么不接剧情命令了**」）：
  //    v1 的轮换是"把上次那位排到**最后**" ⇒ 另一位仍然是第 2 位（也要等观察窗口）
  //    ⇒ **两人都在等、谁都不先开口**，群里看起来就是"指令没反应"✗
  //    ⇒ 必须是**整体重排**：把上次那位挪到末尾、其余整体前移 ⇒ 必然有人排第 1 ✓
  check(
    /ord = \[\.\.\.order\.filter\(\(x\) => x !== lastOpener\), lastOpener\]/.test(src22),
    '★★★ 轮换是**整体重排**（保证永远有一个人排第 1、立即开场）',
  );
  check(
    !/myIdx = iOpenedLast \? order\.length/.test(src22),
    '★★★ 旧写法（"排到最后"）已经删掉 —— 那版会让两个号都在等，剧情指令看起来没反应',
  );
  quest22.__peerPlots().delete(G22);
  quest22.__set({ byGroup: {} });
}

console.log('\n【23】★★ 剧情起因进**聊天提示词**、并且**两个进程共享**（2026-10-07 用户报「不听写的字」）');
{
  // ## 用户报的现场
  //   「/剧情 …其实这一切都是爱音干的，但是现在爱音要保守这个秘密。
  //     我刚才都这么写了，**她们两个还是不听写的字，连爱音自己都在找出口**」
  // ## 两个机制原因
  //   ① 起因原来**只进"生成剧情段"那条路** ⇒ 她们平时**接话**走的是聊天提示词，
  //      那里**从来没有注入过剧情** ⇒ 不知道在演什么、规矩是什么；
  //   ② 让位的那个号**自己根本没有这条线的状态**（序位公式让它没 begin）
  //      ⇒ 它连起因都拿不到（"连爱音自己都在找出口"就是这个）。
  //   ⇒ 所以起因要放一份**两个进程共享**的，聊天提示词据此注入。
  const quest23 = await import('../src/quest.js');
  const G23 = '999000030';
  const PREM23 = '门板上写着必须做到 X 才出得去；其实这一切都是爱音干的，她要保守这个秘密。';

  check(quest23.sharedPremise(G23) === '', '★ 没演剧情时是空串（日常聊天一个字都不加）');
  check(quest23.chatBrief(G23) === '', '★ 没演剧情时聊天简报也是空的');
  check(
    quest23.noteSharedPremise(G23, { premise: PREM23, by: '999000099' }) === true,
    '★★ 起因写得进共享那份（`begin` 时写）',
  );
  check(quest23.sharedPremise(G23) === PREM23, '★★ 另一个进程读得到（这就是让位方能拿到设定的通道）');
  const brief23 = quest23.chatBrief(G23);
  check(brief23.includes('硬设定'), '★★ 聊天简报里点明"这是硬设定，不是背景资料"');
  check(/你就是那个人/.test(brief23) && /岔开/.test(brief23), '★★ 秘密那条：当事人要守着（会慌、会岔开）');
  check(/你不是那个人/.test(brief23), '★★ 而且**不是当事人的那个号就当自己不知道**（不然 saki 会当场说破）');
  check(/不许绕开它另找出口/.test(brief23), '★★ 规则那条：不许绕开它另找出口');
  check(quest23.clearSharedPremise(G23) === true, '★ 清得掉（剧情结束 / 被清除时要用）');
  check(quest23.sharedPremise(G23) === '', '★ 清掉之后不再注入');

  const src23 = readFileSync(join(ROOT, 'src', 'quest.js'), 'utf8');
  const bsrc23 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    /noteSharedPremise\(quest\.groupId/.test(src23),
    '★★ `begin` 里真的写了共享起因',
  );
  check(
    /clearSharedPremise\(quest\.groupId\)/.test(src23) && /clearSharedPremise\(k\)/.test(src23),
    '★★ `finish` / `purge` 里都撤掉了（不然收尾、清剧情之后还一直挂着）',
  );
  check(
    /quest\.chatBrief\(gid0, \{/.test(bsrc23),
    '★★ 聊天提示词（`buildSystemPrompt`）真的注入了剧情简报（并带上"刚说过的几句"）',
  );
  check(/6c-4\./.test(src23), '★ 剧情提示词里有 6c-4（真相 / 秘密必须演出来）');
  check(
    /开场不许急着找出口/.test(src23),
    '★★ 开场那一段单独强化过：**开场不许急着找出口**（用户看到的就是开头就去找风）',
  );

  // ── 用户第二/第三次追问：「剧情开始词要不要重新再加固一下」→
  //    「**我是说 /剧情 后面写的句子**」────────────────────────────────
  //    他写的那段话**通常不止一件事**（场景 + 规矩 + 真相），实测模型只落实了一件半。
  check(/6c-5\./.test(src23), '★★ 剧情提示词里有 6c-5：起因那句话要**逐条照顾**，一条都不许漏');
  // ⚠️ 2026-10-07 加（用户：「**重点是聊天不要死磕一个点，要有进展变化**」）：
  //    光在提示词里写"要有新东西"压不住 ⇒ 把"你们刚说过的几句"直接摆到它面前。
  const recentSrc23 = readFileSync(join(ROOT, 'src', 'recent.js'), 'utf8');
  check(
    /export function lastBotLines\(groupId, \{ n = 6, uids = \[\] \} = \{\}\)/.test(recentSrc23),
    '★★★ 新增 `recent.lastBotLines()`：取最近几条"她 + 对方"说过的话',
  );
  check(
    /你们刚刚已经说过这几句了/.test(src23),
    '★★★ 聊天提示词里把它们列出来 + 明说"别再重复同样的意思"',
  );
  check(
    /recentLines: recent\.lastBotLines\(gid0, \{/.test(bsrc23),
    '★★ 而且真的接进去了（不是写了没用）',
  );

  // ⚠️ 2026-10-07 加（用户截图：群里冒出一条**单独的引号**、还有一条「"。」）：
  //    模型写成 `"。 （回头看她）"祥祥…` 这种引号错位的句子，按句末标点切完，
  //    引号自己就成了一句 ⇒ 单独发一条 ✗（用户：「越来越混乱了」）
  const { splitChatText } = await import('../src/bot.js');
  const junkCases = [
    ['"。 （回头看她）"祥祥，你背得那么熟，你教教我呀', '开头的引号碎片'],
    ['她说行。 "。 然后她又问了一遍', '中间的碎片'],
  ];
  for (const [src, label] of junkCases) {
    const parts = splitChatText(src, { max: 40 });
    check(
      parts.length > 0 && parts.every((p) => /[\p{L}\p{N}]/u.test(p)),
      `★★ 纯标点/引号碎片不许单独成条：${label}`,
      JSON.stringify(parts),
    );
  }
  check(
    splitChatText('"', { max: 40 }).length === 0,
    '★★ 整条只有引号 ⇒ **不发**（宁可少一条，也别发一条只有引号的消息）',
  );
  // ⚠️ 2026-10-07 加（用户截图：开场被切成 6 条，问「分句不是一直都是最多三段吗」）：
  //    主聊天一直有 maxSentenceChunks（默认 3），而剧情/事件这条主动路从来没设过上限 ✗
  const longText = '第一句话。第二句话。第三句话。第四句话。第五句话。第六句话。第七句话。';
  check(
    splitChatText(longText, { max: 8 }).length > 3,
    '★ 不传上限时照旧（主动类保持原样）',
  );
  check(
    splitChatText(longText, { max: 8, maxChunks: 3 }).length === 3,
    '★★★ 传了 `maxChunks` 就**最多 3 条**（超出的并进最后一条）',
  );
  const bsrc23b = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    (bsrc23b.match(/sendChatLike\(gid, r\.text, \{ maxChunks: 3 \}\)/g) ?? []).length === 3,
    '★★ 剧情三条路（开场 / 手动推进 / 自动推进）**都传了** `maxChunks: 3`',
  );
  check(
    /先在心里把它拆成几条/.test(src23),
    '★★ 开场那边明确要求：**先把他那段话拆成几条，再逐条落实**',
  );
  check(/不许改设定/.test(src23), '★★ 而且**不许改设定**（换个说法就是改题）');

  // ── 代码兜底：开场拐去"找出口" ⇒ 重写一次 ──────────────────
  const HINT23 = '爱音和祥子被关在没有窗户的房间里，门板上写着必须做到亲密才能出去，其实这一切都是爱音干的';
  check(
    quest23.looksLikeDodgingOpening(
      JSON.stringify({ text: '她敲了四面墙，又趴下看门缝的风，说外面是通的。' }),
      HINT23,
    ) === true,
    '★★ 兜底认得出来："敲墙 / 门缝的风" 就是跑偏',
  );
  check(
    quest23.looksLikeDodgingOpening(
      JSON.stringify({ text: '她把门板上那行字念了一遍，然后发现爱音一句话都没说。' }),
      HINT23,
    ) === false,
    '★ 正常开场不误伤',
  );
  check(
    quest23.looksLikeDodgingOpening(
      JSON.stringify({ text: '她敲了四面墙。' }),
      '今天天气不错',
    ) === false,
    '★ 起因里没有硬条件时**不管**（免得误伤"本来就在找东西"的剧情）',
  );

  const G23b = '999000031';
  config.groupParams[G23b] = { peers: ['10000023'] };
  let calls23 = 0;
  const fakeAsk23 = async () => {
    calls23++;
    return calls23 === 1
      ? JSON.stringify({
          premise: HINT23,
          event: 'e',
          text: '她敲了四面墙，又趴下看门缝的风，说外面是通的。',
        })
      : JSON.stringify({
          premise: HINT23,
          event: 'e',
          text: '她把门板上那行字念了一遍，然后发现爱音一句话都没说。',
        });
  };
  const r23 = await quest23.begin({
    ask: fakeAsk23,
    extraHint: HINT23,
    groupId: G23b,
    manual: true,
  });
  check(calls23 === 2, `★★ 开场跑偏 ⇒ **真的让它重写了一次**（ask 调了 ${calls23} 次）`);
  check(
    r23?.ok === true && !/门缝/.test(String(r23.text ?? '')),
    '★★ 用的是**重写后**那一版（跑偏那版被丢掉了）',
    String(r23?.text ?? '').slice(0, 24),
  );
  quest23.clearSharedPremise(G23b);
  quest23.__set({ byGroup: {} });

  // ④ ⚠️⚠️ 用户报：「**清除剧情之后她们还在说推柜子出房间**」——
  //    静默只有 60 秒，过了之后**上下文里那几句台词还在**（各进程各存一份 recent）
  //    ⇒ 她们顺着上文接着演 ✗ 所以清完还要有一个"这条剧情作废"的窗口。
  const G23c = '999000032';
  config.groupParams[G23c] = { peers: ['10000023'] };
  const b23 = new Bot();
  b23.speakerRole = () => 'owner';
  const wiped = b23.tryQuestReset(
    {
      message_type: 'group',
      group_id: G23c,
      user_id: '10000001',
      sender: { card: '', nickname: '' },
      message: [{ type: 'text', data: { text: '/清除剧情' } }],
    },
    [{ type: 'text', data: { text: '/清除剧情' } }],
  );
  check(wiped === true, '★ `/清除剧情` 被认出来了');
  check(
    (b23.questWipedUntil?.get(G23c) ?? 0) > Date.now(),
    '★★ 记下了**作废窗口**（不然 60 秒静默一过，她们又顺着上文演）',
  );
  check(
    /刚才那条剧情已经被管理员清掉了（作废）/.test(bsrc23),
    '★★ 聊天提示词里明说"那条剧情作废了、别提那个房间/门/柜子"',
  );
  check(
    /别主动提那个房间 \/ 门 \/ 柜子/.test(bsrc23),
    '★★ 而且点名了"柜子出房间"这类接法（用户看到的就是这个）',
  );
}

console.log('\n【24】★★ 清剧情要**连残留一起清** + 硬条件剧情**不许提前收尾**（2026-10-07 用户报）');
{
  // ## 用户报的两件事
  //   ① 「清除剧情之后她们还在说推柜子出房间」「甚至还记住了之前柜子烂了，现在变成板子了」
  //      ⇒ 查过了：`state/recent.json` 里带"柜子"的 **31 条**、
  //        `state/storyline.json` 里还有几条**没有 questId** 的条目 ⇒ `/清除剧情` 一条没碰 ✗
  //   ② 「现在我只想先把房子的规则真正落实」
  //      ⇒ 真实模型跑出来：**第 2 段就 done 了**，门板上那件事一个字没演就收场 ✗
  const recent24 = await import('../src/recent.js');
  const story24 = await import('../src/storyline.js');
  const quest24 = await import('../src/quest.js');
  const src24 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const qsrc24 = readFileSync(join(ROOT, 'src', 'quest.js'), 'utf8');

  // ① 上下文：只抹窗口内、指定号说的
  const G24 = '999000024';
  const store = recent24.__storeForTest();
  store.set(G24, [
    { time: 1000, userId: '10000024', text: '窗口前的' },
    { time: 2000, userId: '10000024', text: '要抹掉的' },
    { time: 2500, userId: '30003', text: '真人说的（留着）' },
    { time: 9000, userId: '10000024', text: '窗口后的' },
  ]);
  const dropped24 = recent24.dropWindow(G24, { from: 1500, to: 3000, uids: ['10000024'] });
  check(dropped24 === 1, `★★ 只抹窗口内、而且只抹那个号说的（抹了 ${dropped24} 条）`);
  const left24 = store.get(G24) ?? [];
  check(
    left24.length === 3 && left24.some((m) => m.text === '真人说的（留着）'),
    '★★ 真人发言**一条都不动**（不能把群友的聊天也抹了）',
  );
  store.delete(G24);

  // ② 故事线：按时间窗口删（那条"Anon说：…柜子…"就是没 questId 的那种）
  story24.note({ tier: 1, imp: 3, text: '剧情期间的（要删）', at: 5000, groupId: G24 });
  story24.note({ tier: 1, imp: 3, text: '别的时段（留着）', at: 999999999999 });
  const storyDropped24 = story24.removeWindow(G24, { from: 4000, to: 6000 });
  check(storyDropped24 === 1, `★★ 故事线按**时间窗口**删（删了 ${storyDropped24} 条）—— 没有 questId 的那几条也跑不掉`);
  check(
    (story24.recent(20, G24) ?? []).every((e) => !String(e.text).includes('剧情期间的')),
    '★ 而且真的删掉了',
  );
  story24.__clear(G24);

  // ③ 清剧情时**顺手**清这两处
  check(
    /recent\.dropWindow\(gid, \{ from, to, uids \}\)/.test(src24),
    '★★★ `/清除剧情` 顺手抹掉上下文里那段台词（不用用户额外操作）',
  );
  check(
    /storyline\.removeWindow\(gid, \{ from, to \}\)/.test(src24),
    '★★★ 故事线里没有 questId 的那几条也一起清',
  );

  // ④ 硬条件剧情的最低段数
  check(
    /hardCond && done && !forceEnd && !hardStop/.test(qsrc24),
    '★★★ 起因里有"必须做到 X"⇒ **X 还没演到就不许收尾**（实测第 2 段就 done，那个坎根本没演）',
  );
  check(
    /const floor = Math\.max\(3, Math\.min\(4, /.test(qsrc24),
    '★★ 下限 3 段（原来 4 —— 用户每次推到第 3 段就停，"做掉"那段永远到不了 ✗）',
  );

  // ⑤ ⚠️⚠️⚠️ 用户最后那句：「**我也不给你绕弯子了，我就直说了，要有实践**」——
  //    实测（真实模型）证明：**模型完全能写**那件事，之前不写是因为提示词
  //    **从来没直接命令过它**（只写了"不许绕开"，它照样可以每段只挪一点点）。
  check(
    /function hardCondHint\(next, premise, planned\)/.test(qsrc24),
    '★★★ 有硬条件的剧情：**分两档**给指令（前面走"追问 + 细节"，到下限那段才真的发生）',
  );
  check(
    /这一段就是"那件事真的发生"的那一段/.test(qsrc24),
    '★★★ 最后那一段明说"就是那件事发生的那一段"',
  );
  check(
    /hardCondHint\(next, quest\.premise, quest\.plannedStages\)/.test(qsrc24),
    '★★ 真的接进了 `advance` 的提示词（不是写了没人调）',
  );
  check(
    /必须落在「祥子追问、爱音守不住」这条线上/.test(qsrc24),
    '★★★ 前面几段**要的是过程**（用户纠正过：不要一步到位，要有追问爱音的过程）',
  );
  check(
    /不许用"她犹豫了一下""气氛暧昧起来"这种\*\*模糊话\*\*带过/.test(qsrc24),
    '★★ 而且点名禁止模糊话（用户原话：「太模糊了」）',
  );
  check(
    /唯一不许碰的只有「违禁词」/.test(qsrc24),
    '★ 授权写清楚了：细节、身体反应、气氛都可以写，只有违禁词不许碰',
  );
  // ⑥ ⚠️⚠️⚠️ 实测（真实模型、完整路径）第 3 段写的是：
  //    `我走过去把她按在墙上，跟她说，我知道是你。她没躲。然后门就开了。`
  //    —— 提示词明令禁止这个句式，它照样写 ⇒ 只有代码兜得住。
  check(
    /function needsRewriteDeed\(j, premise, next\)/.test(qsrc24),
    '★★★ 有代码兜底：**结果句出现、正文却什么都没发生** ⇒ 重写一次',
  );
  check(
    /needsRewriteDeed\(j0, quest\.premise, next\)/.test(qsrc24),
    '★★ 真的接进了 `advance`（不是写了没人调）',
  );
  check(/REWRITE_DEED_HINT/.test(qsrc24), '★ 重写时明确告诉它"门不是自己开的"');
  if (typeof quest24.needsRewriteDeed === 'function') {
    const HINT26 = '门板上写着必须做到亲密才能出去';
    check(
      quest24.needsRewriteDeed({ text: '她没躲。然后门就开了。' }, HINT26, 3) === true,
      '★★ 命中：门开了、可正文里什么都没发生',
    );
    check(
      quest24.needsRewriteDeed({ text: '她吻了她，两个人贴在一起，门开了。' }, HINT26, 3) === false,
      '★ 有实质内容就放行（不误伤）',
    );
    check(
      quest24.needsRewriteDeed({ text: '她没躲。然后门就开了。' }, HINT26, 2) === false,
      '★ 铺垫段（第 2 段）不管 —— 第 3 段起才要求"做掉"',
    );
    check(
      quest24.needsRewriteDeed({ text: '她没躲。然后门就开了。' }, '今天天气不错', 3) === false,
      '★ 起因里没有硬条件时不管（别的剧情不受影响）',
    );
  }
}

console.log('\n【25】★★ 剧情里**不许用"睡觉 / 晚安"收场**（2026-10-07 用户截图）');
{
  // 截图：那条"必须做到 X 才能出去"的线还在演，她俩聊着聊着互相道晚安 ——
  //   「行，眯会儿吧，我这边先不聊了」「那我先眯了，晚安」⇒ 剧情烂尾 ✗
  //   用户原话：「**睡着在其他地方都可以，在剧情里睡着肯定不行**」
  const { Bot } = await import('../src/bot.js');
  const b25 = new Bot();
  check(
    b25.isSleepEndInQuest('行，眯会儿吧，我这边先不聊了') === true,
    '★★ 截图上那句要拦',
  );
  check(b25.isSleepEndInQuest('那我先眯了，晚安') === true, '★★ 道晚安也要拦');
  check(b25.isSleepEndInQuest('我先睡了') === true, '★ "睡了"也算');
  check(b25.isSleepEndInQuest('早') === false, '★ 短的问候不误拦');
  check(
    b25.isSleepEndInQuest(
      '她闭上眼睛没说话，手指还扣在门缝边上，一点一点往里探过去，像是不甘心似的又停下来',
    ) === false,
    '★★ **长的剧情叙述不误拦**（超过 30 字就不看关键词了）',
  );
  const src25 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const qsrc25 = readFileSync(join(ROOT, 'src', 'quest.js'), 'utf8');
  check(
    /this\.questLive\(groupId\) && this\.isSleepEndInQuest\(text\)/.test(src25),
    '★★★ 兜底接在 `sendChatLike`（她所有发言的**唯一出口**，拦一处就够）',
  );
  check(
    /等于把这条剧情丢掉/.test(qsrc25),
    '★★ 聊天提示词里也明说了（剧情里不许睡觉收场）',
  );
}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
