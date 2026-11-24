/**
 * 纯 API 发 B站 评论 —— **不经过浏览器**（2026-11-01 加）
 *
 * ## 为什么换
 *
 * 用户：「**是不是发评论的方式不对**」→ 是。
 *
 * 原来的做法是**无头 Chrome 模拟点击**（`tools/bili-proactive-comment.mjs`）：
 *   `headless: true` + `goto` → `scrollTo` → 瞬间填字 → `element.click()`。
 *   没有鼠标轨迹、没有逐字输入、无头模式本身还有一堆指纹面 ⇒
 *   B站 直接弹「受到神秘力量干扰」（风控）✗
 *   今天实测：一天只试 2 次（间隔 3 小时、最保守的节奏）**两次都撞**，
 *   而且撞完**登录态立刻失效**（nav -101，扫的码只活了 11 小时）✗✗
 *
 * 对照 `dsh-bili-scroll` 的做法：它**压根不开浏览器**，
 * 直接 `comment.send_comment()` 调 `x/v2/comment/add`（cookie + csrf + wbi 签名），
 * 一天发 1~2 条几乎不撞 ✓
 *
 * ## 这个模块做什么
 *   1. 读 cookie（`state/bili-cookie/bili-<uid>.json` 的 storageState）
 *   2. 从 `x/web-interface/nav` 拿 wbi 的 `img_key` / `sub_key`
 *   3. 按 B站 的混合表算出 `mixin_key`，再签出 `w_rid`
 *   4. `POST x/v2/comment/add`，返回 `rpid`
 *
 * ⚠️ 只用**只读接口 + 发评论**，不发视频、不干别的。
 * ⚠️ 凭据是账号控制权，绝不外传、不打日志。
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/203.0.113.10 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';

/** B站 wbi 的固定重排表（官方前端里那张，别改） */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

/** 从 storageState 文件里拼出 Cookie 头 */
export function cookieHeader(cookieFile) {
  const raw = JSON.parse(readFileSync(cookieFile, 'utf8'));
  const list = raw?.storageState?.cookies || raw?.cookies || [];
  const ck = list.filter((c) => /bilibili/i.test(String(c.domain || '')));
  const header = ck.map((c) => `${c.name}=${c.value}`).join('; ');
  const get = (n) => ck.find((c) => c.name === n)?.value || '';
  return { header, sessdata: get('SESSDATA'), biliJct: get('bili_jct'), buvid3: get('buvid3') };
}

/** 默认 cookie 路径（按 QQ 号） */
export function defaultCookieFile(ROOT, acct) {
  const a = String(acct || '').trim();
  const f = a ? join(ROOT, 'state', 'bili-cookie', `bili-${a}.json`) : '';
  if (f && existsSync(f)) return f;
  const g = join(ROOT, 'state', 'bili-cookie', 'bili-10000002.json');
  return existsSync(g) ? g : f;
}

function baseHeaders(cookie) {
  return {
    'User-Agent': UA,
    Referer: REFERER,
    Origin: 'https://www.bilibili.com',
    Cookie: cookie.header,
  };
}

async function jget(url, cookie) {
  const r = await fetch(url, { headers: baseHeaders(cookie), signal: AbortSignal.timeout(15000) });
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return { code: -999, message: 'not json: ' + t.slice(0, 120) };
  }
}

/** 从 img_url / sub_url 里抠出文件名（去掉目录和扩展名） */
function keyOf(url) {
  return String(url || '')
    .split('/')
    .pop()
    .split('.')[0];
}

/** 按混合表算出 mixin_key */
export function mixinKey(imgKey, subKey) {
  const raw = String(imgKey) + String(subKey);
  let out = '';
  for (const i of MIXIN_KEY_ENC_TAB) out += raw[i] ?? '';
  return out.slice(0, 32);
}

/**
 * 算 wbi 签名
 * @param {Record<string,string|number>} params
 * @param {string} mixin
 * @returns {Record<string,string>} 原参数 + wts + w_rid
 */
