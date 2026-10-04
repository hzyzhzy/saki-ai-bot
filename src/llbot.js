/**
 * LLBot 的「登录状态 / 二维码」适配（2026-09-20 加，用户要求）。
 *
 * ## 为什么需要
 *
 * 用户原话：「**二维码要和之前一样能在 webui 自动刷新**」。
 * NapCat 时代管理界面有「显示二维码 / 刷新」，换成 LLBot 之后
 * `provider.js` 里 `status` / `qrcode` / `refreshQr` 三个能力都是 `false`，
 * 界面上就成了"不支持" —— 于是账号掉了**得去 LLBot 自己的窗口才发现**。
 *
 * 2026-09-20 那场事故正说明这个界面能力是必需的：LLBot 的 QQ 会话失效、
 * 它开始反复出二维码，而 **3001 的 OneBot 连接一直没断** →
 * 从机器人角度看"一切正常"，用户 @ 了半天没人应，日志里连"收到"都没有。
 *
 * ## 判据为什么是"看那张图新不新"
 *
 * LLBot **每约 2 分钟重新生成一张登录二维码**写进 `login-qrcode.png`
 * （它日志里就是「二维码已过期, 这张码用了 122s」+「二维码文件已保存」）。
 * 所以：
 *   · 图**很新**（< 3 分钟）→ **它正在等扫码 = 没登录** ✗
 *   · 图**很旧 / 不存在** → 要么早登上了、要么它没在出码
 *
 * 这个判据**不需要认证、不碰它的 API**（它的 WebUI 要 token，而且不同版本不一样），
 * 比去猜它的接口可靠得多。
 *
 * ## ⚠️ 形状必须和 `napcat.js` 那三个函数**完全一致**
 *
 * `webui.js` 的二维码路由是靠 `loginStatus()` / `qrcodeFile()` / `refreshQrcode()`
 * 这三个（返回 `{ok,isLogin,qrcodeUrl,loginError}` / `{path,stale,ageMs}` / `{ok,qrcodeUrl,message}`）
 * 工作的 —— 保持一致，界面那段代码就能两边通用，不用写两份。
 *
 * ⚠️ 和 NapCat 那套一样：**只读文件，绝不去动 LLBot**。
 */
