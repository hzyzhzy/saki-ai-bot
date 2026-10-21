/**
 * 诊断：B站投稿 tab 的 404 是哪个 URL、renderBiliPub 到底有没有跑（2026-10-22）
 */
import { chromium } from 'playwright-core';

const PORT = process.argv[2] || '3099';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const say = (s) => console.log(`[diag] ${s}`);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
const bad = [];
page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
page.on('requestfailed', (r) => bad.push(`FAIL ${r.url()} ${r.failure()?.errorText}`));
page.on('pageerror', (e) => bad.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') bad.push('console: ' + m.text().slice(0, 300)); });

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(2500);

const info = await page.evaluate(() => ({
  typeofRender: typeof window.renderBiliPub,
  typeofBpBind: typeof window.bpBindSave,
  bpStatus: (document.getElementById('bp-status') || {}).textContent,
  // 找出页面上所有 script 标签里含 renderBiliPub 的那段，看它在哪个函数里
  scriptCount: document.querySelectorAll('script').length,
  // 直接测 fetch
  fetchOk: null,
}));
say(`typeof renderBiliPub = ${info.typeofRender}`);
say(`typeof bpBindSave   = ${info.typeofBpBind}`);
say(`bp-status 初始      = ${JSON.stringify(info.bpStatus)}`);

const fj = await page.evaluate(async () => {
  try {
    const r = await fetch('/api/bili-publish');
    const t = await r.text();
    return { status: r.status, head: t.slice(0, 160) };
  } catch (e) { return { err: String(e) }; }
});
say(`手测 /api/bili-publish = ${JSON.stringify(fj)}`);

// 手动调一次，看能不能成功
const manual = await page.evaluate(async () => {
  try { await window.renderBiliPub(); return 'ok'; } catch (e) { return 'err: ' + (e && e.message); }
});
say(`手动 renderBiliPub() = ${manual}`);
await page.waitForTimeout(800);
const after = await page.evaluate(() => (document.getElementById('bp-status') || {}).textContent);
say(`手动后 bp-status    = ${JSON.stringify((after || '').slice(0, 90))}`);

say(`—— 异常/404 清单（${bad.length} 条）——`);
bad.slice(0, 12).forEach((b) => say('  ' + b));

await browser.close();
