// 主人的作息 / 固定习惯统计（2026-10-19 用户要求）
// ⚠️ 只测"数出来的东西"：只记主人、按天聚合、digest 里有数才输出、30 天自动清
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
process.env.QQBOT_CONFIG = 'config.yml';
process.env.QQBOT_OWNER_RHYTHM_FILE = 'logs/__test-rhythm.json';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

try {
  rmSync(join(ROOT, 'logs/__test-rhythm.json'), { force: true });
} catch {}

const { config } = await import('../src/config.js');
const rh = await import('../src/owner-rhythm.js');
const OWNER = String(config.ownerQQ);
const OTHER = '999999999';

console.log(`\n[1] 只记主人（ownerQQ=${OWNER}）`);
rh.__reset();
rh.note(OTHER, new Date('2026-10-18T03:10:00'));
check(Object.keys(rh.__raw().days).length === 0, '别人发的**一条都不记**');

rh.note(OWNER, new Date('2026-10-18T03:10:00'));
rh.note(OWNER, new Date('2026-10-18T03:40:00'));
const d1 = rh.__raw().days['2026-10-18'];
check(!!d1, '主人发消息 ⇒ 有了当天记录');
check(Number(d1?.n) === 2, '条数累加对了（2）', String(d1?.n));
check(JSON.stringify(d1?.hours) === '[3]', '小时去重（只有 3 点）', JSON.stringify(d1?.hours));
check(d1?.first === '03:10' && d1?.last === '03:40', '首末时间对', `${d1?.first}~${d1?.last}`);

console.log('\n[2] 按天聚合 + 跨天');
rh.note(OWNER, new Date('2026-10-17T01:30:00'));
rh.note(OWNER, new Date('2026-10-17T10:05:00'));
check(Object.keys(rh.__raw().days).length === 2, '两天就是两条记录（不无限增长）');

console.log('\n[3] digest 只在"有数据"时说话');
rh.__reset();
check(rh.digest() === '', '一条都没有 ⇒ 空串（不塞占位段）');
rh.note(OWNER, new Date('2026-10-18T03:10:00'));
check(rh.digest() === '', '只有一天凌晨 ⇒ 还不说（要 ≥2 天）');

console.log('\n[4] 攒够 2 天凌晨 ⇒ 说"最近 7 天里有几天凌晨"');
// 造出"最近 7 天内 2 天凌晨"
const now = new Date();
const mk = (back, hour, min) => {
  const d = new Date(now);
  d.setDate(d.getDate() - back);
  d.setHours(hour, min, 0, 0);
  return d;
};
rh.__reset();
rh.note(OWNER, mk(1, 2, 30));
rh.note(OWNER, mk(2, 3, 50));
const dg = rh.digest();
check(dg.includes('凌晨'), '提了"凌晨"', dg.split('\n').find((l) => l.includes('凌晨')) ?? '');
check(/有 \*\*\d+ 天\*\*/.test(dg), '带了"有 N 天"的数字');
check(dg.includes('心里有数'), '提醒"只是心里有数、不要每次念"');
check(dg.includes('深夜别劝睡'), '明确保留人设那条禁令');

console.log('\n[5] 30 天前的自动清掉');
rh.__reset();
rh.note(OWNER, mk(40, 3, 0));
check(Object.keys(rh.__raw().days).length === 0, '40 天前那条没留下');

console.log(`\n结果: ${failures ? `❌ ${failures} 项失败` : '全部通过 ✅'}`);
process.exit(failures ? 1 : 0);
