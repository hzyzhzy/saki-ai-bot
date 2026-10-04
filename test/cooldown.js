/**
 * 「主动接话的冷却」测试（2026-09-14）。
 *
 * ## 这个套件盯的是一个真 bug：冷却**跨群互相饿死**
 *
 * 原来 `lastVoluntaryAt` 的 key **只有场景名**（`'chat'` / `'share'` / …），
 * 是全进程一份 —— 于是 **A 群刚接过话，B 群这段时间完全不能接**。
 * 实测后果：主群发张建筑截图 → 机器人捧场 → **90 秒内另一个群再发图，它不理**
 * （`share` 的额度被主群用掉了）。
 *
 * 改后 key = `场景@会话`（`Bot.voluntaryBucket()`），两个群各记各的。
 *
 * ## ⚠️ 背景：用户对冷却本身的态度
 *
 * 用户 2026-09-14 原话：
 *   「**冷却机制以后还是得删，因为不符合真人的特征**，
 *    真人是不会看到真正想回的消息却因为发的太快而不接」。
 *
 * 所以**删是计划中的事**，只是要等 speak-judge 在收紧度 > 2 下跑出数据再定。
 * 这个测试的作用是：**在删掉它之前，保证它至少不跨群互相干扰**；
 * 如果哪天真删了，这个套件应该一起删掉（那时候"按群隔离"就没意义了）。
 *
 * ## 还有个容易忘的事（也在这里钉住）
 *
 * **收紧度 ≤ 2 时 judge 是被跳过的**（`strictness <= 2 → return join`），
 * 所以用户在 0 档时**judge 根本没跑**，真正在限流的就是这个冷却。
 * 用户已经知道，打算调成 5 来测 judge。
 * 这条断言是防止以后有人**以为 0 档也过 judge** 而误判。
 *
 * ⚠️ 纯单元测试：不起机器人、不连 NapCat、不花钱（直接 new Bot 调方法）
 *
 * 用法: node test/cooldown.js
 */
import { writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });

