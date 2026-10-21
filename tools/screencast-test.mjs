/**
 * 验证 CDP `Page.startScreencast` 在 headless 下能拿到多少帧
 *
 * 为什么试它：Chrome 的 `recordVideo` 实际内容帧率只有 ~15fps（封装成 25fps 就是
 * 一堆重复帧 ⇒ 用户说的"跳帧/顿挫"）。screencast 是 Chrome **主动推每一帧**、
 * 带真实时间戳，不走 recordVideo 那套封装 ⇒ 有可能拿到更高、更均匀的帧率。
 *
 * 用法：node tools/screencast-test.mjs
 */
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MODEL = 'adv_live2d_sakiko_010_casual_spring_01';
const say = (s) => console.log(`[sc] ${s}`);
mkdirSync(join(ROOT, 'logs', 'bili', '__probe3'), { recursive: true });

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
await page.waitForTimeout(1500);

// 半身放大（和真实录制一致）
await page.evaluate(() => {
  const walk = (root, out) => { for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); } return out; };
  const canvas = walk(document, []).find((e) => e.tagName === 'CANVAS');
  const host = canvas?.getRootNode().host;
  if (!host) return;
  Object.assign(host.style, {
    position: 'fixed', left: '0', top: '0', width: '1400px', height: '1200px',
    transform: 'scale(2)', transformOrigin: 'top center',
    zIndex: '2147483000', background: '#00FF00',
  });
});
await page.waitForTimeout(1000);

const cdp = await ctx.newCDPSession(page);
const frames = [];
cdp.on('Page.screencastFrame', async (e) => {
  frames.push({ ts: e.metadata.timestamp, len: e.data.length });
  try { await cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }); } catch { /* ignore */ }
});

for (const fmt of ['png', 'jpeg']) {
  frames.length = 0;
  await cdp.send('Page.startScreencast', {
    format: fmt, quality: fmt === 'jpeg' ? 92 : undefined,
    maxWidth: 1400, maxHeight: 1200, everyNthFrame: 1,
  });
  await page.waitForTimeout(3000);
  await cdp.send('Page.stopScreencast');
  await page.waitForTimeout(300);

  const n = frames.length;
  if (n < 3) { say(`${fmt}: 只拿到 ${n} 帧 ✗`); continue; }
  const d = [];
  for (let i = 1; i < n; i++) d.push((frames[i].ts - frames[i - 1].ts) * 1000);
  const avg = d.reduce((a, b) => a + b, 0) / d.length;
  const maxd = Math.max(...d), mind = Math.min(...d);
  const span = (frames[n - 1].ts - frames[0].ts);
  say(`${fmt}: ${n} 帧 / ${span.toFixed(2)}s = ${(n / span).toFixed(1)}fps；帧间隔 平均 ${avg.toFixed(1)}ms（${mind.toFixed(0)}~${maxd.toFixed(0)}）`);
  say(`   单帧约 ${Math.round(frames[0].len / 1024)}KB（base64）`);
}

await ctx.close();
await browser.close();
