/**
 * 「慢模型丢弃积压」测试（2026-10-07 用户要求）。
 *
 * ## 盯的是什么
 *
 * 用户原话：「加一个闸，这是为了应对**中转站盗版慢速模型**做的优化，如果已经
 *   接到了**大于两分钟**才开始生成消息（因为前面消息生成太慢），**直接把后面
 *   排队生成的消息全部丢掉**，当有新消息进入开始生成再恢复」，
 *   并补了一句「**就像群里现在黑祥的状态一样，要避免这种情况**」。
 *
 * ## 为什么要这个闸（不是"忍着攒完一起回"）
 *
 * 慢生成会把队列堵成一长串：这一轮还没出来，群里又来几条（默认最多攒 10 条），
 * 等它出来时那些话**早就过时了**；而攒下的那一批马上又是**另一次两分钟的生成**
 * ⇒ **永远在追、永远追不上**，回的还都是几分钟前的事（用户看到的"答非所问"）。
 * 扔掉积压才跳得出这个循环。
 *
 * ## 为什么直接测 `dropIfSlowGenerating()` 而不起真进程
 *
 * 那个判断原来是埋在 `scheduleHandle()` 的"生成期间先攒着"分支里的 ——
 * 直接测它得先等 900ms 的合并窗口，又慢又脆。所以抽成了独立方法，
 * 这里按"三种状态 + 三种配置"把它**逐条钉死**；接线则用源码断言兜（见【7】）。
 *
 * ## 钉住的六件事（缺一条这个闸就白做）
 *
 * ① **默认开**，阈值默认 **60 秒**；② 超阈值 ⇒ 丢（连已攒的一起、且只报一次日志）；
 * ③ **没超阈值不许丢**；④ 关掉开关 ⇒ 回到老行为；⑤ 阈值可调 + 非法值兜底；
 * ⑥ **那条慢的发出后不算恢复** —— 要等**下一条新消息**（"试探轮"）正常生成完
 *    才解除，而这之前攒的**全丢**（用户原话：「反正新消息之前的要全部丢弃」）。
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { config } = await import('../src/config.js');
const { Bot } = await import('../src/bot.js');

const KEY = 'group:999000301';
const b = new Bot();
b.selfId = '10000002';

/** 造一个"这个群正在生成"的状态（`agoMs` 往前挪 = 已经生成了这么久） */
const st = ({ agoMs = 0, items = [], running = true } = {}) => ({
  running,
  items: [...items],
  ...(agoMs ? { startedAt: Date.now() - agoMs } : {}),
});
/** 钉住配置（只改内存里那份，不碰文件） */
const setCfg = (o) => {
  config.llm = { ...(config.llm ?? {}), ...o };
};

console.log('\n【1】默认是**开着**的，阈值默认 60 秒');
{
  config.llm = { ...(config.llm ?? {}) };
  delete config.llm.slowQueueDrop;
  delete config.llm.slowQueueDropMs;
  check(b.slowDropOn() === true, '★ 配置里没写也当**开**（用户要求：默认开启）');
  check(b.slowDropMs() === 60000, '★ 默认阈值 = **60000ms（60 秒）**');
}

console.log('\n【2】★★ 这一轮生成超过阈值 ⇒ 排队的一律丢掉');
{
  setCfg({ slowQueueDrop: true, slowQueueDropMs: 300 });
  const s = st({ agoMs: 500, items: [{ _tag: '老消息' }] });
  const dropped = b.dropIfSlowGenerating(KEY, s);
  check(dropped === true, '★★ 已经生成 500ms（> 300ms 阈值）→ **丢**');
  check(s.items.length === 0, '★★ 而且**原来攒着的那条也一起扔了**', `items=${s.items.length}`);
  check(s.running === true, '★ 状态还是"生成中"（那一轮仍在跑，等它自己结束）');
  check(s._dropLogged === true, '★ 记了"已报过一次"（免得慢模型期间每来一条刷一行日志）');
  // ⚠️ 这就是"这条没被攒下"的等价形式：调用方拿到 true 就直接 return（见【7】的接线断言）
}

