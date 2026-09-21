/**
 * B站数据（2026-09-13 加）。
 *
 * 用户要求：「既然能用 B站了，可以让机器人**记下我的 B站 uid 是 30000001**，
 * 这样以后还可以询问**我的视频播放量最近怎么样**之类的信息」。
 *
 * ## ⚠️ 为什么这个文件里到处是"缓存 + 限流"
 *
 * B站的 space 接口**会限流**（实测）：
 *   · 连探几次 → `-412 request was banned`
 *   · 再探 → `-799 请求过于频繁，请稍后再试`
 *   · 等 45 秒左右才恢复
 *
 * 所以**绝不能每次问都去拉**：
 *   · 同一份数据 `cacheMs`（默认 30 分钟）内只拉一次
 *   · 拉失败时**不报错给群友**，退回"上次拉到的"（没有就说稍后再试）
 *
 * 另外有个坑：`x/space/arc/search` **加了 `platform=web` 就会 -412**，
 * 不加就正常 —— 所以这个参数千万别加。
 */
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { log } from './log.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/203.0.113.10 Safari/537.36';

/** { uid, at, name?, videos: [{title, bvid, play, danmaku, comment, created}] } */
let cache = null;
/** 上次尝试的时间（失败也要记，免得失败时被反复问就反复请求） */
let lastTry = 0;
const cfg = () => config.bilibili ?? {};
const ownerUid = () => String(cfg().ownerUid ?? '').trim();
/**
 * 被限流后的退避时长。
 *
 * ⚠️ 2026-09-14 从 **20 分钟改到 45 分钟**。
 *    实测这个接口封起来是**分钟级**的，而且**一次失败后每 20 分钟再撞一次
 *    等于持续喂它异常请求**，反而更难恢复（这就是它一直 `-412` 的原因之一 ——
 *    我排查时反复探它，越探越封）。
 *    退避久一点 + 有缓存就用缓存，比"勤快地重试"正确。
 */
const throttleMs = () => (Number(cfg().throttleMs) > 0 ? Number(cfg().throttleMs) : 45 * 60 * 1000);

/**
 * 「哪个接口被限流了，到什么时候为止」—— **按接口分开记**（2026-09-14 改）。
 *
 * ⚠️ 为什么不能只有一个全局变量（用户要求「退避按接口分开记」）：
 *    B站这几类接口的限流是**各自独立**的 —— 实测同一时刻
 *    「拉某人投稿」`-412`，而「搜视频」`search/all/v2` **照常 `code=0`**。
 *    用一个全局 `throttleUntil` 的话，**一个接口被封会把别的接口一起挡住**，
 *    表现成"B站整个用不了"——明明是两回事。
 *
 *    ⚠️ 现在只有 `space/arc` 这一个接口会写它（搜索走 `search.js`、有自己的一套），
 *      但**结构先摆对**：以后再接 B站 接口时，顺手 `bumpThrottle('别的接口')` 就行，
 *      不会再犯"一个封全封"。
 */
const throttles = new Map(); // endpoint -> 截止时间戳

/** 这个接口现在能不能打？返回 0 = 能 */
function throttledUntil(endpoint) {
  const t = Number(throttles.get(endpoint)) || 0;
  return t > Date.now() ? t : 0;
}

/** 标记某个接口被限流，退避一段时间 */
function bumpThrottle(endpoint, ms = throttleMs()) {
  throttles.set(endpoint, Date.now() + ms);
  log.warn(`B站[${endpoint}]被限流，${Math.round(ms / 60000)} 分钟内不再试这个接口`);
}

/** 本模块用到的接口名（写退避信息时统一用它） */
const EP_ARC = 'space/arc（拉某人投稿）';

/** 数字写成「3.4万」这种人读的 */
export function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
  return String(v);
}

/**
 * 拉某个 UID 的投稿列表（**带缓存**）。
 *
 * @param {string} [uid]
 * @param {{force?:boolean}} [opts]
 * @returns {Promise<{ok:boolean, cached:boolean, name?:string, videos?:Array, error?:string, ageMs?:number}>}
 */
