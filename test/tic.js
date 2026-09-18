/**
 * 口癖节流测试（2026-09-14）。
 *
 * 用户原话：「**问这个干嘛**这种反问感觉**过于频繁**，有点**不亲近**的感觉，
 *   可以适当抑制一下」
 *
 * ⚠️ 为什么这个测试重要：这已经是**第二次**同一个毛病了
 *    （上次是「被抓了别报我名字」，实测 10 次里出现了 6 次）。
 *    上次只在 `persona.md` 里写了「别当口癖」，结果换句句子接着犯 ——
 *    因为**提示词是无状态的，模型不知道自己上一句说了什么**。
 *    所以这道闸在**代码里**（`src/tic.js`），必须有测试盯着。
 *
 * 用法: node test/tic.js
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });

// ⚠️ 两个环境变量都必须在 import `src/*` **之前**设好 ——
//    `config.js` / `tic.js` 都是模块加载时就初始化（踩过好几次的坑）。
// ⚠️ 而且状态文件必须指向别处（`QQBOT_TIC_FILE`）——
//    不指的话测试会往真实的 `state/tic.json` 里灌记录，
//    正好把"口癖"注进用户正在用的那个群。
const CFG_REL = 'logs/__test-tic.yml';
const TIC_FILE_REL = 'logs/__test-tic-state.json';
writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
    '  apiKey: "sk-test"',
    '  model: test-model',
    'tic:',
    '  enable: true',
    '  windowMs: 7200000',
    '  repeatLimit: 3',
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;
process.env.QQBOT_TIC_FILE = TIC_FILE_REL;

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const TIC_PATH = join(ROOT, TIC_FILE_REL);
const readState = () => JSON.parse(readFileSync(TIC_PATH, 'utf8'));
rmSync(TIC_PATH, { force: true });

const tic = await import('../src/tic.js');
const { config } = await import('../src/config.js');

/** 每个 case 开始前清干净（不然 case 之间互相污染 —— 第一版就是这么挂的） */
const fresh = () => {
  tic.__clear();
  tic.reload();
};

const G = '200000001';
const OTHER = '200000005';

console.log('\n【1】开头特征怎么取');
{
  // ⚠️ `headOf` 取的是**前 4 个字**（口癖的特征在开口那一下），
  //    标点必须先剔掉 —— 否则「问这个干嘛。」和「问这个干嘛，」会被当成两句。
  const same = ['问这个干嘛。', '问这个干嘛，还行', '问这个干嘛', '问这个干嘛啊'];
  const heads = same.map((t) => tic.headOf(t));
  check(new Set(heads).size === 1, `同一句话的 4 种标点写法 → 同一个开头`, JSON.stringify(heads[0]));
  check(heads[0].length === 4, `开头长度固定 4 个字（${heads[0]}）`);

  check(tic.headOf('还行，饿不着自己') !== tic.headOf('问这个干嘛。'), '不同的开头能区分');

  // 太短的没有可跟踪的特征（不记，免得误判）
  for (const t of ['', '嗯', '好', '？？', '草']) {
    check(tic.headOf(t) === '', `「${t}」太短 → 不跟踪`);
  }
}

console.log('\n【2】★ 说三次同一个开场白 → 判定为口癖');
{
  fresh();
  check(tic.repeated(G) === null, '一开始没有口癖');
  check(tic.ticHint(G) === '', '一开始不注入任何提示（不能空着也注入）');

  tic.note(G, '问这个干嘛。还行，饿不着自己');
  check(tic.repeated(G) === null, '说 1 次：还没到阈值（说话本来就会重复）');

  tic.note(G, '问这个干嘛，我又没欠你钱');
  check(tic.repeated(G) === null, '说 2 次：仍然不算（同一个话题接着问就会这样）');

  tic.note(G, '问这个干嘛……');
  const r = tic.repeated(G);
  check(!!r, '说 3 次：**判定为口癖**');
  check(r?.g === tic.headOf('问这个干嘛。') && r?.count === 3, `记录正确（${r?.g} × ${r?.count}）`);
}

