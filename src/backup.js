/**
 * knowledge/ 下 md 文件的**自动备份**。
 *
 * 为什么要：这台机器上**没有 git**，而 knowledge 里的东西是「教一次就改一次」的 ——
 * 教错了、模型抽错了一条（真实踩过：把分享卡片里的玩笑话
 * 「东心乡又名大足特别行政区」抽成了知识）、或者手滑删了段落，
 * **都没有办法回滚**。
 *
 * 策略：
 *   · 在**每次写入之前**先快照一份
 *   · 存到 `knowledge/_backup/<时间戳>__<文件名>`
 *   · **每个文件只留最近 N 份**（默认 10），自动清老的，不占地方
 *
 * ⚠️ 只在真正要改文件时调用，别在启动时无脑备份（那样会很快把配额刷满）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join, basename, isAbsolute } from 'node:path';
import { ROOT, KNOWLEDGE_DIR } from './config.js';
import { log } from './log.js';

const KNOW = KNOWLEDGE_DIR;
const BACKUP = join(KNOW, '_backup');
/** 每个文件保留几份 */
const KEEP = 10;

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  // ⚠️ 带毫秒：同一秒内可能连着改两次（比如「教一条 → 又删掉」），
  //    只精确到秒的话两次备份会撞名、后面那次把前面覆盖掉（实测少了 1 份）。
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`
  );
}

/**
 * 备份一个 knowledge 文件（在写入**之前**调用）。
 * @param {string} filePath 绝对路径，或 knowledge 下的文件名
 * @returns {string|null} 备份文件路径
 */
export function backupKnowledge(filePath) {
  try {
    // ⚠️ 用 `isAbsolute` 判断，**别再用 `includes('knowledge')`**（2026-09-15）：
    //    那个子串判据在"目录被 `QQBOT_KNOWLEDGE_DIR` 搬走"之后就不可靠了
    //    （新目录名里未必含 knowledge），而 `join(KNOW, 绝对路径)` 会拼出一个不存在的路径。
    const src = isAbsolute(String(filePath)) ? String(filePath) : join(KNOW, String(filePath));
    if (!existsSync(src)) return null; // 新文件，没什么可备份的
    const name = basename(src);
    if (!name.endsWith('.md')) return null;

    mkdirSync(BACKUP, { recursive: true });
    const dst = join(BACKUP, `${stamp()}__${name}`);
    writeFileSync(dst, readFileSync(src));
    prune(name);
    log.debug(`[备份] ${name} → ${basename(dst)}`);
    return dst;
  } catch (e) {
    // 备份失败不能挡住正常流程 —— 它是保护措施，不是主功能
    log.warn(`[备份] ${basename(String(filePath))} 备份失败：${e.message}`);
    return null;
  }
}

/** 只保留每个文件最近 KEEP 份 */
function prune(name) {
  try {
    const mine = readdirSync(BACKUP)
      .filter((f) => f.endsWith(`__${name}`))
      .sort(); // 时间戳前缀，字典序就是时间序
    for (const f of mine.slice(0, Math.max(0, mine.length - KEEP))) {
      unlinkSync(join(BACKUP, f));
    }
  } catch {}
}

/** 备份目录概况（管理界面/排障用） */
export function backupStats() {
  try {
    if (!existsSync(BACKUP)) return { dir: BACKUP, files: 0, mb: 0, keep: KEEP };
    const list = readdirSync(BACKUP);
    let bytes = 0;
    for (const f of list) {
      try {
        bytes += statSync(join(BACKUP, f)).size;
      } catch {}
    }
    return { dir: BACKUP, files: list.length, mb: Math.round((bytes / 1048576) * 100) / 100, keep: KEEP };
  } catch {
    return { dir: BACKUP, files: 0, mb: 0, keep: KEEP };
  }
}

/** 列出某个文件的备份记录（新的在前） */
export function listBackups(name = '') {
  try {
    if (!existsSync(BACKUP)) return [];
    return readdirSync(BACKUP)
      .filter((f) => (name ? f.endsWith(`__${name}`) : true))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}
