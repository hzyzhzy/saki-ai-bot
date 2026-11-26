// 跨多轮分析：哪些段每轮在变（跑完删）
import { readFileSync, existsSync } from 'node:fs';

const F = 'logs/_seg-fp.ndjson';
if (!existsSync(F)) {
  console.log('还没有 _seg-fp.ndjson（说明还没跑过一轮）');
  process.exit(0);
}
const rounds = readFileSync(F, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

console.log(`共 ${rounds.length} 轮\n`);
if (rounds.length < 2) {
  console.log('至少要有 2 轮才能对比');
  process.exit(0);
}

// 用「开头 24 字」当段的身份；统计：出现次数 / 出现过几种不同内容
const stat = new Map(); // head -> { shown: Set(roundIdx), hashes: Set }
rounds.forEach((r, ri) => {
  for (const item of r.fp ?? []) {
    const [hash, , head] = String(item).split('|');
    if (!stat.has(head)) stat.set(head, { shown: new Set(), hashes: new Set(), len: 0 });
    const s = stat.get(head);
    s.shown.add(ri);
    s.hashes.add(hash);
    s.len = Number(String(item).split('|')[1]) || s.len;
  }
});

const N = rounds.length;
const rows = [];
for (const [head, s] of stat) {
  // 三种"不稳"：出现次数不全 + 内容变过 + 只出现一次
  const missing = N - s.shown.size;
  const changed = s.hashes.size > 1;
  if (!missing && !changed) continue; // 稳定段跳过
  rows.push({ head, missing, changed, kinds: s.hashes.size, len: s.len });
}
// 按"不稳定程度"排序：内容变 > 时有时无
rows.sort((a, b) => (b.changed ? 1 : 0) - (a.changed ? 1 : 0) || b.missing - a.missing || b.len - a.len);

console.log(`⚠️ 不稳定段共 ${rows.length} 个（总段数约 ${rounds[0].n}）：\n`);
for (const r of rows.slice(0, 30)) {
  const tag = r.changed ? `内容变了 ${r.kinds} 种` : '';
  const tag2 = r.missing ? `有 ${r.missing}/${N} 轮没出现` : '';
  console.log(`  ${String(r.len).padStart(5)}字  ${JSON.stringify(r.head)}  ${[tag, tag2].filter(Boolean).join('，')}`);
}