console.log('\n【3】★ 判定之后要真的往提示词里写东西');
{
  const hint = tic.ticHint(G);
  check(hint.length > 0, '生成了抑制提示');
  // ⚠️ 提示里必须**点名那个开头**，光说"别当口癖"模型不知道改哪句
  check(hint.includes(tic.headOf('问这个干嘛。')), `提示里点名了那个开头（${tic.headOf('问这个干嘛。')}）`);
  check(/口癖/.test(hint), '明确说了这是口癖');
  // ⚠️ 光说"别用"的话，模型会换一句**新的套话** —— 必须给出替代方向
  check(/正面回答|直接说事|换个说法/.test(hint), '给出了替代方案（不是只禁止）');
  check(!/禁止说|不许说|绝对不能说/.test(hint), '措辞不是硬禁令（硬禁令读起来像在骂它）');
}

console.log('\n【4】别的群不受影响');
{
  fresh();
  check(tic.repeated(OTHER) === null, '另一个群没有口癖记录');
  check(tic.ticHint(OTHER) === '', '另一个群不会被注入提示');
  for (let i = 0; i < 3; i++) tic.note(G, '问这个干嘛。');
  check(tic.repeated(G)?.count === 3, '这个群说了 3 次 → 算');
  check(tic.repeated(OTHER) === null, '另一个群仍然不算（计数是按群分开的）');
  // ⚠️ 用**另一个开头**，不然就撞上这个群刚才那 3 次了（第一版就是这么挂的）。
  //    而且它也得够 4 个字 —— 「还行吧」会被 `headOf` 判成太短。
  tic.note(OTHER, '还行，饿不着');
  // ⚠️ `repeated()` 回答的是"**算不算口癖**"，不是"说了几次" ——
  //    没到阈值时故意返回 null（不是 `{count:1}`）。
  //    所以这里要断言 null，同时用 `status().recent` 确认"确实记下来了"。
  const ro = tic.repeated(OTHER);
  check(ro === null, '在另一个群只记 1 次 → 不算口癖', JSON.stringify(ro));
  check(
    tic.status(OTHER).recent.length === 1,
    '但这一条**确实记下来了**（不是没记上）',
    JSON.stringify(tic.status(OTHER).recent),
  );
  check(tic.repeated(G)?.count === 3, '这个群的计数不受影响');
}

console.log('\n【5】换个口癖也能抓到（不是写死某一句）');
{
  fresh();
  for (let i = 0; i < 3; i++) tic.note(G, '被抓了别报我名字');
  const r = tic.repeated(G);
  check(!!r, '换一句照样抓到 —— 盯的是"重复"，不是某一句');
  check(r?.g === tic.headOf('被抓了别报我名字'), `抓到的是新那句（${r?.g}）`);
  check(tic.ticHint(G).includes(r.g), '提示指向的是新的那句');
}

console.log('\n【6】窗口过期后不再算口癖');
{
  // ⚠️ 隔了一天再说是口癖就没意义了（人也记不住）。
  //    这里直接改落盘文件里的时间戳，不真等 2 小时。
  fresh();
  for (let i = 0; i < 3; i++) tic.note(G, '问这个干嘛。');
  check(tic.repeated(G)?.count === 3, '刚说完 → 算口癖');

  const j = readState();
  const old = Date.now() - 3 * 60 * 60 * 1000; // 3 小时前（窗口是 2 小时）
  for (const x of j.groups[G] ?? []) x.at = old;
  writeFileSync(TIC_PATH, JSON.stringify(j), 'utf8');

  tic.reload();
  check(tic.repeated(G) === null, '3 小时前的记录 → 不再算口癖（窗口生效）');
}

