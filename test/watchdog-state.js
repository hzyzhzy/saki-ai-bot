/**
 * 看门狗「QQ 到底在不在线」判据测试（2026-09-15）。
 *
 * ## 用户报的 bug
 *
 *   NapCat 控制台：
 *     23:34:14 [error] [KickedOffLine] 你的账号当前登录已失效，请重新登录。
 *     23:34:15 [info]  账号状态变更为离线
 *     23:34:52 [info]  正在快速登录 10000002
 *     23:34:52 [error] 当前账号(10000002)已登录,无法重复登录
 *
 *   「为什么说已登录，却**实际没登录**？」
 *
 * ## 根因（翻 napcat.mjs 查到的）
 *
 *   ```js
 *   c.onUserLoggedIn = (u) => {
 *     const l = `当前账号(${u})已登录,无法重复登录`;
 *     e.logError(l), ve.setQQLoginError(l);      // ← 只记错误，**不动登录状态**
 *   }
 *   c.onQRCodeLoginSucceed = async (u) => {
 *     o.isLogined = !0, ve.setQQLoginStatus(!0)  // ← 只有"扫码成功"才置为已登录
 *   }
 *   ```
 *
 *   · 那句话是 **QQ 核心**说的（它本地还攥着已被服务器作废的会话）；
 *   · NapCat 当**错误**记下来，**没有**把状态置成已登录；
 *   · `quickLoginWithUin()` 的 promise **只在扫码成功时才 resolve** →
 *     快登**永远不返回** → 15 秒 HTTP 超时；
 *   · 最终停在 `QQLoginStatus = false` = **真的没登录**。
 *
 *   ⚠️ 而**老代码把 loginError 里的「已登录」当成"在线"** →
 *      离线计数清零 → 看门狗**再也没动过**，静默 45 分钟。**那才是真 bug。**
 *
 * ## 这个套件盯什么
 *
 *   给 `tools/napcat-state.mjs` 喂一个**假 NapCat WebUI**，验四件事：
 *     · `isLogin:true` → online
 *     · 「已登录,无法重复登录」→ **stale**（★ 就是这次修的，绝不是 online）
 *     · 「失效/请重新登录」→ offline（在等扫码 → **不许重启 NapCat**，会作废二维码）
 *     · 机器人号**不在快登名单**里 → `nocred`（→ 别白试快登，直接叫人扫码）
 *
 * ⚠️ 纯离线：假 NapCat 跑在随机端口，`QQBOT_CONFIG` 指到 `logs/`，
 *   **不碰真 NapCat（6099）、不碰真实 config.yml**。
 *
 * 用法: node test/watchdog-state.js
 */
import { createServer } from 'node:http';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });
const CFG_REL = 'logs/__test-wdstate.yml';

const BOT_QQ = '10000002';
const OWNER_QQ = '10000001';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

// ── 假 NapCat WebUI ──────────────────────────────────
// 只实现这台机器真实用到的三条：auth/login、CheckLoginStatus、GetQuickLoginList
let scenario = {}; // 每个用例改它

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (obj) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.url === '/api/auth/login') return send({ code: 0, data: { Credential: 'fake-cred' } });
    const authed = String(req.headers.authorization ?? '') === 'Bearer fake-cred';
    if (!authed) return send({ code: -1, message: 'unauthorized' });
    if (req.url === '/api/QQLogin/CheckLoginStatus') {
      return send({
        code: 0,
        data: {
          isLogin: scenario.isLogin === true,
          isOffline: scenario.isOffline === true,
          qrcodeurl: 'https://txz.qq.com/p?k=fake',
          loginError: scenario.loginError ?? '',
        },
      });
    }
    if (req.url === '/api/QQLogin/GetQuickLoginList') {
      return send({ code: 0, data: scenario.quickList ?? [] });
    }
    return send({ code: -1, message: 'unknown endpoint' });
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

