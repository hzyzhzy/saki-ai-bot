/**
 * 合并式「预搜索」—— 一次调用决定「搜不搜 / 搜什么 / 要不要读整页」，
 * 然后实际去搜、去读，把**整理好的材料**交给主模型。
 *
 * 为什么要合并（用户要求：「可以，合并吧，速度慢一点其实也更像人类了」）：
 *
 *   旧流程分三步，模型只看得到每一步的局部：
 *     ① 搜索规划（一次模型调用）→ 只决定一个搜索词，看不到搜索结果长什么样
 *     ② 搜索（规则代码）→ 拿标题+摘要，不读正文
 *     ③ 主聊天（又一次调用）→ 拿着几条摘要回答
 *
 *   问题：第 ① 步的模型**不知道搜出来会是什么**，所以经常判错"该不该搜"。
 *   真实踩过的坑：群友说「给我来碗忘情牛肉面」，规划判了 NONE（当成一道菜），
 *   主模型于是回了「忘情的没有」—— 其实那是王琪的一首歌。
 *   如果规划那一步能意识到「这可能是个作品名」，就会去搜。
 *
 *   合并之后：**同一个上下文里决定 + 执行**，而且可以**把网页正文读进来**，
 *   主模型拿到的就不再是几条摘要，而是真材料 —— 答案质量明显不同。
 *
 * ⚠️ 代价：要多花 1~2 次模型调用 + 一次网页抓取，慢 3~8 秒。
 *    群聊里慢一点反而更像真人（真人也会说"等下我查查"）。
 */
import { config } from './config.js';
import { log } from './log.js';
import { search, searchBlock, looksInternal } from './search.js';
import { readFromResults } from './page-reader.js';

/** 出题：让模型一次决定搜不搜、搜什么、要不要深读 */
const DECIDE_PROMPT = `你要帮一个 QQ 群客服机器人决定：**这句话要不要上网查，查什么。**

读下面这句话（可能带群聊上下文），输出 JSON：

{
  "search": true 或 false,
  "query": "搜索关键词（search 为 false 时留空）",
  "deep": true 或 false,
  "why": "一句话说明为什么"
}

## 什么时候要搜（search: true）

**只要句子里出现一个「外面世界本来就有的名字」而你不确定它是什么，就搜：**
歌名、番剧名、游戏名、角色名、网络梗、小说、电影、主播、软件、品牌、新闻、地名。

⚠️ **关键**：这类词**字面上常像普通东西**，很容易被当成字面意思理解：
- 「给我来碗**忘情牛肉面**」← 这是**王琪的歌**，不是菜
- 「**鸡同鸭讲**是什么梗」← 要搜出处
- 「你看过**MyGO**吗」← 番剧
- 「那个**黑神话**」← 游戏

**不确定就搜。** 搜一次的成本远低于答错。

## 什么时候不搜（search: false）

- **⚠️⚠️ 答案已经在上文（群聊上下文）里了** —— **这一条优先于下面所有"要搜"的判据**：
  如果上下文里有人发过**分享卡片 / 链接 / 截图**（形如「[分享:标题｜简介]」），
  而这句话问的就是它（「那 XX 是什么」「这个呢」「刚发的那个」），
  **答案就在上文的标题里 → 不搜**，让机器人直接看上下文回答。

  ⚠️ 真实踩过（2026-09-17，用户截图报的）：群友刚发了一条 B站卡片
  「[分享:FlatCraft｜还原AB火柴人质感我的世界2D版]」，
  紧接着问「那 flatcraft 是什么」—— **答案明明就在上一条的标题里**，
  却判成了要搜；搜索只匹配到 flat（纸牌接龙），
  拿回一堆垃圾**盖过了上下文**，最后她答「真没搜到，翻出来全是纸牌接龙」。
  用户的原话是：「**看来不能主动 b站搜索**」。

- **纯闲聊 / 情绪**：「今天好累」「哈哈哈哈」「我太没用了」→ 不搜
- **本服务器内部的东西**：下面会给你「服务器知识库」的内容，
  凡是知识库里有的、或者看着像这个服务器自己造的词（内部地名、机构、人、
  线路、机器），**一律不搜** —— 网上没有。
- **纯技术操作问题**（怎么进服务器、Java 装几）→ 知识库里有就够，不搜

## deep 什么时候为 true

默认 false（只搜网页摘要就够）。**只有**下面这种才设 true（会去读网页正文，慢一些）：
- 需要**具体内容**才能答：剧情细节、角色设定、梗的来龙去脉、作品的背景介绍
- 问「是什么」「讲讲」「怎么回事」这类需要一段解释的

只问「有没有」「叫什么名字」这种一句话就能答的 → false。

## query 怎么写

- **实体全名 + 意图词**：「忘情牛肉面 歌曲」「梦限大MewType 动画 剧情」「鸡同鸭讲 梗 出处」
- 别用代词（「这个」「它」）—— 用上下文里的具体名字
- 别照抄整句话，客套和语气都丢掉

只输出 JSON，不要解释、不要代码块。`;

