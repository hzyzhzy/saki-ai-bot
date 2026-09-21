/**
 * **登录凭据自动备份 / 恢复**（2026-09-20 用户要求）。
 *
 * ## 用户原话
 *
 * > 「直接做一个自动备份，**登录成功之后就自动备份**，**被踢之后就自动使用备份登录一次**，
 * >   **登录失败就自动删掉备份然后显示二维码**。」
 *
 * ## 为什么需要（背景，别删）
 *
 * 这个号被腾讯标成「风险设备」，**每 2~4 小时被 `KickedOffLine` 一次**
 * （2026-09-19 实测时刻：02:02 / 12:25 / 14:34 / 17:44 / 22:47 / 次日 01:06）。
 * 目前每次被踢都能**靠本地凭据自动快登回来**（`node tools/napcat-state.mjs` → `online:cred`），
 * 但这份凭据**会被清掉** —— 项目里踩过一次（当时状态 `stale:nocred`，只能扫码）。
 * 真到那天又是在半夜，机器人就会**卡在等扫码**，一直不在线。
 * 所以：平时留一份备份，被踢且凭据没了时**先拿备份试一次**。
 *
 * ## ⚠️⚠️ 这是什么文件、以及它的安全边界
 *
 * `napcat/.credential` 是 NapCat 存快速登录凭据的地方（Base64 的 JSON：
 * `{Data:{CreatedTime,HashEncoded},Hmac}`，约 256 字节）——
 * 2026-09-20 逐目录排查确认过：QQNT 的 `nt_db` 里**没有** login 类库、
 * Windows 凭据管理器里也**没有** QQ 登录态，**就这一个文件**。
 * （排查命令留档：按 `LastWriteTime` 找 napcat 目录近 8 小时写过的文件、列 `nt_db`、
 *   `cmdkey /list`。）
 *
 * 因此这个文件等价于**这个 QQ 号的登录凭据**，规矩钉死：
 *
 * 1. **只在本机**（`logs/cred-backup/`）—— 不上传、不发出去、不贴进聊天；
 * 2. `logs/` 本来就在 `.gitignore` 里，而且公开副本的导出**跳过清单里也有 `logs`** →
 *    双保险，**绝不会进版本库或公开仓库**（别把它挪到 `state/` 或项目根目录 ✗）；
 * 3. 代码里**不打印凭据内容**（日志只说"备份了几份、成功没有"）。
 *
 * ## 三条策略（对应用户那三句）
 *
 * | 时机 | 动作 |
 * | --- | --- |
 * | **登录成功**（机器人日志出现「已登录 QQ」） | `backup()` —— 存一份，**保留最近 5 份** |
 * | **被踢**（看门狗发现 `nocred` / 等扫码） | `restore()` —— 拿**最新**那份放回去，**只试一次** |
 * | **恢复后还是登不上** | `clear()` —— **删掉备份**（它已经废了，留着会反复试）+ 出二维码 |
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, rmSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ROOT } from './config.js';
import { log } from './log.js';

/** 备份放这儿（⚠️ `logs/` 被 gitignore，重装/清理时也方便一起删） */
const BACKUP_ROOT = join(ROOT, 'logs', 'cred-backup');

/** 留几份（防"最新那份恰好是坏的"） */
const KEEP = 5;

/**
 * 要备份的文件（相对各自根目录）。
 * ⚠️ 目前确认**只有 `.credential`** 是真正的凭据；`passkey.json` 一起带上纯属保险
 *    （它当前是空的，但 NapCat 换版本后可能会写东西）。
 */
const ITEMS = [
  { name: 'credential', rel: '.credential', base: 'napcat' },
  { name: 'passkey', rel: join('NapCat.Shell', 'config', 'passkey.json'), base: 'napcat' },
];

/**
 * NapCat 目录在哪（`qq-ai-bot/../napcat` 或 `qq-ai-bot/napcat` 都试）。
 * ⚠️ 和 `tools/napcat-align-token.mjs` 一个口径 —— 这机器上它在**上一级**。
 */
function napcatDir() {
  for (const p of [join(ROOT, '..', 'napcat'), join(ROOT, 'napcat')]) {
    if (existsSync(join(p, '.credential')) || existsSync(join(p, 'NapCat.Shell'))) return p;
  }
  return join(ROOT, '..', 'napcat');
}

/** 某个条目在磁盘上的绝对路径 */
function livePathOf(item) {
  return join(napcatDir(), item.rel);
}

/**
 * 现在这份凭据在不在（**只看有没有、多大**，绝不读内容）。
 * ⚠️ 不读内容是有意的：内容会被打进日志/错误信息里，那是凭据泄漏。
 */
