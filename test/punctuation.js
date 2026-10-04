/**
 * 「聊天里不用的标点」测试（2026-09-14 用户要求）。
 *
 * 用户原话（带截图）：
 *   「这一组对话机器人回的话我觉得**完全可以分段**，因为都用破折号了。
 *    而且我建议**不要发破折号之类一般聊天不常用的标点符号**，这样不像真人」。
 *
 * 截图里那句：
 *   「不大，一个人住刚好 **——** 怎么，你要来？」
 *
 * 两件事要验：
 *  ① `stripChatUncommonPunct()` 把破折号这类换掉（输出里**不能再有** `—`）
 *  ② 破折号那个位置**会触发分条**（20 字的短回复也要能断成两条）
 *
 * ⚠️ 全离线（纯函数 + 假模型 + 假 NapCat），不花钱、不碰真 QQ。
 *
 * 用法: node test/punctuation.js
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { firstSentenceBreak, chunkDelay } from '../src/bot.js';
import { config } from '../src/config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });

// ⚠️ 端口区间 40301 已被 earn-prompt 占用，这里用 40401/40402
const LLM_PORT = 40401;
const WS_PORT = 40402;
const TOKEN = 'punct-token';
const SELF_ID = '10001';
const GROUP_ID = '20002';
const USER_ID = '30003';

// 假模型要吐的正文（**故意带破折号**，复现用户截图那句）
const REPLY_WITH_DASH = '不大，一个人住刚好——怎么，你要来？';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════
// 【A】纯函数：标点清洗（不调模型、不起进程）
// ════════════════════════════════════════════════════════════
const CFG_REL = 'logs/__test-punct.yml';
writeFileSync(
  join(ROOT, CFG_REL),
  ['llm:', '  baseURL: http://127.0.0.1:1/v1', '  apiKey: "sk-test"', '  model: test-model', ''].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;

const bot = await import('../src/bot.js');
const strip = bot.stripChatUncommonPunct;

console.log('\n【A】标点清洗（纯函数）');
{
  // ★ 用户截图那句
  const r = strip('不大，一个人住刚好——怎么，你要来？');
  check(!/—|―|─/.test(r), `破折号被清掉：${r}`, JSON.stringify(r));
  check(r.includes('住刚好') && r.includes('你要来'), '两边的字一个都没丢');
  check(/[，,。]/.test(r), '换成了逗号/句号（不是直接删掉留个空）');
}

{
  // 各种破折号写法都要认（用户可能打一个或两个、全角或半角）
  const cases = [
    '好——行',
    '好—行',
    '好――行',
    '好──行',
    '好  ——  行',
  ];
  for (const c of cases) {
    const r = strip(c);
    check(!/—|―|─/.test(r), `「${c}」→「${r}」里没有破折号`);
  }
}

{
  // 句首/句尾的破折号：直接去掉
  check(!/—/.test(strip('——你说什么')), '句首破折号去掉');
  check(!/—/.test(strip('你说什么——')), '句尾破折号去掉');
}

{
  // 前面已经有标点时，不能变成「。，」这种怪东西
  const r = strip('真的。—不过算了');
  check(!/。\s*，|。，/.test(r), `没出现「。，」：${r}`, JSON.stringify(r));
  const r2 = strip('好，——行');
  check(!/，，/.test(r2), `没出现「，，」：${r2}`, JSON.stringify(r2));
}

console.log('\n【A2】★「」『』【】这类标点也不许发（2026-09-15 用户反馈）');
{
  // 用户原话：「这个套**太聪明的标点**也不应该发，我自己都不知道这个符号怎么打出来的」
  // 他看到的原话：「什么怎么嘞，你心里没数吗。连发五遍我名字，还配个「太聪明了」」
  const r = strip('连发五遍我名字，还配个「太聪明了」');
  check(!/[「」『』【】〔〕〈〉]/.test(r), `括号被清掉：${r}`, JSON.stringify(r));
  check(r.includes('太聪明了'), '括号**里面的字一个都没丢**（只去括号）');
  for (const c of ['他说『走了』', '【重要】明天停服', '（〔备注〕）']) {
    const out = strip(c);
    check(!/[『』【】〔〕〈〉]/.test(out), `「${c}」→「${out}」`);
  }
  // ⚠️ **别把书名号也清了** —— 视频标题/书名要用（她刚报完 B站 视频名）
  const t = strip('那个《炽白真形》生存试玩');
  check(t.includes('《炽白真形》'), `《》要留着：${t}`);
}

{
  // ⚠️ 正常标点**一个都不能动**（这是这个函数最危险的地方）
  const safe = [
    '还行，饿不着自己',
    '够买吗？',
    '真的……算了',
    '好~',
    '行。那我去了',
    '[表情:思考] 这样啊',
  ];
  for (const s of safe) {
    check(strip(s) === s, `「${s}」原样不动`);
  }
}

{
  // 同类的"键盘符号"
  check(!/～/.test(strip('好～')), '全角波浪号去掉');
  check(strip('好~') === '好~', '**半角** ~ 保留（真人会这么打）');
  check(!/｜/.test(strip('A｜B')), '竖线换成逗号');
}

{
  // 空输入不能炸
  check(strip('') === '', '空字符串安全');
  check(strip(undefined) === '', 'undefined 安全');
}

// ════════════════════════════════════════════════════════════
// 【B】真进程：破折号处**要分条**
// ════════════════════════════════════════════════════════════
console.log('\n【B】破折号处要分条（真起机器人进程）');

const sentList = [];
let sock = null;

const llmServer = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {}
    const sys = parsed.messages?.find((m) => m.role === 'system')?.content ?? '';
    const sse = (text) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      for (const piece of text.match(/.{1,4}/gs) ?? [text]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    };
    const json = (text) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }));
    };

    // ⚠️ 规则同 cs/e2e：预搜索/规划要 **SSE**；判断类要 **JSON**；非流式要 **JSON**
    if (sys.includes('要不要上网查')) return sse('{"search":false,"why":"测试不搜"}');
    if (sys.includes('该搜什么')) return sse('测试关键词');
    if (sys.includes('假装成真人群友')) return json('{"speak":true,"why":"测试","length":"short"}');
    if (sys.includes('【归属核对】')) return json('{"ok":true}');
    if (parsed.stream !== true) return json('无');
    sse(REPLY_WITH_DASH);
  });
});

const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });
wss.on('connection', (ws, req) => {
  if ((req.headers.authorization ?? '') !== `Bearer ${TOKEN}`) return ws.close(1008);
  sock = ws;
  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    // ⚠️ 先抓消息再回 echo（机器人每次调用都带 echo）
    if (String(m.action ?? '').includes('send')) {
      const t = (Array.isArray(m.params?.message) ? m.params.message : [])
        .filter((s) => s.type === 'text')
        .map((s) => s.data.text)
        .join('');
      if (t) sentList.push(t);
    }
    if (m.echo !== undefined) {
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: m.echo }));
    }
  });
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

const botCfg = 'logs/__test-punct-run.yml';
writeFileSync(
  join(ROOT, botCfg),
  [
    'onebot:',
    '  mode: forward',
    `  url: ws://127.0.0.1:${WS_PORT}`,
    `  accessToken: "${TOKEN}"`,
    '  reconnectInterval: 300',
    'llm:',
    `  baseURL: http://127.0.0.1:${LLM_PORT}/v1`,
    '  apiKey: "sk-test-fake"',
    '  model: test-model',
    '  maxTokens: 200',
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
    '  port: 3110',
    'chat:',
    '  enable: false',
    'context:',
    '  enable: true',
    '  maxMessages: 30',
    'chunking:',
    '  maxChars: 60',
    '  delayMs: 50',
    '  firstFlushChars: 25',
    // 追补会多发一条，干扰"分了几条"的计数 —— 关掉
    'selfFollowUp:',
    '  enable: false',
    '',
  ].join('\n'),
  'utf8',
);

let proc = null;
let connected = false;

async function waitFor(fn, timeout = 15000, label = '条件') {
  const t = Date.now();
  while (Date.now() - t < timeout) {
    if (fn()) return true;
    await sleep(100);
  }
  console.log(`  ⏱  等待「${label}」超时`);
  return false;
}

async function main() {
  await new Promise((r) => llmServer.listen(LLM_PORT, '127.0.0.1', r));
  await new Promise((r) => (wss._server.listening ? r() : wss.once('listening', r)));

  proc = spawn(process.execPath, [join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      QQBOT_CONFIG: botCfg,
      ...(process.env.QQBOT_TRACE_DASH ? { QQBOT_TRACE_DASH: '1' } : {}),
      NO_PROXY: '127.0.0.1,localhost,::1',
      no_proxy: '127.0.0.1,localhost,::1',
    },
    stdio: process.env.QQBOT_TRACE_DASH ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'ignore', 'ignore'],
  });

  const ok = await waitFor(() => !!sock, 12000, 'WebSocket');
  check(ok, '机器人连上假 NapCat');
  if (!ok) return;

  sock.send(
    JSON.stringify({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 6001,
      group_id: GROUP_ID,
      user_id: USER_ID,
      self_id: SELF_ID,
      time: Math.floor(Date.now() / 1000),
      message: [
        { type: 'at', data: { qq: SELF_ID } },
        { type: 'text', data: { text: ' 你现在在哪租房子' } },
      ],
      sender: { user_id: USER_ID, nickname: '测试用户', role: 'member' },
    }),
  );

  await waitFor(() => sentList.length > 0, 15000, '回复');
  await sleep(2500); // 等分条发完

  console.log(`    实际发出 ${sentList.length} 条：`);
  for (const t of sentList) console.log(`      → ${JSON.stringify(t)}`);

  // ★ ① 输出里**不能有破折号**
  check(!sentList.some((t) => /—|―|─/.test(t)), '★ 发出去的文本里没有破折号');

  // ★ ② 破折号处**要分条**（用户：「我觉得完全可以分段」）
  check(sentList.length >= 2, `★ 断成了 ${sentList.length} 条（不是一整句发出来）`);

  // ★ ③ 内容不能丢字
  const joined = sentList.join('');
  for (const w of ['不大', '一个人住刚好', '你要来']) {
    check(joined.includes(w), `内容没丢：「${w}」`);
  }
}

// ⚠️⚠️ 2026-09-20 加：**分条切点的判据**（这条判据改错过三次，必须留哨兵）。
//
//    最后一次败在"流式 chunk 的边界不由我们控制"：原来要求「**末尾**是句末标点」，
//    而模型一次吐来整句时，句号落在**中间** → 末尾不是标点 → 不切。
//    下面第一条就是用户真实报的那条原文（群 200000001，23:05:28）。
console.log('\n[✓] 分条切点：找最后一个句末标点（不受 chunk 边界影响）');
{
  const real = '祥魔是什么鬼，你大半夜就琢磨这个（。我要是魔，头一个收拾的就是你';
  const n = firstSentenceBreak(real);
  check(n === 18, `★ 用户真实那句切在「（。」之后（得 ${n}）`);
  check(real.slice(0, n) === '祥魔是什么鬼，你大半夜就琢磨这个（。', '前半 = 到「（。」为止');
  check(real.slice(n) === '我要是魔，头一个收拾的就是你', '后半 = 剩下那句');
  check(firstSentenceBreak('这样吗？那算了') === 4, '★ 问号也切');
  check(firstSentenceBreak('太好了！我这就去') === 4, '★ 叹号也切');
  check(firstSentenceBreak('先这样；再说') === 4, '分号也切');
  check(firstSentenceBreak('没有标点的一句话') === -1, '没有句末标点 → 不切（-1）');
  check(firstSentenceBreak('') === -1, '空串 → -1');
}

// ⚠️⚠️ 2026-09-21 加（用户要求）：**分条间隔用随机数（1~2 秒），更像真人**。
//
//    用户原话：「分条消息的时间间隔可以用随机数，范围 1 秒到 2 秒吧，
//    这样更像真人在发消息」。
//    ⇒ 要害是「**每个分条点各摇一次**」：以前是进函数算一次、整条回复一个节奏，
//      那样即便那个值是随机的，看着照样机械（三段都等 1.5 秒）。
console.log('\n[✓] 分条间隔：区间随机 + 每段独立摇');
{
  const keep = { ...config.chunking };
  try {
    config.chunking.delayMs = 1000;
    config.chunking.delayMaxMs = 2000;
    const vals = Array.from({ length: 300 }, () => chunkDelay());
    check(
      vals.every((v) => v >= 1000 && v <= 2000),
      `★ 每次都在 1000~2000 之间（实测 ${Math.min(...vals)}~${Math.max(...vals)}）`,
    );
    check(new Set(vals).size > 30, `★ 确实是随机数（300 次里 ${new Set(vals).size} 种取值）`);
    check(
      !(vals[0] === vals[1] && vals[1] === vals[2]),
      '★ 连着摇不会都是同一个值（不是整条回复一个节奏）',
    );

    config.chunking.delayMs = 1000;
    config.chunking.delayMaxMs = 1001;
    const two = Array.from({ length: 300 }, () => chunkDelay());
    check(two.includes(1000) && two.includes(1001), '★ 上限取得到（1000 和 1001 都出现过）');

    config.chunking.delayMs = 700;
    delete config.chunking.delayMaxMs;
    check(
      chunkDelay() === 700 && chunkDelay() === 700,
      '★ 没配上限 → 不随机（等于原来的固定间隔，不动别人已有的手感）',
    );

    config.chunking.delayMs = 2000;
    config.chunking.delayMaxMs = 500;
    check(chunkDelay() === 2000, '★ 上限比下限小 → 按下限走（配置写反不倒着算）');
  } finally {
    Object.assign(config.chunking, keep);
  }
}

async function cleanup() {
  try {
    proc?.kill();
  } catch {}
  try {
    sock?.close();
  } catch {}
  await new Promise((r) => wss.close(r));
  await new Promise((r) => llmServer.close(r));
  for (const f of [CFG_REL, botCfg]) {
    try {
      rmSync(join(ROOT, f), { force: true });
    } catch {}
  }
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
