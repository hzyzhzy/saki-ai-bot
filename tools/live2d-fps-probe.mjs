/**
 * 测 bdon.moe 页面在「半身放大」状态下的**真实渲染帧率**，并试几档减负
 *
 * 背景（用户 2026-10-21：「翻页跳帧」= 和 Live2D 同因）：
 *   录屏时间戳是均匀 25fps，但**内容**有大量重复帧 ⇒ 页面本身渲染跟不上。
 *   一帧走一大步 = 视觉上的"跳帧"。所以要先把页面的 rAF 帧率测出来，
 *   再一档一档减负看到哪档能稳在 24~25fps。
 *
 * 用法：node tools/live2d-fps-probe.mjs
 */
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MODEL = 'adv_live2d_sakiko_010_casual_spring_01';
const say = (s) => console.log(`[fps] ${s}`);
mkdirSync(join(ROOT, 'logs', 'bili', '__probe3'), { recursive: true });

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--no-proxy-server'],
});

const run = async ({ dsf, zoom }) => {
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 1200 }, deviceScaleFactor: dsf,
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

  // 半身放大（和录制时一致）
  await page.evaluate(({ zoom, vw, vh }) => {
    const walk = (root, out) => { for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); } return out; };
    const canvas = walk(document, []).find((e) => e.tagName === 'CANVAS');
    const host = canvas?.getRootNode().host;
    if (!host) return;
    Object.assign(host.style, {
      position: 'fixed', left: '0', top: '0', width: vw + 'px', height: vh + 'px',
      transform: `scale(${zoom})`, transformOrigin: 'top center',
      zIndex: '2147483000', background: '#00FF00',
    });
  }, { zoom, vw: 1400, vh: 1200 });
  await page.waitForTimeout(1000);

  const measure = () => page.evaluate(() => new Promise((res) => {
    let n = 0;
    const t0 = performance.now();
    const tick = () => {
      n++;
      if (performance.now() - t0 < 1500) requestAnimationFrame(tick);
      else res(Math.round((n / (performance.now() - t0)) * 1000 * 10) / 10);
    };
    requestAnimationFrame(tick);
  }));

  const before = await measure();

  // 关掉「物理效果」和「呼吸」（Live2D 的物理计算最吃 CPU）
  const toggled = await page.evaluate(() => {
    const out = [];
    const walk = (root, acc) => { for (const el of root.querySelectorAll('*')) { acc.push(el); if (el.shadowRoot) walk(el.shadowRoot, acc); } return acc; };
    const all = walk(document, []);
    // 复选框常常是 input + 旁边的 label/span 文字
    for (const name of ['物理效果', '呼吸']) {
      const lab = all.find((el) => el.textContent && el.textContent.trim() === name && el.tagName !== 'BUTTON');
      if (!lab) { out.push(name + ':没找到'); continue; }
      const box = lab.closest('label')?.querySelector('input[type=checkbox]') || lab.parentElement?.querySelector('input[type=checkbox]');
      if (box && box.checked) { box.click(); out.push(name + ':已关'); }
      else out.push(name + ':' + (box ? '本来就是关的' : '没找到复选框'));
    }
    return out;
  });
  await page.waitForTimeout(800);
  const after = await measure();

  await ctx.close();
  return { dsf, zoom, fpsBefore: before, fpsAfter: after, toggled };
};

for (const cfg of [
  { dsf: 2, zoom: 2 },
  { dsf: 1, zoom: 2 },
  { dsf: 1, zoom: 1.5 },
]) {
  const r = await run(cfg);
  say(`dsf=${r.dsf} zoom=${r.zoom} → 减负前 ${r.fpsBefore} fps / 关物理呼吸后 ${r.fpsAfter} fps  ${r.toggled.join(' ')}`);
}

await browser.close();
