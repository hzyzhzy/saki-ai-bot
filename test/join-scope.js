/**
 * 「主动搭话能在哪些群」测试（2026-09-14 用户定的）。
 *
 * 用户原话：「我觉得应该把 2（`chat.group`）改成读 **1**（`allowGroups`），
 *   **填群号是最不容易误触的**，这样**不会跑到其他群里搭话**」。
 *
 * ## 这个套件盯的是「界面填了就该有用」
 *
 * 改之前：`shouldJoinChat()` 查的是 `chat.group` —— 一个**单值字符串**，
 * 而且**管理界面上没有任何输入框**。用户在界面上把 `200000002` 填进了
 * 「它能在哪些群说话」、又设成 1 档，却从来没被搭过话 —— 死在这一行，
 * 界面上还看不到这个限制。
 *
 * 更坑：`chat.group` 只指主群，所以它**一直是唯一生效的群名单**，
 * `allowGroups` 填了几个群对"主动搭话"从来没有过影响。
 *
 * ## 现在的语义（两条一起才允许主动搭话）
 *
 *   ① `allowGroups` 非空 → 群必须在名单里（为空 = 不看群，和"消息收不收"同语义）
 *   ② 该群档位 ≤ 2（3 档只认 @，在 `shouldJoinChat` 第 827 行就 return 了）
 *
 * ⚠️ 纯单元：不起机器人、不连 NapCat、不调模型（`tryVoluntary` 被 stub 成放行）
 *
 * 用法: node test/join-scope.js
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });
const CFG_REL = 'logs/__test-join-scope.yml';

// 五个群、三种档位 —— 覆盖"会搭话 / 不会搭话 / 3 档"三种情况
const GROUPS = [
  { id: '200000001', lv: 1, note: '主群' },
  { id: '200000002', lv: 1, note: '用户要放开的那个' },
  { id: '200000003', lv: 3, note: '3 档' },
  { id: '200000004', lv: 3, note: '3 档' },
  { id: '200000005', lv: 2, note: '2 档' },
];
const OUTSIDER = '999999999'; // 不在白名单里

const cfgFor = (allowList) =>
  [
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
    '  apiKey: "sk-test"',
    '  model: t',
    'trigger:',
    '  respondTo: 3',
    '  allowGroups:',
    ...allowList.map((g) => `    - "${g}"`),
    '  groupRespondTo:',
    ...GROUPS.map((g) => `    "${g.id}": ${g.lv}`),
    'chat:',
    '  enable: true',
    '  group: "200000001"',
    'context:',
    '  enable: true',
    '',
  ].join('\n');

// ⚠️ 配置必须在 import `src/*` **之前**写好（`config.js` 是加载时读的）
writeFileSync(join(ROOT, CFG_REL), cfgFor(GROUPS.map((g) => g.id)), 'utf8');
process.env.QQBOT_CONFIG = CFG_REL;

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const { config } = await import('../src/config.js');
const { Bot } = await import('../src/bot.js');

/** 只跑"群闸门 + 档位"这两层：把掷骰/冷却 stub 成必过，避免随机性 */
function canJoin(gid, { inDialogueWith = null } = {}) {
  const b = new Bot();
  b.selfId = '10001';
  b.tryVoluntary = () => true; // 绕过冷却/概率（那是另一个套件的事）
  b.isOthersTalking = () => false; // 不然纯闲聊会被"两人对话"挡掉
  b.activeConv ??= new Map();
  if (inDialogueWith) {
    // 模拟「机器人刚回过这个人的话」→ followUp 分支
    b.activeConv.set(`group:${gid}`, {
      lastBotReplyAt: Date.now(),
      lastBotReplyTo: inDialogueWith,
      followUpChain: 0,
    });
  }
  const ev = {
    message_type: 'group',
    group_id: gid,
    user_id: '40001',
    self_id: '10001',
    message: [{ type: 'text', data: { text: '你最近在忙什么' } }],
    sender: { user_id: '40001', nickname: '测试', role: 'member' },
  };
  return b.shouldJoinChat(ev) !== null;
}

console.log('\n【1】★ 白名单里、档位 1 的群：能主动搭话（不再看 chat.group）');
{
  // ⚠️ 这是核心：改之前只有 200000001 能，其余全被 chat.group 挡住
  check(canJoin('200000001') === true, '主群(1档) → 能');
  check(canJoin('200000002') === true, '★ 200000002(1档) → **能**（改前被 chat.group 挡死）');
}

console.log('\n【2】★ 3 档的群仍然不接（白名单放开不等于乱说话）');
{
  check(canJoin('200000003') === false, '200000003(3档) → **不能**（3 档只认 @）');
  check(canJoin('200000004') === false, '200000004(3档) → **不能**');
}

console.log('\n【3】★ 不在白名单里的群：一个字都不说');
{
  check(canJoin(OUTSIDER) === false, `不在名单的群(${OUTSIDER}) → 不能`);
}

