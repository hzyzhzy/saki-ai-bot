/**
 * 多 QQ 号（账号）—— 一个应用端控制多个号。
 *
 * ## 为什么要有这个文件（2026-10-07 用户要求）
 *
 * 用户原话：「我希望从一个应用端控制多个 QQ 号……只有模型页面所有 QQ 共用，
 * 其他配置全部分 QQ 控制，然后配置可以被复用」。
 *
 * 为什么要**一号一个进程**、而不是一个进程里跑多个 Bot：
 *   `src/` 下有 **25 个模块**把状态写在模块级变量里（`let store = {}`），
 *   状态文件的路径又是各处 `join(ROOT, 'state', 'x.json')` 写死的。
 *   在一个进程里塞两个号 = 这 25 个模块全都要改成"按号分桶" ⇒ 改动面太大、
 *   而且任何一个漏改都会让**两个号互相串数据**（最阴的那类 bug）。
 *   ⇒ 所以：**一个号一个 node 进程**，用不同的 `QQBOT_ACCOUNT` 拉起来，
 *     每个进程各自是完整的单例世界，谁也不用改内部结构。
 *
 * ## 配置怎么分家（用户拍板：只有模型页共用）
 *
 *   `config.yml`            —— **共用**那份（大模型 / 生图 / 搜索 / 识图 / 协议端 /
 *                              界面端口 / 清理策略 …）
 *   `accounts/<QQ>.yml`     —— **这个号私有**的一份（触发灵敏度 / 按群设定 / 日常事件 /
 *                              剧情 / 好感度 / QQ空间 / 机器人QQ / 人设包选择 …）
 *
 *   ⚠️ 私有文件是**覆盖**(override)，不是整份配置：里面只写要改的键，
 *      读的时候 `merge(共用, 私有)`。这样"共用改了、私有没写"的键会自动跟着变。
 *
 *   ⚠️ **主号走老路径**（见下面 `isMain`）：用户原来那个号的数据文件**一个都不搬** ——
 *      `state/*.json`、`knowledge/group-memory.md`、`logs/bot-<日期>.log` 全都不动。
 *      新加的号才用子目录（`state/accounts/<QQ>/` 等）。
 *      为什么：迁移那些文件是不可逆操作，而"主号零迁移"能让**向后兼容是天然的** ——
 *      旧配置、旧数据、旧回归套件全都照原样跑。
 *
 * ## 成环问题
 *
 *   `config.js` 要 import 本文件（拿当前账号、私有配置），所以**本文件绝对不能
 *   import `config.js`** —— 这里自己算 `ROOT`，也不去解析 `config.yml`（那是 config.js 的事）。
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';
import { createServer } from 'node:net';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');

/**
 * 账号目录。⚠️ 测试必须能整份搬走（和 `QQBOT_KNOWLEDGE_DIR` 一个道理）——
 * 不然套件一跑就会往用户真实的 `accounts/` 里写假号。
 */
export const ACCOUNTS_DIR = process.env.QQBOT_ACCOUNTS_DIR
  ? (isAbsolute(process.env.QQBOT_ACCOUNTS_DIR)
      ? process.env.QQBOT_ACCOUNTS_DIR
      : join(ROOT, process.env.QQBOT_ACCOUNTS_DIR))
  : join(ROOT, 'accounts');

/** QQ 号必须是纯数字（它会被拼进文件名，不能让 `../` 之类的东西进来） */
export function isValidId(qq) {
  return /^\d{5,12}$/.test(String(qq ?? '').trim());
}

export function fileOf(qq) {
  return join(ACCOUNTS_DIR, `${String(qq).trim()}.yml`);
}

/** 目录里已有哪些号 —— 只认 `<纯数字>.yml`，别的文件（模板、备份）一律不当账号 */
export function ids() {
  let names = [];
  try {
    names = readdirSync(ACCOUNTS_DIR);
  } catch {
    return []; // 目录还没有 = 还没配过多号
  }
  return names
    .filter((n) => /^\d{5,12}\.ya?ml$/i.test(n))
    .map((n) => n.replace(/\.ya?ml$/i, ''))
    .sort();
}

export function has(qq) {
  return isValidId(qq) && existsSync(fileOf(qq));
}

