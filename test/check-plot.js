/**
 * 真实验收：聊剧情时会不会去搜、会不会再提「知识库」、会不会说「我没看过」。
 */
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WS_PORT = 41901;
const CFG = join(ROOT, 'config.plot.yml');
const OWNER = '10000001';

const sent = [];
let ws = null;
const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });
wss.on('connection', (s) => {
  ws = s;
  s.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.action === 'send_group_msg') {
      const t = (m.params?.message ?? []).filter((x) => x.type === 'text').map((x) => x.data.text).join('');
      const i = (m.params?.message ?? []).filter((x) => x.type === 'image').length;
      if (t.trim() || i) sent.push(t.trim());
    }
    if (m.echo !== undefined) s.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: m.echo }));
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
    .replace(/accessToken:\s*"?[^"\r\n]*"?/, 'accessToken: "plot"')
    .replace(/respondTo:\s*\d/, 'respondTo: 2'),
  'utf8',
);

const proc = spawn(process.execPath, [join(ROOT, 'src', 'index.js')], {
  cwd: ROOT,
    env: {
      ...process.env,
      QQBOT_CONFIG: 'config.plot.yml',
      // ⚠️ 排除本机代理：假模型/假 NapCat 都跑在 127.0.0.1，
      //    如果 shell 里设了 NODE_USE_ENV_PROXY，不加这个假模型请求会走代理而失败
      NO_PROXY: '127.0.0.1,localhost,::1',
    },
  stdio: ['ignore', 'ignore', 'ignore'],
});
const t0 = Date.now();
while (!ws && Date.now() - t0 < 15000) await sleep(150);
await sleep(1500);

const say = (text, id) => {
  ws.send(JSON.stringify({
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    message_id: id, group_id: '200000001', user_id: OWNER, self_id: '10000002',
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: OWNER, nickname: '<主人>', role: 'owner' },
    message: [{ type: 'at', data: { qq: '10000002' } }, { type: 'text', data: { text } }],
  }));
};

async function ask(label, text, id) {
  sent.length = 0;
  console.log(`\n${'─'.repeat(58)}`);
  console.log(`【${label}】<主人>：${text}`);
  say(text, id);
  const t = Date.now();
  while (!sent.length && Date.now() - t < 90000) await sleep(400);
  await sleep(6000);
  const reply = sent.join('\n');
  console.log(`小祥：${reply || '（没有回复）'}`);
  // 检查禁忌词
  const bad = [
    ['我没看过', /我没看过|我没追|我回头补|我没细看/],
    ['提知识库', /知识库|喂我|写进|补进/],
    ['让你找服主', /问 ?<主人>|找服主/],
    ['说料不多', /料不多|了解不多|不太了解这部/],
  ];
  for (const [name, re] of bad) {
    if (re.test(reply)) console.log(`  ⚠️ 出现了「${name}」`);
  }
  return reply;
}

console.log('=== 聊剧情验收（真模型）===');
await ask('先建立话题', '你看过梦限大了吗', 9001);
await ask('追问剧情', '你能聊聊剧情吗', 9002);
await ask('追更细的', '第一集讲了什么', 9003);

proc.kill();
await new Promise((r) => wss.close(r));
try { unlinkSync(CFG); } catch {}