export async function fetchUserVideos(uid = ownerUid(), opts = {}) {
  const id = String(uid ?? '').trim();
  if (!id) return { ok: false, error: '没配 UID（config.bilibili.ownerUid）' };

  const cacheMs = Number(cfg().cacheMs) > 0 ? Number(cfg().cacheMs) : 1800000;
  const now = Date.now();

  // 缓存命中
  if (!opts.force && cache && cache.uid === id && now - cache.at < cacheMs) {
    return { ok: true, cached: true, ageMs: now - cache.at, ...cache };
  }
  // ⚠️ 限流保护：**这个接口**失败过的话，这段时间内不再试它
  //    （不然被反复问会把自己问进风控）。别的接口不受影响 —— 见 `throttles` 的注释。
  const until = throttledUntil(EP_ARC);
  if (!opts.force && until) {
    if (cache && cache.uid === id) {
      log.debug('B站：还在限流退避期，先用缓存');
      return { ok: true, cached: true, stale: true, ageMs: now - cache.at, ...cache };
    }
    return { ok: false, error: `B站限流中（还要等 ${Math.ceil((until - now) / 60000)} 分钟）` };
  }

  lastTry = now;
  const timeout = Number(cfg().timeoutMs) > 0 ? Number(cfg().timeoutMs) : 15000;
  const limit = Number(cfg().limit) > 0 ? Number(cfg().limit) : 10;
  // ⚠️ 不要加 `platform=web` —— 加了必然 -412
  const url = `https://api.bilibili.com/x/space/arc/search?mid=${encodeURIComponent(id)}&ps=${limit}&pn=1&order=pubdate`;

  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Referer: `https://space.bilibili.com/${id}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) {
      // ⚠️ 412 是**限流**（不是"接口坏了"）—— 实测等两分钟都不一定恢复，
      //    所以退避久一点，别一被问就再撞一次。
      if (r.status === 412 || r.status === 429) {
        bumpThrottle(EP_ARC);
      }
      return fallback(cache, `HTTP ${r.status}`);
    }
    const j = await r.json();
    if (j?.code !== 0) {
      // -412 / -799 都是限流，属于"等一下就好"，不要当故障
      const throttled = j?.code === -412 || j?.code === -799 || j?.code === -352;
      if (throttled) bumpThrottle(EP_ARC);
      log.warn(`B站接口 code=${j?.code}（${j?.message ?? ''}）`);
      return fallback(cache, j?.message ?? `code ${j?.code}`);
    }
    const vlist = j.data?.list?.vlist ?? [];
    const videos = vlist.map((v) => ({
      title: String(v.title ?? '').trim(),
      bvid: String(v.bvid ?? ''),
      play: Number(v.play) || 0,
      danmaku: Number(v.video_review) || 0,
      created: Number(v.created) || 0,
    }));
    cache = { uid: id, at: now, total: Number(j.data?.page?.count) || videos.length, videos };
    log.info(`B站：拉到 ${id} 的 ${videos.length} 条投稿（共 ${cache.total} 个）`);
    return { ok: true, cached: false, ageMs: 0, ...cache };
  } catch (e) {
    log.warn(`B站拉投稿失败：${e.message}`);
    return fallback(cache, e.message);
  }
}

/** 拉失败：有旧数据就用旧的（标明是旧的），没有就如实说失败 */
function fallback(prev, error) {
  if (prev) return { ok: true, cached: true, stale: true, ageMs: Date.now() - prev.at, ...prev };
  return { ok: false, error };
}

/**
 * 「我最近视频播放量怎么样」—— 给模型看的**事实**。
 *
 * 用户 2026-09-13：「以后还可以询问**我的视频播放量最近怎么样**之类的信息」。
 *
 * ⚠️ 数字全部由代码算好（总播放、中位数、最近几条），**不让模型算** ——
 *    它算这种一列数字必错。
 *
 * @param {{force?:boolean}} [opts]
 * @returns {Promise<string>} 给提示词用的一段文本
 */
export async function ownerVideoFacts(opts = {}) {
  const r = await fetchUserVideos(undefined, opts);
  if (!r.ok) {
    // ⚠️⚠️ **不要把 `HTTP 412` 这种内部错误码写进事实**（2026-09-14 用户反馈）。
    //     模型是照着事实文本说话的 —— 给了 `412` 它就念
    //     「B站接口412了，拉不出来」，群友完全看不懂这是什么。
    //     这里改成一句**人话**，并把"别编数字"的要求一起给它。
    //     限流和真故障分开说：限流是"过会儿就好"，故障是"这边查不了"。
    const limited = /限流|412|799|429/.test(String(r.error ?? ''));
    return limited
      ? '（我这会儿查不了他的 B站 数据，接口暂时不让查）——就用你自己的话说"现在查不到，过会儿再问"，**别说任何数字、别提错误码**'
      : '（我这边没能拿到他的 B站 数据）——如实说"我这边没查到"，别编数字、别提错误码';
  }
  const vids = r.videos ?? [];
  if (!vids.length) return '（这个 B站 号下没有公开投稿）';

  const byNew = [...vids].sort((a, b) => b.created - a.created);
  const plays = vids.map((v) => v.play).sort((a, b) => b - a);
  const sum = plays.reduce((a, b) => a + b, 0);
  const med = plays.length ? plays[Math.floor(plays.length / 2)] : 0;
  const days = (t) => Math.round((Date.now() / 1000 - t) / 86400);

  const lines = [
    `（B站 UID ${r.uid}${r.cached ? `，数据是 ${Math.round((r.ageMs ?? 0) / 60000)} 分钟前拉的` : ''}）`,
    `· 公开投稿共 ${r.total ?? vids.length} 个`,
    `· 最近 ${vids.length} 个：总播放 ${fmtNum(sum)}，最高 ${fmtNum(plays[0])}，中位 ${fmtNum(med)}`,
    '',
    '· 最近几条（新→旧）：',
    ...byNew.slice(0, 6).map((v) => `  ${v.title}｜播放 ${fmtNum(v.play)}｜${days(v.created)} 天前`),
  ];
  return lines.join('\n');
}

/**
 * 该不该把这条消息当成"问**我的** B站 视频"。
 *
 * ⚠️ **只对服主本人有效**（这是他的号）。
 *
 * ## ⚠️⚠️ 判据必须要求"**我的**"（2026-09-14 修的真 bug）
 *
 * 用户实测（截图）：「最近 **b站** 有什么比较火的**视频**」→
 * 机器人回答「B站接口412了，拉不出来」。
 *
 * **根因**：原来的判据是「有 B站/视频 这类词」+「有 多少/最近 这类词」，
 * 两者都命中就当成"问我的投稿" —— 于是**任何聊 B站视频的话都被抓走**，
 * 去拉他的投稿（那个接口恰好被限流），
 * **而真正该走的"搜热门视频"（`search.js` 的 bilibiliSearch）压根没被执行到**。
 *
 * 现在要求一个**明确的归属信号**：
 *   · 「我的视频」「我的 B站」「我发的」「我投的」「我上传的」
 *   · 或者直接报了他的 UID
 *   · 「涨粉/掉粉/粉丝数」也算（那只能是说自己）
 *
 * ⚠️ 反例（都要**放给搜索**，不许抓走）：
 *   「b站有什么火的视频」「B站最近什么梗火」「搜一下 B站 的 XXX」
 *   「这个视频播放量多少」（问的是别的视频）
 *
 * @param {string} text
 * @param {boolean} isOwner
 * @param {string} [uid] 他的 B站 UID（写出来也算明确问自己）
 */
export function looksLikeVideoQuestion(text, isOwner, uid = '') {
  if (!isOwner || !cfg().enable) return false;
  const t = String(text ?? '').trim();
  if (!t || t.length > 50) return false;

  // ⚠️ 「报了他 UID」本身就是最强的话题信号 —— 直接算命中
  //    （「30000001 最近怎么样」这种没有"视频"两个字，但意思很明确）
  const byUid = !!uid && t.includes(String(uid));

  // ⚠️ 基础话题词：完全不提视频/B站（也没报 UID）→ 肯定不是问这个
  if (!byUid && !/(视频|投稿|播放|涨粉|掉粉|粉丝|b站|B站|哔哩|数据|流量)/i.test(t)) {
    return false;
  }

  // ⚠️⚠️ 必须带**归属**：「我」的视频
  const mine =
    /我的?(视频|投稿|b站|B站|播放|播放量|数据)/.test(t) ||
    /我(发|投|传|上传|拍)的?/.test(t) ||
    /涨粉|掉粉|粉丝数|粉丝量/.test(t) ||
    byUid;
  return !!mine;
}

/** 给管理界面/自检看 */
export function status() {
  return {
    enable: cfg().enable !== false,
    ownerUid: ownerUid(),
    cachedAt: cache ? new Date(cache.at).toISOString() : null,
    videos: cache?.videos?.length ?? 0,
    total: cache?.total ?? 0,
  };
}

/**
 * 「我的视频最近怎么样」的**润色** —— 数字照抄，口吻是她自己的。
 *
 * ⚠️ 和报账同一套铁律（`llm.phraseMoney`）：数字不许改、不许自己算。
 *    区别只是这段数据是**他 B站的视频**，不是工资。
 *
 * @param {{facts:string, asked:string}} p
 * @returns {Promise<string>} 空串 = 失败 → 调用方退回纯文本事实
 */
export async function videoReply(p = {}) {
  const facts = String(p.facts ?? '').trim();
  if (!facts) return '';
  const llm = await import('./llm.js');
  const line = await llm.phraseMoney({
    facts,
    asked: String(p.asked ?? '').slice(0, 60),
    style: '他在问自己 B站 视频的数据。照实报，可以顺口评两句（哪条高、最近是不是凉了）。',
    maxLines: 3,
    maxTokens: 300,
    extraRules: [
      '· ⚠️ **数字照抄**（播放量、天数、条数），**不要自己算、不要四舍五入**',
      '· 这是**他**发的视频（提一下"你那条…"），不是你的',
      '· 可以有点看法（"这条涨得还行""最近好像没什么动静"），但别替他做决定',
      '· 别把清单整个念一遍 —— 挑一两条说',
    ],
  });
  // 兜底：模型没给出内容就给纯文本事实（宁可死板也不能不给数据）
  return line || facts;
}

// ─────────────────────────────────────────────────────────────
// 「B站最近有什么火的视频」——**真去拉热门榜**
// ─────────────────────────────────────────────────────────────
//
// ⚠️ 2026-09-15 <主人> 截图反馈：问「b站最近有什么火的视频」，她答
//    「搜了一圈全是百科页，热榜没抓着。**你直接上 B 站翻排行榜不就完了**」——
//    既没答案、又是打发人的口气。
//
//    根因：以前**没有**"拉热门榜"这条能力，这类问题被丢给网页搜索
//    （`bilibili-scope` 测试里写的就是"不抓走，交给搜索"），
//    而搜索引擎对这句话只会返回百科词条 → 模型没有数据可报 → 只能打发人。
//
//    实测 `api.bilibili.com/x/web-interface/popular` 能直接返回热门列表
//    （标题 / UP / 播放量），而且不需要登录。所以这里补上真数据这条路。
//    ⚠️ `ranking/v2`（排行榜）实测返回 0 条（大概要 cookie），用 `popular`。

/** 「最近有什么火的视频」这类问题（**不是**问他自己投稿的那种） */
export function looksLikeHotQuestion(text) {
  return hotQuery(text) !== null;
}

/**
 * 题材词 → 拿去搜什么。第三项是可选参数：
 *   `tids`  = B站分区（17 = 单机游戏），`match` = 标题相关性正则（默认"标题含关键词"）
 * ⚠️ 认不出来的就当"某个 UP 主"处理（见 `hotQuery`）。
 */
const TOPICS = [
  [
    /(mc|minecraft|我的世界)/i,
    '我的世界',
    { tids: 17, match: /(我的世界|minecraft|\bmc\b)/i, deny: /(这是我的世界|世界上的另一个我)/ },
  ],
  [/单机/, '单机游戏', { tids: 17 }],
  [/游戏/, '游戏', { tids: 17 }],
  [/鬼畜/, '鬼畜'],
  [/动画|番剧|番/, '动画'],
  [/音乐|歌曲/, '音乐'],
  [/舞蹈|宅舞/, '舞蹈'],
  [/科技|数码/, '科技'],
  [/生活|日常|vlog/i, '生活'],
  [/美食|吃/, '美食'],
  [/影视|电影|解说/, '影视剪辑'],
];

function topicOpts(keyword) {
  const t = TOPICS.find((x) => x[1] === keyword);
  return t?.[2] ?? {};
}

/**
 * 认出「最近有什么火的视频」这类问法，并分成三种：
 *   `{mode:'all'}`              —— b站全站热门（问她"b站最近有什么火的"）
 *   `{mode:'topic', keyword}`   —— 按题材（"最近 mc 有什么火的" → 搜「我的世界」）
 *   `{mode:'up', name}`         —— 按 UP 主（"籽岷最近有什么视频"）
 *
 * ⚠️ 用户 2026-09-15 追加要求：「可以问她最近 mc 或者籽岷有什么比较火的视频吗」。
 * ⚠️ **不抢**"问他自己投稿"那种（`我的视频播放量`）—— 那是 `ownerVideoFacts` 的活。
 */
export function hotQuery(text) {
  // ⚠️⚠️ 先**把开头的 @某某 去掉**（2026-09-15 实测踩到）：
  //    QQ 里 @她时那串名字会**一起进到消息文本**里，实测她收到的是
  //      「@saki酱saki酱saki酱saki酱saki酱 Ch1hayaAnon_QWQ有什么视频」
  //    → 名字被截成 `hayaAnon_QWQ`（11 字上限卡掉一半），查了个错名字。
  //    ⚠️ 只在这个函数里洗 —— **不能**去改提示词那边的文本，
  //       否则「@<主人> 给个服世界地图。」那种"@ 的是别人"的信号就没了。
  const t = String(text ?? '')
    .trim()
    .replace(/^(?:@[^\s@]{1,40}\s*)+/, '')
    .trim();
  if (!t || t.length > 80) return null;
  if (/我的(视频|投稿)|我发的/.test(t)) return null;
  const aboutBili = /b\s*站|bilibili|哔哩|小破站/i.test(t);
  const hotish = /热榜|热门|排行|火的|最火|比较火|最近火|炸裂|精彩|什么好看|有什么好看|好玩|播放(量)?高/.test(t);
  const videoNoun = /视频|投稿|作品/.test(t);
  const fresh = /最近|近期|新(的|出)?|这两天/.test(t);
  // ⚠️ **「XX 有什么视频」也算**（2026-09-15 用户截图：
  //    「Luminiflux有什么视频」原来**没被认出来** → 走到网页搜索 → 她答
  //    「Luminiflux是谁啊，我去搜搜」＝**空头承诺**。用户要求「真的去做然后给回复」）。
  const asking = /有什么|有没有|发过|出过|的视频/.test(t);
  // ⚠️ 得听着像在问"有什么视频"。⚠️ **不要求**他提到"B站"——
  //    实测用户就是直接问「最近 mc 有什么比较火的视频」，不会先说"B站"两个字。
  if (!hotish && !(videoNoun && (fresh || asking))) return null;

  // ① 题材（"最近 mc 有什么火的" → 搜「我的世界」）
  for (const [re, kw] of TOPICS) if (re.test(t)) return { mode: 'topic', keyword: kw };
  // ② 按 UP 主：抓「XX 最近/有什么/新…」里的 XX
  //    ⚠️ 上限 12 → **20 字**：昵称经常比中文名长（实测 `Ch1hayaAnon_QWQ` 16 字，
  //       12 字上限会把它**砍掉一半**，然后拿半个名字去搜）
  const m = t.match(/([A-Za-z0-9_\u4e00-\u9fa5]{2,20}?)(?=最近|近期|有什么|有没有|有啥|新|的视频)/);
  if (
    m &&
    !/^(b站|bilibili|哔哩|小破站|这|这个|那个|哪个|什么|你|你们|他|他们|我们|大家|现在|今天|最近|近期|这两天|这里|那里|群里|游戏|视频|服务器)$/i.test(
      m[1],
    )
  ) {
    return { mode: 'up', name: m[1] };
  }
  // ③ 全站 —— ⚠️ **只有明确说了"B站/热榜/热门/排行"才当全站**，
  //    不然「最近有什么火的视频」这种太含糊，宁可不抢（交给正常聊天）。
  if (aboutBili || /热榜|热门|排行/.test(t)) return { mode: 'all' };
  return null;
}

/** 搜索接口的结果标题带 `<em class="keyword">` 高亮标签，要洗掉（顺手解码实体） */
function cleanSearchTitle(s) {
  return String(s ?? '')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * ⚠️ **必须带 `buvid3`**：实测不带时，B站搜索接口对某些参数组合直接回
 *    **`HTTP 412`**（风控，`order=pubdate` 必踩）。随便一个随机值就够用。
 */
let biliCookie = null;
function cookieHeader() {
  if (!biliCookie) {
    biliCookie = `buvid3=${randomUUID().replace(/-/g, '').toUpperCase()}infoc`;
  }
  return biliCookie;
}

/** 打一次搜索接口（原始结果，不做筛选） */
async function biliSearch({ keyword, order = 'click', tids = 0, pubtime = 0, pageSize = 30 }) {
  const kw = String(keyword ?? '').trim();
  if (!kw) throw new Error('没给关键词');
  const url =
    'https://api.bilibili.com/x/web-interface/search/type?search_type=video' +
    `&page_size=${Math.max(1, Math.min(50, pageSize))}` +
    `&keyword=${encodeURIComponent(kw)}&order=${order === 'pubdate' ? 'pubdate' : 'click'}` +
    (tids ? `&tids=${tids}` : '') +
    (pubtime ? `&pubtime=${pubtime}` : '');
  const r = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Referer: 'https://www.bilibili.com/',
      Cookie: cookieHeader(),
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`搜索 HTTP ${r.status}`);
  const j = await r.json();
  if (j?.code !== 0) throw new Error(`搜索接口 code=${j?.code} ${j?.message ?? ''}`);
  return (j?.data?.result ?? [])
    .map((v) => ({
      title: cleanSearchTitle(v.title),
      up: String(v.author ?? '').trim(),
      play: Number(v.play) || 0,
      date: Number(v.pubdate) || 0,
      url: String(v.arcurl ?? (v.bvid ? `https://www.bilibili.com/video/${v.bvid}` : '')),
    }))
    .filter((v) => v.title);
}

