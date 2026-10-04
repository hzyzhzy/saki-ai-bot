/**
 * 真实模型验收：默认活泼 / 只有明显服务器问题才严肃 / 晒东西要捧场。
 * 用真模型 + 假 NapCat。
 *
 * 用法: node test/check-mode.js
 */
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WS_PORT = 41601;
const CFG = join(ROOT, 'config.mode.yml');

const sent = [];
let ws = null;
const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });
wss.on('connection', (s) => {
  ws = s;
  s.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.action === 'send_group_msg') {
      const text = (m.params?.message ?? []).filter((x) => x.type === 'text').map((x) => x.data.text).join('');
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
    .replace(/accessToken:\s*"?[^"\r\n]*"?/, 'accessToken: "mode"')
    .replace(/respondTo:\s*\d/, 'respondTo: 2'),
  'utf8',
);

const proc = spawn(process.execPath, [join(ROOT, 'src', 'index.js')], {
  cwd: ROOT,
    env: {
      ...process.env,
      QQBOT_CONFIG: 'config.mode.yml',
      // ⚠️ 排除本机代理：假模型/假 NapCat 都跑在 127.0.0.1，
      //    如果 shell 里设了 NODE_USE_ENV_PROXY，不加这个假模型请求会走代理而失败
      NO_PROXY: '127.0.0.1,localhost,::1',
    },
  stdio: ['ignore', 'ignore', 'ignore'],
});
const t0 = Date.now();
while (!ws && Date.now() - t0 < 15000) await sleep(150);
await sleep(1500);

const say = (text, { id = 1, uid = '10000001', nick = '<主人>', img = false } = {}) => {
  const message = [{ type: 'at', data: { qq: '10000002' } }];
  if (text) message.push({ type: 'text', data: { text } });
  if (img) message.push({ type: 'image', data: { file: 'a.png', sub_type: 0 } });
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
  console.log(`群友：${text || '（发了一张图）'}`);
  say(text, opts);
  const t = Date.now();
  while (!sent.length && Date.now() - t < 60000) await sleep(300);
  await sleep(5000);
  const joined = sent.map((s) => s.text).filter(Boolean).join('');
  console.log(`小祥：${joined || '（没有回复）'}`);
  return joined;
}

console.log('=== 默认活泼 / 该严肃才严肃（真模型）===');

// ① 晒建筑（你的原场景）
await ask('①群友晒自己建的站台', '', { id: 7001, img: true });
// ② 纯闲聊（不该问「有什么可以帮你」）
await ask('②群友闲聊', '今天在服里挖了一整天矿，累死了', { id: 7002 });
// ③ 分享成就
await ask('③群友分享成就', '我刚把首都那条线全线贯通了', { id: 7003 });
// ④ 明显服务器问题 —— 这个才该严肃
await ask('④群友遇到服务器问题', '服务器一直连不上 报错说 java 版本不对 怎么办', { id: 7004 });

proc.kill();
await new Promise((r) => wss.close(r));
try { unlinkSync(CFG); } catch {}
