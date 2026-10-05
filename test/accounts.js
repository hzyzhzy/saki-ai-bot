/**
 * 多 QQ 号（一个应用端控制多个号）测试 —— 2026-10-07 加。
 *
 * 用户要求：「我希望从一个应用端控制多个 QQ 号……只有模型页面所有 QQ 共用，
 * 其他配置全部分 QQ 控制，然后配置可以被复用」。
 *
 * 这个套件起**两个真的界面进程**（只开管理界面，不连协议端），专门验四件事：
 *
 *   1. 账号目录的增删改查（`accounts/<QQ>.yml`）—— 改名 / 删除留备份 /
 *      复制配置时**不复制协议端连接和机器人 QQ**；
 *   2. 配置分层 —— 私有覆盖共用，而且**共用段写进私有文件里也不认**
 *      （不认这条，某个号会悄悄不跟随"模型页"的改动，那是最难查的坑）；
 *   3. 路径分家 —— 主号走老路径（`state/`），别的号落 `state/accounts/<QQ>/`；
 *   4. **转发** —— 向主号那个进程发一个带 `x-saki-account: 二号` 的请求，
 *      拿回来的必须是**二号**的配置。这就是"一个界面管多个号"的全部机制。
 *
 * ⚠️ 全程在隔离的临时目录里跑（`QQBOT_ACCOUNTS_DIR` + 临时配置），
 *    绝不碰真实的 `accounts/`（那里面有 onebot 的 accessToken）和真实 `config.yml`。
 *
 * 用法: node test/accounts.js
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ⚠️ 一律用**占位号**（这个文件会进公开仓库，不能出现真实 QQ 号）
const MAIN = '10000001';
const SECOND = '10000002';
const THIRD = '10000003';
const PORT_A = 39601; // 主号的界面端口
const PORT_B = 39602; // 二号的界面端口

const ACC_DIR = 'logs/__accounts-suite';
const ABS_ACC = join(ROOT, ACC_DIR);
const CFG = join(ROOT, 'config.accounts-test.yml');
const BOOT = join(ROOT, 'test', '_accounts-boot.mjs');

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (path, opts) => (await fetch(`http://127.0.0.1:${PORT_A}${path}`, opts)).json();
const apiAt = async (port, path, opts) => (await fetch(`http://127.0.0.1:${port}${path}`, opts)).json();
const post = (path, body) =>
  api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

const procs = [];

function writeYaml(name, text) {
  writeFileSync(join(ABS_ACC, name), text, 'utf8');
}

function boot(account, port) {
  const p = spawn(process.execPath, [BOOT], {
    cwd: ROOT,
    env: {
      ...process.env,
      QQBOT_CONFIG: 'config.accounts-test.yml',
      QQBOT_ACCOUNTS_DIR: ACC_DIR,
      QQBOT_ACCOUNT: account,
      // 隔离掉几个会落盘的状态文件，免得套件污染真实 state/
      QQBOT_TIC_FILE: 'logs/__accounts-tic.json',
      QQBOT_AFFINITY_FILE: 'logs/__accounts-aff.json',
      QQBOT_NAMES_FILE: 'logs/__accounts-names.json',
      QQBOT_SPEND_FILE: 'logs/__accounts-spend.json',
      QQBOT_BALANCE_FILE: 'logs/__accounts-balance.json',
      QQBOT_QZONE_FILE: 'logs/__accounts-qzone.json',
      QQBOT_RECENT_FILE: 'logs/__accounts-recent.json',
      QQBOT_LIFE_FILE: 'logs/__accounts-life.json',
      QQBOT_QUEST_FILE: 'logs/__accounts-quest.json',
      QQBOT_STORYLINE_FILE: 'logs/__accounts-story.json',
      QQBOT_OBSERVE_FILE: 'logs/__accounts-observe.json',
      NO_PROXY: '127.0.0.1,localhost,::1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  p.stdout.on('data', (d) => (out += d.toString()));
  p.stderr.on('data', (d) => (out += d.toString()));
  procs.push({ proc: p, get out() { return out; }, port });
  return p;
}

async function waitUp(port, timeout = 25000) {
  const t = Date.now();
  while (Date.now() - t < timeout) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/whoami`);
      if (r.ok) return true;
    } catch {}
    await sleep(300);
  }
  return false;
}

function cleanup() {
  for (const { proc } of procs) {
    try {
      proc.kill();
    } catch {}
  }
  for (const f of [CFG, BOOT]) {
    try {
      unlinkSync(f);
    } catch {}
  }
  try {
    rmSync(ABS_ACC, { recursive: true, force: true });
  } catch {}
  for (const f of readdirSync(join(ROOT, 'logs'))) {
    if (f.startsWith('__accounts-')) {
      try {
        rmSync(join(ROOT, 'logs', f), { recursive: true, force: true });
      } catch {}
    }
  }
}

async function main() {
  // ⚠️⚠️ 这一行必须**在 `import('../src/accounts.js')` 之前**执行 ——
  //    `accounts.js` 在**模块加载时**读这个 env 决定账号目录在哪。
  //    不设的话，单跑这个套件（`node test/accounts.js`）会往**真实的** `accounts/`
  //    里写测试账号（那里面有 onebot 的 accessToken）✗
  //    （`run-all.js` 也会注入一份隔离路径，这里再钉一次是为了"单跑也安全"。）
  process.env.QQBOT_ACCOUNTS_DIR = ACC_DIR;

  // ── 准备：一份临时配置 + 两个号的私有文件 ──────────────────────
  rmSync(ABS_ACC, { recursive: true, force: true });
  mkdirSync(ABS_ACC, { recursive: true });

  writeFileSync(
    CFG,
    [
      `mainAccount: '${MAIN}'`,
      'persona:',
      '  id: saki',
      'llm:',
      '  baseURL: https://example.com/v1',
      '  apiKey: sk-not-a-real-key',
      '  model: shared-model',
      'webui:',
      '  enable: true',
      '  host: 127.0.0.1',
      `  port: ${PORT_A}`,
      'onebot:',
      '  url: ws://127.0.0.1:39999',
      '  accessToken: shared-token',
      'trigger:',
      '  respondTo: 2',
      'chat:',
      '  enable: false',
      'ownerQQ: "10000009"',
      `botQQ: '${MAIN}'`,
      '',
    ].join('\n'),
    'utf8',
  );

  // 主号：走老路径；私有里把 respondTo 改成 3
  writeYaml(`${MAIN}.yml`, `name: 主号\nbotQQ: '${MAIN}'\nwebui:\n  port: ${PORT_A}\ntrigger:\n  respondTo: 3\n`);
  // 二号：自己的界面端口 + 私有 respondTo=1 + **故意往私有里塞一个共用段**
  //       （`llm.model` 必须被忽略，否则这个号会悄悄不跟随"模型页"）
  writeYaml(
    `${SECOND}.yml`,
    `name: 二号\nbotQQ: '${SECOND}'\nwebui:\n  port: ${PORT_B}\ntrigger:\n  respondTo: 1\nllm:\n  model: SHOULD-BE-IGNORED\n`,
  );

  writeFileSync(
    BOOT,
    `import { startWebUI } from '../src/webui.js';\nstartWebUI();\nsetInterval(() => {}, 60000);\n`,
    'utf8',
  );

  console.log('[1] 账号目录：增删改查');

  // 直接用 accounts.js 的纯函数层（不经过界面），先把文件层的规矩验掉
  const acc = await import('../src/accounts.js');
  check(acc.isValidId('1234567') === true, '合法 QQ 号认得出来');
  check(acc.isValidId('abc') === false, '非数字不认');
  check(acc.isValidId('../etc') === false, '带路径的不认（防目录穿越）');
  check(acc.isValidId('123') === false, '太短的不认');

  const ids0 = acc.ids();
  check(ids0.includes(MAIN) && ids0.includes(SECOND), '列出来的号就是目录里那两个');
  check(acc.displayName(MAIN) === '主号', '显示名读的是文件里的 name');

  // 复制：**不能**把 onebot / botQQ 带过去
  acc.create(THIRD, { name: '三号', copyFrom: SECOND, webuiPort: 39999 });
  const third = acc.read(THIRD) ?? {};
  check(third.botQQ === THIRD, '复制出来的新号，机器人 QQ 是它自己（不是被复制那个）');
  check(third.onebot === undefined, '复制**不含**协议端连接（带过去两个进程会抢同一个端口）');
  check(third.trigger?.respondTo === 1, '其它设置（灵敏度）确实复制过来了');
  check(acc.read(THIRD)?.name === '三号', '备注名是新号自己的，不是被复制那个的');

  let dup = '';
  try {
    acc.create(THIRD, {});
  } catch (e) {
    dup = e.message;
  }
  check(/已经有了/.test(dup), '同一个号加两次会被拒绝');

  const backup = acc.remove(THIRD);
  check(!acc.has(THIRD), '删号之后文件真的没了');
  check(backup && existsSync(backup), '删之前留了备份（误删能捞回来）');
  check(acc.read(THIRD) === null, '读一个不存在的号返回 null（不是抛错）');

  const freePort = await acc.allocatePort([PORT_A, PORT_B]);
  check(freePort > 0 && freePort !== PORT_A && freePort !== PORT_B, `端口分配会避开已占用的（分到 ${freePort}）`);

  console.log('\n[2] 起两个界面进程（主号 + 二号）');
  boot(MAIN, PORT_A);
  boot(SECOND, PORT_B);
  const upA = await waitUp(PORT_A);
  const upB = await waitUp(PORT_B);
  check(upA, `主号进程起来了（:${PORT_A}）`);
  check(upB, `二号进程起来了（:${PORT_B}）`);
  if (!upA || !upB) {
    for (const x of procs) console.log(x.out.split('\n').slice(-12).join('\n'));
    cleanup();
    console.log(`\n结果: ${failures} 项失败 ❌`);
    process.exit(1);
  }

  console.log('\n[3] 每个进程都知道"我是谁"');
  const whoA = await apiAt(PORT_A, '/api/whoami');
  const whoB = await apiAt(PORT_B, '/api/whoami');
  check(whoA.qq === MAIN && whoA.isMain === true, '主号进程报的是主号、而且知道自己是主号');
  check(whoB.qq === SECOND && whoB.isMain === false, '二号进程报的是二号、知道自己不是主号');
  check(whoA.port === PORT_A && whoB.port === PORT_B, '两个进程各在自己的界面端口上');

  console.log('\n[4] 配置分层：私有覆盖共用、共用段不认');
  const stateB = await apiAt(PORT_B, '/api/state');
  check(stateB.ok === true, '二号进程能返回自己的配置');
  check(stateB.config.trigger.respondTo === 1, '私有文件里的灵敏度（1）生效了 —— 覆盖了共用的 2');
  check(
    stateB.config.llm.model === 'shared-model',
    '私有文件里写的 llm.model 被**忽略**（否则这个号会悄悄不跟随"模型页"）',
  );
  const stateA = await apiAt(PORT_A, '/api/state');
  check(stateA.config.trigger.respondTo === 3, '主号的私有灵敏度（3）也生效');
  check(stateA.config.llm.model === 'shared-model', '两个号的大模型都是共用那份');

  console.log('\n[5] 转发：向主号进程要二号的配置');
  const viaA = await apiAt(PORT_A, '/api/state', { headers: { 'x-saki-account': SECOND } });
  check(viaA.ok === true, '带 x-saki-account 的请求被转发出去了');
  check(viaA.config.trigger.respondTo === 1, '拿回来的是**二号**的配置（转发真的到了二号那个进程）');
  const viaB = await apiAt(PORT_B, '/api/state', { headers: { 'x-saki-account': MAIN } });
  check(viaB.config.trigger.respondTo === 3, '反方向也通（二号进程能把请求转给主号）');
  const unknown = await apiAt(PORT_A, '/api/state', { headers: { 'x-saki-account': '10009999' } });
  check(unknown.offline === true || unknown.ok === false, '切到一个不存在的号 → 明确报"没在运行"，不是假装成功');

  console.log('\n[6] 界面上的号列表（含探活）');
  const list = await api('/api/accounts');
  check(list.ok === true, '号列表能读出来');
  const a1 = list.accounts.find((x) => x.qq === MAIN);
  const a2 = list.accounts.find((x) => x.qq === SECOND);
  check(a1 && a1.alive === true && a1.isMain === true, '主号在列表里、标成在跑、标成主号');
  check(a2 && a2.alive === true, '二号也在列表里、也在跑（探活是靠问它的 /api/whoami）');
  check(a2 && a2.port === PORT_B, '二号那一行显示的是它自己的界面端口');
  check(a2 && a2.persona === 'saki', '号列表带人设（界面上要显示每个号在演谁）');

  console.log('\n[7] 界面接口：改名 / 复制 / 删除');
  const ren = await post('/api/accounts', { action: 'rename', qq: SECOND, name: '二号改过名' });
  check(ren.ok === true && acc.displayName(SECOND) === '二号改过名', '改名落到了账号文件里');

  const cp = await post('/api/accounts', { action: 'copy', from: MAIN, to: SECOND });
  check(cp.ok === true, '把主号的设置复制给二号：接口返回成功');
  const after = acc.read(SECOND) ?? {};
  check(after.trigger?.respondTo === 3, '复制之后二号的灵敏度跟着主号变成 3');
  check(after.botQQ === SECOND, '复制**没有**改掉二号的机器人 QQ');
  check(after.onebot === undefined, '复制**没有**把协议端连接带过来');
  check(after.name === '二号改过名', '复制**没有**把备注名覆盖掉');

  const badCopy = await post('/api/accounts', { action: 'copy', from: SECOND, to: SECOND });
  check(badCopy.ok === false, '源和目标同一个号会被拒绝');

  const add = await post('/api/accounts', { action: 'create', qq: '10000004', name: '四号' });
  check(add.ok === true && acc.has('10000004'), '界面上能加新号');
  check(add.port >= 3100, `新号自动分到一个管理界面端口（${add.port}）`);
  const delMain = await post('/api/accounts', { action: 'remove', qq: MAIN });
  check(delMain.ok === false, '主号不许删（删了数据路径就乱了）');
  const del = await post('/api/accounts', { action: 'remove', qq: '10000004' });
  check(del.ok === true && !acc.has('10000004'), '非主号能删掉，而且留了备份');

  console.log('\n[8] 私有配置的写入：保存私有段不写进共用文件');
  const before = readFileSync(CFG, 'utf8');
  const saved = await apiAt(PORT_B, '/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-saki-account': SECOND },
    body: JSON.stringify({ chat: { enable: true, group: '999000001' } }),
  });
  check(saved.ok === true, '二号保存私有段：接口成功');
  const afterCfg = readFileSync(CFG, 'utf8');
  check(afterCfg === before, '共用 config 文件**一个字都没动**（私有段写进了账号文件）');
  const secFile = readFileSync(acc.fileOf(SECOND), 'utf8');
  check(/999000001/.test(secFile), '那个群号出现在**二号的私有文件**里');

  cleanup();
  console.log(
    failures === 0
      ? '\n结果: 全部通过 ✅'
      : `\n结果: ${failures} 项失败 ❌`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('套件自己崩了：', e);
  cleanup();
  console.log(`\n结果: 1 项失败 ❌`);
  process.exit(1);
});
