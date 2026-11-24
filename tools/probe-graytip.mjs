/** 打印界面上所有灰字提示（gray-tip-message）的完整子树。 */

import { acquireLease, runPy, findQQHwnd, cleanup, parseLastJson } from './anode-call.mjs';

await acquireLease(600);
const found = await findQQHwnd();

const out = await runPy('qq-probe-graytip.py', ['--hwnd', String(found.hwnd)], { timeoutMs: 120000 });
const j = parseLastJson(String(out || ''));
if (!j) {
  console.log(String(out).slice(-2000));
  await cleanup();
  process.exit(1);
}

console.log(`会话：「${j.session}」  灰字提示 ${j.count} 个\n`);
for (const [i, t] of (j.tips || []).entries()) {
  console.log(`--- 提示 ${i + 1}  rect=${JSON.stringify(t.rect)}`);
  for (const p of t.parts) {
    console.log(
      `    d${String(p.depth).padStart(2)} ${p.cls.padEnd(50)} | ${String(p.name || '').slice(0, 60)}  rect=${JSON.stringify(p.rect)}`,
    );
  }
}

await cleanup();
process.exit(0);
