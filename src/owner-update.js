/**
 * 「他的资料」自动更新（2026-10-03 用户要求）。
 *
 * ## 用户的原话
 *   「我是指我和她聊到**我的生活有什么变化**时，**我的资料库里面的对应的信息应该要自动更新**，
 *     比如**毕业了**」。
 *   紧接着定的三条实现口径：
 *     · 「**不用分区，直接修改**」（不要那种"自动区"，就改正文里对应的那条）
 *     · 「因为**我可以去检查来修正错误**」（所以每次改动必须留痕 + 留备份）
 *     · 「**完全后台**」（不许在私聊里回一句"我记下了"）
 *
 * ## 它怎么工作
 *   ① 只在**私聊**、且说话的是**他本人**（`config.ownerQQ`）时攒消息（`note()`）；
 *   ② 攒够 `minMessages` 条、或者隔了 `minIntervalMs` —— 后台跑一次（`maybeUpdate()`）；
 *   ③ 把 `owner.md` 全文 + 这几条消息喂给模型，只问一件事：
 *      「这里面有没有**关于他本人、长期有效**的新事实或变化？」（毕业 / 换工作 / 搬家 / 拿奖…）
 *   ④ 它回 `{updates:[{old,new,why}]}`，我们**逐条核对 `old` 确实原样存在**才动手；
 *   ⑤ 改之前先备份（`backupKnowledge`），改完 `reloadKnowledge()` 让她立刻用上。
 *
 * ## ⚠️⚠️ 四条安全底线（这是**他自己的资料**，改错了就是脏数据）
 *   ① `old` 必须在文件里**一字不差**地存在 —— 模型编的片段直接丢掉（不做模糊替换）；
 *   ② **不许把内容改没**：`new` 不能比 `old` 短太多（防止它把一整段缩成一句话）；
 *   ③ **敏感信息永远不写**：姓名 / 电话 / 邮箱 / 证件号 / 住址
 *      （`owner.md` 开头就是这么定的；这里再加一道正则兜底，`new` 里出现 11 位以上数字
 *        或邮箱格式一律拒绝）；
 *   ④ 每次真动手前**先备份**到 `logs/knowledge.bak/`，并且**逐条写日志**（改了哪句、依据是什么）
 *      —— 用户明说了他会去检查。
 *
 * ⚠️ 攒着的消息**落盘**（`state/owner-update.json`）：这个机器人重启很频繁，
 *   只放内存的话几乎永远攒不够（`observe.js` 那边就不落盘，但那边是慢积累、丢得起）。
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config, ROOT, KNOWLEDGE_DIR } from './config.js';
import { log } from './log.js';
import { reloadKnowledge } from './knowledge.js';
import { backupKnowledge } from './backup.js';
import { streamChat } from './llm.js';

const FILE = join(KNOWLEDGE_DIR, 'owner.md');
const STATE_FILE = process.env.QQBOT_OWNER_UPDATE_FILE
  ? join(ROOT, process.env.QQBOT_OWNER_UPDATE_FILE)
  : join(ROOT, 'state', 'owner-update.json');

/** 每次最多处理几条消息（防止一次塞太长的提示词） */
const MAX_BATCH = 40;
/** 单条消息存多长 */
const MAX_LEN = 300;

const c = () => config.ownerUpdate ?? {};

/** 攒着还没核对的私聊消息：`[{text, at}]` */
let pending = [];
/** 上次真的跑过的时间 */
let lastAt = 0;
/** 防并发 */
let running = false;
const stats = { runs: 0, changed: 0, rejected: 0, lastNote: '' };

function loadState() {
  try {
    if (!existsSync(STATE_FILE)) return;
    const j = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    pending = Array.isArray(j?.pending) ? j.pending.filter((x) => x && x.text) : [];
    lastAt = Number(j?.lastAt) || 0;
  } catch (e) {
    log.debug(`资料更新状态读取失败（当作空的）：${e.message}`);
  }
}

function saveState() {
  try {
    mkdirSync(join(ROOT, 'state'), { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ pending, lastAt }, null, 2), 'utf8');
    renameSync(tmp, STATE_FILE);
  } catch (e) {
    log.debug(`资料更新状态写盘失败：${e.message}`);
  }
}

