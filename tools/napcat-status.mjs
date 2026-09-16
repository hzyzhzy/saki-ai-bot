/**
 * 给看门狗用的小工具：查 NapCat 的登录状态，输出**一行**结果。
 *
 * 为什么单独做成脚本：
 *   看门狗是 PowerShell 5.1，要调 NapCat 的 WebUI 得先算 sha256、
 *   再发两个 HTTP 请求，在 PS 里写这一堆又长又容易错。
 *   丢给 node 一条命令搞定，输出一行让 PS 读。
 *
 * 输出格式（一行，空格分隔）：
 *   online  <qq>              已登录且在线
 *   offline qr|noqr  <原因>    未登录；qr=现在就能扫码，noqr=拿不到码
 *   unknown <原因>             问不到
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ⚠️ 别用 process.cwd() —— 看门狗可能在别的目录下调这个脚本，
//    那样会算错路径、读不到 token（踩过）。用脚本自己的位置推。
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

function token() {
  try {
    const p = join(ROOT, '..', 'napcat', 'NapCat.Shell', 'config', 'webui.json');
    return String(JSON.parse(readFileSync(p, 'utf8')).token ?? '');
  } catch {
    return '';
  }
}

const TOK = token();
if (!TOK) {
  console.log('unknown 读不到 napcat webui token');
  process.exit(0);
}

const BASE = process.env.NAPCAT_WEBUI ?? 'http://127.0.0.1:6099';

try {
  const hash = createHash('sha256').update(TOK + '.napcat').digest('hex');
  const r0 = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash }),
    signal: AbortSignal.timeout(8000),
  });
  const cred = JSON.parse(await r0.text())?.data?.Credential;
  if (!cred) {
    console.log('unknown NapCat 管理接口登录失败');
    process.exit(0);
  }

  const r1 = await fetch(`${BASE}/api/QQLogin/CheckLoginStatus`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cred}`, 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(8000),
  });
  const j = JSON.parse(await r1.text());
  if (j?.code !== 0) {
    console.log(`unknown ${String(j?.message ?? '查询失败').replace(/\s+/g, '_')}`);
    process.exit(0);
  }

  const d = j.data ?? {};
  const info = await fetch(`${BASE}/api/QQLogin/GetQuickLoginList`, {
    headers: { Authorization: `Bearer ${cred}` },
    signal: AbortSignal.timeout(8000),
  })
    .then((r) => r.json())
    .catch(() => null);
  const qq = Array.isArray(info?.data) ? info.data[0] ?? '' : '';

  if (d.isLogin === true && d.isOffline !== true) {
    console.log(`online ${qq}`);
  } else {
    const hasQr = !!String(d.qrcodeurl ?? '');
    const why = String(d.loginError ?? '').replace(/\s+/g, '_') || (hasQr ? '等扫码' : '无二维码');
    console.log(`offline ${hasQr ? 'qr' : 'noqr'} ${why}`);
  }
} catch (e) {
  console.log(`unknown ${String(e.message).replace(/\s+/g, '_')}`);
}
