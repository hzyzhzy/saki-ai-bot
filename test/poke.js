/**
 * 「戳一戳交给模型回」测试（2026-09-16）。
 *
 * ## 用户报的问题
 *
 *   「把**戳一戳返回的消息**也加入 llm 和上下文，要不然**戳一下总是回那几句话**」
 *
 * 原来是 `pokeBack()` 里**代码随机挑一句写死的**：
 *
 * ```js
 * const line = ['干嘛', '别戳了', '嗯？', '有事说事'][Math.floor(Math.random() * 4)];
 * ```
 *
 * 两个毛病：① 戳两次就发现永远是这四句；② **完全没看上下文** ——
 * 她不知道刚才在聊什么、是谁在戳、跟这个人什么关系。
 *
 * ## 改后
 *
 * 一次戳 = 一条**带 `[戳一戳]` 正文的假消息**，走完整条路：
 *   · `decide()` 里 `_poke` 直接算「明确召唤」（不看灵敏度档位、不看关键词）
 *   · `mustReply` 也带上 `poke`（不被 2 秒触发冷却咽掉）
 *   · 提示词里带着**群里最近上下文** + 好感度 + 跟他的关系，还专门有一段
 *     【他戳了你一下】告诉她"那是什么、怎么回才不像客服"
 *   · 回答进记忆（`history.remember`），也写进 `recent`（后面别人说话能看到）
 *   · 原来那四句只在 `poke.useLLM: false` 时才用
 *
 * ⚠️ 纯单元测试：不起机器人、不连 NapCat、不花钱
 *    （`scheduleHandle` / `sendText` 都换成计数器）
 *
 * 用法: node test/poke.js
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });

// ⚠️ 配置路径必须在 import `src/*` **之前**设好（`config.js` 是加载时读的）
const CFG_REL = 'logs/__test-poke.yml';
writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
    '  apiKey: "sk-test"',
    '  model: test-model',
    // ⚠️ 故意设成 3 档（只回 @ 她的）—— 用来证明**戳一戳不看档位也该接**
    'trigger:',
    '  respondTo: 3',
    '  allowGroups: []',
    'poke:',
    '  enable: true',
    '  useLLM: true',
    '  cooldownMs: 30000',
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

const mod = await import('../src/bot.js');
const { config } = await import('../src/config.js');
const BotClass = mod.Bot ?? mod.default ?? null;
if (!BotClass) {
  console.log('  ❌ 没找到导出的 Bot 类（测试无法进行）');
  process.exit(1);
}

const GID = '200000001';
const SELF = '10000002';
const textSeg = (t) => ({ type: 'text', data: { text: t } });

/** 一个干净的小机器人：把"有没有真的去生成"换成计数器 */
function freshBot() {
  const b = new BotClass();
  b.selfId = SELF;
  const routed = []; // scheduleHandle 收到的（= 真要走模型）
  const texts = []; // sendText 直接发出去的（= 老写法那几句）
  b.scheduleHandle = async (event, meta) => {
    routed.push({ event, meta });
  };
  b.sendText = async (event, text) => {
    texts.push(text);
    return text;
  };
  return { b, routed, texts };
}

const notice = (uid, target, gid) => ({
  post_type: 'notice',
  notice_type: 'notify',
  sub_type: 'poke',
  user_id: uid,
  target_id: target,
  ...(gid ? { group_id: gid } : {}),
});

console.log('\n【1】先认得出「这是有人在戳我」');
{
  const { b } = freshBot();
  check(b.isPokeAtMe(notice('40001', SELF, GID)) === true, '群里有人戳她 → 认出来');
  check(b.isPokeAtMe(notice('40001', SELF)) === true, '私聊戳她 → 认出来');
  check(b.isPokeAtMe(notice('40001', '99999', GID)) === false, '戳的是别人 → 不接');
  check(b.isPokeAtMe(notice(SELF, SELF, GID)) === false, '自己戳自己（客户端回显）→ 不接');
  check(b.isPokeAtMe({ post_type: 'message' }) === false, '普通消息不是戳一戳');
}

console.log('\n【2】★ 戳一戳 = 明确召唤（3 档群也接，因为他是冲着她戳的）');
{
  const { b } = freshBot();
  const pokeEv = {
    message_type: 'group',
    group_id: GID,
    user_id: '40001',
    message: [textSeg('[戳一戳]')],
    _poke: true,
  };
  const plainEv = {
    message_type: 'group',
    group_id: GID,
    user_id: '40001',
    message: [textSeg('今天天气不错')],
  };
  const d1 = b.decide(pokeEv);
  const d2 = b.decide(plainEv);
  check(d1?.hit === 'poke', '★ 戳一戳 → hit = poke（不看档位）', JSON.stringify(d1?.hit));
  check(d2 === null, '★ 对照：同一档位下的普通闲聊仍然不接（证明不是档位松了）');
  const src = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    /const mustReply =[\s\S]{0,400}?hit === 'poke'/.test(src),
    '★ 它在 `mustReply` 里（不会被 2 秒触发冷却咽掉）',
  );
}