// ⚠️ 配置路径必须在 import `src/*` **之前**设好（`config.js` 是加载时读的）
const CFG_REL = 'logs/__test-cooldown.yml';
writeFileSync(
  join(ROOT, CFG_REL),
  ['llm:', '  baseURL: http://127.0.0.1:1/v1', '  apiKey: "sk-test"', '  model: test-model', ''].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const mod = await import('../src/bot.js');
const BotClass = mod.Bot ?? mod.default ?? null;
const G1 = '200000001'; // 主群
const G2 = '200000002'; // 另一个 1 档群
const ev = (gid) => ({ message_type: 'group', group_id: gid, user_id: '40001', message: [] });

if (!BotClass) {
  console.log('  ❌ 没找到导出的 Bot 类（测试无法进行）');
  process.exit(1);
}
check(true, '拿到了 Bot 类');

const b = new BotClass();
const cfg = { cooldownMs: 60000, probability: 1 };

console.log('\n【1】同一个群：冷却照常生效（机制还在，没被误删）');
{
  // ⚠️ 2026-09-15 改：**记账不再由 `tryVoluntary` 自己做了**。
  //    它以前在"掷骰通过"时就写时间戳 —— 于是**判断还没跑就已经烧掉冷却**，
  //    判了"不说"也会让这条路静默 3~5 分钟（跟真人相反）。
  //    现在：`tryVoluntary` 只负责"能不能轮到我"，**真的开口了**才由
  //    `markVoluntary()` 记账（`shouldJoinChatAsync` 里调）。
  check(b.tryVoluntary('share', cfg, ev(G1)) === true, 'G1 第一次 → 放行');
  check(b.tryVoluntary('share', cfg, ev(G1)) === true, '★ 还没"说"就不烧冷却（第二次仍放行）');
  b.markVoluntary('share', ev(G1)); // ← 模拟"判断通过、她真的说了"
  check(b.tryVoluntary('share', cfg, ev(G1)) === false, 'G1 说过之后立刻第二次 → 被冷却挡住');
}

console.log('\n【2】★ 另一个群不该被连累（这就是修的那个 bug）');
{
  check(b.tryVoluntary('share', cfg, ev(G2)) === true, '★ G2 立刻也能接（改前会被 G1 挡住）');
  b.markVoluntary('share', ev(G2));
  check(b.tryVoluntary('share', cfg, ev(G2)) === false, 'G2 自己的冷却仍然生效');
}

console.log('\n【3】不同场景之间仍然互不影响（保持原设计）');
{
  check(b.tryVoluntary('sticker', cfg, ev(G1)) === true, 'G1 的 sticker 场景没被 share 连累');
}

console.log('\n【4】bucket 的构造');
{
  const k1 = b.voluntaryBucket('share', ev(G1));
  const k2 = b.voluntaryBucket('share', ev(G2));
  console.log(`     G1 → ${k1}`);
  console.log(`     G2 → ${k2}`);
  check(k1 !== k2, '两个群的 key 不同');
  check(k1.startsWith('share@') && k1.includes(G1), 'key = 场景@会话');
  // ⚠️ 有些调用点不传 event —— 不能抛错
  check(b.voluntaryBucket('share', null) === 'share', 'event 为 null 时不抛错（退回纯场景名）');
  check(b.voluntaryBucket(undefined, null) === '', 'scene 为 undefined 也不抛错');
}

console.log('\n【5】私聊也要能区分（没有 group_id）');
{
  const dm1 = { message_type: 'private', user_id: '40001', message: [] };
  const dm2 = { message_type: 'private', user_id: '40002', message: [] };
  check(
    b.voluntaryBucket('chat', dm1) !== b.voluntaryBucket('chat', dm2),
    '两个私聊用户的 key 不同（sessionKey 处理了没有 group_id 的情况）',
  );
}

console.log('\n【6】★ 「收紧度 ≤ 2 跳过 judge」这条必须仍然在（用户明确要求保留）');
{
  // ⚠️⚠️ 这条是**用户点名要保留**的：他当初把收紧度调成 0
  //    就是因为"冷却比较强"，0 档要靠冷却限流；现在他要调成 5 去测 judge。
  //    所以 ≤2 跳过 judge 必须**原样保留** —— 谁要是顺手删了，
  //    0 档就会同时有冷却 + judge 两道闸，机器人会突然变哑。
  const src = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    /if \(isLvl1 && Number\.isFinite\(sNum\) && sNum <= 2\) \{[\s\S]{0,200}?return join;/.test(src),
    '收紧度 ≤2 仍然直接 return（跳过 judge）—— 用户要求保留',
  );
  check(
    /this\.lastVoluntaryAt\[this\.voluntaryBucket\(mode, event\)\] = Date\.now\(\)/.test(src),
    '记账按群的 bucket（不只是同步版）',
  );
  check(
    /this\.markVoluntary\(join\.mode, event\)/.test(src),
    '异步版（判断通过那条路）也是走 `markVoluntary` 按群记',
  );
}

console.log('\n【7】★★ judge 机制通检（2026-09-15 用户要求「再检查一遍judge机制」）');
{
  const src = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const sj = readFileSync(join(ROOT, 'src', 'speak-judge.js'), 'utf8');

  // ── ① 「判了不说」不许再烧冷却 ───────────────────────────────
  // 原来 `tryVoluntary` 在**判断之前**就把 lastVoluntaryAt 写上了，
  // 于是"这次没接"会让这条路**整整 3~5 分钟全静默** —— 跟真人完全相反。
  check(
    !/noDice\) \{[\s\S]{0,200}?this\.lastVoluntaryAt\[bucket\] = now;/.test(src),
    '★「跳过掷骰」那条路不再提前烧冷却',
  );
  check(
    !/if \(Math\.random\(\) > p\)[\s\S]{0,120}?this\.lastVoluntaryAt\[bucket\] = now;/.test(src),
    '★ 掷骰过了也不再提前烧冷却（等判断通过才记）',
  );
  check(
    /judgeThrottleMs/.test(src) && /lastJudgeAt/.test(src),
    '★ 改用「判断节流」省调用费（跟说话冷却分开）',
  );

  // ── ② 判断出错 → 兜底「说」，而且要看得见 ──────────────────
  // 踩过：我写错一个变量名 → 每次都抛 → **她整场不开口**，只记 debug 查不出来。
  check(
    /说话判断出错（\$\{e\.message\}）→ 兜底照常说/.test(src),
    '★ 判断出错 → 兜底**照常说**（不再"按不说处理"让她整场哑掉）',
  );
  check(
    /log\.warn\(`\[主动接话\] 说话判断出错/.test(src),
    '  ↳ 而且提到 **warn**（坏了要看得见，别再埋在 debug 里）',
  );

  // ── ③ 「必须回」的四条路不许被触发冷却挡掉 ──────────────────
  //   ⚠️ 2026-09-15 晚加了后两条：**`reply-me`（引用她）** 和 **`call`（正文点名叫她）** ——
  //      都是明确召唤，被两秒冷却吃掉的话就等于没加。
  check(
    /const mustReply =[\s\S]{0,200}hit === 'at'[\s\S]{0,120}hit === 'reply-me'[\s\S]{0,80}hit === 'call'/.test(
      src,
    ),
    '★ @她 / **引用她** / **点名她** / 关键词 / 服务器问题 → **不受触发冷却影响**',
  );
  check(
    /if \(!mustReply && now - \(this\.lastReplyAt\.get\(key\) \?\? 0\) < config\.trigger\.cooldownMs\)/.test(src),
    '  ↳ 冷却只管"她主动接话"那条路',
  );

  // ── ④ 原来就对的几条，别在通检里改坏 ──────────────────────
  check(/默认闭嘴/.test(sj), 'judge 的「默认闭嘴」总原则还在');
  check(/你自己的状态（收住自己用）/.test(sj), '「你自己的状态」那段还在（4 号）');
  check(
    /if \(opts\.recentFromOthers && !opts\.voluntary\)/.test(sj),
    '「代码已判定两人对话」的直通短路还在（省一次调用）',
  );
  check(
    /const fallback = \{ speak: true/.test(sj),
    'judge 内部兜底仍是「照常说」（宁可多回一句，不能整体哑掉）',
  );
  check(
    /if \(join\.mode === 'echoSticker' \|\| join\.mode === 'sticker'\)/.test(src),
    '表情类仍然**不过** judge（不然会变成针对表情评论一句）',
  );
}

console.log('\n【8】★★ 她刚说完话 → 立刻清掉这个群的判断节流（2026-09-18 用户截图）');
{
  // ⚠️ `src` 是【7】那个块里的（块作用域），这里要自己读一份
  const src = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  // 症状：她回完「十点？…我明天可没这福气」，群里紧接着跟一句
  //   「那你这么晚还不睡」→ 日志里只有「判断节流中…这条没问她，不接」，
  //   那条消息**压根没被拿去问模型**，看着却像"她觉得无关"。
  check(
    /clearJudgeThrottle\(event\.group_id\)/.test(src),
    '★★ 她回复成功后**调了 clearJudgeThrottle**（不然紧跟的那条会被节流吞掉）',
  );
  check(
    /clearJudgeThrottle\(groupId\)\s*\{/.test(src),
    '★ 方法确实定义了',
  );
  check(
    /k\.endsWith\(':' \+ gid\)/.test(src),
    '★★ 按**群**清桶（`followUp@group:xxx`）—— 不许把别的群的节流一起清掉',
  );
  check(
    /Number\(config\.chat\?\.judgeThrottleMs\) \|\| 5000/.test(src),
    '★ 判断节流本身还在（只清"她刚说完话"这一次，刷屏省钱的效果没废）',
  );
}

try {
  rmSync(join(ROOT, CFG_REL), { force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
