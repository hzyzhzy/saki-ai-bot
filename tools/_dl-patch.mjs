/** 补下载一个区间（用于 _dl-multi.mjs 某段失败后补齐，不重下整份） */
import { open, rename } from 'node:fs/promises';

const URL = process.argv[2];
const PART = process.argv[3];
const FINAL = process.argv[4];
const total = Number(process.argv[5]);
const N = Number(process.argv[6] || 16);
const segs = String(process.argv[7] || '')
  .split(',')
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isInteger(x));

if (!URL || !PART || !total) {
  console.error('用法：node tools/_dl-patch.mjs <url> <part文件> <最终文件> <总字节> [分段数] [要补的段,逗号分隔]');
  process.exit(1);
}

const chunk = Math.ceil(total / N);
const fh = await open(PART, 'r+');
try {
  for (const i of segs) {
    const start = i * chunk;
    const end = Math.min(total - 1, start + chunk - 1);
    let ok = false;
    for (let attempt = 0; attempt < 5 && !ok; attempt++) {
      try {
        const r = await fetch(URL, { headers: { Range: `bytes=${start}-${end}` } });
        if (r.status !== 206) throw new Error(`HTTP ${r.status}`);
        let pos = start;
        const t0 = Date.now();
        for await (const buf of r.body) {
          await fh.write(buf, 0, buf.length, pos);
          pos += buf.length;
        }
        if (pos !== end + 1) throw new Error(`只收到 ${pos - start}/${end + 1 - start}`);
        ok = true;
        console.log(`✅ 段 ${i} 补齐 ${(pos - start) / 1048576} MB｜${((Date.now() - t0) / 1000).toFixed(0)}s`);
      } catch (e) {
        console.error(`  段 ${i} 第 ${attempt + 1} 次失败：${e.message}`);
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    if (!ok) {
      console.error(`✗ 段 ${i} 补不上，留着 .part`);
      process.exit(2);
    }
  }
} finally {
  await fh.close();
}
if (FINAL) {
  await rename(PART, FINAL);
  console.log(`✅ 已重命名为 ${FINAL}`);
}
