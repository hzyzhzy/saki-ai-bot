/**
 * 统计群里高频使用的表情包，并检查本地缓存里有没有对应文件。
 * 结论用来判断「学习群友表情包」是否可行。
 *
 * 用法: node test/scan-stickers.js [群号] [拉取条数]
 */
import WebSocket from 'ws';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const URL_ = 'ws://127.0.0.1:3001';
// ⚠️ Token **不许写死在代码里**（2026-09-15 准备开源时清掉的），
//    一律从项目自己的 config.yml 读：onebot.accessToken
const TOKEN = (await import('../src/config.js')).config.onebot?.accessToken ?? '';
if (!TOKEN) { console.error('config.yml 里没读到 onebot.accessToken'); process.exit(2); }
const GROUP = process.argv[2] ?? '200000001';
const COUNT = Number(process.argv[3] ?? 1000);

// NapCat 的图片缓存根目录
const PIC_ROOT = join(
  process.env.USERPROFILE ?? '',
  'OneDrive - yijia',
  '文档',
  'Tencent Files',
  '10000002',
  'nt_qq',
  'nt_data',
  'Pic',
);

const ws = new WebSocket(URL_, { headers: { Authorization: `Bearer ${TOKEN}` } });
const pending = new Map();
let seq = 0;

const call = (action, params = {}, t = 60000) =>
  new Promise((res, rej) => {
    const e = `s${++seq}`;
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

/** 在缓存目录里按文件名找图片 */
function findCached(file) {
  if (!file) return null;
  const name = String(file).split(/[\\/]/).pop();
  if (!name) return null;
  for (const month of ['2026-09', '2026-08', '2026-07', '2026-06']) {
    const p = join(PIC_ROOT, month, name);
    if (existsSync(p)) return p;
    const ori = join(PIC_ROOT, month, 'Ori', name);
    if (existsSync(ori)) return ori;
  }
  // 兜底：递归找
  return null;
}

ws.on('open', async () => {
  try {
    const h = await call('get_group_msg_history', { group_id: GROUP, count: COUNT });
    const msgs = h?.messages ?? [];
    console.log(`拉到 ${msgs.length} 条群消息\n`);

    // 统计图片：按文件名聚合（同一张图文件名相同）
    const tally = new Map(); // file -> { n, senders:Set, hasTextWithIt, samples:[] }
    let imgMsgs = 0;
    let pureSticker = 0; // 只有图、没有文字的，最可能是表情包

    for (const m of msgs) {
      const segs = m.message ?? [];
      if (!Array.isArray(segs)) continue;
      const imgs = segs.filter((s) => s.type === 'image');
      if (!imgs.length) continue;
      imgMsgs++;

      const text = segs.filter((s) => s.type === 'text').map((s) => s.data.text).join('').trim();
      const onlyImage = segs.every((s) => s.type === 'image' || s.type === 'face' || s.type === 'reply');
      if (onlyImage && !text) pureSticker++;

      for (const im of imgs) {
        const key = im.data?.file ?? im.data?.url ?? '';
        if (!key) continue;
        if (!tally.has(key)) tally.set(key, { n: 0, senders: new Set(), withText: 0, pure: 0 });
        const e = tally.get(key);
        e.n++;
        e.senders.add(String(m.user_id));
        if (text) e.withText++;
        else e.pure++;
      }
    }

    console.log(`含图消息: ${imgMsgs} 条`);
    console.log(`纯图片（无文字，最可能是表情包）: ${pureSticker} 条`);
    console.log(`不同图片: ${tally.size} 张\n`);

    if (imgMsgs > 0) {
      console.log(`纯图比例: ${((pureSticker / imgMsgs) * 100).toFixed(0)}%（越高说明群里发表情包越常见）\n`);
    }

    // 高频图
    const top = [...tally.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 30);
    console.log('=== 出现最多的图（前 30）===');
    console.log('次数  发过的人数  纯图  本地缓存  文件名');
    let cachedCount = 0;
    for (const [file, e] of top) {
      const p = findCached(file);
      if (p) cachedCount++;
      const name = String(file).split(/[\\/]/).pop().slice(0, 40);
      console.log(
        `${String(e.n).padStart(4)}  ${String(e.senders.size).padStart(8)}  ${String(e.pure).padStart(4)}  ${
          p ? '  ✅   ' : '  ❌   '
        } ${name}`,
      );
    }

    console.log(`\n前 30 张里有 ${cachedCount} 张能在本地缓存找到`);
    console.log(
      cachedCount > 0
        ? '→ 可以从本地缓存直接收集，不需要重新下载'
        : '→ 本地缓存里没有，需要走 get_image 接口取',
    );
  } catch (e) {
    console.error('出错:', e.message);
  } finally {
    ws.close();
  }
});

ws.on('error', (e) => console.error('连接失败:', e.message));
