// 真实验收：切到「谷雨」后，语音页显示的是什么（2026-10-21）
import { chromium } from 'playwright-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[页面报错] ' + e.message.slice(0, 200)));

await page.goto('http://127.0.0.1:3099/', { waitUntil: 'domcontentloaded', timeout: 30000 });
// ⚠️ 界面的"切号"就是把号存在 localStorage['saki-account']，每个请求带 x-saki-account 头
await page.evaluate(() => localStorage.setItem('saki-account', '10000014'));   // 谷雨
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);

// 点「语音」
await page.evaluate(() => document.querySelector('nav button[data-tab="voice"]').click());
await page.waitForTimeout(2500);

const r = await page.evaluate(() => ({
  侧栏标签: (document.getElementById('nav-accounts')?.textContent || '').trim(),
  总开关: document.getElementById('vc-enable')?.value,
  戳一戳: document.getElementById('vc-poke')?.value,
  音色选项: document.getElementById('vc-ref')?.options?.length ?? -1,
  状态: (document.getElementById('vc-status')?.textContent || '').slice(0, 70),
}));
console.log('【切到谷雨后】' + JSON.stringify(r, null, 1));

// 对照：直接打接口（带 header）
const viaHeader = await page.evaluate(async () => {
  const r = await fetch('/api/voice', { headers: { 'x-saki-account': '10000014' } });
  const j = await r.json();
  return { enable: j.cfg?.enable, pokeVoice: j.cfg?.pokeVoice };
});
console.log('【带 header 直查】' + JSON.stringify(viaHeader));

// 再切回主号看看
await page.evaluate(() => localStorage.setItem('saki-account', '10000002'));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const r2 = await page.evaluate(() => ({
  侧栏标签: (document.getElementById('nav-accounts')?.textContent || '').trim(),
  总开关: document.getElementById('vc-enable')?.value,
  戳一戳: document.getElementById('vc-poke')?.value,
}));
console.log('【切回主号后】' + JSON.stringify(r2));

await browser.close();
process.exit(0);
