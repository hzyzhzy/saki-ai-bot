#!/usr/bin/env node
/**
 * 从**你日常用的 Chrome** 里把 B站登录态搬到 `state/bili-profile`（2026-10-21 加）
 *
 * ## 用户要求
 *   「**可以自动登录吗**」+「**做，然后只在私聊提醒我**」
 *
 * ## 为什么只能这么"自动"
 *   B站 **没有**能自动化登录的接口：
 *   · 密码登录要走**极验验证码**（滑块 + 行为轨迹）⇒ 纯代码过不去 ✗
 *   · 扫码登录必须人拿手机扫 ✗
 *   ⇒ 唯一能"不用你动手"的路 = **把日常 Chrome 里已经登录好的那几张票搬过来**：
 *     `SESSDATA` / `bili_jct` / `DedeUserID`（**只搬票，不碰密码**）✓
 *
 * ## ⚠️ 怎么解 Chrome 的 cookie
 *   Chrome 80+ 的 cookie 是 **AES-256-GCM** 加密的：
 *   · 密钥本身藏在 `Local State` 的 `os_crypt.encrypted_key`，**再用 Windows DPAPI 包一层**
 *   · 数据库里每条 `encrypted_value` = `v10` + 12 字节 nonce + 密文 + 16 字节 tag
 *   ⇒ ① PowerShell 调 DPAPI 解出密钥 → ② `node:sqlite` 读库 → ③ AES-GCM 逐条解 ✓
 *
 * ## 用法
 *   node tools/bili-cookie-import.mjs            # 真搬
 *   node tools/bili-cookie-import.mjs --dry      # 只看能不能解开，不写入
 *
 * ⚠️ 只读你 Chrome 的 cookie 文件（复制一份再读，不动原件）；
 *   搬完**只用 `addCookies` 写进 `state/bili-profile`**，不会把 cookie 打进取任何日志、任何仓库 ✓
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { biliProfileDir } from './lib/browser.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// ⚠️ 2026-10-21：**按 QQ 号分 profile**（主号走老路径 state/bili-profile，别的号 state/bili-profile-<QQ>）
const PROFILE = biliProfileDir();
const DRY = process.argv.includes('--dry');
const say = (s) => console.log(`[搬票] ${s}`);

/** 找 Chrome 的 User Data 目录（多开过的可能要挑一个） */
function chromeDataDir() {
  const cands = [
    join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data'),
    join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome Beta', 'User Data'),
    join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data'),
  ];
  return cands.find((p) => p && existsSync(join(p, 'Local State'))) || '';
}

