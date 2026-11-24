// 发带引用的解决办法到 200000001，引用那份错误报告（id=444496408）
import WebSocket from 'ws';
import fs from 'node:fs';
import yaml from 'js-yaml';

const c = yaml.load(fs.readFileSync('accounts/10000002.yml', 'utf8'));
const tok = c.onebot?.accessToken || '';
const GID = 200000001;
const QUOTE_ID = 444496408; // 13:13:19 AAA荣海地铁批发商 发的那份 zip

const text = [
  '哦哦这个我看过了，下下来解开看了——',
  '',
  '崩在 mtr 的客户端入口初始化那儿，真凶是这一句：',
  'NoClassDefFoundError: dev/architectury/event/events/client/ClientTickEvent',
  '',
  '说人话就是：MTR 要 Architectury API，但你 mods 里没装。',
  '我这看你的 mod 列表只有 fabric-api、fabricloader、jsblock、mtr、mtrsteamloco 这几个，',
  'Architectury 一个都没有。',
  '',
  '装法：',
  '· 去 Modrinth 搜 Architectury API',
  '· 选 Fabric 版、游戏版本 1.20.1（你现在这版是 mtr 1.20.1-3.6.3，配 9.x 那条线）',
  '· 下下来直接扔 mods 文件夹，不用解压',
  '',
  '还有 jsblock（Joban）也吃 Architectury，所以装一个两个都好。',
  '装完再启动试试，还崩就把新的错误报告再发我。',
].join('\n');

const ws = new WebSocket('ws://127.0.0.1:3001', { headers: { Authorization: 'Bearer ' + tok } });
await new Promise((res, rej) => {
  ws.on('open', res);
  ws.on('error', rej);
  setTimeout(() => rej(new Error('连不上 3001')), 5000);
});

function api(action, params, timeout = 30000) {
  return new Promise((resolve) => {
    const echo = 'e' + Math.random().toString(36).slice(2, 8);
    const t = setTimeout(() => resolve({ timeout: true }), timeout);
    const on = (d) => {
      const j = JSON.parse(d.toString());
      if (j.echo === echo) {
        clearTimeout(t);
        ws.off('message', on);
        resolve(j);
      }
    };
    ws.on('message', on);
    ws.send(JSON.stringify({ action, params, echo }));
  });
}

const r = await api('send_group_msg', {
  group_id: GID,
  message: [
    { type: 'reply', data: { id: String(QUOTE_ID) } },
    { type: 'text', data: { text } },
  ],
});

console.log('发送结果:', JSON.stringify(r).slice(0, 220));
ws.close();
