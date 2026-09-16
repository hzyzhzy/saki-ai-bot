/**
 * 月末工资单测试（离线，不连 NapCat、不调模型）。
 *
 * 验证 2026-09-13 用户要求的那条：
 *   「每月末最后一天晚 9 点自动发送这个月的工资情况……
 *     如果因为 QQ 掉线正好没发送，当恢复上线之后马上补发」
 *
 * 最容易出错的**不是**"到点发"，而是**补发那一下**：
 *   · 发失败不能记账（记账了就永远不补了）
 *   · 发成功必须记账（不记就会重发）
 *   · 发成功之后重启不能重发（状态要落盘）
 *
 * ⚠️ 用 `QQBOT_MONTHLY_FILE` / `QQBOT_SPEND_*` 指向临时文件，不碰真实状态。
 *
 * 用法: node test/monthly-report.js
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const T = {
  monthly: 'state/_test-monthly.json',
  spend: 'state/_test-monthly-spend.json',
  base: 'state/_test-monthly-base.json',
};
process.env.QQBOT_MONTHLY_FILE = T.monthly;
process.env.QQBOT_SPEND_FILE = T.spend;
process.env.QQBOT_SPEND_BASE = T.base;

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};
const clean = () => {
  for (const p of Object.values(T)) {
    try {
      existsSync(join(ROOT, p)) && unlinkSync(join(ROOT, p));
    } catch {}
  }
  // ⚠️ 光删文件不够 —— 模块内存里那份还在，`pending()` 照样认为"发过了"。
  //    这正是补发逻辑最容易骗过测试的地方（我第一版就漏了 reload）。
  //    用 typeof 探测：模块导入**之前**也会调 clean()（TDZ 下直接引用会抛）。
  if (typeof monthly !== 'undefined') monthly.reload();
};

const monthly = await import('../src/monthly-report.js');
const spend = await import('../src/spend.js');
const { config } = await import('../src/config.js');
clean(); // ⚠️ 要放在 import 之后：clean() 里会调 monthly.reload()

const HOUR = Number(config.monthlyReport?.hour ?? 21);
const nowBj = new Date(Date.now() + (8 * 60 + new Date().getTimezoneOffset()) * 60000);

/** 相对"现在"的第 n 个月（n=0 本月、n=-1 上月）；用它造账，才不会撞上"启用日闸门" */
const ym = (n = 0) => {
  const d = new Date(nowBj.getFullYear(), nowBj.getMonth() + n, 10, 22, 0);
  return { key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, at: d };
};
// ⚠️ 为什么不拿"真正的上个月"来测"相比上月"：
//    上个月在时间上早于机器人启用日，而 `record()` / `reload()` 有个**故意的**
//    闸门会剔掉启用日之前的记录（防止手工塞的脏数据混进账单）。
//    所以这里换个不会过期、也不会被闸门拦的取法：
//      · 往**本月**记一笔账（本月 ≥ 启用日，能留住）
//      · 把**下个月**当成"发工资单的那个月" → 它的"上月"正好是本月
//    这样"两边都有账"的比较路径才测得动。
const THIS = ym(0);
const NEXT = ym(1);

console.log('\n【1】该发时刻算得对不对');
{
  const due = monthly.dueAt('2026-09');
  check(due.getMonth() === 8 && due.getDate() === 30, '9 月末 = 9/30', `实际 ${due.toLocaleString()}`);
  check(due.getHours() === HOUR, `时刻 = ${HOUR} 点`, `实际 ${due.getHours()} 点`);
  check(monthly.dueAt('2026-02').getDate() === 28, '平年 2 月末 = 2/28');
  check(monthly.dueAt('2024-02').getDate() === 29, '闰年 2 月末 = 2/29（别写死 28）');
  check(monthly.dueAt('2026-04').getDate() === 30, '4 月末 = 4/30（小月）');
  check(monthly.dueAt('2026-01').getDate() === 31, '1 月末 = 1/31');
}

console.log('\n【2】到点之前不发');
{
  const before = new Date(2026, 8, 30, HOUR - 1, 0); // 9/30 20:00
  check(monthly.pending({ now: before, month: '2026-09' }) === null, `9/30 ${HOUR - 1}:00 不发`);
  const mid = new Date(2026, 8, 15, 23, 0); // 9/15
  check(monthly.pending({ now: mid, month: '2026-09' }) === null, '月中不发');
}

console.log('\n【3】到点就发');
{
  const after = new Date(2026, 8, 30, HOUR, 5); // 9/30 21:05
  const p = monthly.pending({ now: after, month: '2026-09' });
  check(p?.month === '2026-09', '到点后判定该发', JSON.stringify(p));
  check(p?.late === true, '标成"补发"语义（说明它不是精确那一秒）');
}

console.log('\n【4】发过就不再发（这是防重发的关键）');
{
  monthly.markSent('2026-09', { groups: 2, posted: true });
  const after = new Date(2026, 8, 30, 22, 0);
  check(monthly.pending({ now: after, month: '2026-09' }) === null, '记过账之后不再发');
  check(monthly.sentMonths().includes('2026-09'), '落盘里有这个月');
}

