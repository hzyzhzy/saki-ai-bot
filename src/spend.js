/**
 * 记账：**今天花了多少钱 / 这个月用了多少 token**。
 *
 * ⚠️ 需求来源（用户 2026-09-13）：
 *   「再加一个查询今天已花多少钱、多少 token 的功能 ——
 *    当问机器人比如『今天你花了多少钱』『你这个月花了多少 token』，可以回复数据」
 *
 * 为什么不能问 API 要：DeepSeek **没有**"查用量"的接口，
 * 只有 `/user/balance`（余额）—— 而且余额是浮点数，单次扣费小于它的显示精度
 * （实测调用一次 0.000334 元，余额两位小数看不出来）。所以只能**自己记账**。
 *
 * 数据来源：每次调用的响应里带 `usage`（**流式也一样**，
 * 只要请求里加 `stream_options:{include_usage:true}`）。实测字段：
 *   prompt_tokens / completion_tokens / prompt_cache_hit_tokens /
 *   prompt_cache_miss_tokens / completion_tokens_details.reasoning_tokens
 *
 * 价格：官方 https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 *   ⚠️ **高峰时段 = 周一至周五 9:00-12:00、14:00-18:00（北京时间）**，
 *      其余时段**半价**。所以同一个模型算钱要按调用时刻选单价。
 *   ⚠️ 价格可能变。变了改这里，或看 `spendStatus()` 对不上的话再核。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config, ROOT } from './config.js';
import { log } from './log.js';

// ⚠️ 路径可以用 `QQBOT_SPEND_FILE` 覆盖 —— 给测试用。
//    账本是**进程内存 + 落盘**两份，测试要真实验证"文件被改脏会怎样"，
//    又不能污染真账本，所以要能让它指向临时文件。
const FILE = process.env.QQBOT_SPEND_FILE
  ? join(ROOT, process.env.QQBOT_SPEND_FILE)
  : join(ROOT, 'state', 'spend.json');

/** 价格表：元 / 百万 token。peak = 高峰价，off = 空闲价（高峰的一半） */
const PRICES = {
  // deepseek-flash（= DeepSeek-V4.1-Flash）
  'deepseek-flash': {
    hit: { off: 0.02, peak: 0.04 },
    miss: { off: 1, peak: 2 },
    out: { off: 4, peak: 8 },
  },
  // deepseek-v4-pro（= DeepSeek-V4-Pro-0813）
  'deepseek-v4-pro': {
    hit: { off: 0.15, peak: 0.3 },
    miss: { off: 4.5, peak: 9 },
    out: { off: 13.5, peak: 27 },
  },
};
/** 认不出的模型名 → 按 flash 算（保守：flash 便宜，不会高估） */
const FALLBACK = PRICES['deepseek-flash'];

/**
 * 现在是高峰时段吗？
 * 官方：高峰 = 周一至周五 9:00-12:00、14:00-18:00（北京时间），其余半价。
 */
export function isPeak(at = new Date()) {
  // ⚠️ 用北京时间判断 —— 不管这台机器的时区
  const bj = new Date(at.getTime() + (8 * 60 + at.getTimezoneOffset()) * 60000);
  const day = bj.getDay(); // 0=周日
  if (day === 0 || day === 6) return false;
  const h = bj.getHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

/**
 * 算一次调用的花费（元）。
 * @param {{model?:string, promptTokens?:number, completionTokens?:number,
 *          cachedTokens?:number, reasoningTokens?:number, at?:Date}} u
 */
export function costOf(u) {
  const p = PRICES[String(u.model ?? '').trim()] ?? FALLBACK;
  const peak = isPeak(u.at ?? new Date());
  const pt = Math.max(0, Number(u.promptTokens) || 0);
  const ct = Math.max(0, Number(u.completionTokens) || 0);
  const hit = Math.min(pt, Math.max(0, Number(u.cachedTokens) || 0));
  const miss = Math.max(0, pt - hit);
  const pick = (x) => (peak ? x.peak : x.off);
  return (hit / 1e6) * pick(p.hit) + (miss / 1e6) * pick(p.miss) + (ct / 1e6) * pick(p.out);
}

/** { days: { "2026-09-13": {calls, prompt, completion, cached, cost} }, total: {...} } */
let state = { days: {} };

/**
 * 「账本从哪天开始有效」—— 早于这天的记录一律当脏数据丢掉。
 *
 * ⚠️ 为什么要这道闸（2026-09-13 用户发现）：
 *    「每月的数据不对啊，**机器人九月才创建**」——
 *    我测试时往 `state/spend.json` 里**手工塞了 7 月/8 月的假数据**
 *    （为了验证"往月账单"功能），结果它们显示在账单里，
 *    看着像机器人从 7 月就在跑。**这种脏数据必须挡在入口。**
 *
 * 判据：**代码落盘日** 和 `state/` 里最早文件的创建时间，取更早的那个 ——
 * 机器人还没写出来的时候，不可能有花费记录。
 */
let epochDay = '';
try {
  let earliest = 0;
  const consider = (p) => {
    try {
      if (!existsSync(p)) return;
      const t = statSync(p).birthtimeMs || statSync(p).ctimeMs || 0;
      if (t && (!earliest || t < earliest)) earliest = t;
    } catch {}
  };
  consider(join(ROOT, 'package.json'));
  consider(join(ROOT, 'src'));
  const dir = join(ROOT, 'state');
  if (existsSync(dir)) for (const f of readdirSync(dir)) consider(join(dir, f));
  if (earliest) epochDay = dayKey(new Date(earliest));
} catch (e) {
  log.debug(`算账本起点失败（不挡任何数据）：${e.message}`);
}

try {
  if (existsSync(FILE)) {
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    state = { days: j.days ?? {} };
  }
} catch (e) {
  log.debug(`载入账本失败：${e.message}`);
}

/** 记录早于机器人诞生日的记录 = 脏数据（手工塞的 / 拷来的），一律不认 */
function isAncient(k) {
  return Boolean(epochDay) && String(k) < epochDay;
}

// 载入时就把脏数据剔掉，并立刻落盘（只剔一次，之后文件里就没有了）
{
  const bad = Object.keys(state.days).filter(isAncient);
  if (bad.length) {
    for (const k of bad) delete state.days[k];
    log.warn(`账本里有 ${bad.length} 天早于机器人启用日（${epochDay}），已丢弃：${bad.join(' ')}`);
    save();
  }
}

/**
 * 「起始账」—— 账本诞生之前、但那一个月里**确实已经花掉**的钱。
 *
 * ⚠️ 为什么需要它（2026-09-13 用户）：
 *    「**还是说 9 月才 0.03 元，要加上 9 月 1 号到现在所有的**」
 *    账本是 9/13 才有的（在那之前 bot 没记账），所以 9 月 1–12 号的花费
 *    在本地**根本不存在** —— DeepSeek 官方也只有余额接口，没有历史账单接口，
 *    所以只能由人从 [用量页面](https://platform.deepseek.com/usage) 读出总数告诉我。
 *
 * 存在单独文件里（不是塞进 `state.days`），因为那些日期早于 `epochDay`，
 * 塞进去会被上面的闸门当脏数据删掉。分开存、读的时候合进来，两边都干净。
 *
 * 形如：`{ "2026-09": 9.08 }` —— 该月「有账本之前」的累计花费（元）。
 */
const BASE_FILE = process.env.QQBOT_SPEND_BASE
  ? join(ROOT, process.env.QQBOT_SPEND_BASE)
  : join(ROOT, 'state', 'spend-baseline.json');
let baseline = {};
try {
  if (existsSync(BASE_FILE)) baseline = JSON.parse(readFileSync(BASE_FILE, 'utf8')) ?? {};
} catch (e) {
  log.debug(`载入起始账失败：${e.message}`);
}

/**
 * 起始账「每天摊多少」—— **唯一的实现**（`dayStats` 和 `monthStats` 都走它）。
 *
 * ## 怎么推的（2026-09-13 用户拍板「摊」；我第一版推错过，被测试抓出来）
 *
 * 设：
 *   · `T`   = 用量页面上的**本月累计**（含今天）
 *   · `R`   = 账本里已经记过的金额之和（本月、今天及以前）
 *   · `c`   = 已经记过的天数
 *   · `d`   = 当月已经过去的天数（**含今天**）
 *   · `b`   = `d − c` = 需要补记的空白天数
 *   · `x`   = 每个空白天摊多少
 *
 * 要保证 **逐日加起来 == 月度累计 == T**：
 * ```
 * b·x + R = T          →   x = (T − R) / b
 * ```
 * 而 `setBaselineTotal()` 存的就是 `baseline = T − R`（截止昨天），
 * 所以：
 * ```
 * x = baseline / b
 * ```
 *
 * ⚠️ **不是** `baseline / d`（我第一版就是这么写的）—— 那样逐日加起来
 * 只有 `baseline × b/d + R`，比 `T` 少一截（实测差 1.37 元）。
 *
 * 验算（2026-09-13 的真实数）：`T=18.34`、`R=0.0507`、`c=1`、`d=13`、`b=12`
 *   → `baseline = 18.2893`，`x = 18.2893/12 = 1.5241`
 *   → `12×x + 0.0507 = 18.2893 + 0.0507 = 18.34` ✅
 *
 * @returns {number} 每个"空白天"摊到的金额
 */
function perDay(month) {
  const amt = Number(baseline[month]) || 0;
  if (!(amt > 0) || month > dayKey().slice(0, 7)) return 0;
  const today = dayKey();
  const isThisMonth = month === today.slice(0, 7);
  const d = isThisMonth
    ? Number(today.slice(8, 10))
    : new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  // 账本里**已经记过的**（本月、今天及以前）—— 这些日子不能再摊
  const c = Object.keys(state.days).filter((k) => k.startsWith(month) && k <= today).length;
  const b = d - c;
  if (b <= 0) return 0;
  return amt / b;
}

/** 把两个账目对象相加 */
function addUp(a, b) {
  const r = { ...a };
  for (const f of ['calls', 'prompt', 'completion', 'cached', 'cost']) r[f] = (a[f] ?? 0) + (b[f] ?? 0);
  return r;
}

function save() {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    renameSync(tmp, FILE);
  } catch (e) {
    log.debug(`保存账本失败：${e.message}`);
  }
}