/**
 * 记一条他私聊里说的话。
 * ⚠️ 群里的**不收** —— 这条链路的输入必须是"他私下跟你说的"，
 *   群里别人也在看，收进来等于把他的私事混进公共上下文。
 */
export function note(event, text) {
  if (c().enable === false) return false;
  if (event?.message_type !== 'private') return false;
  if (String(event?.user_id ?? '') !== String(config.ownerQQ ?? '')) return false;
  const t = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length < 2) return false;
  pending.push({ text: t.slice(0, MAX_LEN), at: Date.now() });
  if (pending.length > 200) pending = pending.slice(-200);
  saveState();
  return true;
}

export function pendingCount() {
  return pending.length;
}

export function status() {
  return { pending: pending.length, lastAt, ...stats };
}

/** 测试用：清空 */
export function reset() {
  pending = [];
  lastAt = 0;
  stats.runs = 0;
  stats.changed = 0;
  stats.rejected = 0;
  stats.lastNote = '';
  saveState();
}

/** 够不够跑一次 */
export function due(now = Date.now()) {
  if (c().enable === false) return { ok: false, reason: '资料自动更新已关闭' };
  if (!pending.length) return { ok: false, reason: '没有新消息' };
  const minN = Math.max(1, Number(c().minMessages) || 6);
  if (pending.length >= minN) return { ok: true };
  const gap = Math.max(60000, Number(c().minIntervalMs) || 30 * 60 * 1000);
  if (lastAt && now - lastAt >= gap) return { ok: true };
  if (!lastAt && now - Number(pending[0]?.at ?? now) >= gap) return { ok: true };
  return { ok: false, reason: `还没攒够（${pending.length}/${minN} 条）` };
}

/** 敏感字段兜底：`new` 里出现手机号 / 身份证 / 邮箱一律拒绝 */
function looksSensitive(s) {
  if (/\d{11,}/.test(s)) return true;
  if (/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(s)) return true;
  return false;
}

function parseJson(raw) {
  const t = String(raw ?? '').trim();
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try {
    return JSON.parse(t.slice(i, j + 1));
  } catch {
    return null;
  }
}

function buildPrompt(ownerText, msgs) {
  return [
    '下面是「<主人>（服主）本人的资料」全文。',
    '===== 资料开始 =====',
    ownerText,
    '===== 资料结束 =====',
    '',
    '这是他最近跟你私聊时说的话（原话）：',
    msgs,
    '',
    '## 你的任务',
    '只找**关于他本人、长期有效的事实或变化** ——',
    '毕业 / 升学 / 换工作 / 搬家 / 拿到什么奖 / 体重变了 / 学会了什么新东西 这类。',
    '',
    '⚠️ 下面这些**一律不算**（一个字都不要改）：',
    '  · 一时的情绪、困了饿了、今天干了什么（那是一次性的，不是"变化"）',
    '  · 玩笑、夸张、假设（「要是我毕业了」不算）',
    '  · 他对机器人的要求、吐槽、让我改的东西',
    '  · 已经写在资料里、没有变化的事',
    '',
    '## 输出格式（严格 JSON，别的什么都不要写）',
    '{"updates": [{"old": "资料里**一字不差**存在的一小段", "new": "替换成什么", "why": "依据他哪句话"}]}',
    '',
    '⚠️⚠️ 规矩：',
    '  · `old` 必须在上面的资料里**原样出现**（复制过去，别改写、别加标点），而且要短、要能唯一定位；',
    '  · 只允许「把 A 改成 B」—— **不许删除内容**，也不许把一整段重写；',
    '  · 敏感信息（姓名 / 电话 / 邮箱 / 证件号 / 住址）**永远不要写进去**；',
    '  · 没把握就**别改**（宁可漏，也别改错）。',
    '  · 没有要改的就回 {"updates": []}',
  ].join('\n');
}

/**
 * 跑一次核对 + 更新。**只有真的改动了才写盘**。
 *
 * @param {number} [now]
 * @param {{ask?: (messages:Array)=>Promise<string>}} [opts]
 *   `ask` 只给测试用（注入假模型，就不必起 HTTP 假服务了）；不传就走真模型。
 * @returns {Promise<{ok:boolean, reason?:string, changed?:number, applied?:Array, rejected?:Array}>}
 */
