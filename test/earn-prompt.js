/**
 * 「工资回答」的**去同质化**测试（2026-09-14 用户要求）。
 *
 * 用户原话（带截图）：
 *   「第一段话和第三段话**同质化**有点严重，经过 llm 润色了吗？
 *    你可以测试一下，**就这么多**和**九牛一毛**这两个词汇都反复出现了，
 *    然后**168 亿**这个结构出现的频率还是太高了」
 *
 * ## 实测到的真实数据（改之前）
 *
 * 同一个问题问 8 次（成功回 4 条）：
 *
 * | 词 | 出现在几次回答里 |
 * | --- | --- |
 * | 房租 | **4 / 4** |
 * | 第一份工资(单) | **4 / 4** |
 * | 168 亿 | **2 / 4**（骰子设的是 1/4） |
 * | 九牛一毛 | 1 / 4 |
 *
 * ## 三个根因（都在提示词里"送词"给模型抄）
 *
 * 1. **`phraseMoney` 铁律里有例句**：「要说也只能是领钱方的：
 *    『就这么点』『还不够花』」→ 模型**逐字抄**「就这么点」。
 * 2. **`earnReply` 的 extraRules 无条件写死 168 亿那一整段**，还给了三句示范
 *    （「九牛一毛都算不上」就在里面）→ **骰子那道闸被绕过**（事实里没给、提示词里还是提了）。
 * 3. **`comparePrev` 的文案带叙事**：「还没有账本，**这是第一份工资单**」
 *    → 模型把这句当情绪素材，每次都说。（账本事实只需要"没记录"）
 *    同理 `livingContext` 的房租那句是**固定文本** → 每次都被抄。
 *
 * ## 这个测试怎么测
 *
 * 起一个**假的 OpenAI 接口**，把 `earnReply()` 实际拼出来的
 * system + user 提示词**抓下来**，断言：
 *   · 里面**不含**那些会被抄的例句
 *   · 168 亿那段**只在骰子掷中时**才出现
 *   · 「第一份/头一次」这种叙事词不在事实里
 *   · 房租那几句是**轮换**的（不是永远同一句）
 *
 * ⚠️ 这是**离线**的（假模型 + 假接口，不联网、不花 token）。
 *
 * 用法: node test/earn-prompt.js
 */
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });

const PORT = 40301;
const CFG_REL = 'logs/__test-earn.yml';

// ⚠️ 环境变量/配置必须在 import `src/*` **之前**就位（`config.js` 是加载时读的）
writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    `  baseURL: http://127.0.0.1:${PORT}/v1`,
    '  apiKey: "sk-test"',
    '  model: test-model',
    '  maxTokens: 300',
    '  timeout: 8000',
    // 账本指向临时文件，不碰真账本
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;
process.env.QQBOT_SPEND_FILE = 'logs/__test-earn-spend.json';
process.env.QQBOT_SPEND_BASE = 'logs/__test-earn-base.json';
process.env.QQBOT_TIC_FILE = 'logs/__test-earn-tic.json';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

// ── 假模型：把每次收到的提示词存下来 ──────────────────
//
// ⚠️⚠️ 断言必须**分开看 system 和 user**（第一版合起来看 `all`，一下挂了 6 项）：
//   · `system` = 铁律 + 规则。里面**故意**有反面例句（「不说『别嫌少』」），
//     所以"提示词里不许出现 XX"这种断言不能拿它去搜 —— 会把反面教材当成违规。
//   · `user`  = 「系统实测数据」+ 事实。**这里才是模型照抄的来源**，
//     要断言"没有可抄的句子"就得搜这个。
const seen = [];
const llmServer = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {}
    const sys = parsed.messages?.find((m) => m.role === 'system')?.content ?? '';
    const user = parsed.messages?.find((m) => m.role === 'user')?.content ?? '';
    seen.push({ sys, user, all: `${sys}\n${user}` });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '2042，就这个数。' } }] }));
  });
});

await new Promise((r) => llmServer.listen(PORT, '127.0.0.1', r));

const spend = await import('../src/spend.js');

// ⚠️⚠️ **先给账本灌一点用量**，否则 `earned` 是 0，`livingContext()` 会直接返回
//    「（这个月没有收入）」，房租那条**根本不会生成** —— 测试就成了空转
//    （第一版就是这么挂的：房租轮换"有 0 种"）。
//    这里按每百万 token 1 元成本记一笔，`salaryOf` 是成本 ×100。
spend.record({ model: 'test-model', usage: { prompt_tokens: 6_000_000, completion_tokens: 2_000_000 } });
{
  const s = spend.salaryOf(spend.monthStats());
  if (!(s.earned > 0)) {
    console.error(`⚠️ 账本没灌进去（earned=${s.earned}），后面的断言会没意义`);
  } else {
    console.log(`（测试账本：工资 ${s.earned} 元 / 成本 ${s.cost} 元）`);
  }
}

