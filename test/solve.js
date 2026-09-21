/**
 * 「解题模式」判据（`src/solve.js` 的 `looksLikeProblem`）。
 *
 * 为什么单独一套：这条判据**踩过两次**，每次都是「一句普通的话 + 一张图」
 * 被判成"有人出题"，她就一本正经地抢答：
 *   · 2026-09-13：他发图 + 「告诉我签300喂圆周率」→ 判成题 → `max_tokens` 抬到 24000
 *     → 整个请求 60 秒超时 → 群里显示「模型调用出错了，请稍后再试」
 *   · 2026-09-20：他发 MC 截图 + 「我这里有点出头了」→ 判成题 → 她抢答
 *     「哪出头了，那栋蓝玻璃的？」，下一轮还答「我这边？老样子，坐着呢」
 *     用户原话：**「又出现没有叫她但是把自己当成主角的情况了」**
 *
 * 节奏：**只收紧"带图 + 短消息"那一条**，真题目一个都不许漏 —— 第 [2] 组就是盯这个。
 *
 * 用法: node test/solve.js
 */
import { looksLikeProblem } from '../src/solve.js';

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}`);
  if (!ok) failures++;
};
/** 简写：这句话会不会被当成「题」 */
const isP = (t, hasImage = false) => looksLikeProblem(t, { hasImage }).isProblem;

console.log('\n[1] 不该判成题的（用户真实踩过的）');
check(!isP('我这里有点出头了', true), '「我这里有点出头了」+ 图 → 自述，不是题');
check(!isP('我这里有点出头呢', true), '「…有点出头呢」+ 图 → 不是题');
check(!isP('我的房子建好了', true), '「我的房子建好了」+ 图 → 陈述，不是题');
check(!isP('看看这张', true), '「看看这张」+ 图 → 纯指代，不是题');
check(!isP('这是啥', true), '「这是啥」+ 图 → 不是题');
check(!isP('告诉我这图里的建筑叫什么', true), '问信息的语气 → 不是题');

console.log('\n[2] 该判成题的（收紧别把真题挡掉）');
check(isP('这题怎么做', true), '「这题怎么做」+ 图');
check(isP('求解', true), '「求解」+ 图');
check(isP('帮我看看这个', true), '「帮我看看这个」+ 图');
check(isP('算一下这个积分', true), '「算一下」+ 图');
check(isP('如图，已知三角形 ABC，求角 A 的度数'), '题干 + 求（没带图也算）');
check(isP('第 3 题 (2) 求证 AB = CD'), '题号 + 求证');

console.log('\n[3] 服务器的事不算题（老规矩，别被"算一下"骗了）');
check(!isP('你算一下这周在线人数'), '「算一下在线人数」→ 问服务器，不是题');
check(!isP('这个模组怎么装'), '问模组 → 不是题');

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
