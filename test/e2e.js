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
import { rmSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ⚠️⚠️ 2026-09-20 加：**给这个套件一个干净的上下文状态文件**。
//    为什么必须：`recent` 的测试状态文件名是**固定的**
//    （`state/__test-config.test-recent.json`），跨次运行会**累积历史消息**；
//    而"要不要引用"取决于 `buried`（她要回的那条后面还有几条）——
//    攒够 ≥4 条就**必然引用** ⇒ 下面「非必要不引用」那两条断言就会红。
//    ⚠️ 这个坑今天才显形：在我修好 `recent.reload()`（那个 TDZ）之前，
//      那个文件**根本加载不进来** ⇒ `recent` 一直是空的 ⇒ 断言"恰好"通过
//      —— **那是个假绿**（修好加载之后，历史状态才开始生效）。
const RECENT_FILE = 'logs/__e2e-recent.json';
process.env.QQBOT_RECENT_FILE = RECENT_FILE;
rmSync(join(ROOT, RECENT_FILE), { force: true });

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
/**
 * ⚠️ 2026-09-21 加：**主聊天每个分片之间等多久**（默认 0 = 一口气写完）。
 *
 * 为什么需要：要测「她正在生成时，同一个人又发了一条 → 应该丢掉草稿并起来重来」，
 * 就必须存在一个**能被插进去的生成窗口**。假模型本来是同步一口气 `res.end()` 的，
 * 那样她一瞬间就生成完了 —— 这类测试会**永远是绿的**（假绿，等于没测）。
 * 测那两节时把它调大，测完调回 0。
 *
 * ⚠️ 只有**主聊天**会走到下面那个兜底分支，所以这个开关不会拖慢
 * 预搜索 / 归属核对 / 说话判断那些请求。
 */
let streamGapMs = 0;
const llmServer = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
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
      // ⚠️ 放在 `write` **之前** —— 连第一片也等，窗口就从"收到请求"开始算
      //    （测试那边正是拿"假模型收到请求"当"她开始生成了"的信号）
      if (streamGapMs) await sleep(streamGapMs);
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

const wss = new WebSocketServer({ port: WS_PORT, host: '203.0.113.10' });

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

/**
 * 推一条 @ 它的群消息。
 * ⚠️ `userId` / `nickname` 可换 —— 测「**别人**插话不该打断她的生成」要用另一个人发。
 */
function pushGroupMessage(text, messageId = 5001, userId = USER_ID, nickname = '测试用户') {
  botSocket.send(
    JSON.stringify({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: messageId,
      group_id: GROUP_ID,
      user_id: userId,
      self_id: SELF_ID,
      raw_message: `[CQ:at,qq=${SELF_ID}] ${text}`,
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: userId, nickname, role: 'member' },
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
  await new Promise((r) => llmServer.listen(LLM_PORT, '203.0.113.10', r));
  await new Promise((r) => (wss._server.listening ? r() : wss.once('listening', r)));
  console.log(`\n假模型服务: http://203.0.113.10:${LLM_PORT}/v1`);
  console.log(`假 NapCat : ws://203.0.113.10:${WS_PORT}\n`);

  console.log('[1] 启动机器人子进程');
  // stdio 交给父进程用的管道，这里设为 ignore 以免和测试输出互相干扰
  bot = spawn(process.execPath, [join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      QQBOT_CONFIG: 'config.test.yml',
      // ⚠️ 排除本机代理：假模型/假 NapCat 都跑在 203.0.113.10，
      //    如果 shell 里设了 NODE_USE_ENV_PROXY，不加这个假模型请求会走代理而失败
      NO_PROXY: '203.0.113.10,localhost,::1',
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
  console.log('\n[7] `/好感度` 群命令（<主人> 报「发了没回复」，2026-09-15 修）');
  //
  // ⚠️⚠️ 这套断言能成立，靠的是 `config.test.yml` 的**默认档位**：
  //    它只写了 `requireAtInGroup: true`，没有 `respondTo` / `groupRespondTo`，
  //    也没有 `chat:` 段 → `resolveRespondTo()` = **3（只认 @）**，
  //    `chat.enable` 是关的。
  //    也就是说：这正是 <主人> 那个"发了石沉大海"的场景 ——
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

  // ─────────────────────────────────────────────────────────────────
  console.log('\n[8] 生成期间「同一个人连发」→ 丢掉草稿并起来，只回一条');
  //
  // ⚠️⚠️ 用户 2026-09-21 报的问题（真实日志，群 200000001 16:01）：
  //    他 @ 她一下、紧接着又补一句 → 她**回了两条**（先回「一张一张的，你们这是
  //    把相册搬来了（」**带引用**、同一秒又回「怎么了这是」**又带引用**）。
  //    用户原话：「**这个就是没有把靠近的消息合并的问题**」。
  //    修法见 `bot.js` 里那段 `_requeue`：这一版草稿丢掉、带着新消息重新生成。
  {
    // ⚠️ 必须先让她**慢下来**（见 `streamGapMs` 的注释）——
    //    不然生成一瞬间就结束，"中途"这个窗口根本不存在，这条测试永远是绿的。
    streamGapMs = 400;
    const callsBefore = llmCalls.length;
    const sendsBefore = received.filter((m) => m.action === 'send_group_msg').length;
    // 主聊天请求的判据（和上面 `isChatAfter` 同一条）：最后一条 user 形如
    // `XX刚发来的消息：「…」`
    const isChatLast = (c) =>
      String((c.body?.messages ?? []).slice(-1)[0]?.content ?? '').includes('刚发来的消息');

    pushGroupMessage('服务器怎么进', 6001);
    // ⚠️ 要**等她真的开始生成**再塞第二条，不能用 sleep 猜时间：
    //    早了 → 第二条会并进**同一个攒批窗口**（那条路本来就会合并，测不到 `_requeue`）；
    //    晚了 → 她已经生成完、发出去了。
    //    ⚠️ 判据只看 `callsBefore` **之后**的请求 —— 上面几节已经留下了聊天请求，
    //      不划基线的话 `waitFor` 会立刻满足（AGENTS.md 里 trap ② 那个坑）。
    const started = await waitFor(
      () => llmCalls.slice(callsBefore).some(isChatLast),
      12000,
      '第一次生成开始',
    );
    check(started, '第一条消息进入了生成');

    pushGroupMessage('就是那个整合包', 6002); // ← **同一个人**紧接着补一句

    const replied = await waitFor(
      () => received.filter((m) => m.action === 'send_group_msg').length > sendsBefore,
      15000,
      '连发之后的回复',
    );
    check(replied, '连发之后她回话了');
    // ⚠️ 多等一会儿再数：旧行为的第二条是「这一轮跑完 → `flushPendingGroup`
    //    → 再处理一批」出来的，**有延迟**。只等第一条出现就数会漏掉它，
    //    而漏掉它这条测试就永远是绿的 —— 正是要防的那种假绿。
    await sleep(4000);
    const n = received.filter((m) => m.action === 'send_group_msg').length - sendsBefore;
    check(n === 1, `★ 只回了一条（实际 ${n} 条 —— 两条就是"没把靠近的消息合并"的老毛病）`);
    // 而且重来的那次生成里**看得到**他补的第二句：是"并起来"，不是"丢掉不管"
    const merged = llmCalls
      .slice(callsBefore)
      .filter(isChatLast)
      .some((c) => JSON.stringify(c.body?.messages ?? []).includes('就是那个整合包'));
    check(merged, '★ 重来的那次生成带上了他补的第二句（真的并起来了）');
    streamGapMs = 0;
  }

  // ─────────────────────────────────────────────────────────────────
  console.log('\n[9] 别人插话**不**打断她的生成');
  //
  // ⚠️ 用户 2026-09-21 明确加的边界：「**注意只有同一个人连发的消息可以打断生成**」。
  //    他一句没说完补一句 = 同一件事，必须并起来；
  //    而**别人**在她生成期间插话是**另一件事** —— 为它把这次生成丢掉重来，
  //    等于拿甲的问题去等乙的闲话，没道理。
  //    这里验两条：① 甲那一轮的生成请求里**没有**乙那句；
  //                ② 乙那句**也没被吞掉**（之后被单独处理）。
  {
    streamGapMs = 400;
    const callsBefore = llmCalls.length;
    const sendsBefore = received.filter((m) => m.action === 'send_group_msg').length;
    const isChatLast = (c) =>
      String((c.body?.messages ?? []).slice(-1)[0]?.content ?? '').includes('刚发来的消息');
    const lastUser = (c) => String((c.body?.messages ?? []).slice(-1)[0]?.content ?? '');

    pushGroupMessage('甲问的那个问题', 6101);
    const started = await waitFor(
      () => llmCalls.slice(callsBefore).some(isChatLast),
      12000,
      '甲这一轮的生成开始',
    );
    check(started, '甲的消息进入了生成');

    pushGroupMessage('乙插一句', 6102, '40004', '路人乙'); // ← **另一个人**

    await waitFor(
      () => received.filter((m) => m.action === 'send_group_msg').length > sendsBefore,
      15000,
      '甲这一轮的回复',
    );
    // ⚠️ 找**甲那一轮**的请求：最后一条 user 是甲的话。乙那一轮最后一条 user 是
    //    "乙插一句"，所以不会误抓（`.reverse()` 取最近的，更稳）。
    const firstRound = [...llmCalls]
      .reverse()
      .find((c) => isChatLast(c) && lastUser(c).includes('甲问的那个问题'));
    check(
      !!firstRound && !JSON.stringify(firstRound.body?.messages ?? []).includes('乙插一句'),
      '★ 乙插话没有打断甲那一轮（他问的事没被别人的闲话搅进去）',
    );
    // 乙那句也不许被吞掉
    const gotB = await waitFor(
      () =>
        llmCalls
          .slice(callsBefore)
          .some((c) => isChatLast(c) && JSON.stringify(c.body?.messages ?? []).includes('乙插一句')),
      15000,
      '乙那条被单独处理',
    );
    check(gotB, '★ 乙插的那句没被吞掉（她之后单独处理了它）');
    streamGapMs = 0;
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
