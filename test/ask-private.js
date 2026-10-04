/**
 * 私聊验收：注入若干私聊提问，捕获机器人的真实回答，检查客服回答质量。
 * 不往群里发消息，不会打扰群友。
 *
 * 注意：NapCat 的 WS 服务端只接受一个客户端。运行前请先停掉正在跑的机器人，
 * 本脚本会自己起一个（用探针端口和探针 token，不碰 NapCat）。
 *
 * 用法: node test/ask-private.js             跑内置问题集
 *       node test/ask-private.js "你的问题"   只问一个
 */
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 39401;
const TOKEN = 'probe-token';
const BOT_QQ = '10000002';
const ASKER = '10000001'; // 用群主的号当提问者

const DEFAULT_QUESTIONS = [
  '新人怎么进服务器啊，需要白名单吗',
  '我Mac玩老是崩，怎么办',
  '车辆隐形了看不见是怎么回事',
  '现在服务器有几个人在线',
  '我想在首都修个车站，需要申请吗',
  '这个服务器支持Fabric吗',
  '你会做什么',
];

const args = process.argv.slice(2);
const questions = args.length ? [args.join(' ')] : DEFAULT_QUESTIONS;

// 用真实 config.yml 生成一份探针配置（只改连接相关）
const cfgFile = 'config.probe.yml';
const base = readFileSync(join(ROOT, 'config.yml'), 'utf8');
writeFileSync(
  join(ROOT, cfgFile),
  base
    .replace(/url:\s*ws:\/\/127\.0\.0\.1:\d+/, `url: ws://127.0.0.1:${PORT}`)
    // ⚠️⚠️ `accessToken` 在 `config.yml` 里是**不带引号**的（`accessToken: islbjh…`）。
    //    这里原来要求**有引号**（`"[^"]*"`）→ **根本匹配不上** →
    //    密钥没被换掉 → 探针服务器鉴权失败 → 机器人连上就被踢 →
    //    表现为"机器人没连上来"。2026-09-14 写另一个探针时踩到的就是这个。
    //    引号可有可无才是对的（`"?…"?`）。
    .replace(/accessToken:\s*"?[^"\r\n]*"?/, `accessToken: "${TOKEN}"`)
    .replace(/^ {2}debugInjectIds:\n(?: {4}- .*\n)+/m, ''),
  'utf8',
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const replies = [];
let sock = null;

const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' });
wss.on('connection', (ws, req) => {
  if ((req.headers.authorization ?? '') !== `Bearer ${TOKEN}`) {
    console.error('鉴权失败:', req.headers.authorization);
    ws.close(1008);
    return;
  }
  sock = ws;
  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    // 动作调用：先捕获，再回执（顺序很重要）
    if (m.action === 'send_private_msg' || m.action === 'send_group_msg') {
      const segs = m.params?.message ?? [];
      const text = segs.filter((s) => s.type === 'text').map((s) => s.data.text).join('');
      const images = segs.filter((s) => s.type === 'image').map((s) => s.data.file);
      if (text.trim() || images.length) replies.push({ at: Date.now(), text: text.trim(), images });
    }
    if (m.echo !== undefined) {
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: m.echo }));
    }
  });
  ws.send(
    JSON.stringify({
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
      self_id: BOT_QQ,
      time: Math.floor(Date.now() / 1000),
    }),
  );
});

async function ask(question) {
  replies.length = 0;
  const mark = Date.now();
  sock.send(
    JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: Math.floor(Math.random() * 1e9),
      user_id: ASKER,
      self_id: BOT_QQ,
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: ASKER, nickname: '<主人>' },
      message: [{ type: 'text', data: { text: question } }],
    }),
  );

  // 分条发送：机器人会把长回答拆成多条（间隔 0.4s），
  // 所以要等到「连续一段时间没有新消息」才算说完。加硬上限防止挂死。
  const started = Date.now();
  const IDLE_MS = 6000;
  const MAX_MS = 45000;
  let last = Date.now();
  while (Date.now() - started < MAX_MS) {
    await sleep(300);
    if (replies.length) last = Date.now();
    if (replies.length && Date.now() - last > IDLE_MS) break;
  }
  const parts = replies.filter((r) => r.at >= mark);
  const answer = parts.map((r) => r.text).filter(Boolean).join('');
  const images = parts.flatMap((r) => r.images ?? []);
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`问：${question}`);
  console.log('─'.repeat(64));
  console.log(answer || '（没有文字回复）');
  if (images.length) {
    console.log(`\n📎 附带表情包 ${images.length} 张：`);
    for (const f of images) console.log(`   ${f.split(/[\\/]/).pop()}`);
  } else {
    console.log('\n（没有发表情包）');
  }
  if (parts.length > 1) console.log(`（文字分 ${parts.filter((p) => p.text).length} 条发送）`);
  return { text: answer, images };
}

let bot = null;

(async () => {
  console.log(`探针 ws://127.0.0.1:${PORT}，启动机器人…\n`);
  bot = spawn(process.execPath, [join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, QQBOT_CONFIG: cfgFile },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  const t = Date.now();
  while (!sock && Date.now() - t < 15000) await sleep(200);
  if (!sock) {
    console.error('机器人没有连上探针');
    process.exitCode = 1;
    return;
  }

  const answers = [];
  const outFile = join(ROOT, 'test', 'answers.json');
  const flush = () => writeFileSync(outFile, JSON.stringify(answers, null, 2), 'utf8');
  for (const q of questions) {
    answers.push({ q, a: await ask(q) });
    flush(); // 增量写盘，中途超时也不丢已问到的结果
    await sleep(1200);
  }
  console.log(`\n回答已存到 test/answers.json`);
})()
  .catch((e) => {
    console.error('出错:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      bot?.kill();
    } catch {}
    await new Promise((r) => wss.close(r));
    process.exit(process.exitCode ?? 0);
  });