console.log('\n【5】★ 掉线补发：发失败 → 不记账 → 恢复后立刻补发');
{
  clean(); // 清空"已发"记录
  const late = new Date(2026, 8, 30, 22, 30); // 本该 21 点发，现在是 22:30（掉线刚恢复）
  const p1 = monthly.pending({ now: late, month: '2026-09' });
  check(p1 !== null, '掉线期间：判定"该发"');

  // 模拟"这一次没发出去"（掉线）—— 不调 markSent
  const p2 = monthly.pending({ now: late, month: '2026-09' });
  check(p2 !== null, '发失败后：**还是**判定"该发"（才能补发）');

  // 恢复上线，真的发出去了
  monthly.markSent('2026-09', { groups: 1, posted: false });
  const p3 = monthly.pending({ now: late, month: '2026-09' });
  check(p3 === null, '补发成功后：不再发');
}

console.log('\n【6】过太久就不补了（免得过几天突然冒出来）');
{
  clean();
  const minMs = Number(config.monthlyReport?.minIntervalMs ?? 86400000);
  const wayLate = new Date(new Date(2026, 8, 30, HOUR, 0).getTime() + minMs + 60000);
  const p = monthly.pending({ now: wayLate, month: '2026-09' });
  check(p === null, `超过 ${Math.round(minMs / 3600000)} 小时不补发`);
  check(monthly.sentMonths().includes('2026-09'), '并记成"跳过"，免得每次都判一遍');
}

console.log('\n【7】工资单内容：只有工资 / 对比 / token');
{
  clean();
  // 往**本月**记一笔账（能过"启用日闸门"），再把**下个月**当成发工资单的月份
  spend.record({
    model: 'deepseek-flash',
    usage: { prompt_tokens: 5e6, completion_tokens: 5e5, prompt_cache_hit_tokens: 0 },
    at: THIS.at,
    force: true,
  });

  const txt = spend.monthlyReportText(THIS.key);
  console.log(txt.replace(/^/gm, '     | '));
  check(!/^\s*\d{4}/.test(txt) && !/\d{1,2}\s*月\s*工资单/.test(txt), '开头没有年月抬头（用户：年月不用重复）');
  check(/工资/.test(txt), '有"工资"');
  check(!/净赚|利润/.test(txt), '**没有**「净赚/利润」（用户明确要求）');
  check(!/花掉|花了/.test(txt), '不提花了多少钱（用户说内容只有工资/对比/token）');
  check(/token/.test(txt), '有 token');
  check(/上月|上个月/.test(txt), '有"相比上月"');
  check(!txt.includes('**'), '没有 Markdown 星号（要原样发到群里）');
  // 句子之间要有标点 —— 早期版本用 join('') 拼，出现「…第一份工资单用了 X token」连在一起
  check(!/工资单用了/.test(txt), '句子之间有标点，没黏在一起');

  const facts = spend.monthlyReportFacts(THIS.key);
  check(!/净赚|利润/.test(facts), '给模型的事实里也没有「净赚」');
}

console.log('\n【8】"相比上月"的三种情况都要说清楚（不然模型会编）');
{
  // 情况 A：上月（本月）有账 → 要能算出方向和幅度
  const cmp = spend.comparePrev(NEXT.key);
  check(cmp.prev === THIS.key, `下个月的上月 = ${THIS.key}`, String(cmp.prev));
  check(cmp.delta === null ? false : true, '两边都有账时能算出变化量', `delta=${cmp.delta}｜${cmp.text}`);
  check(/多|少|持平|一样/.test(cmp.text), '说清了是多了还是少了', cmp.text);

  // 情况 B：上月完全没账 → 不能硬比
  const noneMonth = spend.comparePrev('2019-05');
  check(/没有账本|账本上没有记录|没进账/.test(noneMonth.text), '没账的月份直说没有，不硬比', noneMonth.text);
  check(noneMonth.delta === null && noneMonth.pct === null, '没账时 delta/pct 都是 null（不给模型编的机会）');
  // ⚠️ 2026-09-14 加：这句话里**不许出现"第一份/头一次"那种叙事词**。
  //    用户反馈「第一份工资单…反复出现」（实测 4/4 次都提）——
  //    根因就是这里原来写着「这是第一份工资单」，模型把它当情绪素材每次都说。
  //    账本事实只需要"没记录"这一点，不需要叙事。
  check(
    !/第一份|头一次|第一次/.test(noneMonth.text),
    '没账那句话说事实（"没记录"），不带"第一份"这种叙事词',
    noneMonth.text,
  );

  // 情况 C：跨年
  check(spend.comparePrev('2026-01').prev === '2025-12', '跨年：1 月的上月 = 上年 12 月');
}

console.log('\n【9】默认范围 = 这个月，说赚了就不提花费');
{
  const cases = [
    ['你赚了多少', 'month', 'earn'],
    ['花了多少钱', 'month', 'spend'],
    ['今天赚了多少', 'day', 'earn'],
    ['今天花了多少', 'day', 'spend'],
    ['这个月赚了多少', 'month', 'earn'],
  ];
  for (const [q, scope, type] of cases) {
    const got = spend.looksLikeSpendQuestion(q);
    check(got?.scope === scope && got?.type === type, `「${q}」→ ${scope}/${type}`, got ? `实际 ${got.scope}/${got.type}` : '没识别');
  }
  const earnFacts = spend.spendFacts('month', 'earn');
  check(!/花掉|花了/.test(earnFacts), '问工资的事实里**不含**花费');
  const spendFacts2 = spend.spendFacts('month', 'spend');
  check(!/工资/.test(spendFacts2), '问花费的事实里**不含**工资');
}

clean();
console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
