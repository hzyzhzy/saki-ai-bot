/**
 * 「搜图」给 agent 的任务文本（2026-10-19 加）。
 *
 * 用户原话：「**要让 agent 也一张一张发，并且要符合描述且质量高，
 *   然后要接收到我这边说的搜图数量**」
 *
 * ## 这个套件盯什么
 *   ① **张数要吃准**：他说 2 张就只让 agent 下 2 张 ——
 *      不是"下 17 张然后发 2 张"（那 3 分 18 秒才出第一张，699 群实测）✗
 *   ② **必须写着"边搜边下、别先攒清单"** —— 上一版就是先攒 48 条候选再统一下载，
 *      前两三分钟文件夹空着，`tick` 没东西可发 ✗
 *   ③ **必须写着"对不上就不要、要原图"** —— 用户要"符合描述且质量高" ✓
 *   ④ **必须写着"别写清单文件"** —— 下到文件夹里就算挑好了，`tick` 直接发 ✓
 *
 * ⚠️ 纯字符串断言，不起 agent、不花钱、不碰网络。
 * 用法: node test/image-search.js
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as im from '../src/image-search.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok || !extra ? '' : `（${extra}）`}`);
  if (!ok) failures++;
};

console.log('\n【1】★ 张数要跟着他说的走');

for (const n of [1, 2, 3, 5, 10]) {
  const t = im.imageAgentTask('搜「安岛的图」的图，挑出几张好的发到群里', n);
  check(t.includes(`只要 ${n} 张`), `说 ${n} 张 ⇒ 任务里写「只要 ${n} 张」`);
  // 别把数字写错（比如 2 张却写 8 张）
  const wrong = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter((x) => x !== n && t.includes(`只要 ${x} 张`));
  check(wrong.length === 0, `没有混进别的张数（实际 ${n} 张，混进来：${wrong.join(',') || '无'}）`);
}

console.log('\n【2】★ 四条硬要求都在');

{
  const t = im.imageAgentTask('搜「安岛的图」的图，挑出几张好的发到群里', 2);
  check(/别一口气扒十几张|多下几张备着/.test(t), '写着「别一口气扒十几张」');
  check(/边搜边下|下一张算一张/.test(t), '★ 写着「边搜边下、下一张算一张」');
  check(/别先攒一张候选清单/.test(t), '★★ 明确禁止「先攒候选清单再统一下载」');
  check(/符合描述/.test(t) && /对不上/.test(t), '★ 写着「必须符合描述、对不上的不要」');
  check(/高清/.test(t) || /原图/.test(t), '★ 写着「要高清 / 原图」');
  check(/清单文件/.test(t) && /挑好的\.md/.test(t), '★ 写着「不用写清单文件」');
  check(/搜图-/.test(t), '给了文件名规范（`搜图-…`）');
}

console.log('\n【3】原任务原样带上（别把他的话改没了）');

{
  const raw = '搜「找两张爱祥的图来」的图，挑出几张好的发到群里';
  const t = im.imageAgentTask(raw, 2);
  check(t.startsWith(raw), '第一行就是原任务（原样，没改写）');
}

console.log('\n【4】脏输入不许崩');

for (const [cap, label] of [
  [0, '0 张'],
  [NaN, 'NaN'],
  [-3, '负数'],
  ['abc', '字符串'],
  [undefined, 'undefined'],
]) {
  let ok = true;
  let t = '';
  try {
    t = im.imageAgentTask('搜「x」的图', cap);
  } catch (e) {
    ok = false;
    t = e.message;
  }
  // 至少得说出一个 ≥1 的张数，不能是 0/NaN/负数
  check(ok && /只要 [1-9]\d* 张/.test(t), `${label} ⇒ 兜到 ≥1 张（没崩）`);
}

// ⚠️⚠️ 2026-10-19 加（用户：「**752 群搜图这次只发了一张图**」）——
//    那张是 `调用 send_group_msg 超时`，**一次超时就放弃**，而且失败后还被标成"试过了"
//    ⇒ 说 2 张只出 1 张、永远补不回来 ✗
//    这两条是"代码结构"断言（重试不好离线跑），防以后被改回去：
console.log('\n【5】★ 发图失败要能补回来');
{
  const src = readFileSync(join(ROOT, 'src', 'image-search.js'), 'utf8');
  check(/timeoutMs:\s*60000/.test(src), '发图超时放宽到 60 秒（原来用默认值）');
  check(/for \(let i = 0; i < 2; i \+= 1\)/.test(src), '★ 发图失败会**重试一次**');
  check(/tried\.delete\(it\.path\)/.test(src), '★★ 发失败的那张会**从 tried 里摘掉**（下一轮 tick 还能再试）');
  check(/太大/.test(src) && /throw e/.test(src), '「图太大」不白重试（直接抛）');
}

// ⚠️⚠️ 2026-10-19 加（用户：「**找两张长沙的照片**」竟然没走搜图，当成普通任务派给 agent 了）——
//    原来只认「图/立绘/壁纸/插画/原画/截图/表情包」，「照片/相片/写真/头像」一个都不认 ✗
//    而「找几张 XX 的照片」是最常用的说法之一。
console.log('\n【6】★ 「照片」也要认（这是最常用的说法之一）');
{
  for (const t of [
    '找两张长沙的照片',
    '来几张照片',
    '给我弄几张长沙相片',
    '搜两个头像',
    '发几张写真',
    '找点安岛的照片',
    // ⚠️ 2026-10-19 用户定的是「**动作 + 要找的东西两侧同时符合就行**」——
    //    所以两侧都按"字根族"认，不再穷举词表：动作侧 找搜来给弄要发挑扒收翻拿捞搞整求下，
    //    目标侧 图照相片绘｜壁纸头像素材表情立绘海报封面画面写真。
    //    下面几条就是以前会被漏掉的说话方式 ✓
    '要几张海报',
    '来几张长沙的街景照',
    '给我搞几张素材',
    '拿几张图来',
  ]) {
    check(im.looksLikeImageTask(t) === true, `认：「${t}」`);
  }
  // 反过来：**不是"去找图"**的说法不许抢（不然会把正常聊天顶掉）
  for (const t of ['帮我修照片', '看看我这张照片拍得怎么样', '这个PPT做张图', '这图不错啊']) {
    check(im.looksLikeImageTask(t) === false, `不抢：「${t}」`);
  }
}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
