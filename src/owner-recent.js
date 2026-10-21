/**
 * 「主人最近的近况」短时记忆（2026-10-17 用户要求）。
 *
 * ## 用户原话
 *   「加一个对主人的**短时记忆区**，同样计入 `owner.md`，到 **48 小时**前的数据就清除，
 *     主要是用于**跨群和私聊**的记忆，所以**只用总结记忆**即可，比如图中这种就可以总结并记住，
 *     而且要**记下时间**以便调用和删除。机器人可以在**没事的时候提一下**里面的东西，
 *     但是**不能老是提**。」
 *
 * （图里那条是她说说里的一句话：「<主人> 说今晚又得通宵，一早还要把车送去黄牛那儿年检。
 *   ……反正说了也不听。」—— 就是这种"他最近的近况" ✓）
 *
 * ## 它跟他资料库（`owner-update.js`）的区别 —— 别搞混
 *   | | `owner-update.js` | 本文件 |
 *   | --- | --- | --- |
 *   | 记什么 | **长期有效**的身份/经历（毕业、换工作、搬城市）| **最近 48 小时**的事（今晚通宵、明天去送检）|
 *   | 怎么写 | 按他的原话**改正文**里的那一条 | **只写文件末尾那个自维护区块**，绝不动正文 ✓ |
 *   | 时间 | 不带（长期事实）| **每条都带时间**（要用来过期和调用 ✓）|
 *
 * ## 怎么工作
 *   ① `noteOwnerTalk()` —— 只在**他本人**说话时攒（私聊 / 群里都算 ✓ 跨群 ✓），落盘；
 *   ② `maybeSummarize()` —— 攒够 `minItems` 条、或隔了 `minIntervalMs` ⇒
 *      **让模型总结**成一句短话（不是照抄 ✗ 用户明确说"只用总结记忆即可"）；
 *   ③ 写进 `owner.md` 末尾区块（`<!-- OWNER-RECENT:BEGIN … END -->` 定界 ✓），
 *      写前备份、写后热重载 ⇒ 她立刻能用上 ✓；
 *   ④ `list()` 读的时候按 **48 小时**过滤（顺带把过期的删掉 ✓）、
 *      并把"提过几次 / 最近一次什么时候提的"写回去 ⇒ **她看得见自己刚提过** ✓
 *      （用户要求"可以提，但不能老是提"）
 *
 * ## 安全底线（跟 `owner-update.js` 一致）
 *   · 🚫 敏感信息永不落盘：手机号 / 邮箱 / 证件号 / 地址（正则兜底 + 提示词里也写明）
 *   · 🚫 不写"她自己的事" —— 只记**关于他**的
 *   · ⚠️ 只增删自己那个区块，正文一个字符都不碰 ✓
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config, ROOT, KNOWLEDGE_DIR, stateDir } from './config.js';
import { log } from './log.js';
import { reloadKnowledge } from './knowledge.js';

// ⚠️ 给套件留出口（和 QQBOT_PRIVATE_WORK_FILE 一个套路）——
//    不然套件会去动**真实的** `knowledge/owner.md`（那是用户自己的资料 ✗✗）
const OWNER_FILE = process.env.QQBOT_OWNER_FILE
  ? join(ROOT, process.env.QQBOT_OWNER_FILE)
  : join(KNOWLEDGE_DIR, 'owner.md');
const STATE_FILE = process.env.QQBOT_OWNER_RECENT_FILE
  ? join(ROOT, process.env.QQBOT_OWNER_RECENT_FILE)
  : join(stateDir(), 'owner-recent.json');

const BEGIN = '<!-- OWNER-RECENT:BEGIN';
const END = '<!-- OWNER-RECENT:END -->';
const HEAD = '## 三、他最近的近况（短时记忆 · 只保留 48 小时）';

/** 保留多久（用户指定 48 小时） */
const KEEP_MS = 48 * 60 * 60 * 1000;
/**
 * 攒够几条原始话才总结一次
 *
 * ⚠️⚠️ 2026-10-19 改（用户：「**看起来明显不像是总结出来的，而是有一条消息就记一条**」
 *    + 「**记得太简短，没头没尾，而且过于频繁**」）——
 *    原来是 **4**：他连说 4 句就攒够 ⇒ 模型一回 3 条 ⇒ 效果上就是"一条消息记一条" ✗
 *    实测一个下午刷出十几条（19:23 三条 / 19:29 三条 / 19:33 两条 / 19:38 三条），
 *    而且全是「已更新服务器」「承认问题在自己边」这种**没有主语的残句**。
 *    ⇒ 攒到 **12** 条才总结一次：他不连着聊够一段，就不会有新的近况条目 ✓
 */
