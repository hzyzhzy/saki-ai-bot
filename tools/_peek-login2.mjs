import { readFileSync } from 'node:fs';

const t = readFileSync('C:/SnowLuma/index.mjs', 'utf8').split('\n');
for (let i = 0; i < t.length; i++) {
  const s = t[i];
  if (/\.on\(\s*"login"|case\s*"login"|type\s*===\s*"login"|"login"\s*:/.test(s)) {
    console.log(`\n===== 行 ${i + 1} =====`);
    for (let n = Math.max(0, i - 8); n < Math.min(t.length, i + 18); n++) console.log(`${n + 1}: ${t[n]}`);
  }
}
