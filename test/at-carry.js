/**
 * 「有人**手动 @ 她**、而且两分钟内她们刚聊过 → 她得**接着那段**答」的测试（2026-10-15 加）。
 *
 * ## 用户原话
 *
 *   「**如果是点手动 @ 一下同类机器人的话，而且两分钟内她们有过对话，
 *     @ 的内容就直接靠两分钟之前那个对话说**」
 *
 * ## 现场（截图）
 *
 *   爱音在群里连着甩了两条（「那视频名字怎么听着这么怪啊」「诶诶诶，那名字里怎么还有我啊」）
 *   + 一条 B 站链接，紧跟着**手动 @ 她**问「祥祥周六有空吗，我请你吃甜品」——
 *   她只回「周六啊……我得看看那天有没有班。你请？太阳打西边出来了」，
 *   **完全没接前面那段** ⇒ 看着像突然插话，不像在跟人聊天 ✗
 *
 * ## 判据（**不用模型判**，纯客观条件）
 *
 *   ① 群里 + 手动 @ 她（`at` 段里有她 **或** 正文里 @ 了她的名字/号）；
 *   ② 往回 `chat.carryWindowMs`（默认 2 分钟）里，**她和这个人（@ 她的那个）都说过话**。
 *   ⇒ 两条都成立才把那段对话拎出来放提示词末尾；缺一个就一个字都不加。
 *
 * ## 这个套件盯什么
 *
 *   【1】两分钟内她和对方都说过 → **注入**那段，而且标明"这是接着刚才那段说的"
 *   【2】只有对方说、她没说 → **不注入**（那是人家自己在那儿说，不是对话）
 *   【3】她说过、但对方那句已经过了窗口 → **不注入**
 *   【4】没 @ 她 → 不注入（闲聊不该被当成"接着刚才那段"）
 *   【5】@ 的是**别人** → 不注入
 *   【6】★ **文本形态**的 @（协议端把 @ 退化成纯文本）→ 照样注入
 *   【7】当前那条**不在**"刚才那段"里（不然她看着自己的问题被列一遍）
 *   【8】接线：这段真的进了 `buildSystemPrompt`，而且排在**最后**（动态内容别插到人设前面）
 *
 * ⚠️ 纯单元：不起机器人、不连协议端、不调模型。
 *
 * 用法: node test/at-carry.js
 */
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });
const CFG_REL = 'logs/__test-at-carry.yml';

const GROUP = '200000001';
const BOT = '10000002'; // 机器人自己
const PEER = '10000012'; // 同类机器人（爱音）
const OTHER = '10000003'; // 别的群友
const OTHER2 = '10000004'; // 另一个群友（@ 的是他那种）

// ⚠️ 配置必须在 import `src/*` **之前**写好（`config.js` 是加载时读的）
writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
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
    'context:',
    '  enable: true',
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
const { config } = await import('../src/config.js');

const textSeg = (text) => ({ type: 'text', data: { text } });
const atSeg = (qq) => ({ type: 'at', data: { qq: String(qq) } });

/** 造一条群消息事件 */
const evOf = (uid, message, messageId = 'cur') => ({
  message_type: 'group',
  group_id: GROUP,
  user_id: String(uid),
  self_id: BOT,
  message_id: messageId,
  message,
  sender: { user_id: String(uid), nickname: uid === PEER ? 'Anon' : '某群友', card: '' },
});

/** 直接往上下文缓冲里塞几条（要**精确控制时间**，所以不走 `remember`） */
function seed(items) {
  const key = recent.contextKey(evOf(PEER, [textSeg('x')]));
  recent.__storeForTest().set(
    key,
    items.map((m) => ({
      messageId: m.id,
      name: m.name,
      userId: m.uid,
      text: m.text,
      time: m.at,
      self: m.self === true,
      atMe: m.atMe === true,
    })),
  );
}

const NOW = Date.now();
const MIN = 60 * 1000;

/** 截图里那段：爱音两条 + 她回了一条（都在两分钟内） */
const sceneOfIt = (curId = 'cur') => [
  { id: 'm1', uid: PEER, name: 'Anon', text: '那视频名字怎么听着这么怪啊', at: NOW - 100 * 1000 },
  { id: 'm2', uid: BOT, name: 'saki', text: '……你发的那些我看了', at: NOW - 80 * 1000, self: true },
  { id: 'm3', uid: PEER, name: 'Anon', text: '诶诶诶，那名字里怎么还有我啊', at: NOW - 60 * 1000 },
  { id: curId, uid: PEER, name: 'Anon', text: '@saki酱saki酱saki酱 祥祥周六有空吗，我请你吃甜品', at: NOW - 5 * 1000, atMe: true },
];

/** 拿提示词（`carryOnBlock` 是同步的，直接调） */
function blockFor({ items, uid = PEER, message, text = '祥祥周六有空吗', messageId = 'cur' } = {}) {
  seed(items);
  const b = new Bot();
  b.selfId = BOT;
  const ev = evOf(uid, message ?? [atSeg(BOT), textSeg(` ${text}`)], messageId);
  return b.carryOnBlock(ev, text, { now: NOW });
}