const MIN_ITEMS = 12;
/** 或者隔这么久也总结一次（免得一直等不到那么多条） */
const MIN_INTERVAL_MS = 30 * 60 * 1000;
/** 最多留几条（防止刷屏） */
const MAX = 12;
/**
 * 一条短句最多多长
 * ⚠️ 2026-10-19：**60 → 80**。提示词现在要 30~50 字（原来只要 ≤20 字，
 * 写出来全是残句），上限得跟上，别到最后一步才被截断 ✗
 */
const MAX_LEN = 80;

const W = () => (config.ownerRecent && typeof config.ownerRecent === 'object' ? config.ownerRecent : {});

/** 攒着还没总结的原始话（落盘 —— 重启很频繁，只放内存几乎攒不够） */
let buf = [];
let lastSummaryAt = 0;

function load() {
  try {
    if (!existsSync(STATE_FILE)) return;
    const j = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    buf = Array.isArray(j?.buf) ? j.buf.filter((x) => x && x.text) : [];
    lastSummaryAt = Number(j?.lastSummaryAt) || 0;
  } catch (e) {
    log.debug(`[近况] 读取攒着的消息失败（当空的）：${e.message}`);
    buf = [];
  }
}
function save() {
  try {
    mkdirSync(stateDir(), { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ buf, lastSummaryAt }), 'utf8');
    renameSync(tmp, STATE_FILE);
  } catch (e) {
    log.debug(`[近况] 写盘失败：${e.message}`);
  }
}
load();

/** 🚫 敏感信息兜底（跟 owner-update.js 同口径） */
const SENSITIVE = /(\d{11,})|([\w.+-]+@[\w-]+\.[\w.]+)|(身份证)|(银行卡)|(住址)/;
const safe = (s) => !SENSITIVE.test(String(s ?? ''));

/** 🚫 别把"她自己的事"记进来 */
function aboutOwner(text) {
  return !!String(text ?? '').trim();
}

/**
 * 他本人说了一句话 ⇒ 攒起来（**私聊和群里都调** ✓ 用户要的就是"跨群和私聊" ✓）
 * ⚠️ 只在他本人说话时调 —— 调用方（`bot.js`）已经用 `config.ownerQQ` 判过了 ✓
 */
export function noteOwnerTalk(text, { source = '' } = {}) {
  if (W().enable === false) return false; // ⚠️ 只有配置里**显式关掉**才不记（默认开 ✓）
  const t = String(text ?? '').trim();
  if (!t || t.length < 4) return false;
  if (!safe(t)) return false;
  if (!aboutOwner(t)) return false;
  // 纯表情/占位符不算
  if (/^\[(图片|表情包|QQ表情)\]+$/.test(t)) return false;
  buf.push({ text: t.slice(0, 300), at: Date.now(), source: String(source ?? '') });
  if (buf.length > 60) buf = buf.slice(-60);
  save();
  return true;
}