/**
 * 用**搜索接口**搜视频。
 *
 * ⚠️ 为什么不用"拉某人的投稿"那个 `space/arc` 接口：**它会被限流**
 *    （实测直接回 `code=-799 请求过于频繁`，而且模块自己会把那个接口封 45 分钟）。
 *    搜索接口**稳定可用**。
 */
export async function searchVideos(keyword, { limit = 8, order = 'click', tids = 0, pubtime = 0 } = {}) {
  const list = await biliSearch({ keyword, order, tids, pubtime, pageSize: Math.max(30, limit) });
  if (!list.length) throw new Error('搜不到结果');
  return list.slice(0, Math.max(1, Math.min(20, limit)));
}

/**
 * 按**题材**搜（"最近 mc 有什么火的"）。
 *
 * ⚠️ 两个实测坑：
 *   ① B站会把「我的世界」**拆词**（拆成"我的"+"世界"），结果里混进
 *      《世界上的另一个我》《这是我的世界》这种蹭字的 → **必须按标题再筛一道**；
 *   ② 加分区过滤（`tids=17` 单机游戏）干净很多，但条数会变少
 *      （实测 30 条里只剩 6 条）→ 筛完不够 4 条就**放开分区再拿一遍**。
 */
export async function topicVideos(keyword, { limit = 8, tids = 0, match = null, deny = null } = {}) {
  const kw = String(keyword ?? '').trim();
  const hit =
    typeof match === 'function'
      ? match
      : match instanceof RegExp
        ? (t) => match.test(t)
        : (t) => t.toLowerCase().includes(kw.toLowerCase());
  // ⚠️ `deny`：**蹭字的标题**（实测「我的世界」会搜出《这是我的世界》AI剧集、
  //    《世界上的另一个我》这种，光靠 match 拦不住，得点名排掉）
  const grab = async (useTids) =>
    (await biliSearch({ keyword: kw, order: 'click', tids: useTids ? tids : 0 })).filter(
      (v) => hit(v.title) && !(deny && deny.test(v.title)),
    );
  let list = tids ? await grab(true) : await grab(false);
  if (tids && list.length < 4) {
    const seen = new Set(list.map((v) => v.title));
    list = list.concat((await grab(false)).filter((v) => !seen.has(v.title)));
  }
  if (!list.length) throw new Error(`搜「${kw}」没搜到对得上的`);
  return list.slice(0, Math.max(1, Math.min(20, limit)));
}

