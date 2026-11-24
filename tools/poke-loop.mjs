/**
 * 连戳谷雨 3 次 → 等她（SnowLuma 那个号）回戳 Saki → 验证「收戳一戳」整条链路。
 *
 * 为什么这么绕：Saki 现在走客户端适配器，"被戳"必须**别人来戳她**才算数。
 * 谷雨是 SnowLuma 上的另一个号，`poke.countPerBack` 默认 3（戳 3 次回拍一次），
 * 所以连戳她 3 次，她就会用 `send_poke` 回戳 Saki —— 正好是我们缺的那个"别人"。
 *
 *   node tools/poke-loop.mjs
 */

import { acquireLease, runPy, findQQHwnd, cleanup, parseLastJson } from './anode-call.mjs';

const GROUP = "谷雨、Stby'Crs、Anon、Saki";
const TI = process.argv.indexOf('--to');
const WHO = TI >= 0 ? process.argv[TI + 1] : '谷雨';

await acquireLease(600);
const found = await findQQHwnd();
const hwnd = String(found.hwnd);

const sw = await runPy('qq-py.py', ['switch', '--hwnd', hwnd, '--group', GROUP], { timeoutMs: 120000 });
console.log(String(sw || '').trim().split('\n').slice(-1)[0]);

for (let i = 1; i <= 3; i++) {
  const out = await runPy('qq-poke.py', ['--hwnd', hwnd, '--to', WHO], { timeoutMs: 180000 });
  const p = parseLastJson(String(out || ''));
  console.log(
    `第 ${i} 次戳：ok=${p?.ok} at=${JSON.stringify(p?.avatar_at || [])} tries=${JSON.stringify(p?.tries || [])} hint=${p?.hint || ''} err=${p?.error || ''}`,
  );
  await new Promise((r) => setTimeout(r, 2500));
}

console.log('\n等她回戳（10 秒）…');
await new Promise((r) => setTimeout(r, 10000));

const readOut = await runPy('qq-read.py', ['--hwnd', hwnd, '--limit', '20'], { timeoutMs: 120000 });
const r = parseLastJson(String(readOut || ''));
console.log(`\n=== 现在界面上（${r?.group}，消息 ${r?.messages?.length ?? 0} 条 / 提示 ${r?.tips?.length ?? 0} 条）===`);
for (const t of r?.tips || []) {
  console.log(`  [tip] who=${JSON.stringify(t.who)} action=${JSON.stringify(t.action)} target=${JSON.stringify(t.target)} toMe=${t.toMe} hasIcon=${t.hasIcon} y=${t.y}`);
}
for (const m of r?.messages || []) {
  console.log(`  [msg] ${m.self ? '(我)' : ''}${m.who} | ${String(m.text || '').slice(0, 50)}`);
}

await cleanup();
process.exit(0);
