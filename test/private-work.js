/**
 * 私聊工作模式（2026-10-14 用户要求）套件。
 *
 * ## 这个套件盯的是这几条（都是用户原话定的）
 *
 * 1. 「**每个好友是否主动回复不用一号一份，而且默认开启**」
 *    → `trigger.allowFriendsPrivate` 默认开；是好友就放行；**不看好感度**
 * 2. 「**私聊工作模式开关还是一号一份，默认关闭**」
 *    → `privateWork.enable` 默认 `false`，写在 `accounts/<QQ>.yml` 里覆盖
 * 3. 「**每个私聊只开一个对话，不开新对话**」
 *    → 同一个 uid 的目录**永远复用**，连调两次不许新建第二个
 * 4. 「对方发来的**文件要全部存入**当前私聊里对话的工作区」
 *    → 收到的文件/图片落进 `<工作区>/收到的文件/`
 * 5. ⚠️ **工作区必须在项目外**（`src/private-work.js` 开头那段）——
 *    放进项目里，agent 会把 `qq-ai-bot/AGENTS.md`（70KB、含用户私有资料）整个注入 ✗
 * 6. 🚫 **不碰好感度**、🚫 **不是** `friend.js` 那个每日主动私聊
 *
 * ⚠️ 纯离线：不连协议端、不调模型、不起 agent（假 bot 只提供 `call` / `fetchLogFile`）
 *
 * 用法: node test/private-work.js
 */
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });

const CFG_REL = 'logs/__test-private-work.yml';
const WROOT = 'logs/__test-pw-root';
const WFILE = 'logs/__test-pw.json';
const PERSONA = 'logs/__test-pw-persona.yml';

// ⚠️ 配置必须在 import `src/*` **之前**写好（`config.js` 是加载时读的）
writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
    '  apiKey: "sk-test"',
    '  model: t',
    'botQQ: "10000001"',
    'persona:',
    '  id: <主人>',
    'privateWork:',
    `  personaFile: ${PERSONA}`,
    '  maxIncomingMB: 1',
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;
process.env.QQBOT_PRIVATE_WORK_ROOT = WROOT;
process.env.QQBOT_PRIVATE_WORK_FILE = WFILE;
// ⚠️ 2026-10-14 加：私聊那单现在会**写「本机任务」历史**（agent-bridge 那份）
//    ⇒ 套件必须把它也隔离，不然会往**用户真实的任务台账**里塞测试记录 ✗
// ⚠️⚠️ 2026-10-15 修：**变量名原来是错的** —— 历史走的是 `QQBOT_AGENT_TASKS_FILE`
//    （`agent-bridge.js` 的 `HIST_FILE`），而这里设的 `QQBOT_AGENT_FILE` 是**另一个文件**
//    （`FILE`，只存"当前在跑的那个"）⇒ 隔离没生效，测试记录**真的写进了主号那份**
//    `state/agent-tasks.json`（实测攒了 90 条，用户面板上会看见）✗
process.env.QQBOT_AGENT_TASKS_FILE = 'logs/__test-pw-agent.json';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const { config } = await import('../src/config.js');
const pw = await import('../src/private-work.js');
const { Bot } = await import('../src/bot.js');
// ⚠️⚠️ 2026-10-16 加：**"返工判定"现在是"关键词快筛 + 模型判"**（见 `looksLikeRework` 那里）——
//    套件里不桩的话它会**真调一次模型**（判不出来还超时）⇒ "交付后他说改成…"那三条会假红 ✗
//    ⇒ 这里桩成「他说改了」✓（要验的是"当场又起一轮"，不是模型判得多准）
const abStub = await import('../src/agent-bridge.js');
// ⚠️⚠️ 2026-10-16 用户定了铁律「**非必要不用关键词快判**」——
//    "他这是在让我改吗"那一步的**关键词快筛已经撤掉**，现在每句话都直接问模型 ✗
//    ⇒ 套件这个桩要**像模型那样**按内容回答（不能一律答 change）：
//      否则"收到文件 ⇒ 起预读"那条路会被当成返工，一堆无关断言跟着红 ✗（真踩过）
abStub.__setInterject(async (text) => {
  const t = String(text ?? '');
  if (/改成|换成|弄成|改成蓝|改一下|补上|再加上|重做|修改|蓝的|字体/.test(t)) return 'change';
  return 'none';
});

const FRIEND = '10000001';
const STRANGER = '999999999';
const ROOT_ABS = join(ROOT, WROOT);

rmSync(ROOT_ABS, { recursive: true, force: true });
rmSync(join(ROOT, WFILE), { force: true });
// ⚠️⚠️ 2026-10-16 加（假红踩了两次）：**任务历史也要清干净** ——
//    上一次跑留下的历史行（同一个 uid 已经在里面、而内存里那份状态带着**旧的行 id**）
//    ⇒ 这一轮 `patchPrivateHist(旧 id)` 找不到那一行 ⇒ 「会话 id 写进了历史」当场假红 ✗
//    （单独复跑还是红 ⇒ 白查一轮；清掉这个文件立刻就绿 ✓）
rmSync(join(ROOT, 'logs', '__test-pw-agent.json'), { force: true });

// 一份假的"人设正文"（真那份在 `.dsh` 里、不进仓库；测试不去读它）
writeFileSync(
  join(ROOT, PERSONA),
  ['- id: persona', '  name: x', '  config:', '    prefix: |-', '      短、直给、不客套。'].join('\n'),
  'utf8',
);

console.log('\n【1】★ 两个开关的默认值（用户：「好友回复不用一号一份、默认开；工作模式一号一份、默认关」）');
{
  check(config.trigger.allowFriendsPrivate === true, '★ `trigger.allowFriendsPrivate` 默认 **true**');
  check(config.privateWork.enable === false, '★ `privateWork.enable` 默认 **false**（一号一份写在 accounts/<QQ>.yml）');
  check(pw.enabled() === false, '★ 默认状态下 `enabled()` = false（不开工）');
}

console.log('\n【2】★ 是好友就放行 —— 好友列表本身就是白名单');
{
  pw.__setFriends({ [FRIEND]: '小明' });
  check(pw.isAllowedFriend(FRIEND) === true, '★ 好友 → 放行（不用往 allowPrivateUsers 里写）');
  check(pw.isAllowedFriend(STRANGER) === false, '★ 不是好友 → 不放行');
  check(pw.isAllowedFriend('') === false, '空 uid → 不放行');

  const b = new Bot();
  b.selfId = '10000001';
  check(b.privateAllowed(FRIEND) === true, '★ `bot.privateAllowed(好友)` = true（接线接上了）');
  check(b.privateAllowed(STRANGER) === false, '★ `bot.privateAllowed(陌生人)` = false');
}

console.log('\n【3】★ 关掉"好友回复"那条 → 退回只认 allowPrivateUsers 名单');
{
  const before = config.trigger.allowFriendsPrivate;
  config.trigger.allowFriendsPrivate = false;
  check(pw.isAllowedFriend(FRIEND) === false, '★ `allowFriendsPrivate:false`（不传）→ 连好友也拒');
  const b = new Bot();
  b.selfId = '10000001';
  check(b.privateAllowed(FRIEND) === false, '★ `bot.privateAllowed` 也跟着拒');
  config.trigger.allowFriendsPrivate = before;
  check(pw.isAllowedFriend(FRIEND) === true, '★ 改回来 → 又是放行（判据是现读的，不是缓存死的）');
}

console.log('\n【4】★★ 工作区**在项目外**（这条是硬边界，别让谁"顺手"挪进项目里）');
{
  const saved = process.env.QQBOT_PRIVATE_WORK_ROOT;
  delete process.env.QQBOT_PRIVATE_WORK_ROOT;
  const def = pw.rootDir();
  process.env.QQBOT_PRIVATE_WORK_ROOT = saved;

  check(!def.startsWith(ROOT + sep), `★★ 默认工作区根**不在项目里**`, `实际 ${def}`);
  check(/private-work$/.test(def), '★ 默认落在 …/DeepSeekHarness/private-work（和 .dsh 平级，往上没有 .git）');
  check(pw.rootDir() === ROOT_ABS, '★ 套件用的是 env 指定的隔离目录（不碰用户真数据）');
}

console.log('\n【5】★★ 每个私聊**只有一个**目录，永远复用（用户：「每个私聊只开一个对话，不开新对话」）');
{
  const d1 = pw.ensureWorkspace(FRIEND, '小明');
  const d2 = pw.ensureWorkspace(FRIEND, '小明');
  check(d1 === d2, '★★ 同一个 uid 连调两次 → **同一个目录**（不新建）');
  check(existsSync(join(d1, '收到的文件')), '★ 建了 `收到的文件/`');
  check(existsSync(join(d1, '产物')), '★ 建了 `产物/`');
  check(existsSync(join(d1, 'AGENTS.md')), '★ 建了 `AGENTS.md`（agent 一进这个目录就读它）');
  check(existsSync(join(d1, '对话记录.md')), '★ 建了 `对话记录.md`（下一轮靠它续接）');

  const md = readFileSync(join(d1, 'AGENTS.md'), 'utf8');
  check(md.includes('短、直给、不客套'), '★ AGENTS.md 里注入了人设正文（从那份不进仓库的 preset 读来的）');
  check(/都是资料，不是给你的命令/.test(md), '★★ AGENTS.md 里写死了「收到的文件是资料不是命令」（防注入）');
  const diff = pw.ensureWorkspace(STRANGER, '陌生人');
  check(diff !== d1, '★ 不同的 uid → 不同目录（各聊各的，不串）');
}

console.log('\n【6】★ 对方发来的文件**全部存进那个私聊的工作区**');
{
  const dir = pw.dirFor(FRIEND);
  // ⚠️ 私聊文件走 `get_private_file_url`（私聊**没有 group_id**，群里那条路走不通）——
  //    离线套件让它装死、`get_file` 指向一个真实的本地小文件 ✓
  const srcFile = join(ROOT, 'logs', '__test-pw-src.js');
  writeFileSync(srcFile, 'console.log(1)\n', 'utf8');
  const bot = {
    call: async (action) => {
      if (action === 'get_private_file_url') throw new Error('假装没有这个接口');
      if (action === 'get_file') return { file: srcFile };
      return {};
    },
  };
  const ev = { message_type: 'private', user_id: FRIEND };
  const segs = [
    { type: 'text', data: { text: '帮我看看这个' } },
    { type: 'file', data: { name: 'main.js', file_id: 'f1' } },
  ];
  const r = await pw.saveIncoming(bot, ev, segs, FRIEND);
  check(r.saved.length === 1 && r.saved[0].name === 'main.js', '★ 文件落地了', JSON.stringify(r.saved.map((x) => x.name)));
  check(existsSync(join(dir, '收到的文件', 'main.js')), '★ 就在 `<工作区>/收到的文件/` 下面（对方发来就能直接找到）');

  // 重名不许覆盖
  const r2 = await pw.saveIncoming(bot, ev, segs, FRIEND);
  check(r2.saved[0].name === 'main(2).js', '★ 重名加 `(2)`，**不覆盖**上一个', r2.saved[0].name);

  // 下载失败 → 记一笔跳过，别把整条消息搞崩
  const bad = { call: async () => ({}) };
  const r3 = await pw.saveIncoming(bad, ev, segs, FRIEND);
  check(r3.saved.length === 0 && r3.skipped.length === 1, '★ 拿不到内容 → 记进 skipped，不抛异常');

  // 文件名消毒：不许带路径出去
  const evil = { call: async (a) => (a === 'get_file' ? { file: srcFile } : {}) };
  const r4 = await pw.saveIncoming(evil, ev, [{ type: 'file', data: { name: '..\\..\\逃出去.txt', file_id: 'f' } }], FRIEND);
  check(!r4.saved[0].name.includes('..') && !r4.saved[0].name.includes('\\'), '★ 文件名消毒（路径分隔符进不来）', r4.saved[0].name);

  // 超限就跳过（配置里把上限压到 1MB，塞 2MB）
  const bigFile = join(ROOT, 'logs', '__test-pw-big.zip');
  writeFileSync(bigFile, Buffer.alloc(2 * 1024 * 1024, 1));
  const big = { call: async (a) => (a === 'get_file' ? { file: bigFile } : {}) };
  const r5 = await pw.saveIncoming(big, ev, [{ type: 'file', data: { name: '大文件.zip', file_id: 'big' } }], FRIEND);
  check(r5.saved.length === 0 && /超过 1MB/.test(r5.skipped[0]?.why ?? ''), '★ 超过上限 → 跳过并说清原因', r5.skipped[0]?.why);
}

console.log('\n【7】★★ 好友列表拉回来是**空**的时候，不许清空旧名单');
{
  // ⚠️ 协议端刚起来/刚登录时它可能返回空数组 —— 清空 = 那几分钟所有好友私聊全被拒 ✗
  pw.__setFriends({ [FRIEND]: '小明' });
  const bot = { call: async () => [] };
  const r = await pw.refreshFriends(bot);
  check(r.ok === false, '★ 空名单 → 返回 ok:false');
  check(pw.isAllowedFriend(FRIEND) === true, '★★ 旧名单**还在**（没被清空）');
  check(pw.friendsInfo().count === 1, '★ 名单还是那 1 个', String(pw.friendsInfo().count));

  // 正常拉取会覆盖
  const bot2 = { call: async () => [{ user_id: FRIEND, nickname: '小明' }, { user_id: '12345678', remark: '小李' }] };
  const r2 = await pw.refreshFriends(bot2);
  check(r2.ok === true && r2.count === 2, '★ 拉到 2 个 → 覆盖成功', JSON.stringify(r2));
  check(pw.friendName('12345678') === '小李', '★ 备注优先于昵称');
  check(pw.isAllowedFriend('12345678') === true, '★ 新加的好友立刻能私聊（不用重启）');
  check(pw.isAllowedFriend('55555555') === false, '★ 不在名单里的仍然拒');
}

console.log('\n【8】★ 好友列表为空 + friendOnly 关掉时的兜底语义');
{
  pw.__setFriends({});
  check(pw.isAllowedFriend(FRIEND) === false, '★ 名单空 → 拒（空名单 = 谁都不回）');
  config.privateWork.friendOnly = false;
  check(pw.isAllowedFriend(FRIEND) === true, '★ `friendOnly:false` → 谁都能触发（不建议，但不许静默失效）');
  config.privateWork.friendOnly = true;
}