/**
 * 某个 UP 主**最近发的**视频（"籽岷最近有什么视频"）。
 *
 * 走搜索接口、只留**作者就是本人**的那些（实测搜「籽岷」30 条里 27 条是他本人的）。
 * ⚠️ `pubtime=30` 实测能拿到最近的稿子（2026-09-13 那条只有不带它会丢），
 *    但它的口径不稳（7/180 跟不写一样）→ **两遍都拉、合起来按日期倒排**，
 *    这样"最近"的一定在前面，不够的再用他的高播放老稿补齐。
 */
export async function upVideos(name, { limit = 8 } = {}) {
  const wanted = String(name ?? '').trim();
  if (!wanted) throw new Error('没给 UP 主名');
  // ⚠️ 两遍**串行**（实测同时发两个请求，其中一个会被 B站风控掉），
  //    而且失败**要留日志** —— 不然"最近那几条丢了"谁都看不出来。
  const hot = await biliSearch({ keyword: wanted, order: 'click' }).catch((e) => {
    log.warn(`[B站] 搜「${wanted}」失败：${e.message}`);
    return [];
  });
  // ⚠️⚠️ `pubtime=30`（=按时间筛）**时灵时不灵**：实测同样的请求，
  //     有时回 20 条（含他 2026-09-13 的新稿）、有时回 30 条（pubtime 被无视，
  //     最新只到 2025-07）。**不是 cookie 的问题**（换新 cookie 也一样随机）。
  //     所以这里**不跟另一批比**（另一批自己也可能带新稿，比不出来），
  //     直接**按绝对时间判**：最近 90 天内有稿就算"拿到了最近的"。
  //     没拿到就换个 buvid3 再试，最多 3 遍；还是不行就**照实说"没拿到新稿"**。
  const RECENT_MS = 90 * 86400 * 1000;
  const newestOf = (l) => l.reduce((m, v) => Math.max(m, (v.date || 0) * 1000), 0);
  const recentEnough = (l) => newestOf(l) >= Date.now() - RECENT_MS;
  let recent = [];
  for (let i = 0; i < 3; i++) {
    const got = await biliSearch({ keyword: wanted, order: 'click', pubtime: 30 }).catch(() => []);
    recent = recent.concat(got);
    if (recentEnough(recent) || recentEnough(hot)) break;
    biliCookie = null;
  }
  const all = [...recent, ...hot];
  if (!all.length) throw new Error(`搜「${wanted}」没结果`);
  let list = all.filter((v) => v.up === wanted);
  // ⚠️ 判据是**最终名单**里有没有近 90 天的新稿（不是"某一遍请求"是否成功）
  const fresh = recentEnough(list.length ? list : all);
  if (!fresh) log.warn(`[B站] 搜「${wanted}」最近 90 天没抓到新稿，只能给高播放那批`);
  let note = '';
  if (!list.length) {
    // ⚠️⚠️ 一条本人都没搜到 → **别硬答**（别拿"别人提到他的视频"冒充）。
    //    2026-09-15 用户截图：「Luminiflux有什么视频」→ 她答「Luminiflux是谁啊，**我去搜搜**」
    //    ＝空头承诺。用户要求「**这种能不能真的去做这件事情然后给回复**」。
    //    所以这里把"没这个人"标出来，交给 `bot.js` **放行走正常搜索**（那才是真去查）。
    log.info(`[B站] 搜「${wanted}」没搜到本人的投稿 → 交给正常搜索`);
    return { name: wanted, list: [], note: '', fresh: false, noAuthor: true };
  }
  if (!fresh) {
    note = `⚠️ **没抓到他最近发的新稿**（B站这边时灵时不灵），下面是搜到的**播放量较高**的那些 —— 说的时候别提"最近刚发"。`;
  }
  const seen = new Set();
  list = list
    .filter((v) => {
      const k = v.url || v.title;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => (b.date || 0) - (a.date || 0))
    .slice(0, Math.max(1, Math.min(20, limit)));
  return { name: wanted, list, note, fresh };
}

/** 拉一次热门榜（带缓存，别把接口打爆） */
let hotCache = null;export async function hotVideos({ limit = 8, force = false } = {}) {
  const ttl = Math.max(60000, Number(config.bilibili?.hotCacheMs) || 30 * 60 * 1000);
  if (!force && hotCache && Date.now() - hotCache.at < ttl) return hotCache.list;
  const url = `https://api.bilibili.com/x/web-interface/popular?ps=${Math.max(1, Math.min(20, limit))}&pn=1`;
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      Referer: 'https://www.bilibili.com/',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`热门榜 HTTP ${r.status}`);
  const j = await r.json();
  const list = (j?.data?.list ?? []).map((v) => ({
    title: String(v.title ?? '').trim(),
    up: String(v.owner?.name ?? '').trim(),
    view: Number(v.stat?.view) || 0,
    like: Number(v.stat?.like) || 0,
    url: String(v.short_link_v2 ?? (v.bvid ? `https://www.bilibili.com/video/${v.bvid}` : '')),
  })).filter((v) => v.title);
  if (!list.length) throw new Error('热门榜返回空（接口可能要 cookie 了）');
  hotCache = { at: Date.now(), list };
  return list;
}

