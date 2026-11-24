/**
 * 脱敏层（pseudonymization）—— 只做**本地字符串替换**，不联网、不调模型。
 *
 * ## 为什么要有这一层
 * 模型请求要经过第三方中转（`llm.providers[].baseURL`，可能是别人的站），
 * 而拼给模型的提示词里天然带着真实身份：群号、群名、群友 QQ 号与昵称、
 * 服务器地址，偶尔还有 apiKey。中转方在链路上能看到全文 ⇒ 这些都不该明文过去。
 * 做法：发出去之前把**身份标识**换成 `@U1@` / `@G1@` / `@GN1@` / `@S1@` / `@K1@`，
 * 收到回复再换回来。
 *
 * ## 三条边界（改这个文件之前先看）
 *
 * 1. **只换身份标识，不换正文。** 群聊文字一个字都不动 —— 换了模型就看不懂在聊什么。
 *    所以这里的规则全是"长什么样"（形如群号 / URL / 已知昵称），没有语义判断，
 *    也**没有**关键词快判（那种东西一改说法就漏）。
 *
 * 2. **占位符必须是模型改不动的形状。** 半角 `@U1@`：
 *    · 不含空格、不含全角字符 ⇒ 模型顺手插空格 / 转全角的概率低；
 *    · 不含下划线、星号、尖括号 ⇒ 不会被 markdown 或"XML 标签剥离"吃掉
 *      （踩过的思路：`<NAME_1>` 那种会被当成标签剥掉）；
 *    · 用 `@` 包边 ⇒ 中文行文里不会自然出现，误伤率极低。
 *
 * 3. **一个占位符只对应一个字面值（单向可解）。** 同一个字面值永远同一个占位符
 *    （跨进程也一样，落 `privacy-map.json`），所以 unmask 只要反查、不会歧义。
 *    ⇒ **不做实体归并**：QQ 号 `123456789` 和它的昵称「阿恺」是两条记录、两个占位符。
 *      如果都映射成 `@U1@`，还原时就没法判断该写回哪个（一个占位符只能换回一个字面值）。
 *      "同一实体同一占位符"在这里的定义就是**同一字面值**。
 *
 * ## 性能约束（硬要求）
 * 这是**每条消息必经**的路径（一次请求要过 8 万字的提示词），所以：
 *   · 全程同步字符串操作，**不许**有 await、不许读网络、不许调模型；
 *   · 实体清单（群名 / 昵称）只在**文件 mtime 变了**才重建正则，结果缓存；
 *   · 一万字的目标是 10ms 以内（实测见 `test/privacy.js` 的输出）。
 * ⚠️ 唯一的同步 I/O 是"**分配了新占位符**时落盘"（见 `persist()`）——
 *    已有映射命中时零 I/O，绝大部分消息走这条路。
 *
 * ## 提示词缓存（这条容易被忽略，别改坏）
 * 本项目的 prompt 缓存靠"**前缀逐字节不变**"命中（见 AGENTS 里那条铁律）。
 * 脱敏**不影响**它：同一个实体永远拿到同一个占位符（编号单调、持久化），
 * 所以同一段提示词每轮替换出来的字节完全一致 ⇒ 缓存照样命中。
 * ⚠️ 反过来说：**编号绝不能重排 / 复用**，一旦重排，前缀就变了，缓存全失效。
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { config, ROOT, stateDir } from './config.js';
import { log } from './log.js';

/* ══════════════════════════════════════════════════════════════════
 * 占位符类型
 * ══════════════════════════════════════════════════════════════════ */
const TYPES = ['U', 'G', 'GN', 'S', 'K'];
/*  U  = 人（QQ 号 / 昵称 / 群名片）
 *  G  = 群号
 *  GN = 群名
 *  S  = 服务器地址（URL 里的 host / 裸 IP / 已知域名）
 *  K  = 密钥（sk-* / Bearer * / ark-* …）
 *  ⚠️ 顺序只影响 unmask 正则里 `GN` 要不要排在 `G` 前面（必须排前面，否则
 *     `@GN1@` 会被 `@G` 吃掉前半截）。
 */

/** 映射表最多留多少条（超了按最久没出现淘汰）。20000 条 ≈ 几百 KB，够用很久。 */
const MAX_ITEMS = 20000;

/** 尾部"可能是半个占位符"的候留长度上限 —— 超过它就不是占位符，是普通正文 */
const HOLD_MAX = 32;

/* ══════════════════════════════════════════════════════════════════
 * 路径与状态
 * ══════════════════════════════════════════════════════════════════ */

