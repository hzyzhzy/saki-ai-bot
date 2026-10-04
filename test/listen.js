/**
 * 纯净的 NapCat 事件探针：只连接并打印收到的事件，不做任何回执。
 * 用来判断「NapCat 到底有没有把群事件推给 WebSocket 客户端」。
 *
 * ⚠️ 绝不对事件回执 —— 曾经因为乱回 {status:'ok',echo} 把 NapCat 搞出错误风暴。
 *
 * 用法: node test/listen.js [秒数]
 */
import WebSocket from 'ws';

const URL = 'ws://127.0.0.1:3001';
// ⚠️ Token **不许写死在代码里**（2026-09-15 准备开源时清掉的），
//    一律从项目自己的 config.yml 读：onebot.accessToken
const TOKEN = (await import('../src/config.js')).config.onebot?.accessToken ?? '';
if (!TOKEN) { console.error('config.yml 里没读到 onebot.accessToken'); process.exit(2); }
const SECONDS = Number(process.argv[2] ?? 60);

const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${TOKEN}` } });
let count = 0;

ws.on('open', () => {
  console.log(`已连上 NapCat，监听 ${SECONDS} 秒…（请在群里发消息）\n`);
});

ws.on('message', (raw) => {
  let m;
  try {
    m = JSON.parse(raw.toString('utf8'));
  } catch {
    console.log('（收到非 JSON 数据）');
    return;
  }

  // 只观察，不回任何东西
  if (m.post_type) {
    count++;
    const kind =
      m.post_type === 'message'
        ? `${m.message_type}${m.group_id ? ` group=${m.group_id}` : ''} user=${m.user_id}`
        : m.post_type;
    const text = (() => {
      if (Array.isArray(m.message)) {
        return m.message.map((s) => (s.type === 'text' ? s.data.text : `[${s.type}]`)).join('');
      }
      return String(m.raw_message ?? m.message ?? '');
    })();
    console.log(`#${count} [${kind}] ${JSON.stringify(text)}`);
    return;
  }
  if (m.meta_event_type) {
    console.log(`（meta_event: ${m.meta_event_type}）`);
    return;
  }
  if (m.action) {
    console.log(`（某个客户端在调 API: ${m.action}）`);
    return;
  }
  // 其他（疑似被误当请求的回执）打印出来看看
  console.log('（收到其它消息）', JSON.stringify(m).slice(0, 150));
});

ws.on('error', (e) => {
  console.log(`连接失败: ${e.message}`);
  process.exit(1);
});

setTimeout(() => {
  console.log(`\n${SECONDS} 秒到，共收到 ${count} 个事件`);
  ws.close();
  process.exit(0);
}, SECONDS * 1000);
