/**
 * 中转站余额适配的回归（2026-10-06 加）。
 *
 * ## 用户原话
 *   「**群友用的中转站的 api，给中转站的余额接入适配一下**」
 *
 * ## 背景
 *   余额 = 小祥的「工资」，原来 `fetchBalance()` **写死了 DeepSeek 的 `/user/balance`**。
 *   群友把 `llm.baseURL` 换成中转站（new-api / one-api 那一类）之后，那个接口根本不存在
 *   ⇒ 余额**永远查不出来**，「工资」一直停在旧数字。
 *
 * ## 这个套件盯五件事
 *   ① `provider: deepseek` 的**老行为一字不变**（老用户的配置不用动）；
 *   ② 三种中转站接口各自解析对：new-api 的 `quota`（÷500000 美元）、
 *      OpenAI 式的 `hard_limit_usd − total_usage÷100`、自定义路径；
 *   ③ ★ `auto` 能在「DeepSeek 接口不存在」时**自动换到中转站的接口**（这是群友最需要的）；
 *   ④ ★ `auto` 在**没配面板令牌**时不去撞 newapi（sk- key 打它必 401），
 *      而是继续往下试 `openai-billing`；
 *   ⑤ 全都失败 / provider 名字写错时，**报错要说人话**（把试过什么都列出来），
 *      不许静默返回一个假余额 —— 那会让她在群里报错数。
 *
 * ⚠️ 纯离线：假服务器起在本进程（127.0.0.1:39094），不碰真模型、不花钱。
 * ⚠️ **必须单独一个进程 + 自己的配置**：`config.js` 在**启动时**读 `QQBOT_CONFIG`，
 *    而静态 `import` 会被提升到最前面 ⇒ 那时 env 还没设，就会读到**真实的 config.yml**
 *    （拿真 key 去打真接口）。所以下面全部用 `await import()`。
 * 用法: node test/balance-provider.js
 */
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

// ⚠️ 必须在 import src/* 之前设好（config.js 是加载时读的）
process.env.QQBOT_CONFIG = 'config.balance-test.yml';
process.env.QQBOT_BALANCE_FILE = 'logs/__test-balance-provider.json';

const PORT = 39094;
/**
 * 假中转站：按路径分发，`mode` 控制"这家站有没有这个接口"。
 * ⚠️ 余额查询是**非流式 GET + res.json()**，这里回整块 JSON 就对了。
 */
let mode = 'deepseek'; // deepseek | newapi | billing | custom | none
let hits = [];
const server = createServer((req, res) => {
  const u = req.url ?? '';
  hits.push(u);
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const has = (name) => mode === name || mode === 'all';
  if (u.startsWith('/user/balance')) {
    if (!has('deepseek')) return send(404, { error: 'not found' });
    return send(200, {
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '42.50', granted_balance: '0' }],
    });
  }
  if (u.startsWith('/api/user/self')) {
    if (!has('newapi')) return send(404, { error: 'not found' });
    // ⚠️ new-api 的额度单位：500000 = 1 美元 ⇒ 2500000 就是 5 美元
    return send(200, { success: true, data: { quota: 2500000, used_quota: 100 } });
  }
  if (u.startsWith('/dashboard/billing/subscription')) {
    if (!has('billing')) return send(404, { error: 'not found' });
    return send(200, { hard_limit_usd: 10, soft_limit_usd: 8 });
  }
  if (u.startsWith('/dashboard/billing/usage')) {
    if (!has('billing')) return send(404, { error: 'not found' });
    // ⚠️ `total_usage` 的单位是**美分** ⇒ 250 = 2.5 美元 ⇒ 余额 10 − 2.5 = 7.5
    return send(200, { total_usage: 250 });
  }
  if (u.startsWith('/weird/balance')) {
    if (!has('custom')) return send(404, { error: 'not found' });
    return send(200, { result: { amount: { left: 3600 } } });
  }
  return send(404, { error: 'not found' });
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const { config, ROOT } = await import('../src/config.js');
const balance = await import('../src/balance.js');

const BAL_FILE = join(ROOT, 'logs', '__test-balance-provider.json');
const clearState = () => rmSync(BAL_FILE, { force: true });
/** 把配置改成这个用例要的样子（`config` 是普通对象，改属性立刻生效） */
function setCfg(o = {}) {
  config.llm.baseURL = `http://127.0.0.1:${PORT}/v1`;
  config.llm.apiKey = 'sk-test-fake-key';
  Object.assign(config.balance, {
    enable: true,
    provider: 'auto',
    url: '',
    token: '',
    path: '',
    divide: 1,
    currency: '',
    timeoutMs: 3000,
  });
  Object.assign(config.balance, o);
  clearState();
  hits = [];
}

// ── 【1】deepseek：老行为一字不变 ────────────────────────────
console.log('\n【1】provider=deepseek（官方老行为，老用户配置不用动）');
{
  setCfg({ provider: 'deepseek' });
  mode = 'deepseek';
  const r = await balance.fetchBalance();
  check(r.ok === true, '查到了', JSON.stringify(r));
  check(r.total === 42.5, `余额 42.5（实际 ${r.total}）`);
  check(r.currency === 'CNY', `币种跟返回走 = CNY（实际 ${r.currency}）`);
  check(r.via === 'deepseek', 'via 标了是哪个 provider');
  check(balance.lastBalance()?.balance === 42.5, '落进了 state（后面提醒档位要用）');
}

