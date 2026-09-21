/**
 * **用 HTTP 直接发 QQ 空间说说**（2026-09-20 加，为了 LLBot 兼容）。
 *
 * ## 为什么需要（背景，别删）
 *
 * `qzone.js` 原来走的是 **NapCat 的扩展 action `send_qzone_msg`** —— 那是 NapCat
 * 自己加的，"发说说"**不属于 OneBot 11 标准**（标准里只有消息那一套）。
 * 所以 2026-09-20 换成 **LLBot** 之后，这个 action 在它那边**根本不存在**
 * （查过 `llbot.js` 的实现清单：`send_*` / `get_*` 里没有任何空间相关的），
 * 于是发说说必然失败。
 *
 * ## 这条路怎么来的（不是瞎猜）
 *
 * LLBot **暴露了 `get_cookies`**（正式 action，带输入输出定义：
 * 「需要获取 Cookies 的域名」→「域名对应的 Cookies 字符串」），
 * 而且**它自己发空间用的就是它**（`ntWebApi.getCookies("h5.qzone.qq.com")`）。
 * 所以我们不去改它那个 2.4MB 的打包文件（而且它还会自动更新、改了会被覆盖），
 * 而是：**拿它给的 cookies，自己按 QZone 的网页接口发**。
 *
 * ## ⚠️⚠️ 三条必须知道的风险（用户 2026-09-20 知情后选择做）
 *
 * 1. **风控**：这号已经被腾讯标成「风险设备」。协议端是"标准客户端行为"，
 *    而**自己拼 HTTP 调空间接口**在腾讯看来更像脚本操作 ——
 *    **有可能让它被踢得更勤**。出问题就关掉 `qzone.enable` 或改回 NapCat。
 * 2. **接口是未公开的**：`emotion_cgi_publish_v6` 这类接口腾讯改一次就得跟着改，
 *    这是**长期维护负担**（项目里其它模块都走协议端或公开接口，只有这个是例外）。
 * 3. **第一版只发文字**：QZone 发图要**先上传图片拿 richval**（另一套接口），
 *    这里还没做 → 配图的说说会**降级成纯文字**（见下面 `TODO`）。
 *    要图的话再说，那一套比文字麻烦不少。
 *
 * ## 理想解法（已经让用户去提了）
 *
 * 向 LLBot 提 feature request：**补一个 `send_qzone_msg`**（对齐 NapCat 的扩展），
 * 那样这个文件就可以删掉了。**它一旦支持，优先走 action**（见 `qzone.js` 里的分派）。
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { log } from './log.js';

/** QZone 的发布接口（v6，公开资料里流传很久的那个） */
const PUBLISH_URL =
  'https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6';

/** QZone 的图片上传接口（发图必须先过这一关，拿 `richval`） */
const UPLOAD_URL = 'https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/**
 * 从 cookies 里算 **g_tk**（QZone/QQ 那套经典的 djb2 变体）。
 *
 * ⚠️ 算法是固定的、公开的，网上到处都是：
 *    `hash = 5381; hash += (hash << 5) + charCode;` 最后 `& 0x7fffffff`。
 *    ⚠️ 用的是 **`p_skey`**（不是 `skey`）—— 空间域下是 `p_skey`，用错会 403。
 *
 * @param {string} cookies `get_cookies` 拿回来的整串
 * @returns {number|null} null = 里面没有 p_skey
 */
export function gtkFromCookies(cookies) {
  const m = /(?:^|;\s*)p_skey=([^;]*)/.exec(String(cookies ?? ''));
  if (!m || !m[1]) return null;
  let h = 5381;
  const s = m[1];
  for (let i = 0; i < s.length; i++) h += (h << 5) + s.charCodeAt(i);
  return h & 0x7fffffff;
}

/**
 * **上传一张图**，返回发布时需要的 `richval`（和它的 `url`）。
 *
 * ⚠️ 为什么必须上传：QZone 的发布接口**不接受图片文件本身**，它要的是先上传后
 *    拿到的那串 `richval`（形如 `,<url>,<w>,<h>,<size>,...`），
 *    发布时用 `richtype=1&richval=...` 带上去 —— 这也是**未公开接口**（同 `PUBLISH_URL`）。
 *
 * ⚠️ 设计上**失败不致命**：返回 null，上层就把这条降级成纯文字发出去
 *    （宁可少张图，也不能因为图挂了导致整条说说发不出去）。
 *
 * @param {{filePath:string, cookies:string, uin:string}} q
 * @returns {Promise<{richval:string, url:string, raw?:string}|null>}
 */
/** ⚠️ `qzone.js` 的 `imageRef()` 给的是 `data:image/jpeg;base64,…`，这里解成 buffer */
function dataUrlToBuffer(s) {
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(String(s ?? ''));
  if (!m) return null;
  try {
    const buf = m[2]
      ? Buffer.from(m[3] ?? '', 'base64')
      : Buffer.from(decodeURIComponent(m[3] ?? ''));
    return buf.length ? { buf, mime: m[1] || 'image/jpeg' } : null;
  } catch {
    return null;
  }
}

