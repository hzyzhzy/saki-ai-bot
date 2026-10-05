import { mkdirSync } from 'node:fs';
// ⚠️⚠️ 必须用 `fs/promises` 的 appendFile —— 回调版的 `fs.appendFile(path, data, 'utf8')`
//    第三个参数是 **callback**，传 'utf8' 会直接抛
//    `The "cb" argument must be of type function. Received type string ('utf8')` ✗
//    （2026-10-03 我自己踩的：改异步那天开始，按天日志从 01:15 起**整整断了**，
//      因为 `diskBroken` 一置位就"只输出到控制台"，而控制台在 %TEMP% 里）
import { appendFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { config, ROOT, CONFIG_FILE, ACCOUNT } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * ⚠️⚠️ 2026-10-03：**日志同时落盘，按天一个文件**（`logs/bot-YYYY-MM-DD.log`）。
 *
 * 为什么由这里写、而不是让 `_run-bot.bat` 重定向过去（用户要求「日志按天留存」）：
 *
 *   原来靠 bat 重定向 `> logs\bot.log`，每次启动**覆盖** ⇒ 证据全丢。
 *   9/20 给 bat 加了"启动前改名成 bot-<时分秒>.log、留 10 份"，
 *   但**看门狗启动时会先 `Remove-Item logs\bot.log`** ⇒ bat 那段什么也保不住 ⇒
 *   凡是看门狗拉起来的重启，上一次的日志就没了 ✗
 *   （真实后果：用户报「刚才我发的消息没回」，我翻日志只剩启动信息。）
 *
 *   改成"bat 里算日期 + 按天追加"之后**又踩了一次**：cmd 里那套取日期的写法
 *   在**隐藏窗口 / 非交互**启动下会失败（实测写进了 `bot-unknown.log`）——
 *   而机器人平时几乎都是看门狗这样拉起来的 ⇒ 等于没改。
 *
 *   ⇒ 结论：**日期交给 Node 算**（`new Date()` 永远可靠），bat 那边只留
 *     `> logs\bot-console.log` 抓"起不来"时的原始输出（那条路 Node 还没跑起来）。
 *
 * ⚠️ 写盘失败**绝不能让机器人崩**（磁盘满/权限）⇒ 整段包 try/catch，
 *    而且出错后不再反复报（`diskBroken` 一次就够，免得刷屏）。
 */
const LOG_DIR = join(ROOT, 'logs');
let diskBroken = false;
try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {
  /* 建不了一会在 writeDisk 里报 */
}

function logFile() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  // ⚠️⚠️ **测试隔离**（和 `tic.js` 的 `stateFile()` 同一个判据）：
  //    十几个套件都会 spawn 真实的 `src/index.js`，而它们**本来就都设了**
  //    `QQBOT_CONFIG=config.*-test.yml` ⇒ 配置名带 test 就写到 `__test-*.log`，
  //    绝不往真实的按天日志里灌假日志（那份是我用来查"用户刚才那条为什么没回"的 ✗）。
  const cfgName = basename(CONFIG_FILE ?? '');
  if (/test/i.test(cfgName)) {
    return join(LOG_DIR, `__test-${cfgName.replace(/\.ya?ml$/i, '')}.log`);
  }
  // ⚠️ 2026-10-07 多 QQ 号：**非主号**写到带号后缀的文件（`bot-<日期>-<QQ>.log`），
  //    免得两个进程的行交错在一起 —— 排障时"这一句到底是谁说的"必须一眼看出来。
  //    主号（也是默认那个号）**保持老文件名**，用户翻日志的习惯不变。
  const suffix = ACCOUNT.id && !ACCOUNT.isMain ? `-${ACCOUNT.id}` : '';
  return join(
    LOG_DIR,
    `bot-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}${suffix}.log`,
  );
}

/**
 * ⚠️⚠️ 2026-10-03：**改成异步写**（原来是 `appendFileSync`）。
 *
 * 现场（`logs/bot-2026-10-03.log`）：
 *   `01:03:48 拼提示词 5565 ms（71604 字）` / `01:06:00 拼提示词 6148 ms（71569 字）`
 * 而 `buildSystemPrompt` **没有 await、没有读文件、没有任何重活**（我用探针
 * 把它的几个子模块都量过：knowledge / holiday / names / recent 全是 0~0.8 ms）。
 * 唯一"重"的就是它里面有 **14 处 `log.*`** —— 而每一处都在**同步写盘**，
 * 这个项目又整个放在 **OneDrive 目录**里（同步写小文件在这儿特别贵）。
 * 加上 `_run-bot.bat` 还把 stdout 重定向到 `logs\bot-console.log`（也在 OneDrive）
 * ⇒ 一条日志 = **两次同步写 + 云同步**。
 *
 * ⇒ 日志绝不该拖慢回复：改成**串行 promise 链 + 异步 append**（顺序照旧、不阻塞）。
 * ⚠️ 顺序必须保住，否则日志行会乱序 —— 排障时最恨这个。
 */
let chain = Promise.resolve();

function writeDisk(line) {
  if (diskBroken) return;
  chain = chain.then(() => appendFile(logFile(), line, 'utf8')).catch((e) => {
    diskBroken = true;
    // 只能用 console 报 —— log 自己坏了
    console.error(`[日志] 写文件失败，之后只输出到控制台：${e.message}`);
  });
}

function emit(level, args) {
  if (LEVELS[level] < threshold) return;
  const tag = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' }[level];
  const line = `[${ts()}] ${tag} `;
  const text = line + args.map(String).join(' ') + '\n';
  const sink = level === 'error' || level === 'warn' ? console.error : console.log;
  sink(text.replace(/\n$/, ''));
  writeDisk(text);
}

export const log = {
  debug: (...a) => emit('debug', a),
  info: (...a) => emit('info', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
};

/** 给测试/排障看：这次会写到哪个文件 */
export function currentLogFile() {
  return logFile();
}
