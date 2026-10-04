/**
 * 身份态度验收：分别以服主 / 群友的身份问同类问题，对比回答口吻。
 * 用群聊注入（因为身份靠 sender.role 判断，私聊里没有角色信息）。
 *
 * 用法: node test/ask-attitude.js
 * 注意：运行前请先停掉机器人（NapCat 只允许单客户端）。
 */
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 39901;
const TOKEN = 'attitude-probe';
const BOT_QQ = '10000002';
const GROUP = '200000001';
const OWNER = { id: '10000001', role: 'owner', name: '<主人>' };
const MEMBER = { id: '30003', role: 'member', name: '某群友' };

// 用真实 config.yml，只改连接
writeFileSync(
  join(ROOT, 'config.attitude-probe.yml'),
  readFileSync(join(ROOT, 'config.yml'), 'utf8')
    .replace(/url:\s*ws:\/\/127\.0\.0\.1:\d+/, `url: ws://127.0.0.1:${PORT}`)
    .replace(/accessToken:\s*"[^"]*"/, `accessToken: "${TOKEN}"`),
  'utf8',
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const replies = [];
let sock = null;

const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' });
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
    if (m.action === 'send_group_msg' || m.action === 'send_private_msg') {
      const segs = m.params?.message ?? [];
      const text = segs.filter((s) => s.type === 'text').map((s) => s.data.text).join('');
      const imgs = segs.filter((s) => s.type === 'image').length;
      if (text.trim() || imgs) replies.push({ at: Date.now(), text: text.trim(), imgs });
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

let seq = 4000;

async function ask(who, text) {
  replies.length = 0;
  const mark = Date.now();
  sock.send(
    JSON.stringify({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: ++seq,
      group_id: GROUP,
      user_id: who.id,
      self_id: BOT_QQ,
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: who.id, nickname: who.name, role: who.role },
      message: [
        { type: 'at', data: { qq: BOT_QQ } },
        { type: 'text', data: { text: ` ${text}` } },
      ],
    }),
  );

  const started = Date.now();
  let last = Date.now();
  while (Date.now() - started < 45000) {
    await sleep(300);
    if (replies.length) last = Date.now();
    if (replies.length && Date.now() - last > 6000) break;
  }
  const parts = replies.filter((r) => r.at >= mark);
  return {
    text: parts.map((r) => r.text).filter(Boolean).join(''),
    imgs: parts.reduce((n, r) => n + r.imgs, 0),
    separate: parts.filter((r) => r.imgs && !r.text).length,
  };
}

let bot = null;

async function main() {
  console.log(`探针 ws://127.0.0.1:${PORT}\n`);
  bot = spawn(process.execPath, [join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      QQBOT_CONFIG: 'config.attitude-probe.yml',
      // ⚠️ 排除本机代理：假模型/假 NapCat 都跑在 127.0.0.1，
      //    如果 shell 里设了 NODE_USE_ENV_PROXY，不加这个假模型请求会走代理而失败
      NO_PROXY: '127.0.0.1,localhost,::1',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  const t = Date.now();
  while (!sock && Date.now() - t < 15000) await sleep(200);
  if (!sock) {
    console.error('机器人没连上探针');
    process.exitCode = 1;
    return;
  }

  const pairs = [
    ['服务器怎么进', '「服务器怎么进」'],
    ['这个模组是不是有问题', '「这个模组是不是有问题」'],
    ['帮我把禁言关了', '「帮我把禁言关了」'],
  ];

  for (const [q, label] of pairs) {
    console.log(`\n${'═'.repeat(66)}`);
    console.log(`问题：${label}`);
    console.log('─'.repeat(66));

    const a1 = await ask(OWNER, q);
    console.log(`【服主 <主人>】${a1.text || '（无回复）'}${a1.imgs ? `\n  〔+${a1.imgs} 张表情〕` : ''}`);

    const a2 = await ask(MEMBER, q);
    console.log(`\n【群友】${a2.text || '（无回复）'}${a2.imgs ? `\n  〔+${a2.imgs} 张表情〕` : ''}`);

    console.log(
      `\n  › 表情是否单发：服主 ${a1.separate} 条 / 群友 ${a2.separate} 条（>0 表示单独成条）`,
    );
    await sleep(1500);
  }
}

main()
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
