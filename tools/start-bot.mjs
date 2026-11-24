#!/usr/bin/env node
/**
 * **无窗口启动机器人**（2026-11-18 定，写进 AGENTS 铁律）
 *
 * ## 为什么要这个文件（真事故）
 *
 * | 起法 | 结果 |
 * | --- | --- |
 * | `cmd /c _run-bot.bat <QQ>`（含 WMI） | ❌ **会弹黑窗**（用户：「你不开黑窗会死啊」）|
 * | `wscript //nologo _run-bot-hidden.vbs <QQ>` | ❌ 返回成功但**进程根本不出现**（这台机器上失效）|
 * | **本文件：spawn + detached + windowsHide** | ✅ **零窗口 + 真能起**（2026-11-18 实测）|
 *
 * ## 用法
 *
 * ```powershell
 * node tools/start-bot.mjs 10000002          # 起一个号
 * node tools/start-bot.mjs --all               # 起全部（accounts/*.yml + 主号）
 * ```
 *
 * ⚠️ 为什么要 `detached:true` + `unref()`：**活过我这条命令**（不然 DSH 的 job 一结束它就死）
 * ⚠️ 为什么要 `windowsHide:true`：Windows 上 node 是控制台程序，不加这个会闪一个黑窗 ✗
 * ⚠️ 为什么要手动设 `TEMP`：`_run-bot.bat` 里把它钉到 `C:\Temp` 是为了躲开 Word/agent 的临时目录爆炸，
 *    直接 spawn node 会**绕过那个 bat** ⇒ 得在这里补上 ✓
 * ⚠️ 为什么 `NO_PROXY`：本机服务（协议端/模型接口）不许走代理 ✓
 */
import { spawn } from 'node:child_process';
import { readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function accounts() {
  const list = [];
  const dir = join(ROOT, 'accounts');
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      // ⚠️ 只认纯数字的 .yml（`xxx.yml.bak-*` 那些备份不算账号）
      const m = /^(\d{5,12})\.yml$/.exec(f);
      if (m) list.push(m[1]);
    }
  }
  return list;
}

function start(qq) {
  const env = {
    ...process.env,
    QQBOT_ACCOUNT: qq,
    TEMP: 'C:\\Temp',
    TMP: 'C:\\Temp',
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
  };
  // ⚠️ 直连（和 `_run-bot.bat` 的默认行为一致）：残留的代理变量会让本机请求绕出去 ✗
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  delete env.NODE_USE_ENV_PROXY;
  try {
    mkdirSync('C:\\Temp', { recursive: true });
  } catch {
    /* 建不了就交给系统默认 */
  }
  const p = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  });
  p.unref();
  console.log(`${qq} → pid ${p.pid}（无窗口，已脱离本进程）`);
  return p.pid;
}

const arg = process.argv[2] || '';
if (arg === '--all') {
  const list = [...new Set([...accounts(), '10000002'])];
  for (const qq of list) start(qq);
} else if (/^\d{5,12}$/.test(arg)) {
  start(arg);
} else {
  console.log('用法：node tools/start-bot.mjs <QQ> ｜ node tools/start-bot.mjs --all');
  process.exit(1);
}
