// 抓「稿件管理」里最新那条的 BV 号 / 链接（投稿 agent 的回执里没记 bvid，2026-10-21 补）
import { chromium } from 'playwright-core';
import { join } from 'node:path';
import { browserOpts , biliProfileDir } from './lib/browser.mjs';

const ROOT = process.cwd();
// ⚠️ 2026-10-21：**按 QQ 号分 profile**（主号走老路径 state/bili-profile，别的号 state/bili-profile-<QQ>）
const PROFILE = biliProfileDir();
const say = (s) => console.log(`[稿件] ${s}`);

const ctx = await chromium.launchPersistentContext(PROFILE, {
  ...browserOpts(),
  headless: true,
  viewport: { width: 1600, height: 1100 },
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--disable-blink-features=AutomationControlled'],
});
const page = await ctx.newPage();
const out = { ok: false };

try {
  await page.goto('https://member.bilibili.com/platform/upload-manager/article', {
    waitUntil: 'domcontentloaded', timeout: 45000,
  });
  await page.waitForTimeout(5000);
  // 列表是懒加载的，滚一下再等
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);
  }
  const info = await page.evaluate(() => {
    const txt = document.body.innerText || '';
    const bvs = [...new Set((txt.match(/BV[0-9A-Za-z]{10}/g) || []))];
    /* ⚠️⚠️ 2026-10-21 实测：**列表里 BV 只在封面的 href 里**（`//www.bilibili.com/video/BV…/`），
     *   页面上根本看不到那串文字 ⇒ 光扫 innerText 永远抓不到 ✗
     *   ⇒ 从所有链接的 href 里扫，并且**只认第一张卡**（列表按时间倒序，第一条就是最新的） */
    const cards = [...document.querySelectorAll('a[href*="/video/BV"]')];
    const fromHref = cards.map((a) => (a.getAttribute('href') || '').match(/video\/(BV[0-9A-Za-z]{10})/)?.[1]).filter(Boolean);
    const first = fromHref[0] || '';
    // 第一条卡片的标题（封面 img 的 alt 最准）
    const firstAlt = (cards[0]?.querySelector('img')?.getAttribute('alt') || '').trim();
    return {
      bvs, first, firstAlt,
      allBvs: [...new Set(fromHref)],
      firstRow: (document.querySelector('.article-card')?.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
      head: txt.slice(0, 300).replace(/\s+/g, ' '),
    };
  });
  say('最新那条：' + (info.firstAlt || '(标题没抓到)'));
  say('页面里的 BV：' + (info.bvs.length ? info.bvs.join(', ') : '(文字里没有，看 href)'));
  say('href 里抓到的 BV：' + (info.allBvs.length ? info.allBvs.slice(0, 5).join(', ') : '(没找到)'));
  if (info.first) {
    out.ok = true;
    out.bvid = info.first;
    out.url = `https://www.bilibili.com/video/${info.first}/`;
    out.title = info.firstAlt;
    say(`✅ 最新一条：${info.firstAlt}  →  ${out.url}`);
  }
  out.firstRow = info.firstRow;
  if (!info.first) say('页面开头：' + info.head);
} catch (e) {
  say('❌ ' + e.message);
  out.err = e.message;
}
console.log(JSON.stringify(out));
try { await ctx.close(); } catch { /* ignore */ }
process.exit(0);
