/**
 * 探测：能不能在 bdon.moe 页面里**直接驱动 Cubism 参数**（口型同步的前提）
 *
 * 思路：页面用的是 Cubism 5 core（全局 `Live2DCubismCore`）。
 *   core 的 `Model.prototype.update` 每帧都会跑 ⇒ patch 它就能抓到所有 Model 实例，
 *   并且在"每帧 update 之前"写入 ParamMouthOpenY（player 自己写参数在这个之前，
 *   我们最后写 ⇒ 一定生效）✓
 *
 * 用法：node tools/live2d-mouth-probe.mjs
 */
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MODEL = 'adv_live2d_sakiko_010_casual_spring_01';
const say = (s) => console.log(`[mouth] ${s}`);
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

// ① 页面脚本之前就挂上钩子：轮询等 Live2DCubismCore 出现再 patch
await ctx.addInitScript(() => {
  window.__l2d = { models: [], patched: false, log: [] };
  const patch = () => {
    const core = window.Live2DCubismCore;
    if (!core || !core.Model || !core.Model.prototype) return false;
    const proto = core.Model.prototype;
    if (proto.__dshPatched) return true;
    const origUpdate = proto.update;
    proto.update = function (...args) {
      if (!window.__l2d.models.includes(this)) {
        window.__l2d.models.push(this);
        try {
          const n = this.parameters?.ids?.length ?? this.getParameterCount?.() ?? -1;
          window.__l2d.log.push('model captured, params=' + n);
        } catch (e) { window.__l2d.log.push('capture err ' + e.message); }
      }
      // 每帧 update 之前写入口型（player 写参数在本函数之前 ⇒ 我们覆盖它）
      try {
        const v = window.__l2d.mouth || 0;
        if (v > 0) {
          this.setParameterValueById('ParamMouthOpenY', v, 1);
        }
      } catch (e) {
        if (window.__l2d.log.length < 20) window.__l2d.log.push('set err ' + e.message);
      }
      return origUpdate.apply(this, args);
    };
    proto.__dshPatched = true;
    return true;
  };
  if (!patch()) {
    const t = setInterval(() => { if (patch()) clearInterval(t); }, 200);
    setTimeout(() => clearInterval(t), 60000);
  }
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
await page.waitForTimeout(2500);

const st = await page.evaluate(() => ({
  hasCore: !!window.Live2DCubismCore,
  hasModel: !!window.Live2DCubismCore?.Model,
  patched: !!window.Live2DCubismCore?.Model?.prototype?.__dshPatched,
  models: window.__l2d?.models?.length ?? -1,
  log: (window.__l2d?.log || []).slice(0, 6),
  // 看看模型有没有参数 id 列表
  paramIds: (() => {
    const m = window.__l2d?.models?.[0];
    if (!m) return null;
    try {
      const ids = m.parameters?.ids;
      if (ids) return Array.from(ids).filter((x) => /Mouth|mouth/.test(String(x))).slice(0, 12);
    } catch {}
    return null;
  })(),
}));
say(JSON.stringify(st, null, 2));

// ② 把嘴张到最大，截图对比
if (st.models > 0) {
  await page.evaluate(() => { window.__l2d.mouth = 1.0; });
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(outDir, 'mouth_open.png'), clip: { x: 400, y: 200, width: 600, height: 500 } });
  await page.evaluate(() => { window.__l2d.mouth = 0; });
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(outDir, 'mouth_closed.png'), clip: { x: 400, y: 200, width: 600, height: 500 } });
  say('两张对照图 → __probe/mouth_open.png / mouth_closed.png');
} else {
  say('❌ 没抓到 Model 实例，口型这条路要换方案');
}

await ctx.close();
await browser.close();
