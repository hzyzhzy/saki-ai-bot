/**
 * 私聊白名单总闸测试（2026-09-20）。
 *
 * 用户要求：「私聊白名单外的人，不管发什么类型的消息都不回复」。
 * 原来漏在：戳一戳是 post_type:'notice'，走不到 onRaw 的 message 分支白名单检查，
 * 而 pokeBack 只查群白名单 → 私聊白名单外的人戳一下也会被回。
 *
 * 改后：统一成 privateAllowed(userId)，onRaw(message/notice) + handle() + pokeBack 共用。
 * ⚠️ 纯单元测试：不连 NapCat、不花钱、不碰真 QQ。
 * 用法: node test/private-whitelist.js
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });

const CFG_REL = 'logs/__test-private-wl.yml';
const WL_USER = '10000009';
const OUT_USER = '10000010';
writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
    '  apiKey: "sk-test"',
    '  model: test-model',
    'trigger:',
    '  respondTo: 1',
    '  allowGroups: []',
    '  privateChat: true',
    `  allowPrivateUsers: ["${WL_USER}"]`,
    '  allowPrivateTeach: false',
    'poke:',
    '  enable: true',
    '  useLLM: true',
    '  cooldownMs: 0',
    'groupChat: true',
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

const mod = await import('../src/bot.js');
const { config } = await import('../src/config.js');
const BotClass = mod.Bot ?? mod.default ?? null;
if (!BotClass) {
  console.log('  ❌ 没找到导出的 Bot 类');
  process.exit(1);
}

const SELF = '10000002';
const GID = '200000001';
const textSeg = (t) => ({ type: 'text', data: { text: t } });

function freshBot() {
  const b = new BotClass();
  b.selfId = SELF;
  const pokes = [];
  const routed = [];
  const decided = [];
  b.pokeBack = async (payload) => pokes.push(payload);
  b.scheduleHandle = async (event, meta) => routed.push({ event, meta });
  b.decide = (event, voluntary) => {
    decided.push({ event, voluntary });
    return null;
  };
  b.call = async () => ({});
  return { b, pokes, routed, decided };
}

const privateMsg = (uid, text) => ({
  post_type: 'message',
  message_type: 'private',
  sub_type: 'friend',
  message_id: Math.floor(Math.random() * 1e9),
  user_id: uid,
  self_id: SELF,
  time: Math.floor(Date.now() / 1000),
  sender: { user_id: uid, nickname: '某人' },
  message: [textSeg(text)],
});
const groupMsg = (uid, gid, text) => ({
  post_type: 'message',
  message_type: 'group',
  group_id: gid,
  message_id: Math.floor(Math.random() * 1e9),
  user_id: uid,
  self_id: SELF,
  time: Math.floor(Date.now() / 1000),
  sender: { user_id: uid, nickname: '群友' },
  message: [textSeg(text)],
});
const pokeNotice = (uid, gid) => ({
  post_type: 'notice',
  notice_type: 'notify',
  sub_type: 'poke',
  user_id: uid,
  target_id: SELF,
  self_id: SELF,
  time: Math.floor(Date.now() / 1000),
  ...(gid ? { group_id: gid } : {}),
});
const feed = (b, payload) => b.onRaw(Buffer.from(JSON.stringify(payload), 'utf8'));

console.log('\n【1】privateAllowed()：除非在白名单里，否则一律 false');
{
  const { b } = freshBot();
  check(b.privateAllowed(WL_USER) === true, '白名单内 → true');
  check(b.privateAllowed(OUT_USER) === false, '★ 白名单外 → false');
  check(b.privateAllowed('') === false, '空 userId → false');
  check(b.privateAllowed(undefined) === false, 'undefined → false');
  check(b.privateAllowed(Number(WL_USER)) === true, '传数字也认');
}

console.log('\n【2】★ 白名单外：私聊文字不回');
{
  const { b, routed, decided } = freshBot();
  await feed(b, privateMsg(OUT_USER, '你好呀'));
  check(routed.length === 0, '★ 走不到 scheduleHandle');
  check(decided.length === 0, '★ 连 decide 都没调用');
}

console.log('\n【3】★ 白名单外：私聊戳一戳也不回（本次修的正是它）');
{
  const { b, pokes } = freshBot();
  await feed(b, pokeNotice(OUT_USER));
  check(pokes.length === 0, '★ 私聊戳一戳：pokeBack 没被调用');
  const src = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    /const pokeGid = String\(payload\.group_id[\s\S]{0,200}?this\.privateAllowed\(pokeUid\)/.test(src),
    '★ onRaw notice 分支确实接了 privateAllowed',
  );
}

console.log('\n【4】白名单内：私聊文字照常回');
{
  const { b, routed } = freshBot();
  await feed(b, privateMsg(WL_USER, '你好呀'));
  check(routed.length === 1, '★ 白名单内私聊 → 正常进主流程', `${routed.length} 次`);
  check(routed[0]?.event?.user_id === WL_USER, '路由的就是那条私聊消息');
}

console.log('\n【5】白名单内：私聊戳一戳照常回');
{
  const { b, pokes } = freshBot();
  await feed(b, pokeNotice(WL_USER));
  check(pokes.length === 1, '★ 白名单内私聊戳一戳 → 正常回击', `${pokes.length} 次`);
}

console.log('\n【6】privateChat:false 是总开关：白名单里的人也不回');
{
  const keep = config.trigger.privateChat;
  config.trigger.privateChat = false;
  const { b, routed, pokes } = freshBot();
  check(b.privateAllowed(WL_USER) === false, '★ 开关关掉 → 白名单内也判 false');
  await feed(b, privateMsg(WL_USER, '你好呀'));
  await feed(b, pokeNotice(WL_USER));
  check(routed.length === 0, '★ 文字：不回');
  check(pokes.length === 0, '★ 戳一戳：不回');
  config.trigger.privateChat = keep;
  check(b.privateAllowed(WL_USER) === true, '还原后白名单内恢复 true');
}

console.log('\n【7】群聊完全不受影响');
{
  const { b, pokes, routed } = freshBot();
  await feed(b, groupMsg(OUT_USER, GID, '今天天气不错'));
  check(routed.length === 1, '群消息照常进主流程');
  await feed(b, pokeNotice(OUT_USER, GID));
  check(pokes.length === 1, '★ 群里戳一戳照常回（私聊闸不碰群）');
}

console.log('\n【8】handle() 里的根本防线');
{
  const { b, decided } = freshBot();
  await b.handle({ message_type: 'private', user_id: OUT_USER, message: [textSeg('hi')] });
  check(decided.length === 0, '★ 白名单外假私聊事件 → handle 一进门就 return');
  const { b: b2, decided: d2 } = freshBot();
  await b2.handle({ message_type: 'private', user_id: WL_USER, message: [textSeg('hi')] });
  check(d2.length === 1, '白名单内 → 照常走到 decide（对照）');
}

console.log('\n【9】pokeBack() 自身双保险');
{
  const { b } = freshBot();
  delete b.pokeBack;
  Object.setPrototypeOf(b, BotClass.prototype);
  let reached = 0;
  b.scheduleHandle = async () => {
    reached++;
  };
  await b.pokeBack(pokeNotice(OUT_USER));
  check(reached === 0, '★ pokeBack 直接调（私聊+白名单外）→ 自己挡住');
  await b.pokeBack(pokeNotice(WL_USER));
  check(reached === 1, '对照：白名单内私聊 pokeBack → 正常往下走', `${reached} 次`);
}

console.log(
  failures === 0
    ? '\n结果: 全部通过 ✅（私聊白名单外的人任何类型都不回；群聊不受影响）\n'
    : `\n结果: ${failures} 项失败 ❌\n`,
);
process.exit(failures === 0 ? 0 : 1);