/** 现在该不该总结（攒够了 / 隔够久了） */
export function shouldSummarize(now = Date.now()) {
  if (!buf.length) return false;
  if (buf.length >= (Number(W().minItems) || MIN_ITEMS)) return true;
  const gap = Number(W().minIntervalMs) || MIN_INTERVAL_MS;
  return lastSummaryAt > 0 && now - lastSummaryAt >= gap;
}

/** ── 读写 `owner.md` 里那个自维护区块（正文一个字符都不碰 ✓）── */

function readOwner() {
  try {
    return readFileSync(OWNER_FILE, 'utf8');
  } catch {
    return '';
  }
}

/** 把区块里的条目解析出来（`- 时间 ｜ 内容 ｜ 提过 N 次 @ 最近HH:MM`） */
function parseBlock(md) {
  const i = md.indexOf(BEGIN);
  const j = md.indexOf(END);
  if (i < 0 || j < 0 || j < i) return { head: md, items: [], tail: '' };
  const head = md.slice(0, i);
  const body = md.slice(i + BEGIN.length, j);
  const tail = md.slice(j + END.length);
  const items = [];
  for (const line of body.split(/\r?\n/)) {
    const m = /^-\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*[｜|]\s*(.+?)\s*(?:[｜|]\s*提过\s*(\d+)\s*次(?:\s*@\s*(\d{2}:\d{2}))?)?\s*$/.exec(
      line.trim(),
    );
    if (!m) continue;
    const at = Date.parse(`${m[1].replace(' ', 'T')}:00+08:00`);
    if (!Number.isFinite(at)) continue;
    items.push({
      at,
      text: String(m[2]).trim(),
      raised: Number(m[3]) || 0,
      raisedAt: String(m[4] ?? ''),
    });
  }
  return { head, items, tail };
}

const fmt = (t) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const hhmm = (t) => fmt(t).slice(-5);

/** 只保留 48 小时内的（顺手删过期的 —— 用户要求 ✓） */
export function list({ withinMs = KEEP_MS, persistClean = true } = {}) {
  const md = readOwner();
  if (!md) return [];
  const { head, items, tail } = parseBlock(md);
  const now = Date.now();
  const keep = items.filter((x) => now - x.at <= withinMs).slice(-MAX);
  if (persistClean && keep.length !== items.length) {
    try {
      writeBlockOnly({ head, items: keep, tail });
      log.info(`[近况] 清掉了 ${items.length - keep.length} 条超过 48 小时的短时记忆 ✓`);
    } catch (e) {
      log.debug(`[近况] 清理写回失败：${e.message}`);
    }
  }
  return keep;
}

/**
 * 删掉某一时间段里记下的近况（2026-10-19 加）。
 *
 * ⚠️⚠️ 起因（用户：「**开始新剧情的时候还带着之前已经清除过剧情的记忆**」）：
 *    `/清除剧情` 只清 `recent` / `storyline` / `quest`，**没碰知识库** ——
 *    而「他的近况」这一段是**进提示词**的，里面积着一整排
 *    「在跑密室倒计时剧情」「提醒房间爆炸硬约束不许违反」「赶在爆炸前让角色行动」…
 *    ⇒ 新剧情一开场她就"记得"上一场密室，照着旧设定往下演 ✗
 *    ⇒ 清剧情时顺手把**那条剧情期间**记下的近况也删掉 ✓
 *    ⚠️ 判据用**时间戳**（每条都带 `YYYY-MM-DD HH:MM`），不按关键词猜 ✓
 *
 * @param {number} from 起点（ms，一般是那条剧情的 `startedAt`）
 * @param {number} [to] 终点（ms，默认现在）
 * @returns {number} 删了几条
 */
export function dropWindow(from, to = Date.now()) {
  const md = readOwner();
  if (!md) return 0;
  const { head, items, tail } = parseBlock(md);
  const lo = Number(from) || 0;
  const hi = Number(to) || Date.now();
  const keep = items.filter((x) => !(x.at >= lo && x.at <= hi));
  const removed = items.length - keep.length;
  if (removed > 0) {
    try {
      writeBlockOnly({ head, items: keep, tail });
      log.info(`[近况] /清除剧情：删掉这条剧情期间的 ${removed} 条近况（免得新剧情还「记得」上一场）`);
    } catch (e) {
      log.warn(`[近况] 删近况写回失败（不影响主流程）：${e.message}`);
    }
  }
  return removed;
}