// ── 【2】newapi：quota ÷ 500000 ──────────────────────────────
console.log('\n【2】provider=newapi（new-api / one-api 面板）');
{
  setCfg({ provider: 'newapi', token: 'panel-token-abc' });
  mode = 'newapi';
  const r = await balance.fetchBalance();
  check(r.ok === true, '查到了', JSON.stringify(r));
  // 2500000 ÷ 500000 = 5 美元
  check(r.total === 5, `2500000 quota → 5 美元（实际 ${r.total}）`);
  check(r.currency === 'USD', `币种 = USD（实际 ${r.currency}）`);
  check(hits.some((u) => u.startsWith('/api/user/self')), '打的是 /api/user/self');
}

// ── 【3】openai-billing：订阅 − 用量 ────────────────────────
console.log('\n【3】provider=openai-billing（很多中转站兼容的那套）');
{
  setCfg({ provider: 'openai-billing' });
  mode = 'billing';
  const r = await balance.fetchBalance();
  check(r.ok === true, '查到了', JSON.stringify(r));
  // 10 美元额度 − 250 美分(2.5 美元) = 7.5
  check(r.total === 7.5, `10 − 2.5 = 7.5（实际 ${r.total}）`);
  check(
    hits.some((u) => u.includes('/dashboard/billing/usage?start_date=')),
    '用量接口带了日期区间（不带会被很多站拒）',
  );
}

// ── 【4】custom：自定义地址 + 点分路径 + 除数 ────────────────
console.log('\n【4】provider=custom（自己填 url / path / divide）');
{
  setCfg({
    provider: 'custom',
    url: `http://127.0.0.1:${PORT}/weird/balance`,
    path: 'result.amount.left',
    divide: 100,
    currency: 'CNY',
  });
  mode = 'custom';
  const r = await balance.fetchBalance();
  check(r.ok === true, '查到了', JSON.stringify(r));
  check(r.total === 36, `3600 ÷ 100 = 36（实际 ${r.total}）`);
  check(r.currency === 'CNY', 'currency 配置能强制覆盖');
}

// ── 【5】★★ auto：DeepSeek 接口不存在 → 自动换中转站的 ──────
console.log('\n【5】★ auto 自动识别（群友把 baseURL 换成中转站之后最需要的那条）');
{
  setCfg({ provider: 'auto', token: 'panel-token-abc' });
  mode = 'newapi'; // 这家没有 /user/balance，只有面板接口
  const r = await balance.fetchBalance();
  check(r.ok === true, '★ 自动换到能用的那家', JSON.stringify(r));
  check(r.via === 'newapi', `via = newapi（实际 ${r.via}）`);
  check(r.total === 5, '数也对（5 美元）');
  check(
    hits.some((u) => u.startsWith('/user/balance')),
    '确实先试了 DeepSeek 那个（说明是"试出来的"，不是写死的）',
  );
}
{
  // ★ 没配面板令牌 ⇒ 不去撞 newapi（sk- key 打它必 401），直接试 openai-billing
  setCfg({ provider: 'auto' }); // token 留空 = 沿用 llm.apiKey（sk- 假 key）
  mode = 'billing';
  const r = await balance.fetchBalance();
  check(r.ok === true, '★ 没面板令牌时换用 openai-billing', JSON.stringify(r));
  check(r.via === 'openai-billing', `via = openai-billing（实际 ${r.via}）`);
  check(!hits.some((u) => u.startsWith('/api/user/self')), '★★ 一次都没去打 /api/user/self');
}

// ── 【6】全失败 → 报错要说人话，不许编个假余额 ───────────────
console.log('\n【6】所有接口都不对 → 明确报错（不许静默给个假数）');
{
  setCfg({ provider: 'auto', token: 'panel-token-abc' });
  mode = 'none';
  const r = await balance.fetchBalance();
  check(r.ok === false, '报失败（而不是 ok:true 配一个瞎编的数）');
  check(/都试过了/.test(r.error ?? ''), '错误里说清了"都试过"', r.error);
  check(/deepseek/.test(r.error ?? '') && /newapi/.test(r.error ?? ''), '把试过哪几家列出来了');
}
{
  setCfg({ provider: '不存在的名字' });
  const r = await balance.fetchBalance();
  check(r.ok === false && /不认识/.test(r.error ?? ''), 'provider 写错 → 明确说不认识', r.error);
}

// ── 【7】没配 key → 别去撞 401 ──────────────────────────────
console.log('\n【7】没配 apiKey → 直接说清楚，不去撞 401');
{
  setCfg({ provider: 'auto' });
  config.llm.apiKey = '';
  mode = 'all';
  const r = await balance.fetchBalance();
  check(r.ok === false && /apiKey/.test(r.error ?? ''), '报"没配 apiKey"', r.error);
  check(hits.length === 0, '★ 一个请求都没发出去');
}

// ── 收尾 ───────────────────────────────────────────────────
server.close();
try {
  clearState();
} catch {}

console.log(
  `\n结果: ${failures === 0 ? '全部通过 ✅（官方 / new-api / OpenAI 式 / 自定义四路都能查，auto 会自己认）' : `${failures} 项失败 ❌`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