console.log('\n【3】★ 真的走模型了（不再随机挑那四句）');
{
  const { b, routed, texts } = freshBot();
  await b.pokeBack(notice('40011', SELF, GID));
  check(routed.length === 1, '戳一下 → 交给 `scheduleHandle`（= 走模型那条路）', `${routed.length} 次`);
  check(texts.length === 0, '★ 没有直接甩那四句写死的文字');
  const ev = routed[0]?.event;
  check(ev?._poke === true, '事件带 `_poke` 标记（提示词靠它加那段说明）');
  check(
    ev?.message?.[0]?.data?.text === '[戳一戳]',
    '正文是 `[戳一戳]`（她看得见"这是戳，不是打字"）',
    JSON.stringify(ev?.message?.[0]?.data?.text),
  );
  check(routed[0]?.meta?.poke === true, 'meta 也带了 poke（给调度层看）');
  check(!('isAtMe' in (ev ?? {})), '没往事件上乱塞字段');
}

console.log('\n【4】上下文 / 记忆真的接上了');
{
  const src = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    /recent\.remember\(fakeEvent, \{ text: '\[戳一戳\]'/.test(src),
    '★ 也进了 `recent`（后面别人说话时上下文里能看到"他刚才戳过你"）',
  );
  check(
    /if \(event\._poke\) \{[\s\S]{0,120}?hit: 'poke'/.test(src),
    '★ `decide()` 里那条 poke 分支还在',
  );
  // 提示词那段：告诉她"那是什么、怎么回"
  const { b } = freshBot();
  const sys = b.buildSystemPrompt(
    '',
    { message_type: 'group', group_id: GID, user_id: '40011', _poke: true },
    null,
    '[戳一戳]',
  );
  check(sys.includes('【他戳了你一下】'), '提示词里有【他戳了你一下】那一段');
  check(sys.includes('戳一戳'), '提示词里说清了那是 QQ 的戳一戳');
  check(/别老用同一句/.test(sys), '★ 明确说了"别老用同一句"（用户的原话）');
  check(/看着上文回/.test(sys), '★ 要求看着上文回（进上下文的意义就在这）');
  const sysPlain = b.buildSystemPrompt(
    '',
    { message_type: 'group', group_id: GID, user_id: '40011' },
    null,
    '你好',
  );
  check(!sysPlain.includes('【他戳了你一下】'), '普通消息不会带上这一段（对照）');
}

console.log('\n【5】防刷屏的冷却还在（同一个号 30 秒一次）');
{
  const { b, routed, texts } = freshBot();
  await b.pokeBack(notice('40021', SELF, GID));
  await b.pokeBack(notice('40021', SELF, GID));
  check(routed.length === 1 && texts.length === 0, '★ 30 秒内戳两次 → 只回一次', `${routed.length} 次`);
  await b.pokeBack(notice('40022', SELF, GID));
  check(routed.length === 2, '换个人戳 → 照常回（冷却按人算）');
}

console.log('\n【6】关掉开关 / 没开开关时仍然有兜底');
{
  const { b, routed, texts } = freshBot();
  config.poke.useLLM = false;
  await b.pokeBack(notice('40031', SELF, GID));
  config.poke.useLLM = true; // 马上改回来，别影响后面的断言
  check(routed.length === 0, 'useLLM=false → 不走模型');
  check(texts.length === 1, '★ 老写法还留着（随机挑一句，作为兜底）', JSON.stringify(texts));

  const { b: b2, routed: r2, texts: t2 } = freshBot();
  config.poke.enable = false;
  await b2.pokeBack(notice('40032', SELF, GID));
  config.poke.enable = true;
  check(r2.length === 0 && t2.length === 0, 'poke.enable=false → 完全不响应');
}

console.log('\n【7】不在白名单的群仍然不接（客服模式的边界没被绕过）');
{
  const { b, routed, texts } = freshBot();
  const keep = config.trigger.allowGroups;
  config.trigger.allowGroups = ['123456789'];
  await b.pokeBack(notice('40041', SELF, '999888777'));
  config.trigger.allowGroups = keep;
  check(routed.length === 0 && texts.length === 0, '群不在 allowGroups → 戳了也不回');
}

console.log(
  failures === 0
    ? '\n结果: 全部通过 ✅（戳一戳现在带上下文交给模型回；防刷屏和兜底都还在）\n'
    : `\n结果: ${failures} 项失败 ❌\n`,
);
process.exit(failures === 0 ? 0 : 1);