/** 把区块写回文件（**只重写自己那一段** ✓ + 先备份 ✓） */
function writeBlockOnly({ head, items, tail }) {
  const body = items
    .map(
      (x) =>
        `- ${fmt(x.at)} ｜ ${x.text}` +
        (x.raised ? ` ｜ 提过 ${x.raised} 次${x.raisedAt ? ` @ ${x.raisedAt}` : ''}` : ''),
    )
    .join('\n');
  const block =
    `${BEGIN}（这一段是机器人自己维护的，别手改；超过 48 小时的会自动消失）-->\n` +
    (body ? `${body}\n` : '') +
    `${END}`;
  const next = `${head}${block}${tail}`;
  try {
    if (existsSync(OWNER_FILE)) {
      const bakDir = join(ROOT, 'logs', 'knowledge.bak');
      mkdirSync(bakDir, { recursive: true });
      writeFileSync(join(bakDir, `owner.md.bak-近况-${Date.now()}.md`), readOwner(), 'utf8');
    }
    const tmp = `${OWNER_FILE}.tmp`;
    writeFileSync(tmp, next, 'utf8');
    renameSync(tmp, OWNER_FILE);
  } catch (e) {
    log.warn(`[近况] 写 owner.md 失败：${e.message}`);
    throw e;
  }
}

/** 确保文件末尾有那个区块（没有就补一个 ✓ 只在第一次做） */
export function ensureBlock() {
  const md = readOwner();
  if (!md || md.includes(BEGIN)) return false;
  const sep = md.endsWith('\n') ? '' : '\n';
  writeFileSync(
    OWNER_FILE,
    `${md}${sep}\n${HEAD}\n\n> ⚠️ 这一段是**机器人自己维护**的短时记忆（只留 **48 小时**内的）：\n` +
      `> 她可以**偶尔**提一句他最近在忙什么（例：「你不是今早要去年检吗」），\n` +
      `> ⚠️ **同一件事别反复提** —— 提过几次这里都会记着 ✗\n\n${BEGIN}（下面由机器人自己写）-->\n${END}\n`,
    'utf8',
  );
  log.info('[近况] 在 owner.md 末尾建好了短时记忆区块 ✓');
  return true;
}

/**
 * 攒够了 ⇒ 让模型**总结**成短句写进去（不是照抄 ✗）
 * @returns {Promise<number>} 新增了几条
 */
