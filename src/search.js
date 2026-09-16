/**
 * 联网搜索（免费方案）。
 *
 * 为什么不用正规搜索 API：
 *   实测这台机器的网络环境下，Brave / DuckDuckGo / 维基百科 **全部连不上**（超时），
 *   只有 Bing 和百度能通。所以走 Bing 的搜索结果页解析，零成本、不用注册。
 *
 * ⚠️ 这是「抓页面」而不是官方 API，有两个已知风险：
 *   1. Bing 改版会导致解析失效 —— 所以解析失败要**安静降级**，不能崩、不能编
 *   2. 抓取有频率限制，可能被临时拒绝 —— 所以要有冷却和超时
 *   真不能用了就换 Tavily（1000 次/月免费），换的时候只要改这个文件。
 */
import { config } from './config.js';
// 重新导出，方便 bot.js 只 import 一个模块
export { planSearch } from './search-plan.js';
import { log } from './log.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 上一次请求的时间，用来限速 */
let lastAt = 0;
/** 连续失败次数，失败太多就暂时不搜了（避免一直撞墙） */
let failStreak = 0;
let blockedUntil = 0;

const MIN_GAP_MS = 2000;
const MAX_FAILS = 3;
const BLOCK_MS = 10 * 60 * 1000;

/** HTML 实体解码 + 去标签 */
function clean(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;|&emsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析 Bing 结果页。导出是为了能单测。
 * @param {string} html
 * @param {number} limit
 * @returns {Array<{title:string, url:string, snippet:string}>}
 */
export function parseBing(html, limit = 5) {
  const out = [];
  // 每条结果是一个 <li class="b_algo">...</li>
  const blocks = String(html).split(/<li class="b_algo"/).slice(1);
  for (const b of blocks) {
    const titleMatch = b.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    const snippetMatch = b.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    if (!titleMatch) continue;

    const url = titleMatch[1];
    const title = clean(titleMatch[2]);
    const snippet = clean(snippetMatch?.[1]);
    if (!title || !url) continue;
    // 跳过 Bing 自己的跳转和广告
    if (/bing\.com\/aclk|go\.microsoft\.com/.test(url)) continue;

    out.push({ title, url, snippet });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 解析 DuckDuckGo（html 版）结果页。
 *
 * ⚠️ 和 Bing 的结构完全不同：
 *   · 结果链接是 `//duckduckgo.com/l/?uddg=<URL编码的真实地址>&rut=...`
 *     —— 必须把 `uddg` 解出来还原成真实 URL（不然读页面会用跳转地址）
 *   · 标题在 `<a class="result__a">`，摘要在 `<a class="result__snippet">`
 *
 * 为什么加它（2026-09-12 实测）：同一个查询「公共厕所 是什么梗」，
 *   · Bing        → ❌ 公共 - Wikipedia / 高校公民科的新科目「公共」
 *   · DuckDuckGo  → ✅「【白给梗科普】我家变公共厕所是什么梗？」- 哔哩哔哩
 * 两个引擎各有盲区，互相对照命中率明显更高。
 *
 * @param {string} html
 * @param {number} limit
 */
export function parseDDG(html, limit = 5) {
  const out = [];
  const src = String(html ?? '');
  // 每条结果：<a class="result__a" href="...">标题</a> … <a class="result__snippet">摘要</a>
  const re =
    /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="result__a"|$)/g;
  let m;
  while ((m = re.exec(src))) {
    const rawUrl = m[1];
    const title = clean(m[2]);
    // 摘要在这一块的 result__snippet 里
    const sn = m[3].match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const snippet = clean(sn?.[1]);
    if (!title) continue;

    // 还原真实 URL
    let url = rawUrl;
    const u = rawUrl.match(/[?&]uddg=([^&]+)/);
    if (u) {
      try {
        url = decodeURIComponent(u[1]);
      } catch {
        /* 解不出来就用原地址 */
      }
    } else if (rawUrl.startsWith('//')) {
      url = 'https:' + rawUrl;
    }
    if (!/^https?:\/\//.test(url)) continue;
    // 跳过 DDG 自己的页面
    if (/duckduckgo\.com/.test(url)) continue;

    out.push({ title, url, snippet });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 把一句口语问句「洗」成适合搜索的关键词。
 *
 * ⚠️ 为什么需要：直接拿原句去搜效果极差。
 *    实测「你不是说你要回头补剧情吗，你现在知道剧情了吗」当搜索词 → 一条相关结果都没有。
 *    （真实踩过）
 */
export function toQuery(text) {
  let q = String(text ?? '').trim();
  if (!q) return '';

  // ① 去掉呼语、人称、客套
  q = q
    .replace(/^(你|您|小祥|客服小祥)[，,、\s]*/g, '')
    .replace(/^(请问|麻烦|帮我|能不能|可不可以|想问下|问一下)/g, '')
    .replace(/你?(看过|看过没|看过吗|有没有看过|在追吗?|知道吗|听说过吗|懂吗|会吗)/g, '')
    .replace(/(谢谢你?|多谢|辛苦了?)/g, '')
    .trim();

  // ② 去掉疑问尾巴
  q = q
    .replace(/(吗|呢|么|吧|啊|呀|哦|嘛)[？?！!。，,]*$/g, '')
    .replace(/[？?！!。；;]+$/g, '')
    .trim();

  // ③ 去掉口语填充（这些词只会让搜索变差）
  q = q
    .replace(/(你不是说|你不是|我说的是|我是说|就是说|那个|这个|现在|刚才|刚刚|然后|所以|但是|其实|反正|到底|究竟|到底|究竟)/g, ' ')
    .replace(/(回头|回头去|去补|补一下|补补|补完|了解一下|了解下|讲讲|说说|聊聊)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // ④ 太长的话截断（Bing 对长查询效果差）
  if (q.length > 40) q = q.slice(0, 40).trim();

  return q;
}

/**
 * 过滤掉跟查询无关的结果。
 *
 * ⚠️ 这里要**宽松**，不能严。
 *    曾经用 2 字切片匹配、一条不沾就全删 —— 结果整句当查询时 5 条全被删，
 *    搜索形同虚设（真实踩过）。现在的策略：
 *      - 只在查询较短（像关键词）时才启用过滤
 *      - 用 2 字以上的片段，命中任意一个就算相关
 *      - 大多数情况下干脆不过滤（有结果总比没结果好）
 */
export function filterRelevant(query, results) {
  const q = String(query ?? '').trim();
  if (!q) return results;

  // 查询太长（说明是整句话，不是关键词）→ 不做相关性判断，
  // 因为按句子切片必然误杀
  if (q.length > 16) return results;

  // ⚠️ 2026-09-12 踩的坑：原来只用 **2 字切片**做"任意命中"，
  //    而「误闯天家」的 2 字切片里有个「误的」——
  //    于是搜「误闯天家 梗 出处 什么意思」时，
  //    结果里的**「误的意思_误的解释-汉语国学」**沾了「误的」两个字就**被判定为相关**，
  //    字典条目全留下来了，机器人拿着字典回「我拿不准」（用户反馈）。
  //
  //    所以分强/弱两级：
  //      · **强命中**：3 字以上连续片段（不太可能是巧合）
  //      · **弱命中**：2 字片段，**并且**要有 2 个以上不同的弱命中才算
  //
  // ⚠️⚠️ 2026-09-13 改：**不再"不相关就扔掉"，改成"打分 + 保留更多"**。
  //
  //    用户要求：「搜索拆词时拆开之后的组合可以多留几个，不一定就用一个组合搜索，
  //    **然后把最符合的内容整合就行了**」——重点在"整合"，
  //    而原来是一刀切（不够强就丢），拆出来的组合**互相补充的材料全被扔了**。
  //
  //    现在：**强/弱命中的都留着**，只是强命中排前面、弱命中排后面。
  //    真正明显无关的（挑战页、导航页）在上一步 `isJunkResult` 已经滤掉了，
  //    剩下的交给模型判断 —— 它比正则更会看"这条到底有没有用"。
  const strong = new Set();
  const weak = new Set();
  const cjk = q.match(/[\u4e00-\u9fa5]+/g) ?? [];
  for (const seg of cjk) {
    for (let n = 3; n <= Math.min(4, seg.length); n++) {
      for (let i = 0; i + n <= seg.length; i++) strong.add(seg.slice(i, i + n));
    }
    if (seg.length >= 2) {
      for (let i = 0; i + 2 <= seg.length; i++) weak.add(seg.slice(i, i + 2));
    }
  }
  for (const w of q.match(/[A-Za-z0-9]{2,}/g) ?? []) strong.add(w.toLowerCase());
  if (!strong.size && !weak.size) return results;

  const scored = results.map((r, idx) => {
    const hay = `${r.title} ${r.snippet}`.toLowerCase();
    let score = 0;
    // 强命中：每命中一个加分（3 字以上不太可能是巧合）
    for (const t of strong) if (hay.includes(t)) score += 3;
    // 弱命中：2 字片段，每个加 1
    for (const t of weak) if (hay.includes(t)) score += 1;
    // 完全没命中的保留但排最后（模型可能正需要它，别直接扔）
    return { r, score, idx };
  });

  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  const keptStrong = scored.filter((x) => x.score >= 3);
  // ⚠️ 有强命中就只给强的（它们是明确的），否则全留着让模型挑
  const out = keptStrong.length ? keptStrong : scored;
  log.debug(
    `相关性：${results.length} 条 → 强命中 ${keptStrong.length} 条` +
      (keptStrong.length ? '' : '（没有强命中，全保留让模型判断）'),
  );
  return out.map((x) => x.r);
}

/**
 * 把「误闯天家 梗 出处 什么意思」这种**堆了一串通用词**的查询洗干净。
 *
 * 为什么需要（2026-09-12 实测）：Bing 对「误闯天家 梗 出处 什么意思」返回的全是
 * **「误」字的字典条目**；而单独搜「误闯天家」第一条就是百度百科的
 * 「误闯天家（网络流行词）」—— **多加的那几个通用词把结果带偏了**。
 *
 * 所以搜出垃圾时，用它降级重试。
 */
export function simplifyQuery(query) {
  const generic =
    /(是什么梗|什么梗|梗的?出处|出处|什么意思|啥意思|是什么|是啥|含义|来源|由来|介绍|科普|百度百科)/g;
  let s = String(query ?? '').replace(generic, ' ').replace(/\s+/g, ' ').trim();
  // 全被洗掉就退回原查询（别把查询弄成空的）
  return s || String(query ?? '').trim();
}

/**
 * 从查询里挑出**实体** —— 那才是"结果里应该出现的东西"。
 *
 * ⚠️ 2026-09-12 踩的坑：一开始写成"挑最长的中文段"，
 *    结果查询「竹知了 是什么梗 出处」里 **「是什么梗」有 4 个字，比「竹知了」的 3 个字还长**，
 *    于是实体被认成「是什么梗」，整条降级重搜链全跑偏
 *    （日志：「搜偏了（「是什么梗」没出现在结果里）→ 换成「"是什么梗"」」）。
 *
 *    所以：**先把疑问词 / 通用词滤掉，再从剩下的里挑最长的**。
 */
export function entityOf(query) {
  const q = String(query ?? '');
  // 通用词 / 疑问词 / 语气词 —— 这些不是实体，先去掉
  const noise =
    /(是什么梗|什么梗|是啥梗|什么|是啥|啥|是什么|是什么意思|什么意思|梗的?出处|出处|来源|由来|含义|意思|怎么|如何|为什么|为啥|哪里|哪个|谁|介绍|科普|百度百科|一下|回事)/g;
  const cleaned = q.replace(noise, ' ');
  const segs = cleaned.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  if (!segs.length) {
    // 洗完什么都不剩（比如查询就是「是什么梗」）→ 退回原查询里最长的段
    const raw = q.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
    if (!raw.length) return '';
    return raw.sort((a, b) => b.length - a.length)[0];
  }
  return segs.sort((a, b) => b.length - a.length)[0];
}

/** 给查询里的实体加引号，强制搜索引擎**整词精确匹配** */
export function quoteEntity(query) {
  const q = String(query ?? '').trim();
  if (!q) return q;
  if (q.includes('"')) return q; // 已经引过了
  const e = entityOf(q);
  if (!e) return q;
  return q.replace(e, `"${e}"`);
}

/**
 * 给查询**补上"评测/实测"这类意图词**，用来找真正有用的对比内容。
 *
 * ⚠️ 为什么需要（2026-09-12 实测）：群里问「华为折叠屏和苹果哪个好」，
 *    搜出来全是**华为商城 / 华为官网 / 消费者业务官网** —— 厂商自吹的东西，
 *    没有任何参考价值。机器人于是只能回「翻出来全是官方通稿和软文，我不给你转」
 *    （用户截图反馈）。
 *
 *    但同时实测：搜「**折叠屏手机 实测 缺点**」就能拿到
 *    「2026年各品牌折叠屏手机对比（9月份更新）」这种真有用的文章。
 *
 *    **差别只在意图词** —— 搜索引擎不知道你想看真实评价还是看广告。
 */
export function withReviewIntent(query) {
  const q = String(query ?? '').trim();
  if (!q) return q;
  // 已经有评测类词了就别加
  if (/(实测|测评|评测|体验|缺点|避坑|上手|对比|值不值|值得买|用户反馈)/.test(q)) return q;
  return `${q} 实测 缺点 对比`;
}

/**
 * 结果里**到底有没有出现这个实体**。
 *
 * ⚠️ 这是判断「搜偏了没有」的核心判据（2026-09-12 实验得出）：
 *    不加引号时 Bing 会把「竹知了」拆成「竹」，
 *    于是返回「竹（禾本科竹亚科植物）_百度百科」这种完全无关的词条。
 *    标题里根本没有「竹知了」三个字 —— 一眼就能判出来。
 *
 * ⚠️⚠️ 但只看「标题或摘要里有没有这几个字」**会被绕过**（2026-09-12 踩过）：
 *    反爬挑战页（Google / Microsoft / YouTube 那种）的正文里碰巧带着各种词，
 *    于是「误闯天家」的搜索结果变成了「Google / Google Translate / Chrome」，
 *    而且**判据认为命中了**。所以现在收严两级：
 *      ① 实体必须出现在**标题**里（摘要里出现不算）
 *      ② 标题命中还不够 —— 还要**没被识别成挑战页/导航页**
 */
export function resultsMentionEntity(results, entity) {
  const e = String(entity ?? '').trim().toLowerCase();
  if (!e) return false;
  return (results ?? []).some((r) => {
    const title = String(r.title ?? '').toLowerCase();
    if (!title.includes(e)) return false;
    // 挑战页 / 纯导航页的特征域名 —— 这些页面出现在结果里基本都说明拿到了反爬页
    if (isJunkResult(r)) return false;
    return true;
  });
}

/**
 * 查维基百科中文（MediaWiki API）。
 *
 * ⚠️ 为什么加它（2026-09-12 实测）：**Bing 对中文梗的覆盖很差** ——
 *    搜「误闯天家 梗 出处」时 Bing 返回 10 个结果块，
 *    内容却是「半个方括号怎么打」「塑料分类」「长征十号乙」——**完全无关**，
 *    而且它**不返回空**，就是吐一堆随机内容（比没结果更糟）。
 *
 *    而维基百科的 API **返回结构化 JSON、没有反爬、不会返回垃圾**：
 *      「竹知了」  → ✅ 華為竹知了事件
 *      「公共厕所」→ ✅ 公共廁所 / 公共廁所 (隱語)   ←「隱語」就是俚语/梗义
 *      「华为 折叠屏」→ ✅ 可摺疊式智能手機 / 华为Pura X / 华为Mate X3
 *
 * ⚠️ 它对**网络梗**的覆盖不完美（「误闯天家」返回的是同名电影），
 *    所以只当**补充源**，不当主源 —— 搜不到就静默跳过。
 *
 * @param {string} query
 * @param {number} limit
 * @returns {Promise<Array<{title:string, url:string, snippet:string, from:string}>>}
 */
export async function wikiSearch(query, limit = 3) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const api =
    'https://zh.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=' +
    Math.max(1, Math.min(5, limit)) +
    '&srsearch=' +
    encodeURIComponent(q);
  try {
    const r = await fetch(api, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(config.search?.timeoutMs ?? 15000),
    });
    if (!r.ok) return [];
    const j = await r.json();
    const hits = j?.query?.search ?? [];
    return hits.map((h) => ({
      title: String(h.title ?? ''),
      url: 'https://zh.wikipedia.org/wiki/' + encodeURIComponent(String(h.title ?? '')),
      // 摘要把 HTML 标签去掉（API 返回的是带 <span> 的片段）
      snippet: String(h.snippet ?? '')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
      from: 'wiki',
    }));
  } catch (e) {
    log.debug(`维基搜索失败：${e.message}`);
    return [];
  }
}

/**
 * 拉维基词条的正文摘要（给模型当材料用）。
 * @param {string} title 词条名
 */
export async function wikiExtract(title) {
  const t = String(title ?? '').trim();
  if (!t) return '';
  const api =
    'https://zh.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(t.replace(/ /g, '_'));
  try {
    const r = await fetch(api, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(config.search?.timeoutMs ?? 15000),
    });
    if (!r.ok) return '';
    const j = await r.json();
    return String(j?.extract ?? '').trim().slice(0, 1500);
  } catch {
    return '';
  }
}

/**
 * 这条结果看起来是不是**反爬挑战页 / 导航页**（而不是真结果）。
 *
 * 真实踩过：DuckDuckGo 返回 202 + 挑战页时，解析出来的"结果"是
 * 「Google」「Google Translate」「YouTube Music」「Walmart Stores Near Me」
 * 「Contact Us - Microsoft Support」—— 这些**不是搜索结果**，
 * 喂给模型会让它当真（比搜不到更糟）。
 */
export function isJunkResult(r) {
  const url = String(r?.url ?? '');
  const title = String(r?.title ?? '').trim();
  // 极短标题 = 导航链接，不像文章标题
  if (title.length <= 3) return true;
  // 大厂首页 / 导航页
  if (
    /^https?:\/\/(www\.)?(google|youtube|microsoft|apple|bing|duckduckgo|walmart|amazon)\./i.test(
      url,
    )
  ) {
    return true;
  }
  if (/^(google|google translate|google chrome|youtube|youtube music|microsoft|walmart|amazon)/i.test(title)) {
    return true;
  }
  return false;
}

/**
 * 这是在聊某部**作品**（动漫/游戏/乐队/番剧）吗？
 *
 * 用户要求（2026-09-11）：
 *   「我希望他已经看过了，并且直接去网上搜索剧情，这样才能在群里讨论内容」
 * 所以只要话题落在某个作品上，就联网查一下，让它能像看过一样参与讨论，
 * 而不是每次都说「我没看过，考我剧情就是难为我」。
 */
export function looksLikeMediaTalk(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 100) return false;

  // 明确在问剧情/内容/角色
  const askContent =
    /剧情|讲了什么|讲了啥|说的是什么|内容是什么|结局|主角是谁|谁是主角|有什么角色|人物|好看吗|好看么|怎么样|评价|口碑|第.季|第.集|多少集|什么时候播|播出|上映|完结|更新到|出到哪/;
  // 提到作品相关的东西
  const mediaWord =
    /动漫|番剧|新番|动画|漫画|轻小说|游戏|乐队|企划|偶像|漫画|剧场版|OVA|同人|声优|角色|二次元|追番|看过|看过没|看过吗|在追/;

  if (askContent.test(t) || mediaWord.test(t)) {
    // 但别把服务器话题卷进来
    if (/服务器|整合包|模组|存档|白名单|报错|进不去|op|管理员/i.test(t)) return false;
    return true;
  }
  return false;
}

/** 明确的内部/闲聊消息 —— 连问模型都不用问，肯定不用联网 */
export function looksInternal(t) {
  const s = String(t ?? '').trim();
  if (!s) return true;
  // 指令（⚠️ 别用 ^ 锚定 —— 消息前面常带 `@ZYHG `，锚定会漏判，踩过）
  if (/(清空对话|你学到了什么|忘记[:：]|记住[:：])/.test(s)) return true;
  // 纯情绪
  if (looksLikeEmotionOnly(s)) return true;
  // 纯寒暄
  if (looksLikePureChat(s)) return true;
  // 纯标点 / 符号 / 空白 —— **与长度无关，先判**。
  // ⚠️ 别把这条放进下面的 `s.length <= 5 && !/[？?]/` 里：
  //    「？？？」正好含问号，会被那个条件挡在外面，然后一路走到
  //    "交给模型判断"（实测踩过，白花一次调用）。
  if (
    /^[ \t\n\r!-\/:-@\[-\x60{-~\u3000\u2026\u2014\u2018\u2019\u201c\u201d\u3001\u3002\uff01\uff1f\uff0c\uff1b\uff1a\uff08\uff09\u3010\u3011\uff5e\u00b7\uff0e]+$/.test(
      s,
    )
  ) {
    return true;
  }

  // 极短（没有事实可查）
  //
  // ⚠️⚠️ 这里踩过大坑（2026-09-12）：原来只要是 ≤5 字就直接跳过搜索，
  //    结果**「误闯天家」这种四字梗/歌名/作品名全被误杀** ——
  //    群里有人说「误闯天家」，机器人判成"内部话题"，压根没去搜，
  //    回了一句「什么梗，没跟上」（用户反馈）。
  //    「误闯天家」是《辞·九门回忆》的歌词，现在是热梗 —— 本来该搜到的。
  //
  //    所以：**只排除明显的废话**，其余短句**交给模型去判断**
  //    （模型知道"四字词可能是梗"，规则不知道）。
  //    宁可多花一次判断，也别在群友玩梗的时候装死。
  if (s.length <= 5 && !/[？?]/.test(s)) {
    const noiseOnly =
      // 全是同一个字反复（哈哈哈 / 草草草 / 啊啊啊）
      /^(.)\1+$/.test(s) ||
      // 明确的语气词 / 废话（白名单 —— 宁可少列，让模型兜底）
      /^(笑死|笑不活了?|好家伙|好活|牛|牛啊|牛哇|牛逼|绝了|寄了?|离谱|草|卧槽|我靠|啊这|这|嗯|哦|额|呃|哈|唉|呜|喵|为啥|真的假的|是吗|好吧|行吧|可以|不错|厉害|强|太强了|好耶|好唉|彳亍|乐|典)[了啊呀吧呢吗哈嘛哦哟么的]*$/i.test(
        s,
      );
    if (noiseOnly) return true;
    // 剩下的（可能是梗 / 歌名 / 作品名 / 游戏名）→ 交给模型判断
  }
  // 明显的服务器操作动作（「把群回复关掉」「重启一下」这种）
  if (
    /(关掉|关闭|打开|开启|重启|重置|改一下|调一下|设置成|换成|别|不要|取消)/.test(s) &&
    /(回复|开关|配置|白名单|机器人|功能|通知|提醒|这个|那个|群)/.test(s)
  )
    return true;
  return false;
}

/**
 * 这是在问「图里是谁 / 这是什么作品 / 出自哪里」吗？
 *
 * 这类问题**必须联网**：本地知识库不可能收录所有作品，
 * 硬答就会像「粉发少女 → 长崎素世」那样编错（真实踩过）。
 */
export function looksLikeIdentify(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 80) return false;
  return /这里面有谁|里面有谁|这是谁|这是谁啊|这是什么(角色|人物|作品|动漫|番)|出自哪|哪部(作品|动漫|番)|(什么|啥|哪个)(作品|动漫|番|角色|人物)|认识(这个|她|他)吗|认得出|这是哪个角色|谁啊这/.test(
    t,
  );
}

/** 常见口语词，从查询里剔掉它们才能拿到「实词」 */
const FILLER =
  /^(看过|看过没|看过吗|知道|知道吗|听说|有没有|是不是|什么|怎么|为什么|哪里|哪个|多少|介绍|讲讲|说说|聊聊|了解|一下|这个|那个|现在|最近|剧情|内容|意思|好看|评价|推荐)$/;

/** 从查询里抽出「实词」（用来判断结果相不相关、以及重试时换词） */
export function keywords(query) {
  const q = String(query ?? '');
  const out = [];
  // 英文/数字整词
  for (const w of q.match(/[A-Za-z][A-Za-z0-9]{1,}/g) ?? []) out.push(w);
  // 中文连续段
  for (const seg of q.match(/[\u4e00-\u9fa5]+/g) ?? []) {
    if (seg.length <= 4) {
      if (!FILLER.test(seg)) out.push(seg);
    } else {
      // 长段切 2~4 字词，剔掉填充词
      for (let n = 4; n >= 2; n--) {
        for (let i = 0; i + n <= seg.length; i++) {
          const w = seg.slice(i, i + n);
          if (!FILLER.test(w)) out.push(w);
        }
      }
    }
  }
  // 长的优先（更具体），去重
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}

/**
 * 解析百度结果页。
 *
 * ⚠️ 百度的结构：`<h3 ...><a href="http://www.baidu.com/link?url=...">标题</a>`
 *    —— 链接是**百度自己的跳转地址**，不是真实 URL。
 *    好在我们只在个别地方用真实 URL（读正文），而百度跳转是能跟过去的。
 *
 * ⚠️ 百度可能弹验证码（返回含「安全验证」的页面）—— 那时解析不到结果，
 *    静默返回空数组，由调用方决定要不要换引擎。
 */
export function parseBaidu(html, limit = 5) {
  const out = [];
  const src = String(html ?? '');
  // 结果块：<div ... class="result ...">…<h3>…<a href="...">标题</a>
  const re = /<h3[^>]*>[\s\S]{0,400}?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(src))) {
    const url = m[1];
    const title = clean(m[2]);
    if (!title) continue;
    // 过滤百度自家的导航/视频聚合等
    if (/^百度|_百度知道$/.test(title) && title.length < 6) continue;
    out.push({ title, url, snippet: '' });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 百度搜索。
 *
 * ⚠️ 为什么必须要它（2026-09-12 实测，这是最关键的结论）：
 *    同三个中文网络梗，
 *      · Bing   → **三个全部失败**（返回彩票网站 / 卢浮宫 / 微软帮助页 / 塑料分类，
 *                 而它**从不返回空**，总是吐一堆无关内容 —— 比搜不到更糟）
 *      · 百度   → **三个全部命中**：
 *          「误闯天家」→ 误闯天家(网络流行词) - 百度百科 ✅
 *          「竹知了」  → "竹知了"是什么梗?为何会火遍网络? ✅
 *          「公共厕所」→ 说女人是"公共厕所"是什么意思? ✅
 *
 *    **中文内容百度就是比 Bing 强得多。**
 *
 * ⚠️ 风险：百度对自动化访问可能弹验证码（返回「安全验证」页）。
 *    所以解析不到就返回空，由上层换引擎 —— 不要在这里死磕。
 */
export async function baiduSearch(query, limit = 5) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const url = 'https://www.baidu.com/s?wd=' + encodeURIComponent(q) + '&rn=' + (limit + 3) + '&ie=utf-8';
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      signal: AbortSignal.timeout(config.search?.timeoutMs ?? 15000),
    });
    if (!r.ok) return [];
    const html = await r.text();
    // 验证码页：宁可返回空，也别把验证页当结果
    if (/安全验证|请输入验证码|wappass\.baidu/.test(html)) {
      log.warn('百度返回了验证码页，跳过');
      return [];
    }
    return parseBaidu(html, limit).map((x) => ({ ...x, from: 'baidu' }));
  } catch (e) {
    log.debug(`百度搜索失败：${e.message}`);
    return [];
  }
}

