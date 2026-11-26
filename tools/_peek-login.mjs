import { readFileSync } from 'node:fs';

const t = readFileSync('C:/SnowLuma/index.mjs', 'utf8').split('\n');
const needle = 'login detected: PID=%d';
const idx = [];
for (let i = 0; i < t.length; i++) if (t[i].includes(needle)) idx.push(i);
console.log('命中行：', idx.map((i) => i + 1).join(', '));
for (const i of idx) {
  console.log(`\n===== 行 ${i + 1} 附近 =====`);
  for (let n = Math.max(0, i - 10); n < Math.min(t.length, i + 16); n++) {
    console.log(`${n + 1}: ${t[n]}`);
  }
}