export function signWbi(params, mixin) {
  const wts = Math.floor(Date.now() / 1000);
  const all = { ...params, wts };
  const keys = Object.keys(all).sort();
  const query = keys
    .map((k) => {
      // ⚠️ 官方要求：值里的 !'()* 要过滤掉，否则签名对不上
      const v = String(all[k] ?? '').replace(/[!'()*]/g, '');
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    })
    .join('&');
  const w_rid = createHash('md5').update(query + mixin).digest('hex');
  return { ...all, w_rid };
}

/** 拿 wbi 的两个 key（未登录也能拿到） */
export async function fetchWbiKeys(cookie) {
  const nav = await jget('https://api.bilibili.com/x/web-interface/nav', cookie);
  const wbi = nav?.data?.wbi_img || {};
  const imgKey = keyOf(wbi.img_url);
  const subKey = keyOf(wbi.sub_url);
  if (!imgKey || !subKey) throw new Error('拿不到 wbi_img（nav 没返回）');
  return { imgKey, subKey, mixin: mixinKey(imgKey, subKey), isLogin: !!nav?.data?.isLogin };
}

/**
 * 视频号 → aid
 * ⚠️⚠️ 2026-11-01 修（真踩到）：**av 号也要认** ——
 *    搜索结果里给的是 `av117530270112378` 这种，而 `?bvid=av…` 直接 `-400 请求错误` ✗
 *    （浏览器那条路没事，它只是把 URL 原样打开 ⇒ 换成 API 之后才暴露出来）
 */
export async function aidOf(idOrUrl, cookie) {
  const s = String(idOrUrl || '').trim();
  const mBv = /BV[0-9A-Za-z]{10}/.exec(s);
  const mAv = /\bav(\d{1,20})\b/i.exec(s);
  const q = mBv ? `bvid=${mBv[0]}` : mAv ? `aid=${mAv[1]}` : '';
  if (!q) throw new Error(`认不出视频号（既不是 BV 也不是 av）：${s.slice(0, 40)}`);
  const v = await jget(`https://api.bilibili.com/x/web-interface/view?${q}`, cookie);
  if (v?.code !== 0 || !v?.data?.aid) throw new Error(`取 aid 失败：code=${v?.code} ${v?.message || ''}`);
  return { aid: Number(v.data.aid), title: String(v.data.title || ''), cid: Number(v.data.cid) || 0 };
}

/**
 * 删掉自己发的一条评论（2026-11-01 加）
 * ⚠️ 只用来**收拾测试评论**，流程里正常发出去的不删。
 * @param {{bvid:string, rpid:number, cookieFile:string}} p
 */
export async function deleteComment({ bvid, rpid, cookieFile }) {
  const cookie = cookieHeader(cookieFile);
  if (!cookie.biliJct) return { ok: false, err: '没有 bili_jct' };
  const { mixin } = await fetchWbiKeys(cookie);
  const { aid } = await aidOf(bvid, cookie);
  const signed = signWbi({ oid: aid, type: 1, rpid, csrf: cookie.biliJct }, mixin);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(signed)) body.append(k, String(v));
  const r = await fetch('https://api.bilibili.com/x/v2/reply/del', {
    method: 'POST',
    headers: { ...baseHeaders(cookie), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(20000),
  });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch { return { ok: false, err: `回执不是 JSON：${t.slice(0, 120)}` }; }
  if (j?.code !== 0) return { ok: false, err: `code=${j.code} ${j?.message || ''}` };
  return { ok: true };
}

/**
 * 发一条评论
 * @param {{bvid:string, text:string, cookieFile:string}} p
 * @returns {Promise<{ok:boolean, rpid?:number, err?:string, raw?:any}>}
 */
export async function postComment({ bvid, text, cookieFile }) {
  const cookie = cookieHeader(cookieFile);
  if (!cookie.sessdata) return { ok: false, err: 'cookie 文件里没有 SESSDATA' };
  if (!cookie.biliJct) return { ok: false, err: 'cookie 文件里没有 bili_jct（csrf 必需）' };

  const { mixin, isLogin } = await fetchWbiKeys(cookie);
  if (!isLogin) {
    // ⚠️ 不直接判死：拿不到 wbi 也能发，但登录态失效时接口一定 401/风控，早报早省事
    return { ok: false, err: '登录态失效（nav isLogin=false）⇒ 先重新扫码' };
  }

  const { aid } = await aidOf(bvid, cookie);
  const signed = signWbi(
    {
      oid: aid,
      type: 1,
      message: text,
      csrf: cookie.biliJct,
      plat: 1,
    },
    mixin,
  );

  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(signed)) body.append(k, String(v));

  const r = await fetch('https://api.bilibili.com/x/v2/reply/add', {
    method: 'POST',
    headers: {
      ...baseHeaders(cookie),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(20000),
  });
  const t = await r.text();
  let j = null;
  try {
    j = JSON.parse(t);
  } catch {
    return { ok: false, err: `回执不是 JSON（HTTP ${r.status}）：${t.slice(0, 160)}` };
  }

  if (j?.code !== 0) {
    // ⚠️ 把 B站 的原话带出来，别自己编原因
    const msg = String(j?.message || '');
    const hint =
      /风控|神秘|干扰|稍后/.test(msg)
        ? '（这是 B站 风控，不是代码错误）'
        : j?.code === -352
          ? '（-352 = 风控校验失败）'
          : j?.code === -111
            ? '（-111 = csrf 校验失败，bili_jct 不对）'
            : j?.code === -101
              ? '（-101 = 未登录，cookie 失效）'
              : '';
    return { ok: false, err: `code=${j.code} ${msg}${hint}`, raw: j };
  }

  const rpid = j?.data?.rpid ?? j?.data?.rpid_str ?? 0;
  return { ok: true, rpid: Number(rpid) || 0, raw: j };
}

/* ── 单独跑：node tools/bili-comment-api.mjs --bvid BVxxx --text "..." [--force] ── */
if (process.argv[1] && /bili-comment-api\.mjs$/.test(process.argv[1])) {
  const arg = (n, d = '') => {
    const i = process.argv.indexOf(`--${n}`);
    return i > 0 ? String(process.argv[i + 1] ?? d) : d;
  };
  const has = (n) => process.argv.includes(`--${n}`);
  const bvid = arg('bvid');
  const text = arg('text');
  const acct = arg('account', '10000002');
  const cookieFile = arg('cookie') || defaultCookieFile(join(import.meta.dirname, '..'), acct);
  (async () => {
    console.log('cookie:', cookieFile);
    // ⚠️ 先验「不花钱」的那半：能不能拿到 wbi key、签名算不算得出来
    const cookie = cookieHeader(cookieFile);
    const k = await fetchWbiKeys(cookie).catch((e) => ({ err: e.message }));
    console.log(
      'wbi:',
      k.err
        ? '❌ ' + k.err
        : `✅ imgKey=${k.imgKey.slice(0, 8)}… subKey=${k.subKey.slice(0, 8)}… mixin=${k.mixin.slice(0, 8)}… isLogin=${k.isLogin}`,
    );
    // 顺手验一次签名格式
    if (!k.err) {
      const s = signWbi({ oid: 1, type: 1, message: 'test', csrf: 'x' }, k.mixin);
      console.log(`签名样例: wts=${s.wts} w_rid=${String(s.w_rid).slice(0, 12)}…`);
    }
    if (has('dry')) return;
    if (!bvid || !text) {
      console.log('用法：node tools/bili-comment-api.mjs --bvid BVxxx --text "评论正文" [--dry]');
      return;
    }
    const r = await postComment({ bvid, text, cookieFile });
    console.log('结果:', JSON.stringify(r).slice(0, 400));
  })().catch((e) => console.error('出错:', e.message));
}
