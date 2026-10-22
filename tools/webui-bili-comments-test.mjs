// 验「B站评论回复」设置（现在只剩 3 项：开关 / 多久看一次 / 一次最多回几条）
// 2026-10-22 用户定的规矩：每加/改设置项都要真浏览器验一次 config.yml
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

const ROOT = process.cwd();
const PORT = process.argv[2] || '3099';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const say = (s) => console.log(`[bc] ${s}`);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.evaluate(() => document.querySelector('[data-tab="biliPub"]').click());
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(200);
  const ok = await page.evaluate(() => {
    const t = document.getElementById('bp-scope');
    return !!(t && t.value);
  });
  if (ok) break;
}

const ids = ['bc-enable', 'bc-check', 'bc-max', 'bp-save2'];
// ⚠️ 2026-10-21 加：**B站主动评论**那张卡（去别人视频下发）也在这一页
const ids2 = ['bp2-enable', 'bp2-min', 'bp2-max', 'bp2-start', 'bp2-end', 'bp2-keywords', 'bp2-now', 'bp2-save', 'bp2-recent'];
const has = await page.evaluate((list) => Object.fromEntries(list.map((id) => [id, !!document.getElementById(id)])), ids);
const has2 = await page.evaluate((list) => Object.fromEntries(list.map((id) => [id, !!document.getElementById(id)])), ids2);
const gone = await page.evaluate(() => ['bc-min', 'bc-maxday', 'bc-cool', 'bc-hours', 'bc-sh', 'bc-eh', 'bc-keywords'].filter((id) => document.getElementById(id)));
say('应有元素：' + (ids.every((x) => has[x]) ? '齐全' : '缺 ' + ids.filter((x) => !has[x]).join(',')));
say('主动评论元素：' + (ids2.every((x) => has2[x]) ? '齐全 ✓' : '❌ 缺 ' + ids2.filter((x) => !has2[x]).join(',')));
say('应该没了的元素：' + (gone.length ? '❌ 还在 ' + gone.join(',') : '都删干净了 ✓'));
if (!ids.every((x) => has[x]) || !ids2.every((x) => has2[x])) { await browser.close(); process.exit(2); }

// ⚠️⚠️ 2026-10-22 用户发火：「**你别老是动我的开关啊，我一打开就关掉**」
//   真因就是这里原来写死了「测完改回关闭」⇒ 每跑一次测试就把用户刚打开的开关关掉 ✗
//   ⇒ 现在**先存原值，测完恢复原值**（用户开着的就还是开着）
const prev = await page.evaluate(() => ({
  enable: document.getElementById('bc-enable').value,
  check: document.getElementById('bc-check').value,
  max: document.getElementById('bc-max').value,
  // ⚠️ 主动评论那份也要存原值（同理：绝不动用户自己开的开关）
  p2enable: document.getElementById('bp2-enable').value,
  p2min: document.getElementById('bp2-min').value,
  p2max: document.getElementById('bp2-max').value,
  p2start: document.getElementById('bp2-start').value,
  p2end: document.getElementById('bp2-end').value,
  p2kw: document.getElementById('bp2-keywords').value,
}));
say('测试前用户的值：' + JSON.stringify(prev));

await page.evaluate(() => {
  document.getElementById('bc-enable').value = '1';
  document.getElementById('bc-check').value = '2';
  document.getElementById('bc-max').value = '4';
  // 主动评论：填一个和默认值明显不同的（关键词也填，空关键词等于不发）
  document.getElementById('bp2-enable').value = '1';
  document.getElementById('bp2-min').value = '2';
  document.getElementById('bp2-max').value = '3';
  document.getElementById('bp2-start').value = '11';
  document.getElementById('bp2-end').value = '21';
  document.getElementById('bp2-keywords').value = '我的世界\n轨道交通';
  document.getElementById('bp-save2').click();
});
await page.waitForTimeout(4500);

