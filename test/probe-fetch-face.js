/**
 * 验证：能否用 get_image 取到群里的表情包，并落到本地。
 * 这是「学习群友表情包」可行性的关键一步。
 *
 * 用法: node test/probe-fetch-face.js
 */
import WebSocket from 'ws';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'library', '_probe');
const URL_ = 'ws://127.0.0.1:3001';
// ⚠️ Token **不许写死在代码里**（2026-09-15 准备开源时清掉的），
//    一律从项目自己的 config.yml 读：onebot.accessToken
const TOKEN = (await import('../src/config.js')).config.onebot?.accessToken ?? '';
if (!TOKEN) { console.error('config.yml 里没读到 onebot.accessToken'); process.exit(2); }
const GROUP = '200000001';

const ws = new WebSocket(URL_, { headers: { Authorization: `Bearer ${TOKEN}` } });
const pending = new Map();
let seq = 0;

const call = (action, params = {}, t = 60000) =>
  new Promise((res, rej) => {
    const e = `g${++seq}`;
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
    const h = await call('get_group_msg_history', { group_id: GROUP, count: 1000 });
    const msgs = h?.messages ?? [];

    // 找出「纯图消息」（最可能是表情包），按出现次数排序
    const tally = new Map();
    for (const m of msgs) {
      const segs = m.message ?? [];
      const imgs = segs.filter((s) => s.type === 'image');
      if (!imgs.length) continue;
      const text = segs.filter((s) => s.type === 'text').map((s) => s.data.text).join('').trim();
      if (text) continue; // 只要纯图
      for (const im of imgs) {
        const key = im.data?.file ?? '';
        if (!key) continue;
        if (!tally.has(key)) tally.set(key, { n: 0, data: im.data });
        tally.get(key).n++;
      }
    }

    const top = [...tally.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8);
    console.log(`纯图消息里共 ${tally.size} 张不同的图，尝试取前 ${top.length} 张\n`);

    let ok = 0;
    for (const [file, info] of top) {
      const short = file.slice(0, 28);
      try {
        const r = await call('get_image', { file });
        const local = r?.file;
        const url = r?.url;

        let saved = false;
        let bytes = 0;

        // 优先用返回的本地路径
        if (local && existsSync(local)) {
          const buf = (await import('node:fs')).readFileSync(local);
          bytes = buf.length;
          const dest = join(OUT, `probe_${ok}.png`);
          writeFileSync(dest, buf);
          saved = true;
        } else if (url) {
          const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer());
            bytes = buf.length;
            writeFileSync(join(OUT, `probe_${ok}.png`), buf);
            saved = true;
          }
        }

        console.log(
          `${info.n}次  ${short}…  ${
            saved ? `✅ 取到 ${(bytes / 1024).toFixed(1)}KB` : '❌ 取不到'
          }${local ? `\n        本地路径: ${String(local).slice(-60)}` : ''}`,
        );
        if (saved) ok++;
      } catch (e) {
        console.log(`${info.n}次  ${short}…  ❌ ${e.message}`);
      }
    }

    console.log(`\n成功 ${ok}/${top.length}`);
    console.log(ok > 0 ? '→ 可行：能取到群里的表情包' : '→ 取不到，需要换方案');
  } catch (e) {
    console.error('出错:', e.message);
  } finally {
    ws.close();
  }
});

ws.on('error', (e) => console.error('连接失败:', e.message));
