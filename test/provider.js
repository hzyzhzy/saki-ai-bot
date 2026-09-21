/**
 * 协议端适配层的回归（2026-09-17 加）。
 *
 * ## 为什么要盯这个
 *   用户要求「能换协议端」—— 换的时候**最怕两件事**：
 *     ① 换了之后**收发失效**（那才是要命：机器人变哑巴）；
 *     ② 管理界面**装作还能出码/重启**，用户点了半天没反应。
 *   所以这个套件盯的就是这两条：
 *     · 收发参数（`onebot.url` / token）**不受 provider 影响**；
 *     · 不支持的能力**明确返回"不支持"，并告诉用户去哪儿做**。
 *
 * ## 它怎么测
 *   ① 用三个不同的 `QQBOT_CONFIG` 各起一个**子进程探针**，读真实的 `provider.info()` 与
 *      `napcat-recover.onSendFail()` 的返回值 —— 这样测的是真逻辑，不是抄一遍常量。
 *   ② 再起一个真的机器人进程（配置里 `provider.name = llonebot`），
 *      打它的管理接口，确认"不支持的能力"是被**优雅拒绝**而不是抛异常。
 *
 * ⚠️ 纯离线：不连真 NapCat（OneBot 地址指向死端口）。**不碰真 QQ、不花钱。**
 * 用法: node test/provider.js
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 39703;
const BASE = `http://203.0.113.10:${PORT}`;
const PROBE = join(ROOT, 'logs', '__provider-probe.mjs');

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const realCfg = readFileSync(join(ROOT, 'config.yml'), 'utf8');

/**
 * 造一份临时配置：把 provider 段换成要测的那份（其余照抄真实配置，保证参数真实）。
 * ⚠️ 返回的是**相对 ROOT 的路径** —— `config.js` 是按 ROOT 解析 `QQBOT_CONFIG` 的，
 *    传绝对路径会被拼成 `ROOT\C:\...` 直接报「找不到配置文件」（我第一版就踩了）。
 */
