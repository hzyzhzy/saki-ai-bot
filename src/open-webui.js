/**
 * 「启动机器人就自动打开管理界面」（2026-09-17 用户要求）。
 *
 * 用户原话：「现在启动机器人不会自动打开 webui，我建议打开，然后现在先帮我打开」。
 *
 * ⚠️ 但**不能无脑开** —— 这个机器人重启很频繁（看门狗补起、我改代码重启…），
 *    无脑开会在屏幕上弹一堆标签页。所以三道闸：
 *
 * | 闸 | 作用 |
 * | --- | --- |
 * | ① 测试配置（`QQBOT_CONFIG` 指向 `*-test.yml`）→ 不开 | 跑回归会 spawn 十几个真机器人进程，否则会弹满屏浏览器 |
 * | ② `QQBOT_NO_OPEN_WEBUI=1` → 不开 | 手动的紧急开关 |
 * | ③ 10 分钟内已经自动开过 → 不开 | 看门狗 5~20 秒内补起的进程不会再弹一次 |
 *
 * 也可以把 `webui.autoOpen` 设成 false 彻底关掉这个行为。
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config, ROOT } from './config.js';
import { log } from './log.js';

const STATE = join(ROOT, 'state', 'webui-autoopen.json');
const GAP_MS = 10 * 60 * 1000;

export function maybeOpenWebUI() {
  try {
    if (config.webui?.autoOpen === false) return false;
    if (process.env.QQBOT_NO_OPEN_WEBUI === '1') return false;
    // ⚠️ 测试套件都会把 `QQBOT_CONFIG` 指到 `config.*-test.yml`（见 AGENTS 的隔离约定）
    const cfgName = String(process.env.QQBOT_CONFIG ?? '').trim();
    if (cfgName && !/config\.ya?ml$/i.test(cfgName)) {
      log.debug(`[界面] 测试配置（${cfgName}）→ 不自动打开浏览器`);
      return false;
    }
    // ⚠️⚠️ 再补一道更狠的闸：`run-all.js` 会给**每个**套件发一份隔离的 state 路径
    //    （`isolatedStateEnv`），而**有些套件自己不设 `QQBOT_CONFIG`** ——
    //    光看配置名挡不住它们，回归一跑就会弹满屏浏览器。
    //    看到这些隔离变量 = 一定是在跑测试 → 不开。
    if (
      process.env.QQBOT_AFFINITY_FILE ||
      process.env.QQBOT_LIFE_FILE ||
      process.env.QQBOT_TIC_FILE ||
      process.env.QQBOT_QUEST_FILE ||
      process.env.QQBOT_STORYLINE_FILE
    ) {
      log.debug('[界面] 隔离 state 变量在（跑测试）→ 不自动打开浏览器');
      return false;
    }
    let last = 0;
    try {
      last = Number(JSON.parse(readFileSync(STATE, 'utf8'))?.at) || 0;
    } catch {}
    if (Date.now() - last < GAP_MS) {
      log.debug('[界面] 10 分钟内已经自动打开过 → 这次不弹');
      return false;
    }
    const url = `http://127.0.0.1:${Number(config.webui?.port) || 3099}`;
    mkdirSync(join(ROOT, 'state'), { recursive: true });
    writeFileSync(STATE, JSON.stringify({ at: Date.now(), url }), 'utf8');
    // ⚠️ 用 `cmd /c start`（Windows 打开默认浏览器的标准做法）+ `stdio: 'ignore'`
    //    （受限环境下管道会 EPERM；而且这里也不需要它的输出）
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    log.info(`管理界面已自动打开：${url}`);
    return true;
  } catch (e) {
    log.debug(`自动打开管理界面失败：${e.message}`);
    return false;
  }
}
