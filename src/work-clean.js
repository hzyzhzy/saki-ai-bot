/**
 * 群任务文件夹的**滚动清理**（2026-10-19 用户要求）
 *
 * ## 用户原话
 *   「**群聊的所有工作文件也加个清理机制吧，满 200mb 就删掉日期最早的文件夹。
 *     私聊文件夹一定不要清**」
 *
 * ## 和 `image-search.js` 那个的区别（别搞混）
 *   · `sweepImageCache()` —— 只删**图片文件**，为了防"搜图缓存撑爆"，指纹表不动；
 *   · 这个 —— 直接删**整个任务文件夹**（ppt / 论文 / 脚本 / 中间文件全在里面）✗
 *     ⇒ 删掉就真没了，所以下面每一道判据都是**白名单式**的：不认得的一律不碰 ✓
 *
 * ## 三条底线（改之前先把这三条读一遍）
 *   ① 🚫🚫 **`私聊/` 一个字节都不碰** —— 用户特别点名了。这在实现上是**双重**保证：
 *      本模块**只遍历 `群任务/` 这个子目录**（`私聊/` 在它外面，压根进不来），
 *      而且下面还有一条"路径里含 `私聊` 就跳过"的硬断言；
 *   ② 🚫 **正在跑的那个任务文件夹不删**（`keepDir`）—— 不然跑到一半产物被自己清了；
 *   ③ 🚫 **只认名字形如 `2026-10-19 0430 xxx` 的文件夹** —— `群任务/` 里哪天多出别的东西
 *      （备份、说明、临时目录），不符合这个形状的一律不碰 ✓
 *
 * ## 怎么删
 *   · 算一遍 `群任务/` 的总大小，**没超阈值就什么都不做**；
 *   · 超了 ⇒ 按**文件夹名**（`YYYY-MM-DD HHMM …`，天然就是时间顺序）从早到晚，
 *     **整个文件夹删掉**，删到不超为止；
 *   · 两道刹车：每次最多删 `MAX_DIRS` 个；而且**至少留最近 `KEEP_RECENT` 个** ——
 *     万一某个任务自己就几百 MB，别一口气把历史全端了 ✗
 */

import { readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { log } from './log.js';

/** 一次最多删几个文件夹（防"一个巨物撑爆 ⇒ 一路删到底"） */
const MAX_DIRS = 5;
/**
 * 不管超了多少，**至少留最新这一个**（防「删着删着把最新那个也端了」）。
 * ⚠️ 别写成 3：任务文件夹总共才两三个的时候，`3` 会让「可删列表」永远是空的 ⇒
 *    那个几百 MB 的任务就**永远清不掉** ✗（`test/work-clean.js` 的【4】就是抓这个的）
 */
const KEEP_RECENT = 1;

/** 递归算一个目录多大（算不出来就按 0，别让清理本身报错） */
function sizeOf(dir) {
  let total = 0;
  const walk = (d) => {
    let items = [];
    try {
      items = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const p = join(d, it.name);
      if (it.isDirectory()) {
        walk(p);
        continue;
      }
      try {
        total += statSync(p).size;
      } catch {
        /* 单个文件读不到就跳过 */
      }
    }
  };
  walk(dir);
  return total;
}

/**
 * 清一次群任务文件夹。
 *
 * @param {object} p
 * @param {string} p.root      `群任务/` 的绝对路径（由调用方给 —— 本模块不 import `agent-bridge`，免得成环）
 * @param {number} [p.maxMB]   超过多少 MB 开始删（默认 200）
 * @param {string} [p.keepDir] 正在跑的那个任务文件夹（不删）
 * @param {boolean} [p.dryRun] true = 只算一遍、**不真删**（自检用）
 * @returns {{totalMB:number, removed:number, freedMB:number, would:Array<{name:string,mb:number}>}}
 */
export function sweepGroupTasks({ root, maxMB = 200, keepDir = '', dryRun = false } = {}) {
  const none = { totalMB: 0, removed: 0, freedMB: 0, would: [] };
  const base = String(root ?? '').trim();
  if (!base || !existsSync(base)) return none;

  const keep = String(keepDir ?? '').replace(/[\\/]+$/, '');
  let dirs = [];
  try {
    dirs = readdirSync(base, { withFileTypes: true }).filter((it) => it.isDirectory());
  } catch (e) {
    log.debug(`[清理] 列群任务文件夹失败：${e.message}`);
    return none;
  }

  // ⚠️ 白名单：只认 `2026-10-19 0430 …` 这种**任务文件夹**
  //    ⚠️⚠️ 注意「**计入总量**」和「**可以删**」是两件事：
  //       正在跑的那个文件夹也要算进总量（它同样占着 200MB 的额度），
  //       只是**不许删** ✗ —— 早先写成"跳过就不计入"，结果是"正在跑的那个再大也清不动" ✗
  const tasks = [];
  let totalMB = 0;
  for (const it of dirs) {
    const p = join(base, it.name);
    // 🚫 私聊：双重保险（正常情况它压根不在 `群任务/` 里）
    if (/私聊/.test(p) || /私聊/.test(it.name)) continue;
    // 只认任务文件夹的形状（备份 / 说明 / 临时目录一律不算、也不碰）
    if (!/^\d{4}-\d{2}-\d{2} \d{4}/.test(it.name)) continue;
    const mb = sizeOf(p) / 1024 / 1024;
    totalMB += mb; // 计入总量（含正在跑的那个）
    if (p === keep || p.startsWith(`${keep}\\`) || p.startsWith(`${keep}/`)) continue; // 但不删它
    tasks.push({ name: it.name, path: p, mb });
  }
  if (totalMB <= maxMB) return { totalMB: Math.round(totalMB), removed: 0, freedMB: 0, would: [] };

  // 按名字排 = 按时间排（`YYYY-MM-DD HHMM …`）⇒ **最早的在最前面**
  tasks.sort((a, b) => a.name.localeCompare(b.name));
  // 「至少留 1 个」：这次如果带了 `keepDir`（正在跑的那个），它本身就是被留着的那个 ⇒
  // 不用再从可删列表里扣 —— 扣了的话，「总共就俩文件夹、其中一个还在跑」时**啥也删不掉** ✗
  const reserve = keep ? 0 : KEEP_RECENT;
  const deletable = tasks.slice(0, Math.max(0, tasks.length - reserve));

  let freed = 0;
  let removed = 0;
  const would = [];
  for (const t of deletable) {
    if (totalMB - freed <= maxMB) break;
    if (removed >= MAX_DIRS) break;
    would.push({ name: t.name, mb: Math.round(t.mb) });
    if (dryRun) {
      freed += t.mb; // 只算「会释放多少」；`removed` 保持 0（一个都没真删）
      continue;
    }
    try {
      rmSync(t.path, { recursive: true, force: true });
      freed += t.mb;
      removed++;
      log.info(`[清理] 群任务满了（${Math.round(totalMB)}MB > ${maxMB}MB）⇒ 删掉最早的一个：${t.name}（${Math.round(t.mb)}MB）`);
    } catch (e) {
      log.warn(`[清理] 删 ${t.name} 失败（跳过它，接着看下一个）：${e.message}`);
    }
  }

  return { totalMB: Math.round(totalMB), removed, freedMB: Math.round(freed), would };
}
