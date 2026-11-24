/**
 * 把 seat 里 QQ 的当前会话切到某个群（或私聊会话）。
 *
 *   node tools/switch-group.mjs "湖工电影协会ACG同好群"
 *   node tools/switch-group.mjs --list          # 先看有哪些会话名
 */

import { acquireLease, runPy, findQQHwnd, cleanup, parseLastJson } from './anode-call.mjs';

const argv = process.argv.slice(2);
if (!argv.length || argv[0] === '--list') {
  await acquireLease(600);
  const found = await findQQHwnd();
  const out = await runPy('qq-sessions.py', ['--hwnd', String(found.hwnd)], { timeoutMs: 120000 });
  const j = parseLastJson(String(out || ''));
  for (const s of j?.all || []) console.log(`[${s.kind}] ${s.name}`);
  await cleanup();
  process.exit(0);
}

const target = argv.join(' ');
await acquireLease(600);
const found = await findQQHwnd();
const out = await runPy('qq-py.py', ['switch', '--hwnd', String(found.hwnd), '--group', target], {
  timeoutMs: 120000,
});
console.log(String(out || '').trim().split('\n').slice(-3).join('\n'));

// 读回来确认
const readOut = await runPy('qq-read.py', ['--hwnd', String(found.hwnd), '--limit', '5'], {
  timeoutMs: 120000,
});
const r = parseLastJson(String(readOut || ''));
console.log(`现在在：「${r?.group}」（${r?.messages?.length ?? 0} 条）`);

await cleanup();
process.exit(0);
