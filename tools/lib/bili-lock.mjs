/**
 * B站 Chrome profile 的**独占锁**（2026-11-08）
 *
 * ## 为什么要有它
 *   `state/bili-profile` 一个 user-data-dir **只能被一个 Chrome 占着**（Chrome 的硬限制），
 *   而现在有 8 个脚本各自 `launchPersistentContext` 抢它：
 *   `bili-browser-serve` / `bili-proactive-comment` / `bili-upload` / `bili-login` /
 *   `bili-latest-bvid` / `bili-comment-bot` / `bili-cookie-import` / `bili-cookie-restore`
 *
 *   抢不到的那个拿到的是**空会话** ⇒ 打 nav 拿到 `isLogin=false` ⇒ 被当成
 *   「**登录态失效**」写进日志、写进 `sent` 记录 ⇒ 11-07 那天白试 19 次、
 *   用户看到界面上一片「失败」，还以为是 cookie 过期了 ✗
 *   （实际 cookie 一直是好的，`nav` 用同一份 65 条 cookie 打回去是 `isLogin=true`）
 *
 * ## 干什么
 *   · 谁要用 profile **先在文件里抢锁**，抢不到就**等/跳过**（而不是硬起一个 Chrome）；
 *   · 锁里记 `pid`：那个进程死了锁就**自动作废**（不会因为崩溃把所有人卡死）；
 *   · 带 `ttlMs`：上传那种长活给它 30 分钟，评论 3 分钟，超时也算失效。
 *
 * ## 用法
 *   ```js
 *   const lock = acquire({ who: 'upload', ttlMs: 30 * 60 * 1000 });
 *   if (!lock.ok) {
 *     // ⚠️ 这里**不是失败**，是"等下一轮" —— 别报登录态失效、别私聊打扰
 *     console.log(`profile 被 ${lock.holder.who} 占着（${lock.holder.ageMs}ms）⇒ 这轮跳过`);
 *     process.exit(0);
 *   }
 *   try { ...起 Chrome 干活... } finally { release('upload'); }
 *   ```
 */
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCK_FILE = join(ROOT, 'state', 'bili-profile.lock');
const DEFAULT_TTL = 5 * 60 * 1000;

/** 进程还活着吗（跨平台：signal 0 只探测不杀） */
function alive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    // EPERM = 存在但没权限（照样算活）；ESRCH = 不存在
    return e.code === 'EPERM';
  }
}

/** 读当前锁（不判死活）→ null / { pid, who, at, ttlMs } */
function read() {
  try {
    if (!existsSync(LOCK_FILE)) return null;
    const o = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
    if (!o || typeof o !== 'object') return null;
    return {
      pid: Number(o.pid) || 0,
      who: String(o.who || '?'),
      at: Number(o.at) || 0,
      ttlMs: Number(o.ttlMs) || DEFAULT_TTL,
    };
  } catch {
    return null;
  }
}

/** 锁还成立吗（进程活着 + 没超时） */
function valid(l) {
  if (!l) return false;
  if (!alive(l.pid)) return false;
  if (Date.now() - l.at > l.ttlMs) return false;
  return true;
}

/**
 * 当前持有者（无效锁会被顺手清掉）
 * @returns {null | {pid:number, who:string, at:number, ageMs:number, ttlMs:number}}
 */
export function holder() {
  const l = read();
  if (!l) return null;
  if (!valid(l)) {
    // 陈旧锁：进程死了 / 超时 ⇒ 清掉，别把所有人卡住
    try {
      unlinkSync(LOCK_FILE);
    } catch {
      /* ignore */
    }
    return null;
  }
  return { ...l, ageMs: Date.now() - l.at };
}

/** 只是看看有人占着没（不清锁、不抢） */
export function isBusy() {
  return holder() !== null;
}

/**
 * 抢锁
 * @param {{who?:string, ttlMs?:number, waitMs?:number}} [opts]
 *   · `waitMs` > 0 时会在这么久内轮询等（默认 0 = 抢不到立刻返回）
 * @returns {{ok:true} | {ok:false, holder:{who,ageMs,pid}}}
 */
export function acquire(opts = {}) {
  const who = String(opts.who || 'unknown');
  const ttlMs = Number(opts.ttlMs) || DEFAULT_TTL;
  const waitMs = Math.max(0, Number(opts.waitMs) || 0);
  const deadline = Date.now() + waitMs;

  for (;;) {
    const h = holder();
    if (!h) {
      try {
        mkdirSync(dirname(LOCK_FILE), { recursive: true });
        writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, who, at: Date.now(), ttlMs }), 'utf8');
        return { ok: true };
      } catch (e) {
        return { ok: false, holder: { who: '（写锁失败）', ageMs: 0, pid: 0, err: e.message } };
      }
    }
    if (Date.now() >= deadline) return { ok: false, holder: { who: h.who, ageMs: h.ageMs, pid: h.pid } };
    // 等 1.5 秒再看一次（CLI 脚本里同步等没关系，不阻塞任何事件循环关键路径）
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  }
}

/** 释放（只释放自己拿的那把，别人的不误删） */
export function release(who) {
  const l = read();
  if (!l) return false;
  const samePid = l.pid === process.pid;
  const sameWho = who == null || l.who === String(who);
  if (!samePid && !sameWho) return false;
  try {
    unlinkSync(LOCK_FILE);
    return true;
  } catch {
    return false;
  }
}

export const LOCK_PATH = LOCK_FILE;
