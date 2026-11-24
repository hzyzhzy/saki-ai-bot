/** 列出客户端会话列表里的所有名字（群 + 私聊），用来对群名。 */

import { acquireLease, runPy, findQQHwnd, cleanup, parseLastJson } from './anode-call.mjs';

await acquireLease(600);
const found = await findQQHwnd();

const out = await runPy('qq-sessions.py', ['--hwnd', String(found.hwnd)], { timeoutMs: 120000 });
const j = parseLastJson(String(out || ''));
if (!j?.ok) {
  console.log(String(out).slice(-1200));
  await cleanup();
  process.exit(1);
}

console.log(`共 ${j.total} 个会话：群 ${j.groups} / 私聊 ${j.privates} / 未知 ${j.unknown}\n`);
for (const s of j.all || []) {
  console.log(
    `  [${s.kind}] ${JSON.stringify(s.name)}  成员=${s.memberCount ?? '-'} 未读=${s.unread ?? 0}  ${s.summary ? '| ' + String(s.summary).slice(0, 30) : ''}`,
  );
}

await cleanup();
process.exit(0);