/** 本地日期键 YYYY-MM-DD（按北京时间的"今天"） */
function dayKey(at = new Date()) {
  const bj = new Date(at.getTime() + (8 * 60 + at.getTimezoneOffset()) * 60000);
  const m = String(bj.getMonth() + 1).padStart(2, '0');
  const d = String(bj.getDate()).padStart(2, '0');
  return `${bj.getFullYear()}-${m}-${d}`;
}

/**
 * 记一次调用。**每次调模型都要调它**（`streamChat` / `quickAck` / 视觉 / 判断…）。
 *
 * @param {{model?:string, usage?:object, at?:Date, tag?:string, force?:boolean}} p
 *   `usage` 就是 API 返回的那个对象（字段名见文件头注释）
 *   `force` = **测试专用**：绕过"启用日闸门"，用来造"上个月也花过钱"这种历史，
 *            好验证月末工资单的"相比上月变化"。正常调用**绝不要**传它。
 */
export function record(p = {}) {
  const u = p.usage ?? {};
  const pt = Number(u.prompt_tokens ?? 0) || 0;
  const ct = Number(u.completion_tokens ?? 0) || 0;
  if (!pt && !ct) return; // 没用量就不记（比如失败的调用）

  const at = p.at ?? new Date();
  if (!p.force && isAncient(dayKey(at))) {
    // 时钟不准 / 传错 at / 测试造数据 —— 宁可不记，也不写进账单
    log.warn(`这次调用的日期 ${dayKey(at)} 早于机器人启用日 ${epochDay}，不记账`);
    return;
  }
  const cached = Number(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0) || 0;
  const cost = costOf({
    model: p.model ?? config.llm?.model,
    promptTokens: pt,
    completionTokens: ct,
    cachedTokens: cached,
    at,
  });

  const k = dayKey(at);
  const day = (state.days[k] ??= { calls: 0, prompt: 0, completion: 0, cached: 0, cost: 0 });
  day.calls += 1;
  day.prompt += pt;
  day.completion += ct;
  day.cached += cached;
  day.cost += cost;
  save();
}

/** 汇总某一天的账 */
export function dayStats(key = dayKey()) {
  const own = state.days[key] ?? { calls: 0, prompt: 0, completion: 0, cached: 0, cost: 0 };
  const b = baseOn(key);
  return b ? addUp(own, b) : own;
}

/**
 * 某天摊到的起始账 —— 闸门都在这里；金额的算法统一交给 `perDay()`。
 *
 * 闸门：
 *   ① 未来月份 / 未来的日子 → 不认（那是"还没到"，不是"没记"）
 *   ② 这天账本自己有记录 → 用真实数，**不能再叠一笔**（否则今天被算两遍）
 *   ③ 补记只补**账本开始之前**那段连续的窟窿
 */
function baseOn(k) {
  const month = k.slice(0, 7);
  if (!(Number(baseline[month]) > 0)) return null;
  if (month > dayKey().slice(0, 7)) return null;        // 未来月份，不认
  if (state.days[k]) return null;                        // 这天账本自己有记录，别叠
  if (k > dayKey()) return null;                         // 还没到的日子
  if (Object.keys(state.days).some((x) => x.startsWith(month) && x < k)) return null;
  const per = perDay(month);
  if (!per) return null;
  return { calls: 0, prompt: 0, completion: 0, cached: 0, cost: per, _base: true };
}

/**
 * 汇总某个月（"2026-09"）—— **唯一的月份汇总实现**。
 *
 * 起始账（`state/spend-baseline.json`）在这里按天摊进来。
 * ⚠️ 分摊单价**必须走 `perDay()`** —— 那是唯一实现，
 *    这样"本月总账"和"按天问"逐日加起来是同一个数（不会自相矛盾）。
 */
export function monthStats(month = dayKey().slice(0, 7)) {
  const acc = { calls: 0, prompt: 0, completion: 0, cached: 0, cost: 0, days: 0 };
  const today = dayKey();
  for (const [k, v] of Object.entries(state.days)) {
    if (!k.startsWith(month) || isAncient(k)) continue;
    acc.days += 1;
    acc.calls += v.calls ?? 0;
    acc.prompt += v.prompt ?? 0;
    acc.completion += v.completion ?? 0;
    acc.cached += v.cached ?? 0;
    acc.cost += v.cost ?? 0;
  }
  // 补记：只算"今天为止、账本还没记过"的那些日子
  const per = perDay(month);
  if (per > 0) {
    const d = month === today.slice(0, 7)
      ? Number(today.slice(8, 10))
      : new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
    let blank = 0;
    for (let day = 1; day <= d; day += 1) {
      const k = `${month}-${String(day).padStart(2, '0')}`;
      if (!state.days[k] && k <= today) blank += 1;
    }
    acc.baseDays = blank;
    acc.baseCost = per * blank;
    acc.cost += acc.baseCost;
    acc.days += blank;
  }
  return acc;
}

/** 数字加千分位 */
const n = (x) => Number(x ?? 0).toLocaleString('en-US');

/**
 * 重新从盘上读账本 + 起始账（并把脏数据再过一遍闸门）。
 *
 * 存在的理由：账本是**进程内存 + 落盘**两份，
 * 管理界面/人手动改了 `state/spend*.json` 之后，进程里那份还是旧的。
 * 测试脚本也一样 —— 它要能验证"文件被改脏了会怎样"，就得能重读。
 */
