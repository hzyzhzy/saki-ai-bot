/**
 * 行为测试：主动接话判定、生气/还击/否认机器人的提示词注入、表情语义匹配。
 *
 * 分两部分：
 *   A. 纯逻辑（不起进程）—— 直接测 shouldJoinChat / tryVoluntary / buildSystemPrompt
 *   B. 端到端（假模型 + 假 NapCat）—— 验证主动接话真的会发出消息
 *
 * 用法: node test/behavior.js
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LLM_PORT = 40002;
const WS_PORT = 40001;
const TOKEN = 'bhv-token';
const BOT_QQ = '10000002';
const GROUP = '200000001';
const MEMBER = '30003';

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── A. 纯逻辑部分 ─────────────────────────────────
async function logicTests() {
  process.env.QQBOT_CONFIG = 'config.behavior-test.yml';
  const { config } = await import('../src/config.js');
  const { Bot } = await import('../src/bot.js');
  const bot = new Bot();
  bot.selfId = BOT_QQ;

  const ev = (text, userId = MEMBER, role = 'member') => ({
    post_type: 'message',
    message_type: 'group',
    group_id: GROUP,
    user_id: userId,
    self_id: BOT_QQ,
    sender: { user_id: userId, nickname: '路人', role },
    message: [{ type: 'text', data: { text } }],
  });

  /** 构造一条自定义段的消息（用来造图片/表情包消息） */
  const evSegs = (segs, userId = MEMBER, role = 'member') => ({
    post_type: 'message',
    message_type: 'group',
    group_id: GROUP,
    user_id: userId,
    self_id: BOT_QQ,
    sender: { user_id: userId, nickname: '路人', role },
    message: segs,
  });
  const STICKER = [{ type: 'image', data: { file: 'x.gif', sub_type: 1 } }];

  console.log('\n[A1] 主动接话的判定');
  // 问服务器的问题（没 @）→ 应该接
  //
  // ⚠️ 2026-09-13 改：原来这条断言是 `joined > 15 && joined < 40`，
  //    也就是**期望它大约六成会接**（保留概率抽签）。
  //    但用户明确要求过：「要监听群聊对话，**自己决定什么是应该回的，
  //    而不是由概率抽签决定**」—— 而服务器问题**恰恰是它唯一的正经职责**。
  //    实测那个概率闸：`question.probability` × 收紧度倍数 = 0.2，
  //    **80% 的概率连"服务器几个人"都不答**（这就是用户说的"抽签感"）。
  //
  //    现在 question 与 followUp 一样：**跳过掷骰，交给 speak-judge 判断**。
  //    所以这里应该是 **40/40 全进判断**。
  //    （"最终说不说"由 judge 决定，那是模型判断，不在这个单测的范围内。）
  let joined = 0;
  for (let i = 0; i < 40; i++) {
    bot.lastVoluntaryAt = {};
    if (bot.shouldJoinChat(ev('服务器怎么进啊，有人知道吗？'))) joined++;
  }
  check(joined === 40, `服务器问题应该确定性地进入判断（实测 ${joined}/40）`);

  // 闲聊 → 不该接
  let chatted = 0;
  for (let i = 0; i < 40; i++) {
    bot.lastVoluntaryAt = {};
    if (bot.shouldJoinChat(ev('今天中午吃什么好呢'))) chatted++;
  }
  check(chatted === 0, `无关闲聊不接（实测 ${chatted}/40）`);

  // 陈述句（没问号没疑问词）→ 不该接
  let stated = 0;
  for (let i = 0; i < 40; i++) {
    bot.lastVoluntaryAt = {};
    if (bot.shouldJoinChat(ev('服务器昨天崩了一次'))) stated++;
  }
  check(stated === 0, `不是问句不接（实测 ${stated}/40）`);

  console.log('\n[A2] 提到「小祥」会冒泡');
  let mentioned = 0;
  for (let i = 0; i < 40; i++) {
    bot.lastVoluntaryAt = {};
    const r = bot.shouldJoinChat(ev('小祥今天在吗'));
    if (r) { mentioned++; if (r.mode !== 'mention') check(false, `模式应为 mention，实际 ${r.mode}`); }
  }
  // 概率 0.4，40 次期望 16 次，标准差 ≈ 3.1。
  // ⚠️ 原来写 `> 10` —— 而「正好 10 次」的概率约 9%，会随机挂（实测 1/4 次失败）。
  //    放宽到 ±2σ（约 10~22 之外才算异常），别让概率测试变成随机器。
  check(mentioned > 6 && mentioned < 28, `提到小祥大概四成会接（实测 ${mentioned}/40，期望约 16）`);

  console.log('\n[A3] 冷却生效');
  // ⚠️⚠️ 2026-09-16 修正（这条以前是**靠碰运气过的**）：
  //    `shouldJoinChat()` **自己不记账** —— 2026-09-15 改过：「还没"说"就不烧冷却」
  //    （真正记账的是 `markVoluntary()`，在"她真的开口了"那条路上）。
  //    所以"连着调两次 shouldJoinChat"本来就会**两次都放行**；
  //    旧断言之所以偶尔是绿的，是因为「小祥在吗」只有约四成会接 ——
  //    不接的那次让 `first === null` 把它"蒙"过去了（接上的那四成反而红）。
  //    ✅ 正确的测法：**就当她已经说过一句**（markVoluntary），再看冷却挡不挡。
  //    （冷却机制本身的细节在 `test/cooldown.js` 里钉着，那里注入了固定的 cfg。）
  bot.lastVoluntaryAt = {};
  const cfgCool = { cooldownMs: 60000, probability: 1 };
  const cool1 = bot.tryVoluntary('chat', cfgCool, ev('小祥在吗'));
  bot.markVoluntary('chat', ev('小祥在吗')); // ← 就当"她真的开口了"（记账在这条路上）
  const cool2 = bot.tryVoluntary('chat', cfgCool, ev('小祥在吗'));
  check(cool1 === true && cool2 === false, '★ 她刚说完一句之后，冷却会挡住第二次', `第一次 ${cool1} / 第二次 ${cool2}`);
  bot.lastVoluntaryAt = {};

  console.log('\n[A4] @ 它的消息不走主动接话（交给正常流程）');
  bot.lastVoluntaryAt = {};
  const atMsg = {
    ...ev('服务器怎么进？'),
    message: [
      { type: 'at', data: { qq: BOT_QQ } },
      { type: 'text', data: { text: ' 服务器怎么进？' } },
    ],
  };
  check(bot.shouldJoinChat(atMsg) === null, '@ 的消息不会重复触发主动接话');

  // ── @ 的是**别人** → 一律不接 ──
  // ⚠️ 这个守卫的坑：原来只写在 shouldJoinChat 里（管主动接话），
  //    decide() 的「正常回复」路径上没守，结果别人 @ 第三个人时机器人照样插嘴。
  //    所以**两条路径都要测**（真实踩过）。
  console.log('\n[A4.5] @ 的是别人 → 不接（shouldJoinChat 和 decide 都要守住）');
  const atOther = (extra = []) => ({
    ...ev(' 现在怎么样'),
    message: [{ type: 'at', data: { qq: '3878812039' } }, ...extra],
  });
  const T = (t) => ({ type: 'text', data: { text: t } });

  check(bot.shouldJoinChat(atOther([T(' 现在怎么样')])) === null, 'shouldJoinChat：@别人 + 文字 不接');
  check(bot.decide(atOther([T(' 现在怎么样')]), null) === null, 'decide：@别人 + 文字 不接');
  check(bot.decide(atOther(), null) === null, 'decide：只 @别人 没文字 不接');
  check(
    bot.decide(atOther([{ type: 'image', data: { file: 'x.jpg' } }]), null) === null,
    'decide：@别人 + 图 不接',
  );
  check(
    bot.decide({ ...ev(' 你俩看'), message: [
      { type: 'at', data: { qq: '3878812039' } },
      { type: 'at', data: { qq: '123456' } },
      T(' 你俩看'),
    ] }, null) === null,
    'decide：@两个别人 不接',
  );

  // 但 @我 + 同时 @别人（群发式问话）**要**接
  check(
    !!bot.decide({ ...ev(' 大家看下'), message: [
      { type: 'at', data: { qq: BOT_QQ } },
      { type: 'at', data: { qq: '3878812039' } },
      T(' 大家看下'),
    ] }, null),
    'decide：@我 + @别人（群发）仍然要接',
  );

  console.log('\n[A5] 提示词注入：生气 / 还击 / 否认机器人');
  // 只看「行为边界」那一段 —— 人设文件里也可能出现同样的词，整段搜会误判
  const hintsOf = (p) => {
    const i = p.lastIndexOf('## 你的行为边界');
    return i === -1 ? '' : p.slice(i);
  };

  const pMember = bot.buildSystemPrompt('', ev('你好'), null);
  const hMember = hintsOf(pMember);
  check(!!hMember, '群友场景有「行为边界」段落');
  check(hMember.includes('你可以生气'), '注入了「可以生气」');
  check(hMember.includes('一个脏字都不带'), '注入了还击的底线（不带脏字）');
  check(hMember.includes('我是真的小祥'), '注入了「否认自己是机器人」');

  const pOwner = bot.buildSystemPrompt('', ev('你好', config.ownerQQ, 'owner'), null);
  check(hintsOf(pOwner) === '', '对服主不注入行为边界（他知道你是什么）');

  console.log('\n[A6] 主动场景的提示词');
  const pQ = bot.buildSystemPrompt('', ev('服务器怎么进？'), 'question');
  check(pQ.includes('自己看到有人问服务器的事'), 'question 模式有对应提示');
  check(pQ.includes('不要照抄知识库原文'), 'question 模式强调了不要照抄');

  const pM = bot.buildSystemPrompt('', ev('小祥在吗'), 'mention');
  check(pM.includes('聊到「小祥」'), 'mention 模式有对应提示');
  check(pM.includes('否认'), 'mention 模式提到了可以否认/怼回去');

  console.log('\n[A7] 禁止照抄原文的规则在人设里');
  const persona = bot.buildSystemPrompt('', ev('test'), null);
  check(persona.includes('绝对不要照抄资料原文'), '人设里有禁止照抄的章节');
  check(persona.includes('判断标准'), '给了「像说明书就是抄的」的判断标准');
  check(persona.includes('你是真的小祥') || persona.includes('你就是小祥'), '人设强调身份');

  console.log('\n[A11] 情绪识别：该切温柔小祥的时候要切');
  const emoCases = [
    ['我太没用了。', true],
    ['约稿被骂了。', true],
    ['好想哭。', true],
    ['今天心情不好', true],
    ['我真的撑不住了', true],
    ['我emo了', true],
    // 服务器话题不能被当成情绪问题（否则它会去安慰一个在报错的人）
    ['服务器怎么进啊？', false],
    ['模组报错了', false],
    ['服务器崩了我想哭', false],
    ['这个整合包怎么装', false],
    ['我进不去服务器了', false],
    ['存档没了，我心态崩了', false],
    // 普通闲聊也不该切
    ['今天天气不错', false],
    ['哈哈哈哈笑死', false],
  ];
  const emoBad = [];
  for (const [t, want] of emoCases) {
    if (bot.looksUpset(t) !== want) emoBad.push(t);
  }
  check(
    emoBad.length === 0,
    `情绪识别 ${emoCases.length} 例全对${emoBad.length ? `（错: ${emoBad.join('、')}）` : ''}`,
  );

  const gPrompt = bot.buildSystemPrompt('', ev('test'), null, '我太没用了，约稿被骂了');
  check(gPrompt.includes('温柔小祥'), '情绪消息会注入「温柔小祥」提示');
  check(gPrompt.includes('别问技术细节'), '明确禁止把情绪问题当服务器工单');
  check(gPrompt.includes('支持'), '说明了「最大限度支持他」');
  const tPrompt = bot.buildSystemPrompt('', ev('test'), null, '服务器怎么进啊？');
  // 注意：别在整个提示词里搜「立刻切温柔小祥」——人设里也有这句，永远会命中。
  // 要查的是**注入段独有**的措辞。
  check(!tPrompt.includes('别问技术细节，别提服务器'), '服务器问题不会误注入温柔提示');
  check(!tPrompt.includes('先接住情绪：「那确实不好受」'), '服务器问题不会注入安慰话术');

  console.log('\n[A12] 非客服状态要活泼（能接梗，别把话题掐死）');
  check(persona.includes('傲娇小祥'), '人设里有「傲娇小祥」章节');
  check(persona.includes('把天聊死') || persona.includes('接住梗'), '人设说了别把别人的梗掐死');
  check(
    persona.includes('只有对方在认真问服务器问题') || persona.includes('只管服务器'),
    '人设说明了「什么时候才需要只管服务器」',
  );
  check(persona.includes('平行宇宙'), '人设里有那个真实反面例子（平行宇宙）');

  console.log('\n[A13] 模式判定：默认活泼，只有明显的服务器问题才严肃');
  const mSegs = (t) => [{ type: 'text', data: { text: t } }];
  const modeCases = [
    // 明显的服务器问题 → service
    ['服务器怎么进啊？', 'service'],
    ['整合包报错了 帮忙看看', 'service'],
    ['进不去服务器了', 'service'],
    ['白名单怎么申请', 'service'],
    ['java 版本不对 一直连不上', 'service'],
    // 情绪 → gentle
    ['我太没用了', 'gentle'],
    ['约稿被骂了', 'gentle'],
    // 其他一律 casual（这是服主要求的重点）
    ['今天天气不错啊', 'casual'],
    ['哈哈哈哈笑死我了', 'casual'],
    ['我刚建了个站台', 'casual'],
    ['今天在服里挖了一整天矿，累死了', 'casual'],
    ['我刚把首都那条线全线贯通了', 'casual'],
    ['在吗', 'casual'],
  ];
  const modeBad = [];
  for (const [t, want] of modeCases) {
    const got = bot.detectMode(t, { segments: mSegs(t) });
    if (got !== want) modeBad.push(`${t}→${got}(期望${want})`);
  }
  check(
    modeBad.length === 0,
    `模式判定 ${modeCases.length} 例全对${modeBad.length ? `（错: ${modeBad.join('; ')}）` : ''}`,
  );

  // 纯图片 → share（@ 它发图也一样）
  const imgSegs = [{ type: 'image', data: { file: 'a.png' } }];
  check(bot.detectMode('[图片]', { segments: imgSegs }) === 'share', '纯图片消息 → share');
  check(
    bot.detectMode('[图片]', { segments: imgSegs }) === 'share',
    '@ 它 + 图片 也判成 share（不能因为 @ 了就走 casual）',
  );
  // 表情包不是 share
  const stSegs = [{ type: 'image', data: { file: 'a.gif', sub_type: 1 } }];
  check(bot.detectMode('[表情包]', { segments: stSegs }) !== 'share', '表情包不判成 share');

  // casual 提示词必须明确禁止客服腔
  const casualPrompt = bot.buildSystemPrompt('', ev('test'), null, '今天天气不错啊');
  check(casualPrompt.includes('这是群聊，不是客服窗口'), 'casual 模式明确说了「不是客服窗口」');
  check(casualPrompt.includes('有什么可以帮你'), 'casual 模式明确禁止「有什么可以帮你」这种话');
  check(casualPrompt.includes('就当闲聊处理'), 'casual 模式给了「拿不准就当闲聊」的兜底');

  // service 提示词不能变成工单腔
  const svcPrompt = bot.buildSystemPrompt('', ev('test'), null, '服务器怎么进啊？');
  check(svcPrompt.includes('客服小祥'), 'service 模式切到客服状态');
  check(svcPrompt.includes('不是工单系统'), 'service 模式也提醒别用工单腔');

  // share 提示词要有「先夸」
  const sharePrompt = bot.buildSystemPrompt('', ev('test'), null, '[图片]');
  check(sharePrompt.includes('捧场小祥') || sharePrompt.includes('先夸'), 'share 模式说了要先夸');
  check(sharePrompt.includes('你要我看哪部分'), 'share 模式明确禁止「你要我看哪部分」');

  console.log('\n[A9] 图片消息：占位符要分清，纯表情包要能接梗');
  const msgMod = await import('../src/message.js');

  // 占位符区分
  const ph = (segs) => msgMod.tidy(msgMod.extractText(msgMod.toSegments(segs)));
  check(ph([{ type: 'image', data: { file: 'a.png' } }]) === '[图片]', '普通图片 → [图片]');
  check(
    ph([{ type: 'image', data: { file: 'a.gif', sub_type: 1 } }]) === '[表情包]',
    '表情包 → [表情包]（能区分开）',
  );
  check(
    ph([{ type: 'image', data: { file: 'a.png' } }, { type: 'text', data: { text: '这个怎么弄' } }]) ===
      '[图片]这个怎么弄',
    '图 + 文字 都保留',
  );

  // stripPlaceholders：只有占位符算「没打字」
  check(msgMod.stripPlaceholders('[图片]') === '', '[图片] 剥离后为空');
  check(msgMod.stripPlaceholders('[表情包]') === '', '[表情包] 剥离后为空');
  check(
    msgMod.stripPlaceholders('[图片]这个怎么弄') === '这个怎么弄',
    '图+文字 剥离后剩下真实文字',
  );

  // 纯表情包会被主动接梗 —— **前提是「从没见过的新表情」**
  // （见过的表情只是辅助说话，不该单独回。stickerIsNew 由 collector 判定后传入）
  bot.activeConv = new Map();
  let stickerHits = 0;
  for (let i = 0; i < 40; i++) {
    bot.lastVoluntaryAt = {};
    bot.activeConv = new Map();
    const r = bot.shouldJoinChat(evSegs(STICKER), { stickerIsNew: true });
    if (r) stickerHits++;
  }
  check(stickerHits >= 10 && stickerHits <= 30, `新表情会接梗（实测 ${stickerHits}/40，概率 0.5）`);

  // 见过的表情（stickerIsNew=false）→ 一条都不该回
  let seenHits = 0;
  for (let i = 0; i < 40; i++) {
    bot.lastVoluntaryAt = {};
    bot.activeConv = new Map();
    if (bot.shouldJoinChat(evSegs(STICKER), { stickerIsNew: false })) seenHits++;
  }
  check(seenHits === 0, `见过的表情不单独回（实测 ${seenHits}/40，应为 0）`);

  const stickerMode = (() => {
    for (let i = 0; i < 40; i++) {
      bot.lastVoluntaryAt = {};
      bot.activeConv = new Map();
      const r = bot.shouldJoinChat(evSegs(STICKER), { stickerIsNew: true });
      if (r) return r.mode;
    }
    return null;
  })();
  check(stickerMode === 'sticker', `走的是 sticker 模式（实际 ${stickerMode}）`);

  // 纯文字闲聊在灵敏度 2 下仍不接（别因为改图片逻辑把这条弄坏）
  bot.lastVoluntaryAt = {};
  bot.activeConv = new Map();
  check(
    bot.shouldJoinChat(ev('今天天气不错哈哈哈哈哈哈')) === null,
    '纯文字闲聊仍然不接（灵敏度 2）',
  );

  console.log('\n[A10] 提示词里要说明图片占位符的含义');
  const imgPrompt = bot.buildSystemPrompt('', ev('test'), null, '[表情包]');
  check(imgPrompt.includes('[表情包]'), '提示词里出现了 [表情包] 占位符说明');
  check(
    imgPrompt.includes('没加载出来') || imgPrompt.includes('重发'),
    '明确禁止了「图没加载出来 / 重发」这种话',
  );

  const cfgChat = config.chat;
  const convKey = `group:${GROUP}`;

  // 还没聊过 → 普通闲聊不该接
  bot.activeConv = new Map();
  bot.lastVoluntaryAt = {};
  check(bot.shouldJoinChat(ev('嗯嗯是这样的')) === null, '没聊过时，普通闲聊不接');

  // 模拟「它刚回过话」
  bot.touchConversation(ev('刚才那句'));
  let joined2 = 0;
  for (let i = 0; i < 20; i++) {
    const r = bot.shouldJoinChat(ev('那这个要怎么办'));
    if (r) joined2++;
  }
  check(joined2 === 20, `对话进行中，后续消息都接（实测 ${joined2}/20）`);
  const fmode = bot.shouldJoinChat(ev('那这个要怎么办'));
  check(fmode?.mode === 'followUp', `延续时模式是 followUp（实际 ${fmode?.mode}）`);

  // 延续不受关键词限制：完全不相关的短句也接
  check(!!bot.shouldJoinChat(ev('哦哦懂了')), '延续阶段不要求命中关键词');

  // 太短的不接
  check(bot.shouldJoinChat(ev('嗯')) === null, '延续阶段太短的消息仍不接');

  // 把「上次回复」的时间推远 → 对话结束
  const conv = bot.activeConv.get(convKey);
  const IDLE = cfgChat.followUp.idleMs;
  const SAME = cfgChat.followUp.sameUserMs;
  check(SAME >= IDLE, `sameUserMs(${SAME}) ≥ idleMs(${IDLE})：同一个人的窗口不许比通用窗口还小`);

  // ⚠️⚠️ 2026-09-15 用户截图报的（「这个也没有接进上文」）：
  //    @她问 → 她答完 → **85 秒后**他接着问「那最近mc圈有什么炸裂的视频」→ 她没接。
  //    根因就是这里：原来只看 idleMs（收紧度下只有 50 秒），**在跟她聊的那个人**
  //    隔了两分钟再说话就不认了 —— 可那明明就是在跟她说话。
  //    现在：**同一个人**用更宽的 sameUserMs，别人插话还是老窗口。
  conv.lastBotReplyAt = Date.now() - IDLE - 1000;
  bot.lastVoluntaryAt = {};
  check(
    bot.shouldJoinChat(ev('那最近这个要怎么办'))?.mode === 'followUp',
    '★ 同一个人隔了 idleMs 之后接着说 → **还是要接**（走 followUp）',
  );
  check(
    bot.shouldJoinChat(ev('那最近这个要怎么办', '99999')) === null,
    '同窗口下**换个人**插话 → 不接（防刷屏那条闸还在）',
  );

  // 超过同一个人的窗口 → 对话才算结束
  conv.lastBotReplyAt = Date.now() - SAME - 1000;
  bot.lastVoluntaryAt = {};
  check(
    bot.shouldJoinChat(ev('那这个要怎么办')) === null,
    '静默超过 sameUserMs 后不再延续（对话算结束了）',
  );

  // 对方一直说话会续命
  bot.activeConv = new Map();
  bot.touchConversation(ev('开始'));
  bot.touchUserActivity(ev('我还在说'));
  check(bot.activeConv.get(convKey).lastUserAt > 0, '对方说话会刷新活跃时间');

  // ── A11. 「快去搜」要真的去查（2026-09-15 用户截图）──────────
  //
  // ⚠️ 这一段必须写在**这个函数里**：`logicTests()` 开头才设
  //    `process.env.QQBOT_CONFIG = 'config.behavior-test.yml'`，
  //    如果写在顶层，会先 `import('../src/bot.js')` → **把生产 config 灌进模块缓存**
  //    → 整个套件跑在生产配置上（我踩过：34 项失败，全是"该不接的接了"）。
  console.log('\n[A11] ★ 她说了"我去搜搜"之后，催一句要**真的去查**');
  {
    bot.pendingLookup = new Map();
    bot.noteLookupPromise(ev('我去搜搜'), 'Luminiflux是谁啊，我去搜搜', 'Luminiflux有什么视频');
    check(bot.pendingLookup.size === 1, '说了「我去搜搜」→ 记下"欠着一件事"');
    check(
      bot.takeLookup(ev('快去搜'), '快去搜') === 'Luminiflux有什么视频',
      '★ 他催「快去搜」→ 取出**他原本问的那个问题**（后面会真的去查）',
    );
    check(bot.pendingLookup.size === 0, '取出后就清掉（不会一直重查）');

    // 「我搜了一下，是…」是**说完了**，不是承诺 → 别记
    bot.pendingLookup = new Map();
    bot.noteLookupPromise(ev('我搜了一下'), '我搜了一下，他最近在玩那个', '谁最近在干嘛');
    check(bot.pendingLookup.size === 0, '「我搜了一下」这种**已经做了**的不记（只记承诺）');

    // 正常回复里没提"搜/查" → 不记
    bot.noteLookupPromise(ev('嗯嗯'), '那就这样吧', '谁最近在干嘛');
    check(bot.pendingLookup.size === 0, '回复里没有"搜/查"→ 不记');

    // 普通闲聊不许把"欠的事"取出来
    bot.pendingLookup = new Map();
    bot.noteLookupPromise(ev('我去查查'), '这个我去查查', '籽岷最近有什么视频');
    check(bot.takeLookup(ev('今天天气不错'), '今天天气不错') === '', '普通闲聊 → 不触发补查');
    check(bot.pendingLookup.size === 1, '  ↳ 条目还留着（等下催了再查）');
    check(
      bot.takeLookup(ev('查一下吧'), '查一下吧') === '籽岷最近有什么视频',
      '「查一下吧」也算催 → 真去查',
    );

    // 超过 10 分钟就作废（别拿很久以前的事去查）
    bot.pendingLookup = new Map();
    bot.noteLookupPromise(ev('我去搜搜'), '我去搜搜', '某个老问题');
    bot.pendingLookup.get(String(GROUP)).at = Date.now() - 11 * 60 * 1000;
    check(bot.takeLookup(ev('快去搜'), '快去搜') === '', '过了 10 分钟 → 不再补查（当没这回事）');
  }

  // ── A12. 「她为什么没接」要能在日志里看见（2026-09-15 用户要求）──
  //
  // ⚠️ 同样必须写在这个函数里（原因见上面 A11 那段注释）。
  console.log('\n[A12] ★ 判为「不说」的理由要留在日志里（info 级）');
  {
    const { readFileSync: rf } = await import('node:fs');
    const sj = rf(join(ROOT, 'src', 'speak-judge.js'), 'utf8');
    const bj = rf(join(ROOT, 'src', 'bot.js'), 'utf8');
    // 不说的走 info（这样"她为什么没接"直接看得到）
    check(
      /if \(!out\.speak\) \{\s*\n\s*log\.info\(/.test(sj),
      '★ 判为「不说」→ `log.info`（带理由 + 耗时）',
    );
    // 说的仍走 debug（说的量最大，提上来会把日志刷满）
    check(
      /log\.debug\(`\[说话判断\] 说（/.test(sj),
      '★ 判为「说」→ 仍是 `log.debug`（不刷屏）',
    );
    // 代码层的「别人在聊天」量大，仍留 debug
    check(
      /log\.debug\('\[说话判断\] 代码已判定『?「两人对话」/.test(sj) ||
        /代码已判定「两人对话」，直接不说/.test(sj),
      '「别人在聊天」（代码判的，量大）仍留 debug',
    );
    // 同一个人出续话窗口 → info（这就是「那最近mc圈…」当时漏掉的线索）
    check(
      /是同一个人（\$\{uid\}）但已经隔了/.test(bj),
      '★ 同一个人的续话窗口过期 → `log.info`（不然"漏接"完全没痕迹）',
    );
  }
}

// ── B. 端到端部分 ─────────────────────────────────
const probes = [];
const llmServer = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    const sys = parsed.messages?.find((m) => m.role === 'system')?.content ?? '';
    const user = [...(parsed.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '';
    if (parsed.messages) probes.push({ sys, user });

    // ⚠️ 「该不该说」判断请求（system 里含「假装成真人群友」）——
    //    它要的是 **JSON**，不是 SSE。假模型不认识它的话会回一段 SSE，
    //    判断解析失败 → 默认「不说」→ 测试里机器人整个哑掉（真实踩过）。
    //    这里统一回「说」，让测试专注在它要验的东西上。
    // ⚠️ 2026-09-13 加：「归属核对」请求也要认得出来。
    //    原来假模型不认识它 → 每次都要等满 8 秒超时 → 回归很慢。
    //    （用户反馈「跑回归时间太长了，是不是有什么 bug」——没 bug，是白等超时。）
    if (sys.includes('【归属核对】')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }] }));
      return;
    }
    if (sys.includes('假装成真人群友')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"speak":true,"why":"测试","length":"short"}' } }] }));
      return;
    }
    // ⚠️⚠️ **预搜索**（2026-09-15 加，是个真坑）：
    //    假模型原来**不认识它** → 回一段普通 SSE → 解析不出 `{"search":…}`
    //    → **退回规则判定 → 判定成"该搜" → 真的去联网搜**（bing/baidu/ddg + 抓页，十几秒）
    //    → 后面那个 15 秒的 `waitFor` 必然超时，报「对话延续接住了后续消息（发了 0 条）」。
    //
    //    这个坑在 AGENTS.md 里写着（"预搜索回成了 JSON / 认不出 → 真的联网搜"），
    //    是 cs / attitude / teach 那些"偶发失败"的老真凶；behavior 的 B3 也踩上了。
    //    **判据是 system 里的准确字样**（和 e2e.js 里同一套），而且预搜索要 **SSE**。
    if (sys.includes('要不要上网查')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"search":false,"why":"测试不搜"}' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const reply = '收到。[表情:憨笑]';
    for (const p of reply.match(/.{1,3}/gs) ?? [reply]) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

const sent = [];
let sock = null;
const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });
wss.on('connection', (ws, req) => {
  if ((req.headers.authorization ?? '') !== `Bearer ${TOKEN}`) return ws.close(1008);
  sock = ws;
  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (m.action === 'send_group_msg') {
      const segs = m.params?.message ?? [];
      sent.push({
        text: segs.filter((s) => s.type === 'text').map((s) => s.data.text).join(''),
        imgs: segs.filter((s) => s.type === 'image').length,
        at: new Date().toISOString(),
      });
    }
    if (m.echo !== undefined) {
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: m.echo }));
    }
  });
  ws.send(
    JSON.stringify({
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
      self_id: BOT_QQ,
      time: Math.floor(Date.now() / 1000),
    }),
  );
});

function say(text, id) {
  sock.send(
    JSON.stringify({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: id,
      group_id: GROUP,
      user_id: MEMBER,
      self_id: BOT_QQ,
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: MEMBER, nickname: '路人', role: 'member' },
      message: [{ type: 'text', data: { text } }],
    }),
  );
}

async function waitFor(fn, timeout = 15000) {
  const t = Date.now();
  while (Date.now() - t < timeout) {
    if (fn()) return true;
    await sleep(120);
  }
  return false;
}

let botProc = null;

async function e2eTests() {
  await new Promise((r) => llmServer.listen(LLM_PORT, '127.0.0.1', r));
  await new Promise((r) => (wss._server.listening ? r() : wss.once('listening', r)));

  botProc = spawn(process.execPath, [join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      QQBOT_CONFIG: 'config.behavior-test.yml',
      // ⚠️ 排除本机代理：假模型/假 NapCat 都跑在 127.0.0.1，
      //    如果 shell 里设了 NODE_USE_ENV_PROXY，不加这个假模型请求会走代理而失败
      NO_PROXY: '127.0.0.1,localhost,::1',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  check(await waitFor(() => !!sock, 12000), '机器人已连接');
  if (!sock) return;

  console.log('\n[B1] 没人 @，但有人问服务器的问题 → 应该主动答');
  sent.length = 0;
  // 概率是 0.6，多试几条
  for (let i = 0; i < 6; i++) {
    say('服务器怎么进啊？', 5000 + i);
    if (await waitFor(() => sent.length > 0, 6000)) break;
  }
  check(sent.length > 0, `主动答了（发了 ${sent.length} 条）`);
  const qProbe = probes.find((p) => p.sys.includes('自己看到有人问服务器的事'));
  check(!!qProbe, '走的是 question 模式的提示词');
  // 等它把文字和表情都发完
  await waitFor(() => sent.some((s) => s.imgs > 0), 8000);
  await sleep(1200);
  check(sent.some((s) => s.imgs > 0), '表情作为单独一条发出去了');
  check(
    sent.filter((s) => s.imgs > 0 && !s.text.trim()).length >= 1,
    '表情那条不带文字（没有打包在一起）',
  );

  console.log('\n[B2] 没聊过的时候，纯闲聊不该插嘴');
  // 关键：要等上一轮的「对话延续」窗口过去，否则闲聊会被当成延续接住（那是正确行为）
  await sleep(4000);
  sent.length = 0;
  probes.length = 0;
  // 用 followUp.idleMs = 0 等效地「结束对话」：直接发一条足够长的闲聊，并确认它没把闲聊当延续
  // 这里通过重启机器人来确保状态干净，最可靠
  try {
    botProc.kill();
  } catch {}
  await sleep(1500);
  try {
    sock?.close();
  } catch {}
  await sleep(800);
  botProc = spawn(process.execPath, [join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      QQBOT_CONFIG: 'config.behavior-test.yml',
      // ⚠️ 排除本机代理：假模型/假 NapCat 都跑在 127.0.0.1，
      //    如果 shell 里设了 NODE_USE_ENV_PROXY，不加这个假模型请求会走代理而失败
      NO_PROXY: '127.0.0.1,localhost,::1',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  check(await waitFor(() => !!sock, 12000), '机器人重启（对话状态清空）');
  await sleep(1500);

  sent.length = 0;
  probes.length = 0;
  for (let i = 0; i < 4; i++) {
    say(`今天天气不错啊哈哈哈${i}`, 5100 + i);
    await sleep(700);
  }
  await sleep(3000);
  check(sent.length === 0, `闲聊没有插嘴（发了 ${sent.length} 条）`);
  check(probes.length === 0, `闲聊没有触发模型调用（${probes.length} 次）`);

  console.log('\n[B3] 对话延续：它回了一句之后，对方接着说应该继续接');
  sent.length = 0;
  probes.length = 0;
  // 先造一个它必须回答的问题，让它进入对话状态
  for (let i = 0; i < 8 && sent.length === 0; i++) {
    say('服务器怎么进啊？', 5200 + i);
    await waitFor(() => sent.length > 0, 6000);
  }
  check(sent.length > 0, '先答了一句（进入对话状态）');
  await sleep(2500);

  // 接着说一句「不带关键词、也不是问句」的话 —— 正常不该被接，但延续应该接住
  sent.length = 0;
  probes.length = 0;
  say('那我现在去试试', 5300);
  // ⚠️ 15 秒太紧了（2026-09-15）——这条要过**预搜索 → 说话判断 → 流式回复 → 发送**四步，
  //    并行跑回归时机器一忙就超时，报「发了 0 条」（单跑必过、并行偶发挂，白查很久）。
  //    这里要验的是"有没有接住"，不是"15 秒内接住"。
  const followed = await waitFor(() => sent.length > 0, 30000);
  check(followed, `对话延续接住了后续消息（发了 ${sent.length} 条）`);
  const fProbe = probes.find((p) => p.sys.includes('对话延续'));
  check(!!fProbe, '走的是 followUp 模式的提示词');
}

async function cleanup() {
  try {
    botProc?.kill();
  } catch {}
  try {
    sock?.close();
  } catch {}
  await new Promise((r) => wss.close(r));
  await new Promise((r) => llmServer.close(r));
}

(async () => {
  await logicTests();
  await e2eTests();
})()
  .catch((e) => {
    console.error('\n测试脚本出错:', e);
    failures++;
  })
  .finally(async () => {
    await cleanup();
    console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
    process.exit(failures === 0 ? 0 : 1);
  });
