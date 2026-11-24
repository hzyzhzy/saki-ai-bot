/**
 * 轻量搜图 —— 不派 agent，直接 HTTP 抓图源 → 校验 → 下载 → 发群（2026-11-21 加）
 *
 * ## 为什么要这条路
 *   原来的搜图（`image-search.js` 的 `startImageSearch()`）是**派一个 agent 任务**：
 *   起 agent ⇒ agent 自己上网翻 safebooru ⇒ 挑图 ⇒ 下到工作文件夹 ⇒ `tick` 每 3 秒扫一次发。
 *   第一次发图经常是 **1~3 分钟**之后，而且整条链依赖 DSH runner 活着。
 *   而"搜图"本身只是个 HTTP 抓取 + 解析的活，跟文字搜索（`search.js`）没有区别。
 *   ⇒ 这条路：**几个源并行抓 → 校验能下 → 直接下 → 直接发**，通常 3~8 秒出图。
 *
 * ## 和老路的分工（老路**保留**，别删）
 *   · 这条路：`什么图 → 拿到几张能用的 → 发出去`。不做"挑"，不做识图，不做跨次指纹去重；
 *   · 老路：要"挑好的"、要每张识图后配一段评论、要反复换关键词找特定角色 ⇒ 还得靠 agent。
 *   ⇒ `bot.js` 里先走这条路，**拿不到图才退回老路** ✓
 *
 * ## 三个源（都是实测过的，见 `logs/__img-source-probe.mjs`）
 *   | 源 | 拿得到 | 备注 |
 *   | --- | --- | --- |
 *   | 百度 image.baidu.com/acjson | 20~30 条 | 最快（2 秒级）、中文 query 命中率最好；`middleURL` 可直连下载 |
 *   | Bing 图片 | 20~35 条 | 慢一点（首字节 5~8 秒）、域名杂（各家图床都可能有）；`m` 属性里的 `murl` |
 *   | safebooru | 5~20 条 | 只认英文 tag（`hatsune_miku`），中文 query 自然 0 条 ⇒ 自动跳过 |
 *   ⚠️ 这台机器 `127.0.0.1:7890` 代理**没在跑**，三个源**直连都通**，所以不做代理解析 ✓
 *
 * ## 内容安全（硬要求）
 *   · safebooru 一律带 `rating:safe` tag，并且**逐条再查 `rating` 字段** ——
 *     只收 `safe` / `general`，`questionable` / `explicit` / `sensitive` 一律丢；
 *   · 百度结果里 `is_gif` 的丢掉（动图 / 视频源，体积也大）；
 *   · `.svg` 丢（协议端不认、也可能带脚本）；整条 URL 只放行 `image/*` + 魔数对得上的；
 *   · ⚠️ 百度 / Bing 是公共图搜，**里面混着真人照片，这条路没有识图能力、判不了** ——
 *     所以它只适合"要几张相关图看看"，真人对脸/隐私要求高的场景还得走老路（老路提示词里
 *     明确"绝不下载真人照片"）。这条限制写在交付报告里，别当成已解决 ✓
 */

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { log } from './log.js';
import { sendImageMsg } from './image-search.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, 'state', '__quick-img'); // 轻量搜图的下图临时目录（自己清，不掺和老路那套）
const CACHE_KEEP_MS = 7 * 24 * 3600 * 1000; // 只留最近 7 天

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/203.0.113.10 Safari/537.36';

const DEF_TIMEOUT = 10000; // 单次 HTTP 10 秒（用户要求：超时 10 秒，失败就换下一个源）
const DEF_MAX_BYTES = 8 * 1024 * 1024; // 8MB 上限（别下个几十 MB 的视频/GIF 进来）
const MIN_BYTES = 8 * 1024; // 比这小的多半是图标 / 占位图 / 空壳
const MAX_SEND = 3; // 一次最多发 3 张（别刷屏）
const PER_SOURCE = 12; // 每个源最多取几条候选
const PROBE_BATCH = 4; // 校验（能不能下）时一次并发几个
const TOTAL_BUDGET_MS = 25000; // 整条轻量路径的总预算，超了就交给老路
const OUT_PX = 1600; // 发出去统一缩到这个边（和老路的 toSendable 一致）
const MIN_SIDE = 360; // 最短边比这个还小 ⇒ 群里明显糊，不发（实测百度那条接口只给 500px 的缩略图）

