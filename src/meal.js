/**
 * 「她吃了没」状态机（2026-09-17 用户要求）。
 *
 * 用户原话：
 *   「可以加个**吃饭的状态机**，有什么影响吃饭的事件会被计入，
 *     下次有人喊她，他自己就知道**吃过没有了**，然后她**吃饭的时长可以设定为 10 分钟**」。
 *
 * ## 为什么需要它
 *
 * 她会在剧情里、在群里随口说「我去吃饭了」「先吃口饭」——
 * 但那只是**一句话**，不是**状态**：说过就过去了，谁都不记得。
 * 于是过二十分钟群友喊「一起吃饭吗」，她可能又说「好」——
 * 等于一天吃了两顿，而群友记得她刚说过要去吃。这类"没记性"特别伤人设。
 *
 * 所以这里把「吃饭」做成一个**有寿命的状态**：
 *   · 她说「去吃 / 在吃」→ `eating`，**默认 10 分钟**后自动变成 `done`（吃完了）
 *   · 她说「吃完了 / 吃过了」→ `done`
 *   · 她说「不吃了 / 还没吃 / 不饿」→ `none`
 * 然后每次给她拼提示词时把当前状态带上 —— 有人喊她，她自己就知道吃过没有。
 *
 * ## 几个刻意的设计
 *
 * ⚠️ **只处理她自己说的话**（`note()` 的调用点都在"她发出去之后"）。
 *    群友说「我吃饭去了」跟她没关系，绝不能记成她的状态。
 *
 * ⚠️ **问句一律不算**（`你吃了吗`「吃饭了没」）——
 *    她在**问别人**，不是在报自己的状态。第一版没挡这个，
 *    "吃饭了吗"会把她的状态改成"正在吃饭"。
 *
 * ⚠️ **判据顺序是 `done` → `none` → `eating`**：
 *    「刚吃完了」里既有"吃完"也有"吃"，必须先判 `done`；
 *    而**放宽之后**「还没吃饭」里同样有"吃 + 饭"，所以"否定"必须排在"正在吃"前面。
 *
 * ⚠️ **状态只有一个，不分群** —— 她是一个人，在同一时刻不可能既在 A 群吃又在 B 群没吃。
 *    但**谁喊她**是分群的（提示词本来就按群拼）。
 *
 * ⚠️ 落盘沿用 `digest.js` / `qzone.js` / `tic.js` 的做法（写 `.tmp` 再 rename），
 *    而且**测试必须隔离**（`QQBOT_MEAL_FILE`），绝不能让套件写进真实状态。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { ROOT, config, CONFIG_FILE } from './config.js';
import { log } from './log.js';

const STATE_DIR = join(ROOT, 'state');

/**
 * 状态文件落在哪 —— 和 `tic.js` 同一套三步优先：
 *   ① `QQBOT_MEAL_FILE` 显式指定（单测用）
 *   ② 配置文件带 `test` → 隔离到 `state/__test-*.json`（跑套件时自动生效）
 *   ③ 否则才是真实的 `state/meal.json`
 */
function stateFile() {
  const explicit = process.env.QQBOT_MEAL_FILE;
  if (explicit) return join(ROOT, explicit);
  const cfgName = basename(CONFIG_FILE ?? '');
  if (/test/i.test(cfgName)) {
    return join(STATE_DIR, `__test-${cfgName.replace(/\.ya?ml$/i, '')}-meal.json`);
  }
  return join(STATE_DIR, 'meal.json');
}

const STATE_FILE = stateFile();

/** 测试专用：看它把状态落在哪了 */
export function path() {
  return STATE_FILE;
}

const cfg = () => config.meal ?? {};
const enabled = () => cfg().enable !== false;

/** 「在吃」这个状态活多久（毫秒）。用户拍板：默认 **10 分钟**。 */
export const DEFAULT_MINUTES = 10;
const minutes = () => {
  const v = Number(cfg().minutes);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MINUTES;
};

/**
 * 吃饭状态**最多留几天**（2026-09-18 用户要求：「吃饭状态保留两天的就行了」）。
 *
 * ⚠️ 为什么必须有这条：`done` 是**不带直到期**的（`until: 0`）——
 *    没有它的话，两天前那句"我吃过了"会一直挂着，
 *    她隔天还跟人说"我刚吃过"，比没记性更怪。
 *    超过这个天数 → 直接当**没吃**（`none`），提示词里也不再提。
 */
