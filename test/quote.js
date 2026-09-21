/**
 * 「引用」的两条新规矩（2026-09-15 晚 <主人> 提的）。
 *
 * ## 用户原话
 *
 * ① 「**引用但是没有 @ 机器人应该也要直接回话**」
 *    —— 真人聊天里"引用他上一句"和 @ 他是一回事，都是在对他说话。
 *       以前只认 @：所以"引用她但没 @"这种最明确的召唤被当成普通群聊，
 *       掉到主动接话那条路（要过 speak-judge、还会被触发冷却挡），经常就静默了。
 *
 * ② 「如果检测到机器人自己发出的话距离要回复的那条消息已经**间隔 4 条以上**，
 *     就要**引用那条正在回复的消息**，**这就是引用最有用的时候**」
 *    —— 间隔大了，群里的人根本看不出她在答哪一句。
 *
 * ③ 「但是**除了引用不要加 @**，会有点吵」
 *    —— 所以：引用归引用，**不许再补一个 @**（这条在下面用源码断言盯着）。
 *      ⚠️ **唯一例外：余额见底（<2 元）那条提醒照旧 @ 服主** ——
 *         用户明确说「@我充值的不要改」，所以这里也断言它**没被动过**。
 *
 * ⚠️ 纯离线：不起机器人、不连 NapCat、不发消息。
 *
 * 用法: node test/quote.js
 */
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });
const CFG_REL = 'logs/__test-quote.yml';

const GROUP = '200000001'; // 1 档 + 在白名单里
const BOT = '10000002'; // 机器人自己
const <主人> = '10000001'; // 别人（服主）
const OTHER = '10000003'; // 另一个群友

// ⚠️ 配置必须在 import `src/*` **之前**写好（`config.js` 是加载时读的）
writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    '  baseURL: http://203.0.113.10:1/v1',
    '  apiKey: "sk-test"',
    '  model: t',
    'trigger:',
    '  respondTo: 3',
    '  allowGroups:',
    `    - "${GROUP}"`,
    '  groupRespondTo:',
    `    "${GROUP}": 1`,
    'chat:',
    '  enable: true',
    '  quoteAfterGap: 4',
    'context:',
    '  enable: true',
    'ownerQQ: "' + <主人> + '"',
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const { Bot } = await import('../src/bot.js');
const recent = await import('../src/recent.js');

const textSeg = (text) => ({ type: 'text', data: { text } });
const replySeg = (id) => ({ type: 'reply', data: { id: String(id) } });
const atSeg = (qq) => ({ type: 'at', data: { qq: String(qq) } });

const evOf = (message, userId = OTHER, messageId = '') => ({
  message_type: 'group',
  group_id: GROUP,
  user_id: String(userId),
  self_id: BOT,
  message,
  // ⚠️ `message_id` 是"这条被刷下去没有"的判据（见 `recent.messagesAfterMe`），
  //    要测引用就得给事件带上 id，并且让缓冲里真的存在这条。
  message_id: messageId,
  sender: { user_id: String(userId), nickname: '某群友', role: 'member' },
});

const botWith = (myIds = []) => {
  const b = new Bot();
  b.selfId = BOT;
  b.myMsgIds = new Map([[`group:${GROUP}`, myIds.map(String)]]);
  b.lastReplyAt = new Map();
  b.batchState = new Map();
  b.batch = new Map();
  b.activeConv = new Map();
  // ⚠️ **防刷屏闸 stub 掉**：这里测的是"怎么判定这条在跟谁说话"，
  //    而测试里同一个假人会在几毫秒内连发十几条 → 真闸门会闭麦 60 秒，
  //    把后面所有断言都变成 null（第一版就是这么挂的，日志里能看到"闭麦 60 秒"）。
  b.checkFlood = () => false;
  return b;
};

