/**
 * 端到端冒烟测试：不需要真实的 QQ 和 API Key。
 *   - 起一个假的「大模型服务」，按 SSE 流式返回固定文本
 *   - 起一个假的「NapCat」，接收机器人的连接并推送一条群消息
 *   - 真实启动 src/index.js（子进程），验证它回的消息内容正确
 *
 * 用法: node test/e2e.js
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const LLM_PORT = 39002;
const WS_PORT = 39001;
const TOKEN = 'test-token';
const SELF_ID = '10001';
const GROUP_ID = '20002';
const USER_ID = '30003';

const REPLY_ZH = '这是一条来自假模型的测试回复。';
const REPLY_EN = 'Hello from the fake model.';

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. 假的 OpenAI 兼容流式接口 ───────────────────────
const llmCalls = [];
const llmServer = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {}
    llmCalls.push({ auth: req.headers.authorization, body: parsed });

    // 按最后一条用户消息决定回中文还是英文，方便断言
    const last = [...(parsed.messages ?? [])].reverse().find((m) => m.role === 'user');
    const reply = /english|英文/i.test(last?.content ?? '') ? REPLY_EN : REPLY_ZH;

    const sysOf = parsed.messages?.find((m) => m.role === 'system')?.content ?? '';

    // ⚠️⚠️ 这里有两个**开头几乎一样**的提示词，必须用**准确字样**区分（2026-09-13 踩）：
    //    · 预搜索（`search-presearch.js`）：`…决定：**这句话要不要上网查，查什么。**`
    //    · 搜索规划（`search-plan.js`）  ：`…决定「这句话该搜什么」。`
    //    我第一版用 `/上网查|该搜什么/` 一起匹配 —— 结果**规划请求也被回了
    //    `{"search":false}`**（那是预搜索的答案格式），规划解析不出来
    //    → 回复变空 → 机器人发了兜底话「咦，我这会儿有点卡壳」
    //    → e2e 报「群消息得到回复」失败 + 收到的是那句兜底。
    //
    //    而且**预搜索走的是 `collect(streamChat(...))`，要 SSE 不要 JSON** ——
    //    回 JSON 它解析不出 `{...}`，会**退回规则 → 真去联网搜**（老 bug，
    //    以前搜索快所以看不出来，加了 B站/萌娘百科两个引擎之后就超时了）。
    if (sysOf.includes('要不要上网查')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: '{"search":false,"why":"测试不搜"}' } }] })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    // 搜索规划：要**一句话关键词**（也得是 SSE）
    if (sysOf.includes('该搜什么')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '测试关键词' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // ⚠️ 2026-09-13 加：「归属核对」请求也要认得出来。
    //    原来假模型不认识它 → 每条消息都要等满 8 秒超时 → 回归很慢。
    //    （用户反馈「跑回归时间太长了，是不是有什么 bug」——
    //     没 bug，是白等超时；假模型认得它就能立刻回。）
    if (sysOf.includes('【归属核对】')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }] }));
      return;
    }

    // ⚠️ 「该不该说」判断请求（system 里含「假装成真人群友」）——
    //    它要的是 **JSON**，不是 SSE。不认识它的话会回 SSE → 判断解析失败
    //    → 默认「不说」→ 机器人整个哑掉（真实踩过）。统一回「说」。
    if (sysOf.includes('假装成真人群友')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '{"speak":true,"why":"测试","length":"short"}' } }],
        }),
      );
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const chunks = reply.match(/.{1,6}/gs) ?? [reply];
    for (const piece of chunks) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

// ── 2. 假的 NapCat（WS 服务端） ───────────────────────
const received = []; // 机器人发回来的 API 调用
let botSocket = null;
let connected = false;

const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });

wss.on('connection', (ws, req) => {
  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${TOKEN}`) {
    check(false, `鉴权头不正确: "${auth}"`);
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
    // 所有 API 调用都回成功，否则机器人会一直等超时
    if (m.echo !== undefined) {
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 900 + received.length }, echo: m.echo }));
    }
  });

  ws.on('close', () => {
    connected = false;
  });

  // 推送一个 lifecycle，让机器人知道自己的 QQ 号
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

/** 推一条**没 @ 它**的群消息（`/好感度` 那类命令要用这个形态） */
function pushGroupMessageNoAt(text, messageId = 5001) {
  botSocket.send(
    JSON.stringify({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: messageId,
      group_id: GROUP_ID,
      user_id: USER_ID,
      self_id: SELF_ID,
      raw_message: text,
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: USER_ID, nickname: '测试用户', role: 'member' },
      message: [{ type: 'text', data: { text } }],
    }),
  );
}

