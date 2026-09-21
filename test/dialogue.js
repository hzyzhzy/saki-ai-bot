/**
 * 对话状态机的测试（2026-09-15 用户要求「完善对话状态机」）。
 *
 * ## 它替换掉了什么
 *
 * 原来判断"要不要接着聊"只有两个时间窗（`idleMs` / `sameUserMs`）+ 一个
 * `lastBotReplyTo`。于是「他接着说、但隔了 85 秒」被当成陌生人 → **漏接**
 * （用户截图：「这个也没有接进上文」），而「这一段她已经说了几句」根本没人知道。
 *
 * 现在 `src/dialogue.js` 把一段对话当成有生命周期的状态：
 *   `idle → active`（谁在跟她说：`him` / `other` / `alone`）
 * 并且把「她上一次开口是多久前、这一段对方几句、她几句」**交给说话判断** ——
 * 密度从"时间闸"变成"判断"（用户：「额度闸和冷却闸背后都是一样的」）。
 *
 * ⚠️ 纯离线：状态机是纯函数 + 两个钩子（假 event），不起进程、不联网、不花钱。
 *
 * 用法: node test/dialogue.js
 */
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });

// ⚠️⚠️ 必须在 import bot.js **之前**设好配置 ——
//    否则会把生产 config 灌进模块缓存（我在 test/behavior.js 踩过：34 项失败）。
const CFG_REL = 'logs/__test-dialogue.yml';
writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    '  baseURL: http://203.0.113.10:1/v1',
    '  apiKey: "sk-test"',
    '  model: test-model',
    'trigger:',
    '  groupChat: true',
    '  allowGroups:',
    '    - "200000001"',
    '  groupRespondTo:',
    '    "200000001": 1',
    'chat:',
    '  enable: true',
    '  followUp:',
    '    enable: true',
    '    idleMs: 30000',
    '    sameUserMs: 180000',
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

const d = await import('../src/dialogue.js');
const { Bot } = await import('../src/bot.js');

const T0 = 1_700_000_000_000;
const GID = '200000001';
const <主人> = '10000001';
const OTHER = '10000008';

console.log('\n【1】状态机：这一段对话的计数与分段');
{
  let conv = d.userTurn(null, { uid: <主人>, name: '<主人>', text: '在吗', now: T0 });
  check(conv.theirTurns === 1 && conv.herTurns === 0, '对方说话 → 对方 1 句、她 0 句');
  check(conv.lastSpeaker === 'user' && conv.lastUserText === '在吗', '最后开口的是对方，且记下了原话');

  conv = d.botTurn(conv, { uid: <主人>, name: '<主人>', text: '在。', now: T0 + 5000 });
  check(conv.herTurns === 1 && conv.theirTurns === 1, '她说话 → 她 1 句');
  check(conv.lastBotText === '在。' && conv.lastBotReplyTo === <主人>, '记下她上一句 + 她在回谁');
  check(conv.lastBotReplyAt === T0 + 5000, '兼容字段 `lastBotReplyAt` 还在（别的地方在读）');
  check(conv.followUpChain === 1, '兼容字段 `followUpChain` 还在（防刷屏计数）');

  conv = d.userTurn(conv, { uid: <主人>, text: '籽岷最近有什么视频', now: T0 + 20000 });
  check(conv.theirTurns === 2 && conv.herTurns === 1, '同一段里继续累加');

  // ⚠️ 隔太久（> 10 分钟）→ 算**新的一段**，计数从头来，别把半小时前的对话算进来
  const far = d.userTurn(conv, { uid: <主人>, text: '还在吗', now: T0 + 40 * 60 * 1000 });
  check(far.theirTurns === 1 && far.herTurns === 0, '隔了 40 分钟 → **新的一段**（计数归零）');
}

console.log('\n【2】状态机：三种"谁在说话"（him / other / alone）');
{
  const conv = d.botTurn(d.userTurn(null, { uid: <主人>, text: '在吗', now: T0 }), {
    uid: <主人>,
    text: '在。',
    now: T0 + 5000,
  });

  const him = d.snapshot(conv, { now: T0 + 25000, uid: <主人>, idleMs: 30000, sameUserMs: 180000 });
  check(him.phase === 'active' && him.who === 'him', '★ 同一个人接着说 → `him`（默认该接）');

  const other = d.snapshot(conv, { now: T0 + 25000, uid: OTHER, idleMs: 30000, sameUserMs: 180000 });
  check(other.who === 'other', '★ 换个人插话 → `other`（要判断）');

  // ★ 用户截图那次：他隔了 85 秒接着说 —— 超过 idleMs 但在 sameUserMs 里
  const late = d.snapshot(conv, { now: T0 + 90000, uid: <主人>, idleMs: 30000, sameUserMs: 180000 });
  check(late.who === 'him' && late.inWindow === false, '★ 隔了 85 秒（超 idleMs）**还是 him** —— 这次不许再漏接');

  const over = d.snapshot(conv, { now: T0 + 190000, uid: <主人>, idleMs: 30000, sameUserMs: 180000 });
  check(over.phase === 'idle' && over.who === 'alone', '超过 sameUserMs → 这段散了（idle）');

  const none = d.snapshot(null, { now: T0, uid: <主人> });
  check(none.phase === 'idle' && none.who === 'alone', '没有对话 → idle / alone（不炸）');
}

