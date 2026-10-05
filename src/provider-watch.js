/**
 * 协议端自愈 —— 3001 连不上了就把协议端重新拉起来（2026-10-06 用户要求）。
 *
 * ## 为什么加
 *
 * 实测（2026-10-06 凌晨）：SnowLuma 跑了约 2 小时后**短暂抖了 1 分钟** ——
 * 那段时间 3001 没人听，机器人只能 `ECONNREFUSED` 反复重连；而协议端**进程还在**
 * （内存 105 MB、日志还在写），只是不再监听端口了。
 * 用户当时正在等回话，「为什么机器人不回」有一半就是它。
 *
 * ## ⚠️⚠️ 三条安全线（都别改）
 *
 * ① **只探端口，绝不杀任何进程。**
 *    要"找出哪个进程是协议端"就得按命令行匹配 —— 而那条路**会打中 DSH 的 runner 自己**
 *    （项目里踩过两次，见 AGENTS 的硬规矩）。所以这里**只启动、不杀**：
 *    万一旧进程其实还活着，新起的会因端口占用自己退出（无害，日志里能看到）。
 * ② **连续失败到阈值才动手**（默认 3 次 × 30 秒 ≈ 90 秒）—— 单次抖动不许碰它，
 *    否则我们会变成"抖动放大器"。
 * ③ **动手之后给足冷却**（默认 5 分钟）—— 协议端起来 + 登录本身要几十秒，
 *    冷却期内不许再打扰它。
 *
 * ⚠️ 拉起走 `provider.launcherPath()`（配置里的 launcher，SnowLuma 是那个
 *   `_start-hidden.vbs`）—— **不许自己拼命令**（NapCat 时代那个"注入根本没发生"的坑）。
 *
 * ⚠️ 还有一条**不做**的事：**不在这里重启 QQ 登录**。协议端自己会处理它自己的登录态；
 *   我们只负责"把它拉起来"。要不要扫码是它的事，**这里不下任何结论**。
 */
import net from 'node:net';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { log } from './log.js';
import * as provider from './provider.js';

const watchdog = () => config.provider?.watch ?? {};

/** 连续失败计数（每次探测成功清零） */
let fails = 0;
/** 上次动手的时间（冷却用） */
let lastReviveAt = 0;
/** 上次探测成功的时间 */
let lastOkAt = Date.now();
/** 总共拉起过几次（给界面看） */
let reviveCount = 0;
let timer = null;

/** 测试专用：替换探测实现（不然测试就得真开端口） */
let probeImpl = null;

/** 允许的探测超时 */
const probeTimeout = () => {
  const v = Number(watchdog().probeTimeoutMs);
  return Number.isFinite(v) && v > 0 ? v : 3000;
};

/** 连续几次失败才动手 */
const maxFails = () => {
  const v = Number(watchdog().maxFails);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 3;
};

/** 动手之后的冷却 */
const cooldownMs = () => {
  const v = Number(watchdog().cooldownMs);
  return Number.isFinite(v) && v >= 0 ? v : 5 * 60 * 1000;
};

/** 探测间隔 */
const intervalMs = () => {
  const v = Number(watchdog().intervalMs);
  return Number.isFinite(v) && v >= 5000 ? v : 30000;
};

/**
 * 探一下这个端口能不能连上（TCP 握手）。
 * @returns {Promise<boolean>}
 */
export function probePort(port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try {
        s.destroy();
      } catch {}
      resolve(ok);
    };
    const s = net.connect({ host: '127.0.0.1', port });
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

/** 从 `onebot.url` 里抠端口（`ws://127.0.0.1:3001` → 3001）；抠不到就用 3001 */
export function portOf() {
  const u = String(config.onebot?.url ?? '');
  const m = u.match(/:(\d{2,5})(?!\d)/);
  return m ? Number(m[1]) : 3001;
}

/** 状态（给界面 / 日志用） */
export function status() {
  return {
    enable: watchdog().enable !== false,
    port: portOf(),
    fails,
    maxFails: maxFails(),
    intervalMs: intervalMs(),
    cooldownMs: cooldownMs(),
    reviveCount,
    lastOkAt,
    lastReviveAt,
    lastOkAgoMs: lastOkAt ? Date.now() - lastOkAt : null,
    /** 能不能自动拉起（launcher 配了且文件在） */
    canLaunch: provider.can('launch'),
    launcher: provider.launcherPath(),
    provider: provider.name(),
  };
}