console.log('\n【7】重启后记录还在（落盘）');
{
  fresh();
  for (let i = 0; i < 3; i++) tic.note(G, '问这个干嘛。');
  check(existsSync(TIC_PATH), '写了 state 文件');

  const j = readState();
  check(
    Array.isArray(j.groups?.[G]) && j.groups[G].length === 3,
    `文件里存着 3 条记录`,
    JSON.stringify(j.groups?.[G]?.length),
  );

  // ⚠️ 这一步是关键：模拟"机器人重启"。
  //    如果 `tic.js` 不在模块加载时 `reload()`，重启后记忆就空了 ——
  //    而那道闸**不会报错，只是静默失效**。
  //    这里用一个**干净的子进程**来验"加载即有记录"，而不是只检查源码里有没有那行字
  //    （只 grep 源码的话，把 `reload()` 放到别的函数里也能骗过测试）。
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(
    process.execPath,
    [
      '-e',
      `const tic = await import('./src/tic.js');
       const s = tic.status('${G}');
       console.log(JSON.stringify({ records: s.records, repeated: s.repeated }));`,
      '--input-type=module',
    ],
    {
      cwd: ROOT,
      env: { ...process.env, QQBOT_CONFIG: CFG_REL, QQBOT_TIC_FILE: TIC_FILE_REL },
      encoding: 'utf8',
    },
  ).trim();
  const got = JSON.parse(out.split('\n').pop());
  check(
    got.records === 3 && got.repeated?.count === 3,
    `★ 新进程一加载就读到了记录（records=${got.records}）`,
  );
}

console.log('\n【8】关掉开关就完全不工作');
{
  fresh();
  const before = config.tic.enable;
  config.tic.enable = false;
  for (let i = 0; i < 5; i++) tic.note(G, '问这个干嘛。');
  check(tic.repeated(G)?.count === 5, '记录仍然在数（关掉的只是"注入"）');
  check(tic.ticHint(G) === '', 'tic.enable=false → 不注入提示');
  config.tic.enable = before;
}

console.log('\n【9】status() 给管理界面看');
{
  fresh();
  tic.note(G, '问这个干嘛。');
  // ⚠️ 第二个开头也得够 4 个字 —— 「还行吧」会被 `headOf` 判成太短而不记（第一版就挂在这）
  tic.note(G, '饿不着自己的');
  const s = tic.status(G);
  check(s.records === 2 && s.groups === 1, `统计正确（${s.records} 条 / ${s.groups} 个群）`);
  check(Array.isArray(s.recent) && s.recent.length === 2, '能列出最近的开头');
  check(s.repeatLimit >= 2 && s.windowMs > 0, `暴露了阈值和窗口（${s.repeatLimit} 次 / ${s.windowMs}ms）`);
}

