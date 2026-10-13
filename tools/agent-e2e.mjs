// 端到端自检：**不桩任何东西**，直接调 agent-bridge.handle()（假的 bot，不往群里发）
// 目的：① 真起 agenttask profile 的会话能不能跑通；
//       ② 会话有没有落盘 / 有没有进 GUI 的工作区索引（用户要的"显示在这里"）；
//       ③ 结果会不会被"她自己的口吻"重写（这次是真模型调用）。
import { readFileSync } from 'node:fs';

const ab = await import('../src/agent-bridge.js');
const { config } = await import('../src/config.js');

console.log('[e2e] enabled =', ab.enabled(), '| workspace =', ab.workspace());
console.log('[e2e] runner cfg =', JSON.stringify({ profile: config.agent?.profile, timeoutMs: config.agent?.timeoutMs }));

const sent = [];
const calls = [];
const bot = {
  selfId: String(config.botQQ),
  sendToGroup: async (gid, text, opts) => {
    sent.push({ text: String(text), at: opts?.at ?? '' });
    console.log(`[e2e] 她发了（群 ${gid}）：${String(text).slice(0, 200)}`);
  },
  // ⚠️ 产物发群走的是 `call('upload_group_file')` —— 这里只**打印**，真 bot 才真发
  call: async (action, params) => {
    calls.push({ action, params });
    console.log(`[e2e] call(${action}) ${JSON.stringify(params ?? {}).slice(0, 240)}`);
    return { status: 'ok' };
  },
};

const GROUP = '999000001'; // 假群号，**不会真的发出去**（bot 是桩）
const OWNER = String(config.ownerQQ);
const TASK = process.argv[2] ?? '帮我看看这个工作区里有哪些文件，用一句话说说它是干什么的';
const segs = [{ type: 'text', data: { text: TASK } }];
const ev = {
  message_type: 'group',
  group_id: GROUP,
  user_id: OWNER,
  self_id: String(config.botQQ),
  message: segs,
  sender: { user_id: OWNER, nickname: '<主人>', card: '<主人>' },
};

ab.__reset();
const handled = await ab.handle(ev, segs, bot);
console.log('[e2e] handled =', handled);
console.log('[e2e] 等她跑完（最多 4 分钟）…');

// 盯着 state.running 消失
const t0 = Date.now();
let sid = '';
while (Date.now() - t0 < 240000) {
  const s = ab.__state();
  if (s.running?.sessionId) sid = s.running.sessionId;
  if (!s.running) break;
  await new Promise((r) => setTimeout(r, 3000));
}
const st = ab.__state();
// ⚠️ `running` 清空**不等于**这件事完了 —— 结果那句、还有产物发文件都在它之后（
//    我第一版就在这里提前打印，看着像"没发结果、没发文件" ✗）⇒ 多等 8 秒再收尾
await new Promise((r) => setTimeout(r, 8000));
console.log('[e2e] sessionId =', sid, '| 还挂着吗 =', !!st.running);
console.log('[e2e] 收到她说的条数 =', sent.length);
for (const s of sent) console.log('   -', s.text.slice(0, 160));

// ② 会话落盘 / GUI 索引
const home = 'C:\\Users\\<主人>\\AppData\\Local\\DeepSeekHarness\\.dsh';
try {
  const ws = JSON.parse(readFileSync(`${home}\\storages\\workspace.json`, 'utf8'));
  const hit = Object.values(ws.tables?.workspaces ?? {}).find((w) => /agentwork/i.test(String(w.path ?? '')));
  console.log('[e2e] GUI 工作区索引里有 agentwork 吗 =', !!hit, hit ? `（${hit.sessionIds?.length} 个会话，含本次=${hit.sessionIds?.includes(sid)}）` : '');
} catch (e) {
  console.log('[e2e] 读 workspace.json 失败：', e.message);
}
// ③ 产物发群（这次只会打印 —— 真发由机器人进程做）
console.log('[e2e] upload 调用次数 =', calls.length);
for (const c of calls) console.log('   -', c.action, c.params?.name ?? '');
process.exit(0);