// ─────────────────────────────────────────────────────────────
console.log('\n【1】★★ 引用她（没 @）→ 直接对她说话（hit = reply-me）');
{
  const b = botWith(['9001', '9002']);
  const d = b.decide(evOf([replySeg(9002), textSeg('这句你怎么答？')]));
  check(!!d, '★ 引用了她 → 判定为要对她说（以前会掉进普通群聊）');
  check(d?.hit === 'reply-me', `★★ hit 是 \`reply-me\`（拿到的是 ${d?.hit ?? 'null'}）`);
  check(/这句你怎么答？$/.test(d?.realText ?? ''), '★ 正文照旧剥出来（引用段不算正文）');
  check(
    /\[引用#9002\]/.test(d?.realText ?? ''),
    '★ 而且留了「引用」占位符 —— 提示词要据此知道"她在被引用"',
  );
}

console.log('\n【2】引用**别人**的消息 → 不当成"对她说"（别乱插话）');
{
  const b = botWith(['9001']);
  const d = b.decide(evOf([replySeg('7777'), textSeg('我是回楼上那句的')]));
  check(d?.hit !== 'reply-me', '★★ 引用的不是她 → 不走 reply-me 这条路');
}

console.log('\n【3】★ 她在别处发过的 id 不算（按群隔离）');
{
  const b = botWith(['9001']);
  b.myMsgIds.set('group:999999', ['5555']);
  const d = b.decide(evOf([replySeg('5555'), textSeg('这句呢')]));
  check(d?.hit !== 'reply-me', '★ 别的群里她发过的 id 不会误判成本群引用');
}

console.log('\n【4】★★ 上下文缓冲兜底：她刚说完就被引用（myMsgIds 还没轮到）');
{
  recent.clearAll();
  recent.rememberBot(
    { message_type: 'group', group_id: GROUP, user_id: BOT, message_id: '8888', sender: { nickname: 'saki' } },
    '刚说的这句',
    '8888', // ⚠️ 第三个参数就是 message_id（2026-09-15 晚加的，引用她时要靠它）
  );
  check(recent.isOwnMessage(GROUP, '8888') === true, '★ `isOwnMessage` 认得出来');
  const b = botWith([]); // myMsgIds 里什么都没有
  const d = b.decide(evOf([replySeg(8888), textSeg('那这句呢')]));
  check(d?.hit === 'reply-me', '★★ 靠上下文缓冲也能认出来（重启后 myMsgIds 是空的）');
  recent.clearAll();
}

console.log('\n【5】★★ 引用 + @ 别的群友 → 仍然不接（@ 别人是硬判据）');
{
  const b = botWith(['9001']);
  const d = b.decide(evOf([atSeg(OTHER), replySeg('9001'), textSeg('你看这个')]));
  check(d === null, '★★ @ 了别人（哪怕同时引用了她）→ 不插嘴');
}

console.log('\n【6】★★ 引用条件：她上次说话隔 ≥4 条 **且** 要回的那条不紧挨着她');
console.log('        （<主人> 2026-09-15 晚截图抓的 bug：「相邻消息引用了」）');
{
  const b = botWith(['9001']);
  /**
   * 造缓冲：她一句 → afterBot 句别人 → 目标那条（id=`T`）→ afterTarget 句别人。
   * `withBot=false` = 缓冲里**没有**她说的话（＝"不知道"那条路）。
   */
  const seed = (afterBot, afterTarget, withBot = true) => {
    recent.clearAll();
    if (withBot) {
      recent.rememberBot({ message_type: 'group', group_id: GROUP, user_id: BOT, message_id: 'b1' }, '她先说一句');
    }
    for (let i = 0; i < afterBot; i++) {
      recent.remember(
        { message_type: 'group', group_id: GROUP, user_id: OTHER, message_id: `h${i}`, sender: { nickname: 'X' } },
        { text: `别人的第 ${i} 句` },
      );
    }
    recent.remember(
      { message_type: 'group', group_id: GROUP, user_id: OTHER, message_id: 'T', sender: { nickname: 'X' } },
      { text: '她要回的那条' },
    );
    for (let i = 0; i < afterTarget; i++) {
      recent.remember(
        { message_type: 'group', group_id: GROUP, user_id: OTHER, message_id: `a${i}`, sender: { nickname: 'X' } },
        { text: `后面第 ${i} 句` },
      );
    }
  };
  const ev = () => evOf([textSeg('接着聊')], OTHER, 'T');

  // ⚠️⚠️ 这就是截图那个 bug：她 7 分钟没说话（gap 很大），但**要回的那条就是最新的**
  seed(5, 0);
  check(recent.messagesAfterMe(GROUP, 'T') === 0, '★ 目标那条就是最新的（后面 0 条）');
  check(recent.messagesSinceBotLast(GROUP) === 6, '★ 她上次说话隔了 6 条（按老规则这会引用 ✗）');
  check(
    b.shouldQuote(ev()) === false,
    '★★ **相邻 → 不引用**（她的话就紧跟在被回那条下面，谁都看得出在回谁）',
  );

  // 她的话**不紧挨着**被回那条，而且她确实很久没说话 → 引用
  seed(2, 1);
  check(
    recent.messagesAfterMe(GROUP, 'T') === 1 && recent.messagesSinceBotLast(GROUP) === 4,
    '★ 造数：目标后面 1 条、她上次说话隔 4 条',
  );
  check(b.shouldQuote(ev()) === true, '★★ 不紧挨着 + 隔够 4 条 → 引用');

  // 隔不够 → 不引用
  seed(1, 1);
  check(recent.messagesSinceBotLast(GROUP) === 3, '★ 造数：隔 3 条');
  check(b.shouldQuote(ev()) === false, '★★ 隔不够 4 条 → 不引用');

  // 缓冲里没有她的锚点，但**那条被刷下去 ≥4 条** → 也该引用（不引用真看不出在回谁）
  seed(0, 4, false);
  check(recent.messagesSinceBotLast(GROUP) === -1, '★ 造数：她在这个窗口里没说过话（-1）');
  check(recent.messagesAfterMe(GROUP, 'T') === 4, '★ 造数：目标被压下去 4 条');
  check(b.shouldQuote(ev()) === true, '★★ 被刷下去 ≥4 条 → 引用（这条不看她上次说话隔了几条）');
  recent.clearAll();
}

console.log('\n【7】★★ 缓冲里她还没说过话 **且** 目标是新的 → 不引用（"没检测到"≠"间隔很大"）');
{
  const b = botWith([]);
  recent.clearAll();
  recent.remember(
    { message_type: 'group', group_id: GROUP, user_id: OTHER, message_id: 'T', sender: { nickname: 'X' } },
    { text: '她要回的那条' },
  );
  check(recent.messagesSinceBotLast(GROUP) === -1, '★ 没说过话 → **-1（不知道）**');
  check(recent.messagesAfterMe(GROUP, 'T') === 0, '★ 那条就是最新的');
  check(
    b.shouldQuote(evOf([textSeg('在吗')], OTHER, 'T')) === false,
    '★★ 新群 / 刚重启（缓冲是空的）→ **不引用**，别回到"满屏引用框"（e2e 盯着这条）',
  );
  recent.clearAll();
}

console.log('\n【8】★★ 阈值可关（`chat.quoteAfterGap: 0`）+ 调用方要求仍然优先');
{
  const b = botWith(['9001']);
  recent.clearAll();
  // ⚠️ 先给她一条"说过的话"当锚点 —— 没锚点时是"不知道"（-1），不会触发引用
  recent.rememberBot({ message_type: 'group', group_id: GROUP, user_id: BOT, message_id: 'a0' }, '她先说的这句');
  for (let i = 0; i < 3; i++) {
    recent.remember(
      { message_type: 'group', group_id: GROUP, user_id: OTHER, message_id: `y${i}`, sender: { nickname: 'X' } },
      { text: `第 ${i} 句` },
    );
  }
  recent.remember(
    { message_type: 'group', group_id: GROUP, user_id: OTHER, message_id: 'T', sender: { nickname: 'X' } },
    { text: '她要回的那条' },
  );
  recent.remember(
    { message_type: 'group', group_id: GROUP, user_id: OTHER, message_id: 'z9', sender: { nickname: 'X' } },
    { text: '后面还有一条' },
  );
  const ev = () => evOf([textSeg('t')], OTHER, 'T');
  check(b.shouldQuote(ev()) === true, '★ 默认（4）→ 引用');
  const cfg = (await import('../src/config.js')).config;
  const old = cfg.chat.quoteAfterGap;
  cfg.chat.quoteAfterGap = 0;
  check(b.shouldQuote(ev()) === false, '★★ 设成 0 = 关掉这条（回到"非必要不引用"）');
  cfg.chat.quoteAfterGap = old;
  check(b.shouldQuote(ev(), true) === true, '★ 调用方要求引用时照旧引用（老语义没变）');
  // ⚠️ 私聊不受这条影响（私聊没有"群里刷过去了"这个问题）
  const priv = { message_type: 'private', user_id: <主人>, self_id: BOT, message: [textSeg('在吗')], sender: { nickname: '<主人>' } };
  check(recent.messagesSinceBotLast('') === -1, '★ 私聊那个桶是空的（-1 = 不知道）');
  check(b.shouldQuote(priv) === false, '★★ 私聊**不**因为这条去引用（只管群里）');
  recent.clearAll();
}

console.log('\n【9】★★ 引用归引用，**不许再补一个 @**（用户：「除了引用不要加 @，会有点吵」）');
{
  const src = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  // 她正常说话那条路（`sendText`）只许有 reply / text / image 三种段
  const fn = src.match(/sendText\(event, text,[\s\S]*?return this\.call\(action, params\)/);
  check(!!fn, '★ 找得到 `sendText` 那段');
  check(!!fn && !/type: 'at'/.test(fn[0]), '★★ 她正常回复**不插 at 段**（引用就够了）');
  // 新增的 `reply-me` 也不许顺手 @ 人
  const decideFn = src.match(/isQuoteOfMe\(event, segments\)\) \{[\s\S]{0,80}/) ?? [''];
  check(!/atSeg|type: 'at'/.test(decideFn[0]), '★ `reply-me` 这条分支里没有 @');
}

console.log('\n【10】★★ 余额见底那条提醒的 @ **不许动**（用户：「@我充值的不要改」）');
{
  const src = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    /at: c\.tier === 'critical' \? config\.ownerQQ : ''/.test(src),
    '★★ 见底档（<2 元）照旧 @ 服主（`at: c.tier === \'critical\' ? config.ownerQQ : \'\'`）',
  );
  check(/atName: '<主人>'/.test(src), '★ 而且带上了 atName（QQ 客户端才显示得对）');
  check(
    /偏低档不 @/.test(src),
    '★★ 而且**只有见底档 @**：偏低档（现在按用户要求关掉了，代码留着）不 @',
  );
}

console.log('\n【11】★ 新路不受触发冷却影响（和 @ 她一样是明确召唤）');
{
  const src = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    /hit === 'at' \|\|[\s\S]{0,80}hit === 'reply-me' \|\|[\s\S]{0,80}hit === 'call'/.test(src),
    "★★ `mustReply` 里带上了 `reply-me`（引用她）和 `call`（点名叫她）—— 否则会被两秒冷却悄悄吃掉",
  );
}