console.log('\n【10】★ 不能污染真实状态文件');
{
  // ⚠️ 这条是**安全断言**，而且是真踩过的：
  //    第一版跑到回归里，`state/tic.json` 被灌进了 `good我来 ×4`、`这是一条 ×2`、
  //    `啊对了还`、`Hell`…… **全是假模型造出来的句子**。
  //    麻烦在于写盘的是**子进程里的机器人**（十几个套件各自 spawn 它），
  //    逐个去补 spawn 的 env 不现实 —— 所以 `tic.js` 改成
  //    **配置文件名带 `test` 就自动写到 `state/__test-*.json`**。
  const real = join(ROOT, 'state', 'tic.json');
  check(process.env.QQBOT_TIC_FILE === TIC_FILE_REL, '测试通过 QQBOT_TIC_FILE 指向了独立文件');
  check(TIC_PATH !== real, '测试用的不是真实的 state/tic.json');
  check(tic.path() === TIC_PATH, `tic.path() 和测试以为的一致（${tic.path()}）`);

  // ★ 关键：**没有** QQBOT_TIC_FILE 时，靠配置文件名自己隔离。
  //   用一个干净的子进程验 —— 只是 grep 源码不算验。
  const { execFileSync } = await import('node:child_process');
  const probe = (env) =>
    execFileSync(
      process.execPath,
      ['-e', `const t = await import('./src/tic.js'); console.log(t.path());`, '--input-type=module'],
      { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' },
    ).trim().split('\n').pop();

  const withTestCfg = probe({ QQBOT_TIC_FILE: '', QQBOT_CONFIG: 'config.cs-test.yml' });
  check(
    withTestCfg.includes('__test-') && !/state[\\/]tic\.json$/.test(withTestCfg),
    `配置文件带 test → 自动隔离（${basename(withTestCfg)}）`,
  );

  const withRealCfg = probe({ QQBOT_TIC_FILE: '', QQBOT_CONFIG: 'config.yml' });
  check(
    /state[\\/]tic\.json$/.test(withRealCfg),
    `真实配置文件 → 用真实的 state/tic.json（${basename(withRealCfg)}）`,
  );
}

console.log('\n【11】私聊不该被记账');
{
  // ⚠️ 私聊没有 `group_id`。第一版没挡，回归里真的出现过一组
  //    `"undefined": [{"head":"Hell"}]` —— 私聊的回复被记进了一个叫
  //    "undefined" 的"群"。私聊是 1v1，不存在"群里老这么开口"的问题。
  fresh();
  tic.note(undefined, '这是一条私聊回复');
  tic.note(null, '这是一条私聊回复');
  tic.note('', '这是一条私聊回复');
  const s = tic.status();
  check(s.groups === 0 && s.records === 0, '私聊/空群号 → 一条都不记', JSON.stringify(s));
}

// ── 收尾 ──────────────────────────────────────────────
console.log('\n【12】★ 句中口癖：「哪看到的」（2026-09-14 用户反馈）');
{
  // 用户原话：「"**哪看到的**"这个小句子发的频率有点略高了」
  //   然后补了关键的一句：「**我不是说完全不能说，而是遣词造句要有一点变化**，
  //   要不然我不会记忆这么深刻」——
  //   也就是**重复本身就够让人记住了，不需要高频**。
  //
  // ⚠️ 而 `headOf`（只记开头 4 字）**完全管不到**这两条真实实例：
  //     · 「中国人能飞」……哪看来的，你倒是说说   ← 在句中
  //     · 哪看到的？想看登录设备的话…              ← 字面还变了
  //    所以加了 `clausesOf()`。
  fresh();

  // ★ 判据是「同一句回复里、跨句重复的短串」
  const c1 = tic.clausesOf('「中国人能飞」……哪看来的，你倒是说说。你哪看来的这种说法');
  check(c1.includes('哪看来的'), '★ 抓到「哪看来的」（句中重复）', JSON.stringify(c1));
  const c2 = tic.clausesOf('哪看到的？想看登录设备的话，QQ 设置里能翻到。我哪看到的还要报备？');
  check(c2.includes('哪看到的'), '★ 抓到「哪看到的」', JSON.stringify(c2));

  // ⚠️ 反向：不能误伤正常句子 —— 这是最危险的地方
  //    （我一开始想用"最常出现的 4 个字"，那会抓到 `看到的`，正常句子全中）
  check(
    tic.clausesOf('这个工具看到的都告诉你。它看到的范围挺大的').length === 0,
    '「…看到的都…」这种**只出现一次的正常词组不抓**',
  );
  check(tic.clausesOf('行吧，知道了').length === 0, '普通短句不抓');
  check(tic.clausesOf('').length === 0, '空串安全');
  check(tic.clausesOf('只有一句话没有重复').length === 0, '只有一句时无法跨句重复 → 不抓');
}

console.log('\n【13】★ 句中口癖要真的触发「换个说法」的提示');
{
  fresh();
  const G3 = '200000001';
  // ⚠️ 每次 note 的文本里，那个说法必须**跨句出现两次**才会被 `clausesOf` 抓到
  //    （判据就是"同一句回复里重复 = 套话"）。
  //    我第一版每条只写了一次 → `clausesOf` 返回空 → 抓到的是开头那个 head
  //    （"你别问了"），于是"抓到的是句中短串"这条假失败。
  for (let i = 0; i < 3; i++) {
    tic.note(G3, `哪看来的？我哪看来的还要跟你报备。第${i}次了`);
  }
  const r = tic.repeated(G3);
  check(!!r, '判定了口癖');
  check(r?.g === '哪看来的' && r?.kind === 'clause', `抓到的是句中短串（${r?.g} / ${r?.kind}）`);
  const hint = tic.ticHint(G3);
  check(hint.includes('哪看来的'), '提示里点名了那个说法');
  check(/措辞|换个说法/.test(hint), '提示说的是"换措辞"而不是"换个开头"');
  // ⚠️ 用户的原话要能传达出去：不是不许说，是要有变化
  check(/遣词造句/.test(hint), '提示里带了「遣词造句要有一点变化」的意思（不是禁言）');
}

console.log('\n【14】开头和句中是两类，互不覆盖');
{
  fresh();
  const G4 = '200000001';
  for (let i = 0; i < 3; i++) tic.note(G4, '问这个干嘛。还行吧');
  const head = tic.repeated(G4);
  check(head?.kind === 'head', `纯开头口癖仍然是 head 类（${head?.g}）`);
  check(tic.ticHint(G4).includes('你最近老这么开口'), 'head 类用"老这么开口"的措辞');
}

console.log('\n【15】★ 口癖词：「倒是」（2026-09-17 用户反馈）');
{
  // 用户原话：「先把这个 **倒是** 这个词频率修一下，感觉很高」。
  // 实例：「还没呢，等交完班再说。**你倒是**先吃上了（」
  //
  // ⚠️ 它同时卡在前两层机制的盲区里 —— 这两条断言就是"为什么还要第三层"的证据：
  fresh();
  check(
    tic.headOf('还没呢，你倒是先吃上了') !== '倒是',
    '它在句中 → headOf（只看开头 4 字）抓不到',
  );
  check(
    tic.clausesOf('还没呢，等交完班再说。你倒是先吃上了').length === 0,
    '每条只出现一次 → clausesOf（要求跨句重复）也抓不到',
  );

  tic.note(G, '还没呢，等交完班再说。你倒是先吃上了（');
  check(tic.repeated(G) === null, '说 1 次：不提醒（这个词本身是正常语气，不是脏话）');

  tic.note(G, '你倒是说说看，这图哪来的');
  const r = tic.repeated(G);
  check(
    !!r && r.g === '倒是' && r.kind === 'word' && r.count === 2,
    `★ 说 2 次就判定为口癖（${r?.g} / ${r?.kind} / ${r?.count} 次）`,
  );

  const hint = tic.ticHint(G);
  check(hint.includes('倒是'), '提示里点名了「倒是」');
  check(/同一个词/.test(hint), '措辞说的是"老用同一个词"（不是"老这么开口"）');
  check(/不是说完全不能说|遣词造句/.test(hint), '仍然带了"不是禁言"的意思（用户的原话）');
  check(!/禁止说|不许说|绝对不能说/.test(hint), '措辞不是硬禁令');

  // ⚠️ 反向：正常用这个词不该被"见到就拦" —— 拦的是**高频**，不是词本身
  check(tic.wordsOf('这倒是真的').length === 1, '命中就是命中，频率交给阈值管');
}

console.log('\n【16】口癖词表可以改，表外的词不乱抓');
{
  fresh();
  const before = config.tic.words;
  config.tic.words = ['貌似', '倒是'];
  check(tic.wordsOf('他貌似不太高兴').includes('貌似'), 'config 里加的词生效');
  check(tic.wordsOf('这倒是真的').includes('倒是'), '表里原有的词仍在');
  check(tic.wordsOf('他好像不太高兴').length === 0, '表里没有的词不抓（不自动统计所有词）');
  check(tic.status(G).words.includes('貌似'), 'status() 能列出当前词表（管理界面/自检要看）');
  config.tic.words = before;
}

try {
  rmSync(TIC_PATH, { force: true });
  rmSync(join(ROOT, CFG_REL), { force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
