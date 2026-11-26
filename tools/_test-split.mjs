/**
 * 离线验 `bot.splitForSend` 的切分效果（不启动机器人、不发消息）。
 *
 * 用法：node tools/_test-split.mjs
 * 它从 src/bot.js 里**抠出真实的函数源码**来跑，所以验的就是线上那份。
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/bot.js', import.meta.url), 'utf8');
const i = src.indexOf('  splitForSend(text) {');
const j = src.indexOf('\n  trimChunk(', i);
if (i < 0 || j < 0) {
  console.error('抠不到 splitForSend 源码');
  process.exit(1);
}
const fnSrc = '({' + src.slice(i, j) + '})';

// 非工作模式：maxChars 40 → half = 20，maxChunks = 3
const chunkCfg = () => ({ max: 20, maxChunks: 3 });
// eslint-disable-next-line no-new-func
const make = new Function('chunkCfg', 'config', `return ${fnSrc}`);
const o = make(chunkCfg, { chunking: {} });

const samples = [
  '……哎你们看，这回又往前挪了一点（ victory-belobug 那个 AMD 分支现在跑在头里了，效果比上一个分支再好一些（歪头） 不过还是那句，几个项目抢来抢去，真正能完整跑通的还没有（笑） 【gta6移植pc最新进展！victory-belobug-amd分支取得领先 效果再进一步！】 https://www.bilibili.com/video/BV1yG411M7xZ',
  '……哎你们看，又有个新说法冒出来了：能加载开场动画、真的进到序章了（ 不过帧率还不到 1，画面泛白、人物模型也加载错，离能玩差得远（歪头） R星那边还在封项目，Leonida 就被封了（叹气） 【《GTA6》PC项目新进展 有项目已能进入开场序章】 https://news.17173.com/content/11252026/111104152.shtml',
  '嗯嗯，在呢。',
  '好，那我去看看。反正还没定，等有准信了再跟你说一声。',
];

for (const s of samples) {
  const p = o.splitForSend(s);
  console.log(`原文 ${s.length} 字 → ${p.length} 条｜${p.map((x) => x.length).join('/')}`);
  p.forEach((x, k) => console.log(`  [${k + 1}] ${x}`));
  console.log('');
}
