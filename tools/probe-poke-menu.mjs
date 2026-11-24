/**
 * 在 seat 里跑 qq-poke.py。
 *
 *   node tools/probe-poke-menu.mjs                → 只打开头像右键菜单，把项名列出来（不点）
 *   node tools/probe-poke-menu.mjs --to 昵称       → 真戳（会打扰对方，验证一次就够）
 */

import { acquireLease, runPy, findQQHwnd, cleanup, parseLastJson } from './anode-call.mjs';

const argv = process.argv.slice(2);
const ti = argv.indexOf('--to');
const to = ti >= 0 ? argv[ti + 1] : '';

await acquireLease(600);
const found = await findQQHwnd();
console.log(`hwnd=${found.hwnd} pid=${found.pid}`);

const args = ['--hwnd', String(found.hwnd)];
if (to) args.push('--to', to);
else args.push('--probe');

const out = await runPy('qq-poke.py', args, { timeoutMs: 180000 });
const j = parseLastJson(String(out || ''));
if (!j) {
  console.log('原始输出：');
  console.log(String(out).slice(-2500));
  await cleanup();
  process.exit(1);
}

console.log(`\n会话：「${j.session}」  模式=${j.mode}  头像=${JSON.stringify(j.avatar_at)}`);
if (j.error) console.log('错误：' + j.error);
if (j.menu_items) {
  console.log('\n右键菜单项：');
  for (const n of j.menu_items) console.log('   - ' + n);
  console.log(`\n${j.menu_items.includes('戳一戳') ? '✅ 菜单里有「戳一戳」' : '❌ 菜单里没有「戳一戳」'}`);
}
if (j.mode === 'send') {
  console.log(`\n目标：${j.to}`);
  console.log(`点击方式：${JSON.stringify(j.tries)}`);
  console.log(`界面提示：${j.hint ? JSON.stringify(j.hint) : '（没看到「戳了戳」字样）'}`);
}

await cleanup();
process.exit(0);
