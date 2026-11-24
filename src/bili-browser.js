/**
 * B站数据 —— 用**无头浏览器**取（2026-10-24 加）
 *
 * ## 为什么要这个文件
 *
 * 用户：「以后用到 b站官方 api 的地方可以大部分改成直接使用无头浏览器吗，
 *        这样更不容易被风控」⇒ 定了「**按风控强度分层**」：
 *
 * | 接口 | 风控 | 走哪 |
 * | --- | --- | --- |
 * | `x/web-interface/view`（单个视频） | 很宽松 | **API**（快，3 分钟轮询也安全）|
 * | `x/web-interface/search/type`（搜索） | 中 | **API + 长缓存** |
 * | `x/web-interface/popular`（热门） | 中 | **API + 缓存** |
 * | `x/space/arc/search`（拉某人投稿） | **最严** | **本文件（浏览器）** |
 *
 * `space/arc` 实测：连探几次就 `-412` / `-799`，一封 45 分钟（见 bilibili.js 文件头）。
 * 而**空间页 HTML 是公开的**，走的是完整浏览器指纹 + 真 cookie ⇒ 风险低得多，
 * 代价是慢（一次 4~8 秒）—— 好在「问自己视频播放量」是**低频**操作，等得起 ✓
 *
 * ## 三条实现上的讲究
 *
 * 1. **用独立的临时 profile**（`state/__browse-profile`），**绝不碰** `state/bili-profile`
 *    —— 那是投稿/评论的登录态，被抢了整条 B站 线全挂 ✗
 * 2. **单实例串行**：一个进程里同时只开一个浏览器（`busy` 锁），并发开 3 个 Chrome
 *    会吃 1GB 内存还互相拖慢 ✓
 * 3. **失败就返回 null**，由调用方退回 API / 缓存 —— 浏览器取不到不该让业务崩 ✓
 *
 * ⚠️ 无头也要装得像人：先访问首页种 cookie，再进空间页，别直捣黄龙 ✓
 */
import { join } from 'node:path';
import { ROOT } from './config.js';
import { log } from './log.js';

const CHROME = process.env.BILI_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
/** ⚠️ 独立 profile —— **不是** `state/bili-profile`（那是业务登录态） */
const PROFILE = join(ROOT, 'state', '__browse-profile');

/** 同一个进程里同时只跑一个浏览器 */
let busy = false;

/** 等锁（最多等 ms） */
async function acquire(ms = 60000) {
  const t0 = Date.now();
  while (busy) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
  busy = true;
  return true;
}
function release() {
  busy = false;
}

/**
 * 打开某人的空间视频列表，抓回结构化数据。
 *
 * @param {string} mid 用户 uid
 * @param {{limit?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<Array<{bvid:string,title:string,play:number,duration:string,created:number}>|null>}
 */
