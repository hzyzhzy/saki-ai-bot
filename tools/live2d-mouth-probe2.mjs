/**
 * 口型专项诊断：这个模型的嘴到底怎么才能张开
 *
 * 背景（用户 2026-10-21 连着两次说「还是明显没有张嘴」）：
 *   已经能抓到 Cubism model 实例、也能每帧写 ParamMouthOpenY，但画面上只是"一条小缝"。
 *   怀疑点：
 *     ① ParamMouthOpenY 的范围/灵敏度本身很小
 *     ② 这个模型有 `ParamMouthSiwaON`（闭嘴开关）之类在**压着**它
 *     ③ 实际是别的参数（MouthForm / Mouthupdawn / Mouthside）控制嘴形
 *
 * 做法：打印所有 Mouth 类参数的范围与当前值，再**逐个组合**试，每次都截嘴部特写对比。
 * 用法：node tools/live2d-mouth-probe2.mjs
 */
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MODEL = 'adv_live2d_sakiko_010_casual_spring_01';
const say = (s) => console.log(`[mp2] ${s}`);
const outDir = join(ROOT, 'logs', 'bili', '__probe2');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--no-proxy-server'],
});
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 1200 }, deviceScaleFactor: 2,
  ignoreHTTPSErrors: true, locale: 'zh-CN',
});

// 抓模型 + 提供"强制参数"入口（每帧 update 前写入，最后写的一定生效）
await ctx.addInitScript(() => {
  window.__probe = { models: [], force: {} };
  const patch = () => {
    const core = window.Live2DCubismCore;
    if (!core?.Model?.prototype) return false;
    const proto = core.Model.prototype;
    if (proto.__probePatched) return true;
    const origUpdate = proto.update;
    proto.update = function (...a) {
      if (!this.__seen) { this.__seen = true; window.__probe.models.push(this); }
      // ⚠️ core 里**没有** setParameterValueById（实例上也没有，实测报 not a function）
      //    唯一可靠写法：直接写 parameters.values 数组
      try {
        const P = this.parameters;
        const ids = P.ids;
        for (const [k, v] of Object.entries(window.__probe.force)) {
          for (let i = 0; i < ids.length; i++) {
            if (String(ids[i]) === k) { P.values[i] = v; break; }
          }
        }
      } catch (e) { window.__probe.err = e.message; }
      return origUpdate.apply(this, a);
    };
    proto.__probePatched = true;
    return true;
  };
  if (!patch()) { const t = setInterval(() => { if (patch()) clearInterval(t); }, 200); }
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

// 放大取半身（看得清嘴）
await page.evaluate(({ zoom, vw, vh }) => {
  const walk = (root, out) => { for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); } return out; };
  const canvas = walk(document, []).find((e) => e.tagName === 'CANVAS');
  const host = canvas?.getRootNode().host;
  if (!host) return false;
  Object.assign(host.style, {
    position: 'fixed', left: '0', top: '0',
    width: vw + 'px', height: vh + 'px',
    transform: `scale(${zoom})`, transformOrigin: 'top center',
    zIndex: '2147483000', background: '#00FF00',
  });
  return true;
}, { zoom: 2, vw: 1400, vh: 1200 });
await page.waitForTimeout(1500);

// ① 打印所有 Mouth 参数的范围与当前值
const info = await page.evaluate(() => {
  const m = window.__probe.models[0];
  if (!m) return { err: 'no model' };
  const P = m.parameters;
  const ids = Array.from(P.ids || []);
  const rows = [];
  for (let i = 0; i < ids.length; i++) {
    const id = String(ids[i]);
    if (!/mouth/i.test(id)) continue;
    rows.push({
      id, i,
      min: +Number(P.minimumValues?.[i]).toFixed(3),
      max: +Number(P.maximumValues?.[i]).toFixed(3),
      def: +Number(P.defaultValues?.[i]).toFixed(3),
      cur: +Number(P.values?.[i]).toFixed(3),
    });
  }
  return { rows, total: ids.length };
});
say(JSON.stringify(info, null, 2));

// ② 组合测试：每次都截嘴部特写
const mouthClip = { x: 520, y: 380, width: 380, height: 240 };
const combos = [
  ['baseline', {}],
  ['open1', { ParamMouthOpenY: 1 }],
  ['open1_siwa0', { ParamMouthOpenY: 1, ParamMouthSiwaON: 0 }],
  ['open1_siwa0_siwa2_0', { ParamMouthOpenY: 1, ParamMouthSiwaON: 0, ParamMouthSiwaON2: 0 }],
  ['open1_formNeg1', { ParamMouthOpenY: 1, ParamMouthForm: -1 }],
  ['open1_siwa0_formNeg1', { ParamMouthOpenY: 1, ParamMouthSiwaON: 0, ParamMouthForm: -1 }],
  ['open1_siwa0_formNeg1_side3', { ParamMouthOpenY: 1, ParamMouthSiwaON: 0, ParamMouthForm: -1, ParamMouthside: 3 }],
  ['open1_updawn1', { ParamMouthOpenY: 1, ParamMouthupdawn: 1 }],
  ['open1_strength1', { ParamMouthOpenY: 1, ParamMouthStrength: 1 }],
];
for (const [name, force] of combos) {
  await page.evaluate((f) => { window.__probe.force = f; }, force);
  await page.waitForTimeout(500);
  const out = join(outDir, `${name}.png`);
  await page.screenshot({ path: out, clip: mouthClip });
  say(`${name}: ${JSON.stringify(force)}`);
}
const err = await page.evaluate(() => window.__probe.err || null);
if (err) say('写入参数时报错：' + err);
say('截图 → ' + outDir);

await ctx.close();
await browser.close();