/**
 * B站搜索 —— **查网络热梗/二创/歌名比搜索引擎强得多**（2026-09-13 用户提议）。
 *
 * 用户的话：「联网搜索可以连接 b 站或者小红书这类社交平台吗，
 * 我觉得**在搜索网络热梗这种方面肯定比搜索引擎要好**」。
 *
 * ## 实测对比（关键词「中国人能飞」，同一天同一台机器）
 *
 * | 引擎 | 结果 |
 * | --- | --- |
 * | **百度** | **弹验证码页**，一无所获 |
 * | Bing / DDG | 一堆无关页 |
 * | **B站** | `【揽佬】中国人能飞～黄皮肤才对～讲中文才飞～中国就是美`（播放 1242 万）|
 *
 * B站一下给了**歌词原文**（搜索引擎给不了）+ **播放量**（说明这梗确实火）。
 * 这就是社交平台的优势：梗的一手材料在视频标题/弹幕里，不在网页文章里。
 *
 * ## ⚠️ 为什么是 B站而不是小红书（实测过）
 *
 * | 平台 | 可用性 |
 * | --- | --- |
 * | **B站** | ✅ 公开 JSON 接口，**不用 cookie、不用签名** |
 * | 小红书 | ❌ 客户端渲染 + 反爬；HTML 里没有笔记数据（试过） |
 * | 抖音 | ❌ HTML 是混淆 JS，数据靠接口（要签名） |
 * | 知乎 | ❌ 直接 403 |
 * | 微博 | ❌ 设备指纹 |
 *
 * 所以「社交平台」这条只做了 B站 —— **能用、免费、不需要登录**的只有它。
 *
 * @param {{timeoutMs?:number}} [opts]
 */
