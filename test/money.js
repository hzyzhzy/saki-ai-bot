/**
 * 「跟群友要钱」的拦截回归（2026-09-17 加）。
 *
 * ## 为什么要盯这个
 *   真实事故（用户截图）：群友问「恁能收红包吗」→ 她回「**能收啊，你要发？**」
 *
 *   ⚠️ 这跟前几条"说错话"不是一个量级：那是个**真 QQ 号，收红包是账号固有能力**，
 *      群友真发了钱就真进账。群里还可能有未成年人，而截图传出去写的就是
 *      「客服向群友讨红包」——对要发视频的场合是致命素材。
 *
 *   所以两头都堵：`persona.md`「零一」写了规矩（她该说什么），
 *   这里测的是**代码兜底**（万一她还是要说，直接拦下不发）。
 *
 * ⚠️ 纯离线：只测纯函数判据，不起进程、不碰真 QQ、不花钱。
 * 用法: node test/money.js
 */
import { detectMoneyTalk } from '../src/bot.js';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

console.log('\n【1】该拦的（都是"她自己要收 / 在要"）');
for (const t of [
  '能收啊，你要发？', // ★ 真实事故原句，必须拦
  '可以收红包的',
  '我收下了',
  '谢谢老板',
  '你要发红包吗',
  '发多少合适',
  '给我发个红包',
  '行收转账',
]) {
  const r = detectMoneyTalk(t);
  check(!!r, `拦下：${t}`, r ? `→ ${r}` : '（漏了！）');
}

console.log('\n【2】不许误拦的（群里正常聊钱 / 正常聊天）');
// ⚠️ 这一组和上一组同样重要：拦错了表现为"她突然不说话"（静默失败），
//    比说错话更难查 —— 所以每条都要有反例钉着。
for (const t of [
  '我也想发个红包',
  '我给大家发红包了，快去抢',
  '该发工资了吧', // 服主说的
  '这个月工资多少', // 问工资是她设定里允许的
  '红包没了',
  '收到消息了吗',
  '能收到吗', // 「能收」后面跟的是「到」，不是钱
  '你要发给谁',
  '我这边钱不够了', // 她抱怨工资可以（这是设定的一部分）
  '服务器几点开',
]) {
  const r = detectMoneyTalk(t);
  check(!r, `放行：${t}`, r ? `→ 误拦了：${r}` : '');
}

console.log('\n【3】边界：空输入 / 非字符串不许抛错');
for (const v of ['', '   ', null, undefined, 123]) {
  let ok = true;
  let got = '（抛错了）';
  try {
    got = String(detectMoneyTalk(v));
  } catch (e) {
    ok = false;
    got = e.message;
  }
  check(ok && got === 'null', `安全处理：${JSON.stringify(v)}`, got);
}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures ? 1 : 0);