/**
 * 用正牌的 launcher 把协议端拉起来（**独立进程**：我们这条命令马上要结束，
 * 被拉起的协议端必须活过它 —— 所以 `detached` + `cmd /c start` + `unref()`）。
 */
function launch() {
  const l = provider.launcherPath();
  if (!l) {
    log.warn('[协议端自愈] 没有配 launcher（config.yml 的 provider.dir / provider.launcher）→ 没法自动拉起');
    return false;
  }
  try {
    // ⚠️ 和 `webui.js` 的「重启机器人」同一个套路：交给一个**独立进程**去做，
    //    别在这个进程里等它（协议端起来要几十秒，等它会把机器人自己也拖住）。
    spawn('cmd.exe', ['/c', 'start', '', '/min', l], {
      detached: true,
      stdio: 'ignore',
      cwd: provider.dir() || undefined,
    }).unref();
    log.warn(`[协议端自愈] 已尝试拉起协议端：${l}`);
    return true;
  } catch (e) {
    log.error(`[协议端自愈] 拉起失败：${e.message}`);
    return false;
  }
}

/**
 * 探一次（定时器每 `intervalMs` 调它）。**导出来是为了测试能直接驱动它。**
 * @returns {Promise<{ok:boolean, acted:boolean, reason:string}>}
 */
export async function tick() {
  if (watchdog().enable === false) return { ok: false, acted: false, reason: '关了' };
  const port = portOf();
  const probe = probeImpl ?? probePort;
  const ok = await probe(port, probeTimeout());
  if (ok) {
    if (fails > 0) log.info(`[协议端自愈] ${port} 又通了（之前连续失败 ${fails} 次）`);
    fails = 0;
    lastOkAt = Date.now();
    return { ok: true, acted: false, reason: '通' };
  }

  fails += 1;
  const need = maxFails();
  const gap = Date.now() - lastReviveAt;
  log.warn(`[协议端自愈] ${port} 连不上（第 ${fails}/${need} 次）`);
  if (fails < need) return { ok: false, acted: false, reason: `还没到阈值（${fails}/${need}）` };

  if (lastReviveAt && gap < cooldownMs()) {
    const left = Math.ceil((cooldownMs() - gap) / 1000);
    log.warn(`[协议端自愈] 到阈值了，但 ${Math.ceil(gap / 1000)}s 前刚拉过（冷却中，还有 ${left}s）→ 这次不动`);
    // ⚠️ 冷却期里**把计数清零**（重新数）—— 不然日志会打成「第 4/3 次」「第 5/3 次」，
    //    读起来像阈值算错了（第一版就是这样）。
    fails = 0;
    return { ok: false, acted: false, reason: `冷却中（还有 ${left}s）` };
  }

  // ⚠️ 动手前把头一句说清楚：**发生了什么、我要做什么、没做什么**
  log.error(
    `[协议端自愈] ${port} 连续 ${fails} 次连不上（约 ${Math.round((fails * intervalMs()) / 1000)}s）` +
      ` → 判定协议端没在听，尝试拉起（⚠️ 只启动、不杀任何进程；也没重启 QQ 登录）`,
  );
  const acted = launch();
  lastReviveAt = Date.now();
  if (acted) reviveCount += 1;
  fails = 0; // 重新数，别在冷却期内一直堆
  return { ok: false, acted, reason: acted ? '已尝试拉起' : '拉不起来（没配 launcher）' };
}

/** 启动定时探测（`index.js` 里调一次） */
export function start() {
  if (watchdog().enable === false) {
    log.info('协议端自愈：已关闭（config.yml 的 provider.watch.enable）');
    return null;
  }
  if (timer) return timer;
  const every = intervalMs();
  timer = setInterval(() => {
    tick().catch((e) => log.debug(`[协议端自愈] 出错：${e.message}`));
  }, every);
  timer.unref?.();
  log.info(
    `协议端自愈：每 ${Math.round(every / 1000)}s 探一次 ${portOf()}` +
      `，连续 ${maxFails()} 次连不上就拉起（冷却 ${Math.round(cooldownMs() / 60000)} 分钟；` +
      `能自动拉起=${provider.can('launch') ? '是' : '否（没配 launcher）'}）`,
  );
  return timer;
}

/** 停掉定时器（测试/重启用） */
export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** 重置计数（测试用） */
export function __reset() {
  fails = 0;
  lastReviveAt = 0;
  lastOkAt = Date.now();
  reviveCount = 0;
  probeImpl = null;
}

/** 测试专用：替换探测实现 */
export function __setProbe(fn) {
  probeImpl = fn;
}