export function liveCredOk() {
  const p = livePathOf(ITEMS[0]);
  try {
    return existsSync(p) && statSync(p).size > 0;
  } catch {
    return false;
  }
}

/** 备份目录（按时间排序，新的在后） */
function backupDirs() {
  try {
    if (!existsSync(BACKUP_ROOT)) return [];
    return readdirSync(BACKUP_ROOT)
      .filter((n) => /^\d{8}-\d{6}$/.test(n))
      .sort();
  } catch {
    return [];
  }
}

/**
 * **登录成功后调它**：把当前凭据存一份。
 * @returns {{ok:boolean, dir?:string, files?:number, kept?:number, error?:string}}
 */
export function backup(now = new Date()) {
  try {
    const files = ITEMS.filter((it) => existsSync(livePathOf(it)));
    if (!files.length) return { ok: false, error: '没找到凭据文件（NapCat 目录对吗？）' };

    const pad = (n) => String(n).padStart(2, '0');
    const stamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const dir = join(BACKUP_ROOT, stamp);
    mkdirSync(dir, { recursive: true });

    let n = 0;
    for (const it of files) {
      const src = livePathOf(it);
      const dst = join(dir, it.name);
      try {
        // ⚠️ 先写 `.tmp` 再改名 —— 备份写到一半被杀掉，不会留下一个"半份"的坏备份
        const tmp = `${dst}.tmp`;
        copyFileSync(src, tmp);
        renameSync(tmp, dst);
        n++;
      } catch (e) {
        log.warn(`[凭据备份] ${it.name} 没拷成：${e.message}`);
      }
    }
    if (!n) {
      rmSync(dir, { recursive: true, force: true });
      return { ok: false, error: '一个文件都没拷成' };
    }

    // 只留最近 KEEP 份
    const dirs = backupDirs();
    let removed = 0;
    for (const old of dirs.slice(0, Math.max(0, dirs.length - KEEP))) {
      try {
        rmSync(join(BACKUP_ROOT, old), { recursive: true, force: true });
        removed++;
      } catch {
        /* 删不掉就算了，不影响这次备份 */
      }
    }
    log.info(`[凭据备份] 已存 ${n} 个文件 → ${stamp}${removed ? `（顺手清了 ${removed} 份旧的）` : ''}`);
    return { ok: true, dir, files: n, kept: Math.min(KEEP, backupDirs().length) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 最新一份备份的目录（没有就 null） */
export function latest() {
  const dirs = backupDirs();
  return dirs.length ? join(BACKUP_ROOT, dirs[dirs.length - 1]) : null;
}

/**
 * **被踢之后调它**：把最新那份备份放回原位。
 *
 * ⚠️ 调用方（看门狗）的规矩是"**只试一次**"：这次不行就 `clear()` + 出二维码，
 *    别反复拿一份已经废掉的凭据去撞风控。
 *
 * @returns {{ok:boolean, from?:string, files?:number, error?:string}}
 */
export function restore() {
  const dir = latest();
  if (!dir) return { ok: false, error: '没有任何备份' };
  try {
    let n = 0;
    for (const it of ITEMS) {
      const src = join(dir, it.name);
      if (!existsSync(src)) continue;
      const dst = livePathOf(it);
      mkdirSync(dirname(dst), { recursive: true });
      const tmp = `${dst}.restore-tmp`;
      copyFileSync(src, tmp);
      renameSync(tmp, dst);
      n++;
    }
    if (!n) return { ok: false, error: '备份里没有可用的文件' };
    log.info(`[凭据备份] 已从 ${dir.split(/[\\/]/).pop()} 恢复 ${n} 个文件（接下来重启协议端试一次快登）`);
    return { ok: true, from: dir, files: n };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** **恢复失败后调它**：把备份全删掉（凭据已废，留着会让我们反复去撞风控） */
export function clear() {
  try {
    const n = backupDirs().length;
    if (existsSync(BACKUP_ROOT)) rmSync(BACKUP_ROOT, { recursive: true, force: true });
    if (n) log.warn(`[凭据备份] 备份已失效 → 删掉全部 ${n} 份（以后要扫码了）`);
    return { ok: true, removed: n };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 给界面/排查看的状态（⚠️ 不含任何凭据内容） */
export function status() {
  const dirs = backupDirs();
  const last = dirs.length ? dirs[dirs.length - 1] : '';
  return {
    live: liveCredOk(),
    count: dirs.length,
    latest: last,
    latestAt: last
      ? `${last.slice(0, 4)}-${last.slice(4, 6)}-${last.slice(6, 8)} ` +
        `${last.slice(9, 11)}:${last.slice(11, 13)}:${last.slice(13, 15)}`
      : '',
    dir: BACKUP_ROOT,
    keep: KEEP,
  };
}