console.log('\n【4】2 档群的行为：**只在对话延续里接**，不对陌生人插话');
{
  // ⚠️ 我一开始以为"2 档 = 也能主动搭话"，其实不是：
  //    2 档只在 `followUp` 分支接（机器人刚回过这个人），
  //    陌生闲聊会一路落到 `level <= 1` 那道判断之外 → null。
  //    所以拆掉 `chat.group` 之后，**2 档群的行为其实没变**。
  check(canJoin('200000005') === false, '200000005(2档) 陌生闲聊 → 不接（和改前一样）');
  check(canJoin('200000005', { inDialogueWith: '40001' }) === true, '200000005(2档) 对话延续 → 接');
  check(canJoin('200000003', { inDialogueWith: '40001' }) === false, '3 档即使对话延续 → 也不接');
}

console.log('\n【5】`chat.group` 必须**完全不再参与判断**');
{
  // ⚠️ 这条防止哪天有人把那个闸门又加回来（它就是这次 bug 的根源）
  const src = (await import('node:fs')).readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  // 只看**非注释行**里有没有 chat.group
  const codeLines = src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .filter((l) => l.includes('chat.group'));
  check(codeLines.length === 0, `代码里没有 chat.group 的判断了（实际 ${codeLines.length} 处）`);

  // 而 shouldJoinChat 里要有读白名单那一行
  check(
    /const allow = config\.trigger\?\.allowGroups \?\? \[\];/.test(src),
    'shouldJoinChat 里读了 allowGroups',
  );
}

console.log('\n【6】白名单为空 = 不看群（和"消息收不收"同一套语义）');
{
  // ⚠️ 这条不能反：老配置依赖"空 = 所有群"，反过来会让升级即静默全哑
  const src = (await import('node:fs')).readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    /allow\.length > 0 && !allow\.map\(String\)\.includes\(String\(event\.group_id\)\)/.test(src),
    '「allowGroups 非空时才校验」的写法在（空 = 不限制）',
  );
}

console.log('\n【7】★★ 收紧度**按群**（<主人> 2026-09-15 晚：「收紧度也加一个一样的下拉菜单分群调节」）');
{
  const { config } = await import('../src/config.js');
  const b = new Bot();
  b.selfId = '10000002';
  const MAIN = '200000001'; // 1 档
  const OTHER = '200000002'; // 1 档
  const LV3 = '200000003'; // 3 档
  const ev = (gid) => ({ message_type: 'group', group_id: gid, user_id: '40001', message: [] });

  const global = b.strictnessOf(ev(MAIN));
  check(global >= 0 && global <= 100, `★ 收紧度读得到（现在 ${global}）`);
  check(b.strictnessOf(ev(OTHER)) === global, '★ 没设过的群 = 默认值（现在就是 50）');

  // 给"主群"单独调松
  config.groupParams[MAIN] = { ...(config.groupParams[MAIN] || {}), chat: { strictness: 0 } };
  check(b.strictnessOf(ev(MAIN)) === 0, '★★ 那个群单独设成 0 → **只它自己**变松');
  check(b.strictnessOf(ev(OTHER)) === global, '★★ **别的群一点没受影响**（还是默认 50）');
  check(b.strictnessFactor(ev(MAIN)) === 1, '★ 系数：0 = 最松（乘数 1）');
  check(
    b.strictnessParams(ev(MAIN)).minChars < b.strictnessParams(ev(OTHER)).minChars,
    `★★ 松的那个群 minChars 更小（真的更爱接话：${b.strictnessParams(ev(MAIN)).minChars} < ${b.strictnessParams(ev(OTHER)).minChars}）`,
  );

  // 反过来调紧也要生效
  config.groupParams[MAIN] = { chat: { strictness: 100 } };
  check(b.strictnessOf(ev(MAIN)) === 100 && b.strictnessFactor(ev(MAIN)) === 0.15, '★ 调紧也生效（100 → 乘数 0.15）');

  // 越界由读侧夹住（写侧那道在 config.js / 界面上）
  config.groupParams[MAIN] = { chat: { strictness: 999 } };
  check(b.strictnessOf(ev(MAIN)) === 100, '★ 写歪了也不会越界（读侧夹到 0~100）');
  delete config.groupParams[MAIN];

  // 3 档群：收紧度**本来就不适用**
  check(b.strictnessParams(ev(LV3)).active === false, '★ 3 档群：收紧度不适用（active=false，别把它算进去）');

  // 源码层面：**谁都别再去读全局那份**（<主人>：「取消保存全局的说法，只保留分群的数据」）
  const src = (await import('node:fs')).readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const codeLines = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  const globalReads = codeLines.filter((l) => l.includes('config.chat?.strictness')).length;
  check(globalReads === 0, '★★ 现在**一处都不读**全局收紧度了（只认分群 + 默认 50）', `实际 ${globalReads} 处`);
  check(/const DEFAULT_STRICTNESS = 50/.test(src), '★ 默认值是 50（用户要求：首先默认 50）');
}

try {
  rmSync(join(ROOT, CFG_REL), { force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