export async function uploadImage({ src, filePath, cookies, uin }) {
  const gtk = gtkFromCookies(cookies);
  if (gtk === null) return null;
  // ⚠️ 支持三种来源，但**主路径是 data URL** —— `qzone.js` 的 `imageRef()` 就是把文件
  //    读成 `data:image/…;base64,…` 塞进 `params.images` 的（不要以为那是路径）。
  const raw0 = String(src ?? filePath ?? '').trim();
  let buf = null;
  let mime = 'image/jpeg';
  let name = 'image.jpg';
  if (raw0.startsWith('data:')) {
    const d = dataUrlToBuffer(raw0);
    if (!d) {
      log.warn('[空间·HTTP] 配图的 data URL 解不开');
      return null;
    }
    buf = d.buf;
    mime = d.mime;
  } else {
    const p = raw0.startsWith('file://')
      ? decodeURIComponent(raw0.replace(/^file:\/\/\/?/, ''))
      : raw0;
    try {
      buf = await readFile(p);
      name = basename(p) || name;
    } catch (e) {
      log.warn(`[空间·HTTP] 读不到配图文件：${e.message}`);
      return null;
    }
  }
  try {
    const fd = new FormData();
    // ⚠️ 字段名是照社区实现来的：`filename`（名字）+ `uploadtype` + `file`（本体）
    fd.append('filename', name);
    fd.append('uploadtype', '1');
    fd.append('albumtype', '1');
    fd.append('file', new Blob([buf], { type: mime }), name);
    const res = await fetch(`${UPLOAD_URL}?g_tk=${gtk}`, {
      method: 'POST',
      headers: {
        Cookie: String(cookies),
        Referer: `https://user.qzone.qq.com/${uin ?? ''}`,
        'User-Agent': UA,
      },
      body: fd,
      signal: AbortSignal.timeout(60000), // 上传比发布慢，给足时间
    });
    const raw = await res.text();
    if (!res.ok) {
      log.warn(`[空间·HTTP] 上传配图失败：HTTP ${res.status}`);
      return null;
    }
    let j = null;
    try {
      j = JSON.parse(raw);
    } catch {
      log.warn(`[空间·HTTP] 上传返回的不是 JSON：${raw.slice(0, 120)}`);
      return null;
    }
    // ⚠️ 宽容解析：不同版本把结果放在 `data` 里或直接平铺，`ret`/`code` 也见过两种
    const d = j?.data ?? j ?? {};
    const richval = String(d.richval ?? j?.richval ?? '').trim();
    const url = String(d.url ?? j?.url ?? '').trim();
    if (!richval) {
      log.warn(
        `[空间·HTTP] 上传没给 richval（ret=${j?.ret ?? j?.code ?? '?'}）：${raw.slice(0, 160)}`,
      );
      return null;
    }
    log.info(`[空间·HTTP] 配图已上传（${Math.round(buf.length / 1024)}KB）`);
    return { richval, url, raw: raw.slice(0, 300) };
  } catch (e) {
    log.warn(`[空间·HTTP] 上传配图出错：${e.message}`);
    return null;
  }
}

/**
 * 发一条说说。
 *
 * ⚠️ 配图要先 `uploadImage()` 拿 `richval`（见上面那段注释）；
 *    上传失败就**降级成纯文字**，不影响这条说说本身发出去。
 *
 * @param {{content:string, cookies:string, uin:string, images?:string[]}} q
 *        `images` = 本地图片路径，最多 9 张（跟 QZone 一致）
 * @returns {Promise<{ok:boolean, tid?:string|null, error?:string, images?:number}>}
 */
export async function publish({ content, cookies, uin, images = [] }) {
  const text = String(content ?? '').trim();
  if (!text) return { ok: false, error: '内容是空的' };
  const gtk = gtkFromCookies(cookies);
  if (gtk === null) {
    return { ok: false, error: 'cookies 里没有 p_skey（拿不到 g_tk，可能是域名取错了）' };
  }
  // ── 配图（可选，失败不致命）──────────────────────────────
  const richvals = [];
  for (const p of (Array.isArray(images) ? images : []).slice(0, 9)) {
    if (!p) continue;
    const up = await uploadImage({ filePath: p, cookies, uin });
    if (up?.richval) richvals.push(up.richval);
  }
  const body = new URLSearchParams({
    syn_tweet_verson: '1',
    paramstr: '1',
    who: '1',
    con: text,
    feedversion: '1',
    ver: '1',
    ugc_right: '1',
    to_sign: '0',
    hostuin: String(uin ?? ''),
    code_version: '1',
    format: 'json',
    qzreferrer: `https://user.qzone.qq.com/${uin ?? ''}`,
  });
  if (richvals.length) {
    // ⚠️ 这两个是配图的开关：`richtype=1` + `richval`（多张用 \t 分隔，社区实现一致）
    body.set('richtype', '1');
    body.set('richval', richvals.join('\t'));
  }
  try {
    const res = await fetch(`${PUBLISH_URL}?g_tk=${gtk}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: String(cookies),
        Referer: `https://user.qzone.qq.com/${uin ?? ''}`,
        'User-Agent': UA,
      },
      body,
      signal: AbortSignal.timeout(25000),
    });
    const raw = await res.text();
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}${raw ? ` —— ${raw.slice(0, 160)}` : ''}` };
    }
    let j = null;
    try {
      j = JSON.parse(raw);
    } catch {
      /* 有些失败会回一段 HTML，下面统一报原文 */
    }
    // ⚠️ 成功时通常带 `code:0` 和 `tid`；拿不到 code 时只要没有明确的错误码就算过
    if (j && (j.code === 0 || j.ret === 0 || j.subcode === 0 || j.tid)) {
      // ⚠️ 把"带了几张图"也报出去 —— 上层/日志能据此判断配图有没有成功
      return { ok: true, tid: j.tid ? String(j.tid) : null, images: richvals.length };
    }
    const msg = j ? `code=${j.code ?? '?'} ${j.message ?? j.msg ?? ''}`.trim() : '';
    return { ok: false, error: `接口没认（${msg || raw.slice(0, 160)}）` };
  } catch (e) {
    log.debug(`[空间·HTTP] 发送出错：${e.message}`);
    return { ok: false, error: e.message };
  }
}