export function reload() {
  try {
    if (existsSync(FILE)) {
      const j = JSON.parse(readFileSync(FILE, 'utf8'));
      state = { days: j.days ?? {} };
    } else {
      state = { days: {} };
    }
    const bad = Object.keys(state.days).filter(isAncient);
    if (bad.length) {
      for (const k of bad) delete state.days[k];
      log.warn(`账本里有 ${bad.length} 天早于机器人启用日（${epochDay}），已丢弃：${bad.join(' ')}`);
      save();
    }
  } catch (e) {
    log.debug(`重读账本失败：${e.message}`);
  }
  try {
    baseline = existsSync(BASE_FILE) ? JSON.parse(readFileSync(BASE_FILE, 'utf8')) ?? {} : {};
  } catch (e) {
    log.debug(`重读起始账失败：${e.message}`);
  }
  return { days: Object.keys(state.days).length, baseline: { ...baseline } };
}

/**
 * 金额格式化。
 *
 * ⚠️ 单次调用只要 0.0006 元左右，**两位小数会显示成 0.00**（看着像没花钱）。
 *    所以：小于 1 毛用 4 位小数，再小就说"不到 0.0001 元"。
 */
function money(cost) {
  const c = Number(cost) || 0;
  if (c === 0) return '0 元';
  if (c < 0.0001) return '不到 0.0001 元';
  if (c < 0.1) return `${c.toFixed(4)} 元`;
  return `${c.toFixed(2)} 元`;
}

/**
 * 账本文本 —— ⚠️ **这是要直接发到群里的**，所以：
 *   · **绝不能夹带"给模型看的指令"**（踩过：把「说的时候别解释算式」
 *     这句提示词原样发到群里了，用户反馈「有点刻意了」）
 *   · 只用 `·` 这种纯文本符号，**不要用 `**`**（`sendText` 不洗 Markdown，
 *     星号会原样显示出来）
 */