console.log('\n【1】★★ 两分钟内她和对方都说过 → 把那段拎出来，要求"接着刚才那段说"');
{
  const blk = blockFor({ items: sceneOfIt() });
  check(!!blk, '★ 注入块有内容', blk ? '' : '（空的 ✗）');
  check(/接着刚才那段/.test(blk), '★★ 标题就是"他这句是接着刚才那段说的"');
  check(blk.includes('那视频名字怎么听着这么怪啊'), '★★ 她把爱音前面那两句**原文**看见了');
  check(blk.includes('你：……你发的那些我看了'), '★★ 她说过的也算进去，而且标成"你"');
  check(/Anon：/.test(blk), '★ 对方标的是名字（她一眼看出是谁）');
  check(/顺着上面那段/.test(blk) || /接着它答/.test(blk), '★★ 明确要求"顺着那段答"');
  check(/别当成一个从零开始的新话题/.test(blk), '★★ 并禁止当成新话题（就是要修的那个毛病）');
  check(/别把上面的话重复一遍/.test(blk), '★ 也别复读（和"别重复说过的话"那条一致）');
}

console.log('\n【2】只有对方说、她没说 → 不注入（那是人家自己在那儿说）');
{
  const items = [
    { id: 'm1', uid: PEER, name: 'Anon', text: '那视频名字怎么听着这么怪啊', at: NOW - 100 * 1000 },
    { id: 'm2', uid: PEER, name: 'Anon', text: '诶诶诶，那名字里怎么还有我啊', at: NOW - 60 * 1000 },
    { id: 'cur', uid: PEER, name: 'Anon', text: '@saki酱 周六有空吗', at: NOW - 5 * 1000, atMe: true },
  ];
  check(blockFor({ items }) === '', '★ 她这两分钟没说过话 ⇒ 一个字都不加');
}

console.log('\n【3】她说过、但对方那句已经过了窗口（>2 分钟）→ 不注入');
{
  const items = sceneOfIt().map((m) => (m.uid === PEER && m.id !== 'cur' ? { ...m, at: NOW - 9 * MIN } : m));
  check(blockFor({ items }) === '', '★ 3 分钟前的对话不算"刚才那段"');
  // 同一条改成 1 分钟前 → 立刻又成立（证明拦的就是时间）
  const items2 = sceneOfIt().map((m) => (m.uid === PEER && m.id !== 'cur' ? { ...m, at: NOW - 1 * MIN } : m));
  check(!!blockFor({ items: items2 }), '★ 对照：改到 1 分钟前 → 又注入了');
}

console.log('\n【4】没 @ 她 → 不注入（哪怕刚聊过）');
{
  seed(sceneOfIt());
  const b = new Bot();
  b.selfId = BOT;
  const ev = evOf(PEER, [textSeg('祥祥周六有空吗')]);
  check(b.carryOnBlock(ev, '祥祥周六有空吗', { now: NOW }) === '', '★ 没 @ 她（她自己会另判要不要接）');
}

console.log('\n【5】@ 的是别人 → 不注入');
{
  const blk = blockFor({ items: sceneOfIt(), uid: OTHER, message: [atSeg(OTHER2), textSeg(' 给个世界地图')], text: '给个世界地图' });
  check(blk === '', '★ @ 的是别人 ⇒ 不注入（也不该接）');
}

console.log('\n【6】★ 文本形态的 @（协议端把 @ 退化成纯文本）→ 照样注入');
{
  const blk = blockFor({
    items: sceneOfIt(),
    message: [textSeg('@saki酱saki酱saki酱 祥祥周六有空吗，我请你吃甜品')],
  });
  check(!!blk, '★ 正文里 @ 了她（没有 at 段）⇒ 也认（这条兜底别丢）');
}

console.log('\n【7】当前那条**不在**"刚才那段"里');
{
  const blk = blockFor({ items: sceneOfIt() });
  const body = blk.split('\n').filter((l) => l.startsWith('  ')).join('\n');
  check(!body.includes('@saki酱saki酱saki酱'), '★★ 他正在 @ 的那句不列进去（不然她看着自己的问题）');
  check(body.includes('那视频名字怎么听着这么怪啊'), '★ 但前面那句在（对照）');
}

console.log('\n【8】接线：这段真的进了提示词，而且排在最后');
{
  seed(sceneOfIt());
  const b = new Bot();
  b.selfId = BOT;
  const ev = evOf(PEER, [atSeg(BOT), textSeg(' 祥祥周六有空吗，我请你吃甜品')]);
  const p = b.buildSystemPrompt('', ev, 'chat', '祥祥周六有空吗，我请你吃甜品', '', '', '', '', false);
  check(/接着刚才那段/.test(p), '★★ `buildSystemPrompt` 里真的注入了（不是只写了函数没人调）');
  check(
    p.indexOf('接着刚才那段') > p.length * 0.9,
    '★★ 而且排在**最后 10%** —— 动态内容不能插到人设前面（会毁提示词缓存）',
    `位置 ${p.indexOf('接着刚才那段')} / 全长 ${p.length}`,
  );
  const src = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(/this\.carryOnBlock\(event, currentText\)/.test(src), '★ 调用点用了当前这句正文（不是别的东西）');
  check(
    /const atSeg = segs\.some\(/.test(src) && /tok\.includes\(n\)/.test(src),
    '★★ 两条 @ 判据都在：`at` 段 + 正文里"包含她的叫法"（长群名片那种也要认）',
  );
}

// ── 收尾
try {
  recent.clearAll();
  rmSync(join(ROOT, CFG_REL), { force: true });
} catch {}
void config;

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
