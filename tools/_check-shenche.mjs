import { readFileSync } from 'node:fs';

const t = readFileSync('personas/shenche/life-events.md', 'utf8');
const segs = t.split(/^### /m).slice(1);
let total = 0;
let ok = true;
for (const s of segs) {
  const name = s.split('\n')[0].trim();
  const n = (s.match(/^- \d \| /gm) || []).length;
  total += n;
  const segOk = n >= 12;
  if (!segOk) ok = false;
  console.log(`${name} → ${n} 条${segOk ? '' : '  ❌ 少于 12'}`);
}
console.log(`合计 ${total} 条（要求 ≥90）${total >= 90 ? ' ✓' : ' ❌'}`);

// 台词禁令：正文行里不许出现引号
const quoteLines = t
  .split('\n')
  .filter((l) => /^[>-]/.test(l) && /["“”『』「」]/.test(l) && !/^<!--/.test(l));
console.log(`含引号的行：${quoteLines.length}（要求 0）`);
if (quoteLines.length) {
  ok = false;
  console.log(quoteLines.slice(0, 5).join('\n'));
}

// 人名只能在 cast 里
const cast = readFileSync('personas/shenche/cast.md', 'utf8');
const names = ['谢璩', '江澈', '商岫', '陆瑄', '苏霁', '韩瑀', '谢邈', '商砚', '沈熠', '柳琤'];
const outsider = names.filter((n) => !cast.includes(n));
console.log(`名册人名：${names.filter((n) => t.includes(n)).join('、')}`);
if (outsider.length) {
  ok = false;
  console.log(`❌ 事件里用到但名册没有的：${outsider.join('、')}`);
}

process.exit(ok ? 0 : 1);
