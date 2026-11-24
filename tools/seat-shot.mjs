/** 截一张 seat 的画面（看 QQ 现在长什么样）。 */

import { acquireLease, seatCmd, cleanup } from './anode-call.mjs';

await acquireLease(600);
const out = await seatCmd(['shot'], 90000);
console.log(String(out || '').trim());

await cleanup();
process.exit(0);
