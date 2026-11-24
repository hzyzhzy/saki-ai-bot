/** 看会话项名字到底取成了什么。 */

import { acquireLease, runPy, findQQHwnd, cleanup, parseLastJson } from './anode-call.mjs';

await acquireLease(600);
const found = await findQQHwnd();
const out = await runPy('qq-list-items.py', ['--hwnd', String(found.hwnd)], { timeoutMs: 120000 });
const j = parseLastJson(String(out || ''));
if (!j?.ok) {
  console.log(String(out).slice(-1200));
  await cleanup();
  process.exit(1);
}

console.log(`会话项 ${j.count} 个：`);
for (const it of j.items) {
  console.log(`  joined=${JSON.stringify(it.joined)}`);
  console.log(`    texts=${JSON.stringify(it.texts)}`);
}

await cleanup();
process.exit(0);