console.log('\n【12】★★ 正文里**点名叫她** → 也算召唤（<主人>：「明确提到祥子的没有回复」）');
{
  const b = botWith([]);
  // ① 就是用户报的那一句
  const d1 = b.decide(evOf([textSeg('祥子你现在和谁住在一起')]));
  check(d1?.hit === 'call', '★★ 「祥子你现在和谁住在一起」→ 直接回（hit=call）');
  check(d1?.calledBy === '祥子', '★ 记下了是哪个名字叫的');
  // ② 别的叫法（用户/群里都在用）
  check(b.decide(evOf([textSeg('小祥在吗')]))?.hit === 'call', '★ 「小祥在吗」也算');
  check(b.decide(evOf([textSeg('客服小祥帮我看看这个')]))?.hit === 'call', '★ 「客服小祥」也算');
  check(b.decide(evOf([textSeg('saki 你怎么看')]))?.hit === 'call', '★ 英文写法 saki 也算');
  check(b.decide(evOf([textSeg('Sakiko 在不在')]))?.hit === 'call', '★ 英文不区分大小写');
  // ③ 骆驼祥子不算 —— 老舍那本书（用户自己提过：没看过 MyGO 的人会认成"骆驼祥子"）
  check(
    b.decide(evOf([textSeg('你看过骆驼祥子吗')]))?.hit !== 'call',
    '★★ 「骆驼祥子」**不算**在叫她（不然天天误触发）',
  );
  // ④ @ 别人优先：@ 了别人就不插嘴，哪怕正文里有她的名字
  check(
    b.decide(evOf([atSeg(OTHER), textSeg('祥子刚才说啥了')])) === null,
    '★★ @ 的是别人（哪怕提到了她）→ 仍然不插嘴',
  );
  // ⑤ 真 @ 她的优先级更高
  check(b.decide(evOf([atSeg(BOT), textSeg('祥子你看看')]))?.hit === 'at', '★ 真 @ 她时 hit 还是 at（@ 优先）');
  // ⑥ **就算那个群是最严的 3 档（只认 @）→ 点名叫她照样回**
  const b3 = botWith([]);
  b3.resolveRespondTo = () => 3; // 假装这个群是 3 档
  check(
    b3.decide(evOf([textSeg('祥子，服务器那个事怎么样了')]))?.hit === 'call',
    '★★ 3 档群（只认 @）里，正文点名叫她**也照样回**（和 @ 同级）',
  );
  // ⑦ 私聊不受影响（私聊本来就回）
  const priv = { message_type: 'private', user_id: <主人>, self_id: BOT, message: [textSeg('祥子')], sender: { nickname: '<主人>' } };
  check(b.decide(priv)?.hit === 'private', '★ 私聊还是 private（不走这条）');
  // ⑧ 名字表可配（config.trigger.callNames）
  const cfg2 = (await import('../src/config.js')).config;
  const oldNames = cfg2.trigger.callNames;
  cfg2.trigger.callNames = ['小祥子'];
  check(b.decide(evOf([textSeg('小祥子在哪')]))?.hit === 'call', '★ 配了 callNames 就按配置走');
  check(b.decide(evOf([textSeg('祥子在吗')]))?.hit !== 'call', '★ 覆盖之后原来的「祥子」不再命中');
  cfg2.trigger.callNames = oldNames;
}

try {
  rmSync(join(ROOT, CFG_REL), { force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
