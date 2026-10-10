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
    // ⚠️ 2026-10-09：窗口从 1600 放宽到 3200 —— `sendText()` 开头新加了"旁白闸"
    //    （那段注释 + 判定约 1200 字符）⇒ 原来那个距离窗口不够，误报"没接线" ✗
    // ⚠️ 2026-10-10：窗口 3200 → 8000 —— `sendText` 开头又长了两段（旁白剥离），
    //    3200 字装不下、断言就"假失败"了。这条要钉的是**接线在不在**，不是距离 ✓
    /sendText\(event, text[\s\S]{0,8000}?splitAtMentions\(event/.test(bsrc10),
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
    /if \(peers0\.has\(sender0\) && \(cooling \|\| farewellCooling\) && !this\.questLive\(gid0\)\)/.test(
      src15,
    ),
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
    // ⚠️ 2026-10-10：窗口 2200 → 6000 —— 函数开头又插了一段（「不回复的机器人」闸 +
    //    那段说明注释），2200 字装不下了。这条钉的是**接线在不在**，不是距离 ✓
    /async shouldJoinChatAsync\(event, opts = \{\}\) \{[\s\S]{0,6000}?await this\.waitPeerQuiet/.test(src16),
    '★★ 接在同类消息处理的**最前面**（连"要不要接"都还没判就先等）',
  );
  check(
    /async shouldJoinChatAsync\(event, opts = \{\}\) \{[\s\S]{0,1200}?this\.isIgnoredBotEvent\(event\)/.test(src16),
    '★★★ 「不回复的机器人」（`otherBots`）的闸也提到这条路上 —— ' +
      '主动接话原来**绕过**它 ⇒ 两个号会一起回黑祥（用户报的"都回相同几条"就是这个）✗',
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
    /if \(await this\.questTurnYield\(gid, \{ since, where: '开场', rotate: true \}\)\)[\s\S]{0,2600}?const r = await quest\.begin/.test(
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
  //
  //    ⚠️⚠️ 2026-10-07 再改（用户：「**机器人之间的日常聊天还是不会自己停下来**」）：
  //    判据从"看见同类发了一句像剧情的话"（`peerPlots`）换成**共享起因**
  //    （`state/quest-shared.json`）—— 后者是"**真开了一场剧情**"才会写的东西，
  //    日常闲聊不会写 ✓（原来那个判据太松，把闲聊也当剧情 ⇒ 所有闸全被豁免）
  //    ⇒ 所以这里要先**写上共享起因**（就是对面那个号 `begin` 时写的那一下）。
  quest19.__set({ byGroup: {} });
  check(!quest19.current(G19), '★ 先确认：我自己这条线是**空的**（让位方的状态）');
  quest19.notePeerPlot(G19, {
    uid: PEER19,
    text: '她把手搭在门把上，没回头，说这扇门认的不是敲没敲过。',
  });
  // ⚠️⚠️ 新加的反向断言：**只记了 peerPlot、没有共享起因 ⇒ 不算"剧情中"** ——
  //    这正是这次修的东西（日常闲聊就是这种状态，不能再被当成剧情豁免）
  check(
    b19.questLive(G19) === false,
    '★★★ 只有"看见同类发了句长话"（没有共享起因）⇒ **不算剧情中**（日常闲聊就是这种，闸门要靠这个拦住）',
  );
  quest19.noteSharedPremise(G19, {
    premise: '门锁死了，两个人之间必须做到 X 才能出去',
    by: PEER19,
  });
  check(
    b19.questLive(G19),
    '★★ 自己没开线、但对面**真开了剧情**（共享起因在）⇒ `questLive` 仍然算**剧情进行中**',
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
  quest19.clearSharedPremise(G19);
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
  // ⚠️ 2026-10-07：`questLive` 现在认的是**共享起因**（真开了一场剧情才会写它），
  //    所以这里先写一条 —— 就是对面那个号 `begin` 时写的那一下。
  quest21.noteSharedPremise(G21, { premise: '门锁死了，必须做到 X 才能出去', by: PEER21 });
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
    !!quest21.__peerPlots().get(G21)?.lastAt,
    '★★ 而且这一步**照样提前记下 peerPlot** —— `leadership()` 和序位让位全靠它，别删',
  );
  quest21.__peerPlots().delete(G21);
  quest21.clearSharedPremise(G21);
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
    /quest\.chatBrief\(\w+, \{/.test(bsrc23),
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
    /recentLines: recent\.lastBotLines\(\w+, \{/.test(bsrc23),
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

console.log('\n【26】★★ 剧情**永远不往硬条件上走**的两个真凶（2026-10-07 用户：「查一下为什么」）');
{
  // ## 用户的问题
  //   「查一下为什么现在剧情永远不会跟着那扇门写的走」
  //
  // ## 查出来的两条，都有日志铁证（`logs/bot-2026-10-07.log`）
  //
  // ① **定时自动推进那条路原来是裸的 `streamChat`**（没关思考、没抬 max_tokens）
  //      `[06:24:23] WRN LLM 输出被 max_tokens(8000) 截断了（其中思考链吃了 8000 token）`
  //      `[06:24:23] INF [剧情] 群 200000001 到点了但这次没推进：模型没给出内容，保持原状`
  //    ⇒ 起因里的硬条件越硬，模型**思考得越久** ⇒ 8000 全被思考链吃光、**正文一个字没有**
  //      ⇒ `advance()` 只能"保持原状" ⇒ **卡在同一段**，每 30 分钟原地重演
  //      ⇒ 用户看到的"永远不走"其实是**整条线停摆**，不是绕开
  //
  // ② **对面那个号的"拒演"被当成群友建议，喂回给了主导方**
  //      `[02:21:32] [剧情] 记下一条可能改变走向的发言（suggest）：说了不接这类剧情，换个正常的来。`
  //      `[02:50:06] …（suggest）：不接，消停会儿吧，换个正常的剧情我还愿意陪你玩。`
  //    ⇒ 这两句进了 `quest.pending`，下一段以【这一阶段群里说的话】喂回主导方
  //      ⇒ **自己人给自己下了一道禁令** ✗
  const quest26 = await import('../src/quest.js');
  const { Bot } = await import('../src/bot.js');
  const src26 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const isrc26 = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8');

  // ── 真凶① ──────────────────────────────────
  check(
    /const ask = async \(messages\) => \{[\s\S]{0,400}?maxTokens: 16000[\s\S]{0,200}?thinking: \{ type: 'disabled' \}/.test(
      isrc26,
    ),
    '★★★ 定时推进的 `ask` 必须和 `questAsk()` 对齐（16000 token + **关思考**）—— 不关思考就会"思考链吃满 max_tokens、正文 0 字、剧情原地不动"',
  );
  check(
    !/for await \(const d of streamChat\(messages\)\) out \+= d;/.test(isrc26),
    '★★★ 裸 `streamChat(messages)` 不许再出现在剧情推进那条路上',
  );

  // ── 真凶②（静态） ───────────────────────────
  check(/const PEER_META_RE =/.test(src26), '★★★ 有"同类在说这部剧本身"的判据');
  check(
    /if \(fromPeer && PEER_META_RE\.test\(String\(text \?\? ''\)\)\)/.test(src26),
    '★★★ 而且真的在 `noteQuestReply` 里先拦一道（在进 `pending` 之前）',
  );

  // ── 真凶②（行为） ───────────────────────────
  const G26 = '999000026';
  const PEER26 = '10000026';
  config.groupParams[G26] = { peers: [PEER26] };
  const mk26 = () => ({
    byGroup: {
      [G26]: {
        current: {
          id: 'q26',
          groupId: G26,
          startedAt: Date.now(),
          premise: '门板上写着：两个人之间必须做到 X，否则它永远不会开。',
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
  const mkev26 = (uid, t) => ({
    post_type: 'message',
    message_type: 'group',
    group_id: G26,
    user_id: uid,
    self_id: String(config.botQQ ?? ''),
    sender: { card: '', nickname: '' },
    message: [{ type: 'text', data: { text: t } }],
  });
  const segs26 = (t) => [{ type: 'text', data: { text: t } }];
  const say26 = (b, t) => b.noteQuestReply(mkev26(PEER26, t), segs26(t), t);

  quest26.__set(mk26());
  const b26 = new Bot();
  say26(b26, '说了不接这类剧情，换个正常的来。');
  check(
    (quest26.current(G26)?.pending ?? []).length === 0,
    '★★★ 对方**拒演**的那句话不许进下一段素材（原来会被当成"群友建议"喂回主导方 ⇒ 自己人劝退自己人）',
    JSON.stringify((quest26.current(G26)?.pending ?? []).map((x) => x.text)),
  );

  // 对照：剧里的正常台词照样要进去（用户要"聊天也能推动剧情"，别一刀切）
  say26(b26, '她说完就靠回墙上，手指在袖口里抠着，没敢看他。');
  check(
    (quest26.current(G26)?.pending ?? []).length === 1,
    '★★ 对照：剧中的台词**照样进**（不能把同类的话一刀切掉）',
    JSON.stringify((quest26.current(G26)?.pending ?? []).map((x) => x.text)),
  );
  quest26.__set({ byGroup: {} });
}

console.log('\n【27】★★ 开新剧情后，开场之前的旧话题要抹掉（2026-10-07 用户：「为什么开了剧情偏到其他对话了」）');
{
  // ## 用户的问题
  //   「为什么我刚才开了剧情，但是偏到其他对话了」
  //
  // ## 实测（`state/quest.json` 的 premise/stages 与 `state/recent.json` 对着看）
  //     07:10:45 [她]   刚坐下没一会儿，谱子才翻到第二页…        ← 上一轮的话头（练琴）
  //     07:11:01 Anon  谁惦记你了。第二页就卡住了啊，你练的哪首   ← 对面还在旧话题上
  //     07:11:05 [她]   早上醒过来的时候，我跟爱音在一间没有窗户的屋子里。← 开场第 1 条
  //     07:11:07 [她]   谁惦记你了。第二页就卡住了啊，你练的哪首   ← 她**又回了一句练琴** ✗
  //     07:11:25 Anon  行，那我等着呗，练顺了弹一段给我听听啊（   ← 从此整条线全在聊琴
  //   ⇒ 那条剧情的 `pending` 里 **11 条全是练琴**，开场 3 条像没发过一样。
  //   ⇒ 原因不是开场写得差（它把三条设定都摆出来了），而是：
  //     开场是**陈述**，而对面在开场前一刻**直接问了她一句** ——
  //     模型天然优先回"有人在问我"⇒ 一句话把两条线都拽回旧话题。
  const recent27 = await import('../src/recent.js');
  const src27 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');

  check(
    /const beforeAt = recent\.lastMessageAt\(gid\);/.test(src27),
    '★★★ 开场发出去**之前**先记下"群里最后一条"的时间（旧话题的上界）',
  );
  check(
    /recent\.dropWindow\(gid, \{\s*from: since - 3 \* 60 \* 1000,\s*to: beforeAt,/.test(src27),
    '★★★ 窗口终点用 `beforeAt` —— 既盖住"生成开场那几秒"里的旧话题，又不会把刚发的开场本身抹掉',
  );
  check(
    /'__self__'/.test(src27),
    '★★ 连她自己的旧话也抹（不然她会顺着自己刚说过的"谱子翻到第二页"往下聊）',
  );

  // 行为：真人发言一条都不许动
  const G27 = '999000027';
  const store27 = recent27.__storeForTest();
  const now27 = 1791328260000;
  store27.set(G27, [
    { time: now27 - 60000, userId: '10000027', text: '上一轮同类的旧话头' },
    { time: now27 - 55000, userId: '__self__', text: '她自己的旧话头' },
    { time: now27 - 1000, userId: '30003', text: '真人说的（必须留着）' },
  ]);
  const n27 = recent27.dropWindow(G27, {
    from: now27 - 3 * 60 * 1000,
    to: now27 - 2000,
    uids: ['10000027', '__self__'],
  });
  const left27 = store27.get(G27) ?? [];
  check(
    n27 === 2 && left27.length === 1 && left27[0].text === '真人说的（必须留着）',
    `★★★ 同类和她自己的旧话头抹掉、**真人发言一条都不动**（抹了 ${n27} 条）`,
    JSON.stringify(left27.map((x) => x.text)),
  );
  store27.delete(G27);
}

console.log('\n【28】★★ `/暂停` 不许被 `/剧情` 顺手解除 + 同一条 `/剧情` 只执行一次（2026-10-07 用户：「为什么对爱音没用」）');
{
  // ## 用户的问题
  //   「我刚才发了暂停指令，为什么对爱音没用」
  //
  // ## 日志实证（`logs/bot-2026-10-07-10000012.log`）
  //   `[07:13:27] 群 200000001：120 秒内一个字都不发（收到 /暂停）`   ← 暂停**生效了** ✓
  //   `[07:13:49] [剧情] 手动开始（群 200000001，…）`                  ← 同一条 `/剧情` 又跑了一次 ✗
  //   `[07:13:49] [静默] 群 200000001 解除静默（开新剧情 → 解除静默）` ← **暂停被它抹掉了** ✗✗
  // ⇒ 那 2 分 49 秒里爱音**没有重连**（不是补看重放），是同一个事件被处理了两遍。
  const src28 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const { Bot } = await import('../src/bot.js');

  check(
    /isPausedByCommand\(groupId\)/.test(src28),
    '★★★ 有"这个群的静默是不是 `/暂停` 按的"这个判据',
  );
  check(
    /const paused = this\.isPausedByCommand\(gid\);/.test(src28),
    '★★★ 而且 `/剧情` 里真的接上了（暂停期间**不解除**静默）',
  );
  check(
    /this\._questCmdSeen \?\?= new Map\(\)/.test(src28),
    '★★★ 同一条 `/剧情`（按 message_id）10 分钟内只执行一次 —— 重复执行正是"暂停被抹掉"的元凶',
  );
  check(
    /'收到 \/暂停'/.test(src28) && /this\._muteWhy\.set\(gid/.test(src28),
    '★★ `muteGroup` 记下了"这次静默是谁下的"（不然分不清 `/暂停` 和 `/清除剧情`）',
  );

  // 行为：两种静默要能分开
  const G28 = '999000028';
  const b28 = new Bot();
  b28.muteGroup(G28, 120000, '收到 /暂停');
  check(b28.isMuted(G28) === true, '★ 按下 /暂停 ⇒ 群进了静默期');
  check(b28.isPausedByCommand(G28) === true, '★★★ 而且认得出"这是 /暂停 按的"（`/剧情` 不许解除它）');

  const b28b = new Bot();
  b28b.muteGroup(G28, 60000, '收到 /清除剧情（清掉了）');
  check(
    b28b.isPausedByCommand(G28) === false,
    '★★ 对照：`/清除剧情` 那 60 秒**不算** `/暂停` ⇒ 开新剧情照旧能解除它（那是有意的）',
  );

  // 行为：解除之后两边都不算
  b28.muteGroup(G28, 0, '开新剧情 → 解除静默');
  check(
    b28.isMuted(G28) === false && b28.isPausedByCommand(G28) === false,
    '★ 静默解除后，两个判据都归零（不会留个"幽灵暂停"把后面的都挡掉）',
  );
}

console.log('\n【29】★★ `/清除剧情` 那一分钟必须真安静：开场能发，发完把静默按回去（2026-10-07 用户：「也失效了」）');
{
  // ## 用户的问题
  //   「`/清除剧情` 指令应该也要屏蔽一分钟 bot 发言，也失效了」
  //
  // ## 日志实证
  //   `[07:09:28] 群 200000001：60 秒内一个字都不发（收到 /清除剧情（清掉了））`
  //   `[07:09:33] 群 200000001 解除静默（开新剧情 → 解除静默）`  ← 只安静了 5 秒 ✗
  //
  // ## 两个真因
  //   ① **解除静默原来在 `questTurnYield` 之前** ⇒ **让位的那一方也解除了**
  //      （它收到的 `/清除剧情` 那 60 秒就这么没了，于是接着聊旧话题）
  //   ② 真正开场的号解除之后**再也没按回去** ⇒ 用户要的"那一分钟安静"根本没发生
  //
  // ## 修法
  //   静默的解除/恢复整体挪进 IIFE、挪到 `questTurnYield` **之后**；
  //   开场发完把**剩余时间**按回去（不是重新算 60 秒）。
  const src29 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const { Bot } = await import('../src/bot.js');

  check(/muteInfo\(groupId\)/.test(src29), '★★★ 有"当前静默到几点 + 谁按的"这个判据');
  check(/const muteBefore = this\.muteInfo\(gid\);/.test(src29), '★★★ `/剧情` 里记下了原静默的到期时刻');
  check(
    /if \(!paused && muteBefore\.until > Date\.now\(\)\)/.test(src29),
    '★★★ 开场发完之后**把剩下的时间按回去**（"清完剧情那一分钟真的安静"）',
  );

  // ⚠️ 顺序才是关键：**解除静默必须在 `questTurnYield` 之后** ——
  //    在它之前的话，让位那一方也会把自己的静默解除掉（①就是这么来的）。
  const atYield = src29.indexOf("where: '开场', rotate: true }))");
  const atMute = src29.indexOf('const paused = this.isPausedByCommand(gid);');
  check(
    atYield > 0 && atMute > 0 && atMute > atYield,
    '★★★ 解除静默排在 `questTurnYield` **之后**（让位方不再把自己的静默解除）',
    `yield@${atYield} mute@${atMute}`,
  );

  // 行为：`muteInfo` 报得出"还剩多久 + 谁按的"
  const G29 = '999000029';
  const b29 = new Bot();
  b29.muteGroup(G29, 60000, '收到 /清除剧情（清掉了）');
  const info29 = b29.muteInfo(G29);
  check(
    info29.until > Date.now() + 50000 && /清除剧情/.test(info29.why),
    '★★★ 报得出到期时刻和原因（`/剧情` 就靠它把静默原样按回去）',
    JSON.stringify(info29),
  );
  b29.muteGroup(G29, 0, '解除');
  check(b29.muteInfo(G29).until === 0, '★ 解除报 0（不会留一道幽灵静默把后面的都挡掉）');
}

console.log('\n【30】★★ 剧情必须有**绝对时长上限**、`questLive` 不许被无限续命（2026-10-07 用户：「一直在无意义聊天还一直不自动结束」）');
{
  // ## 用户的问题
  //   「为什么现在一直在无意义聊天而且还一直没有自动结束」
  //
  // ## 实测
  //   那条 07:22 开的剧情**早就结束了**（`quest.current` 为空），
  //   可两个号从早上 07 点一路互刷到 16:53（日志里
  //   `刷到硬闸了（9+15 条），但剧情还在演 → 不收尾、也不闭麦` 在反复打）。
  //
  // ## 两个真因
  //   ① `due()` 是"隔一会儿推进一段"，被互动不断刷新 ⇒ **永远不到点**；
  //      而收尾（模型 done / 冷场 / MAX_STAGES）**都得靠推进**才走得到
  //      ⇒ 这条线可以无限滚。缺的是**从头算的绝对时长上限**。
  //   ② `notePeerPlot` 的"续记"只要 ≥2 字就刷新 `lastAt` ⇒ `questLive`
  //      **永远为真** ⇒ 硬闸 / 闭麦 / 冷却全被豁免 ⇒ **刹车被拆了**。
  const quest30 = await import('../src/quest.js');
  const src30 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const isrc30 = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8');

  check(/export function overdue\(now = Date\.now\(\), groupId = ''\)/.test(readFileSync(join(ROOT, 'src', 'quest.js'), 'utf8')), '★★★ 有"这条剧情演太久了"的判据');
  check(
    /if \(quest\.overdue\(Date\.now\(\), gid\)\)/.test(isrc30),
    '★★★ 定时器到点就**强制收个结局**（`forceEnd`）—— 保证一定结束',
  );
  check(
    /quest\.sharedPremise\(g, \{ maxAgeMs: 45 \* 60 \* 1000 \}\)/.test(src30),
    '★★★ `questLive` 改用**共享起因**（只有真开了一场剧情才会写它）+ 45 分钟上限 —— ' +
      '原来的"看见同类发了一句像剧情的话"太松（日常闲聊也满足），于是所有防互刷的闸全被豁免',
  );
  {
    const { Bot } = await import('../src/bot.js');
    const b30 = new Bot();
    const G30b = '999000031';
    if (quest30.current(G30b)) quest30.__set({ byGroup: {} });
    check(
      b30.questLive(G30b) === false,
      '★★★ 行为：没有剧情、也没有共享起因（= 日常闲聊）⇒ **不算"剧情中"**，硬闸/闭麦才拦得住',
    );
  }

  // 行为：老的剧情要判 overdue、新开的不算
  const G30 = '999000030';
  const mk30 = (ageMs) => ({
    byGroup: {
      [G30]: {
        current: {
          id: 'q30', groupId: G30, startedAt: Date.now() - ageMs, endedAt: 0,
          premise: '门锁死了', plannedStages: 3, stageIndex: 1,
          stages: [], herMsgIds: [], pending: [], cast: [], humanReplies: 0, autoContinues: 0,
        },
        recent: [], starts: [],
      },
    },
  });
  quest30.__set(mk30(46 * 60 * 1000));
  check(quest30.overdue(Date.now(), G30) === true, '★★★ 演了 46 分钟 ⇒ 该收尾了');
  quest30.__set(mk30(5 * 60 * 1000));
  check(quest30.overdue(Date.now(), G30) === false, '★★ 才 5 分钟 ⇒ 不收（别把正常剧情砍了）');
  quest30.__set({ byGroup: {} });
}

console.log('\n【31】★ "不回了 → 行 → 真不回了 → ……" 这种拉锯要断掉（2026-10-07 用户截图：「Saki 都无语了」）');
{
  // ## 截图上的链子
  //   爱音「（不回了，这轮就到这儿。）」→ Saki「行」→
  //   爱音「（这轮真到这儿了，不接。）」→ Saki「……」→
  //   过一分钟爱音又开口「诶，干嘛呀，光一个点（」✗
  //
  // ## 三个燃料
  //   ① 那句"我不回了"是**代码逼出来的**（`sayBotFarewell` 走 `phrase`），
  //      所以带"（…）"旁白格式 —— 在群里像自说自话的元发言；
  //   ② 对面收到"我不回了"**照样要回一句**（点头/无语）；
  //   ③ 冷却只有 1 分钟 ⇒ 一分钟后它又开口 ⇒ 自打脸 ✗
  const src31 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');

  // ① 代码不再发那句收尾话
  check(
    (src31.match(/this\.sayBotFarewell\(/g) ?? []).length === 0,
    '★★★ 硬闸命中**不再发**那句代码逼出来的收尾话（"（不回了，这轮就到这儿。）"就是它）',
  );
  check(
    /硬闸[\s\S]{0,400}?直接静默/.test(src31),
    '★★★ 改成**直接静默**：不发声、不接同类 —— 没有那句"我不回了"，对面就没有可回的东西',
  );

  // ② 对面说告别话 ⇒ 一个字都不回（Saki 那两句短回应就是燃料）
  //    ⚠️ 这件事**上面 `isFarewellLine()` 那条闸已经管了** —— 我这个补丁的第一版
  //    另开了一条闸，结果重复 + 漏了 @ 例外，被【11】当场抓住。
  //    ⇒ 正确的修法是**往那个词表里补词**（截图那句就是没进词表才漏的）。
  check(
    /isFarewellLine\(text\) \{[\s\S]{0,900}?不回了\|不接你了/.test(src31),
    '★★★ `isFarewellLine()` 的词表里补上了「不回了 / 不接了 / 这轮就到」—— 截图那句原来是漏的',
  );
  check(
    (src31.match(/this\.sayBotFarewell\(/g) ?? []).length === 0,
    '★★★ 而且**不再另开一条重复的闸**（@ 例外和剧情例外都沿用已有的那条）',
  );

  // ③ 收场话之后要安静更久（1 分钟断不掉拉锯）
  check(/botFarewellCooldownMs/.test(src31), '★★★ 收场话有独立的、更长的冷却（默认 10 分钟，可配）');
  check(
    /this\.botFarewellAt \?\?= new Map\(\)/.test(src31) && /farewellCooling/.test(src31),
    '★★ "她自己说了收场的话"和"硬闸冷却"用的是两套时间戳（别混）',
  );

  // 行为：词表既认得截图那句，又不误伤正常台词
  const { Bot } = await import('../src/bot.js');
  const b31 = new Bot();
  check(b31.isFarewellLine('（这轮真到这儿了，不接。）') === true, '★★★ 截图里那句要判成告别');
  check(b31.isFarewellLine('不回了，这轮就到这儿。') === true, '★★ 简写也要判成告别');
  check(b31.isFarewellLine('好，回见') === true, '★ 原来认的照样认（别改坏）');
  check(
    b31.isFarewellLine('先这样，我去挪柜子了') === true,
    '★★ 已知（原来就是这样）：短句里的「先这样」会被判成告别 —— ' +
      '但**剧情里这条闸整个不生效**（`questLive` 例外），所以剧情台词不受影响',
  );
  check(b31.isFarewellLine('你去了记得把那个装完再回来再说这个事') === false, '★★ 长句不算');
}

console.log('\n【32】★★★ 机器人不能互相学习（2026-10-07 用户截图）');
{
  // ## 截图
  //   saki：「别急着装？那不装拿什么进啊。 **Java 21 该装还是得装的**」
  //   Anon（引用她那条）：「**记下了 —— 【Java版本要求】（覆盖了旧的）**」
  //                         「哦——原来是 21 啊，我记岔了」
  //   ⇒ 对面那个号**把同类说的话当知识记进了学习档案** ⇒ 知识库被污染 ✗
  //   用户一句：「**机器人不能互相学习**」
  //
  // ## 为什么原来那两道守卫拦不住
  //   · `teach.bots` 是**白名单**，只列了 Q群管家那一个号；
  //   · 昵称判据要求带「管家 / 机器人 / bot」，而那个号的群名片是「saki酱saki酱saki酱」✗
  //   ⇒ 现在按**配置里的机器人池**判（同类池 + 别的机器人池）—— 不看昵称、也不用记白名单 ✓
  //
  // ⚠️ 所有教学路径都经过 `canTeach()`（6456 确认 / 6472 忘记 / 6486 总闸 / 8205 自然教学），
  //    所以堵这一处就全覆盖。
  const src32 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const { Bot } = await import('../src/bot.js');

  check(
    /const pool = \[\.\.\.peersFor\(gid\), \.\.\.otherBotsFor\(gid\)\]\.map\(String\);/.test(src32),
    '★★★ `canTeach()` 里按**机器人池**拒（同类池 + 别的机器人池）',
  );
  check(
    /拒绝来自同类\/别的机器人 \$\{uid\} 的"教学"/.test(src32),
    '★★ 而且会记一条日志（以后能查是谁教的）',
  );

  // 行为
  const G32 = '999000032';
  const P32 = '10000032';
  const O32 = '10000033';
  config.groupParams[G32] = { peers: [P32], otherBots: [O32] };
  config.teach = { ...(config.teach ?? {}), enable: true, requireOwnerRole: true };
  const b32 = new Bot();
  const ev32 = (uid, role) => ({
    message_type: 'group',
    group_id: G32,
    user_id: uid,
    sender: { user_id: uid, card: 'saki酱saki酱saki酱', nickname: 'saki酱saki酱saki酱', role },
  });
  check(b32.canTeach(ev32(P32, 'admin')) === false, '★★★ 同类池里的号（哪怕在群里是管理员）**不许教她**');
  check(b32.canTeach(ev32(O32, 'owner')) === false, '★★★ 别的机器人池里的号也一样');
  check(
    b32.canTeach(ev32('30003', 'admin')) === true,
    '★★★ 对照：**真人管理员照旧能教**（别把真人一起堵掉）',
  );
  check(
    b32.canTeach(ev32('30003', 'member')) === false,
    '★ 对照：普通群友照旧不能教（原来那条规矩没被破坏）',
  );
}

console.log('\n【33】★★ 「花多少时间」不许被当成「花了多少钱」（2026-10-07 用户截图：「为什么这个会触发查账」）');
{
  // ## 截图
  //   群里那句是「给你看看我进服务器**花多少时间**」，结果两个号各报了一遍账：
  //     「哇塞进个服务器这么费劲的吗——不过说到账本，爱音这个月花掉 42.37 元…」
  //     「101元，这月花的。12,426次调用，两亿多token……」
  //   ⇒ 裸的 `花` 命中 + `ask` 里的 `多少` 命中 ⇒ 被当成"问花了多少钱" ✗
  const spend33 = await import('../src/spend.js');

  check(
    spend33.looksLikeSpendQuestion('给你看看我进服务器花多少时间') === null,
    '★★★ 截图那句**不许**触发查账（"花多少时间"跟钱没关系）',
  );
  check(spend33.looksLikeSpendQuestion('这个我花了不少功夫') === null, '★★ 「花了不少功夫」也不算');

  // 对照：真问钱照旧要认（别把闸堵死）
  const m1 = spend33.looksLikeSpendQuestion('这个月花了多少钱');
  check(m1?.type === 'spend' && m1?.scope === 'month', '★★★ 对照：「这个月花了多少钱」照旧认', JSON.stringify(m1));
  const m2 = spend33.looksLikeSpendQuestion('今天花了多少');
  check(m2?.type === 'spend' && m2?.scope === 'day', '★★★ 对照：「今天花了多少」照旧认（含 day 范围）', JSON.stringify(m2));
  const m3 = spend33.looksLikeSpendQuestion('你赚了多少');
  check(m3?.type === 'earn', '★★ 对照：「你赚了多少」照旧认（earn 那一路）', JSON.stringify(m3));
  const m4 = spend33.looksLikeSpendQuestion('余额还有多少');
  check(m4?.type === 'spend', '★★ 对照：「余额还有多少」照旧认', JSON.stringify(m4));
}

console.log('\n【34】★★★ 说了收场话就不许再追补（2026-10-07 用户截图：「发了结束语还在接话」）');
{
  // ## 截图
  //   saki「行行行，机密最大，我不挑了。**我先去忙了，到点了**」
  //   Anon「行，去吧」
  //   Anon「**机密我先替你收着（**」   ← 自己又补一句 ✗
  //   saki「收着吧，别给我弄丢了」     ← 又被带着接一句 ✗
  // ⇒ 后面那两句是**追补**（"说完又想补充"）补出来的，而那条路
  //   **从来没查过"我刚说的是不是收场话"** ✗
  //   （`decide()` 里那几道收尾闸只管"接**别人**的话"，管不到自己补自己。）
  const src34 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const { Bot } = await import('../src/bot.js');
  const b34 = new Bot();

  check(
    /if \(this\.isFarewell\(replied\)\) \{[\s\S]{0,200}?不追补/.test(src34),
    '★★★ `maybeFollowUp()` 里：**自己刚说的是收场话 ⇒ 不补**',
  );
  check(
    /刚收过尾（\$\{Math\.ceil\(\(cool - \(Date\.now\(\) - closedAt\)\) \/ 1000\)\} 秒冷却中）→ 不追补/.test(src34),
    '★★★ 这个群刚收过尾（含这一轮她自己刚说的那一次）⇒ 也不补（双保险）',
  );

  // 行为：那句确实是"收场话"
  check(
    b34.isFarewell('行行行，机密最大，我不挑了。我先去忙了，到点了') === true,
    '★★★ 截图里 saki 那句要判成收场话',
  );
  check(
    b34.isFarewell('行，去吧') === false,
    '★ 已知：「行，去吧」**故意不认**（认了会误伤「去吧台看看」）—— ' +
      '它不算收场，所以回它没问题；真正要拦的是**说完收场话之后的追补**',
  );
  check(
    b34.isFarewell('那我先看看这个日志里报的什么错，等会儿告诉你') === false,
    '★★ 对照：**正常的一句交代不算收场**（别把追补整条路堵死）',
  );

  // ⚠️⚠️ 2026-10-07 补（用户截图：「**又把不接（）发出来了**」）：
  //    提示词里原来写着「没什么可说的**直接不接**也完全可以」——
  //    模型把它读成"要说一句'不接'" ⇒ 群里出现「（这话已经说到头了，不接）」「（不接）」✗
  //    ⇒ 提示词必须说清：**"不接"就是不发消息**，不是发一句"我不接"。
  // ⚠️⚠️ 2026-10-09 更新（用户又截图两次：「这个还是存在」+「结束对话的判定也交给模型吧」）：
  //    光禁「（不接）」不够 —— 她换写法继续写（只写左括号 / 括号后带正文）。
  //    ⇒ 提示词现在把话说透：**判断只体现在"发不发"这一个动作上**。
  check(
    /任何"我决定了"都不许写出来/.test(src34),
    '★★★ 提示词里禁掉**任何形式的"我决定了"**（不只是「（不接）」那一个写法）',
  );
  check(
    /你的判断只体现在"发不发"这一个动作上/.test(src34),
    '★★★ 而且点明：决定不接 = **一个字都别发** —— 判断只体现在发不发上（用户：「判定交给模型」）',
  );
  check(
    /决定不接 ⇒ \*\*一个字都别发\*\*/.test(src34),
    '★★ 这条正反两面都写了（决定接 ⇒ 只写那句话本身，别先解释为什么接）',
  );
}

console.log('\n【35】★★★ 收紧度调高时，「判断节流」不许绕过它（2026-10-07 用户：「收紧度调高回话频率还是很高」）');
{
  // ## 用户的问题
  //   「为什么感觉现在收紧度调高回话频率还是很高」
  //
  // ## 真因（日志实证）
  //   `[主动接话] 判断节流中（chat@group:…，5s 内刚问过）→ 跳过判断、直接接`
  //   —— 收紧度调高只是让 `judge` 更严格，可 **5 秒窗口内的消息压根不问 judge**：
  //     群里连着说话时，第一条判"接"之后，后面 5 秒里的**每一条都直接接** ✗✗
  //   ⇒ 这条闸**完全绕过收紧度**，用户把滑块拉高也没用。
  const src35 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');

  check(
    /const sThrottle = this\.strictnessOf\(event\);/.test(src35),
    '★★★ 判断节流命中时**先读收紧度**',
  );
  check(
    /if \(sThrottle <= 2\) \{[\s\S]{0,400}?跳过判断、直接接/.test(src35),
    '★★ 收紧度 ≤ 2（最放得开那档）⇒ 照旧"直接接"（要的就是像真人一样想说就说）',
  );
  check(
    /收紧度 \$\{sThrottle\} > 2 → \*\*这条不接\*\*/.test(src35),
    '★★★ 收紧度 > 2 ⇒ **这条不接** —— 原来是一律"直接接"，等于这条闸完全绕过滑块',
  );
  check(
    /const sThrottle = this\.strictnessOf\(event\);\s*\n\s*if \(sThrottle <= 2\)/.test(src35),
    '★ 而且判断就在节流分支里面（不改"判得了就正常判"那条路）',
  );
}

console.log('\n【36】★★★ 追补（followUp）要受收紧度管 —— 它原来一点都不过（2026-10-07 用户：「主动搭话的频率就是很高」）');
{
  // ## 实测（日志统计，最近那批 `主动接话` 里 **15 条有 14 条是 `followUp`**）
  //    18:46:30 followUp / 18:47:19 followUp / 18:47:24 followUp /
  //    18:48:19 / 18:48:38 / 18:49:35 / 18:49:44 … 几乎全是它。
  //   ⇒ 用户把收紧度拉高也没用：`judge` 只管"这条要不要接"，
  //     而追补是**回复发出去之后**又自己补的，走 `maybeFollowUp`，
  //     那边只有"概率闸 + 每次上限"，**跟收紧度毫无关系** ✗✗
  const src36 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const { Bot } = await import('../src/bot.js');

  check(
    /const sFU = this\.strictnessOf\(event\);/.test(src36),
    '★★★ `maybeFollowUp()` 里**读了收紧度**',
  );
  check(
    /if \(sFU > 2\) \{[\s\S]{0,300}?不追补/.test(src36),
    '★★★ 收紧度 > 2 ⇒ **不追补**（和 judge 那条闸同一个分界：>2 才过 judge）',
  );

  // 行为：收紧度高时确实不补（`maybeFollowUp` 是 async，但要走到返回只需要前面几行）
  const G36 = '999000036';
  const P36 = '10000036';
  config.groupParams[G36] = { peers: [P36], chat: { strictness: 60 } };
  const b36 = new Bot();
  const ev36 = {
    message_type: 'group',
    group_id: G36,
    user_id: P36,
    self_id: String(config.botQQ ?? ''),
    sender: { card: '', nickname: '' },
    message: [{ type: 'text', data: { text: '嗯' } }],
  };
  config.selfFollowUp = { ...(config.selfFollowUp ?? {}), enable: true };
  // ⚠️ `shouldConsider()` 是概率闸（测试里没法固定随机源）—— 所以这里只断言
  //    "**把随机闸放开之后，收紧度仍然挡得住**"：连续试 30 次，一次都不许真的发出去。
  let sent36 = 0;
  const origSend = b36.sendText.bind(b36);
  b36.sendText = async () => {
    sent36 += 1;
    return { status: 'ok' };
  };
  for (let i = 0; i < 30; i++) {
    await b36.maybeFollowUp(ev36, { replied: '这条就是一句普通的回应，没有收场的意思', who: '群' });
  }
  check(sent36 === 0, `★★★ 行为：收紧度 60 的群里，追补**一次都没发出去**（试了 30 次，发出 ${sent36} 次）`);
  b36.sendText = origSend;
}

console.log('\n【37】★★★ 机器人不能互相设定时提醒（2026-10-08 跨天 00:00 用户报：「出来了一堆机器人互相提醒」）');
{
  // ## 实测（`logs/bot-2026-10-08.log`，跨天那一刻爆的）
  //   Anon「你让我提醒你的，下完记得喊我一声。」
  //   → `[提醒] 记下一条：10月9日 00:00 提醒 10000012「下完」` ✗
  //   → 紧接着 `[提醒] 到点已发出：到拐弯喊我一声 / 圈转完了喊我看 /
  //      搞素世的话记得把项目更新一下…` —— **四条一起发** ✗✗
  //   —— 那些本来是**剧情里的台词**（「到拐弯喊我一声」），
  //     被 `提醒|叫我|喊我|记得` 那个粗筛抓成了"用户定的提醒"。
  //   用户一句：「**机器人不能互相设定时提醒**」。
  const src37 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const { Bot } = await import('../src/bot.js');

  check(
    /wantsRemind\(event\) \{[\s\S]{0,900}?const pool = \[\.\.\.peersFor\(gid0\), \.\.\.otherBotsFor\(gid0\)\]\.map\(String\);/.test(
      src37,
    ),
    '★★★ `wantsRemind()`（同步粗筛）里按**机器人池**拒 —— 和"教学"同一个模式',
  );
  check(
    /机器人不能互相设定时提醒/.test(src37),
    '★★ 而且 `maybeRemind()` 里再挡一道（别的调用点会直接调它）',
  );

  // 行为
  const G37 = '999000037';
  const P37 = '10000037';
  const O37 = '10000038';
  config.groupParams[G37] = { peers: [P37], otherBots: [O37] };
  config.remind = { ...(config.remind ?? {}), enable: true };
  const b37 = new Bot();
  const ev37 = (uid, t) => ({
    message_type: 'group',
    group_id: G37,
    user_id: uid,
    message: [{ type: 'text', data: { text: t } }],
    sender: { user_id: uid, card: '', nickname: '' },
  });
  check(
    b37.wantsRemind(ev37(P37, '你让我提醒你的，下完记得喊我一声')) === false,
    '★★★ 同类说的话（含「提醒」「喊我一声」）⇒ **不算要定提醒**',
  );
  check(
    b37.wantsRemind(ev37(O37, '记得提醒我看一眼')) === false,
    '★★★ 别的机器人池里的号也一样',
  );
  check(
    b37.wantsRemind(ev37('30003', '提醒我明天八点起床')) === true,
    '★★★ 对照：**真人定的提醒照旧认**（一个字都没受影响）',
  );
}

console.log('\n【38】★★★ 到点太久还没发出去的提醒要自动丢掉（2026-10-08 用户：「真人的都是已经过去的事情，为什么不会自动删除」）');
{
  // ## 用户看到的
  //   state/remind.json 里躺着 12 条**9 月**的真人提醒（9/19 起床、9/25 下火车…），
  //   早就过期了却一直不删。
  //
  // ## 根因
  //   `index.js` 的提醒 tick 靠一个**内存** Map 记"试了多久"（`fails: id → {n,since}`）
  //   + `giveUpMs`（2 小时）决定什么时候放弃 —— 而**内存态一重启就归零**，
  //   机器人本来就每天重启几次（2026-10-07 那晚我自己就重启了十几次）
  //   ⇒ 那 2 小时**永远等不到** ⇒ 发不出去的提醒**永远挂着** ✗✗
  //
  // ## 修
  //   换一条**跟重启无关**的判据：**看提醒自己到点多久了**（`remind.stale()`）——
  //   到点超过 staleMs（默认 24 小时）还没发出去就丢掉，不再重试 ✓
  const rsrc38 = readFileSync(join(ROOT, 'src', 'remind.js'), 'utf8');
  const isrc38 = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8');

  check(
    /export function stale\(before = Date\.now\(\)\)/.test(rsrc38),
    '★★★ `remind.stale()`：按"提醒自己到点多久了"判过期（跟重启无关）',
  );
  check(
    /const sweepStale = \(\) => \{/.test(isrc38) && /sweepStale\(\);\s*\n\s*\} catch/.test(isrc38),
    '★★★ tick 里**先清过期**、再处理到点的',
  );
  check(
    /Number\(config\.remind\?\.staleMs\) \|\| 24 \* 3600 \* 1000/.test(isrc38),
    '★★ staleMs 默认 24 小时（可配）—— 隔了一天的提醒发出去反而是打扰',
  );
  check(
    /到点已经超过 \$\{Math\.round\(staleMs \/ 3600000\)\} 小时还没发出去/.test(isrc38),
    '★ 丢掉时会记一条日志（以后能查"什么提醒被丢了"）',
  );
}

console.log('\n【39】★★★ 一整段"旁白式括号"不许发出去（2026-10-08 用户截图：「前面又输出括号了」）');
{
  // ## 截图（连着两条）
  //   Anon「（不回，继续翻素世那摊）」
  //   saki「（那就没我什么事了，让她弄去吧。）」
  // —— 那是**状态报告**，不是台词；群里的人看到只会莫名其妙。
  //   用户为这个已经截过好几次图（上一次是「（不接）」）。
  //
  // ⚠️ 为什么单靠提示词管不住：写不写括号全看模型那一次的心情 ——
  //    上一轮已经在提示词里点名禁过「（不接）」，这次换个说法又冒出来 ✗
  //    ⇒ 代码兜底（和"剧情里不许睡觉收场"同一个位置：`sendChatLike`）✓
  const src39 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const { Bot } = await import('../src/bot.js');
  const b39 = new Bot();

  check(/isBracketNarration\(text\) \{/.test(src39), '★★★ 有"一整段旁白式括号"的判据');
  // ⚠️ 2026-10-09 改：入口从"同步的快判据"换成"**await 的模型判定**"；
  //    ⚠️⚠️ 更要紧的是**挂在哪一层**：原来挂在 `sendChatLike` 上 —— 而那个函数
  //    **不是**她发言的唯一出口 ✗（`handle()` 的主聊天走 `sendChunk` → `sendText`）
  //    ⇒ 群里连着 11 条括号旁白、日志里却一条 `[旁白` 都没有，就是这么来的。
  //    现在挂在 `sendText()`（所有外发的最后一道）✓
  check(
    /async sendText\(event, text[\s\S]{0,1200}?await this\.shouldPauseByBracket\(/.test(src39),
    '★★★ 闸挂在 **`sendText()`** 里 —— 所有外发的最后一道（聊天 / 剧情 / 日常事件全都经过它）',
  );
  check(
    !/shouldPauseByBracket\(text, groupId\)/.test(src39),
    '★★ 而且没有留在 `sendChatLike` 里（那层拦不到主聊天，留着还会判两次）',
  );
  check(
    /return null;/.test(src39),
    '★ 拦下时返回 `null`（调用方按 `sentText !== null` 判"发出去没有"）',
  );

  // 行为：截图那两条要拦
  check(
    b39.isBracketNarration('（不回，继续翻素世那摊）') === true,
    '★★★ 截图第 1 条（Anon 那句）要拦',
  );
  check(
    b39.isBracketNarration('（那就没我什么事了，让她弄去吧。）') === true,
    '★★★ 截图第 2 条（saki 那句，带句号）要拦',
  );
  check(b39.isBracketNarration('（不接）') === true, '★★ 上一轮那个「（不接）」也能兜住');
  // ⚠️⚠️ 2026-10-09 用户截图又抓到两条（**新的形态：内部带句号**）——
  //    它们原来被"内部还有别的句子 ⇒ 不算旁白"那条**写反**的判据放走了 ✗
  check(
    b39.isBracketNarration('（那是在说爱音，不是冲我。这条我不接。）') === true,
    '★★★ 多句的旁白也要拦（先判断一句、再下结论「这条我不接」）',
  );
  check(
    b39.isBracketNarration('（她在跟爱音掰扯，没我什么事。不接。）') === true,
    '★★★ 同上那条的另一种写法',
  );
  check(
    b39.isBracketNarration('（笑）') === false,
    '★ 但纯语气那种照旧放行（它不含元话语词，别误伤）',
  );
  // ⚠️⚠️ 2026-10-09 第三轮（用户截图：「**这个还是存在**」，形态又变了）：
  //    只认"整条被一对括号包住"是不够的 —— 下面这两种一条都拦不住 ✗
  check(
    b39.isBracketNarration('（这是回<主人>的，跟我没关系。不接') === true,
    '★★★ 只有左括号（她没写右括号）也要拦',
  );
  check(
    b39.isBracketNarration('（这条是黑祥回 <主人> 的，不是给我的）。那就不关我事了，你们自己说去') === true,
    '★★★ 括号后还带着正文的那种也要拦',
  );
  // ⚠️ 提示词那头也要把话说透（用户：「结束对话的判定也交给模型吧」）
  check(
    /你的判断只体现在"发不发"这一个动作上/.test(src39),
    '★★★ 提示词里点明：决定不接 = **一个字都别发**（判断只体现在发不发上）',
  );
  // ⚠️⚠️ 2026-10-09 第四轮（用户：「**括号话越来越多了**。为什么不能只要模型去检查括号里的话，
  //    只要括号里的话意思是暂停就直接把消息截回来并且把对话掐断」）：
  //    ⇒ 不再往关键词表里加词，改成**让模型判**，代码只负责"截住不发 + 掐断对话" ✓
  check(
    /async shouldPauseByBracket\(/.test(src39),
    '★★★ 有一条"先快判、拿不准**问模型**"的判定（关键词表那条路不再独自扛）',
  );
  // ⚠️ 2026-10-09 撤回：这一版**不在 `sendText` 里 await 模型**了 ——
  //    实测它会把她**最热的发送出口**拖红（`behavior` 5 项"发了 0 条"）✗
  //    ⇒ 出口上只做**同步快判据**；"让模型判括号"换个位置（生成后、发送前）重做 ✓
  check(
    /if \(this\.isBracketNarration\(String\(text \?\? ''\)\)\)/.test(src39),
    '★★★ 出口上做的是**同步**快判据（异步判定留待换位置重做）',
  );
  check(
    /this\.botChainClosed\.set\(String\(event\.group_id\), Date\.now\(\)\)/.test(src39),
    '★★★ 判为"停"时**把这轮对话掐断** —— 用户要的"把对话掐断"，不只是这条不发',
  );
  check(
    /llm\.phrase\(\{[\s\S]{0,240}?maxTokens: 60/.test(src39),
    '★★ 判定走轻量通道（`phrase`：非流式 + 关思考链 + 60 token 下限）',
  );
  check(
    /if \(!\/\[（\(\]\/\.test\(t\)\) return false/.test(src39),
    '★★ 没括号的消息**一次都不问**（只有"含括号 + 关键词没命中"才花这次调用）',
  );

  // 对照：动作 / 表情那种括号**必须放行**（不然就误伤了）
  check(b39.isBracketNarration('（笑）') === false, '★★★ 对照：「（笑）」是动作，照旧放行');
  check(b39.isBracketNarration('（揉了揉眼睛）') === false, '★★ 对照：动作描写放行');
  check(
    b39.isBracketNarration('（她说的那个我再看看）好，我知道了') === false,
    '★★★ 对照：**前面带括号、后面有正话** ⇒ 不是"一整段旁白"，放行',
  );
  check(b39.isBracketNarration('行，那你弄，弄完吱我一声') === false, '★ 对照：普通一句话放行');
}

console.log('\n【40】★★★ 两个机器人互刷时用精简提示词 + 关思考链（2026-10-08 用户：「耗 token 非常快」，选了 A+D）');
{
  // ## 实测（`state/spend.json`）
  //   10-07：3207 次调用、**6712 万 prompt token**、completion 126 万（只占 3%）→ ¥42.4
  //   ⇒ 单次平均 prompt ≈ **2.1 万 token**：钱全花在"每次都把那一大坨提示词重发一遍"上 ✗
  //   ⇒ A：互刷时**只留人设**（不带服务器库/群记忆/故事线）；
  //     D：互刷时**关思考链**。
  //   ⚠️ 判据是 `botOnlyChain()`（来回够多条 + 窗口里没有真人）⇒
  //      **你和群友说话时一个字都不变** ✓
  const src40 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');

  check(
    /buildSystemPrompt\(liveStatus = '', event = null, voluntary = null, currentText = '', vision = '', webSearch = '', forwardText = '', crashLog = '', solveMode = false, lean = false\)/.test(
      src40,
    ),
    '★★★ `buildSystemPrompt()` 多了 `lean` 参数',
  );
  check(
    /const onlyNames = lean\s*\n?\s*\?\s*picked\.names\.filter\(/.test(src40),
    '★★★ A：`lean` 时知识库**只留人设**（其余文件不带）',
  );
  check(
    /const sl = lean \? '' : storyline\.promptBlock\(5, scopeId\);/.test(src40),
    '★★★ A：`lean` 时**不带故事线**（那是给群友看的长期记忆，互刷用不上）',
  );
  check(
    /\(_bcStat\.humans \?\? 0\) === 0 &&\s*\n\s*\(_bcStat\.total \?\? 0\) >= 3/.test(src40),
    '★★★ `leanMode` 的判据改成「窗口里没有真人 + 至少 3 条」—— ' +
      '原来是 `botOnlyChain()`（要满 10 条或跨 3 分钟），实测 65 条里只有 3 条命中（4.6%）✗',
  );
  // ⚠️ 2026-10-09：原来那条"截前 12000 字"的断言已经过时 ——
  //    现在改成**按节挑**（`leanSections()`），那条断言搬到了【42】里 ✓
  check(
    /const leanNoThink = leanMode && !this\.questLive\(String\(event\.group_id \?\? ''\)\);/.test(src40),
    '★★★ `leanNoThink` = "互刷、且**不**在演剧情"（2026-10-09 起剧情那一档单独用 `thinkOffInQuest` 关，见【50】）',
  );
  check(
    // ⚠️ 2026-10-09 再改：关思考的判据从"两档硬编码"升级成**三类开关**
    //    （`config.llm.thinking` = peer / questPeer / quest）⇒ 这里只守"开关真的接上了" ✓
    /config\.llm\?\.thinking/.test(src40) && /if \(fromPeer && thinkOffInQuest\)/.test(src40),
    '★★★ 关思考的判据走 `config.llm.thinking` 那三类开关（不是 `leanMode`）',
  );
  check(
    !/\bleanMode\s*\n?\s*\?\s*\{ thinking/.test(src40),
    '★★ 别拿 `leanMode` 当"关思考"的开关（它只是"要不要精简"，两者不是一回事）',
  );
  check(
    /const onlyNames = lean\s*\n?\s*\?\s*picked\.names\.filter\(/.test(src40),
    '★★★ A（砍知识库）**剧情里照砍** —— 服务器库/群记忆对剧情没用，纯粹是省',
  );
  check(
    /solveMode,\s*\n\s*leanMode,\s*\n\s*\);/.test(src40),
    '★★ 调用点真的把 `leanMode` 传进去了（不然上面全白改）',
  );
}

console.log('\n【41】★★★ "短句点头"拉锯要停：话题完了就别再往下接（2026-10-08 用户截图：「很明显应该自己停下接话，但是没停」）');
{
  // ## 截图那串
  //   Saki「嗯，去吧」→ Anon「嗯，这就去」→ Saki「嗯，去吧，这次真不催你了」
  //   → Anon「诶，这话你刚说过一遍了吧…」→ Saki「去吧去吧，这回真不催了」
  //   → Anon「诶，你这话都第三遍了…」
  // —— 话题早就完了（双方都点头"去吧"），却一句接一句下不去 ✗
  //
  // ⚠️ 为什么现成三道闸都拦不住：
  //   · `botOnlyChain()`（注入"该收了"）要**满 10 条或跨 3 分钟**，这里才 6 条几十秒 ⇒ 没注入；
  //   · 硬闸 `botChainHard` 要 24 条；
  //   · `isFarewellLine()` 的词表**故意没有"去吧"**（怕误伤「去吧台看看」）。
  const src41 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const recent41 = await import('../src/recent.js');
  const { Bot } = await import('../src/bot.js');

  check(/isShortNodLull\(groupId, peerText\) \{/.test(src41), '★★★ 有"短句点头拉锯"的判据');
  check(
    /!this\.questLive\(gid0\) && !peerAtMe && this\.isShortNodLull\(gid0, peerText0\)/.test(src41),
    '★★★ 接在同类那条路上（剧情里不拦、@ 她的照旧回）',
  );

  const G41 = '999000041';
  const store41 = recent41.__storeForTest();
  store41.set(G41, [{ time: Date.now() - 5000, userId: '__self__', self: true, text: '嗯，去吧' }]);
  const b41 = new Bot();
  check(b41.isShortNodLull(G41, '嗯，这就去') === true, '★★★ 截图那句（对面也在点头）⇒ 停');
  check(b41.isShortNodLull(G41, '去吧去吧') === true, '★★ 同款短句 ⇒ 停');
  check(
    b41.isShortNodLull(G41, '你那边几点开始啊') === false,
    '★★★ 对照：**问句一定要答**（不能因为短就吞掉）',
  );
  check(
    b41.isShortNodLull(G41, '话说素世那摊我翻了一下，确实该更新了') === false,
    '★★★ 对照：**长句 = 还在正常聊天** ⇒ 不拦',
  );

  // 我自己上一句是长句 ⇒ 说明还在正经聊，不该按"点头拉锯"处理
  store41.set(G41, [
    {
      time: Date.now() - 5000,
      userId: '__self__',
      self: true,
      text: '素世那摊我翻了一下，确实该更新了',
    },
  ]);
  check(
    b41.isShortNodLull(G41, '嗯嗯') === false,
    '★★★ 对照：我自己上一句是长句 ⇒ 这不是"点头拉锯"（她还在正经聊）',
  );
  store41.delete(G41);
}

console.log('\n【42】★★★ 按节挑人设（2026-10-09 用户：「只要拼的时候只拼必须的，优化拼库流程」）');
{
  // ## 背景
  //   `persona.md` **45,891 字 / 80 节**（"用户每报一个毛病就加一节"攒出来的：
  //   光「⚠️⚠️ 别XX」就有 25 节、约 1.5 万字），而整条提示词平均 73,320 字
  //   ⇒ 人设占 ≈70%，这才是真正的大头 ✗
  //
  // ## 三道保险（`leanSections`）
  //   ① 永远带：铁律 / 说话方式 / 语气词 / 长短句 / 标点 / 别自言自语 / 身份；
  //   ② 相关才带：节标题里的词出现在当前消息里；
  //   ③ 超量按节丢：丢整节，不切半句。
  const src42 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const { Bot } = await import('../src/bot.js');
  const { readFileSync: rf42 } = await import('node:fs');

  check(/leanSections\(full, currentText = '', groupId = ''\) \{/.test(src42), '★★★ 有 `leanSections()`（按节挑人设）');
  check(
    /const picked2 = this\.leanSections\(k, currentText, String\(event\?\.group_id \?\? ''\)\);/.test(src42),
    '★★★ 而且真的用上了（原来那段"切前 12K"已经换成它）',
  );
  check(
    /if \(!solveMode && config\.chat\?\.leanSections !== false\) \{[\s\S]{0,300}?this\.leanSections\(k, currentText/.test(
      src42,
    ),
    '★★★ **默认开着**（`chat.leanSections` 设 false 才关）—— ' +
      '我一度因 3 个回归红把它关掉，事后查明那是 `cap` 按体积丢节造成的、而 cap 已放开，' +
      '关掉等于把唯一有效的省法丢掉',
  );
  check(/const parts = text\.split\(\/\\n\(\?=#\{2,3\}\\s\)\/\);/.test(src42), '★★ 按 `## ` 节切（不切半句）');

  // 行为：拿真实人设文件量一下到底省多少
  const b42 = new Bot();
  const full42 = rf42(join(ROOT, 'personas', 'saki', 'persona.md'), 'utf8');
  const out42 = b42.leanSections(full42, '嗯，去吧');
  check(
    out42.length > 2000 && out42.length < full42.length,
    `★★★ 实测：${full42.length} → ${out42.length} 字（省 ${Math.round((1 - out42.length / full42.length) * 100)}%）` +
      ' —— 能切、能变小、不是空壳就行（⚠️ 它只省 13%，所以默认是关的）',
  );
  check(
    /铁律|说话|语气|傲娇/.test(out42),
    '★★★ 而且**该留的都在**（铁律 / 说话方式 / 人格那几节必须在，不然她就不像她了）',
  );
  // 切不开的文本要原样返回，别搞坏
  check(b42.leanSections('没有二级标题的一小段文字', '你好') === '没有二级标题的一小段文字', '★★ 切不开就原样返回（绝不返回空）');
  check(b42.leanSections('', '你好') === '', '★ 空输入也不崩');
}

console.log('\n【43】★★★ 答不上来 ⇒ 把上次没拼上的补进来重生成一次（2026-10-09 用户要求的那道防线）');
{
  // ## 用户原话
  //   「**加一道防线，如果检测到生成的消息存在不明白的地方，就重新更完善地拼一次库，
  //     并且只拼上次没拼上来的**」
  // ## 做法
  //   · `leanSections()` 顺手记下"这次没带上的节"（`_leanSkipped`）；
  //   · 生成完检测到"答不上来"（`looksConfused`）⇒ `takeSkippedKb()` 取出那部分
  //     （**取一次就清**）⇒ 追加一条 user 消息 ⇒ **重新生成一次**；
  //   · **只补一次**（补完不再判），不会循环烧钱。
  const src43 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const { Bot } = await import('../src/bot.js');
  const b43 = new Bot();

  check(/looksConfused\(text\) \{/.test(src43), '★★★ 有"她这条答不上来"的判据');
  check(/takeSkippedKb\(groupId\) \{/.test(src43), '★★★ 有"取出上次没拼上的那部分"（取一次就清）');
  check(
    /if \(this\.looksConfused\(full\)\) \{[\s\S]{0,600}?await _genOnce\(\{\}\);/.test(src43),
    '★★★ 真的会补库重生成一次',
  );
  check(
    /this\._leanSkipped\.delete\(g\)/.test(src43),
    '★★ 补完就清掉（不会下一轮又补同样的东西）',
  );

  // 行为：该认的要认
  check(b43.looksConfused('东心我手上真没料啊') === true, '★★★ 截图那句（"手上真没料"）要认');
  check(b43.looksConfused('这个我查不到') === true, '★★ "查不到"要认');
  check(b43.looksConfused('我不太清楚诶') === true, '★★ "不清楚"要认');
  // 不该认的别认（不然她每句都补库 = 白花钱）
  check(b43.looksConfused('嗯，去吧') === false, '★★★ 对照：正常一句话**不许**触发补库');
  check(b43.looksConfused('行，那我去更新了') === false, '★★ 对照：普通交代不许触发');
  check(
    b43.looksConfused('这句话写得很长'.repeat(30)) === false,
    '★ 对照：超长回复不看（那是剧情/正经回答，不是"答不上来"）',
  );

  // 行为：跳过清单会记、会取、取完就清
  // ⚠️ 注意两点，不然这条断言**不稳定**（踩过）：
  //    ① 按节挑**默认是关的**（`chat.leanSections`）⇒ 直接调 `leanSections()` 验行为；
  //    ② 先**清掉模型挑库的缓存** ⇒ 强制走"规则分支"，结果才确定
  //      （缓存命中时走的是"模型挑的那几节"，可能一个都不砍 ✗）
  const G43 = '999000043';
  b43._pickCache = new Map();
  const full43 =
    '## 铁律\n说话要短\n## 她现在住哪\n住东京\n## 一天怎么过\n上课练琴\n## 你在质疑我吗\n别质疑\n';
  const cut43 = b43.leanSections(full43, '嗯，去吧', G43);
  check(!cut43.includes('住东京'), '★★★ 砍掉了「她现在住哪」那一节（那是"设定"，闲聊时用不上）');
  check(cut43.includes('别质疑'), '★★★ 但「你在质疑我吗」那节**留着**（人格/规矩类的绝不砍）');
  check(!cut43.includes('上课练琴'), '★★ 「一天怎么过」也砍了');
  check(
    (b43._leanSkipped?.get(G43) ?? '').includes('住东京'),
    '★★★ 砍掉的那些**被记下来了**（"答不上来就补库"那道防线要用它）',
  );
  const first = b43.takeSkippedKb(G43);
  check(first.includes('住东京'), '★★ 取得到（补库要用它）');
  check(b43.takeSkippedKb(G43) === '', '★★★ 取过一次就清空（不会反复补同一份）');
}

console.log('\n【44】★★★ 起因里的「铁律」是给编故事的，不是给角色的（2026-10-09 用户：「一定要去找房子的破绽，而不是按房子所说的做」）');
{
  // ## 用户报的
  //   「最近开的那个剧情一直都不能跟着剧情开场词走，一定要去找房子的破绽，
  //     而不是按房子所说的做，我已经加强几遍开场词了，还是那样」
  //   他那条起因里明明写着：
  //     「还有一道铁律：禁止对房子的结构进行研究和破坏，否则会马上爆炸，
  //       只能按照房子的说法行动，门才会开」
  //   可剧情一直去研究房子 —— 他被迫**手动干预三次**（「不能再花时间研究房子了」
  //   「房子出现倒计时」「所有对房子的操作都没用」）。
  //
  // ## 根因（不是"措辞不够强"）
  //   用户写的铁律是**给写戏的人看的** ⇒ 角色**不该知道**它、更不该去试探它；
  //   可模型读成了"剧情内的设定" ⇒ "角色不知道这条规则，所以可以试着试探" ✗
  //   而"找破绽"恰恰是模型写戏时最自然的推进方式 ✗
  // ⇒ 所以要把它**单独拎出来**、写明"这是给你的，不是给角色的" ✓
  const quest44 = await import('../src/quest.js');
  const qsrc44 = readFileSync(join(ROOT, 'src', 'quest.js'), 'utf8');

  const p44 =
    '爱音和祥子进入了一个不出的房间，门也是锁死的，而且还有一个10分钟倒计时。' +
    '还有一道铁律：禁止对房子的结构进行研究和破坏，否则会马上爆炸，只能按照房子的说法行动，门才会开。';
  const rules44 = quest44.ironRules(p44);
  check(rules44.length >= 1, `★★★ 抽得出「铁律句」（${rules44.length} 条）`);
  check(
    rules44.some((r) => /禁止对房子的结构/.test(r)),
    '★★★ 截图那条（「禁止对房子的结构进行研究和破坏」）必须抽到',
    JSON.stringify(rules44),
  );
  check(quest44.ironRules('今天天气不错，她们在屋里聊天。').length === 0, '★★ 没有铁律的起因 ⇒ 抽不出东西（别硬造）');

  check(
    /是"铁律"—— 是给你（写戏的人）的硬约束，/.test(qsrc44),
    '★★★ `chatBrief` 里钉了"**这是给你的硬约束，不是给角色的设定**"',
  );
  check(
    /不许写"她们去试探 \/ 研究 \/ 破坏它"/.test(qsrc44),
    '★★★ 并且明说**不许写试探性动作**（敲墙/看门缝/翻柜子/按一按/找缝）',
  );
  check(
    /起因里的"铁律"是给你的硬约束，不是给角色的设定/.test(qsrc44),
    '★★★ 推进那一段（`advance`）也钉了同一条（两边口径必须一致）',
  );
}

console.log('\n【45】★★★ `/清除剧情` 要连「她自己的话」一起清（2026-10-09 用户：「聊天记录的上下文还是不会清」）');
{
  // ## 用户报的
  //   「现在 `/清除剧情` 只会清故事线里的内容，聊天记录的上下文还是不会清，这个可以解决吗」
  // ## 查出来的
  //   代码**确实在清** `recent`（`recent.dropWindow`），但 `uids` 里只传了
  //   `selfId`（**QQ 号**）+ 同类池的号 —— 而她自己在 `recent` 里的 `userId` 是
  //   **`'__self__'`** ⇒ **永远匹配不上** ⇒ **她自己的台词一条都没被清** ✗
  //   （她那一刻看到的：清了 3 条同类的话，可她自己的全程留着 —— 表现就是"没清"）
  //   ⚠️ 实证：清出来的残留里就有「行吧，那我回教室了，下午还有课」「上课了」，
  //     而"回去上课"正是用户之前报过的那个穿帮 ✗（同一个根因）
  // ## 另外
  //   **每个账号有自己的 `recent.json`**（`state/accounts/<QQ>/recent.json`）——
  //   两个进程各自收到 `/清除剧情`、各自清自己那份 ⇒ 机制上能覆盖两边 ✓
  const src45 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');

  check(
    /String\(this\.selfId \?\? config\.botQQ \?\? ''\),[\s\S]{0,600}?'__self__',/.test(src45),
    '★★★ `/清除剧情` 的 `uids` 里必须有 `\'__self__\'` —— ' +
      '她自己的发言在 `recent` 里存的是这个，只传 QQ 号永远清不掉 ✗',
  );
  check(/清掉上一段的聊天残留/.test(src45), '★★★ 开新剧情时也会自动清一次上一段的残留（不用手动 /清除剧情）');
  check(
    /只清\*\*那两个号\*\*说的话，真人发言一条不动/.test(src45),
    '★★ 而且只清那两个号（真人发言不许动）',
  );
}

console.log(
  '\n【46】★★★ 切人设只改「当前这个号」，而且日志要留下**能查到的**落点' +
    '（2026-10-09 用户：「主号改回Saki，而且不是我改的，查一下怎么变得」）',
);
{
  // ## 用户报的
  //   「主号改回Saki，而且不是我改的，查一下怎么变得」
  // ## 查出来的（有日志证据）
  //   `logs/bot-2026-10-09.log` 13:49:42 界面上点了「切到这个」⇒
  //   `persona` **不在 `SHARED_SECTIONS` 里** ⇒ 走 `splitPatch` 被当成"这个号私有"
  //   ⇒ 写进 `accounts/<当前号>.yml`，**config.yml 一个字没动**。
  // ⇒ 而那条"谁改了人设"的日志打的是 `CONFIG_FILE`（config.yml）
  //   ⇒ 照它去翻**必然扑空**（我真扑了）✗
  // ## 修法
  //   ① 在 `splitPatch` **之前**记下 `personaPatch`（patch 会被摘过一遍）；
  //   ② 日志打**真实落点**；③ 接口把落点返回给界面；④ 界面上加二次确认。
  const src46 = readFileSync(join(ROOT, 'src', 'webui.js'), 'utf8');
  check(
    /personaPatch/.test(src46) &&
      /accounts\.has\(ACCOUNT\.id\) \? accounts\.fileOf\(ACCOUNT\.id\)/.test(src46),
    '★★★ `persona` 的写入日志要打**真实落点**（账号私有文件），不能用 `CONFIG_FILE` —— ' +
      '打错文件会让"主号怎么变成别人的人设了"查不到 ✗',
  );
  check(/wrote,/.test(src46), '★★ 切换接口要把落点回给界面（不然看不出"只改了这一个号"）');
  const html46 = readFileSync(join(ROOT, 'src', 'webui.html'), 'utf8');
  check(
    /if \(!confirm\(/.test(html46),
    '★★★ 界面上「切到这个」必须有二次确认 —— 误点一下人格当场就换了，而且没有撤销 ✗',
  );
  check(
    /只影响\*\*当前正在控制的这个号\*\*/.test(html46),
    '★★ 确认框里要写明**只影响当前这一个号**（别的号不变）',
  );
}

console.log('\n【47】★★★ 回归套件的日志不许灌进真实的按天日志（2026-10-09 踩了）');
{
  // ## 我踩的
  //   查「主号人设被改」时，`logs/bot-2026-10-09.log` 里满屏重复九次的
  //   「不回复的机器人名单」，外加 `999000098` / `10000020` 这些**假号** ——
  //   我差点判成"机器人在崩溃重启循环"（差点让用户白紧张一场）。
  // ## 根因
  //   `src/log.js` 的隔离判据是"配置名里含 test"，而 `test/run-all.js`
  //   **故意不动 `QQBOT_CONFIG`**（指向不存在的文件会让 config.js 拿不到配置）
  //   ⇒ 套件里 `spawn` 的真机器人用的还是 `config.yml` 这个名字 ✗
  // ## 修法
  //   加一个**显式**的 `QQBOT_LOG_FILE`（优先于一切猜测），由 run-all 注入。
  const src47 = readFileSync(join(ROOT, 'src', 'log.js'), 'utf8');
  check(
    /process\.env\.QQBOT_LOG_FILE/.test(src47),
    '★★★ `src/log.js` 要认 `QQBOT_LOG_FILE`（显式指定，优先级最高）',
  );
  check(
    /QQBOT_LOG_FILE\) return join\(ROOT/.test(src47),
    '★★ 而且它要**排在**"按配置名猜"那条判据前面（否则等于没加）',
  );
  const run47 = readFileSync(join(ROOT, 'test', 'run-all.js'), 'utf8');
  check(/QQBOT_LOG_FILE: `logs\/__run-/.test(run47), '★★★ `run-all.js` 要给每个套件注入独立的日志文件');
}

console.log(
  '\n【48】★★★ 剧情进行中也不许接「不同类机器人」的话' +
    '（2026-10-09 用户：「不同类机器人不回话这道闸失效了」）',
);
{
  // ## 用户报的
  //   「不同类机器人不回话这道闸失效了」
  // ## 查出来的（有日志实证，群 200000001 今天 13:12:41）
  //   `[收到·主动/@] Alone゜独白ぴ（helps菜单）：嗯，那正好。`
  //   → `[同类] 剧情进行中 → **这条我接**`
  //   可那个号**就在落盘的不回复名单里**（启动日志每次都打它）。
  //   真因：那条"剧情里我接"的快速通道在 `message_type === 'group'` 的块里
  //   （**不限同类**），只看"剧情在演 + 没 @ 我"，**没问发送者是谁**；
  //   而总闸 `isIgnoredBotEvent()` 在 `decide()` 很后面 ⇒ 一 return 就绕过去了 ✗
  // ## 修法
  //   ① 那条通道加上 `!this.isIgnoredBotEvent(event)`（对同类池的号它返回 false，
  //      不会误伤自己人）；② 落盘名单的比对加"核心名"一层 —— 名单里存的是
  //      `Alone゜独白ぴ（helps菜单）` 这种**完整昵称**，对方改个后缀就静默失效了。
  const src48 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    // ⚠️ 2026-10-09：中间又插了 `!this.peersHeadsToHuman(event)`（见【55】）⇒
    //    不能再要求两者**相邻**，改成"两个判据都在那条通道里"就行 ✓
    /this\.questLive\(gid0\)[\s\S]{0,300}?!this\.isIgnoredBotEvent\(event\)/.test(src48),
    '★★★ 「剧情进行中 → 这条我接」的快速通道必须过 `isIgnoredBotEvent()`' +
      '（不然剧情一开，不同类机器人那道闸就等于不存在 ✗）',
  );
  check(
    /nc === core\(bs\)/.test(src48),
    '★★★ 落盘的不回复名单要按**核心名**比对（去掉括号后缀）—— ' +
      '精确比对对方改个群名片就静默失效 ✗',
  );
  check(
    !/this\.ignoreBots\?\.has\(name\)/.test(src48),
    '★★ 旧的"完整昵称精确比对"要换掉（留着就是那个静默失效的隐患）',
  );
  // 闸门只加到"剧情"那条通道上还不够 —— 它必须**仍然**在最前面的总闸里
  check(
    /if \(this\.isIgnoredBotEvent\(event\)\) \{/.test(src48),
    '★★★ `decide()` 里那道总闸还在（`isIgnoredBotEvent` 仍然被调用）',
  );
}

console.log(
  '\n【49】★★★ 提示词「固定的排前面、每轮会变的排最后」' +
    '（2026-10-09 用户：「跑了一段时间剧情，可以对比出 token 花销数据变化了」）',
);
{
  // ## 查出来的（`state/spend.json` + 日志）
  //   主号 10-07：缓存命中 50.4% / 每次 ¥0.0132
  //   主号 10-09：缓存命中 **32.4%** / 每次 **¥0.0264**（用户说「感觉烧得更快」）
  //   根因：`chatBrief`（里面带"你们刚说过的 6 句"，**每轮都在变**）被插在
  //   **人设正文（四万字）之前** ⇒ 提示词前缀每轮都不一样 ⇒ 大模型的**上下文缓存
  //   整段失效** ✗ 缓存按**前缀**匹配：前面一变，后面几万字全部按全价重算。
  // ## 修法
  //   把"每轮会变"的两段（剧情起因 + 刚说过的几句、清剧情的作废窗口）挪到
  //   `parts` 的**最末尾**（人设正文之后）。内容一个字没改，只是换了位置。
  const src49 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const iPersona = src49.indexOf('以下是人格设定与知识库');
  const iBrief = src49.indexOf('const brief = quest.chatBrief');
  check(iPersona > 0 && iBrief > 0, '★ 两处都在（人设正文的标题 / 剧情起因那一段）');
  check(
    iBrief > iPersona,
    '★★★ 「刚说过的几句 + 剧情起因」（每轮都变）必须排在**人设正文之后** —— ' +
      '排在前面会让上下文缓存整段失效、每次单价翻倍 ✗（10-09 实测：50.4% → 32.4%）',
  );
  check(
    /thinking: \{ type: 'disabled' \},\s*\}\)\) full2 \+= delta;/.test(src49),
    '★★★ 空内容重试要**关掉思考链** —— 第一次空回基本都是思考链吃满 8000 token，' +
      '不关的话重试大概率还是空（10-09 一整天白跑 8 次）✗',
  );
}

console.log(
  '\n【50】★★★ 剧情进行中不带给思考链' + '（2026-10-09 用户：「指定只关剧情下的思考链」）',
);
{
  // ## 用户拍板的
  //   「只关剧情下的思考链」—— 日常闲聊照旧带（他 2026-10-07 说过「直接调回思考链」）。
  // ## 为什么挑剧情
  //   剧情对戏是**刷屏最多**的场景；思考链又**不受 `budget_tokens` 约束**
  //   （设 3000 照样烧满 8000，日志 8 次 `其中思考链吃了 8000 token` 全是它）⇒
  //   这一档关掉省得最多，而它不是解难题、对那层推敲的依赖最低。
  const src50 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    /const thinkOffInQuest = \(\(\) => \{/.test(src50) &&
      /if \(fromPeer && thinkOffInQuest\) return th\.questPeer !== false/.test(src50),
    '★★★ 剧情进行中（`questLive`）+ 对方是同类 ⇒ 默认**不带思考链**' +
      '（关卡挂在 `llm.thinking.questPeer`，可在模型页改）',
  );
  check(
    /this\.questLive\(String\(event\?\.group_id \?\? ''\)\)/.test(src50),
    '★★ 判据要用 `questLive()`（让位的那个号自己没有剧情状态，只认 `quest.current` 会漏）',
  );
  check(
    /th\.peer !== false/.test(src50) && /th\.quest === true/.test(src50),
    '★★ 三档各有默认：**机器人之间关**、**剧情里和真人开**（其余日常闲聊照旧带思考链）',
  );
}

console.log(
  '\n【51】★★★ 回归的探针不许抢真实的管理界面端口' +
    '（2026-10-09 用户：「http://127.0.0.1:3099 为什么打不开了」）',
);
{
  // ## 用户报的
  //   「3099 为什么打不开了」 —— 日志里是 `管理界面端口 3099 被占用`。
  // ## 查出来的
  //   占它的**不是别的软件，是我自己**：`test/run-all.js` 的隔离 env 只管
  //   状态文件 / 单例锁 / 账号目录 / 日志，**没有一条管 webui 端口** ⇒
  //   套件里 `spawn(node, [src/index.js])` 的探针按真实配置去绑 3099；
  //   探针先绑上时，真实机器人一重启就绑不上 ⇒ 用户的管理界面没了 ✗
  //   （按天日志「端口被占用」次数：10-05 210 次、10-07 198 次、10-09 97 次 —— 一直是它。）
  // ## 修法
  //   ① `src/config.js` 认 `QQBOT_WEBUI_PORT`（给了正数才顶掉）；② run-all 给每个套件发一个。
  const cfg51 = readFileSync(join(ROOT, 'src', 'config.js'), 'utf8');
  check(
    /process\.env\.QQBOT_WEBUI_PORT/.test(cfg51),
    '★★★ `src/config.js` 要认 `QQBOT_WEBUI_PORT`（管理界面端口能被测试顶掉）',
  );
  check(
    // ⚠️ 这一条是**被 `accounts` 套件教出来的**：第一版我写成"有 env 就无条件顶掉"，
    //    `accounts` 立刻红两项 —— 它给自己两个号显式配的 39601 / 39602 被顶成了别的端口，
    //    于是连不上自己刚起的进程 ✗ ⇒ 判据必须是"**只有走默认端口时**才顶"。
    /const useDefaultPort = [\s\S]{0,140}?rawUiPort === 3099/.test(cfg51) &&
      /envUiPort > 0 && useDefaultPort/.test(cfg51),
    '★★★ 只在"配置里没写端口、就是默认 3099"时才顶掉 —— ' +
      '套件自己显式配的端口（`accounts` 的 39601 / 39602）优先级更高，不能被顶 ✗',
  );
  const run51 = readFileSync(join(ROOT, 'test', 'run-all.js'), 'utf8');
  check(
    /QQBOT_WEBUI_PORT:/.test(run51),
    '★★★ `run-all.js` 要给每个套件注入一个独立的管理界面端口（不然探针还去抢 3099）',
  );
  check(/39100 \+/.test(run51), '★★ 而且是错开的高位端口，不是一个固定值');
}

console.log(
  '\n【52】★★★ 三类对话关思考链的开关（模型页 · 共用段 · 默认值）' +
    '（2026-10-09 用户：「把机器人互相对话的思考链也关掉…做成开关…放在模型页，' +
    '控制所有账号，默认机器人互相对话和剧情内机器人互相对话关思考链，其他打开」）',
);
{
  const b = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    /config\.llm\?\.thinking/.test(b),
    '★★★ 开关读 `config.llm.thinking` —— `llm` 是**共用段** ⇒ 天然"控制所有账号"',
  );
  check(
    /if \(fromPeer && thinkOffInQuest\) return th\.questPeer !== false/.test(b),
    '★★ 剧情里和同类对戏 ⇒ 默认**关**（questPeer）',
  );
  check(/if \(fromPeer\) return th\.peer !== false/.test(b), '★★ 机器人之间的日常聊天 ⇒ 默认**关**（peer）');
  check(
    /if \(thinkOffInQuest\) return th\.quest === true/.test(b),
    '★★ 剧情里和真人 ⇒ 默认**开**（quest 没配就是开）',
  );
  check(
    /isPeerBot\(String\(event\?\.group_id/.test(b),
    '★ 判"是不是机器人之间"用 `isPeerBot()`，不是靠昵称猜',
  );
  const h = readFileSync(join(ROOT, 'src', 'webui.html'), 'utf8');
  for (const id of ['llm-thinkPeer', 'llm-thinkQuestPeer', 'llm-thinkQuest']) {
    check(h.split(id).length - 1 >= 3, `★★ 模型页里「${id}」表单 + 回填 + 保存三处配套`);
  }
  check(
    /thinking: \{[\s\S]{0,200}?peer: !!/.test(h),
    '★★ 保存时三个开关**都显式写**（省略 = 用户关不掉，和 slowQueueDrop 那条同理）',
  );
}

console.log(
  '\n【53】★★★ 「@ 的是同类」不能被当成「@ 我」' +
    '（2026-10-09 用户：「@白祥会把黑祥也叫起来」）',
);
{
  const s53 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    /textAtOf\(text, segs = \[\], groupId = ''\)/.test(s53),
    '★★★ `textAtOf()` 收群号（要靠它查"同类池里有没有人叫这个名字"）',
  );
  check(
    /for \(const t2 of this\.atTargetsOf\(String\(groupId \?\? ''\)\)\)/.test(s53),
    '★★★ 先查同类池的名字 ⇒ 有、且不是我 ⇒ 判成"@ 别人"',
  );
  check(
    /lower === String\(k\)\.toLowerCase\(\)/.test(s53),
    '★★ 而且用**精确相等** —— `includes` 会让"@saki酱"又命中 "saki"',
  );
  check(
    /this\.textAtOf\(realText, segs, String\(event\?\.group_id \?\? ''\)\)/.test(s53),
    '★★ 调用点把群号传进去了',
  );
  check(
    /const selfNames = persona\.selfNames\(\)/.test(s53),
    '★ selfNames 那条兜底还在（"@小祥"这种简称照旧认）',
  );
  // ⚠️ 本机是**主号**视角：`@saki酱saki酱saki酱` 就是它自己 ⇒ 仍判"@ 我"（别把正路修反了）
  const b53 = new Bot();
  b53.selfId = '10000002';
  check(
    b53.textAtOf('@saki酱saki酱saki酱 发张以前的', [], '200000001') === '',
    '★★ 主号视角照旧：`@saki酱saki酱saki酱` 仍然算"@ 我"（不回归）',
  );
  // ⚠️⚠️ 2026-10-09 用户报「@别人时不接话的闸失效了」—— 真漏洞在这里：
  //    原来只认**消息开头**那个 @，可群里最常见的是「XX @某人 你说呢」（@ 在中间）✗
  check(
    b53.textAtOf('你看 @<主人> 给个服世界地图', [], '200000001') === '<主人>',
    '★★★ @ 在**中间**也要认出来（原来只认开头那个 @ ⇒ 闸等于没走到）',
  );
  check(
    b53.textAtOf('a@b.com 这个邮箱', [], '200000001') === '',
    '★ 但邮箱里的 @ 不算（`@` 前面是字母/数字 ⇒ 跳过）',
  );
}

console.log(
  '\n【54】★★★ 不同类机器人池：**保存了必须读得回来**' +
    '（2026-10-09 用户：「不同类机器人池为什么保存不了」）',
);
{
  // ## 用户报的
  //   「不同类机器人池为什么保存不了？」—— 界面上填了、点了保存，回来还是空的。
  // ## 查出来的（实测复现）
  //   保存**是成功的**：账号文件里写进去了（日志也有 `配置写入账号私有文件：groupParams`）。
  //   但 `config.js` 规范化 `groupParams` 那一段**只收了 `peers`**，**`otherBots` 压根没合并** ✗
  //   ⇒ `reloadConfig()` 之后内存里没有它 ⇒ ① 界面回读空、② `otherBotsFor()` 返回空
  //     ⇒ **"完全不回应"那道闸等于一直没配** ✗
  const cfgSrc = readFileSync(join(ROOT, 'src', 'config.js'), 'utf8');
  check(
    /if \(Array\.isArray\(v\.otherBots\)\)/.test(cfgSrc) && /one\.otherBots = otherBots/.test(cfgSrc),
    '★★★ `config.js` 合并时必须把 **otherBots** 也收进来 —— 漏了它就是"存得进、读不回" ✗',
  );
  check(
    /if \(Array\.isArray\(v\.peers\)\)/.test(cfgSrc) && /one\.peers = peers/.test(cfgSrc),
    '★ `peers`（同类池）那段当然还在（两个池子要一起管）',
  );
  // 两个池子各自独立（别又把其中一个写串）
  const c = { groupParams: { '999000001': { peers: ['10000001'], otherBots: ['10000002'] } } };
  check(
    /seenO/.test(cfgSrc) && /seen\b/.test(cfgSrc),
    '★ 去重用的是两个各自独立的 Set（`seen` / `seenO`），不会互相干扰',
  );
  void c;
}

console.log(
  '\n【55】★★★ 「同类在跟真人说话」时不许被另一个号抢过去接' +
    '（2026-10-09 用户截图：<主人> `@主号 解题`，**爱音却把主号那句回答接了**）',
);
{
  // ## 怎么发生的
  //   <主人> @ 主号 ⇒ 主号答「解题可以，题呢…」（**它在回真人**，带引用 `<主人>`）；
  //   而另一条通道「剧情进行中 + 对方是同类 ⇒ 直接放行」**只看对方是不是同类** ⇒
  //   爱音把主号那句**抢过来接了** ✗
  // ## 修法
  //   同类那句话**带引用 / @ 别人** ⇒ 它在跟真人对答 ⇒ 不接 ✓
  //   （剧情里两个号对戏通常不带这两样，所以不受影响 ✓）
  const b55 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(/peersHeadsToHuman\(event\) \{/.test(b55), '★★★ 有"同类在跟真人说话"这个判据（引用 / @ 别人）');
  check(
    (b55.match(/!this\.peersHeadsToHuman\(event\)/g) || []).length >= 2,
    '★★★ 两条"剧情中同类直接放行"的通道**都**加了这道（漏一条就还漏一半）',
  );
  check(
    /s\.type === 'at' && s\.data\?\.qq !== 'all'/.test(b55),
    '★★ 判据只认「**@ 别人**」（`reply` 那半暂时不认 —— 见 bot.js 里那段"连试两版都碰红"的注释）',
  );
}

console.log(
  '\n【56】★★★ 「回服务器消息」那个开关要**真正管住服务器话题**' +
    '（2026-10-09 用户：「爱音的账号已经关闭了回复服务器的内容，但是还是回复了」）',
);
{
  // ## 用户报的
  //   爱音那边 `groupParams['200000001'].chat.answerServer = false`（配置文件里确认过），
  //   可她还是答了「为什么最新的整合包一进服务器就崩溃呀」✗
  // ## 真因
  //   那道闸判的是 `shouldQueryStatus()` —— 它**只认"有人吗 / 几个人 / 谁在线 / 关键词表"**，
  //   而"整合包一进服务器就崩溃"一条都不命中 ✗
  //   ⇒ 开关写着"回服务器消息"，实际只关得住"问在线人数" ⇒ 语义对不上 ✓
  // （对照：同一天 20:42 那次"服务器问题"确实被拦了 —— 说明闸在，只是口径太窄。）
  const b56 = new Bot();
  for (const [t, want] of [
    ['为什么最新的整合包一进服务器就崩溃呀', true],
    // ⚠️ 注意：别把「服务器现在有人吗」放进这个列表 —— 它走的是 `shouldQueryStatus()`，
    //    而那条**要求 `config.status.host` 有值**；测试环境里默认是空的 ⇒ 会假红 ✗
    ['整合包怎么装', true],
    ['服务器延迟高怎么办', true],
    ['我刚在服务器里挖了个洞', false],
    ['今天天气不错', false],
  ]) {
    check(b56.looksServerTalk(t) === want, `「${t}」→ ${want ? '算服务器消息（该拦）' : '不算（别误伤）'}`);
  }
  const src56 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    /this\.looksServerTalk\(plain\)/.test(src56),
    '★★★ 那道闸用的是**新判据**（原来只认"有人吗/几个人/谁在线"）',
  );
}

console.log(
  '\n【57】★★★ 电量 = 生命值（分档 / 劫后余生 / 同类配合）' +
    '（2026-10-09 用户：「把电池电量设计为机器人的生命值…电量越低语气要更重，' +
    '其他机器人也要配合演出」「复原的语气要和死里逃生一样，而不是化解一般般的困难比如考试之类」）',
);
{
  const bl = await import('../src/battery-life.js');
  // ⚠️ 2026-10-09 档位按用户改过的口径（0-20 濒死 / 20-40 很低 / 40-50 偏低 / >50 正常）——
  //    原话：「因为笔记本的电池一般都不行」✓
  for (const [p, ch, want] of [
    [80, false, 'ok'],
    [65, false, 'ok'],
    [55, false, 'low'],
    [45, false, 'low'],
    [30, false, 'critical'],
    [20, false, 'dying'],
    [12, false, 'dying'],
    [3, false, 'dying'],
    [30, true, 'charging'],
  ]) {
    check(bl.levelOf({ percent: p, charging: ch }) === want, `${p}% charging=${ch} → ${want}`);
  }
  const src57 = readFileSync(join(ROOT, 'src', 'battery-life.js'), 'utf8');
  check(
    /劫后余生/.test(src57) && /绝不许/.test(src57),
    '★★★ 复原那段写明是**劫后余生**，并明确**禁止**说成小事',
  );
  check(/考试/.test(src57), '★★ 而且把用户点名的反例（"考试没考好"那种）直接写进去了');
  check(
    /一直没说的，现在是说的时候/.test(src57),
    '★★ 同类配合：对"随时会黑"的那个号说点平时不说的（用户要的演出）',
  );
  const bot57 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    /batteryLife\.guide\(/.test(bot57) && /batteryLife\.publish\(/.test(bot57),
    '★★★ 提示词里真的接了（自己的档 + 把自己的档写进共享文件给同类看）',
  );
}

console.log(
  '\n【58】★★★ config.yml 变动监听：一次保存、**多账号各自重载**' +
    '（2026-10-10 用户：「能不能模型界面两个界面是同时保存的」）',
);
{
  const cfgSrc58 = readFileSync(join(ROOT, 'src', 'config.js'), 'utf8');
  const idxSrc58 = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8');
  check(/export function watchConfigFile\(/.test(cfgSrc58), '★★★ `config.js` 里有 `watchConfigFile()`');
  check(
    /watchFile\(CONFIG_FILE/.test(cfgSrc58),
    '★★ 用的是 `watchFile`（轮询）—— 保存是"写 tmp + rename 覆盖"，`fs.watch(文件)` 在 Windows 上会失效 ✗',
  );
  check(
    /sw\.unref\?\.\(\)/.test(cfgSrc58),
    '★★ 轮询 `unref()` 了 —— 不然会把测试进程吊着不退（套件跑不完）',
  );
  check(
    /cur\.mtimeMs === prev\.mtimeMs && cur\.size === prev\.size/.test(cfgSrc58),
    '★ 只认"内容真的变了"（mtime + size 一起变），免得 stat 抖动白重载',
  );
  check(
    /watchConfigFile\(\(fresh, err\)/.test(idxSrc58),
    '★★★ `index.js` 启动时**真的挂了它**（只定义不调用 = 白做）',
  );
}

console.log(
  '\n【59】★★★ 日常聊天剥掉「（动作旁白）」，剧情里保留' +
    '（2026-10-10 用户截图：「日常聊天不要带这些，只有剧情需要带一点」）',
);
{
  const { stripBracketAct } = await import('../src/bot.js');
  check(
    stripBracketAct('（顿了顿）。祥祥，你先说，那个人的消息我可不管') ===
      '祥祥，你先说，那个人的消息我可不管',
    '★★★ 日常：剥掉「（顿了顿）」、**正文留下**（不整条丢）',
  );
  check(
    stripBracketAct('（没退开，眼睛还半垂着）。……谢什么呀') === '……谢什么呀',
    '★★ 神态描写同样剥掉（截图里那两句就是这两种）',
  );
  check(stripBracketAct('（笑）') === '', '★★ 整条只剩旁白 ⇒ 空串（调用方据此**不发**）');
  check(
    stripBracketAct('（那是在回大豆，不用我应）') === '',
    '★★★ **整条就是一句旁白 ⇒ 不发**（用户截图：黑祥把内部判定说出来了 —— ' +
      '上一版会把它剥成"那是在回大豆，不用我应"，括号一去看着就像台词了 ✗✗）',
  );
  check(stripBracketAct('（她问的是大豆，跟我没关系）') === '', '★★ 同上（另一句）');
  check(
    stripBracketAct('（顿了顿）。祥祥，你先说，那个人的消息我可不管') ===
      '祥祥，你先说，那个人的消息我可不管',
    '★ 括号在前、后面有正文 ⇒ **剥括号留正文**（这条别被上一条弄坏）',
  );
  check(stripBracketAct('我这儿正忙着呢') === '我这儿正忙着呢', '★ 没括号 ⇒ 原样返回（不动正常话）');
  check(stripBracketAct('（这是口癖') === '这是口癖', '★ 不成对的半括号也清掉（有人拿「（」当口癖）');
  const bsrc59 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    (bsrc59.match(/stripBracketAct\(/g) || []).length >= 3,
    '★★★ 接线**两处真实出口都挂了**（`sendText` 主聊天 + `sendChatLike` 剧情/事件/搭话）',
  );
  check(
    /!this\.questLive\(String\(event\.group_id\)\)/.test(bsrc59) &&
      /!this\.questLive\(String\(groupId \?\? ''\)\)/.test(bsrc59),
    '★★ 判据是 `questLive`：**日常剥、剧情保留**（用户：「只有剧情需要带一点」）',
  );
}

console.log(
  '\n【60】★★★ 「服务器重新开启 → @ 他」订阅' +
    '（2026-10-10 用户：「如果有人 @bot 让她在服务器重新开启的时候提醒一下、@他，可以做到吗」' +
    ' ⇒ 拍板：谁都能挂、一直有效直到触发）',
);
{
  const sw = await import('../src/server-watch.js');
  const { Bot: BotW } = await import('../src/bot.js');
  const GW = '999000906';
  sw.__reset({ subs: [] });
  check(sw.subscribe(GW, '10000001', '甲') === true, '★ 能挂订阅');
  check(sw.list().length === 1, '★ 落盘列表里有 1 条');
  check(
    sw.subscribe(GW, '10000001', '甲') === true && sw.list().length === 1,
    '★★ 同一个人重复挂 ⇒ **覆盖**（不叠加 —— 免得一次开服 @ 他五遍）',
  );
  sw.subscribe(GW, '10000002', '乙');
  check(sw.list().length === 2, '★ 另一个人是另一条');
  const taken = sw.takeAll();
  check(taken.length === 2, '★★ 服务器恢复 ⇒ **取走全部**');
  check(sw.list().length === 0, '★★ 取走即清空（提醒是**一次性**的）');
  check(/服务器开了/.test(sw.textFor({ name: '甲' }, { online: 3, max: 20 })), '★ 文案里有"服务器开了"');
  check(/在线 3/.test(sw.textFor({ name: '甲' }, { online: 3, max: 20 })), '★ 顺手带上在线人数');
  check(
    sw.textFor({ name: '甲' }, { online: 0 }).includes('还没人'),
    '★ 没人在线时换个说法（不报"在线 0 人"这种怪话）',
  );

  // 命令识别（行为；`sendToGroup` 打桩，别真往群里发）
  const bW = new BotW();
  bW.selfId = '10000002';
  bW.sendToGroup = async () => {};
  const mk = (t) => ({
    message_type: 'group',
    group_id: GW,
    user_id: '10000003',
    message_id: 1,
    self_id: '10000002',
    message: [{ type: 'text', data: { text: t } }],
    sender: { nickname: '甲' },
  });
  sw.__reset({ subs: [] });
  const evW = mk('服务器重新开启的时候提醒我一下');
  check(bW.tryServerWatch(evW, evW.message) === true, '★★★ 「服务器重新开启的时候提醒我一下」→ **挂上**');
  check(sw.find(GW, '10000003') !== null, '★★ 没 @ 别人时，提醒的是**说这句话的人**');
  const evW2 = mk('服务器卡不卡');
  check(
    bW.tryServerWatch(evW2, evW2.message) === false,
    '★★ 单纯问状态**不挂订阅**（那种走实查 —— 两条路别混）',
  );
  sw.__reset({ subs: [] });
}

console.log(
  '\n【61】★★★ 备选模型失败 ⇒ **自动回主模型重跑一次**' +
    '（2026-10-10 用户拍板选 B —— 3.5 Flash Lite 免费层 TPM 只有 250K，' +
    '而机对机提示词 6~7 万字，一次就吃掉 15%）',
);
{
  const bsrc61 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    /else if \(bkAny\)/.test(bsrc61) && /没配备选模型/.test(bsrc61),
    '★★★ **双向兜底**：备选失败 → 回主模型；主模型失败 → **切备选顶上**；' +
      '没配备选 ⇒ 照旧抛（真故障不吞）',
  );
  check(/自动切备选模型顶上/.test(bsrc61), '★★ 主模型挂了会切备选（日志里看得见）');
  check(
    /const noThink = \{ \.\.\.solveOpts \};\s*\n\s*delete noThink\.thinking;/.test(bsrc61),
    '★★ 切备选前**现删 `thinking`**（Gemini 不认 DeepSeek 那个字段，会 400）',
  );
  check(
    /const bkAny =\s*\n\s*bkCfg\.baseURL && bkCfg\.model/.test(bsrc61),
    '★★ 兜底**不受 `for.*` 三个勾管** —— 那是"主动想用才用"，这是"保险"',
  );
  check(/full = '';\s*\n\s*buffer = '';/.test(bsrc61), '★★ 重跑前**清掉第一次的半截输出**（否则两份正文会拼在一起）');
  check(
    /\.\.\.solveOpts,\s*\n\s*report: solveReport,/.test(bsrc61),
    '★★ 重跑用 `solveOpts`（主模型该带 thinking）—— 不是 `genOpts`（那个把 thinking 删了）',
  );
}

console.log(
  '\n【62】★★★ 同一条**真人**消息只让一个号接' +
    '（2026-10-10 用户拍板选 C —— 大豆说「你啥时候回来」，两个号都引用它回）',
);
{
  const { pickPeerIndex } = await import('../src/bot.js');
  const bsrc62 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(/export function pickPeerIndex\(text, n\)/.test(bsrc62), '★★★ 有确定性选号的公式');
  check(
    pickPeerIndex('999000907|10000001|你啥时候回来', 2) ===
      pickPeerIndex('999000907|10000001|你啥时候回来', 2),
    '★★★ 同一条消息 ⇒ **永远同一个结果**（两台机器各算一次必须一样）',
  );
  const many = new Set();
  for (let i = 0; i < 50; i++) many.add(pickPeerIndex(`999000907|10000001|消息${i}`, 2));
  check(many.size === 2, '★★ 不同消息能分到两边（不会永远只让同一个号接、另一个变哑巴）');
  check(
    /pick !== idx/.test(bsrc62) && /轮到 .* 先接/.test(bsrc62),
    '★★ 没轮到的那个**让位**（`return null`），轮到的正常接',
  );
  check(
    /if \(this\.peersHeadsToHuman\(event\)\) \{\s*\n\s*log\.info\('\[让位\]/.test(bsrc62),
    '★★ @ 的是别人 ⇒ **这条路上也不接**（那个判据原来只挂在剧情路）',
  );
  check(
    !/Math\.random\(\)[\s\S]{0,120}?pickPeerIndex/.test(bsrc62),
    '★ 公式里**不许出现随机** —— 两台机器要算出同一个（随机就会一起抢或一起哑）',
  );
  check(
    /recent\.messagesSinceBotLast\(String\(event\?\.group_id \?\? ''\)\)/.test(bsrc62) &&
      /if \(sinceBot > 1\)/.test(bsrc62),
    '★★★ **"中间还夹着别人"就不算对话延续**（用户：「这哪是对话延续，就是突然接的」）—— ' +
      '原判据只看 isSamePerson + 他刚说话，完全没管有人插过话 ✗',
  );
}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
