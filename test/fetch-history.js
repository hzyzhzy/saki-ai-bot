// 拉取群历史（count=500 是 NapCat 本地缓存上限）并保存。
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';

const URL = 'ws://127.0.0.1:3001';
// ⚠️ Token **不许写死在代码里**（2026-09-15 准备开源时清掉的），
//    一律从项目自己的 config.yml 读：onebot.accessToken
const TOKEN = (await import('../src/config.js')).config.onebot?.accessToken ?? '';
if (!TOKEN) { console.error('config.yml 里没读到 onebot.accessToken'); process.exit(2); }
const GROUP = process.argv[2] ?? '200000001';
const OUT = process.argv[3] ?? 'test/gh-full.json';

const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${TOKEN}` } });
const pending = new Map();
let seq = 0;

const call = (a, p = {}, t = 90000) =>
  new Promise((res, rej) => {
    const e = `g${++seq}`;
    pending.set(e, { res, rej });
    ws.send(JSON.stringify({ action: a, params: p, echo: e }));
    setTimeout(() => {
      if (pending.delete(e)) rej(new Error(`${a} 超时`));
    }, t);
  });

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString('utf8'));
  if (m.echo && pending.has(m.echo)) {
    const p = pending.get(m.echo);
    pending.delete(m.echo);
    m.status === 'ok' || m.retcode === 0 ? p.res(m.data) : p.rej(new Error(m.message ?? m.wording ?? 'err'));
  }
});

ws.on('open', async () => {
  try {
    // 反复用不同 count 试探，拿到缓存上限
    let best = [];
    for (const count of [200, 500, 1000]) {
      try {
        const r = await call('get_group_msg_history', { group_id: GROUP, count });
        const msgs = r?.messages ?? [];
        if (msgs.length > best.length) best = msgs;
        console.log(`count=${count} -> ${msgs.length} 条`);
      } catch (e) {
        console.log(`count=${count} 失败: ${e.message}`);
      }
    }
    writeFileSync(OUT, JSON.stringify(best, null, 2), 'utf8');
    const uniq = new Set(best.map((m) => m.message_id));
    console.log(`\n最佳结果 ${best.length} 条，唯一 ${uniq.size} 条 -> ${OUT}`);
    if (best.length) {
      const ts = best.map((m) => m.time);
      console.log('时间范围:', new Date(Math.min(...ts) * 1000).toLocaleString(), '→', new Date(Math.max(...ts) * 1000).toLocaleString());
    }
  } catch (e) {
    console.error('出错:', e.message);
    process.exitCode = 1;
  } finally {
    ws.close();
  }
});

ws.on('error', (e) => {
  console.error('连接失败:', e.message);
  process.exitCode = 1;
});
