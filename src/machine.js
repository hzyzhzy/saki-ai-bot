/**
 * 电脑状态 —— 把运行这台机器人的电脑当成「小祥工作的电脑」。
 *
 * 群友问「你电脑什么配置」「还剩多少电」时，她能根据**真实数据**回答，
 * 而不是编一个。这既提高沉浸感，也真的有用（比如她想说「我这边电脑快没电了」）。
 */
import os from 'node:os';
import { statfsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { config } from './config.js';
import { log } from './log.js';
import * as persona from './persona.js';

const CACHE_MS = 30000;
let cache = { at: 0, data: null };

// ── 网络可达性（2026-09-12 加）──────────────────────────────
//
// 用户要求：「这种能也加进问机器人电脑状态的功能吗」。
// 起因是群里有人问「你能上油管吗」，机器人只能含糊地说「没试过…要不知道」——
// 而她其实**完全测得起**：这台机器有代理，海外站点走代理可达。
//
// 所以这里定期探一次「国内 / 海外」两组站点，让她能像说自己的电脑一样
// 直接回答「能 / 不能 / 代理没开」。
//
// ⚠️ 为什么用「后台定时刷新 + 读缓存」而不是每次现测：
//    现测一次要好几秒，而 machineText() 是**同步**的（在拼提示词时调用）。
//    所以启动后先测一次，之后每 NET_CACHE_MS 刷一次，问的时候读缓存。
const NET_CACHE_MS = 5 * 60 * 1000;
const netCache = { at: 0, data: null, running: false };

/** 探一个地址通不通 */
async function reachable(url, ms = 6000) {
  try {
    const r = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(ms),
      // 只要拿到响应就算通，不用读内容
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; xiaoxiang-netcheck)' },
    });
    return r.status < 500;
  } catch {
    return false;
  }
}

/**
 * 刷新网络可达性（后台跑，别 await 在提示词拼装路径上）。
 */
export async function refreshNetwork() {
  if (netCache.running) return;
  netCache.running = true;
  try {
    // 两组分开测：**国内**（不走代理也该通）和**海外**（要走代理）
    const [baidu, bing, google, youtube] = await Promise.all([
      reachable('https://www.baidu.com', 5000),
      reachable('https://www.bing.com', 5000),
      reachable('https://www.google.com', 7000),
      reachable('https://www.youtube.com', 7000),
    ]);
    netCache.at = Date.now();
    netCache.data = { baidu, bing, google, youtube };
    log.debug(
      `网络可达性：国内=${baidu || bing ? '通' : '断'} 海外=${google || youtube ? '通' : '断'}`,
    );
  } catch (e) {
    log.debug(`网络探测失败：${e.message}`);
  } finally {
    netCache.running = false;
  }
}

/** 起后台定时刷新（启动时调一次） */
export function startNetworkProbe() {
  refreshNetwork().catch(() => {});
  const t = setInterval(() => refreshNetwork().catch(() => {}), NET_CACHE_MS);
  t.unref?.();
}

/** 读网络可达性（给提示词用，同步） */
export function networkStatus() {
  return netCache.data;
}

/** 跑一条 PowerShell，失败返回空串 */
function ps(cmd, timeout = 12000) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
    }).trim();
  } catch (e) {
    log.debug(`PowerShell 查询失败：${e.message}`);
    return '';
  }
}

const gb = (n) => Number((n / 1024 ** 3).toFixed(1));

/** 电池信息（台式机没有，返回 null） */
function battery() {
  const out = ps(
    'Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress',
  );
  if (!out) return null;
  try {
    const j = JSON.parse(out);
    const pct = Number(j.EstimatedChargeRemaining);
    if (!Number.isFinite(pct)) return null;
    // BatteryStatus: 1=放电中 2=接电源 3=充满 4=低电量 5=临界 6=充电中
    const st = Number(j.BatteryStatus);
    const charging = st === 2 || st === 6 || st === 3;
    return { percent: pct, charging, status: st };
  } catch {
    return null;
  }
}

/** CPU 使用率（要跑 WMI，比较慢，所以缓存里） */
function cpuLoad() {
  const out = ps('(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average');
  const n = Number(out);
  return Number.isFinite(n) ? n : null;
}

/**
 * 独立显卡名。注意：装了向日葵之类的远程软件会多出来一个虚拟显示器，
 * 所以要过滤掉那些假显卡，优先报真显卡。
 */
function gpu() {
  const out = ps('Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name');
  if (!out) return null;
  const lines = out
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  const fake = /OrayIddDriver|Virtual|Basic Display|Remote|ToDesk|Parsec|VDD|Mirror/i;
  const real = lines.filter((x) => !fake.test(x));
  return (real.length ? real : lines).slice(0, 2).join(' / ') || null;
}

/** 磁盘（系统盘） */
function disk() {
  try {
    const s = statfsSync(process.env.SystemDrive || 'C:');
    return { total: gb(s.blocks * s.bsize), free: gb(s.bavail * s.bsize) };
  } catch {
    return null;
  }
}

/**
 * 采集当前电脑状态。带 30 秒缓存，免得每次都跑 PowerShell。
 */