/** 用 Windows DPAPI 解出 Chrome 的 AES 密钥 */
function dpapiUnprotect(b64) {
  // ⚠️ 走 PowerShell 而不是自己调 ffi：这台机器上没有编译好的绑定，PowerShell 自带 DPAPI ✓
  const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$b=[Convert]::FromBase64String('${b64}')
$u=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser')
[Convert]::ToBase64String($u)
`.trim();
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 30000,
  });
  return Buffer.from(String(out).trim(), 'base64');
}

/** AES-256-GCM 解一条 encrypted_value */
function decryptValue(enc, key) {
  const buf = Buffer.from(enc);
  const prefix = buf.slice(0, 3).toString('utf8');
  if (prefix !== 'v10' && prefix !== 'v11') {
    // 老格式（Chrome 80 以前）是直接 DPAPI 的
    return null;
  }
  const nonce = buf.slice(3, 15);
  const tag = buf.slice(buf.length - 16);
  const ct = buf.slice(15, buf.length - 16);
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(tag);
  const plain = Buffer.concat([d.update(ct), d.final()]);
  /* ⚠️ Chrome 24+ 在明文前面塞了 **32 字节的 domain hash**，要跳过 —— 
   *   不跳过的话拿到的 cookie 值前面会粘一串乱码 ⇒ 注入后还是未登录 ✗ */
  return plain.length > 32 ? plain.slice(32).toString('utf8') : plain.toString('utf8');
}

const WANT = new Set(['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'buvid3', 'buvid4', 'bili_ticket']);

const dataDir = chromeDataDir();
if (!dataDir) { say('❌ 找不到 Chrome / Edge 的 User Data 目录'); process.exit(2); }
say('Chrome 数据目录：' + dataDir);

const lsPath = join(dataDir, 'Local State');
const ls = JSON.parse(readFileSync(lsPath, 'utf8'));
const encKeyB64 = ls?.os_crypt?.encrypted_key;
if (!encKeyB64) { say('❌ Local State 里没有 os_crypt.encrypted_key（Chrome 版本太老？）'); process.exit(2); }
// 前 5 个字节是 "DPAPI" 标记
const keyRaw = Buffer.from(encKeyB64, 'base64');
say('encrypted_key 前缀：' + keyRaw.slice(0, 5).toString('utf8') + '（长度 ' + keyRaw.length + '）');
const aesKey = dpapiUnprotect(keyRaw.slice(5).toString('base64'));
say('解出 AES 密钥：' + aesKey.length + ' 字节' + (aesKey.length === 32 ? ' ✓（正好 256 位）' : ' ⚠️ 不是 32 字节'));

/* 找 Cookies 数据库（新版在 Network/Cookies，老版在 Cookies） */
const cookieCands = [join(dataDir, 'Default', 'Network', 'Cookies'), join(dataDir, 'Default', 'Cookies')];
const cookieDb = cookieCands.find((p) => existsSync(p));
if (!cookieDb) { say('❌ 找不到 Cookies 数据库'); process.exit(2); }
say('Cookies 库：' + cookieDb + `（${(statSync(cookieDb).size / 1024).toFixed(0)} KB）`);

/* ⚠️⚠️ 2026-10-21 修：**Chrome 开着的时候 `copyFileSync` 会 EBUSY**（库被独占）✗
 *   ⇒ 先试复制（Chrome 没开时最稳），**失败就改用 `immutable=1` 只读直连**：
 *     `file:///C:/.../Cookies?immutable=1` —— 注意**空格要 %20**，
 *     不然 sqlite 认不出这个 URI（这个坑我踩了两次）✓
 */
const { DatabaseSync } = await import('node:sqlite');
const pickSql = "SELECT host_key, name, encrypted_value, path, CAST(expires_utc AS TEXT) AS expires_utc, is_secure, is_httponly FROM cookies WHERE host_key LIKE '%bilibili%'";
let rows = [];
let tmpDb = '';
let copied = false;

tmpDb = join(ROOT, 'logs', `__cookies-copy-${Date.now()}.sqlite`);
try {
  copyFileSync(cookieDb, tmpDb);
  copied = true;
  say('已复制一份到临时文件（不动你原来的库）');
} catch (e) {
  say(`复制失败（${String(e.code || e.message).slice(0, 40)}）⇒ 改用只读直连（Chrome 正开着也能读）`);
}

try {
  const uri = 'file:///' + cookieDb.replace(/\\/g, '/').replace(/ /g, '%20');
  const db = new DatabaseSync(copied ? tmpDb : `${uri}?immutable=1`, { readOnly: true });
  rows = db.prepare(pickSql).all();
  db.close();
  say(copied ? '读取方式：临时副本' : '读取方式：immutable=1 只读直连');
} catch (e) {
  say('❌ 读 sqlite 失败：' + e.message + '（Node 22+ 才有 node:sqlite）');
  process.exit(2);
}

say(`bilibili 相关 cookie：${rows.length} 条`);
const got = {};
for (const r of rows) {
  if (!WANT.has(r.name)) continue;
  try {
    const v = decryptValue(r.encrypted_value, aesKey);
    if (v) got[r.name] = { value: v, host: r.host_key, path: r.path || '/', secure: !!r.is_secure, httpOnly: !!r.is_httponly, expires: Number(r.expires_utc) };
  } catch (e) {
    say(`  解 ${r.name} 失败：${e.message.slice(0, 60)}`);
  }
}
const names = Object.keys(got);
say('解出来的票：' + (names.length ? names.join(', ') : '（一条都没解出来）'));
if (got.SESSDATA) say('SESSDATA 长度：' + got.SESSDATA.value.length + '（够不够长一眼能看出来）');

if (!got.SESSDATA || !got.bili_jct) {
  say('❌ 缺 SESSDATA / bili_jct —— 说明你**日常那个 Chrome 没登录 B站**，或者登录的是另一个 Windows 用户');
  process.exit(3);
}
if (DRY) {
  say('（--dry，没有写入）');
  process.exit(0);
}

/* 注入到 bili-profile */
mkdirSync(PROFILE, { recursive: true });
const { chromium } = await import('playwright-core');
const { browserOpts } = await import('./lib/browser.mjs');
// ⚠️ 不用 launchPersistentContext（那会起窗口）；这里只要写 cookie ⇒ 用 launchPersistentContext + headless
const ctx = await chromium.launchPersistentContext(PROFILE, {
  ...browserOpts(), headless: true,
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--disable-blink-features=AutomationControlled'],
});
/* ⚠️ Chrome 的 expires_utc 是**1601 年起的微秒**，Playwright 要**毫秒时间戳** */
const toMs = (v) => (v > 1e15 ? Math.round(v / 1000 - 11644473600000) : -1);
const cookies = Object.values(got).map((c) => ({
  name: Object.keys(got).find((k) => got[k] === c),
  value: c.value,
  domain: c.host.startsWith('.') ? c.host : c.host,
  path: c.path || '/',
  expires: toMs(c.expires),
  httpOnly: c.httpOnly,
  secure: c.secure,
  sameSite: 'Lax',
}));
await ctx.addCookies(cookies);
say(`已注入 ${cookies.length} 条 cookie`);

// 验一下
const page = await ctx.newPage();
await page.goto('https://api.bilibili.com/x/web-interface/nav', { waitUntil: 'domcontentloaded', timeout: 45000 });
const j = JSON.parse(await page.evaluate(() => document.body.innerText));
if (j?.data?.isLogin) {
  say(`✅ 登录成功：uid=${j.data.mid} 昵称=${j.data.uname}（票是从你日常 Chrome 搬过来的）`);
} else {
  say(`❌ 注入了但还是未登录（code=${j?.code}）—— 可能日常 Chrome 那份也失效了，只能扫码`);
}
try { await ctx.close(); } catch { /* ignore */ }
try { const fs = await import('node:fs'); fs.unlinkSync(tmpDb); } catch { /* ignore */ }
process.exit(j?.data?.isLogin ? 0 : 4);
