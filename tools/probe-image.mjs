/** 看界面上的图片元素能拿到什么（Name / fileid / 屏幕矩形）。 */

import { acquireLease, runPy, findQQHwnd, cleanup, parseLastJson } from './anode-call.mjs';

await acquireLease(600);
const found = await findQQHwnd();
const out = await runPy('qq-probe-image.py', ['--hwnd', String(found.hwnd)], { timeoutMs: 120000 });
const j = parseLastJson(String(out || ''));
if (!j?.ok) {
  console.log(String(out).slice(-1500));
  await cleanup();
  process.exit(1);
}

console.log(`会话：「${j.session}」  图片元素 ${j.count} 个\n`);
for (const im of j.images) {
  console.log(`  cls=${im.cls}`);
  console.log(`    name=${JSON.stringify(im.name)} type=${im.type}`);
  console.log(`    help=${JSON.stringify(im.help)}`);
  console.log(`    rect=${JSON.stringify(im.rect)}`);
}

await cleanup();
process.exit(0);
