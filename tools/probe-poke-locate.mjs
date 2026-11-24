/** 看戳一戳定位到底选的是哪一条消息的头像。 */

import { acquireLease, runPy, findQQHwnd, cleanup, parseLastJson } from './anode-call.mjs';

await acquireLease(600);
const found = await findQQHwnd();
const out = await runPy('qq-probe-poke-locate.py', ['--hwnd', String(found.hwnd)], { timeoutMs: 120000 });
const j = parseLastJson(String(out || ''));
if (!j) {
  console.log(String(out).slice(-1500));
  await cleanup();
  process.exit(1);
}

console.log('窗口:', JSON.stringify(j.window));
console.log('\nmessage-panel:');
for (const p of j.panels || []) console.log('  ', p.cls, JSON.stringify(p.rect));

console.log(`\n谷雨的消息 ${j.cands.length} 条:`);
for (const c of j.cands) {
  const ar = c.avatar_rect;
  const center = ar ? [(ar[0] + ar[2]) >> 1, (ar[1] + ar[3]) >> 1] : null;
  console.log(`  box=${JSON.stringify(c.box_rect)} avatar=${JSON.stringify(ar)} 中心=${JSON.stringify(center)} cls=${c.avatar_cls}`);
}

await cleanup();
process.exit(0);