export async function fetchSpaceVideos(mid, { limit = 30, timeoutMs = 45000 } = {}) {
  const uid = String(mid ?? '').trim();
  if (!/^\d{3,20}$/.test(uid)) return null;

  const got = await acquire();
  if (!got) {
    log.warn('[B站浏览器] 上一个浏览器还没关，这次跳过（避免开多个吃内存）');
    return null;
  }

  let ctx = null;
  const timer = setTimeout(() => {
    // 兜底：卡死时强行关掉（不然 busy 永远回不来）
    try {
      ctx?.close();
    } catch {}
    release();
  }, timeoutMs);

  try {
    const { chromium } = await import('playwright-core');
    ctx = await chromium.launchPersistentContext(PROFILE, {
      executablePath: CHROME,
      headless: true, // 不给用户弹窗
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--disable-gpu',
        '--window-position=-32000,-32000',
      ],
    });
    const page = await ctx.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9' });

    // ① 先访问首页种 cookie（直捣空间页容易被判爬虫）
    await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1200);

    // ② 进空间页
    await page.goto(`https://space.bilibili.com/${uid}/video`, {
      waitUntil: 'domcontentloaded',
      timeout: 25000,
    });
    await page.waitForTimeout(4000);

    // ③ 抓卡片：**用 href 认**（B站 改版换 class 也不会失效）
    const items = await page.evaluate((max) => {
      const out = [];
      const seen = new Set();
      document.querySelectorAll('a[href*="/video/BV"]').forEach((a) => {
        const m = a.href.match(/\/video\/(BV[0-9A-Za-z]+)/);
        if (!m) return;
        const bvid = m[1];
        if (seen.has(bvid)) return;
        // 往上找能代表"这张卡"的容器（最多 6 层）
        let box = a;
        for (let i = 0; i < 6 && box; i++) {
          if (box.querySelector && box.querySelector('.bili-video-card__stats--item, .bili-video-card__info--tit')) break;
          box = box.parentElement;
        }
        const q = (sel) => box?.querySelector?.(sel)?.innerText?.trim() || '';
        const title =
          box?.querySelector?.('.bili-video-card__info--tit')?.getAttribute('title') ||
          q('.bili-video-card__info--tit') ||
          a.getAttribute('title') ||
          a.innerText?.trim().slice(0, 80) ||
          '';
        const playTxt = q('.bili-video-card__stats--item');
        const durTxt = q('.bili-video-card__stats__duration');
        const dateTxt = q('.bili-video-card__info--date');
        if (!title) return;
        seen.add(bvid);
        out.push({ bvid, title, playTxt, durTxt, dateTxt });
        if (out.length >= max) return;
      });
      return out;
    }, limit);

    if (!items || !items.length) {
      log.warn(`[B站浏览器] 空间页没抓到视频（uid ${uid}）—— 可能页面改版或需要登录`);
      return null;
    }

    const result = items.map((x) => ({
      bvid: x.bvid,
      title: String(x.title || '').slice(0, 120),
      play: parseCount(x.playTxt),
      duration: x.durTxt || '',
      dateText: x.dateTxt || '',
      created: parseDateText(x.dateTxt),
    }));
    log.info(`[B站浏览器] 空间页取到 ${result.length} 个视频（uid ${uid}）✓`);
    return result;
  } catch (e) {
    log.warn(`[B站浏览器] 取空间页失败：${String(e.message || e).slice(0, 120)}`);
    return null;
  } finally {
    clearTimeout(timer);
    try {
      await ctx?.close();
    } catch {}
    release();
  }
}

/** 「3.4万」「1.2亿」「1234」→ 数字 */
function parseCount(s) {
  const t = String(s ?? '').replace(/[,\s]/g, '');
  if (!t) return 0;
  const m = t.match(/^([\d.]+)\s*(万|亿)?/);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  if (m[2] === '万') return Math.round(n * 10000);
  if (m[2] === '亿') return Math.round(n * 100000000);
  return Math.round(n);
}

/** 「昨天」「10-22」「2天前」「2026-10-22」→ 毫秒时间戳（认不出给 0） */
function parseDateText(s) {
  const t = String(s ?? '').replace('·', '').trim();
  if (!t) return 0;
  const now = Date.now();
  const DAY = 86400000;
  if (/^\d+分钟前$/.test(t)) return now - Number(t.replace('分钟前', '')) * 60000;
  if (/^\d+小时前$/.test(t)) return now - Number(t.replace('小时前', '')) * 3600000;
  if (/^\d+天前$/.test(t)) return now - Number(t.replace('天前', '')) * DAY;
  if (t === '昨天') return now - DAY;
  if (t === '前天') return now - 2 * DAY;
  const md = t.match(/^(\d{1,2})-(\d{1,2})$/);
  if (md) {
    const d = new Date();
    d.setMonth(Number(md[1]) - 1, Number(md[2]));
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  const ymd = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (ymd) {
    const d = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
    return d.getTime();
  }
  return 0;
}
