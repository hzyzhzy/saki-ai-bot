/**
 * 人的真实身份：**QQ 号 ↔ 昵称** 的映射。
 *
 * ⚠️ 为什么需要它（2026-11-27）：
 *   群记忆里记的是 `- 昵称：评价`，而 **昵称是可以随便改的**（群名片、马甲、模型写歪的
 *   「Anon（补充三）」）。于是同一个人在记忆里会分成好几条 —— 实测 Anon 一个人被写成了
 *   **13 种**写法。只按昵称合并永远合不干净。
 *   ⇒ 记一份 `QQ号 → 昵称/群名片`，以后**按 QQ 号合并**；昵称只拿来显示。
 *
 * ⚠️ 只做三件事：记（`touch`）、查（`uidOfName` / `nickOf`）、存 `state/people.json`。
 *    **不写知识库、不参与判断** —— 它是一张通讯录，不是一个"印象"。
 * ⚠️ 昵称以 **QQ 昵称（nickname）** 为准来显示；群名片（card）只当别名用来认人。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './config.js';
import { log } from './log.js';

// ⚠️ `QQBOT_PEOPLE_FILE` 是给测试/模拟器隔离用的（别在真机上设）；
//    没设就用这个号的 `state/people.json`
const FILE = () => process.env.QQBOT_PEOPLE_FILE || join(stateDir(), 'people.json');

let cache = null;

/**
 * 读进内存（**一个进程只读一次**）。
 * ⚠️⚠️ 这里踩过一个坑：原来按"文件 mtime"判要不要重读，而 mtime 取的是 `Date.now()`
 *    ⇒ 每次调用都不相等 ⇒ 每次都重读文件并**覆盖内存里的修改** ⇒
 *    批量导入 840 个人，最后只剩 1 个（每次 touch 都把上一次的成果冲掉）✗
 *    现在：进程内缓存一次，写盘只走 `saveSoon()` / `flush()`。
 */
function load() {
  if (cache) return cache;
  try {
    const o = JSON.parse(readFileSync(FILE(), 'utf8'));
    cache = { byUid: o.byUid && typeof o.byUid === 'object' ? o.byUid : {} };
  } catch {
    cache = { byUid: {} };
  }
  return cache;
}

let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(FILE(), JSON.stringify(cache, null, 2), 'utf8');
    } catch (e) {
      log.warn(`[通讯录] 写盘失败（不影响聊天）：${e.message}`);
    }
  }, 3000);
  if (saveTimer.unref) saveTimer.unref();
}

/** 立刻落盘（批量导入之后用，别等那 3 秒） */
export function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(FILE(), JSON.stringify(cache ?? load(), null, 2), 'utf8');
  } catch (e) {
    log.warn(`[通讯录] 写盘失败（不影响聊天）：${e.message}`);
  }
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * 见到一个人就记一笔（每收到一条消息调用一次，成本可以忽略：内存里改一个对象）。
 * @param {{uid:string|number, nick?:string, card?:string, gid?:string}} p
 */
export function touch({ uid, nick = '', card = '', gid = '' } = {}) {
  const id = String(uid ?? '').trim();
  if (!/^\d{5,12}$/.test(id)) return;
  // 机器人自己不算
  if (id === String(globalThis.__selfId ?? '')) return;
  const db = load();
  const cur = db.byUid[id] ?? { nick: '', cards: {}, groups: {}, seenAt: 0 };
  const nk = clean(nick);
  const cd = clean(card);
  let changed = false;
  // ⚠️ 昵称以**最近一次 QQ 昵称**为准；群名片单独存（同一个人在别的群可能叫别的）
  if (nk && cur.nick !== nk) {
    cur.nick = nk;
    changed = true;
  }
  if (cd && cd !== nk && !cur.cards[cd]) {
    cur.cards[cd] = Date.now();
    changed = true;
  }
  if (gid && !cur.groups[String(gid)]) {
    cur.groups[String(gid)] = Date.now();
    changed = true;
  }
  cur.seenAt = Date.now();
  db.byUid[id] = cur;
  if (changed) saveSoon();
}

/** 这个昵称（QQ 昵称或群名片）对应哪个 QQ 号；认不出返回 '' */
export function uidOfName(name) {
  const key = clean(name);
  if (!key) return '';
  const db = load();
  // ① 先比 QQ 昵称
  for (const [uid, v] of Object.entries(db.byUid)) {
    if (v?.nick === key) return uid;
  }
  // ② 再比群名片
  for (const [uid, v] of Object.entries(db.byUid)) {
    if (v?.cards && v.cards[key]) return uid;
  }
  return '';
}

/** QQ 号对应的**QQ 昵称**（没有就退回群名片，再没有返回空） */
export function nickOf(uid) {
  const db = load();
  const v = db.byUid[String(uid ?? '')];
  if (!v) return '';
  return v.nick || Object.keys(v.cards || {})[0] || '';
}

/** 这份数据现在有多少人（界面上可以报个数） */
export function size() {
  const db = load();
  return Object.keys(db.byUid).length;
}