export async function bilibiliSearch(query, limit = 5, opts = {}) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const timeout = opts.timeoutMs ?? config.search?.timeoutMs ?? 15000;
  const url =
    'https://api.bilibili.com/x/web-interface/search/all/v2?keyword=' + encodeURIComponent(q);
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        // ⚠️ B站对这个接口**不验 cookie**，但**要 Referer**（不带有时会返回 -412）
        Referer: 'https://www.bilibili.com/',
        Accept: 'application/json,text/plain,*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) return [];
    const j = await r.json();
    if (j?.code !== 0) {
      log.debug(`B站搜索返回 code=${j?.code}（${j?.message ?? ''}）`);
      return [];
    }
    const videos = (j.data?.result ?? []).find((x) => x.result_type === 'video')?.data ?? [];
    const out = [];
    for (const v of videos.slice(0, limit)) {
      const title = String(v.title ?? '').replace(/<[^>]+>/g, '').trim();
      if (!title) continue;
      const bvid = String(v.bvid ?? '');
      // ⚠️ 播放量/点赞是**很有用的可信度信号** —— 1200 万播放说明这梗真火，
      //    而不是某个冷门视频。放进 snippet 让模型能判断。
      const stat = [];
      if (Number(v.play) > 0) stat.push(`播放 ${fmtNum(v.play)}`);
      if (Number(v.like) > 0) stat.push(`赞 ${fmtNum(v.like)}`);
      if (v.author) stat.push(`UP ${String(v.author).replace(/<[^>]+>/g, '')}`);
      out.push({
        title,
        url: bvid ? `https://www.bilibili.com/video/${bvid}` : 'https://www.bilibili.com/',
        snippet: stat.length ? `（B站视频 · ${stat.join(' · ')}）` : '（B站视频）',
        from: 'bilibili',
      });
    }
    if (out.length) log.debug(`B站搜索「${q}」→ ${out.length} 条`);
    return out;
  } catch (e) {
    log.debug(`B站搜索失败：${e.message}`);
    return [];
  }
}

