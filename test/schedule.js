/**
 * 「这个点她在哪」测试（2026-09-16）。
 *
 * ## 用户截图报的冲突
 *
 * 群里有人 @她问「你工作没有假期么」，她答：
 *
 * > 「有啊，**轮到谁值班谁上。放假也得来，我这不是坐了一天了**」
 *
 * 两句都和人设/时间表冲突：
 *   · 人设写的是「**白天在羽丘教室，放学后才到客服室**」→「坐了一天」= 坐班一整天；
 *   · 那天是**周三、不是假期**（`holiday.on().off === false`）→「放假也得来」凭空放了个假。
 *
 * 根因：人设里那张时间表是**静态的**，模型得自己从"现在几点"推"我在教室还是客服室"，
 * 被带着前提的问题一引（"没有假期么"）就推飞了。
 *
 * ## 两道修（这个套件都钉着）
 *
 * | # | 改动 | 在哪 |
 * | --- | --- | --- |
 * | ① | `whereAmI()`：把「今天是不是上学日 / 这个点你在哪 / 不许说什么」**算好**写进时间那一段 | `src/bot.js` → `timeText()` |
 * | ② | 人设「别演串的四件事」加了第 4 条：不许说"坐了一天"、不许凭空放假 | `knowledge/persona.md` |
 *
 * ⚠️ 纯单元测试：不起机器人、不连 NapCat、不花钱
 *
 * 用法: node test/schedule.js
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });

const CFG_REL = 'logs/__test-schedule.yml';
writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
    '  apiKey: "sk-test"',
    '  model: test-model',
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
const { whereAmI } = mod;
const BotClass = mod.Bot ?? mod.default ?? null;
const KNOW = process.env.QQBOT_KNOWLEDGE_DIR
  ? join(ROOT, process.env.QQBOT_KNOWLEDGE_DIR)
  : join(ROOT, 'knowledge');

// 2026-09-16 是周三（上学日）；2026-09-19 是周六
const wed = (h, m = 0) => new Date(2026, 8, 16, h, m);
const sat = (h, m = 0) => new Date(2026, 8, 19, h, m);

console.log('\n【1】★ 上学日 / 周末分得清');
{
  check(typeof whereAmI === 'function', '导出了 `whereAmI`（测试要能单独问它）');
  check(whereAmI(wed(10))?.schoolDay === true, '周三 10:00 → 上学日');
  check(whereAmI(sat(11))?.schoolDay === false, '周六 11:00 → 不是上学日');
  check(/上学日/.test(whereAmI(wed(10)).line), '文本里写明了"上学日"');
  check(/周末|不上学/.test(whereAmI(sat(11)).line), '周末写明了"不上学"');
}

console.log('\n【2】★★ 这个点她在哪（截图那两个错就是这里出的）');
{
  const morning = whereAmI(wed(10)).line;
  check(/教室/.test(morning), '★ 周三上午 → **在教室**', morning.split('\n')[1] ?? '');
  check(!/客服室/.test(morning.split('\n')[1] ?? ''), '★ 上午那条**不说**客服室（那个点在教室）');

  // ★★ 2026-09-18 用户报「为什么这个时候还在上课」：中午 12 点是**午休**，
  //    而原来 `hh < 15` 一律写成"在教室上课"——她 12:39 刚说去吃饭，12:41 又说在上课。
  const noon = whereAmI(wed(12)).line;
  check(/午休/.test(noon), '★★ 周三 12:00 → **午休**（不是"在教室上课"）', noon.split('\n')[1] ?? '');
  check(!/上课/.test(noon.split('\n')[1] ?? ''), '★★ 午休那条**不许**出现"上课"');
  check(/上课/.test(whereAmI(wed(13)).line), '★ 13:00 回到上课');
  check(/上课/.test(whereAmI(wed(11)).line), '★ 11:00 还在上课（午休只从 12 点开始）');

  const after = whereAmI(wed(16)).line;
  check(/客服室/.test(after), '★ 周三 16:00 → **放学后到客服室**');

  const night = whereAmI(wed(23)).line;
  check(/回家/.test(night), '★ 周三 23:00 → 下班回家了');

  const weekendDay = whereAmI(sat(14)).line;
  check(/不上学/.test(weekendDay), '★ 周六白天 → 不上学（可能在客服室，也可能在家）');
}

console.log('\n【3】★★ 硬规矩：不许说"坐了一天"、不许凭空放假');
{
  const school = whereAmI(wed(16)).line;
  check(/不许/.test(school) && /坐了一天/.test(school), '★ 上学日明说"不许说坐了一天"');
  check(/不放假/.test(school), '★ 上学日明说"今天不放假"');
  check(/高一学生|羽丘/.test(school), '★ 也说清了"白天在教室、放学后才去客服室"');

  const weekend = whereAmI(sat(14)).line;
  check(/不上学/.test(weekend) && /排班/.test(weekend), '★ 周末说"不上学"，但排班照样可能要去');
}

console.log('\n【4】★ 提示词里真的注入了（最靠近对话的那一段）');
{
  const b = new BotClass();
  const sys = b.buildSystemPrompt('', null, null, '');
  check(/这个点你应该在哪/.test(sys), '★ 提示词里有【这个点你应该在哪】那一段');
  check(/上学日/.test(sys) || /不上学/.test(sys), '★ 并且写清了今天是上学日还是放假');
  check(/坐了一天/.test(sys), '★ 那句"不许说坐了一天"也进去了');
}

console.log('\n【5】★ 人设那边也补了（光靠代码不够：模型会编理由）');
{
  const persona = readFileSync(join(KNOW, 'persona.md'), 'utf8');
  check(/别演串的四件事/.test(persona), '★ 人设写的是"四件事"（原来三件）');
  check(/坐了一天/.test(persona), '★ 那条硬规矩在：不许说"一整天都在客服室/坐了一天"');
  check(/凭空|没放假就别说放假/.test(persona), '★ 也不许凭空放假');
}

console.log('\n【6】代码层：接线别再被拆掉');
{
  const src = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(/export function whereAmI/.test(src), '`whereAmI` 还在（并且导出给测试用）');
  check(/holiday\.on\(now\.getTime\(\)\)/.test(src), '★ 它真的去查了"今天放不放假"');
  check(
    /const w = whereAmI\(d\);[\s\S]{0,120}?这个点你应该在哪/.test(src),
    '★ `timeText()` 里把它拼进提示词了',
  );
}

console.log(
  failures === 0
    ? '\n结果: 全部通过 ✅（这个点她在哪算得对；"坐了一天/凭空放假"被两道闸挡住）\n'
    : `\n结果: ${failures} 项失败 ❌\n`,
);
process.exit(failures === 0 ? 0 : 1);
