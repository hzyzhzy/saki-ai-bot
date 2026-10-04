/**
 * 把 QQ 收藏的表情包下载到本地 library/ 目录，便于人工/模型识别内容。
 * 用法: node test/fetch-faces.js
 */
import WebSocket from 'ws';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'library');
const URL_ = 'ws://127.0.0.1:3001';
// ⚠️ Token **不许写死在代码里**（2026-09-15 准备开源时清掉的），
//    一律从项目自己的 config.yml 读：onebot.accessToken
const TOKEN = (await import('../src/config.js')).config.onebot?.accessToken ?? '';
if (!TOKEN) { console.error('config.yml 里没读到 onebot.accessToken'); process.exit(2); }

const ws = new WebSocket(URL_, { headers: { Authorization: `Bearer ${TOKEN}` } });
const pending = new Map();
let seq = 0;

const call = (action, params = {}, t = 30000) =>
  new Promise((res, rej) => {
    const e = `f${++seq}`;
    pending.set(e, { res, rej });
    ws.send(JSON.stringify({ action, params, echo: e }));
    setTimeout(() => {
      if (pending.delete(e)) rej(new Error(`${action} 超时`));
    }, t);
  });

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString('utf8'));
  if (m.echo && pending.has(m.echo)) {
    const p = pending.get(m.echo);
    pending.delete(m.echo);
    m.status === 'ok' || m.retcode === 0
      ? p.res(m.data)
      : p.rej(new Error(`${m.retcode} ${m.message ?? m.wording ?? ''}`));
  }
});

ws.on('open', async () => {
  try {
    mkdirSync(OUT, { recursive: true });
    const urls = await call('fetch_custom_face', { count: 100 });
    console.log(`收藏表情 ${urls.length} 个`);

    const saved = [];
    for (let i = 0; i < urls.length; i++) {
      const u = urls[i];
      const name = `face_${String(i).padStart(2, '0')}.png`;
      const dest = join(OUT, name);
      if (existsSync(dest)) {
        saved.push({ name, url: u, skipped: true });
        continue;
      }
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        writeFileSync(dest, buf);
        console.log(`  ${name}  ${(buf.length / 1024).toFixed(1)} KB`);
        saved.push({ name, url: u, bytes: buf.length });
      } catch (e) {
        console.log(`  ${name} 下载失败: ${e.message}`);
        saved.push({ name, url: u, error: e.message });
      }
    }
    writeFileSync(join(OUT, '_sources.json'), JSON.stringify(saved, null, 2), 'utf8');
    console.log(`\n共保存 ${saved.filter((s) => !s.error).length} 个到 library/`);
  } catch (e) {
    console.error('出错:', e.message);
  } finally {
    ws.close();
  }
});

ws.on('error', (e) => console.error('连接失败:', e.message));