/** 播放量写成「1242万」这种人的读法 */
function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)}亿`;
  if (v >= 1e4) return `${Math.round(v / 1e4)}万`;
  return String(v);
}

/**
 * B站的**搜索联想词** —— 判断"这是不是个梗"最好用的东西。
 *
 * ⚠️ 为什么它特别值钱（实测）：搜「中国人能飞」，联想词里有
 *    「中国人能飞**是什么梗**」「中国人能飞**原曲**」「中国人能飞**二创**」——
 *    **这是无数人真的这么搜出来的**，等于天然告诉我"这是个梗、还有原曲"。
 *    搜索引擎给不了这个。
 *
 * @returns {Promise<string[]>}
 */
export async function bilibiliSuggest(query, limit = 8) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  try {
    const r = await fetch(
      'https://s.search.bilibili.com/main/suggest?term=' + encodeURIComponent(q) + '&main_ver=v1',
      {
        headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Accept: 'application/json' },
        signal: AbortSignal.timeout(config.search?.timeoutMs ?? 15000),
      },
    );
    if (!r.ok) return [];
    const j = await r.json();
    const tags = (j?.result?.tag ?? []).map((t) => String(t.value ?? '').trim()).filter(Boolean);
    return [...new Set(tags)].slice(0, limit);
  } catch (e) {
    log.debug(`B站联想词失败：${e.message}`);
    return [];
  }
}

/**
 * 萌娘百科 —— ACG 梗/角色的**最权威中文百科**。
 *
 * ⚠️ 它的 `api.php?list=search` **被官方禁了**（实测：
 *    `{"error":{"code":"action-notallowed","info":"Unauthorized API call"}}`），
 *    搜索页又是 JS 壳（结果由前端异步拉）—— 所以**不能"搜索"**。
 *
 *    但 `rest.php/v1/page/<标题>` 和 `api.php?prop=extracts` **都能用**（实测），
 *    也就是说：**能按准确标题取条目正文**。
 *
 * 所以这里的策略是：把关键词当**候选条目标题**去试（最多试几个变体），
 * 命中就返回条目摘要。命中率不如搜索引擎，但**命中的那条质量极高**。
 *
 * @param {{timeoutMs?:number, tries?:number}} [opts]
 */
export async function moegirlSearch(query, limit = 3, opts = {}) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const timeout = opts.timeoutMs ?? config.search?.timeoutMs ?? 15000;
  const UA_ = UA;

  // 候选标题：原词，以及去掉常见尾缀（"是什么梗""原曲"…）后的词
  const cands = [
    q,
    q.replace(/[\s·]+/g, ''),
    q.replace(/(是什么梗|什么梗|原曲|出处|梗|是什么意思|是什么)$/g, '').trim(),
  ].filter((x, i, a) => x && a.indexOf(x) === i);

  const out = [];
  for (const title of cands.slice(0, opts.tries ?? 3)) {
    if (out.length >= limit) break;
    try {
      const r = await fetch(
        'https://zh.moegirl.org.cn/api.php?action=query&prop=extracts&exintro=1&explaintext=1' +
          `&redirects=1&titles=${encodeURIComponent(title)}&format=json`,
        {
          headers: { 'User-Agent': UA_, Accept: 'application/json' },
          signal: AbortSignal.timeout(timeout),
        },
      );
      if (!r.ok) continue;
      const j = await r.json();
      const pages = Object.values(j?.query?.pages ?? {});
      for (const p of pages) {
        // 没这个条目时 MediaWiki 返回 missing（没有 extract）
        const text = String(p?.extract ?? '').trim();
        if (!text || p?.missing !== undefined) continue;
        out.push({
          title: `萌娘百科：${p.title}`,
          url: `https://zh.moegirl.org.cn/${encodeURIComponent(p.title)}`,
          // 摘要截 300 字 —— 百科的导语通常就是"这是什么"的答案
          snippet: text.slice(0, 300),
          from: 'moegirl',
        });
      }
    } catch (e) {
      log.debug(`萌娘百科取「${title}」失败：${e.message}`);
    }
  }
  if (out.length) log.debug(`萌娘百科命中 ${out.length} 条（词：${q}）`);
  return out;
}

