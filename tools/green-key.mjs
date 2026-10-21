/**
 * 算绿幕帧序列里人物的真实边界（bbox），供 ffmpeg crop + scale 用
 *
 * 为什么需要：canvas 是 758×758，但人物只占中间一小块（上下左右大量纯绿）。
 * 不裁紧的话，抠完图人物还是小小一个，缩放到视频里会糊 ✗
 *
 * 用法：node tools/green-key.mjs logs\bili\sakiko_green_frames [--step 6] [--pad 8]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';

function decode(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error('只支持 8-bit 非隔行');
  const CH = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * CH;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[p++];
    const cur = raw.subarray(p, p + stride); p += stride;
    const line = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= CH ? line[x - CH] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= CH ? prev[x - CH] : 0;
      let v = cur[x];
      switch (ft) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error('未知 filter ' + ft);
      }
      line[x] = v & 0xff;
    }
  }
  return { w, h, CH, out, stride };
}

const dir = process.argv[2];
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const STEP = arg('step', 6);
const PAD = arg('pad', 8);
if (!dir) { console.error('用法：node tools/green-key.mjs <帧目录> [--step 6] [--pad 8]'); process.exit(2); }

const files = readdirSync(dir).filter((f) => /\.png$/i.test(f)).sort();
if (!files.length) { console.error('目录里没有 png'); process.exit(2); }

// 绿幕判据：G 高、R/B 明显低（页面刷的是纯 #00FF00，抗锯齿边缘是它的暗版）
const isGreen = (r, g, b) => g > 90 && g > r * 1.9 && g > b * 1.9;

let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
let W = 0, H = 0;
let scanned = 0;
for (let i = 0; i < files.length; i += STEP) {
  const { w, h, CH, out, stride } = decode(readFileSync(join(dir, files[i])));
  W = w; H = h;
  scanned++;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * stride + x * CH;
      const a = CH === 4 ? out[p + 3] : 255;
      if (a < 16) continue;                      // 已透明 = 不算人物
      if (isGreen(out[p], out[p + 1], out[p + 2])) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
}

if (x1 < 0) { console.error('❌ 整帧都是绿的？没找到人物'); process.exit(2); }

const pad = PAD;
const bx = Math.max(0, x0 - pad);
const by = Math.max(0, y0 - pad);
const bw = Math.min(W - bx, x1 - x0 + 1 + pad * 2);
const bh = Math.min(H - by, y1 - y0 + 1 + pad * 2);

console.log(JSON.stringify({
  source: { w: W, h: H }, scanned, total: files.length,
  person: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 },
  crop: { x: bx, y: by, w: bw, h: bh },
  // 偶数化（libx264 + yuv420p 要求宽高为偶数）
  cropEven: { x: bx - (bx % 2), y: by - (by % 2), w: bw + (bw % 2), h: bh + (bh % 2) },
  ffmpegCrop: `crop=${bw + (bw % 2)}:${bh + (bh % 2)}:${bx - (bx % 2)}:${by - (by % 2)}`,
}, null, 2));
