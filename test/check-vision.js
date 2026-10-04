/**
 * 端到端验收：群里有人发图 → 机器人下载 → 视觉模型识别 → 带着描述回答。
 *
 * 用真模型 + 假 NapCat。假 NapCat 会：
 *   - 响应 get_image，返回我们指定的本地图片路径
 *   - 记录机器人发出的回复
 *
 * 用法: node test/check-vision.js [图片路径]
 */
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { writeFileSync, readFileSync, unlinkSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WS_PORT = 41701;
const CFG = join(ROOT, 'config.vision-test.yml');

const srcImg = process.argv[2] ?? join(ROOT, 'library', '79355357d2ef9088b29b560ad15f0663.png');
// NapCat 的 get_image 返回的是本地路径，我们伪造一个
const fakePath = join(ROOT, 'test', '_fake-image.png');
copyFileSync(srcImg, fakePath);

const sent = [];
const getImageCalls = [];
let ws = null;

const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });
wss.on('connection', (s) => {
  ws = s;
  s.on('message', (raw) => {
    const m = JSON.parse(raw.toString());

    if (m.action === 'get_image') {
      getImageCalls.push(m.params);
      s.send(
        JSON.stringify({ status: 'ok', retcode: 0, data: { file: fakePath }, echo: m.echo }),
      );
      return;
    }
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
    .replace(/accessToken:\s*"?[^"\r\n]*"?/, 'accessToken: "vision"')
    .replace(/respondTo:\s*\d/, 'respondTo: 2'),
  'utf8',
);

const proc = spawn(process.execPath, [join(ROOT, 'src', 'index.js')], {
  cwd: ROOT,
    env: {
      ...process.env,
      QQBOT_CONFIG: 'config.vision-test.yml',
      // ⚠️ 排除本机代理：假模型/假 NapCat 都跑在 127.0.0.1，
      //    如果 shell 里设了 NODE_USE_ENV_PROXY，不加这个假模型请求会走代理而失败
      NO_PROXY: '127.0.0.1,localhost,::1',
    },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const logs = [];
proc.stdout.on('data', (d) => logs.push(String(d).trim()));
proc.stderr.on('data', (d) => logs.push(String(d).trim()));

const t0 = Date.now();
while (!ws && Date.now() - t0 < 15000) await sleep(150);
await sleep(1500);

const sayImage = (text, { id = 1, uid = '10000001', nick = '<主人>', subType = 0 } = {}) => {
  const message = [{ type: 'at', data: { qq: '10000002' } }];
  if (text) message.push({ type: 'text', data: { text } });
  message.push({ type: 'image', data: { file: 'fake.jpg', sub_type: subType } });
  ws.send(
    JSON.stringify({
      post_type: 'message', message_type: 'group', sub_type: 'normal',
      message_id: id, group_id: '200000001', user_id: uid, self_id: '10000002',
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: uid, nickname: nick, role: 'owner' }, message,
    }),
  );
};

console.log(`=== 识图端到端验收（图片：${srcImg.split(/[\\/]/).pop()}）===\n`);

sent.length = 0;
getImageCalls.length = 0;
console.log('群友：@它 + 一张图');
sayImage('');
const t = Date.now();
while (!sent.length && Date.now() - t < 120000) await sleep(500);
await sleep(6000);

console.log(`\n取图调用次数: ${getImageCalls.length}`);
console.log(`\n小祥：${sent.map((s) => s.text).filter(Boolean).join('') || '（没有回复）'}`);

if (logs.some((l) => l.includes('识图完成'))) {
  console.log('\n✅ 识图链路跑通了');
  const line = logs.find((l) => l.includes('识图完成'));
  console.log('   ' + line);
} else {
  console.log('\n❌ 没有看到识图日志');
  console.log('   日志尾部:');
  logs.slice(-8).forEach((l) => console.log('     ' + l));
}

proc.kill();
await new Promise((r) => wss.close(r));
try { unlinkSync(CFG); unlinkSync(fakePath); } catch {}
