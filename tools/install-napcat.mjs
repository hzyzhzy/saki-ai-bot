/**
 * 自动下载并配置 NapCat（QQ 协议端）。
 *
 * ## 为什么要有它
 *   用户最痛的一步就是装 NapCat：找对 release、下对包、解压到对的位置、
 *   还得在它的 WebUI 里手填端口和 token。这个脚本把这几步一次做完。
 *
 * ## ⚠️ 关于许可（**不是客套，是硬要求**）
 *   NapCat 用的是 **Limited Redistribution License**（Copyright © 2024 Mlikiowa）：
 *   不得商用；再分发必须附许可全文并标明来源。
 *   所以这个脚本**不镜像、不打包** NapCat ——
 *   它是**用户本人**从**官方 Release** 下载（等于用户自己去作者那儿取）。
 *   运行前必须显式接受许可（`--accept-license`），否则直接拒绝。
 *
 * ## 用法
 * ```bash
 * # 正常用（安装器会这么调）：token 和端口从 config.yml 里读，不用重复传
 * node tools/install-napcat.mjs --bot-qq 123456 --accept-license
 *
 * # 国内网络要挂代理
 * node tools/install-napcat.mjs --bot-qq 123456 --accept-license --proxy http://127.0.0.1:7890
 *
 * # 自己已经下好 zip 了（跳过下载，只解压 + 写配置）
 * node tools/install-napcat.mjs --bot-qq 123456 --accept-license --zip D:\下载\NapCat.Shell.zip
 *
 * # 只看它打算干什么，不下载不写盘
 * node tools/install-napcat.mjs --bot-qq 123456 --accept-license --dry-run
 * ```
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, def = '') => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : def;
};
const has = (n) => argv.includes(`--${n}`);

const REPO = 'NapNeko/NapCatQQ';
const ASSET = 'NapCat.Shell.zip'; // Shell 版：走 QQ 自带 Node，体积最小
const SHELL_DIR = join(ROOT, 'napcat', 'NapCat.Shell');
const ONEBOT_PORT = 3001;

const botQQ = String(arg('bot-qq')).replace(/\D/g, '');
const givenProxy = arg('proxy') || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || '';
const localZip = arg('zip');
const dryRun = has('dry-run');
const version = arg('version'); // 想钉版本：--version v4.18.28
const dest = join(arg('dest') || SHELL_DIR);

// ── 0. 许可门槛 ──────────────────────────────────────────
if (!has('accept-license')) {
  console.log(`
════════════════════════════════════════════════════════════
 关于 NapCat 的许可 —— 请先读这段，再决定要不要继续
════════════════════════════════════════════════════════════
NapCat 使用 **Limited Redistribution License for NapCat**
（Copyright © 2024 Mlikiowa），要点：

  1. 未经作者明确许可，禁止未授权的使用/复制/修改/分发；
  2. 允许再分发，但必须附上许可全文、并明确标注来源与版权；
  3. **不得用于任何商业用途**；
  4. 其它权利需向作者申请。

**本脚本的做法**：不镜像、不打包、不修改 —— 直接用官方 Release 的下载地址，
由**你本人**从作者那里取得。这一步是你与 NapCat 作者之间的关系。

继续即表示你已阅读并接受上述许可（再加 --accept-license 即可）。
许可全文：https://github.com/${REPO}/blob/main/LICENSE
`);
  process.exit(3);
}

if (!botQQ) {
  console.error('✗ 缺机器人 QQ 号：--bot-qq <QQ>');
  process.exit(1);
}

// ── 1. 从 config.yml 读 token / 端口（安装器不用重复传）──────
function readConfigToken() {
  try {
    // 用项目自带的 js-yaml（payload 里有），没有就退回正则
    const p = join(ROOT, 'config.yml');
    if (!existsSync(p)) return '';
    const txt = readFileSync(p, 'utf8');
    const m = txt.match(/^\s*accessToken:\s*['"]?([^'"\s#]+)/m);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}
const token = arg('token') || readConfigToken();
if (!token) {
  console.error('✗ 没拿到 OneBot token（config.yml 里没有 onebot.accessToken，也没给 --token）');
  console.error('  → 先跑 tools/first-run-setup.mjs 生成 config.yml');
  process.exit(1);
}

// ── 2. 拿版本信息（官方 API；连不上就自动试本机常见代理端口）──
//
// ⚠️ 2026-09-17 踩过两次：
//   ① 第一版只把 proxy 用在"下载"那步、API 查询没用 → 明明传了 --proxy 还是 fetch failed；
//   ② 用户根本不知道自己要挂代理 → 所以**自动探测**本机常见代理端口（Clash/v2ray 等），
//      通了就一路用它（API + 下载都走）。
//   探测是"先直连、失败再逐端口试"，所以直连能通的网络不会多花时间。
function proxyCandidates() {
  const list = [];
  if (givenProxy) list.push({ label: `你指定的 ${givenProxy}`, url: givenProxy });
  for (const p of [7890, 7897, 10809, 1080, 10808]) list.push({ label: `本机 ${p}（自动探测）`, url: `http://127.0.0.1:${p}` });
  list.push({ label: '直连', url: '' });
  return list;
}

async function fetchWith(proxyUrl, url, opts = {}) {
  let f = fetch;
  let extra = {};
  if (proxyUrl) {
    const undici = await import('undici');
    f = undici.fetch;
    extra = { dispatcher: new undici.ProxyAgent(proxyUrl) };
  }
  return f(url, { ...extra, ...opts });
}

async function api(path, proxyUrl) {
  const url = `https://api.github.com${path}`;
  const res = await fetchWith(proxyUrl, url, {
    headers: { 'User-Agent': 'saki-ai-bot-installer', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}`);
  return res.json();
}

let proxy = '';
let info = null;
if (!localZip) {
  const tried = [];
  for (const c of proxyCandidates()) {
    try {
      if (c.url) console.log(`· 试着用 ${c.label} 连 GitHub…`);
      const rel = version
        ? await api(`/repos/${REPO}/releases/tags/${version}`, c.url)
        : await api(`/repos/${REPO}/releases/latest`, c.url);
      const a = (rel.assets || []).find((x) => x.name === ASSET);
      if (!a) throw new Error(`这个 release 里没有 ${ASSET}`);
      proxy = c.url;
      info = {
        tag: rel.tag_name,
        url: a.browser_download_url,
        size: a.size,
        sha256: String(a.digest || '').replace(/^sha256:/, ''),
      };
      if (c.url) console.log(`✅ 用 ${c.label} 连上了 GitHub`);
      break;
    } catch (e) {
      tried.push(`${c.label} → ${e.message}`);
    }
  }
  if (!info) {
    console.error('✗ 所有方式都连不上 GitHub：');
    tried.forEach((t) => console.error(`    ${t}`));
    console.error('  两个办法：');
    console.error('    ① 把代理软件开起来（Clash 等），再跑一次这个脚本');
    console.error('    ② 手动下载后用它装：--zip <你下到的 NapCat.Shell.zip 路径>');
    console.error(`  手动下载页：https://github.com/${REPO}/releases/latest`);
    process.exit(2);
  }
}

console.log('客服小祥 · 安装 NapCat');
console.log('─'.repeat(48));
console.log(`  版本      : ${info ? info.tag : '(用本地 zip)'}`);
console.log(`  下载源    : ${info ? info.url : localZip}`);
console.log(`  大小      : ${info ? (info.size / 1048576).toFixed(1) + ' MB' : (statSync(localZip).size / 1048576).toFixed(1) + ' MB（本地）'}`);
console.log(`  sha256    : ${info?.sha256 ? info.sha256.slice(0, 16) + '…（官方 API 给的，会校验）' : '（无，跳过校验）'}`);
console.log(`  安装到    : ${dest}`);
console.log(`  机器人 QQ : ${botQQ}`);
console.log(`  OneBot    : 127.0.0.1:${ONEBOT_PORT}，token ${token.slice(0, 8)}…`);
if (proxy) console.log(`  代理      : ${proxy}`);
console.log('─'.repeat(48));
if (dryRun) {
  console.log('（--dry-run：不下载、不写盘）');
  process.exit(0);
}

// ── 3. 下载 + 校验 ───────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'napcat-dl-'));
const zipPath = localZip || join(work, ASSET);
try {
  if (!localZip) {
    console.log('↓ 下载中…（GitHub 在国内可能很慢，耐心等；失败就按上面 ② 手动下载）');
    // ⚠️ 不走 undici 的 fetch —— 大文件要边下边写盘、要进度。
    //    用 PowerShell 下（Windows 自带、支持代理、有进度回调），避免再加依赖。
    const ps = proxy
      ? `$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '${info.url}' -OutFile '${zipPath}' -Proxy '${proxy}'`
      : `$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '${info.url}' -OutFile '${zipPath}'`;
    const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
    if (r.status !== 0 || !existsSync(zipPath)) throw new Error('下载失败');
    console.log(`✅ 下载完成：${(statSync(zipPath).size / 1048576).toFixed(1)} MB`);
  }

  if (info?.sha256) {
    const h = createHash('sha256');
    h.update(readFileSync(zipPath));
    const got = h.digest('hex');
    if (got !== info.sha256) {
      console.error('✗ sha256 对不上，文件可能被篡改或下坏了 —— 已中止，什么都没装。');
      console.error(`   期望 ${info.sha256}`);
      console.error(`   实际 ${got}`);
      process.exit(4);
    }
    console.log('✅ sha256 校验通过（和官方 API 给的一致）');
  }

  // ── 4. 解压 ────────────────────────────────────────────
  // Windows 10+ 自带 tar（bsdtar）能解 zip，比 PowerShell 的 Expand-Archive 快得多
  const unzipDir = join(work, 'unzip');
  mkdirSync(unzipDir, { recursive: true });
  let ok = false;
  const tar = spawnSync('tar', ['-xf', zipPath, '-C', unzipDir], { stdio: 'pipe' });
  if (tar.status === 0) ok = true;
  if (!ok) {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${unzipDir}' -Force`], { stdio: 'inherit' });
    ok = r.status === 0;
  }
  if (!ok) {
    console.error('✗ 解压失败（tar 和 PowerShell 都不行）');
    process.exit(5);
  }

  // zip 里可能多套一层目录，找到 launcher 所在的那一层
  let srcDir = unzipDir;
  if (!existsSync(join(srcDir, 'launcher-win10-user.bat'))) {
    const inner = readdirSync(unzipDir).map((n) => join(unzipDir, n)).filter((p) => statSync(p).isDirectory());
    const hit = inner.find((p) => existsSync(join(p, 'launcher-win10-user.bat')));
    if (hit) srcDir = hit;
  }
  if (!existsSync(join(srcDir, 'launcher-win10-user.bat'))) {
    console.error('✗ 解压出来的目录里没有 launcher-win10-user.bat —— 包不对？');
    process.exit(5);
  }

  // 拷到位（先解压到临时目录，成功才动目标目录 —— 失败不留下半成品）
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest)) {
    const bak = `${dest}.bak-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
    console.log(`⚠️ 目标目录已存在 → 老的挪到 ${basename(bak)}（没删，你可以自己清）`);
    renameSync(dest, bak);
  }
  mkdirSync(dest, { recursive: true });
  for (const n of readdirSync(srcDir)) {
    renameSync(join(srcDir, n), join(dest, n));
  }
  console.log(`✅ 已解压到 ${dest}`);

  // ── 5. 写 OneBot 配置（端口 + token，让机器人能连上）────
  const cfgDir = join(dest, 'config');
  mkdirSync(cfgDir, { recursive: true });
  const obPath = join(cfgDir, `onebot11_${botQQ}.json`);
  let ob = {
    network: {
      httpServers: [],
      httpSseServers: [],
      httpClients: [],
      websocketServers: [],
      websocketClients: [],
      plugins: [],
    },
    musicSignUrl: '',
    enableLocalFile2Url: false,
    parseMultMsg: false,
    imageDownloadProxy: '',
    timeout: { baseTimeout: 10000, uploadSpeedKBps: 256, downloadSpeedKBps: 256, maxTimeout: 1800000 },
  };
  if (existsSync(obPath)) {
    try {
      ob = JSON.parse(readFileSync(obPath, 'utf8'));
      writeFileSync(`${obPath}.bak`, readFileSync(obPath)); // 别静默覆盖
      console.log('（这个 QQ 的 OneBot 配置已存在 → 只补/更新那一条 websocket 服务端，其余不动）');
    } catch {}
  }
  ob.network = ob.network || {};
  ob.network.websocketServers = Array.isArray(ob.network.websocketServers) ? ob.network.websocketServers : [];
  const entry = {
    name: 'qq-ai-bot',
    enable: true,
    host: '127.0.0.1',
    port: ONEBOT_PORT,
    messagePostFormat: 'array',
    reportSelfMessage: false,
    token,
    enableForcePushEvent: true,
    debug: false,
    heartInterval: 30000,
  };
  const i = ob.network.websocketServers.findIndex((s) => s && s.name === 'qq-ai-bot');
  if (i >= 0) ob.network.websocketServers[i] = { ...ob.network.websocketServers[i], ...entry };
  else ob.network.websocketServers.push(entry);
  writeFileSync(obPath, JSON.stringify(ob, null, 2), 'utf8');
  console.log(`✅ 已写 OneBot 配置：config\\onebot11_${botQQ}.json（端口 ${ONEBOT_PORT}，token 与 config.yml 一致）`);

  console.log(`
════════════════════════════════════════════════════════════
 NapCat 装好了，接下来只剩"登录"这一步（没人能替你点）
════════════════════════════════════════════════════════════
 1. **先把 QQ 完全退出**（NapCat 是在 QQ 启动时注入的，QQ 开着就注入不进去）
 2. 双击：${join(dest, 'launcher-win10-user.bat')}
    → 会启动 QQ 并注入 NapCat（窗口最小化在任务栏，别关）
 3. 登录态失效时它会出二维码：在 QQ 窗口里扫码，或打开
    NapCat 自己的 WebUI http://127.0.0.1:6099 看二维码
 4. 回到安装目录，双击「一键启动（QQ+机器人）.bat」
 5. 想确认成没成：日志里要出现「已连接到协议端」+「已登录 QQ」

 ⚠️ NapCat 不得用于商业用途（Limited Redistribution License）；
    第三方协议端有账号被风控的风险，请自行评估。
════════════════════════════════════════════════════════════`);
} finally {
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {}
}
