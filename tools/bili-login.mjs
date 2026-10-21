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
import { mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME =
  process.env.BILI_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE = process.env.BILI_PROFILE || join(ROOT, 'state', 'bili-profile');
const LOG = join(ROOT, 'logs', 'bili-login.log');
const WAIT_MS = Number(process.env.BILI_WAIT_MS || 10 * 60 * 1000);

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

const deadline = Date.now() + WAIT_MS;
let sess = null;
let jct = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  let cookies = [];
  try {
    cookies = await ctx.cookies('https://www.bilibili.com');
  } catch {}
  sess = cookies.find((c) => c.name === 'SESSDATA' && c.value)?.value ?? null;
  jct = cookies.find((c) => c.name === 'bili_jct' && c.value)?.value ?? null;
  if (sess && jct) break;
}

if (!sess || !jct) {
  say('⏰ 等超时了，没检测到登录态（SESSDATA / bili_jct）。窗口留着，你可以再扫一次后重跑本脚本');
  process.exit(2);
}

// ⚠️ 只报 uid / 昵称，**绝不把 SESSDATA 打进日志**（那是账号控制权）
try {
  const r = await page.evaluate(async () => {
    const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      credentials: 'include',
    });
    return res.json();
  });
  if (r?.data?.isLogin) {
    say(`✅ 登录成功：uid=${r.data.mid} 昵称=${r.data.uname} 等级=${r.data.level}`);
  } else {
    say('⚠️ 拿到 cookie 了，但 nav 说未登录（可能刚登录还没刷新）');
  }
} catch (e) {
  say(`⚠️ 查账号信息失败（不影响登录态）：${e.message}`);
}

try {
  await ctx.close();
} catch {}
say('登录态已存进 state/bili-profile/ ⇒ 之后 tools/bili-upload.mjs 不用再登录 ✓');
process.exit(0);
