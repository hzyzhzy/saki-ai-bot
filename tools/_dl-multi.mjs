/**
 * 多连接分段下载（单网卡就够）。
 *
 * 为什么写它：ModelScope 的 CDN **单连接被限速**（实测 0.5~0.7 MB/s，
 * 而本机 WiFi 协商 130 Mbps ≈ 16 MB/s）⇒ 瓶颈不在网卡，而在"一条 TCP 连接的额度"。
 * 所以开 16 条 Range 连接并行拉同一文件的不同区间，写进同一文件的对应偏移，
 * 速度通常能翻几倍到十几倍。⚠️ 不依赖多网卡（两个网卡连同一个 AP 共享同一条出口，
 * 绑两个网卡不会提速，反而互相干扰）。
 *
 * 用法：
 *   node tools/_dl-multi.mjs <url> <输出文件> [并发数=16]
 */
import { open, rename, rm } from 'node:fs/promises';

const [url, out, nArg] = process.argv.slice(2);
if (!url || !out) {
  console.error('用法：node tools/_dl-multi.mjs <url> <输出文件> [并发数]');
  process.exit(1);
}
const N = Math.max(1, Math.min(32, Number(nArg) || 16));

const head = await fetch(url, { headers: { Range: 'bytes=0-0' } });
if (head.status !== 206) {
  console.error(`服务端不支持 Range（HTTP ${head.status}）⇒ 只能单连接下`);
  process.exit(2);
}
const cr = head.headers.get('content-range') || '';
const total = Number(cr.split('/')[1]);
try { await head.body?.cancel?.(); } catch {}
if (!total) {
  console.error('拿不到文件总大小');
  process.exit(3);
}
console.log(`总大小 ${(total / 1048576).toFixed(1)} MB｜分 ${N} 段并行`);

const part = `${out}.part`;
await rm(part, { force: true }).catch(() => {});
const fh = await open(part, 'w');
await fh.truncate(total);

const segBytes = new Array(N).fill(0);
const sum = () => segBytes.reduce((a, b) => a + b, 0);
const t0 = Date.now();
const tick = setInterval(() => {
  const sec = Math.max(0.001, (Date.now() - t0) / 1000);
  const d = sum();
  console.log(
    `  ${((d / total) * 100).toFixed(1)}%  ${(d / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB` +
      `  ${(d / 1048576 / sec).toFixed(2)} MB/s`,
  );
}, 5000);

const chunk = Math.ceil(total / N);
let failed = 0;
await Promise.all(
  Array.from({ length: N }, async (_, i) => {
    const start = i * chunk;
    const end = Math.min(total - 1, start + chunk - 1);
    if (start > end) return;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
        if (r.status !== 206) throw new Error(`HTTP ${r.status}`);
        let pos = start;
        segBytes[i] = 0;
        for await (const buf of r.body) {
          await fh.write(buf, 0, buf.length, pos);
          pos += buf.length;
          segBytes[i] += buf.length;
        }
        if (pos !== end + 1) throw new Error(`段 ${i} 只收到 ${pos - start}/${end + 1 - start} 字节`);
        return;
      } catch (e) {
        if (attempt === 3) {
          failed++;
          console.error(`  段 ${i} 失败（重试 4 次）：${e.message}`);
        } else {
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        }
      }
    }
  }),
);
clearInterval(tick);
await fh.close();

if (failed) {
  console.error(`✗ ${failed} 段没下完，保留 ${part}`);
  process.exit(4);
}
await rename(part, out);
const sec = (Date.now() - t0) / 1000;
console.log(`✅ 完成 ${(total / 1048576).toFixed(1)} MB｜${sec.toFixed(0)}s｜平均 ${(total / 1048576 / sec).toFixed(2)} MB/s`);
