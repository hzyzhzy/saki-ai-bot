/**
 * 「回复自己说说下面的评论」（2026-09-28 加，用户要求）。
 *
 * ## 为什么自己拼 HTTP（不依赖协议端）
 *
 * QQ空间这套**不属于 OneBot 11 标准**。当前协议端是 SnowLuma，它暴露的空间能力是：
 * `get_qzone_msg_list`（**只给评论数量 `comment_num`，不给评论内容**）、
 * `get_qzone_feeds`、`send_qzone_msg`、`like_qzone`…
 * 而"发评论"的那个函数（`commentQzoneMsg`）**是它内部的，没有挂成 action**
 * （2026-09-28 在它的打包产物里确认过）。
 *
 * ⇒ 只能走 `qzone-http.js` 那条路：拿 `get_cookies` 给的 cookie，自己按 QZone
 *    网页接口读写。**风险和"发说说"完全一样**，见 `qzone-http.js` 顶部那三条
 *    （风控 / 接口未公开 / 长期维护负担）。出问题就 `qzone.comment.enable: false`。
 *
 * ## 两个接口（2026-09-28 都实测验证过）
 *
 * · **读**：`user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6`
 *   ⚠️ 必须走 **`user.qzone.qq.com`** 这条路由 —— `h5.qzone.qq.com` 那条返回
 *      `code=-2 对不起，系统繁忙`（实测）。响应是 **jsonp**（`_Callback({...})`），要剥壳。
 *   ⚠️ 要带 `replynum=100` 才会返回 `commentlist`（否则只有 `cmtnum` 数量）。
 * · **写**：`h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds`
 *   参数照 SnowLuma 内部 `commentQzoneMsg()` 抄的，其中
 *   **`topicId` 必须是 `${hostUin}_${tid}__1`** —— 格式错了发不出去。
 *   ⚠️ 响应**不给 `comment_id`**（实测 `commentid` 是空的）⇒ 去重只能靠
 *      "说说 tid + 评论者 uin + 评论时间"。
 *
 * ## ⚠️ 它是"在说说下发一条新评论"，不是嵌套回复
 *
 * QQ空间这个接口做的是 `re_feeds`（回复动态），**没法指定"回复哪一条评论"**。
 * 所以效果是：她在自己的说说下面**多发一条评论**，正文里点名。
 * 这符合用户的预期（"回复评论"在空间里的可见效果就是这个）。
 *
 * ## 规矩（用户 2026-09-28 定）
 *
 * · 只回**最近 3 天**的说说（`days`）—— 不翻旧账
 * · **每条评论只回一次**（按上面的 key 落盘去重）
 * · **每天最多 5 条**（`maxPerDay`）
 * · 自己的评论不回、已知机器人的评论不回（免得两个机器人互相客套）
 *
 * ## 落盘
 *
 * `state/qzone-comment.json`：`{ replied: { "<key>": at }, date, count }`。
 * ⚠️ **必须落盘**：不然重启一次"今天已回几条"就归零、去重也失效 ⇒ 同一条评论
 *    会被反复回复（`qzone.js` 的计数就踩过这个坑，见那里的注释）。
 * ⚠️ 路径可用 `QQBOT_QZONE_COMMENT_FILE` 覆盖（给测试用，和 `QQBOT_QZONE_FILE` 一个套路）。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, config } from './config.js';
import { log } from './log.js';
import { gtkFromCookies } from './qzone-http.js';
import * as llm from './llm.js';
import * as persona from './persona.js';

const STATE_FILE = process.env.QQBOT_QZONE_COMMENT_FILE
  ? join(ROOT, process.env.QQBOT_QZONE_COMMENT_FILE)
  : join(ROOT, 'state', 'qzone-comment.json');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/** 读评论走这条路由（`h5.` 那条实测 `code=-2` 系统繁忙） */
const MSGLIST_URL =
  'https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6';
/** 发评论走这条（参数照 SnowLuma 的 `commentQzoneMsg()`） */
const COMMENT_URL =
  'https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds';

