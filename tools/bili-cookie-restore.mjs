/**
 * 把导出的 B站 登录态**注入**回一个浏览器 profile（`state/bili-cookie/` 下的备份）。
 *
 * ## 背景（2026-10-26）
 *
 * 用户问「导出 cookie 长期复用可不可行」。实测：
 *   · **可行** —— playwright 的 `storageState()` 给的是**已解密**的 cookie（不用碰 Windows DPAPI），
 *     导出来就是明文 JSON，注入回去就能用 ✓
 *   · 但它只能救**本地原因**造成的失效（profile 被抢 / 被强杀写坏 / 换机器 / profile 丢了）；
 *   · **服务端主动作废 SESSDATA** 的那种，注入了照样 -101 ✗（这点必须说清楚，别指望它万能）
 *
 * ## 用法
 *
 *   node tools/bili-cookie-restore.mjs                    # 注入回主 profile
 *   node tools/bili-cookie-restore.mjs --dry               # 只校验备份内容，不动 profile
 *   node tools/bili-cookie-restore.mjs --profile D:/tmp/p  # 注入到别的 profile（验证用）
 *   node tools/bili-cookie-restore.mjs --file state/bili-cookie/bili-10000002.json
 *
 * ⚠️ 备份文件里是**明文 SESSDATA = 账号控制权**，`state/` 已在 .gitignore，别拷出去 ✓
 */
import { chromium } from 'playwright-core';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.BILI_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const argOf = (name, def = '') => {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const FILE = String(argOf('file', join(ROOT, 'state', 'bili-cookie', 'bili-10000002.json')));
const PROFILE = String(argOf('profile', join(ROOT, 'state', 'bili-profile')));
const DRY = !!argOf('dry', false);

if (!existsSync(FILE)) {
  console.error('❌ 找不到备份文件:', FILE);
  process.exit(1);
}

const payload = JSON.parse(readFileSync(FILE, 'utf8'));
const state = payload.storageState || {};
const cookies = state.cookies || [];
const KEY = ['SESSDATA', 'bili_jct', 'DedeUserID'];
const has = KEY.every((k) => cookies.some((c) => c.name === k && String(c.value || '').length > 4));

console.log('备份文件:', FILE);
console.log('  导出时间:', payload.exportedAt || '?');
console.log('  账号:', payload.uname || '?', '(uid', payload.uid || '?', ')');
console.log('  cookie 总数:', cookies.length);
for (const k of KEY) {
  const c = cookies.find((x) => x.name === k);
  const exp = c && c.expires > 0 ? new Date(c.expires * 1000).toLocaleString('zh-CN') : '?';
  console.log(`  ${k.padEnd(12)} ${c ? '有（' + String(c.value).length + ' 字符，到期 ' + exp + '）' : '❌ 缺'}`);
}

if (!has) {
  console.error('❌ 备份不完整（缺 SESSDATA / bili_jct / DedeUserID），注入也没用');
  process.exit(1);
}

if (DRY) {
  console.log('\n(--dry：只校验，不动 profile)');
  process.exit(0);
}

console.log('\n注入到 profile:', PROFILE);
const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME,
  headless: false,
  viewport: { width: 1280, height: 800 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  args: [
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--window-position=-32000,-32000',
  ],
});

try {
  await ctx.addCookies(cookies); // 明文 cookie，直接灌
  const page = await ctx.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9' });
  await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);

  const nav = await page.evaluate(async () => {
    const r = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
    return await r.json();
  });
  if (nav.data?.isLogin) {
    console.log('✅ 注入成功，登录态有效：', nav.data.uname, '(uid', nav.data.mid, ')');
  } else {
    console.log('❌ 注入后仍然未登录（nav code =', nav.code, '）');
    console.log('   ⇒ 说明是**服务端作废了会话**，这份备份也救不回来，只能重新扫码 ✗');
  }
} catch (e) {
  console.log('出错:', String(e.message).slice(0, 200));
} finally {
  await ctx.close();
}
