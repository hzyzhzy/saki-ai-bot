/**
 * 真实模型验收：群友晒建筑截图时该捧场，不是问「你要我看哪部分」。
 * 用真模型 + 假 NapCat。
 *
 * 用法: node test/check-share.js
 */
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WS_PORT = 41501;
const TOKEN = 'share';
const CFG = join(ROOT, 'config.share.yml');

const sent = [];
let ws = null;
const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });
wss.on('connection', (s) => {
  ws = s;
  s.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.action === 'send_group_msg') {
      const text = (m.params?.message ?? [])
        .filter((x) => x.type === 'text')
        .map((x) => x.data.text)
        .join('');
      const imgs = (m.params?.message ?? []).filter((x) => x.type === 'image').length;
      if (text.trim() || imgs) sent.push({ text: text.trim(), imgs });
    }
    if (m.echo !== undefined) {
      s.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: m.echo }));
    }
  });
  s.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle', self_id: '10000002', time: 1 }));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await new Promise((r) => (wss._server.listening ? r() : wss.once('listening', r)));

const base = readFileSync(join(ROOT, 'config.yml'), 'utf8');
writeFileSync(
  CFG,
  base
    .replace(/url:\s*ws:\/\/127\.0\.0\.1:\d+/, `url: ws://127.0.0.1:${WS_PORT}`)
    .replace(/accessToken:\s*"?[^"\r\n]*"?/, `accessToken: "${TOKEN}"`)
    .replace(/respondTo:\s*\d/, 'respondTo: 2'),
  'utf8',
);

const proc = spawn(process.execPath, [join(ROOT, 'src', 'index.js')], {
  cwd: ROOT,
    env: {
      ...process.env,
      QQBOT_CONFIG: 'config.share.yml',
      // ⚠️ 排除本机代理：假模型/假 NapCat 都跑在 127.0.0.1，
      //    如果 shell 里设了 NODE_USE_ENV_PROXY，不加这个假模型请求会走代理而失败
      NO_PROXY: '127.0.0.1,localhost,::1',
    },
  stdio: ['ignore', 'ignore', 'ignore'],
});
const t0 = Date.now();
while (!ws && Date.now() - t0 < 15000) await sleep(150);
await sleep(1500);

/** 发一条带图的消息（subType 1=表情包，其他=普通图片） */
const sayImage = (text, { id = 1, uid = '10000001', nick = '<主人>', imgSubType = 0 } = {}) => {
  const message = [];
  if (text) message.push({ type: 'text', data: { text } });
  message.push({ type: 'image', data: { file: 'test.png', sub_type: imgSubType } });
  ws.send(
    JSON.stringify({
      post_type: 'message', message_type: 'group', sub_type: 'normal',
      message_id: id, group_id: '200000001', user_id: uid, self_id: '10000002',
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: uid, nickname: nick, role: 'owner' }, message,
    }),
  );
};

async function ask(label, text, opts = {}) {
  sent.length = 0;
  console.log(`\n${'─'.repeat(58)}`);
  console.log(`【${label}】`);
  sayImage(text, opts);
  const t = Date.now();
  while (!sent.length && Date.now() - t < 60000) await sleep(300);
  await sleep(5000);
  const joined = sent.map((s) => s.text).filter(Boolean).join('');
  console.log(`小祥：${joined || '（没有回复）'}`);
  return joined;
}

console.log('=== 晒建筑场景验收（真模型）===');

// 你的原场景：只发一张服务器建筑截图，没配文字
await ask('场景1：群友发了张自己建的站台截图（没配文字）', '', { id: 8001, imgSubType: 0 });
await ask('场景2：换个群友再晒一张（没配文字）', '', { id: 8002, uid: '10000003', nick: '某群友', imgSubType: 0 });

// 对比：真的是报错截图
await ask('场景3（对比）：配了文字说明是报错', '这个一直报错 怎么弄', { id: 8003, uid: '30003', nick: '群友', imgSubType: 0 });

proc.kill();
await new Promise((r) => wss.close(r));
try { unlinkSync(CFG); } catch {}
