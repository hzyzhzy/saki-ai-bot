/**
 * 客服模式专项测试。
 * 不连真实 QQ，用假的模型服务 + 假的 NapCat + 假的 MC 状态 API，
 * 重点验证：
 *   1. 只在该群应答，其他群完全忽略
 *   2. 知识库和人设确实被注入到系统提示词
 *   3. 问在线人数时真的去查服务器，并把结果注入提示词
 *   4. 客服不会乱回（未 @ 时沉默）
 *
 * 用法: node test/cs.js
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const LLM_PORT = 39102;
const WS_PORT = 39101;
const MC_PORT = 39103;
// ⚠️ 假 MC 的 **TCP**（真实 MC 协议）—— HTTP 和 TCP 不能共用端口，所以 +1。
//    status.js 现在优先用 MC 协议自己查（不依赖第三方 API），
//    所以测试必须提供这一路，否则走不到真实路径（2026-09-13 加）。
const MC_TCP_PORT = 39104;
const TOKEN = 'test-token';
const SELF_ID = '10001';
const WORK_GROUP = '200000001'; // 客服应该在这应答
const OTHER_GROUP = '999999999'; // 不该应答的群
const USER_ID = '30003';

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 假模型：记录收到的提示词，回一句可识别的话 ──
const llmCalls = [];
const llmProbe = []; // { sys, lastUser, hasLive }
const llmServer = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {}
    if (!parsed.messages) {
      llmCalls.push(parsed);
      res.end('');
      return;
    }
    const sys = parsed.messages.find((m) => m.role === 'system')?.content ?? '';
    const lastUser = [...parsed.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    llmCalls.push(parsed);
    llmProbe.push({ sys, lastUser, hasLive: sys.includes('【实时数据·刚刚查到】') });

    // ⚠️ `CS_DEBUG=1` 时把每个请求的身份打出来 —— 排查"某一步之后
    //    机器人不再发聊天请求"这类问题（只看断言列表看不出是哪一层出的岔）。
    if (process.env.CS_DEBUG) {
      const tag = sys.includes('这句话要不要上网查')
        ? '预搜索'
        : sys.includes('该搜什么')
          ? '搜索规划'
          : sys.includes('【归属核对】')
            ? '归属核对'
            : sys.includes('假装成真人群友')
              ? '说话判断'
              : `★聊天(stream=${parsed.stream !== false})`;
      console.log(`    [req] ${tag} | user="${String(lastUser).replace(/\s+/g, ' ').slice(0, 50)}"`);
    }

    // ⚠️⚠️ 合并式预搜索（system 里含「这句话要不要上网查」）——
    //    **它走的是流式 `collect(streamChat(...))`，必须回 SSE，不能回 JSON**。
    //
    //    这里原来回的是 `Content-Type: application/json` 的一整块 ——
    //    预搜索的 SSE 解析器从里面读不出任何 `data:`，`raw` 是空串，
    //    正则匹配不到 `{...}` → `plan` 为 null → **退回规则** →
    //    `shouldSearch()` 认为该搜 → **真的去联网搜**（bing/百度/DDG，
    //    还要抓页），一段 12~15 秒。
    //
    //    后果就是 cs 套件长年"偶发失败"：那 12~15 秒把后面几步的
    //    `waitFor` 全拖过超时（实测失败 2 项 / 6 项 / 7 项随机跳）。
    //    一直以为是"并发抢 CPU 的噪音"，其实是**假模型回错了格式**。
    //    （e2e.js 里早就记着同一个坑 —— 那边修了，这边漏了。）
    if (sys.includes('这句话要不要上网查')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: '{"search":false,"why":"测试不搜"}' } }] })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    // ⚠️ 搜索规划（system 里含「该搜什么」）也是流式，同样要 SSE
    if (sys.includes('该搜什么')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '测试关键词' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const reply = '好的，我来帮您看一下。';
    // ⚠️ 「该不该说」判断请求（system 里含「假装成真人群友」）——
    //    它要的是 **JSON**，不是 SSE。假模型不认识它的话会回一段 SSE，
    //    判断解析失败 → 默认「不说」→ 测试里机器人整个哑掉（真实踩过）。
    //    这里统一回「说」，让测试专注在它要验的东西上。
    // ⚠️ 2026-09-13 加：「归属核对」请求也要认得出来。
    //    原来假模型不认识它 → 每次都要等满 8 秒超时 → 回归很慢。
    //    （用户反馈「跑回归时间太长了，是不是有什么 bug」——没 bug，是白等超时。）
    if (sys.includes('【归属核对】')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }] }));
      return;
    }
    if (sys.includes('假装成真人群友')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"speak":true,"why":"测试","length":"short"}' } }] }));
      return;
    }
    // ⚠️ **非流式**请求（`stream` 不是 true）要回整块 JSON，不能回 SSE。
    //    原来这里一律回 SSE，于是 `llm.phrase()` 这种非流式调用拿到
    //    `data: {"ch...` 去 `res.json()` → 报「润色出错：Unexpected token 'd'」。
    //    「说完一句又想补充」（follow-up）走的就是这条非流式路径，
    //    它会**静默退回"不补充"** —— 功能看着是好的，其实从没生效过。
    if (parsed.stream !== true) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    for (const piece of reply.match(/.{1,5}/gs) ?? [reply]) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

// ── 假的 MC 服务器状态（**两套都要**，2026-09-13 改） ──
//
// ⚠️ 为什么需要两套：`src/status.js` 现在**优先自己用 MC 协议查**（不依赖第三方），
//    只有自己查失败才去问 mcstatus.io 那种 HTTP API。
//    所以测试必须**同时**提供：
//      ① TCP + MC 协议（Server List Ping）→ 走"自己查"那条路
//      ② HTTP API                      → 走"兜底"那条路
//    只给 HTTP 的话，自己查会被跳过、兜底又不触发（因为自查询成功了），
//    结果玩家名单拿不到（真实踩过：cs 测试报「实时结果里带上了在线玩家名单」失败）。
let mcQueries = 0;
let mcTcpQueries = 0;
const MC_PLAYERS = ['Kirito', 'Asuna', 'hzyzhzy'];

/** 假 MC 的 HTTP 状态 API（mcstatus.io 格式） */
const mcServer = createServer((req, res) => {
  mcQueries++;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      online: true,
      version: { name_clean: '1.20.1', protocol: 763 },
      players: {
        online: 7,
        max: 2026,
        list: MC_PLAYERS.map((n) => ({ name_clean: n })),
      },
    }),
  );
});