/**
 * ⚠️ **记住上一次报的是什么**（2026-09-15 用户截图：
 *    「这个也没有接进上文」—— 他 @ 她问了籽岷，她答完，他紧接着问
 *    「**那**最近mc圈有什么炸裂的视频」，她答得像另起一题，没接上文）。
 *
 * 这条分支走的是 `llm.phraseMoney`（**不带群聊上下文**），所以要把上一轮
 * 「他问的 + 她答的」当成事实喂给它，它才能开口接住。
 */
let lastHot = null;
export function setLastHot(ask, answer) {
  lastHot = { at: Date.now(), ask: String(ask ?? '').slice(0, 60), answer: String(answer ?? '').slice(0, 300) };
}
function prevHotLine() {
  if (!lastHot) return '';
  if (Date.now() - lastHot.at > 10 * 60 * 1000) return ''; // 超过 10 分钟就不算"接着聊"
  return (
    `（⚠️ 他**上一句**问的是「${lastHot.ask}」，你**上一句**答的是「${lastHot.answer}」——` +
    `如果这次是在接着上面问的（"那…""还有呢""别的呢"），**开头先接住上文**再报新的名单，别答得像另起一题）`
  );
}

/**
 * 把"查到的视频"做成给模型看的事实（**数字代码算好**，模型只组织说法）。
 * @param {{query?:{mode:string, keyword?:string, name?:string}, limit?:number}} p
 */
