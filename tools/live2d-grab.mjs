/**
 * 从 bdon.moe 的 Live2D 页面**抓画面**（它自己能渲染 format 2 的模型）
 *
 * 为什么绕开自建渲染：CDN 上的模型是 Unity prefab **format 2**，
 * 而 npm 上 ournotes-player 所有版本（0.1.0~0.2.0）都只认 **format 3**
 * ⇒ 自己渲染必然报 `format 2 is not supported` ✗
 * 而 bdon.moe 站内做了转换层，那就直接用它渲染好的画面 ✓
 *
 * 用法：
 *   node tools/live2d-grab.mjs --model adv_live2d_sakiko_010_casual_spring_01
 *   node tools/live2d-grab.mjs --list          列出可选模型
 */
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME =
  process.env.BILI_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const say = (s) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${s}`);

const MODEL = arg('model', 'adv_live2d_sakiko_010_casual_spring_01');
const OUT = resolve(arg('out', join(ROOT, 'logs', 'bili', '__l2d_site.png')));
const URL0 = arg('url', 'https://bdon.moe/zh-CN/tools/live2d');
const WAIT = Number(arg('wait', '40000'));
const MOTION = arg('motion', '');
const W = Number(arg('w', '760'));
const H = Number(arg('h', '1140'));

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--disable-blink-features=AutomationControlled', '--use-gl=angle', '--enable-unsafe-swiftshader'],
});
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 1000 },
  deviceScaleFactor: 2,
  ignoreHTTPSErrors: true,
  locale: 'zh-CN',
});
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

say(`打开 ${URL0}${MODEL ? '?model=' + MODEL : ''}`);
await page.goto(`${URL0}?model=${encodeURIComponent(MODEL)}`, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch((e) => say('goto: ' + e.message));

// 等 canvas 出现
const t0 = Date.now();
let found = false;
while (Date.now() - t0 < WAIT) {
  const st = await page.evaluate(() => ({
    canvases: document.querySelectorAll('canvas').length,
    selects: [...document.querySelectorAll('select')].map((s) => ({
      n: s.options.length,
      cur: s.options[s.selectedIndex]?.text?.slice(0, 40) || '',
      id: s.id,
    })),
    err: document.body.innerText.match(/error[^\n]{0,80}/i)?.[0] || '',
  }));
  if (st.canvases > 0 && !found) {
    found = true;
    say(`canvas ${st.canvases} 个；下拉框：${JSON.stringify(st.selects).slice(0, 300)}`);
  }
  if (found && st.selects.some((s) => s.cur)) break;
  await page.waitForTimeout(800);
}

// 给模型点时间加载（网络 + 编译着色器）
await page.waitForTimeout(Number(arg('settle', '9000')));

mkdirSync(dirname(OUT), { recursive: true });
await page.screenshot({ path: OUT, omitBackground: true });
say(`截图：${OUT}`);

// 顺便把 canvas 单独截一张（更干净，只有模型）
const canvasShot = OUT.replace(/\.png$/, '_canvas.png');
try {
  const cv = await page.$('canvas');
  if (cv) {
    await cv.screenshot({ path: canvasShot, omitBackground: true });
    say(`canvas 截图：${canvasShot}`);
  }
} catch (e) {
  say('canvas 截图失败：' + e.message);
}

if (logs.length) {
  say('--- 页面日志 ---');
  logs.slice(0, 12).forEach((l) => say('  ' + l.slice(0, 170)));
}
await ctx.close();
await browser.close();
if (!existsSync(OUT)) process.exit(2);
