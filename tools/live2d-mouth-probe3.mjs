/**
 * 验证：**点过表情动作之后，口型还能不能张开**
 *
 * 线索：hook 写入是成功的（诊断显示 lastOk.v=0.79、无报错），但成片里嘴只有一条缝。
 * 怀疑 smile01_R 这类表情会改写嘴部变形器/参数，把 ParamMouthOpenY 的效果压掉。
 *
 * 做法：同一模型、同一位置，分三组各截一张嘴部特写：
 *   ① 不点任何动作 + OpenY=1
 *   ② 点 smile01_R 之后 + OpenY=1
 *   ③ 点 nod01_C 之后 + OpenY=1（纯头部动作，应当不影响嘴）
 *
 * 用法：node tools/live2d-mouth-probe3.mjs
 */
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MODEL = 'adv_live2d_sakiko_010_casual_spring_01';
const say = (s) => console.log(`[mp3] ${s}`);
const outDir = join(ROOT, 'logs', 'bili', '__probe3');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--no-proxy-server'],
});
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 1200 }, deviceScaleFactor: 2,
  ignoreHTTPSErrors: true, locale: 'zh-CN',
});
await ctx.addInitScript(() => {
  window.__p = { models: [], open: 0, err: null };
  const patch = () => {
    const core = window.Live2DCubismCore;
    if (!core?.Model?.prototype) return false;
    const proto = core.Model.prototype;
    if (proto.__pp) return true;
    const orig = proto.update;
    proto.update = function (...a) {
      if (!this.__seen) { this.__seen = true; window.__p.models.push(this); }
      try {
        const P = this.parameters;
        if (!this.__mi) {
          this.__mi = -1;
          for (let i = 0; i < P.ids.length; i++) if (String(P.ids[i]) === 'ParamMouthOpenY') { this.__mi = i; break; }
        }
        // 一次覆盖**所有** Mouth* 参数：动作/表情会把嘴部一批参数写回去，
        // 只写 OpenY 会被它们压成一条缝
        if (!this.__mouthIdx) {
          const mi = [];
          for (let i = 0; i < P.ids.length; i++) if (/^ParamMouth/i.test(String(P.ids[i]))) mi.push(i);
          this.__mouthIdx = mi;
        }
        const F = window.__p;
        for (const i of this.__mouthIdx) {
          const id = String(P.ids[i]);
          if (id === 'ParamMouthOpenY') P.values[i] = F.open;
          else if (F.allZero) P.values[i] = 0;   // 其余嘴部参数清零（闭嘴开关/歪斜/强度）
        }
      } catch (e) { window.__p.err = e.message; }
      return orig.apply(this, a);
    };
    proto.__pp = true;
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

await page.evaluate(({ zoom, vw, vh }) => {
  const walk = (root, out) => { for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); } return out; };
  const canvas = walk(document, []).find((e) => e.tagName === 'CANVAS');
  const host = canvas?.getRootNode().host;
  if (!host) return false;
  Object.assign(host.style, {
    position: 'fixed', left: '0', top: '0', width: vw + 'px', height: vh + 'px',
    transform: `scale(${zoom})`, transformOrigin: 'top center',
    zIndex: '2147483000', background: '#00FF00',
  });
  return true;
}, { zoom: 2, vw: 1400, vh: 1200 });
await page.waitForTimeout(1500);

const clip = { x: 520, y: 380, width: 380, height: 240 };
const clickBtn = (name) => page.evaluate((nm) => {
  const btns = [];
  const walk = (root) => { for (const el of root.querySelectorAll('button')) btns.push(el); for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot); };
  walk(document);
  const b = btns.find((x) => x.textContent.trim() === nm);
  if (b && !b.disabled) { b.click(); return true; }
  return false;
}, name);

const shot = async (name, open) => {
  await page.evaluate((v) => { window.__p.open = v; }, open);
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(outDir, `${name}.png`), clip });
  say(`${name}（OpenY=${open}）`);
};

// ① 不点动作
await shot('1_noAction_open1', 1);
await shot('1_noAction_open0', 0);
// ② 点表情动作之后
say('smile01_R → ' + (await clickBtn('smile01_R')));
await page.waitForTimeout(1200);
await shot('2_smile_open1', 1);
// ③ 点纯头部动作之后
say('nod01_C → ' + (await clickBtn('nod01_C')));
await page.waitForTimeout(1200);
await shot('3_nod_open1', 1);
// ④ 点动作 + 把**所有** Mouth 参数清零再强推 OpenY
await page.evaluate(() => { window.__p.allZero = true; });
await shot('4_nod_open1_allZero', 1);
await page.evaluate(() => { window.__p.allZero = false; });
await shot('5_nod_open1_raw', 1);

if (await page.evaluate(() => window.__p.err)) say('报错：' + (await page.evaluate(() => window.__p.err)));
say('截图 → ' + outDir);
await ctx.close();
await browser.close();
