/**
 * 探测 bdon.moe Live2D 页里的 canvas 结构（穿透 shadow DOM）
 * 用法：node tools/live2d-probe.mjs
 */
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MODEL = process.argv[2] || 'adv_live2d_sakiko_010_casual_spring_01';
const say = (s) => console.log(`[probe] ${s}`);
const outDir = join(ROOT, 'logs', 'bili', '__probe');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--no-proxy-server'],
});
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 1000 },
  deviceScaleFactor: 2,
  ignoreHTTPSErrors: true,
  locale: 'zh-CN',
});
const page = await ctx.newPage();

const CACHE = join(ROOT, 'logs', 'bili', 'l2dcache', MODEL);
await page.route('**/storage.bdon.moe/moenotes/**', async (route) => {
  const rel = route.request().url().split('/moenotes/')[1]?.split('?')[0];
  if (!rel) return route.continue();
  const f = join(CACHE, rel);
  if (existsSync(f)) {
    return route.fulfill({ status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' }, path: f });
  }
  return route.continue();
});

await page.goto(`https://bdon.moe/tools/live2d?model=${encodeURIComponent(MODEL)}`, {
  waitUntil: 'domcontentloaded', timeout: 90000,
});
let stable = 0;
for (let i = 0; i < 120 && stable < 3; i++) {
  const loading = await page.evaluate(() =>
    /正在加载模型|模型就绪|正在加载模型列表/.test(document.body.innerText));
  stable = loading ? 0 : stable + 1;
  await page.waitForTimeout(1000);
}
say('加载判据稳定');
await page.waitForTimeout(3000);

const info = await page.evaluate(() => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  // 递归收集所有 shadow root（含 nested）
  const allEls = [];
  const walk = (root, depth) => {
    for (const el of root.querySelectorAll('*')) {
      allEls.push({ el, depth });
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
    }
  };
  walk(document, 0);
  const canvases = [];
  for (const { el, depth } of allEls) {
    if (el.tagName === 'CANVAS') {
      let alpha = null, clear = null;
      try {
        const gl = el.getContext('webgl2') || el.getContext('webgl');
        if (gl) {
          alpha = gl.getContextAttributes().alpha;
          const cv = gl.getParameter(gl.COLOR_CLEAR_VALUE);
          clear = [cv[0], cv[1], cv[2], cv[3]].map((v) => +Number(v).toFixed(3));
        }
      } catch (e) { alpha = 'err:' + e.message; }
      const cs = getComputedStyle(el);
      canvases.push({
        rect: rect(el), cssW: el.style.width, cssH: el.style.height,
        alpha, clearColor: clear,
        cssBg: cs.backgroundColor, cssBgImg: cs.backgroundImage.slice(0, 50),
        hostTag: el.getRootNode().host?.tagName || null,
        hostCls: el.getRootNode().host?.className || null,
        depth,
      });
    }
  }
  // 页面里 tag 名带 live2d 的元素
  const tagged = allEls.filter(({ el }) => /live2d|stage|canvas/i.test(el.tagName) || /live2d/i.test(String(el.className)))
    .map(({ el, depth }) => ({ tag: el.tagName, cls: String(el.className).slice(0, 60), rect: rect(el), depth, host: !!el.getRootNode().host }));
  return { canvases, tagged: tagged.slice(0, 20) };
});
say(JSON.stringify(info, null, 2));

// 刷绿测试：给 canvas 设 CSS 背景 + 宿主设绿底
const c0 = info.canvases[0];
if (c0) {
  const ok = await page.evaluate(() => {
    const found = [];
    const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'CANVAS') found.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
    walk(document);
    if (!found.length) return 'no canvas';
    const c = found[0];
    c.style.background = '#00FF00';
    const host = c.getRootNode().host;
    if (host) { host.style.background = '#00FF00'; host.style.backgroundImage = 'none'; }
    // 往上两层也刷绿
    let p = host;
    for (let i = 0; i < 3 && p; i++) { p.style.background = '#00FF00'; p.style.backgroundImage = 'none'; p = p.parentElement; }
    return 'done';
  });
  say('刷绿：' + ok);
  await page.waitForTimeout(1000);
  const clip = { x: c0.rect.x, y: c0.rect.y, width: c0.rect.w, height: c0.rect.h };
  await page.screenshot({ path: join(outDir, 'canvas_green.png'), clip });
  say(`canvas 区域截图 → ${join(outDir, 'canvas_green.png')} clip=${JSON.stringify(clip)}`);
}

await ctx.close();
await browser.close();
say('完成');