export async function hotFacts(p = {}) {
  const q = p.query ?? { mode: 'all' };
  const limit = Math.max(1, Math.min(12, Number(p.limit) || 8));
  const prev = prevHotLine();
  const day = (ts) => (ts ? new Date(ts * 1000).toLocaleDateString('zh-CN') : '');
  // ⚠️ **必须告诉它今天是几号**：实测它会把"日期"自己换算成相对时间，
  //    把两天前的稿子说成「去年9月13号的」（它的时间感是错的）。
  const today = new Date().toLocaleDateString('zh-CN');
  const head = (s) => `（系统实测数据 · 今天 ${today} · ${s}）`;
  if (q.mode === 'topic') {
    const list = await topicVideos(q.keyword, { limit, ...topicOpts(q.keyword) });
    return [
      ...(prev ? [prev] : []),
      head(`B站搜「${q.keyword}」按**播放量**排的前 ${list.length} 条`),
      ...list.map((v, i) => `· ${i + 1}. ${v.title}（UP：${v.up}，播放 ${fmtNum(v.play)}，${day(v.date)}）`),
    ].join('\n');
  }
  if (q.mode === 'up') {
    const { name, list, note, fresh, noAuthor } = await upVideos(q.name, { limit });
    // ⚠️ B站没这个人 → **抛一个带标记的错**，让 `bot.js` 放行走正常网页搜索
    //    （那才是"真的去做这件事"，而不是答一句「我去搜搜」）
    if (noAuthor) {
      const e = new Error(`B站没搜到「${name}」本人的投稿`);
      e.noAuthor = true;
      throw e;
    }
    return [
      ...(prev ? [prev] : []),
      ...(note ? [note] : []),
      head(
        `B站搜「${name}」拿到的前 ${list.length} 条，` +
          `${fresh ? '**按发布时间倒排**（最新的在前）' : '**按播放量**排的'}`,
      ),
      ...list.map((v, i) => `· ${i + 1}. ${v.title}（UP：${v.up}，播放 ${fmtNum(v.play)}，${day(v.date)}）`),
    ].join('\n');
  }
  const list = await hotVideos({ limit });
  return [
    head('B站全站热门榜，刚拉的'),
    ...list.slice(0, limit).map((v, i) => `· ${i + 1}. ${v.title}（UP：${v.up}，播放 ${fmtNum(v.view)}）`),
    `· 一共取了前 ${Math.min(limit, list.length)} 条`,
  ].join('\n');
}

