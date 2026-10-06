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
    // ⚠️ 窗口放宽到 1400：那一段后来又加了"记下同类正在说话"（打字延迟用）几行
    iPeerBlock11 > 0 && iFarewell11 > iPeerBlock11 && iFarewell11 - iPeerBlock11 < 1400,
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
    /!quest\.current\(gid0\) && !peerAtMe && this\.isFarewellLine\(peerText0\)/.test(src15),
    '★★ "纯告辞不接"那条闸在剧情里**不生效**（`/剧情` 的回执就栽在这儿）',
  );
  check(
    /!quest\.current\(gid0\) &&[\s\S]{0,80}?this\.farewellPingPong\(gid0\)/.test(src15),
    '★★ 收尾拉锯那条闸同样有剧情例外（剧情里道别是戏的一部分）',
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
    /async shouldJoinChatAsync\(event, opts = \{\}\) \{[\s\S]{0,1200}?await this\.waitPeerQuiet/.test(src16),
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

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
