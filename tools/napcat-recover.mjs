/**
 * 给看门狗用的「试一次快速登录」工具。
 *
 * ⚠️ 为什么要单独一个脚本、而不是让看门狗直接调管理接口：
 *    NapCat 管理接口要先 sha256(token+".napcat") 换 Credential，
 *    在 PowerShell 里写这段又长又容易出错。用 node 写一次，
 *    看门狗只负责读一行输出，职责清楚。
 *
 * 输出（**只输出一行**，看门狗按第一个词判断）：
 *   ok <qq>            快速登录成功，QQ 已在线
 *   already            本来就在线（不用恢复）
 *   noqr <原因>        本地没有可快登的号，需要扫码
 *   busy               上次还在登录中（避免并发）
 *   error <原因>       出错
 *
 * ⚠️ 不要连点：NapCat 管理接口有 loginRate 限流，猛调会被拒。
 *    看门狗那边有 45 秒节流，这里不再管。
 */
import { loginStatus, quickLogin, quickLoginList } from '../src/napcat.js';
import { config } from '../src/config.js';

const out = (s) => {
  process.stdout.write(String(s) + '\n');
};

/**
 * 该快登哪个号。
 *
 * ⚠️⚠️ 2026-09-13 修的真 bug：这里原来只看 `process.env.BOT_QQ`，
 *    而**整个项目里从来没有人设置过那个变量**（我 grep 过：ps1/bat/yml/md 全没有）。
 *    于是每次都退到 `uins[0]` —— 而那个列表的第一个是**用户的主号 10000001**。
 *
 *    实际后果（NapCat 日志）：
 *        [10:33:43] 正在快速登录  10000001          ← 登的是主号，不是机器人号
 *        [10:33:43] 当前账号(10000001)已登录,无法重复登录   ← 必然失败
 *    所以**自动恢复从来没成功过**，每次都退化到"要用户扫码"。
 *
 *    现在改成：环境变量 > config.yml 的 botQQ（配置里一直有，只是没人用）。
 */
function targetUin(uins) {
  const fromEnv = process.env.BOT_QQ ? String(process.env.BOT_QQ) : '';
  if (fromEnv && uins.includes(fromEnv)) return { uin: fromEnv, how: 'BOT_QQ 环境变量' };
  const fromCfg = config.botQQ ? String(config.botQQ) : '';
  if (fromCfg && uins.includes(fromCfg)) return { uin: fromCfg, how: 'config.yml 的 botQQ' };
  // 兜底：优先挑看起来像机器人号的（配置里有、但列表里没有时只能取第一个）
  return { uin: uins[0], how: '列表第一个（没能确定机器人号）' };
}

try {
  const st = await loginStatus();
  if (st.isLogin === true && st.isOffline !== true) {
    out(`already ${st.uin ?? ''}`.trim());
    process.exit(0);
  }

  const list = await quickLoginList();
  const uins = (Array.isArray(list) ? list : []).map((x) => String(x));
  if (!uins.length) {
    out('noqr 本地没有可快速登录的号');
    process.exit(0);
  }

  // 优先快登**机器人号**（别登用户的主号 —— 那个已经在登录了，必然失败）
  //
  // ⚠️ 这个脚本的输出格式是**契约**：看门狗只看第一行的第一个词
  //    （ok / already / noqr / busy / error）。所以**不要在这里加调试行** ——
  //    加一行 `# …` 就会让看门狗读到 `#` 而认不出结果（差点踩）。
  //    要调试就写到 stderr（看门狗用 2>$null 丢掉了，不会干扰）。
  const { uin, how } = targetUin(uins);
  process.stderr.write(`[napcat-recover] 选号依据: ${how} → ${uin}\n`);

  if (String(uin) === String(config.ownerQQ ?? '')) {
    // 明确识别出"要登的是主号" → 不登，直接报需要扫码（避免白试一次）
    out(`noqr 只找到主号 ${uin}，机器人号不在可快登列表里，需要扫码`);
    process.exit(0);
  }

  const r = await quickLogin(uin);
  if (r?.ok === false) {
    out(`error ${r.message ?? '快登被拒'}`);
    process.exit(0);
  }

  // 等几秒确认真的上线了
  for (let i = 0; i < 8; i++) {
    await new Promise((res) => setTimeout(res, 1500));
    const s = await loginStatus();
    if (s.isLogin === true && s.isOffline !== true) {
      out(`ok ${uin}`);
      process.exit(0);
    }
  }
  out(`error 快登发出去了但没上线（${uin}）`);
} catch (e) {
  out(`error ${String(e.message ?? e).slice(0, 120)}`);
}
