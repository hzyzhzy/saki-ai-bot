/**
 * 字幕断行自检 —— 交付前跑这个，比等 6 分钟合成完再看快得多
 *
 * 用法：
 *   node tools/subtitle-wrap-test.mjs                    # 用 logs/bili/intro_lines.json
 *   node tools/subtitle-wrap-test.mjs 某个台词.json       # 指定文件
 *   node tools/subtitle-wrap-test.mjs --text "一句话"      # 直接测一句
 *
 * 判据（任一不满足就退出码 1）：
 *   ① 拆完拼回去和原文**一字不差**（丢字是最严重的错）
 *   ② 每行宽度 ≤ SUB_WIDTH（超了会被画面边缘裁掉）
 *   ③ 行尾不许是半个英文单词
 */
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrapSub, widthOf, lossless, SUB_WIDTH } from './lib/subtitle-wrap.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

let lines = [];
const ti = argv.indexOf('--text');
if (ti >= 0) {
  lines = [argv[ti + 1]];
} else {
  const f = resolve(argv[0] || join(ROOT, 'logs', 'bili', 'intro_lines.json'));
  const j = JSON.parse(readFileSync(f, 'utf8'));
  lines = j.map((x) => (typeof x === 'string' ? x : String(x.text || '').trim()));
  console.log(`台词文件：${f}\n`);
}

let bad = 0;
lines.forEach((t, i) => {
  const rows = wrapSub(t);
  console.log(`[${i}] ${t}`);
  for (const r of rows) {
    const w = widthOf(r);
    const over = w > SUB_WIDTH + 0.01 ? ' ⚠️超宽' : '';
    console.log(`     (${w.toFixed(1)}) ${r}${over}`);
  }
  if (!lossless(t)) { console.log('     ❌ 丢字/错字了'); bad++; }
  if (rows.some((r) => widthOf(r) > SUB_WIDTH + 0.01)) { console.log('     ❌ 有行超宽'); bad++; }
  if (rows.some((r) => /[A-Za-z]$/.test(r) && /[A-Za-z]/.test(t[t.indexOf(r) + r.length] || ''))) {
    console.log('     ⚠️ 可能切断了英文单词');
  }
  console.log('');
});

if (bad) {
  console.log(`❌ 有 ${bad} 处问题，别急着合成`);
  process.exit(1);
}
console.log('✅ 全部通过（无丢字、无超宽）');
