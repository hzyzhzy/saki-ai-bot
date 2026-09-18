/**
 * 「连发碎片 → 整串当成一句话，只回一次」测试（2026-09-16）。
 *
 * ## 这个套件盯的是用户报的那个「多信息合并的极端情况」
 *
 * 用户原话：
 *   「这是多信息合并的极端情况，图一是现在情况，图二是理想情况，
 *    现在我们能最小限度修改现有逻辑实现好吗」
 *
 * 截图内容：他连着发了 11 条**一个字一条**的消息（「你/可/以/一/个/一/个/字/说/话/吗」）。
 *   · 图一（私聊）＝ 现在的情况：她**分着**答了两句
 *     （「就一个字？我还以为你要反悔（」+「嗯？怎么，睡不着」）。
 *   · 图二（群里）＝ 他要的样子：**整串当成一句话，只回一次**。
 *
 * ## 为什么会拆开（两个原因，都在这套件里钉住）
 *
 * ① 合并窗口是**固定**的 900ms（@她/引用她）/ 1200ms（其它），
 *    靠"安静下来才处理"凑批。可手打一个字要 1~2 秒 → **每条都掉在窗口外面**
 *    → 一条一批 → 分着答。
 * ② `scheduleHandle()` 第一行写着 `event.message_type !== 'group'` ——
 *    **私聊压根不过合并这道门**，11 条是一条一条单独处理的。
 *
 * ## 改法（只动 `scheduleHandle`，别处一行没动）
 *
 * · 私聊也走合并；
 * · **碎片**消息（≤ `burstShortChars` 个字，或纯表情/纯图）把安静窗口放宽到
 *   `burstQuietMs`，并且照旧"每来一条就重新计时" → 他不停手就一直不处理，
 *   停手之后整串**一次**处理完；
 * · 只有碎片放宽 —— 正常一句话还是 900/1200ms（**不许把所有回复都拖慢**，
 *   这是本套件【4】盯的）；
 * · @ 她 / 引用她 也不放宽（明确提问，人在等答案）——【5】盯的；
 * · `burstMaxMs` 是上限，防刷屏把她嘴堵死。
 *
 * ## 还有那个「回复也一个字一条」的彩蛋（同一天，用户拍板）
 *
 * 用户截图里她的回复是「真是。拿。你。没。办。法」——**她想接梗**（写成了一行一个字），
 * 但 `cleanMarkdown` 把换行变成了句号，最后挤成一个气泡。
 * 用户拍板「**加，私聊随便玩、群里只在 @她/引用她 时**」：
 *   · 提示词告诉她可以一个字一行回（见 `buildSystemPrompt` 那段）；
 *   · `charPlayParts()` 负责：她真按一个字一行写 → **一行一个气泡**发出去；
 *     写的是正常一整句 → 返回 null，照旧分条。
 *   · 闸：最多 8 个字 / 同会话 30 分钟一次 / 群里必须有明确召唤。【11】【12】盯这些。
 *
 * ⚠️ 纯单元测试：不起机器人、不连 NapCat、不花钱、不落盘
 *    （直接把 `handle`/`enqueue` 换成计数器，只测 `scheduleHandle` 的攒批时机
 *      与 `charPlayParts` 的判定）
 *
 * 用法: node test/burst.js
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });

// ⚠️ 配置路径必须在 import `src/*` **之前**设好（`config.js` 是加载时读的）
const CFG_REL = 'logs/__test-burst.yml';
writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
    '  apiKey: "sk-test"',
    '  model: test-model',
    // 跟 config.yml 一致的两个窗口（连发那几个旋钮走 config.js 的默认值，
    // 也就是线上那份 config.yml 里写的数）
    'context:',
    '  batch:',
    '    windowMsAtMe: 900',
    '    windowMs: 1200',
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mod = await import('../src/bot.js');
const { config } = await import('../src/config.js');
const { sessionKey } = await import('../src/history.js');
const BotClass = mod.Bot ?? mod.default ?? null;
if (!BotClass) {
  console.log('  ❌ 没找到导出的 Bot 类（测试无法进行）');
  process.exit(1);
}

const B = config.context.batch;
const QUIET = Number(B.burstQuietMs); // 连发模式下的安静窗口
const GAP = Number(B.burstGapMs);
const WIN = Number(B.windowMs);
const WIN_AT = Number(B.windowMsAtMe);
// 造一条消息用的辅助（间隔要比普通窗口大、比连发窗口小 —— 这才是截图里的情况）
const STEP = Math.round(WIN * 1.17); // ≈1400ms：旧逻辑必拆，新逻辑该合
const SELF = '10000002';
const uid = '40001';

const textSeg = (t) => ({ type: 'text', data: { text: t } });
const atSeg = (qq) => ({ type: 'at', data: { qq } });
const faceSeg = () => ({ type: 'image', data: { sub_type: 1 } });
const privEv = (segs, userId = uid) => ({ message_type: 'private', user_id: userId, message: segs });
const groupEv = (segs, userId = uid, gid = '200000001') => ({
  message_type: 'group',
  group_id: gid,
  user_id: userId,
  message: segs,
});

/** 把 handle/enqueue 换成计数器，返回一个干净的小机器人 */
function freshBot() {
  const b = new BotClass();
  b.selfId = SELF; // 真连上之后才有，测 @ 那条要用
  const batches = [];
  // ⚠️ `enqueue` 的替身必须**照抄真货 finally 里那段"收摊"**：
  //    `batchState.running` 不复位的话，下一条消息会被当成"正在生成中"攒进 items
  //    永远排空不了（这个替身写错时，【6】就是这么假失败的）。
  b.enqueue = async (event) => {
    batches.push(event);
    const k = sessionKey(event);
    const st = b.batchState?.get(k);
    if (st) {
      if (!st.items.length) b.batchState.delete(k);
      else {
        st.running = false;
        st.pending = false;
        b.flushPendingGroup(k);
      }
    }
  };
  b.handle = async (event) => {
    batches.push(event);
  };
  return { b, batches };
}
/** 按节奏连发一串（每条间隔 STEP，模拟手打一个字） */
async function burst(b, evs, step = STEP) {
  for (let i = 0; i < evs.length; i++) {
    if (i) await sleep(step);
    b.scheduleHandle(evs[i]).catch(() => {});
  }
}

