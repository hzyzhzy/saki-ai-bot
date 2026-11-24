/** 列 seat 里的所有窗口（看独立聊天窗口有没有开出来）。 */

import { acquireLease, seatCmd, cleanup } from './anode-call.mjs';

await acquireLease(600);
const out = await seatCmd(['windows'], 60000);
console.log(String(out || '').trim());

await cleanup();
process.exit(0);
