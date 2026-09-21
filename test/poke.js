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
    // ⚠️ 2026-09-21：那行改成多行了（`text` 要按有没有动作文案分两种写法），
    //    所以改成**跨行**匹配 —— 只认「进了 recent 且标了 isAtMe」这个事实，
    //    不去钉它那一行的具体写法（钉写法会让这条断言变脆）。
    /recent\.remember\(fakeEvent, \{[\s\S]{0,220}?isAtMe: true/.test(src),
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
  check(/有上文时就着上文回/.test(sys), '★ 要求有上文时接上文（进上下文的意义就在这）');
  // ⚠️ 2026-09-21 用户要求「平均长度缩短，但不要把语气词也压缩了」——
  //    下面三条盯住它的两半：给死字数（免得模型自由发挥）、保住语气词、
  //    堵住"为了短改成书面说法"这条歪路。
  check(/15 个字/.test(sys), '★ 给了字数上限（15 个字；一开始写的 4~10 用户嫌太短）');
  check(/语气词/.test(sys) && /一个都不许省/.test(sys), '★ 明说"语气词一个都不许省"（用户原话）');
  check(/书面说法/.test(sys), '　也堵住了改成书面说法那条歪路（"请不要捏我"）');
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

console.log('\n【8】★ 认得出他用的动作文案（用户 2026-09-21 问的「捏一捏」）');
{
  // ⚠️ SnowLuma 的形状：它把动作随事件一起传（见 `bot.js` 里 `pokeBack` 那段注释）：
  //    notice(…, { action:'捏', suffix:'一捏' }) → QQ 上显示的就是「捏一捏」。
  const { b, routed } = freshBot();
  await b.pokeBack({ ...notice('40051', SELF, GID), action: '捏', suffix: '一捏' });
  check(routed.length === 1, '带文案的戳 → 照常走模型');
  const ev = routed[0]?.event;
  check(
    ev?._pokeText === '捏一捏',
    '★ 动作文案拼出来了（action + suffix = 「捏一捏」）',
    JSON.stringify(ev?._pokeText),
  );
  const sys = b.buildSystemPrompt('', ev, null, '[戳一戳]');
  check(sys.includes('捏一捏'), '★ 提示词里带了「捏一捏」（她才知道他是捏、不是拍）');
  check(!sys.includes('伸手戳了你一下'), '★ 有文案时不再用那句通用的"伸手戳了你一下"');

  // NapCat 那一类把动作放在 `raw_info.action` 里的格式也要认
  const { b: b2, routed: r2 } = freshBot();
  await b2.pokeBack({
    ...notice('40052', SELF, GID),
    raw_info: { action: '拍了拍', suffix: '我的小脑袋' },
  });
  check(
    r2[0]?.event?._pokeText === '拍了拍我的小脑袋',
    '★ 另一种格式（raw_info.action）也认',
    JSON.stringify(r2[0]?.event?._pokeText),
  );

  // 协议端没给文案 → **不许瞎编**，退回原来那句通用的
  const { b: b3, routed: r3 } = freshBot();
  await b3.pokeBack(notice('40053', SELF, GID));
  check(!r3[0]?.event?._pokeText, '★ 没给文案 → 事件上就没这个字段（不瞎编）');
  const sys3 = b3.buildSystemPrompt('', r3[0].event, null, '[戳一戳]');
  check(sys3.includes('伸手戳了你一下'), '★ 没文案时退回原来那句通用的');

  // ⚠️ 光在入口读到还不够：**"合并成一批"的两处**也要带上，
  //    不然他先打字、再戳一下（并成一批）时文案就又丢了。
  const src = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const spots = [...src.matchAll(/_poke: true, \.\.\.\(/g)].length;
  check(spots === 2, '★ 两处合并都带上了文案（`scheduleHandle` + 生成期间重来那条）', `${spots} 处`);
}

console.log('\n【9】★ 按协议端决定要不要"拍回去"（用户 2026-09-21 要求）');
{
  // ⚠️ 背景：NapCat 时代"一律不发包"，因为它的 `send_poke` 走 PacketBackend、
  //    而用户的 QQ 版本越界 ⇒ 每次必然失败 ⇒ 每次失败都是一次风控证据。
  //    SnowLuma 是**独立协议实现**，`send_poke` 是它自己 action 表里的一个
  //    （`params: { user_id, group_id? }`，和我们调用格式一致）⇒ 可以发。
  const keepProvider = config.provider.name;
  const keepTry = config.poke.tryPacket;
  const keepPer = config.poke.countPerBack;
  // ⚠️⚠️ 这条是"按协议端默认"能成立的前提，也是我踩过的坑的守门断言：
  //    `config.js` 原来把 tryPacket 归一化成 `=== true`，于是"没配置"和
  //    "显式关掉"分不开 → snowluma 下也永远不发包
  //    （用户真戳了一下：日志里既没有"拍回去了"也没有"拍回去没成"）。
  check(
    config.poke.tryPacket === undefined,
    '★ 没配 `poke.tryPacket` 时它保持 undefined（= 按协议端默认），不许被归一化压成 false',
    JSON.stringify(config.poke.tryPacket),
  );
  try {
    // ⚠️ 这一节只验"能不能发"，所以把次数设成 1（每戳必拍）；
    //    真正的"每 3 次一次"在【10】里验。
    config.poke.countPerBack = 1;
    // ① SnowLuma → 默认就拍回去
    const { b, routed } = freshBot();
    const calls = [];
    b.call = async (action, params) => {
      calls.push({ action, params });
      return { message_id: 1 };
    };
    config.provider.name = 'snowluma';
    delete config.poke.tryPacket;
    await b.pokeBack(notice('40061', SELF, GID));
    check(
      calls.length === 1 && calls[0].action === 'send_poke',
      '★ snowluma → 默认拍回去（调 `send_poke`）',
      JSON.stringify(calls.map((c) => c.action)),
    );
    check(
      calls[0]?.params?.user_id === '40061' && calls[0]?.params?.group_id === GID,
      '★ 参数形状对（user_id + group_id，和它 action 表的定义一致）',
      JSON.stringify(calls[0]?.params),
    );
    check(
      routed.length === 1,
      '★★ 拍回去之后**照样**回话（用户要求「还是直接和之前一样给回复好一点」）',
    );
    // 私聊：不带 group_id（它自己路由）
    await b.pokeBack(notice('40065', SELF));
    check(
      calls[1]?.params?.group_id === undefined && calls[1]?.params?.user_id === '40065',
      '★ 私聊不带 group_id（交给它自动路由）',
      JSON.stringify(calls[1]?.params),
    );

    // ② NapCat → 默认不发，走文字（老规矩）
    const { b: b2, routed: r2 } = freshBot();
    const calls2 = [];
    b2.call = async (action, params) => {
      calls2.push({ action, params });
      return {};
    };
    config.provider.name = 'napcat';
    await b2.pokeBack(notice('40062', SELF, GID));
    check(calls2.length === 0, '★ napcat → 默认不发（走 PacketBackend 必然失败，别送风控证据）');
    check(r2.length === 1, '　不发包时仍然交给她用文字回（老行为没丢）');

    // ③ 显式 true 能覆盖（napcat 也照发）
    const { b: b3 } = freshBot();
    const calls3 = [];
    b3.call = async (action, params) => {
      calls3.push({ action, params });
      return {};
    };
    config.provider.name = 'napcat';
    config.poke.tryPacket = true;
    await b3.pokeBack(notice('40063', SELF, GID));
    check(calls3.length === 1, '★ 显式 `poke.tryPacket: true` 能覆盖（napcat 也照发）');

    // ④ 拍回去失败 → **不影响**文字回应（不许静默丢掉）
    const { b: b4, routed: r4 } = freshBot();
    b4.call = async () => {
      throw new Error('不支持的 Action: send_poke');
    };
    config.provider.name = 'snowluma';
    delete config.poke.tryPacket;
    await b4.pokeBack(notice('40064', SELF, GID));
    check(r4.length === 1, '★ 拍回去失败也照样回话（不静默丢掉）');
  } finally {
    config.provider.name = keepProvider;
    if (keepTry === undefined) delete config.poke.tryPacket;
    else config.poke.tryPacket = keepTry;
    config.poke.countPerBack = keepPer;
  }
}

console.log('\n【10】★ 拍回去是「每戳 3 次一次」（用户 2026-09-21 要求）');
{
  // ⚠️ 用户原话：「机器人戳回来的话**在我戳了3次再触发一次**就行了」。
  //    所以是第 3、6、9… 次各拍一次（拍完归零），**不是**"从第 3 次起每次都拍"。
  const keepProvider = config.provider.name;
  const keepTry = config.poke.tryPacket;
  const keepPer = config.poke.countPerBack;
  try {
    config.provider.name = 'snowluma';
    delete config.poke.tryPacket;
    config.poke.countPerBack = 3;
    const { b, routed } = freshBot();
    const calls = [];
    b.call = async (a, p) => {
      calls.push({ a, p });
      return {};
    };
    const uid = '40071'; // 用一个没被别的断言碰过的号
    await b.pokeBack(notice(uid, SELF, GID));
    check(calls.length === 0, '第 1 次戳 → 只回话，不拍');
    await b.pokeBack(notice(uid, SELF, GID));
    check(calls.length === 0, '第 2 次戳 → 还是不拍（没到 3）');
    await b.pokeBack(notice(uid, SELF, GID));
    check(calls.length === 1, '★ 第 3 次戳 → 拍回去一次');
    await b.pokeBack(notice(uid, SELF, GID));
    check(calls.length === 1, '第 4 次戳 → 计数归零，不拍');
    await b.pokeBack(notice(uid, SELF, GID));
    await b.pokeBack(notice(uid, SELF, GID));
    check(calls.length === 2, '★ 第 6 次戳 → 又拍一次（"每 3 次一次"，不是"第 3 次起每次都拍"）');
    // ⚠️ 计数**不受冷却影响**是这条功能能用的前提：他是为了试它才连戳三下的。
    //    这里连戳 6 下、文字只回了 1 次（30 秒冷却，那是原来就有的行为），
    //    但拍回去照样在第 3、6 次触发 ✓
    check(routed.length === 1, '★ 文字回应的冷却照旧（连戳 6 下只回 1 次话），但计数照记');
  } finally {
    config.provider.name = keepProvider;
    if (keepTry === undefined) delete config.poke.tryPacket;
    else config.poke.tryPacket = keepTry;
    config.poke.countPerBack = keepPer;
  }
}

console.log(
  failures === 0
    ? '\n结果: 全部通过 ✅（戳一戳：认得动作文案、照样回话、每 3 次回拍一次、防刷屏和兜底都在）\n'
    : `\n结果: ${failures} 项失败 ❌\n`,
);
process.exit(failures === 0 ? 0 : 1);
