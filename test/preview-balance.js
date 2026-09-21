/**
 * 预览「工资（余额）提醒」会发什么（**不会真的发**）。
 *
 * 对应 2026-09-13 用户的两轮反馈：
 *   ① 「**为什么电子琴键盘要换琴弦？**」—— 原话术里「我连键盘弦都换不起了」是常识错
 *   ② 「2 块钱的可以凸出一下**是我的问题**，有一种**催我发工资**的感觉，
 *      同时要注意带上**机器人和我的特殊关系**，**不要像真的欠了 100 万一样**」
 *
 * ⚠️ 预览用 `dry: true` —— **不会**把档位标记成"已抱怨"，
 *    所以随便看多少次都不影响真实提醒（这点很重要：标记了真提醒就不发了）。
 *
 * 用法:
 *   node test/preview-balance.js           # 列话术 + 让模型现说几条
 *   node test/preview-balance.js --plain   # 只列话术，不调模型
 */
import { config } from '../src/config.js';
import * as balance from '../src/balance.js';
import { phraseMoney } from '../src/llm.js';

const plain = process.argv.includes('--plain');
const b = config.balance ?? {};
const low = Number(b.low) > 0 ? Number(b.low) : 5;
const crit = Number(b.critical) > 0 ? Number(b.critical) : 2;

console.log('\n════ 工资提醒预览 ════\n');
console.log(`档位　　：「偏低」< ${low} 元　　「见底」< ${crit} 元`);
console.log(`每档只报一次（按档位，不按时间）；涨回档位以上会重置`);
console.log(`发送方式：1 档群里**冷场** ${Math.round((Number(b.quietMs) || 180000) / 1000)} 秒后才发`);
console.log(`发到群　：${Object.entries(config.trigger?.groupRespondTo ?? {}).filter(([, v]) => Number(v) === 1).map(([g]) => g).join('、') || '（没有 1 档群）'}`);
console.log(`@ 本人　：「见底」档（< ${crit} 元）会**直接 @ ${config.ownerQQ}**（用户要求：增强提醒效果）`);
console.log(`　　　　　「偏低」档不 @ —— 那档只是随口提一句，每次都 @ 就成骚扰了`);

console.log('\n──── 话术：偏低（< ' + low + ' 元，轻提一句）────\n');
for (const line of balance.allLines('low')) console.log(`  ${line}`);

console.log('\n──── 话术：见底（< ' + crit + ' 元，点到他、软催）────\n');
for (const line of balance.allLines('critical')) console.log(`  ${line}`);

console.log('\n──── 见底档在群里**实际长什么样**（带 @）────\n');
{
  const demo = balance.allLines('critical')[0];
  const at = config.ownerQQ;
  // ⚠️ @ 是**独立消息段**，不是文字里的 "@qq" —— 后者不会真的提醒到人
  console.log(
    `  ${JSON.stringify(
      [
        { type: 'at', data: { qq: String(at), name: '<主人>' } },
        { type: 'text', data: { text: ' ' } },
        { type: 'text', data: { text: demo } },
      ],
      null,
      2,
    ).replace(/^/gm, '  ')}`,
  );
  console.log(`\n  群里显示成：[@<主人>] ${demo}`);
}

console.log('\n──── 给提示词的语气要求 ────\n');
console.log('（两个档位各给一次 —— 「见底」那档要求更软、更冲他去）');

for (const [name, total] of [
  [`偏低（余额 ${(low + crit) / 2} 元）`, (low + crit) / 2],
  [`见底（余额 ${crit - 0.5} 元）`, crit - 0.5],
]) {
  console.log(`\n  ┌─ ${name} ─────────────────────────`);
  // ⚠️ 只改内存、不落盘：预览不能影响真实的"已抱怨"状态
  balance.setLastForPreview(total);
  const note = balance.balanceNote();
  // ⚠️ 找"状态判定"那行不能用 `includes('手头')` —— 标题里也有"手头"两个字，
  //    结果抓到的是标题（`# 【你手头的情况】`）。要挑**没有 `#` 的那行**。
  const feel = note.split('\n').find((l) => /手头/.test(l) && !/^#/.test(l.trim())) ?? '';
  console.log(`  │ 状态判定：${feel.replace(/\*\*/g, '')}`);
  const rules = note.split('\n').filter((l) => /^·\s|^一句话/.test(l.trim()));
  for (const r of rules) console.log(`  │ ${r.trim().replace(/\*\*/g, '')}`);
  console.log('  └──────────────────────────────────');
}

if (!plain) {
  console.log('\n──── 让模型照这套语气现说几条（见底档）────\n');
  // ⚠️⚠️ 这里的规则**必须和生产路径一致**（2026-09-13 踩过）：
  //    我原来在这写的是旧规格（"工资是 <主人> 发给你的，他还没发"
  //    "不要在句子里写名字""认下是我自己花超了"）——
  //    全是当天被用户否掉的那套，于是**预览显示"你"、而生产提示词早就
  //    要求点名 <主人>**，两边对不上，白让人以为改坏了。
  //    现在**直接从 `balanceNote()` 里抽出规则**，改一处两边同步。
  balance.setLastForPreview(crit - 0.5);
  const note = balance.balanceNote();
  const ruleLines = note
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[·|✅❌⚠️]/.test(l))
    .slice(0, 12);
  for (let i = 0; i < 3; i += 1) {
    try {
      const t = await phraseMoney({
        // ⚠️ 事实也要跟生产的口径一致：**余额**不是"工资"，而且没有月度周期
        facts: '（情况）账户余额不多了，该充钱了。账户是 <主人> 管的。',
        asked: '在群里提一句该充值了',
        style: '这是她自己在群里说的（旁边有群友，但话是说给 <主人> 听的）。',
        maxLines: 1,
        maxTokens: 120,
        extraRules: [
          '· **一句话**，15 字左右',
          ...ruleLines,
          // ⚠️ 实测：不拦的话这几条会长得一模一样 —— 真发到群里连着两次就露馅了
          '· ⚠️ **别用「工资还没发」这个句式**（那是另一套，这里说的是账户要充值）',
        ],
      });
      const out = t || '（模型没返回 → 走上面那些固定话术）';
      // 自检：群里发的必须有指向（点名 <主人>），而且不许提"这个月"
      const problems = [];
      if (out && !/<主人>/.test(out)) problems.push('没点名 <主人>（群里没指向）');
      if (out && /这个月|本月|月底/.test(out)) problems.push('提了"这个月"（余额没有月度周期）');
      console.log(`  ${i + 1}. ${out}${problems.length ? `   ⚠️ ${problems.join('；')}` : ''}`);
    } catch (e) {
      console.log(`  ${i + 1}. （出错：${e.message}）`);
    }
  }
}

console.log('\n（本次预览**没有**真的发送，也没动"已抱怨"状态）\n');
