// 试能不能真的拿到那个「错误报告」压缩包
//   file_id 从日志里抄：/b8267aa4-b8e7-45a2-86fd-408b00b0c14f
//   ⚠️ 同时也测几个不同的 action，看哪个能通
import WebSocket from 'ws';
import fs from 'node:fs';
import yaml from 'js-yaml';

const c = yaml.load(fs.readFileSync('accounts/10000002.yml', 'utf8'));
const tok = c.onebot?.accessToken || '';
const GID = 200000001;
const FILE_ID = '/b8267aa4-b8e7-45a2-86fd-408b00b0c14f';
const FILE_NAME = '错误报告-2026-11-20_23.08.49.zip';

const ws = new WebSocket('ws://127.0.0.1:3001', { headers: { Authorization: 'Bearer ' + tok } });
await new Promise((res, rej) => {
  ws.on('open', res);
  ws.on('error', rej);
  setTimeout(() => rej(new Error('连不上')), 5000);
});

function api(action, params, timeout = 30000) {
  return new Promise((resolve) => {
    const echo = 'e' + Math.random().toString(36).slice(2, 8);
    const t0 = Date.now();
    const t = setTimeout(() => resolve({ timeout: true, ms: Date.now() - t0 }), timeout);
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

const tries = [
  ['get_group_file_url', { group_id: GID, file_id: FILE_ID }],
  ['get_file', { file_id: FILE_ID }],
  ['get_private_file_url', { user_id: 0, file_id: FILE_ID }],
  ['get_group_root_files', { group_id: GID }],
];

for (const [action, params] of tries) {
  const r = await api(action, params);
  const brief = JSON.stringify(r.data ?? r).slice(0, 220);
  console.log(
    action.padEnd(24) +
      String(r.ms).padStart(6) +
      ' ms  ' +
      (r.timeout ? 'TIMEOUT' : r.status || '?') +
      '  ' +
      brief,
  );
}

// 再试试按文件名在群文件里找
console.log('\n=== 在群文件列表里找那个 zip ===');
const r = await api('get_group_root_files', { group_id: GID }, 60000);
const files = r?.data?.files ?? [];
console.log('  群根目录文件数:', files.length);
const hit = files.filter((f) => String(f.file_name || '').includes('错误报告'));
console.log('  名字带「错误报告」的:', hit.length);
for (const f of hit.slice(0, 5)) {
  console.log('   ', JSON.stringify(f).slice(0, 250));
}

ws.close();