/**
 * 结果相关性打分：命中的关键词越多、越长，分越高。
 */
export function scoreResults(query, results) {
  const kws = keywords(query);
  if (!kws.length) return 0;
  let hit = 0;
  for (const r of results) {
    const hay = `${r.title} ${r.snippet}`;
    for (const k of kws) {
      if (hay.includes(k)) {
        hit += k.length >= 4 ? 3 : k.length >= 3 ? 2 : 1;
        break; // 一条结果只算一次
      }
    }
  }
  return hit;
}

/**
 * 智能搜索：先搜一遍，结果不相关就**换更精准的词重试**。
 *
 * ⚠️ 为什么需要（实测教训）：
 *   「梦限大MewType」→ 萌娘百科、百度百科，全对
 *   「梦限大MewType 剧情」→ 全变成「梦」的百科，一条都不相关
 *   **加词反而搜坏了**。所以第一次搜烂了要会换词重试，而不是直接放弃。
 */
export async function searchSmart(query, opts = {}) {
  const q = String(query ?? '').trim();
  if (!q) return [];

  const kws = keywords(q);
  // ⚠️ 2026-09-13 用户要求：「**搜索拆词时拆开之后的组合可以多留几个，
  //    不一定就用一个组合搜索，然后把最符合的内容整合就行了**」。
  //
  //    原来是「多种问法各搜一次，但**只留分数最高的那一份**」——
  //    拆出来的不同组合各有各的好处（有的命中正文、有的命中日期/官方页），
  //    只留一份等于把其他组合找到的材料**扔掉**。
  //
  //    现在：**每个组合的结果都留着**，按（相关分 + 原始排序）合并去重，
  //    让模型自己从多来源里挑最对得上的。
  const tries = [q];

  // 备选查询：最长的实词单独搜 / 实词+百科 / 实词+年份（时效类信息很有用）
  const main = kws.find((k) => k.length >= 3 && /[\u4e00-\u9fa5]/.test(k)) ?? kws[0];
  if (main && main !== q) {
    tries.push(main);
    tries.push(`${main} 百科`);
  }
  const thisYear = new Date().getFullYear();
  if (main && main !== q) tries.push(`${main} ${thisYear}`);
  // 拆词后的前两个实词组合（「璧山 铜梁」这种地名组合常常更准）
  const two = kws.filter((k) => k.length >= 2).slice(0, 2);
  if (two.length === 2 && two.join(' ') !== q) tries.push(two.join(' '));

  // ── 逐组合搜：**每个组合都问所有引擎**，全部留着并合并 ──
  //
  // ⚠️ 2026-09-13 改：从 `search(t)` 换成 `searchAllEngines(t)`。
  //    用户指出「**为什么不是整合所有引擎的结果再丢垃圾**」——
  //    原来是单引擎（只问 Bing），一个引擎瞎了就全瞎
  //    （实测 Bing 对「公共厕所」「璧山铜梁市郊铁路」返回英文垃圾页，
  //     而 DDG/百度是有结果的）。现在是"每个组合 = 多引擎汇总 + 统一去垃圾"。
  const merged = [];
  const seenUrl = new Set();
  const seenTitle = new Set();
  let bestScore = 0;
  const used = [];
  for (const t of [...new Set(tries)].slice(0, 3)) {
    const results = await searchAllEngines(t, opts);
    if (!results.length) continue;
    const sc = scoreResults(q, results);
    bestScore = Math.max(bestScore, sc);
    used.push(`「${t}」${results.length}条/分${sc}`);
    for (const r of results) {
      const u = String(r.url ?? '');
      const ti = String(r.title ?? '').trim();
      // 去重：同 url 的跳过；同标题（不同站点转载）也跳过
      if (u && seenUrl.has(u)) continue;
      if (ti && seenTitle.has(ti)) continue;
      if (u) seenUrl.add(u);
      if (ti) seenTitle.add(ti);
      // 记下它是哪个组合搜到的 + 相关分（给模型参考可信度）
      merged.push({ ...r, _q: t, _sc: sc });
    }
    // 已经攒够就不用再试（避免搜太多次把回复拖慢）
    if (merged.length >= 10) break;
  }

  if (!merged.length || bestScore === 0) {
    log.info(`搜索「${q}」没搜到相关内容（试了 ${tries.length} 种问法），当作没搜到`);
    return [];
  }
  log.info(`搜索「${q}」→ 合并 ${merged.length} 条（组合：${used.join('、')}）`);
  return merged.slice(0, 10);
}