export const DEFAULT_KEEP_DAYS = 2;
const keepMs = () => {
  const v = Number(cfg().keepDays);
  return (Number.isFinite(v) && v > 0 ? v : DEFAULT_KEEP_DAYS) * 24 * 3600 * 1000;
};

/**
 * 关键词表。
 *
 * ⚠️ 只看**她自己发出去的话**，而且**问句先被挡掉**（见 `note()`），
 *    所以这里可以放心写"吃饭了"这种词 —— 它不会被别人的问句误触发。
 * ⚠️ 顺序有意义：先判 `done`（吃完），再判 `eating`（在吃）。
 */
const WORDS = {
  done: ['吃完了', '吃过了', '刚吃完', '吃好了', '吃饱了', '吃完回来', '吃过饭了', '吃完啦'],
  eating: ['去吃饭', '吃饭去', '先去吃', '吃个饭', '去食堂', '下楼吃', '出去吃', '去吃了', '干饭', '吃饭了', '先吃饭'],
  none: ['不吃了', '还没吃', '没吃饭', '不饿', '不想吃'],
};

const wordsOf = (kind) => {
  const w = cfg()[kind];
  if (Array.isArray(w) && w.length) return w.map((x) => String(x ?? '').trim()).filter(Boolean);
  return WORDS[kind];
};

/**
 * ⚠️⚠️ 宽松判据（2026-09-18 用户要求「放宽吧」）。
 *
 * 她说话很活：「下楼吃碗牛肉面」「出门吃点东西」「去食堂随便吃点」——
 * 那十几个写死的关键词**覆盖不住**（实测「我**去楼下**吃碗牛肉面」压根不命中）。
 *
 * 所以再加一层：**含"吃" + 命中食物/吃饭场景词**就算。
 * ⚠️ 但只放宽到"高置信"为止 —— 下面两张表就是边界：
 *    · `NOT_MEAL`：**"吃×"但不是吃饭**（吃瓜 / 吃惊 / 吃亏…）→ 一律不记
 *    · `NEG_MEAL`：**否定**（还没吃 / 不吃 / 不饿）→ 记成"没在吃"，不是"在吃"
 *    宁可不记，也不要把这些记成"正在吃饭"—— **记错比不记更伤人设**
 *    （她会跟人说"我刚吃过"，而其实压根没吃）。
 */
const NOT_MEAL = ['吃瓜', '吃惊', '吃亏', '吃力', '吃瘪', '吃醋', '吃土', '吃鸡', '吃相', '吃灰'];
const MEAL_OBJ = [
  '饭', '菜', '面', '粉', '粥', '汤', '餐', '食堂', '外卖', '宵夜', '夜宵',
  '早餐', '早饭', '午餐', '午饭', '中饭', '晚餐', '晚饭', '东西', '口', '碗', '顿',
  // ⚠️ 2026-09-20 加宽（用户要求「判断都扩宽一点」）：**具体的食物名**也收进来 ——
  //    她点单时说的是"牛肉面""饺子""烤肉"，不是笼统的"饭"。
  '米线', '拉面', '刀削', '馄饨', '饺子', '包子', '馒头', '烧饼', '煎饼', '汉堡',
  '炸鸡', '薯条', '披萨', '烤肉', '烧烤', '串', '火锅', '麻辣烫', '冒菜', '盖饭',
  '炒饭', '拌饭', '便当', '寿司', '拉条', '螺蛳粉', '米皮', '凉皮', '豆花', '豆浆',
  '奶茶', '咖啡', '可乐', '啤酒', '饮料', '水果', '零食', '面包', '蛋糕', '冰淇淋',
];
const NEG_MEAL = ['还没', '没吃', '不吃', '不想吃', '没胃口', '不饿', '没空吃'];

