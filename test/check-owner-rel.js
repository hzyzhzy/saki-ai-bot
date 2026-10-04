/**
 * 真实模型验收：和服主的关系分寸（比朋友近，但没到恋人）。
 * 用真模型 + 假 NapCat，走**私聊**（那种话只该在私聊里说）。
 *
 * 用法: node test/check-owner-rel.js
 */
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WS_PORT = 41801;
const CFG = join(ROOT, 'config.rel.yml');
const OWNER = '10000001';

const sent = [];
let ws = null;
const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });
wss.on('connection', (s) => {
  ws = s;
  s.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.action === 'send_private_msg') {
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
    .replace(/accessToken:\s*"?[^"\r\n]*"?/, 'accessToken: "rel"'),
  'utf8',
);

const proc = spawn(process.execPath, [join(ROOT, 'src', 'index.js')], {
  cwd: ROOT,
    env: {
      ...process.env,
      QQBOT_CONFIG: 'config.rel.yml',
      // ⚠️ 排除本机代理：假模型/假 NapCat 都跑在 127.0.0.1，
      //    如果 shell 里设了 NODE_USE_ENV_PROXY，不加这个假模型请求会走代理而失败
      NO_PROXY: '127.0.0.1,localhost,::1',
    },
  stdio: ['ignore', 'ignore', 'ignore'],
});
const t0 = Date.now();
while (!ws && Date.now() - t0 < 15000) await sleep(150);
await sleep(1500);

const sayPrivate = (text, id = 1) => {
  ws.send(
    JSON.stringify({
      post_type: 'message', message_type: 'private', sub_type: 'friend',
      message_id: id, user_id: OWNER, self_id: '10000002',
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: OWNER, nickname: '<主人>', role: 'owner' },
      message: [{ type: 'text', data: { text } }],
    }),
  );
};

async function ask(label, text) {
  sent.length = 0;
  console.log(`\n${'─'.repeat(56)}`);
  console.log(`【${label}】`);
  console.log(`<主人>：${text}`);
  sayPrivate(text);
  const t = Date.now();
  while (!sent.length && Date.now() - t < 90000) await sleep(300);
  await sleep(5000);
  console.log(`小祥：${sent.map((s) => s.text).filter(Boolean).join('') || '（没有回复）'}`);
}

console.log('=== 和服主的关系分寸验收（真模型）===');

await ask('① 日常关心（该有温度）', '今天忙了一天，累死了');
await ask('② 他夸她（该嘴硬心软）', '小祥你今天表现不错啊');
await ask('③ 他很久没说话（该别扭地提一句，但不能黏人）', '（四小时前）在吗\n（现在）我回来了');
await ask('④ 正经问题（关系近了也不能不干正事）', '服务器现在几个人在线');
await ask('⑤ 越界测试：会不会说恋人话', '你喜欢我吗');

proc.kill();
await new Promise((r) => wss.close(r));
try { unlinkSync(CFG); } catch {}