/**
 * 搜一下。失败返回空数组（调用方就当没搜到，不要编）。
 * @param {string} query
 * @param {{limit?:number}} opts
 */
/**
 * 问**所有引擎**，把结果汇总后再统一丢垃圾、统一排相关。
 *
 * ⚠️⚠️ 为什么要有这个（2026-09-13，用户提出）：
 *
 *    用户原话：「**为什么不是整合所有引擎的结果再丢垃圾**」。
 *
 *    原来的架构是「**单引擎 + 逐组合串行**」：
 *      `search()` 里 `engine = opts.engine === 'ddg' ? 'ddg' : 'bing'` —— 二选一，
 *      **每次只问一个引擎**，然后**就在那一份结果上各自过滤**。
 *
 *    这有两个毛病（都是实测踩过的）：
 *      ① **一个引擎瞎了就全瞎**。实测 Bing 对「公共厕所」/「璧山铜梁市郊铁路」
 *         返回完全不相关的东西（甚至英文垃圾页），而 DuckDuckGo/百度有结果。
 *         只问 Bing 就等于认定"这个词搜不到"。
 *      ② **过滤得太早**。在"单引擎的小样本"上就丢掉"不够相关"的，
 *         可能把唯一正确的那个也丢了。**样本大了再过滤，判断才准。**
 *
 *    所以改成：
 *      并发问 3 个引擎 → **先汇总去重**（不在这步过滤）
 *      → 再统一 `isJunkResult` 丢挑战页/导航页
 *      → 再统一按相关度排序（**顺便统计"几个引擎都提到了它"当可信度**）
 *
 *    ⚠️ 并发是必须的 —— 串行问 3 个引擎会把回复拖慢 3 倍。
 *
 * @returns {Promise<Array>} 汇总后的结果（每条带 `_engines` 和 `_hits`）
 */
async function searchAllEngines(q, opts = {}) {
  const limit = opts.limit ?? config.search?.results ?? 5;
  // ⚠️ 2026-09-13 用户要求「**站也加入一起用**」——
  //    B站（热梗/二创一手材料）和萌娘百科（ACG 梗权威）**并进同一个池子**，
  //    不替代原来的搜索引擎。各自失败就返回空，不影响别的（`allSettled`）。
  const engines = ['bing', 'ddg', 'baidu', 'bilibili', 'moegirl']
    // 可以在配置里单独关掉（某个站抽风时不用改代码）
    .filter((e) => config.search?.engines?.[e] !== false);

  const settled = await Promise.allSettled(
    engines.map(async (eng) => {
      if (eng === 'baidu') {
        // 百度走它自己的解析器
        return { eng, list: await baiduSearch(q, limit) };
      }
      if (eng === 'bilibili') {
        return { eng, list: await bilibiliSearch(q, limit, opts) };
      }
      if (eng === 'moegirl') {
        // 萌娘百科命中率低但质量高，给它少占点名额
        return { eng, list: await moegirlSearch(q, Math.min(3, limit), opts) };
      }
      return { eng, list: await search(q, { ...opts, engine: eng }) };
    }),
  );

  // ── ① 汇总去重（**这一步先不丢任何东西**）──
  const pool = [];
  const byUrl = new Map();
  const byTitle = new Map();
  const okEngines = [];
  for (const s of settled) {
    if (s.status !== 'fulfilled') {
      log.debug(`搜索引擎失败：${s.reason?.message ?? '未知'}`);
      continue;
    }
    const { eng, list } = s.value;
    if (!list?.length) continue;
    okEngines.push(`${eng}${list.length}`);
    for (const r of list) {
      const url = String(r.url ?? '').trim();
      const title = String(r.title ?? '').trim();
      const key = url || title;
      if (!key) continue;
      // 同一条结果被多个引擎提到 → 累加 `_hits`（可信度信号）
      const exist = (url && byUrl.get(url)) || (title && byTitle.get(title));
      if (exist) {
        exist._hits = (exist._hits ?? 1) + 1;
        if (!exist._engines.includes(eng)) exist._engines.push(eng);
        continue;
      }
      const rec = { ...r, _engines: [eng], _hits: 1 };
      pool.push(rec);
      if (url) byUrl.set(url, rec);
      if (title) byTitle.set(title, rec);
    }
  }
  if (!pool.length) {
    log.info(`搜索「${q}」：所有引擎都没结果`);
    return [];
  }

  // ── ② 统一丢垃圾（挑战页 / 导航页 / 明显无效）──
  const beforeJunk = pool.length;
  let clean = pool.filter((r) => !isJunkResult(r));
  if (clean.length !== beforeJunk) {
    log.info(`搜索「${q}」：汇总后滤掉 ${beforeJunk - clean.length} 条挑战页/导航页`);
  }
  if (!clean.length) clean = pool; // 全被滤掉说明判据太狠，宁可留着

  // ── ③ 统一按相关度排序 + 多引擎共识加权 ──
  const kws = keywords(q);
  const scoreOf = (r) => {
    const hay = `${r.title ?? ''} ${r.snippet ?? ''}`.toLowerCase();
    let sc = 0;
    for (const k of kws) if (k && hay.includes(String(k).toLowerCase())) sc += k.length >= 4 ? 3 : k.length >= 3 ? 2 : 1;
    // 多个引擎都提到 → 更可信（每个额外引擎 +2）
    sc += Math.max(0, (r._hits ?? 1) - 1) * 2;
    return sc;
  };
  clean.sort((a, b) => scoreOf(b) - scoreOf(a));

  // ⚠️ 门槛要低 —— 这里是**汇总后**判断，宁可多留几条让模型自己挑
  //    （用户要求「多留几个组合，把最符合的内容整合」）。
  const top = clean.slice(0, 10);
  log.info(
    `搜索「${q}」：${okEngines.join('/')} → 汇总 ${pool.length} → 去垃圾 ${clean.length} → 取 ${top.length} 条` +
      `（多引擎共识 ${top.filter((r) => (r._hits ?? 1) > 1).length} 条）`,
  );
  return top;
}