import { existsSync, statSync, openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

/** 多久没更新就不再算"正在出的码"（它约 2 分钟换一张，留点余量） */
const FRESH_MS = 3 * 60 * 1000;

/**
 * 「LLBot 已经停止出码了」的统一话术（后端 409 和界面提示共用一份，免得两边说法不一致）。
 */
export const STOPPED_HINT =
  'LLBot 已经停止自动出码了（它连出 10 张没人扫就会停）—— 打开 LLBot 自己的界面 http://127.0.0.1:3081，在登录页点「刷新」；或者重启 LLBot';

/** LLBot 的安装目录：优先 `provider.dir`，否则用这台机器上的实际位置 */
function llbotDir() {
  const d = String(config.provider?.dir ?? '').trim();
  return d || 'C:\\LLBot';
}

/** 二维码文件路径。可用 `provider.qrcodeFile` 覆盖（LLBot 换版本可能挪位置）。 */
export function qrcodePath() {
  const p = String(config.provider?.qrcodeFile ?? '').trim();
  if (p) return p;
  return join(llbotDir(), 'bin', 'llbot', 'data', 'temp', 'login-qrcode.png');
}

/**
 * 二维码文件 + 它够不够新。
 * ⚠️ 形状对齐 `napcat.qrcodeFile()`：`{ path, stale, ageMs }`（多给的字段无害）。
 */
export function qrcodeFile() {
  const path = qrcodePath();
  try {
    if (!existsSync(path)) return null;
    const st = statSync(path);
    if (!st.size) return null;
    const ageMs = Date.now() - st.mtimeMs;
    return { path, ageMs, stale: ageMs > FRESH_MS, mtime: st.mtimeMs };
  } catch {
    return null;
  }
}

/** LLBot 的日志目录 / 最新那个日志文件（它每次启动会新建一个 `llbot-<日期 时间>.log`） */
function logDir() {
  return join(llbotDir(), 'bin', 'llbot', 'data', 'logs');
}

function latestLogFile() {
  try {
    const d = logDir();
    if (!existsSync(d)) return '';
    return (
      readdirSync(d)
        .map((n) => join(d, n))
        .map((p) => ({ p, t: statSync(p).mtimeMs }))
        .sort((a, b) => b.t - a.t)[0]?.p ?? ''
    );
  } catch {
    return '';
  }
}

/**
 * LLBot 是不是**已经停止自动出码**了。
 *
 * ⚠️⚠️ 为什么需要（2026-09-20 用户截图报的：界面说"已经登录了"、下面一张破图）：
 *    LLBot 连着出 **10 张**码没人扫，就**自己停了** —— 它日志的原话是：
 *      `[W] qq-protocol 已自动刷新 10 张二维码仍未登录, 停止自动刷新;
 *           到 WebUI 登录页点击刷新可继续, 或重启`
 *    停了之后 `login-qrcode.png` **不再更新**，永远是旧的。
 *    而"码旧"在原来那套判据里被当成"**已经登录了**" → 界面就撒谎说
 *    「QQ 已经登录了，不需要扫码」，而它其实**离线、且没有码可扫** ✗
 *
 * 判据：读它日志的**尾部 32KB** 找那句话（不整文件读；日志可能几十 MB）。
 *   ⚠️ 只在"码已经旧了"的时候才会被调用 —— 正常情况下每约 2 分钟一张新码，用不着读日志。
 *   ⚠️ 读的是**最新那个日志**（= 当前这次会话），所以"上次会话里说过这句话"不会误判。
 */
export function stoppedGenerating() {
  try {
    const f = latestLogFile();
    if (!f) return false;
    const { size } = statSync(f);
    const len = Math.min(size, 32 * 1024);
    if (!len) return false;
    const fd = openSync(f, 'r');
    const buf = Buffer.alloc(len);
    try {
      readSync(fd, buf, 0, len, size - len);
    } finally {
      closeSync(fd);
    }
    return /停止自动刷新/.test(buf.toString('utf8'));
  } catch {
    return false;
  }
}

/**
 * 登录状态 —— 形状对齐 `napcat.loginStatus()`。
 * ⚠️ 只看本地那张图和它的日志，**不调 LLBot 的接口**（要认证，而且版本间不一致）。
 *   ⚠️ 想知道"能不能收消息"的真话，去问 OneBot 的 `get_status().online`
 *      （`webui.js` 的二维码路由就是这么做的，这里只作兜底）。
 */
export async function loginStatus() {
  const f = qrcodeFile();
  // ① 码很新 → 它正在等人扫，这个判断是可靠的
  if (f && !f.stale) {
    return {
      ok: true,
      isLogin: false,
      isOffline: true,
      qrcodeUrl: '',
      loginError: `正在等扫码（这张码是 ${Math.round(f.ageMs / 1000)} 秒前生成的）`,
    };
  }
  // ② ⚠️ 码旧/没有 —— **不能再默认"已经登录了"**（2026-09-20 修）：
  //    也可能是"连出 10 张没人扫，它自己停止出码了"，那时它根本没登录。
  if (stoppedGenerating()) {
    return {
      ok: true,
      isLogin: false,
      isOffline: true,
      qrcodeUrl: '',
      loginError: STOPPED_HINT,
    };
  }
  // ③ 没在出码、也没有"已停止"的记录 → 多半是登录着（真掉线时它会持续刷新那张图）
  return { ok: true, isLogin: true, isOffline: false, qrcodeUrl: '', loginError: '' };
}

/**
 * "重新出码" —— ⚠️ LLBot **自己每约 2 分钟换一张**，我们催不动它（也不该去催）。
 * 所以这里只**如实报告**；界面上点"刷新"时，重新拉一次图（带 `fresh=1` 防缓存）就能拿到最新那张。
 * ⚠️ 但它**停止出码之后**，点刷新也拿不到 —— 那种情况必须如实说，并告诉用户去哪儿点。
 */
export async function refreshQrcode() {
  if (stoppedGenerating()) return { ok: false, qrcodeUrl: '', message: STOPPED_HINT };
  const f = qrcodeFile();
  return {
    ok: true,
    qrcodeUrl: '',
    message: f
      ? `LLBot 每约 2 分钟自动换一张码（当前这张是 ${Math.round(f.ageMs / 1000)} 秒前生成的）—— 刷新页面即可拿到最新`
      : 'LLBot 现在没有在出码（多半已经登录了）',
  };
}