/** 相对路径都按项目根解析（配置/环境变量里可能写 `state/xxx.json`） */
function rootPath(p) {
  const s = String(p ?? '').trim();
  if (!s) return '';
  return isAbsolute(s) ? s : join(ROOT, s);
}

/**
 * 映射表落盘位置。
 * ⚠️ 默认**跟着号走**（`stateDir()`）—— 三个号是**三个进程**，
 *    共用一份文件会互相覆盖（A 号刚分配的 `@U1@` 被 B 号写的表顶掉 ⇒
 *    `@U1@` 指向两个人 ⇒ 还原出错）。分文件之后各自编号互不干扰。
 * ⚠️ 也支持 `QQBOT_PRIVACY_FILE` 直接指定：自测脚本要用临时文件，
 *    绝不能拿生产那份表做实验。
 */
function mapFile() {
  const env = rootPath(process.env.QQBOT_PRIVACY_FILE);
  if (env) return env;
  try {
    return join(stateDir(), 'privacy-map.json');
  } catch {
    return join(ROOT, 'state', 'privacy-map.json');
  }
}

/** 群名表（`{ groups: { "群号": { name } } }`）—— 自测可覆盖 */
const GROUP_NAMES_FILE = () =>
  rootPath(process.env.QQBOT_GROUP_NAMES_FILE) || join(ROOT, 'state', 'group-names.json');
/** 昵称表（`{ nick: {QQ:名字}, card: {QQ:名片} }`）—— 自测可覆盖 */
const NAMES_FILE = () => rootPath(process.env.QQBOT_NAMES_FILE) || join(ROOT, 'state', 'names.json');

/** 占位符 → { v: 原值, t: 类型, at: 最后出现时间 } */
const items = new Map();
/** `${类型}:${原值}` → 占位符（正向索引，避免每次线性扫） */
const fwd = new Map();
/** 每种类型的当前最大编号（**只增不减**；复用编号会让历史占位符指向别人） */
const seq = Object.fromEntries(TYPES.map((t) => [t, 0]));

let loaded = false;
let needPersist = false;
let warnedPersist = false;
let _lastError = '';
let _lastPersistAt = 0;

/** 只读统计用的计数（调试用，不影响行为） */
const counter = {masked: 0, unmaskCalls: 0, unresolved: 0, streams: 0};

/* ══════════════════════════════════════════════════════════════════
 * 映射表读写
 * ══════════════════════════════════════════════════════════════════ */

/**
 * BOM 防御。
 * ⚠️ `JSON.parse` **不认 BOM**，而 PowerShell 的 `Set-Content -Encoding utf8`
 *    会写 BOM（这个坑在本项目里已经毁过一次 state 文件）⇒ 这里先剥掉再 parse。
 */
function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const file = mapFile();
    if (!existsSync(file)) return;
    const o = JSON.parse(stripBom(readFileSync(file, 'utf8')));
    if (o && typeof o === 'object') {
      for (const [ph, rec] of Object.entries(o.items || {})) {
        if (!rec || typeof rec.v !== 'string') continue;
        const t = String(rec.t || ph.replace(/[^A-Z]/g, ''));
        if (!TYPES.includes(t)) continue;
        items.set(ph, {v: rec.v, t, at: Number(rec.at) || 0});
        fwd.set(`${t}:${rec.v}`, ph);
      }
      for (const t of TYPES) seq[t] = Math.max(seq[t], Number(o.seq?.[t]) || 0);
      // ⚠️ 兜底：配置/手改过的表可能 seq 比实际小 ⇒ 按现有占位符把编号抬上去
      //    （否则会分配出一个已存在的占位符 ⇒ 指向两个人）
      for (const ph of items.keys()) {
        const m = /^@(GN|U|G|S|K)(\d+)@$/.exec(ph);
        if (m) seq[m[1]] = Math.max(seq[m[1]], Number(m[2]) || 0);
      }
    }
  } catch (e) {
    _lastError = String(e?.message || e);
    log.warn(`[脱敏] 映射表读不出来（${_lastError}）—— 本次从空表开始，会导致旧占位符还原不了`);
  }
}