/**
 * 这个问题是不是在问「小祥自己 / 她跟别人的关系 / 作品内设定」。
 *
 * ⚠️ 为什么要单独判（2026-09-12 真实踩过）：
 *    「你和她说过话吗」被当成检索任务去搜「户山香澄 丰川祥子 说过话 关系」，
 *    两个引擎全失败，机器人于是回了一堆「不确定」「说不准」「我没查到」。
 *    **这类问题网上没有权威答案**（是虚构设定），而且**她自己就是当事人** ——
 *    该怎么答是她的自由，不需要"查"。
 */
function looksLikeSelfLore(t) {
  const s = String(t ?? '');
  // ① 直接问「你」的经历 / 关系 / 态度
  const askSelf =
    /你(和|跟|与|有没有|有没有和|认不认识|认识|见过|说过话|聊过|熟不熟|喜不喜欢|怎么看|讨厌|为什么|是不是)/.test(
      s,
    );
  // ② 作品内的关系/设定词
  const loreWord =
    /(说过话|聊过|认识|见过|熟|同团|队友|成员|乐队|退团|解散|关系|前辈|后辈|剧情|设定|动画里|手游里|原作|第一季|第二季|第三季)/.test(
      s,
    );
  // ③ 提到企划里的人物/乐队名（从 anime.md 那份表里也覆盖得到）
  const franchise =
    /(邦邦|BanG|香澄|户山|MyGO|高松灯|Ave Mujica|Mujica|梦限大|ゆめみた|Poppin|破琵琶|祥子|睦|若麦|初华|海铃|乐奈|素世|立希|爱音)/i.test(
      s,
    );

  // ⚠️⚠️ ④ **用外号在第三人称提她**（2026-09-13 补的真 bug）。
  //
  //    真实踩的：群友发「**小祥**今天在干嘛」——
  //    上面三条件**一个都不满足**（没有"你"、没有设定词），
  //    于是白搜了一次「今天在干」，搜了一堆没用的东西（还拖慢 3~5 秒）。
  //
  //    这就是「**关于她自己的问题一律不搜**」这条规则的漏洞：
  //    它只认第二人称，别人**用名字提她**就漏了。
  //    而这类话恰恰是最常见的闲聊（"小祥在吗""祥子今天怎么没说话"）。
  const callByName =
    /(小祥|祥子|saki|客服|大祥|祥宝|章鱼祥|章鱼小祥|骆驼祥子|oblivionis|オブリビニス)/i.test(s);
  // 「问她这个人怎么了」的迹象：在不在 / 干嘛 / 状态 / 情绪 / 去哪了
  const askAboutHer =
    /(在干嘛|在吗|在不在|干嘛呢|干什么呢|去哪|怎么了|怎么没|今天怎么|还好吗|在忙|睡了吗|醒着|心情|状态|是不是不)/.test(
      s,
    );
  if (callByName && askAboutHer) return true;

  // ⑤ 叫了她的名字 + 问她的事（"小祥你今天…"）—— 也是关于她自己
  if (callByName && /你(今天|现在|最近|怎么|在)/.test(s)) return true;

  return (askSelf && loreWord) || (askSelf && franchise) || (loreWord && franchise);
}

/** 把流式输出收成字符串 */
async function collect(messages, opts = {}) {  const { streamChat } = await import('./llm.js');
  let out = '';
  for await (const d of streamChat(messages, opts.signal)) out += d;
  return out;
}