export async function maybeUpdate(now = Date.now(), opts = {}) {
  const d = due(now);
  if (!d.ok) return d;
  if (running) return { ok: false, reason: '上一次还在跑' };
  running = true;
  try {
    if (!existsSync(FILE)) return { ok: false, reason: 'owner.md 不存在' };
    const ownerText = readFileSync(FILE, 'utf8');
    const batch = pending.slice(-MAX_BATCH);
    const msgs = batch.map((m) => `他说：${m.text}`).join('\n');

    const ask =
      typeof opts.ask === 'function'
        ? opts.ask
        : async (messages) => {
            let out = '';
            for await (const d2 of streamChat(messages, undefined, {
              maxTokens: 2000,
              timeoutMs: 120000,
              thinking: { type: 'disabled' },
            })) {
              out += d2;
            }
            return out;
          };
    const out = await ask([
      { role: 'system', content: '你只做事实核对，输出严格 JSON，不要解释。' },
      { role: 'user', content: buildPrompt(ownerText, msgs) },
    ]);

    const j = parseJson(out);
    const list = Array.isArray(j?.updates) ? j.updates : [];
    let next = ownerText;
    const applied = [];
    const rejected = [];

    for (const u of list) {
      const oldS = String(u?.old ?? '');
      const newS = String(u?.new ?? '').trim();
      const why = String(u?.why ?? '').slice(0, 120);
      // 底线①：old 必须原样存在
      if (!oldS || !newS || !next.includes(oldS)) {
        rejected.push({ old: oldS, why: 'old 在资料里找不到（模型编的片段）' });
        continue;
      }
      // 底线②：不许把内容改没
      if (newS.length < oldS.length * 0.4) {
        rejected.push({ old: oldS, why: 'new 比 old 短太多（像是把内容删了）' });
        continue;
      }
      // 底线③：敏感信息
      if (looksSensitive(newS)) {
        rejected.push({ old: oldS, why: 'new 里有手机号/邮箱这类敏感信息' });
        continue;
      }
      next = next.replace(oldS, newS);
      applied.push({ old: oldS, new: newS, why });
    }

    stats.rejected += rejected.length;

    if (!applied.length) {
      // 这一批核对完（没改动也要清掉，别再喂一遍）
      pending = pending.slice(batch.length);
      lastAt = now;
      saveState();
      log.info(
        `[资料] 核对了他最近的 ${batch.length} 条私聊：没有需要改的` +
          (rejected.length ? `（另有 ${rejected.length} 条提案被拒）` : ''),
      );
      return { ok: true, changed: 0, applied, rejected };
    }

    // 底线④：先备份，再写
    try {
      backupKnowledge(FILE);
    } catch (e) {
      log.warn(`[资料] 备份失败（仍继续改，但这次要留意）：${e.message}`);
    }
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, next, 'utf8');
    renameSync(tmp, FILE);
    try {
      reloadKnowledge();
    } catch (e) {
      log.debug(`[资料] 改完重载知识库失败：${e.message}`);
    }

    stats.runs++;
    stats.changed += applied.length;
    stats.lastNote = applied[0]?.new ?? '';
    pending = pending.slice(batch.length);
    lastAt = now;
    saveState();

    for (const a of applied) {
      // ⚠️ 逐条写日志 —— 用户明说了他会去检查这些改动
      log.info(`[资料] 自动更新：「${a.old.slice(0, 40)}」→「${a.new.slice(0, 40)}」（依据：${a.why}）`);
    }
    for (const r of rejected) {
      log.warn(`[资料] 这条提案被拒了：${r.why}（${String(r.old).slice(0, 40)}）`);
    }
    return { ok: true, changed: applied.length, applied, rejected };
  } catch (e) {
    stats.lastNote = `出错：${e.message}`;
    log.warn(`[资料] 自动更新出错：${e.message}`);
    return { ok: false, reason: e.message };
  } finally {
    running = false;
  }
}

loadState();