function trimIfNeeded() {
  if (items.size <= MAX_ITEMS) return;
  const arr = [...items.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
  const drop = items.size - MAX_ITEMS;
  for (let i = 0; i < drop; i += 1) {
    const [ph, rec] = arr[i];
    items.delete(ph);
    fwd.delete(`${rec.t}:${rec.v}`);
  }
}

/**
 * 落盘（**同步**，原子写）。
 *
 * ⚠️ 为什么必须是同步、且**分配新编号时就写**：
 *    编号只能增不能复用。如果"先攒着、以后再写"，进程被 kill 掉（这个项目
 *    经常被 kill / 重启）⇒ 内存里的 `seq` 丢了 ⇒ 下次启动从旧值开始分配
 *    ⇒ **新实体拿到别人用过的 `@U1@`** ⇒ 历史回复里的占位符全部还原成错的字面值。
 *    这个错误比"漏脱敏"更糟（会写出张冠李戴的话），所以宁可付一次几毫秒的写盘。
 * ⚠️ 命中已有映射时**不写**（`needPersist` 为 false）—— 绝大多数消息是这条路。
 */
function persist() {
  if (!needPersist) return;
  try {
    trimIfNeeded();
    const obj = {v: 1, seq: {...seq}, items: {}, updatedAt: Date.now()};
    for (const [ph, rec] of items) obj.items[ph] = rec;
    const file = mapFile();
    mkdirSync(dirname(file), {recursive: true});
    // ⚠️ 先写临时文件再 rename：写到一半被杀也不会留下半截 JSON
    //    （半截 JSON 会让下一次启动读不出表 ⇒ 全部历史占位符失效）
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    renameSync(tmp, file);
    needPersist = false;
    _lastPersistAt = obj.updatedAt;
  } catch (e) {
    // 写失败**不清** needPersist：下一次 mask 还会再试
    _lastError = String(e?.message || e);
    if (!warnedPersist) {
      warnedPersist = true;
      log.warn(`[脱敏] 映射表写盘失败（会一直重试）：${_lastError}`);
    }
  }
}

/**
 * 强制把内存里的表刷进磁盘。
 * 平时不需要（分配即写）；自测脚本要"跨进程还原"时会显式调一次。
 */
export function flush() {
  if (!loaded) return;
  needPersist = true;
  persist();
}

/* ══════════════════════════════════════════════════════════════════
 * 配置（每次现读 —— 界面上改了开关要立刻生效，别固化在模块加载时）
 * ══════════════════════════════════════════════════════════════════ */

function pcfg() {
  const p = config?.llm?.privacy;
  return p && typeof p === 'object' ? p : {};
}

/**
 * 总开关。
 * ⚠️ 默认 **true**（`!== false`）—— 这一段配置是后来才加的，
 *    老配置里根本没有 `privacy:`，那时候也必须脱敏（默认关等于白做）。
 */
export function enabled() {
  return pcfg().enable !== false;
}

/**
 * 人名/群名片要不要脱敏（**默认 false**）。
 *
 * ⚠️⚠️ 为什么默认不脱（上线后按实测数据改的）：
 *    ① **昵称不具唯一性** —— 「阿恺」「小明」这种重名一大片，脱掉它挡不住谁；
 *       真正能定位到人的只有 **QQ 号**（那个照脱）⇒ 脱昵称的隐私收益接近于零。
 *    ② **误伤很重** —— `state/names.json` 里就有群友昵称是常用词
 *       （「或者 / 今天 / 时间 / 默认 / 哈哈 / 名字 / 不知道 / 机器人 …」），
 *       一脱就把提示词里这些词也换成 `@U3@`：实测「没写的就是不知道」→
 *       「没写的就是@U3@」、「你是丰川祥子」→「你是@U1@」（41 次以上）。
 *       unmask 能把输出还原（陈述不会错），但**模型读到的提示词是残的**，
 *       而且 `@U1@` 看着像 @ 提及，容易被当成一种写法去模仿。
 *    ③ 纯中文昵称里 2 字 445 个、3 字 227 个 ⇒ 误伤面铺得很开。
 *    ⇒ 默认**关**。确实要"连昵称也不给中转站看"，就把 `llm.privacy.maskNames` 设 true，
 *      再配 `nameAllowlist` 把上面那批常用词剔出去（否则误伤会回来）。
 *    ⚠️ 关掉的只是**名字**：QQ 号（含 `personIds` 里那些已知号）、群号、群名、地址、密钥
 *      照旧全脱 —— 那几类不会误伤，别一起关。
 */
function maskNamesOn() {
  return pcfg().maskNames === true;
}

/**
 * 未知的 6-12 位裸数字要不要当身份号（默认 true）。
 * ⚠️ 打开它的代价：提示词里那些"不是身份"的长数字（金额、token 数、统计数据）
 *    也会变成 `@U9@` ⇒ 模型算不了算术（还原后的陈述是对的，但推理过程会瘸）。
 *    按需求默认开；觉得影响做题就关掉，已知的群号/QQ 号仍然照脱。
 */
function maskNumbersOn() {
  return pcfg().maskNumbers !== false;
}

/* ══════════════════════════════════════════════════════════════════
 * 分配占位符
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 拿到 `value`（类型 `type`）的占位符，没有就新建。
 * @returns {string} 形如 `@U1@`
 */
function ensureItem(type, value) {
  ensureLoaded();
  const key = `${type}:${value}`;
  const hit = fwd.get(key);
  if (hit) {
    // 记一下"最近还在用"，裁剪时留它
    const rec = items.get(hit);
    if (rec) rec.at = Date.now();
    return hit;
  }
  seq[type] = (seq[type] || 0) + 1;
  const ph = `@${type}${seq[type]}@`;
  items.set(ph, {v: value, t: type, at: Date.now()});
  fwd.set(key, ph);
  needPersist = true;
  return ph;
}

/* ══════════════════════════════════════════════════════════════════
 * 实体清单（群名 / 昵称 / 已知号码 / 已知域名）—— 带缓存
 * ══════════════════════════════════════════════════════════════════ */

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 一个"名字"值不值得当实体。
 *
 * ⚠️ 为什么必须过滤（都是真实踩到的形状）：
 *   · `state/group-names.json` 里有个群的名字就是 **`-`** —— 不过滤的话
 *     全文所有连字符都会被换成 `@GN1@`，提示词直接废掉；
 *   · 有群名是纯 emoji（`🚏`）—— 同理，emoji 到处都是；
 *   · 超长的一条多半是"名字里塞了句话"，替换它等于替换正文。
 */
function usableName(raw, minLen = 2) {
  const t = String(raw ?? '').trim();
  if (!t) return '';
  if ([...t].length < minLen) return '';
  // 必须含字母/数字/汉字（排除纯标点、纯 emoji）
  if (!/[\p{L}\p{N}]/u.test(t)) return '';
  if (t.length > 40) return '';
  return t;
}

function statKey(f) {
  try {
    const s = statSync(f);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return '0';
  }
}

function readJsonSafe(file) {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(stripBom(readFileSync(file, 'utf8')));
  } catch (e) {
    _lastError = String(e?.message || e);
    return null;
  }
}

