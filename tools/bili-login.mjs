/**
 * B 站登录态 —— **一次性**跑这个，之后上传脚本就免登录了。
 *
 * ## 用户要求（2026-10-20）
 *   「**视频。直接调用一个 agent 发视频，完全模仿真人操作**」
 *
 * ## 为什么必须真浏览器
 *   B 站投稿有风控（指纹 / 行为 / 频率），**纯 HTTP 接口发视频基本必挂**：
 *   上传要分片 + wbi 签名 + 一堆前端参数，而且新号容易直接弹验证码。
 *   ⇒ 用**用户自己机器上的 Chrome**（`C:\Program Files\Google\Chrome\...`），
 *     指纹、字体、时区、插件全是真的，行为也是真的（鼠标、滚动、停顿）。
 *   ⚠️ 用 `playwright-core` 而不是 `playwright`：**它不带浏览器**，
 *     所以不下载那 300MB chromium，直接用系统 Chrome ✓
 *
 * ## 怎么用
 *   node tools/bili-login.mjs
 *   会弹一个 Chrome 窗口（**独立配置目录**，不碰你日常那个 profile）⇒
 *   你扫码登录 ⇒ 脚本检测到 SESSDATA 就自己关窗口、把登录态留在
 *   `state/bili-profile/` 里（下次上传直接复用，不用再扫）。
 *
 * ⚠️ 登录态 = 账号控制权。那个目录**不许进任何仓库**（`state/` 已在 .gitignore）✓
 * ⚠️ 本脚本**只登录、不投稿**，绝不发任何东西出去。
 */