/**
 * 一次调用决定 + 执行搜索（可选读正文）。
 *
 * @param {string} text 当前这句话
 * @param {string} context 群聊上下文（帮它消解代词）
 * @param {{knowledge?:string, signal?:AbortSignal}} opts
 *        knowledge：服务器知识库摘要（用来判断「是不是内部话题」）
 * @returns {Promise<{searched:boolean, query?:string, deep?:boolean, why?:string,
 *                    block?:string, results?:number, read?:string}>}
 */
export async function preSearch(text, context = '', opts = {}) {
  const cfg = config.search ?? {};
  if (cfg.enable === false) return { searched: false, why: '搜索功能关闭' };

  const t = String(text ?? '').trim();
  if (!t) return { searched: false, why: '空消息' };

  // ⚠️⚠️ **极短消息不搜**（2026-09-13 用户反馈「这个场景还可以优化」）。
  //
  //    真实场景（截图）：
  //      群友：「喵」
  //      机器人：「嗯，等下，我瞅瞅」 ← **过渡话**（说明它在"查东西"）
  //      机器人：「喵什么喵」
  //
  //    问题：**一个字的拟声词/情绪词触发了一次联网搜索**。
  //    它本来该**直接回一句「喵什么喵」**，根本不需要"我瞅瞅"那个过渡。
  //    两宗罪：① 白等一次搜索（3~15 秒）② 白花一次模型调用。
  //
  //    判据：**短 + 没有搜索意图** → 不搜。
  //      · 「喵」「草」「啊这」「6」「哈哈」「草草草」 → 不搜
  //      · 「是什么梗」「怎么了」 → **搜**（有疑问词）
  //      · 「Java 装几」 → **搜**（超过 6 字，走正常判断）
  //
  //    ⚠️ 为什么这条要放在**模型之前**（而不是交给模型判断）：
  //      这是**确定性**的（字数 + 有没有疑问词），规则能判的别花一次模型调用。
  //      而且实测模型在这类消息上会**过度保守**（它宁可搜一下）——
  //      而这里"搜错"的代价是白等十几秒，"不搜"的代价只是少查一次无关内容。
  //    ⚠️ 疑问词的判据要**够全** —— 我第一版漏了「是啥/是嘛」，
  //      结果「原神是啥」「梦限大是啥」被当成"没有搜索意图"拦掉了
  //      （测试抓出来的）。中文疑问说法比想象的多。
  if (
    t.length <= 6 &&
    !/[?？]|什么|啥|咋|怎么|为什么|多少|哪|谁|是不是|有没有|吗$|呢$|嘛$/.test(t)
  ) {
    log.debug(`预搜索：太短且没有疑问词（「${t}」），不搜`);
    return { searched: false, why: '极短消息（没有搜索意图）' };
  }

  // ⚠️ 明显的内部话题直接跳过，连模型都不用调（省一次调用）
  if (looksInternal(t)) return { searched: false, why: '内部话题（规则判定）' };

  // ⚠️⚠️ 「关于小祥自己 / 她跟别人的关系」的问题**一律不搜**（2026-09-12 加）。
  //
  //    真实踩过：HZY 问「你和她（户山香澄）说过话吗」，
  //    系统去搜「户山香澄 丰川祥子 说过话 关系」→ Bing 解析不到、百度弹验证码，
  //    全失败 → 机器人回了一堆「这我真不确定」「说不准」「我没查到」。
  //
  //    **这类问题本来就没有"网上的答案"** —— 那是虚构作品的设定，
  //    而且**小祥自己就是当事人**，该怎么答是她的自由。
  //    搜了只会让她摆出"在查档案"的姿态，非常出戏。
  if (looksLikeSelfLore(t)) {
    log.debug('预搜索：问的是她自己 / 作品内关系，不搜');
    return { searched: false, why: '问的是她自己的事（作品内设定，网上没有答案）' };
  }

  // ⚠️ **本地知识库里已经有答案的，也不用搜**（2026-09-12 加）。
  //
  //    真实踩过：往 anime.md 里加了「户山香澄 / 邦高祖」这张表之后，
  //    问「邦高祖是谁」**还是会去搜** —— 白花 20 秒、还搜到「石敬瑭」，
  //    而答案明明就在知识库里（提示词里已经有那张表了）。
  //
  //    判据：消息里出现的关键词，在知识文件里也出现过 → 本地有，直接答。
  if (typeof opts.knownLocally === 'function' && opts.knownLocally(t)) {
    log.debug('预搜索：知识库里已经有这个词条，不搜');
    return { searched: false, why: '知识库里已有（直接照知识库答）' };
  }

  let plan = null;
  try {
    const user = [
      // ⚠️⚠️ 2026-09-17：这句提示原来写的是「帮你理解代词」——
      //    那等于告诉模型"上下文只用来解代词、不是答案来源"，
      //    于是「flatcraft 是什么」被拿去搜了（答案就在上面的分享卡片标题里）。
      //    现在明确写出来：**这里面可能已经有答案**。
      context ? `# 群聊上下文（**先读这里：可能已经有答案**，尤其是分享卡片/链接的标题）\n${context}\n` : '',
      opts.knowledge ? `# 服务器知识库摘要（凡是这里面有的，一律不搜）\n${String(opts.knowledge).slice(0, 4000)}\n` : '',
      `# 这句话\n${t}`,
    ]
      .filter(Boolean)
      .join('\n');

    const raw = await collect(
      [
        { role: 'system', content: DECIDE_PROMPT },
        { role: 'user', content: user },
      ],
      opts,
    );
    const m = String(raw).match(/\{[\s\S]*\}/);
    if (m) plan = JSON.parse(m[0]);
  } catch (e) {
    log.debug(`预搜索决策失败，退回规则：${e.message}`);
  }

  // 模型没给出判断 → 退回老规则
  if (!plan || typeof plan.search !== 'boolean') {
    const { shouldSearch } = await import('./search.js');
    const q = shouldSearch(t);
    if (!q) return { searched: false, why: '规则判定不需要搜' };
    plan = { search: true, query: q, deep: false, why: '退回规则' };
  }

  if (!plan.search) {
    log.info(`预搜索：不搜（${plan.why || ''}）`);
    return { searched: false, why: plan.why };
  }

  const query = String(plan.query ?? '').trim().slice(0, 100);
  if (!query) return { searched: false, why: '决策给了 search 但没给 query' };

  const deep = plan.deep === true;
  log.info(`预搜索：「${t.slice(0, 24)}」→ 搜「${query}」${deep ? '（并读正文）' : ''}`);

  let results = [];
  try {
    results = await search(query, { limit: cfg.results ?? 5 });
  } catch (e) {
    log.warn(`预搜索：搜索失败 ${e.message}`);
    return { searched: true, query, deep, why: plan.why, block: '', results: 0, error: e.message };
  }

  // ── ⚠️ 中文内容**百度比 Bing 强得多**，所以按「百度 → 维基 → Bing」多源找 ──
  //
  // 2026-09-12 实测（同样的中文网络梗）：
  //   · Bing   → **三个全失败**：彩票网站 / 卢浮宫 / 微软帮助页 / 塑料分类。
  //             而且它**从不返回空**，总是吐一堆无关内容 —— 比搜不到更糟。
  //   · 百度   → **三个全命中**：
  //       「误闯天家」→ 误闯天家(网络流行词) - 百度百科
  //       「竹知了」  → "竹知了"是什么梗?为何会火遍网络?
  //       「公共厕所」→ 说女人是"公共厕所"是什么意思?
  //   · 维基   → 覆盖不全但可靠（「竹知了」→ 華為竹知了事件；
  //              「公共厕所」→ 公共廁所 (隱語)）；「误闯天家」只给同名电影。
  //
  // ⚠️ 百度会弹验证码（实测：连续打 4 次就中）。所以**当成"能救就救"的源**，
  //    拿不到就静默跳过，不能让它拖累主流程。
  {
    const { baiduSearch, wikiSearch, entityOf, isJunkResult } = await import('./search.js');
    const ent = entityOf(query);
    const better = [];
    // ① 百度：中文内容首选（用"实体 + 是什么梗"这种更贴近人问法的词）
    try {
      const baw = await baiduSearch(ent ? `${ent} 是什么梗` : query, 4);
      const ok = baw.filter((r) => !isJunkResult(r));
      if (ok.length && (!ent || ok.some((r) => r.title.includes(ent)))) {
        better.push(...ok);
        log.info(`预搜索：百度命中「${ent || query}」→ ${ok[0].title.slice(0, 30)}`);
      }
    } catch (e) {
      log.debug(`预搜索：百度失败 ${e.message}`);
    }
    // ② 维基：可靠的补充（覆盖不全，但从不给垃圾）
    if (ent && ent.length >= 2) {
      try {
        const wiki = await wikiSearch(ent, 3);
        if (wiki.length) {
          const { wikiExtract } = await import('./search.js');
          const top = wiki.find((w) => w.title.includes(ent)) ?? wiki[0];
          const body = await wikiExtract(top.title);
          if (body) top.snippet = body;
          better.push(top, ...wiki.filter((w) => w !== top));
        }
      } catch (e) {
        log.debug(`预搜索：维基失败 ${e.message}`);
      }
    }
    // 合并：好的放前面，Bing 的去重后跟在后面（有总比没有好）
    if (better.length) {
      const seen = new Set(better.map((r) => r.title));
      results = [...better, ...results.filter((r) => !seen.has(r.title))];
    }
  }

  // 搜不到有用结果 → 换更精准的词再试一次（老逻辑里有，别丢）
  if (!results.length) {
    const { searchSmart } = await import('./search.js');
    try {
      results = await searchSmart(query, { limit: cfg.results ?? 5 });
    } catch {}
  }

  // ── ⚠️ 搜偏了就自动降级重搜（2026-09-12 实测总结的规律）──
  //
  // 对比实测（同一个梗，不同查询词，结果天差地别）：
  //   搜「竹知了 梗」    → ❌ 竹（禾本科竹亚科植物）_百度百科   ← Bing 把词**拆开了**
  //   搜「"竹知了"」     → ✅ 竹知了_百度百科 / 「一个网络梗为何引发巨大争议」
  //   搜「误闯天家 梗 出处」→ ❌ 误（汉字）_百度百科
  //   搜「"误闯天家"」    → ✅ 误闯天家（网络流行词）_百度百科
  //
  // **两条经验**：
  //   ① 模型给查询堆的通用词（梗/出处/什么意思）越多，Bing 越容易跑偏
  //   ② 中文多字词不加引号会被 Bing **拆词**（「竹知了」→「竹」），
  //      加英文引号强制整词精确匹配就好了
  //
  // 判据统一是：**结果里有没有出现"实体"（查询里最长的中文段）**。
  // 没出现 = 搜偏了，就往下试更好的查询。
  // ── ⚠️ 搜偏了就自动降级重搜（2026-09-12 实测总结的规律）──
  //
  // ⚠️⚠️ **触发条件必须严格**。我第一版写得太宽（"没有评测味的词就算搜偏"），
  //    结果把**本来是对的**结果也换掉了：搜「公共厕所是什么梗」本来能拿到
  //    哔哩哔哩的梗科普，被我换成了「雷电模拟器官网」；「竹知了」被换成
  //    「Walmart Stores Near Me」。**改一个东西、弄坏另一个**（真实踩过）。
  //
  //    所以现在只用**一个**硬判据：**实体有没有出现在结果里**。
  //    · 实体存在且**一次都没出现** → 确定搜偏了，才重搜
  //    · 实体不存在（查询太泛，抽不出实体）→ **不动**，保持原结果
  //
  // 对比实测（说明为什么"实体出现"是个可靠的判据）：
  //   搜「竹知了 梗」      → ❌ 竹（禾本科竹亚科植物）_百度百科   ← 没有「竹知了」
  //   搜「"竹知了"」       → ✅ 竹知了_百度百科                 ← 有
  //   搜「华为折叠屏和苹果哪个好」→ ❌ 华为商城 / 华为官网        ← 没有「华为折叠屏」以外的有效信息
  //
  // 重搜顺序（由轻到重，谁先命中实体就用谁）：
  //   ① 补意图词（实测 缺点 对比）
  //   ② 洗掉通用词
  //   ③ 加引号强制整词匹配
  //   ④ 换引擎（DuckDuckGo）—— 但 DDG 会限流，拿不到就跳过
  if (results.length) {
    const { simplifyQuery, entityOf, quoteEntity, resultsMentionEntity, withReviewIntent } =
      await import('./search.js');
    const entity = entityOf(query);
    // **唯一的触发条件**：抽不出实体 → 不动；抽得出但没出现 → 重搜
    const needRetry = !!entity && !resultsMentionEntity(results, entity);

    if (needRetry) {
      const tries = [];
      // ① 补意图词：搜「华为折叠屏和苹果哪个好」只会得到厂商官网，
      //    补成「… 实测 缺点 对比」就能拿到真正的对比文章（实测）
      const reviewy = withReviewIntent(query);
      if (reviewy !== query) tries.push({ q: reviewy });
      // ② 洗掉通用词
      const simpler = simplifyQuery(query);
      if (simpler && simpler !== query) tries.push({ q: simpler });
      // ③ 加引号强制整词匹配
      const quoted = quoteEntity(query);
      if (quoted !== query) tries.push({ q: quoted });
      // ④ 直接拿实体本身搜（最干净）
      const quotedEntity = `"${entity}"`;
      if (!tries.some((t) => t.q === quotedEntity)) tries.push({ q: quotedEntity });

      // ⚠️ **不做换引擎重试**（2026-09-12 试了又撤）。
      //    原因：DDG 对自动化访问会返回 **HTTP 202 + 反爬挑战页**，
      //    而那个页面的正文里**碰巧带着各种词** —— 于是"命中实体"的判据被绕过，
      //    把「雷电模拟器官网」「Walmart」「YouTube Music」「豆瓣插件」当成结果塞给模型。
      //    **比搜不到更糟**（模型会当真）。所以只做同一个引擎（Bing）内的换词。

      for (const t of tries) {
        try {
          const retry = await search(t.q, { limit: cfg.results ?? 5 });
          if (retry.length && resultsMentionEntity(retry, entity)) {
            log.info(
              `预搜索：原查询搜偏了（「${entity}」没出现在结果里）→ 换成「${t.q}」`,
            );
            results = retry;
            break;
          }
        } catch {}
      }
    }
  }

  // 需要深读时，挑一条最相关的把正文读进来
  // ⚠️ readFromResults 返回的是**拼好的文本块**（不是对象），别当成对象用。
  let pageText = '';
  if (deep && results.length) {
    try {
      pageText = await readFromResults(results, query);
    } catch (e) {
      log.debug(`预搜索：读正文失败 ${e.message}`);
    }
  }

  const block = buildBlock({ query, results, pageText, deep, why: plan.why });
  return {
    searched: true,
    query,
    deep,
    why: plan.why,
    block,
    results: results.length,
    read: pageText ? 'yes' : '',
  };
}