/** 从配置里那些 baseURL 里提出"已知域名"（中转站地址本身也别明文发出去） */
function knownHosts() {
  const set = new Set();
  const add = (u) => {
    try {
      const h = new URL(String(u)).hostname.toLowerCase();
      // 纯 IP 交给 IP 规则；`localhost` 之类没有脱敏价值
      if (!h || h === 'localhost' || /^[\d.]+$/.test(h) || h.length < 4) return;
      set.add(h);
    } catch {
      /* 不是 URL 就算了 */
    }
  };
  const l = config?.llm || {};
  add(l.baseURL);
  for (const p of Array.isArray(l.providers) ? l.providers : []) add(p?.baseURL);
  add(l.backup?.baseURL);
  add(config?.vision?.baseURL);
  add(config?.imagegen?.baseURL);
  return set;
}

/** 缓存：3 秒内不重复 stat（每条消息都会 mask，statSync 不该每条都做） */
let cache = {at: 0, key: '', rules: null};

/**
 * 当前生效的规则集（正则 + 集合）。文件变了才重建。
 * @returns {{keyRe:RegExp|null, urlRe:RegExp, ipRe:RegExp, hostRe:RegExp|null,
 *            groupNameRe:RegExp|null, personRe:RegExp|null,
 *            groupIds:Set<string>, personIds:Set<string>}}
 */