/** 假 MC 的 TCP 服务（真实 Server List Ping 协议） */
const mcTcp = createServer((sock) => {
  mcTcpQueries++;
  if (process.env.CS_DEBUG) console.log(`    [mc] TCP 连接 #${mcTcpQueries}`);
  sock.on('data', () => {
    if (process.env.CS_DEBUG) console.log('    [mc] 收到握手/请求，回状态');
    // 收到 Handshake / Status Request 就回一段状态 JSON。
    // ⚠️ 不用真去解析协议 —— bot 那边只会在收到的数据里找第一个 `{`。
    const status = JSON.stringify({
      version: { name: '1.20.1', protocol: 763 },
      players: { online: 7, max: 2026, sample: MC_PLAYERS.map((n) => ({ name: n })) },
    });
    const json = Buffer.from(status, 'utf8');
    // VarInt(长度) + PacketID(0) + VarInt(字符串长) + 字符串
    const vint = (n) => {
      const out = [];
      let v = n >>> 0;
      for (;;) {
        if ((v & ~0x7f) === 0) {
          out.push(v);
          break;
        }
        out.push((v & 0x7f) | 0x80);
        v >>>= 7;
      }
      return Buffer.from(out);
    };
    const body = Buffer.concat([Buffer.from([0x00]), vint(json.length), json]);
    sock.write(Buffer.concat([vint(body.length), body]));
  });
  sock.on('error', () => {});
});

// ── 假 NapCat ──
const received = [];
let botSocket = null;
let connected = false;

const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });

wss.on('connection', (ws, req) => {
  if ((req.headers.authorization ?? '') !== `Bearer ${TOKEN}`) {
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
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: m.echo }));
    }
  });
  ws.on('close', () => (connected = false));
  ws.send(
    JSON.stringify({
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
      self_id: SELF_ID,
      time: Math.floor(Date.now() / 1000),
    }),
  );
});

