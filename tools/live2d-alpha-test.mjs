/**
 * 验证两条抠图路线，各出 1 帧：
 *   A. clean：把 canvas 的祖先/兄弟底色全刷透明 + omitBackground ⇒ 真 alpha
 *   B. green：把祖先底色刷纯绿 ⇒ 交给 ffmpeg colorkey
 * 顺带找出盖在 canvas 上的页面 UI（水印/按钮/缩放条）并隐藏
 *
 * 用法：node tools/live2d-alpha-test.mjs
 */
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MODEL = process.argv[2] || 'adv_live2d_sakiko_010_casual_spring_01';
const say = (s) => console.log(`[test] ${s}`);
const outDir = join(ROOT, 'logs', 'bili', '__probe');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--no-proxy-server'],
});
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2,
  ignoreHTTPSErrors: true, locale: 'zh-CN',
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
await page.goto(`https://bdon.moe/tools/live2d?model=${encodeURIComponent(MODEL)}`,
  { waitUntil: 'domcontentloaded', timeout: 90000 });
let stable = 0;
for (let i = 0; i < 120 && stable < 3; i++) {
  const loading = await page.evaluate(() =>
    /正在加载模型|模型就绪|正在加载模型列表/.test(document.body.innerText));
  stable = loading ? 0 : stable + 1;
  await page.waitForTimeout(1000);
}
await page.waitForTimeout(3000);
say('加载完成');

/* ① 找 canvas + 找盖在它上面的 UI */
const geo = await page.evaluate(() => {
  const walk = (root, out) => {
    for (const el of root.querySelectorAll('*')) {
      out.push(el);
      if (el.shadowRoot) walk(el.shadowRoot, out);
    }
    return out;
  };
  const all = walk(document, []);
  const canvas = all.find((e) => e.tagName === 'CANVAS');
  if (!canvas) return { err: 'no canvas' };
  const host = canvas.getRootNode().host;
  const r = canvas.getBoundingClientRect();
  const rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };

  // 在 canvas 上多点取样，看最上层压着谁
  // ⚠️ canvas 在 shadow DOM 里 ⇒ document.elementsFromPoint 返回的是**宿主**，不是 canvas
  //    ⇒ 命中宿主就该停，否则会把整条祖先容器链都当成"覆盖层"隐藏掉（模型会整块消失 ✗）
  const overlays = new Map();
  const pts = [];
  for (const fx of [0.02, 0.5, 0.98]) for (const fy of [0.02, 0.5, 0.98]) pts.push([fx, fy]);
  for (const [fx, fy] of pts) {
    const px = r.x + r.width * fx, py = r.y + r.height * fy;
    for (const el of document.elementsFromPoint(px, py)) {
      if (el === host) break;                       // 到 canvas 宿主就停
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
      const key = el.tagName + '.' + String(el.className).slice(0, 40);
      if (!overlays.has(key)) {
        const er = el.getBoundingClientRect();
        overlays.set(key, {
          tag: el.tagName, cls: String(el.className).slice(0, 60),
          text: (el.innerText || '').trim().slice(0, 20),
          rect: { x: Math.round(er.x), y: Math.round(er.y), w: Math.round(er.width), h: Math.round(er.height) },
          pos: cs.position, z: cs.zIndex,
        });
      }
    }
  }
  return { rect, overlays: [...overlays.entries()].map(([k, v]) => ({ key: k, ...v })) };
});
say(JSON.stringify(geo, null, 2));
if (geo.err) { await browser.close(); process.exit(2); }
const clip = { x: geo.rect.x, y: geo.rect.y, width: geo.rect.w, height: geo.rect.h };

/* ② 隐藏覆盖 UI + 祖先刷透明 ⇒ clean 帧 */
const setup = (mode) => page.evaluate(({ mode, overlayKeys }) => {
  const walk = (root, out) => {
    for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); }
    return out;
  };
  const all = walk(document, []);
  const canvas = all.find((e) => e.tagName === 'CANVAS');
  const host = canvas.getRootNode().host;
  // 隐藏覆盖层（按 tag.class 匹配）
  for (const el of all) {
    const key = el.tagName + '.' + String(el.className).slice(0, 40);
    if (overlayKeys.includes(key)) el.style.setProperty('display', 'none', 'important');
  }
  const paint = (el) => {
    if (!el || !el.style) return;
    el.style.setProperty('background', mode === 'green' ? '#00FF00' : 'transparent', 'important');
    el.style.setProperty('background-image', 'none', 'important');
    el.style.setProperty('box-shadow', 'none', 'important');
    el.style.setProperty('border-radius', '0', 'important');
  };
  // 往上清：host、宿主父链一路到 body
  let p = host;
  let n = 0;
  while (p && p !== document.documentElement && n < 12) { paint(p); p = p.parentElement; n++; }
  paint(document.body); paint(document.documentElement);
  if (mode === 'green') paint(canvas);
  return { host: host.tagName + '.' + host.className, painted: n };
}, { mode, overlayKeys: geo.overlays.map((o) => o.key) });
say('clean 准备：' + JSON.stringify(await setup('clean')));
await page.waitForTimeout(900);
await page.screenshot({ path: join(outDir, 'frame_clean.png'), omitBackground: true, clip });
say('→ frame_clean.png');

/* ③ green 帧 */
say('green 准备：' + JSON.stringify(await setup('green')));
await page.waitForTimeout(900);
await page.screenshot({ path: join(outDir, 'frame_green.png'), omitBackground: true, clip });
say('→ frame_green.png');

await ctx.close();
await browser.close();
say('完成');
