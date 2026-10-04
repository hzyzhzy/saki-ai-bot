/**
 * 「说完一句又想补充」—— 机器人自己接自己（2026-09-13 用户要求）。
 *
 * 用户原话：「在机器人回复一条消息之后**不用暂停 llm**，可以加个判定，
 *   如果机器人说完这句话之后**还想补充**，可以继续生成并接着发送，
 *   这样就更接近真人了。但是**不能每次都发补充消息，要和真人一样自然**，
 *   然后**限制最多自己接自己五条消息**」
 *
 * ## 这个套件分两半
 *
 * 【A】离线单测（纯函数，不调模型、不起进程）—— 快、稳、能穷举边界。
 * 【B】端到端接线（假模型 + 假 NapCat + 真起 `src/index.js`）——
 *      证明**接线真的通了**：正文发完之后确实会追补，而且**是分开的两条**。
 *
 * ⚠️ 为什么非要【B】：这个功能的坑**不在算法上，在接线上** ——
 *    "算得对但没接进主流程"是我在这个项目里反复犯的错
 *    （`monthly-report` 写好了没起定时器、`balance` 提醒写好了没接发送路径）。
 *    单测全绿但线上没反应，所以必须有一条真进程的验证。
 *
 * ⚠️ 两半用**两个不同的临时配置文件**（`__A.yml` / `__B.yml`）——
 *    第一版写成同一个文件，结果【A】先写了一份指向 `127.0.0.1:1` 的配置，
 *    【B】再覆盖时 `config.js` 已经是模块级缓存了（改文件没用），
 *    而**子进程比覆盖写更早启动**，于是它读到的是【A】那份 —— 全盘皆错。
 *
 * 用法: node test/follow-up.js
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
// ⚠️ 用**独立的端口区间** —— `run-all.js` 是并行跑所有套件的，
//    撞端口会让两个套件同时挂（而且看起来像代码 bug）。已占用：
//    e2e 39001-39002 / cs 39101-39104 / teach 39501-39502 /
//    face 39601-39602 / webui 39701 / attitude 39801-39802 /
//    behavior 40001-40002 / natural-teach 40101-40102
const LLM_PORT = 40201;
const WS_PORT = 40202;

const TOKEN = 'test-token';
const SELF_ID = '10001';
const GROUP_ID = '20002';
const USER_ID = '30003';

const MAIN_REPLY = '这条是正文，已经发出去了。';
const ADD_ONE = '啊对了，还有件事。';
const ADD_TWO = '等一下，我再补一句。';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ⚠️ `QQBOT_CONFIG` 必须是**相对项目根目录**的路径 ——
//    `config.js` 里是 `join(ROOT, process.env.QQBOT_CONFIG)`，
//    给绝对路径会拼成一个不存在的路径（第一版就踩了：
//    `…\qq-ai-bot\C:\Users\…\Temp\qqbot-followup-xxx\a.yml`）。
//    所以写在 `logs/` 下（那个目录已经在，而且不会进版本库）。
const TMP = join(ROOT, 'logs');
const CFG_A_REL = 'logs/__test-followup-a.yml';
const CFG_B_REL = 'logs/__test-followup-b.yml';
const CFG_A = join(ROOT, CFG_A_REL);
const CFG_B = join(ROOT, CFG_B_REL);
mkdirSync(TMP, { recursive: true });

// ⚠️ 必须**在** import `src/*` 之前设好配置路径 —— `config.js` 是
//    模块加载时就 `load()` 的（就是 `$env:QQBOT_CONFIG` 那个坑）。
//    【A】只验纯判定，所以随便指向一个连不上的地址就行（它不该发请求）。
writeFileSync(
  CFG_A,
  [
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
    '  apiKey: "sk-test"',
    '  model: test-model',
    'selfFollowUp:',
    '  enable: true',
    '  probability: 0.35',
    '  maxPerReply: 5',
    '  continueProbability: 0.5',
    '  betweenMs: [400, 1200]',
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_A_REL;

// ════════════════════════════════════════════════════════════
// 【A】离线单测
// ════════════════════════════════════════════════════════════
console.log('\n【A】离线判定（不调模型）');

const fu = await import('../src/follow-up.js');

{
  // ── 概率闸 ────────────────────────────────────────────
  let hit = 0;
  for (let i = 0; i < 200; i++) if (fu.shouldConsider(i / 200)) hit++;
  check(hit === 70, `概率闸按 0.35 卡（200 次里放行 ${hit} 次，期望 70）`);
  check(fu.shouldConsider(0) === true, '随机数 0 → 放行');
  check(fu.shouldConsider(0.999) === false, '随机数 0.999 → 不放行');
  check(fu.shouldConsider(0.34) === true, '刚好在门内 → 放行');
  check(fu.shouldConsider(0.36) === false, '刚好在门外 → 拦截');
}

{
  // ── 问句结尾不追补 ────────────────────────────────────
  // ⚠️ 这条很重要：刚问完人就自问自答，非常假。
  for (const t of ['要不要试试？', '你玩吗?', '行不行 ？', '几点啊？']) {
    check(fu.endsWithQuestion(t), `「${t}」判为问句 → 不追补`);
  }
  for (const t of ['那就这样吧。', '我看看', '行。', '不过嘛……', '是啊']) {
    check(!fu.endsWithQuestion(t), `「${t}」不是问句 → 可追补`);
  }
  check(!fu.endsWithQuestion(''), '空文本不算问句');
}

{
  // ── 上限与续补概率 ────────────────────────────────────
  check(fu.MAX_PER_REPLY === 5, '默认上限 = 5（用户指定「最多自己接自己五条」）');
  check(fu.CONTINUE_P > 0 && fu.CONTINUE_P < 1, `续补概率在开区间内（${fu.CONTINUE_P}）`);

  // ⚠️ 第 1 条**必须**放行（它已经过了概率闸），后面按 continueProbability 掷。
  //    第一版把这道随机写死在 bot.js 里直接调 `Math.random()`，
  //    结果回归里"上限"那组断言全靠运气 —— 挂了 3 项，正是踩在这里。
  fu.__setRandom(() => 0.999); // 永远落在门外
  check(fu.shouldContinue(0) === true, '第 1 条追补：不掷随机，直接放行');
  check(fu.shouldContinue(1) === false, '第 2 条：随机在门外 → 不再补');
  check(fu.shouldContinue(4) === false, '第 5 条：同理');
  fu.__setRandom(() => 0); // 永远落在门内
  check(fu.shouldContinue(1) === true, '第 2 条：随机在门内 → 继续补');
  check(fu.shouldContinue(9) === true, '第 10 条：同理（上限由 maxPerReply 管，不归它管）');
  fu.__setRandom();
}

{
  // ── 该发出去的请求才发 ────────────────────────────────
  // 空正文 / 问句结尾都要**直接返回空**，一次模型调用都不该花。
  check((await fu.askFollowUp({ replied: '' })) === '', '正文为空 → 返回空（不发请求）');
  check(
    (await fu.askFollowUp({ replied: '这样就行吗？' })) === '',
    '正文以问句结尾 → 返回空（**没调模型**，否则会等超时）',
  );
}

{
  // ── status() 给管理界面用 ─────────────────────────────
  const s = fu.status();
  check(s.enable === true && s.maxPerReply === 5, `status() 反映配置：${JSON.stringify(s)}`);
}

{
  // ── 关掉开关就彻底不工作 ──────────────────────────────
  // ⚠️ 用 `__setRandom` 固定随机源 —— 这条链上有两道随机，
  //    不固定住的话自动化测试就是 flaky 的，而"偶发失败"比没测试更糟。
  fu.__setRandom(() => 0); // 永远落在概率闸内
  check(fu.shouldConsider() === true, '随机源=0 时概率闸必放行');
  fu.__setRandom(() => 0.999);
  check(fu.shouldConsider() === false, '随机源=0.999 时概率闸必拦截');
  fu.__setRandom();
}

// ════════════════════════════════════════════════════════════
// 【B】端到端接线（假模型 + 假 NapCat + 真起机器人）
// ════════════════════════════════════════════════════════════

const llmCalls = [];

const isFollowUpCall = (c) =>
  (c.messages?.find((m) => m.role === 'system')?.content ?? '').includes('想补充的冲动');

/**
 * 假模型：必须**认得追补那次的请求**并给出固定的补充话。
 *
 * ⚠️ 追补走的系统提示词里有「想补充的冲动」，这是**唯一**能把它和主回复
 *    区分开的字样（主回复走 `buildSystemPrompt`）。认错的话追补请求会被
 *    当成正文 → 返回 `MAIN_REPLY` → 测试看起来"追补了"，其实补的是正文，
 *    等于什么都没验到。
 */
