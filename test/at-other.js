/**
 * 「消息 @ 的是别人 → 一个字都别接」测试（2026-09-14 用户截图报的 bug）。
 *
 * ## 真实 bug
 *
 *   某群友在群里发：「**@<主人>** 给个服世界地图。」
 *   机器人接了，回「地图得找 <主人> 要，我这儿没有」
 *   —— **人家本来就是在问 <主人>**，机器人插嘴了。
 *
 * ## 根因：`@` 有两种形态，守卫只认了一种
 *
 * NapCat 要把 `@` 解析成 `at` 段，得先能查到那个人的 `uid`。
 * **机器人查不到 <主人> 的 uid**（他不在机器人的好友里），
 * 于是那条 @ **降级成一截纯文本**发过来 —— 原始记录：
 *
 *   elements: [{ elementType: 1, textElement: {
 *                 content: "@<主人> 给个服世界地图。", atUid: "0", atNtUid: "" } }]
 *
 * 守卫原来只查 `s.type === 'at'` → 这种情况**整个失效** → 机器人当成在问它。
 * 实测当天这种"@ 写在文本里"的有 **2 条**（正常解析成 at 段的有 21 条），
 * 不是罕见的边角情况。
 *
 * ## 这个套件盯什么
 *
 *   · `at` 段 @ 别人 → 不接（老行为，别改坏）
 *   · ★ **文本形态** @ 别人 → 不接（这次修的）
 *   · 对照组：**同一句话去掉 @ 就该接** —— 证明拦住它的确实是 @ 守卫，
 *     而不是别的什么条件碰巧把消息挡了（这种"假绿"最坑）
 *   · 不许误伤：@全体成员、@机器人自己、不在开头的 @（邮箱）都要放行
 *
 * ⚠️ 纯单元：不起机器人、不连 NapCat、不调模型。
 *
 * 用法: node test/at-other.js
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });
const CFG_REL = 'logs/__test-at-other.yml';

const GROUP = '200000001'; // 1 档 + 在白名单里 → 光看闸门是"能接"的
const BOT = '10000002'; // 机器人自己（真实号）
const <主人> = '10000001'; // 别人（真实号）

// ⚠️ 配置必须在 import `src/*` **之前**写好（`config.js` 是加载时读的）
writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    '  baseURL: http://203.0.113.10:1/v1',
    '  apiKey: "sk-test"',
    '  model: t',
    'trigger:',
    '  respondTo: 3',
    '  allowGroups:',
    `    - "${GROUP}"`,
    '  groupRespondTo:',
    `    "${GROUP}": 1`,
    'chat:',
    '  enable: true',
    'context:',
    '  enable: true',
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

const { Bot } = await import('../src/bot.js');

/** 造一个群消息事件 */
const evOf = (message) => ({
  message_type: 'group',
  group_id: GROUP,
  user_id: '10000003', // 某群友（不是机器人自己）
  self_id: BOT,
  message,
  sender: { user_id: '10000003', nickname: '某群友', role: 'member' },
});

/**
 * 跑一遍 `shouldJoinChat`（同步的那层闸门）。
 * 把"主动接话"和"两人对话"都 stub 成放行，
 * 这样返回 `null` 就只可能是 **@ 守卫** 干的。
 */
function wouldJoin(message) {
  const b = new Bot();
  b.selfId = BOT;
  b.tryVoluntary = () => true;
  b.isOthersTalking = () => false;
  b.activeConv ??= new Map();
  return b.shouldJoinChat(evOf(message)) !== null;
}

const textSeg = (text) => ({ type: 'text', data: { text } });
const atSeg = (qq) => ({ type: 'at', data: { qq: String(qq) } });

// ─────────────────────────────────────────────────────────────
console.log('\n【1】`at` 段 @ 别人 → 不接（老行为，别改坏）');
{
  check(
    wouldJoin([atSeg(<主人>), textSeg(' 给个服世界地图。')]) === false,
    'at 段 @<主人> → 不接',
  );
  // 对照组：把 @ 拿掉就得接 —— 证明拦住它的确实是 @，不是别的原因
  check(wouldJoin([textSeg('给个服世界地图。')]) === true, '★ 对照：同一句话不带 @ → 接');
}

console.log('\n【2】★ 文本形态的 @ 别人 → 不接（这次修的 bug）');
{
  // 这就是用户截图的原文
  check(
    wouldJoin([textSeg('@<主人> 给个服世界地图。')]) === false,
    '★ 文本 `@<主人> 给个服世界地图。` → **不接**（改前会接）',
  );
  check(wouldJoin([textSeg('@<主人> 给个服世界地图。')]) === false, '再跑一次（确定性）');
  // 同一句话去掉 @ → 必须接
  check(wouldJoin([textSeg('给个服世界地图。')]) === true, '★ 对照：去掉 `@<主人>` → 接');
  // 别的名字、别的句式也一样
  check(wouldJoin([textSeg('@某群友 我看看有什么')]) === false, '文本 `@某群友 …` → 不接');
  check(wouldJoin([textSeg('@某同学 这题你会吗')]) === false, '文本 `@某同学 …` → 不接');
  check(wouldJoin([textSeg('@<主人>')]) === false, '只有 `@<主人>` 没正文 → 也不接');
}

