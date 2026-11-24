/** 给某个会话开独立聊天窗口，并用那个窗口读一次消息（验证 detached 这条路通不通）。 */

import { acquireLease, runPy, findQQHwnd, cleanup, parseLastJson } from './anode-call.mjs';

const argv = process.argv.slice(2);
const mi = argv.indexOf('--match');
const match = mi >= 0 ? argv[mi + 1] : '示例服务器 2026';

await acquireLease(600);
const found = await findQQHwnd();
console.log(`主窗口 hwnd=${found.hwnd}`);

const out = await runPy('qq-open-detached.py', ['--hwnd', String(found.hwnd), '--match', match], {
  timeoutMs: 180000,
});
const j = parseLastJson(String(out || ''));
if (!j?.ok) {
  console.log('开窗口失败：' + (j?.error || String(out).slice(-600)));
  await cleanup();
  process.exit(1);
}
console.log(`✅ 独立窗口 hwnd=${j.hwnd} 标题=${JSON.stringify(j.title)} 复用=${j.reused}`);

// 用那个 hwnd 读一次
const rd = await runPy('qq-read.py', ['--hwnd', String(j.hwnd), '--limit', '15'], { timeoutMs: 120000 });
const rj = parseLastJson(String(rd || ''));
if (!rj?.ok) {
  console.log('读独立窗口失败：' + (rj?.error || String(rd).slice(-600)));
  await cleanup();
  process.exit(1);
}
console.log(`\n读独立窗口：「${rj.group}」 ${rj.messages.length} 条消息 / ${(rj.tips || []).length} 条灰字`);
for (const m of rj.messages.slice(-6)) {
  console.log(`  ${m.self ? '(我)' : ''}${m.who} | ${String(m.text || '').slice(0, 40)}`);
}

await cleanup();
process.exit(0);
