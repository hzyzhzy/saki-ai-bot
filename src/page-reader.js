/**
 * 网页阅读：把搜索结果里的页面**打开读一遍**，拿到摘要里没有的细节。
 *
 * ⚠️ 为什么需要（用户反馈）：
 *   光靠搜索摘要，模型只能说「我记不太清了」，答不了「第一集讲了什么」这种细节问题。
 *   DeepSeek 网页版能答，是因为它有「浏览 N 个页面」这一步 —— 这里就是在补这一步。
 *
 * 实测可达性：
 *   萌娘百科  ✅ 200，正文约 20~30k 字（剧情最全，二次元首选）
 *   百度百科  ❌ 403（防爬）
 *   → 所以优先萌娘百科
 */
import { config } from './config.js';
import { log } from './log.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 值得打开读的站点（按优先级）。其余站点点进去多半是垃圾或广告。 */
const GOOD_SITES = [
  { re: /moegirl\.org\.cn/i, name: '萌娘百科', priority: 1 },
  { re: /zh\.wikipedia\.org/i, name: '维基百科', priority: 2 },
  { re: /wiki\.bgm\.tv|bangumi\.tv/i, name: 'Bangumi', priority: 3 },
  { re: /bilibili\.com\/read|bilibili\.com\/opus/i, name: 'B站专栏', priority: 4 },
  { re: /baike\.baidu\.com/i, name: '百度百科', priority: 5 },
];

const cache = new Map();
const CACHE_MS = 30 * 60 * 1000;

function cleanCache() {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at > CACHE_MS) cache.delete(k);
}

/** 去掉 HTML 标签和脚本，抽出可读正文 */
export function htmlToText(html) {
  let t = String(html ?? '');
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  t = t.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  // 块级标签换成换行，保住段落感
  t = t.replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n');
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<[^>]+>/g, '');
  // 实体
  t = t
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  // 压缩空行
  t = t
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return t;
}

/**
 * 从正文里挑出**跟问题最相关的段落**，而不是一股脑全塞给模型。
 *
 * 做法：按段落打分（含问题关键词的加分），取分数最高的若干段。
 * 这样「第一集讲了什么」能捞到剧情段落，而不是页面顶部的编辑组广告。
 */
export function pickRelevant(text, query, maxChars = 3000) {
  const paras = String(text ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length >= 20); // 太短的多半是导航/表格残渣

  if (!paras.length) return '';

  // 问题里的实词
  const kws = [];
  for (const seg of String(query ?? '').match(/[\u4e00-\u9fa5]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= seg.length; i++) kws.push(seg.slice(i, i + 2));
  }
  for (const w of String(query ?? '').match(/[A-Za-z]{2,}/g) ?? []) kws.push(w.toLowerCase());

  // 剧情相关的高权重词 —— 问细节时这些段落最有用
  const PLOT_WORDS = /剧情|故事|简介|第.{1,3}[集话章]|讲述|讲述了|梗概|开头|结局|设定|角色|人物|成员|主角/;

  const scored = paras.map((p, idx) => {
    let sc = 0;
    const low = p.toLowerCase();
    for (const k of kws) if (low.includes(k)) sc += k.length >= 3 ? 2 : 1;
    if (PLOT_WORDS.test(p)) sc += 5;
    // 排版噪声扣分
    if (/编辑|欢迎|QQ群|协助|版权|导航|目录|上一[篇页]|下一[篇页]/.test(p)) sc -= 6;
    // 位置靠前的稍微加分（正文通常在前面）
    if (idx < 40) sc += 1;
    return { p, sc, idx };
  });

  scored.sort((a, b) => b.sc - a.sc || a.idx - b.idx);

  const out = [];
  let total = 0;
  for (const { p, sc } of scored) {
    if (sc <= 0) break;
    if (total + p.length > maxChars) continue;
    out.push(p);
    total += p.length;
    if (total >= maxChars * 0.85) break;
  }
  return out.join('\n');
}