/* ────────────────────────────── 小工具 ────────────────────────────── */

const unesc = (s) =>
  String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\\\//g, '/');

/** 去掉 HTML 标签 + 压空白（百度的标题字段带 `<em>` 高亮） */
const plain = (s) =>
  unesc(String(s ?? ''))
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** 魔法数字：content-type 可以骗人，头几个字节骗不了 */
function sniff(buf) {
  if (!buf || buf.length < 4) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'gif';
  if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP')
    return 'webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  return '';
}

/** 去重用的归一化 key：同 URL、同图不同尺寸（`?w=500&h=666`、`-1200x4000`）算一张 */
function keyOf(u) {
  try {
    const x = new URL(u);
    const p = x.pathname
      .toLowerCase()
      .replace(/[-_]\d{2,4}x\d{2,4}(?=\.[a-z]+$)/, '') // -1200x4000.jpg
      .replace(/\.(jpe?g|png|webp|gif|bmp|jpeg)$/, '');
    return `${x.hostname.replace(/^www\./, '')}${p}`;
  } catch {
    return String(u);
  }
}

/** 去重：同 key 只留第一条（先到先得 = 前面那个源的优先级更高） */
function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const it of list) {
    const k = keyOf(it.url);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

/** 几个源的结果**交错**排（一次 3 张里尽量混着不同源，别全是一家的杂图） */
function interleave(lists) {
  const out = [];
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i += 1) {
    for (const l of lists) if (l[i]) out.push(l[i]);
  }
  return out;
}

async function fetchText(url, { timeoutMs = DEF_TIMEOUT, headers = {} } = {}) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/json,*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...headers,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  return { status: r.status, text };
}

/* ────────────────────────────── 三个源 ────────────────────────────── */