console.log('\n【1】配置旋钮确实读到了（config.yml / config.js 的默认值）');
{
  console.log(
    `     碎片阈值 ${B.burstShortChars} 字 · 安静窗口 ${QUIET}ms · 同串间隔 ${GAP}ms · ` +
      `上限 ${B.burstMaxMs}ms`,
  );
  check(Number(B.burstShortChars) >= 1, 'burstShortChars 有效');
  check(QUIET > WIN, `★ 连发的安静窗口(${QUIET}ms) > 普通窗口(${WIN}ms)`);
  check(GAP > WIN, `★ 判定「同一串」的间隔(${GAP}ms) > 普通窗口(${WIN}ms)`);
}

console.log('\n【2】★ 私聊：一个字一个字连发 → 整串只处理一次（图一那个 bug）');
{
  const { b, batches } = freshBot();
  const chars = ['你', '可', '以', '一'];
  await burst(
    b,
    chars.map((c) => privEv([textSeg(c)])),
  );
  check(batches.length === 0, `还在连发时不抢答（现在 ${batches.length} 批）`);
  await sleep(QUIET + 900);
  check(batches.length === 1, `★ 4 条合成 1 批（旧逻辑会是 4 批）`, `实际 ${batches.length} 批`);
  const segs = batches[0]?.message ?? [];
  check(segs.length === 4, '4 条的正文都在同一批里（内容没丢）', `实际 ${segs.length} 段`);
  check(
    segs.map((s) => s.data?.text).join('') === '你可以一',
    '拼起来就是他那句话',
    segs.map((s) => s.data?.text).join(''),
  );
  check(batches[0]?._charBurst === true, '★ 打上了「一个字一条」的标记（提示词会告诉她可以玩这个梗）');
}

