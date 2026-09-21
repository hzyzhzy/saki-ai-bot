/**
 * 用真实素材生成并发布一条说说。
 *
 * 这是一次性脚本（用户在界面上也有「立刻发送」按钮）。
 * 用法: node test/post-qzone.js
 */
import WebSocket from 'ws';
import { config } from '../src/config.js';
import * as digest from '../src/digest.js';
import { compose } from '../src/qzone-compose.js';
import { publish, resetLimits } from '../src/qzone.js';

// 只放这一次的素材
const MATERIAL = [
  { name: 'LyUxion', text: '小豆机器人已经似了' },
  { name: 'LyUxion', text: '你怎么似了' },
  { name: '<主人>', text: '自己把自己修似了。' },
];

config.qzone.enable = true;
digest.clearAll();
digest.load(MATERIAL);
resetLimits();

console.log('=== 素材 ===');
console.log(digest.materialText());
console.log('\n=== 生成中 ===');

const d = await compose({});
console.log(JSON.stringify(d, null, 2));

if (!d.post) {
  console.log('\n→ 模型决定不发。没发布任何东西。');
  process.exit(0);
}

console.log('\n=== 发布 ===');
const ws = new WebSocket(config.onebot.url, {
  headers: { Authorization: `Bearer ${config.onebot.accessToken}` },
});
const pending = new Map();
let seq = 0;

const call = (action, params) =>
  new Promise((resolve, reject) => {
    const echo = `e${++seq}`;
    pending.set(echo, { resolve, reject });
    ws.send(JSON.stringify({ action, params, echo }));
    setTimeout(() => {
      if (pending.has(echo)) {
        pending.delete(echo);
        reject(new Error('超时'));
      }
    }, 60000);
  });

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.echo && pending.has(m.echo)) {
    const { resolve } = pending.get(m.echo);
    pending.delete(m.echo);
    resolve(m);
  }
});

await new Promise((r) => ws.on('open', r));

try {
  const r = await publish(call, { content: d.content, faceTag: d.face, type: d.type });
  console.log('✅ 已发布到 QQ 空间');
  console.log('   tid =', r?.tid ?? '(无)');
  console.log('   正文：');
  console.log('   ' + d.content.split('\n').join('\n   '));
  if (d.face) console.log('   配图表情：' + d.face);
} catch (e) {
  console.log('❌ 发布失败：' + e.message);
}

ws.close();
process.exit(0);
