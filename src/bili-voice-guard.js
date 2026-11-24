/**
 * B站评论的**语感闸** —— 三道检查，撞了就不发。
 *
 * ## 出处（2026-10-26：「dsh-bili-scroll 是怎么主动发评论的」→「改」）
 *
 * 抄自 `c1overzz/dsh-bili-scroll` 的 `vendor/bilibili-mcp/mcp_server.py` 里
 * `_style_reason()`（作者注释叫它「治鱼八股」）。他的原话：
 *
 *   > 章程里写"要有具体细节、别客套"，模型照样写"这条我认""值得一看"——
 *   > **禁令没有范例有效、自觉没有拦截可靠** ⇒ 在执行层做最后一道检查
 *
 * 三道检查（他那边就是这个顺序、这个阈值）：
 *   ① 开头**八股黑名单**（正则）—— 最便宜，先挡
 *   ② 跟**自己以前发过的**太像（bigram Jaccard ≥ 0.55）—— 治"每条一个味"
 *   ③ 跟**这条视频现有热评**太像（≥ 0.5）—— 治"跟别的鱼撞车"
 *
 * ⚠️ 撞了就**不发**，把"为什么不行 + 该怎么改"返回给调用方，让它重写**一次**；
 *    再撞就这一轮不发（他那边也是这么收的：「**再被拦就不发**」）。
 *
 * ⚠️ 为什么用 bigram Jaccard 而不是向量相似度：零依赖、几十微秒、够用。
 *    这是抄他的口径，别自己发明一套更"高级"的 —— 换成向量就要多一次模型调用，
 *    而这道闸的意义恰恰是**不发钱也能挡住废句** ✓
 */

/** 开头八股黑名单（**中文场景**，照我们实测过的 AI 味句式写的） */
const LEAD_CLICHE = new RegExp(
  '^\\s*(?:' +
    // 他那边列的（直译过来的那几句）
    '这条(?:我认|我记下了|值得)|我记下了|值得一看|确实值得|不得不说|' +
    '好家伙|这个(?:必须|真的要)|强烈推荐|感谢分享|学到了|受教了|' +
    '作为一个|总之|综上|' +
    // 我们这边实测反复出现的（2026-10-26 从 sent 历史里捞的）
    '真的太|确实是|说实话|讲真|客观(?:地)?说|看完(?:之后|以后)|' +
    '总结一下|有一说一|不得不说|整体(?:来说|上看)|不得不说|' +
    // 「第一/首先」这种作文开头
    '首先|第一[，,、]' +
  ')'
);

/** 整句就是客套、没有具体内容（短句命中就拦）——
 *  ⚠️ 2026-10-26 补：`LEAD_CLICHE` 只管**开头**，可实测还有「说得太好了，感谢分享这些」
 *    这种把客套放后半句的。判据故意收窄成「**短 ≤20 字** + 命中客套词」，
 *    免得把「这期讲得挺好，就是那个音效听着像卡了」这种带内容的也误杀 ✓ */
const EMPTY_PRAISE = /感谢分享|学到了|受教了|说得太(?:好|对)了|讲得(?:太)?好|支持一下|已三连|求(?:个)?关注|一键三连/;

/** 去掉标点/空白，只留字（bigram 用） */
function bare(s) {
  return String(s ?? '')
    .replace(/[\s，,。.！!？?、…~～；;：:""''（）()【】\[\]《》<>—－-]/g, '')
    .trim();
}

/** bigram 集合 */
export function bigrams(s) {
  const t = bare(s);
  if (t.length < 2) return new Set(t ? [t] : []);
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** bigram Jaccard 相似度（0~1） */
export function sim(a, b) {
  const x = bigrams(a);
  const y = bigrams(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const g of x) if (y.has(g)) inter++;
  return inter / Math.max(1, x.size + y.size - inter);
}

/** 阈值（抄他的：自己的 0.55、别人的 0.5） */
export const SELF_MAX = 0.55;
export const OTHER_MAX = 0.5;

/**
 * 这句能不能发？
 *
 * @param {string} text 要发的评论正文
 * @param {{history?:string[], hot?:string[]}} [ctx]
 *   `history` = 自己以前发过的评论正文（最近 30 条就够，读 `state/bili-proactive.json` 的 `sent[].text`）
 *   `hot` = 这条视频现有的热评（页面/接口拿到的前 20 条）
 * @returns {string} 空串 = 可以发；否则 = 为什么不能发（**带改法**，直接喂回模型）
 */
export function styleReason(text, { history = [], hot = [] } = {}) {
  const body = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!body) return '评论是空的。';

  // ① 开头八股
  const m = LEAD_CLICHE.exec(body);
  if (m) {
    return (
      `开头「${m[0].trim()}」是套话（AI 味的起手式）。` +
      '直接说这条视频里的具体东西：「这期讲了什么 + 一个只有看了才说得出的细节」，开头别用套话。'
    );
  }
  // ①' 整句就是客套（短 + 命中），没提任何具体的东西
  if (bare(body).length <= 20 && EMPTY_PRAISE.test(body)) {
    return '整句都是客套（没有一处是"只有看过才说得出来"的细节）。说视频里具体哪一下、哪句话、哪个画面。';
  }

  // ② 跟自己以前发过的太像
  for (const old of history) {
    const s = sim(body, old);
    if (s >= SELF_MAX) {
      return (
        `这句跟你以前发过的「${String(old).slice(0, 18)}…」太像了（相似度 ${s.toFixed(2)}）。` +
        '换开头、换关注点，别套同一个句式。'
      );
    }
  }

  // ③ 跟这条视频的热评撞车
  for (const other of hot) {
    const s = sim(body, other);
    if (s >= OTHER_MAX) {
      return (
        `这条视频底下已经有一句很像的（相似度 ${s.toFixed(2)}）：${String(other).slice(0, 24)}… ` +
        '撞车了 —— 换个角度写，或者这一轮不发。'
      );
    }
  }

  return '';
}