console.log('\n【3】★ 群里连发（没 @ 她、没点名）→ 同样只处理一次');
{
  const { b, batches } = freshBot();
  await burst(
    b,
    ['一', '个', '字'].map((c) => groupEv([textSeg(c)])),
  );
  await sleep(QUIET + 900);
  check(batches.length === 1, '★ 3 条合成 1 批', `实际 ${batches.length} 批`);
  check((batches[0]?.message ?? []).length === 3, '3 条正文都在（合并跨消息，不只留最后一条）');
}

console.log('\n【4】★ 正常一句话**不许**被拖慢（还是老窗口）');
{
  const { b, batches } = freshBot();
  b.scheduleHandle(privEv([textSeg('服务器现在几个人在线啊')])).catch(() => {});
  await sleep(WIN - 300);
  check(batches.length === 0, `普通长度的话，${WIN}ms 窗口没到之前不处理`);
  await sleep(400 + 300);
  check(batches.length === 1, `★ ${WIN}ms 左右就处理了（没有傻等 ${QUIET}ms）`, `实际 ${batches.length} 批`);
}

console.log('\n【5】★ @ 她的碎片也不放宽（明确提问，人在等答案）');
{
  const { b, batches } = freshBot();
  // 「@她 你」—— 碎片，但因为是 @ 她，仍然走短窗口
  b.scheduleHandle(groupEv([atSeg(SELF), textSeg('你')])).catch(() => {});
  await sleep(WIN_AT + 500);
  check(batches.length === 1, `★ ${WIN_AT}ms 左右就处理了（走短窗口）`, `实际 ${batches.length} 批`);
}

console.log('\n【6】隔久了算新的一串（不能把两句话永远粘在一起）');
{
  const { b, batches } = freshBot();
  b.scheduleHandle(privEv([textSeg('你')])).catch(() => {});
  await sleep(QUIET + 900);
  check(batches.length === 1, '第一串自己处理了');
  b.scheduleHandle(privEv([textSeg('好')])).catch(() => {});
  await sleep(QUIET + 900);
  check(batches.length === 2, '★ 后来那句另起一批（没有并进上一批）', `实际 ${batches.length} 批`);
}

console.log('\n【7】纯表情/纯图也算碎片（截图里就是一串表情）');
{
  const { b, batches } = freshBot();
  await burst(
    b,
    [faceSeg(), faceSeg(), faceSeg()].map((s) => privEv([s])),
  );
  await sleep(QUIET + 900);
  check(batches.length === 1, '★ 3 张表情合成 1 批', `实际 ${batches.length} 批`);
  check((batches[0]?.message ?? []).length === 3, '3 段都在');
}