/** 百度图片（acjson）—— 最快，中文 query 命中率最好 */
async function fromBaidu(query, { timeoutMs }) {
  const u =
    'https://image.baidu.com/search/acjson?tn=resultjson_com&logid=1&ipn=rj&ct=201326592' +
    `&fp=result&word=${encodeURIComponent(query)}&pn=0&rn=30`;
  const { status, text } = await fetchText(u, {
    timeoutMs,
    headers: { Referer: 'https://image.baidu.com/' },
  });
  if (status !== 200) throw new Error(`百度 HTTP ${status}`);
  let data = [];
  try {
    data = JSON.parse(text).data ?? [];
  } catch {
    throw new Error('百度返回的不是 JSON');
  }
  const out = [];
  for (const d of data) {
    if (!d || typeof d !== 'object') continue;
    // 🚫 动图 / 视频源：体积不可控，协议端也不适合发
    if (d.is_gif === 1 || d.is_gif === '1') continue;
    const url = d.middleURL || d.hoverURL || d.thumbURL;
    if (!url || !/^https?:\/\//.test(url)) continue;
    out.push({
      url,
      thumbUrl: d.thumbURL || '',
      title: plain(d.fromPageTitleEnc || d.fromPageTitle || '').slice(0, 80),
      w: Number(d.width) || 0,
      h: Number(d.height) || 0,
      bytes: (Number(d.filesize) || 0) * 1024 || 0, // 百度这边 filesize 是 KB
      source: 'baidu',
    });
    if (out.length >= PER_SOURCE) break;
  }
  return out;
}

/** Bing 图片 —— `m="{…}"` 属性里那个 JSON 带 `murl`（原图）/ `turl`（缩略图）/ `t`（标题） */
async function fromBing(query, { timeoutMs }) {
  const u = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1`;
  const { status, text } = await fetchText(u, { timeoutMs });
  if (status !== 200) throw new Error(`Bing HTTP ${status}`);
  const out = [];
  // ① 先按属性整块解 JSON（能同时拿到 murl / turl / t）
  for (const m of text.matchAll(/m="(\{[^"]{20,}\})"/g)) {
    let o;
    try {
      o = JSON.parse(unesc(m[1]));
    } catch {
      continue;
    }
    if (!o?.murl || !/^https?:\/\//.test(o.murl)) continue;
    out.push({
      url: o.murl,
      thumbUrl: o.turl && /^https?:\/\//.test(o.turl) ? o.turl : '',
      title: plain(o.t || o.desc || '').slice(0, 80),
      w: 0,
      h: 0,
      bytes: 0,
      source: 'bing',
    });
    if (out.length >= PER_SOURCE) break;
  }
  // ② 兜底：属性外面的裸露 JSON（不同区域版本长这样）
  if (!out.length) {
    for (const m of text.matchAll(/"murl":"(https?:\/\/[^"]+)"/g)) {
      const url = unesc(m[1]);
      if (!/^https?:\/\//.test(url)) continue;
      out.push({ url, thumbUrl: '', title: '', w: 0, h: 0, bytes: 0, source: 'bing' });
      if (out.length >= PER_SOURCE) break;
    }
  }
  return out;
}

/**
 * safebooru —— 只认英文 tag（`hatsune_miku`），中文 query 自然 0 条 ⇒ 自动跳过。
 *
 * ⚠️ 内容安全：**一律带 `rating:safe`**，并且逐条再查 `rating` 字段。
 *    safebooru 实际返回的 rating 是 `safe` / `general`（这俩都是全年龄），
 *    `questionable` / `explicit` / `sensitive` 一律丢 ✗
 */
async function fromSafebooru(query, { timeoutMs }) {
  const tags = String(query).trim().replace(/\s+/g, '_');
  if (!tags) return [];
  const u =
    'https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1' +
    `&limit=20&tags=${encodeURIComponent(`${tags} rating:safe`)}`;
  const { status, text } = await fetchText(u, { timeoutMs });
  if (status !== 200) throw new Error(`safebooru HTTP ${status}`);
  let posts = [];
  try {
    posts = JSON.parse(text);
  } catch {
    return []; // 中文 tag / 不存在的 tag ⇒ 站上给的是 HTML 空页，不是错
  }
  if (!Array.isArray(posts)) return [];
  const OK_RATING = new Set(['safe', 'general']);
  const out = [];
  for (const p of posts) {
    const r = String(p?.rating ?? '').toLowerCase();
    if (!OK_RATING.has(r)) continue; // 🚫 非全年龄一律不进
    let url = String(p?.file_url ?? '');
    if (url.startsWith('//')) url = 'https:' + url;
    else if (url.startsWith('/')) url = 'https://safebooru.org' + url;
    if (!/^https?:\/\//.test(url)) continue;
    const tagsList = String(p?.tags ?? '')
      .split(/\s+/)
      .filter((t) => t && !t.includes(':') && t.length > 2)
      .slice(0, 6);
    out.push({
      url,
      thumbUrl: (() => {
        const t = String(p?.preview_url ?? '');
        return t.startsWith('//') ? 'https:' + t : '';
      })(),
      title: tagsList.join(', ').slice(0, 80),
      w: Number(p?.width) || 0,
      h: Number(p?.height) || 0,
      bytes: 0,
      source: 'safebooru',
    });
    if (out.length >= PER_SOURCE) break;
  }
  return out;
}

/* ────────────────────────────── 校验 ────────────────────────────── */

/**
 * 只读前 n 个字节（读完就断连接）。
 * ⚠️ 为什么不能直接 `arrayBuffer()`：有的图床**不支持 Range**（回 200 + 整张图），
 *    那样"只探一下"就会把一张 20MB 的原图整个拉进内存 ✗
 */
async function readHead(r, n = 2048) {
  const reader = r.body?.getReader?.();
  if (!reader) {
    const b = Buffer.from(await r.arrayBuffer());
    return b.subarray(0, n);
  }
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const b = Buffer.from(value);
      chunks.push(b);
      size += b.length;
      if (size >= n) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
  return Buffer.concat(chunks).subarray(0, n);
}

/**
 * 校验这张**真能下、真是图、不是超大**。
 * ⚠️ 用 `GET + Range: bytes=0-2047` 而不是 HEAD —— 不少图床不支持 HEAD（405/403），
 *    而 Range 请求**实测三个源都回 206**，顺便拿到总大小（在 `Content-Range` 里）✓
 */
async function probeImage(url, { timeoutMs, maxBytes }) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'image/*,*/*', Referer: 'https://www.bing.com/' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok && r.status !== 206) return { ok: false, why: `HTTP ${r.status}` };
  const ct = String(r.headers.get('content-type') ?? '').toLowerCase();
  if (!/^image\//.test(ct)) return { ok: false, why: `不是图（${ct || '无 CT'}）` };
  if (ct.includes('svg')) return { ok: false, why: 'svg' };
  // 总大小：206 时 content-length 只是这 2KB，真值在 Content-Range 的 `/总长`
  let total = 0;
  const cr = String(r.headers.get('content-range') ?? '');
  const m = cr.match(/\/(\d+)\s*$/);
  if (m) total = Number(m[1]) || 0;
  if (!total) total = Number(r.headers.get('content-length') ?? 0) || 0;
  if (total && total > maxBytes) return { ok: false, why: `太大 ${Math.round(total / 1024 / 1024)}MB` };
  if (total && total < MIN_BYTES) return { ok: false, why: `太小 ${Math.round(total / 1024)}KB` };
  let buf = Buffer.alloc(0);
  try {
    buf = await readHead(r, 2048);
  } catch {}
  const kind = sniff(buf);
  if (!kind) return { ok: false, why: '头几个字节不是图' };
  if (kind === 'gif') return { ok: false, why: 'gif' };
  return { ok: true, bytes: total, kind, ct };
}

/* ────────────────────────────── 对外：搜索 ────────────────────────────── */

/**
 * 搜图：几个源并行抓 → 去重 → 校验（能不能下）→ 返回**只含能下的**。
 *
 * @param {{query:string, limit?:number, maxBytes?:number, timeoutMs?:number}} opts
 * @returns {Promise<Array<{url:string, thumbUrl:string, title:string, w:number, h:number,
 *   bytes:number, source:string, kind:string}>>}
 */
export async function quickImageSearch({ query, limit = MAX_SEND, maxBytes = DEF_MAX_BYTES, timeoutMs = DEF_TIMEOUT } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const t0 = Date.now();
  const want = Math.max(1, Math.min(MAX_SEND + 2, Math.floor(Number(limit)) || MAX_SEND)); // 多备两张，下载可能失败

  // ① 三个源**同时**问 —— 谁挂了都不影响别的（"失败就换下一个源"由并行天然满足）
  const [b, bi, s] = await Promise.allSettled([
    fromBaidu(q, { timeoutMs }),
    fromBing(q, { timeoutMs }),
    fromSafebooru(q, { timeoutMs }),
  ]);
  const take = (r, name) => {
    if (r.status === 'fulfilled') return r.reason ?? r.value ?? [];
    const v = r.value ?? [];
    if (!v.length) log.debug(`[速搜图] ${name} 没给东西：${String(r.reason?.message ?? '').slice(0, 60)}`);
    return v;
  };
  const lists = [
    take(bi, 'Bing'),
    take(b, '百度'),
    take(s, 'safebooru'),
  ].map((x) => (Array.isArray(x) ? x : []));
  // ⚠️ 顺序 = Bing → 百度 → safebooru：实测**百度那条 acjson 只给 500~750px 的缩略图**
  //    （`middleURL` 带 `?w=500&h=666`，去掉 query / 改大 w、h 都还是 500px，原图字段是空的），
  //    而 Bing 的 `murl` 通常是原图（1000~2000px）⇒ 先把大的放前面 ✓
  const counts = { bing: lists[0].length, baidu: lists[1].length, safebooru: lists[2].length };
  if (!lists.some((l) => l.length)) {
    log.info(`[速搜图] 三个源都没拿到候选（${q.slice(0, 30)}）`);
    return [];
  }
  const cands = dedupe(interleave(lists));
  log.info(
    `[速搜图] 候选 ${cands.length} 条（百度 ${counts.baidu} / Bing ${counts.bing} / safebooru ${counts.safebooru}）`,
  );

  // ② 分批并发校验，够了就停
  const ok = [];
  for (let i = 0; i < cands.length && ok.length < want; i += PROBE_BATCH) {
    if (Date.now() - t0 > TOTAL_BUDGET_MS) {
      log.warn('[速搜图] 预算用完了，先用手上这些');
      break;
    }
    const batch = cands.slice(i, i + PROBE_BATCH);
    const res = await Promise.allSettled(
      batch.map((c) => probeImage(c.url, { timeoutMs, maxBytes })),
    );
    res.forEach((r, idx) => {
      const c = batch[idx];
      if (r.status !== 'fulfilled' || !r.value?.ok) {
        if (r.status === 'fulfilled' && r.value?.why) {
          log.debug(`[速搜图] 跳过（${c.source} ${r.value.why}）：${c.url.slice(0, 70)}`);
        }
        return;
      }
      ok.push({ ...c, bytes: r.value.bytes || c.bytes || 0, kind: r.value.kind });
    });
  }
  log.info(`[速搜图] ${q.slice(0, 30)} ⇒ 可用 ${ok.length} 张，耗时 ${Date.now() - t0}ms`);
  return ok.slice(0, want);
}

/* ────────────────────────────── 对外：下载 ────────────────────────────── */

/** 清一下轻量搜图的临时目录（只删自己的、只删 7 天前的） */
function cleanCache(dir) {
  try {
    const now = Date.now();
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      try {
        if (now - statSync(p).mtimeMs > CACHE_KEEP_MS) rmSync(p, { force: true });
      } catch {}
    }
  } catch {}
}

/**
 * 把一张图下到本地（顺手统一成 1600px 的 JPEG）。
 *
 * ⚠️ 为什么要 sharp 转一道：① 体积从几 MB 降到 300KB 左右（协议端上限那里会卡）；
 *    ② 顺手丢掉 EXIF（原图可能带定位 / 拍摄设备）；③ 格式统一成 jpg，协议端不会挑；
 *    ④ 转不动（sharp 不认的格式）⇒ 就用原始字节，别因为"压不了"把图丢了。
 *
 * @returns {Promise<{path:string, bytes:number, w:number, h:number, kind:string}>}
 */
export async function downloadImage(url, { dir = CACHE_DIR, maxBytes = DEF_MAX_BYTES, timeoutMs = DEF_TIMEOUT, name = '' } = {}) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'image/*,*/*', Referer: 'https://www.bing.com/' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const ct = String(r.headers.get('content-type') ?? '').toLowerCase();
  if (!/^image\//.test(ct)) throw new Error(`不是图（${ct || '无 CT'}）`);
  // ⚠️ 先看声明长度，再**边读边数**：有的源不给 content-length，
  //    直接 `arrayBuffer()` 会把一张几十 MB 的原图整个拉进内存 ✗
  const declared = Number(r.headers.get('content-length') ?? 0) || 0;
  if (declared && declared > maxBytes) throw new Error(`太大 ${Math.round(declared / 1024 / 1024)}MB`);
  let raw;
  const reader = r.body?.getReader?.();
  if (!reader) {
    raw = Buffer.from(await r.arrayBuffer());
  } else {
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const b = Buffer.from(value);
      size += b.length;
      if (size > maxBytes) {
        try {
          await reader.cancel();
        } catch {}
        throw new Error(`太大 超过 ${Math.round(maxBytes / 1024 / 1024)}MB`);
      }
      chunks.push(b);
    }
    raw = Buffer.concat(chunks);
  }
  if (raw.length > maxBytes) throw new Error(`太大 ${Math.round(raw.length / 1024 / 1024)}MB`);
  if (raw.length < MIN_BYTES) throw new Error(`太小 ${raw.length}B`);
  const kind = sniff(raw);
  if (!kind) throw new Error('头几个字节不是图');

  mkdirSync(dir, { recursive: true });
  cleanCache(dir);
  const file = join(dir, `${name || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`}.jpg`);
  let out = raw;
  let w = 0;
  let h = 0;
  try {
    out = await sharp(raw)
      .rotate()
      .resize({ width: OUT_PX, height: OUT_PX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer();
    const meta = await sharp(out).metadata();
    w = meta.width || 0;
    h = meta.height || 0;
  } catch (e) {
    log.debug(`[速搜图] 压不动，原样存（${e.message}）`);
  }
  writeFileSync(file, out);
  return { path: file, bytes: out.length, w, h, kind };
}

/* ────────────────────────────── 对外：一条龙（搜 → 下 → 发群） ────────────────────────────── */

/**
 * 轻量搜图一条龙：搜 → 下 → **直接发进群**。
 *
 * ⚠️ **只发图，不配文**，也不做"每张图 => 生成一句话"的循环。
 *    口径就是"正常人发图"：图该发就发，文字该说什么说什么 —— 那句由她**自己那次回复**说，
 *    这条路一个字都不替她写。老路（`startImageSearch`）才是"一张一句、图文交错"，
 *    新路径**不照抄**那个形式 ✓
 *
 * @param {{bot:any, gid:string|number, query:string, limit?:number}} opts
 * @returns {Promise<{ok:boolean, got:number, sent:Array<object>, fails:string[], ms:number, reason:string}>}
 */
export async function quickImageSearchSend({ bot, gid, query, limit = MAX_SEND } = {}) {
  const t0 = Date.now();
  const cap = Math.max(1, Math.min(MAX_SEND, Math.floor(Number(limit)) || MAX_SEND));
  // ⚠️ 多备两张：下面"尺寸太小 / 下不下来"会跳过，得有后备才凑得够 cap 张
  const found = await quickImageSearch({ query, limit: cap + 2 });
  const out = { ok: false, got: found.length, sent: [], fails: [], ms: 0, reason: '' };
  if (!found.length) {
    out.ms = Date.now() - t0;
    out.reason = '三个源都没拿到能用的图';
    return out;
  }
  for (const it of found) {
    if (out.sent.length >= cap) break;
    try {
      const f = await downloadImage(it.url, { name: `q-${it.source}-${Date.now()}` });
      // ⚠️ 太小的不发（缩略图 / 图标，群里看就是糊的）—— 换个后备顶上，别拿它凑数
      if (f.w && f.h && Math.min(f.w, f.h) < MIN_SIDE) throw new Error(`尺寸太小 ${f.w}x${f.h}`);
      await sendImageMsg(bot, gid, f.path); // 复用老路那个"带超时 + 失败重试一次"的发图函数
      out.sent.push({ ...it, file: f.path, bytes: f.bytes, w: f.w || it.w, h: f.h || it.h });
      log.info(`[速搜图] 已发第 ${out.sent.length} 张（${it.source} ${Math.round(f.bytes / 1024)}KB）`);
    } catch (e) {
      out.fails.push(`${it.source}: ${String(e?.message ?? e).slice(0, 60)}`);
      log.warn(`[速搜图] 这一张没发成（${it.source}）：${String(e?.message ?? e).slice(0, 80)}`);
    }
  }
  out.ok = out.sent.length > 0;
  out.ms = Date.now() - t0;
  if (!out.ok) out.reason = out.fails[0] || '下不下来';
  return out;
}
