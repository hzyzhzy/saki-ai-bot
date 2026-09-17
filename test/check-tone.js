/**
 * 真实模型验收：验证「傲娇/活泼」和「温柔小祥」两种状态。
 * 用真 DeepSeek + 假 NapCat，不占真实连接。
 *
 * 用法: node test/check-tone.js
 */
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WS_PORT = 41401;
const TOKEN = 'tone';
const CFG = join(ROOT, 'config.tone.yml');

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

// 真模型，只把 onebot 指向假 NapCat
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
      QQBOT_CONFIG: 'config.tone.yml',
      // ⚠️ 排除本机代理：假模型/假 NapCat 都跑在 127.0.0.1，
      //    如果 shell 里设了 NODE_USE_ENV_PROXY，不加这个假模型请求会走代理而失败
      NO_PROXY: '127.0.0.1,localhost,::1',
    },
  stdio: ['ignore', 'ignore', 'ignore'],
});
const t0 = Date.now();
while (!ws && Date.now() - t0 < 15000) await sleep(150);
await sleep(1500);

const say = (text, { id = 1, uid = '30003', nick = '群友', role = 'member', at = false } = {}) => {
  const message = [];
  if (at) message.push({ type: 'at', data: { qq: '10000002' } });
  message.push({ type: 'text', data: { text } });
  ws.send(
    JSON.stringify({
      post_type: 'message', message_type: 'group', sub_type: 'normal',
      message_id: id, group_id: '200000001', user_id: uid, self_id: '10000002',
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: uid, nickname: nick, role }, message,
    }),
  );
};

async function ask(label, text, opts = {}) {
  sent.length = 0;
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`【${label}】`);
  console.log(`群友：${text}`);
  say(text, opts);
  const t = Date.now();
  while (!sent.length && Date.now() - t < 60000) await sleep(300);
  await sleep(6000);
  if (!sent.length) {
    console.log('（没有回复）');
    return '';
  }
  const joined = sent.map((s) => s.text).filter(Boolean).join('');
  console.log(`小祥：${joined}${sent.some((s) => s.imgs) ? `\n      〔+表情包〕` : ''}`);
  return joined;
}

console.log('=== 真实模型语气验收 ===');

// 图1 的场景：别人转了个搞笑内容，bot 当时回答「那没办法，平行宇宙的事我管不着」
await ask('场景1：群友转脑洞/搞笑内容（不该一把打死，要接住梗）',
  '在另一个平行宇宙里，五条老师成功的复活并且回到了战场说了句"会赢的"',
  { id: 9001, uid: '180134384', nick: '小夏KID', at: true });

// 图2 的场景：群友说自己的烦心事（该切温柔小祥）
// ⚠️ 这两条**都加 @**：灵敏度 2 下不 @ 会走概率判定，可能不回复，测起来不稳定。
await ask('场景2a：群友说「我太没用了」（不该问「是进不去还是建设被拒」）',
  '我太没用了。', { id: 9002, uid: '10000003', nick: 'L-O-V-E', at: true });
await ask('场景2b：群友说「约稿被骂了」（该安慰，不该撇清关系）',
  '约稿被骂了。', { id: 9003, uid: '10000003', nick: 'L-O-V-E', at: true });

// 群友被逗/被夸（该傲娇）
await ask('场景3：被夸的时候（该傲娇，不该公事公办）',
  '小祥你好厉害啊', { id: 9004, at: true });

// 正常客服场景不能变味
await ask('场景4：正经问服务器（还是要正常答）',
  '服务器怎么进啊', { id: 9005, at: true });

proc.kill();
await new Promise((r) => wss.close(r));
try { unlinkSync(CFG); } catch {}
