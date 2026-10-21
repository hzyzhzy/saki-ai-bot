/**
 * 把 bdon.moe CDN 上的 Live2D 模型**缓存到本地**
 *
 * 为什么需要：Chrome（Playwright）里下载那个 5.8 MB 的 prefab 会卡在 2 KB 不动，
 * 而 curl 同一条 URL **2.4 秒就下完**（200 KB/s）⇒ 用 curl 缓存，再让 Playwright 拦截请求读本地 ✓
 *
 * 用法：
 *   node tools/live2d-cache.mjs --model adv_live2d_sakiko_010_casual_spring_01
 */
import { createWriteStream, mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CDN = 'https://storage.bdon.moe/moenotes';

const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const say = (s) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${s}`);

const MODEL = arg('model', 'adv_live2d_sakiko_010_casual_spring_01');
const CACHE = join(ROOT, 'logs', 'bili', 'l2dcache', MODEL);
mkdirSync(CACHE, { recursive: true });

/** 用 curl 下（Chrome 下不动的，curl 能下） */
function fetchTo(url, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest) && statSync(dest).size > 0) return true;
  try {
    execFileSync('curl.exe', ['-s', '--max-time', '180', '-o', dest, url], { stdio: 'pipe' });
    const ok = existsSync(dest) && statSync(dest).size > 0;
    return ok;
  } catch (e) {
    say('  下失败：' + url.slice(-60) + ' ' + e.message);
    return false;
  }
}

// ① manifest
const manifestUrl = `${CDN}/models/${MODEL}.json`;
const manifestPath = join(CACHE, 'models', `${MODEL}.json`);
say(`manifest：${MODEL}.json`);
if (!fetchTo(manifestUrl, manifestPath)) { say('❌ manifest 下不下来'); process.exit(1); }
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
say(`  files 条目：${Object.keys(manifest.files).length}`);

// ② 遍历 files 里的 asset（可能嵌在 parts 里）
const assets = new Set();
const walk = (v) => {
  if (typeof v === 'string') {
    if (v.startsWith('assets/')) assets.add(v);
    return;
  }
  if (Array.isArray(v)) { v.forEach(walk); return; }
  if (v && typeof v === 'object') { Object.values(v).forEach(walk); }
};
walk(manifest.files);

say(`需要下载 ${assets.size} 个资源文件…`);
let ok = 0;
let fail = 0;
let total = 0;
for (const rel of assets) {
  const dest = join(CACHE, rel);
  const good = fetchTo(`${CDN}/${rel}`, dest);
  if (good) {
    ok++;
    total += statSync(dest).size;
    say(`  ✅ ${basename(rel).slice(0, 50)}  ${(statSync(dest).size / 1024).toFixed(0)} KB`);
  } else {
    fail++;
  }
}
say(`缓存完成：${ok} 成功 / ${fail} 失败，共 ${(total / 1048576).toFixed(1)} MB`);
say(`目录：${CACHE}`);