function makeConfig(name, relFile, extra = '') {
  const base = realCfg
    .replace(/\n# ── QQ 协议端[\s\S]*?(?=\nlogLevel:)/, '')
    .replace(/\nprovider:\n(?:[ \t]+.*\n)*/, '\n');
  const injected = `\nprovider:\n  name: ${name}\n${extra}`;
  writeFileSync(join(ROOT, relFile), base.replace(/\nlogLevel: info/, `${injected}logLevel: info`), 'utf8');
  return relFile;
}

const drop = (rel) => rmSync(join(ROOT, rel), { force: true });

/** 探针脚本：在**子进程**里 import 真模块，把结论打成 JSON（避免 ESM 单例缓存的问题） */
function writeProbe() {
  writeFileSync(
    PROBE,
    `import * as provider from '../src/provider.js';
import { config } from '../src/config.js';
import * as recover from '../src/napcat-recover.js';
const info = provider.info();
console.log(JSON.stringify({
  name: provider.name(),
  label: info.label,
  caps: info.caps,
  dir: info.dir,
  launcher: info.launcher,
  launcherExists: info.launcherExists,
  manageUrl: info.manageUrl,
  onebotUrl: info.onebot.url,
  tokenSet: info.onebot.tokenSet,
  nameRaw: config.provider.nameRaw,
  canQrcode: provider.can('qrcode'),
  canRestart: provider.can('restart'),
  canLaunch: provider.can('launch'),
  unsupportedQrcode: provider.unsupported('qrcode'),
  unsupportedRestart: provider.unsupported('restart'),
  recover: recover.onSendFail(1),
}));
`,
    'utf8',
  );
}

/** 跑一次探针，拿它打印的 JSON */
function probe(cfgFile) {
  const r = spawnSync(process.execPath, [PROBE], {
    cwd: ROOT,
    env: { ...process.env, QQBOT_CONFIG: cfgFile, QQBOT_NAPCAT_REQ_FILE: 'logs/__provider-req.json' },
    encoding: 'utf8',
  });
  const line = String(r.stdout || '')
    .split('\n')
    .reverse()
    .find((l) => l.trim().startsWith('{'));
  if (!line) throw new Error(`探针没输出 JSON：${r.stdout}\n${r.stderr}`);
  return JSON.parse(line);
}

async function main() {
  writeProbe(); // ⚠️ 别忘了这一句：探针脚本是子进程要跑的（第一次我就漏了，报 MODULE_NOT_FOUND）

  console.log('\n【1】默认（配置里不写 provider）= NapCat，行为和以前一样');
  {
    const cfg = makeConfig('napcat', 'config.provider-napcat-test.yml');
    const p = probe(cfg);
    check(p.name === 'napcat', '默认就是 napcat', p.name);
    check(p.caps.status === true && p.caps.qrcode === true && p.caps.restart === true, '管理能力全开（出码/重启/状态）', JSON.stringify(p.caps));
    check(/napcat[\\/]NapCat\.Shell$/i.test(p.dir), '默认目录指向 ../napcat/NapCat.Shell', p.dir);
    check(/launcher-win10-user\.bat$/i.test(p.launcher), '默认启动器是 launcher-win10-user.bat', p.launcher);
    check(p.manageUrl.includes('6099'), '默认管理界面是 6099', p.manageUrl);
    check(p.recover.requested === false || typeof p.recover.requested === 'boolean', 'napcat 下自愈逻辑照旧可用', JSON.stringify(p.recover));
    drop(cfg);
  }

  console.log('\n【2】★ 换 LLBot：能力必须如实缩水，而不是装作能用');
  {
    const cfg = makeConfig('llonebot', 'config.provider-llbot-test.yml');
    const p = probe(cfg);
    check(p.name === 'llonebot', 'provider.name 读到了', p.name);
    // ⚠️ 2026-09-20 改：LLBot 现在**支持**出码/刷码（`src/llbot.js` 读它自己写的那张
    //    `login-qrcode.png` —— 用户要求「二维码要和之前一样能在 webui 自动刷新」）。
    //    所以原来那句「出码/重启/快速登录 都标成不支持」已经不对了。
    //    **仍然必须如实是 false** 的是：重启、快速登录、假在线自愈。
    check(
      p.caps.qrcode === true && p.caps.refreshQr === true && p.caps.status === true,
      '★ LLBot 支持：看状态 / 出码 / 刷码',
      JSON.stringify(p.caps),
    );
    check(
      p.caps.restart === false && p.caps.quickLogin === false && p.caps.autoRecover === false,
      '★ LLBot 不支持：重启 / 快速登录 / 假在线自愈（都如实为 false）',
      JSON.stringify(p.caps),
    );
    check(p.canQrcode === true && p.canRestart === false, '★ can()：出码 true、重启 false（界面据此禁按钮）');
    check(/LLBot/.test(p.unsupportedQrcode) && /管理界面/.test(p.unsupportedQrcode), '★ 拒绝文案里指明了"去哪儿做"', p.unsupportedQrcode);
    check(p.recover.requested === false && /不是 NapCat/.test(p.recover.reason), '★ 非 NapCat 时不写"重启请求"条子（别误导看门狗）', p.recover.reason);
    check(p.canLaunch === false, '没配 launcher → 不能说"能从这边启动"');
    drop(cfg);
  }

  console.log('\n【3】★ 收发参数不受协议端影响（换谁都得能收发）');
  {
    const cfgN = makeConfig('napcat', 'config.provider-a.yml');
    const cfgL = makeConfig('llonebot', 'config.provider-b.yml');
    const a = probe(cfgN);
    const b = probe(cfgL);
    check(a.onebotUrl === b.onebotUrl && a.onebotUrl.startsWith('ws://'), '★ 两个协议端读到的是**同一个** onebot.url', a.onebotUrl);
    check(a.tokenSet === b.tokenSet, 'token 有没有配也一致（收发参数与协议端无关）');
    unlinkSync(cfgN);
    unlinkSync(cfgL);
  }

  console.log('\n【4】provider 名字写错 → 退回通用实现，但不能把机器人搞挂');
  {
    const cfg = makeConfig('napct', 'config.provider-typo-test.yml');
    const p = probe(cfg);
    check(p.name === 'onebot', '不认识的名字 → 归一化成 onebot', p.name);
    check(p.nameRaw === 'napct', '原始值留着（便于排查）', p.nameRaw);
    check(p.label.includes('通用'), '界面显示"通用 OneBot 11 实现"', p.label);
    drop(cfg);
  }

  console.log('\n【5】自定义 dir / launcher / manageUrl 能被解析');
  {
    const cfg = makeConfig(
      'llonebot',
      'config.provider-custom-test.yml',
      "  dir: logs\n  launcher: __provider-probe.mjs\n  manageUrl: http://203.0.113.10\n",
    );
    const p = probe(cfg);
    check(/logs[\\/]__provider-probe\.mjs$/.test(p.launcher), 'launcher 相对 dir 解析成绝对路径', p.launcher);
    check(p.launcherExists === true, '★ 文件真存在 → can("launch") 才算支持', String(p.launcherExists));
    check(p.canLaunch === true, 'can("launch") 随文件存在与否变化');
    check(p.manageUrl === 'http://203.0.113.10', 'manageUrl 用配置里的', p.manageUrl);
    drop(cfg);
  }

  console.log('\n【6】★ 真起一个机器人（provider=llonebot），管理接口必须优雅拒绝');
  {
    const cfg = makeConfig('llonebot', 'config.provider-bot-test.yml');
    // 管理界面换端口 + OneBot 指向死端口（绝不碰真 NapCat 的唯一连接）
    const txt = readFileSync(cfg, 'utf8')
      .replace(/port:\s*3099/, `port: ${PORT}`)
      .replace(/url:\s*ws:\/\/127\.0\.0\.1:\d+/, 'url: ws://203.0.113.10');
    writeFileSync(cfg, txt, 'utf8');

    const proc = spawn(process.execPath, ['src/index.js'], {
      cwd: ROOT,
      env: { ...process.env, QQBOT_CONFIG: 'config.provider-bot-test.yml', QQBOT_NAPCAT_REQ_FILE: 'logs/__provider-req2.json' },
      stdio: 'ignore',
    });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      await sleep(250);
      try {
        const r = await fetch(`${BASE}/api/state`);
        up = r.ok;
      } catch {}
    }
    check(up, '机器人起来了（管理界面可访问）');
    if (up) {
      const st = await (await fetch(`${BASE}/api/qq/status`)).json();
      check(st.provider?.name === 'llonebot', '★ 状态接口报出了协议端', st.provider?.name);
      // ⚠️ 2026-09-20 改：LLBot 现在支持出码 → qrcode 该是 true；**重启**仍如实 false。
      //    （这条断言的本意是"能力不许吹牛"，所以两半都要查。）
      check(
        st.provider?.caps?.qrcode === true && st.provider?.caps?.restart === false,
        '★ 状态接口里能力如实（出码 true / 重启 false）',
        JSON.stringify(st.provider?.caps),
      );
      check(/LLBot/.test(JSON.stringify(st)), '状态里带上了协议端说明（界面显示用）');

      const qr = await fetch(`${BASE}/api/qq/qrcode.png?fresh=1`);
      const qrj = await qr.json().catch(() => ({}));
      // ⚠️ 2026-09-20 改：原来断言"409（不支持出码）"。LLBot 现在支持出码，它会去读那张
      //    `login-qrcode.png`：码旧了（多半说明登录着）→ 409「QQ 已经登录了，不需要扫码」；
      //    码很新（它正在等扫码）→ 200 + 那张原图。
      //    所以这里只断言**不打 500、而且给的理由清楚** —— 两种环境都成立。
      check(qr.status !== 500, '★ 出码接口：不打 500（不假装成功、也不炸）', String(qr.status));
      check(
        qr.status !== 409 || /已经登录/.test(qrj.error || ''),
        '★ 409 时理由是「已经登录了，不需要扫码」',
        qrj.error ?? `（HTTP ${qr.status}，返回的是图）`,
      );

      const rs = await (await fetch(`${BASE}/api/qq/restart`, { method: 'POST' })).json();
      check(rs.ok === false, '★ 重启接口：ok=false（没配 launcher 就不吹牛）', JSON.stringify(rs));
      const rc = await (await fetch(`${BASE}/api/qq/recover`, { method: 'POST' })).json();
      check(rc.recovered === false && /LLBot/.test(rc.message || ''), '★ 一键恢复：明确说这个协议端不适用', rc.message);
      const rq = await (await fetch(`${BASE}/api/qq/refresh-qr`, { method: 'POST' })).json();
      // ⚠️ 2026-09-20 改（**这条断言抓出过一个真 bug**）：LLBot 现在支持"重新出码"
      //    （它每约 2 分钟自己轮换一张，我们只如实报告）→ 不再是"明确拒绝"。
      //    但它**必须走 LLBot 那条路** —— 修之前这条路由硬编码 `napcat`，
      //    返回的是 `fetch failed`（跑去调 NapCat 的 6099 了）。
      //    ⚠️ 所以断言里**必须带 `!/fetch failed/`**，别再让这个 bug 溜过去。
      check(
        rq.ok === true && /LLBot/.test(rq.message || '') && !/fetch failed/.test(rq.message || ''),
        '★ 重新出码：走 LLBot 那条路（不许跑去调 NapCat 报 fetch failed）',
        rq.message,
      );
    }
    proc.kill();
    await sleep(400);
    drop(cfg);
  }

  try {
    if (existsSync(PROBE)) unlinkSync(PROBE);
    rmSync(join(ROOT, 'logs', '__provider-req.json'), { force: true });
    rmSync(join(ROOT, 'logs', '__provider-req2.json'), { force: true });
  } catch {}

  // ─────────────────────────────────────────────────────────────────
  console.log('\n★ 启动脚本要认得「当前协议端」的连接日志（2026-09-21 修）');
  //
  // ⚠️ 用户截图报的：看门狗窗口一直刷「机器人未在 30 秒内连上」，但机器人其实好好的。
  //    根因：`watchdog.ps1` 找的字符串是 `已连接到 NapCat`，而协议端换成 SnowLuma 之后
  //    日志写的是 `已连接到协议端（snowluma），等待消息…` ⇒ **永远匹配不上**
  //    （每次启动白等 30 秒，还误导排查）。
  //    ⚠️ 同一个错在**三处**都有：`watchdog.ps1` / `start-all.ps1` / `启动机器人（后台）.bat`。
  //    ⚠️ 所以这里不是"看一眼字符串"，而是**把 pattern 从源码里抽出来真跑一遍**：
  //       它必须同时认新日志（当前协议端）和旧日志（别人还在用 NapCat）。
  {
    const sampleNew = '已连接到协议端（snowluma），等待消息…';
    const sampleOld = '已连接到 NapCat，等待消息…';
    for (const f of ['watchdog.ps1', 'start-all.ps1']) {
      const m = /Pattern '([^']*已连接到[^']*)'/.exec(readFileSync(join(ROOT, f), 'utf8'));
      check(!!m, `★ ${f}：抽到它判断"连上没连上"用的 pattern`, m ? m[1] : '(没抽到)');
      if (!m) continue;
      check(new RegExp(m[1]).test(sampleNew), `★ ${f} 认得当前协议端的日志（换协议端不再误报）`);
      check(new RegExp(m[1]).test(sampleOld), `　${f} 也认旧 NapCat 的日志（别人还在用）`);
    }
    const bat = readFileSync(join(ROOT, '启动机器人（后台）.bat'), 'utf8');
    const line = (bat.split(/\r?\n/).find((l) => /findstr/.test(l) && /已连接到/.test(l)) ?? '').trim();
    check(!!line, '★ 启动机器人（后台）.bat 里那条 findstr 还在', line);
    // ⚠️ 这条正则要求 `已连接到` 后面**紧跟引号** —— 所以写回 `已连接到 NapCat` 就会红
    check(/findstr \/C:"已连接到"/.test(line), '★ 它找的是通用那句（不再只认 NapCat）', line);
  }

  console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
