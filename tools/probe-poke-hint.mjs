/**
 * 戳一次 → 立刻看界面上那条「戳了戳」提示的结构。
 * 目标固定用测试群里的「谷雨」（用户自己的号，零打扰）。
 */

import { acquireLease, runPy, findQQHwnd, cleanup, parseLastJson } from './anode-call.mjs';

await acquireLease(600);
const found = await findQQHwnd();
const hwnd = String(found.hwnd);

// 确保在测试群
await runPy('qq-py.py', ['switch', '--hwnd', hwnd, '--group', "谷雨、Stby'Crs、Anon、Saki"], {
  timeoutMs: 120000,
});

// 戳
const pokeOut = await runPy('qq-poke.py', ['--hwnd', hwnd, '--to', '谷雨'], { timeoutMs: 180000 });
const p = parseLastJson(String(pokeOut || ''));
console.log('戳：' + JSON.stringify(p));

await new Promise((r) => setTimeout(r, 1200));

// 看结构
const dOut = await runPy('qq-probe-poke-hint.py', ['--hwnd', hwnd], { timeoutMs: 120000 });
const d = parseLastJson(String(dOut || ''));
if (!d) {
  console.log('诊断没返回 JSON：');
  console.log(String(dOut).slice(-2000));
  await cleanup();
  process.exit(1);
}

console.log(`\n=== 含「戳」的节点（${d.hits.length} 个）===`);
for (const h of d.hits) {
  console.log(`  d${h.depth} ${h.cls.padEnd(56)} | ${h.name}  rect=${JSON.stringify(h.rect)}`);
}

console.log('\n=== 第一个命中的祖先链（从自己往上）===');
for (const c of d.first_chain || []) {
  console.log(`  ${c.cls.padEnd(56)} | ${String(c.name || '').slice(0, 40)}  rect=${JSON.stringify(c.rect)}`);
}

await cleanup();
process.exit(0);
