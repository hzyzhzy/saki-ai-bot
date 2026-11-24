/** 在 seat 里跑 qq-probe-classes.py，看 QQ 消息区的「灰字提示」是什么 className。 */

import { acquireLease, runPy, findQQHwnd, cleanup, parseLastJson } from './anode-call.mjs';

await acquireLease(600);
const found = await findQQHwnd();
console.log(`hwnd=${found.hwnd} pid=${found.pid}`);

const out = await runPy('qq-probe-classes.py', ['--hwnd', String(found.hwnd)], { timeoutMs: 120000 });
const j = parseLastJson(String(out || ''));
if (!j) {
  console.log(String(out).slice(-2000));
  await cleanup();
  process.exit(1);
}

console.log(`\n会话：「${j.session}」  节点 ${j.nodes}`);
console.log('\n=== 带 container/tip/gray/notice 的节点 ===');
for (const h of j.hits) {
  console.log(`  d${String(h.depth).padStart(2)} ${h.cls.padEnd(60)} | ${h.name.slice(0, 60)}`);
}

await cleanup();
process.exit(0);
