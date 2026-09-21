/**
 * 凭据备份的**命令行入口**（给看门狗用）。
 *
 * 用法：
 * ```
 * node tools/napcat-cred.mjs status     # 只看状态
 * node tools/napcat-cred.mjs backup     # 存一份（登录成功后）
 * node tools/napcat-cred.mjs restore    # 把最新那份放回去（被踢后试一次）
 * node tools/napcat-cred.mjs clear      # 备份已废 → 全删（之后只能扫码）
 * ```
 *
 * ⚠️ 输出格式是**契约**（跟 `tools/napcat-state.mjs` 一个规矩）：
 *    **stdout 第一行**是 `ok` 或 `fail:<原因>`。
 *    ⚠️ 不要在这里加调试行 —— 看门狗按第一行判断。要调试写 stderr（`WD_DEBUG=1`）。
 *    （`src/config.js` / `log.js` 的日志走 stderr 和文件，不会污染这一行。）
 *
 * ⚠️ 这个脚本**不打印凭据内容**，只说"几个文件、成没成" —— 那是登录凭据。
 */
import * as cred from '../src/cred-backup.js';

const cmd = String(process.argv[2] ?? 'status').trim().toLowerCase();
const out = (s) => process.stdout.write(String(s) + '\n');

let r;
if (cmd === 'backup') r = cred.backup();
else if (cmd === 'restore') r = cred.restore();
else if (cmd === 'clear') r = cred.clear();
else if (cmd === 'status') r = { ok: true, ...cred.status() };
else {
  out(`fail:未知命令 ${cmd}`);
  process.exit(2);
}

// ⚠️ 只有 `status` 会把明细放 stderr（给人看/排查），其余一律闭嘴
if (process.env.WD_DEBUG) process.stderr.write(`[napcat-cred] ${cmd} ${JSON.stringify(r)}\n`);
out(r.ok ? 'ok' : `fail:${r.error ?? '未知'}`);
process.exit(r.ok ? 0 : 1);
