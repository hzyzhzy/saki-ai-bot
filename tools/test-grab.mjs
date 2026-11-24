/** 验证「裁屏」这条链路在 seat 里能不能用（截一块区域存 PNG）。 */

import { acquireLease, runPy, findQQHwnd, cleanup, parseLastJson } from './anode-call.mjs';

await acquireLease(600);
const found = await findQQHwnd();

const out = await runPy(
  'qq-grab-image.py',
  ['--l', '500', '--t', '200', '--r', '760', '--b', '420', '--out', 'C:\\Temp\\qq-grab-test.png'],
  { timeoutMs: 60000 },
);
const j = parseLastJson(String(out || ''));
console.log(JSON.stringify(j, null, 2));

await cleanup();
process.exit(j?.ok ? 0 : 1);