console.log('\n【11】★ 「一个字一条」的彩蛋：判定（私聊随便玩 / 群里要有召唤）');
{
  const b = new BotClass();
  const L = (arr) => arr.join('\n');
  const dm = (id) => ({ message_type: 'private', user_id: id, message: [], _charBurst: true });
  const gp = { message_type: 'group', group_id: '200000001', user_id: uid, message: [], _charBurst: true };

  const p1 = b.charPlayParts(dm('40101'), { hit: 'private' }, L(['真', '是', '拿', '你', '没', '办', '法']));
  check(Array.isArray(p1) && p1.length === 7, '私聊 + 一个字一行 ×7 → 切成 7 条', JSON.stringify(p1));
  check(p1?.[0] === '真' && p1?.[6] === '法', '顺序没乱、字没丢');
  const p2 = b.charPlayParts(dm('40102'), { hit: 'private' }, L(['真。', '是。', '拿。']));
  check(p2?.join('') === '真是拿', '每行带句号也认（句号剥掉）', JSON.stringify(p2));
  check(
    b.charPlayParts(dm('40103'), { hit: 'private' }, '真是拿你没办法') === null,
    '★ 正常写一整句 → 不切（玩不玩这个梗由她自己决定）',
  );
  check(
    b.charPlayParts(dm('40104'), { hit: 'private' }, L(['拿', '你'])) === null,
    '只有 2 行 → 不切',
  );
  check(
    b.charPlayParts(dm('40105'), { hit: 'private' }, L('一二三四五六七八九'.split(''))) === null,
    '9 行 > max 8 → 不切（防刷屏）',
  );
  check(
    b.charPlayParts(gp, { hit: 'voluntary:chat' }, L(['拿', '你', '没'])) === null,
    '★ 群里主动接话 → 不切（没明确召唤不许刷屏）',
  );
  check(
    Array.isArray(b.charPlayParts(gp, { hit: 'at' }, L(['拿', '你', '没']))),
    '★ 群里 @她/引用她 → 可以切',
  );
  check(
    b.charPlayParts(dm('40106'), { hit: 'private' }, L(['拿', '你', '没'])).length === 3 &&
      b.charPlayParts(dm('40106'), { hit: 'private' }, L(['好', '吧', '行'])) === null,
    '★ 同一个会话 30 分钟内第二次 → 不切（防刷屏）',
  );
  check(
    b.charPlayParts(
      { message_type: 'private', user_id: '40107', message: [] },
      { hit: 'private' },
      L(['拿', '你', '没']),
    ) === null,
    '对方不是「一个字一条」→ 不切（她不会无缘无故这么发）',
  );
}

console.log('\n【12】★ 「一个字一条」的标记：只有真的一个字一条才打');
{
  const { b, batches } = freshBot();
  await burst(
    b,
    ['服务器现在几个人', '我想进去玩', '卡不卡'].map((t) => privEv([textSeg(t)])),
    500,
  );
  await sleep(WIN + 1500);
  check(batches.length === 1, '3 条长消息在窗口内合成 1 批');
  check(!batches[0]?._charBurst, '★ 没被打上「一个字一条」（她不会莫名其妙玩这个梗）');
}

console.log('\n【8】代码层：这两处别再被改回去');
{
  const src = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    /const chatType = String\(event\.message_type \?\? ''\)[\s\S]{0,160}?chatType !== 'private'/.test(src),
    '★ 私聊放进了合并（不再是 `message_type !== \'group\'` 直接放行）',
  );
  check(
    /isFragment[\s\S]{0,400}?waitMs = quietMs/.test(src),
    '★ 碎片续窗那段还在（`isFragment` → `waitMs = quietMs`）',
  );
  check(
    /if \(!capped && isFragment && !atMe && !hasReply && quietMs > waitMs\)/.test(src),
    '★ @她/引用她 与 上限（capped）都没被绕过',
  );
  check(
    /this\.charPlayParts\(event, decision, rawReplyText\)/.test(src),
    '★ 发送路径接了「一个字一条」的彩蛋（一行一个气泡）',
  );
  // ★★ 2026-09-18 用户截图：她引用了小泥的「而且只要二十多」，正文回的却是 @她的那位。
  //    根因是合并批次时拿"最后一条"当当前消息（`回复时引用它`），
  //    而叫她的那条往往不是最后一条（她生成时别人又插话）。
  check(
    /const caller = \[\.\.\.items\]\.reverse\(\)\.find\(callsMe\) \?\? last/.test(src),
    '★★ 合并批次时**优先拿"叫她的那条"当当前消息**（引用才会挂对人）',
  );
  check(
    /msg\.isAt\(segs, this\.selfId\)[\s\S]{0,80}?this\.isQuoteOfMe\(e, segs\)/.test(src),
    '★ 判据是「@她 / 引用她」两种',
  );
  check(
    /【他在一个字一个字跟你说话】/.test(src) && /event\._charBurst/.test(src),
    '★ 提示词那段（可以一个字一行回）与 `_charBurst` 标记都还在',
  );
}

console.log(
  failures === 0
    ? '\n结果: 全部通过 ✅（连发碎片现在整串只回一次；正常消息没变慢）\n'
    : `\n结果: ${failures} 项失败 ❌\n`,
);
process.exit(failures === 0 ? 0 : 1);
