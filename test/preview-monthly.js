/**
 * 预览「月末工资单」会发什么（**不会真的发**）。
 *
 * 走的是机器人真正的那条路：
 *   `monthly.pending()` 判定 → `spend.monthlyReportReply()` 润色
 *   → 拿不到就退回 `spend.monthlyReportText()` → `stripMdLite()`
 * 然后把**发到群里的那段字**原样打印出来。
 *
 * ⚠️ 全程不调 `monthly.markSent()` —— 所以预演多少次都不会影响真实发送。
 * ⚠️ QQ 空间发的是**同一段字**（见 bot.js 的 checkMonthlyReport），所以看这一份就够。
 *
 * 用法:
 *   node test/preview-monthly.js              # 本月
 *   node test/preview-monthly.js 2026-10      # 指定月份
 *   node test/preview-monthly.js --plain      # 只看兜底模板（不调模型、不花钱）
 */
import { config } from '../src/config.js';
import * as spend from '../src/spend.js';
import * as monthly from '../src/monthly-report.js';

const args = process.argv.slice(2);
const plain = args.includes('--plain');
const monthArg = args.find((a) => /^\d{4}-\d{2}$/.test(a));
const month = monthArg ?? monthly.thisMonth();

/** 和 bot.js 里 `stripMdLite` 同一套（符号清洗；**保留换行**） */
const BT = String.fromCharCode(96);
function stripMdLite(t) {
  return String(t ?? '')
    .replace(new RegExp(`${BT}{1,3}`, 'g'), '')
    .replace(/\*\*/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .trim();
}

console.log(`\n════ ${month} 月末工资单预览 ════\n`);
console.log(`该发时刻：${monthly.dueAt(month).toLocaleString()}`);
console.log(`检查间隔：每 ${Math.round(Number(config.monthlyReport?.checkIntervalMs ?? 0) / 60000)} 分钟`);
console.log(`补发时限：${Math.round(Number(config.monthlyReport?.minIntervalMs ?? 0) / 3600000)} 小时内恢复就补发`);
console.log(`发到群　：${Object.entries(config.trigger?.groupRespondTo ?? {}).filter(([, v]) => Number(v) === 1).map(([g]) => g).join('、') || '（没有 1 档群）'}`);
console.log(`QQ空间　：${config.monthlyReport?.qzone === false ? '不发' : '发（同一段字）'}`);
console.log(`已发记录：${JSON.stringify(monthly.status().history[month] ?? '（尚未发过）')}`);

// ⚠️ **必须在润色之前**取事实：润色那次调用本身也会被记账，
//    事后再算 token 必然比给模型的数大一点（我第一版就栽在这，
//    自检报"token 数对不上"，其实是自检算错了）。
const factsAtCallTime = spend.monthlyReportFacts(month);

console.log('\n──── 给模型的事实（数字来源，它不许改）────\n');
console.log(factsAtCallTime.replace(/^/gm, '  '));

console.log('\n──── 兜底模板（模型挂了就发这个）────\n');
console.log(stripMdLite(spend.monthlyReportText(month)).replace(/^/gm, '  '));

if (!plain) {
  console.log('\n──── 实际会发的（过 LLM 润色）────\n');
  let line = '';
  try {
    line = await spend.monthlyReportReply(month);
  } catch (e) {
    console.log(`  （润色抛错：${e.message}）`);
  }
  if (line) {
    const text = stripMdLite(line);
    console.log(text.replace(/^/gm, '  '));
    console.log('\n  ⬆ 这就是发到群和 QQ空间的那段字');

    // ⚠️ 发出去之前先自检一遍（这些都是实测踩过的）
    const problems = [];
    if (/净赚|利润/.test(text)) problems.push('出现了「净赚/利润」（用户明确不许说）');
    // 用户 2026-09-13：「年月信息大家都知道，不用重复」→ 不许有抬头
    if (/^\s*[\[【]?\s*(20\d{2}[-年/]|\d{1,2}\s*月)/.test(text)) {
      problems.push('开头带了年月/「X 月工资单」这种抬头（用户说不用重复年月，直接说事）');
    }
    // ⚠️ 别把「第一份单子」这种正常说法也当成标题 ——
    //    判据是**标题句式**：开头就是「X 月工资单/月末总结」，或者整句就是个字段名。
    //    （我第一版只搜「工资单」三个字，把「第一份单子」放过了、又把正常句子拦了。）
    if (/^\s*[\[【]?\s*(\d{1,2}\s*月\s*)?(工资单|月末总结|本月结算|月度报告|月度账单)\s*[\]】]?\s*[:：]?/.test(text)) {
      problems.push('开头是公告标题（「X 月工资单」这类），太公文');
    }
    if (/(工资单|月末总结|本月结算|月度报告|月度账单)\s*[:：]/.test(text)) {
      problems.push('出现了"标题：内容"的公文写法');
    }
    if (/烧了|消耗了|花掉了\s*\d/.test(text)) problems.push('把 token 说成「烧了/消耗了」（不像客服说的话）');
    // ⚠️ 第一版只拦了「以后每月都报」，结果模型换了个说法「往后就照这个来」——
    //    所以这里按**意思**拦（对以后做承诺），不是背关键词
    if (
      /以后|往后|下次|接下来|每月都|每个月都|都会报|会一直|长期|照这个来|固定这么|成惯例/.test(text) &&
      /报|发|来|这样|如此/.test(text)
    ) {
      problems.push('承诺了以后的安排（"以后都报""往后照这个来"…）—— 那是配置，不该她承诺');
    }
    if (/成本乘|×100|乘一百|API\s*KEY|余额/.test(text)) problems.push('漏了内部算式/术语');
    if (text.includes('**')) problems.push('带了 Markdown 星号（群里会原样显示）');
    if (text.length > 220) problems.push(`太长了（${text.length} 字）`);
    // ⚠️ 用户要求有"她自己的感想" —— 纯数字陈述就是没感想
    //    判据：除了数字和 token 之外，有没有带情绪的短句
    const feelings = /(居然|才|就这|还行|不错|挺|有点|白干|够|不够|撑|省|亏|值|忍不住|哈|啧|唉|诶|嗯|算是|勉强|勉勉强强)/;
    if (!feelings.test(text)) problems.push('没看出"她自己的感想"（现在还是像在念数字）');
    // ── 数字核对 ──
    // ⚠️ **必须拿"给模型的那份事实"里的数来比，不能用事后的 monthStats()** ——
    //    润色那次调用本身也会被记账，事后再算一定比给模型的数大一点，
    //    于是每次都误报「token 数对不上」（我在这里栽了两次）。
    //    直接从事实文本里抠出那两个数，才是它当时看到的值。
    const got = [...text.matchAll(/\d[\d,]*/g)].map((m) => Number(m[0].replace(/,/g, '')));
    const near = (v, tol = 2) => got.some((g) => Math.abs(g - v) <= Math.max(tol, v * 0.001));
    const salWant = Number((factsAtCallTime.match(/工资：([\d,.]+)/) ?? [])[1]?.replace(/,/g, ''));
    if (Number.isFinite(salWant) && !near(salWant)) {
      problems.push(`工资数字对不上（应为 ${salWant}）`);
    }
    const tokWant = Number((factsAtCallTime.match(/用了 ([\d,]+) token/) ?? [])[1]?.replace(/,/g, ''));
    if (Number.isFinite(tokWant) && tokWant >= 1000 && !near(tokWant, 5)) {
      problems.push(`token 数对不上（应为 ${tokWant}）`);
    }
    // 日期**不该出现**（用户：「年月信息大家都知道，不用重复」）
    if (/\b20\d{2}\b/.test(text)) problems.push('正文里出现了年份 —— 用户说年月不用重复');
    if (problems.length) {
      console.log('\n  ⚠️ 自检发现问题（建议再调提示词）：');
      for (const p of problems) console.log(`     · ${p}`);
    } else {
      console.log('\n  ✅ 自检通过（数字保住了、没说净赚、没漏术语、没说"烧了"）');
    }
  } else {
    console.log('  （润色没拿到内容 → 机器人会退回上面的兜底模板，属于正常降级）');
  }
}

console.log('\n（本次预览**没有**真的发送，也没记"已发"）\n');