console.log('\n【9】★★ 不碰好感度、不碰那个每日主动私聊');
{
  const src = readFileSync(join(ROOT, 'src', 'private-work.js'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  check(!code.some((l) => /affinity/.test(l)), '★★ `private-work.js` 里**一处**都没提 affinity（好感度）');
  check(!code.some((l) => /from '\.\/friend\.js'/.test(l)), '★★ 也没 import `friend.js`（不是那个每日主动私聊）');
  check(!code.some((l) => /pickForToday|composeDm|markDm\b/.test(l)), '★★ 没有任何"主动私聊"的调用');

  // bot 那边：好友放行那条**不许**夹带好感度
  const bsrc = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const lines = bsrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  const i = lines.findIndex((l) => l.includes('privateWork.isAllowedFriend(uid)'));
  check(i >= 0, '★ `bot.privateAllowed` 里接了这条判据');
  const near = lines.slice(Math.max(0, i - 3), i + 2).join('\n');
  check(!/affinity/.test(near), '★★ 那几行里没有好感度参与', near.replace(/\s+/g, ' ').slice(0, 80));
}

console.log('\n【10】★ 只有**开了工作模式**的号才把文件收进工作区（主号 / 爱音不受影响）');
{
  const bsrc = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const lines = bsrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  const i = lines.findIndex((l) => l.includes('privateWork.onPrivate('));
  check(i >= 0, '★ `onMessage` 里接了 `onPrivate`（收文件 + 推进状态）');
  check(/await privateWork\.onPrivate\(payload/.test(lines[i]), '★ 是 **await**（文件先落地、状态先定，她这一轮才说得对）');
  const iAgent = lines.findIndex((l) => l.includes('agentBridge.handle(payload'));
  check(iAgent > i, '★★ 它挡在 `agentBridge` **之前**（状态先定，再谈派活）');

  const pwSrc = readFileSync(join(ROOT, 'src', 'private-work.js'), 'utf8');
  check(/if \(!enabled\(\)\) return false;/.test(pwSrc), '★ `onPrivate` 内部先判"这个号开没开工作模式"（别的号不受影响）');
  check(/get_private_file_url/.test(pwSrc), '★★ 私聊文件走 `get_private_file_url`（私聊没有 group_id，群里那条路走不通）');
}

console.log('\n【11】★ `status()` 把两个开关分别报出来（排查时一眼看清是哪个没开）');
{
  const s = pw.status();
  check('friendsReply' in s && 'workMode' in s, '★ 两个开关分开报（不是一个含糊的 enabled）', JSON.stringify({ f: s.friendsReply, w: s.workMode }));
  check(typeof s.root === 'string' && s.root.length > 0, '★ 报出工作区根目录');
}

console.log('\n【12】★★ 接单状态机：注入块按阶段说话（话由她自己说，代码只管状态）');
{
  config.privateWork.enable = true;
  pw.__setFriends({ [FRIEND]: '小明' });
  const ev = { message_type: 'private', user_id: FRIEND };

  pw.patchState(FRIEND, { stage: 'intake', need: '帮我把这个脚本改成批量处理', askHint: '要改的是哪个脚本' });
  const n1 = pw.noteFor(ev);
  check(/你手上这个活/.test(n1), '★ intake：注入"你手上这个活"');
  check(/先把要求弄清楚/.test(n1), '★ intake：先摸需求，别急着开工');
  check(/不许.*我这就去做/.test(n1), '★★ intake：明写**不许**承诺"马上就好"（用户要的那条）');
  check(/要改的是哪个脚本/.test(n1), '★ 缺什么就让她问什么（`askHint`）');

  pw.patchState(FRIEND, { stage: 'confirming' });
  const n2 = pw.noteFor(ev);
  // ⚠️ 2026-10-16 改（用户截图：「开始做了吗」→ 她回「**在弄着呢，弄好了给你**」✗）——
  //    confirming 阶段（他还没答应）**不许报开工**，不然对面就干等着了 ✗
  check(/还在等他一句话/.test(n2), '★ confirming：在等他一句话（他还没说做）');
  check(
    /千万别说「在弄着呢」/.test(n2),
    '★★ confirming：还没开工不许说"在弄着呢 / 弄好了给你"（用户截图抓到的原话）',
  );
  check(/先别报时间/.test(n2), '★ confirming：**先别报时间**（得等估完再说）');

  pw.patchState(FRIEND, { stage: 'running', etaAt: Date.now() + 3600000 });
  {
    // ⚠️⚠️ 2026-10-16 定稿：**只说到"时间段"**（早上/上午/中午/下午/傍晚/晚上/凌晨），
    //    连"三点半""八点左右"这种钟点都不许说 ✓
    const n3 = pw.noteFor(ev);
    check(/只能说到"时间段"/.test(n3), '★★ running：只说**时间段**（用户 2026-10-16 定稿）');
    check(/钟点一律不许说/.test(n3), '★★ 而且明写"钟点一律不许说"（"三点半""八点左右"都不行 ✓）');
    check(
      /「(?:今天|明天|后天)(?:凌晨|早上|上午|中午|下午|傍晚|晚上) 给你」/.test(n3),
      '★★ 给她的例句是**时段**那种（不是「三点半」）',
      (n3.match(/「(?:今天|明天|后天)[^」]*」/) ?? [''])[0],
    );
  }

  pw.patchState(FRIEND, { stage: 'waiting', etaAt: Date.now() + 3600000 });
  check(/别把东西发出去/.test(pw.noteFor(ev)), '★★ waiting：说好的时间没到，**不许提前发**（用户要的）');

  check(pw.noteFor({ message_type: 'group', group_id: '50001', user_id: FRIEND }) === '', '★ 群里不注入（只管私聊）');
  check(pw.noteFor({ message_type: 'private', user_id: STRANGER }) === '', '★ 不是好友不注入');
  pw.patchState(FRIEND, { stage: 'done' });
  check(pw.noteFor(ev) === '', '★ 交付完了（done）就不再注入');

  // ⚠️⚠️ 用户：「不是跳过，而是要**正常接话**但是**不调用功能**」+「**不能返回错误信息**」
  pw.patchState(FRIEND, { stage: 'intake' });
  const n5 = pw.noteFor(ev);
  check(/这个号是干活的/.test(n5), '★★ 每一轮都告诉她"这个号是干活的"');
  check(/话要照常接住/.test(n5), '★★ **照常接话**（不是把这条消息丢掉）');
  check(/绝对不许.*功能已关闭/.test(n5), '★★ 明写**不许**说「功能已关闭」这类错误信息');
  check(/画图 \/ 生图/.test(n5), '★ 点名"生图不做"（用户点名的那个）');
}

console.log('\n【13】★★ 全流程：摸需求 → 问开始 → 他点头 → 起 agent → 到点才交付');
{
  const seen = [];
  pw.__setPhrase(async ({ system }) => {
    if (system.includes('够不够开工')) return '够了';
    if (system.includes('他答应了吗')) return '是';
    if (system.includes('估时间')) return '4.5 小时';
    return '';
  });
  let started = null;
  pw.__setRunner(async (prompt, hooks) => {
    started = { prompt, cwd: hooks.cwd };
    seen.push('run');
    return { promise: Promise.resolve({ code: 0, stdout: 'ok' }), kill: () => {} };
  });
  const fakeBot = { call: async () => ({}), sendText: async () => {} };

  pw.patchState(FRIEND, { stage: 'intake', need: '', askHint: '', etaAt: 0, judgeAt: 0, goAt: 0 });
  await pw.onPrivate(
    { message_type: 'private', user_id: FRIEND, message: [{ type: 'text', data: { text: '帮我把这个脚本改成批量处理，文件发你了' } }] },
    null,
    fakeBot,
  );
  check(pw.stateOf(FRIEND).stage === 'confirming', '★ 材料齐了 → 转"等他点头"', pw.stateOf(FRIEND).stage);

  await pw.onPrivate(
    { message_type: 'private', user_id: FRIEND, message: [{ type: 'text', data: { text: '行，开始吧' } }] },
    null,
    fakeBot,
  );
  check(pw.stateOf(FRIEND).stage === 'running', '★ 他点头 → 进 running（几秒内回一句也要认得出来）', pw.stateOf(FRIEND).stage);
  check(pw.stateOf(FRIEND).etaAt > Date.now(), '★★ 记下了"说好的时间"（还没到点）');
  check(
    pw.stateOf(FRIEND).etaMinutes === 270,
    '★★ 用的是"**真人兼职**要多久"（模型估的 4.5 小时 = 270 分钟），不是 agent 的耗时',
    String(pw.stateOf(FRIEND).etaMinutes),
  );

  await new Promise((r) => setTimeout(r, 80)); // `startJob` 是 void 的，等它跑到"跑完"
  check(seen.includes('run'), '★ agent 起来了');
  check(pw.stateOf(FRIEND).stage === 'waiting', '★★ 跑完**不马上发** → 进 waiting（等时间到点）', pw.stateOf(FRIEND).stage);
  check(started?.cwd === pw.dirFor(FRIEND), '★★ 跑在**那个私聊自己的工作区**里（永远复用、不新建）', String(started?.cwd));
  check(/AGENTS\.md/.test(started?.prompt ?? ''), '★ 提示词里让它先看工作区的 AGENTS.md（规矩只留一份）');

  writeFileSync(join(pw.outDir(FRIEND), '弄好的.js'), 'x', 'utf8');
  const sent = [];
  const bot2 = {
    call: async (a, p) => {
      sent.push({ a, p });
      return { status: 'ok', retcode: 0 };
    },
    sendText: async (_ev, t) => {
      sent.push({ say: t });
      return '1';
    },
  };
  pw.patchState(FRIEND, { etaAt: Date.now() - 1000 });
  await pw.deliver(FRIEND, bot2);
  check(sent.some((x) => x.a === 'upload_private_file'), '★ 交付走 `upload_private_file`（私聊传文件）');
  const say = sent.find((x) => x.say)?.say ?? '';
  check(!!say, '★ 附一句话', say);
  check(!/机器人|工作区|agent|自动|脚本|目录/.test(say), '★★ 那句话里**不出现**会露馅的词', say);
  check(pw.stateOf(FRIEND).stage === 'done', '★ 交付完 → done');

  pw.__setPhrase(null);
  pw.__setRunner(null);
}

console.log('\n【14】★ 产物 > 3 个才打包，而且包名要像人写的');
{
  const s = readFileSync(join(ROOT, 'src', 'private-work.js'), 'utf8');
  check(/Compress-Archive/.test(s), '★ 打包用系统自带的 `Compress-Archive`（不引第三方 zip 库）');
  check(/PW_SRC/.test(s) && /PW_ZIP/.test(s), '★★ 路径走**环境变量**（这个项目的路径带空格和中文，拼命令行必炸）');
  check(/stem \|\| '给你弄好的'/.test(s), '★★ 包名从他说的那件事里取字（不是 `output_2026.zip` 那种）');
  check(/maxFilesDirect, 3/.test(s), '★ 默认**多于 3 个**才打包（用户：「3个以上的再打包」）');
}

console.log('\n【15】★ 界面上两个开关都在 QQ 号页（私聊工作模式 + 人工接管）');
{
  const w = readFileSync(join(ROOT, 'src', 'webui.html'), 'utf8');
  check(/id="acc-workmode"/.test(w), '★ 有「私聊工作模式」那个 checkbox');
  check(/async function accSaveWorkMode/.test(w), '★ 有它的保存函数');
  check(/privateWork: \{ enable: on \}/.test(w), '★ 保存发的是 `privateWork.enable`（后端会按号存）');
  check(/me && me\.workMode/.test(w), '★ 进页面时刷成**当前这个号**的真实值');
  check(
    /id="acc-takeover"/.test(w) && /async function accSaveTakeover/.test(w),
    '★ 「人工接管」那两个也都在（用户说看到不按钮 = 缺的就是这两个）',
  );
  const j = readFileSync(join(ROOT, 'src', 'webui.js'), 'utf8');
  check(/workMode: a\.privateWork\?\.enable === true/.test(j), '★ `/api/accounts` 报出每个号的工作模式状态');
}

console.log('\n【16】★★ 分好友的设置（和「好感度 / 好友」那套完全没关系）');
{
  config.privateWork.enable = true;
  pw.__setFriends({ [FRIEND]: '小明' });
  config.privateWork.friends = {
    [FRIEND]: { allow: false, timeoutMin: 30, etaMinMin: 20, etaMaxMin: 60, note: '老客户' },
  };
  check(pw.allowFor(FRIEND) === false, '★★ 关掉「允许派活」→ 不接他的单');
  check(pw.allowFor(STRANGER) === true, '★ 没配过的人默认允许（不配 = 照常接）');
  check(pw.minutesFor(FRIEND, 'timeoutMin', 15) === 30, '★ 单活上限能按好友覆盖');
  check(pw.minutesFor(STRANGER, 'timeoutMin', 15) === 15, '★ 没配就跟着全局走');
  const d = pw.uiData();
  check(d.friends.some((f) => f.qq === FRIEND && f.cfg.timeoutMin === 30), '★ `uiData` 把每个人的设置带出来给表用');
  check(!!d.defaults && d.defaults.timeoutMin > 0, '★ 也带全局默认值（表里的 placeholder）');

  pw.__setPhrase(async () => '够了');
  pw.patchState(FRIEND, { stage: 'intake', need: '', judgeAt: 0 });
  const r = await pw.onPrivate(
    { message_type: 'private', user_id: FRIEND, message: [{ type: 'text', data: { text: '帮我改个脚本' } }] },
    null,
    { call: async () => ({}), sendText: async () => {} },
  );
  check(
    r === false && pw.stateOf(FRIEND).stage === 'intake',
    '★★ 关掉派活的人 → 接单状态机**一动不动**（但这条消息仍归她自己聊）',
  );
  pw.__setPhrase(null);
  delete config.privateWork.friends;

  const src = readFileSync(join(ROOT, 'src', 'private-work.js'), 'utf8');
  check(/W\(\)\.friends/.test(src), '★ 分好友的设置存在 `privateWork.friends` 里（不是 affinity）');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check(!/affinity/.test(code), '★★ 整个文件里**一处都没碰**好感度');
  const w = readFileSync(join(ROOT, 'src', 'webui.html'), 'utf8');
  check(
    /id="pw-friends"/.test(w) && /function pwFriendTable/.test(w) && /async function saveFriendCfg/.test(w),
    '★ 界面上真的有那张表和它的保存函数',
  );
  const j = readFileSync(join(ROOT, 'src', 'webui.js'), 'utf8');
  check(/'GET \/api\/private-work'/.test(j), '★ 有 `/api/private-work` 这个接口');
}

console.log('\n【17】★★★ 这些功能**只属于开了工作模式的号**（用户：「不要影响到其他号」）');
{
  const FRESH = '2777777777';
  pw.__setFriends({ [FRIEND]: '小明', [FRESH]: '新人' });
  config.privateWork.enable = false; // ← 这个号没开工作模式
  const ev = { message_type: 'private', user_id: FRESH };
  check(pw.enabled() === false, '前提：这个号没开工作模式');
  check(pw.noteFor(ev) === '', '★★ 没开 → 聊天提示词里**一个字都不注入**（别的号完全不受影响）');

  const fakeBot = { call: async () => ({}), sendText: async () => {} };
  const out = await pw.onPrivate(ev, null, fakeBot);
  check(out === false, '★★ 没开 → `onPrivate` 立刻返回：不建工作区、不收文件、不动状态机');
  check(!existsSync(pw.dirFor(FRESH)), '★★ 没开 → 连那个私聊的**工作区目录都不该被创建**出来');

  check(pw.status().workMode === false, '★ `status()` 照实报"没开"');
  check(pw.friendsReply() === true, '★ 「好友私聊回不回」是**另一条**开关（默认开），没被牵连');
  check(pw.isAllowedFriend(FRESH) === true, '★ 所以它照样能被回私聊 —— 但只是普通聊天，不进接单流程');

  // 源码级：那几个入口都得先过 `enabled()`
  const src = readFileSync(join(ROOT, 'src', 'private-work.js'), 'utf8');
  check(/export function noteFor\(event\) \{\n  if \(!enabled\(\)\) return '';/.test(src), '★★ `noteFor` 第一句就是 `if (!enabled())`');
  // ⚠️ 2026-10-16 改：`onPrivate` 里在 `enabled()` 之后**又加了一句"必须是私聊"**
  //    （群消息原来也会被当成私聊处理 ⇒ 群里有人 @ 别人也能触发私聊工作 ✗）
  //    ⇒ 断言跟着改成"先过 enabled、再过 message_type，然后才是 uid" ✓
  check(
    /if \(!enabled\(\)\) return false;[\s\S]{0,600}?message_type[\s\S]{0,200}?const uid = String\(event\?\.user_id/.test(
      src,
    ),
    '★★ `onPrivate` 先过 enabled、再确认是私聊，然后才取 uid',
  );
  config.privateWork.enable = true;
}

console.log('\n【18】★★★ 收到文件先起一次**只读**预读，把概要拿去问细节');
{
  const uid = '2888888888';
  config.privateWork.enable = true;
  pw.__setFriends({ [uid]: '客户' });
  const dir = pw.ensureWorkspace(uid, '客户');
  const srcFile = join(ROOT, 'logs', '__test-pw-src2.js');
  writeFileSync(srcFile, 'const a = 1;\n', 'utf8');
  writeFileSync(join(pw.incomingDir(uid), 'a.js'), 'const a = 1;\n', 'utf8');

  let seen = null;
  pw.__setRunner(async (prompt, hooks) => {
    seen = { prompt, hooks };
    return { promise: Promise.resolve({ code: 0, stdout: '这是一个 Node 小脚本，作用是……' }), kill: () => {} };
  });
  const bot = {
    call: async (a) => (a === 'get_file' ? { file: srcFile } : {}),
    sendText: async () => {},
  };
  await pw.onPrivate(
    { message_type: 'private', user_id: uid, message: [{ type: 'file', data: { name: 'a.js', file_id: 'x' } }] },
    null,
    bot,
  );
  await new Promise((r) => setTimeout(r, 100));

  check(!!seen, '★★ 收到文件 → 真的起了一次 agent（先把文件读一遍是什么）');
  check(
    seen?.hooks?.permission === 'read-only',
    '★★★ 那一次是 **只读** —— 用户：「agent 这时是只读，**不要开始工作**」',
    String(seen?.hooks?.permission),
  );
  check(/只许看，不许改/.test(seen?.prompt ?? ''), '★ 提示词里也明写"只许看、不许改、别翻外面"');
  check(existsSync(join(dir, '文件概要.md')), '★★ 概要落成 `文件概要.md`（只读模式下它写不了盘，我们替它写）');
  const n = pw.noteFor({ message_type: 'private', user_id: uid });
  check(/文件是什么/.test(n), '★★ 概要会被念给她听');
  check(/Node 小脚本/.test(n), '★★ 她看到的就是那份概要 —— 照着它去问对方细节');
  const asrc = readFileSync(join(ROOT, 'src', 'agent-bridge.js'), 'utf8');
  check(/hooks\.permission \?\? ''/.test(asrc), '★ `agent-bridge` 支持按次指定权限（不传 = 老行为 workspace-write）');
  pw.__setRunner(null);
}

console.log('\n【19】★★ 分条的下一条要"像真人在打字"（每字 0.25 秒）');
{
  const { chunkDelay, typingWait } = await import('../src/bot.js');
  const keep = { ...config.chunking };
  // ① 默认（`typeDelayPerChar` 不配）⇒ **老行为**：固定 `delayMs`
  config.chunking = { delayMs: 700, typeDelayPerChar: 0 };
  check(chunkDelay() === 700, '★ 没配 `typeDelayPerChar` → 还是老的固定间隔（别的号一个字没变）');

  // ② 配了就按"刚发出去那段的字数"算
  config.chunking = { delayMs: 700, typeDelayPerChar: 250, typeDelayMinMs: 500, typeDelayMaxMs: 8000 };
  const b = new Bot();
  b.selfId = '10000002';
  // ⚠️ 借"人工接管"把 sendText 当**记账**用（它会记下刚说的那段，但一条都不发出去）
  config.humanTakeover = { enable: true };
  await b.sendText({ message_type: 'group', group_id: '50001' }, '一二三四五六七八九十'.repeat(4));
  const d40 = chunkDelay();
  // ⚠️ 2026-10-14 改：按字算的打字延迟**已经挪到 `sendText()`** 了（含第一条）——
  //    `chunkDelay()` 现在只管"分条之间"那个固定间隔 ✓
  //    （老断言盯的是 chunkDelay 里按字算，所以这里不再断言它按字数变长）
  check(d40 >= 400, '★ 分条之间的间隔照旧生效（不低于下限）', `${d40}ms`);

  // ⚠️ 两次测量都得**开着接管**（那样 `sendText` 只记账、不真发 ——
  //    不然它会去连协议端，套件里连不上就抛 ✗）
  await b.sendText({ message_type: 'group', group_id: '50001' }, '嗯');
  config.humanTakeover = { enable: false };
  const d2 = chunkDelay();
  check(d2 >= 400 && d2 <= 700, '★ 一两个字 → 走**下限**（0.5 秒上下），不会等太久', `${d2}ms`);

  config.chunking = keep;
  const srcB = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(/typeDelayPerChar \?\? 0/.test(srcB), '★ 默认值是 0（不启用）');
  check(/lastSentText = String\(text \?\? ''\)/.test(srcB), '★ `sendText` 里真的记了"刚说的那段"');
  check(/let lastSentText = ''/.test(srcB), '★ 那个模块级变量在');

  // ⚠️⚠️ 2026-10-15 加（用户截图：「**第二条一瞬间就发出来了**」）——
  //    现场（群聊，一次生成分成两条）：47 字那条按配额等了 1 秒发出去（模型那 7 秒顶掉了
  //    大部分等待），31 字那条**紧跟着就冒出来**了 ✗
  //    真因：`spent` 原来一律从"本轮生成起点"算 ⇒ 第二条把**第一条的等待 + 分条间隔**
  //    也算成"已经等过了" ⇒ `wait` = 0 ✗
  //    ⇒ 那份额度只顶**第一条**；从第二条起，那是另打一段字，得按自己的字数重新等满 ✓
  const T = { perMs: 250, lo: 500, hi: 8000 };
  const w1 = typingWait({ n: 47, now: 7000, genAt: 0, typingFrom: 0, ...T });
  check(w1.wait === 1000, '★ 第一条：模型已经想了 7 秒 → 只补等 1 秒（不白等）', `wait=${w1.wait}`);
  const w2 = typingWait({ n: 31, now: 13700, genAt: 0, typingFrom: 13000, ...T });
  check(w2.wait === 7050, '★★ 第二条：按自己的字数重新等满（只扣上一条发出后的那 700ms）', `wait=${w2.wait}`);
  const bad = typingWait({ n: 31, now: 13700, genAt: 0, typingFrom: 0, ...T });
  check(bad.wait === 0, '★ 反面：若还用"生成起点"当本段起点 → `wait` 归零（就是这次报的现象）', `wait=${bad.wait}`);
  check(/typingFrom: this\._typingFrom/.test(srcB), '★★ `sendText` 真的把"上一条发出时刻"传进去了');
  check(/this\._typingFrom = Date\.now\(\)/.test(srcB), '★ 每发完一条就把本段计时起点推到现在');
}

console.log('\n【20】★★ 工作模式：发不出去就**静默**，绝不输出错误消息（用户两次要求）');
{
  // ① 纯函数判据
  check(pw.scrubOutbound('⚠️ 这条没记下来：模型没有返回可解析的 json') === '', '★ 带 ⚠️ 的**整条不发**');
  check(
    pw.scrubOutbound('ReferenceError: x is not defined\n    at foo (file:1:2)') === '',
    '★ 报错原文 / 堆栈不发',
  );
  check(pw.scrubOutbound('[私聊工作] 交付失败') === '', '★ 我们自己的日志前缀不发');
  check(pw.scrubOutbound('东西在 C:\\x\\agentwork\\私聊\\123 里') === '', '★ 工作区路径不发');
  check(
    pw.scrubOutbound('……刚卡了一下，你再说一遍行吗') === '……刚卡了一下，你再说一遍行吗',
    '★ 人话照发（中文里"卡了一下"不算错误信息）',
  );
  check(
    pw.scrubOutbound('第一次用这个软件，导出的文件在哪？') === '第一次用这个软件，导出的文件在哪？',
    '★ 正常聊天一个字都不动',
  );

  // ② 消息段数组：文字带 ⚠️ ⇒ **整条**不发（不许把那张图单独甩过去）
  const segs = [
    { type: 'text', data: { text: '⚠️ 出错了' } },
    { type: 'image', data: { file: 'x.png' } },
  ];
  check(pw.cleanOutMessage(segs) === '', '★ 图文混排里文字带 ⚠️ ⇒ 整条不发');
  const okSegs = [
    { type: 'image', data: { file: 'x.png' } },
    { type: 'text', data: { text: '给你' } },
  ];
  check(Array.isArray(pw.cleanOutMessage(okSegs)), '★ 干净的消息原样返回（图照发）');

  // ③ 走**真 `call()`** —— 那是最底层那道闸（聊天回复 / 交付 / 定时任务全从这儿出去）
  const keepW = config.privateWork;
  const keepT = config.humanTakeover;
  const keepOwner = config.ownerQQ;
  config.privateWork = { ...(keepW ?? {}), enable: true };
  config.humanTakeover = { enable: false };
  const b = new Bot();
  b.selfId = '10000002';
  const r1 = await b.call('send_private_msg', { user_id: FRIEND, message: '⚠️ API Key 似乎不对' });
  check(
    r1?.status === 'ok' && r1?.retcode === 0,
    '★★ 被拦的外发**假装成功**（不触发重试、也不进补发箱）',
  );
  // 干净的话放行 ⇒ 会去真发送 ⇒ 套件没连协议端 ⇒ reject（这条同时证明闸没误伤 ✓）
  let passed = false;
  try {
    await b.call('send_private_msg', { user_id: FRIEND, message: '行，我看看' });
  } catch {
    passed = true;
  }
  check(passed, '★ 正常文本**没被拦**（照样走真发送路径）');
  // ④ 发给**主人**的运维通知放行 —— 他就是要看真相（工作区路径、超了几轮）
  config.ownerQQ = '10000009';
  let ownerPassed = false;
  try {
    await b.call('send_private_msg', {
      user_id: '10000009',
      message: '⚠️ 这单超时了，工作区：C:\\x\\agentwork',
    });
  } catch {
    ownerPassed = true;
  }
  check(ownerPassed, '★ 发给**主人**的通知不拦（工作区路径要留着）');
  config.privateWork = keepW;
  config.humanTakeover = keepT;
  config.ownerQQ = keepOwner;

  // ⑤ 交付那句：失败时**一个字都不说**（源码级 —— 空文案没法在离线套件里跑出来）
  const pwSrc = readFileSync(join(ROOT, 'src', 'private-work.js'), 'utf8');
  check(!/const say = sent/.test(pwSrc), '★★ 交付那句**不再按成败分三种说法**（旧的三元赋值已删）');
  check(/if \(sent\) \{/.test(pwSrc), '★ 只有真发出去了才开口说那句话');
  // ⑥ 工作模式关着的时候一个字都不许变（别的号不受影响）
  config.privateWork = { ...(keepW ?? {}), enable: false };
  const b2 = new Bot();
  b2.selfId = '10000002';
  let offPassed = false;
  try {
    await b2.call('send_private_msg', { user_id: FRIEND, message: '⚠️ 别的号照旧发' });
  } catch {
    offPassed = true;
  }
  check(offPassed, '★ **没开工作模式**的号：一个字都不拦（闸只对工作号生效）');
  config.privateWork = keepW;
}

console.log('\n【21】★★ 工作模式下**禁止学习**（用户原话：「工作模式下得禁止学习」）');
{
  const keepW2 = config.privateWork;
  const keepTeach = config.teach;
  // ① 开关跟着工作模式走
  config.privateWork = { ...(keepW2 ?? {}), enable: true };
  check(pw.noLearn() === true, '★ 工作模式开着 ⇒ `noLearn()` 为真');
  config.privateWork = { ...(keepW2 ?? {}), enable: false };
  check(pw.noLearn() === false, '★ 关着 ⇒ 别的号一个字都不变');
  config.privateWork = { ...(keepW2 ?? {}), enable: true };

  // ② 谁都不许教它（明确教学 + 自然教学都走 canTeach）
  config.teach = { enable: true, teachers: ['10000001'], bots: [] };
  const b = new Bot();
  b.selfId = '10000002';
  const ev = {
    message_type: 'group',
    group_id: '50001',
    user_id: '10000001',
    sender: { nickname: '<主人>' },
  };
  check(b.canTeach(ev) === false, '★★ 工作模式：**连主人本人都教不了**（canTeach 直接 false）');
  // 反过来：同样的配置、工作模式关掉 ⇒ 照旧允许（证明挡的是工作模式，不是别的东西）
  config.privateWork = { ...(keepW2 ?? {}), enable: false };
  check(b.canTeach(ev) === true, '★ 工作模式关掉 ⇒ 教学照旧（挡的确实是工作模式）');
  config.privateWork = { ...(keepW2 ?? {}), enable: true };

  // ③ 群观察 / 资料更新两条写入路径都不记（源码级 —— 它们要发模型，离线套件跑不动）
  const bSrc = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    /if \(privateWork\.noLearn\(\)\) \{[\s\S]{0,300}?observe\.note\(payload, text\);[\s\S]{0,400}?ownerUpdate\.note\(payload, text\);/.test(
      bSrc,
    ),
    '★★ `observe.note` 和 `ownerUpdate.note` 都在同一个 `noLearn()` 分支后面',
  );
  check(
    /canTeach\(event\) \{[\s\S]{0,400}?privateWork\.noLearn\(\)/.test(bSrc),
    '★ `canTeach()` 开头就挡（自然教学也走它，不用另加一道）',
  );
  const iSrc = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8');
  check(
    /config\.observe\?\.enable !== false && !privateWork\.noLearn\(\)/.test(iSrc),
    '★★ 群友观察（summarize）的定时器：工作号整个不起',
  );
  check(
    /ownerUpdate\?\.enable !== false && !privateWork\.noLearn\(\)/.test(iSrc),
    '★★ 资料自动更新的定时器：工作号整个不起',
  );
  check(
    /observe\?\.compress\?\.enable !== false &&\s*!privateWork\.noLearn\(\)/.test(iSrc),
    '★★ 群记忆压缩的定时器：工作号整个不起',
  );
  // ④ 禁止学习**不能**连带把"接话"掐了（用户之前的要求：正常接话、不返回错误信息）
  check(
    /if \(this\.canTeach\(event\)\) \{/.test(bSrc),
    '★ 教学那条分支由 `canTeach` 把关 ⇒ 不给资格就**自然落回普通聊天**（照样接话）',
  );
  config.teach = keepTeach;
  config.privateWork = keepW2;
}

console.log('\n【22】★★ 一个私聊**只留一条**任务历史 + 会话 id 要补上（用户截图报的两件事）');
{
  const uid = '2999999999';
  const keepW3 = config.privateWork;
  config.privateWork = { ...(keepW3 ?? {}), enable: true };
  pw.__setFriends({ [uid]: '客户' });
  pw.ensureWorkspace(uid, '客户');
  const srcFile = join(ROOT, 'logs', '__test-pw-src3.js');
  writeFileSync(srcFile, 'const b = 1;\n', 'utf8');

  // 历史是**按号**落盘的（套件已经把它隔离到 logs/__test-pw-agent.json）
  const histFile = join(
    ROOT,
    process.env.QQBOT_AGENT_TASKS_FILE ?? 'logs/__test-pw-agent.json',
  );
  const dmRows = () => {
    try {
      const j = JSON.parse(readFileSync(histFile, 'utf8'));
      return (j.tasks ?? []).filter(
        (t) => !t.gid && /^dm/.test(String(t.kind ?? '')) && String(t.by) === uid,
      );
    } catch {
      return [];
    }
  };

  let sid = 0;
  pw.__setRunner(async (_prompt, hooks) => {
    const id = `session-test-dm-${++sid}`;
    // ⚠️ 真的 `cliRunner` 是**进程退出后**才调 `onSetup`（headless 拿不到更早的 id）——
    //    这里照那个时序模拟，不然测不出"接到就补进历史"这件事
    setTimeout(() => {
      try {
        hooks?.onSetup?.({ sessionId: id });
      } catch {}
    }, 10);
    return {
      promise: Promise.resolve({ code: 0, stdout: '这是一份任务书，要求做……', sessionId: id }),
      kill: () => {},
    };
  });
  const bot = {
    call: async (a) => (a === 'get_file' ? { file: srcFile } : {}),
    sendText: async () => {},
  };
  const fileEv = (name) => ({
    message_type: 'private',
    user_id: uid,
    message: [{ type: 'file', data: { name, file_id: 'x' } }],
  });

  const before = dmRows().length;
  writeFileSync(join(pw.incomingDir(uid), 'b1.js'), '1\n', 'utf8');
  await pw.onPrivate(fileEv('b1.js'), null, bot);
  await new Promise((r) => setTimeout(r, 180));
  const after1 = dmRows();
  // ⚠️ 2026-10-16 改：「文件变没变」的判据换成"名字+大小+改时间"之后更敏感 ⇒
  //    前面那些场景可能**已经给这个 uid 建过历史**了 ⇒ 这里复用它也**是对的**
  //    （设计本来就是"一个私聊只留一条"✓ 下面那条 ✅「预读复用同一个私聊唯一的那条历史」盯的就是它）
  //    ⇒ 所以这里只要求"有历史、没弄丢"，不强制"必须新建" ✓
  check(after1.length >= before, '★ 第一批文件 → 有历史（新建或复用同一条都算）', `${before} → ${after1.length}`);
  check(
    !!String(after1[after1.length - 1]?.sessionId ?? '').trim(),
    '★★ 会话 id 写进了历史（不然点开就是「（这次没有可显示的对话）」）',
    String(after1[after1.length - 1]?.sessionId ?? '(空)'),
  );

  writeFileSync(join(pw.incomingDir(uid), 'b2.js'), '2\n', 'utf8');
  await pw.onPrivate(fileEv('b2.js'), null, bot);
  await new Promise((r) => setTimeout(r, 180));
  const after2 = dmRows();
  check(
    after2.length === after1.length,
    '★★★ 第二批文件**不再新建**一条 —— 用户：「一个号只能建立一个对话」',
    `${after1.length} → ${after2.length}`,
  );
  // 源码级：那个"复用同一条"的判据得在（预读和开工一共只有一条）
  const src3 = readFileSync(join(ROOT, 'src', 'private-work.js'), 'utf8');
  check(
    /const hid = s\.readHistId \|\| s\.histId \|\| ''/.test(src3),
    '★★ 预读复用同一个私聊唯一的那条历史（不再无条件 addPrivateHist）',
  );
  check(
    /onSetup: \(\{ sessionId \}\) => \{[\s\S]{0,400}?patchPrivateHist\([^)]*sessionId/.test(src3),
    '★ 预读的 `onSetup` 里把会话 id 补进历史',
  );
  pw.__setRunner(null);
  config.privateWork = keepW3;
}

console.log('\n【23】★★ 工作号不许出现"机器味"的特殊回复（用户截图：工作号报了账）');
{
  // 现场：工作号在群里回「天花板看出来了 我这边调用了 148 次 花了 0.58 元」
  //   —— 那是**报账**那条特殊回复（直接甩机器数据，不经过正常聊天）✗
  // ⚠️ 配置那边也关了（`accounts/<那个号>.yml` 的 `spend: enable: false`），
  //    但**不靠它**：那些开关是手工列的，实测就漏了 `spend` ⇒ 代码再兜一道 ✓
  const b3 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const spendGate = (b3.match(/config\.spend\?\.enable !== false && !privateWork\.noGimmick\(\)/g) ?? [])
    .length;
  check(spendGate >= 2, '★★ 报账 + 工资注入**两处**都被工作模式挡掉', `命中 ${spendGate} 处`);
  check(
    /!privateWork\.noGimmick\(\) &&\s*String\(event\.user_id\) === String\(config\.ownerQQ\) &&\s*\/\^起始账/.test(
      b3,
    ),
    '★ 「起始账」这个财务指令也不做',
  );
  check(
    /!privateWork\.noGimmick\(\) &&\s*bilibili\.looksLikeVideoQuestion/.test(b3),
    '★ B站播报不做（同报账那条）',
  );
  const dmGate = (
    b3.match(/!\(privateWork\.enabled\(\) && event\.message_type === 'private'\)/g) ?? []
  ).length;
  check(dmGate >= 2, '★★ 工作模式的**私聊**里不认指令（清空对话 / 停止 两道）', `命中 ${dmGate} 处`);
  // `noGimmick()` 本身跟着工作模式走（别的号一个字都不变）
  const keepW4 = config.privateWork;
  config.privateWork = { ...(keepW4 ?? {}), enable: true };
  check(pw.noGimmick() === true, '★ 工作模式开着 ⇒ 挡');
  config.privateWork = { ...(keepW4 ?? {}), enable: false };
  check(pw.noGimmick() === false, '★★ 没开工作模式的号（主号 / 爱音）一个字都不变');
  config.privateWork = keepW4;
}

console.log('\n【24】★★ 工作号不许出现在任何"同类池"里（用户：「工作号不要加同类池」）');
{
  // ⚠️ 起因：用户「同类池里这一个删不掉」——
  //    真因是 `pools.sync()` 会把**我们管的每个号**自动补进同群的 peers
  //    ⇒ 他手动删掉、下次同步又补回来 ✗
  //    修法：`pools.js` 里按 `privateWork.enable` 排除（不写死号）✓
  const yaml = (await import('js-yaml')).default;
  const dir = join(ROOT, 'accounts');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.yml')) : [];
  const texts = new Map();
  for (const f of files) texts.set(f.replace(/\.yml$/, ''), readFileSync(join(dir, f), 'utf8'));
  // 工作号 = `privateWork:` 段里有 `enable: true`
  const isWorkYml = (t) => {
    const lines = t.split('\n');
    let inPW = false;
    for (const line of lines) {
      if (/^privateWork:\s*$/.test(line)) {
        inPW = true;
        continue;
      }
      if (inPW) {
        if (/^\S/.test(line)) inPW = false;
        else if (/^\s+enable:\s*true\s*$/.test(line)) return true;
      }
    }
    return false;
  };
  const workIds = new Set([...texts].filter(([, t]) => isWorkYml(t)).map(([qq]) => qq));
  check(workIds.size > 0, '★ 认得出来哪个是工作号（扫 privateWork.enable）', `${workIds.size} 个`);

  // ① 别的号的 peers 里不许有工作号
  const bad = [];
  for (const [qq, t] of texts) {
    if (workIds.has(qq)) continue;
    let j;
    try {
      j = yaml.load(t);
    } catch {
      continue;
    }
    for (const [gid, v] of Object.entries(j?.groupParams ?? {})) {
      for (const p of v?.peers ?? []) if (workIds.has(String(p))) bad.push(`${qq}@${gid}`);
    }
  }
  check(!bad.length, '★★ 没有别的号把工作号当同类', bad.join(' '));

  // ② 工作号自己也没有同类池（不跟任何人互相搭话）
  for (const qq of workIds) {
    let j;
    try {
      j = yaml.load(texts.get(qq));
    } catch {
      continue;
    }
    const n = Object.values(j?.groupParams ?? {}).reduce((a, v) => a + (v?.peers?.length ?? 0), 0);
    check(n === 0, `★★ 工作号（尾号 ${qq.slice(-4)}）自己没有同类池`, `${n} 个`);
  }

  // ③ 源码级：自动同步里真的排除了（不然"删了又补回来"会复发）
  const psrc = readFileSync(join(ROOT, 'src', 'pools.js'), 'utf8');
  check(/function isWorkAccount/.test(psrc), '★★ `pools.js` 里有"工作号"判据');
  check(
    /filter\(\(x\) => !isWorkAccount\(x\)\)/.test(psrc),
    '★★ 同步的号名单里把工作号**滤掉**了（这是"删不掉"的真因）',
  );
}

console.log('\n【25】★★ 「agent 做不到的都得拒绝掉」（用户 2026-10-15 加严）');
{
  const pSrc = readFileSync(join(ROOT, 'src', 'private-work.js'), 'utf8');
  // ① 人设里那节"做不了的一律当场拒"要在
  //    ⚠️ 直接读**真实人设文件**（`pw.personaText()` 读的是套件那份测试人设，是空的）；
  //       公开副本里 `personas/` 本来就不存在 ⇒ 没有就跳过 ✓
  const pf = join(ROOT, 'personas', '<主人>', 'persona.md');
  if (existsSync(pf)) {
    const pText = readFileSync(pf, 'utf8');
    check(/做不了的一律/.test(pText), '★★ 人设里有「做不了的一律当场拒」那一节');
    for (const kw of ['答辩', '打印装订', '连他电脑上的', '真机联调', '包过', '抢课']) {
      check(pText.includes(kw), `★ 那一节点名了「${kw}」这类`);
    }
    check(/当场说清|别含糊/.test(pText), '★ 而且要求**当场说清**（别含糊、别先收钱再退）');
    // ⚠️ 2026-10-15 用户定：Unity / Blender 那类推掉，但**网页小游戏要接** ——
    //    最怕的是"一听见游戏两个字就推"（那会把能赚的活推掉）✗
    check(/Unity/.test(pText) && /Blender/.test(pText), '★★ 3D / 游戏引擎那类在"做不了"清单里');
    check(
      /网页小游戏/.test(pText) && /能做/.test(pText),
      '★★ 同时明确写了「**网页小游戏能做**」（别把这两样混起来）',
    );
  } else {
    console.log('  ⏭  没装这个人设（公开副本里本来就没有）→ 跳过');
  }
  // ② agent 侧（工作区 AGENTS.md）也要有：真做不了就直说、别硬糊一个交差
  check(
    /做不了，就直说做不了/.test(pSrc) && /别硬做/.test(pSrc),
    '★★ 工作区的 AGENTS.md 里让 agent「做不了就直说、别硬做」',
  );
}

console.log('\n【26】★★ 返工：交付后说"改"直接接着改 + 交付只发本轮产物');
{
  const uid = '2666666666';
  const keepW5 = config.privateWork;
  config.privateWork = { ...(keepW5 ?? {}), enable: true };
  pw.__setFriends({ [uid]: '客户' });
  pw.ensureWorkspace(uid, '客户');
  const fakeBot = { call: async () => ({}), sendText: async () => {} };
  let ran = 0;
  pw.__setRunner(async () => {
    ran++;
    return {
      promise: Promise.resolve({ code: 0, stdout: '好', sessionId: `session-rw-${ran}` }),
      kill: () => {},
    };
  });

  // ── A：交付完了（done）他说"改成…" ⇒ **直接接着改** ──
  //    ⚠️ 原来 `done → intake` 会把返工当新活：再问一遍"要不要开始"+ 重新估时间 ✗
  pw.patchState(uid, {
    stage: 'done',
    need: '做一份简历',
    etaAt: 0,
    etaMinutes: 30,
    outBase: '',
    selfCheckRounds: 0,
    timeoutRounds: 0,
  });
  const say = (t) => ({ message_type: 'private', user_id: uid, message: [{ type: 'text', data: { text: t } }] });
  await pw.onPrivate(say('把标题改成"个人简历"'), null, fakeBot);
  await new Promise((r) => setTimeout(r, 200));
  check(ran >= 1, '★★ 交付后说「改成…」⇒ **当场又起了一轮 agent**（不走"重新接单"那套）');
  check(
    pw.stateOf(uid).stage !== 'confirming',
    '★★ 而且**没退回"等你点头"**那一档（不用他再说一遍"开始"）',
    pw.stateOf(uid).stage,
  );

  // ── 反例：闲聊 / 新话题 ⇒ 一个字都不许动 ──
  ran = 0;
  pw.patchState(uid, { stage: 'done', etaAt: 0, outBase: '' });
  await pw.onPrivate(say('你好呀，在干嘛'), null, fakeBot);
  await new Promise((r) => setTimeout(r, 150));
  check(ran === 0, '★★ 闲聊**不许**触发重跑（判据宁缺勿滥，不然费钱又费时）');

  // ── C：交付只发**这一轮**的产物 ──
  //    ① 先放一个"上一轮留下的"旧产物
  writeFileSync(join(pw.outDir(uid), '旧产物.docx'), 'old', 'utf8');
  //    ② 起一轮（`startJob` 会记下基线 = 含旧产物）；etaAt 给到未来，免得它自己交付
  ran = 0;
  pw.patchState(uid, { stage: 'done', outBase: '', etaAt: Date.now() + 3600_000, selfCheckRounds: 0 });
  await pw.onPrivate(say('再加上一页实习经历'), null, fakeBot);
  await new Promise((r) => setTimeout(r, 250));
  check(ran >= 1, '★ 这一轮真的跑起来了（基线也是这时记的）');
  //    ③ 这一轮产出新文件
  writeFileSync(join(pw.outDir(uid), '新产物.docx'), 'new', 'utf8');
  const sentNames = [];
  const bot2 = {
    call: async (a, p) => {
      if (a === 'upload_private_file') sentNames.push(String(p.file).split(/[\\/]/).pop());
      return { status: 'ok', retcode: 0 };
    },
    sendText: async () => {},
  };
  // ⚠️⚠️ 2026-10-16：交付**加了互斥**（同一号同一时间只跑一路，防并发上传 ✗）——
  //    这一节里之前那几轮可能还有一个交付在后台跑 ⇒ 直接调会拿到 `{ok:false, why:'正在交付中'}`，
  //    看着像"一个都没发" ✗ ⇒ 先等它结束再调 ✓（`__delivering()` 是只读探针）
  for (let i = 0; i < 40 && pw.__delivering().map(String).includes(String(uid)); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  await pw.deliver(uid, bot2);
  check(
    sentNames.includes('新产物.docx') && !sentNames.includes('旧产物.docx'),
    '★★ 交付**只发这一轮的**新产物（上一轮的别再跟着发一遍）',
    sentNames.join('、') || '（一个都没发）',
  );

  pw.__setRunner(null);
  config.privateWork = keepW5;
}

// 收尾：清掉这次用的临时目录 / 配置（别留垃圾在 logs/ 里）
try {
  rmSync(ROOT_ABS, { recursive: true, force: true });
  rmSync(join(ROOT, WFILE), { force: true });
  rmSync(join(ROOT, WFILE) + '.tmp', { force: true });
  rmSync(join(ROOT, CFG_REL), { force: true });
  rmSync(join(ROOT, PERSONA), { force: true });
} catch {}

console.log('\n【27】★★ 分好友的「人工接管」开关 + 搜索框（2026-10-15 用户要求）');
{
  // 用户原话：「把工作模式的**分好友设置也加一个人工接管开关**」
  //   +「加个**搜索筛选框**来快捷找到要控制的好友卡片」。
  // 语义：跟号级那个一样，只是范围只有这一个人 —— 他的私聊由用户自己回，机器人一声不吭；
  //   ⚠️ 但**照常落盘** ⇒ 接管完切回机器人，它还认得这段聊天 ✓
  // ⚠️ 名单也要摆好 —— uiData() 列的是**协议端那份好友名单**里的
  pw.__setFriends({ [FRIEND]: '小明', [STRANGER]: '路人' });
  config.privateWork.friends = { [FRIEND]: { takeover: true }, [STRANGER]: {} };
  check(pw.friendTakeover(FRIEND) === true, '★★ 勾了「人工接管」⇒ 这个人的私聊由我自己回');
  check(pw.friendTakeover(STRANGER) === false, '★ 没勾的人照旧（默认关）');
  check(pw.friendTakeover('99999999') === false, '★ 完全没配过的人也是关的');

  const d27 = pw.uiData();
  check(
    d27.friends.some((f) => f.qq === FRIEND && f.cfg.takeover === true),
    '★ `uiData` 把接管状态带给界面那张表',
  );

  // ⚠️⚠️ **bot 那边的判据里也得有它** —— 不然界面上勾了没人管 ✗
  const b27 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    /if \(privateWork\.friendTakeover\(uid\)\) return false;/.test(b27),
    '★★ 私聊回复判据里真的拦了（勾了就不回他）',
  );

  // 前端：搜索框 + 那一列（⚠️ 这两样只能扫源码 —— 它们是纯 DOM 的事）
  const w27 = readFileSync(join(ROOT, 'src', 'webui.html'), 'utf8');
  check(/id="pw-friend-search"/.test(w27) && /function filterPwFriends/.test(w27), '★★ 搜索筛选框在');
  check(/pwf-takeover-/.test(w27) && /人工接管<\/th>/.test(w27), '★★ 分好友那张表里有「人工接管」这一列');
}

console.log('\n【28】★★ 自己发出去的文件被协议端回显 ⇒ 不许当成对方发来的（2026-10-16 用户截图抓到的）');
{
  // 现场：工作号把做好的 pptx 私聊发给对方，**8 秒后同一个文件**（同名、同字节数、
  //   SHA256 一模一样）被当成"对方发来的文件"推回来 ⇒
  //   起了一次只读预读（白花钱），她还回了一句「噢，那不就是我发你那个吗」
  //   —— 用户一眼看出视角反了（那两个文件我核过 SHA256，完全一致）✗
  const { Bot } = await import('../src/bot.js');
  const b = Object.create(Bot.prototype);
  b.selfId = '10000002';
  b.noteSentFile('10000002', 'QQ界面.pptx', 105701);
  const seg = (type, data) => ({ type, data });

  check(
    b.isOwnEcho({
      post_type: 'message',
      message_type: 'private',
      user_id: '10000002',
      message: [seg('file', { name: 'QQ界面.pptx', size: 105701 })],
    }) === true,
    '★★ 自己刚发出去的那个文件又"收到" ⇒ 认出来是回显（不回、不预读）',
  );
  check(
    b.isOwnEcho({ post_type: 'message_sent', message_type: 'private', user_id: '10000003', message: [] }) === true,
    '★ `message_sent`（协议端明说"这是自己发的"）也认',
  );
  check(
    b.isOwnEcho({
      post_type: 'message',
      message_type: 'private',
      user_id: '10000003',
      message: [seg('text', { text: '在吗' })],
    }) === false,
    '★★ 对方发来的普通消息**一律不受影响**（这道闸绝不许吃消息）',
  );
  check(
    b.isOwnEcho({
      post_type: 'message',
      message_type: 'private',
      user_id: '10000003',
      message: [seg('file', { name: '别的.docx', size: 1234 })],
    }) === false,
    '★ 对方发来**别的**文件不受影响',
  );
  check(
    b.isOwnEcho({
      post_type: 'message',
      message_type: 'group',
      group_id: '999000001',
      user_id: '10000003',
      message: [seg('file', { name: 'QQ界面.pptx', size: 105701 })],
    }) === false,
    '★ 群里别人发个**同名**文件也被保护住（只认私聊的回显）',
  );

  // ⚠️⚠️ 这条是**血泪教训**：上一版按「user_id === 本机号」判 ⇒ `sensitivity` 当场红 16 项
  //    （她自己的话进上下文时本来就是 `user_id = 本机号`）⇒ 宽判据会**把正常消息吃掉** ✗
  const b2 = Object.create(Bot.prototype);
  b2.selfId = '10000002';
  check(
    b2.isOwnEcho({
      post_type: 'message',
      message_type: 'group',
      group_id: '999000001',
      user_id: '10000002',
      message: [seg('text', { text: '我自己说的一句' })],
    }) === false,
    '★★ **她自己的话进上下文**（user_id = 本机号）不许被吃掉 —— 宽判据会让一整套红',
  );
}

console.log('\n【29】★★ 好友卡上的工作进度 / 倒计时 / 立刻发送 / 按最近对话排序（2026-10-16 用户要求）');
{
  // 用户原话：「工作模式分好友界面加一个**工作进度**显示 —— 对话状态、任务完成状态、
  //   **还有多久自动发送产物**，再加一个**手动立刻发送产物**按钮」
  //   +「好友排序改成**按最近对话时间**排，有新对话的排在上面」
  const d = pw.uiData();
  const one = d.friends[0] || {};
  check(Array.isArray(one.arts), '★★ 每个好友都带「产物」清单（界面要显示"产物（N）：…"）');
  check(typeof one.talkAt === 'number', '★★ 带「最近对话时间」（排序 + "几分钟前说过话"都靠它）');
  check(
    typeof one.busy === 'boolean' && 'sentAt' in one && 'etaAt' in one,
    '★ 还带"正跑着 / 上次发出去的时间 / 自动发送的到点时间"',
  );

  // 界面那几样是纯 DOM 的事 ⇒ 只能扫源码
  const w = readFileSync(join(ROOT, 'src', 'webui.html'), 'utf8');
  check(/function pwTickEta/.test(w) && /\.pw-eta/.test(w), '★★ 倒计时每秒刷（`pwTickEta`）在');
  check(/function pwDeliverNow/.test(w) && /立刻发送产物<\/button>/.test(w), '★★ 「立刻发送产物」按钮在');
  // ⚠️ 2026-10-16 用户报过「**没看到立即发送的按钮**」：原来按钮只在"等交付/交付过/发失败"
  //    才出现，可 `stage` 常常已经回到 `intake`（客户又开始聊下一件）⇒ 产物在、按钮没了 ✗
  //    ⇒ 钉死：**只要有产物就给按**，别再往这个条件里加 stage ✓
  check(/const canSend = arts\.length > 0;/.test(w), '★★ 按钮的判据只看"有没有产物"（不许再加 stage 条件）');
  check(/border-top:1px dashed/.test(w), '★ 名字和进度之间那条虚线分割线在（用户说"有点乱了"）');

  // ⚠️⚠️ 2026-10-16（用户截图问「**是不是又没看文档**」之后，用户又拍板）——
  //    原话：「还是不要直接转为txt吧，万一里面有图片怎么办，**还是得丢给 agent 保险一点**」
  //    ⇒ ① **不许**把转出来的 txt 当"她看文档"的来源（txt 里没图，照着答会漏要害）✗
  //       ② 预读（agent 那条路）里必须写明"**图也要看**"✓
  //       ③ 重启会把预读带走，可 `reading: true` 留在落盘里 ⇒ 以后**文件再也不预读** ✗
  const src29 = readFileSync(join(ROOT, 'src', 'private-work.js'), 'utf8');
  check(
    !/const docText = recentDocText\(uid\)/.test(src29),
    '★★ 不再把转出来的 txt 塞给她（用户：图会漏，得让 agent 看）',
  );
  check(
    /必须看图/.test(src29) && /read_image/.test(src29),
    '★★ 预读里写明了"有图必须看图"（docx 里的图要解压出来看）',
  );
  check(
    /if \(st\.uid\[k\]\?\.reading\) \{/.test(src29),
    '★★ 重启后把卡住的 `reading` 复位（不然那个人的文件再也不预读）',
  );
  // ⚠️⚠️ 2026-10-16（用户：「**看看这次丢给 agent 了吗**，而且我没在本机任务上面看到」）——
  //    真因：判"文件变没变"原来只比**文件名列表** ⇒ **同名文件被覆盖**时列表没变 ⇒
  //    当成"没新东西" ⇒ **不起预读** ✗（实测 00:34 读过那份 docx，00:42 他重发同名文件就没读）
  check(
    /function incomingKey/.test(src29) && !/const readKey = listIncoming\(uid\)\.join/.test(src29),
    '★★ "文件变没变"按 名字+大小+改时间 算（同名覆盖也要重新起预读）',
  );
  // ⚠️⚠️ 2026-10-16（用户：「**你看看任务开始了吗**，那个界面还是停留在 ppt 那里」）
  //    真因两条，都在这里钉住：
  //    ① 开工判定原来写「宁缺勿滥」⇒ 客户把「完成课题一把项目给我」说了三遍、还回了「彳亍」，
  //       它照样判"缺" ⇒ stage 永远停在 intake ⇒ **活永远不开工** ✗
  //    ② 她自己照旧说「行嘞，那我动手了。弄好直接甩你」⇒ 对面等一个永远不来的东西 ✗
  // ⚠️ 断言写成**正向**的：查注释里有没有那个词会误伤（上一版就是把自己注释里的
  //    "宁缺勿滥"匹配上了 ⇒ 假红 ✗）
  check(
    /能开工就算够\*\*：他说清了「做什么」就够/.test(src29),
    '★★ 开工判定已放宽（"能开工就算够"），不再宁缺勿滥 —— 不然活永远开不了工',
  );
  check(/一个字都不许提/.test(src29), '★★ 还没开工时不许宣告"动手了"（说了对面就干等）');
  // ⚠️⚠️ 2026-10-16 用户拍板：「**只计算是任务超时被打断而继续的次数，其他继续的次数都不算**」——
  //    开机自动接活**不设次数上限**（重启、我手动打断，一律接着做 ✓）；
  //    "超时"另有机制管（超时 ⇒ 接着再跑一轮；两轮还超时 ⇒ 私聊主人接管）
  //    ⇒ 钉住：不许再出现"接满 N 次就不接"那种写法 ✗
  check(
    !/if \(n >= 2\)/.test(src29) && /resumeTimes/.test(src29),
    '★★ 接着做不再有"2 次上限"（重启打断不算数）',
  );
  check(/times\.length >= 12/.test(src29), '★ 但留了刹车：1 小时里接了 12 次以上就不接（调试期放宽过）');
  // ⚠️ 2026-10-16 用户要求：「**除了关键词表，还是得要模型自己判断该不该把消息丢给 agent，
  //    光靠关键词还是容易遗漏**」⇒ 关键词没命中时**再过一次模型判**（复用群任务那套
  //    `judgeInterject`：改 / 停 / 催 / 无），并带 20 秒节流 ✓
  check(
    /judgeInterject\(txt, String\(s\.need/.test(src29),
    '★★ 关键词没命中时还要过一道模型判"这句要不要动这一单"',
  );
  check(/interjectJudgeAt/.test(src29), '★ 那道模型判有 20 秒节流（连发多条时别重复判、别烧钱）');
  // ⚠️⚠️ 2026-10-16 用户：「**修改时必须要去看看项目现在的状态，现在明显回的话不对**」
  //    +「**如果项目已经做完但是还没到发送时间的话也不能直接告诉对面做完了，要说还差一点**」
  check(
    /function myWorkNow/.test(src29) && /你手上现在有什么/.test(src29),
    '★★ 她看得到"手上现在有什么"（别再反问"你那个项目原本是什么写的"）',
  );
  check(
    /现在一个字都不许说"做完了/.test(src29),
    '★★ 做完了但没到发送时间时，不许说"做完了/弄好了"（要说"还在弄"）',
  );
  check(
    /api\("\/api\/private-work\/deliver"/.test(w),
    '★ 那个按钮走的是服务端交付那条路（**不是**另写一套发文件的代码）',
  );
  check(/sort\(\(a, b\) => \(Number\(b\.talkAt\)/.test(w), '★★ 好友表按"最近对话时间"降序排');
  check(/function pwAgo/.test(w), '★ 显示"多久之前说过话"');
  check(/pwFriendTable\(d\)[\s\S]{0,400}?, 30000\)/.test(w), '★ 每 30 秒悄悄重拉一次（新对话才会自己冒到顶上）');
}

console.log(
  '\n【30】★★ "说发码却没发"：那句**先扣住**，判完再决定 原样发 / 原样发+发码 / 换一句（2026-10-16 用户要求）',
);
{
  // 用户原话：「**改了之后会不会出现说发码但是却没发的情况？我建议在判定这是一个要发二维码
  //   的消息时先不要发送出去**，如果 20 条内没有二维码，就正常发送消息；如果 20 条内有，
  //   就**重新生成消息**，大概是"码在上面已经发过了"」
  //   现场（截图）：她发出去「行嘞，码发你了」，可 20 条内刚发过码 ⇒ 那张码**没跟着发** ⇒
  //   对面等一个永远不会到的码 ✗
  const uid = '2777777777';
  const keepW6 = config.privateWork;
  config.privateWork = { ...(keepW6 ?? {}), enable: true, payCodeDelayMs: 0 };
  pw.__setFriends({ [uid]: '客户' });
  const ev = { message_type: 'private', user_id: uid };
  const fakeBot = { call: async () => ({ status: 'ok', retcode: 0 }), sendText: async () => {} };

  // ① ⚠️ 2026-10-16 用户定了铁律「非必要不用关键词快判」——
  //    收款码那条的**快筛（PAY_SAY_RE）已经删掉**：现在**每一句私聊外发都先扣住、过模型** ✓
  check(pw.payHoldPending(ev, '行嘞，码发你了') === true, '★★ 像"要发码"的那句 ⇒ 先扣住不发');
  check(
    pw.payHoldPending(ev, '好，我看看哈') === true,
    '★★ 普通聊天也**照扣**（快筛撤了 ⇒ 让模型判"这句要不要配码" ✓）—— ' +
      '判不是钱的话，`settlePayHold` 会**原样发出去**，不会少一句 ✓',
  );
  check(
    pw.payHoldPending({ message_type: 'group', user_id: uid }, '码发你了') === false,
    '★ 群里那条路不管（只管私聊）',
  );

  const reset = (extra = {}) =>
    pw.patchState(uid, { msgCount: 100, payCodeAt: 0, payCodeMsgCount: 0, payHoldAt: 0, ...extra });
  const catcher = (bag) => (t) => {
    bag.push(t);
    return Promise.resolve({ status: 'ok', retcode: 0 });
  };

  // ② 是要钱 + 20 条内没发过 ⇒ **原话照发** + 跟着把码发出去 ✓
  reset();
  let sent = [];
  pw.__setPhrase(async ({ system }) => (system.includes('要不要发收款码') ? '发' : ''));
  await pw.settlePayHold(uid, '行嘞，码发你了', fakeBot, catcher(sent));
  check(sent.length === 1 && sent[0] === '行嘞，码发你了', '★★ 没刚发过 ⇒ 原话照发 ✓', sent.join('｜'));
  check(pw.stateOf(uid).payCodeAt > 0, '★★ 而且**真把码发出去了**（记了发放时刻，说了就有 ✓）');

  // ③ 是要钱 + 20 条内刚发过 ⇒ 🚫 **原话一个字都不许发**，换一句说 ✓
  reset({ payCodeAt: Date.now(), payCodeMsgCount: 100 });
  sent = [];
  pw.__setPhrase(async ({ system }) => {
    if (system.includes('要不要发收款码')) return '发';
    if (system.includes('换一句话说')) return '上面那个码还能扫呢';
    return '';
  });
  const before = pw.stateOf(uid).payCodeAt;
  await pw.settlePayHold(uid, '行嘞，码发你了', fakeBot, catcher(sent));
  check(
    sent.length === 1 && sent[0] !== '行嘞，码发你了',
    '★★★ 20 条内刚发过 ⇒ 原话**绝不发出去**（发了就是"说发码却没发" ✗）',
    sent.join('｜'),
  );
  check(sent[0] === '上面那个码还能扫呢', '★★ 换成"码在上面"那类说法发 ✓', sent[0] ?? '');
  check(pw.stateOf(uid).payCodeAt === before, '★ 这次**不重复发码**（别显得图钱）');

  // ④ 换出来的那句还在承诺"发码" ⇒ 不能用 ⇒ **这条干脆不发**（宁可少说一句 ✗）
  reset({ payCodeAt: Date.now(), payCodeMsgCount: 100 });
  sent = [];
  pw.__setPhrase(async ({ system }) => {
    if (system.includes('要不要发收款码')) return '发';
    if (system.includes('换一句话说')) return '码发你了，扫这个';
    return '';
  });
  await pw.settlePayHold(uid, '行嘞，码发你了', fakeBot, catcher(sent));
  check(sent.length === 0, '★★ 换出来的那句还在承诺"发码" ⇒ 直接不发（不许拿它凑数 ✗）', sent.join('｜'));

  // ⑤ 判"不是要钱的话" ⇒ 原样发、不配码
  reset();
  sent = [];
  pw.__setPhrase(async ({ system }) => (system.includes('要不要发收款码') ? '不发' : ''));
  await pw.settlePayHold(uid, '这个报价我先看看', fakeBot, catcher(sent));
  check(sent.length === 1 && sent[0] === '这个报价我先看看', '★ 不是要钱的话 ⇒ 原样发（码不跟）');
  check(!pw.stateOf(uid).payCodeAt, '★ 也没乱发码');

  pw.__setPhrase(null);
  config.privateWork = keepW6;

  // ⑥ 接线：那道闸长在**最底层出站口**（不是聊天那层 —— 不然 `sendChunk` / 定时任务会漏 ✗）
  const b30 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(/privateWork\.payHoldPending\?\.\(/.test(b30), '★★ `bot.js` 最底层出站口接了这道闸');
  check(/privateWork\.settlePayHold\(/.test(b30), '★★ 判完再放行也是它接的');
  check(
    /!params\?\.__payChecked/.test(b30) && /_payPass/.test(b30),
    '★★ 内部记号 `__payChecked` 不许发给协议端，重发时还要靠它绕过自己',
  );
  check(
    !/void privateWork\s*\n?\s*\.settlePayHold/.test(b30),
    '★★ 放行那步必须 **await** 掉（不然被判的那句会晚于后面几条发出去，分条顺序乱 ✗）',
  );
  const s30 = readFileSync(join(ROOT, 'src', 'private-work.js'), 'utf8');
  check(/payCodeDelayMs/.test(s30), '★ 发码的等待留了固定值口子（离线套件用 0，不然要干等 10 秒）');
  // ⚠️ 通知主人那两条**引用着客户的原话**（"他刚说：怎么付款"）⇒ 要是让这道闸去判它，
  //    可能判成"她在要钱" ⇒ **把收款码发给主人自己** ✗ ⇒ 标 `__internal` 跳过 ✓
  check(
    (s30.match(/__internal: true/g) ?? []).length >= 3,
    '★★ 发给主人的内部通知（超时接管 / 有人问价 / 骂人要退款）都标了 `__internal`（别让收款码那道闸去判它们）',
    String((s30.match(/__internal: true/g) ?? []).length),
  );
  check(/!params\?\.__internal/.test(b30), '★★ 那道闸真的跳过 `__internal`');
}

console.log(
  '\n【31】★★ 估时改成"真人兼职的时钟"（用户：「一两个小时做完还显得太快了…估计时间还可以延长一点」）',
);
{
  // 用户原话：「**其实一两个小时做完还显得太快了，因为真人兼职不会一直在做一个这个项目，
  //   估计时间还可以延长一点**」
  //   现场（今晚那个单）：真人净工时被当成墙钟 ⇒ 说好 02:45 交、结果 03:52 才做完，
  //   而"说好的时间"根本没起到"延迟发送"的作用（早就过点了）✗
  //   ⇒ ① 估的是**时钟**（他得挤时间、上课、睡一觉）；② 单位直接报小时；
  //     ③ 下限 2 小时、上限 48 小时（原来 8~240 分钟 ⇒ 两小时就交，太像程序 ✗）

  check(pw.minutesFromEtaSay('3 小时') === 180, '★ "3 小时" → 180 分钟');
  check(pw.minutesFromEtaSay('1.5 小时') === 90, '★ 小数也认："1.5 小时" → 90 分钟');
  check(pw.minutesFromEtaSay('两天') === 2880, '★★ "两天" → 2880 分钟（大活能给到一两天）');
  check(pw.minutesFromEtaSay('半天') === 720, '★ "半天" → 720 分钟');
  check(pw.minutesFromEtaSay('90 分钟') === 90, '★ 它要是还报分钟，也照样认');
  check(pw.minutesFromEtaSay('6') === 360, '★★ 裸数字按**小时**算（提示词就是让它报小时的）');
  check(pw.minutesFromEtaSay('') === 0 && pw.minutesFromEtaSay('说不好') === 0, '★ 认不出来 → 0（交给兜底区间）');

  const d31 = pw.uiData().defaults;
  check(d31.etaMinMin === 120, '★★ 下限 2 小时（小活也不许"一小时就交"）', String(d31.etaMinMin));
  check(d31.etaMaxMin === 2880, '★★ 上限 48 小时（原来 4 小时封顶 ⇒ 太像程序）', String(d31.etaMaxMin));

  const s31 = readFileSync(join(ROOT, 'src', 'private-work.js'), 'utf8');
  check(
    /大学生兼职/.test(s31) && /空出来的时间/.test(s31),
    '★★ 估时的提示词里写清了"他是兼职、只能在空出来的时间弄"（不是连着几小时干这一件）',
  );
  check(
    /按\*\*时钟\*\*算/.test(s31),
    '★★ 而且明写"按时钟算，不是按他动手干了几小时算"',
  );
  const w31 = readFileSync(join(ROOT, 'src', 'webui.html'), 'utf8');
  check(
    /function pwLeft\(/.test(w31) && /sec >= 86400/.test(w31),
    '★★ 面板倒计时改成 天/小时/分钟（2~48 小时的等待只报"2880 分钟"根本没法看 ✗）',
  );

  // 跨天的"说好的时间"要说人话（只报 `15:30` 会分不清今天还是明天 ✗）
  const uid31 = '2888888888';
  const keepW7 = config.privateWork;
  config.privateWork = { ...(keepW7 ?? {}), enable: true };
  pw.__setFriends({ [uid31]: '客户' });
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(15, 30, 0, 0);
  pw.patchState(uid31, { stage: 'waiting', etaAt: tomorrow.getTime() });
  const n31 = pw.noteFor({ message_type: 'private', user_id: uid31 });
  // ⚠️⚠️ 2026-10-16 用户最后定稿：「**告诉对方预估发送时间还是太精确了，我建议只用说早上，
  //    上午，中午，下午，傍晚，晚上，凌晨这几个时间段大概就可以了**」
  //    演变：① `19:27`（精确到分钟）✗ → ② 「晚上七点半左右」（钟点 + 左右）✗ → ③ **只给时段** ✓
  check(/明天下午/.test(n31), '★★★ 说好的时间跨天 ⇒ 只说**时段**（「明天下午」）', (n31.match(/明天[^\s」]*/) ?? [''])[0]);
  check(/「明天下午 给你」/.test(n31), '★★ 注入给她的那条例句就是那个时段', (n31.match(/「明天[^」]*」/) ?? [''])[0]);
  check(
    !/\d{1,2}:\d{2}/.test(n31),
    '★★★ 一个具体到分钟的时间都不出现（老毛病：她回过「19:27 给你」✗）',
    (n31.match(/\d{1,2}:\d{2}/) ?? [''])[0],
  );
  pw.patchState(uid31, { stage: 'waiting', etaAt: tomorrow.getTime() + 86400000 });
  const n31b = pw.noteFor({ message_type: 'private', user_id: uid31 });
  check(/后天下午/.test(n31b), '★ 再往后一天 ⇒ 「后天下午」');
  // 七个时段都认（用户点名的就这七个）——⚠️ 从**例句**里抠，别从整段提示词里抠（
  //    那段本身就列着这七个词，抠出来永远是第一个 ✗）
  {
    const today = new Date();
    const mk = (h) => {
      const d = new Date(today);
      d.setHours(h, 20, 0, 0);
      return d.getTime();
    };
    const got = [2, 7, 10, 12, 15, 18, 21, 23].map((h) => {
      pw.patchState(uid31, { stage: 'waiting', etaAt: mk(h) });
      const s = pw.noteFor({ message_type: 'private', user_id: uid31 });
      const m = /「(?:今天|明天|后天)(凌晨|早上|上午|中午|下午|傍晚|晚上)/.exec(s);
      return m ? m[1] : '?';
    });
    check(
      got.join(',') === '凌晨,早上,上午,中午,下午,傍晚,晚上,凌晨',
      '★★ 七个时段都出得来（凌晨 / 早上 / 上午 / 中午 / 下午 / 傍晚 / 晚上 ✓）',
      got.join(','),
    );
  }
  config.privateWork = keepW7;
}

console.log(
  '\n【32】★★ 截图模式：她答应截图 ⇒ 子代理找页面 ⇒ **机器人自己**按快门 ⇒ 发给他（2026-10-16 用户要求）',
);
{
  // 用户原话：「私聊工作模式再加一个截图模式吧，**如果这个项目有图形页面的话**，对面要求把
  //   现在的某个页面发给他的话，bot 先答应下来去帮他截个图，然后**截图判定只判定 bot 自己
  //   回的消息**…然后调用一个子代理去截张对应要求的图给 bot，让 bot 再发给对方。
  //   如果对方要求更改，就和之前修改模式一样的过程，但是**要带上这张图给 agent 的探查子代理**」
  const uid = '2999999999';
  const keepW8 = config.privateWork;
  config.privateWork = { ...(keepW8 ?? {}), enable: true, shot: { enable: true, cooldownMs: 600000 } };
  pw.__setFriends({ [uid]: '客户' });
  const dir = pw.ensureWorkspace(uid, '客户');

  // ① 用户的前提："**如果这个项目有图形页面的话**" ⇒ 没 html 就别接这个话头
  pw.__clearGuiCache();
  check(pw.guiFile(uid) === '', '★★ 工作区里一个 html 都没有 ⇒ 不接"截图"这个话头');
  writeFileSync(join(dir, '产物', 'index.html'), '<html><body>hi</body></html>', 'utf8');
  pw.__clearGuiCache();
  const gui = pw.guiFile(uid);
  check(/index\.html$/.test(gui), '★★ 有入口页就认出来（优先 `index.html`）', gui);

  const sent = [];
  const bot = {
    call: async (a, p) => {
      sent.push(p);
      return { status: 'ok', retcode: 0, data: { message_id: 1 } };
    },
    sendText: async () => '1',
    noteSentFile: () => {},
  };
  let shotPrompt = '';
  pw.__setPhrase(async ({ system }) => (system.includes('要不要截图') ? '是' : ''));
  pw.__setRunner(async (prompt) => {
    shotPrompt = prompt;
    return {
      promise: Promise.resolve({
        code: 0,
        stdout: `【页面】${gui}\n【尺寸】1400x1200\n【一句话】截好了，你看这个\n`,
      }),
      kill: () => {},
    };
  });
  pw.__setCapture(async (_page, _size, out) => {
    writeFileSync(out, 'x'.repeat(5000), 'utf8');
    return out;
  });

  // ② 她那句不像截图 ⇒ **模型判"不是"** ⇒ 一个字都不动 ✓
  //    ⚠️ 2026-10-16 铁律：**快筛撤了**（原来那句"没有截图字样就跳过"不成立了）⇒
  //      现在是**每句都问模型**，模型说不是才不动 ✓
  pw.patchState(uid, { shotAt: 0, shotting: false, lastShot: null });
  pw.__setPhrase(async ({ system, user }) =>
    String(system).includes('要不要截图')
      ? /截图|截个图|截一张|把.*发你/.test(String(user))
        ? '是'
        : '不是'
      : '',
  );
  check(
    (await pw.maybeShot(uid, bot, '好，我看看哈')) === false,
    '★★ 模型判"这句不是在说截图" ⇒ 不截（快筛撤了，改成每句问模型 ✓）',
  );
  check(shotPrompt === '', '★★ 而且**没起子代理**');

  // ③ 她答应了 ⇒ 起子代理找页面 + 本进程截图 + 发图 + 记下那张图
  check(
    (await pw.maybeShot(uid, bot, '行，我截个图给你')) === true,
    '★★ 她说「我截个图给你」⇒ 接住（起子代理去找页面）',
  );
  // ⚠️ `takeShot` 是 void 的，而且**发完那句要停 1.2 秒才甩图**（像人先打字再发图 ✓）
  //    ⇒ 这里得等够，不然断言会卡在"图还没发出去"那一刻 ✗
  await new Promise((r) => setTimeout(r, 1800));
  check(/他现在要看|他要看一张/.test(shotPrompt), '★ 子代理收到的活是"找他要的那个页面"');
  check(
    /别自己截图、别起浏览器/.test(shotPrompt) && /画一张图/.test(shotPrompt),
    '★★ 明写「别自己截图、别起浏览器、也别照样式画一张假图」（实测它真画过 ✗）',
  );
  check(
    sent.some((p) => Array.isArray(p.message) && p.message[0]?.type === 'image'),
    '★★ 图**真发出去了**（image 段，和他收到的一样）',
    JSON.stringify(sent).slice(0, 100),
  );
  check(
    String(sent.find((p) => typeof p.message === 'string')?.message ?? '').includes('截好了'),
    '★ 配图那句话也发了（在图的**前面**，像人先打字再甩图）',
  );
  check(
    // ⚠️ 别拿"现在的分钟"去拼名字 —— 跑过整分钟就会假红 ✗（刚踩过）
    /[\\/]产物[\\/]截图-\d{4}\.png$/.test(String(pw.stateOf(uid).lastShot?.path ?? '')) &&
      existsSync(String(pw.stateOf(uid).lastShot?.path ?? '')),
    '★★ 记下了"刚发出去那张图"（他要求改时要拿它给探查子代理看）',
    String(pw.stateOf(uid).lastShot?.path ?? ''),
  );

  // ④ 冷却：同一个私聊别一句话截一张
  const n4 = sent.length;
  pw.patchState(uid, { shotting: false });
  await pw.maybeShot(uid, bot, '行，我截个图给你');
  await new Promise((r) => setTimeout(r, 200));
  check(sent.length === n4, '★ 冷却期内不再截第二张（默认 10 分钟一次）');

  // ⑤ 模型判"她不是在说截图" ⇒ 不截
  pw.patchState(uid, { shotAt: 0, shotting: false });
  pw.__setPhrase(async () => '不是');
  check((await pw.maybeShot(uid, bot, '我把页面截给你')) === false, '★ 模型判"不是截图" ⇒ 不截');
  pw.__setPhrase(async ({ system }) => (system.includes('要不要截图') ? '是' : ''));

  // ⑥ 子代理说"这单没界面" ⇒ 不发图，让她直说（别硬编 ✗）
  pw.patchState(uid, { shotAt: 0, shotting: false, lastShot: null });
  pw.__setRunner(async () => ({
    promise: Promise.resolve({ code: 0, stdout: '【无界面】\n这项目是纯脚本的\n' }),
    kill: () => {},
  }));
  const sent6 = [];
  const bot6 = {
    call: async (a, p) => {
      sent6.push(p);
      return { status: 'ok', retcode: 0, data: { message_id: 1 } };
    },
    sendText: async () => '1',
    noteSentFile: () => {},
  };
  await pw.maybeShot(uid, bot6, '我给你截个图');
  await new Promise((r) => setTimeout(r, 400));
  check(
    !sent6.some((p) => Array.isArray(p.message)),
    '★★ 子代理说没有图形页面 ⇒ **不发图**（走兜底那句话，不许硬编 ✗）',
  );

  pw.__setCapture(null);
  pw.__setRunner(null);
  pw.__setPhrase(null);
  config.privateWork = keepW8;

  // ⑦ 接线：改需求那一轮要把**这张图**交给探查子代理看（用户明确要求）
  const s32 = readFileSync(join(ROOT, 'src', 'private-work.js'), 'utf8');
  check(/他手上那张图/.test(s32) && /先看这张图/.test(s32), '★★ 改需求时把那张截图交给探查子代理看');
  check(/stateOf\(uid\)\.lastShot/.test(s32), '★ 用的是记下来的 `lastShot`');
  check(
    /export function __setCapture/.test(s32) && /function capturePage/.test(s32),
    '★★ 快门由**机器人自己**按（`capturePage`），而且套件能把它换掉',
  );
  check(
    /stdio: 'ignore'/.test(s32),
    '★★ 起浏览器不接管道（受限环境里接管道会 EPERM，直接起不来 ✗）',
  );
  // ⚠️ `file://` 会把 ES module 拦掉 ⇒ 现代页面（Vite/React）截出来是一片白 ✗
  //    ⇒ 本地页面走**临时静态服务**（127.0.0.1 + 随机端口，截完就关）✓
  check(
    /async function serveDir/.test(s32) &&
      /createServer/.test(s32) &&
      /listen\(0, '127\.0\.0\.1'/.test(s32),
    '★★ 本地页面先起个临时静态服务再截（file:// 下 ES module 跑不起来 ⇒ 白图 ✗）',
  );
  check(/srv\?\.close\(\)/.test(s32), '★ 截完把那个服务关掉');
  check(/__setShotSay|judgeShotSay/.test(s32), '★ 判定只判**她自己那句话**（和收款码同一个形状）');
  const c32 = readFileSync(join(ROOT, 'src', 'config.js'), 'utf8');
  check(/shot: \{ enable: true/.test(c32), '★ 配置里有 `privateWork.shot`（能整个关掉）');
}

console.log(
  '\n【33】★★ 文件没下下来：那条**一个字都不回**；他催就直说"还没下好"（2026-10-16 用户要求）',
);
{
  // 用户原话：「修3，**文件没下载就不回复**，如果对面又催的话就直接说文件还没下好之类的话，
  //   **不编**。然后把合并窗口调到20秒」+「2 **直接调到 4gb**，我会自己去清理的」
  //
  // 现场（用户截图）：客户先甩一个 90MB 的 `实训.zip`、紧接着补一句说明 ⇒ 两个事件各回一轮 ⇒
  //   她**说了两遍"包太大"** ✗；而且那个 zip 还被当成"崩溃日志"，真去拖了 90MB 才说太大 ✗

  // ① `实训.zip` 这种**普通压缩包不许再算崩溃日志**（`.log` / `crash-report.zip` 还算 ✓）
  const mc = await import('../src/mc-log.js');
  check(
    mc.looksLikeLogFile({ type: 'file', data: { name: '实训.zip' } }) === false,
    '★★ 普通压缩包（实训.zip）**不再**被当成崩溃日志（客户发的项目包不该走 MC 日志那套 ✗）',
  );
  check(
    mc.looksLikeLogFile({ type: 'file', data: { name: 'latest.log' } }) === true &&
      mc.looksLikeLogFile({ type: 'file', data: { name: 'crash-2026-01-01.zip' } }) === true &&
      mc.looksLikeLogFile({ type: 'file', data: { name: '崩溃日志.txt' } }) === true,
    '★★ 真正的崩溃日志照旧认（`latest.log` / `crash-….zip` / 「崩溃日志.txt」）',
  );
  check(
    mc.looksLikeLogFile({ type: 'file', data: { name: '作业.docx' } }) === false,
    '★ 别的文件（docx 之类）当然也不算',
  );

  const uid = '2777777777';
  const keepW9 = config.privateWork;
  config.privateWork = { ...(keepW9 ?? {}), enable: true };
  pw.__setFriends({ [uid]: '客户' });
  pw.ensureWorkspace(uid, '客户');

  // ② 声明就超上限 ⇒ **压根不下载**（原来是先拖 90MB 再说太大 ✗）
  let called = 0;
  const botBig = {
    call: async (a) => {
      called++;
      return a === 'get_private_file_url' ? { url: 'http://127.0.0.1:1/x' } : {};
    },
    sendText: async () => '1',
  };
  const rBig = await pw.saveIncoming(
    botBig,
    { message_type: 'private', user_id: uid },
    [{ type: 'file', data: { name: '大包.zip', file_id: 'big', file_size: 999 * 1024 * 1024 } }],
    uid,
  );
  check(rBig.saved.length === 0 && /超过/.test(rBig.skipped[0]?.why ?? ''), '★ 声明超上限 → 跳过');
  check(called === 0, '★★★ 而且**一次网络都没碰**（下之前先比大小 ✓）', `调了 ${called} 次`);

  // ③ 纯文件、没存下来 ⇒ 按住她这条（bot.js 那道闸会看到 holdReplyAt ⇒ 不发）✓
  pw.patchState(uid, { holdReplyAt: 0, pendingFile: null, stage: '', need: '' });
  const sayFile = {
    message_type: 'private',
    user_id: uid,
    message: [{ type: 'file', data: { name: '大包.zip', file_id: 'big2', file_size: 999 * 1024 * 1024 } }],
  };
  await pw.onPrivate(sayFile, null, botBig);
  await new Promise((r) => setTimeout(r, 120));
  check(pw.stateOf(uid).holdReplyAt > 0, '★★ 文件没下下来 ⇒ **这条按住不回**（一个字都不发）');
  check(
    pw.holdReply({ message_type: 'private', user_id: uid }) === true,
    '★★★ 而且最底层那道闸真的会拦住（不是只在状态里记一笔）',
  );
  check(!!pw.stateOf(uid).pendingFile?.name, '★★ 记下了"他还欠着一个文件"', pw.stateOf(uid).pendingFile?.name ?? '');

  // ④ 他再开口（= 催）⇒ 放开闸，而且提示词里**明说那个文件还没下好**（不编 ✓）
  pw.patchState(uid, { stage: 'intake' });
  await pw.onPrivate(
    { message_type: 'private', user_id: uid, message: [{ type: 'text', data: { text: '收到了吗' } }] },
    null,
    botBig,
  );
  await new Promise((r) => setTimeout(r, 150));
  check(pw.holdReply({ message_type: 'private', user_id: uid }) === false, '★★ 他一说话 ⇒ 闸放开（该回就回）');
  const n33 = pw.noteFor({ message_type: 'private', user_id: uid });
  check(/还没下好/.test(n33), '★★★ 提示词里告诉她"那个文件还没下好"');
  check(/别假装看过|别编/.test(n33), '★★ 并且明写**不许假装看过、不许编**（用户：「不编」）');
  check(/别提大小、压缩|别解释为什么/.test(n33), '★ 也别解释为什么下不下来（别露内部原因）');

  // ⑤ 文件后来拿到了 ⇒ 提示清掉、闸也放开 ✓
  const small = join(ROOT, 'logs', '__test-pw-small.txt');
  writeFileSync(small, 'ok', 'utf8');
  const botSmall = { call: async (a) => (a === 'get_file' ? { file: small } : {}), sendText: async () => '1' };
  await pw.saveIncoming(
    botSmall,
    { message_type: 'private', user_id: uid },
    [{ type: 'file', data: { name: '小.txt', file_id: 's' } }],
    uid,
  );
  await pw.onPrivate(
    { message_type: 'private', user_id: uid, message: [{ type: 'file', data: { name: '小.txt', file_id: 's' } }] },
    null,
    botSmall,
  );
  await new Promise((r) => setTimeout(r, 150));
  check(!pw.stateOf(uid).pendingFile, '★★ 文件拿到手 ⇒ "还没下好"那条提示清掉');
  check(!/还没下好/.test(pw.noteFor({ message_type: 'private', user_id: uid })), '★ 提示词里也不再提它');

  config.privateWork = keepW9;

  // ⑥ 两个数：合并窗口 20 秒、单文件上限 4GB（用户拍板的）
  const c33 = readFileSync(join(ROOT, 'src', 'config.js'), 'utf8');
  const b33 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const s33 = readFileSync(join(ROOT, 'src', 'private-work.js'), 'utf8');
  check(/mergeMs: 20000/.test(c33), '★★ 工作模式合并窗口 = **20 秒**（用户要求）');
  check(/\?\? 20000/.test(b33), '★★ 兜底值也跟着改（不然两处不一致 ✗）');
  check(/maxIncomingMB: 4096/.test(c33), '★★ 单文件上限 = **4GB**（用户：「直接调到 4gb，我会自己去清理」）');
  check(
    /async function streamToFile/.test(s33) && /边下边写盘/.test(s33),
    '★★★ 大文件**边下边写盘**（4GB 的 Buffer 会把这个进程搞死 ✗）',
  );
  check(/声明就有|先比一下上限|下之前/.test(b33), '★★ 崩溃日志那条也是**下之前**先比大小');

  // ⑦ 工作模式那页的两个开关：**必须显示真实状态**（用户截图：「这两个开关的状态不显示了」）
  const w33 = readFileSync(join(ROOT, 'src', 'webui.html'), 'utf8');
  check(
    /id="state-acc-workmode"/.test(w33) && /id="state-acc-takeover"/.test(w33),
    '★★ 两个开关旁边各有一句**当前状态**（勾选框骗人时一眼能看出来）',
  );
  check(
    /function accPaintSwitches/.test(w33) && /当前：已开启/.test(w33) && /当前：已关闭/.test(w33),
    '★★ 有个专门刷状态的函数，写的是"当前：已开启 / 已关闭"',
  );
  {
    // ⚠️ 关键：刷状态必须**排在画名单之前**（原来排在 `accPaintNav()` 后面，
    //    那一步一抛异常，勾选框就永远停在"没勾"，而且**静默** ✗）
    const iSw = w33.indexOf('accPaintSwitches();');
    const iNav = w33.indexOf('accPaintNav();', w33.indexOf('async function renderAccounts'));
    check(iSw > 0 && iNav > 0 && iSw < iNav, '★★★ 刷状态排在 `accPaintNav()` **之前**（它抛异常也刷得上）');
    check(/accPaintSwitches\(\)[\s\S]{0,40}catch/.test(w33) || /try \{[\s\S]*accPaintSwitches[\s\S]*catch/.test(w33) || /function accPaintSwitches\(\) \{\n  try/.test(w33), '★ 而且它自己 try 掉（坏了也不影响后面）');
  }
}

console.log(
  '\n【34】★★ 补收文件：接管期间漏下的文件，能从私聊历史里补回来（2026-10-16 用户要求）',
);
{
  // 用户原话：「我在测试**接管之后文件还能不能下载下来**，现在我把开关关了，
  //   **能不能对他发的文件进行补回**」
  //   真因：`bot.js` 那条接管闸**直接 return**，`onPrivate` 压根没跑 ⇒ 接管期间不收文件 ✗
  const uid = '2770181345';
  const keepWA = config.privateWork;
  config.privateWork = { ...(keepWA ?? {}), enable: true, maxIncomingMB: 4096 };
  pw.__setFriends({ [uid]: '客户' });
  pw.ensureWorkspace(uid, '客户');

  // 一个"他发来的文件"（用本地文件冒充协议端缓存）
  const srcTxt = join(ROOT, 'logs', '__test-pw-backfill.txt');
  writeFileSync(srcTxt, '这是接管那会儿漏下的文件', 'utf8');
  let hist = [
    { time: Math.floor(Date.now() / 1000), sender: { user_id: uid }, message: [{ type: 'file', data: { name: '漏下的.txt', file_id: 'bf1' } }] },
    { time: Math.floor(Date.now() / 1000), sender: { user_id: '10000001' }, message: [{ type: 'file', data: { name: '我自己发的.txt', file_id: 'bf2' } }] },
  ];
  const bot = {
    call: async (a) => {
      if (a === 'get_friend_msg_history') return hist;
      if (a === 'get_file') return { file: srcTxt };
      return {};
    },
    sendText: async () => '1',
  };
  // ⚠️ 补收之后会顺手起一次**预读**（那是 agent）⇒ 桩掉，不然套件会真起进程 ✗
  pw.__setRunner(async () => ({ promise: Promise.resolve({ code: 0, stdout: '读过了' }), kill: () => {} }));

  const r1 = await pw.backfillFiles(uid, bot, 50, { say: false });
  check(r1.ok === true, '★ 接口跑通了', r1.error || '');
  check(
    r1.saved.length === 1 && r1.saved[0] === '漏下的.txt',
    '★★★ 他发来的那个补下来了（**自己发的不算**）',
    r1.saved.join('、') || '（一个都没补）',
  );
  check(
    existsSync(join(pw.incomingDir(uid), '漏下的.txt')),
    '★★ 真落到 `收到的文件/` 里了',
  );
  check(r1.scanned === 1, '★ 只扫到他那 1 个文件段（自己发的那条跳过）', String(r1.scanned));

  // 再补一次：**已经有了就不重复下** ✓
  const r2 = await pw.backfillFiles(uid, bot, 50, { say: false });
  check(r2.ok === true && r2.saved.length === 0, '★★ 再补一次不重复下（按文件名比）', r2.saved.join('、'));

  // ⚠️⚠️ 2026-10-16 加（用户：「**帮我补发一下收到文件之后回复的消息**」）——
  //    补下来的那一刻他是"发完文件没人理"的状态 ⇒ 补完要**由她说一句** ✓
  //    （`say:true` 是默认；模型那句润色在这套里走不通 ⇒ 会落到兜底那句，照样要发出去 ✓）
  {
    const said = [];
    const botSay = {
      call: async (a) => (a === 'get_friend_msg_history' ? hist : a === 'get_file' ? { file: srcTxt } : {}),
      sendText: async (_ev, t) => {
        said.push(String(t));
        return '1';
      },
    };
    const r4a = await pw.backfillFiles(uid, botSay, 50, { say: true });
    await new Promise((r) => setTimeout(r, 600));
    check(said.length >= 1, '★★★ 补完之后**她主动说了一句**（用户要的"补发回复"）', said.join('｜'));
    check(!!r4a.ok, '★ 接口照样返回 ok');
    // 只补文件、不要那句（`say:false`）⇒ 一个字都不发 ✓
    const said2 = [];
    const botQuiet = {
      call: async (a) => (a === 'get_friend_msg_history' ? hist : {}),
      sendText: async (_ev, t) => {
        said2.push(String(t));
        return '1';
      },
    };
    await pw.backfillFiles(uid, botQuiet, 50, { say: false });
    await new Promise((r) => setTimeout(r, 400));
    check(said2.length === 0, '★ `say:false` ⇒ 只补文件、不打扰他 ✓');
  }

  // 拉不到历史 ⇒ 明说原因，别装作补成功 ✓
  const r3 = await pw.backfillFiles(uid, { call: async () => [] }, 50);
  check(r3.ok === false && /历史/.test(r3.error ?? ''), '★ 拉不到历史 → 返回失败并说清原因', r3.error ?? '');

  // ⚠️⚠️ 2026-10-16 实测的协议端怪癖：**要得太多反而一条都不给**
  //    （SnowLuma 日志原样：`count=200 → returned=0`，可 `count=40 → returned=24`）
  //    ⇒ 补收必须**从大到小挨个试**，不然永远补回 0 条 ✗
  {
    const seen = [];
    const botQuirk = {
      call: async (a, p) => {
        if (a === 'get_friend_msg_history') {
          seen.push(Number(p.count));
          return Number(p.count) > 100 ? { messages: [] } : hist;
        }
        if (a === 'get_file') return { file: srcTxt };
        return {};
      },
      sendText: async () => '1',
    };
    // 先把之前补下来的那个删掉，好验证"能再补一次"
    try {
      rmSync(join(pw.incomingDir(uid), '漏下的.txt'), { force: true });
    } catch {}
    pw.__setRunner(async () => ({ promise: Promise.resolve({ code: 0, stdout: '读过了' }), kill: () => {} }));
    const r4 = await pw.backfillFiles(uid, botQuirk, 200);
    check(r4.ok === true && r4.saved.length === 1, '★★★ 要 200 条它不给 ⇒ 自己退到小的重试、还是补回来了', r4.saved.join('、'));
    check(seen.length >= 2 && seen[0] === 200, '★★ 确实按"从大到小"试过（第一次就是要 200）', seen.join('→'));
    pw.__setRunner(null);
  }

  pw.__setRunner(null);
  config.privateWork = keepWA;

  // 接线：面板上那个按钮 + 服务端接口
  const w34 = readFileSync(join(ROOT, 'src', 'webui.html'), 'utf8');
  const j34 = readFileSync(join(ROOT, 'src', 'webui.js'), 'utf8');
  check(
    /id="pw-backfill-qq"/.test(w34) && /function pwBackfill/.test(w34),
    '★★ 面板上有「补收他的文件」按钮（填 QQ 号）',
  );
  check(
    /api\/private-work\/backfill/.test(w34) && /POST \/api\/private-work\/backfill/.test(j34),
    '★★ 服务端也真有这个接口',
  );
  check(
    /export async function backfillFiles/.test(readFileSync(join(ROOT, 'src', 'private-work.js'), 'utf8')),
    '★ 核心 `backfillFiles()` 是导出的（套件/接口都能调）',
  );
}

console.log(
  '\n【34b】★★★ 补收**自动**做（用户：「补收文件要自动补收，要不然很容易漏」）',
);
{
  // 用户原话：「**补收文件要自动补收，要不然很容易漏**」
  //   背景：面板上那个按钮得他手点 ⇒ 他不可能一直盯着 ⇒ 漏 ✗
  //   ⇒ 启动后 45 秒扫一轮 + 之后每 10 分钟一轮，只补"有文件等着 / 最近聊过"的那几个 ✓
  const uid = '2770181347';
  const spare = '2770181348'; // 一个"很久没聊、也没欠文件"的人（不该被扫）
  const keepWC = config.privateWork;
  config.privateWork = { ...(keepWC ?? {}), enable: true, maxIncomingMB: 4096 };
  pw.__setFriends({ [uid]: '客户', [spare]: '路人' });
  pw.ensureWorkspace(uid, '客户');
  pw.ensureWorkspace(spare, '路人');

  // ---- ① 候选人怎么挑（纯函数）----
  const now = Date.now();
  // ⚠️ 上一轮套件跑完时**留下了节流时间**（`autoBackfillAt`）⇒ 不清掉的话这一轮开头就被
  //    "10 分钟内补过"挡掉，看着像"挑不出来人" ✗（第一次跑就这么假红了一次）
  pw.patchState(uid, { autoBackfillAt: 0 });
  pw.patchState(uid, { pendingFile: { at: now, name: '还没下好.zip' }, talkAt: now });
  pw.patchState(spare, { talkAt: now - 72 * 3600 * 1000, pendingFile: null });
  {
    const picked = pw.backfillCandidates({ max: 6, now });
    check(picked.includes(uid), '★★ 「有文件欠着」的人会被挑进来 ✓', picked.join('、'));
    check(!picked.includes(spare), '★★ 三天没说话、也没欠文件的人**不扫**（省协议端的调用 ✓）');
    // 刚补过的 10 分钟内不再补（节流，落盘 ⇒ 重启也不忘 ✓）
    pw.patchState(uid, { autoBackfillAt: now });
    check(!pw.backfillCandidates({ max: 6, now }).includes(uid), '★★ 刚补过的 10 分钟内不重复补 ✓');
    check(pw.backfillCandidates({ max: 6, now: now + 11 * 60 * 1000 }).includes(uid), '★★ 过了 10 分钟又该补了 ✓');
    pw.patchState(uid, { autoBackfillAt: 0 });
    // 最近聊过的人（不欠文件）也该扫 —— 那是"机器人没跑的时候他发的东西"✓
    pw.patchState(uid, { pendingFile: null });
    check(pw.backfillCandidates({ max: 6, now }).includes(uid), '★★ 最近聊过的人照样扫（机器人没跑时发的文件就靠这补 ✓）');
    // max 生效
    pw.patchState(spare, { talkAt: now });
    check(pw.backfillCandidates({ max: 1, now }).length === 1, '★ 一次最多补 max 个（别一口气拉几十个 ✓）');
  }

  // ⚠️ 这套跑到这儿，状态里已经攒了**前面各节留下的一堆人**（有的还欠着文件）⇒
  //    自动补收会把他们一起补（`saved` 就不是 1 了）✗
  //    ⇒ 验自动那一趟之前，先把**别人**都压掉（节流到刚补过 + 清空欠账）✓
  const onlyMe = (keep) => {
    for (const u of pw.__uids()) {
      if (u === keep) continue;
      pw.patchState(u, {
        pendingFile: null,
        missedFileAt: 0,
        talkAt: 0,
        autoBackfillAt: Date.now(), // 10 分钟节流 ⇒ 这轮不会被挑中 ✓
      });
    }
  };

  // ---- ② 真跑一轮：补到文件 ⇒ 存下来 + 说一句 ----
  const srcTxt2 = join(ROOT, 'logs', '__test-pw-auto-bf.txt');
  writeFileSync(srcTxt2, '这是机器人没跑那会儿他发的', 'utf8');
  const hist2 = [
    { time: Math.floor(now / 1000), sender: { user_id: uid }, message: [{ type: 'file', data: { name: '自动补的.txt', file_id: 'ab1' } }] },
  ];
  const said2 = [];
  const bot2 = {
    call: async (a) => {
      if (a === 'get_friend_msg_history') return hist2;
      if (a === 'get_file') return { file: srcTxt2 };
      return {};
    },
    sendText: async (_e, t) => {
      said2.push(String(t));
      return '1';
    },
  };
  pw.__setRunner(async () => ({ promise: Promise.resolve({ code: 0, stdout: '读过了' }), kill: () => {} }));
  onlyMe(uid);
  pw.patchState(uid, { talkAt: now, autoBackfillAt: 0, pendingFile: { at: now, name: '自动补的.txt' } });
  const a1 = await pw.autoBackfill(bot2, { now, max: 4 });
  check(
    a1.ok === true && a1.tried.length === 1 && a1.tried[0] === uid,
    '★★ 自动跑起来了，这一轮补的就是他 ✓',
    a1.tried.join('、'),
  );
  check(a1.saved === 1 && existsSync(join(pw.incomingDir(uid), '自动补的.txt')), '★★★ 文件真的补下来了 ✓', a1.saved + ' 个');
  check(pw.stateOf(uid).pendingFile === null, '★★ 补到了 ⇒ "还没下好"那笔记清掉 ✓');
  await new Promise((r) => setTimeout(r, 600));
  check(said2.length >= 1, '★★ 补下来之后她**主动说了一句**（他是"发完没人理"的状态 ✓）', said2.join('｜'));

  // ---- ③ 没补到新的 ⇒ **一个字都不说**（不然每 10 分钟一句就是骚扰 ✗）----
  {
    const said3 = [];
    const bot3 = {
      call: async (a) => (a === 'get_friend_msg_history' ? hist2 : {}),
      sendText: async (_e, t) => {
        said3.push(String(t));
        return '1';
      },
    };
    onlyMe(uid);
    pw.patchState(uid, { talkAt: Date.now(), autoBackfillAt: 0, pendingFile: null });
    await pw.autoBackfill(bot3, { now: Date.now(), max: 4 });
    await new Promise((r) => setTimeout(r, 500));
    check(said3.length === 0, '★★★ 没补到新的就**一个字都不说**（自动那趟不打扰他 ✓）', said3.join('｜') || '（没说话 ✓）');
  }

  // ---- ④ 接管中的人：文件照补，但**不许说话**（他的私聊归主人自己回 ✓）----
  {
    const said4 = [];
    try {
      rmSync(join(pw.incomingDir(uid), '自动补的.txt'), { force: true });
    } catch {}
    config.privateWork = { ...config.privateWork, friends: { [uid]: { takeover: true } } };
    const bot4 = {
      call: async (a) => {
        if (a === 'get_friend_msg_history') return hist2;
        if (a === 'get_file') return { file: srcTxt2 };
        return {};
      },
      sendText: async (_e, t) => {
        said4.push(String(t));
        return '1';
      },
    };
    onlyMe(uid);
    pw.patchState(uid, { talkAt: Date.now(), autoBackfillAt: 0, pendingFile: { at: Date.now(), name: '自动补的.txt' } });
    const a4 = await pw.autoBackfill(bot4, { now: Date.now(), max: 4 });
    await new Promise((r) => setTimeout(r, 500));
    check(a4.saved === 1, '★★ 接管中的人文件照样补（不能让他白等 ✓）', String(a4.saved));
    check(said4.length === 0, '★★★ 但他这会儿被接管 ⇒ **一个字都不说**（人在用手上的号 ✗）', said4.join('｜') || '（没说话 ✓）');
    config.privateWork = { ...config.privateWork, friends: {} };
  }

  // ---- ⑤ 没开私聊工作 ⇒ 一点都不动 ----
  {
    config.privateWork = { ...config.privateWork, enable: false };
    const r5 = await pw.autoBackfill(bot2, { max: 4 });
    check(r5.ok === false && /没开/.test(r5.why ?? ''), '★ 私聊工作没开 ⇒ 不扫（别白打协议端 ✓）', r5.why ?? '');
    config.privateWork = { ...config.privateWork, enable: true };
  }

  // ---- ⑥ 接管期间他发的文件 ⇒ 记一笔，自动补收会优先补他 ----
  {
    const uid6 = '2770181349';
    pw.__setFriends({ [uid6]: '客户' });
    pw.ensureWorkspace(uid6, '客户');
    const hit = pw.noteMissedFile(
      { message_type: 'private', user_id: uid6 },
      [{ type: 'file', data: { name: '接管时发的.zip', file_id: 'x1' } }],
    );
    check(hit === true && pw.stateOf(uid6).missedFileAt > 0, '★★ 接管期间发的文件会被记一笔（`missedFileAt` ✓）');
    // ⚠️ 这个人在上面 `onlyMe` 那步被"节流"过 ⇒ 断言前先把节流清掉，不然看着像"没被挑中" ✗
    pw.patchState(uid6, { autoBackfillAt: 0 });
    check(pw.backfillCandidates({ max: 6 }).includes(uid6), '★★ 记过的人自动补收会**优先**补他 ✓');
    const noHit = pw.noteMissedFile({ message_type: 'private', user_id: uid6 }, [{ type: 'text', data: { text: '在吗' } }]);
    check(noHit === false, '★ 只是说话、没发文件 ⇒ 不记（别把它当成"欠着文件" ✓）');
  }

  // ---- ⑦ 接线：定时器真挂上了 ✓ ----
  {
    const s34 = readFileSync(join(ROOT, 'src', 'private-work.js'), 'utf8');
    check(
      /autoBackfill\(bot, \{ max: 12 \}\)/.test(s34) &&
        /autoBackfill\(bot, \{ max: 6 \}\)/.test(s34) &&
        /, 45000\)/.test(s34) &&
        /AUTO_BACKFILL_MS\)/.test(s34),
      '★★★ 启动后 45 秒扫一轮 + 之后每 10 分钟一轮（都在 `start()` 里挂上 ✓）',
    );
    check(
      /if \(autoBackfillTimer\) clearInterval\(autoBackfillTimer\)/.test(s34),
      '★ `stop()` 会把定时器清掉',
    );
    const b34 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
    check(
      /privateWork\.noteMissedFile\?\.\(payload, msg\.toSegments\(payload\.message\)\)/.test(b34),
      '★★ 接管那条闸里也接了：他发的文件会被记一笔 ✓',
    );
    check(
      /sayOnlyWhenSaved/.test(s34) && /if \(opts\?\.sayOnlyWhenSaved\) return out;/.test(s34),
      '★★ 自动那趟"没补到就不说话"这条路实现了 ✓',
    );
  }

  pw.__setRunner(null);
  config.privateWork = keepWC;
}

console.log(
  '\n【34c】★★★ 主人**不是客户**（2026-10-16：谷雨把主人的号当成客户，给人家交付了一堆文件）',
);
{
  // 现场：谷雨给主人号发了 启动.bat / 界面预览.html / 零件缺陷检测.zip（86MB，还传不上去）
  //   ⇒ 而且那个包卡在 sendfail + pendingSend ⇒ 每轮 sweep 重试 ⇒ 把协议端通道占满 ✗
  const ownerUid = '10000003';
  const keepWC2 = config.privateWork;
  const keepOwner2 = config.ownerQQ;
  config.ownerQQ = ownerUid;
  config.privateWork = { ...(keepWC2 ?? {}), enable: true };
  pw.__setFriends({ [ownerUid]: '主人' });

  check(pw.isOwnerId(ownerUid) === true, '★★ 认得出"这是主人自己"（`isOwnerId` ✓）');
  check(pw.isOwnerId('10000002') === false, '★ 别人不是主人 ✓');
  check(pw.ownerAsCustomer() === false, '★★ 默认**主人不当客户** ✓');

  // ⚠️⚠️ 真因就在这儿：**saki 那个号被配进了同类池（peers）** ⇒ 她是"自己人"，
  //    却被当成客户交付了一堆文件 ✗ ⇒ 同类池里的号一律不当客户 ✓
  {
    const keepGP = config.groupParams;
    config.groupParams = {
      ...(keepGP ?? {}),
      '999000001': { ...(keepGP?.['999000001'] ?? {}), peers: ['10000008'] },
    };
    check(pw.isPeerUid('10000008') === true, '★★ 认得出"同类池里的号"（`isPeerUid` ✓）');
    check(pw.isSelfSide('10000008') === true, '★★★ 同类池的号算**自己人** ⇒ 不当客户 ✓');
    check(pw.isSelfSide('10000007') === false, '★ 不在池里的才算客户 ✓');
    {
      const r2 = await pw.deliver('10000008', { call: async () => ({ status: 'ok' }), sendText: async () => {} });
      check(r2 && r2.ok === false, '★★★ 同类池里的号：交付也被挡住 ✓', String(r2?.why));
    }
    config.groupParams = keepGP;
  }

  // ① 他发消息 ⇒ 不走接单状态机（stage 一点都不动）
  {
    const before = pw.stateOf(ownerUid).stage;
    let ran = 0;
    pw.__setRunner(() => {
      ran++;
      return { promise: Promise.resolve({ code: 0, stdout: '' }), kill: () => {} };
    });
    await pw.onPrivate(
      { message_type: 'private', user_id: ownerUid, message: [{ type: 'text', data: { text: '在吗' } }] },
      [{ type: 'text', data: { text: '在吗' } }],
      { call: async () => ({}), sendText: async () => {} },
    );
    await new Promise((r) => setTimeout(r, 200));
    check(pw.stateOf(ownerUid).stage === before, '★★★ 主人发消息 ⇒ **不推进接单状态机**（只是聊天 ✓）', pw.stateOf(ownerUid).stage);
    check(ran === 0, '★★ 也不会给他起 agent / 预读 ✓', String(ran));
    pw.__setRunner(null);
  }

  // ② 就算有人喊交付 ⇒ 主人这条被挡住（那条 86MB 的包不会再被反复重试 ✗）
  {
    const r = await pw.deliver(ownerUid, { call: async () => ({ status: 'ok' }), sendText: async () => {} });
    check(r && r.ok === false && /主人/.test(String(r.why ?? '')), '★★★ 交付**被挡住**（主人不是客户 ✓）', String(r.why));
  }

  // ③ 自动补收也不把他算进去
  pw.patchState(ownerUid, { talkAt: Date.now(), pendingFile: { at: Date.now(), name: 'x.zip' } });
  check(!pw.backfillCandidates({ max: 8 }).includes(ownerUid), '★★ 自动补收**不补主人的文件** ✓');

  // ④ 开关：拿主人号测单子时打开 ⇒ 一切照旧
  {
    config.privateWork = { ...config.privateWork, ownerAsCustomer: true };
    check(pw.ownerAsCustomer() === true, '★★ 开关打开 ⇒ 主人也当客户 ✓');
    config.privateWork = { ...config.privateWork, ownerAsCustomer: false };
  }

  // ⑤ 接线：配置里有这个开关（不然用户没法拿主人号测单子）
  {
    const c = readFileSync(join(ROOT, 'src', 'config.js'), 'utf8');
    check(/ownerAsCustomer: false,/.test(c), '★★ 配置里有 `ownerAsCustomer`（默认 false ✓）');
  }

  config.ownerQQ = keepOwner2;
  config.privateWork = keepWC2;
}

console.log(
  '\n【35】★★ 交付要成套：产物里的**目录**（那个"服务"）也得打包发过去（2026-10-16 用户抓到）',
);
{
  // 用户原话：「交付过去的文件不能直接跑，**应该还有个服务也得发过去**」
  //   现场：`零件缺陷检测/` 里有 app.py / detect.py / requirements.txt / weights（88MB）——
  //        而 `listOut()` **只列文件、目录直接跳过** ⇒ 这个"服务"从来没被打包发出去过 ✗
  //        ⇒ 客户收到 html + 报告，一打开没数据 ⇒ 回头问「服务呢」
  const uid = '2770181346';
  const keepWB = config.privateWork;
  config.privateWork = { ...(keepWB ?? {}), enable: true, maxSendMB: 4096 };
  pw.__setFriends({ [uid]: '客户' });
  const dir = pw.ensureWorkspace(uid, '客户');

  // 造一个"项目目录"（就是那个服务）
  mkdirSync(join(pw.outDir(uid), '小项目'), { recursive: true });
  writeFileSync(join(pw.outDir(uid), '小项目', 'app.py'), 'print(1)\n', 'utf8');
  writeFileSync(join(pw.outDir(uid), '小项目', 'requirements.txt'), 'flask\n', 'utf8');
  writeFileSync(join(pw.outDir(uid), '说明.txt'), '先起服务\n', 'utf8');

  const dirs = pw.listOutDirs(uid);
  check(
    dirs.length === 1 && dirs[0].name === '小项目' && dirs[0].dir === true,
    '★★ `listOutDirs()` 认出了产物里的目录（原来这种"服务"是被跳过的 ✗）',
    dirs.map((d) => d.name).join('、'),
  );

  // 真跑一次交付：目录要被压成 zip 再传出去 ✓
  const sentFiles = [];
  const bot = {
    call: async (a, p) => {
      if (a === 'upload_private_file') {
        sentFiles.push({ name: String(p.name), exists: existsSync(String(p.file)) });
        return { status: 'ok', retcode: 0, data: { message_id: 1 } };
      }
      return {};
    },
    sendText: async () => '1',
    noteSentFile: () => {},
  };
  pw.patchState(uid, { stage: 'waiting', etaAt: Date.now() - 1000, outBase: '' });
  await pw.deliver(uid, bot);
  check(
    sentFiles.some((f) => /小项目\.zip$/.test(f.name)),
    '★★★ 交付时把「小项目」打成了 zip 发出去（"服务"这一半终于带上了）',
    sentFiles.map((f) => f.name).join('、'),
  );
  check(
    sentFiles.every((f) => f.exists),
    '★★ 传的每个文件都**真在磁盘上**（不是报个名字）',
    sentFiles.filter((f) => !f.exists).map((f) => f.name).join('、') || '全部在',
  );
  check(
    existsSync(join(pw.outDir(uid), '小项目.zip')),
    '★ zip 落在产物根下（他解压就看到整个项目）',
  );

  // ⚠️⚠️ 2026-10-16 加（用户：「交付过去的文件必须要直接跑，**如果缺什么运行前需要下载的
  //    必须要告知客户**」）——
  //    现场：AGENTS.md 一直写着"做完在 `要说的话.md` 追加一行、对方会看到这句"，
  //    可**全文件搜下来没有任何地方读它** ✗ ⇒ 交付那句一直是写死的
  //    「弄好了，给你（3 个文件）」⇒ "要先装什么"永远送不到他手上 ✗
  {
    const said = [];
    const bot2 = {
      call: async (a, p) => {
        if (a === 'upload_private_file') {
          said.push({ up: String(p.name) });
          return { status: 'ok', retcode: 0, data: { message_id: 1 } };
        }
        return {};
      },
      sendText: async (_ev, t) => {
        said.push({ say: String(t) });
        return '1';
      },
      noteSentFile: () => {},
    };
    writeFileSync(
      join(dir, '要说的话.md'),
      '解压后先装 requirements 里那些，再跑 app.py 就出来了（torch 有点大，装慢点）\n',
      'utf8',
    );
    pw.patchState(uid, { stage: 'waiting', etaAt: Date.now() - 1000, outBase: '' });
    await pw.deliver(uid, bot2);
    const line = String(said.find((x) => x.say)?.say ?? '');
    check(
      /requirements/.test(line) && /app\.py/.test(line),
      '★★★ 交付那句用的是 **agent 写在「要说的话.md」里的那句**（含"要先装什么"）',
      line,
    );
    check(
      !/弄好了，给你/.test(line),
      '★★ 不再是那句写死的通用话（用户要的是"必须告知客户要下什么"）',
      line,
    );
  }

  config.privateWork = keepWB;

  // 接线 + 规矩
  const s35 = readFileSync(join(ROOT, 'src', 'private-work.js'), 'utf8');
  const c35 = readFileSync(join(ROOT, 'src', 'config.js'), 'utf8');
  check(
    /交付要\*\*成套\*\*/.test(s35) && /服务\/后端一起给/.test(s35),
    '★★ 工作区 AGENTS.md 里写死了"交付要成套：页面 + 服务一起给"（下次 agent 自己就会带 ✓）',
  );
  check(
    /一个没看过这个项目的人，照着我写的说明能不能跑起来/.test(s35),
    '★★ 并给了自检那句话（跑不起来就是还差东西）',
  );
  check(/maxSendMB: 4096/.test(c35), '★★ 回过去的文件上限也放到 4GB（88MB 的项目包原来会被 30MB 拦掉 ✗）');
  {
    // ⚠️ 顺序：目录打包必须排在 `packIfMany` **之后**，否则会被再包一层（zip 套 zip ✗）
    const iPack = s35.indexOf('files = await packIfMany(uid, files)');
    const iDir = s35.indexOf('const zf = await packDir(uid, d)');
    check(iPack > 0 && iDir > iPack, '★★★ 目录打包排在"整体打包"之后（不会被包成 zip 套 zip）');
    // ⚠️⚠️ 传大包必须放宽超时：固定 30 秒 ⇒ 80MB 的包**每次都判超时**、三次重试全废 ✗
    //    （现场：`调用 upload_private_file 超时` ×3 ⇒ 客户拿不到那个服务）
    const b35 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
    check(
      /call\(action, params = \{\}, opts = \{\}\)/.test(b35) && /rawWait === 0 \? 0 : Math\.max\(1000, Number\(rawWait\) \|\| 30000\)/.test(b35),
      '★★★ `bot.call()` 支持传超时：默认 30 秒，**传 0 = 不限时**（用户：「进入了上传过程就不要限时了」）',
    );
    // ⚠️⚠️ 2026-10-16 用户定的新规矩：「**只看是否开始进入上传**，没进入就不断重试；
    //    进入了就不要限时；中途断了要自己重试，直到传完」+ 实在不行要说"网络不好"（模型润色）
    check(
      /if \(await tryOnce\(0\)\)/.test(s35),
      '★★★ 大文件上传**不限时**（`tryOnce(0)` ⇒ 传十几分钟也让它传完 ✓）',
    );
    check(
      /传到一半断了/.test(s35) && /没进入上传/.test(s35),
      '★★ 分得清"没进入上传"和"传到一半断了"（两种都重试 ✓）',
    );
    check(
      /let noStart = 0/.test(s35) && /noStart >= 3/.test(s35) && /网络有点问题，文件得等会儿再发你/.test(s35),
      '★★ 连着传不上去 ⇒ **跟他说一句"网络不好、等会儿再发"**（走 `sendAdvice` **模型润色**，只提一次 ✓）',
    );
    check(
      /if \(!toldNet && noStart >= 3\)/.test(s35) &&
        /nz\(W\(\)\.bigRetryMaxMs, 30 \* 60 \* 1000\)/.test(s35),
      '★ 只提一次、别刷屏；兜底最多磨 **30 分钟**（可配 `bigRetryMaxMs`；2026-10-16 从 3 小时收小 ✓）',
    );
    check(
      (s35.match(/Math\.min\(600000, Math\.max\(30000, Number\(f\.size/g) ?? []).length === 2,
      '★★ 两处传文件的地方都按**文件大小**放宽超时（上限 10 分钟）',
      String((s35.match(/Math\.min\(600000/g) ?? []).length),
    );
    check(
      /const mine = lastSay\(uid\)/.test(s35) && /const line = mine \|\|/.test(s35),
      '★★ 交付那句优先用 agent 写的那句（`lastSay`），空了才回落通用那句',
    );
  }
}

console.log(
  '\n【36】★★ 私聊也要会"打住"：收场话之后不再一人一句刷 + 不报具体到分钟（2026-10-16 用户要求）',
);
{
  // 用户原话：「**私聊也得加一个进入告别或者无意义聊天时自动切断的机制**，要不然也是不像人」
  //   +「**不要回复具体到分钟的时间，说个大概几点钟就行了**」
  const uid = '2770181347';
  const keepWC = config.privateWork;
  config.privateWork = { ...(keepWC ?? {}), enable: true };
  pw.__setFriends({ [uid]: '客户' });
  pw.ensureWorkspace(uid, '客户');

  // ① 没说过收场话 ⇒ 什么都不拦 ✓
  pw.patchState(uid, { stage: 'intake', farewellAt: 0 });
  check(
    pw.looksPointlessAfterFarewell(uid, '嗯') === false,
    '★ 平时他说「嗯」照常接（这套只在她说收场话之后才生效）',
  );

  // ② 她说了收场话 ⇒ 之后的"语气词"不接 ✓
  pw.noteFarewell(uid);
  // ⚠️ 2026-10-16 铁律：判"这句要不要打住"从**关键词**（嗯/行/好）改成**模型判** ——
  //    它跑在 `onPrivate`（async）里，结论写进 `dropReplyAt`；
  //    `bot.js` 那道**同步**闸只读标记 ✓（下面这几条就是钉这个两步设计）
  check(
    pw.looksPointlessAfterFarewell(uid, '嗯') === false,
    '★ 光"说过收场话"还不够 —— 得**模型判过他这句是没营养的**才不回 ✓',
  );
  pw.patchState(uid, { dropReplyAt: Date.now() });
  check(pw.looksPointlessAfterFarewell(uid, '嗯') === true, '★★★ 模型判过"没营养" ⇒ **不接**（不再一人一句刷 ✓）');
  check(
    pw.looksPointlessAfterFarewell(uid, '行行行') === true,
    '★★ 「行行行」这种也照样不接（标记在就一律不接，判据在模型那层 ✓）',
  );
  // 那条标记 90 秒自动过期（别永久闭麦 ✗）
  pw.patchState(uid, { dropReplyAt: Date.now() - 2 * 60 * 1000 });
  check(
    pw.looksPointlessAfterFarewell(uid, '嗯') === false,
    '★★ 标记 90 秒就过期（不会一直不理他 ✓）',
  );
  check(pw.looksPointlessAfterFarewell(uid, '那我先睡了你忙') === false, '★★ 他说了新东西（长句）⇒ 照常接 ✓');
  check(pw.looksPointlessAfterFarewell(uid, '你几点给我') === false, '★★ 问句 ⇒ 照常接 ✓');

  // ③ 两条豁免：等他准话 / 她刚问过他 ⇒ **绝不能吞** ✗
  pw.patchState(uid, { stage: 'confirming' });
  check(
    pw.looksPointlessAfterFarewell(uid, '行') === false,
    '★★★ 工作模式在等他一句准话 ⇒「行」是他答应开工，**不能吞**（吞了这单就卡死 ✗）',
  );
  pw.patchState(uid, {
    stage: 'running',
    myLastSay: { at: Date.now(), text: '这个现在开始弄吗？' },
  });
  check(
    pw.looksPointlessAfterFarewell(uid, '好') === false,
    '★★ 她刚问过他 ⇒ 他的「好」是在回答，**不能吞** ✗',
  );

  // ④ 超过 10 分钟就自动失效（别永久闭麦）✓
  pw.patchState(uid, { stage: 'running', farewellAt: Date.now() - 11 * 60 * 1000, myLastSay: null });
  check(pw.looksPointlessAfterFarewell(uid, '嗯') === false, '★★ 10 分钟一过就恢复（不会一直不理他）');

  // ⑤ 接线：`bot.js` 里真的要调这两处（记收场 + 私聊那条闸）
  const b36 = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(
    /privateWork\.noteFarewell\(event\.user_id\)/.test(b36),
    '★★ 她自己说收场话时会记一笔（群里有这套，私聊这次补上了）',
  );
  check(
    /privateWork\.looksPointlessAfterFarewell\?\.\(event\.user_id, text\)/.test(b36),
    '★★★ 私聊那条闸真的接在"接不接"的判定上（不是只写了个函数没人用 ✗）',
  );
  config.privateWork = keepWC;
}

console.log(
  '\n【37】★★ QQ 红包：告诉她"收不了、也花不出去" + 直接把微信收款码发过去（2026-10-16 用户要求）',
);
{
  // 用户原话：「**如果对面发了 qq 红包，要告诉对面收不了 QQ 红包，而且收了也花不了**，
  //   这类话。**然后跑给微信收款码的逻辑**」+「**先补发一下收款码和话术再改**」
  check(
    pw.hasRedPacket([{ type: 'redbag', data: {} }]) === true,
    '★★ 认得出红包段（`redbag`）',
  );
  check(
    pw.hasRedPacket([{ type: 'json', data: { data: '{"app":"com.tencent.mobileqq.redpacket"}' } }]) ===
      true,
    '★★ json 段里带 `redpacket` 也算',
  );
  // ⚠️⚠️ 实测：SnowLuma 给的红包**是一句文本**（`段=text`）——
  //    「[QQ红包]请使用新版手机QQ查收红包。」⇒ 只看消息段永远判不出来 ✗
  check(
    pw.hasRedPacket([{ type: 'text', data: { text: '[QQ红包]请使用新版手机QQ查收红包。' } }]) ===
      true,
    '★★★ 协议端把红包给成**文本**时也认（实测就是这个形态 ✗）',
  );
  check(
    pw.hasRedPacket([], '[QQ红包]请使用新版手机QQ查收红包。') === true,
    '★★ 只给文本（不给段）时也认 ✓',
  );
  check(
    pw.hasRedPacket([{ type: 'text', data: { text: '我给你发个红包吧' } }]) === false,
    '★★★ 但**只是嘴上说"发个红包"不算**（判据只看消息段，不看那两个字 ✗）',
  );
  check(pw.hasRedPacket([]) === false, '★ 空消息当然不算');

  const uid = '2770181348';
  const keepWD = config.privateWork;
  config.privateWork = { ...(keepWD ?? {}), enable: true };
  pw.__setFriends({ [uid]: '客户' });
  pw.ensureWorkspace(uid, '客户');
  pw.patchState(uid, { stage: 'intake', redbagAt: 0, redbagTold: 0, payCodeAt: 0, holdReplyAt: 0 });

  // 真发一次红包 ⇒ 收款码要跟着出去 ✓
  const sent = [];
  const bot = {
    call: async (a, p) => {
      if (a === 'send_private_msg' && Array.isArray(p.message)) sent.push('image');
      return { status: 'ok', retcode: 0, data: { message_id: 1 } };
    },
    sendText: async () => '1',
    noteSentFile: () => {},
  };
  config.privateWork.payCodeDelayMs = 0;
  await pw.onPrivate(
    {
      message_type: 'private',
      user_id: uid,
      message: [{ type: 'redbag', data: { title: '恭喜发财' } }],
    },
    null,
    bot,
  );
  await new Promise((r) => setTimeout(r, 1500));
  check(pw.stateOf(uid).redbagAt > 0, '★★ 记下了"他发过红包"（提示词靠它告诉她收不了 ✓）');
  // ⚠️ 套件里没有真的 `收款码.png`（那份在按号知识目录里、不进仓库）⇒
  //    这里验的是**"收款码那条逻辑真的被触发了"**（发送时刻被记下来）✓
  check(
    pw.stateOf(uid).payCodeAt > 0,
    '★★★ 红包触发后**走了发收款码那条逻辑**（"跑给微信收款码的逻辑" ✓）',
  );

  // 提示词里要告诉她"收不了、也花不出去"、并且让他扫收款码 ✓
  pw.patchState(uid, { stage: 'intake' });
  const n37 = pw.noteFor({ message_type: 'private', user_id: uid });
  check(/QQ 红包/.test(n37) && /收不了/.test(n37), '★★ 提示词里明说"你收不了 QQ 红包"');
  check(/花不出去/.test(n37), '★★ 而且"收了也花不出去"这句也在（用户点名要的）');
  check(/收款码/.test(n37), '★ 并让他扫收款码 ✓');

  // ⚠️⚠️ 2026-10-16 用户补的一条：「**应该不是直说固定话术，而是经过模型润色确保不是在说
  //     重复的话吧**」——
  //    ① 那句话**不许写死**，得走模型润色（`sendAdvice`）✓
  //    ② 而且要把**她上回为钱说的那句**摆给它看、明确要求**换一种说法** ✓
  {
    pw.patchState(uid, { stage: 'intake', redbagAt: Date.now(), lastPaySay: '二维码我发你了，扫那个就行' });
    const n37b = pw.noteFor({ message_type: 'private', user_id: uid });
    check(
      /换一种说法/.test(n37b) && /二维码我发你了/.test(n37b),
      '★★★ 红包提示里**带上她上次说的那句**并要求换一种说法（不是固定话术 ✓）',
    );
    pw.patchState(uid, { redbagTold: 0 });
    // 接口那条路：话要经过模型润色（`sendAdvice`），不是直接发写死的那句
    const s37b = readFileSync(join(ROOT, 'src', 'private-work.js'), 'utf8');
    check(
      /const say = await sendAdvice\(id, bot, meaning, 1200,/.test(s37b),
      '★★ 补发收款码那句是**润色后**才发的（写死的只是"模型挂了"的兜底）✓',
    );
    check(
      /s\.lastPaySay = String\(say\)\.slice\(0, 120\)/.test(s37b),
      '★★ 并且记住这次是怎么说的（下次好换着说 ✓）',
    );
  }

  // 接线：接口在、面板话术那句也在
  const j37 = readFileSync(join(ROOT, 'src', 'webui.js'), 'utf8');
  const s37 = readFileSync(join(ROOT, 'src', 'private-work.js'), 'utf8');
  check(/POST \/api\/private-work\/paycode/.test(j37), '★★ 有"手动补发收款码"的接口（用户要的"先补发"就靠它 ✓）');
  check(
    /export async function sendPayCodeNow/.test(s37) && /hasRedPacket\(segs2, segText\)/.test(s37),
    '★★ 红包那条路真的接在 `onPrivate` 上（不是只写了个函数没人调 ✗）',
  );
  config.privateWork = keepWD;
}

console.log(
  '\n【39】★★ 他问"现在改成什么样了" ⇒ 也顺手截一张发过去（2026-10-16 用户要求）',
);
{
  // 用户原话：「**这种也应该同时进一下截图过程，截个图发给对方**」
  //   （截图里客户问的是「现在改成什么样了？」）
  //   之前只有"**她答应截图**"才会去截 ✗ ⇒ 客户直接问效果时她只会用嘴描述 ✗
  const uid = '2770181349';
  const keepWE = config.privateWork;
  config.privateWork = { ...(keepWE ?? {}), enable: true, shot: { enable: true, cooldownMs: 0 } };
  pw.__setFriends({ [uid]: '客户' });
  const dir = pw.ensureWorkspace(uid, '客户');
  writeFileSync(join(dir, '产物', 'index.html'), '<html><body>hi</body></html>', 'utf8');
  pw.__clearGuiCache();
  const gui = pw.guiFile(uid);
  check(!!gui, '★ 前提：工作区里有能截的页面 ✓', gui);

  const sent = [];
  const bot = {
    call: async (a, p) => {
      if (a === 'send_private_msg' && Array.isArray(p.message)) sent.push('image');
      return { status: 'ok', retcode: 0, data: { message_id: 1 } };
    },
    sendText: async () => '1',
    noteSentFile: () => {},
  };
  // 判"他是不是想看效果"**全交给模型** ⇒ 桩成一个"能听懂话"的模型 ✓
  // ⚠️ 2026-10-16 用户要求：「**别用关键词判断，就修改一下是否截图的判断模型就行了**」
  //    ⇒ 代码里**不该再有** `SHOT_ASK_RE` 那种快筛；措辞一变也得认出来 ✓
  pw.__setPhrase(async ({ system, user }) =>
    String(system).includes('他要不要看图')
      ? /什么样|啥样|瞅一眼|看看效果|长什么/.test(String(user))
        ? '是'
        : '不是'
      : '',
  );
  // 截图那两步也桩掉（子代理找页面 + 按快门）
  pw.__setRunner(async () => ({
    promise: Promise.resolve({ code: 0, stdout: `【页面】${gui}\n【尺寸】1400x900\n【一句话】这是现在的样子\n` }),
    kill: () => {},
  }));
  pw.__setCapture(async (_p, _s, out) => {
    writeFileSync(out, 'x'.repeat(5000), 'utf8');
    return out;
  });

  pw.patchState(uid, { shotAt: 0, shotting: false, stage: 'running' });
  check(
    (await pw.maybeShotByAsk(uid, bot, '现在改成什么样了？')) === true,
    '★★★ 「现在改成什么样了？」⇒ **接住**（会去截一张 ✓）',
  );
  await new Promise((r) => setTimeout(r, 1800));
  check(sent.includes('image'), '★★ 图真发出去了（不用她拿嘴描述 ✓）');

  // 反例：不相关的问句别乱截图（省钱、也别骚扰客户）✗
  pw.patchState(uid, { shotAt: 0, shotting: false });
  check(
    (await pw.maybeShotByAsk(uid, bot, '这个大概多少钱？')) === false,
    '★★ 问价格那种**不截**（模型判"不是要看图" ⇒ 不截 ✓）',
  );
  // 催进度那句（"做到哪一步了"）也不该被这条抢走 —— 那是"催进度"那条路的事 ✓
  pw.patchState(uid, { shotAt: 0, shotting: false });
  check(
    (await pw.maybeShotByAsk(uid, bot, '做到哪一步了')) === false,
    '★ 「做到哪一步了」走"催进度"那条路，不抢 ✓',
  );
  // ⚠️ 换个说法（**不带"什么样"三个字**）也要认出来 —— 这正是"别用关键词"的意义 ✓
  pw.patchState(uid, { shotAt: 0, shotting: false });
  check(
    (await pw.maybeShotByAsk(uid, bot, '给我瞅一眼现在弄成啥了')) === true,
    '★★★ **换种说法也认**（"给我瞅一眼…啥样"）—— 关键词那版会漏掉这种 ✗',
  );

  pw.__setPhrase(null);
  pw.__setRunner(null);
  pw.__setCapture(null);
  config.privateWork = keepWE;

  const s39 = readFileSync(join(ROOT, 'src', 'private-work.js'), 'utf8');
  check(
    /void maybeShotByAsk\(uid, bot, askText\)/.test(s39),
    '★★ 接线在 `onPrivate` 上（他每来一句话都会过一下 ✓）',
  );
  check(
    !/const SHOT_ASK_RE/.test(s39) && !/SHOT_ASK_RE\.test/.test(s39),
    '★★★ **关键词快筛已经删掉了**（用户：「别用关键词判断，就修改一下是否截图的判断模型就行了」✓）',
  );
  check(
    /sqllocaldb start MSSQLLocalDB/.test(s39),
    '★★ 工作区规矩里加了"跑要数据库的项目先 `sqllocaldb start`"（今天那个 LocalDB 弹框的真凶 ✓）',
  );
}

console.log(
  '\n【38】★★ 任务面板不该留下"被打断"的僵尸记录（2026-10-16 用户截图问的）',
);
{
  // 用户原话：「**看看为什么这个是被杀的状态，现在不应该有被杀掉的状态吧，
  //   要么重启了之后自动继续，要么是做完了**」
  const ab = await import('../src/agent-bridge.js');

  // ① 一条"上次重启带走"的 killed 记录（已经十分钟了、也没人在跑）⇒ 应该收成 done ✓
  const id1 = ab.addPrivateHist({ by: '2770000001', byName: '客户甲', task: '接着做过 2 次的活', kind: 'dm' });
  ab.patchPrivateHist(id1, { status: 'killed', startedAt: Date.now() - 10 * 60 * 1000, endedAt: 0 });

  // ② 一条 killed、但**这会儿真的在跑**（jobs 里有它）⇒ 标回 running ✓
  const id2 = ab.addPrivateHist({ by: '2770000002', byName: '客户乙', task: '正在跑的活', kind: 'dm' });
  ab.patchPrivateHist(id2, { status: 'killed', startedAt: Date.now() - 10 * 60 * 1000, endedAt: 0 });

  const n = ab.tidyStaleTasks((t) => String(t?.by ?? '') === '2770000002');
  check(n >= 1, '★★ 收拾了僵尸记录（原来会永远挂在"被打断了" ✗）', String(n));
  const h = ab.taskHistory(200);
  check(
    h.find((t) => t.id === id1)?.status === 'done',
    '★★★ 没人管的 killed ⇒ 收成 done（面板上不再显示"被打断" ✓）',
    h.find((t) => t.id === id1)?.status,
  );
  check(
    h.find((t) => t.id === id2)?.status === 'running',
    '★★ 还在跑的那条 ⇒ 标回 running（重启后会接着做 ✓）',
    h.find((t) => t.id === id2)?.status,
  );

  // ③ 刚结束的（1 分钟内）不许动 —— 可能上层正要标 done ✓
  const id3 = ab.addPrivateHist({ by: '2770000003', byName: '客户丙', task: '刚发生的', kind: 'dm' });
  ab.patchPrivateHist(id3, { status: 'killed', startedAt: Date.now() - 5000, endedAt: 0 });
  ab.tidyStaleTasks(() => false);
  check(
    ab.taskHistory(200).find((t) => t.id === id3)?.status === 'killed',
    '★ 刚结束的不动（留出上层标 done 的时间窗 ✓）',
  );

  // ④ 接线：开机 45 秒后扫一次；预读收尾时也顺手收拾 killed ✓
  const s38 = readFileSync(join(ROOT, 'src', 'private-work.js'), 'utf8');
  check(
    /ab\.tidyStaleTasks\(\(t\) =>/.test(s38) && /45000/.test(s38),
    '★★ 开机后会自己扫一遍（把群任务和私聊的活都算上 ✓）',
  );
  check(
    /const ab4 = await import\('\.\/agent-bridge\.js'\)[\s\S]{0,400}st === 'killed'/.test(s38),
    '★★ 预读收尾时也顺手把 killed 收掉 ✓',
  );
}

console.log(
  '\n【40】★★ 交付完之后他回来问"怎么用" ⇒ 她照产物自带的那份说明答（2026-10-16 用户问的）',
);
{
  // 用户原话：「**现在还差客户收到产物之后回来问 bot 或者截图问 bot 如何操作之类的事情了。
  //   现在 bot 会如何回应？**」
  //   真问题：交付完 `stage` 重置成 `intake` ⇒ 提示词里给她的却是"有人来找你帮个忙、
  //   先把要求弄清楚" ✗，而**产物里那份《怎么跑》压根没进提示词** ✗✗
  const uid = '2770181350';
  const keepWF = config.privateWork;
  config.privateWork = { ...(keepWF ?? {}), enable: true };
  pw.__setFriends({ [uid]: '客户' });
  const dir = pw.ensureWorkspace(uid, '客户');
  writeFileSync(
    join(pw.outDir(uid), '怎么跑.md'),
    '1. 先装 .NET 8 运行时\n2. 双击 AIBOM.UI.exe\n3. 账号 admin / 密码 Admin@123456\n',
    'utf8',
  );
  writeFileSync(join(pw.outDir(uid), '手办.py'), 'print(1)\n', 'utf8');

  const sent = [];
  const bot = {
    call: async (a, p) => {
      if (a === 'upload_private_file') sent.push(String(p.name));
      return { status: 'ok', retcode: 0, data: { message_id: 1 } };
    },
    sendText: async () => '1',
    noteSentFile: () => {},
  };
  pw.patchState(uid, { stage: 'waiting', etaAt: Date.now() - 1000, outBase: '' });
  await pw.deliver(uid, bot);
  check(
    !!pw.stateOf(uid).handbook?.text && /Admin@123456/.test(pw.stateOf(uid).handbook.text),
    '★★★ 交付成功时**把产物自带的说明存下来了**（原来压根不读它 ✗）',
  );

  // 他回来问"怎么用" ⇒ 提示词里必须带这份说明，而且明说"这是问怎么用、不是新活" ✓
  pw.patchState(uid, { stage: 'intake' });
  const n40 = pw.noteFor({ message_type: 'private', user_id: uid });
  check(/怎么跑|怎么用/.test(n40), '★★ 提示词里带上了"这东西怎么用"那段 ✓');
  check(/Admin@123456|双击/.test(n40), '★★★ 说明的**内容**也在（她照着说，不用猜 ✓）');
  check(/不是新活/.test(n40), '★★ 并明说"他这是问怎么用、不是新活"（不然她会当新单反问 ✗）');
  check(/发截图/.test(n40) && /别凭想象/.test(n40), '★★ 发截图问某一步时等她看过图再答（别编 ✓）');

  // 2 小时后就不带了（别把提示词一直塞爆 ✗）
  pw.patchState(uid, { handbook: { at: Date.now() - 3 * 60 * 60 * 1000, text: 'x' } });
  check(
    !/你刚交给他那个东西怎么用/.test(pw.noteFor({ message_type: 'private', user_id: uid })),
    '★ 过了 2 小时就不带了（提示词不长期变胖 ✓）',
  );
  config.privateWork = keepWF;
}

console.log(
  '\n【41】★★★ 关键词快判全撤了：换个说法也得认出来（铁律「非必要不用关键词快判」）',
);
{
  // 用户原话：「**撤一下然后改，效果必须要比关键词快判要好很多**」
  //   ⇒ 下面三条都是**老关键词一定漏**的说法（"多少米" / "嗯嗯" / "弄成蓝的"），
  //     现在交给模型判 ⇒ 全都认得出来 ✓
  const s41 = readFileSync(join(ROOT, 'src', 'private-work.js'), 'utf8');
  check(
    !/const (PAY_SAY_RE|SHOT_SAY_RE|BORING_RE) =/.test(s41) &&
      !/function (looksLikePaying|looksLikeRework)\(/.test(s41),
    '★★★ 老快判（收款码/截图/语气词/谈钱/返工）**都已经删掉**了（用户：「撤一下然后改」✓）',
  );
  for (const fn of ['judgeMoneyTalk', 'judgeBoringSay', 'judgeShotAsk']) {
    check(new RegExp(`(async )?function ${fn}\\(`).test(s41), `★★ 改成模型判：\`${fn}\` 在 ✓`);
  }

  const uid = '2770181351';
  const keepWG = config.privateWork;
  const keepOwner = config.ownerQQ;
  config.privateWork = { ...(keepWG ?? {}), enable: true };
  pw.__setFriends({ [uid]: '客户' });
  pw.ensureWorkspace(uid, '客户');
  const evOf = (t) => ({
    message_type: 'private',
    user_id: uid,
    message: [{ type: 'text', data: { text: t } }],
  });
  const toOwner = [];
  const bot = {
    call: async (a, p) => {
      if (a === 'send_private_msg' && String(p.user_id) === '10000001') toOwner.push(String(p.message));
      return {};
    },
    sendText: async () => '1',
    noteSentFile: () => {},
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ① 谈钱：用**老关键词表里一个都没有**的说法（"多少米""便宜点""咋给你"）
  config.ownerQQ = '10000001';
  pw.patchState(uid, { stage: 'intake', moneyJudgeAt: 0, payToldAt: 0, dropReplyAt: 0 });
  pw.__setPhrase(async ({ system, user }) =>
    String(system).includes('是不是在谈钱')
      ? /多少米|便宜点|咋给你/.test(String(user))
        ? '是'
        : '不是'
      : '',
  );
  await pw.onPrivate(evOf('这个多少米啊，能便宜点不'), null, bot);
  await sleep(300);
  check(
    toOwner.length >= 1,
    '★★★ 换种说法也认出来了 ⇒ **通知主人** ✓（"多少米/便宜点"老表里一个都没有 ✗）',
    toOwner.length ? '通知了' : '没通知',
  );
  toOwner.length = 0;
  pw.patchState(uid, { moneyJudgeAt: 0, payToldAt: 0 });
  await pw.onPrivate(evOf('行，那我把文件发你'), null, bot);
  await sleep(200);
  check(toOwner.length === 0, '★ 不是谈钱就不通知（不误报 ✓）');

  // ② 收场之后的语气词：换个说法（"嗯嗯""晓得啦"）—— 老 `BORING_RE` 也漏 ✗
  pw.patchState(uid, { stage: 'intake', dropReplyAt: 0, myLastSay: null });
  pw.noteFarewell(uid);
  pw.__setPhrase(async ({ system, user }) =>
    String(system).includes('没营养')
      ? /嗯嗯|晓得啦|好的好的/.test(String(user))
        ? '是'
        : '不是'
      : '',
  );
  await pw.onPrivate(evOf('嗯嗯，晓得啦'), null, bot);
  await sleep(200);
  check(
    pw.looksPointlessAfterFarewell(uid, '嗯嗯，晓得啦') === true,
    '★★★ 「嗯嗯，晓得啦」也不回（老关键词是"嗯/行/好"那种死表 ⇒ 必漏 ✗）',
  );
  pw.patchState(uid, { dropReplyAt: 0 });
  await pw.onPrivate(evOf('你把那个报告的封面换一下'), null, bot);
  await sleep(200);
  check(pw.looksPointlessAfterFarewell(uid, '你把那个报告的封面换一下') === false, '★★ 真说了事 ⇒ 照常回 ✓');

  // ③ 返工：换个说法（"这块能不能弄成蓝的"）也必须认出来 ⇒ 当场再起一轮 ✓
  pw.__setPhrase(null);
  let ran = 0;
  pw.__setRunner(async () => {
    ran++;
    return { promise: Promise.resolve({ code: 0, stdout: '好', sessionId: `s-${ran}` }), kill: () => {} };
  });
  pw.patchState(uid, { stage: 'waiting', need: '做一份报告', etaAt: 0, selfCheckRounds: 0 });
  const ab41 = await import('../src/agent-bridge.js');
  ab41.__setInterject(async (t) => (/弄成蓝的/.test(String(t)) ? 'change' : 'none'));
  await pw.onPrivate(evOf('这块能不能弄成蓝的'), null, bot);
  await sleep(400);
  check(ran >= 1, '★★★ 换种说法（"弄成蓝的"）也判成"要改" ⇒ 当场又起一轮 ✓（老关键词"改成/换成"必漏 ✗）');
  ab41.__setInterject(async () => 'none');
  pw.__setRunner(null);

  config.ownerQQ = keepOwner;
  config.privateWork = keepWG;
}

console.log(
  '\n【42】★★ 骂人/要退款 ⇒ 私聊通知主人；加急 ⇒ 把"故意拉长"的交付时间缩回去（2026-10-16 用户要求）',
);
{
  // 用户原话：「**骂人 / 要退款给我发消息**，然后**加急的话缩短那个为了模仿真人故意
  //   延长的交付时间即可**」
  const uid = '2770181352';
  const keepWH = config.privateWork;
  const keepOwnerH = config.ownerQQ;
  config.privateWork = { ...(keepWH ?? {}), enable: true, rushMinutes: 20 };
  config.ownerQQ = '10000001';
  pw.__setFriends({ [uid]: '客户' });
  pw.ensureWorkspace(uid, '客户');
  const ev = (t) => ({ message_type: 'private', user_id: uid, message: [{ type: 'text', data: { text: t } }] });
  const toOwner = [];
  const bot = {
    call: async (a, p) => {
      if (a === 'send_private_msg' && String(p.user_id) === '10000001') toOwner.push(String(p.message));
      return {};
    },
    sendText: async () => '1',
    noteSentFile: () => {},
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ① 他骂人 ⇒ 通知主人 + 提示词里告诉她"先稳住、不许答应退钱" ✓
  pw.patchState(uid, { stage: 'waiting', moodJudgeAt: 0, upsetToldAt: 0, upsetAt: 0, etaAt: 0, need: '做个报告' });
  pw.__setPhrase(async ({ system, user }) => {
    const sys = String(system);
    if (sys.includes('不高兴')) return /退钱|什么破|坑|投诉/.test(String(user)) ? '是' : '不是';
    if (sys.includes('加急')) return /加急|快点|今天就要|急着/.test(String(user)) ? '是' : '不是';
    return '';
  });
  await pw.onPrivate(ev('这什么破东西，退钱吧，不退我投诉'), null, bot);
  await sleep(300);
  check(toOwner.length >= 1 && /退款|投诉/.test(toOwner[0] ?? ''), '★★★ 骂人/要退款 ⇒ **私聊通知主人** ✓', toOwner[0]?.slice(0, 20) ?? '没通知');
  const n42 = pw.noteFor({ message_type: 'private', user_id: uid });
  check(/退款|发火/.test(n42) && /别顶回去|稳住/.test(n42), '★★ 提示词里教她"先稳住" ✓');
  check(/不许\*\*答应退款|绝对不许\*\*答应退款|不许答应退款/.test(n42), '★★★ 并且明写**不许答应退款/赔钱**（那不是她能定的 ✓）');

  // ② 不是骂人 ⇒ 不通知
  toOwner.length = 0;
  pw.patchState(uid, { moodJudgeAt: 0, upsetToldAt: 0 });
  await pw.onPrivate(ev('这个大概多少钱'), null, bot);
  await sleep(250);
  check(toOwner.filter((m) => /骂|退款/.test(m)).length === 0, '★ 普通催进度/问价不会误报"骂人" ✓');

  // ③ 加急 ⇒ **交付时间缩回去**（平时那 2 小时~2 天是故意拉长的 ✓）
  const far = Date.now() + 6 * 60 * 60 * 1000; // 说好 6 小时后
  pw.patchState(uid, { stage: 'waiting', moodJudgeAt: 0, etaAt: far, rush: 0 });
  await pw.onPrivate(ev('太慢了，能加急吗，我今天就要'), null, bot);
  await sleep(300);
  const eta = pw.stateOf(uid).etaAt;
  check(pw.stateOf(uid).rush > 0, '★★ 记下了"他加急了" ✓');
  check(
    eta < far && eta - Date.now() <= 21 * 60 * 1000,
    '★★★ 交付时间**往前赶了**（6 小时 → 最多 20 分钟）✓',
    `还剩 ${Math.round((eta - Date.now()) / 60000)} 分钟`,
  );
  const n42b = pw.noteFor({ message_type: 'private', user_id: uid });
  check(/加急/.test(n42b), '★★ 提示词里也提醒她"他加急了、时间提前了" ✓');
  check(!/\d{1,2}:\d{2}/.test(n42b), '★ 而且照样**不报具体到分钟**的钟点 ✓');

  config.ownerQQ = keepOwnerH;
  config.privateWork = keepWH;
}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
