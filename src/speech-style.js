/**
 * 「这个群的人现在怎么说话」—— 纯统计的发言特征快照（2026-11-07 加）。
 *
 * ## 要解决的问题
 *   bot 说出来的话一眼就能看出是 AI ⇒ 让它持续学「这个群的人怎么说话」，
 *   而不是靠人一条条往里写死。
 *
 * ## 设计上的三条硬约束（别越界）
 *
 * ① **只学"特征"，不学"句子"**。
 *    这里只统计**数字**（平均几个字、多少比例不带句号、多少比例拆成几条发…），
 *    然后写成一段**描述**给她看。
 *    🚫 **绝不收集群友的例句原文再塞进提示词** —— 那她会照着念，
 *    正是「不许写让她复读的话」那条铁律要防的东西 ✗
 *
 * ② **只统计真人**。
 *    排除她自己（`self`）、同类池（`peers`）、不同类池（`otherBots`）、
 *    已知机器人（`teach.bots`）—— 否则她学的是"另一个 AI 怎么说话"，
 *    越学越像 AI ✗
 *
 * ③ **零模型成本**。
 *    全是本地统计，不调 API。每 30 分钟重算一次，结果按群缓存。
 *    统计很小（300 条消息），几毫秒。
 *
 * ## 输出给她的东西长这样（150 字以内）
 *   【这个群的人现在怎么说话（最近 300 条里的真人发言）】
 *   · 一句平均 11 个字，一半以上是 8 字以内
 *   · 大部分句尾不带句号（82%），爱用「啊 / 吧 / 了 / 呢」
 *   · 将近四成会拆成 2~3 条发，不是一段说完
 *   · 表情包和图片占了五分之一
 *   → 你照这个密度说话：短、别工整、可以拆开
 *
 * ⚠️ 这是**描述**，不是让她照抄的句子 —— 所以不违反铁律 ✓
 */
import * as recent from './recent.js';
import { config } from './config.js';
import { log } from './log.js';

/** 每个群一份缓存（统计很便宜，但没必要每条消息都重算） */
const cache = new Map();
const TTL_MS = 30 * 60 * 1000;

/** 这个群里的机器人号（学它们 = 越学越像 AI） */
function botIds(gid) {
  const ids = new Set();
  const add = (v) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach(add);
    else {
      const s = String(v).trim();
      if (s) ids.add(s);
    }
  };
  try {
    const gp = config.groupParams?.[String(gid)] ?? {};
    add(gp.peers);
    add(gp.otherBots);
  } catch {
    /* ignore */
  }
  try {
    add(config.teach?.bots);
  } catch {
    /* ignore */
  }
  try {
    add(config.ownerQQ); // 主人也不算"群友的说话习惯"来源（他是她最熟的人，会把整体带偏）
  } catch {
    /* ignore */
  }
  return ids;
}

/** 这些"消息"没有语言价值，只算噪音 */
const NOISE = /^\[(图片|表情|表情包|空消息|语音|视频|文件|分享|卡片)[^\]]*\]$/;

/**
 * 算这个群的发言特征。
 * @returns {null | {n:number, avgLen:number, shortRatio:number, noPeriodRatio:number,
 *   moodRatio:number, splitRatio:number, mediaRatio:number, topTa:Array<string>}}
 */
