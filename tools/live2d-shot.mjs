/**
 * 渲染**真 Live2D 模型**（Cubism 5、带分层、可做口型）—— 数据来自 bdon.moe 的 CDN
 *
 * ## 模型从哪来
 * BanG Dream! **Our Notes** 游戏用的原始 Live2D 资源，公开在
 * `https://storage.bdon.moe/moenotes/`：
 *   · 模型列表 `models.json`（191 条，含祥子 7 套：便服 / 夏冬校服 / 演出服 / 面具版 / 初中版）
 *   · 单个模型 manifest `models/<id>.json`，里面 `files` 指向 `.moc3`、`.prefab.json`、shader 等
 *   · 用 [empty-sekai/ournotes-player](https://github.com/empty-sekai/ournotes-player) 解析（Unity prefab → Live2D）
 *
 * ## 两个坑（2026-10-20 踩的）
 *   ① 事件名是 **`ready`**，不是 `load` —— 等 `load` 永远等不到 ✗
 *   ② manifest 里的资源路径是**相对 site 根**的（`assets/xxx.gz`），
 *      而 manifest 自己在 `models/` 下 ⇒ 直接给 CDN 的 manifest 绝对地址会拼错
 *      ⇒ 起一个**本地代理**，把 `/models/*` 和 `/assets/*` 都转发到 CDN 的 `/moenotes/*` ✓
 *
 * 用法：
 *   node tools/live2d-shot.mjs --model adv_live2d_sakiko_010_casual_spring_01
 *   node tools/live2d-shot.mjs --list          列出所有可用模型
 */
import { chromium } from 'playwright-core';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { get } from 'node:https';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME =
  process.env.BILI_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDN = 'https://storage.bdon.moe/moenotes';

const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const say = (s) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${s}`);

if (argv.includes('--list')) {
  const body = await fetchText(`${CDN}/models.json`);
  const { models } = JSON.parse(body);
  const chars = {};
  for (const m of models) {
    const c = (m.id.match(/^adv_live2d_([a-z]+)_/) || [])[1] || '?';
    (chars[c] ||= []).push(m.id);
  }
  say(`共 ${models.length} 个模型，${Object.keys(chars).length} 个角色`);
  for (const [c, ids] of Object.entries(chars)) {
    say(`  ${c}: ${ids.length} 套`);
  }
  process.exit(0);
}

const MODEL = arg('model', 'adv_live2d_sakiko_010_casual_spring_01');
const OUT = resolve(arg('out', join(ROOT, 'logs', 'bili', '__l2d.png')));
const W = Number(arg('w', '720'));
const H = Number(arg('h', '1100'));
const WAIT = Number(arg('wait', '30000'));
const MOTION = arg('motion', '');
const EXPR = arg('expression', '');

function fetchText(url) {
  return new Promise((res, rej) => {
    get(url, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        fetchText(new URL(r.headers.location, url).href).then(res, rej);
        return;
      }
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => res(d));
    }).on('error', rej);
  });
}

/* ── 本地代理：/models/* /assets/* → CDN /moenotes/* ── */
const proxy = createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  const target = CDN + req.url; // /models/x.json → https://…/moenotes/models/x.json
  get(target, (r) => {
    res.writeHead(r.statusCode || 500, {
      'Content-Type': r.headers['content-type'] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
    });
    r.pipe(res);
  }).on('error', (e) => {
    res.writeHead(502);
    res.end(String(e));
  });
});

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body { margin:0; padding:0; background:transparent; overflow:hidden; }
  #stage { width:${W}px; height:${H}px; display:flex; align-items:flex-end; justify-content:center;
           background:transparent; }
  ournotes-live2d { width:${W}px; height:${H}px; display:block; }
</style>
<script src="https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js"></script>
<script type="module"
  src="https://cdn.jsdelivr.net/npm/ournotes-player@0.2.0/dist/ournotes-player.live2d.element.min.js"></script>
</head><body>
<div id="stage"><ournotes-live2d id="m"></ournotes-live2d></div>
<script>
  window.__state = 'init';
  window.__err = '';
  const el = document.getElementById('m');
  el.addEventListener('progress', (e) => { window.__state = 'loading ' + Math.round((e.detail.loaded / e.detail.total) * 100) + '%'; });
  // ⚠️ 事件名是 ready，不是 load
  el.addEventListener('ready', () => { window.__state = 'ready'; console.log('READY'); });
  el.addEventListener('error', (e) => {
    const err = e && e.detail && e.detail.error;
    window.__err = (err && (err.message || err.stack)) || String(err) || 'unknown';
    window.__state = 'error';
    console.log('ERR ' + window.__err);
  });
</script>
</body></html>`;

await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const PORT = proxy.address().port;
say(`本地代理 http://127.0.0.1:${PORT}/  → ${CDN}`);

const chrome = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--disable-blink-features=AutomationControlled',
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
  ],
});
const ctx = await chrome.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 2,
  ignoreHTTPSErrors: true,
});
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url().slice(-90)} ${r.failure()?.errorText}`));

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });

// 等 ready
const manifestUrl = `${PORT}/models/${MODEL}.json`;
await page.evaluate((u) => document.getElementById('m').setAttribute('src', u), `http://127.0.0.1:${manifestUrl}`);
say(`加载模型：${MODEL}`);

const t0 = Date.now();
let lastState = '';
while (Date.now() - t0 < WAIT) {
  const st = await page.evaluate(() => ({ s: window.__state, e: window.__err }));
  if (st.s !== lastState) { say(`  状态：${st.s}`); lastState = st.s; }
  if (st.s === 'ready') break;
  if (st.s === 'error') { say('❌ ' + st.e); break; }
  await page.waitForTimeout(400);
}

if (lastState === 'ready') {
  if (MOTION) {
    await page.evaluate((m) => document.getElementById('m').playMotion(m), MOTION).catch(() => {});
  }
  if (EXPR) {
    await page.evaluate((x) => document.getElementById('m').setExpression(x), EXPR).catch(() => {});
  }
  await page.waitForTimeout(Number(arg('after', '1500')));
  mkdirSync(dirname(OUT), { recursive: true });
  await page.screenshot({ path: OUT, omitBackground: true });
  say(`✅ 截图：${OUT}`);
  const info = await page.evaluate(() => {
    const p = document.getElementById('m').player;
    return p ? { name: p.name, motions: p.motions?.length, expressions: p.expressions?.length } : null;
  });
  if (info) say(`  模型：${info.name}  motion ${info.motions} 个 / expression ${info.expressions} 个`);
} else {
  say('⚠️ 没渲染成功');
}

if (logs.length) {
  say('--- 页面日志 ---');
  logs.slice(0, 15).forEach((l) => say('  ' + l.slice(0, 180)));
}
await ctx.close();
await chrome.close();
proxy.close();
if (!existsSync(OUT)) process.exit(2);
