// 验「B站评论」独立板块（2026-10-21 用户：「把B站评论单开一个板块，离开B站投稿板块」）
//
// 重点验两件事：
//   ① 新 tab 存在、两张卡片都在里面、投稿页只剩投稿的东西
//   ② ⚠️ **在评论页点保存，不能把投稿配置改坏**（两个 tab 共用同一个 POST /api/bili-publish）
//
// ⚠️ 铁律：先存原值 → 测 → **恢复原值**（绝不写死改关闭，2026-10-22 用户发过火）
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const ROOT = process.cwd();
const PORT = process.argv[2] || '3099';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const say = (s) => console.log(`[分板] ${s}`);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
// ⚠️ 等 1.5 秒：页面加载后有个 setTimeout(1200) 会全量渲染一遍，必须等它跑完
await page.waitForTimeout(2000);

/* ① nav 上有没有「B站评论」，点进去对不对 */
const hasTab = await page.evaluate(() => !!document.querySelector('nav button[data-tab="biliCmt"]'));
say('nav 上有「B站评论」按钮：' + (hasTab ? '✓' : '❌'));
await page.evaluate(() => document.querySelector('nav button[data-tab="biliCmt"]').click());
await page.waitForTimeout(800);
const vis = await page.evaluate(() => {
  const s = document.getElementById('tab-biliCmt');
  return { 显示: !!s && !s.classList.contains('hidden'), 里面有两张卡: !!document.querySelector('#tab-biliCmt #bc-enable') && !!document.querySelector('#tab-biliCmt #bp2-enable') };
});
say('评论板块：' + JSON.stringify(vis));

/* ② 投稿页里还剩什么（评论的东西应该没了吧） */
const pubClean = await page.evaluate(() => {
  const s = document.getElementById('tab-biliPub');
  return {
    还有评论开关: !!s?.querySelector('#bc-enable'),
    还有主动评论: !!s?.querySelector('#bp2-enable'),
    还有立刻做一条: !!s?.querySelector('#bp-run'),
    还有最近记录: !!s?.querySelector('#bp-history'),
  };
});
say('投稿页残留：' + JSON.stringify(pubClean));

/* ③ 存原值（config.yml 里真实的） */
const cfg0 = yaml.load(readFileSync(`${ROOT}/config.yml`, 'utf8')) || {};
const prev = {
  biliPublish: JSON.parse(JSON.stringify(cfg0.biliPublish || {})),
  call: Number(cfg0.biliComments?.checkEveryMinutes) || 1,
  cmax: Number(cfg0.biliComments?.maxPerRun) || 3,
};
say('测试前：投稿=' + JSON.stringify({ enable: prev.biliPublish.enable, ws: prev.biliPublish.windowStart, we: prev.biliPublish.windowEnd }) +
  ` 评论 check=${prev.call} max=${prev.cmax}`);

/* ④ 在**评论页**改一个值 → 点它自己的保存按钮（bp-save2） */
const targetCheck = prev.call === 7 ? 9 : 7;
await page.evaluate((v) => {
  document.getElementById('bc-check').value = String(v);
  document.getElementById('bp-save2').click();
}, targetCheck);
await page.waitForTimeout(4500);

const cfg1 = yaml.load(readFileSync(`${ROOT}/config.yml`, 'utf8')) || {};
const checkSaved = Number(cfg1.biliComments?.checkEveryMinutes) === targetCheck;
say(`评论设置存进去了？${checkSaved ? '✓' : '❌'}（check=${cfg1.biliComments?.checkEveryMinutes}，期望 ${targetCheck}）`);

/* ⑤ ⚠️ 关键：投稿配置有没有被误改 */
const pubAfter = cfg1.biliPublish || {};
const pubIntact =
  pubAfter.enable === prev.biliPublish.enable &&
  String(pubAfter.windowStart) === String(prev.biliPublish.windowStart) &&
  String(pubAfter.windowEnd) === String(prev.biliPublish.windowEnd) &&
  JSON.stringify(pubAfter.scope || []) === JSON.stringify(prev.biliPublish.scope || []);
say(`投稿配置没被改坏？${pubIntact ? '✓' : '❌'} → ` +
  JSON.stringify({ enable: pubAfter.enable, ws: pubAfter.windowStart, we: pubAfter.windowEnd }));
if (!pubIntact) {
  say('  测试前：' + JSON.stringify({ enable: prev.biliPublish.enable, ws: prev.biliPublish.windowStart, we: prev.biliPublish.windowEnd }));
}

/* ⑥ 恢复原值（直接打接口，不看按钮状态） */
await fetch(`http://127.0.0.1:${PORT}/api/bili-publish`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    cfg: {
      enable: prev.biliPublish.enable,
      windowStart: prev.biliPublish.windowStart,
      windowEnd: prev.biliPublish.windowEnd,
      group: prev.biliPublish.group,
      durationMax: prev.biliPublish.durationMax,
      zone: prev.biliPublish.zone,
      zone2: prev.biliPublish.zone2,
      tags: prev.biliPublish.tags,
      groupMaxStreak: prev.biliPublish.groupMaxStreak,
      scope: prev.biliPublish.scope,
      notifyOwner: prev.biliPublish.notifyOwner,
    },
    comments: { enable: cfg0.biliComments?.enable === true, checkEveryMinutes: prev.call, maxPerRun: prev.cmax },
    proactive: {
      enable: cfg0.biliProactive?.enable === true,
      keywords: cfg0.biliProactive?.keywords || [],
      minPerDay: cfg0.biliProactive?.minPerDay ?? 1,
      maxPerDay: cfg0.biliProactive?.maxPerDay ?? 2,
      startHour: cfg0.biliProactive?.startHour ?? 10,
      endHour: cfg0.biliProactive?.endHour ?? 22,
    },
  }),
});
await page.waitForTimeout(1500);
const cfg2 = yaml.load(readFileSync(`${ROOT}/config.yml`, 'utf8')) || {};
const backOk = Number(cfg2.biliComments?.checkEveryMinutes) === prev.call;
say(`已恢复：评论 check=${cfg2.biliComments?.checkEveryMinutes}（期望 ${prev.call}）${backOk ? '✓' : '❌'}`);

if (errs.length) say('页面 JS 报错：' + errs.slice(0, 3).join(' | '));
await browser.close();
const okAll = hasTab && vis.显示 && vis.里面有两张卡 && !pubClean.还有评论开关 && !pubClean.还有主动评论 &&
  pubClean.还有立刻做一条 && pubClean.还有最近记录 && checkSaved && pubIntact && backOk && !errs.length;
say(okAll ? '\n结果: 全部通过 ✅' : '\n结果: 有项没过 ❌');
process.exit(okAll ? 0 : 1);
