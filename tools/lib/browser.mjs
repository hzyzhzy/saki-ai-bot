/**
 * **用哪个浏览器** —— 统一在这里决定（2026-10-22 用户要求）
 *
 * ## 用户原话
 *   「可以直接在项目里**内置一个微型浏览器**吗，这样**不会干扰其他浏览器**的事情，
 *     别人把项目下载下来也能**马上用上 B 站功能**」
 *   + 「**尽量减小占用，因为打包的 exe 要能存进蓝奏云**」（≤100 MB）
 *
 * ## ⇒ 结论：**不把浏览器打进包**，按这个顺序找
 *   ① `BILI_CHROME` 环境变量（调试 / 想指定某个 Chrome）
 *   ② **系统 Chrome** —— 默认。用**独立 user-data-dir**（`state/bili-profile`），
 *      和用户日常那个 Chrome **互不干扰**（不同 profile、不同进程，不抢窗口/登录态）✓
 *      ⇒ **零下载、零体积增长**，exe 还是 50 MB 左右 ✓
 *   ③ Playwright 自带的 Chromium —— 只有系统里**一个 Chrome 都没有**时才用
 *      （要 `node tools/bili-browser-install.mjs` 下 ~150MB；**不进安装包**）
 *
 * ## ⚠️ 为什么不打包 Chromium
 *   150MB+，塞进 exe 直接超蓝奏云 100MB 限制 ✗
 *   而 Windows 上 Chrome 几乎人人都有 ⇒ 用系统的最省 ✓
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

/**
 * **B站 登录态目录（按 QQ 号分）** —— 2026-10-21 用户要求：
 *   「**b站那一套也要分QQ账号**，以后也许会加一个b站账号给其他QQ号」
 *
 * ## 规则（顺序不能乱）
 *   ① `BILI_PROFILE` 环境变量 —— 显式指定优先（调试 / 特殊用途）
 *   ② **主号**（`config.yml` 的 `mainAccount`）或**拿不到账号信息** ⇒ `state/bili-profile`
 *      ⚠️ 主号必须继续用这个老路径 —— 换了路径等于**登录态全丢，要重新扫码** ✗
 *   ③ 其他号 ⇒ `state/bili-profile-<QQ>`（每个号连**自己的 B 站账号**）✓
 *
 * ## 账号信息从哪来
 *   `_run-bot.bat` 会给每个号的进程设 `QQBOT_ACCOUNT`，**子进程（agent / 工具脚本）会继承** ✓
 *   ⇒ 工具脚本不用额外传参，自己读环境变量就知道"我是哪个号的"
 */
export function biliProfileDir() {
  const env = String(process.env.BILI_PROFILE || '').trim();
  if (env) return env;
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const stateBase = join(root, 'state');
  const acct = String(process.env.QQBOT_ACCOUNT || '').trim();
  if (!acct) return join(stateBase, 'bili-profile');
  let main = '';
  try {
    const cfg = yaml.load(readFileSync(join(root, 'config.yml'), 'utf8')) || {};
    main = String(cfg.mainAccount || '').trim();
  } catch { /* 读不到就当主号 */ }
  if (!main || acct === main) return join(stateBase, 'bili-profile');
  return join(stateBase, `bili-profile-${acct}`);
}

/** 常见的系统 Chrome 位置 */
const SYS_CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  // Edge 也是 Chromium 内核，Chrome 一个都没有时也能顶（位置比较固定）
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

/** 系统里能用的 Chromium 内核浏览器（没有就返回空串） */
export function systemChrome() {
  return SYS_CHROME.find((p) => p && existsSync(p)) || '';
}

/** Playwright 浏览器缓存目录 */
export function browsersDir() {
  return (
    String(process.env.PLAYWRIGHT_BROWSERS_PATH || '').trim() ||
    join(process.env.LOCALAPPDATA || process.env.HOME || '', 'ms-playwright')
  );
}

/** 内置 Chromium 装好了吗（粗判；真正能不能跑由 launch 报错） */
export function bundledStatus() {
  const base = browsersDir();
  if (!existsSync(base)) return { ok: false, dirs: [], hint: `没有缓存目录 ${base}` };
  try {
    const dirs = readdirSync(base).filter((d) => /^chromium/.test(d));
    return dirs.length
      ? { ok: true, dirs, hint: '' }
      : { ok: false, dirs: [], hint: '缓存里没有 chromium' };
  } catch (e) {
    return { ok: false, dirs: [], hint: e.message };
  }
}

/**
 * 传给 `chromium.launch()` / `launchPersistentContext()` 的选项。
 *
 * @param {object} extra 额外选项
 * @param {{log?:(s:string)=>void}} opt 想打日志就传 `log`
 */
export function browserOpts(extra = {}, { log = null } = {}) {
  const env = String(process.env.BILI_CHROME || '').trim();
  if (env && existsSync(env)) {
    log?.(`浏览器：用 BILI_CHROME 指定的 ${env}`);
    return { executablePath: env, ...extra };
  }
  const sys = systemChrome();
  if (sys) {
    log?.(`浏览器：系统自带的 ${sys}（独立 profile，不干扰你日常那个）`);
    return { executablePath: sys, ...extra };
  }
  const b = bundledStatus();
  if (b.ok) {
    log?.(`浏览器：Playwright 内置的 Chromium（${b.dirs.join(', ')}）`);
    return { ...extra };   // 不传 executablePath ⇒ Playwright 用自己下载的
  }
  log?.('浏览器：❌ 一个都没找到 ⇒ 先跑 node tools/bili-browser-install.mjs（下 ~150MB）');
  return { ...extra };
}
