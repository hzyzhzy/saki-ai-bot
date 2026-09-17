/**
 * 「有人在骂她」—— 好感度要不要减分，靠它判（2026-09-17 用户要求）。
 *
 * 用户原话：
 *   「日常互动影响的好感度可以改改，不能每次和她说话都是加，
 *    有人骂她那肯定得减，而且减2，因为加上来很容易。」
 *
 * ## ⚠️⚠️ 设计原则：**宁可漏，不可误伤**
 *
 * 减分是很重的惩罚（`-2` 顶掉两次正常互动，而且她语气会跟着变冷），
 * 所以误伤一个老群友随口说的「你个笨蛋」比漏掉一句真骂**更糟** ——
 * 前者会让一个天天来聊天的人莫名其妙被冷落，而且他根本不知道自己哪儿说错了。
 *
 * 两条硬约束：
 *
 * 1. **只认明确的侮辱词**（脏话级）。
 *    🚫 不认「笨」「烦」「讨厌」「幼稚」这类轻的 —— 熟人之间这些往往是亲昵、
 *       是逗她玩，不是骂。真实群里「你好笨啊」的下一句经常就是「可爱」。
 * 2. **必须同时指向她**（@她 / 提到她的名字）。
 *    「这服务器真垃圾」骂的是服务器，不是她 —— 少了这一条会大面积误伤。
 *    所以本模块**要求调用方把 `segs` 和名字表传进来**，不能只看文本。
 *
 * ## 与「对等还击」的关系（不冲突）
 *
 * 她被骂之后**自己也会还嘴**（见 `persona.md` 第六章「被骂的时候可以对等还击」）。
 * 那件事由提示词管，这里只管**分数**。两件事同时发生才是对的：
 * 她嘴上不吃亏，心里也确实记了这个人一笔。
 *
 * ## 为什么不做「阴阳怪气」
 *
 * 反讽/阴阳靠规则判不了（「您可真是个大聪明」一个脏字没有），
 * 硬做必然大面积误伤；交给模型又要每条消息多花一次调用。
 * 用户说的是**骂**，那就只做骂。
 */

/**
 * 侮辱词表。
 *
 * ⚠️ 加词之前先问自己：**熟人开玩笑会不会用到？** 会 → 别加。
 *   · 「垃圾」「恶心」「闭嘴」都在**故意不收**之列：
 *     「@祥子 这服务器真垃圾」是常见句式，收了就是误伤。
 *   · 短语优先于单字：「蠢货」收，「蠢」不收。
 */
const WORDS = [
  // 直接骂人的
  '傻逼', '傻b', '煞笔', '沙比', '傻叉', '傻X', '傻x',
  '蠢货', '蠢猪', '智障', '弱智', '脑残', '脑瘫', '白痴',
  // ⚠️ 2026-09-17 **移掉了「废物」**（用户拍板）：
  //    某个群友因为一句含「废物」的话被扣了 2 分（50→48），
  //    而这个词在熟人之间**多半是调侃**（「你个废物哈哈哈」），不符合
  //    这个文件头那句「**宁可漏，不可误伤**」。
  //    ⚠️ 别再往这儿加"轻量级"的词：判断标准是**「陌生人当面说这句会不会翻脸」**，
  //       "废物 / 有病 / 神经病 / 蠢货 / 白痴"这类都**不到**那个线（后四个用户暂留）。
  '贱人', '贱货', '混蛋', '王八蛋', '畜生', '杂种', '狗东西',
  // 驱赶 / 诅咒
  '滚蛋', '滚出去', '去死', '死开',
  // 泛骂（仍然要求"指向她"才生效，见文件头约束②）
  '神经病', '有病',
];
// 小写化后再比一次，免得有人写「傻B」「傻X」
const WORDS_LC = WORDS.map((w) => w.toLowerCase());

/**
 * `sb` 这类两字母缩写要单独判 —— 中文没有词边界，
 * 直接 `includes('sb')` 会命中 `asb`、`xhsb` 这种无关串。
 * 所以要求左右都不是字母数字。
 */
const SB_RE = /(^|[^a-z0-9])s\.?b\.?([^a-z0-9]|$)/i;

/**
 * 文本里有没有明确的侮辱词（**不看指向**，只看有没有骂人的词）。
 * @param {string} text
 * @returns {string} 命中的词；没有 = `''`
 */
export function findInsultWord(text) {
  const t = String(text ?? '');
  if (!t) return '';
  const lc = t.toLowerCase();
  for (let i = 0; i < WORDS.length; i++) {
    if (lc.includes(WORDS_LC[i])) return WORDS[i];
  }
  if (SB_RE.test(t)) return 'sb';
  return '';
}

/**
 * 这条消息**是不是在骂她**。
 *
 * @param {Array} segs 消息段（用来认 `@她`）
 * @param {string} text 纯文本
 * @param {{selfId?:string|number, names?:string[]}} [opts]
 *   `names` = 她的名字表（`config.trigger.callNames` + `chat.mention.names` 合一），
 *   用来认「不带 @、但点名骂」的情况（「客服小祥你就是个傻逼」）。
 * @returns {{insult:boolean, why:string, word?:string}}
 */
export function detectInsult(segs, text, opts = {}) {
  const t = String(text ?? '');
  if (!t) return { insult: false, why: '空消息' };

  const word = findInsultWord(t);
  if (!word) return { insult: false, why: '没有侮辱词' };

  // ── 指向她：@她 或者 文本里点她的名 ──
  const selfId = String(opts.selfId ?? '');
  const arr = Array.isArray(segs) ? segs : [];
  if (selfId && arr.some((s) => s?.type === 'at' && String(s?.data?.qq) === selfId)) {
    return { insult: true, why: 'at', word };
  }
  // ⚠️ 名字表可能很大（含 saki / 祥子 这类常见词），所以只在**已经出现侮辱词**之后才查
  //    —— 顺序反过来的话，「saki」出现在一句普通闲聊里也会被拉进来判一次。
  const names = (opts.names ?? []).filter((n) => n && String(n).length >= 2);
  for (const n of names) {
    if (t.includes(String(n))) return { insult: true, why: `名字:${n}`, word };
  }
  return { insult: false, why: '骂的不是她（没 @ 也没点名）' };
}

/** 测试用 */
export function __words() {
  return [...WORDS];
}
