// 两轮实测：验证"对面说的话不会被当成自己的/被当成转述"
//   第 1 轮：Anon 说「我最喜欢蓝色」
//   第 2 轮：Anon 问「我平时喜欢什么来着」
//   期望：她答「你说过你喜欢蓝色」之类 —— 主语是"你"，不是"我"
import WebSocket from 'ws';
import fs from 'node:fs';
import yaml from 'js-yaml';

const acc = yaml.load(fs.readFileSync('accounts/10000013.yml', 'utf8'));
const tok = acc.onebot?.accessToken || '';
const GID = 200000007;

const ws = new WebSocket('ws://127.0.0.1:3002', { headers: { Authorization: 'Bearer ' + tok } });
await new Promise((res, rej) => {
  ws.on('open', res);
  ws.on('error', rej);
  setTimeout(() => rej(new Error('连不上')), 8000);
});
function api(a, p, to = 30000) {
  return new Promise((resolve) => {
    const e = 'e' + Math.random().toString(36).slice(2, 7);
    const t = setTimeout(() => resolve({ timeout: true }), to);
    const on = (d) => {
      const j = JSON.parse(d.toString());
      if (j.echo === e) {
        clearTimeout(t);
        ws.off('message', on);
        resolve(j);
      }
    };
    ws.on('message', on);
    ws.send(JSON.stringify({ action: a, params: p, echo: e }));
  });
}
const say = (txt) =>
  api('send_group_msg', {
    group_id: GID,
    message: [{ type: 'at', data: { qq: '10000002' } }, { type: 'text', data: { text: ' ' + txt } }],
  });

console.log('第 1 轮：我最喜欢蓝色');
console.log('  ', JSON.stringify(await say('我最喜欢蓝色')).slice(0, 60));
ws.close();
