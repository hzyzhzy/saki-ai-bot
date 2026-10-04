/**
 * 跟 NapCat 自己的管理接口（WebUI，默认 6099）打交道。
 *
 * 为什么需要：机器人只能通过 OneBot（3001）收发消息，**管不了登录状态**。
 * 想「在网页上看 QQ 在不在线」「点一下出二维码」，得走 NapCat 的 WebUI 接口。
 *
 * ⚠️ 鉴权流程（逆出来的，别再踩）：
 *   ① POST /api/auth/login   body: { hash: sha256(token + ".napcat") }
 *      → { code:0, data:{ Credential: "<JWT>" } }
 *   ② 之后的请求带 `Authorization: Bearer <Credential>`
 *      （也可以用 `?webui_token=<原始token>`，但登录那条必须用 hash）
 *   ③ 凭证会过期，所以这里**每次请求前都重新登录一次**（很快，本地回环）。
 *
 * 实测可用的接口：
 *   POST /api/QQLogin/CheckLoginStatus
 *        → { isLogin, isOffline, qrcodeurl, loginError }
 *          ⚠️ **未登录时 qrcodeurl 就是二维码的链接** —— 可以直接转成二维码图片，
 *             不用去翻 NapCat 目录下的 qrcode.png（那个还会被覆盖）。
 *   GET  /api/QQLogin/GetQuickLoginList → ["10000002", ...]（可快速登录的号）
 *   POST /api/QQLogin/GetQQLoginQrcode  → 已登录时返回 "QQ Is Logined"
 *   POST /api/QQLogin/RestartNapCat     → 让 NapCat 重启（会重新出码）
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { join } from 'node:path';
import { config, ROOT } from './config.js';
import { log } from './log.js';

const pExecFile = promisify(execFile);
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

/** NapCat.Shell 目录（launcher 就在里面，用 %cd% 定位自己，所以必须在它里面启动） */
function shellDir() {
  return join(ROOT, '..', 'napcat', 'NapCat.Shell');
}

/** 机器人连的那个 OneBot 端口（默认 3001，从 config 里读） */
function onebotPort() {
  try {
    return Number(new URL(config.onebot?.url ?? '').port) || 3001;
  } catch {
    return 3001;
  }
}