/**
 * ⚠️⚠️ 2026-09-20 新增（用户要求「判断都扩宽一点」）：
 * **"点了什么"也算在吃** —— 因为人点单时**不说"吃"字**。
 *
 * 真实踩过：她被群友拐去吃面，说的是「**牛肉面吧，加个蛋** 你请客啊」——
 * 里面有食物词（面），就是没有"吃" → 上面那条判据完全不命中 → 状态机一点没记，
 * 用户来问「状态机运行正常吗」。
 *
 * ⚠️ 意愿词收得紧一点，别把正常说话都算进来：
 *    · 上面**已经先挡掉**了 `NOT_MEAL`（吃瓜/吃亏）和 `NEG_MEAL`（不吃/不饿）；
 *    · **问句在上游就被挡了**（`你吃什么面啊` 走不到这里）；
 *    · 所以这里只认"点单/要东西"那种语气。
 */
const ORDER_HINT = /(吧|啊|要|来|点|加|给我|我想|我吃|我喝|吃个|来碗|来个|整一个|就行)/;

/** 宽松判据 → 'done' | 'none' | 'eating' | ''（认不出来就不记） */
function looseKind(t) {
  if (NOT_MEAL.some((w) => t.includes(w))) return '';
  if (NEG_MEAL.some((w) => t.includes(w))) return 'none';
  if (/吃(完|过|好|饱)了?/.test(t)) return 'done';
  // ⚠️ 原来这里要求**必须有"吃"字** → 点单式说法（"牛肉面吧"）全漏 → 见上面 ORDER_HINT
  if (MEAL_OBJ.some((w) => t.includes(w)) && (t.includes('吃') || ORDER_HINT.test(t))) {
    return 'eating';
  }
  return '';
}

/** {status:'none'|'eating'|'done', at:number, until:number, what:string, source:string} */
let state = { status: 'none', at: 0, until: 0, what: '', source: '' };

export function reload() {
  try {
    if (!existsSync(STATE_FILE)) return;
    const j = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    const st = String(j?.status ?? 'none');
    state = {
      status: ['eating', 'done'].includes(st) ? st : 'none',
      at: Number(j?.at ?? 0) || 0,
      until: Number(j?.until ?? 0) || 0,
      what: String(j?.what ?? ''),
      source: String(j?.source ?? ''),
    };
  } catch (e) {
    log.debug(`吃饭状态读取失败（当作没吃）：${e.message}`);
    state = { status: 'none', at: 0, until: 0, what: '', source: '' };
  }
}

function save() {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 0), 'utf8');
    renameSync(tmp, STATE_FILE);
  } catch (e) {
    log.debug(`吃饭状态写盘失败：${e.message}`);
  }
}

/**
 * 从**她自己说的一句话**里抽吃饭状态。
 *
 * @param {string} text 她说的话（不是群友的）
 * @param {string} [source] 来源，写进日志/状态方便排查（如 '剧情第 3 段'）
 * @returns {boolean} 是否改变了状态
 */
export function note(text, source = '') {
  if (!enabled()) return false;
  const t = String(text ?? '').trim();
  if (!t) return false;
  // ⚠️ **问句不算** —— 她在问别人「你吃了吗」，不是在报自己的状态。
  //    这条不加的话，"吃饭了吗"会把状态改成"正在吃"（真实踩过）。
  if (/[?？]/.test(t) || /(吗|呢)[。！!～~]*$/.test(t)) return false;

  const now = Date.now();
  const hit = (kind) => wordsOf(kind).some((k) => t.includes(k));
  const loose = looseKind(t);
  // ⚠️ 顺序定死 **done → none → eating**（放宽之后"还没吃饭"里也含"吃 + 饭"，
  //    所以"否定"必须排在"正在吃"前面，不然会把"还没吃"记成"正在吃"）
  const isDone = hit('done') || loose === 'done';
  const isNone = hit('none') || loose === 'none';
  const isEating = hit('eating') || (!isNone && loose === 'eating');

  // ⚠️ 2026-09-18 用户要求：**把"吃了什么"也记下来**。
  //    做法是**直接存她那句话的原文** —— 食物名是开放的（牛肉面 / 盖饭 / 泡面 / 楼下那家…），
  //    用关键词抠根本抠不全；存原话，模型自己就知道该怎么答"你吃的什么"。
  const what = t.slice(0, 60);

  if (isDone) {
    state = { status: 'done', at: now, until: 0, what, source };
    save();
    log.info(`[吃饭] → 吃过了（${source || '群里'}）：${what}`);
    return true;
  }
  if (isNone) {
    state = { status: 'none', at: now, until: 0, what, source };
    save();
    log.info(`[吃饭] → 没在吃（${source || '群里'}）：${what}`);
    return true;
  }
  if (isEating) {
    state = {
      status: 'eating',
      at: now,
      until: now + minutes() * 60 * 1000,
      what,
      source,
    };
    save();
    log.info(`[吃饭] → 正在吃，${minutes()} 分钟后自动算吃完（${source || '群里'}）：${what}`);
    return true;
  }
  return false;
}