/**
 * 往群里推一条假消息。
 *
 * ⚠️⚠️ 2026-09-13 加 `who` 参数：**每一步要用不同的发送者**。
 *
 *    原因（这个 bug 找了很久）：测试连发 7 条消息，原来**全用同一个 USER_ID** ——
 *    而机器人开着**防刷屏**（`flood: count=6/windowMs=10000`）：
 *    同一个人 10 秒内发满 6 条 → 判定刷屏 → **之后静默**。
 *    第 5、6 步正好在那之后 → 「实查后的模型调用」超时 → 5 项失败。
 *
 *    为什么今天才暴露：`question` 路径去掉了概率掷骰（用户要求「不要抽签」），
 *    响应变快 → 7 条消息更密地挤进那个 10 秒窗口 → 撞上防刷屏。
 *
 *    真实群聊里也不会同一个人 10 秒连发 7 条，所以**改测试**是对的：
 *    每步换个发送者（`who`），既符合现实，也不会误触发防刷屏。
 *
 * @param {string} groupId
 * @param {string} text
 * @param {boolean} [atBot] 要不要 @ 机器人
 * @param {number} [id] 消息 id
 * @param {string} [who] 发送者 QQ（默认 USER_ID）
 */
function pushGroupMsg(groupId, text, atBot = true, id = 1, who = USER_ID) {
  const message = [];
  if (atBot) message.push({ type: 'at', data: { qq: SELF_ID } });
  message.push({ type: 'text', data: { text: ` ${text}` } });
  botSocket.send(
    JSON.stringify({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: id,
      group_id: groupId,
      user_id: who,
      self_id: SELF_ID,
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: who, nickname: '测试群友', role: 'member' },
      message,
    }),
  );
}

async function waitFor(fn, timeout = 15000, label = '条件') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return true;
    await sleep(100);
  }
  console.log(`  ⏱  等待「${label}」超时`);
  return false;
}

const sentTexts = () =>
  received
    .filter((m) => m.action === 'send_group_msg' || m.action === 'send_private_msg')
    .map((m) => (Array.isArray(m.params?.message) ? m.params.message : []))
    .map((segs) => segs.filter((s) => s.type === 'text').map((s) => s.data.text).join(''))
    .join('|');

// ⚠️ 排除预搜索的探针（它的 sys 是搜索决策提示词，看不到实时数据段落）
const isPresearch = (p) => /这句话要不要上网查|该搜什么/.test(p.sys);
const lastSystemPrompt = () => [...llmProbe].reverse().find((p) => !isPresearch(p))?.sys ?? '';
const probeFor = (text) => [...llmProbe].reverse().find((p) => !isPresearch(p) && p.lastUser.includes(text));

/**
 * 等**主聊天请求**（不是"含这个字样的任何请求"）。
 *
 * ⚠️⚠️ 为什么不能用 `probeFor(关键词)` 当等待条件（第一版就是这么写的）：
 *    「说完一句又想补充」（follow-up）那边会把**整段群聊上下文**塞进 user ——
 *    上下文里自然含前面几步说过的话。于是"等第 5 步的 `几个人在线`"会被
 *    **第 4 步迟到的追补请求**满足 → 拿到一条没有实时数据的 prompt →
 *    4 项假失败。
 *
 *    ✅ 可靠判据：主聊天的 user 是
 *      `「<昵称>刚发来的消息：「<正文>」"`（`bot.js` 里就是这么拼的），
 *      而追补/预搜索的 user 都以 `# 群聊上下文` / `# 群里最近的对话` 开头。
 *    所以按"**以这句正文结尾**"来认，最准。
 */
const isChatProbe = (p) => !isPresearch(p) && /刚发来的消息：「[\s\S]*」\s*$/.test(p.lastUser);
const chatFor = (text) => [...llmProbe].reverse().find((p) => isChatProbe(p) && p.lastUser.includes(text));
/** 等第 n 步的主聊天请求到达 */
const waitChat = (text, label = '主聊天请求', timeout = 15000) =>
  waitFor(() => !!chatFor(text), timeout, label);

let bot = null;