export function snapshot(gid) {
  const g = String(gid ?? '');
  if (!g) return null;
  const hit = cache.get(g);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  let items = [];
  try {
    items = recent.recentItems(g, 300) ?? [];
  } catch (e) {
    log.debug(`[说话特征] 取群消息失败：${e.message}`);
    return null;
  }
  const skip = botIds(g);
  const mine = new Set();
  try {
    // 她自己发的（`self: true`）在下面单独排除
    for (const it of items) if (it?.self) mine.add(String(it?.userId ?? ''));
  } catch {
    /* ignore */
  }

  const texts = [];
  let media = 0;
  let total = 0;
  for (const it of items) {
    const uid = String(it?.userId ?? '');
    if (!uid || it?.self === true) continue;
    if (skip.has(uid)) continue;
    const t = String(it?.text ?? '').trim();
    if (!t) continue;
    total++;
    // 纯图片/表情：算"媒体"，不进字数统计
    if (NOISE.test(t) || /^\[(图片|表情)/.test(t)) {
      media++;
      continue;
    }
    const clean = t.replace(/\[[^\]]{1,12}\]/g, '').trim();
    if (clean.length < 2) continue;
    texts.push(clean);
  }
  if (texts.length < 12) {
    // 样本太少就别下结论（新群 / 死群）
    cache.set(g, { at: Date.now(), data: null });
    return null;
  }

  const lens = texts.map((t) => t.length);
  const avgLen = Math.round(lens.reduce((a, b) => a + b, 0) / lens.length);
  const shortRatio = Math.round((lens.filter((n) => n <= 8).length / lens.length) * 100);
  // 句尾带句号的（真人聊天里很少）
  const withPeriod = texts.filter((t) => /[。.]$/.test(t)).length;
  const noPeriodRatio = Math.round((1 - withPeriod / texts.length) * 100);
  // 带语气词的（那是"活人味"的最强信号）
  const moodRe = /[啊呀嘛啦诶呗嘞喔哦哈咯的了呢吧]/;
  const moodRatio = Math.round((texts.filter((t) => moodRe.test(t)).length / texts.length) * 100);
  // 拆条的（同一个人 10 秒内连发 >2 条，这里用"短句占比"近似）
  const splitRatio = shortRatio;
  const mediaRatio = total ? Math.round((media / total) * 100) : 0;

  // 最常见的语气词 Top3（只统计"字"，不沾内容）
  const taCount = new Map();
  for (const t of texts) {
    for (const ch of t) {
      if ('啊呀嘛啦诶呗嘞喔哦哈咯呢吧'.includes(ch)) taCount.set(ch, (taCount.get(ch) || 0) + 1);
    }
  }
  const topTa = [...taCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([c]) => c);

  const data = {
    n: texts.length,
    avgLen,
    shortRatio,
    noPeriodRatio,
    moodRatio,
    splitRatio,
    mediaRatio,
    topTa,
  };
  cache.set(g, { at: Date.now(), data });
  log.info(
    `[说话特征] 群 ${g}：${data.n} 条真人发言 ｜ 平均 ${avgLen} 字、${shortRatio}% 是短句、` +
      `${noPeriodRatio}% 不带句号、${moodRatio}% 带语气词、媒体 ${mediaRatio}%`,
  );
  return data;
}

/**
 * 拼成给她的那一段（没有样本就返回空串）。
 * ⚠️ 只描述**特征**，一句例句都不给 —— 不违反"不许让她复读"的铁律 ✓
 */
/* ⚠️ 下面两块**不依赖本群统计**（是「怎么接话」的行为策略，不是「这个群的数据」）——
 *   所以单独拎出来：**没有样本的群也必须拿到**。
 *   （实测 200000001 近期干净真人发言凑不满 12 条 ⇒ snapshot 返回 null ⇒
 *     原来整块被 `if (!d) return ''` 一起丢掉，冷群永远学不到 ✗） */
