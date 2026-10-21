/**
 * 读 PNG 的 alpha 统计（纯 Node，无第三方依赖；只支持 8-bit、非隔行）
 * 用法：node tools/png-alpha.mjs <a.png> [b.png ...]
 * 输出：尺寸 / 透明像素数 / 全透明比例 / 四角 RGBA
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

function decode(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let off = 8;
  let w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
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
  if (bitDepth !== 8) throw new Error('只支持 8-bit，实际 ' + bitDepth);
  if (interlace !== 0) throw new Error('不支持隔行扫描');
  const CH = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!CH) throw new Error('不支持的 colorType ' + colorType);
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
  return { w, h, CH, out, stride, hasAlpha: colorType === 4 || colorType === 6 };
}

for (const f of process.argv.slice(2)) {
  const { w, h, CH, out, stride, hasAlpha } = decode(readFileSync(f));
  const px = (x, y) => {
    const i = y * stride + x * CH;
    return CH === 4 ? [out[i], out[i + 1], out[i + 2], out[i + 3]] : [out[i], out[i + 1], out[i + 2], 255];
  };
  let transparent = 0, total = w * h;
  if (hasAlpha) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (out[y * stride + x * 4 + 3] < 16) transparent++;
  }
  const corners = {
    左上: px(0, 0), 右上: px(w - 1, 0), 左下: px(0, h - 1), 右下: px(w - 1, h - 1),
  };
  console.log(`\n${f}`);
  console.log(`  ${w}×${h}  CH=${CH}  hasAlpha=${hasAlpha}`);
  console.log(`  透明像素(<16): ${transparent} / ${total} = ${((transparent / total) * 100).toFixed(1)}%`);
  console.log('  四角 RGBA: ' + Object.entries(corners).map(([k, v]) => `${k}(${v.join(',')})`).join(' '));
}