// ⚠️ 配置必须在**跑工具之前**写好（`config.js` 是加载时读的）
writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
    '  apiKey: "sk-test"',
    '  model: t',
    `botQQ: "${BOT_QQ}"`,
    `ownerQQ: "${OWNER_QQ}"`,
    'napcat:',
    '  enable: true',
    '  webuiHost: 127.0.0.1',
    `  webuiPort: ${PORT}`,
    '  webuiToken: "test-token"',
    '',
  ].join('\n'),
  'utf8',
);

/**
 * 跑一次探针，拿它打印的那一行（`<state>:<cred|nocred>`）。
 *
 * ⚠️⚠️ **必须用异步 execFile，不能用 spawnSync** —— 踩过：
 *    `spawnSync` 会**阻塞本进程的事件循环**，而假 NapCat 就跑在本进程里，
 *    于是"子进程发请求 → 等父进程回应"变成死锁：TCP 连得上，但永远没有响应，
 *    8 秒后 `AbortSignal.timeout` 到点 → 探针报 ok:false → 全判成 unknown:nocred。
 *    表现是**每一条都失败**，看着像探针坏了，其实是测试自己把自己锁住了。
 */
async function probe() {
  try {
    const { stdout } = await pExecFile(process.execPath, [join(ROOT, 'tools', 'napcat-state.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, QQBOT_CONFIG: CFG_REL },
      timeout: 30000,
    });
    return String(stdout ?? '').trim().split('\n').pop() ?? '';
  } catch (e) {
    // 工具本身按契约一定会打印一行；真出错就把它暴露出来，别静默当 unknown
    return `<probe 失败: ${String(e?.stdout ?? e?.message ?? e).trim()}>`;
  }
}

// ─────────────────────────────────────────────────────
console.log('\n【1】在线：isLogin=true → online');
{
  scenario = { isLogin: true, quickList: [OWNER_QQ, BOT_QQ] };
  const got = await probe();
  check(got === 'online:cred', '在线 + 凭据在 → online:cred', `实际 ${JSON.stringify(got)}`);
}

console.log('\n【2】★ 卡死态：「已登录,无法重复登录」**绝不是在线**（这次修的）');
{
  scenario = {
    isLogin: false,
    isOffline: false,
    loginError: `当前账号(${BOT_QQ})已登录,无法重复登录`,
    quickList: [OWNER_QQ, BOT_QQ],
  };
  const got = await probe();
  check(got === 'stale:cred', '★ 判成 stale（改前会被当成 online → 看门狗从此静默）', `实际 ${JSON.stringify(got)}`);
  check(!got.startsWith('online'), '★ 尤其**不许**判成 online');
}

console.log('\n【3】真离线：「登录态已失效，请重新登录」→ offline（在等扫码，不许重启）');
{
  scenario = { isLogin: false, isOffline: false, loginError: '登录态已失效，请重新登录。', quickList: [OWNER_QQ] };
  const got = await probe();
  check(got === 'offline:nocred', '真离线 → offline', `实际 ${JSON.stringify(got)}`);
  check(!got.startsWith('stale'), '★ 别把"在等扫码"误判成卡死（那会重启 NapCat → 作废二维码）');
}

console.log('\n【4】★ 凭据被清掉：机器人号不在快登名单 → nocred');
{
  // 2026-09-15 实测：被踢之后名单里就只剩服主主号了
  scenario = {
    isLogin: false,
    loginError: `当前账号(${BOT_QQ})已登录,无法重复登录`,
    quickList: [OWNER_QQ],
  };
  const got = await probe();
  check(got === 'stale:nocred', '★ 卡死 + 凭据没了 → stale:nocred（→ 别白试快登，直接叫人扫码）', `实际 ${JSON.stringify(got)}`);
}

console.log('\n【5】★ 「二维码已过期，请刷新」也是 offline（实测刚重启完就是这个）');
{
  // 2026-09-15 实测：NapCat 刚重启、还没人扫的时候 loginError 就是这个。
  // ⚠️ 原来没把「过期/刷新」算进去 → 掉进 unknown → 看门狗什么都不做。
  scenario = { isLogin: false, isOffline: false, loginError: '二维码已过期，请刷新', quickList: [] };
  const got = await probe();
  check(got === 'offline:nocred', '★ 过期码 → offline（不是 unknown）', `实际 ${JSON.stringify(got)}`);
}

console.log('\n【6】快登名单为空 / 查不到 → 也不许乱判');
{
  scenario = { isLogin: false, loginError: '', quickList: [] };
  const got = await probe();
  check(got === 'unknown:nocred', '没错误信息也没登录 → unknown（**绝不当作离线**）', `实际 ${JSON.stringify(got)}`);
}

console.log('\n【7】NapCat 完全不通 → unknown（不能因此去重启）');
{
  await new Promise((r) => server.close(r));
  const got = await probe();
  check(got === 'unknown:nocred', '连不上 6099 → unknown:nocred', `实际 ${JSON.stringify(got)}`);
}

console.log('\n【8】看门狗侧：接线与阈值');
{
  const src = (await import('node:fs')).readFileSync(join(ROOT, 'watchdog.ps1'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  check(code.includes('napcat-state.mjs'), '看门狗调的是 tools/napcat-state.mjs');
  check(
    !/loginError[^\n]*已登录[^\n]*online|含「已登录」\s*→\s*(在线|online)/.test(code),
    '★ 代码里**没有**「loginError 含已登录 → online」那条老判据了',
  );
  check(/\$qqDead\s*=/.test(code) && /stale/.test(code), '★ 把 stale 也算作"死了要处理"');
  check(/hasCred/.test(code), '★ 用了 hasCred 决定"要不要白试快登"');
  check(
    /stale' -and \$qq\.hasCred/.test(code),
    '★ 只有「卡死 + 凭据还在」才重启 NapCat（在等扫码时绝不重启）',
  );
  check(
    /\(Test-QQOnline\)\.state -eq 'online'|\$after\.state -eq 'online'/.test(code),
    '恢复判定读的是 .state（不是拿字符串跟 online 比）',
  );
  check(/\[pscustomobject\]/.test(code), '返回值是对象（state + hasCred）');
  // 硬编码机器人号必须没了
  check(!/'10000002'/.test(code), '没有硬编码的机器人号了（从 config.yml 读）');

  // ★ 启动那一段也必须认"在等扫码"
  //   踩过：主循环认了、启动漏了 → 每次重启看门狗都杀掉 QQ、作废用户刚要扫的码。
  //   ⚠️ 这里用**原始源码**切片 —— `code` 已经把注释行删了，
  //      而"启动时先对齐一次状态"这行提示词就在注释里，用 code 会 indexOf -1（踩过）。
  const at = src.indexOf('启动时先对齐一次状态');
  const startup = at >= 0 ? src.slice(at, at + 1200) : '';
  check(at >= 0, '找得到「启动时先对齐一次状态」那一段');
  check(/\$webuiUp/.test(startup), '★ 启动时的对齐也查了 6099（在等扫码就不重启）');
  check(
    /if \(\$webuiUp\)[\s\S]{0,200}?不重启/.test(startup) || /在等扫码登录[\s\S]{0,120}?不重启/.test(startup),
    '★ 6099 通 → 走"不重启、等用户扫"那一路',
  );

  // ★ 「在等扫码」时必须把机器人拉起来 —— 码是在 3099 里看的
  //   踩过：只 Say 一句就 continue，机器人停着 → 3099 不通 → 用户根本看不到码。
  //   ⚠️ 切片要锚在**那句提示词**上：`3099` 字面量在源码里出现好几处，
  //      而 `Say '⏳ …'` 是**后面**才执行的，从它往后切 900 字切不到（踩过）。
  const at3099 = src.indexOf('3099）不在');
  const waitKeepAlive = at3099 >= 0 ? src.slice(at3099, at3099 + 400) : '';
  check(at3099 >= 0, '★ 「在等扫码」那一支里查了 3099（界面在不在）');
  check(/Start-Bot/.test(waitKeepAlive), '★ 界面不在就把机器人拉起来（不然没人能显示二维码）');
}

try {
  rmSync(join(ROOT, CFG_REL), { force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
