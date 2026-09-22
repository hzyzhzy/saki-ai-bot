/**
 * 「大模型出口」的自动识别与切换（2026-09-23 用户要求：「要能自动识别并切换」）。
 *
 * ## 踩到的真实故障
 *
 * `_run-bot.bat` 在**启动时**探 7890：通就设 `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY=…`
 * ⇒ **这个进程的所有 fetch 都走代理**。那次启动时 Clash 开着，**后来被关了**
 * ⇒ 机器人**一句话都回不出来**（全线 `ECONNREFUSED`），直到重启才自愈。
 *
 * ## 为什么原来那个"自动切换"是假的
 *
 * 老代码切换时只写 `egress = other` —— 只影响 `rawFetch` 自己传的 `dispatcher`。
 * 而 `NODE_USE_ENV_PROXY` 让 Node 的**全局** fetch 走它自己的 EnvHttpProxyAgent，
 * 我们换自己的 ProxyAgent **管不着它**：
 *   · 生图 / 搜索 / 余额这些走**普通 fetch** 的模块照样撞死；
 *   · 连 `rawFetch` 的"直连"分支（`fetch(url, opts)` 不传 dispatcher）
 *     也会落回那个已经死掉的全局代理。
 * ⇒ 修法：切换时**必须 `setGlobalDispatcher`**（选直连就装一个干净的 `Agent` 顶掉 env-proxy）。
 *
 * ⚠️ 真机验证（当时手工跑的，这里没法自动化）：把环境设成
 *    `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY=http://203.0.113.10`（7890 没人听），
 *    再 `import` 本模块 ⇒ 启动那句探测会把出口定成直连，
 *    之后 **`llmFetch` 和普通 `fetch` 都能拿到 401**（＝请求真的到得了上游）。
 *
 * 用法: node test/egress.js
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const src = readFileSync(join(ROOT, 'src', 'llm.js'), 'utf8');

console.log('\n【1】★★ 切换必须是**全局**的（否则生图/搜索那些普通 fetch 照样撞死）');
{
  check(/setGlobalDispatcher/.test(src), '★ 用了 `setGlobalDispatcher`（改全局 dispatcher）');
  check(
    /import \{ Agent, ProxyAgent, setGlobalDispatcher \} from 'undici'/.test(src),
    '★ `Agent` 和 `setGlobalDispatcher` 都从 undici 引进来了',
  );
  check(/function applyEgress\(/.test(src), '有 `applyEgress()`（改出口的唯一入口）');
  check(
    /setGlobalDispatcher\(mode === 'proxy' \? \(proxyAgent \?\?= new ProxyAgent\(PROXY_URL\)\) : \(directAgent \?\?= new Agent\(\)\)\)/.test(src),
    '★★ 选代理装 `ProxyAgent`、选直连装干净的 `Agent`（把启动期的 env-proxy 顶掉）',
  );
  check(/let directAgent = null/.test(src), '★ 直连那个 agent 缓存着（别每次新建）');
}

console.log('\n【2】★★ 所有改出口的地方都要走 `applyEgress`（别只赋 `egress`）');
{
  // 只赋 egress 的写法一处都不许留 —— 那次"假切换"就是这么来的
  const bare = src.match(/(?<!apply)\begress = (?!'unknown'|mode)/g) || [];
  check(bare.length <= 1, '★ 没有"只赋 `egress` 不换全局"的地方', `剩 ${bare.length} 处`);
  check(/if \(egress === 'unknown'\) applyEgress\(/.test(src), '★ `llmFetch` 里初次判定走 `applyEgress`');
  check(/applyEgress\(other\)/.test(src), '★★ 失败后换出口重试也走 `applyEgress`（那次假切换的修复点）');
  check(!/^\s*egress = other;$/m.test(src), '★ 老的 `egress = other;` 已经不在了');
}

console.log('\n【3】★ 启动时就定好出口 + 定期体检（用户：「自动识别并切换」）');
{
  check(/启动时就把出口定下来/.test(src), '★ 注释里写清了为什么不能等第一个请求');
  check(/if \(egress !== 'unknown'\) return;\s*\n\s*applyEgress\(\(await proxyAlive\(true\)\)/.test(src),
    '★ 模块加载时**立刻探一次**（不等第一个请求 —— 否则生图会先撞上死代理）');
  check(/EGRESS_WATCH_MS/.test(src) && /setInterval/.test(src), '★ 有定期体检（代理中途被关掉也能自愈）');
  check(/egressWatch\.unref\?\.\(\)/.test(src), '★★ 定时器 `unref()` 了 —— 不然 `test/*` 的进程会被吊着不退出');
  check(/egress === 'proxy' && !\(await proxyAlive\(true\)\)/.test(src), '★ 只在"当前是代理且代理已死"时切直连');
}

console.log('\n【4】★ 别把另一个方向弄坏（直连不通时仍会试代理）');
{
  check(/const other = first === 'proxy' \? 'direct' : 'proxy'/.test(src), '★ 双向都会试另一个出口');
  check(/other === 'proxy' && !\(await proxyAlive\(true\)\)/.test(src), '★ 代理本来就不通时别白试一遍');
  check(/isNetErr\(e\)/.test(src), '★ 只对**网络类**错误切换（402/401 那些业务错误原样抛）');
}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
