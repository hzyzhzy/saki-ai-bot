/**
 * 账本测试（不连 NapCat、不调模型）。
 *
 * 验证 2026-09-13 用户提的两个问题：
 *   ① 「每月的数据不对啊，**机器人九月才创建**」——
 *      账单里冒出了 7 月/8 月（我造测试数据时手工塞进去的）。
 *      现在有 `epochDay` 闸门：早于机器人启用日的记录一律丢。
 *   ② 「**要加上 9 月 1 号到现在所有的**」——
 *      账本是 9/13 才建的，之前的花费得靠「起始账」补
 *      （数字从 https://platform.deepseek.com/usage 读）。
 *
 * ⚠️ 全程用 `QQBOT_SPEND_FILE` / `QQBOT_SPEND_BASE` 指向**临时账本**，
 *    绝不碰 `state/spend.json` —— 真账本里有用户真实的花费。
 *
 * 用法: node test/spend.js
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const T_FILE = 'state/_test-spend.json';
const T_BASE = 'state/_test-spend-base.json';
const STATE = join(ROOT, T_FILE);
const BASE = join(ROOT, T_BASE);

// ⚠️ 必须在 import spend.js **之前**设好，模块顶层就把它读走了
process.env.QQBOT_SPEND_FILE = T_FILE;
process.env.QQBOT_SPEND_BASE = T_BASE;

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};
const near = (a, b, tol = 0.005) => Math.abs(Number(a) - Number(b)) <= tol;
const cleanup = () => {
  for (const p of [STATE, BASE]) {
    try {
      existsSync(p) && unlinkSync(p);
    } catch {}
  }
};
cleanup(); // 上次跑崩了可能留了文件

const spend = await import('../src/spend.js');

console.log('\n【1】单价与高峰时段');
{
  // 空闲时段：命中 0.02 / 未命中 1 / 输出 4（元每百万）
  const off = new Date('2026-09-13T20:00:00+08:00'); // 周日，非高峰
  const c = spend.costOf({ model: 'deepseek-flash', promptTokens: 1e6, completionTokens: 1e6, cachedTokens: 0, at: off });
  check(near(c, 1 + 4), '空闲时段 100 万输入（全未命中）+ 100 万输出 = 5 元', `实际 ${c}`);
  const ch = spend.costOf({ model: 'deepseek-flash', promptTokens: 1e6, completionTokens: 0, cachedTokens: 1e6, at: off });
  check(near(ch, 0.02, 0.001), '缓存命中部分按 0.02 元/百万算', `实际 ${ch}`);

  // 高峰：工作日 09–12、14–18 → 命中 0.04 / 未命中 2 / 输出 8
  const peak = new Date('2026-09-14T10:00:00+08:00'); // 周一上午
  const cp = spend.costOf({ model: 'deepseek-flash', promptTokens: 1e6, completionTokens: 1e6, cachedTokens: 0, at: peak });
  check(near(cp, 2 + 8), '高峰时段同量 = 10 元（翻倍）', `实际 ${cp}`);
  check(spend.isPeak(peak) === true, '周一 10:00 判定为高峰');
  check(spend.isPeak(off) === false, '周日 20:00 判定为非高峰');
}

console.log('\n【2】幽灵月份（用户反馈的问题）不能再出现');
{
  const j = { days: {} };
  j.days['2026-07-15'] = { calls: 99, prompt: 9e6, completion: 9e5, cached: 0, cost: 42.5 };
  j.days['2026-08-20'] = { calls: 88, prompt: 8e6, completion: 8e5, cached: 0, cost: 31.5 };
  writeFileSync(STATE, JSON.stringify(j, null, 2), 'utf8');
  spend.reload(); // 走一遍"载入时剔脏数据"
  const months = spend.monthlyStats({ limit: 12 }).map((x) => x.month);
  check(!months.includes('2026-07'), '7 月不出现在往月账单里');
  check(!months.includes('2026-08'), '8 月不出现在往月账单里');
  check(!readFileSync(STATE, 'utf8').includes('2026-07'), '脏数据已被从账本文件里删掉');
  check(near(spend.monthStats('2026-07').cost, 0), '7 月的月份汇总也是 0');
}

console.log('\n【3】起始账（9/1–9/12 那笔）');
{
  writeFileSync(STATE, JSON.stringify({ days: {} }, null, 2), 'utf8');
  spend.reload();
  const before = spend.monthStats();
  check(near(before.cost, 0), '没设起始账时本月 = 0', `实际 ${before.cost}`);

  const nowBj = new Date(Date.now() + (8 * 60 + new Date().getTimezoneOffset()) * 60000);
  const day = nowBj.getDate();
  const month = `${nowBj.getFullYear()}-${String(nowBj.getMonth() + 1).padStart(2, '0')}`;
  const todayKey = `${month}-${String(day).padStart(2, '0')}`;

  // 真实场景：**今天有账本记录**，起始账只管"账本建好之前"的天
  writeFileSync(
    STATE,
    JSON.stringify({ days: { [todayKey]: { calls: 3, prompt: 1000, completion: 200, cached: 0, cost: 0.5 } } }, null, 2),
    'utf8',
  );
  spend.reload();

  spend.setBaseline(month, 9.08);
  const ms = spend.monthStats(month);
  const wantDays = day - 1; // 今天之前的天数全是补记
  // 分摊单价 = 起始账 / 空白天数（见 src/spend.js 的 perDay() 推导）
  const blankDays = day - 1; // 本月只有"今天"有账
  const want = 0.5 + (9.08 / blankDays) * wantDays;
  check(near(ms.cost, want, 0.001), '起始账只补"今天之前"，今天用真实记录', `期望 ${want.toFixed(3)} 实际 ${ms.cost.toFixed(3)}`);
  check(ms.baseDays === wantDays, `补记天数 = 今天之前的天数（${wantDays}）`, `实际 ${ms.baseDays}`);
  check(ms.calls === 3, '补记不虚增调用次数', `实际 ${ms.calls}`);
  check(ms.days === wantDays + 1, '覆盖天数 = 补记天数 + 今天', `实际 ${ms.days}`);

  // 「摊」的核心保证：**本月合计 == 用量页面上的累计**
  {
    const TARGET = 18.34;
    spend.setBaselineTotal(month, TARGET);
    const got = spend.monthStats(month);
    check(near(got.cost, TARGET, 0.001), 'setBaselineTotal 后，本月合计 == 用量页面的累计', `期望 ${TARGET} 实际 ${got.cost.toFixed(4)}`);
    // 按天问加起来也要等于同一个数（不能按月一个数、按天另一个数）
    let sum = 0;
    for (let d = 1; d <= day; d += 1) {
      sum += spend.dayStats(`${month}-${String(d).padStart(2, '0')}`).cost;
    }
    check(near(sum, TARGET, 0.001), '逐日加起来也 == 累计（按月/按天口径一致）', `实际 ${sum.toFixed(4)}`);
    spend.setBaseline(month, 9.08); // 还原成上面那步的设定
  }

  const txt = spend.spendText('month');
  check(!txt.includes('**'), '账单文本不含 Markdown 星号（要原样发到群里）');
  check(/账本建好之前补记/.test(txt), '账单里注明了哪部分是补记的');
  check(!/别解释算式|提示词/.test(txt), '账单里没夹带"给模型看的指令"');
  // ⚠️ 用户 2026-09-13：「不要说净赚」
  check(!/净赚|利润/.test(txt), '账单里**没有**「净赚/利润」这种账房词');
  check(!/净赚|利润/.test(spend.earnText('month')), '工资模板里也没有「净赚」');

  // 工资 = 成本 ×100
  const s = spend.salaryOf(ms);
  check(near(s.earned, ms.cost * 100, 0.01), '工资 = 成本 ×100');
  check(s.profit === undefined, 'salaryOf **不再产出** profit 字段（从源头堵住）');

  // 取消：那一笔补记要消失，只剩下真实记录
  spend.setBaseline(month, 0);
  const after = spend.monthStats(month);
  check(after.baseDays === undefined && near(after.cost, 0.5), '起始账传 0 能取消（只剩真实开销）', `实际 ${after.cost.toFixed(4)}`);
}

console.log('\n【4】起始账的闸门');
{
  let threw = false;
  try {
    spend.setBaseline('2026/09', 1);
  } catch {
    threw = true;
  }
  check(threw, '月份格式不对会拒绝（不静默写坏）');

  let futureThrew = false;
  try {
    spend.setBaseline('2099-01', 5);
  } catch {
    futureThrew = true;
  }
  check(futureThrew, '未来月份会被拒绝（不能补还没到的账）');
  check(!Object.keys(spend.baselineOf()).includes('2099-01'), '未来月份没被写进起始账');
}

// ─────────────────────────────────────────────────────────────
console.log('\n【★】★★ 每一处打模型的地方都必须记账（2026-09-15 加的"结构性"断言）');
//
// ⚠️⚠️ 为什么要有这一条：<主人> 报「刚才几段对话余额变动异常，掉的比以前快很多」。
//    查下来 ① 当时是**高峰时段**（周二 9:00-12:00，按价格表是**双倍**），
//    ② `src/extract.js` / `src/search-plan.js` / `src/vision.js` 这三处
//       是**各自直接 fetch 打 `/chat/completions`** 的，
//       而且**都没有 `spend.record`** —— 于是真实余额掉得比账本快。
//    这三处已经补上了；这条断言就是**防止以后再加一条路时又漏掉**：
//    数一数源码里有几处 `chat/completions`，就得有几处记账。
{
  const { readdirSync } = await import('node:fs');
  const offenders = [];
  for (const f of readdirSync(join(ROOT, 'src')).filter((n) => n.endsWith('.js'))) {
    const src = readFileSync(join(ROOT, 'src', f), 'utf8');
    const hits = (src.match(/chat\/completions/g) ?? []).length;
    if (!hits) continue;
    // `spend.record(` 和 `recordSpend(` 都算（后者是直接 fetch 那几个模块的别名导入）
    const recs = (src.match(/spend\.record\(|recordSpend\(/g) ?? []).length;
    if (hits > recs) offenders.push(`${f}（打模型 ${hits} 次，只记账 ${recs} 次）`);
  }
  check(offenders.length === 0, '★★ 打模型的地方全都记账了', offenders.join('；'));
  // 反向锚定：这三处**曾经漏掉**的，别再退回直接 fetch 不记账
  for (const f of ['extract.js', 'search-plan.js', 'vision.js']) {
    const src = readFileSync(join(ROOT, 'src', f), 'utf8');
    check(/recordSpend\(/.test(src), `★ ${f} 那条路记账了（原来漏的就是它）`);
  }
}

// ─────────────────────────────────────────────────────────────
console.log('\n【★★】直接 fetch 那条路**真的**会记账（端到端，不是只看源码）');
//
// ⚠️ 上面那条是"结构性"断言（数源码处数），这条是**行为**断言：
//    起一个假模型，让它返回 `usage`，然后真的调一次 `extract.detectKnowledge()`，
//    看账本有没有多出这一次调用。两条一起才说明问题真修好了 ——
//    光加一行 `spend.record` 但放错位置（比如在 `return` 之后）源码也数得出来。
{
  const { createServer } = await import('node:http');
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            { message: { role: 'assistant', content: '{"hasKnowledge":false,"natural":false,"topic":"","fact":""}' } },
          ],
          usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_cache_hit_tokens: 0 },
        }),
      );
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const { config } = await import('../src/config.js');
  const extract = await import('../src/extract.js');
  // ⚠️ `config` 是个普通对象，`extract.js` 是**调用时**才读 `config.llm.baseURL` 的，
  //    所以这里临时改指向假服务是安全的（跑完改回去）
  const oldBase = config.llm.baseURL;
  const oldKey = config.llm.apiKey;
  config.llm.baseURL = `http://127.0.0.1:${port}/v1`;
  config.llm.apiKey = 'sk-test';

  const before = spend.dayStats().calls;
  let threw = '';
  try {
    await extract.detectKnowledge('这句话里有没有知识', 'natural', '');
  } catch (e) {
    threw = e.message;
  }
  const after = spend.dayStats().calls;

  config.llm.baseURL = oldBase;
  config.llm.apiKey = oldKey;
  await new Promise((r) => srv.close(r));

  check(!threw, `调用没炸${threw ? `（${threw}）` : ''}`);
  check(after === before + 1, `★★ extract 那次调用**记进账本了**（${before} → ${after}）`);
  const d = spend.dayStats();
  check(d.prompt >= 1000 && d.completion >= 500, `★★ token 也记对了（输入 ${d.prompt}、输出 ${d.completion}）`);
}

console.log('\n【★★】报账那条路必须「记一笔对话」（<主人> 截图：接着问没回我）');
{
  // 用户原话：「两个问题，没有自然语言了，然后我接着问没回我」
  // ⚠️ 根因：报账是 `handle()` 里**提前 return 的特殊回复**，
  //    而 `touchConversation()` 在正常回复那条路的末尾才调 ——
  //    于是她没记「刚回过话」，用户接着说的一句（没 @、没关键词）不算"对话延续" → 不接。
  const botSrc = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const i = botSrc.indexOf('// ⚠️ 「今天花了多少钱」');
  check(i > 0, '找得到报账那段');
  const seg = botSrc.slice(i, i + 4200);
  check(/touchConversation\(event\)/.test(seg), '★★ 报账那条路也调了 `touchConversation`');
  check(/recent\.rememberBot\(event/.test(seg), '★★ 而且把自己报的账记进了聊天上下文');
  // 位置要对：必须在 `return` **之前**
  const iSend = seg.indexOf('await this.sendText(event, line, { reply: true })');
  const iTouch = seg.indexOf('this.touchConversation(event)');
  const iRet = seg.indexOf('return;', iSend);
  check(iSend > 0 && iTouch > iSend && iRet > iTouch, '★★ 顺序是：发出去 → 记上下文 → touch → 才 return');
  // 润色失败要**重试一次**、而且失败要 warn（原来记 debug，日志里看不见）
  check(/attempt < 2/.test(seg), '★ 润色失败会重试一次');
  check(/log\.warn\(`\[花销\] 报账润色失败/.test(seg), '★ 失败用 warn 记（原来 debug，等于没记）');
  check(/润色两次都没成 → 退回模板/.test(seg), '★ 退模板时也留一条能看见的日志');
  // 顺手：B站那条也是提前 return，同样要记对话
  const j = botSrc.indexOf('looksLikeVideoQuestion');
  const seg2 = botSrc.slice(j, j + 3000);
  check(/touchConversation\(event\)/.test(seg2), '★★ B站那条提前 return 的路也补了 `touchConversation`');
}

cleanup();
console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