/**
 * 跑一次 `earnReply`，返回它实际拼出来的提示词。
 *
 * ⚠️ `rand` **不能给常数**（第一版给 `() => 0`）：`livingContext` 里
 *    **先用随机数洗牌**、**最后才掷 168 亿那个骰子**。常数 0 会让洗牌里
 *    `Math.floor(0 * (i+1))` 恒为 0（等于没洗牌），而且骰子那一步永远读到同一个值。
 *    这里给一个**每次调用都往后走**的伪随机序列。
 */
let seed = 0;
const seq = (start = 0) => {
  let x = start;
  return () => {
    x = (x + 0.37) % 1;
    return x;
  };
};

async function capture({ rand, scope = 'month' } = {}) {
  seen.length = 0;
  const r = rand ?? seq(seed++);
  await spend.earnReply({ scope, asked: '赚了多少钱了', rand: r });
  const got = seen[0] ?? { sys: '', user: '', all: '' };
  if (process.env.EARN_DEBUG) {
    console.log(`    [dbg] earned=${spend.salaryOf(spend.monthStats()).earned}`);
    console.log(`    [dbg] 事实段里的参照行：`);
    for (const l of got.user.split('\n')) if (l.startsWith('·')) console.log(`        ${l}`);
  }
  return got;
}

console.log('\n【1】★ 不许给"可被逐字抄走"的例句');
{
  // ⚠️ 这些句子原来就写在提示词里，模型**原样抄**进了回复（用户截图里就是）
  const BANNED = ['就这么点', '还不够花', '你还没发呢', '就这么多了'];
  const p = await capture();
  for (const b of BANNED) {
    // ⚠️ 搜 `user`（事实段），不是 `all` —— `system` 里有反面例句是**故意**的
    check(!p.user.includes(b), `事实里没有可抄的例句「${b}」`);
  }
  check(!/要说也只能是领钱方的/.test(p.sys), '规则里也删掉了"领钱方该这么说"的示范');
  check(!/「就这么点」/.test(p.sys), '规则里没有再给带引号的可抄台词');
  // 方向铁律本身要留着（那是防"别嫌少"的老板口吻，用户明确要求过）
  check(/别嫌少/.test(p.sys), '「别嫌少」这条**禁令**仍然在（那是防老板口吻的）');
  check(/领工资的那个/.test(p.sys), '仍然交代了"你是领工资的那个"（立场铁律没丢）');
  check(/反例，不是模板/.test(p.sys), '明确告诉它上面那些是反例、不许搬字面');
}

console.log('\n【2】★ 168 亿：骰子没掷中就不能出现');
{
  // ⚠️⚠️ 「骰子永远不中」**不能靠一个递增序列** —— 第一版用 `seq(0.9)`
  //    （每次 +0.37），结果走满 24 步之后落到了 0.01，
  //    **正好落进 1/4 的骰子里**，于是"不中"的那次反而中了，测试假失败。
  //    洗牌那 24 次调用对**同一个常数**是安全的（`Math.floor(0.9*(i+1))`
  //    随 i 变化，照样洗得动），所以这里直接用常数 0.9。
  const off = await capture({ rand: () => 0.9 });
  check(!off.all.includes('168'), '骰子没中 → 提示词里**一个字都不提 168 亿**');
  check(!/偿还义务|欠条/.test(off.all), '骰子没中 → 那一整段（含"别撇清"）都不注入');

  // 骰子永远中 —— 所有值都必须 <0.25，**但要小步变化**
  // （常数会让洗牌退化：`Math.floor(0.1 * (i+1))` 里 i 小时恒为 0）
  let t = 0;
  const always = () => {
    t = (t + 1) % 20; // 0.005 / 0.015 / … / 0.195，全 < 0.25
    return 0.005 + t * 0.01;
  };
  const on = await capture({ rand: always });
  check(on.all.includes('168'), '骰子中了 → 事实里给出了 168 亿那条');
  check(/偿还义务/.test(on.all), '骰子中了 → 也带上了"别撇清"那条铁律');
  // ⚠️ 但即使给了，也**不许给现成的比方**（原来这三句就在里面）
  for (const s of ['九牛一毛', '就是个笑话', '我这点算什么']) {
    check(!on.all.includes(s), `即使给了 168 亿，也不给现成比方「${s}」`);
  }
}

