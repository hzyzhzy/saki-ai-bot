/**
 * 取 NapCat 的 QQ 登录二维码链接 —— 给看门狗用。
 *
 * ⚠️ 为什么需要（2026-09-13）：
 *   机器人号被风控强制下线后，**本地的"快速登录"凭据会被清掉**，
 *   所以自动恢复**永远不可能成功**，只能人工扫码。
 *   而看门狗原来的提醒指向 `http://127.0.0.1:3099`（那是**机器人自己的**管理界面，
 *   不是 NapCat 的 WebUI），用户按提示点进去根本找不到二维码。
 *
 *   所以这里直接把**登录链接**取出来，看门狗把它贴到提醒里，
 *   用户点一下就能扫 —— 不用自己找。
 *
 * NapCat WebUI 的登录方式（从它的 bundle 里逆出来的）：
 *   POST /api/auth/login  { hash: sha256(token + ".napcat") }  → 拿 Credential
 *   POST /api/QQLogin/GetQQLoginQrcode  (Bearer Credential)    → 拿 qrcode 链接
 *
 * 输出（**只输出一行**，看门狗按第一个词判断）：
 *   url <登录链接>      取到了
 *   error <原因>        没取到（那看门狗就只说去 6099 看）
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ROOT } from '../src/config.js';

const out = (s) => process.stdout.write(String(s) + '\n');

const WEBUI = join(ROOT, '..', 'napcat', 'NapCat.Shell', 'config', 'webui.json');
const BASE = 'http://127.0.0.1:6099';

try {
  if (!existsSync(WEBUI)) {
    out('error 找不到 napcat 的 webui.json');
    process.exit(0);
  }
  const cfg = JSON.parse(readFileSync(WEBUI, 'utf8'));
  const token = String(cfg.token ?? '');
  if (!token) {
    out('error webui.json 里没有 token');
    process.exit(0);
  }
  const hash = createHash('sha256').update(token + '.napcat').digest('hex');

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash }),
    signal: AbortSignal.timeout(10000),
  }).then((r) => r.json());
  const cred = login?.data?.Credential;
  if (!cred) {
    out(`error WebUI 登录失败（${login?.message ?? '未知'}）`);
    process.exit(0);
  }

  const qr = await fetch(`${BASE}/api/QQLogin/GetQQLoginQrcode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cred}` },
    body: '{}',
    signal: AbortSignal.timeout(15000),
  }).then((r) => r.json());

  const url = qr?.data?.qrcode;
  if (!url) {
    out(`error 没拿到二维码（${qr?.message ?? '未知'}）`);
    process.exit(0);
  }
  out(`url ${url}`);
} catch (e) {
  out(`error ${String(e.message ?? e).slice(0, 100)}`);
}