/** key -> 回复时间（去重用） */
let replied = new Map();
/** 今天回了几条 */
let today = { date: '', count: 0 };

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function save() {
  try {
    mkdirSync(join(ROOT, 'state'), { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify(
        {
          date: today.date,
          count: today.count,
          // ⚠️ 只留最近 500 条 —— 这个文件不该无限长
          replied: Object.fromEntries([...replied.entries()].slice(-500)),
        },
        null,
        2,
      ),
      'utf8',
    );
    renameSync(tmp, STATE_FILE);
  } catch (e) {
    log.debug(`[空间评论] 状态落盘失败：${e.message}`);
  }
}

export function load() {
  try {
    if (!existsSync(STATE_FILE)) return;
    const j = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    const d = todayStr();
    today = j.date === d ? { date: d, count: Number(j.count) || 0 } : { date: d, count: 0 };
    replied = new Map(
      Object.entries(j.replied ?? {}).filter(([k, v]) => k && Number.isFinite(Number(v))),
    );
    if (replied.size) log.debug(`[空间评论] 已载入 ${replied.size} 条"回过的评论"记录`);
  } catch (e) {
    log.debug(`[空间评论] 读状态失败（当作空的）：${e.message}`);
    replied = new Map();
  }
}

function rollDay() {
  const d = todayStr();
  if (today.date !== d) {
    today = { date: d, count: 0 };
    save();
  }
}

/** 配置（都给了默认值，config.yml 不写也能跑） */
function cfg() {
  const c = config.qzone?.comment ?? {};
  return {
    enable: c.enable !== false,
    intervalMs: Math.max(60000, Number(c.intervalMs) || 10 * 60 * 1000),
    days: Math.max(1, Number(c.days) || 3),
    maxPerDay: Math.max(1, Number(c.maxPerDay) || 5),
    maxPerCheck: Math.max(1, Number(c.maxPerCheck) || 2),
  };
}

/** jsonp 剥壳（响应是 `_Callback({...})`，不是纯 JSON） */
export function unwrapJsonp(text) {
  const t = String(text ?? '').trim();
  try {
    return JSON.parse(t);
  } catch {
    /* 不是纯 JSON，继续剥 */
  }
  const m = /^[^(]*\(([\s\S]*)\)[;\s]*$/.exec(t);
  if (m) {
    try {
      return JSON.parse(m[1]);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 拉自己的说说（含评论）。**只读**。
 *
 * @returns {Promise<Array<{tid:string, content:string, at:number, comments:Array<{uin:string,name:string,content:string,at:number}>}>>}
 */
export async function fetchMsgList({ cookies, uin, num = 20 }) {
  const gtk = gtkFromCookies(cookies);
  if (!gtk) throw new Error('cookies 里没有 p_skey，算不出 g_tk');
  const url =
    `${MSGLIST_URL}?` +
    new URLSearchParams({
      uin: String(uin),
      ftype: '0',
      sort: '0',
      pos: '0',
      num: String(num),
      // ⚠️ 少了这个就只有 cmtnum、没有 commentlist
      replynum: '100',
      g_tk: String(gtk),
      format: 'json',
      need_private_comment: '1',
    }).toString();
  const res = await fetch(url, {
    headers: {
      Cookie: cookies,
      Referer: `https://user.qzone.qq.com/${uin}`,
      'User-Agent': UA,
    },
  });
  const j = unwrapJsonp(await res.text());
  if (!j) throw new Error('说说列表不是可解析的 JSON/jsonp');
  if (Number(j.code) !== 0) {
    throw new Error(`说说列表 code=${j.code} ${j.message ?? j.subcode ?? ''}`.trim());
  }
  return (j.msglist ?? []).map((e) => ({
    tid: String(e.tid ?? ''),
    content: String(e.content ?? ''),
    at: Number(e.created_time ?? 0) * 1000,
    comments: (e.commentlist ?? [])
      .filter((c) => c && String(c.content ?? '').trim())
      .map((c) => ({
        uin: String(c.uin ?? ''),
        name: String(c.name ?? '').trim(),
        content: String(c.content ?? '').trim(),
        at: Number(c.create_time ?? 0) * 1000,
      })),
  }));
}

/**
 * 在一条说说下面发评论。**会写进空间，收不回来** —— 调用前想清楚。
 *
 * @returns {Promise<boolean>} 发出去了没有（响应里没有 comment_id，只能看 code）
 */
export async function postComment({ cookies, selfUin, hostUin, tid, content }) {
  const gtk = gtkFromCookies(cookies);
  if (!gtk) throw new Error('cookies 里没有 p_skey，算不出 g_tk');
  const text = String(content ?? '').trim();
  if (!text) throw new Error('评论内容不能为空');
  const body = new URLSearchParams({
    qzreferrer: `https://user.qzone.qq.com/${selfUin}`,
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    hostUin: String(hostUin),
    format: 'json',
    ref: 'feeds',
    // ⚠️⚠️ 格式必须是 `${hostUin}_${tid}__1` —— 错了发不出去（实测照 SnowLuma 抄的）
    topicId: `${hostUin}_${tid}__1`,
    feedsType: '100',
    private: '0',
    paramstr: '1',
    richtype: '',
    richval: '',
    isSignIn: '',
    uin: String(selfUin),
    content: text,
    plat: 'qzone',
    source: 'ic',
    platformid: '52',
  });
  const res = await fetch(`${COMMENT_URL}?g_tk=${gtk}`, {
    method: 'POST',
    headers: {
      Cookie: cookies,
      Referer: `https://user.qzone.qq.com/${selfUin}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
    },
    body,
  });
  const j = unwrapJsonp(await res.text());
  if (!j) throw new Error('发评论的响应不是可解析的 JSON/jsonp');
  if (Number(j.code) !== 0 || Number(j.subcode ?? 0) !== 0) {
    throw new Error(`发评论失败 code=${j.code} subcode=${j.subcode} ${j.message ?? ''}`.trim());
  }
  return true;
}

/** 是不是"已知的机器人"（它们的评论不回，免得两个机器人互相客套） */function isKnownBot(uin, name, extra) {
  const u = String(uin ?? '').trim();
  if (!u) return false;
  for (const l of [config.teach?.bots, config.ignoreBots, config.ignore?.bots]) {
    if (Array.isArray(l) && l.map(String).includes(u)) return true;
  }
  // ⚠️⚠️ 还有**一份按"名字"的**机器人名单 —— `state/ignore-bots.json`，
  //    由 bot 实例持有（`bot.js` 的 `this.ignoreBots`，见那里 `isIgnoredBotEvent`）。
  //    **它才是 `Alone゜独白ぴ（helps菜单）` 那种的真实来源**：
  //    实测 `config.teach.bots` 里只有 `2854196310`（Q群管家）和 `10000010`（小豆），
  //    **没有** `10000009` —— 只查 config 的话，重启后她会去回那个机器人的评论 ✗。
  //    ⚠️ 这里**不去读**那个文件（那是别的模块的内部状态）—— 由调用方给个回调判断。
  if (typeof extra === 'function') {
    try {
      if (extra(u, String(name ?? ''))) return true;
    } catch {
      /* 判断失败就当"不是机器人"（宁可多回一条，也别因为读不到名单整轮卡死） */
    }
  }
  return false;
}

/** 让模型用**她的口吻**写一句回复（失败返回空串 ⇒ 这条不回，宁可不回也别乱回） */
async function composeReply({ name, comment, post }) {
  const who = String(name ?? '').trim() || '有人';
  const sys = [
    llm.personaLine(),
    '',
    `你发了一条 QQ空间说说，内容是：「${String(post ?? '').slice(0, 80)}」。`,
    `现在 ${who} 在下面评论：「${String(comment ?? '').slice(0, 120)}」。`,
    '',
    '写**一句**回复（8~30 字），用你自己的口吻 —— 是空间里回朋友一句话，不是客服话术。',
    '硬要求：',
    '· 一句话，**别分条**、别写称呼前缀（不要「回复XX：」这种格式，直接说话）；',
    '· 🚫 不许有括号动作（（笑）（叹气）这类）；',
    '· 🚫 不许提"评论""回复""空间"这些词；',
    '· 可以顺着他说，也可以轻轻怼一下 —— 但你跟他熟不熟**按他这句话的语气猜**，别自来熟；',
    '· 直接输出那句话本身：不要引号、不要解释。',
  ].join('\n');
  try {
    const out = await llm.phrase({
      system: sys,
      user: '参考语气（**别照抄**）：行啊，你倒是会挑重点　／　这话我记下了，回头跟你算',
      maxTokens: 100,
      timeoutMs: 12000,
    });
    let line = String(out ?? '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/^[\s"'"'「『]+|[\s"'"'」』]+$/g, '')
      .trim();
    if (!line || line.length > 40) return '';
    if (/[（(][^）)]{0,6}[）)]\s*$/.test(line)) line = line.replace(/[（(][^）)]{0,6}[）)]\s*$/, '').trim();
    return line.slice(0, 40);
  } catch (e) {
    log.debug(`[空间评论] 生成回复失败：${e.message}`);
    return '';
  }
}

/**
 * 查一轮：把"最近几天、还没回过"的评论挑出来回掉。
 *
 * @param {{call:Function, isBot?:Function}} deps `call` = 协议端调用（`bot.call`）；
 *   `isBot(uin, name)` = 可选的"这是不是已知机器人"回调（按名字那份名单，见 `isKnownBot`）
 * @returns {Promise<{checked:number, replied:number, skipped:string}>}
 */
/**
 * 取空间 cookie —— **带缓存**（2026-09-29 加）。
 *
 * ⚠️ 为什么需要缓存（用户实测：「最近说说有人评论了但是没有回复」）：
 *    取 cookie 走的是 QQ 的 **OIDB 命令 `0x102a_1`**，而实测它会**间歇性**失败
 *    （协议端日志：`OIDB error 1006507 on 0x102a_1: 网络连接异常!`，
 *      12:22 和 12:42 两轮都挂；同一时段 `0x10c0_1`、`0xd69_0` 也一起挂）。
 *    而**评论列表**走的是普通 HTTP（`emotion_cgi_msglist_v6`），**不**失败。
 *    ⇒ 每 10 分钟都去要一次 cookie，等于每 10 分钟去撞一次那个不稳定的命令 ——
 *      一撞上就**整轮跳过**：评论明明在那儿，就是回不了 ✗
 *      （实测 `repliedTotal: 0`，而空间里有一条 11 小时前的评论一直没回）。
 *    ⇒ 缓存一小段时间，把调用频率降下来（cookie 本身的有效期比这长得多）。
 *    ⚠️ 失败时**清掉缓存**，下一轮重新取 —— 别把一份坏的用到底。
 */
let cookieCache = { value: '', at: 0 };
const COOKIE_TTL_MS = 20 * 60 * 1000;

async function getCookies(call) {
  if (cookieCache.value && Date.now() - cookieCache.at < COOKIE_TTL_MS) {
    return cookieCache.value;
  }
  const ck = await call('get_cookies', { domain: 'h5.qzone.qq.com' });
  const c = String(ck?.data?.cookies ?? '').trim();
  if (c) {
    cookieCache.value = c;
    cookieCache.at = Date.now();
  }
  return c;
}

/** 这份 cookie 看起来坏了（发了评论却不认）→ 丢掉缓存，下次重新取 */
function dropCookieCache() {
  cookieCache = { value: '', at: 0 };
}

export async function checkOnce({ call, isBot } = {}) {
  const c = cfg();
  if (!c.enable) return { checked: 0, replied: 0, skipped: '功能关了' };
  if (typeof call !== 'function') return { checked: 0, replied: 0, skipped: '没有 call' };

  rollDay();
  if (today.count >= c.maxPerDay) {
    return { checked: 0, replied: 0, skipped: `今天已经回了 ${today.count} 条（上限 ${c.maxPerDay}）` };
  }

  const selfUin = String(config.botQQ ?? '').trim();
  if (!selfUin) return { checked: 0, replied: 0, skipped: '没配 botQQ' };

  // ⚠️ 拿 cookie 失败就整轮不做（拿不到 cookie 什么都干不了）
  //    ⚠️ 2026-09-29：改走**带缓存**的 `getCookies()` —— 那个 OIDB 命令会间歇性挂，
  //       每轮都去撞它就会变成"评论在那儿却回不了"（见 `getCookies` 的注释）。
  const cookies = await getCookies(call);
  if (!cookies) return { checked: 0, replied: 0, skipped: 'get_cookies 没给东西' };

  const selfName = String(persona.selfName?.() ?? '').trim();
  const list = await fetchMsgList({ cookies, uin: selfUin, num: 20 });
  const since = Date.now() - c.days * 24 * 3600 * 1000;

  // 挑出待回复的：说说在窗口内、评论不是自己发的、不是机器人、还没回过
  const todo = [];
  for (const post of list) {
    if (!post.tid || !post.at || post.at < since) continue;
    for (const cm of post.comments) {
      if (!cm.uin || cm.uin === selfUin) continue;
      if (isKnownBot(cm.uin, cm.name, isBot)) continue;
      const key = `${post.tid}:${cm.uin}:${cm.at}`;
      if (replied.has(key)) continue;
      todo.push({ key, post, cm });
    }
  }
  if (!todo.length) return { checked: list.length, replied: 0, skipped: '没有要回的' };

  let n = 0;
  for (const t of todo) {
    if (today.count >= c.maxPerDay) break;
    if (n >= c.maxPerCheck) break; // 一轮别回太多，免得像刷屏
    const line = await composeReply({
      name: t.cm.name,
      comment: t.cm.content,
      post: t.post.content,
    });
    if (!line) {
      log.debug(`[空间评论] 这条没生成出回复，跳过：${t.cm.content.slice(0, 20)}`);
      continue;
    }
    try {
      await postComment({
        cookies,
        selfUin,
        hostUin: selfUin, // 自己的说说 ⇒ hostUin 就是自己
        tid: t.post.tid,
        content: line,
      });
      replied.set(t.key, Date.now());
      today.count += 1;
      save();
      n += 1;
      log.info(
        `[空间评论] 回了 ${t.cm.name}（${t.cm.content.slice(0, 16)}…）→ 「${line}」` +
          `　今天 ${today.count}/${c.maxPerDay}`,
      );
    } catch (e) {
      // ⚠️ 失败**不记状态** —— 下次还会重试（记了就永远不会再回了）
      log.warn(`[空间评论] 回复失败（不记状态，下次重试）：${e.message}`);
      // ⚠️ 2026-09-29：顺便**丢掉 cookie 缓存** —— 发评论失败多半就是这份 cookie 不认了，
      //    留着它下一轮还会拿同一份去撞。
      dropCookieCache();
      break; // 一条失败多半是接口/cookie 的问题，这一轮先停
    }
  }
  if (!selfName) log.debug('[空间评论] 人设没给 selfName（只影响日志）');
  return { checked: list.length, replied: n, skipped: '' };
}

export function status() {
  const c = cfg();
  return {
    enable: c.enable,
    days: c.days,
    maxPerDay: c.maxPerDay,
    todayCount: today.count,
    repliedTotal: replied.size,
    file: STATE_FILE,
  };
}

/** 测试用 */
export function __reset() {
  replied = new Map();
  today = { date: todayStr(), count: 0 };
  // ⚠️ cookie 缓存也要清 —— 不清的话，套件里"拿不到 cookie"那个用例
  //    会命中上一个用例缓存下来的 cookie，永远测不到那条分支。
  cookieCache = { value: '', at: 0 };
}

/** 测试用：把"今天已回几条"设成指定值（验日上限那条闸） */
export function __setTodayCount(n) {
  today = { date: todayStr(), count: Math.max(0, Number(n) || 0) };
}

load();