const cfg = yaml.load(readFileSync(join(ROOT, 'config.yml'), 'utf8')) || {};
const bc = cfg.biliComments || {};
say('config.yml：' + JSON.stringify(bc));
const ok = bc.enable === true && Number(bc.checkEveryMinutes) === 2 && Number(bc.maxPerRun) === 4;
const leftovers = ['minPerDay', 'maxPerDay', 'startHour', 'endHour', 'cooldownMs', 'keywords', 'everyMinutes'].filter((k) => k in bc);
say(ok ? '✅ 3 项都存进去了' : '❌ 有项没存对');
say('老字段：' + (leftovers.length ? '❌ 还在 ' + leftovers.join(',') : '已清掉 ✓'));

/* ⚠️ 主动评论那 6 项也要真读回来核对（用户定的规矩：加设置项必须验"存得进去"） */
const bpr = cfg.biliProactive || {};
say('config.yml biliProactive：' + JSON.stringify(bpr));
const ok2 = bpr.enable === true && Number(bpr.minPerDay) === 2 && Number(bpr.maxPerDay) === 3 &&
  Number(bpr.startHour) === 11 && Number(bpr.endHour) === 21 &&
  Array.isArray(bpr.keywords) && bpr.keywords.length === 2;
say(ok2 ? '✅ 主动评论 6 项都存进去了' : '❌ 主动评论有项没存对');
if (errs.length) say('JS 报错：' + errs.slice(0, 3).join(' | '));

// ⚠️ **恢复成测试前的值**（用户开着的就还是开着 —— 绝不许写死改关闭）
/* ⚠️⚠️ 2026-10-21 真踩到：原来这段是"设置 DOM 值 → 点 bp-save2"，
 *    结果**没恢复回去** —— 用户的 `checkEveryMinutes` 从 1 变成 2、`maxPerRun` 从 3 变成 4，
 *    还把主动评论的开关留成了开着 ✗（又犯"动用户开关"那条）
 *    原因：`bp-save` 的 onclick 是 async，按钮在跑的过程中 `disabled`，
 *    `bp-save2` 里那句 `b.click()` 对 disabled 的按钮**不生效** ⇒ 恢复的 POST 根本没发出去 ✗
 *    ⇒ 改成**直接 fetch 那个接口**（不碰 DOM、不看按钮状态），发完**读 config.yml 断言等于原值** ✓ */
const restoreBody = {
  comments: {
    enable: prev.enable === '1',
    checkEveryMinutes: Number(prev.check) || 5,
    maxPerRun: Number(prev.max) || 3,
  },
  proactive: {
    enable: prev.p2enable === '1',
    keywords: prev.p2kw,
    minPerDay: Number(prev.p2min) || 1,
    maxPerDay: Number(prev.p2max) || 2,
    startHour: Number(prev.p2start) || 10,
    endHour: Number(prev.p2end) || 22,
  },
};
const rr = await (await fetch(`http://127.0.0.1:${PORT}/api/bili-publish`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(restoreBody),
})).json();
say('恢复请求返回 ok=' + rr.ok);
await page.waitForTimeout(1500);

const cfg2 = yaml.load(readFileSync(join(ROOT, 'config.yml'), 'utf8')) || {};
say('已恢复：' + JSON.stringify(cfg2.biliComments));
say('已恢复（主动评论）：' + JSON.stringify(cfg2.biliProactive));

// 🔁 恢复必须**核对**：不相等就是又把用户的开关改了 ✗
const backOk = (cfg2.biliComments?.enable === (prev.enable === '1')) &&
  Number(cfg2.biliComments?.checkEveryMinutes) === (Number(prev.check) || 5) &&
  Number(cfg2.biliComments?.maxPerRun) === (Number(prev.max) || 3) &&
  (cfg2.biliProactive?.enable === (prev.p2enable === '1'));
say(backOk ? '✅ 已恢复成测试前的值' : '❌❌ 没恢复回去 —— 用户开关被改了，立刻手工改回！');
await browser.close();
process.exit(ok && ok2 && backOk && !leftovers.length ? 0 : 1);