console.log('\n【3】喂给说话判断的那段状态（#4）');
{
  const conv = d.botTurn(d.userTurn(null, { uid: <主人>, name: '<主人>', text: '在吗', now: T0 }), {
    uid: <主人>,
    name: '<主人>',
    text: '在。',
    now: T0 + 5000,
  });
  const conv2 = d.userTurn(conv, { uid: <主人>, text: '籽岷最近有什么视频', now: T0 + 60000 });
  const txt = d.describe(conv2, { now: T0 + 65000, uid: <主人>, idleMs: 30000, sameUserMs: 180000 });
  check(/跟你聊的就是他/.test(txt), '说清"现在就是在跟他聊"', '');
  check(/你上一次开口：1 分钟前/.test(txt) || /你上一次开口/.test(txt), '带上"你上一次开口是多久前"');
  check(txt.includes('在。'), '带上她上一句的原话（判断才知道有没有重复）');
  check(/对方说了 2 句，你说了 1 句/.test(txt), '★ 带上"这一段各说了几句"（密度靠这个收住）');

  // 别人插话时要说清"不是你正在聊的那位"
  check(/不是你正在聊的那位/.test(d.describe(conv2, { now: T0 + 65000, uid: OTHER })), '别人插话 → 描述里点明');
  // 没有活跃对话就不给这段（省 token）
  check(d.describe(null) === '', '没有活跃对话 → 返回空串（不占提示词）');
}

console.log('\n【4】接线：两个钩子真的走状态机');
{
  const bot = new Bot();
  const ev = (text, uid = <主人>) => ({
    post_type: 'message',
    message_type: 'group',
    group_id: GID,
    user_id: uid,
    self_id: '10000002',
    sender: { user_id: uid, nickname: '<主人>', card: '<主人>', role: 'member' },
    message: [{ type: 'text', data: { text } }],
  });
  const key = `group:${GID}`;

  bot.activeConv = new Map();
  // 没聊过时对方说话 → 不建状态（保持原来的语义）
  bot.touchUserActivity(ev('路人甲'), '');
  check(!bot.activeConv.get(key), '没聊过时，对方说话**不建**对话状态');

  bot.touchConversation(ev('在吗'), '在。');
  const c1 = bot.activeConv.get(key);
  check(c1?.lastBotReplyAt > 0 && c1.herTurns === 1, '她回话 → 建状态 + 她 1 句');
  check(c1.lastBotText === '在。', '记下她说的那句话');

  bot.touchUserActivity(ev('籽岷最近有什么视频'), '籽岷最近有什么视频');
  const c2 = bot.activeConv.get(key);
  check(c2.theirTurns === 1 && c2.lastUserText === '籽岷最近有什么视频', '对方说话 → 对方 1 句 + 原话');
  check(
    c2.startedAt === c1.startedAt,
    '同一段对话里 startedAt 不变（这是"这一段有多久"的基准）',
  );

  // 被 @ 时续话计数归零（原来的行为要保住）
  c2.followUpChain = 3;
  bot.resetFollowUpChain(ev('@她'));
  check(bot.activeConv.get(key).followUpChain === 0, '被 @ → 续话计数归零（行为不变）');
  check(bot.activeConv.get(key).herTurns === 1, '  ↳ 但"这一段说了几句"不该被清（那是事实）');
}

console.log('\n【5】说话判断要拿到状态，而且知道怎么用它');
{
  const sj = readFileSync(join(ROOT, 'src', 'speak-judge.js'), 'utf8');
  const bj = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(/你自己的状态（收住自己用）/.test(sj), '★ 判断的输入里有「你自己的状态」那一段');
  check(/用「你自己的状态」管住密度/.test(sj), '★ 提示词里说清了**怎么用**（不是摆设）');
  check(/你几十秒前刚说过话/.test(sj) && /你已经说了 3 句以上/.test(sj), '给的是**具体判据**（刚说过 / 连说三句就收住）');
  check(/而不是靠时间闸\/额度闸/.test(sj), '  ↳ 并说明了它是**替代时间闸/额度闸**的');
  check(/dialogue: dialogue\.describe\(/.test(bj), '★ bot 那边真的把状态传进去了');
  check(/import \* as dialogue from '\.\/dialogue\.js'/.test(bj), '  ↳ 用的是 src/dialogue.js 那个状态机');

  // ⚠️ 有意**不落盘**：一段对话只有几分钟寿命，重启后记起"我们在聊天"反而危险
  const dj = readFileSync(join(ROOT, 'src', 'dialogue.js'), 'utf8');
  check(!/from 'node:fs'|writeFileSync|readFileSync/.test(dj), '状态机不落盘（内存态，重启丢掉最坏也只是不续话）');
}

try {
  rmSync(join(ROOT, CFG_REL), { force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