async function main() {
  await new Promise((r) => llmServer.listen(LLM_PORT, '127.0.0.1', r));
  await new Promise((r) => mcServer.listen(MC_PORT, '127.0.0.1', r));
  // ⚠️ 假 MC 的 TCP 也监听到**同一个端口 MC_PORT**？
  //    不行 —— HTTP 和 TCP 不能共用端口。所以 TCP 用 MC_PORT + 1，
  //    并在配置里把 host 写成 `127.0.0.1:<MC_TCP_PORT>`（显式端口 → 不解析 SRV）。
  await new Promise((r) => mcTcp.listen(MC_TCP_PORT, '127.0.0.1', r));
  await new Promise((r) => (wss._server.listening ? r() : wss.once('listening', r)));
  console.log(`\n假模型   http://127.0.0.1:${LLM_PORT}/v1`);
  console.log(`假 MC API http://127.0.0.1:${MC_PORT}/v2/status/java`);
  console.log(`假 MC TCP 127.0.0.1:${MC_TCP_PORT}（真实 MC 协议）`);
  console.log(`假 NapCat ws://127.0.0.1:${WS_PORT}\n`);

  console.log('[1] 启动机器人（客服配置）');
  bot = spawn(process.execPath, [join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      QQBOT_CONFIG: 'config.cs-test.yml',
      // ⚠️ 调试用：`CS_BOT_LOG=1` 时把机器人日志级别抬到 debug
      ...(process.env.CS_BOT_LOG ? { QQBOT_LOG_LEVEL: 'debug' } : {}),
      // ⚠️ 排除本机代理：假模型/假 NapCat 都跑在 127.0.0.1，
      //    如果 shell 里设了 NODE_USE_ENV_PROXY，不加这个假模型请求会走代理而失败
      NO_PROXY: '127.0.0.1,localhost,::1',
    },
    // ⚠️ 调试用：`CS_BOT_LOG=1` 时把机器人自己的日志打到文件，
    //    排查"某一步之后机器人整个不吭声了"这类问题（`ignore` 的话什么都看不到）。
    stdio: process.env.CS_BOT_LOG
      ? ['ignore', 'pipe', 'pipe']
      : ['ignore', 'ignore', 'ignore'],
  });
  if (process.env.CS_BOT_LOG) {
    const { createWriteStream } = await import('node:fs');
    const s = createWriteStream(join(ROOT, 'logs', 'cs-bot.log'));
    bot.stdout.pipe(s);
    bot.stderr.pipe(s);
  }
  const ok = await waitFor(() => connected, 10000, 'WebSocket 连接');
  check(ok, '机器人已连接');
  if (!ok) return;

  console.log('[2] 非白名单群应该被完全忽略');
  const beforeOther = sentTexts().length;
  const callsBeforeOther = llmCalls.length;
  pushGroupMsg(OTHER_GROUP, '有人在线吗', true, 1001, '30001');
  await sleep(3000);
  check(sentTexts().length === beforeOther, '其他群里没有回复');
  check(llmCalls.length === callsBeforeOther, '其他群没有触发模型调用（连查都没查）');

  console.log('[3] 客服群未 @ 时也应该沉默');
  const beforeNoAt = sentTexts().length;
  pushGroupMsg(WORK_GROUP, '服务器怎么进啊', false, 1002, '30002');
  await sleep(3000);
  check(sentTexts().length === beforeNoAt, '未 @ 时没有回复');

  console.log('[4] @ 客服问新人问题 → 知识库应被注入');
  pushGroupMsg(WORK_GROUP, '新人应该怎么安装这个整合包？', true, 1003, '30003');
  const got = await waitFor(() => sentTexts().includes('好的，我来帮您'), 15000, '客服回复');
  check(got, '客服在客服群里回复了');

  const sysPrompt = chatFor('新人应该怎么安装')?.sys ?? '';
  if (process.env.CS_DEBUG) {
    console.log('    [debug] 模型调用记录：');
    llmProbe.forEach((p, i) =>
      console.log(`      #${i} hasLive=${p.hasLive} user="${p.lastUser.slice(0, 40)}"`),
    );
    console.log(`    [debug] 命中 probe 的 user="${chatFor('新人应该怎么安装')?.lastUser}"`);
  }
  check(sysPrompt.length > 3000, `系统提示词很长，说明知识库已注入（${sysPrompt.length} 字）`);
  check(sysPrompt.includes('客服小祥'), '系统提示词包含人设「客服小祥」');
  check(sysPrompt.includes('Java 21'), '系统提示词包含知识库内容（Java 21）');
  check(sysPrompt.includes('video player'), '系统提示词包含 Mac 排障知识（video player）');
  check(sysPrompt.includes('大足特别行政区') || sysPrompt.includes('建设'), '系统提示词包含建设规则');
  check(!chatFor('新人应该怎么安装')?.hasLive, '普通新人问题没有注入实时状态');

  console.log('[5] 问在线人数 → 应该触发实查并注入结果');
  pushGroupMsg(WORK_GROUP, '现在几个人在线？', true, 1004, '30004');
  // ⚠️ 等**第 5 步的主聊天请求**（不是"含这几个字的任何请求"—— 见 `chatFor` 的注释：
  //    第 4 步迟到的追补请求会把群上下文一起带上，含这句话，会提前满足）。
  await waitChat('几个人在线', '实查后的模型调用');
  const live = chatFor('几个人在线');
  check(live?.hasLive === true, '系统提示词里出现了实时查询结果段落');
  check(!!live?.sys.includes('在线'), '实时结果里包含在线状态');
  check(!!live?.sys.includes('7') && !!live?.sys.includes('2026'), '实时结果的数字来自查询（7/2026）');
  check(
    !!live?.sys.includes('Kirito') || !!live?.sys.includes('Asuna'),
    '实时结果里带上了在线玩家名单',
  );

  console.log('[5b] 碰服务器、但触发不了实查 → 必须有「这次没查」的守卫（2026-09-17 加）');
  // ⚠️ 这一节复现的是**真实事故**（用户截图来问的）：
  //    群友发「查服务器功能」→ 关键词表（在线/几个人/服务器开了/服务器状态…）
  //    **一条都命不中** → 没实查 → 她回了「没查到，这次数据没上来。你想看在线人数还是服务器开没开？」
  //    → 群友和服主都以为**服务器挂了**，其实服务器好好的。
  //    所以这里钉两件事：① 确实没注入实时数据；② 提示词里**有**那段禁令（A 法）。
  //    ⚠️ 这条断言**不依赖假 MC**，所以不受本套件那条已知偶发（玩家名单）影响。
  pushGroupMsg(WORK_GROUP, '查服务器功能', true, 1006, '30006');
  await waitChat('查服务器功能', '这条的模型调用');
  const noQuery = chatFor('查服务器功能');
  check(!!noQuery, '这条确实发生了一次模型调用（没被静默丢掉）');
  check(noQuery?.hasLive !== true, '没有注入实时状态（说明判据确实没命中）');
  check(
    !!noQuery?.sys.includes('这次**没有**服务器实时数据'),
    '★ 提示词里有「这次没查」的守卫 —— 她不会编「数据没上来」',
  );

  console.log('[6] 普通闲聊不应触发实查');
  pushGroupMsg(WORK_GROUP, '今天的天气你觉得怎么样呀', true, 1005, '30005');
  // ⚠️⚠️ 这里原来等的是「非预搜索调用数**变多**」—— 那个条件会被
  //    **上一步迟到的探针**（追补 / 说话判断 / 归属核对）满足，
  //    于是根本没等到这条闲聊的探针就往下走，`chatFor` 拿到 undefined，
  //    `?.hasLive === false` 就成了 false → **假失败**。
  await waitChat('天气', '闲聊的模型调用');
  check(chatFor('天气')?.hasLive === false, '闲聊没有浪费一次服务器查询');
  // 顺带确认真的等到了一条（不然 `?.` 会把"没等到"伪装成"没实查"）
  check(!!chatFor('天气'), '闲聊确实发生了一次模型调用');

  console.log('[7] 「清空对话」应重置上下文');
  pushGroupMsg(WORK_GROUP, '清空对话', true, 1006, '30006');
  await waitFor(() => sentTexts().includes('清空'), 10000, '清空回复');
  check(sentTexts().includes('清空'), '清空指令有回复');
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
  await new Promise((r) => mcServer.close(r));
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
