/**
 * 节日（`src/holiday.js` + `knowledge/holidays.md`）回归。
 *
 * ## 盯的四件事
 *
 * 1. **农历不用手写表**：春节 / 中秋 / 端午 / 元宵的日期要**真的算对**
 *    （用 Node 自带的 `Intl` 的 `u-ca-chinese`）
 * 2. ⚠️ **闰月必须跳过** —— 闰六月初一**不是**六月初一
 *    （2025 年有闰六月，正好拿来验）
 * 3. **日本节日 vs 中国节日不能混**：
 *    日本的是"她自己会过"（换事件池 + 放假屏蔽学校事件）；
 *    中国的只是**素材**，不许自动出事件
 * 4. **放假那天不许出「上课 / 赶电车」**
 *
 * ⚠️ 纯离线，不调模型、不碰真实 state。
 *
 * 用法: node test/holiday.js
 */
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** ⚠️ knowledge 目录跟着 `QQBOT_KNOWLEDGE_DIR` 走（回归时是各套件自己的副本） */
const KNOW = process.env.QQBOT_KNOWLEDGE_DIR
  ? join(ROOT, process.env.QQBOT_KNOWLEDGE_DIR)
  : join(ROOT, 'knowledge');
mkdirSync(join(ROOT, 'logs'), { recursive: true });
const CFG_REL = 'logs/__test-holiday.yml';
const LIFE_REL = 'logs/__test-holiday-life.json';
const STORY_REL = 'logs/__test-holiday-story.json';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
    '  apiKey: "sk-test"',
    '  model: t',
    'life:',
    '  enable: true',
    '  holidays: true',
    'storyline:',
    '  enable: true',
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;
process.env.QQBOT_LIFE_FILE = LIFE_REL;
process.env.QQBOT_STORYLINE_FILE = STORY_REL;

const hol = await import('../src/holiday.js');
const life = await import('../src/life.js');

const D = (s, hh = 12, mm = 0) => {
  const d = new Date(`${s}T00:00:00`);
  d.setHours(hh, mm, 0, 0);
  return d.getTime();
};

// ─────────────────────────────────────────────────────────────
console.log('\n【1】★★ 农历节日：必须真的算对（不是手写表）');
{
  // 这几个是查证过的公历日期
  const cases = [
    ['2026-02-17', '春节'],
    ['2026-03-03', '元宵节'],
    ['2026-06-19', '端午节'],
    ['2026-09-25', '中秋节'],
    ['2027-02-07', '春节'],
  ];
  for (const [d, name] of cases) {
    const names = hol.on(D(d)).names;
    check(names.includes(name), `${d} → ${name}`, JSON.stringify(names));
  }
  // 前一天不该命中（确保不是"整月都算"）
  check(!hol.on(D('2026-02-16')).names.includes('春节'), '2026-02-16 不是春节');
  check(!hol.on(D('2026-09-24')).names.includes('中秋节'), '2026-09-24 不是中秋');
}

console.log('\n【2】★★ 闰月必须跳过（闰六月初一 ≠ 六月初一）');
{
  // 2025 年有闰六月：2025-07-25 是闰六月初一
  const l = hol.lunarMD(new Date('2025-07-25T12:00:00'));
  check(l?.leap === true, '★ 2025-07-25 被识别成闰月', JSON.stringify(l));
  const l2 = hol.lunarMD(new Date('2025-06-25T12:00:00'));
  check(l2?.leap === false && l2.month === 6 && l2.day === 1, '★ 2025-06-25 = 六月初一（不闰）', JSON.stringify(l2));
  // 造一个"农历六月初一"的节日，闰月那天不许命中
  const raw = hol.parse('## 中国\n- L06-01 | 测试节\n### 测试节\n- 3 | 测试事件');
  check(raw.length === 1, '能解析');
  hol.__set(raw);
  check(hol.on(D('2025-06-25')).names.includes('测试节'), '★ 六月初一 → 命中');
  check(!hol.on(D('2025-07-25')).names.includes('测试节'), '★★ 闰六月初一 → **不**命中');
  hol.reload(); // 还原真实表
}

console.log('\n【3】日期四种写法都要能解析');
{
  check(hol.parseDate('01-01')?.kind === 'day', '`MM-DD`');
  check(hol.parseDate('04-29..05-05')?.kind === 'range', '`MM-DD..MM-DD`');
  check(hol.parseDate('01-W2-1')?.kind === 'nth', '`MM-Wn-d`');
  check(hol.parseDate('L08-15')?.kind === 'lunar', '`LMM-DD`');
  check(hol.parseDate('乱写的') === null, '乱写的返回 null');
  // 第 n 个星期几要算对：2026-01 的第 2 个周一
  const names = hol.on(D('2026-01-12')).names;
  check(names.includes('成人の日'), '2026-01-12 = 1月第2个周一 = 成人の日', JSON.stringify(names));
  check(!hol.on(D('2026-01-05')).names.some((n) => /成人/.test(n)), '2026-01-05（第 1 个周一）不是');
}