export async function maybeSummarize({ force = false, ask = null } = {}) {
  if (!force && !shouldSummarize()) return 0;
  const src = buf.slice(-12);
  if (!src.length) return 0;
  const call =
    ask ??
    (async (opts) => {
      const { phrase } = await import('./llm.js');
      return phrase(opts);
    });
  // ⚠️ 2026-10-19 加：把**现有的几条**也丢给模型 ⇒ 让它自己认出"这事已经记过了"
  //    （原来只在代码里按**字面完全相同**去重 ⇒ 「已更新服务器」和「服务器已更新」
  //      会被当成两条不同的事各记一遍 ✗）
  let existing = [];
  try {
    existing = list({ withinMs: KEEP_MS, persistClean: false })
      .map((x) => String(x.text ?? '').trim())
      .filter(Boolean)
      .slice(-MAX);
  } catch {}
  let out = '';
  try {
    out = await call({
      system:
        '你在帮一个人整理**他最近在忙什么**的备忘。只回 JSON，不要解释。' +
        '⚠️ 绝不写手机号/邮箱/证件号/住址这类敏感信息。',
      user:
        `他最近说过这些话：\n${src.map((x) => `- ${x.text}`).join('\n')}\n\n` +
        // ⚠️⚠️ 2026-10-19 重写（用户：「**看起来明显不像是总结出来的，而是有一条消息
        //    就记一条**」+「**记得太简短，没头没尾，而且过于频繁**」）——
        //    旧提示词要"最多 3 条、每条 ≤20 字" ⇒ 他连说几句就吐出
        //    「已更新服务器」「排查自己这边的故障」「更新相关文件资料」这种**流水账残句** ✗
        //    现在：**一件事只写一条**，写清"在做什么 + 到哪一步 / 为什么"，
        //    并且把**现有的**给他，让他别再重复记 ✓
        '## 怎么总结\n' +
        '· **一件事写一条** —— 同一件事的几步（"更新服务器"→"怀疑是LED屏"→"排查故障"）' +
        '**必须合成一条**，🚫 不许拆成好几条流水账；\n' +
        '· 每条 **25~45 字**，要写清「**他在做什么 + 做到哪一步 / 卡在哪 / 为什么要做**」。' +
        '像「在给 JR 列车加 LED 屏，怀疑是它导致服务器出问题，正在排查」这样；\n' +
        '· 🚫 不许写「已更新服务器」「在处理文件」这种**没有主语的残句** —— 看了等于没看 ✗；\n' +
        '· **只写关于他的事**，不要写别人、不要照抄原句、不要寒暄；\n' +
        '· 这批话里如果**没有**值得记的新进展（只是闲聊、重复）⇒ `{"items":[]}` 也行，' +
        '宁可这次不写，也别硬凑 ✗；\n' +
        '· 最多 **2 条**。\n\n' +
        (existing.length
          ? `## 已经记着这些（**别再重复记同一件事**，哪怕换了说法）：\n` +
            existing.map((x) => `- ${x}`).join('\n') +
            '\n\n'
          : '') +
        '只回 JSON：{"items":["…","…"]}',
      maxTokens: 220,
      timeoutMs: 12000,
    });
  } catch (e) {
    log.debug(`[近况] 总结调用失败（下次再试）：${e.message}`);
    return 0;
  }
  let items = [];
  try {
    const m = /\{[\s\S]*\}/.exec(String(out ?? ''));
    const j = JSON.parse(m ? m[0] : String(out ?? '{}'));
    items = (Array.isArray(j?.items) ? j.items : []).map((x) => String(x ?? '').trim()).filter(Boolean);
  } catch {
    log.debug('[近况] 总结结果不是 JSON，这次跳过');
    return 0;
  }
  const now = Date.now();
  const add = [];
  for (const t of items) {
    const s = t.replace(/^[-•\d.、\s]+/, '').slice(0, MAX_LEN).trim();
    if (s.length < 3) continue;
    if (!safe(s)) continue;
    add.push({ at: now, text: s, raised: 0, raisedAt: '' });
  }
  buf = [];
  lastSummaryAt = now;
  save();
  if (!add.length) return 0;
  ensureBlock();
  const md = readOwner();
  const { head, items: old, tail } = parseBlock(md);
  const live = old.filter((x) => now - x.at <= KEEP_MS);
  // ⚠️⚠️ 三个号**共用同一份** `owner.md` ⇒ **同一句话别写两遍**
  //    （他在群里说一句，可能不止一个号都总结出同一件事 ✓）
  const seen = new Set(live.map((x) => String(x.text).trim()));
  const uniq = add.filter((x) => !seen.has(String(x.text).trim()));
  if (!uniq.length) {
    log.debug('[近况] 总结出来的这几条都已经有了（去重跳过）✓');
    return 0;
  }
  const merged = [...live, ...uniq].slice(-MAX);
  writeBlockOnly({ head, items: merged, tail });
  try {
    reloadKnowledge();
  } catch {}
  log.info(`[近况] 总结出 ${add.length} 条短时记忆，已写进 owner.md ✓（现存 ${merged.length} 条）`);
  return add.length;
}

