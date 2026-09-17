/**
 * 「别一直质疑对方」测试（2026-09-14 用户反馈）。
 *
 * ## 用户报的现象
 *
 *   原话：「和人交流的时候有时会出现这种**不断反驳**的情况，
 *   虽然这很符合一些人的真实状态，但是**我希望机器人对人更温柔**」。
 *
 *   截图里某群友在说自己买的 OPPO Watch：
 *
 *     对方：oppo watch 约等于手机了          → 她：那么小的屏，**打字不累吗**
 *     对方：为了买这个表我上交了半年的零花钱  → 她：半年零花钱**就换这个**？
 *     对方：自带浏览器                       → 她：拿手表刷网页，**图什么呢**
 *
 *   ⚠️ **单看每一句都不算过分，连着三句就是在抬杠。**
 *
 * ## 为什么光改人设不够
 *
 *   模型每一轮是**孤立**生成一句话的 —— 它看不见"我刚连着挑了两句"，
 *   所以它不会觉得自己在抬杠。
 *
 *   所以两层一起上：
 *     ① `persona.md` 里那条「别一直质疑对方」（给它"该怎么演"的规矩）
 *     ② `recent.js` 的**语气计数**（给它"你刚连着挑了两句"这个事实）
 *        → 到阈值就往提示词里塞「这句必须接住」
 *
 * ## 这个套件盯什么
 *
 *   · 判据本身：三句截图里的话必须被判成"质疑"，正常接住的话不许误判
 *   · ★ 计数方向：对方在**分享**时连着质疑才累加
 *   · ★ 对方在**问你**时回一句反问**不算**抬杠（别把这条用过头）
 *   · ★ 接住一句就断链
 *   · ★ 阈值 ≥2 才注入提示，而且真的注进了 `buildSystemPrompt`
 *
 * ⚠️ 纯离线：不起机器人、不连 NapCat、不调模型（`recent` 只有内存，无状态文件）。
 *
 * 用法: node test/tone.js
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });
const CFG_REL = 'logs/__test-tone.yml';

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
    'chat:',
    '  enable: true',
    'context:',
    '  enable: true',
    '  maxMessages: 15',
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

const recent = await import('../src/recent.js');
const { Bot } = await import('../src/bot.js');

const GROUP = '200000001';
const mkEvent = (userId = '10000003') => ({
  message_type: 'group',
  group_id: GROUP,
  user_id: userId,
  self_id: '10000002',
  message_id: String(Math.floor(Math.random() * 1e9)),
  message: [{ type: 'text', data: { text: 'x' } }],
  sender: { user_id: userId, nickname: '某群友', role: 'member' },
});

/** 对方说一句 */
const heSays = (text, ev = mkEvent()) => {
  recent.remember(ev, { text, isAtMe: false });
  return ev;
};
/** 机器人说一句 */
const sheSays = (text, ev) => recent.rememberBot(ev, text);

// ─────────────────────────────────────────────────────────────
console.log('\n【1】判据：截图里那三句必须被判成"质疑"');
{
  const bad = [
    '那么小的屏，打字不累吗',
    '半年零花钱就换这个？',
    '拿手表刷网页，图什么呢',
  ];
  for (const t of bad) {
    check(recent.looksLikeChallenge(t) === true, `质疑：${t}`);
  }
}

console.log('\n【2】判据：正常"接住"的话不许误判成质疑');
{
  const good = [
    '行吧，喜欢就好',
    '那你平时真拿它刷网页啊',
    '我倒是想要个能听歌的',
    '……你还挺舍得',
    '嗯',
  ];
  for (const t of good) {
    check(recent.looksLikeChallenge(t) === false, `不算质疑：${t}`);
  }
}

console.log('\n【3】★ 计数方向：对方在**分享**，连着质疑才累加');
{
  recent.clearAll();
  const ev = heSays('oppo watch 约等于手机了');
  sheSays('那么小的屏，打字不累吗', ev);
  check(recent.challengeStreak(ev) === 1, '第 1 句质疑 → 1', `实际 ${recent.challengeStreak(ev)}`);

  heSays('为了买这个表我上交了半年的零花钱', ev);
  sheSays('半年零花钱就换这个？', ev);
  check(recent.challengeStreak(ev) === 2, '★ 第 2 句质疑 → 2（这就是抬杠的起点）', `实际 ${recent.challengeStreak(ev)}`);

  heSays('自带浏览器', ev);
  sheSays('拿手表刷网页，图什么呢', ev);
  check(recent.challengeStreak(ev) === 3, '第 3 句质疑 → 3', `实际 ${recent.challengeStreak(ev)}`);
}

console.log('\n【4】★ 接住一句就断链');
{
  recent.clearAll();
  const ev = heSays('oppo watch 约等于手机了');
  sheSays('那么小的屏，打字不累吗', ev);
  sheSays('半年零花钱就换这个？', heSays('为了买这个表我上交了半年的零花钱', ev));
  check(recent.challengeStreak(ev) === 2, '先连着两句 → 2');
  sheSays('行吧，喜欢就好', heSays('自带浏览器', ev));
  check(recent.challengeStreak(ev) === 0, '★ 接住一句 → 断链归零', `实际 ${recent.challengeStreak(ev)}`);
}

