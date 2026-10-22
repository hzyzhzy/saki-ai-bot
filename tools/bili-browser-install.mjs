#!/usr/bin/env node
/**
 * **可选**：下载 Playwright 自带的 Chromium（2026-10-22）
 *
 * ## 什么时候才需要跑它
 *   机器上**一个 Chromium 内核的浏览器都没有**（Chrome / Edge 都没装）。
 *   有 Chrome 或 Edge 的话，B站功能直接就能用，**不需要跑这个** ✓
 *
 * ## ⚠️ 为什么默认不装
 *   用户要求「**尽量减小占用，因为打包的 exe 要能存进蓝奏云**」（≤100 MB）。
 *   Chromium 150MB+，打进安装包直接超限 ✗
 *   ⇒ 安装包里**不带浏览器**；这个脚本只是给"连 Chrome 都没有"的人一个兜底。
 *
 * ## 用法
 *   node tools/bili-browser-install.mjs          # 检查现状，缺了才下
 *   node tools/bili-browser-install.mjs --force  # 强制重下
 */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { systemChrome, bundledStatus, browsersDir } from './lib/browser.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FORCE = process.argv.includes('--force');
const say = (s) => console.log(`[浏览器] ${s}`);

const sys = systemChrome();
const bundled = bundledStatus();

say(`系统浏览器：${sys || '（没有）'}`);
say(`内置 Chromium：${bundled.ok ? bundled.dirs.join(', ') : '（没有）'}`);

if (sys && !FORCE) {
  say('✅ 有系统浏览器 ⇒ **不需要下载**，B站功能直接能用');
  say('   （用的是独立 profile：state/bili-profile，不会干扰你日常那个浏览器）');
  process.exit(0);
}
if (bundled.ok && !FORCE) {
  say('✅ 内置 Chromium 已经在 ⇒ 什么都不用做');
  process.exit(0);
}

say(`开始下载 Chromium（约 150MB）到 ${browsersDir()} …`);
const cli = join(ROOT, 'node_modules', 'playwright-core', 'cli.js');
const p = spawn(process.execPath, [cli, 'install', 'chromium'], { cwd: ROOT, stdio: 'inherit' });
p.on('close', (code) => {
  if (code === 0) {
    say('✅ 装好了');
    const b = bundledStatus();
    say(`   现在：${b.ok ? b.dirs.join(', ') : '（还是没找到，可能装到别处了）'}`);
  } else {
    say(`❌ 下载失败（exit ${code}）—— 多半是网络。挂了代理再试，或者装个 Chrome 也行`);
  }
  process.exit(code === 0 ? 0 : 1);
});