/**
 * 挑一个值得打开的搜索结果。
 *
 * ⚠️ 光按站点优先级不够：问「第一集讲了什么」时，
 *    「梦限大MewType」（乐队页）和「BanG Dream! YUME∞MITA」（动画页）
 *    都是萌娘百科，但只有**动画页**有剧情。踩过这个坑。
 *    所以还要看**标题跟问题对不对得上**。
 *
 * @param {Array} results
 * @param {string} query 用户的问题（用来判断他要什么）
 * @returns {object|null}
 */
export function pickPage(results, query = '') {
  if (!Array.isArray(results) || !results.length) return null;

  const q = String(query ?? '');
  const wantsAnimation = /动画|番剧|第.{1,3}[集话]|剧情|播出|开播|讲了什么|讲了啥/.test(q);

  const scored = [];
  for (const r of results) {
    let pr = 99;
    for (const g of GOOD_SITES) {
      if (g.re.test(r.url)) {
        pr = g.priority;
        break;
      }
    }
    if (pr === 99) continue; // 不在白名单里的不打开

    let bonus = 0;
    const title = String(r.title ?? '');
    // 问动画/剧情 → 标题里带「动画/番」的优先
    if (wantsAnimation && /动画|TV|番|YUME|MITA|∞/i.test(title)) bonus -= 5;
    // 反过来：标题明显是「乐队/组合」条目的，问动画时降权
    if (wantsAnimation && /乐队|组合|成员|唱片|LIVE/i.test(title)) bonus += 3;
    // 标题里直接含问题关键词的优先
    for (const w of q.match(/[\u4e00-\u9fa5A-Za-z]{3,}/g) ?? []) {
      if (title.includes(w)) bonus -= 2;
    }

    scored.push({ r, score: pr + bonus });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => a.score - b.score);
  return scored[0].r;
}

/**
 * 打开一个页面，返回跟问题相关的正文。
 * @param {string} url
 * @param {string} query
 * @param {{maxChars?:number}} opts
 * @returns {Promise<{ok:boolean, text:string, title?:string, skipped?:string}>}
 */
export async function readPage(url, query, opts = {}) {
  if (config.pageReader?.enable === false) return { ok: false, text: '', skipped: '网页阅读已关闭' };

  const u = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(u)) return { ok: false, text: '', skipped: '不是合法网址' };

  cleanCache();
  const key = `${u}#${query}`;
  if (cache.has(key)) return cache.get(key).result;

  try {
    const r = await fetch(u, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(config.pageReader?.timeoutMs ?? 12000),
    });
    if (!r.ok) {
      log.debug(`[读页] ${u} HTTP ${r.status}`);
      return { ok: false, text: '', skipped: `HTTP ${r.status}` };
    }
    const html = await r.text();
    const full = htmlToText(html);
    const title = (html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '').trim();
    const picked = pickRelevant(full, query, opts.maxChars ?? config.pageReader?.maxChars ?? 3000);

    const result = picked
      ? { ok: true, text: picked, title }
      : { ok: false, text: '', skipped: '正文里没找到相关内容', title };
    if (picked) {
      log.info(`[读页] ${title.slice(0, 24) || u} → 摘出 ${picked.length} 字相关内容`);
    }
    cache.set(key, { at: Date.now(), result });
    return result;
  } catch (e) {
    log.debug(`[读页] ${u} 出错：${e.message}`);
    return { ok: false, text: '', skipped: e.message };
  }
}

/**
 * 从搜索结果里挑一页读，拼成给模型看的文本。
 * @returns {Promise<string>} 读不到就返回空串
 */
export async function readFromResults(results, query) {
  const page = pickPage(results, query);
  if (!page) return '';
  const r = await readPage(page.url, query);
  if (!r.ok || !r.text) return '';
  return [
    '',
    '# 【打开网页读了】以下是页面正文里跟问题相关的部分',
    '',
    `来源：${r.title || page.url}`,
    '',
    r.text,
    '',
    '⚠️ 这些是**页面原文摘录**，比搜索摘要详细得多。',
    '回答细节问题（比如「第一集讲了什么」）就用这里的内容。',
    '这里没有的就还是不知道，别编。',
  ].join('\n');
}

export function stats() {
  return { enable: config.pageReader?.enable !== false, cached: cache.size };
}

export function reset() {
  cache.clear();
}