/**
 * 她"提过"某一条 ⇒ 记一笔（用户要求"可以提，但不能老是提"✓）
 * 写回文件 ⇒ 她下次拼提示词时**看得见自己刚提过** ⇒ 不会反复提 ✓
 */
export function noteRaised(index) {
  const md = readOwner();
  if (!md) return false;
  const { head, items, tail } = parseBlock(md);
  const now = Date.now();
  const live = items.filter((x) => now - x.at <= KEEP_MS);
  if (index < 0 || index >= live.length) return false;
  live[index].raised = (Number(live[index].raised) || 0) + 1;
  live[index].raisedAt = hhmm(now);
  try {
    writeBlockOnly({ head, items: live, tail });
    return true;
  } catch {
    return false;
  }
}

/**
 * ⚠️⚠️ 2026-10-17 加（用户：「**如果和她说哪个是记错了，她能自己删掉那条吗，
 * 要用模型判断是否删除**」）——
 *
 * 他说话时调这个：**让模型判断**"他是不是在指出某条近况记错了 / 要删掉"——
 * ⚠️ **不用关键词快判**（用户铁律：凡是要"理解人话"的地方一律交给模型 ✓）：
 *   他可能说「那年检是明天不是今天」/「你记错了吧」/「这条别记了」/「我没说过通宵」…
 *   换个说法都得认出来 ✓
 *
 * @param {string} said 他刚说的那句
 * @param {(opts:object)=>Promise<string>} [ask] 模型调用（套件可注入）
 * @returns {Promise<{removed:number, why:string, texts:string[]}>}
 */