/** 读某个号的私有配置。文件不存在 / 解析失败 → null（**不抛**，让调用方回落共用那份） */
export function read(qq) {
  if (!isValidId(qq)) return null;
  try {
    const o = yaml.load(readFileSync(fileOf(qq), 'utf8')) ?? {};
    return typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

/** 原子写（写 `.tmp` 再 rename —— 和项目里其它落盘一个写法，防写一半断电） */
export function write(qq, obj) {
  if (!isValidId(qq)) throw new Error(`QQ 号不合法：${qq}`);
  mkdirSync(ACCOUNTS_DIR, { recursive: true });
  const p = fileOf(qq);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, yaml.dump(obj, { lineWidth: 120, noRefs: true }), 'utf8');
  renameSync(tmp, p);
  return p;
}

/** 只改某一段里的几个键（深合并一层）—— 界面保存走它 */
export function patch(qq, patchObj) {
  const cur = read(qq) ?? {};
  write(qq, deepMerge(cur, patchObj ?? {}));
  return read(qq);
}

/** 深合并（对象递归、数组整体替换）—— 和 `config.js` 里那份语义一致，别改歪 */
export function deepMerge(base, over) {
  if (over === undefined || over === null) return base;
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

/**
 * 新建一个号。
 *
 * @param {string} qq      新号的 QQ
 * @param {object} opt
 * @param {string} [opt.name]     界面上的备注名（例如「素世那个号」）
 * @param {string} [opt.copyFrom] 从哪个号复制私有配置（用户要求「配置可以被复用」）
 * @param {string[]} [opt.sections] 只复制这几段；不传 = 除 `onebot` 外全部
 * @param {number} [opt.webuiPort] 这个号的管理界面端口
 *
 * ⚠️ **`onebot` 永远不复制** —— 它里面是 `url` / `accessToken`，
 *    那是**那个号专属**的连接凭据，复制过去会让两个进程抢同一个 WS 端口。
 * ⚠️ `botQQ` 强制写成新号（复制来的值是旧号的，不改就会"登录脚本去登录别人"）。
 */
export function create(qq, opt = {}) {
  if (!isValidId(qq)) throw new Error(`QQ 号不合法：${qq}（只能是 5~12 位数字）`);
  if (has(qq)) throw new Error(`这个号已经有了：${qq}`);

  let body = {};
  const from = String(opt.copyFrom ?? '').trim();
  if (from && has(from)) {
    const src = read(from) ?? {};
    const skip = new Set(['onebot', 'botQQ']);
    for (const [k, v] of Object.entries(src)) {
      if (skip.has(k)) continue;
      if (Array.isArray(opt.sections) && opt.sections.length && !opt.sections.includes(k)) continue;
      body[k] = v;
    }
  }
  body = deepMerge({ name: '', note: '' }, body);
  if (opt.name !== undefined) body.name = String(opt.name).trim();
  // ⚠️ botQQ 放在最后写死，覆盖任何复制来的值
  body.botQQ = String(qq);
  if (Number.isInteger(opt.webuiPort) && opt.webuiPort > 0) {
    body.webui = { ...(body.webui ?? {}), port: opt.webuiPort };
  }
  write(qq, body);
  return body;
}

/**
 * 删掉一个号。
 *
 * ⚠️ **默认先备份**（搬到 `accounts/_deleted/<QQ>.yml-<时间戳>`）——
 *    这个文件里有 token 和整套按群设定，误删一次要么重配要么去 git 里翻。
 *    `git` 里确实有一份，但那是「上次提交时的」，中间改的会丢 ⇒ 备份更实在。
 */
export function remove(qq, opt = {}) {
  if (!has(qq)) throw new Error(`没有这个号：${qq}`);
  const p = fileOf(qq);
  if (opt.backup !== false) {
    const dir = join(ACCOUNTS_DIR, '_deleted');
    mkdirSync(dir, { recursive: true });
    const d = new Date();
    const stamp =
      `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}` +
      `-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
    renameSync(p, join(dir, `${qq}.yml-${stamp}`));
    return join(dir, `${qq}.yml-${stamp}`);
  }
  rmSync(p, { force: true });
  return '';
}

/** 界面上的显示名（没写备注就用 QQ 号本身） */
export function displayName(qq) {
  const o = read(qq);
  const n = String(o?.name ?? '').trim();
  return n || `${qq}`;
}

/** 这个号的私有文件最后一次改动（界面上显示"多久没动过了"） */
export function mtime(qq) {
  try {
    return statSync(fileOf(qq)).mtimeMs;
  } catch {
    return 0;
  }
}

/** 端口空不空（异步）—— 建号时自动挑一个没被占的 */
export function portFree(port) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

/**
 * 给新号挑一个管理界面端口。
 *
 * ⚠️ 从 3100 往上找（主号是 `config.yml` 里的 3099，别去碰它）——
 *    每个号都要开自己的界面端口：**界面上的"切号"是转发到那个号的进程**，
 *    没有端口就没法转发（见 `webui.js` 顶部那段）。
 */
export async function allocatePort(taken = [], start = 3100) {
  const busy = new Set((taken ?? []).map((x) => Number(x)).filter((x) => Number.isInteger(x)));
  for (let p = start; p < start + 200; p++) {
    if (busy.has(p)) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await portFree(p)) return p;
  }
  return 0;
}
