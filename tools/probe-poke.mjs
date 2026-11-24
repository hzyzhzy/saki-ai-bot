/**
 * 只读探测：seat 里 QQ 当前会话是什么、最近有没有「戳一戳」那种系统行。
 *
 * 跑法：node tools/probe-poke.mjs [--group 群名]
 * 不切会话、不发消息 —— 只读当前打开的会话。
 */

import { acquireLease, runPy, findQQHwnd, cleanup } from './anode-call.mjs';

const argv = process.argv.slice(2);
const gi = argv.indexOf('--group');
const groupHint = gi >= 0 ? argv[gi + 1] : '';

await acquireLease(600);
console.log('lease ok');

const found = await findQQHwnd();
console.log(`hwnd=${found.hwnd} pid=${found.pid} 节点=${found.nodes} 有会话列表=${found.hasItems}`);

const args = ['--hwnd', String(found.hwnd), '--limit', '40'];
if (groupHint) args.push('--group', groupHint);

const out = await runPy('qq-read.py', args, { timeoutMs: 120000 });
const j = out && typeof out === 'object' ? out : null;

if (!j) {
  console.log('读出来不是 JSON，原始输出：');
  console.log(String(out).slice(-1500));
  await cleanup();
  process.exit(1);
}

console.log(`\n当前会话：「${j.group}」 消息 ${(j.messages || []).length} 条\n`);
for (const m of j.messages || []) {
  console.log(
    `  [${m.kind || '?'}] who=${JSON.stringify(m.who || '')} self=${m.self ? 'Y' : 'n'} text=${JSON.stringify(String(m.text || '').slice(0, 60))}`,
  );
}

console.log('\n=== 被判成 system 的那些（戳一戳通常在这里）===');
const sys = (j.messages || []).filter((m) => m.kind === 'system');
if (!sys.length) console.log('  （这一屏没有 system 行）');
for (const m of sys) {
  console.log(`  text=${JSON.stringify(String(m.text || '').slice(0, 100))}`);
}

await cleanup();
process.exit(0);