console.log('\n【5】★ 对方在**问你**的时候，回一句反问不算抬杠');
{
  recent.clearAll();
  const ev = heSays('服务器怎么进？');
  sheSays('你不是有正版吗', ev);
  check(
    recent.challengeStreak(ev) === 0,
    '★ 他问问题 → 反问不计（别把这条规矩用过头）',
    `实际 ${recent.challengeStreak(ev)}`,
  );

  // 他问完接着开始分享，这时候才该开始算
  sheSays('半年零花钱就换这个？', heSays('我买了个表', ev));
  check(recent.challengeStreak(ev) === 1, '转入分享后 → 开始计 1', `实际 ${recent.challengeStreak(ev)}`);
}

console.log('\n【6】★ 阈值 ≥2 才注入提示，而且真的注进系统提示词里');
{
  const b = new Bot();
  b.selfId = '10000002';
  b.activeConv ??= new Map();

  // 断言用的特征串（和 bot.js 里注入的那段必须一致）
  const MARK = '这一句必须"接住"，不许再质疑';

  // ① 只有一句质疑 → 不注入（一次挑刺不算毛病，别把它憋成木头）
  recent.clearAll();
  let ev = heSays('oppo watch 约等于手机了', mkEvent());
  sheSays('那么小的屏，打字不累吗', ev);
  let sys = b.buildSystemPrompt('', ev);
  check(!sys.includes(MARK), `连着 1 句 → 不注入（实际 streak=${recent.challengeStreak(ev)}）`);

  // ② 两句 → 注入
  sheSays('半年零花钱就换这个？', heSays('为了买这个表我上交了半年的零花钱', ev));
  check(recent.challengeStreak(ev) === 2, '前置：streak 到 2');
  sys = b.buildSystemPrompt('', ev);
  check(sys.includes(MARK), '★ 连着 2 句 → **注入**「这句接住」');
  check(sys.includes('连着 2 句'), '提示里带了具体句数（让模型知道有多严重）');

  // ③ 接住之后就不再注入
  sheSays('行吧，喜欢就好', heSays('自带浏览器', ev));
  sys = b.buildSystemPrompt('', ev);
  check(!sys.includes(MARK), '接住之后 → 不再注入');
}

console.log('\n【7】接线：那一层真的挂上了');
{
  const src = (await import('node:fs')).readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  check(
    code.some((l) => l.includes('recent.challengeStreak(event)')),
    'buildSystemPrompt 里读了 challengeStreak',
  );
  check(
    !code.some((l) => /challengeStreak\([^)]*\)\s*>=\s*1\b/.test(l)),
    '阈值不是 ≥1（≥1 会把偶尔一句吐槽也压掉）',
  );

  const rsrc = (await import('node:fs')).readFileSync(join(ROOT, 'src', 'recent.js'), 'utf8');
  check(/noteTone\(key, body\)/.test(rsrc), 'rememberBot 里调了 noteTone');
  check(
    /isQuestionLike\(prev\.text\)/.test(rsrc),
    '★ 对方在问问题时不计（`isQuestionLike` 那一路在）',
  );
}

// ── 过渡话不许像"客服在翻资料"（2026-09-16 用户截图） ──
console.log('\n【★】过渡话：问她自己的事时不许说「翻翻」');
{
  // 用户原话：「这里在问动画的信息，说翻翻有点奇怪」——
  // 她答的是「嗯…等我翻翻」。她是本人，手边没有资料库，"翻"字一出来就露馅。
  const { readFileSync: rf } = await import('node:fs');
  const lsrc = rf(join(ROOT, 'src', 'llm.js'), 'utf8');
  const bsrc = rf(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    !/等我翻翻/.test(lsrc.replace(/\/\/[^\n]*/g, '')),
    '★ `quickAck` 的例句里**没有**「等我翻翻」了（就是它把模型带偏的）',
  );
  check(
    /不许说「翻 \/ 查 \/ 搜 \/ 资料 \/ 档案 \/ 记录」/.test(lsrc),
    '★ 提示词写清了：除非真上网查，不许说"翻/查/搜/资料"',
  );
  check(
    /replace\(\/翻翻\|翻一下\|翻下\|去翻\|翻一翻\|翻资料\/g, '想想'\)/.test(bsrc),
    '★★ 代码还兜了一道：「翻」类词一律换成"想想"（提示词不可靠）',
  );
  const fix = (t) => t.replace(/翻翻|翻一下|翻下|去翻|翻一翻|翻资料/g, '想想');
  check(fix('嗯…等我翻翻') === '嗯…等我想想', '「嗯…等我翻翻」→「嗯…等我想想」', fix('嗯…等我翻翻'));
  check(fix('我查查') === '我查查', '真去上网查时的「我查查」不动它');
  // ⚠️ 2026-09-16 晚：模型/网络故障时**也不许把内部错误甩到群里**
  //    （用户截图：群里出现「⚠️ 模型调用出错了，请稍后再试」）
  check(
    !/模型调用出错了，请稍后再试/.test(bsrc.replace(/\/\/[^\n]*/g, '')),
    '★ 群里不再出现「模型调用出错了」这种内部话（发的是人话）',
  );
  check(/刚卡了一下，你再说一遍/.test(bsrc), '★ 网络类瞬时故障 → 只说"刚卡了一下"');
  check(/失败底层原因/.test(bsrc), '★ 日志里记下底层原因（err.cause），以后好排障');
}

try {
  rmSync(join(ROOT, CFG_REL), { force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