console.log('\n【3】★ 事实里不能有"第一份工资单"这种叙事词');
{
  const BANNED = ['第一份', '头一次', '第一次', '开张'];
  const p = await capture();
  for (const b of BANNED) {
    check(!p.user.includes(b), `事实里没有叙事词「${b}」`);
  }
  check(/账本|记录/.test(p.user), '但仍然说清了"上月没记录"这个事实（不能干脆不说）');
}

console.log('\n【4】★ 房租那句要**轮换**（不能永远同一句）');
{
  // ⚠️ 这里**直接给 `livingContext` 传工资**，不靠走 `earnReply`。
  //    第一版走 `earnReply` 收集，结果账本被测试自己的调用一路推高
  //    （1400 → 3000+），中途跨过了 2500 这条线、换了分支，
  //    只收到 2 种写法 → 假失败。直接传参数就**不受账本影响**。
  const variantsOf = (yuan) => {
    const out = new Set();
    for (let i = 0; i < 40; i++) {
      const txt = spend.livingContext(yuan, { rand: () => 0.999 - i * 0.0249 });
      for (const line of txt.split('\n')) {
        if (/^\s*·/.test(line) && /合租|房租|2500/.test(line)) out.add(line.trim());
      }
    }
    return out;
  };

  const low = variantsOf(1400); // 工资不够房租那条分支
  const high = variantsOf(9000); // 够房租那条分支
  check(low.size >= 3, `工资偏低时房租说法有 ${low.size} 种`);
  check(high.size >= 2, `工资够房租时房租说法有 ${high.size} 种`);
  check(
    ![...low].some((l) => high.has(l)),
    '两个分支用的是**各自**的一组说法（没有混用）',
  );
  for (const v of low) console.log(`       低：「${v}」`);
  for (const v of high) console.log(`       高：「${v}」`);

  // 仍然确认一下 `earnReply` 拼出来的事实里真的带上了房租那条
  const p = await capture({ rand: () => 0.9 });
  check(/合租/.test(p.user), 'earnReply 的事实里确实有房租那条参照');
}

console.log('\n【5】"别每次都用同一件事当感想"这条要写进去');
{
  const p = await capture();
  check(/别每次|不一样|换个角度/.test(p.sys), '规则里明确要求"别每次同一件事实"');
  check(/房租/.test(p.sys) && /两三次/.test(p.sys), '点名了"房租"并给了频率上限（最多十次里两三次）');
}

console.log('\n【6】问"今天"时不该出现月度参照');
{
  // ⚠️ 用户 2026-09-13 要求：问今天挣了多少，别甩月度对比（答非所问）
  const day = await capture({ scope: 'day' });
  check(!/168/.test(day.all), '问"今天" → 不给 168 亿参照');
  check(!/合租|2500/.test(day.all), '问"今天" → 不给"够买几杯奶茶"那种物价参照');
  check(!/上月|上个月/.test(day.all), '问"今天" → 不甩月度对比');
  check(/今天/.test(day.all), '问"今天" → 说的是"今天"');
}

console.log('\n【7】数字仍然原样给出（别把上一轮的修复弄坏）');
{
  const p = await capture();
  // ⚠️ 数字不能用 `2042` 硬编码 —— 账本是临时的，金额会变。
  //    只断言"事实里有一个金额"，别断言具体数（第一版写死 2042 就挂了）。
  check(/·\s*工资：/.test(p.user), '事实里有"工资："这一项');
  check(/[0-9]/.test(p.user), '工资数额是个数字', p.user.split('\n').find((l) => l.includes('工资')) ?? '');
  check(/token/.test(p.user), 'token 数出现在事实里');
  // ⚠️ 「净赚/利润」这两个词在 system 里是**禁令**（"绝对不要说净赚"），
  //    所以只能断言**事实段**里没有 —— 用 `all` 会误伤。
  check(!/净赚|利润/.test(p.user), '事实段里没有「净赚/利润」');
}

// ── 收尾 ──────────────────────────────────────────────
await new Promise((r) => llmServer.close(r));
for (const f of ['__test-earn.yml', '__test-earn-spend.json', '__test-earn-base.json', '__test-earn-tic.json']) {
  try {
    rmSync(join(ROOT, 'logs', f), { force: true });
  } catch {}
}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