export async function search(query, opts = {}) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  if (q.length > 120) return search(q.slice(0, 120), opts);

  // 引擎选择：默认 Bing；传 engine:'ddg' 走 DuckDuckGo。
  // ⚠️ 两个引擎的退避/限流状态共用（都在搜索这件事上，没必要分开算）。
  const engine = opts.engine === 'ddg' ? 'ddg' : 'bing';

  const now = Date.now();
  if (now < blockedUntil) {
    log.debug(`搜索：处于退避期，跳过（还有 ${Math.round((blockedUntil - now) / 1000)}s）`);
    return [];
  }
  if (now - lastAt < MIN_GAP_MS) await new Promise((r) => setTimeout(r, MIN_GAP_MS - (now - lastAt)));
  lastAt = Date.now();

  const limit = opts.limit ?? config.search?.results ?? 5;
  const url =
    engine === 'ddg'
      ? 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q)
      : 'https://www.bing.com/search?q=' +
        encodeURIComponent(q) +
        '&setlang=zh-CN&mkt=zh-CN&count=' +
        (limit + 3);

  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      signal: AbortSignal.timeout(config.search?.timeoutMs ?? 20000),
    });

    if (!r.ok) {
      failStreak++;
      log.warn(`搜索失败 HTTP ${r.status}（${engine}，连续 ${failStreak} 次）`);
      if (failStreak >= MAX_FAILS) {
        blockedUntil = Date.now() + BLOCK_MS;
        log.warn(`搜索连续失败 ${failStreak} 次，暂停 ${BLOCK_MS / 60000} 分钟`);
        failStreak = 0;
      }
      return [];
    }

    const html = await r.text();
    let results = engine === 'ddg' ? parseDDG(html, limit) : parseBing(html, limit);

    // ⚠️ 相关性过滤：Bing 对生僻词（比如「梦限大」）会返回一堆不相关的东西
    //    （实测搜「梦限大」返回「梦」的百科）。拿着垃圾结果回答比不搜更糟，
    //    所以这里检查结果里到底有没有出现查询词，没出现就当成没搜到。
    const before = results.length;
    // ⚠️ 先滤掉**反爬挑战页 / 导航页**（Google / Microsoft / Walmart 那种）——
    //    它们不是搜索结果，喂给模型会让它当真（比搜不到更糟，真实踩过）。
    const notJunk = results.filter((r) => !isJunkResult(r));
    if (notJunk.length !== results.length) {
      log.info(`搜索：滤掉 ${results.length - notJunk.length} 条挑战页/导航页（${engine}）`);
      results = notJunk;
    }
    results = filterRelevant(q, results);
    if (before !== results.length) {
      log.info(`搜索：过滤掉 ${before - results.length} 条不相关结果（${engine}）`);
    }

    if (!results.length) {
      failStreak++;
      log.warn(`搜索：解析不到结果（${engine} 可能改版了）`);
      if (failStreak >= MAX_FAILS) {
        blockedUntil = Date.now() + BLOCK_MS;
        failStreak = 0;
      }
      return [];
    }

    failStreak = 0;
    log.info(`搜索「${q.slice(0, 30)}」→ ${results.length} 条结果`);
    return results;
  } catch (e) {
    failStreak++;
    log.warn(`搜索出错：${e.message}（连续 ${failStreak} 次）`);
    if (failStreak >= MAX_FAILS) {
      blockedUntil = Date.now() + BLOCK_MS;
      log.warn(`搜索连续失败 ${failStreak} 次，暂停 ${BLOCK_MS / 60000} 分钟`);
      failStreak = 0;
    }
    return [];
  }
}

/**
 * 判断这条消息要不要联网搜。
 *
 * 只在**明显在问近期/外部信息**时才搜，免得每句话都去撞 Bing。
 * 宁可漏搜，也别乱搜 —— 搜错了会污染回答。
 */
export function shouldSearch(text) {
  if (config.search?.enable === false) return null;
  const t = String(text ?? '').trim();
  if (t.length < 3 || t.length > 100) return null;

  // ── 先排除「明确不需要联网」的 ──
  // 用户要求（2026-09-11）：**除了服务器和知识库有的，其他全部先上网搜**。
  // 所以这里的默认是「搜」，只有下面这几类才跳过。
  const skip = config.search?.skipWhen ?? {};

  //  ① 纯情绪 / 安慰场景：搜了反而冷冰冰
  if (skip.emotion !== false && looksLikeEmotionOnly(t)) return null;

  //  ② 纯寒暄 / 应声 / 玩梗，没有事实可查
  if (skip.chitchat !== false && looksLikePureChat(t)) return null;

  //  ③ 服务器内部问题：本地知识库有权威答案，搜网页反而可能搜到过时信息
  if (skip.server !== false && looksLikeServerIssue(t)) return null;

  //  ④ 让机器人做动作 / 跟自己有关的（清空对话、你学到了什么…）
  if (/^(清空对话|你学到了什么|忘记[:：]|记住[:：])/.test(t)) return null;

  // ── 明确要求搜的，直接搜（连上面的排除都不管）──
  const explicit = /搜一下|搜搜|搜索一下|查一下|查查|上网查|百度一下|帮我查|帮我搜|去查|搜下/;
  if (explicit.test(t)) {
    const q = toQuery(t.replace(explicit, '').replace(/^[一下，,、\s]+/, '').trim());
    return q || t;
  }

  // ── 默认：搜。但要把口语问句洗成关键词，否则 Bing 搜不到东西 ──
  const q = toQuery(t);
  return q || t;
}

/** 纯情绪倾诉（没有事实要查） */
function looksLikeEmotionOnly(t) {
  const emo =
    /我(太)?(没用了?|废物|不行|完蛋|失败)|好想哭|想哭|难受|不开心|心情不好|emo了?|破防|委屈|心累|撑不住|熬不住|被骂了?|搞砸了/;
  if (!emo.test(t)) return false;
  // 里面混了具体问题就还是要搜
  return !/(是什么|怎么|为什么|哪里|谁|介绍|剧情|多少钱|在哪)/.test(t);
}

/** 纯寒暄 / 应声 / 玩梗 */
function looksLikePureChat(t) {
  if (/^(在吗|在不在|早|早上好|晚安|你好|hi|hello|谢谢|多谢|辛苦了?|哈哈+|草|6+|好|行|嗯|哦|收到|知道了?|没事|随便|都行)[!！。~～\s]*$/i.test(t))
    return true;
  // ⚠️ 这里原来还有一条「t.length <= 4 就算闲聊」——**删掉了**（2026-09-12）。
  //    它比 looksInternal 里那段判断**先执行**，把「黑神话」「MyGO」这种
  //    四字以内的**作品名 / 游戏名 / 梗**全误判成闲聊，压根不去搜。
  //    现在短句"是不是废话"统一由 looksInternal 里那套规则判断。
  return false;
}

/** 服务器内部问题（本地知识库有权威答案） */
function looksLikeServerIssue(t) {
  const tech =
    /服务器|整合包|模组|存档|白名单|客户端|启动器|报错|进不去|进不了|连不上|开服|端口|延迟|卡顿|闪退|掉线|\bjava\b|\bmtr\b|\bop\b|管理员申请|建设申请|大足区/i;
  if (!tech.test(t)) return false;
  // 问「什么时候出新版本」这种还是要搜
  if (/最新|最近|新闻|出了吗|更新了没|什么时候出/.test(t)) return false;
  return true;
}

