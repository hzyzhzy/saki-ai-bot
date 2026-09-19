/**
 * 复读机套件（2026-09-17 加）。
 *
 * ## 用户的三条要求（截图：六个人连着刷「怎么下这么早」）
 *   ① 群友全变复读机时，**复读到第 3 句或更多**才跟一句 +1
 *   ② **第三句概率最大，然后依次减小**
 *   ③ **「不要有人打断复读时还在接复读」** ← 这条最要紧，是本套件的重点
 *
 * ⚠️ 纯离线：只测纯逻辑，不起进程、不碰真 QQ、不花钱。
 * 用法: node test/repeat.js
 */
import * as repeat from '../src/repeat.js';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const G = '200000001';
const SAME = '怎么下这么早';

console.log('\n【1】归一化：什么样才算"同一句"');
check(repeat.norm(SAME) === repeat.norm(`${SAME} `), '末尾空格不算区别');
check(repeat.norm(SAME) === repeat.norm(`${SAME}！`), '末尾感叹号不算区别');
check(repeat.norm(SAME) === repeat.norm('怎么下 这么早'), '中间空格不算区别');
check(repeat.norm(SAME) !== repeat.norm('怎么下这么晚'), '换了字就是不同的话');
check(repeat.norm('[图片]') === '[图片]', '图片占位符保留（同一张图才算复读）');
check(repeat.norm('') === '' && repeat.norm(null) === '', '空 / null 归一化成空串');

console.log('\n【2】★ 复读计数');
repeat.reset();
check(repeat.observe(G, SAME) === 1, '第 1 句 → 1');
check(repeat.observe(G, SAME) === 2, '第 2 句 → 2');
check(repeat.observe(G, SAME) === 3, '第 3 句 → 3');
check(repeat.observe(G, SAME) === 4, '第 4 句 → 4');

console.log('\n【3】★★ 有人打断 → 链断（用户特别点出来的那条）');
check(repeat.observe(G, '在吗') === 1, '插一句别的 → 计数立刻回 1');
check(repeat.observe(G, SAME) === 1, '★ 打断之后再有人复读 → 也是 1（不会接上旧链）');
check(repeat.observe(G, SAME) === 2, '再一句 → 2');
check(repeat.shouldJoin(G, { cooldownMs: 0 }).join === false, '★★ 打断之后不会"接着接复读"');

console.log('\n【4】★ 概率：第三句最大，然后依次减小');
check(repeat.joinChance(1) === 0 && repeat.joinChance(2) === 0, '前两句恒为 0（两个人说同一句不算复读机）');
const c3 = repeat.joinChance(3);
const c4 = repeat.joinChance(4);
const c5 = repeat.joinChance(5);
const c6 = repeat.joinChance(6);
check(c3 > c4 && c4 > c5 && c5 > c6 && c6 > 0, `依次减小：${c3} > ${c4} > ${c5} > ${c6}`);
check(c3 === 0.6, `第三句确实是最大的那个（${c3}）`);
check(repeat.joinChance(99) > 0, '再往后也还有一点概率（不会变成 0）');
check(repeat.joinChance(3, [0.9]) === 0.9, '配置能给覆盖（probs 参数）');

console.log('\n【5】★★ 一条链只接一次');
repeat.reset();
repeat.observe(G, 'x');
repeat.observe(G, 'x');
repeat.observe(G, 'x');
const v3 = repeat.shouldJoin(G, { cooldownMs: 0 });
check(v3.join === true, '第 3 句时可以接');
// ★★ 2026-09-18 用户纠正：「不是直接发+1，而是复述前面几个人正在复述的内容」
check(v3.say === 'x', '★★ 她跟的是被复读的**原话**（不是 "+1"）', JSON.stringify(v3.say));
repeat.noteJoined(G);
check(repeat.shouldJoin(G, { cooldownMs: 0 }).join === false, '★ 接过了就不再接（同一条链）');
repeat.observe(G, 'x');
repeat.observe(G, 'x');
check(repeat.shouldJoin(G, { cooldownMs: 0 }).join === false, '★ 链继续到第 4、5 句也不接');

console.log('\n【5b】★★ 复读发的是**原话**（归一化只用来比对，不用来发送）');
repeat.reset();
repeat.observe(G, '  原神，启动！  ');
repeat.observe(G, '原神，启动！');
repeat.observe(G, '原神，启动！');
const vv = repeat.shouldJoin(G, { cooldownMs: 0 });
check(vv.join === true, '第 3 句还是能接');
check(vv.say === '原神，启动！', '★★ 发出去的是原文（首尾空格去掉）', JSON.stringify(vv.say));
check(vv.say !== '+1', '★★ 不是 "+1"（用户 2026-09-18 纠正过）');

console.log('\n【6】冷却（按群各算各的）');
repeat.reset();
for (let i = 0; i < 3; i++) repeat.observe(G, 'y');
repeat.noteJoined(G);
check(repeat.shouldJoin(G, { cooldownMs: 60000 }).join === false, '刚接过 → 冷却中不接');
check(repeat.current('999999') === 0, '别的群压根没链');

console.log('\n【7】边界：空消息不打断、自己发的不算');
repeat.reset();
repeat.observe(G, 'a');
repeat.observe(G, 'a');
check(repeat.observe(G, '') === 2, '空消息不打断链');
check(repeat.observe(G, '   ') === 2, '纯空白不打断链');
check(repeat.observe(G, '换了一句完全不一样的话') === 1, '换了内容 → 重新起链');
// ⚠️⚠️ 2026-09-19 加（用户报：他连发 3 张**不同**的图，却触发了复读、群里出现一行字面 `[图片]`）：
//    图片消息归一化出来的是**占位符** `[图片]`（不是空串）→ 三张不同的图被当成
//    "同一句话刷了 3 遍" → 她跟着复读那句占位符 ✗
//    ⇒ 占位符必须**当没内容**：既不参与复读，也不打断正在进行的链
//      （所以下面两次都还是 1，不是 2）。
check(
  repeat.observe(G, '[图片]') === 1 && repeat.observe(G, '[图片]') === 1,
  '发图不参与复读（连发几张也不涨链）',
);
repeat.reset();
repeat.observe(G, 'b');
repeat.observe(G, 'b');
check(repeat.observe(G, 'b', { isSelf: true }) === 2, '她自己发的**不进链**（不然 +1 会自己叠自己）');
check(repeat.current('nope') === 0, '没记录的群 = 0');
check(repeat.shouldJoin('nope', { cooldownMs: 0 }).join === false, '没链 → 不接');
check(repeat.shouldJoin(G, { enable: false }).join === false, '功能关了 → 不接');

console.log('\n【8】异常输入不许抛');
for (const bad of [null, undefined, 123, ''][Symbol.iterator]()) {
  let ok = true;
  try {
    repeat.observe(bad, null);
    repeat.observe(G, bad);
    repeat.shouldJoin(bad, {});
    repeat.joinChance(bad);
  } catch (e) {
    ok = false;
    console.log(`    ${e.message}`);
  }
  check(ok, `安全处理：${JSON.stringify(bad)}`);
}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures ? 1 : 0);
