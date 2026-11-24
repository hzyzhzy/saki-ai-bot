/** 直接测一次「切群 + 发文本」（走 qq-py.py，验证群名模糊匹配修好没有）。 */

import { acquireLease, runPy, findQQHwnd, cleanup } from './anode-call.mjs';

const group = process.argv[2] || 'Anon、谷雨、Saki';
const text = process.argv[3] || '切群匹配测试（可忽略）';

await acquireLease(600);
const found = await findQQHwnd();

const out = await runPy(
  'qq-py.py',
  ['send', '--hwnd', String(found.hwnd), '--group', group, '--text', text],
  { timeoutMs: 240000 },
);
console.log(String(out || '').trim().split('\n').slice(-12).join('\n'));

await cleanup();
process.exit(/发送成功/.test(String(out || '')) ? 0 : 1);