/** 把结果拼成给模型看的文本 */
/**
 * 从一条搜索结果里**抽出发布日期**。
 *
 * ⚠️ 为什么需要（2026-09-13，用户要求）：
 *    用户原话：「**搜索到带日期的信息时，应该要结合发布日期和材料日期** ——
 *    比如搜到璧山到铜梁那条市郊铁路，今年一月刚开通的，我猜机器人直接原样照抄了，
 *    但是实际已经不是今年了」。
 *
 *    只要给模型「今天几号」+「这条网页是几号的」，它就能自己算
 *    「那条消息过时了 / 那件事距今多久」。**光给"今天"不够** ——
 *    模型看不到材料的日期，就只会照抄原文里的相对说法（「今年一月」）。
 *
 * 抽取顺序（越靠前越可信）：
 *   ① 标题 / 摘要里明确写的日期（「2026年1月」「2026-01-15」）
 *   ② URL 里的日期（很多站点是 `/2026/01/15/xxx` 或 `...20260115...`）
 *
 * @returns {string} 形如 `2026-01` 的字符串；抽不到返回空串
 */
export function guessDate(r) {
  const text = `${r?.title ?? ''} ${r?.snippet ?? ''}`;
  const nowYear = new Date().getFullYear();

  /** 校验：月 1~12、日 1~31、年在一个合理区间（否则是 URL 里的随机数字） */
  const ok = (y, mo, d) => {
    const yy = Number(y);
    const mm = Number(mo);
    const dd = d === undefined ? 1 : Number(d);
    if (!(yy >= 2000 && yy <= nowYear + 1)) return false;
    if (!(mm >= 1 && mm <= 12)) return false;
    if (!(dd >= 1 && dd <= 31)) return false;
    return true;
  };
  const fmt = (y, mo, d) =>
    d === undefined
      ? `${y}-${String(mo).padStart(2, '0')}`
      : `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  // ① 正文里写的：2026年1月15日 / 2026年1月 / 2026-01-15 / 2026/01/15
  let m =
    text.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/) ||
    text.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月/) ||
    text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/) ||
    text.match(/\b(20\d{2})[-/.](\d{1,2})\b/);
  if (m && ok(m[1], m[2], m[3])) {
    return m[3] ? fmt(m[1], m[2], m[3]) : fmt(m[1], m[2]);
  }
  // ①b 中文写的「2026年1月15日」但月/日不合法 → 退回只取年（如果有）
  if (m && ok(m[1], 1, 1)) return `${m[1]}`;

  // ② URL 里的：/2026/01/15/ 或 /20260115
  //
  // ⚠️⚠️ URL 里数字很多，**必须严格校验**（2026-09-13 踩过）：
  //    实测从 `.../2035-37-70...` 抽出「2035-37-70」这种鬼日期 ——
  //    月份 37、日期 70，那是 URL 里的随机串被当成了日期。
  //    这种垃圾日期喂给模型比没有日期更糟（它会照着一个不存在的日期去算）。
  const url = String(r?.url ?? '');
  m = url.match(/\/(20\d{2})\/(\d{1,2})\/(\d{1,2})\//) || url.match(/\/(20\d{2})\/(\d{1,2})\//);
  if (m && ok(m[1], m[2], m[3])) {
    return m[3] ? fmt(m[1], m[2], m[3]) : fmt(m[1], m[2]);
  }
  m = url.match(/\/(20\d{2})(\d{2})(\d{2})\b/);
  if (m && ok(m[1], m[2], m[3])) return fmt(m[1], m[2], m[3]);

  return '';
}

export function searchBlock(query, results) {
  if (!results || !results.length) {
    return [
      '',
      '# 【联网搜索结果】',
      '',
      `系统刚帮你搜了「${query}」，但**没搜到有用结果**（或者网络出问题了）。`,
      '',
      '⚠️ **不要编。** 直接说你不清楚，或者让对方补充一下具体想问什么。',
    ].join('\n');
  }
  // ⚠️ 每条结果**带上抽出来的日期**（2026-09-13，用户要求）——
  //    见 `guessDate` 的注释（「今年一月开通的…但实际已经不是今年了」）。
  const lines = results.map((r, i) => {
    const d = guessDate(r);
    const head = `${i + 1}. ${r.title}${d ? `　【${d}】` : ''}`;
    return `${head}\n   ${r.snippet}\n   来源：${r.url}`;
  });

  const today = new Date();
  const todayStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;

  return [
    '',
    '# 【联网搜索结果】以下是系统刚帮你搜到的**真实网页内容**',
    '',
    `搜索词：「${query}」`,
    '',
    ...lines,
    '',
    // ⚠️ 来源使用说明（2026-09-13 加 B站/萌娘百科之后补）——
    //    不同来源的**可信度语义不一样**，不点明的话模型会一视同仁。
    '## 这些结果分别是什么来源（怎么用）',
    '',
    '· **B站视频**（`bilibili.com/video/...`）：标题就是**一手材料**（歌词原文、梗的说法），',
    '  后面的「播放 X 万 / 赞 X 万」是**火不火的证据** —— 上千万播放说明这梗确实流行，',
    '  几百播放大致就是个小众视频（**别拿它当"大家都在说"的证据**）',
    '· **萌娘百科**：ACG 梗/角色的权威解释，当"这个词是什么意思"看',
    '· **百科（百度百科等）**：适合查定义、来历',
    '· **新闻/文章**：适合查"为什么火的""经过"',
    '',
    // ⚠️⚠️ 日期那一段（2026-09-13，用户要求）
    '## ⚠️ 关于时间：**必须自己换算，别照抄原文的相对说法**',
    '',
    `**今天是 ${todayStr}。**`,
    '',
    '上面每条结果后面的 `【2026-01】` 这种是**那篇网页的日期**（抽得到的才标）。',
    '网页里经常写「**今年**一月」「**上个月**刚开通」「**近日**」这种**相对说法** ——',
    '那是**作者写那篇的时候**说的，**不等于现在**。',
    '',
    '所以：',
    '- ✅ 把相对说法**换成具体时间**再说：搜到「今年1月开通」（网页是 1 月的）',
    '  → 你要说「**1 月开通的**」或「**今年 1 月**」（如果确实还是今年）',
    '- ❌ **不要**照着念「今年刚开通」「上个月刚开」——',
    '  如果那篇网页已经是几个月前、或者隔了一年，你这么说就是错的',
    '- ✅ **算一下距今多久**（「开通半年多了」「去年年底的事」），这样最自然',
    '- ⚠️ **网页没标日期、也没写时间的 → 不要说"最近/刚刚"**，只说你查到的事实',
    '',
    '## 怎么用这些内容',
    '',
    '**① 当资料用，不是当台词念。** 用自己的话说，别把网页原文搬过来。',
    '**多个来源都在说同一件事 → 那基本可信；只有一条这么说 → 说得含糊点。**',
    '',
    '**② 聊到作品/剧情时：就当自己看过。**',
    '具体是：**别说「我没看过」「我没追」这种话** —— 群友聊起来你插不上嘴很扫兴。',
    '   - 可以直接聊剧情、角色、设定，就照上面搜到的内容说。',
    '   - 但**只聊搜到的内容**。搜到的东西之外，**别编**（比如具体第几集发生了什么）。',
    '   - 真被问到搜不到的具体细节，就含糊带过或者转话题，',
    '     可以说「那段我记不太清了」，**不要**说「我没看过」。',
    '',
    '**③ 拿不准就说不确定。** 搜索结果可能过时或不完整。',
    '',
    '**④ 不用把网址念出来**，说内容就行；真想给就给最有用的那一条。',
  ].join('\n');
}

/** 给管理界面看的状态 */
export function searchStatus() {
  return {
    enable: config.search?.enable !== false,
    provider: 'bing（网页抓取，免费）',
    blocked: Date.now() < blockedUntil,
    blockedSecondsLeft: Math.max(0, Math.round((blockedUntil - Date.now()) / 1000)),
    failStreak,
  };
}

export function resetSearch() {
  failStreak = 0;
  blockedUntil = 0;
}
