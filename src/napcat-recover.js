/**
 * 「通道假在线」的自救请求 —— **机器人发现发不出去，就请看门狗重启协议端**。
 *
 * 用户要求（2026-09-15）：「下次回 1200 应该自动重启」。
 *
 * ## 病是什么样
 *
 * NapCat 会**假在线**：`tools/napcat-state.mjs` 报 `online`、WS 也一直连着，
 * 但发消息时 QQ 回 `retcode=1200「网络连接异常!」`，而且**群里谁也看不到**。
 * 2026-09-15 实测的时间线：
 *   03:13 起收不到任何消息 → 11:33 手动重启协议端后恢复 → 12:28 正常聊天
 *   → 14:2x 又坏（发出去报成功但没人看到）→ 14:3x 起一律 1200
 * 也就是**会自己坏、也会自己好**，唯一有效的动作是**重启 NapCat**。
 *
 * ## 为什么"请求"而不是自己动手
 *
 * 重启协议端是个**贵且危险**的操作：它会**作废当前登录会话**（这台机器上的号已经被
 * 标成"风险设备"，短时间反复登录是风控最敏感的特征），而且凭据没了就只能扫码。
 * 那套判断（`hasCred` 检查、10 分钟节流、"在等扫码时绝不重启"、弹窗叫人）
 * **看门狗里全都有了、而且是踩出来的**。
 * 所以机器人只做它擅长的事：**数连续失败次数**，够了就在 `state/napcat-restart.request`
 * 留一张条子；看门狗看到条子，用现成的那套逻辑决定要不要真重启。
 *
 * ⚠️ 看门狗没在跑的时候，条子会一直在那儿（无害）—— 日志里会吼一句，
 *    用户看到就知道该去双击「看门狗.bat」。
 */
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { config, ROOT } from './config.js';
import { log } from './log.js';
import * as provider from './provider.js';

// ⚠️ 2026-09-17：这套「假在线 → 留条子 → 看门狗重启」是 **NapCat 专属**的
//    （别的协议端没有"假在线"这个毛病，看门狗也只认 NapCat 目录）。
//    换了协议端就别再留条子，免得看门狗被误导去重启一个不存在的东西。
const ENABLED_FOR_PROVIDER = provider.isNapcat();

const FILE = process.env.QQBOT_NAPCAT_REQ_FILE
  ? join(ROOT, process.env.QQBOT_NAPCAT_REQ_FILE)
  : join(ROOT, 'state', 'napcat-restart.request');

const cfg = () => config.napcatRecover ?? {};
const nz = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** 连续失败了几次（**只在内存里**：进程重启后重新数，这是对的） */
let streak = 0;
/** 上次留条子的时间（跨进程用条子本身的 `at` 兜住，见下） */
let lastRequestAt = 0;

// 启动时如果条子还在（说明看门狗没处理），把它的时间认成"刚求过"，
// 免得我们一上来又写一张、把看门狗的节流绕过去。
try {
  if (existsSync(FILE)) {
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    lastRequestAt = Number(j?.at) || 0;
    log.warn(
      `[协议端] 上次留的重启请求还没被处理（${lastRequestAt ? new Date(lastRequestAt).toLocaleString('zh-CN', { hour12: false }) : '时间未知'}）` +
        ' —— 看门狗在跑吗？（双击「看门狗.bat」）',
    );
  }
} catch {}

/** 发出去一条了 → 通道是活的，计数归零 */
export function onSendOk() {
  streak = 0;
}

/**
 * 发失败了一次（`retcode 1200`）。
 *
 * @param {number} [now]
 * @returns {{streak:number, requested:boolean, reason:string}}
 */
export function onSendFail(now = Date.now()) {
  if (!ENABLED_FOR_PROVIDER) {
    return { streak, requested: false, reason: `当前协议端不是 NapCat（${provider.name()}），不做这套自愈` };
  }
  if (cfg().enable === false) return { streak, requested: false, reason: '功能关着' };
  streak++;
  const threshold = Math.max(1, nz(cfg().failThreshold, 3));
  const throttle = Math.max(60000, nz(cfg().throttleMs, 30 * 60 * 1000));
  if (streak < threshold) return { streak, requested: false, reason: `还没到 ${threshold} 次` };
  if (now - lastRequestAt < throttle) {
    return { streak, requested: false, reason: `刚求过（${Math.round((now - lastRequestAt) / 60000)} 分钟前）` };
  }

  lastRequestAt = now;
  const body = {
    at: now,
    streak,
    pid: process.pid,
    reason: `连续 ${streak} 次发送都回 retcode 1200（网络连接异常）—— 通道假在线，请重启协议端`,
  };
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(body, null, 2), 'utf8');
    log.warn(
      `[协议端] ⚠️ 连续 ${streak} 次发送失败（1200）→ 已留下重启请求：${FILE}\n` +
        '        看门狗会接手（它会检查快登凭据、节流、必要时叫你扫码）。' +
        '看门狗没在跑的话请双击「看门狗.bat」。',
    );
  } catch (e) {
    log.warn(`[协议端] 重启请求写不进去：${e.message}`);
  }
  return { streak, requested: true, reason: body.reason };
}

export function status() {
  let req = null;
  try {
    if (existsSync(FILE)) req = JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {}
  return {
    enable: cfg().enable !== false,
    streak,
    lastRequestAt,
    file: FILE,
    pending: !!req,
    request: req,
  };
}

/** 测试用 */
export function __clear() {
  streak = 0;
  lastRequestAt = 0;
  try {
    rmSync(FILE, { force: true });
  } catch {}
}
export function __set(patch = {}) {
  if ('streak' in patch) streak = patch.streak;
  if ('lastRequestAt' in patch) lastRequestAt = patch.lastRequestAt;
}