/** 本机某个端口在不在监听（1.5 秒超时） */
function portOpen(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => {
      try {
        s.destroy();
      } catch {}
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/**
 * NapCat 到底在不在跑。
 *
 * ⚠️ 为什么要单独有个函数（2026-09-17 用户报「重启 NapCat 按钮还是没用，那两个窗口没动静」）：
 *    界面上那个「重启 NapCat」原来只有一条路 —— `POST /api/QQLogin/RestartNapCat`，
 *    而那是**发给 NapCat 管理接口**（6099）的请求。**NapCat 压根没跑的时候，
 *    那个请求只会 ECONNREFUSED**（界面弹「重启失败：fetch failed（NapCat 似乎没在运行）」），
 *    它**没有任何"把 NapCat 启动起来"的能力** —— 所以点多少遍都不会有窗口出来。
 *
 * @returns {Promise<{onebot:boolean, webui:boolean}>}
 */
export async function running(opts = {}) {
  const [onebot, webui] = await Promise.all([
    portOpen(opts.onebotPort ?? onebotPort()),
    portOpen(opts.webuiPort ?? (config.napcat?.webuiPort ?? 6099)),
  ]);
  return { onebot, webui };
}

/** 关掉残留的 QQ / NapCat 宿主进程（它们没被注入 NapCat 时，会挡着新的注入） */
async function killResidual() {
  let n = 0;
  for (const img of ['QQ.exe', 'NapCatWinBootMain.exe']) {
    try {
      await pExecFile('taskkill', ['/F', '/IM', img]);
      n += 1; // taskkill 只要成功退出，就说明确实杀到了进程
      log.info(`启动 NapCat 前先关掉残留的 ${img}`);
    } catch {
      /* 没这个进程，taskkill 会非零退出 —— 正常 */
    }
  }
  if (n) await sleep(3000);
  return n;
}

/**
 * **把 NapCat 启动起来**（不只是"重启"）。
 *
 * ⚠️⚠️ 2026-09-17 新加。原因见 `running()` 的注释：原来的「重启 NapCat」按钮
 *    在 NapCat 没跑的时候是**死按钮**，用户点了两个窗口都不动。
 *
 * 必须走 `launcher-win10-user.bat` —— 它会给 `NapCatWinBootMain.exe` 设五个环境变量
 * （`NAPCAT_LOAD_PATH` 等），缺一个就是"QQ 起来了但 NapCat 完全没跑"（见 AGENTS.md）。
 *
 * 窗口**不能隐藏**：登录态失效时 NapCat 会停在二维码等人扫，
 * 隐藏窗口 = 界面卡死在"起不来"而没人看得见码。
 *
 * @param {{waitMs?:number, quickQQ?:string}} [opts]
 */
export async function launch({ waitMs = 60000, quickQQ } = {}) {
  const before = await running();
  if (before.onebot || before.webui) {
    return { ok: true, already: true, message: 'NapCat 已经在运行了' };
  }

  const dir = shellDir();
  const launcher = join(dir, 'launcher-win10-user.bat');
  if (!existsSync(launcher)) {
    return { ok: false, message: `找不到 ${launcher}` };
  }

  const killed = await killResidual();

  // 快速登录（`-q <QQ号>`，launcher 自己的注释里写的那个形式）：
  // 缓存凭据还在就不用扫码。⚠️ 别写成裸号码，那个不是它认的参数形式。
  const qq = String(quickQQ ?? config.botQQ ?? '').trim();
  const args = ['/c', 'start', '', '/min', 'launcher-win10-user.bat'];
  if (qq) args.push('-q', qq);

  try {
    // ⚠️ 用 `cmd /c start` 起一个**独立的新控制台**：
    //    直接 spawn 那个 bat 的话，它继承的是机器人自己被重定向/隐藏的控制台，
    //    二维码窗口就等于没有（用户扫不了）。cwd 设在 NapCat.Shell，
    //    所以这里只传文件名 —— 路径里那个空格（`OneDrive - yijia`）就不会捣乱。
    const child = spawn('cmd.exe', args, { cwd: dir, detached: true, stdio: 'ignore' });
    child.unref();
  } catch (e) {
    return { ok: false, message: `启动 NapCat 失败：${e.message}` };
  }
  log.info(`已启动 NapCat（launcher-win10-user.bat${qq ? ` -q ${qq}` : ''}${
    killed ? `，先关掉了 ${killed} 类残留进程` : ''
  }），等端口…`);

  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    await sleep(1500);
    const s = await running();
    if (s.webui || s.onebot) {
      const sec = Math.round((Date.now() - t0) / 1000);
      return {
        ok: true,
        launched: true,
        killedQQ: !!killed,
        message: `NapCat 已启动（等了 ${sec} 秒）${
          s.onebot ? '' : '，正在等它登录 QQ'
        }`,
      };
    }
  }
  return {
    ok: false,
    launched: true,
    killedQQ: !!killed,
    message: `NapCat 的窗口已经开了，但 ${Math.round(waitMs / 1000)} 秒内还没监听端口 —— 去看那个 NapCat 窗口（可能停在扫码登录）`,
  };
}

/** NapCat 的 WebUI 地址从配置读，默认本机 6099 */
function base() {
  const host = config.napcat?.webuiHost ?? '127.0.0.1';
  const port = config.napcat?.webuiPort ?? 6099;
  return `http://${host}:${port}`;
}

/** 从 NapCat 的 webui.json 里读 token（用户没在 config.yml 填的话） */
function token() {
  if (config.napcat?.webuiToken) return String(config.napcat.webuiToken);
  try {
    const p = join(ROOT, '..', 'napcat', 'NapCat.Shell', 'config', 'webui.json');
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return String(j.token ?? '');
  } catch (e) {
    log.debug(`读 NapCat webui.json 失败：${e.message}`);
    return '';
  }
}

export function enabled() {
  return config.napcat?.enable !== false && !!token();
}

async function login() {
  const t = token();
  if (!t) throw new Error('拿不到 NapCat 的 webui token');
  const hash = createHash('sha256').update(t + '.napcat').digest('hex');
  const r = await fetch(`${base()}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash }),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json().catch(() => ({}));
  const cred = j?.data?.Credential;
  if (!cred) throw new Error(j?.message || 'NapCat 登录失败');
  return cred;
}

async function call(method, path, body = null) {
  const cred = await login();
  const r = await fetch(`${base()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${cred}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(config.napcat?.timeoutMs ?? 15000),
  });
  const txt = await r.text();
  let j = null;
  try {
    j = JSON.parse(txt);
  } catch {}
  return { status: r.status, json: j, text: txt };
}

/**
 * 登录状态。
 * @returns {Promise<{ok:boolean, isLogin?:boolean, isOffline?:boolean,
 *                    qrcodeUrl?:string, loginError?:string, error?:string}>}
 */
export async function loginStatus() {
  if (!enabled()) return { ok: false, error: 'NapCat 管理接口未配置（缺 token）' };
  try {
    const { json } = await call('POST', '/api/QQLogin/CheckLoginStatus', {});
    if (!json || json.code !== 0) return { ok: false, error: json?.message ?? '查询失败' };
    const d = json.data ?? {};
    return {
      ok: true,
      isLogin: d.isLogin === true,
      isOffline: d.isOffline === true,
      // ⚠️ 2026-09-13 修：这里原来只读 `qrcodeurl`，但 NapCat 给的是 **`qrcode`**
      //    （跟 getQrcode 里那个字段错误是同一类问题）。
      //    读错的后果：`hasQrcode` 永远是 false、而且会一直挂着
      //    「二维码已过期，请刷新」——**即使二维码其实好好的**，
      //    用户看到这句就以为得重启 NapCat，白折腾。
      qrcodeUrl: String(d.qrcode ?? d.qrcodeurl ?? d.qrcodeUrl ?? ''),
      loginError: String(d.loginError ?? ''),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 能快速登录的 QQ 号（NapCat 存着的） */
export async function quickLoginList() {
  if (!enabled()) return [];
  try {
    const { json } = await call('GET', '/api/QQLogin/GetQuickLoginList');
    return Array.isArray(json?.data) ? json.data.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * 主动取一次二维码。
 *
 * ⚠️ 已登录时 NapCat 会直接回 "QQ Is Logined"（不是错误，是没必要出码）。
 *    真正出码的时机是「未登录/掉线」，那会儿 CheckLoginStatus 的 qrcodeurl 就有值。
 *
 * @returns {Promise<{ok:boolean, qrcodeUrl?:string, message?:string}>}
 */
/**
 * 让 NapCat **重新出一张二维码**（不重启进程）。
 *
 * ⚠️⚠️ 2026-09-15 加：用户反馈「**webui 那个码就没扫成功过，重新出码也一直不出**」。
 *
 *    查 `napcat.mjs` 才明白 —— **`GetQQLoginQrcode` 根本不刷新**：
 *
 *      ```js
 *      tue = async (t, e) => {                 // ← GetQQLoginQrcode 的处理器
 *        if (ve.getQQLoginStatus()) return ne(e, "QQ Is Logined");
 *        const n = ve.getQQLoginQrcodeURL();   // ← 只是**读缓存的那个 URL**
 *        return Hn(n) ? ne(e, "QRCode Get Error") : me(e, { qrcode: n });
 *      }
 *      ```
 *
 *    那个缓存的 URL 是**上一次 `onQRCodeGetPicture` 时存下来的快照**
 *    （`setQQLoginQrcodeURL(l)`，同时写 `cache/qrcode.png`）。
 *    **二维码几分钟就过期** —— 所以界面上画出来的那张，
 *    十有八九是**一张早就死了的码**。这就是"从来没扫成功过"。
 *
 *    真正会重出的只有这条：`POST /api/QQLogin/RefreshQRcode` → `ve.refreshQRCode()`
 *    → 触发 `onQRCodeGetPicture` → 更新缓存 URL + 重写 `cache/qrcode.png`。
 *
 *    ⚠️ 别用 `restart()`（`RestartNapCat`）来"重新出码"：那是**重启整个进程**，
 *       等于一次 QQ 登录（风控信号），还得等 20 秒。轻活要用轻接口。
 */
export async function refreshQrcode() {
  if (!enabled()) return { ok: false, message: 'NapCat 管理接口未配置' };
  try {
    const { json, status } = await call('POST', '/api/QQLogin/RefreshQRcode');
    // 已登录时 NapCat 回的是 "QQ Is Logined"（不是错误，只是没码可出）。
    // ⚠️ 先看 message 再看 code —— NapCat 那里两种情况都出现过
    //    （`me(e,null)` 给 code 0，`ne(e,msg)` 给非 0），按 message 判最稳。
    const msg = String(json?.message ?? '');
    if (/Is Logined|已登录/i.test(msg)) return { ok: false, message: 'QQ 已经登录了，不需要二维码' };
    if (json?.code === 0) return { ok: true };
    return { ok: false, message: msg || `刷新二维码失败（HTTP ${status}）` };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

/**
 * NapCat 自己写的二维码图片（`cache/qrcode.png`）+ 它的写入时间。
 *
 * ⚠️ 为什么优先用它、而不是我们自己拿 URL 画：这张是 **QQ 给的原图**
 *    （`onQRCodeGetPicture` 里 base64 落盘的那个），跟缓存 URL **必然同一个**。
 *    自己画虽然也行，但多一层"画错/画糊"的可能。
 *    ⚠️ 它的分辨率很低（实测 **147×147**），所以界面上**不能放大 + 最近邻**，
 *    否则模块会被拉得不均匀、扫不出来（见 webui.html 那张图上的注释）。
 */
export function qrcodeFile() {
  try {
    const p = join(ROOT, '..', 'napcat', 'NapCat.Shell', 'cache', 'qrcode.png');
    const st = statSync(p);
    if (!st.isFile() || st.size <= 0) return null;
    const ageMs = Date.now() - st.mtimeMs;
    // ⚠️ 2026-09-17：**加一个"太旧了"的标记**。二维码几分钟就死，
    //    而这张文件会一直躺在 cache 里。NapCat 没在跑的时候把它当"有码"发出去，
    //    用户扫的就是一张几小时前的死码（「从来没扫成功过」的一部分原因）。
    return { path: p, mtimeMs: st.mtimeMs, size: st.size, ageMs, stale: ageMs > 5 * 60 * 1000 };
  } catch {
    return null;
  }
}

export async function getQrcode() {
  if (!enabled()) return { ok: false, message: 'NapCat 管理接口未配置' };
  try {
    const { json } = await call('POST', '/api/QQLogin/GetQQLoginQrcode');
    // ⚠️⚠️ 2026-09-13 修的真 bug：**字段名读错了**。
    //
    //    实测 NapCat 返回的是：
    //      {"code":0,"data":{"qrcode":"https://txz.qq.com/p?k=..."},"message":"success"}
    //                                        ^^^^^^ 就叫 qrcode
    //    而这里原来读的是 `qrcodeurl / qrcodeUrl / data` —— 三个都不对
    //    （`data` 是个对象，String() 出来是 "[object Object]" 或空串）。
    //
    //    后果：`/api/qq/qrcode.png` **永远拿不到新码**，
    //    退回去画 `cache/qrcode.png` —— **那是很久以前缓存的一张过期码**。
    //    所以管理界面点「显示二维码」看到的是过期二维码，扫不了
    //    （接口还报「二维码已过期，请刷新」）。
    //    用户反馈「重新生成应该就放在 webui 里，这里太麻烦了」——
    //    其实界面早就有这个功能，只是**它一直出的是废码**。
    const url = String(
      json?.data?.qrcode ??
        json?.data?.qrcodeUrl ??
        json?.data?.qrcodeurl ??
        '',
    );
    if (json?.code === 0 && /^https?:/.test(url)) return { ok: true, qrcodeUrl: url };
    // 没直接给链接就退回去读状态（未登录时那里也有链接）
    const st = await loginStatus();
    if (st.qrcodeUrl) return { ok: true, qrcodeUrl: st.qrcodeUrl };
    return { ok: false, message: json?.message ?? '没拿到二维码' };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

/**
 * 让 NapCat 重启（掉线后重新出码用）。
 *
 * ⚠️⚠️ 2026-09-13 修：**「连接被断开」其实是成功，不是失败**。
 *
 *    用户截图报的 bug：管理界面点「重新出码」，弹「重启失败: fetch failed」。
 *
 *    实测那个接口本身完全正常：
 *      POST /api/QQLogin/RestartNapCat
 *      → HTTP 200 {"code":0,"data":{"message":"进程重启请求已发送"}}
 *
 *    那 `fetch failed` 是哪来的？—— **这个接口会让 NapCat 重启进程**，
 *    于是它**来不及把响应发完就把自己关了**，我们这边的 fetch 就被掐断。
 *
 *    也就是说：**命令成功送达了，只是回声没听到。**
 *    原来的代码把这个当失败 → 用户看到"重启失败"，以为没生效，
 *    实际上 NapCat 正在重启（等十几秒就好了）。
 *
 *    所以现在：
 *      · 网络层断开类错误（ECONNRESET / socket hang up / fetch failed）
 *        → 判定为**已发送**（这正是重启生效的表现）
 *      · 真连不上（ECONNREFUSED：NapCat 压根没跑）→ 才算失败
 */
export async function restart() {
  if (!enabled()) return { ok: false, message: 'NapCat 管理接口未配置' };
  try {
    const { json } = await call('POST', '/api/QQLogin/RestartNapCat');
    const ok = json?.code === 0;
    return {
      ok,
      // 重启后连接会断，所以这里加一句提示，别让用户以为要用不了
      message: json?.data?.message ?? json?.message ?? (ok ? '重启请求已发送（约 20 秒后恢复）' : '重启失败'),
    };
  } catch (e) {
    // ⚠️ 关键：**断开连接 = 重启已经开始了**，不是失败。
    //    详见函数头的注释。只有"压根连不上"才算真的失败。
    const msg = String(e?.message ?? '');
    const cause = String(e?.cause?.code ?? e?.code ?? '');
    const refused = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(msg + ' ' + cause);
    if (!refused) {
      log.info(`重启 NapCat：连接已被断开（${msg}）—— 这是重启生效的表现，按成功处理`);
      return { ok: true, message: '重启请求已发送（NapCat 正在重启，约 20 秒后恢复）' };
    }
    return { ok: false, message: `${msg}（NapCat 似乎没在运行）` };
  }
}

/**
 * 快速登录（**免扫码**）。
 *
 * ⚠️ 这是最有用的一条：掉线后如果 QQ 本地还留着凭据，走这个就能直接登回去，
 *    不用扫码。实测有效（NapCat 会让 QQ 自己拿缓存凭据换新会话）。
 *    凭据没了才必须扫码 —— 那时候这个会失败，再退回二维码。
 *
 * @param {string} uin QQ 号
 */
export async function quickLogin(uin) {
  if (!enabled()) return { ok: false, message: 'NapCat 管理接口未配置' };
  const n = String(uin ?? '').trim();
  if (!n) return { ok: false, message: '没给 QQ 号' };
  try {
    const { json } = await call('POST', '/api/QQLogin/SetQuickLogin', { uin: n });
    if (json?.code === 0) return { ok: true, message: '快速登录请求已发送，等几秒看状态' };
    return { ok: false, message: json?.message ?? '快速登录失败' };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

/**
 * 自动恢复：先试快速登录（能省一次扫码），不行再出二维码。
 * @returns {Promise<{recovered:boolean, message:string}>}
 */
/**
 * 自动恢复：先试快速登录（能省一次扫码），不行再出二维码。
 *
 * ⚠️⚠️ 2026-09-13 改：**只试机器人自己的号，绝不碰用户主号**。
 *
 *    用户要求（TODO 的 D 条）：「`autoRecover` 会去试用户主号（建议改）」。
 *
 *    原来的代码是**遍历整个快登列表**：
 *      `for (const uin of list) { await quickLogin(uin); ... }`
 *    而列表长这样：`["10000002", "10000001"]`
 *    —— 第二个是**用户自己的主号**。
 *
 *    风险：机器人号试失败后会去登主号。虽然主号不在风险设备上、
 *    理论上登不上，但「让机器人去登用户的私人号」这件事本身就不该发生
 *    （而且真登上了会把用户在用的 QQ 顶下线）。
 *
 *    现在：**只在列表里找 `config.botQQ`**，找不到就直接让人扫码。
 *
 * @returns {Promise<{recovered:boolean, message:string}>}
 */
export async function autoRecover() {
  const st = await loginStatus();
  if (st.ok && st.isLogin && !st.isOffline) return { recovered: true, message: '本来就在线' };

  const list = await quickLoginList();
  if (!list.length) return { recovered: false, message: '没有可快速登录的号，需要扫码' };

  const botQQ = String(config.botQQ ?? '').trim();
  if (!botQQ) {
    // 没配 botQQ 就**不动手** —— 否则只能瞎猜，猜错就登了别人的号
    return {
      recovered: false,
      message: `没配 botQQ，不敢乱登（快登列表里有 ${list.join('、')}），请扫码`,
    };
  }
  if (!list.includes(botQQ)) {
    return {
      recovered: false,
      message: `机器人号 ${botQQ} 不在快登列表里（列表：${list.join('、')}），需要扫码`,
    };
  }

  log.info(`自动恢复：只试机器人号 ${botQQ}（不碰列表里其他号）`);
  const r = await quickLogin(botQQ);
  if (r.ok) {
    // 等它真登上（最多 12 秒）
    for (let i = 0; i < 6; i++) {
      await new Promise((res) => setTimeout(res, 2000));
      const s = await loginStatus();
      if (s.ok && s.isLogin && !s.isOffline) {
        return { recovered: true, message: `用 ${botQQ} 快速登录成功` };
      }
    }
  }
  return { recovered: false, message: `机器人号 ${botQQ} 快速登录没成功，需要扫码` };
}

/** 给管理界面看的一行状态 */
export async function describe() {
  const st = await loginStatus();
  if (!st.ok) {
    return { configured: enabled(), reachable: false, error: st.error };
  }
  return {
    configured: true,
    reachable: true,
    isLogin: st.isLogin,
    isOffline: st.isOffline,
    hasQrcode: !!st.qrcodeUrl,
    loginError: st.loginError,
    quickLogin: await quickLoginList(),
  };
}
