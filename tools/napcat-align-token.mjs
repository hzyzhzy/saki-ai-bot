/**
 * 把「机器人这边的 accessToken」和「NapCat 那边的 token」对齐（一键，不用手填）。
 *
 * ## 为什么要有它（2026-09-18 用户要求）
 *
 * 用户原话：「那个登录 token 还是对新人不友好不方便找，这个能不能优化一下」。
 *
 * 装 NapCat 的人现在的流程是：我们的安装器随机生成一个 token 写进 `config.yml`，
 * 然后让用户「打开 NapCat 的 WebUI → 网络配置 → 把那串 token 填进去」——
 * 那串 token 藏在 `config.yml` 里、要填的地方藏在 NapCat 的界面里，**既难找又容易填错**。
 *
 * 可这两边其实**都是明文 JSON**，直接写就行：
 *   · 我们这边：`config.yml` 的 `onebot.accessToken`
 *   · NapCat 那边：`napcat/NapCat.Shell/config/onebot11_<QQ>.json`
 *                   → `network.websocketServers[].token`
 *
 * ## 用法
 *
 *   node tools/napcat-align-token.mjs --check   # 只看两边一致不一致，不改（推荐先跑）
 *   node tools/napcat-align-token.mjs           # 不一致就写成一致
 *
 * ## ⚠️ 三个必须知道的坑
 *
 * 1. **改完要重启 NapCat 才生效** —— NapCat 只在启动时读这份配置。
 *    而重启 NapCat = **一次 QQ 登录**（这个号是风险设备），所以别为了这个反复重启。
 * 2. **NapCat 正在跑的时候，它可能把我们的改动覆盖回去**（它内存里是旧值）。
 *    所以：改完**紧接着**重启 NapCat，或者干脆在 NapCat 没跑的时候改。
 * 3. 找不到 `onebot11_*.json` ⇒ NapCat **还没装，或者装完还没启动过一次**
 *    （那个文件是 NapCat 首次启动时自己生成的）。那就等它跑起来再执行本脚本。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ONLY = process.argv.includes('--check');

const CONFIG = join(ROOT, 'config.yml');
// ⚠️ NapCat 的配置目录要**挨个候选位置找**：
//    ① `<项目>/napcat/NapCat.Shell/config` —— **安装包装出来的位置**
//       （`first-run-setup.mjs` 里就是让用户解压到 `<本目录>\napcat\NapCat.Shell\`）
//    ② `<项目>/../napcat/NapCat.Shell/config` —— **开发机上的布局**
//       （2026-09-18 实测：这台机器的 napcat 在项目**上一层**，第一版只找了 ①，
//         结果明明装着 NapCat 却报"没装"）
const NAPCAT_CONF_DIR = [
  join(ROOT, 'napcat', 'NapCat.Shell', 'config'),
  join(ROOT, '..', 'napcat', 'NapCat.Shell', 'config'),
].find((p) => existsSync(p));

/** 从 `config.yml` 取机器人这边的 token 和它要连的端口 */
function mine() {
  const j = yaml.load(readFileSync(CONFIG, 'utf8')) ?? {};
  const token = String(j?.onebot?.accessToken ?? '').trim();
  const url = String(j?.onebot?.url ?? '');
  const port = Number((/:\s*(\d+)/.exec(url) ?? [])[1]) || 0;
  return { token, url, port };
}

const me = mine();
console.log(`机器人这边（config.yml）：`);
console.log(`  地址 ${me.url || '(没写)'}　端口 ${me.port || '(没写)'}`);
console.log(`  token ${me.token ? me.token : '(空 —— 那 NapCat 那边也该留空)'}`);

if (!existsSync(NAPCAT_CONF_DIR)) {
  console.log(`\n❌ 找不到 NapCat 的配置目录：${NAPCAT_CONF_DIR}`);
  console.log('   → 说明 NapCat 还没装，或者装在别的地方。装好并**启动过一次**之后再跑本脚本。');
  process.exit(1);
}

const files = readdirSync(NAPCAT_CONF_DIR).filter((f) => /^onebot11_\d+\.json$/.test(f));
if (!files.length) {
  console.log(`\n❌ ${NAPCAT_CONF_DIR} 里没有 onebot11_<QQ>.json`);
  console.log('   → 那是 NapCat **首次启动时自己生成的**。先启动一次 NapCat，再跑本脚本。');
  process.exit(1);
}

let changed = 0;
let same = 0;
for (const f of files) {
  const p = join(NAPCAT_CONF_DIR, f);
  let j;
  try {
    j = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    console.log(`\n⚠️ ${f}：读不出来（${e.message}），跳过`);
    continue;
  }
  const servers = j?.network?.websocketServers;
  if (!Array.isArray(servers) || !servers.length) {
    console.log(`\n⚠️ ${f}：没有 websocketServers（NapCat 里还没建 OneBot 的 WS 服务端），跳过`);
    console.log('   → 先去 NapCat 的「网络配置」里新建一个 WebSocket 服务端（端口对上就行），再跑本脚本。');
    continue;
  }
  // 挑"就是给这个机器人用的"那个：优先名字，其次端口
  const hit =
    servers.find((s) => String(s?.name ?? '').includes('qq-ai-bot')) ??
    servers.find((s) => Number(s?.port) === me.port) ??
    servers[0];
  const now = String(hit?.token ?? '');
  if (now === me.token) {
    console.log(`\n✅ ${f}　（${hit?.name ?? '未命名'} :${hit?.port ?? '?'}）token 已经一致，不用改`);
    same++;
    continue;
  }
  console.log(`\n${CHECK_ONLY ? '🔍' : '✏️'} ${f}　（${hit?.name ?? '未命名'} :${hit?.port ?? '?'}）`);
  console.log(`   现在是：${now || '(空)'}`);
  console.log(`   应该是：${me.token || '(空)'}`);
  if (CHECK_ONLY) {
    changed++;
    continue;
  }
  hit.token = me.token;
  copyFileSync(p, `${p}.bak-${Date.now()}`); // 动别人的配置文件，先留一份
  writeFileSync(p, JSON.stringify(j, null, 2), 'utf8');
  console.log(`   → 已改（备份在同目录 ${basename(p)}.bak-*）`);
  changed++;
}

console.log(
  `\n结果：${same} 个已经一致，${changed} 个${CHECK_ONLY ? '需要改（--check 模式，没动）' : '已改'}`,
);
if (changed && !CHECK_ONLY) {
  console.log('\n⚠️⚠️ 还要**重启 NapCat** 才生效 —— 它只在启动时读这份配置。');
  console.log('   重启 NapCat = 一次 QQ 登录（这个号是风险设备），所以：');
  console.log('   ① 现在就去重启 NapCat（趁它还没把改动覆盖回去）；');
  console.log('   ② 重启之后跑一次 `node tools/napcat-align-token.mjs --check` 确认还是"一致"。');
}