console.log('\n【3】没超阈值 ⇒ 不许丢（不误伤正常速度）');
{
  setCfg({ slowQueueDrop: true, slowQueueDropMs: 300 });
  const s = st({ agoMs: 100 });
  check(b.dropIfSlowGenerating(KEY, s) === false, '★ 才生成 100ms（< 300ms）→ 不丢，照常攒');
  const s2 = st({ agoMs: 300 });
  check(b.dropIfSlowGenerating(KEY, s2) === false, '★ 正好等于阈值 → 也不丢（判据是"**超过**"）');
}

console.log('\n【4】关掉开关 ⇒ 再慢也不丢（回到老行为）');
{
  setCfg({ slowQueueDrop: false, slowQueueDropMs: 300 });
  check(b.slowDropOn() === false, '★ 开关读到的是"关"');
  const s = st({ agoMs: 60000, items: [{ _tag: '老消息' }] });
  check(b.dropIfSlowGenerating(KEY, s) === false, '★★ 已经生成一分钟了也不丢');
  check(s.items.length === 1, '★ 攒着的那条还留着');
}

console.log('\n【5】阈值可调（界面上那个秒数）+ 非法值兜底');
{
  setCfg({ slowQueueDrop: true, slowQueueDropMs: 60000 });
  check(b.slowDropMs() === 60000, '★ 读的是配置里的值');
  check(b.dropIfSlowGenerating(KEY, st({ agoMs: 5000 })) === false, '★ 阈值 60 秒 → 5 秒不算慢');
  check(b.dropIfSlowGenerating(KEY, st({ agoMs: 61000 })) === true, '★ 61 秒 → 超了，丢');

  setCfg({ slowQueueDrop: true, slowQueueDropMs: 0 });
  check(b.slowDropMs() === 60000, '★ 写成 0 → 退回默认 **60 秒**（**不能变成"永远在丢"**）');
  setCfg({ slowQueueDrop: true, slowQueueDropMs: 'abc' });
  check(b.slowDropMs() === 60000, '★ 写成非数字 → 同样退回默认');
  setCfg({ slowQueueDrop: true, slowQueueDropMs: -5 });
  check(b.slowDropMs() === 60000, '★ 写成负数 → 同样退回默认');
}

console.log('\n【6】★★ 那条慢的发出后**不算恢复**；要等"试探轮"成功才算');
{
  setCfg({ slowQueueDrop: true, slowQueueDropMs: 300 });
  const s = st({ agoMs: 500, items: [{ _tag: '老消息' }] });
  check(b.dropIfSlowGenerating(KEY, s) === true, '超阈值 → 丢');
  check(s.slowMode === true, '★★ 并且**进入慢模式**');

  // ① 那条慢的生成完了（它不是"试探轮"）
  s.probing = false;
  s.items.push({ _tag: '它之后才来的' });
  b.noteGeneratingDone(KEY, s);
  check(
    s.slowMode === true,
    '★★ **那条慢的发出之后仍然不恢复**（用户原话：「生成完了正好超过 2 分钟的那条之后也不要恢复」）',
  );
  check(s.items.length === 0, '★★ 而且它之后攒下的**全丢**（用户原话：「反正新消息之前的要全部丢弃」）');

  // ② 下一条新消息进来 ⇒ 它是"试探轮"（`scheduleHandle` 里见到 slowMode 会打这个标记）
  s.probing = true;
  s.startedAt = Date.now();
  b.noteGeneratingDone(KEY, s);
  check(s.slowMode === false, '★★ 试探轮**正常生成完** ⇒ 这才叫**恢复**');
  check(s.probing === false, '★ 标记也清干净（下次不会误判成试探轮）');

  // ③ 从没进过慢模式 ⇒ 什么都不做（别影响日常）
  const fresh = st({ running: false });
  b.noteGeneratingDone(KEY, fresh);
  check(fresh.slowMode === undefined, '★ 没进过慢模式 → `noteGeneratingDone()` 一个字都不改');

  // ④ 恢复之后：全新的一轮没有 `startedAt` ⇒ 不再丢
  check(fresh.startedAt === undefined, '★ 恢复后的新状态里没有 `startedAt`');
  check(b.dropIfSlowGenerating(KEY, fresh) === false, '★★ 所以照常处理 —— 不会卡在"永远丢"');
}

