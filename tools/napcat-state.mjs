/**
 * 给看门狗用的「QQ 到底在不在线」探针。
 *
 * ⚠️ 为什么要单独一个脚本、而不是让看门狗内嵌一段 JS：
 *    内嵌那段是**用 here-string 拼出来的**，改一行就要整段重写，
 *    而且**没法写测试**（这个文件里就是一个字符串）。
 *    2026-09-15 那个"卡死 45 分钟"的 bug 恰恰就出在这段判据上，
 *    所以把它挪出来，让 `test/watchdog-state.js` 能真的喂假 NapCat 去验。
 *
 * ## 输出格式是**契约**：只有一行，`<state>:<cred|nocred>`
 *
 *   state = online    QQ 在线（可以发消息）
 *   state = offline   QQ 离线，NapCat 在等扫码
 *   state = stale     ⚠️ **卡死态**：登录态已被作废，但 NapCat（和 QQ 核心）
 *                     还在说「当前账号已登录,无法重复登录」。
 *                     它自己**永远出不来**，只有重启 NapCat 能清掉坏会话。
 *   state = unknown   查不到（**绝不当作离线**，避免误动作）
 *
 *   cred  = 机器人号还在不在 NapCat 的「快速登录名单」里。
 *           `nocred` = 本地登录凭据已被腾讯清掉 →
 *           **快登和重启都不可能成功，只能扫码**（别再白烧风控信号）。
 *
 * 判定依据与来龙去脉见下面 `classify()` 上面的长注释。
 * ⚠️ 不要在这里加调试行 —— 看门狗按第一行的词判断。要调试写 stderr。
 */
import { loginStatus, quickLoginList } from '../src/napcat.js';
import { config } from '../src/config.js';

const out = (s) => process.stdout.write(String(s) + '\n');

/**
 * 把 NapCat 的登录状态归成上面四个词之一。
 *
 * ⚠️⚠️⚠️ 这里就是 2026-09-15 修的那个 bug 的正中央。
 *
 *   用户看到的（NapCat 控制台）：
 *     23:34:14 [error] [KickedOffLine] 你的账号当前登录已失效，请重新登录。
 *     23:34:15 [info]  账号状态变更为离线
 *     23:34:52 [info]  正在快速登录 10000002
 *     23:34:52 [error] 当前账号(10000002)已登录,无法重复登录
 *
 *   他问：为什么说「已登录」，可**实际没登录**？
 *
 *   翻 napcat.mjs 得到的真相：
 *     ```js
 *     c.onUserLoggedIn = (u) => {
 *       const l = `当前账号(${u})已登录,无法重复登录`;
 *       e.logError(l), ve.setQQLoginError(l);   // ← 只记错误，**不动登录状态**
 *     }
 *     c.onQRCodeLoginSucceed = async (u) => {
 *       o.isLogined = !0, ve.setQQLoginStatus(!0)  // ← 只有"扫码成功"才置为已登录
 *     }
 *     ```
 *   · 那句话**是 QQ 核心说的**（它本地还攥着那个已经被服务器作废的会话）；
 *   · NapCat 把它当**错误**记下来，**根本没有**把状态置成已登录；
 *   · `quickLoginWithUin()` 的 promise **只在扫码成功时才 resolve** ——
 *     所以这次快登**永远不返回**，15 秒后 HTTP 超时；
 *   · 最终 NapCat 停在 `QQLoginStatus = false`，也就是**真的没登录**。
 *
 *   ⚠️ 而老代码把 loginError 里的「已登录」当成**在线** →
 *      离线计数被清零 → 看门狗**再也没动过**，静默了 45 分钟。**那才是真 bug。**
 *
 *   四个判据（`isLogin = QQLoginStatus && selfInfo.online`）：
 *     · isLogin true                      → online
 *     · loginError 含「已登录」但 isLogin false → **stale**（卡死，要重启）
 *     · loginError 含「失效/重新登录/未登录/请扫码/过期/刷新」 → offline（在等扫码）
 *     · 其他 / 查不到                      → unknown
 *
 *   ⚠️ 「过期/刷新」是 2026-09-15 实测补上的：刚重启完 NapCat、还没人扫的时候，
 *      loginError 是 **「二维码已过期，请刷新」** —— 那是**在等扫码**，
 *      不是"查不到"。原来没这两个词就会掉进 unknown，看门狗于是什么都不做。
 */
export function classify(st) {
  if (st?.ok && st.isLogin === true) return 'online';
  const err = String(st?.loginError ?? '');
  if (/已登录/.test(err)) return 'stale';
  if (/失效|重新登录|未登录|请扫码|过期|刷新/.test(err)) return 'offline';
  return 'unknown';
}

/** 机器人号还在不在快登名单里 */
export async function hasQuickLoginCred() {
  const botQQ = String(config.botQQ ?? '').trim();
  if (!botQQ) return false;
  try {
    const list = await quickLoginList();
    return Array.isArray(list) && list.map(String).includes(botQQ);
  } catch {
    return false;
  }
}

try {
  const st = await loginStatus();
  const state = classify(st);
  const hasCred = await hasQuickLoginCred();
  // ⚠️ 调试走 stderr（看门狗用 2>nul 丢掉，不会污染那一行输出）
  if (process.env.WD_DEBUG) {
    process.stderr.write(`[napcat-state] status=${JSON.stringify(st)} → ${state} hasCred=${hasCred}\n`);
  }
  out(`${state}:${hasCred ? 'cred' : 'nocred'}`);
} catch (e) {
  process.stderr.write(`[napcat-state] ${String(e?.message ?? e)}\n`);
  out('unknown:nocred');
}
