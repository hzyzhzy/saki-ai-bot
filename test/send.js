// 让当前登录的机器人账号给指定 QQ 发一条消息。
import WebSocket from 'ws';

const URL = 'ws://127.0.0.1:3001';
// ⚠️ Token **不许写死在代码里**（2026-09-15 准备开源时清掉的），
//    一律从项目自己的 config.yml 读：onebot.accessToken
const TOKEN = (await import('../src/config.js')).config.onebot?.accessToken ?? '';
if (!TOKEN) { console.error('config.yml 里没读到 onebot.accessToken'); process.exit(2); }
const [target, ...rest] = process.argv.slice(2);

if (!target) {
  console.error('用法: node test/send.js <目标QQ号> [消息内容...]');
  process.exit(2);
}

const text = rest.length
  ? rest.join(' ')
  : [
      '🤖 这是我的运行状态',
      '',
      '账号：10000002（ZYHG）',
      '状态：在线，NapCat 后台运行中',
      '能力：已接入 DeepSeek，可群聊 / 私聊对话',
      '',
      '现在没有图形界面，但你随时可以：',
      '· 私聊我直接对话',
      '· 在群里 @我',
      '· 发「清空对话」重置上下文',
    ].join('\n');

const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${TOKEN}` } });

ws.on('open', () => {
  ws.send(
    JSON.stringify({
      action: 'send_private_msg',
      params: { user_id: String(target), message: [{ type: 'text', data: { text } }] },
      echo: 'e1',
    }),
  );
});

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString('utf8'));
  if (m.echo !== 'e1') return;
  if (m.status === 'ok' || m.retcode === 0) {
    console.log(`已发送给 ${target}，message_id = ${m.data?.message_id}`);
  } else {
    console.error('发送失败:', JSON.stringify(m));
    process.exitCode = 1;
  }
  ws.close();
});

ws.on('error', (e) => {
  console.error('连接失败:', e.message);
  process.exitCode = 1;
});

setTimeout(() => {
  console.error('超时');
  process.exitCode = 1;
  ws.close();
}, 20000).unref();
