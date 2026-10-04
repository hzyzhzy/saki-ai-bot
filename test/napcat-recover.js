/**
 * 「通道假在线」自救（`src/napcat-recover.js`）回归 —— 纯离线。
 *
 * 用户要求（2026-09-15）：「下次回 1200 应该自动重启」。
 *
 * ⚠️ 这里验的是**机器人的那一半**：数连续失败、到了阈值留条子、节流、成功后归零。
 *    「看到条子真去重启」那一半在 `watchdog.ps1` 里 —— 那部分只能用结构性断言看着
 *    （真去启动 QQ 显然不能在回归里做）。
 */
import { writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CFG = 'logs/__test-recov-cfg.yml';
const REQ = 'logs/__test-recov.request';

writeFileSync(
  join(ROOT, CFG),
  [
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
    '  apiKey: "sk-test"',
    '  model: t',
    'napcatRecover:',
    '  enable: true',
    '  failThreshold: 3',
    '  throttleMs: 600000', // 10 分钟，好测节流
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG;
process.env.QQBOT_NAPCAT_REQ_FILE = REQ;

const recov = await import('../src/napcat-recover.js');
const { config } = await import('../src/config.js');

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}`);
  if (!ok) failures++;
};
const REQ_ABS = join(ROOT, REQ);
const T0 = 1789000000000;
const reset = () => {
  recov.__clear();
  config.napcatRecover.enable = true;
};

// ─────────────────────────────────────────────────────────────
console.log('\n【1】连续失败到阈值才留条子（偶尔一次不算）');
{
  reset();
  check(!existsSync(REQ_ABS), '一开始没有条子');
  check(recov.onSendFail(T0).requested === false, '第 1 次失败：不留（阈值 3）');
  check(recov.onSendFail(T0 + 1000).requested === false, '第 2 次：还不留');
  const r3 = recov.onSendFail(T0 + 2000);
  check(r3.requested === true, '★★ 第 3 次：**留条子了**（连续 3 次 = 通道真断了）');
  check(existsSync(REQ_ABS), '★ 文件真的写出来了');
  const j = JSON.parse(readFileSync(REQ_ABS, 'utf8'));
  check(j.streak === 3, `条子里记了连续次数（${j.streak}）`);
  check(/1200/.test(String(j.reason)), '条子里写清了原因（1200）');
}

console.log('\n【2】成功一次就归零（别把"偶尔卡一下"当成断了）');
{
  reset();
  recov.onSendFail(T0);
  recov.onSendFail(T0 + 1000);
  recov.onSendOk();
  check(recov.status().streak === 0, '★ 成功之后 streak 归零');
  check(recov.onSendFail(T0 + 2000).requested === false, '★ 再失败一次也不留（重新数）');
}

console.log('\n【3】节流：10 分钟内不许重复留条子（重启 = 一次登录，别喂风控）');
{
  reset();
  for (let i = 0; i < 3; i++) recov.onSendFail(T0 + i * 1000);
  check(recov.status().pending === true, '第一次留上了');
  recov.__set({ lastRequestAt: T0 + 2000 });
  const again = recov.onSendFail(T0 + 3000);
  check(again.requested === false, '★ 紧接着又失败 → **不再留条子**');
  check(/刚求过/.test(again.reason), `理由说清了是节流（${again.reason}）`);
  // 过了节流窗口就允许再求
  const later = recov.onSendFail(T0 + 20 * 60 * 1000);
  check(later.requested === true, '★ 过了 10 分钟 → 可以再求一次');
}

console.log('\n【4】总开关：关了就不留条子');
{
  reset();
  config.napcatRecover.enable = false;
  for (let i = 0; i < 5; i++) recov.onSendFail(T0 + i * 1000);
  check(!existsSync(REQ_ABS), '★ 关着 → 一条都不留');
  check(recov.status().enable === false, 'status 也说关着');
  config.napcatRecover.enable = true;
}

console.log('\n【5】★ 接线：机器人真在数失败、看门狗真会看到条子');
{
  const botSrc = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const wd = readFileSync(join(ROOT, 'watchdog.ps1'), 'utf8');

  // 机器人侧
  check(/napcatRecover\.onSendFail\(\)/.test(botSrc), '★★ 1200 那条路上调了 `onSendFail`');
  check(/napcatRecover\.onSendOk\(\)/.test(botSrc), '★ 发送成功时调了 `onSendOk`（归零）');
  // ⚠️ 必须在 1200 分支里 —— 别的地方没有这个判据
  const i1200 = botSrc.indexOf('payload.retcode === 1200');
  check(i1200 > 0, '找得到 1200 那段');
  const seg = botSrc.slice(i1200, i1200 + 1600);
  check(/napcatRecover\.onSendFail/.test(seg), '★★ 而且就在 1200 分支里（不是别处）');

  // 看门狗侧
  check(/napcat-restart\.request/.test(wd), '★★ 看门狗会看 `state/napcat-restart.request`');
  check(/Test-QQOnline/.test(wd.slice(wd.indexOf('napcat-restart.request'), wd.indexOf('napcat-restart.request') + 2200)),
    '★ 重启前**先查快登凭据**（没了就不重启，只能扫码）');
  check(/lastFakeOnlineRestart/.test(wd), '★ 有 10 分钟节流，别反复重启');
  check(/Start-NapCat \| Out-Null/.test(wd.slice(wd.indexOf('napcat-restart.request'), wd.indexOf('napcat-restart.request') + 2200)),
    '★ 条件满足时真的调 `Start-NapCat`');
}

try {
  rmSync(join(ROOT, CFG), { force: true });
  rmSync(REQ_ABS, { force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
