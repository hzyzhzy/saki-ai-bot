/**
 * 真实链路验证：通过 NapCat 注入一条「群友 @ 机器人提问」的消息，
 * 观察机器人是否真的处理并回复。
 *
 * 注意：NapCat 通常只允许一个客户端。如果被拒，就先停机器人再跑。
 * 用法: node test/inject.js "问题内容" [群号]
 */
import WebSocket from 'ws';

const URL = 'ws://127.0.0.1:3001';
// ⚠️ Token **不许写死在代码里**（2026-09-15 准备开源时清掉的），
//    一律从项目自己的 config.yml 读：onebot.accessToken
const TOKEN = (await import('../src/config.js')).config.onebot?.accessToken ?? '';
if (!TOKEN) { console.error('config.yml 里没读到 onebot.accessToken'); process.exit(2); }
const BOT_QQ = '10000002';
const GROUP = process.argv[3] ?? '200000001';
const QUESTION = process.argv[2] ?? '服务器怎么进啊？';
// 用一个不是机器人自己的号发，避免被「忽略自己发的消息」挡掉
const SENDER = '30003';

const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${TOKEN}` } });
const pending = new Map();
let echoSeq = 0;
const t = setTimeout(() => {
  console.log('超时：没收到回复');
  process.exit(1);
}, 60000);

let opened = false;
const replies = [];

ws.on('open', () => {
  opened = true;
  console.log(`已连上 NapCat，注入消息：@它 "${QUESTION}"`);
  ws.send(
    JSON.stringify({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: Math.floor(Math.random() * 1e9),
      group_id: GROUP,
      user_id: SENDER,
      self_id: BOT_QQ,
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: SENDER, nickname: '测试探针', role: 'member' },
      message: [
        { type: 'at', data: { qq: BOT_QQ } },
        { type: 'text', data: { text: ` ${QUESTION}` } },
      ],
    }),
  );
});

ws.on('message', (raw) => {
  let m;
  try {
    m = JSON.parse(raw.toString('utf8'));
  } catch {
    return;
  }

  // ⚠️⚠️ 极其重要：只对「我们自己发的请求」回执。
  //    如果对 NapCat 推来的事件也回一个 {status:'ok', echo}，那个回执缺 action 字段，
  //    NapCat 会报「不支持的API undefined」，然后把这个无效回执当成请求回给客户端，
  //    形成错误风暴，**并且会持久污染 NapCat 的 WS 服务端配置**（曾经把服务搞坏过）。
  if (m.echo !== undefined && pending.has(m.echo)) {
    pending.delete(m.echo);
    return;
  }
  // 事件（没有 echo）直接忽略，绝不回执
  if (!m.action) return;

  // 机器人的回复会以 send_group_msg 动作发出来
  if (m.action === 'send_group_msg') {
    const text = (m.params?.message ?? [])
      .filter((s) => s.type === 'text')
      .map((s) => s.data.text)
      .join('');
    const imgs = (m.params?.message ?? []).filter((s) => s.type === 'image').length;
    if (text.trim() || imgs) {
      replies.push(text.trim());
      console.log(`\n✅ 机器人回复：${text.trim()}${imgs ? `\n   〔+${imgs} 张表情〕` : ''}`);
    }
  }
});

ws.on('error', (e) => {
  console.log(`连接失败: ${e.message}`);
  if (!opened) {
    console.log('→ NapCat 只允许一个客户端，机器人正占着。要么先停机器人，要么这条路走不通。');
  }
  clearTimeout(t);
  process.exit(1);
});

// 收满或在静默后退出
let last = Date.now();
setInterval(() => {
  if (replies.length && Date.now() - last > 6000) {
    clearTimeout(t);
    console.log(`\n共 ${replies.length} 条回复`);
    process.exit(0);
  }
  if (replies.length) last = Date.now();
}, 1000);
