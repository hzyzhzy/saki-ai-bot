// 验收：新增的 intervalMinutes 能不能存下来（2026-10-22 用户铁律：加设置项必须验证能存）
// ⚠️ 先存原值 → 测 → 恢复原值，并断言恢复成功
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const PORT = process.argv[2] || '3099';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const say = (s) => console.log(`[interval] ${s}`);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(2500);

// ① 打开「B站评论」页
await page.evaluate(() => document.querySelector('nav button[data-tab="biliCmt"]').click());
await page.waitForTimeout(2500);

// ② 输入框在不在
const has = await page.evaluate(() => !!document.getElementById('bp2-interval'));
say('输入框存在：' + (has ? '✓' : '❌'));
if (!has) { await browser.close(); process.exit(1); }

// ③ 存原值
/* ⚠️⚠️ 2026-10-22：**`biliProactive` 是按号私有的**（不在 `SHARED_SECTIONS`）⇒
 *   写进 `accounts/<QQ>.yml`，**不是** `config.yml` ✗
 *   （我第一次就是读 `config.yml`，看到"没变"就判失败，白折腾一轮）
 *   ⇒ 两个文件都读，谁有就用谁的 ✓
 */
function readProactive() {
  for (const f of ['accounts/10000002.yml', 'config.yml']) {
    try {
      const o = yaml.load(readFileSync(f, 'utf8')) || {};
      if (o.biliProactive && o.biliProactive.intervalMinutes !== undefined) {
        return { v: Number(o.biliProactive.intervalMinutes), from: f };
      }
    } catch { /* 下一个 */ }
  }
  return { v: 20, from: '(默认)' };
}
const p0 = readProactive();
const prev = p0.v;
say(`测试前的值：${prev}（来自 ${p0.from}）`);

// ④ 改成 45 并保存
/* ⚠️⚠️ 2026-10-22 又是那个坑（AGENTS 里记过）：**别点按钮，直接调接口**。
 *   `bp2-save` 只是转发给 `bp-save`，而 `bp-save` 可能处于 `disabled` 状态
 *   ⇒ 点了**请求根本没发出去** ⇒ 看起来像"存不进去" ✗
 *   （上次验收把用户的开关改坏，就是这个原因）
 */
const TARGET = 45;
await page.evaluate((v) => {
  const el = document.getElementById('bp2-interval');
  el.value = String(v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, TARGET);
await page.waitForTimeout(300);

const saveRes = await page.evaluate(async (v) => {
  // 直接按界面同样的结构 POST（只带要改的那一项，后端会合并）
  const r = await fetch('/api/bili-publish', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proactive: { intervalMinutes: v } }),
  });
  return r.json();
}, TARGET);
say('接口返回：' + JSON.stringify(saveRes).slice(0, 120));
await page.waitForTimeout(1500);

// ⑤ 读回
const p1 = readProactive();
const after = p1.v;
const saved = after === TARGET;
say(`存进去了吗：${saved ? '✓' : '❌'}（文件里现在是 ${after}，来自 ${p1.from}）`);

// ⑥ 恢复
const r = await page.evaluate(async (v) => {
  const res = await fetch('/api/bili-publish', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proactive: { intervalMinutes: v } }),
  });
  return res.json();
}, prev);
await page.waitForTimeout(1500);
const p2 = readProactive();
const back = p2.v;
const backOk = back === prev;
say(`已恢复：${back}（${backOk ? '✓' : '❌'}）`);

if (errs.length) say('页面 JS 报错：' + errs.slice(0, 3).join(' | '));
await browser.close();
const all = has && saved && backOk && !errs.length;
say(all ? '\n结果: 全部通过 ✅' : '\n结果: 有项没过 ❌');
process.exit(all ? 0 : 1);