/** 等某个条件成立，或超时 */
async function waitFor(fn, timeout = 12000, label = '条件') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return true;
    await sleep(100);
  }
  console.log(`  ⏱  等待「${label}」超时（${timeout}ms）`);
  return false;
}

const sentTexts = () =>
  received
    .filter((m) => m.action === 'send_group_msg' || m.action === 'send_private_msg')
    .map((m) => (Array.isArray(m.params?.message) ? m.params.message : []))
    .map((segs) => segs.filter((s) => s.type === 'text').map((s) => s.data.text).join(''))
    .join('|');

// ── 3. 跑测试 ─────────────────────────────────────────
let bot = null;

async function main() {
  await new Promise((r) => llmServer.listen(LLM_PORT, '127.0.0.1', r));
  await new Promise((r) => (wss._server.listening ? r() : wss.once('listening', r)));
  console.log(`\n假模型服务: http://127.0.0.1:${LLM_PORT}/v1`);
  console.log(`假 NapCat : ws://127.0.0.1:${WS_PORT}\n`);

  console.log('[1] 启动机器人子进程');
  // stdio 交给父进程用的管道，这里设为 ignore 以免和测试输出互相干扰
  bot = spawn(process.execPath, [join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      QQBOT_CONFIG: 'config.test.yml',
      // ⚠️ 排除本机代理：假模型/假 NapCat 都跑在 127.0.0.1，
      //    如果 shell 里设了 NODE_USE_ENV_PROXY，不加这个假模型请求会走代理而失败
      NO_PROXY: '127.0.0.1,localhost,::1',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  bot.on('exit', (code) => {
    if (code !== 0 && code !== null) console.log(`  ⚠️  机器人进程退出，code=${code}`);
  });

  console.log('[2] 等待机器人连上假的 NapCat');
  const ok = await waitFor(() => connected, 10000, 'WebSocket 连接');
  check(ok, '机器人已连接并完成鉴权');
  if (!ok) return;

  console.log('[3] 推一条群消息，验证 @ 触发与流式回复');
  pushGroupMessage('你好啊');
  const got = await waitFor(() => sentTexts().includes(REPLY_ZH.slice(0, 6)), 12000, '群回复');
  check(got, `群消息得到回复`);
  const groupText = sentTexts();
  check(groupText.includes(REPLY_ZH) || REPLY_ZH.startsWith(groupText.replace(/\|/g, '')),
    `回复内容与模型输出一致（收到 "${groupText}"）`);
  check(
    received.some((m) => m.action === 'send_group_msg' && m.params?.group_id === GROUP_ID),
    '回复发到了正确的群',
  );
  // ⚠️ 2026-09-12 行为变更（用户要求）：
  //    「非必要不直接回复引用那个人的信息，而是直接发出信息」。
  //    以前首条永远带 reply 引用 —— 满屏引用框，很像工单系统。
  //    真人聊天很少引用，所以**默认改成不引用**。
  //    所以这里反过来断言：**不应该带引用**。
  check(
    received.some(
      (m) =>
        m.action === 'send_group_msg' &&
        Array.isArray(m.params?.message) &&
        m.params.message[0]?.type === 'text',
    ),
    '回复是直接发出的文本（不引用对方的消息）',
  );
  check(
    !received.some(
      (m) =>
        m.action === 'send_group_msg' &&
        Array.isArray(m.params?.message) &&
        m.params.message.some((seg) => seg.type === 'reply'),
    ),
    '没有多余的引用（非必要不引用）',
  );

  console.log('[4] 验证未 @ 机器人时不回复');
  const before = sentTexts().length;
  botSocket.send(
    JSON.stringify({
      post_type: 'message',
      message_type: 'group',
      message_id: 5002,
      group_id: GROUP_ID,
      user_id: '40004',
      self_id: SELF_ID,
      message: [{ type: 'text', data: { text: '这条没有 at 机器人' } }],
      sender: { user_id: '40004', nickname: '路人', role: 'member' },
    }),
  );
  await sleep(2500);
  check(sentTexts().length === before, '未 @ 的消息被正确忽略');

  console.log('[5] 验证私聊回复（无需 @）');
  botSocket.send(
    JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 5003,
      user_id: USER_ID,
      self_id: SELF_ID,
      message: [{ type: 'text', data: { text: 'please answer in english' } }],
      sender: { user_id: USER_ID, nickname: '测试用户' },
    }),
  );
  const gotPrivate = await waitFor(
    () => received.some((m) => m.action === 'send_private_msg'),
    12000,
    '私聊回复',
  );
  check(gotPrivate, '私聊消息得到回复');

  console.log('[6] 验证多轮上下文与「清空对话」指令');
  pushGroupMessage('再说一次', 5004);
  // ⚠️ 等待条件必须**和下面筛选时用同一套判据**（含"再说一次" 且 消息数 > 2）——
  //    以前这里只等「有调用含『再说一次』」，而**预搜索/说话判断**的 user 里
  //    也会带群聊原文（所以也含"再说一次"）→ waitFor 立刻满足，
  //    但真正的聊天请求**还没到** → 下面筛历史的过滤就是空的，
  //    报「角色序列: 」（空）这种假失败（2026-09-12 踩过）。
  const isChatCallWithHistory = (c) =>
    JSON.stringify(c.body?.messages ?? []).includes('再说一次') &&
    (c.body?.messages ?? []).length > 2; // 真正的聊天请求会带上历史轮次
  await waitFor(
    () => llmCalls.some(isChatCallWithHistory),
    12000,
    '带上一轮历史的聊天请求',
  );
  // ⚠️ 别用 llmCalls.length >= N 来定位是哪一次 —— 私聊、搜索规划这些请求
  //    都会插进来，索引法会抓到错误的调用（踩过）。
  //    直接找「消息里带『再说一次』且有历史」的那一次。
  const thirdCall = [...llmCalls].reverse().find(isChatCallWithHistory);
  const roles = (thirdCall?.body?.messages ?? []).map((m) => m.role);
  check(
    (thirdCall?.body?.messages ?? []).length > 2,
    `请求里带上了历史上下文（角色序列: ${roles.join(',')}）`,
  );
  check(thirdCall?.body?.stream === true, '请求使用了流式模式');
  check(
    llmCalls.every((c) => c.auth === 'Bearer sk-test-fake-key'),
    '模型请求携带了正确的 Authorization 头',
  );

  // ⚠️⚠️ 取样前必须先等"上一步迟到的请求"落下来（2026-09-15 修）。
  //
  //    踩过（回归里偶发挂这一项）：上一条消息的**追补（follow-up）/ 说话判断**
  //    是异步的，可能在我们取 `callsBefore` **之后**才到达 ——
  //    于是它被算成"「清空对话」浪费的调用"，成了假失败。
  //    这正是 AGENTS.md 里 trap ② 那条（"上一步迟到的请求"）的同一个坑。
  //
  //    修法：**等到调用数不再变**再取样，而不是固定睡 1.5 秒碰运气。
  let stable = -1;
  for (let i = 0; i < 20 && stable !== llmCalls.length; i++) {
    stable = llmCalls.length;
    await sleep(300);
  }
  const callsBefore = llmCalls.length;
  pushGroupMessage('清空对话', 5005);
  await sleep(2500);
  check(
    sentTexts().includes('清空'),
    '「清空对话」指令被识别并回复',
  );
  check(llmCalls.length === callsBefore, '「清空对话」没有浪费一次模型调用');

  // ─────────────────────────────────────────────────────────────────
  console.log('\n[7] `/好感度` 群命令（HZY 报「发了没回复」，2026-09-15 修）');
  //
  // ⚠️⚠️ 这套断言能成立，靠的是 `config.test.yml` 的**默认档位**：
  //    它只写了 `requireAtInGroup: true`，没有 `respondTo` / `groupRespondTo`，
  //    也没有 `chat:` 段 → `resolveRespondTo()` = **3（只认 @）**，
  //    `chat.enable` 是关的。
  //    也就是说：这正是 HZY 那个"发了石沉大海"的场景 ——
  //    命令原来挂在 `shouldJoinChat()` 里，被"档位 3"和"chat.enable=false"
  //    两道与它无关的闸门挡掉了，而且**一道日志都不留**。
  {
    let st = -1;
    for (let i = 0; i < 20 && st !== llmCalls.length; i++) {
      st = llmCalls.length;
      await sleep(300);
    }
    const callsBeforeBoard = llmCalls.length;
    const boardsBefore = (sentTexts().match(/好感度排行榜/g) ?? []).length;

    // ① 没 @ 它
    pushGroupMessageNoAt('/好感度', 5006);
    const gotBoard = await waitFor(
      () => (sentTexts().match(/好感度排行榜/g) ?? []).length > boardsBefore,
      8000,
      '好感度排行榜',
    );
    check(gotBoard, '★ 没 @ 它、而且是 3 档的群，`/好感度` 也回了（原来静默丢掉）');
    check(llmCalls.length === callsBeforeBoard, '★ 排行榜没浪费模型调用（纯拼字符串）');

    // ② `@她 /好感度` —— 原来 onRaw 里 @ 的分支排在前面，
    //    会把它推进 `decide()` 那条「`/` 开头一律不回复」，永远到不了排行榜
    const boardsBefore2 = (sentTexts().match(/好感度排行榜/g) ?? []).length;
    pushGroupMessage('/好感度', 5007);
    const gotBoard2 = await waitFor(
      () => (sentTexts().match(/好感度排行榜/g) ?? []).length > boardsBefore2,
      8000,
      '第二条排行榜',
    );
    check(gotBoard2, '★ `@她 /好感度` 也能用（@ 的分支不再把它抢走）');

    // ③ 命令**不许融进聊天上文**（用户明确要求；放在 `recent.remember` 之前才行）
    //    ⚠️ 这条要用**带 @** 的形态推 —— `config.test.yml` 的档位是 3，
    //       不 @ 它的普通消息**根本不会回**，那这次聊天请求就不会发生，
    //       下面那条断言会"因为没请求"而白白通过（假绿）。
    pushGroupMessage('这句是清空之后的第一句话', 5008);
    // 主聊天请求的判据：最后一条 user 是 `XX刚发来的消息：「…」`（见 bot.js 里那句）
    const isChatAfter = (c) => {
      const msgs = c.body?.messages ?? [];
      return String(msgs[msgs.length - 1]?.content ?? '').includes('刚发来的消息');
    };
    await waitFor(() => llmCalls.some(isChatAfter), 12000, '清空后的聊天请求');
    const chatAfter = [...llmCalls].reverse().find(isChatAfter);
    check(!!chatAfter, '清空之后确实又聊了一次（否则下面那条断言没意义）');
    // ⚠️ 判据必须是「**斜杠**好感度」，不能只查"好感度"两个字：
    //    `knowledge/learned.md` 里有群主教的"好感度"（最高优先级，**必定**进 system），
    //    只查两个字的话这条断言永远失败（而且是假失败）。
    const ctx = (chatAfter?.body?.messages ?? [])
      .filter((m) => m.role !== 'system')
      .map((m) => String(m.content ?? ''))
      .join('\n');
    check(!/\/\s*好感度/.test(ctx), '★★ `/好感度` 没有融进聊天上文（命令本身也不许进）');
  }
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