function getRules() {
  const now = Date.now();
  if (cache.rules && now - cache.at < 3000) return cache.rules;

  /* ⚠️ `maskNames` 也要进缓存 key —— 它是开关（配置热重载会变），
   *    不进来的话"关掉人名脱敏"之后还会沿用旧规则里那几千项名字正则（白算）。 */
  const namesOn = maskNamesOn();
  const gf = GROUP_NAMES_FILE();
  const nf = NAMES_FILE();
  const key = `${gf}|${statKey(gf)}|${nf}|${statKey(nf)}|${namesOn ? 1 : 0}`;
  if (cache.rules && cache.key === key) {
    cache.at = now;
    return cache.rules;
  }

  const groupNames = new Set();
  const groupIds = new Set();
  const personNames = new Set();
  const personIds = new Set();

  const g = readJsonSafe(gf);
  if (g && typeof g.groups === 'object') {
    for (const [id, v] of Object.entries(g.groups)) {
      const sid = String(id ?? '').trim();
      if (/^\d{5,12}$/.test(sid)) groupIds.add(sid);
      const nm = usableName(v?.name);
      if (nm) groupNames.add(nm);
      // 群名改过（`prevName`）的旧名也一样敏感
      const pn = usableName(v?.prevName);
      if (pn) groupNames.add(pn);
    }
  }

  const n = readJsonSafe(nf);
  /* ⚠️ `nameAllowlist`（可选，配置里没写就是空）：**这些名字不脱敏**。
   *    唯一想得到的用途是"她自己的名字/人设名" —— 把自称换成 `@U1@` 之后，
   *    提示词里的「你是@U1@」可能让人称更乱（不是错，但模型多一层要绕）。
   *    ⚠️ 默认空 = 一律脱；写进去的名字在**发出去的正文里是明文**，这点要清楚。 */
  const allow = new Set(
    (Array.isArray(pcfg().nameAllowlist) ? pcfg().nameAllowlist : [])
      .map((x) => String(x ?? '').trim())
      .filter(Boolean),
  );
  if (n && typeof n === 'object') {
    for (const table of ['nick', 'card']) {
      const t = n[table];
      if (!t || typeof t !== 'object') continue;
      for (const [id, v] of Object.entries(t)) {
        const sid = String(id ?? '').trim();
        /* ⚠️ **QQ 号无条件收**（不管要不要脱昵称）——
         *    号码规则靠它判断"这个数字是已知的人号"⇒ 换成 `@U1@`。
         *    昵称能不能脱是另一件事（见 `maskNamesOn()` 那段）。 */
        if (/^\d{5,12}$/.test(sid)) personIds.add(sid);
        if (!namesOn) continue; // 昵称/群名片不脱 ⇒ 连正则都不建（省掉几千项）
        const nm = usableName(v);
        if (nm && !allow.has(nm)) personNames.add(nm);
      }
    }
  }

  const hosts = knownHosts();

  /**
   * 建"多个字面值 → 一个正则"的大 alternation（只给**中文/混合**名字用）。
   * ⚠️ 必须**按长度降序**：「凌海云烟」要排在「凌海」前面，否则长名字永远匹配不到。
   * ⚠️ 空集合**绝不能**建成 `new RegExp('')`（那个会匹配每个位置，灾难）。
   *
   * ⚠️⚠️ 纯 ASCII 的名字**不走这里**（两件踩过的事）：
   *   ① 昵称表里有个群友就叫 `<主人>`，而提示词里到处是服务器名 `示例服务器` ——
   *      不加词边界的话 `示例服务器` 会被切成 `@U2@MTR`（还原得回来，但模型看到的是个残词）。
   *   ② 把 `\b` 分支混进几千项的大 alternation 会让 V8 的前缀加速失效：
   *      同一段 57.7 万字的提示词实测 106ms → 306ms。
   *   ⇒ ASCII 名字改用"**先抓词、再查表**"：一个 `/[A-Za-z0-9_]{2,40}/g` 把连续的
   *      字母数字整段抓出来，再拿它去 Map 里查是不是某人的昵称。
   *      天然自带词边界（`示例服务器` 是个整体，查不到 `<主人>` 就原样留着），
   *      而且只有一个简单模式，比几千项 alternation 快得多。
   */
  const buildNameRe = (list) => {
    if (!list.length) return null;
    const sorted = [...list].sort((a, b) => b.length - a.length);
    return new RegExp(sorted.map((v) => escRe(v)).join('|'), 'g');
  };
  /** 把名字拆成「中文/混合」和「纯 ASCII」两组：前者建正则，后者进 Map 查表 */
  const isAsciiName = (v) => /^[A-Za-z0-9_]+$/.test(v);
  const dropAscii = (set, map, type) => {
    const other = [];
    for (const v of set) {
      if (isAsciiName(v)) map.set(v, type);
      else other.push(v);
    }
    return other;
  };

  /** 域名单独一套边界：`(?<![A-Za-z0-9.-])…(?![A-Za-z0-9.-])`
   *  ⚠️ 不能只用 `\b` —— 域名里的 `.` 不是词字符，`\bnotexample.com` 会命中 `example.com`
   *     （实际不会，但 `aexample.com` 里 `example.com` 是"\b"边界，会被误切）。 */
  const buildHostRe = (set) => {
    if (!set.size) return null;
    const list = [...set].sort((a, b) => b.length - a.length);
    return new RegExp(list.map((h) => `(?<![A-Za-z0-9.-])${escRe(h)}(?![A-Za-z0-9.-])`).join('|'), 'g');
  };

  /** 纯 ASCII 名字的查表（值 = 类型 'U' / 'GN'） */
  const asciiNames = new Map();
  const gNames = buildNameRe(dropAscii(groupNames, asciiNames, 'GN'));
  // 人名那一趟在 `maskNames: false`（默认）时**整个不建**
  const pNames = namesOn ? buildNameRe(dropAscii(personNames, asciiNames, 'U')) : null;
  /** 名字类的替换趟（中文那两趟；ASCII 那趟走 `asciiWordRe` + 查表） */
  const nameRules = [
    {re: gNames, type: 'GN'},
    {re: pNames, type: 'U'},
  ].filter((x) => x.re);

  const rules = {
    // 密钥：`sk-…` / `Bearer …` / `ark-…` / Gemini 的 `AQ.…`
    // ⚠️ 必须**第一个**替换：`sk-2b14…e116467883` 里那段 9 位数字
    //    否则会被后面的号码规则当成 QQ 号换掉，密钥就还原不回来了。
    keyRe: /\b(?:sk-[A-Za-z0-9_-]{8,}|ark-[A-Za-z0-9-]{8,}|AQ\.[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{8,})/g,
    // URL：保留 scheme（模型据此知道这是 http 链接），只换 host[:port]
    urlRe: /(https?|wss?):\/\/([^\s/?#"'`)\]}>]+)/g,
    // 裸 IPv4（`203.0.113.10` / 带端口）。⚠️ 会误伤 `203.0.113.10` 这种版本号，
    //    但版本号还原后没差别，可接受。
    ipRe: /(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/g,
    hostRe: buildHostRe(hosts),
    hostCount: hosts.size,
    nameRules,
    /** 纯 ASCII 名字：先抓"整段字母数字"，再查这里（天然带词边界） */
    asciiWordRe: /[A-Za-z0-9_]{2,40}/g,
    asciiNames,
    nameCounts: {
      groupNames: groupNames.size,
      personNames: personNames.size,
    },
    groupIds,
    personIds,
  };
  cache = {at: now, key, rules};
  return rules;
}

/* ══════════════════════════════════════════════════════════════════
 * mask：原文 → 占位符
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 把一段文本里的身份标识换成占位符。
 *
 * @param {string} text
 * @param {{deferPersist?:boolean}} [opts] `deferPersist` 给批量调用用
 *        （`maskMessages` 一次落盘，别每条消息都写一次文件）
 * @returns {{text:string, map:Map<string,string>}} `map` 是 占位符 → 原值
 */
export function mask(text, opts = {}) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  /** @type {Map<string,string>} */
  const map = new Map();
  if (!s) return {text: s, map};
  if (!enabled()) return {text: s, map};

  let rules;
  try {
    rules = getRules();
  } catch (e) {
    _lastError = String(e?.message || e);
    return {text: s, map}; // 规则建不出来就按明文发 —— 宁可漏，不能把请求搞挂
  }

  /** 记一笔 + 返回占位符（同一个实体在一次文本里出现多次只记一次） */
  const ph = (type, value) => {
    const p = ensureItem(type, value);
    if (!map.has(p)) map.set(p, value);
    return p;
  };

  let out = s;

  // ① 密钥
  if (rules.keyRe) out = out.replace(rules.keyRe, (m) => ph('K', m));

  // ② URL（只换 host，scheme 留着）
  out = out.replace(rules.urlRe, (m, scheme, host) => `${scheme}://${ph('S', host)}`);

  // ③ 已知域名（不带 scheme 的裸写法，比如中转站地址被人贴在群里）
  if (rules.hostRe) out = out.replace(rules.hostRe, (m) => ph('S', m.toLowerCase()));

  // ④ 裸 IPv4
  out = out.replace(rules.ipRe, (m) => ph('S', m));

  // ⑤⑥ 群名 / 人名 / 群名片
  //    ⚠️ `maskNames` 关掉时只跳过 **人名** 那几趟；群名照样要脱（群名不等于人名）。
  const namesOn = maskNamesOn();
  for (const r of rules.nameRules) {
    if (r.type === 'U' && !namesOn) continue;
    out = out.replace(r.re, (m) => ph(r.type, m));
  }
  // 纯 ASCII 的昵称（`Saki` / `Cat` / `<主人>`…）：先抓整段字母数字再查表。
  if (rules.asciiNames.size) {
    out = out.replace(rules.asciiWordRe, (w) => {
      const t = rules.asciiNames.get(w);
      if (!t) return w; // 不是名字 ⇒ 原样（`示例服务器` 就不会被 `<主人>` 切开）
      if (t === 'U' && !namesOn) return w;
      return ph(t, w);
    });
  }

  // ⑦ 号码（群号 / QQ 号 / 未知裸数字）
  //    ⚠️ 放最后：前面已经把密钥、URL、名字里的数字段处理掉了，
  //       这里剩下的"孤立 5-12 位数字"才更有可能是身份号。
  out = out.replace(/(?<!\d)(\d{5,12})(?!\d)/g, (m) => {
    if (rules.groupIds.has(m)) return ph('G', m);
    if (rules.personIds.has(m)) return ph('U', m);
    // 未知的：6 位以上才当身份号（5 位太容易是计数/金额）
    if (maskNumbersOn() && m.length >= 6) return ph('U', m);
    return m;
  });

  counter.masked += 1;
  if (!opts.deferPersist) persist();
  return {text: out, map};
}

/**
 * 批量脱敏一组 `{role, content}` 消息。
 *
 * @param {{role:string, content:any}[]} messages
 * @returns {{messages:any[], map:Map<string,string>}}
 */
export function maskMessages(messages) {
  /** @type {Map<string,string>} */
  const map = new Map();
  if (!Array.isArray(messages)) return {messages, map};
  if (!enabled()) return {messages, map};

  const out = messages.map((m) => {
    if (!m || typeof m !== 'object') return m;
    const c = m.content;
    if (typeof c === 'string') {
      const r = mask(c, {deferPersist: true});
      for (const [k, v] of r.map) if (!map.has(k)) map.set(k, v);
      return r.text === c ? m : {...m, content: r.text};
    }
    // ⚠️ 多模态的 content 是数组（`[{type:'text',text:…},{type:'image_url',…}]`）。
    //    这里只动 `text` 那几块 —— base64 图片数据一个字都不能碰（换了就发不出去）。
    if (Array.isArray(c)) {
      let changed = false;
      const nc = c.map((part) => {
        if (part && typeof part === 'object' && typeof part.text === 'string') {
          const r = mask(part.text, {deferPersist: true});
          for (const [k, v] of r.map) if (!map.has(k)) map.set(k, v);
          if (r.text !== part.text) {
            changed = true;
            return {...part, text: r.text};
          }
        }
        return part;
      });
      return changed ? {...m, content: nc} : m;
    }
    return m;
  });

  // 一次性落盘（上面每个 mask 都是 deferPersist）
  persist();
  return {messages: out, map};
}

/* ══════════════════════════════════════════════════════════════════
 * unmask：占位符 → 原文
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 占位符识别正则。
 * ⚠️ 做成**宽容**的（大小写不敏感 + 认全角 ＠）：模型偶尔会把 `@U1@` 写成
 *    `@u1@` 或 `＠U1＠`，宽容一点能救回来；而正常中文行文里几乎不会出现
 *    这个形状，误伤可以忽略。
 * ⚠️ `GN` 必须排在 `G` 前面。
 */
const PH_RE = /[＠@](GN|U|G|S|K)(\d{1,6})[＠@]/gi;
const PH_FULL_RE = /[＠@](GN|U|G|S|K)(\d{1,6})[＠@]/i;

function normPh(m) {
  return m.replace(/＠/g, '@').toUpperCase();
}

/**
 * 把占位符换回原值。
 *
 * @param {string} text
 * @param {Map<string,string>} [map] 本次 mask 的映射（优先用它；缺了回落到持久表）
 * @returns {string}
 */
export function unmask(text, map) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  if (!s) return s;
  if (s.indexOf('@') < 0 && s.indexOf('＠') < 0) return s;
  ensureLoaded();
  counter.unmaskCalls += 1;
  return s.replace(PH_RE, (m, type, num) => {
    const key = `@${String(type).toUpperCase()}${num}@`;
    const hit = map instanceof Map ? map.get(key) : undefined;
    if (hit != null) return hit;
    const rec = items.get(key);
    if (rec) return rec.v;
    // 认不出来（表被裁掉了 / 模型自己编的编号）⇒ 原样留着，并记一笔
    counter.unresolved += 1;
    return m;
  });
}

/* ══════════════════════════════════════════════════════════════════
 * 流式 unmask
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 末尾"可能是个还没写完的占位符"的长度 —— 这段先扣住不发。
 *
 * ⚠️⚠️ 为什么需要它（这是流式最容易被写错的地方）：
 *    SSE 的 delta 是**按 token 切**的，`@U1@` 完全可能被切成 `"@U"` + `"1@"`。
 *    如果每块都独立 unmask 再吐：
 *      · 第一块 `"@U"` 认不出 → 原样吐给调用方 → 调用方已经拼出半个占位符；
 *      · 第二块 `"1@"` 也认不出 → 最终正文里留下 `@U1@` 明文（用户看到占位符）。
 *    所以必须"**先攒到能确定不是半个占位符**再吐"。
 *
 * ⚠️ 为什么是"先替换、再判尾部"这个顺序（顺序反了就漏）：
 *    若先判尾部再替换，一段完整的 `"@U1@"` 会被判成"尾部 @ 开头、可能没写完"
 *    ⇒ 扣住最后一个 `@`，把前面的 `"@U1"` 当正文吐出去 ⇒ 占位符照样漏。
 *    先替换的话，完整的已经换成真名了，剩下的只可能是"真的没写完"。
 */
function tailHold(s) {
  // 末尾是 `@`、`@U`、`@U1`、`@GN12` 这类形状 ⇒ 扣住
  const m = /[＠@](?:[A-Za-z]{1,3}\d{0,6})?$/.exec(s);
  if (!m) return 0;
  const len = s.length - m.index;
  if (len > HOLD_MAX) return 0; // 太长 ⇒ 不是占位符，是正文（别把正文扣着不发）
  return len;
}

/**
 * 造一个流式 unmask 器：喂增量、吐"已经安全"的文本，结束时 `flush()`。
 *
 * 取舍说明：为什么选"边收边换（带扣留）"而不是"全部攒完再一次性换"？
 *   · 攒完再换最稳（绝不会切断），但**正文档次会退化成非流式** ——
 *     首字要等整段写完（实测普通回复 8~20 秒），webui 的思考链页面也一样，
 *     这个代价比"多十几行状态机"大得多；
 *   · 扣留法的风险只有一个：**块尾被扣住的那十几个字符**在流异常中断时不会吐出去
 *     （最多丢半个占位符，页面看着像少了个字）。两害相权取其轻。
 *   · 想换成"全攒完再换"：把 `feed()` 改成 `return ''`、只留 `flush()`，
 *     调用方不需要改（`flush` 里会把全部内容吐出去）。
 */
export function createStreamUnmasker(map) {
  let buf = '';
  counter.streams += 1;
  return {
    /** @param {string} chunk @returns {string} 可以立刻交给调用方的部分（可能是空串） */
    feed(chunk) {
      const t = typeof chunk === 'string' ? chunk : String(chunk ?? '');
      if (!t) return '';
      buf += t;
      // ① 先把完整的占位符换掉（未完成的还留在字符串里，因为格式对不上）
      const replaced = unmask(buf, map);
      // ② 再看末尾有没有可能没写完的
      const hold = tailHold(replaced);
      if (!hold) {
        buf = '';
        return replaced;
      }
      buf = replaced.slice(replaced.length - hold);
      return replaced.slice(0, replaced.length - hold);
    },
    /** 流结束（或异常）时把剩下的一次性吐出去 */
    flush() {
      if (!buf) return '';
      const t = unmask(buf, map);
      buf = '';
      return t;
    },
  };
}

/* ══════════════════════════════════════════════════════════════════
 * 只读统计 / 调试接口
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 只读快照（给调试 / 自测用，别拿它做业务判断）。
 * @returns {object}
 */
export function stats() {
  ensureLoaded();
  const byType = Object.fromEntries(TYPES.map((t) => [t, 0]));
  for (const rec of items.values()) byType[rec.t] = (byType[rec.t] || 0) + 1;
  let rules = null;
  try {
    const r = getRules();
    rules = {
      groupNames: r.nameCounts.groupNames,
      personNames: r.nameCounts.personNames,
      knownHosts: r.hostCount,
      nameRegexps: r.nameRules.length,
      asciiNameMap: r.asciiNames.size,
      groupIds: r.groupIds.size,
      personIds: r.personIds.size,
    };
  } catch {
    rules = null;
  }
  return {
    enable: enabled(),
    maskNames: maskNamesOn(),
    maskNumbers: maskNumbersOn(),
    file: mapFile(),
    entities: items.size,
    byType,
    seq: {...seq},
    rules,
    config: {...pcfg()},
    counter: {...counter},
    lastPersistAt: _lastPersistAt,
    lastError: _lastError,
  };
}

/** 测试用：判断一段文本里还有没有未还原的占位符 */
export function hasPlaceholder(text) {
  return PH_FULL_RE.test(String(text ?? ''));
}

/** 调试用：清掉内存状态（**不动磁盘**，自测脚本每次开跑时调） */
export function resetMemory() {
  items.clear();
  fwd.clear();
  for (const t of TYPES) seq[t] = 0;
  loaded = false;
  needPersist = false;
  cache = {at: 0, key: '', rules: null};
  counter.masked = 0;
  counter.unmaskCalls = 0;
  counter.unresolved = 0;
  counter.streams = 0;
}

/** 调试用：让规则缓存立刻失效（改了实体源文件之后不必等 3 秒） */
export function reloadSources() {
  cache = {at: 0, key: '', rules: null};
}
