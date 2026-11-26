// 回原设定集核对人设事实：把命中的**唯一原文行**捞出来对照（不凭记忆）。
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const FILE = 'E:/Downloads/沈策古风剧情设定完整版.txt';
const KEYS = [
  '沈渡', '柳氏', '左肋', '右肩', '虎口', '四十七', '夹板', '九天',
  '断眉', '匕首割', '自割', '霜刃', '断雁', '惊鸿', '结案', '水声', '琴',
];
const hits = new Map(); // key -> Set(唯一行)

const rl = createInterface({ input: createReadStream(FILE, 'utf8'), crlfDelay: Infinity });
for await (const raw of rl) {
  const t = raw.replace(/^[\s　]+/, '').trim();
  if (!t || t.length > 200) continue;
  for (const k of KEYS) {
    if (!t.includes(k)) continue;
    if (!hits.has(k)) hits.set(k, new Set());
    const s = hits.get(k);
    if (s.size < 14) s.add(t);
  }
}
rl.close();

for (const k of KEYS) {
  const s = hits.get(k);
  console.log(`\n===== ${k}（${s ? s.size : 0} 条唯一原文）=====`);
  if (!s) continue;
  for (const line of s) console.log('·', line.slice(0, 150));
}
