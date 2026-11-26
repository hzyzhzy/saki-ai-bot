import { readFileSync } from 'node:fs';

const t = readFileSync('C:/SnowLuma/index.mjs', 'utf8').split('\n');
for (let i = 0; i < t.length; i++) {
  const s = t[i];
  // HookManager 上的卸载入口（方法定义）
  if (/^\s*(async\s+)?unload\w*\s*\(/.test(s) && i > 4900 && i < 6000) {
    console.log(`\n===== 行 ${i + 1} =====`);
    for (let n = Math.max(0, i - 4); n < Math.min(t.length, i + 14); n++) console.log(`${n + 1}: ${t[n]}`);
  }
}
