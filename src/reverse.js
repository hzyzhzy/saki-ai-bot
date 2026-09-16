/**
 * 反向图片搜索（SauceNAO）—— 专门用来认二次元角色和出处。
 *
 * 为什么需要它：
 *   视觉模型能描述「粉发少女、拿着印考拉的手机」，但它**不认识这是谁**；
 *   硬让主模型猜，就会出现「粉发 → 长崎素世」这种错（真实踩过）。
 *   SauceNAO 是动漫图搜源，能直接给出角色名和作品名。
 *
 * 白嫖路子都试过、都不通：
 *   百度识图 → 反爬，一律 Reject
 *   ascii2d → Cloudflare 挡
 *   trace.moe → 免注册但只认番剧原帧，表情包认不准
 *   → 只有 SauceNAO 靠谱（免费 basic 账号就够，api access 默认开启）
 *
 * 限制（basic 账号）：
 *   有请求频率限制（大概每 30 秒几次），所以这里有节流 + 缓存。
 */
import { readFileSync } from 'node:fs';
import { config } from './config.js';
import { log } from './log.js';

const ENDPOINT = 'https://saucenao.com/search.php';

/** 同一张图 10 分钟内不重复查 */
const cache = new Map();
const CACHE_MS = 10 * 60 * 1000;
/** 两次请求之间至少隔这么久（basic 账号限制严） */
const MIN_GAP_MS = 8000;
let lastAt = 0;
let blockedUntil = 0;

function cleanCache() {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at > CACHE_MS) cache.delete(k);
}

export function isEnabled() {
  return config.saucenao?.enable !== false && !!config.saucenao?.apiKey;
}

/**
 * 用 SauceNAO 查一张图。
 *
 * @param {Buffer} buf 图片内容
 * @param {string} [cacheKey] 缓存键（一般用图片 hash）
 * @returns {Promise<{ok:boolean, matches:Array, skipped?:string}>}
 *   matches: [{ similarity, title, character, material, source, urls }]
 */
export async function searchAnime(buf, cacheKey = null) {
  if (!isEnabled()) return { ok: false, matches: [], skipped: '没配 SauceNAO API key' };
  if (!buf?.length) return { ok: false, matches: [], skipped: '图片是空的' };

  cleanCache();
  if (cacheKey && cache.has(cacheKey)) {
    log.debug(`[图搜] 命中缓存 ${cacheKey}`);
    return cache.get(cacheKey).result;
  }

  const now = Date.now();
  if (now < blockedUntil) {
    return { ok: false, matches: [], skipped: `图搜退避中（还有 ${Math.ceil((blockedUntil - now) / 1000)}s）` };
  }
  if (now - lastAt < MIN_GAP_MS) {
    await new Promise((r) => setTimeout(r, MIN_GAP_MS - (now - lastAt)));
  }
  lastAt = Date.now();

  const form = new FormData();
  form.append('file', new Blob([buf]), 'a.png');
  form.append('output_type', '2'); // JSON
  form.append('numres', String(config.saucenao?.results ?? 5));
  form.append('db', '999'); // 搜所有库
  form.append('api_key', String(config.saucenao.apiKey));

  let result;
  try {
    const r = await fetch(ENDPOINT, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
    const text = await r.text();

    let j;
    try {
      j = JSON.parse(text);
    } catch {
      log.warn(`[图搜] 返回不是 JSON（HTTP ${r.status}）：${text.slice(0, 120)}`);
      return { ok: false, matches: [], skipped: `返回异常 HTTP ${r.status}` };
    }

    const status = Number(j.header?.status);
    if (status < 0) {
      const msg = String(j.header?.message ?? '未知错误');
      log.warn(`[图搜] 接口报错：${msg}`);
      // 频率限制 → 退避一会儿再试
      if (/limit|too many|throttl/i.test(msg)) {
        blockedUntil = Date.now() + 60_000;
      }
      return { ok: false, matches: [], skipped: msg };
    }

    const matches = (j.results ?? [])
      .map((x) => {
        const d = x.data ?? {};
        return {
          similarity: Number(String(x.header?.similarity ?? '0').replace('%', '')) || 0,
          title: String(d.title ?? '').trim(),
          character: String(d.character ?? '').trim(),
          material: String(d.material ?? '').trim(),
          source: String(d.source ?? '').trim(),
          urls: (d.ext_urls ?? []).slice(0, 2).map(String),
        };
      })
      // 相似度太低的没参考价值，还会误导
      .filter((m) => m.similarity >= (config.saucenao?.minSimilarity ?? 60))
      .slice(0, config.saucenao?.results ?? 5);

    result = { ok: true, matches };
    log.info(`[图搜] ${matches.length ? `命中 ${matches.length} 条（最高 ${matches[0]?.similarity}%）` : '没匹配到'}`);
    if (cacheKey) cache.set(cacheKey, { at: Date.now(), result });
    return result;
  } catch (e) {
    log.warn(`[图搜] 出错：${e.message}`);
    return { ok: false, matches: [], skipped: e.message };
  }
}

/** 文件路径版本 */
export async function searchAnimeFile(path, cacheKey = null) {
  try {
    return await searchAnime(readFileSync(path), cacheKey);
  } catch (e) {
    return { ok: false, matches: [], skipped: `读图失败：${e.message}` };
  }
}

/**
 * 把图搜结果拼成给模型看的文本。
 * @returns {string} 没结果就返回空串
 */
export function reverseBlock(matches) {
  if (!matches?.length) return '';
  const lines = matches.map((m, i) => {
    const parts = [];
    if (m.character) parts.push(`角色：${m.character}`);
    if (m.title) parts.push(`作品：${m.title}`);
    if (m.material) parts.push(`出处：${m.material}`);
    if (m.source) parts.push(`来源：${m.source}`);
    return `${i + 1}. （相似度 ${m.similarity}%）${parts.join('　')}`;
  });

  return [
    '',
    '# 【反向图搜结果】这张图**查到了出处**',
    '',
    ...lines,
    '',
    '⚠️ 这是图片搜索引擎给出的匹配，用这些信息回答：',
    '- **以这里的信息为准**，别再用自己的印象猜角色名了。',
    '- 相似度高（90% 以上）基本可以确定；只有 60~70% 的话说「可能是」。',
    '- 如果你本来以为是谁、但这里写的是别人，**以这里为准**。',
  ].join('\n');
}

export function stats() {
  return {
    enable: isEnabled(),
    cached: cache.size,
    blocked: Date.now() < blockedUntil,
    blockedSecondsLeft: Math.max(0, Math.ceil((blockedUntil - Date.now()) / 1000)),
  };
}

export function reset() {
  cache.clear();
  blockedUntil = 0;
  lastAt = 0;
}
