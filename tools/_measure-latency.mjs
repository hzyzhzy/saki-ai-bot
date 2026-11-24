import WebSocket from 'ws';
import fs from 'node:fs';
import yaml from 'js-yaml';

const c = yaml.load(fs.readFileSync('accounts/10000002.yml', 'utf8'));
const tok = c.onebot?.accessToken || '';

const ws = new WebSocket('ws://127.0.0.1:3001', { headers: { Authorization: 'Bearer ' + tok } });
await new Promise((res, rej) => {
  ws.on('open', res);
  ws.on('error', rej);
  setTimeout(() => rej(new Error('连不上')), 5000);
});

function api(action, params) {
  return new Promise((resolve) => {
    const echo = 'e' + Math.random().toString(36).slice(2, 8);
    const t0 = Date.now();
    const t = setTimeout(() => resolve({ timeout: true, ms: Date.now() - t0 }), 20000);
    const on = (d) => {
      const j = JSON.parse(d.toString());
      if (j.echo === echo) {
        clearTimeout(t);
        ws.off('message', on);
        resolve({ ...j, ms: Date.now() - t0 });
      }
    };
    ws.on('message', on);
    ws.send(JSON.stringify({ action, params, echo }));
  });
}

console.log('=== 轻量读操作 ===');
for (const a of ['get_status', 'get_login_info', 'get_group_list']) {
  const r = await api(a, {});
  console.log('  ' + a.padEnd(18) + String(r.ms).padStart(6) + ' ms  ' + (r.status || (r.timeout ? 'timeout' : '?')));
}

console.log('=== get_group_info × 20 ===');
const nums = [];
for (let i = 0; i < 20; i++) {
  const r = await api('get_group_info', { group_id: 200000007 });
  nums.push(r.ms);
}
nums.sort((a, b) => a - b);
console.log('  平均 ' + Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) + ' ms | 中位 ' + nums[10] + ' ms | 最快 ' + nums[0] + ' | 最慢 ' + nums[19]);

console.log('=== 发消息 × 3（都发到 200000007）===');
const sendMs = [];
for (let i = 1; i <= 3; i++) {
  const r = await api('send_group_msg', {
    group_id: 200000007,
    message: [{ type: 'text', data: { text: '[延迟测试 ' + i + '/3] ' + new Date().toLocaleTimeString('zh-CN') } }],
  });
  sendMs.push(r.ms);
  console.log('  第' + i + '次 ' + String(r.ms).padStart(6) + ' ms  ' + (r.status || (r.timeout ? 'timeout' : '?')));
  await new Promise((r2) => setTimeout(r2, 800));
}
sendMs.sort((a, b) => a - b);
console.log('  中位 ' + sendMs[1] + ' ms');

ws.close();
