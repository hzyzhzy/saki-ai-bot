/**
 * 从群历史里收集群友常用的表情包，落到 library/。
 *
 * 思路：群里的「纯图消息」（无文字）最可能是表情包。
 * 按出现次数排序，取前 N 张，用 get_image 拿到本地文件并复制过来。
 *
 * 用法: node test/collect-faces.js [群号] [最多收集几张] [最少出现次数]
 */
import WebSocket from 'ws';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, 'library');
const RAW = join(LIB, '_collected'); // 原始收集，等人工/AI 打标签后进正式库
const URL_ = 'ws://127.0.0.1:3001';
// ⚠️ Token **不许写死在代码里**（2026-09-15 准备开源时清掉的），
//    一律从项目自己的 config.yml 读：onebot.accessToken
const TOKEN = (await import('../src/config.js')).config.onebot?.accessToken ?? '';
if (!TOKEN) { console.error('config.yml 里没读到 onebot.accessToken'); process.exit(2); }

const GROUP = process.argv[2] ?? '200000001';
const MAX = Number(process.argv[3] ?? 24);
const MIN = Number(process.argv[4] ?? 1);

const ws = new WebSocket(URL_, { headers: { Authorization: `Bearer ${TOKEN}` } });
const pending = new Map();
let seq = 0;

const call = (action, params = {}, t = 60000) =>
  new Promise((res, rej) => {
    const e = `c${++seq}`;
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

/** 按文件头判断真实格式（QQ 缓存常给错扩展名） */
function sniff(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return 'webp';
  return null;
}

const manifest = [];

ws.on('open', async () => {
  try {
    mkdirSync(RAW, { recursive: true });

    const h = await call('get_group_msg_history', { group_id: GROUP, count: 1000 });
    const msgs = h?.messages ?? [];

    // 统计「纯图消息」里的图
    const tally = new Map(); // file -> { n, senders:Set }
    for (const m of msgs) {
      const segs = m.message ?? [];
      const imgs = segs.filter((s) => s.type === 'image');
      if (!imgs.length) continue;
      const text = segs.filter((s) => s.type === 'text').map((s) => s.data.text).join('').trim();
      if (text) continue; // 带文字的多半是截图，不是表情包
      for (const im of imgs) {
        const key = im.data?.file;
        if (!key) continue;
        if (!tally.has(key)) tally.set(key, { n: 0, senders: new Set() });
        const e = tally.get(key);
        e.n++;
        e.senders.add(String(m.user_id));
      }
    }

    const candidates = [...tally.entries()]
      .filter(([, e]) => e.n >= MIN)
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, MAX);

    console.log(`符合条件的候选表情包 ${candidates.length} 张，开始取图…\n`);

    let saved = 0;
    const seenHash = new Set();

    for (const [file, e] of candidates) {
      try {
        const r = await call('get_image', { file });
        let buf = null;

        if (r?.file && existsSync(r.file)) {
          buf = readFileSync(r.file);
        } else if (r?.url) {
          const resp = await fetch(r.url, { signal: AbortSignal.timeout(25000) });
          if (resp.ok) buf = Buffer.from(await resp.arrayBuffer());
        }

        if (!buf || !buf.length) {
          console.log(`  ${String(e.n).padStart(3)}次  ❌ 取不到`);
          continue;
        }

        const fmt = sniff(buf) ?? 'jpg';

        // 去重：同一张图可能文件名不同
        const hash = createHash('md5').update(buf).digest('hex').slice(0, 12);
        if (seenHash.has(hash)) {
          console.log(`  ${String(e.n).padStart(3)}次  ⏭  重复（${hash}）`);
          continue;
        }
        seenHash.add(hash);

        // 太大的（>1.5MB）大概率不是表情包，多半是截图或原图
        if (buf.length > 1.5 * 1024 * 1024) {
          console.log(`  ${String(e.n).padStart(3)}次  ⏭  太大 ${(buf.length / 1048576).toFixed(1)}MB，跳过`);
          continue;
        }

        const name = `g${String(saved).padStart(2, '0')}_${hash}.${fmt}`;
        writeFileSync(join(RAW, name), buf);
        manifest.push({
          file: name,
          usedTimes: e.n,
          usedBy: e.senders.size,
          bytes: buf.length,
          srcName: file,
        });
        console.log(
          `  ${String(e.n).padStart(3)}次  ${e.senders.size}人  ✅ ${name}  ${(buf.length / 1024).toFixed(0)}KB`,
        );
        saved++;
      } catch (err) {
        console.log(`  ${String(e.n).padStart(3)}次  ❌ ${err.message}`);
      }
    }

    writeFileSync(join(RAW, '_manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    console.log(`\n共收集 ${saved} 张到 library/_collected/`);
    console.log('接下来需要给每张写「画的是什么」和「什么场合用」，见 _manifest.json');
  } catch (e) {
    console.error('出错:', e.message);
  } finally {
    ws.close();
  }
});

ws.on('error', (e) => console.error('连接失败:', e.message));
