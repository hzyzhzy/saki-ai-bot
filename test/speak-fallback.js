/**
 * 「说话判断」失败时的兜底（2026-10-15 用户报的）。
 *
 * 用户原话：「**699 群**，可能是因为 llm 服务器的问题，**到中午开始疯狂回消息**」。
 *
 * 真因：上游 429/超时那阵子，`judgeSpeak()` 每次失败都兜底「**照常说**」
 *   ⇒ 群里**每条消息她都去接**（实测一小时 40 条，平时只有 2~6 条）✗
 * 而同一个群里**另一种"判不出来"**（判断节流）走的是**相反**的兜底
 *   （`bot.js` 那处：收紧度 > 2 ⇒ 这条不接）⇒ 两条判据不一致，这就是 bug。
 *
 * 修法：兜底跟着**收紧度**走 —— 调用方（只在"主动搭话"那几种 mode 上）
 *   传 `fallbackSilent: true` ⇒ 判不出来就**不接** ✓
 *   ⚠️ 不传 = 老行为（默认「说」）⇒ 别的调用方一个字不变 ✓
 *
 * ⚠️ 纯离线：配置里模型地址写的是死端口 ⇒ 调用**必然失败** ⇒ 正好走兜底 ✓
 *
 * 用法: node test/speak-fallback.js
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });

// ⚠️ 配置必须在 import `src/*` **之前**写好（`config.js` 是加载时读的）
const CFG = 'logs/__test-speak.yml';
writeFileSync(
  join(ROOT, CFG),
  [
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
    '  apiKey: "sk-test"',
    '  model: t',
    '  timeout: 800',
    'botQQ: "10000001"',
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG;

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const { judgeSpeak } = await import('../src/speak-judge.js');

const ev = {
  message_type: 'group',
  group_id: '999000001',
  user_id: '10000002',
  sender: { nickname: '路人' },
  message: [{ type: 'text', data: { text: '在吗' } }],
};

console.log('\n【1】判不出来（模型挂）时的兜底');
{
  const a = await judgeSpeak(ev, {});
  check(a.speak === true, '★ 不传 `fallbackSilent` ⇒ 老行为「照常说」（别的调用方零影响）');
  const b = await judgeSpeak(ev, { fallbackSilent: true });
  check(b.speak === false, '★★ 传了 `fallbackSilent` ⇒ 判不出来就**不接**（别再疯狂回消息）');
  check(/收紧度高/.test(String(b.why ?? '')), '★ 理由也说得清（日志里能看出是"收紧度高才不接"）', String(b.why));
}

console.log('\n【2】源码级：调用方要按收紧度传');
{
  const { readFileSync } = await import('node:fs');
  const bsrc = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    /fallbackSilent:[\s\S]{0,300}?!\/\(\[\?？\]/.test(bsrc),
    '★★ `bot.js` 的兜底判据是「**像在跟她说话**（问句）才照常说」，不看收紧度',
  );
  check(
    /吗\|呢\|怎么/.test(bsrc),
    '★ 那是按**消息内容**判的（`?？/吗/怎么/为什么/帮我…`），不是按群的性质',
  );
  check(
    /'chat', 'share', 'followUp', 'sticker', 'echoSticker'\]\.includes/.test(bsrc),
    '★★ 只对"主动搭话"那几种 mode 生效（被 @ / 引用她走另一条路，不许静默）',
  );
  const ssrc = readFileSync(join(ROOT, 'src', 'speak-judge.js'), 'utf8');
  check(
    /const fallback = opts\.fallbackSilent/.test(ssrc),
    '★ 兜底在 `speak-judge` 里按选项分派（不是写死"说"）',
  );
}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
