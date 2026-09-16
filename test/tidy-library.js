/**
 * 整理 library/ 里的图片：
 *   1. 按文件头修正扩展名（QQ 的图经常扩展名不对）
 *   2. 内容相同的去重
 *   3. 太大的（>1.5MB，多半是视频/超长动图）移出去
 *
 * 用法: node test/tidy-library.js
 */
import { readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'library');
const TOO_BIG = 1.5 * 1024 * 1024;

function sniff(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return 'webp';
  return null;
}

const files = readdirSync(LIB).filter((n) => /\.(png|jpe?g|gif|webp)$/i.test(n));
const seen = new Map();
const moved = [];
let renamed = 0;
let dupes = 0;

const overflow = join(LIB, '_toobig');
mkdirSync(overflow, { recursive: true });

for (const name of files) {
  const path = join(LIB, name);
  const buf = readFileSync(path);
  const fmt = sniff(buf);
  if (!fmt) {
    console.log(`  跳过（识别不出格式）: ${name}`);
    continue;
  }

  // 太大 → 移出去
  if (buf.length > TOO_BIG) {
    renameSync(path, join(overflow, name));
    moved.push(name);
    console.log(`  移出（${(buf.length / 1048576).toFixed(1)}MB）: ${name}`);
    continue;
  }

  // 去重
  const hash = createHash('md5').update(buf).digest('hex');
  if (seen.has(hash)) {
    unlinkSync(path);
    dupes++;
    console.log(`  删除重复: ${name}（与 ${seen.get(hash)} 相同）`);
    continue;
  }
  seen.set(hash, name);

  // 修正扩展名
  const want = name.replace(/\.[^.]+$/, '.' + fmt);
  if (want !== name) {
    const target = join(LIB, want);
    if (existsSync(target)) {
      unlinkSync(path);
      dupes++;
      console.log(`  删除重复: ${name}（${want} 已存在）`);
      continue;
    }
    renameSync(path, target);
    renamed++;
    console.log(`  改名: ${name} → ${want}`);
  }
}

console.log(`\n改名 ${renamed} 个，去重 ${dupes} 个，移出 ${moved.length} 个`);
const rest = readdirSync(LIB).filter((n) => /\.(png|jpe?g|gif|webp)$/i.test(n));
console.log(`library/ 里现在有 ${rest.length} 张图:`);
for (const n of rest) {
  const b = readFileSync(join(LIB, n));
  console.log(`  ${n}  ${(b.length / 1024).toFixed(0)}KB  ${sniff(b)}`);
}