console.log('\n【7】接线：默认值 / 界面控件 / 真的接在那条路上 / 慢模式的结算');
{
  const cfgSrc = readFileSync(join(ROOT, 'src', 'config.js'), 'utf8');
  check(
    /slowQueueDrop: true/.test(cfgSrc) && /slowQueueDropMs: 60000/.test(cfgSrc),
    '★ `config.js` 的默认值 = **开** + 60000ms（60 秒）',
  );

  const html = readFileSync(join(ROOT, 'src', 'webui.html'), 'utf8');
  check(
    /id="llm-slowDrop"/.test(html) && /id="llm-slowDropMs"/.test(html),
    '★ 界面上有这两个控件（「模型 → 大模型」卡片里）',
  );
  check(
    /slowQueueDrop: !!\$\('llm-slowDrop'\)\.checked/.test(html),
    '★★ 保存时**显式写 false** —— 省略就等于"没改"，用户就关不掉这个闸了',
  );
  check(
    /\$\('llm-slowDrop'\)\.checked = c\.llm\.slowQueueDrop !== false/.test(html),
    '★ 读回来也是"只有明确写 false 才算关"（默认开）',
  );
  check(/slowQueueDropMs:[\s\S]{0,140}\* 1000/.test(html), '★ 界面填**秒**、存**毫秒**');
  check(/\?\? 60000\)/.test(html), '★ 界面上读回来的兜底默认也是 **60 秒**');

  const bsrc = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(/slowQueueDrop !== false/.test(bsrc), '★ 后端也按"默认开"判（`!== false`）');
  check(
    /if \(st\.running\) \{[\s\S]{0,2500}?this\.dropIfSlowGenerating\(bkey, st\)/.test(bsrc),
    '★★ **真的接在**「生成期间新来的消息先攒着」那条路上（而且是**攒之前**就判）',
  );
  check(
    /if \(this\.dropIfSlowGenerating\(bkey, st\)\) \{[\s\S]{0,160}?return Promise\.resolve\(\);/.test(bsrc),
    '★★ 判定为"丢"时**直接返回**（不攒、不触发生成）',
  );
  check(
    (bsrc.match(/st\.startedAt = Date\.now\(\)/g) ?? []).length >= 2,
    '★★ **真正开始生成**那两处（首次 + 续批）都记了 `startedAt` —— 漏一处计时就永远是 0、这个闸等于没做',
  );
  check(
    /st\.startedAt = 0;/.test(bsrc),
    '★ 而"只是在等他打完字"那条路（`genHoldMs`）把计时清掉 —— 等待不算生成',
  );

  // ⚠️ 2026-10-07 用户补的要求：**那条慢的发出后不许恢复**，要等"试探轮"成功
  check(/st\.slowMode = true;/.test(bsrc), '★ 超阈值时进入慢模式');
  check(
    /noteGeneratingDone\(bkey, st\)/.test(bsrc),
    '★ 慢模式在 `enqueue` 的 `finally` 里结算（`noteGeneratingDone`）',
  );
  check(
    /if \(st\.probing\) \{[\s\S]{0,400}?st\.slowMode = false;/.test(bsrc),
    '★★ **只有"试探轮"跑完才解除**慢模式（那条慢的自己跑完不算）',
  );
  check(
    (bsrc.match(/if \(st\.slowMode\) st\.probing = true;/g) ?? []).length >= 2,
    '★★ 慢模式里新开始的那一轮 = **试探轮**（首次 + 续批两处都要标）',
  );
  check(
    /if \(st\.slowMode\) \{[\s\S]{0,200}?this\.batchState\.set\(bkey, st\)/.test(bsrc),
    '★★ **慢模式时不删状态** —— 一删 `slowMode` 就丢，等于"那条慢的一生成完就恢复"（用户不要的行为）',
  );
}

console.log(
  failures === 0
    ? '\n结果: 全部通过 ✅（慢模型：超时就丢积压、不超时照旧、关掉回老行为、那条慢的发出后不恢复）\n'
    : `\n结果: ${failures} 项失败 ❌\n`,
);
process.exit(failures === 0 ? 0 : 1);
