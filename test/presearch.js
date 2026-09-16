/**
 * 预搜索「极短消息不搜」的判定测试（离线，不调模型、不联网）。
 *
 * 来源（2026-09-13 用户截图）：
 *   群友：「喵」
 *   机器人：「嗯，等下，我瞅瞅」  ← 过渡话（说明它去"查"了）
 *   机器人：「喵什么喵」
 *   —— 一个字的拟声词**触发了一次联网搜索**，白等 3~15 秒。
 *   本来该直接回「喵什么喵」。
 *
 * ⚠️ 这条规则是**确定性**的（字数 + 有没有疑问词），所以能离线测。
 *
 * 用法: node test/presearch.js
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.QQBOT_CONFIG ??= 'config.test.yml';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const { preSearch } = await import('../src/search-presearch.js');

/**
 * 跑一次预搜索并返回「有没有去搜」。
 *
 * ⚠️ 这里**不断言"为什么没搜"** —— 可能是"极短消息"，也可能是"内部话题"，
 *    只要**没去真搜**就算对（那才是我们要的行为）。
 *    而且这些断言**都不该触发模型调用**（所以离线可测、飞快）。
 */
const didSearch = async (text) => {
  const r = await preSearch(text, '');
  return { searched: !!r.searched, why: r.why ?? '' };
};

console.log('\n【1】★ 极短消息不该触发联网搜索');
{
  // 截图里那条 + 同类（拟声词/情绪词/单字）
  const shouldNotSearch = [
    '喵',
    '喵喵',
    '草',
    '草草草',
    '啊这',
    '6',
    '哈哈',
    '嗯嗯',
    '哦',
    '？',
    '...',
    '笑死',
    '搜嘎',
  ];
  for (const t of shouldNotSearch) {
    const r = await didSearch(t);
    check(!r.searched, `「${t}」不搜`, r.why);
  }
}

console.log('\n【2】但**有疑问词**的短消息还是要搜（别一刀切）');
{
  // 这些虽然短，但有明确的"想查"的意图 —— 不能拦
  const shouldSearch = ['这什么梗', '原神是啥', '咋回事', '梦限大是啥'];
  for (const t of shouldSearch) {
    const r = await didSearch(t);
    // ⚠️ 这里只断言"**没被极短消息闸门拦掉**" —— 它可能因为别的原因不搜
    //    （比如知识库里有、或者被 looksInternal 判成内部话题），
    //    但不能是因为"太短"。所以查 why 里不能是"极短消息"。
    check(!/极短消息/.test(r.why), `「${t}」没被"极短消息"闸门拦下`, r.why);
  }
}

console.log('\n【3】稍长的正常消息不受影响（走正常判断）');
{
  for (const t of ['中国人能飞是什么梗', '服务器怎么进啊']) {
    const r = await didSearch(t);
    check(!/极短消息/.test(r.why), `「${t}」不走"极短消息"闸门`, r.why);
  }
}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