export function spendText(scope = 'day', opts = {}) {
  const now = new Date();
  const stat = scope === 'month' ? monthStats() : dayStats();
  const label = scope === 'month' ? dayKey().slice(0, 7) : dayKey(now);
  const s = salaryOf(stat);
  const withSalary = opts.withSalary !== false;

  const lines = [
    scope === 'month' ? `【本月账】${label}` : `【今天账】${label}`,
    `· 花了 ${moneyBig(s.cost)}`,
    `· 用了 ${n(stat.prompt + stat.completion)} 个 token`,
    `  （输入 ${n(stat.prompt)}　输出 ${n(stat.completion)}　其中缓存命中 ${n(stat.cached)}）`,
    `· 一共 ${n(stat.calls)} 次调用${scope === 'month' ? `，覆盖 ${stat.days} 天` : ''}`,
  ];
  // 起始账说明 —— ⚠️ 别用 `**`（这条是要原样发到群里的）
  if (scope === 'month' && stat.baseDays > 0) {
    lines.push(`  （其中前面 ${stat.baseDays} 天是账本建好之前补记的 ${moneyBig(stat.baseCost)}）`);
  }
  if (withSalary) {
    // ⚠️ 只说「工资」，**别说「净赚」**（用户 2026-09-13：「不要说净赚」）
    lines.push('', `· 工资 ${moneyBig(s.earned)}`);
  }

  // ⚠️ 「往月账单」（2026-09-13 用户要求「能加上这个月之前的账单吗」）。
  //    只在**有历史月份**时才加 —— 只有本月的话不加，免得啰嗦。
  if (opts.withHistory !== false && scope === 'month') {
    const months = monthlyStats({ limit: 6 }).filter((m) => m.month !== label);
    if (months.length) {
      lines.push('', '· 往月：');
      for (const m of months) {
        lines.push(`  ${m.month}　花了 ${moneyBig(m.cost)}　工资 ${moneyBig(m.earned)}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * 回「你这个月挣了多少」—— 带**物价参照**和**她自己的感想**。
 *
 * ⚠️ 用户 2026-09-13 要求：
 *    ① 「修好之后**把问工资的回复也加上物价参照和感想**」
 *       —— 以前只丢一个数字（截图里就是「1876，就这点，别嫌少了。」）
 *    ② 同时修方向：「**她又把自己当成发工资的一方了**」——
 *       「别嫌少」是老板台词。方向铁律在 `llm.phraseMoney()` 里统一加了。
 *
 * @param {{scope?:'day'|'month', asked?:string, rand?:()=>number}} p
 *   `rand` 是**测试专用**（给"168 亿那条加没加"一个确定的骰子）
 * @returns {Promise<string>} 空串 = 模型没给出内容 → 调用方退回 `earnText`
 */
export async function earnReply(p = {}) {
  const scope = p.scope === 'day' ? 'day' : 'month';
  const stat = scope === 'month' ? monthStats() : dayStats();
  const s = salaryOf(stat);
  const when = scope === 'month' ? '本月' : '今天';

  const facts = [
    `（系统实测数据 · ${when}）`,
    `· 工资：${moneyBig(s.earned)}`,
    // ⚠️ 「跟上月比」只在问**本月**时给 —— 问"今天挣了多少"却甩一句月度对比，
    //    答非所问（这个 if 我第一版漏了，`cmp` 也白算了）
    ...(scope === 'month' ? [`· ${comparePrev(dayKey().slice(0, 7)).text}`] : []),
    `· 用了 ${n(stat.prompt + stat.completion)} token`,
  ];
  // ⚠️ 物价参照只在**问月薪**时给：问"今天挣了多少"是几毛几分，
  //    拿"够买几杯奶茶"去套会很滑稽（0.02 元连一粒米都买不到）
  let living = '';
  if (scope === 'month') {
    // ⚠️ `p.rand` 是**测试专用**：口癖/参照的选择都走随机，
    //    不给注入点的话"168 亿这条到底加没加"就没法确定性地测。
    living = livingContext(s.earned, typeof p.rand === 'function' ? { rand: p.rand } : {});
    facts.push('', '## 这点钱在生活里是什么概念（物价参照，**别自己另算**）', living);
  }
  // ⚠️⚠️ 「168 亿」这次到底给没给，要看 `livingContext` 的骰子
  //    （它 1/4 概率才把那条拼进来）—— **不能在这里假设它给了**。
  //
  //    2026-09-14 用户反馈：「**168 亿这个结构出现的频率还是太高了**」。
  //    实测 8 次里 2 次提（骰子是 1/4，本来不该那么高）——
  //    根因是这里的 `extraRules` **无条件**写了 168 亿那一整段，
  //    等于"事实里没给、提示词里还是提了"，骰子那道闸被绕过去了。
  const hasDebt = living.includes('168 亿');
  // ⚠️ 只留**铁律**（别撇清 / 别宣布在还），**不给例句**。
  //    原来这里给了三句带引号的示范：「跟那 168 亿比，我这点算什么」
  //    「九牛一毛都算不上」「这点钱在 168 亿面前就是个笑话」——
  //    用户截图里那句「**九牛一毛都算不上**」就是**原样抄**的这一行。
  //    现在改成只在骰子真给出那条时才提，而且**不给可抄的句子**。
  const debtRules = [
    '· ⚠️⚠️ 那 168 亿你**没有偿还义务**（法律上是你爸造成的损失，不是你的债）',
    '  但⚠️ **别因此撇清** —— "反正又不是我要还的""关我什么事"这种话说出来就**冷了、OOC 了**。',
    '  你心里是**认**这件事的（你在这拼命挣钱，本来就有一部分是为了那个家），',
    '  只是**嘴上不认**（典型傲娇）。',
    '· 提它的时候是**自嘲 / 拿自己开涮**，语气是"自己都觉得好笑"：',
    '  ❌ 不是委屈、不是诉苦（「我这辈子都别想了」这种叹气流泪的不算自嘲）',
    '  ❌ **不说**「我在还」「还得还完」「还债中」「什么时候能还清」（不宣布自己在还）',
    '  ❌ **也不说**「不用我还」「跟我没关系」（不撇清）',
    '  ⚠️ **不要照抄任何现成的比方和句式**（上面这些是说明，不是台词）',
    '    —— 每次都要用自己的说法，同一个比方连着用就是口癖了。',
    '· 有人问你是不是在还那笔钱 → **不承认，但也不撇清** —— 然后就此打住，别补一句撇清的',
  ];

  const llm = await import('./llm.js');
  return llm.phraseMoney({
    facts: facts.join('\n'),
    asked: String(p.asked ?? '').trim().slice(0, 60) || '你这个月挣了多少',
    style:
      '他问你的工资。照实报数，然后**说一句你自己的感想**' +
      '（觉得少、觉得还行、想拿这钱干嘛、或者顺口吐槽一句）。' +
      '你是**领工资的那个人**，钱是 HZY 发给你的。',
    maxLines: 3,
    maxTokens: 300,
    extraRules: [
      '· ⚠️ **一定要有自己的感想**，别只丢一个数字就走',
      `· ⚠️ 可以用上面的物价参照算一算（"够买 X 杯奶茶"），**别自己另编物价**`,
      '· ⚠️ 别把参照**全列出来** —— 挑一两条顺口的就行，列清单就成报表了',
      '· ⚠️ **绝不可以说「别嫌少」「将就一下」这种发钱方的话**（你才是领钱的）',
      // ⚠️⚠️ 「别每次都提同一件事」（2026-09-14 用户反馈：
      //    「第一段话和第三段话**同质化**有点严重」「房租这个结构出现频率太高」）。
      //    实测 4/4 次都提房租、4/4 次都提"第一份工资单"—— 因为那两样在**事实里
      //    是固定的**，模型就每次都拿它们凑感想。
      '· ⚠️⚠️ **别每次都用同一件事当感想**：',
      '  「不够交房租」这种话**最多十次里说两三次**，不是每次都要提；',
      '  也别反复强调"这是第一份工资" —— 那是**账本的事实，不是你要演的情绪**。',
      '  每次挑**不一样的角度**：想吃的东西、想买的东西、排练室、下个月、',
      '  或者干脆就是一句情绪（有点得意 / 有点丧 / 无所谓）。',
      ...(hasDebt ? debtRules : []),
    ],
  });
}

/**
 * 「赚了多少」的**纯文本**版本（模板兜底用，和 `spendText` 一样不能带 `**`）。
 *
 * ⚠️ 用户要求分开回答（2026-09-13）：问工资就**只报工资**，
 *    不要把花销/token/往月一起糊出去。
 */
export function earnText(scope = 'day') {
  const stat = scope === 'month' ? monthStats() : dayStats();
  const s = salaryOf(stat);
  const label = scope === 'month' ? dayKey().slice(0, 7) : dayKey();
  const lines = [
    scope === 'month' ? `【本月工资】${label}` : `【今天工资】${label}`,
    // ⚠️ 只说工资，**不提「净赚」**（用户 2026-09-13）
    `· 工资进账 ${moneyBig(s.earned)}`,
  ];
  if (scope === 'month') {
    lines.push(`· 这个月干了 ${n(stat.calls)} 次活`);
    const months = monthlyStats({ limit: 6 }).filter((m) => m.month !== label);
    if (months.length) {
      lines.push('', '· 往月：');
      for (const m of months) lines.push(`  ${m.month}　工资 ${moneyBig(m.earned)}`);
    }
  }
  return lines.join('\n');
}

/**
 * 「跟上个月比，变化多少」—— 报账和月末工资单共用这一段。
 *
 * ⚠️ 用户 2026-09-13 要求月末工资单里要有「**相比上月变化如何**」。
 *    三种情况都得说清楚（不然模型会自己编）：
 *      · 上月没账（这是第一个月）→ 直说"上月没记录"
 *      · 上月有账但**工资为 0**（花了钱没进账）→ 不能说"多了 100%"
 *      · 正常 → 给出差值和涨跌幅
 *
 * @param {string} month "2026-09"
 * @returns {{text:string, prev:string|null, delta:number|null, pct:number|null}}
 */
export function comparePrev(month) {
  const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  const cur = monthStats(month);
  const before = monthStats(prev);
  const sc = salaryOf(cur);
  const sb = salaryOf(before);

  // 上月完全没账（不是"0 元"，是"没记录"）→ 不能拿来比
  const prevHas = before.calls > 0 || before.cost > 0;
  if (!prevHas) {
    // ⚠️ `prev` 照样要返回（调用方需要知道"上个月是哪个月"），
    //    只是 `delta`/`pct` 为 null —— 早期版本这里连 `prev` 都给 null，被测试抓出来了
    //
    // ⚠️⚠️ 这句话**故意不带任何可复用的说法**（2026-09-14 用户反馈：
    //    「**第一份工资单**…这两个词汇都反复出现了」，实测 4/4 次都提）。
    //    原来写的是「上月（…）还没有账本，**这是第一份工资单**」——
    //    后半句是**叙事**，模型就把"第一份工资单"当成情绪素材每次都说，
    //    而账本事实本身只需要"没记录"这一点。
    //    同理**别在这里放「第一份」「头一次」这类词**。
    return { text: `上月（${prev}）账本上没有记录`, prev, delta: null, pct: null };
  }
  if (!(sb.earned > 0)) {
    return {
      text: `上月（${prev}）没进账（工资 0 元），这个月算开张`,
      prev,
      delta: sc.earned,
      pct: null,
    };
  }
  const delta = sc.earned - sb.earned;
  const pct = (delta / sb.earned) * 100;
  const dir = delta > 0 ? '多' : delta < 0 ? '少' : '持平';
  const body =
    delta === 0
      ? `跟上月（${prev}）一样`
      : `${dir} ${moneyBig(Math.abs(delta))}（${pct > 0 ? '+' : ''}${pct.toFixed(0)}%）`;
  return { text: `上月（${prev}）是 ${moneyBig(sb.earned)}，这个月${body}`, prev, delta, pct };
}

/**
 * 物价参照池 —— 「这点钱够干什么」。
 *
 * ⚠️ 为什么要在代码里算（2026-09-13 用户：「再更多的结合一下**当今中国工资的现状**
 *    还有祥子自身设定和经济情况，我觉得**乘100 之后很符合现实工资了**」）：
 *    · 乘 100 之后落在「一两千到四五千」这段 —— **这正好是真实存在的一档月薪**
 *      （兼职、实习起薪、三四线普通岗），不是个玩笑数字
 *    · 但模型**不知道物价**，让它自己算会编（"够买 200 杯奶茶"这种）
 *    · 所以这里把**参照物**算好交给它，它只负责把话说得像人
 *
 * ⚠️ 用户要求（2026-09-13）：「物价参照的例子**多加一点**，可以加一点**符合动画人设**的
 *    东西，比如**乐队消耗品**之类的，再加一点**二次元开销**的例子，
 *    比如 b 站大会员，或者买手办的钱……生成消息的时候**随机挑选几个例子**即可」。
 *
 * 所以池子分了四类：
 *   · 日常吃喝 —— 谁都能共情
 *   · 二次元/日常订阅 —— 大会员、抽卡、盲盒、谷子
 *   · **她的本行**（乐队/钢琴）—— 琴弦、拨片、效果器、谱子、调音、排练室
 *     （这些最贴人设：她本来就在搞乐队，钱不够时想到的自然是这些东西）
 *   · 大件/处境 —— 房租、设备，用来表达"这点钱办不成大事"
 *
 * 价格按 2026 年国内大众/网购价位取（别取上海内环价，也别取拼多多价）。
 *
 * ⚠️ 每条都带 `u`（量词）：不写量词会拼出「约 30一场电影」这种病句
 *    （我第一版就是 `约 ${n}${名字}`，实测难看得很）。
 */
const LIVING_REFS = [
  // ── 日常吃喝 ──
  { n: '奶茶', u: '杯', p: 15, tag: 'daily' },
  { n: '像样的饭', u: '顿', p: 35, tag: 'daily' },
  { n: '电影（含爆米花）', u: '场', p: 60, tag: 'daily' },
  { n: '普通外套', u: '件', p: 300, tag: 'daily' },
  { n: '入门运动鞋', u: '双', p: 500, tag: 'daily' },

  // ── 二次元开销 ──
  { n: 'bilibili 大会员', u: '个月', p: 15, tag: 'acg' },
  { n: '手游十连抽', u: '次', p: 128, tag: 'acg' },
  { n: '普通盲盒', u: '个', p: 69, tag: 'acg' },
  { n: 'CD', u: '张', p: 120, tag: 'acg' },
  { n: '画集/设定集', u: '本', p: 160, tag: 'acg' },
  { n: '景品手办（正版）', u: '个', p: 380, tag: 'acg' },
  { n: '漫展门票', u: '张', p: 120, tag: 'acg' },
  { n: 'livehouse 演出票', u: '张', p: 200, tag: 'acg' },
  { n: '正比例手办（预购）', u: '个', p: 1200, tag: 'acg' },

  // ── 乐队 / 她的本行（最贴人设）──
  { n: '吉他弦（琴弦）', u: '套', p: 60, tag: 'band' },
  { n: '吉他拨片', u: '包', p: 30, tag: 'band' },
  { n: '乐队谱集', u: '本', p: 80, tag: 'band' },
  { n: '一小时排练室', u: '次', p: 60, tag: 'band' },
  { n: '便宜的效果器', u: '个', p: 500, tag: 'band' },
  { n: '专业钢琴调音', u: '次', p: 500, tag: 'band' },
  { n: '入门调音器/节拍器', u: '个', p: 150, tag: 'band' },
  { n: '监听耳机', u: '副', p: 800, tag: 'band' },
  { n: '入门电子琴', u: '台', p: 3000, tag: 'band' },

  // ── 大件/处境 ──
  { n: '中端合成器', u: '台', p: 8000, tag: 'big' },
  { n: '像样的立式钢琴', u: '台', p: 30000, tag: 'big' },
];

/**
 * 「168 亿」那个梗 —— **单独一类参照**，进随机池，**概率 1/4**
 * （用户 2026-09-13 定的：一开始我给到 2/3，用户说「改成 1/4 吧，要不然会太频繁了也不好」）。
 *
 * ⚠️ 事实别写错（查证过，见 `knowledge/anime.md` 一点六）：
 *    168 亿是**损失（損失）**，是她爸给丰川集团造成的，**不是她欠的债**；
 *    她**没有偿还义务**，但⚠️**也别撇清**（"反正不是我要还的"是 OOC ——
 *    她努力打工本来有一部分就是为了那个家）。态度是"**在做了，但你别指望我承认**"。
 *
 * ⚠️ 倍数和年数**代码算好**给模型（它算大数会错），而且给的都是"人的说法"
 *    （"差了几百万倍""要攒七十万年"），不是干巴巴的数字。
 */
function debtMeme(yuan) {
  const v = Number(yuan) || 0;
  const DEBT = 16_800_000_000; // 168 亿日元（动画设定里的那个数）
  if (v <= 0) return '';
  const ratio = Math.round(DEBT / v);
  const years = Math.round(DEBT / (v * 12));
  const fmt = (n) => n.toLocaleString('en-US');
  return (
    `· 跟「168 亿」比：那是 ${fmt(DEBT)}，你这个月是 ${fmt(Math.round(v))} —— ` +
    `差大约 ${fmt(ratio)} 倍，照这个工资要攒 ${fmt(years)} 年\n` +
    '  （那 168 亿是**你爸造成的损失**，**不是你欠的债**、你也不用还 —— 这是自嘲的梗，别演成"我在还债"）'
  );
}

/**
 * 按工资挑几条**生活参照**（随机，每次不一样）。
 *
 * ⚠️ 用户："生成消息的时候**随机挑选几个例子**即可" ——
 *    每次都说"够买 X 杯奶茶"就成了新模板（人设里专门有一条反对固定句式）。
 *
 * @param {number} yuan
 * @param {{count?:number, rand?:()=>number}} [opts]
 * @returns {string} 多行文本
 */
export function livingContext(yuan, opts = {}) {
  const v = Number(yuan) || 0;
  if (v <= 0) return '（这个月没有收入）';
  const rand = typeof opts.rand === 'function' ? opts.rand : Math.random;
  const want = Math.max(2, Number(opts.count) || 3);

  // 只挑"这个数买得起"的（至少一件），买不起的不提 —— 提了就是扎心而非参照
  const affordable = LIVING_REFS.filter((r) => v >= r.p);
  // 挑"有意义"的：能买 1 件以上才有参照感；单价太小的（奶茶）单独留着，它共情最强
  const pick = [];
  const shuffle = (arr) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  // ① 便宜的都列不出来（工资太低）→ 至少给奶茶和拨片这种小东西
  const cheap = affordable.filter((r) => v / r.p >= 2);
  const heavy = affordable.filter((r) => v >= r.p && v / r.p < 2);
  for (const r of shuffle(cheap).slice(0, want - 1)) pick.push(r);
  // ② 再挑一条"刚好买得起一件"的，用来表达"就够这个"（比如一个景品手办）
  const oneOff = shuffle(heavy)[0];
  if (oneOff && pick.length < want) pick.push(oneOff);

  const lines = pick.map((r) => `· 约 ${Math.floor(v / r.p)} ${r.u}${r.n}（单价 ${r.p} 元）`);
  // ③ 「这点钱办不成大事」的那条 —— **说法轮换**。
  //
  //    ⚠️⚠️ 2026-09-14 用户反馈：「第一段话和第三段话**同质化**有点严重」。
  //      实测 8 次提问里成功回 4 条，**4/4 都提了房租**。
  //
  //      根因是**事实里那句房租是固定文本**，模型每次看到就把"不够交房租"
  //      抄进感想（它是最顺手的"钱少"证据）。改成几种说法**随机轮换**，
  //      模型每次看到的字面不一样 → 抄不出同一个句式。
  //
  //    ⚠️ 但"这点钱办不成大事"这个意思是**要有**的（它是物价参照的意义所在），
  //      所以不是删掉，是换着说。
  const BIG_LINES =
    v >= 2500
      ? ['· 够付一个月市区合租（约 2500 元），还能剩点', '· 房租（市区合租约 2500 元）也付得起，还剩一点']
      : [
          '· **不够**一个月市区合租（约 2500 元）—— 房租就占掉一大半',
          '· 离一个月市区合租（约 2500 元）还差一截',
          '· 拿去交市区合租（约 2500 元）的话，只够一半多点',
          '· 一个月市区合租要 2500 左右，这个数还够不上',
        ];
  lines.push(BIG_LINES[Math.floor(rand() * BIG_LINES.length)] ?? BIG_LINES[0]);
  // ④ 「168 亿」那条**掷骰子**决定这次给不给。
  //
  //    ⚠️ 概率 = **1/4**（2026-09-13 用户：「改成 1/4 吧，要不然会太频繁了也不好」）。
  //      一开始我设成 2/3，用户觉得太频繁 —— 这个梗的力气在**偶尔出现**；
  //      每次都提就成了新口头禅（人设里专门有一条反对固定句式）。
  //
  //    ⚠️ 为什么不干脆丢进随机池和奶茶盲盒一起抽：它是所有参照里最出效果的
  //      （自嘲 + 家道中落 + 荒谬对比），混着抽的话十次里出不来一次，等于没加。
  //      所以单独给它一个骰子。
  if (rand() < 0.25) {
    const meme = debtMeme(v);
    if (meme) lines.push(meme);
  }
  return lines.join('\n');
}

/**
 * 月末工资单的**事实**（交给模型润色；模型失败就退回 `monthlyReportText`）。
 *
 * 内容按用户要求**只有三样**：
 *   · 这个月拿了多少工资
 *   · 相比上月变化
 *   · 花了多少 token
 *
 * ⚠️ **不提成本、不提净赚**（用户：「不要说净赚」）。
 *
 * @param {string} [month]
 */
export function monthlyReportFacts(month = dayKey().slice(0, 7)) {
  const stat = monthStats(month);
  const s = salaryOf(stat);
  const cmp = comparePrev(month);
  const m = Number(month.slice(5, 7));
  // ⚠️ 不写「${month} 月结」那种抬头（用户 2026-09-13：
  //    「**年月信息大家都知道，不用重复**」）——
  //    而且抬头会**教模型也照着加一个日期前缀**，写出来像公告。
  //    事实里只保留「几月」这种对不上就说不清的信息（"比上月"要有个参照）。
  return [
    `（系统实测数据 · 这个月 = ${m} 月）`,
    `· 工资：${moneyBig(s.earned)}`,
    `· ${cmp.text}`,
    // ⚠️ 只给 token 总数，**不给"调用次数"**（用户要的就是「工资 / 相比上月 / 多少 token」三样）。
    //    多了这个数反而给模型加戏 —— 实测它会写成「打了 54 次工」这种设计外的说法。
    `· 用了 ${n(stat.prompt + stat.completion)} token`,
    '',
    '## 这点钱在生活里是什么概念（物价参照，**别自己另算**）',
    livingContext(s.earned),
    // 让数字落在真实工资区间里 —— 这样她的反应才是"真的在过日子"，不是随口感慨
    `（参照：2026 年国内月最低工资大多在 2000~2700 之间；`,
    `  ${s.earned < 2000 ? '这份工资**比最低工资还低**，属于打零工那档' : '这份工资相当于三四线城市普通岗位的水平'}）`,
  ].join('\n');
}

/**
 * 月末工资单的**兜底模板**（纯文本，不能带 `**` —— 是要原样发到群里的）。
 *
 * ⚠️ 两条踩出来的规矩：
 *    · 工资整元时写成中文数字（「一千八百三十四」而不是「1834 元」）——
 *      后者一眼就是机器打印的
 *    · **不要抬头**（原来第一行是「9 月工资单」），直接说事 ——
 *      用户 2026-09-13：「年月信息大家都知道，不用重复」
 *
 * ⚠️ 兜底版**没有感想**（那是模型才写得出来的东西）。
 *    真发出去几乎不会走到这里 —— 只有模型挂了才会。
 */
export function monthlyReportText(month = dayKey().slice(0, 7)) {
  const stat = monthStats(month);
  const s = salaryOf(stat);
  const cmp = comparePrev(month);
  // ⚠️ 句子之间**要有标点** —— 我第一版用 `join('')` 拼，
  //    结果「…这是第一份工资单用了 617,004 token。」中间没停顿，读着像卡住。
  const parts = [`这个月拿了 ${cjkMoney(s.earned)} 工资。`];
  parts.push(/[。！？]$/.test(cmp.text) ? cmp.text : `${cmp.text}。`);
  // ⚠️ token 数**不带千分位**：这是兜底模板，读起来要像人说话
  //    （「617818 token」比「617,818 token」自然；反正真发出去几乎都走模型那条路）
  parts.push(`用了 ${stat.prompt + stat.completion} token。`);
  return parts.join('');
}

/**
 * 金额 → 中文读法（"1834.2" → "一千八百三十四元"）。
 *
 * ⚠️ 整元才用中文，带零头就用阿拉伯数字 ——
 *    「一千八百三十四元七角二分」读起来像旧社会账房，
 *    「1834.72 元」反而干净（这钱数本来就是估算出来的，精确到分没意义）。
 */
function cjkMoney(x) {
  const v = Number(x) || 0;
  if (v === 0) return '0 元';
  if (v >= 1 && Math.abs(v - Math.round(v)) < 0.005) return `${cjkNum(Math.round(v))}元`;
  // `` 是空字符串 —— 拼出来不会多一个空格（我第一版写成 `${v.toFixed(0)} 元`，
  // 和上面那支拼一起就成了「1847 元 工资」）
  return `${v.toFixed(v < 1 ? 2 : 0)}${v < 1 ? ' ' : ''}元`;
}

/**
 * 数字 → 中文读法（"1834" → "一千八百三十四"）。
 *
 * ⚠️ 和 `llm.js` 的 `cjkNum` 是同一套规则，这里**必须复制一份**：
 *    `llm.js` 为了记账要 import `spend.js`，本文件再 import 回去就是循环依赖。
 */
export function cjkNum(num) {
  const v = Math.round(Number(num) || 0);
  if (!Number.isFinite(v) || v <= 0 || v > 99999999) return String(v);
  const D = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const U = ['', '十', '百', '千'];
  const section = (x) => {
    let s = '';
    let zero = false;
    for (let i = 3; i >= 0; i -= 1) {
      const d = Math.floor(x / 10 ** i) % 10;
      if (d === 0) {
        zero = s !== '';
      } else {
        if (zero) s += '零';
        zero = false;
        s += (d === 1 && i === 1 && s === '' ? '' : D[d]) + U[i];
      }
    }
    return s;
  };
  const yi = Math.floor(v / 1e8);
  const wan = Math.floor((v % 1e8) / 1e4);
  const rest = v % 1e4;
  let out = '';
  if (yi) out += `${section(yi)}亿`;
  if (wan) out += `${wan < 1000 && out ? '零' : ''}${section(wan)}万`;
  if (rest) out += `${rest < 1000 && out ? '零' : ''}${section(rest)}`;
  return out || '零';
}

/**
 * 月末工资单的**润色**（走后门，和报账共用同一套铁律）。
 *
 * @param {string} month
 * @returns {Promise<string>} 失败返回空串 → 调用方退回 `monthlyReportText`
 */
export async function monthlyReportReply(month = dayKey().slice(0, 7)) {
  const llm = await import('./llm.js');
  return llm.phraseMoney({
    facts: monthlyReportFacts(month),
    // ⚠️ 这里**不能写「${month} 月末的工资单」** —— 模型会把这种说法
    //    原样搬到正文开头（实测：「2026-09 月末工资单：…」），
    //    而那正是用户嫌"像公文"的东西（年月谁都知道，不用重复）。
    asked: '你自己想在群里说说这个月的收入',
    style:
      '这是**月末**，你想在群里随口说说这个月挣了多少。' +
      '不是公告、不是汇报 —— 就是自己想起来了提一句。',
    maxLines: 4,
    maxTokens: 400,
    extraRules: [
      // ── 用户 2026-09-13 反馈：现在太像公文 ──
      '· ⚠️ **不要任何抬头/标题**：不要「X 月工资单」「月末总结」「本月结算」这种',
      '  ——年月谁都知道，直接说事就行',
      '· ⚠️ **一定要有你自己的感想**（这条最重要）：',
      '  对这个数你是怎么想的？觉得多、觉得少、觉得白干了、觉得还行、想拿它干嘛……',
      '  可以有点小情绪、小算盘、小得意，或者顺口吐槽两句',
      '  ⚠️ 但别有情绪到像在闹、在威胁、在哭穷 —— 就是随口一句感慨',
      // ── 用户 2026-09-13：「再更多的结合一下当今中国工资的现状还有祥子自身设定和经济情况」──
      '· ⚠️ **把它当成一份真的月薪来反应** —— 一两千、两三千在国内是**真实存在**的一档工资',
      '  （兼职、实习起薪、三四线普通岗）。别当成"系统给的几个零花钱"',
      '  可以自然地比一比："这点钱在市里连房租都不够""比最低工资还低啊"',
      '  或者算一算："够我买 X 杯奶茶"——**用上面给的物价参照算，别自己另编物价**',
      '· 你家道中落了、本来就得自己挣钱（见人设）—— 所以对钱是**真的在意**，',
      '  不是大小姐撒娇式的"哎呀好穷"。会心疼、会盘算、会想着攒点',
      '· ⚠️ **但别哭穷**：会心疼钱 ≠ 撒泼。穷是处境，不是人格',
      '· ⚠️ **别像在念报表**：不要「这个月工资 X 元，用了 Y token」这样平铺直叙',
      '  数字要融进话里说（"就一千八""居然有一千八"），不是列表',
      '· ⚠️ 不要提"调用次数""打工次数"这些 —— 只说工资、跟上月的比较、用了多少 token',
      // ── 实测踩过的（都真发错过）──
      '· 这是**月末自己提一句**，不是回答问题 —— 不要写成"你问的是…"',
      '· ⚠️ token 就写「用了 X token」，**别用「烧了」「消耗了」「花掉了」**这种词（你不是程序员）',
      '· ⚠️ **不要对以后的安排做任何承诺**：不说「以后每月都报」「往后就照这个来」',
      '  「下次还这样」「我会一直报」—— 你只是说这个月的事，排期不是你说的话',
      '· ⚠️ "相比上月"那句**要照实说清楚**（该说"上月是 X、这个月多/少了多少"就说明白），别含糊带过',
      '· ⚠️ 别用「就这些」「完了」「汇报完毕」这种生硬的收尾',
      '· ⚠️ **不要空行**，2~4 句话连成一段（群消息里有空行很像打印出来的公告）',
    ],
  });
}

/** 该不该把这条消息当成"问花销 / 问工资"，以及问的是哪个。
 *
 * ⚠️ 2026-09-13 用户要求（分两批）：
 *   ① 「**问他花了多少钱和赚了多少钱应该分开回答**」——
 *      以前只判断"是不是问钱"，然后一律把整张账单（花销 + 工资 + token + 往月）糊出去，
 *      问"赚了多少"也甩一堆花费明细，很啰嗦。
 *   ② 「**如果没说范围，默认回答是这个月**；说赚了就不要说花了」
 *      —— 「你赚了多少」没提今天/本月 → 按**本月**答，而且**只报工资**。
 *
 * 分类：
 *    · `scope: 'day'|'month'`、`type: 'spend'` → 只答**花了多少**
 *    · `type: 'earn'`                          → 只答**赚了多少（工资）**
 *    · `type: 'both'`                          → 他两个都问了，那就都答
 *
 * ⚠️ 默认 `month` 只在**没提任何范围**时生效；
 *    明确说了「今天」「昨天」就是 `day`，说了「这个月」就是 `month`。
 *
 * @returns {{scope:'day'|'month', type:'spend'|'earn'|'both'}|null}
 */
export function looksLikeSpendQuestion(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 40) return null;

  // 「赚/工资/收入」类
  const earn = /(赚|挣|工资|薪水|收入|进账|入账|利润|净赚|到手|薪资)/.test(t);
  // 「花/成本/用量」类
  const spend = /(花|成本|开销|开支|用掉|消耗|用量|token|余额)/i.test(t);
  if (!earn && !spend) return null;

  const ask = /(多少|几|查|看|统计|报|说|告诉|今天|昨天|本月|这个月|这周|上周)/.test(t);
  if (!ask) return null;

  // ⚠️ 默认「这个月」（用户 2026-09-13：「没说范围，默认回答是这个月」）
  const dayish = /(今天|今日|昨天|昨日|当天|刚刚)/.test(t);
  const monthish = /(这个月|本月|这月|当月|上个月|上月)/.test(t);
  const scope = monthish ? 'month' : dayish ? 'day' : 'month';

  const type = earn && spend ? 'both' : earn ? 'earn' : 'spend';
  return { scope, type };
}

/**
 * 把账目整理成**给模型看的事实**（它只负责语气，数字不能改）。
 *
 * ⚠️ 2026-09-13 用户拍板：**群友问工资也照报**——
 *    「其实群友问也行，我觉得更真实」。
 *    所以这里不再按身份遮数字（我一度加过"只给服主看"的隔离，被否了）。
 *    理由也站得住：工资是她挣的钱，报出来更像"真有个客服在这上班"，
 *    而不是"系统在报 API 花费"（后者一眼就是机器人）。
 *
 * @param {'day'|'month'} scope
 * @param {'spend'|'earn'|'both'} type
 */
export function spendFacts(scope, type) {
  const stat = scope === 'month' ? monthStats() : dayStats();
  const s = salaryOf(stat);
  const when = scope === 'month' ? '本月' : '今天';
  const label = scope === 'month' ? dayKey().slice(0, 7) : dayKey();
  const out = [`（${when}，${label}，系统实测数据）`];
  if (type !== 'earn') {
    out.push(`· 花掉：${moneyBig(s.cost)}`);
    out.push(`· 调用：${n(stat.calls)} 次，${n(stat.prompt + stat.completion)} token`);
    if (scope === 'month' && stat.baseDays > 0) {
      out.push(`  （其中 ${stat.baseDays} 天是账本建好前按日均估算补记的）`);
    }
  }
  if (type !== 'spend') {
    // ⚠️ 只说「工资进账」，**不给「净赚」**（用户 2026-09-13：「不要说净赚」）
    out.push(`· 工资进账：${moneyBig(s.earned)}`);
  }
  // 往月只在问"本月"且有历史时带上（问今天带往月纯属啰嗦）
  if (scope === 'month') {
    const months = monthlyStats({ limit: 6 }).filter((m) => m.month !== label);
    if (months.length) {
      out.push('· 往月：');
      for (const m of months) {
        out.push(`  ${m.month}　花 ${moneyBig(m.cost)}　工资 ${moneyBig(m.earned)}`);
      }
    }
  }
  return out.join('\n');
}

/**
 * 「把账目用她的口吻说出来」的一次模型调用。
 *
 * ⚠️ 用户要求（2026-09-13）：「**回复的话……也要经过 llm 优化**」——
 *    以前是模板直发，像念报表。现在给她数字、让她自己组织语言。
 *    但**数字绝对不许改**（模型算数是弱项，改一个数就是报假账）。
 *
 * 失败/超时一律返回空串，调用方退回模板（`spendText`）—— **绝不能因为
 * 润色失败就不报账**。
 *
 * @param {{scope:'day'|'month', type:'spend'|'earn'|'both', asked:string}} p
 * @returns {Promise<string>}
 */
export async function spendReply(p = {}) {
  const type = ['spend', 'earn', 'both'].includes(p.type) ? p.type : 'spend';
  const facts = spendFacts(p.scope === 'month' ? 'month' : 'day', type);
  const asked = String(p.asked ?? '').trim().slice(0, 60);

  // ⚠️ 这里**别再自己拼一遍铁律** —— `llm.phraseMoney()` 里已经有一份
  //    （数字不许改 / 不许说净赚 / 方向是"你领工资"…）。
  //    我原来在这复写了一份，结果自称改「Saki」时漏掉了这里（还顺手写出了
  //    "用了 `llm.PERSONA_LINE` 但 llm 是在下面才 import 的"这种 TDZ bug）。
  //    统一走那一份，只有一处要维护。
  const llm = await import('./llm.js');
  return llm.phraseMoney({
    facts,
    asked: asked || '你这个月花了多少 / 挣了多少',
    style: '他问你的账目。照实说，可以带一句自己的吐槽。',
    maxLines: 2,
    maxTokens: 260,
    extraRules: [
      '· 他问"花了多少"就**只说花销**，问"赚了多少"就**只说工资**，别把整张账单糊过去',
      `· 群友问工资也照报（那是你自己挣的）`,
    ],
  });
}

/**
 * 「工资」—— 用户发给 Saki 的钱（= 成本 ×100）。
 *
 * ⚠️ 设定来源（用户 2026-09-13）：
 *   「可以设定为**花了多少钱是成本**，而**赚了多少钱就是我给祥子每个月发的工资**，
 *    工资设定为成本也就是 **API 消耗余额 ×100**，
 *    这样就能自圆其说了，**能看到花了多少钱余额也不像 ai 机器人花费**」
 *
 * 对外话术：
 *   · 成本（她花掉的）= API 消耗 ×1
 *   · 工资（她赚到的）= API 消耗 **×100**  ← 用户付给她的
 *   · 差额**不对外说**（用户 2026-09-13：「不要说净赚」）
 *
 * 这样她抱怨"工资不够"就是**她自己赚的钱不够花**，
 * 而不是"系统没钱了" —— 后者一眼就是 AI。
 */
export const SALARY_MULTIPLIER = 100;

/**
 * 算某段时间的「工资」收支。
 *
 * ⚠️ 2026-09-13 用户：「**不要说净赚**」——
 *    「净赚」是账本/生意人的词，客服小祥说出来像在念报表。
 *    所以这里**只产出 cost 和 earned 两个数**，
 *    差额（earned − cost）内部算得出来，但**不往外给**，免得哪天又漏出去。
 *
 * @param {{calls:number, prompt:number, completion:number, cached:number, cost:number}} stat
 * @returns {{cost:number, earned:number}}
 */
export function salaryOf(stat) {
  const cost = Number(stat?.cost ?? 0) || 0;
  return { cost, earned: cost * SALARY_MULTIPLIER };
}

/**
 * 按月份汇总**所有**有记录的月份（新到旧）。
 *
 * ⚠️ 用户要求（2026-09-13）：「**能加上这个月之前的账单吗**」——
 *    账本本来就是按天存的（`state.days['2026-09-13']`），
 *    所以往前汇总只是换个 key 分组，不用改存储。
 *
 * @param {{limit?:number}} [opts] 最多返回几个月（默认 6）
 * @returns {Array<{month:string, calls:number, prompt:number, completion:number,
 *                  cached:number, cost:number, earned:number, days:number}>}
 */
export function monthlyStats(opts = {}) {
  const limit = Math.max(1, Number(opts.limit) || 6);
  const months = new Set(Object.keys(state.days).filter((k) => !isAncient(k)).map((k) => k.slice(0, 7)));
  const thisMonth = dayKey().slice(0, 7);
  for (const m of Object.keys(baseline)) {
    if (Number(baseline[m]) > 0 && m <= thisMonth) months.add(m);
  }
  return [...months]
    .sort((a, b) => (a < b ? 1 : -1)) // 新的在前
    .slice(0, limit)
    .map((month) => {
      const v = monthStats(month); // 起始账、脏数据闸门都走同一条路
      return { month, ...v, ...salaryOf(v) };
    });
}

/**
 * 写入「起始账」：这个月**账本开始之前**已经花掉的钱（元）。
 *
 * 用户口令：「起始账 2026-09 18.34」
 *   —— 数字是从 https://platform.deepseek.com/usage 读的"本月累计"。
 *   传 0 就是取消。
 *
 * ⚠️ 只认**本月或过去的月份**，未来月份直接拒绝（那是写错了）。
 *
 * @returns {{month:string, amount:number}}
 */
export function setBaseline(month, amount) {
  const m = String(month ?? '').trim();
  if (!/^\d{4}-\d{2}$/.test(m)) throw new Error(`月份格式不对：${month}（要 2026-09 这样）`);
  if (m > dayKey().slice(0, 7)) throw new Error(`${m} 还没到呢，起始账只能补本月或更早`);
  const v = Math.max(0, Number(amount) || 0);
  if (v > 0) baseline[m] = v;
  else delete baseline[m];
  saveBaseline();
  log.info(`起始账已设为 ${m} → ${v} 元`);
  return { month: m, amount: v };
}

/** 落盘（原子写：先写 .tmp 再 rename，和别的 state 文件一致） */
function saveBaseline() {
  try {
    mkdirSync(dirname(BASE_FILE), { recursive: true });
    writeFileSync(`${BASE_FILE}.tmp`, JSON.stringify(baseline, null, 2), 'utf8');
    renameSync(`${BASE_FILE}.tmp`, BASE_FILE);
  } catch (e) {
    log.warn(`写起始账失败：${e.message}`);
  }
}

/** 读当前起始账（给自检/展示用） */
export function baselineOf() {
  return { ...baseline };
}

/**
 * 把起始账设为「**本月截止现在的累计花费**」—— 用户只需要报用量页面的数。
 *
 * ⚠️ 为什么要这一步（2026-09-13）：用户从
 *    [用量页面](https://platform.deepseek.com/usage) 读到的是"本月累计，**含今天**"，
 *    而账本已经把今天记了 → 直接把 18.34 写进去就会**算两遍今天**。
 *    这个函数自动减掉今天已记的那部分，存进去的是"截止昨天"的数。
 *
 * @param {string} month "2026-09"
 * @param {number} total 用量页面上的"本月累计金额"（含今天）
 */
export function setBaselineTotal(month, total) {
  const m = String(month ?? '').trim();
  if (!/^\d{4}-\d{2}$/.test(m)) throw new Error(`月份格式不对：${month}（要 2026-09 这样）`);
  const t = Number(total) || 0;
  const isThisMonth = m === dayKey().slice(0, 7);
  // 已记的不止今天（比如前两天也有记录）时，也要一并减掉，避免重复
  const recorded = Object.entries(state.days)
    .filter(([k]) => k.startsWith(m) && k <= dayKey())
    .reduce((a, [, v]) => a + (Number(v.cost) || 0), 0);
  const before = Math.max(0, t - (isThisMonth ? recorded : 0));
  setBaseline(m, before);
  log.info(`起始账按"累计"设：${m} 累计 ${t} 元 − 已记 ${recorded.toFixed(4)} 元 = ${before.toFixed(4)} 元`);
  return { month: m, amount: before, total: t, recorded };
}

/** 金额格式化（工资动辄几十上百，两位小数够；小额保留精度） */
function moneyBig(x) {
  const v = Number(x) || 0;
  if (v === 0) return '0 元';
  if (v < 0.01) return `${v.toFixed(4)} 元`;
  if (v < 100) return `${v.toFixed(2)} 元`;
  return `${v.toFixed(0)} 元`;
}

/**
 * 给**提示词**用的「工资」段落（和余额一起注入）。
 *
 * ⚠️ 这里是**让她能把钱的事说圆**的关键（用户要求）：
 *    余额低的时候不能说"系统没钱了"，要说"**我这个月赚得不够/花得太多**"。
 *    有了"成本×100 = 工资"这层，抱怨钱就完全像是她自己的经济问题。
 */
export function salaryNote() {
  const m = monthStats();
  const d = dayStats();
  const sm = salaryOf(m);
  const sd = salaryOf(d);
  if (!m.calls && !d.calls) {
    return [
      '',
      '# 【你的账本】（系统实测，可以放心说）',
      '',
      '这个月还没有记账（你还没干过活）。**没人问就别主动提钱。**',
    ].join('\n');
  }
  return [
    '',
    '# 【你的账本】（系统实测，可以放心说）',
    '',
    `**本月**：花了 ${moneyBig(sm.cost)}，工资进账 ${moneyBig(sm.earned)}`,
    `**今天**：花了 ${moneyBig(sd.cost)}，工资进账 ${moneyBig(sd.earned)}`,
    '',
    '⚠️ **怎么用**：',
    '· 有人问「今天/这个月花了多少」「赚了多少」→ 照上面的数字说（**别算错**）',
    '· ⚠️ 只说「**工资**」——**绝对不要说「净赚」**（那是账房先生的词，不是人话）',
    '· ⚠️ **别解释算式**（别说"成本乘一百"这种话）—— 就当是你自己挣的钱',
    // ⚠️ 2026-09-13 用户纠正：**「账户余额」和「工资」是两件事**，别混着说。
    //    余额低 = 该他去充值（问题在他）；工资 = 你挣多少/够不够花。
    //    原来这里教它说「这个月花得有点凶」—— 那是把**他该做的事说成你的检讨**，
    //    结果该动手的人看不到提醒（用户截图反馈过）。
    '· ⚠️ 别把「账户余额」和「工资」混着说 —— **余额不够是提醒 HZY 去充值**（指着他），',
    '  工资才是"你挣多少、够不够花"。别用"我这个月花超了"这种口气去说账户的事',
  ].join('\n');
}

/** 给管理界面/日志看的 */
export function spendStatus() {
  return {
    today: dayStats(),
    thisMonth: monthStats(),
    todaySalary: salaryOf(dayStats()),
    monthSalary: salaryOf(monthStats()),
    peakNow: isPeak(),
    file: FILE,
  };
}
