/**
 * 搜索规划：先让模型想清楚「该搜什么」，再去搜。
 *
 * 为什么不能靠正则洗词（用户反馈「太呆板」）：
 *   用户说「你不是说你要回头补剧情吗，你现在知道剧情了吗」
 *   → 正则怎么洗都洗不出「梦限大 动画」这种正确的搜索词，
 *     因为它需要**理解上下文**（前面聊的是梦限大）**和意图**（要的是动画剧情）。
 *
 * 所以这里用一次便宜的模型调用做「查询规划」。先用 chat（快，1~2 秒），
 * 不行再退到规则。
 */
import { config } from './config.js';
import { looksInternal } from './search.js';
import { log } from './log.js';
// ⚠️ 2026-09-15 补：搜索规划也是**直接 fetch** 的，原来**没记账**。
//    这条路每触发一次搜索就跑一次，而且 user 里带**整段群聊上下文**，
//    单次输入不小 —— 不记账的话余额和账本会越差越多。
import { record as recordSpend } from './spend.js';

const PLAN_PROMPT = `你要帮一个 QQ 群客服机器人决定「这句话该搜什么」。

## 你的任务

读下面这句话（可能还带了群里的上下文），输出**一句话的搜索关键词**，用来上网查资料。

## 规则

- **只输出搜索关键词本身**，不要解释、不要引号、不要标点符号。
- 关键词要**具体**，能直接扔进搜索引擎。
- **用实体全名**，别用代词：
  - ❌「这个」「那个」「它」 → ✅ 具体名字
  - ❌「梦限大」→ ✅「梦限大MewType 动画」（有全名就用全名）
- **加上意图词**：问剧情加「剧情」，问角色加「角色」，问什么时候播加「播出时间」。

## ⚠️ 最重要的一条：**遇到「专有名词」就搜**

**只要句子里出现一个具体名字 —— 歌名、番剧名、游戏名、角色名、梗、小说、电影、
主播、软件、地名 —— 而你不确定它是什么，就要搜。**

⚠️ 因为这些词**字面上像普通东西，其实是有出处的名字**，不搜就会被当成字面意思理解。
真实踩过：群友说「给我来碗**忘情牛肉面**」，机器人没搜，**当成了一道菜**，
回了句「忘情的没有，我这一台不睡觉的机子和本人——你要哪个」——
其实那是**王琪的一首歌**，认出来的话完全可以接「你这是想忘谁啊」。

常见的坑：歌名 / 影视剧名 / 动漫名 / 网络梗 / 游戏黑话 / 他人昵称。

**⚠️ 但「专有名词」指**外面世界**的名字，不包括本服务器自己的东西。**
服务器内部的地名、机构、人、线路、机器（「安岛港」「东心乡」「梦茏集团」
「Luminiflux」「高铁几号线」）**都是群里的内部话题，网上搜不到，一律 NONE** ——
那些答案在知识库里，不在互联网上。
（判断方法：这个词是**这个服务器里造出来的**，还是**外面世界本来就有的**？
前者 → NONE，后者 → 搜。）

- **不要照抄整句话**。一句话里的客套、语气、重复都要丢掉。
- 如果这句话其实**不需要联网查**（比如纯闲聊、纯情绪、服务器内部问题），
  就只输出一个词：NONE
- 如果给了群聊上下文，**用它补全代词**（「那个」指的是上文提到的什么）。

## 例子

输入：你不是说你要回头补剧情吗，你现在知道剧情了吗
（上下文：前面在聊梦限大）
输出：梦限大MewType 动画 剧情

输入：你看过 MyGO 吗
输出：MyGO 动画 剧情

输入：这个梗是什么意思
（上下文：有人发了「鸡同鸭讲」）
输出：鸡同鸭讲 梗 出处

输入：给我来碗忘情牛肉面
输出：忘情牛肉面 歌曲

输入：你听过《孤勇者》吗
输出：孤勇者 歌曲

输入：今天那个黑神话你玩了吗
输出：黑神话悟空 游戏

输入：服务器怎么进
输出：NONE

输入：我太没用了
输出：NONE

输入：今天天气不错啊
输出：NONE

只输出一行。`;

/**
 * 让模型规划搜索词。
 * @param {string} text 用户这句话
 * @param {string} [context] 群聊上下文（帮它消解代词）
 * @param {{signal?:AbortSignal}} opts
 * @returns {Promise<{query:string|null, raw:string}>} query 为 null 表示不用搜
 */
export async function planSearch(text, context = '', opts = {}) {
  // 明显的内部/闲聊消息直接返回，不浪费一次模型调用
  if (looksInternal(text)) {
    log.debug('搜索规划：规则判定为内部/闲聊，跳过');
    return { query: null, raw: '(跳过)' };
  }

  const baseURL = String(config.llm.baseURL ?? '').replace(/\/+$/, '');
  const key = config.llm.apiKey;
  if (!baseURL || !key) return { query: null, raw: '（没配模型）' };

  const user = context
    ? `# 群聊上下文（帮你理解代词）\n${context}\n\n# 这句话\n${text}`
    : text;

  const body = {
    // 用便宜的模型做规划 —— 这活儿简单，不需要贵的
    model: config.search?.plannerModel ?? config.llm.model,
    // ⚠️ 原来只给 60 —— 而主模型是 deepseek-flash（推理模型），
    //    思考一下就吃光，正文吐不出来，规划静默失败（退回规则搜索）。
    //    规划的输出其实很短（一个搜索词或 NONE），但**思考要占 token**，
    //    所以这里给足，并且关掉思考（这活儿不需要推理）。
    max_tokens: 800,
    thinking: { type: 'disabled' },
    temperature: 0,
    messages: [
      { role: 'system', content: PLAN_PROMPT },
      { role: 'user', content: user },
    ],
  };

  try {
    const r = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal ?? AbortSignal.timeout(config.search?.planTimeoutMs ?? 15000),
    });
    if (!r.ok) {
      log.debug(`搜索规划失败 HTTP ${r.status}`);
      return { query: null, raw: '' };
    }
    const j = await r.json();
    try {
      if (j.usage) recordSpend({ model: body.model, usage: j.usage });
    } catch (e) {
      log.debug(`记账失败（不影响主流程）：${e.message}`);
    }
    const raw = String(j.choices?.[0]?.message?.content ?? '').trim();
    if (!raw) return { query: null, raw: '' };

    const first = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] ?? '';
    if (!first || /^NONE$/i.test(first)) {
      log.info(`搜索规划：不需要搜（模型答 ${JSON.stringify(first)}）`);
      return { query: null, raw };
    }

    // 清掉模型可能加上的引号/标点
    const q = first
      .replace(/^["'「『]+|["'」』]+$/g, '')
      .replace(/[。！？!?，,；;]+$/g, '')
      .trim()
      .slice(0, 60);

    if (!q || /^NONE$/i.test(q)) return { query: null, raw };
    log.info(`搜索规划：「${text.slice(0, 24)}」→ 搜「${q}」`);
    return { query: q, raw };
  } catch (e) {
    log.debug(`搜索规划出错：${e.message}`);
    return { query: null, raw: '' };
  }
}