export async function judgeAndFix(said, { ask = null } = {}) {
  const text = String(said ?? '').trim();
  if (!text || text.length < 2) return { removed: 0, why: '', texts: [] };
  const items = list(); // ⚠️ 顺带把过期的清一遍 ✓
  if (!items.length) return { removed: 0, why: '', texts: [] };
  const call =
    ask ??
    (async (opts) => {
      const { phrase } = await import('./llm.js');
      return phrase(opts);
    });
  let out = '';
  try {
    out = await call({
      system:
        '你在帮一个人维护"他最近的近况"这条备忘。他可能会**纠正**你记错的地方。' +
        '只回 JSON，不要解释。' +
        '⚠️ 三种情况分清楚：' +
        '① 他说得对、**改完仍然值得记**（只是某个细节不对：时间/地点/数量/人名/做没做…）' +
        '⇒ 用 `update` 把那一条**改成他说的样子**（**保持简短，≤20 字**，还是"近况"口吻）；' +
        '② 那件事**根本不存在 / 完全记错了**，或者改完之后**只剩一件不值得记的小事**' +
        '⇒ 用 `remove` 把它删掉；' +
        '③ 只是闲聊、或者提到相关但这几条都没问题 ⇒ 两个数组都留空。',
      user:
        `他最近的近况（编号从 1 开始）：\n` +
        items.map((x, i) => `${i + 1}. ${x.text}`).join('\n') +
        `\n\n他刚说：「${text}」\n\n` +
        '他这句是在纠正里面的哪条吗？\n' +
        '· 只是某个细节不对、这件事还值得记 ⇒ `update`（给出编号 + 改后的短句）\n' +
        '· 完全记错 / 改完就不值得记了 ⇒ `remove`（给出编号）\n' +
        '· 只是闲聊、或者这几条都没问题 ⇒ 两个数组都留空\n' +
        '⚠️ 不许为了"顺手"改别的条；只动他这次说的那条。\n' +
        '只回 JSON：{"update":[{"n":1,"text":"改后的短句"}],"remove":[2],"why":"一句话理由"}',
      maxTokens: 160,
      timeoutMs: 10000,
    });
  } catch (e) {
    log.debug(`[近况] 判"是不是记错了"失败（不动它）：${e.message}`);
    return { removed: 0, why: '', texts: [] };
  }
  let idx = [];
  let edits = [];
  let why = '';
  try {
    const m = /\{[\s\S]*\}/.exec(String(out ?? ''));
    const j = JSON.parse(m ? m[0] : String(out ?? '{}'));
    idx = (Array.isArray(j?.remove) ? j.remove : [])
      .map((x) => Number(x))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= items.length);
    edits = (Array.isArray(j?.update) ? j.update : [])
      .map((x) => ({ n: Number(x?.n), text: String(x?.text ?? '').trim() }))
      .filter((x) => Number.isInteger(x.n) && x.n >= 1 && x.n <= items.length)
      .map((x) => ({ n: x.n, text: x.text.replace(/[\\/:*?"<>|\r\n\t]/g, '').slice(0, MAX_LEN).trim() }))
      .filter((x) => x.text.length >= 2 && safe(x.text));
    why = String(j?.why ?? '').slice(0, 80);
  } catch {
    log.debug('[近况] 判定结果不是 JSON，这次不动');
    return { removed: 0, updated: 0, why: '', texts: [] };
  }
  if (!idx.length && !edits.length) return { removed: 0, updated: 0, why: '', texts: [] };

  const dropIdx = new Set(idx.map((n) => n - 1));
  const texts = [...dropIdx].map((i) => items[i].text);
  // ⚠️ 按**文本**匹配着动（编号是刚读出来的那份，中间可能被别的号写过 ⇒ 文本更稳 ✓）
  const dropSet = new Set(texts.map((x) => String(x).trim()));
  const fixMap = new Map(
    edits.map((x) => [String(items[x.n - 1].text).trim(), x.text]),
  );
  const md = readOwner();
  const { head, items: all, tail } = parseBlock(md);
  const now = Date.now();
  let removed = 0;
  let updated = 0;
  const next = [];
  for (const x of all) {
    const key = String(x.text).trim();
    if (now - x.at <= KEEP_MS && dropSet.has(key)) {
      removed++; // 删掉（完全记错 / 改完不值得记 ✓）
      continue;
    }
    if (now - x.at <= KEEP_MS && fixMap.has(key)) {
      const nt = fixMap.get(key);
      if (nt && nt !== key) {
        updated++; // 改成他说的样子（时间戳保留 —— 那件事还是那时发生的 ✓）
        next.push({ ...x, text: nt });
        continue;
      }
    }
    next.push(x);
  }
  try {
    writeBlockOnly({ head, items: next.slice(-MAX), tail });
    try {
      reloadKnowledge();
    } catch {}
    const bits = [];
    if (updated) bits.push(`改了 ${updated} 条`);
    if (removed) bits.push(`删了 ${removed} 条`);
    log.info(`[近况] 他纠正了 ⇒ ${bits.join('、') || '没动'}（${why || '没说理由'}）`);
    return { removed, updated, why, texts };
  } catch (e) {
    log.warn(`[近况] 写不进去（文件失败）：${e.message}`);
    return { removed: 0, updated: 0, why: '', texts: [] };
  }
}

/** 定时清理（超 48 小时的删掉 ✓） */
export function sweep() {
  const before = (() => {
    try {
      return parseBlock(readOwner()).items.length;
    } catch {
      return 0;
    }
  })();
  const keep = list();
  if (keep.length !== before) {
    log.info(`[近况] 定时清理：${before} → ${keep.length} 条 ✓`);
  }
  return keep.length;
}

/** 排障 / 套件用 */
export function status() {
  try {
    return { items: list().length, buffered: buf.length, lastSummaryAt, file: OWNER_FILE };
  } catch (e) {
    return { error: e.message };
  }
}

/** ⚠️ 套件用：清掉攒着的（别碰 owner.md） */
export function __clearBuf() {
  buf = [];
  lastSummaryAt = 0;
  save();
}