const llmServer = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {}
    llmCalls.push(parsed);
    const sys = parsed.messages?.find((m) => m.role === 'system')?.content ?? '';
    const sse = (text) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    };
    const json = (text) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }));
    };

    // ① 预搜索 / 搜索规划：一律"不用搜"（要 SSE）
    if (sys.includes('要不要上网查')) return sse('{"search":false,"why":"测试不搜"}');
    if (sys.includes('该搜什么')) return sse('测试关键词');
    // ② 说话判断 / 归属核对（要 JSON）
    if (sys.includes('假装成真人群友')) return json('{"speak":true,"why":"测试","length":"short"}');
    if (sys.includes('【归属核对】')) return json('{"ok":true}');
    // ③ 追补判断：非流式 JSON，第一次问给 ADD_ONE、第二次给 ADD_TWO
    if (isFollowUpCall(parsed)) {
      const idx = llmCalls.filter(isFollowUpCall).length;
      return json(idx === 1 ? ADD_ONE : ADD_TWO);
    }
    // ④ 正文（流式）
    sse(MAIN_REPLY);
  });
});

const received = [];
let botSocket = null;
let connected = false;

const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });
wss.on('connection', (ws, req) => {
  if ((req.headers.authorization ?? '') !== `Bearer ${TOKEN}`) {
    check(false, `鉴权头不正确: "${req.headers.authorization}"`);
    ws.close(1008);
    return;
  }
  connected = true;
  botSocket = ws;
  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    received.push(m);
    if (m.echo !== undefined) {
      ws.send(
        JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 900 + received.length }, echo: m.echo }),
      );
    }
  });
  ws.on('close', () => (connected = false));
  ws.send(
    JSON.stringify({
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
      sub_type: 'connect',
      self_id: SELF_ID,
      time: Math.floor(Date.now() / 1000),
    }),
  );
});