import { chromium } from 'playwright-core';
import { mkdirSync, appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { biliProfileDir } from './lib/browser.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME =
  process.env.BILI_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// ⚠️ 2026-10-21：**按 QQ 号分 profile**（主号走老路径 state/bili-profile，别的号 state/bili-profile-<QQ>）
const PROFILE = biliProfileDir();
const LOG = join(ROOT, 'logs', 'bili-login.log');
const WAIT_MS = Number(process.env.BILI_WAIT_MS || 10 * 60 * 1000);

/* ⚠️⚠️ 2026-10-22 加（用户：「**可不可以纯靠 webui 完成整个 b 站登录过程，
 *   方便没有 agent 的用户操作？**」）
 *
 * 光有日志不够 —— 界面上要能看到"现在到哪一步了 / 登的是谁 / 成没成"。
 * ⇒ 这个脚本把状态**同时写进一个 json**（`state/bili-login-<QQ>.json`），
 *   `webui.js` 的 `GET /api/bili/login` 直接读它 ⇒ 界面轮询这个就行 ✓
 *
 * ⚠️ 路径**按 QQ 号分**（和 `bili-profile-<QQ>` 一个口径）：
 *   主号也是 `state/bili-login-<QQ>.json`，不搞"主号走老路径"那种例外
 *   —— 界面那边算路径的代码只有一份，少一个分支就少一种错 ✗
 */
const ACCT = String(process.env.QQBOT_ACCOUNT || '').trim();
function stateFile() {
  if (!ACCT) return join(ROOT, 'state', 'bili-login.json');
  return join(ROOT, 'state', `bili-login-${ACCT}.json`);
}
function setState(patch) {
  try {
    const f = stateFile();
    let cur = {};
    try { cur = JSON.parse(readFileSync(f, 'utf8')) || {}; } catch { /* 没有/坏了都当空的 */ }
    writeFileSync(f, JSON.stringify({ ...cur, ...patch, at: Date.now() }, null, 2), 'utf8');
  } catch { /* 状态写不进去不影响登录本身 */ }
}

function say(s) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${s}`;
  console.log(line);
  try {
    appendFileSync(LOG, line + '\n', 'utf8');
  } catch {}
}

if (!existsSync(CHROME)) {
  say(`❌ 找不到 Chrome：${CHROME}`);
  process.exit(1);
}
mkdirSync(PROFILE, { recursive: true });
say(`Chrome: ${CHROME}`);
say(`登录态目录: ${PROFILE}`);
setState({ state: 'running', uid: 0, uname: '', err: '', profile: PROFILE, pid: process.pid });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME,
  headless: false,
  viewport: null,
  // ⚠️ 这两条是为了**不像自动化**：去掉 --enable-automation（那条会让
  //    页面出现"Chrome 正受自动测试软件控制"的横幅），并关掉
  //    navigator.webdriver 那个特征位 ✓
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
});

say('✅ Chrome 已打开。请在窗口里扫码 / 登录 B站，登录成功我会自动关掉它');

const page = ctx.pages()[0] || (await ctx.newPage());
await page
  .goto('https://www.bilibili.com', { waitUntil: 'domcontentloaded', timeout: 45000 })
  .catch(() => {});

/* ⚠️⚠️ 2026-10-21 真踩到（**登录态被 B站 踢掉**那次）：
 *   原来的判据是「**有 SESSDATA + bili_jct 就算登录成功**」——
 *   可 **cookie 过期/被踢时，这两个 cookie 还在**（只是服务端不认了）⇒
 *   脚本 **4 秒就"成功"退出了**，用户根本没扫上码，而 `nav` 明明返回 `isLogin:false` ✗
 *   ⇒ 现在**只认 `nav.data.isLogin === true`**（这才是服务端认不认的唯一判据）✓
 */
const deadline = Date.now() + WAIT_MS;
let sess = null;
let jct = null;
let who = null;
/* ⚠️⚠️ 2026-10-21 又踩一次：`page.evaluate` 查 nav 有个致命问题 ——
 *   **用户一关窗口，page 就没了，navOf() 永远抛错** ⇒ 脚本以为"还没登录"，
 *   在那儿空转满 10 分钟才超时，而用户那边明明已经扫完了 ✗
 *   ⇒ 改用 **`ctx.request`**（Playwright 的 context 级请求，**自己带 cookie**，
 *     完全不依赖页面还开着没有）✓ 并且**每 30 秒报一次进度**，别让人干等。
 */
const navOf = async () => {
  try {
    const r = await ctx.request.get('https://api.bilibili.com/x/web-interface/nav', { timeout: 15000 });
    return await r.json();
  } catch { return null; }
};
let waited = 0;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2500));
  waited += 2.5;
  let cookies = [];
  try {
    cookies = await ctx.cookies('https://www.bilibili.com');
  } catch { /* context 关了就直接跳出去 */ }
  if (!Array.isArray(cookies)) break;
  sess = cookies.find((c) => c.name === 'SESSDATA' && c.value)?.value ?? null;
  jct = cookies.find((c) => c.name === 'bili_jct' && c.value)?.value ?? null;
  const r = await navOf();
  if (r?.data?.isLogin) { who = r.data; break; }   // ✅ 只认服务端
  if (Math.floor(waited) % 30 === 0) {
    say(`还在等…（${Math.round(waited)}s｜cookie ${sess && jct ? '在，但服务端说未登录' : '还没拿到'}）`);
  }
}

if (!who) {
  const why = sess && jct
    ? '等超时了：cookie 在，但 B站 说未登录（登录态已失效）⇒ 请在窗口里真的扫码/输密码登录，然后重试'
    : '等超时了，没检测到登录态（SESSDATA / bili_jct）—— 窗口里再扫一次，或者重新点「登录」';
  setState({ state: 'fail', err: why });
  say(sess && jct
    ? '⏰ 等超时了：cookie 在，但 **B站 说未登录**（登录态已失效）⇒ 请在窗口里**真的扫码/输密码**登录，然后重跑本脚本'
    : '⏰ 等超时了，没检测到登录态（SESSDATA / bili_jct）。窗口留着，你可以再扫一次后重跑本脚本');
  process.exit(2);
}

// ⚠️ 只报 uid / 昵称，**绝不把 SESSDATA 打进日志**（那是账号控制权）
say(`✅ 登录成功：uid=${who.mid} 昵称=${who.uname} 等级=${who.level}`);
setState({ state: 'ok', uid: Number(who.mid) || 0, uname: String(who.uname || ''), err: '' });

try {
  await ctx.close();
} catch {}
say('登录态已存进 state/bili-profile/ ⇒ 之后 tools/bili-upload.mjs 不用再登录 ✓');
process.exit(0);
