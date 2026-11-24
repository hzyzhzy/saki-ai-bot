/** 右键会话项，看菜单里有没有「打开独立聊天窗口」。 */

import { acquireLease, runPy, findQQHwnd, cleanup, parseLastJson } from './anode-call.mjs';

const argv = process.argv.slice(2);
const mi = argv.indexOf('--match');
const match = mi >= 0 ? argv[mi + 1] : '示例服务器';

await acquireLease(600);
const found = await findQQHwnd();
const out = await runPy('qq-probe-session-menu.py', ['--hwnd', String(found.hwnd), '--match', match], {
  timeoutMs: 120000,
});
const j = parseLastJson(String(out || ''));
if (!j?.ok) {
  console.log(String(out).slice(-1200));
  await cleanup();
  process.exit(1);
}

console.log(`会话项：${JSON.stringify(j.item)}`);
console.log(`\n菜单项（${j.menu_items.length} 个）：`);
for (const n of j.menu_items) console.log('  - ' + n);
console.log(`\n${j.has_detached ? '✅ 有「打开独立聊天窗口」' : '❌ 没有「打开独立聊天窗口」'}`);
if (j.new_windows?.length) console.log('新窗口：' + JSON.stringify(j.new_windows));

await cleanup();
process.exit(0);