const ALWAYS = [
  '',
  '# 【接不上话的时候怎么办（这也是活人味）】',
  '',
  '有人发了一句**你看不懂但明显在玩**的话（抽象梗、谐音、圈内黑话），',
  '硬接容易露怯，装没看见又不像活人。**真人这时候是这么办的**（挑一个，**别连着两次用同一招**）：',
  '',
  '· **把他的话原样接回来** —— 挑他句子里**那两三个字**重复一遍，表示"我听见了、我也觉得有点东西"。',
  '  ⚠️ 只在他**真的接不上**的时候用；⚠️ 复读的是**关键词**不是整句，也**别加解释**（解释了就不像接梗）',
  '· 只回一个语气词（用这个群最常出现的那些）',
  '· 反问回去，让他接着说',
  '· 挑他话里**一个具体的词**接着问 —— 比硬猜意思安全',
  '· 干脆只发表情，不说话',
  '',
  '🚫 **别每次都复读** —— 那是另一种机器人味（一晚上复读三次，比不接还假）✗',
  '🚫 别硬编一个理解（"你是说……吧？"猜错了比不接更尴尬）✗',
  '🚫 别每次都反问（那也成套路了）✗',
  '✅ 真接不上、又不想复读 ⇒ **就发表情 / 或者只应一声** —— 真人经常这样 ✓',
  '',
  '# 【怎么接得让人想笑（手法，不是句子）】',
  '',
  '群友说了一句话，你**用他自己的词**往回推一档，笑点就出来了。四种推法（挑一种，别连着用）：',
  '',
  '· **往极端推**：他说「下次注意点」⇒ 你把它推到**时间或程度的尽头**（一辈子 / 下辈子 / 永世）。',
  '  关键是**用他的词**、只把量级夸张一格，不是换一件事说。',
  '· **往小了推**：他说了件惊天动地的大事，你一句「哦」「行吧」—— 落差就是笑点。',
  '· **顺着他的逻辑推到荒谬**：他说 A 导致 B，你接着问「那是不是还得 C」—— 让他自己听出不对劲。',
  '· **认领成自己的**：他把锅甩给别人，你顺手接过来（「行，怪我」）—— 越平静越好笑。',
  '',
  '⚠️ 三条分寸：',
  '· 🚫 **别解释为什么好笑**（一解释就死）；🚫 别加"哈哈哈"垫场。',
  '· 🚫 别拿**别人的真事 / 身体 / 家人**开玩笑 —— 那是冒犯，不是玩笑 ✗',
  '· ⚠️ 对方是**真的着急 / 真的出事**（东西没了、人受伤了）⇒ **先关心，别开玩笑** ✓',
  '  这一条优先于上面全部：分不清是玩笑还是真事 ⇒ **按真事办**。',
].join('\n');

export function block(gid) {
  if (config.chat?.speechStyle === false) return '';
  const d = snapshot(gid);
  // 没统计样本 ⇒ 只给"怎么接话"那两块（它们本来就不靠数据）
  if (!d) return ALWAYS;
  const ta = d.topTa.length ? d.topTa.join(' / ') : '（不明显）';

  /* ⚠️⚠️ 2026-11-07：措辞必须**跟着数据走**，不能写死"短" ——
   *   实测群 200000007 是「平均 22 字、只有 10% 是短句、98% 不带句号」，
   *   而第一版这里写死了「跟他们一样短」⇒ **自相矛盾**，模型会无所适从 ✗
   *   ⇒ 按平均字数分三档给不同的话：
   *     · ≤12 字：确实短 ⇒ 让她短
   *     · ≥20 字：偏长 ⇒ 让她别切成三五个字，一句说完
   *     · 中间：中性，只强调"别工整" */
  const lenNote =
    d.avgLen <= 12
      ? [
          `⚠️ **你照这个密度说**：跟他们一样短、一样不工整、一样松散。`,
          '· ✅ 可以只接半句、可以不回答、可以把一句话拆成两条发',
        ]
      : d.avgLen >= 20
        ? [
            `⚠️ **这个群的人说话是偏长的（一句 ${d.avgLen} 字左右）** —— 别为了显得"像聊天"就切成三五个字，`,
            '  那样反而突兀。跟着他们的长度走，但**把标点松掉、把话说明白就停**，别写完整段落。',
            '· ✅ 一句二十来字是正常的；🚫 但别写成"首先/其次/总之"那种分点稿子 ✗',
          ]
        : [
            `⚠️ **你照这个密度说**：长度跟他们差不多（一句 ${d.avgLen} 字左右），但**别工整**。`,
            '· ✅ 可以只接半句、可以不回答、可以把一句话拆成两条发',
          ];

  const lines = [
    '',
    `# 【这个群的人现在怎么说话（最近 ${d.n} 条真人发言）】`,
    '',
    `· 一句大约 **${d.avgLen} 个字**，**${d.shortRatio}%** 是 8 字以内的短句`,
    `· **${d.noPeriodRatio}%** 的句子结尾**不带句号**；最常出现的是「${ta}」这几个语气词（${d.moodRatio}% 的句子带语气词）`,
    `· 图片 / 表情占 **${d.mediaRatio}%**`,
    '',
    ...lenNote,
    '· 🚫 别写出"一句话把意思说完整、标点齐全"的那种句子 —— 那是稿子，不是聊天 ✗',
    '· ⚠️ 但**别学他们的用词和梗**（那是抄，不是你的话）—— 学的是**节奏**，不是内容 ✓',
    '',
  ];
  return lines.join('\n') + ALWAYS;
}

/** 测试用 */
export function __clear() {
  cache.clear();
}
