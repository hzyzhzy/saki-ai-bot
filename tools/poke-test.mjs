/**
 * 戳一戳端到端验证（零打扰真人）：
 *   切到「Anon、谷雨、Saki」那个 4 人纯机器人测试群 → 读消息 → 挑一个头像 → 戳 → 读回界面看提示长什么样。
 *
 * 为什么在这个群：群里只有用户自己的几个机器人号，戳一下不打扰任何群友，
 * 而且能同时验证两件事：
 *   ① `qq-poke.py`（发）到底能不能点中菜单里的「戳一戳」；
 *   ② 界面上的戳一戳**提示行长什么样**（`qq-read.py` 要按它认，才能推成 OneBot 的 notice）。
 *
 *   node tools/poke-test.mjs                 → 只切换 + 读消息，不戳（看有哪些人可选）
 *   node tools/poke-test.mjs --to 谷雨        → 真戳
 */

import { acquireLease, runPy, findQQHwnd, cleanup, parseLastJson } from './anode-call.mjs';

const GROUP = "谷雨、Stby'Crs、Anon、Saki";
const argv = process.argv.slice(2);
const ti = argv.indexOf('--to');
const to = ti >= 0 ? argv[ti + 1] : '';

await acquireLease(600);
const found = await findQQHwnd();
const hwnd = String(found.hwnd);
console.log(`hwnd=${hwnd} pid=${found.pid}`);

// ① 切群
const sw = await runPy('qq-py.py', ['switch', '--hwnd', hwnd, '--group', GROUP], { timeoutMs: 120000 });
console.log('切换：' + String(sw || '').trim().split('\n').slice(-2).join(' | '));

// ② 读当前会话
const readOut = await runPy('qq-read.py', ['--hwnd', hwnd, '--limit', '30'], { timeoutMs: 120000 });
const r = parseLastJson(String(readOut || ''));
if (!r?.ok) {
  console.log('读消息失败：' + String(readOut).slice(-600));
  await cleanup();
  process.exit(1);
}
console.log(`\n当前会话：「${r.group}」  ${r.messages.length} 条`);
for (const m of r.messages) {
  console.log(`  [${m.kind || '?'}] ${m.self ? '(我)' : ''}${m.who} | ${String(m.text || '').slice(0, 50)}`);
}

if (!to) {
  console.log('\n（没给 --to，只做了切换和读取。给昵称才会真戳）');
  await cleanup();
  process.exit(0);
}

// ③ 戳
const pokeOut = await runPy('qq-poke.py', ['--hwnd', hwnd, '--to', to], { timeoutMs: 180000 });
const p = parseLastJson(String(pokeOut || ''));
console.log('\n=== 戳的结果 ===');
console.log(JSON.stringify(p, null, 2));

// ④ 戳完再读一遍：戳一戳的提示行应该出现在消息区
await new Promise((r) => setTimeout(r, 1500));
const after = await runPy('qq-read.py', ['--hwnd', hwnd, '--limit', '30'], { timeoutMs: 120000 });
const a = parseLastJson(String(after || ''));
console.log(`\n=== 戳完再读（${a?.messages?.length ?? 0} 条）===`);
for (const m of a?.messages || []) {
  const hit = /戳|拍|捏/.test(String(m.text || ''));
  console.log(`  ${hit ? '👉' : '  '} [${m.kind || '?'}] who=${JSON.stringify(m.who || '')} | ${String(m.text || '').slice(0, 60)}`);
}

await cleanup();
process.exit(0);