/**
 * 读当前状态 —— **顺手处理过期**：
 * `eating` 到点了就自动变成 `done`（用户说的"吃饭时长 10 分钟"就是这个意思）。
 */
export function current(now = Date.now()) {
  if (state.status === 'eating' && state.until && now >= state.until) {
    state = { ...state, status: 'done', at: state.until };
    save();
    log.info('[吃饭] 到点了 → 自动算吃过了');
  }
  // ⚠️ 超过保留期（默认 **2 天**）→ **忘掉**，当没吃（2026-09-18 用户要求）。
  //    没有这条的话，两天前那句"我吃过了"会一直挂着，她隔天还说"我刚吃过"。
  if (state.status !== 'none' && state.at && now - state.at > keepMs()) {
    log.info(`[吃饭] 状态超过 ${Math.round(keepMs() / 86400000)} 天 → 忘掉（当没吃）`);
    state = { status: 'none', at: 0, until: 0, what: '', source: '' };
    save();
  }
  return { ...state };
}

/** 相对时间（"12 分钟前"），提示词里要用 */
function agoText(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

/**
 * 给提示词用的一段；没在吃也没吃过 → 返回空串（不占提示词）。
 *
 * ⚠️ 措辞都带**行为指令**，不是只报状态 ——
 *    只写"你吃过了"她会当背景信息忽略掉，得写清"有人喊你别再答应一顿"。
 */
export function hint(now = Date.now()) {
  if (!enabled()) return '';
  const s = current(now);
  if (s.status === 'none') return '';

  if (s.status === 'eating') {
    const left = Math.max(0, Math.round((s.until - now) / 60000));
    return [
      '## 🍚 你现在**正在吃饭**（真实状态，别当成随口一说）',
      '',
      `你 ${agoText(now - s.at)}开始吃的，估计还要 ${left} 分钟左右。`,
      // ⚠️ 2026-09-18：把"吃了什么"也给她（存的是她那句话的原文）——
      //    不然群友问"你吃的什么"，她只能现编一个。
      ...(s.what ? [`你当时说的是：「${s.what}」—— 有人问吃的什么就照这个说，别另编一个。`] : []),
      '⚠️ 这期间有人叫你一起吃饭 / 问你在干嘛 → 直说**正在吃**，**别又答应一顿**。',
      '⚠️ 别人问你别的（正事、服务器、聊天）照样答，吃饭只影响"要不要再吃一顿"这件事。',
    ].join('\n');
  }

  return [
    '## 🍚 你今天已经吃过饭了',
    '',
    `你 ${agoText(now - s.at)}吃的。`,
    ...(s.what ? [`你当时说的是：「${s.what}」—— 有人问吃的什么就照这个说，别另编一个。`] : []),
    '⚠️ 有人现在叫你一起吃饭 → 可以说**刚吃过 / 不饿**，或者说"陪你坐会儿" ——',
    '  **但别再答应吃一顿**（同一顿吃两次，群友会觉得你没记性）。',
    '⚠️ 但**这不是万能的**：如果对方明说是**下一顿**（早饭 / 午饭 / 晚饭、或者已经隔了很久），',
    '  那就是新的一顿，正常答应就行。',
  ].join('\n');
}

/** 给管理界面/自检看 */
export function status(now = Date.now()) {
  const s = current(now);
  return {
    ...s,
    enable: enabled(),
    minutes: minutes(),
    leftMs: s.status === 'eating' ? Math.max(0, s.until - now) : 0,
    path: STATE_FILE,
  };
}

/** 测试专用 */
export function __clear() {
  state = { status: 'none', at: 0, until: 0, what: '', source: '' };
  save();
}

// ⚠️ 模块加载时就恢复（和 `tic.js` 同一个做法）——
//    不在这里加载的话，机器人一重启"她吃过了"就忘了，这道闸等于没接上。
reload();