/** 机器人实际发到群里的**每条文本**（保持顺序，一条一个元素） */
const sentList = () =>
  received
    .filter((m) => m.action === 'send_group_msg')
    .map((m) => (Array.isArray(m.params?.message) ? m.params.message : []))
    .map((segs) => segs.filter((s) => s.type === 'text').map((s) => s.data.text).join(''));

function pushGroupMessage(text, messageId = 5001) {
  botSocket.send(
    JSON.stringify({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: messageId,
      group_id: GROUP_ID,
      user_id: USER_ID,
      self_id: SELF_ID,
      raw_message: `[CQ:at,qq=${SELF_ID}] ${text}`,
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: USER_ID, nickname: '测试用户', role: 'member' },
      message: [
        { type: 'at', data: { qq: SELF_ID } },
        { type: 'text', data: { text: ` ${text}` } },
      ],
    }),
  );
}

async function waitFor(fn, timeout = 15000, label = '条件') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return true;
    await sleep(100);
  }
  console.log(`  ⏱  等待「${label}」超时（${timeout}ms）`);
  return false;
}

let bot = null;

async function partB() {
  console.log('\n【B】端到端接线（真起机器人进程）');

  // ⚠️ 必须先写好配置，**再**起子进程。
  //    `probability: 1` + `continueProbability: 1` —— 【B】要验的是**接线和上限**，
  //    概率闸在【A】里穷举过了；留随机的话这里就是 flaky 的。
  //    `maxPerReply: 2` 让"上限"这条能在几秒内验完
  //    （真跑满 5 条要多等 4 次模型调用 + 4 段间隔）。
  writeFileSync(
    CFG_B,
    [
      'onebot:',
      '  mode: forward',
      `  url: ws://127.0.0.1:${WS_PORT}`,
      `  accessToken: "${TOKEN}"`,
      '  reconnectInterval: 300',
      'llm:',
      `  baseURL: http://127.0.0.1:${LLM_PORT}/v1`,
      '  apiKey: "sk-test-fake-key"',
      '  model: test-model',
      '  maxTokens: 100',
      '  timeout: 10000',
      'trigger:',
      '  privateChat: false',
      '  groupChat: true',
      '  requireAtInGroup: true',
      '  historyRounds: 2',
      '  cooldownMs: 0',
      'logLevel: info',
      'webui:',
      '  enable: false',
      '  port: 3108',
      'chat:',
      '  enable: false',
      'context:',
      '  enable: true',
      '  maxMessages: 30',
      '  maxChars: 2000',
      'selfFollowUp:',
      '  enable: true',
      '  probability: 1',
      '  maxPerReply: 2',
      '  continueProbability: 1',
      '  betweenMs: [50, 120]',
      '',
    ].join('\n'),
    'utf8',
  );

  bot = spawn(process.execPath, [join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      QQBOT_CONFIG: CFG_B_REL,
      NO_PROXY: '127.0.0.1,localhost,::1',
      no_proxy: '127.0.0.1,localhost,::1',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  const ok = await waitFor(() => connected, 15000, 'WebSocket 连接');
  check(ok, '机器人连上假 NapCat');
  if (!ok) return;

  pushGroupMessage('你好啊');

  // ── ① 正文 ────────────────────────────────────────────
  const gotMain = await waitFor(() => sentList().some((t) => t.includes('这条是正文')), 15000, '正文');
  check(gotMain, '正文发出去了');

  // ── ② 追补 ────────────────────────────────────────────
  const gotAdd = await waitFor(() => sentList().some((t) => t.includes(ADD_ONE)), 15000, '追补');
  check(gotAdd, '★ 正文之后**又追补了一句**');

  // ── ③ ⚠️ 关键：正文和追补必须是**两条独立的消息** ────────
  //
  // 并成一条的话，"先把话说出来，然后想起来再补一句"这个拟人效果
  // 就完全没了（用户 2026-09-13 为"过渡话被并进正文"专门纠正过一次，
  // 是同一类问题）。
  const list = sentList();
  const iMain = list.findIndex((t) => t.includes('这条是正文'));
  const iAdd = list.findIndex((t) => t.includes(ADD_ONE));
  check(iMain >= 0 && iAdd >= 0, '正文和追补都能定位到');
  check(iAdd > iMain, `追补排在正文**之后**（正文 #${iMain}，追补 #${iAdd}）`);
  check(
    !list.some((t) => t.includes('这条是正文') && t.includes(ADD_ONE)),
    '正文和追补**没有并成同一条消息**',
  );

  // ── ④ 上限：maxPerReply=2，模型一直肯补也不能超过 2 条 ──
  const gotAdd2 = await waitFor(() => sentList().some((t) => t.includes(ADD_TWO)), 15000, '第二条追补');
  check(gotAdd2, '第二条追补也发了（没被"只补一条"卡死）');
  await sleep(2500);
  const addCount = sentList().filter((t) => t.includes(ADD_ONE) || t.includes(ADD_TWO)).length;
  check(addCount === 2, `追补**卡在上限 2 条**（实际 ${addCount} 条）`);
  check(
    llmCalls.filter(isFollowUpCall).length === 2,
    `追补判断只问了 ${llmCalls.filter(isFollowUpCall).length} 次（上限到了就不再问）`,
  );

  // ── ⑤ 追补是纯文本、**不带引用** ──────────────────────
  //
  // ⚠️ 追补如果每条都引用自己，群里会是一串引用框，比不补还难看。
  const addMsgs = received.filter(
    (m) =>
      m.action === 'send_group_msg' &&
      Array.isArray(m.params?.message) &&
      m.params.message.some((s) => s.type === 'text' && (s.data.text ?? '').includes(ADD_ONE)),
  );
  check(addMsgs.length > 0, '能找到追补那条的原始调用');
  check(
    addMsgs.every((m) => !m.params.message.some((s) => s.type === 'reply')),
    '追补**不引用**任何消息（直接发出去）',
  );

  // ── ⑥ 追补请求本身走非流式小调用 ──────────────────────
  const fuCalls = llmCalls.filter(isFollowUpCall);
  check(fuCalls.length >= 1, `追补判断确实问了模型（${fuCalls.length} 次）`);
  check(fuCalls.every((c) => c.stream !== true), '追补判断走非流式（不占正文的流）');
  check(
    fuCalls.every((c) => Number(c.max_tokens) <= 200),
    `追补请求是小调用（max_tokens=${fuCalls[0]?.max_tokens}）`,
  );

  // ⚠️ 追补的提示词里**不能**混进报账那套铁律 —— 那是 `phraseMoney` 的东西，
  //    套在"要不要补一句"上完全不搭（第一版我就用错了）。
  const fuSys = fuCalls[0]?.messages?.find((m) => m.role === 'system')?.content ?? '';
  check(!fuSys.includes('净赚') && !fuSys.includes('工资'), '追补提示词没混进报账那套规矩');
  check(fuSys.includes('无'), '追补提示词明确给了「无」这个出口');
}

async function cleanup() {
  try {
    bot?.kill();
  } catch {}
  try {
    botSocket?.close();
  } catch {}
  await new Promise((r) => wss.close(r));
  await new Promise((r) => llmServer.close(r));
  try {
    rmSync(CFG_A, { force: true });
    rmSync(CFG_B, { force: true });
  } catch {}
}

async function main() {
  await new Promise((r) => llmServer.listen(LLM_PORT, '127.0.0.1', r));
  await new Promise((r) => (wss._server.listening ? r() : wss.once('listening', r)));
  await partB();
}

main()
  .catch((e) => {
    console.error('\n测试脚本自身出错:', e);
    failures++;
  })
  .finally(async () => {
    await cleanup();
    console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
    process.exit(failures === 0 ? 0 : 1);
  });