console.log('\n【3】不许误伤：这几种必须放行');
{
  check(
    wouldJoin([atSeg('all'), textSeg(' 记得看群公告')]) === true,
    'at 段 @全体成员 → 放行（那是通知所有人）',
  );
  check(
    wouldJoin([textSeg('@全体成员 记得看群公告')]) === true,
    '文本 `@全体成员 …` → 放行',
  );
  // ⚠️ @机器人自己 的消息在更上面 `msg.isAt` 那行就 return 了，
  //    这里测的是**文本形态** @自己 —— 那种情况必须**不**被判成"@别人"
  check(
    wouldJoin([textSeg('@小祥 服务器怎么进')]) === true,
    '文本 `@小祥 …`（叫的是机器人自己）→ **放行**，别把叫自己当成叫别人',
  );
  check(
    wouldJoin([textSeg('Saki 服务器怎么进')]) === true,
    '不带 @ 直接叫名字 → 放行',
  );
  check(
    wouldJoin([textSeg('我的邮箱是 abc@163.com，你记一下')]) === true,
    '@ 不在开头（邮箱）→ 放行',
  );
  check(wouldJoin([textSeg('你们看 @<主人> 说的那个')]) === true, '@ 在句子中间 → 不拦');
}

console.log('\n【4】`textAtOf()` 本身的判据');
{
  const b = new Bot();
  b.selfId = BOT;
  const t = (text, segs = []) => b.textAtOf(text, segs);
  check(t('@<主人> 给个服世界地图。') === '<主人>', '取到名字 <主人>', `实际 ${JSON.stringify(t('@<主人> 给个服世界地图。'))}`);
  check(t('@<主人>') === '<主人>', '只有 @名字 也取得到');
  check(t('@  <主人> 在吗') === '<主人>', '中间多空格也认');
  check(t('@全体成员 注意') === '', '@全体成员 不算某个人');
  check(t('@小祥 在吗') === '', '@自己 → 空');
  check(t('@Saki 在吗') === '', '@Saki → 空');
  check(t('abc@163.com') === '', '邮箱 → 空');
  check(t('给个服世界地图。') === '', '没 @ → 空');
  check(t('[图片] @<主人> 看看') === '', '@ 不在开头 → 空');
  check(
    t('@<主人> 看看', [atSeg(<主人>)]) === '',
    '已经有 at 段时 → 空（那条路由 at 段负责，别重复判）',
  );
  check(t('') === '' && t(null) === '', '空值不炸');
}

console.log('\n【5】守卫接线：两路都要在');
{
  const src = (await import('node:fs')).readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const codeLines = src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  check(
    codeLines.some((l) => l.includes('const atOtherInSegs')),
    '`at` 段那一路在',
  );
  check(
    codeLines.some((l) => l.includes('const atOtherInText')),
    '★ 文本形态那一路在（这次修的，别被谁删了）',
  );
  check(
    codeLines.some((l) => /if \(this\.selfId && \(atOtherInSegs \|\| atOtherInText\)\)/.test(l)),
    '两路是 `||` 到一起的（别写成 `&&`）',
  );
}

console.log('\n【5】★★ 没指名她时，**她不是主角**（<主人> 2026-09-15 晚要求）');
console.log('        「只有 @她 或者明确叫她名字时，才能把自己当成被请求聊天的主角」');
{
  const { Bot } = await import('../src/bot.js');
  const b = new Bot();
  b.selfId = BOT;
  b.myMsgIds = new Map([[`group:${GROUP}`, ['m1']]]);
  const T = (t) => ({ type: 'text', data: { text: t } });
  const A = (qq) => ({ type: 'at', data: { qq: String(qq) } });
  const R = (id) => ({ type: 'reply', data: { id: String(id) } });
  const gEv = (segs) => ({
    message_type: 'group',
    group_id: GROUP,
    user_id: '10000003',
    self_id: BOT,
    message_id: 'cur',
    message: segs,
    sender: { nickname: '某群友', card: '' },
  });
  /** 提示词里有没有"你不是主角"那一段 */
  const notMain = (segs, text) =>
    b.buildSystemPrompt('', gEv(segs), 'chat', text, '', '', '', '', false).includes('没人在指名跟你说话');

  // ① 明确召唤 → 她**就是**被问的那个人（不注入那段）
  check(notMain([A(BOT), T('在吗')], '在吗') === false, '★★ @她 → 她是主角（不注入"不是主角"段）');
  check(
    notMain([T('祥子你现在和谁住在一起')], '祥子你现在和谁住在一起') === false,
    '★★ 正文叫她的名字 → 她是主角',
  );
  check(notMain([R('m1'), T('这句怎么说')], '这句怎么说') === false, '★★ 引用她的消息 → 她是主角');
  const priv = {
    message_type: 'private',
    user_id: <主人>,
    self_id: BOT,
    message_id: 'p1',
    message: [T('在吗')],
    sender: { nickname: '<主人>' },
  };
  check(
    b.buildSystemPrompt('', priv, 'chat', '在吗', '', '', '', '', false).includes('没人在指名跟你说话') === false,
    '★ 私聊 → 当然是跟她说话（不注入那段）',
  );

  // ② 没指名 → 她只是路过搭一句的人
  check(notMain([T('这游戏最近更新挺勤的')], '这游戏最近更新挺勤的') === true, '★★ 群里闲聊（没指名）→ **她不是主角**');
  check(
    notMain([T('服务器卡了怎么办')], '服务器卡了怎么办') === true,
    '★★ 没 @ 的服务器问题 → 该答，但**不把自己当主角**',
  );

  // ③ 那段的硬要求（别被删成一句空话）
  const p = b.buildSystemPrompt('', gEv([T('这游戏最近更新挺勤的')]), 'chat', '这游戏最近更新挺勤的', '', '', '', '', false);
  check(/别辩解、别自证/.test(p), '★★ 明确要求「别辩解、别自证」（真实踩过：「消息多又不是我发的（」）');
  check(/别把话题往自己身上拉/.test(p), '★ 要求「别把话题往自己身上拉」');
  check(/接不上就\*\*别开口\*\*/.test(p) || /接不上就别开口/.test(p), '★ 而且给了她"接不上就不说"的出口');
}

try {
  rmSync(join(ROOT, CFG_REL), { force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
