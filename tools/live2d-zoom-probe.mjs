/**
 * 探测 bdon.moe 页面的缩放控件（想把模型放大到 200% 取半身，且分辨率不损失）
 * 用法：node tools/live2d-zoom-probe.mjs
 */
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MODEL = 'adv_live2d_sakiko_010_casual_spring_01';
const say = (s) => console.log(`[zoom] ${s}`);
const outDir = join(ROOT, 'logs', 'bili', '__probe');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--no-proxy-server'],
});
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 1200 }, deviceScaleFactor: 1,
  ignoreHTTPSErrors: true, locale: 'zh-CN',
});
const page = await ctx.newPage();
const CACHE = join(ROOT, 'logs', 'bili', 'l2dcache', MODEL);
await page.route('**/storage.bdon.moe/moenotes/**', async (route) => {
  const rel = route.request().url().split('/moenotes/')[1]?.split('?')[0];
  if (!rel) return route.continue();
  const f = join(CACHE, rel);
  if (existsSync(f)) return route.fulfill({ status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' }, path: f });
  return route.continue();
});
await page.goto(`https://bdon.moe/tools/live2d?model=${encodeURIComponent(MODEL)}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
let stable = 0;
for (let i = 0; i < 120 && stable < 3; i++) {
  const loading = await page.evaluate(() => /正在加载模型|模型就绪|正在加载模型列表/.test(document.body.innerText));
  stable = loading ? 0 : stable + 1;
  await page.waitForTimeout(1000);
}
await page.waitForTimeout(2000);

// 列出所有按钮 + 找百分比文字
const btnInfo = await page.evaluate(() => {
  const walk = (root, out) => {
    for (const el of root.querySelectorAll('button')) out.push(el);
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot, out);
    return out;
  };
  const btns = walk(document, []);
  const pct = (document.body.innerText.match(/\d{2,3}%/g) || []).slice(0, 6);
  return {
    total: btns.length,
    small: btns.map((b) => (b.textContent || '').trim()).filter((t) => t && t.length <= 6).slice(0, 40),
    pct,
  };
});
say(JSON.stringify(btnInfo, null, 2));

// 试着点 "+"（页面里是 svg 图标的话 textContent 会是空 ⇒ 找 aria-label/title）
const found = await page.evaluate(() => {
  const walk = (root, out) => {
    for (const el of root.querySelectorAll('button')) out.push(el);
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot, out);
    return out;
  };
  const btns = walk(document, []);
  return btns
    .map((b, i) => ({
      i, text: (b.textContent || '').trim(), aria: b.getAttribute('aria-label') || '',
      title: b.getAttribute('title') || '', cls: String(b.className).slice(0, 40),
    }))
    .filter((x) => /[\+\-−=]|放大|缩小|zoom|scale/i.test(x.text + x.aria + x.title + x.cls));
});
say('疑似缩放按钮：' + JSON.stringify(found, null, 2));

// 点它 4 次，每点一次记一次百分比
for (let k = 0; k < 4; k++) {
  const before = await page.evaluate(() => (document.body.innerText.match(/\d{2,3}%/) || [''])[0]);
  const clicked = await page.evaluate((idx) => {
    const walk = (root, out) => {
      for (const el of root.querySelectorAll('button')) out.push(el);
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot, out);
      return out;
    };
    const b = walk(document, [])[idx];
    if (!b) return false;
    b.click();
    return true;
  }, found.find((x) => /\+|放大|zoom.?in/i.test(x.text + x.aria + x.title))?.i ?? -1);
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => (document.body.innerText.match(/\d{2,3}%/) || [''])[0]);
  say(`第 ${k + 1} 次点击: ${before} → ${after} (clicked=${clicked})`);
}
await page.screenshot({ path: join(outDir, 'zoom_after.png') });
say('截图 → zoom_after.png');

await ctx.close();
await browser.close();
