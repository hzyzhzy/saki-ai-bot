/**
 * 「服务器问题」关键词判定的套件（2026-10-04 加）。
 *
 * ## 为什么单开一个套件
 *   ⚠️⚠️ 这条断言**不能放进 `test/behavior.js`** —— 那个套件是 spawn 一个真进程来测的、
 *   **故意不 import `src/bot.js`**。我在它里面 `await import('../src/bot.js')` 之后，
 *   它自己的逻辑断言**集体失效**（实测：6 条「闲聊不接」全变成 40/40 都接）。
 *   ⇒ 所以另起一个进程来钉这件事。
 *
 * ## 现场（用户截图，群 200000006）
 *   群友发了一条游戏宣传文（带 steam 商店链接），关键词表里的 **`tps`**
 *   命中了 URL 里的 **`https`**（h-t-t-p-s 就含 "tps"）⇒ 被判成「服务器问题」⇒
 *   系统认为"这个问题她必须答" ⇒ 她主动插话答了一大段**她压根不知道**的事
 *   （「这个我还真说不准，宣传里写的是 2025 年蛇年上半年」…）。
 *   用户原话：「既没提到她、她也不知道怎么回答，这种**除了收紧度为 0 之外完全不应该出现**」。
 *
 * ⚠️ 纯离线：只读配置、不起进程、不碰真 QQ、不花钱。
 * 用法: node test/status-kw.js
 */
// ⚠️ 2026-10-07：配置**分家**之后 `config.yml` 只剩"共用"那半份 ——
//    服务器关键词表（`status.keywords`）属于**每个号私有**（`accounts/<QQ>.yml`），
//    所以不能再拿 `config.yml` 当配置源（那样读到的关键词是空的 ⇒ 断言全红）。
//    这一步把 `QQBOT_CONFIG` 指到"共用 + 主号私有"**合并后**的那份临时配置
//    （`QQBOT_CONFIG` 显式设过的话不动它 —— 那是有意的调试用法）。
await import('./_config-base.mjs');

const { Bot } = await import('../src/bot.js');

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const b = new Bot();

console.log('\n【1】★★ URL 里的 https 不许被当成 tps（中文关键词照旧）');
{
  check(b.shouldQueryStatus('现在几个人在线') === true, '正常的服务器问题照常命中');
  check(
    b.shouldQueryStatus('steam《黑巢》商店传送门：https://store.steampowered.com/app/2825330') ===
      false,
    '★★ 带 https 链接的宣传文**不再**被判成服务器问题（原来 `tps` 命中了 `https`）',
  );
  check(b.shouldQueryStatus('服务器 tps 多少') === true, '★ 真的问 tps 仍然命中（词边界匹配）');
  check(b.shouldQueryStatus('tps 多少') === true, '★ 句首的 tps 也命中');
  check(b.shouldQueryStatus('服务器卡不卡') === true, '★ 中文关键词不受影响');
  check(b.shouldQueryStatus('有人吗') === true, '★ 兜底正则（"有人吗"）没被改坏');
}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