console.log("\n【4】区间 + 跨年区间");
{
  check(hol.on(D('2026-05-01')).names.includes('ゴールデンウィーク'), '05-01 在 GW 里');
  check(!hol.on(D('2026-05-10')).names.includes('ゴールデンウィーク'), '05-10 不在 GW 里');
  // 年末年始 12-29..01-03 跨年
  check(hol.on(D('2026-12-30')).names.includes('年末年始'), '12-30 在年末年始里');
  check(hol.on(D('2027-01-02')).names.includes('年末年始'), '★ 跨年：01-02 也在');
  check(!hol.on(D('2027-01-05')).names.includes('年末年始'), '01-05 不在');
}

console.log('\n【5】★★ 日本节日 vs 中国节日：绝不能混');
{
  // 春节：中国的 → foreign
  const spring = hol.on(D('2026-02-17'));
  check(spring.foreign.some((h) => h.name === '春节'), '★ 春节被标成 foreign');
  check(
    !spring.events.some((e) => /春节/.test(e.holiday ?? '')),
    '★★ 春节**不产生事件**（她自己不会过，得等群友说）',
  );
  // 元日：日本的 → 有事件
  const newyear = hol.on(D('2026-01-01'));
  check(newyear.local.some((h) => h.name === '元日'), '元日在 local 里');
  check(newyear.events.length > 0, '★ 元日有专属事件', `${newyear.events.length} 条`);
  check(newyear.off === true, '元日是放假');
  check(newyear.events.some((e) => e.holiday === '元日'), '事件带上了节日名');
  // 她的"这天怎么过"要能取到
  check(/便利店|加班|三倍/.test(hol.on(D('2026-01-01')).noteText), '★ 取到了"她怎么过这天"的设定');
  check(/母亲|安静/.test(hol.on(D('2026-08-14')).noteText), '★ お盆 那条沉重的设定在');
}

console.log('\n【6】★★ 放假那天不许出「上课 / 赶电车」');
{
  // 2026-01-01 元日（放假）→ 上午只能是非学校事件
  const schoolish = /学校|上课|课|小测|作业|体育|同学|翘|值日|电车|通勤|校服|校门/;
  let bad = 0;
  for (let i = 0; i < 40; i++) {
    life.plan(D('2026-01-01', 10, 0), Math.random);
    life.__setState({ nextAt: D('2026-01-01', 10, 0), fired: 0, target: 50 });
    const p = life.plan(D('2026-01-01', 10, 0), Math.random);
    if (p.fire && schoolish.test(p.template.text)) bad++;
    life.__clear();
  }
  check(bad === 0, `★ 元日上午抽 40 次，0 次是学校/通勤事件（实际 ${bad}）`);

  // 对照：普通上学日应该能抽到学校事件
  let schoolOnNormal = 0;
  for (let i = 0; i < 60; i++) {
    life.__clear();
    life.plan(D('2026-05-20', 10, 0), Math.random);
    life.__setState({ nextAt: D('2026-05-20', 10, 0), fired: 0, target: 50 });
    const p = life.plan(D('2026-05-20', 10, 0), Math.random);
    if (p.fire && schoolish.test(p.template.text)) schoolOnNormal++;
  }
  check(schoolOnNormal > 0, `★ 对照：普通日子里学校事件出得来（${schoolOnNormal}/60）`);
  life.__clear();
}

console.log('\n【7】节日事件带上节日名当标签（能顺着故事线关联）');
{
  const h = hol.on(D('2026-01-01'));
  const ev = h.events[0];
  check((ev.tags ?? []).some((t) => /元日|正月/.test(t)), `事件标签：${JSON.stringify(ev.tags)}`);
  check(typeof ev.w === 'number' && ev.w >= 1 && ev.w <= 5, '权重合法');
}

console.log('\n【8】真实那份文件解析得动（用户会手改它）');
{
  const md = readFileSync(join(KNOW, 'holidays.md'), 'utf8');
  const list = hol.parse(md);
  check(list.length >= 30, `解析出 ${list.length} 个节日`);
  check(list.filter((h) => h.foreign).length >= 8, `中国节日 ${list.filter((h) => h.foreign).length} 个`);
  check(list.filter((h) => h.off).length >= 15, `放假的 ${list.filter((h) => h.off).length} 个`);
  check(list.filter((h) => h.events.length).length >= 8, `有专属事件的 ${list.filter((h) => h.events.length).length} 个`);
  check(list.filter((h) => h.note).length >= 20, `带"她怎么过这天"设定的 ${list.filter((h) => h.note).length} 个`);
  const s = hol.status();
  check(s.total === list.length, 'status() 对得上');
}

try {
  for (const f of [CFG_REL, LIFE_REL, STORY_REL]) rmSync(join(ROOT, f), { force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