export function snapshot(force = false) {
  const now = Date.now();
  if (!force && cache.data && now - cache.at < CACHE_MS) return cache.data;

  const total = os.totalmem();
  const free = os.freemem();
  const data = {
    at: now,
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    cpuModel: (os.cpus()[0]?.model ?? '').replace(/\s+/g, ' ').trim(),
    cpuCores: os.cpus().length,
    cpuLoad: cpuLoad(),
    memTotal: gb(total),
    memUsed: gb(total - free),
    memFree: gb(free),
    memPercent: Math.round(((total - free) / total) * 100),
    uptimeHours: Number((os.uptime() / 3600).toFixed(1)),
    disk: disk(),
    battery: battery(),
    gpu: gpu(),
  };
  cache = { at: now, data };
  return data;
}

export function clearCache() {
  cache = { at: 0, data: null };
}

/** 电量低 / 没插电的提醒语气用得到 */
export function batteryMood(b) {
  if (!b) return '';
  if (b.charging) return b.percent >= 95 ? '电已经充满了' : `在充电，${b.percent}%`;
  if (b.percent <= 10) return `只有 ${b.percent}% 了，快没电了`;
  if (b.percent <= 25) return `${b.percent}%，有点悬`;
  return `没插电，还有 ${b.percent}%`;
}

/**
 * 拼成给人设看的「电脑状态」段落。
 * 让她能像说自己的电脑一样说出来。
 */
export function machineText() {
  if (config.machine?.enable === false) return '';
  const m = snapshot();
  const name = config.machine?.name || '我这台电脑';

  const lines = [
    `主机名：${m.hostname}`,
    `CPU：${m.cpuModel}（${m.cpuCores} 核）${m.cpuLoad !== null ? `，当前占用 ${m.cpuLoad}%` : ''}`,
    `内存：${m.memTotal} GB，已用 ${m.memUsed} GB（${m.memPercent}%）`,
  ];
  if (m.disk) lines.push(`系统盘剩余：${m.disk.free} GB / ${m.disk.total} GB`);
  if (m.gpu) lines.push(`显卡：${m.gpu}`);
  if (m.battery) {
    lines.push(
      `电池：${m.battery.percent}%${m.battery.charging ? '（正在充电）' : '（没插电）'}`,
    );
  } else {
    lines.push('电池：没有电池（台式机，一直插着电）');
  }
  lines.push(`已开机：${m.uptimeHours} 小时`);

  // ── 网络可达性（2026-09-12 加，用户要求）──
  // 群里有人问「你能上油管吗」，她只能含糊地说「没试过…要不知道」。
  // 其实完全测得起 —— 这里把结果直接给她。
  const net = networkStatus();
  let netLine = '';
  if (!net) {
    netLine = '网络：还没测出来（稍后会有一个结果）';
  } else {
    const cn = net.baidu || net.bing;
    const abroad = net.google || net.youtube;
    netLine =
      `网络：国内网站 ${cn ? '**能上**' : '上不去'}；` +
      `海外网站（Google / YouTube）${abroad ? '**能上**（有代理）' : '**上不去**（代理没开或挂了）'}`;
  }
  const netLines = [
    '',
    '## 网络（她自己也关心这个，因为别人老问）',
    '',
    netLine,
    '',
    '有人问「你能上油管吗 / 能不能翻墙 / 网通不通」——**照上面如实答**，别猜、别编。',
    '- 能上就说能上（可以顺口提一句「我这有代理」）。',
    '- 上不去就直说上不去，别装。',
    '- ⚠️ **别主动扯政治**，就当作「网通不通」这种技术问题回答。',
  ];

  return [
    `# 【你手边这台电脑·实时状态】（${name}）`,
    '',
    '## ⚠️ 先分清：「你」和「这台电脑」是两个东西',
    '',
    `**你就是${persona.shortName()}，是个活人。这台电脑只是你用的一台机器。**`,
    '你坐在这台机器前面，用它看群、回消息、查服务器、看图片。',
    '',
    '- ❌ **绝对不要说「我这台电脑」** —— 你**不是**一台电脑。',
    '- ❌ 也别把自己说成机器、AI、程序、账号、系统。',
    '- ✅ 要提设备就说「**我这边**」「**我这台机子**」「**我手边这台**」。',
    '  「机子」可以，「我这台电脑」不行 —— 差了「我这」两个字，性质就变了。',
    '  （真实踩过：之前说过「别老盯着我这台电脑看」，直接被当成了电脑。）',
    '- 如果群友问「你用什么设备」——那是在问**你的机器**，照下面真实数据答就行，',
    '  但别顺着他的话把自己也说成设备。',
    '- 你是**能看图的**（系统会把图的内容识别给你），所以**永远不要说「我看不到图」**。',
    '',
    '（背景：服主 <主人> 之前说过要给你换个「能看图、能发语音」的设备，',
    '后来直接给了你这台电脑。**这件事已经发生了，所以你现在就能看图。**',
    '别再把「以后会不会给我换设备」当成还没发生的事来说。）',
    '',
    '## 实时数据（这是**机器**的数据，不是你的身体状况）',    '',
    ...lines,
    ...netLines,
    '',
    '有人问配置、电量、卡不卡，就用上面的**真实数据**回答，别编。',
  ].join('\n');
}

/** 给管理界面看的 */
export function machineStatus() {
  const m = snapshot(true);
  return { ...m, text: machineText() };
}
