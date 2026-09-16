/**
 * 修正 library/ 下图片的扩展名（按文件头判断真实格式）。
 * QQ 上传/缓存的图经常扩展名不对，不修的话无法正确查看和发送。
 *
 * 用法: node test/fix-ext.js
 */
import { readdirSync, readFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'library');
const dir = process.argv[2] ? join(LIB, process.argv[2]) : LIB;

function sniff(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return 'webp';
  return null;
}

let fixed = 0;
const files = readdirSync(dir).filter((n) => /\.(png|jpe?g|gif|webp)$/i.test(n));
for (const name of files) {
  const p = join(dir, name);
  const buf = readFileSync(p);
  const fmt = sniff(buf);
  if (!fmt) {
    console.log(`  ?  识别不出格式: ${name}`);
    continue;
  }
  const cur = name.split('.').pop().toLowerCase();
  const ok = (cur === 'jpg' && fmt === 'jpg') || cur === fmt || (cur === 'jpeg' && fmt === 'jpg');
  if (ok) continue;

  const target = join(dir, name.replace(/\.[^.]+$/, '.' + fmt));
  if (existsSync(target)) {
    unlinkSync(p);
    console.log(`  重复删除: ${name}（${fmt} 版本已存在）`);
  } else {
    renameSync(p, target);
    console.log(`  改名: ${name} → ${target.split(/[\\/]/).pop()}`);
  }
  fixed++;
}
console.log(`\n共处理 ${fixed} 个`);
