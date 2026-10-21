/**
 * 验「B站投稿」这个 tab 页能不能真的用（2026-10-22）
 *
 * 为什么要真浏览器点：面板 DOM 和 `renderBiliPub()` 是两块代码，
 *   拼错一个 id、或者事件绑在 DOM 之前，**页面照样打开、但按钮点了没反应** ✗
 *   ⇒ 这里点一遍：切 tab → 表单有值 → 保存不报错 → 抓 JS 报错
 *
 * 用法：node tools/webui-bili-test.mjs [端口]
 */
import { chromium } from 'playwright-core';

const PORT = process.argv[2] || '3099';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const say = (s) => console.log(`[test] ${s}`);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
// ⚠️ 不用 console 的「Failed to load resource」—— 它不带 URL，favicon.ico 的 404
//    也会被当成"页面坏了"✗  改成看 response，并且放过 favicon
page.on('response', (r) => {
  const u = r.url();
  if (r.status() >= 400 && !/favicon\.ico/.test(u)) errors.push(`HTTP ${r.status()} ${u}`);
});

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });

// ① 找到并点「B站投稿」
const nav = await page.$('[data-tab="biliPub"]');
if (!nav) { say('❌ 导航里没有 biliPub 按钮'); await browser.close(); process.exit(2); }
await page.evaluate(() => document.querySelector('[data-tab="biliPub"]').click());

// ⚠️ 2026-10-22：别用固定等待。这个页面有 350KB、18 个 tab 都在初始化，
//    实测 renderBiliPub 从「读取中…」到填完要 ~1 秒（不是接口慢 —— 接口 22ms，
//    是主线程被别的 tab 占着）⇒ 固定 1.2s 会读到「读取中…」而误判成坏了 ✗
//    ⇒ 改成轮询，最多等 8 秒
for (let i = 0; i < 40; i++) {
  const done = await page.evaluate(() => {
    const t = (document.getElementById('bp-scope') || {}).value || '';
    return t.split('\n').filter(Boolean).length > 0;
  });
  if (done) break;
  await page.waitForTimeout(200);
}
await page.waitForTimeout(150);

// ② 面板可见 + 表单填上了
const st = await page.evaluate(() => {
  const sec = document.getElementById('tab-biliPub');
  const vis = sec && !sec.classList.contains('hidden');
  const v = (id) => (document.getElementById(id) || {}).value ?? null;
  return {
    visible: !!vis,
    ws: v('bp-ws'), we: v('bp-we'), dur: v('bp-durmax'),
    topics: (v('bp-scope') || '').split('\n').filter(Boolean).length,
    status: (document.getElementById('bp-status') || {}).textContent || '',
    hasSave: !!document.getElementById('bp-save'),
    hasRun: !!document.getElementById('bp-run'),
  };
});
say(`面板可见=${st.visible} 时间窗=${st.ws}~${st.we} 时长=${st.dur} 范围=${st.topics} 条`);
say(`状态条：${st.status.slice(0, 80)}`);

// ③ 点一次保存（值不改，等于把当前值存回去）—— 只看有没有报错
let saveOk = false;
let saveResp = '';
if (st.hasSave) {
  page.once('dialog', (d) => d.accept());
  page.on('response', async (r) => {
    if (r.url().includes('/api/bili-publish') && r.request().method() === 'POST') {
      try { saveResp = (await r.text()).slice(0, 200); } catch {}
    }
  });
  await page.evaluate(() => document.getElementById('bp-save').click());
  // ⚠️ 保存成功后前端会再跑一次 renderBiliPub（重新拉接口）⇒ 固定等 1.5s 不够，
  //    改成轮询「已保存」字样，最多 8 秒
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => (document.getElementById('bp-status') || {}).textContent || '');
    if (/已保存/.test(after)) { saveOk = true; break; }
  }
  const after = await page.evaluate(() => (document.getElementById('bp-status') || {}).textContent || '');
  say(`保存按钮：${saveOk ? '✓ 生效' : '✗ ' + after.slice(0, 100)}`);
  if (saveResp) say('保存响应：' + saveResp);
}

if (errors.length) {
  say('❌ 页面有 JS 报错：');
  errors.slice(0, 6).forEach((e) => say('   ' + e));
} else {
  say('✓ 没有 JS 报错');
}

await browser.close();
const ok = st.visible && st.hasSave && st.hasRun && saveOk && !errors.length;
say(ok ? '结果：全部通过 ✅' : '结果：有问题 ✗');
process.exit(ok ? 0 : 1);