/**
 * 「报热门/报某个题材或 UP 主」的说法。
 *
 * ⚠️ 这里的规矩是照着 <主人> 的反馈定的：
 *    · **必须把名单本身报出来**（至少 4-5 条）—— 他要的就是"有什么火的"，
 *      只答"你自己去看排行榜"就是没回答（真实踩过）
 *    · 🚫 别打发人、别反问"你怎么想起问这个"
 *    · 可以挑一两条顺口评一句，但别每条都评
 */
export async function hotReply(p = {}) {
  const facts = String(p.facts ?? '').trim();
  if (!facts) return '';
  const llm = await import('./llm.js');
  const isUp = p.mode === 'up';
  const line = await llm.phraseMoney({
    facts,
    asked: String(p.asked ?? 'b站最近有什么火的视频').slice(0, 60),
    style: isUp
      ? '他问的是"这个 UP 主最近发了什么"——你把搜到的最新几条念给他听，顺口挑一两条评一句。'
      : '他要的是"最近有什么火的（或者这个题材有什么火的）"——你把查到的名单念给他听，顺口挑一两条评一句。',
    maxLines: 8,
    maxTokens: 500,
    extraRules: [
      '· ⚠️⚠️ **必须真的把名单报出来**：至少念 4-5 条的名字（UP 主和日期挑着提）',
      '· 🚫 **不许打发人**（"你自己去看排行榜"这种一律不许），也**别反问他为什么问**',
      '· 🚫 数字照抄，别自己算、别四舍五入；日期也照抄',
      '· 可以挑一两条顺口评一句，但别每条都评 —— 那就成播报了',
      '· ⚠️ 只是"最近有什么"，别替人做判断（"这个必看""你该看这个"这种别说）',
      // ⚠️ 实测它会把"日期"自己换算，把两天前的稿子说成「去年9月13号」（它的时间感是错的）
      '· ⚠️ 时间**只照抄那个日期**（"9月13号"），🚫 **别自己算**"去年/上个月/几天前/刚刚"这类相对说法',
      '· 🚫 别评价人家"冷清/数据不行"（那是人家自己的事）',
      // ⚠️ 用户 2026-09-15：「这个也没有接进上文」—— 事实里带了"上一句"就必须接住
      '· ⚠️ 如果事实里带了「他上一句问的是…」，说明这是**接着问的**：' +
        '**开头先用一句话接住上文**（例：「籽岷那边就这些，mc 这边我看了下…」），🚫 别答得像另起一题',
      // ⚠️ 按名字搜会搜出**别人做的、带他名字的视频**（看"UP："那一栏），别混为一谈
      ...(isUp
        ? [
            '· ⚠️ 名单里**可能是别人做的相关视频**（看「UP：」那一栏）—— ' +
              'UP 不是本人的，就说成"别人做的/提到他的"，🚫 别硬说成是他发的',
          ]
        : []),
    ],
  });
  return line || facts;
}

/** 测试用：清缓存 */
export function __clearCache() {
  cache = null;
  lastTry = 0;
  hotCache = null;
  throttles.clear();
}