/** 拼成给主模型看的材料 */
function buildBlock({ query, results, pageText, deep, why }) {
  const parts = ['', '# 【联网查到的资料】系统**已经替你查过了**', ''];
  parts.push(`搜索词：${query}`);
  if (why) parts.push(`（查它的原因：${why}）`);

  // 网页正文（已经带着自己的小标题和说明，直接附上）
  if (pageText) parts.push(pageText);

  if (results.length) {
    parts.push('', '## 搜索结果（标题 + 摘要）');
    for (const [i, r] of results.entries()) {
      parts.push(`${i + 1}. ${r.title}`, `   ${String(r.snippet ?? '').slice(0, 200)}`, `   来源：${r.url}`);
    }
  } else {
    parts.push('', '⚠️ **没搜到有用结果**（或者网络出问题了）。');
  }

  parts.push(
    '',
    '## 怎么用这些资料',
    '- **就当自己已经看过、知道了**，直接用你自己的话答。**绝对不要说**「我查了一下」',
    '  「搜到的资料显示」「根据网上信息」这种话 —— 真人聊天不会念检索报告。',
    '- **别把资料原文念出来**，也别分点罗列，挑重点用你的语气说。',
    '- **资料和知识库冲突时，以知识库为准**（网页可能过时）。',
    '- 资料里没有的细节**别编** —— 不确定就说不确定。',
    '- 资料不够回答时，老实说「不太确定」，别硬凑。',
  );
  return parts.join('\n');
}
