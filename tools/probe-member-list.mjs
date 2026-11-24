/** 看群成员列表里目标昵称在哪些元素上、坐标是多少。 */

import { acquireLease, runPy, findQQHwnd, cleanup, parseLastJson } from './anode-call.mjs';

const argv = process.argv.slice(2);
const wi = argv.indexOf('--want');
const want = wi >= 0 ? argv[wi + 1] : '谷雨';

await acquireLease(600);
const found = await findQQHwnd();
const out = await runPy('qq-probe-member-list.py', ['--hwnd', String(found.hwnd), '--want', want], {
  timeoutMs: 120000,
});
const j = parseLastJson(String(out || ''));
if (!j) {
  console.log(String(out).slice(-1500));
  await cleanup();
  process.exit(1);
}

console.log(`=== 名字等于「${want}」的元素 ===`);
for (const t of j.target || []) console.log(`  d${t.depth} ${t.cls.padEnd(50)} rect=${JSON.stringify(t.rect)}`);

console.log('\n=== 带 member 的节点（前 25 个）===');
for (const m of (j.members || []).slice(0, 25)) {
  console.log(`  d${m.depth} ${m.cls.padEnd(50)} | ${m.name}  rect=${JSON.stringify(m.rect)}`);
}

await cleanup();
process.exit(0);
