/**
 * 「本机 agent 任务」的回归（2026-10-13 加）。
 *
 * ## 用户定的规则（原话，一条都不许改）
 *   「可以让 bot 接入本机上的 agent 完成一些简单的任务吗」
 *   「…**要支持自然语言**，现在**只允许主人 QQ 能直接开始任务**。
 *    bot 发送的**确认开始任务**发的消息**前面加两个空格**来分辨是否开始了任务，
 *    其他人要开始的话 bot 先发一条 **@主人** 的消息问主人是否同意，
 *    回复**同意**的消息之后再开始。**前面的部分全部是自然语言**。
 *    加指令：`/任务撤回`，负责撤回刚才开始的任务。」
 *
 * ## 这个套件盯什么（每条都对应他原话里的一个字）
 *   ① 主人说一句活 ⇒ 回一条**两个空格开头**的确认 ⇒ 起 agent（真的开跑）
 *   ② 别人说一句活 ⇒ 先 **@主人** 问一句，**不跑**；主人回「同意」才跑
 *   ③ 别人回「同意」**不算**（只有主人能批）
 *   ④ 主人回「不行」⇒ 那件事作废
 *   ⑤ `/任务撤回` ⇒ 把正在跑的那个停掉；没有在跑的 ⇒ 明说
 *   ⑥ 判定说是"不是任务" ⇒ 什么都不做（`handle` 返回 false，交回正常聊天）
 *   ⑦ 上限 / 工作区没配 → 都不跑，但要回一句
 *   ⑧ 结果：**截断 + 脱敏**后才发群；同时追加进工作区的 `任务记录.md`（GUI 里能看见）
 *
 * ⚠️ 纯离线：`__setJudge` / `__setRunner` 把"模型判定"和"真起进程"两步都换掉，
 *    所以**不花模型钱、也不会真跑 agent、更不会碰到工作区里的真文件**。
 *
 * 用法: node test/agent-bridge.js
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });
const CFG_REL = 'logs/__test-agent.yml';
const STATE_REL = 'logs/__test-agent-state.json';
const HIST_REL = 'logs/__test-agent-tasks.json';
const WS_REL = 'logs/__test-agent-ws';

// ⚠️ 配置必须在 import `src/*` **之前**写好（`config.js` 是加载时读的）
writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
    '  apiKey: "sk-test"',
    '  model: t',
    'trigger:',
    '  respondTo: 3',
    `  allowGroups: ["999000001"]`,
    `  groupRespondTo:`,
    `    "999000001": 1`,
    'ownerQQ: "10000001"',
    'chat:',
    '  enable: true',
    'context:',
    '  enable: true',
    'agent:',
    '  enable: true',
    `  workspace: "${WS_REL}"`,
    '  maxPerDay: 2',
    '  timeoutMs: 60000',
    '  maxOutputChars: 120',
    // ⚠️ 2026-10-13：产物发群的两个上限（小一点才测得出来：
    //    maxFiles=2 / maxFileMB=1 —— 下面【15】就是靠这两个数验"卡不卡得住"）
    '  maxFiles: 2',
    '  maxFileMB: 1',
    // ⚠️ 2026-10-13：套件里**关掉"必须 @ 她"**那道闸 —— 老段落测的是别的东西，
    //    不该因为这条新规矩集体变红；"必须 @"这条由【23】单独测（它自己临时打开 ✓）
    '  requireAt: false',
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;
process.env.QQBOT_AGENT_FILE = STATE_REL;
// ⚠️⚠️ 2026-10-13 补（**又踩了同一个坑**）：任务历史也要隔离 ——
//    不然套件里那些假任务会写进**真实的** `state/agent-tasks.json`，
//    用户打开任务页看到一堆「做个喜庆的界面 / 999000001」（我实测看到了 ✗）
process.env.QQBOT_AGENT_TASKS_FILE = HIST_REL;
// ⚠️⚠️ **必须把账号目录也隔离掉**（2026-10-13 踩的）：
//    `config.js` 会把**主号的私有配置**（`accounts/<主号>.yml`）合并到最上面 ——
//    而那份文件里**真的有 `agent:` 段**（enable + workspace=真实工作区）⇒
//    我这份测试配置会被它整个盖掉：`workspace` 变成**真目录**、`maxPerDay`/`maxOutputChars`
//    也全按线上的来 ⇒ 断言全错，**而且测试会往用户真工作区里写 `任务记录.md`** ✗✗
//    （run-all 会给每个套件注入 `QQBOT_ACCOUNTS_DIR`；这里单独跑也要自己设。）
process.env.QQBOT_ACCOUNTS_DIR = 'logs/__test-agent-accounts';
// ⚠️⚠️ run-all 会给所有套件注入 `QQBOT_AGENT=off`（免得不小心真跑 agent）——
//    本套件正是要测它，所以必须显式打开（和 `test/peer-chat.js` 同一个坑）。
process.env.QQBOT_AGENT = 'on';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const { ROOT: R2, config } = await import('../src/config.js');
const ab = await import('../src/agent-bridge.js');
const { Bot } = await import('../src/bot.js');
void R2;

// ⚠️ 2026-10-13：「用她自己的口吻说一遍」那一步也是**一次真模型调用**（`voiceize`）——
//    套件里桩掉、原样返回（要验的是"发没发、内容对不对"，不是模型文笔）。
ab.__setVoice(async (kind, facts) => String(facts ?? ''));
// ⚠️⚠️ 2026-10-13：**"他问的是不是刚做完那个活"那个判定也要默认桩成"不是"** ——
//    不桩的话它会**真调模型**（每句 @她的消息都要等 8 秒 ✗），而且会抢插话那条路 ✗
//    （要测它的那一段自己覆盖成 `action:'ask'` ✓ 见【27】）
ab.__setAskAgent(async () => ({ action: '', question: '' }));
// ⚠️⚠️ 2026-10-16 加：**"插话前先探查现状"那一步也要桩掉**（`peekForChange`）——
//    它是**一次真的只读 agent 调用** ⇒ 不桩的话：① 本套件从 4 秒变 **216 秒**；
//    ② 真花一次 agent 的钱 ✗（要验的是"探查之后有没有带上建议重跑"，不是探查质量）
ab.__setPeek(async () => '');
// ⚠️⚠️ 2026-10-14（用户：「**直接把 agent 设定为 saki 自己的电脑**，由**她自己决定**
//    什么时候该用电脑…」）：那道"她自己决定要不要动电脑"的判定也是**一次真模型调用** ——
//    默认桩成「不用」，否则**套件里每一句 @她的话都会真调模型**（等 6 秒 + 花钱 ✗）。
//    （要测它的那一段自己覆盖成 `{ action: 'use', plan: … }` ✓ 见【29】）
ab.__setSelfUse(async () => ({ action: '', plan: '' }));

const GROUP = '999000001';
const BOT = '10000002';
const OWNER = '10000001';
const OTHER = '10000003';

mkdirSync(join(ROOT, WS_REL), { recursive: true });

const textSeg = (t) => ({ type: 'text', data: { text: t } });
const atSeg = (qq) => ({ type: 'at', data: { qq: String(qq) } });
const evOf = (uid, message) => ({
  message_type: 'group',
  group_id: GROUP,
  user_id: String(uid),
  self_id: BOT,
  message,
  sender: { user_id: String(uid), nickname: uid === OWNER ? '<主人>' : '某群友', card: uid === OWNER ? '<主人>' : '某群友' },
});

/** 桩：记下 bot 发了什么 */
function botWith() {
  const b = new Bot();
  b.selfId = BOT;
  b.sent = [];
  b.sendToGroup = async (g, t, opts) => {
    b.sent.push({ gid: g, text: String(t), at: opts?.at ?? '' });
  };
  return b;
}

/** 桩：不真起进程；把"开跑"和"kill"都记下来 */
function stubRunner({ autoFinish = true } = {}) {
  const calls = { tasks: [], dirs: [], hooks: [], killed: 0 };
  let resolveRun = null;
  ab.__setRunner((task, hooks) => {
    calls.tasks.push(String(task));
    calls.dirs.push(String(hooks?.taskDir ?? ''));
    calls.hooks.push(hooks ?? {});
    const promise = autoFinish
      ? new Promise((r) => setTimeout(() => r({ code: 0, stdout: `干完了：${task.slice(-8)}`, stderr: '', killed: false }), 5))
      : new Promise((r) => {
          resolveRun = () => r({ code: 0, stdout: '晚到的结果', stderr: '', killed: true });
        });
    return {
      promise,
      kill: () => {
        calls.killed++;
        resolveRun?.();
      },
    };
  });
  return calls;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
console.log('\n【1】★★ 主人说一句活 → 两个空格开头的确认 + 真的开跑');
{
  ab.__reset();
  ab.__setJudge(async () => 'task');
  const calls = stubRunner();
  const b = botWith();
  const msg = [textSeg('帮我看看这个目录里有什么，整理成一份 md')];
  const handled = await ab.handle(evOf(OWNER, msg), msg, b);
  check(handled === true, '★ 这条被任务桥接管了（不再走正常聊天）');
  check(
    b.sent.some((s) => s.text.startsWith('  ') && /去弄/.test(s.text)),
    '★★ 回了「两个空格开头」的确认（用户要靠它分辨任务是否已开始）',
    JSON.stringify(b.sent.map((s) => s.text.slice(0, 18))),
  );
  // ⚠️ 2026-10-13 用户截图：「**不要复制一遍要做的事**」——确认那条不许复读他的话
  {
    const cm = b.sent.find((s) => s.text.startsWith('  '));
    check(
      !!cm && !cm.text.includes('整理成一份') && !cm.text.includes('帮我看看这个目录'),
      '★★ 确认那条**不复读**他说的话（用自己的话说开始做什么就行）',
      cm ? cm.text.trim().slice(0, 26) : '（没发）',
    );
  }
  await wait(60);
  check(calls.tasks.length === 1, '★ agent 真的开跑了（一次）', String(calls.tasks.length));
  // ⚠️ 铁律是 `defaultRunner` 拼进提示词的（套件桩掉的是"起进程"那一步，所以这里查源码）
  const src = readFileSync(join(ROOT, 'src', 'agent-bridge.js'), 'utf8');
  check(
    /要改现有的文档：先复制一份/.test(src) &&
      /要做一份工作区里本来就没有的东西/.test(src) &&
      /\$\{RULES\}\$\{taskText\}/.test(src),
    '★★ 提示词里钉着两条（而且都真的拼进去了）：改现有的→复制再改；工作区**没有**的→直接新建（别卡住）',
  );
  check(
    calls.tasks[0].includes('整理成一份 md'),
    '★ 任务原文原样带下去了（没有被改写）',
  );
  check(
    b.sent.some((s) => /干完了/.test(s.text)),
    '★ 结果发回群里了',
    JSON.stringify(b.sent.map((s) => s.text.slice(0, 12))),
  );
  const ledger = join(ROOT, WS_REL, '任务记录.md');
  check(existsSync(ledger), '★★ 工作区里出现了 `任务记录.md`（GUI 里打开工作区就能看见）');
  if (existsSync(ledger)) {
    const t = readFileSync(ledger, 'utf8');
    check(/开工/.test(t) && /完工/.test(t), '★ 台账里有开工 + 完工两条');
  }
  // ⚠️⚠️ 2026-10-13 加（用户：「agent 文件夹现在有点乱，建议**直接一个文件夹对应一个任务**」）
  const dir = calls.dirs[0];
  check(!!dir && existsSync(dir), '★★ 这次任务有**自己的文件夹**（不是把文件散在工作区里）', dir || '（没给）');
  check(
    !!dir && /^\d{4}-\d{2}-\d{2} \d{4} /.test(basename(dir)),
    '★★ 文件夹名是「日期 时间 + 任务摘要」（他自己在资源管理器里认得出）',
    dir ? basename(dir) : '',
  );
  check(
    !!dir && existsSync(join(dir, 'AGENTS.md')) && existsSync(join(dir, '任务.md')),
    '★★ 文件夹里放好了 `AGENTS.md`（铁律的副本）+ `任务.md`（这次是谁、原话是什么）',
  );
  // ⚠️ 2026-10-19 改（用户：「**把在群里开的任务都收到一个文件夹里**，现在 agentwork 文件夹里有点乱了」）——
  //    原来这条断言要求"任务文件夹就在工作区**根下**"，现在改成**统一放进 `群任务/`** 了。
  //    ⚠️ 但"别塞进深层子目录"那个初衷**还在**：任务文件夹往下**不再有子层**，
  //    再深就不许了 —— 不然清理逻辑（按顶层文件夹扫）和用户自己翻文件都会变难 ✗
  // ⚠️ 用"父目录就是工作区/群任务"判（工作区在套件里是**相对路径** —— 别拿绝对路径去 startsWith）
  const wsBase = String(config.agent.workspace).replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
  const parent = dir ? dirname(String(dir)).replace(/[\\/]+$/, '').toLowerCase() : '';
  // ⚠️⚠️ 2026-10-21 再改（用户：「**不同群不应该不是同一个 agent 文件夹吗**」）——
  //    现在多一层**群号**：`<工作区>/群任务/<群号>/<任务文件夹>`
  //    ⇒ 两个群同一个活名也各归各的，物理上串不了（2026-10-21 跨群发错视频的根因之一）
  const groupOfDir = parent ? parent.slice(parent.lastIndexOf('\\') + 1) : '';
  check(
    !!parent && dirname(parent) === `${wsBase}\\群任务` && /^\d+$/.test(groupOfDir),
    '★ 任务文件夹在 `<工作区>/群任务/<群号>/` 里（按群隔离，不往更深的子目录里塞）',
    dir || '',
  );
}

console.log('\n【2】★★ 别人说一句活 → 先 @主人 问，**不许直接跑**');
{
  ab.__reset();
  ab.__setJudge(async () => 'task');
  const calls = stubRunner();
  const b = botWith();
  const msg = [textSeg('帮我整理一下这个目录')];
  const handled = await ab.handle(evOf(OTHER, msg), msg, b);
  check(handled === true, '★ 这条也被接管了（她要回话）');
  check(calls.tasks.length === 0, '★★ 但**没有开跑**（要等主人同意）', String(calls.tasks.length));
  const ask = b.sent.find((s) => s.at === OWNER);
  check(!!ask, '★★ 发的是一条 **@主人** 的消息', JSON.stringify(b.sent.map((s) => s.at)));
  check(!!ask && !ask.text.startsWith('  '), '★ 询问那条**不带**两个空格（只有"确认开始"才带）');
  check(!!ask && /同意/.test(ask.text), '★ 问法里写明了"回同意我就去"');
}

console.log('\n【3】★★ 主人回「同意」→ 才开始（用**原来那句**任务）');
{
  const calls = stubRunner();
  const b = botWith();
  ab.__setJudge(async () => 'approve');
  const msg = [textSeg('同意')];
  const handled = await ab.handle(evOf(OWNER, msg), msg, b);
  check(handled === true, '★ 主人这句被接管');
  check(
    b.sent.some((s) => s.text.startsWith('  ')),
    '★★ 开始那一刻才发"两个空格开头"的确认',
  );
  await wait(60);
  check(calls.tasks.length === 1, '★★ agent 开跑了', String(calls.tasks.length));
  check(calls.tasks[0].includes('整理一下这个目录'), '★★ 跑的是**刚才那件**（不是"同意"两个字）', calls.tasks[0].slice(-20));
}

console.log('\n【4】别人回「同意」**不算**（只有主人能批）');
{
  ab.__reset();
  ab.__setJudge(async () => 'task');
  const b0 = botWith();
  await ab.handle(evOf(OTHER, [textSeg('帮我整理一下这个目录')]), [textSeg('帮我整理一下这个目录')], b0);
  const calls = stubRunner();
  ab.__setJudge(async () => 'approve');
  const b = botWith();
  const msg = [textSeg('同意')];
  const handled = await ab.handle(evOf(OTHER, msg), msg, b);
  check(handled === false, '★ 不是主人 ⇒ 这句交给正常聊天（不由任务桥处理）');
  check(calls.tasks.length === 0, '★★ 没跑', String(calls.tasks.length));
}

console.log('\n【5】主人回「不行」→ 那件事作废');
{
  ab.__reset();
  ab.__setJudge(async () => 'task');
  const b0 = botWith();
  await ab.handle(evOf(OTHER, [textSeg('帮我把这个目录整理一下')]), [textSeg('帮我把这个目录整理一下')], b0);
  const calls = stubRunner();
  ab.__setJudge(async () => 'reject');
  const b = botWith();
  await ab.handle(evOf(OWNER, [textSeg('不行')]), [textSeg('不行')], b);
  check(calls.tasks.length === 0, '★ 没跑');
  check(b.sent.some((s) => /不接了/.test(s.text)), '★ 回了「那件事我不接了」', JSON.stringify(b.sent.map((s) => s.text)));
  check(ab.__state().pending === null, '★ 挂着的询问清掉了');
}

console.log('\n【6】★★ `/任务撤回`：把正在跑的那个停掉');
{
  ab.__reset();
  ab.__setJudge(async () => 'task');
  const calls = stubRunner({ autoFinish: false }); // 一直跑，等撤回
  const b = botWith();
  await ab.handle(evOf(OWNER, [textSeg('帮我整理一下这个大目录')]), [textSeg('帮我整理一下这个大目录')], b);
  check(
    calls.tasks.length === 1,
    '★ 先跑起来',
    `实际 ${calls.tasks.length} 次：${JSON.stringify(calls.tasks.map((x) => String(x).slice(0, 24)))}`,
  );
  const b2 = botWith();
  const handled = await ab.handle(evOf(OWNER, [textSeg('/任务撤回')]), [textSeg('/任务撤回')], b2);
  check(handled === true, '★ 撤回指令被接管');
  check(calls.killed >= 1, '★★ 正在跑的那个被 kill 了', String(calls.killed));
  await wait(30);
  check(
    b2.sent.some((s) => /我停了/.test(s.text)),
    '★ 回了「那个我停了」',
    JSON.stringify(b2.sent.map((s) => s.text)),
  );
  // ⚠️ 2026-10-13：**手打的 `/任务撤回`** 不是插话 ⇒ 那条**不带**两个空格（插话那两条才带）
  check(
    b2.sent.some((s) => /我停了/.test(s.text) && !s.text.startsWith('  ')),
    '★ 手打的 `/任务撤回` 那条**不带**两个空格（那是命令，不是插话）',
  );
}

console.log('\n【7】没有在跑的时候 → 明确回一句，不许装死');
{
  ab.__reset();
  ab.__setJudge(async () => 'task');
  const calls = stubRunner();
  const b = botWith();
  const msg = [textSeg('/任务撤回')];
  const handled = await ab.handle(evOf(OWNER, msg), msg, b);
  check(handled === true, '★ 指令被接管');
  check(calls.killed === 0, '★ 没有可杀的东西（没报错）');
  check(b.sent.some((s) => /没有在跑/.test(s.text)), '★ 回了「这会儿没有在跑的任务」');
}

console.log('\n【8】判定说"不是在派活" → 什么都不做（交回正常聊天）');
{
  ab.__reset();
  const calls = stubRunner();
  const b = botWith();
  ab.__setJudge(async () => '');
  const msg = [textSeg('帮我把这个目录整理一下')];
  const handled = await ab.handle(evOf(OWNER, msg), msg, b);
  check(handled === false, '★ 不接管');
  check(calls.tasks.length === 0 && b.sent.length === 0, '★★ 没说也没跑（一个字都不该发）');

  // 快判没过时**连模型都不问**（省钱）—— 数一下判定被调了几次
  let asked = 0;
  ab.__setJudge(async () => {
    asked++;
    return '任务';
  });
  const msg2 = [textSeg('我今天任务好多啊')];
  const h2 = await ab.handle(evOf(OWNER, msg2), msg2, botWith());
  check(h2 === false && asked === 0, '★★ 「我今天任务好多啊」→ 快判就挡了，一次模型调用都没花');
}

console.log('\n【9】次数上限 / 没配工作区 → 不跑，但要回一句');
{
  ab.__reset();
  ab.__setJudge(async () => 'task');
  const calls = stubRunner();
  const b = botWith();
  // 连开两次（maxPerDay: 2）——第一次等它跑完，第二次还应该能开；第三次才该被挡
  for (let i = 0; i < 3; i++) {
    const t = `帮我整理一下第 ${i} 个目录`;
    await ab.handle(evOf(OWNER, [textSeg(t)]), [textSeg(t)], b);
    await wait(60);
  }
  check(calls.tasks.length === 2, `★ 一天最多 2 个（实际跑了 ${calls.tasks.length} 个）`);
  check(b.sent.some((s) => /够多了/.test(s.text)), '★ 超了之后回一句「今天够多了」');

  const keep = config.agent.workspace;
  config.agent.workspace = '';
  ab.__reset();
  const b2 = botWith();
  await ab.handle(evOf(OWNER, [textSeg('帮我整理一下这个目录')]), [textSeg('帮我整理一下这个目录')], b2);
  check(b2.sent.some((s) => /没配好|找不到/.test(s.text)), '★ 没配工作区 ⇒ 回一句，不跑');
  config.agent.workspace = keep;

  // ⚠️⚠️ 2026-10-13 用户要求「**直接取消限制**」：`maxPerDay: 0` = 不限次数
  const keepCap = config.agent.maxPerDay;
  config.agent.maxPerDay = 0;
  ab.__reset();
  const calls2 = stubRunner();
  const b3 = botWith();
  for (let i = 0; i < 4; i++) {
    const t = `帮我整理一下第 ${i} 个目录`;
    await ab.handle(evOf(OWNER, [textSeg(t)]), [textSeg(t)], b3);
    await wait(60);
  }
  check(
    calls2.tasks.length === 4,
    `★★ maxPerDay=0 ⇒ **不限次数**（连开 4 次全跑了：${calls2.tasks.length}）`,
  );
  check(!b3.sent.some((s) => /够多了/.test(s.text)), '★★ 也不再回「今天够多了」');
  check(ab.status().maxPerDay === 0, '★ 状态里如实报 0（不限），没被偷偷改成 1');
  config.agent.maxPerDay = keepCap;
  ab.__reset();
}

console.log('\n【10】结果：脱敏 + 截断');
{
  check(
    ab.redact('key sk-abcdef123456 和 ark-xyz789000 和 AQ.abcdef123456') === 'key sk-*** 和 ark-*** 和 AQ.***',
    '★★ 凭据一律打掉（结果是要发进群的）',
    ab.redact('key sk-abcdef123456 和 ark-xyz789000 和 AQ.abcdef123456'),
  );
  check(
    ab.redact('token=abcd1234').includes('token=***'),
    '★ `token=xxx` 这种写法也打掉',
  );
  ab.__reset();
  ab.__setJudge(async () => 'task');
  ab.__setRunner(() => ({
    promise: Promise.resolve({ code: 0, stdout: `xxxxx${'y'.repeat(500)}`, stderr: '', killed: false }),
    kill: () => {},
  }));
  const b = botWith();
  await ab.handle(evOf(OWNER, [textSeg('帮我整理一下这个目录')]), [textSeg('帮我整理一下这个目录')], b);
  await wait(60);
  const res = b.sent.find((s) => /xxxxx/.test(s.text));
  check(!!res && res.text.length < 400, '★ 输出被截断（maxOutputChars: 120）', String(res?.text.length));
}

console.log('\n【11】★★ 说得不清楚 → 她**反问一句**（用户：saki 还能反问我给的描述不够清晰）');
{
  ab.__reset();
  const calls = stubRunner();
  const b = botWith();
  ab.__setJudge(async () => ({ action: 'ask', question: '你想给谁看？要几页？' }));
  const msg = [textSeg('帮我做个介绍的东西')];
  const handled = await ab.handle(evOf(OWNER, msg), msg, b);
  check(handled === true, '★ 这条被接管（她要问一句）');
  check(calls.tasks.length === 0, '★★ **没开跑**（先问清再说）');
  check(
    b.sent.some((s) => /你想给谁看/.test(s.text)),
    '★★ 把反问发出来了',
    JSON.stringify(b.sent.map((s) => s.text)),
  );
  check(!b.sent.some((s) => s.text.startsWith('  ')), '★ 反问那条**不带**两个空格（只有"确认开始"才带）');
  check(!!ab.__state().clarify, '★ 记下了"等他补充"');
}

console.log('\n【12】★★ 他补一句 → 两段拼起来直接开工（不再来回问）');
{
  const calls = stubRunner();
  const b = botWith();
  ab.__setJudge(async () => 'task'); // 就算判定又说"任务"，也应该走"补充"这条路
  const msg = [textSeg('给群里那几个人看，五页左右就行')];
  const handled = await ab.handle(evOf(OWNER, msg), msg, b);
  check(handled === true, '★ 接管');
  check(
    b.sent.some((s) => s.text.startsWith('  ')),
    '★★ 这次才发"两个空格开头"的确认',
  );
  await wait(60);
  check(calls.tasks.length === 1, '★ 开跑了', String(calls.tasks.length));
  check(
    calls.tasks[0].includes('帮我做个介绍的东西') && calls.tasks[0].includes('补充：'),
    '★★ 跑的是**原话 + 补充**拼起来的（没丢掉原来那句）',
    calls.tasks[0].slice(0, 60),
  );
  check(ab.__state().clarify === null, '★ 补充用掉了');
}

console.log('\n【13】★★ 「以她自己为主角」这条写进了提示词（不许转述 agent）');
{
  const src = readFileSync(join(ROOT, 'src', 'agent-bridge.js'), 'utf8');
  check(
    /不要转述别人/.test(src) && /agent 报告说/.test(src),
    '★★ 明确禁止转述（「agent 报告说」「工具输出显示」这种）',
  );
  check(/不要小标题、不要 markdown/.test(src), '★★ 禁止小标题和 markdown（报告味就来自它）');
  check(/改了什么 \/ 结果 \/ 没做到的/.test(src), '★★ 点名禁止"改了什么/结果/没做到的"那套报告框架');
  check(/事实必须准/.test(src), '★★ 但事实（成没成、东西在哪）一个字都不许编');
  check(
    /voiceImpl\('result'/.test(src) && /voiceImpl\('progress'/.test(src),
    '★★ 结果和进度**都过她自己的口吻**（不是贴 agent 的原话）',
  );
  check(/onProgress/.test(src), '★ 过程中有一次进度播报（她自己开口说）');
  // ⚠️ 2026-10-13 用户截图追的两条：「不要说任务文件夹里有什么东西」+「不要复制一遍要做的事」
  check(
    /不许交代你翻到了什么/.test(src),
    '★★ 明着禁止交代"翻了什么、目录里有什么、有没有现成底稿"（那两句就是漏在这儿）',
  );
  check(
    /也别提"任务文件夹""工作区""工具""agent"/.test(src),
    '★★ 连"任务文件夹/工作区/工具/agent"这些词都不许出现',
  );
  check(
    /你刚刚动手，这件事还在做/.test(src),
    '★★ 进度那条喂给她的事实只说"你动手了、还没做完"（工作区细节一个都不给）',
  );
  check(
    /voiceImpl\('start'/.test(src) && /你刚刚动手/.test(src),
    '★★ 开工那句也过她自己的口吻，而且是 **start** 这一档（不是复读他的话）',
  );
  check(
    /行，我这就去弄，好了跟你说。/.test(src),
    '★★ 想不出来时退回的是一句**通用**说法（不带他说的话 —— 复读模板已经清掉）',
  );

  // ⚠️⚠️ 2026-10-13 用户截图：「**她自己不就是祥子吗**」—— 她开口说的是
  //    「这就动手**给祥子**写简历」 ⇒ 她把自己当成了第三个人 ✗
  //    （任务原文里写的是"丰川祥子"，而她的提示词里原来只有"你就是客服小祥"，
  //      没告诉她"丰川祥子"就是她自己）
  let vsys = '';
  const vline = await ab.voiceize('start', '你现在开始动手做了。', {
    task: '做一份丰川祥子的简历',
    phrase: async ({ system }) => {
      vsys = String(system ?? '');
      return '行，我这就去写我自己的简历。';
    },
  });
  check(
    /丰川祥子/.test(vsys) && /不许把自己说成第三个人/.test(vsys),
    '★★ 「祥子就是你自己」这条真的进了她说话的提示词',
  );
  check(/Saki/.test(vsys), '★ 连她的自称一起喂了（她说「Saki」）');
  check(/我自己的简历/.test(vline), '★ 注入点也真的接上了（能拿回模型那句话）');
}

console.log('\n【14】★★ 把会话登记进 GUI 的工作区列表（用户：「执行的任务要能显示在这里」）');
{
  // 实测（2026-10-13）：`agenttask` profile 的会话**会落盘**，但**不会自动登记** ——
  //   登记是 GUI 自己在"用户打开/新建会话"时写的 ⇒ 我们从 stdio 驱动它不会触发 ⇒ 自己补一条。
  const home = join(ROOT, 'logs', '__test-agent-dsh');
  rmSync(home, { recursive: true, force: true });
  mkdirSync(join(home, 'storages'), { recursive: true });
  // ⚠️ 故意**带 BOM** 写进去（真实世界会碰到；BOM 会让 `JSON.parse` 直接报错，得吃掉它）
  writeFileSync(
    join(home, 'storages', 'workspace.json'),
    `\uFEFF${JSON.stringify({ global: { initialized: true, workspaceIds: ['old'] }, tables: { workspaces: { old: { path: 'C:\\x', title: '别的', sessionIds: [] } } } })}`,
    'utf8',
  );
  process.env.QQBOT_DSH_HOME = join(ROOT, 'logs', '__test-agent-dsh');
  const ws = join(ROOT, WS_REL);
  const keep = config.agent.workspace;
  config.agent.workspace = ws;
  check(ab.registerSession('session-reg-1') === true, '★ 登记成功');
  check(ab.registerSession('session-reg-1') === true, '★ 重复登记不炸（幂等）');
  const j = JSON.parse(
    readFileSync(join(ROOT, 'logs', '__test-agent-dsh', 'storages', 'workspace.json'), 'utf8').replace(/^\uFEFF/, ''),
  );
  const mine = Object.entries(j.tables.workspaces).find(([, v]) => String(v.path) === ws);
  check(!!mine, '★★ 索引里新建了"这个工作区"那一条');
  check(!!mine && mine[1].sessionIds.filter((x) => x === 'session-reg-1').length === 1, '★★ 会话挂上去了（且只挂一次）');
  check(!!mine && j.global.workspaceIds[0] === mine[0], '★ 也进了 workspaceIds 的头部（列表才排得出来）');
  check(!!mine && mine[1].title === '__test-agent-ws', '★ 标题取的是目录名');
  config.agent.workspace = keep;
  delete process.env.QQBOT_DSH_HOME;
}

console.log('\n【14.5】★★ 会话反查：**"正在跑的活"也要能在任务面板上看对话**');
{
  // ⚠️⚠️ 2026-10-16 加（用户：「**正在跑的能不能也把对话显示出来**」）——
  //    会话 id 是**扫会话目录**扫出来的，而"扫"原来只在子进程**退出之后**才做 ⇒
  //    跑着的那几十分钟里任务历史里是空的 ⇒ 面板点开显示「（这次没有可显示的对话）」✗
  //    ⇒ 现在两条兜底：① 跑着时每 2 秒扫一次（`cliRunner` 里的 `grabSid`）；
  //                    ② 真没有就按「工作区尾巴 + 时间窗」反查（`sessionIdForTask`）✓
  //    这里测 ②（① 要真起一个 dsh 进程，套件里太慢 ✗）
  const home = join(ROOT, 'logs', '__test-agent-dsh-sid');
  rmSync(home, { recursive: true, force: true });
  const uid = '10000002';
  // 工作区目录名就是 DSH 那套编码：非 ASCII 变成 `~XXXX~`，**中文尾段的号原样保留** ✓
  const wsName = '--C-x--agentwork-~79C1~804A-10000002--';
  const sid = 'session-11111111-2222-3333-4444-555555555555';
  mkdirSync(join(home, 'sessions', wsName, sid), { recursive: true });
  writeFileSync(join(home, 'sessions', wsName, sid, 'session.v3.jsonl.zstd'), 'x', 'utf8');
  const keepHome = process.env.QQBOT_DSH_HOME;
  process.env.QQBOT_DSH_HOME = home;
  const at = Date.now();
  const hit = ab.sessionIdForTask({ dir: join(ROOT, WS_REL, '私聊', uid), startedAt: at, endedAt: 0 });
  check(hit === sid, '★★ 按"工作区尾巴 + 时间窗"把会话反查出来了', hit || '（没查到）');
  const other = ab.sessionIdForTask({ dir: join(ROOT, WS_REL, '私聊', '9999999999'), startedAt: at, endedAt: 0 });
  check(other === '', '★ **别的号**的活不会捞到这条会话（认工作区尾巴）', other || '（对的，空的）');
  const old = ab.sessionIdForTask({
    dir: join(ROOT, WS_REL, '私聊', uid),
    startedAt: at - 86400000,
    endedAt: at - 86400000 + 1000,
  });
  check(old === '', '★ 时间对不上的老任务也不乱认（时间窗兜着）', old || '（对的，空的）');
  if (keepHome === undefined) delete process.env.QQBOT_DSH_HOME;
  else process.env.QQBOT_DSH_HOME = keepHome;
}

console.log('\n【15】★★ 做完的**文件**发进群（用户要的是那份产物，不是一句"做好了"）');
{
  ab.__reset();
  ab.__setJudge(async () => 'task');
  const b = botWith();
  b.uploads = [];
  // ⚠️ 桩掉 `call`（真的 `Bot#call` 会去连 OneBot，套件里连不上）
  b.call = async (action, params) => {
    if (action === 'upload_group_file') b.uploads.push({ action, params });
    return { status: 'ok' };
  };
  // 桩：这次"agent"真往任务文件夹里放了几份东西 —— 一份该发、一份该被体积挡住、
  //     一份该被条数挡住（顺序按"像不像成品"排：pptx/xlsx 在前）
  ab.__setRunner((task, hooks) => {
    const d = String(hooks?.taskDir ?? '');
    writeFileSync(join(d, '介绍.pptx'), 'P'.repeat(1024), 'utf8');
    writeFileSync(join(d, '名单.xlsx'), 'X'.repeat(2048), 'utf8');
    writeFileSync(join(d, '脚本.py'), 'print(1)'.repeat(500), 'utf8');
    writeFileSync(join(d, '太大.pdf'), Buffer.alloc(1024 * 1024 * 1.5));
    return {
      promise: Promise.resolve({ code: 0, stdout: '做好了，东西都在工作区那个文件夹里', stderr: '', killed: false }),
      kill: () => {},
    };
  });
  await ab.handle(evOf(OWNER, [textSeg('帮我做一份介绍')]), [textSeg('帮我做一份介绍')], b);
  await wait(80);
  const up = b.uploads.filter((u) => u.action === 'upload_group_file');
  const names = up.map((u) => u.params.name);
  check(up.length === 2, `★★ 产物发进群了（上限 maxFiles=2，实发 ${up.length} 个）`, names.join('、'));
  check(
    names.includes('介绍.pptx') && names.includes('名单.xlsx'),
    '★★ 发的正是那两份"像成品"的（按类型排过序）',
    names.join('、'),
  );
  check(!names.includes('太大.pdf'), '★★ 超 `maxFileMB` 的**不发**（群里传大文件很慢）');
  check(!names.includes('脚本.py'), '★ 超过 `maxFiles` 的也不发');
  check(
    up.every((u) => u.params.file && existsSync(u.params.file)),
    '★ 发的是**绝对路径**（`upload_group_file` 收路径，不是 base64 消息段）',
  );
  check(
    up.every((u) => String(u.params.group_id) === GROUP),
    '★ 发到的是**这个群**（不是别处）',
    JSON.stringify(up.map((u) => u.params.group_id)),
  );
  check(
    // ⚠️ 2026-10-20 改：原来还要求"连在哪个文件夹里一起说清"——
    //    可代码那边明令「不许出现工作区/文件夹/路径」（用户 2026-10-13 定的：
    //    别交代放哪儿，东西直接发到群里了）⇒ 两条互相打架 ✗
    //    ⇒ 只断言**最关键的那点**：没发出去的东西要**点名说**，绝不假装发过 ✓
    b.sent.some((s) => /太大\.pdf/.test(s.text)),
    '★★ 没发出来的那个**明说了一句**（点了名，绝不假装发过）',
    JSON.stringify(b.sent.map((s) => s.text.slice(0, 30))),
  );

  // 没有产物时**一条 upload 都不发**（别拿一个空文件夹去烦人）
  ab.__reset();
  const calls2 = stubRunner();
  const b2 = botWith();
  b2.uploads = [];
  // ⚠️ 2026-10-14 修（加了「她自己决定用电脑」之后这里稳定假红）：
  //    这个桩原来把**任何** `bot.call` 都记进 `uploads` —— 而她的电脑现在起任务时会
  //    调 `get_group_msg_history`（拉群聊记录给她读 ✓）⇒ 那次**根本不是上传**却被记成 upload
  //    ⇒ 断言「没有产物 ⇒ 一次 upload 都没有」就假红 ✗
  //    ⇒ 只记真正的上传（`upload_group_file`）—— 这条断言的本意也正是这个 ✓
  b2.call = async (action, params) => {
    if (action === 'upload_group_file') b2.uploads.push({ action, params });
    return { status: 'ok' };
  };
  await ab.handle(evOf(OWNER, [textSeg('帮我看看这个目录里有什么')]), [textSeg('帮我看看这个目录里有什么')], b2);
  await wait(80);
  check(b2.uploads.length === 0, '★★ 没有产物 ⇒ 一次 upload 都没有（只说一句结果）');
  check(calls2.tasks.length === 1, '★ （这次任务本身照跑）');
}

console.log('\n【16】★★ 「和她有关的可以夹带私货，和她无关的一定不要」');
{
  // ① 判定里**顺手**把"跟她有没有关系"一起判了（同一次调用，不多花钱）
  let sys = '';
  const it = await ab.judgeIntent('帮我做个描述 crychic 的 ppt', {
    phrase: async ({ system }) => {
      sys = String(system ?? '');
      return '任务\n有关';
    },
  });
  check(it.action === 'task' && it.related === true, '★★ 判定带回「这次和她有关」', JSON.stringify(it));
  check(/有关/.test(sys) && /无关/.test(sys), '★★ 判定提示词里写明了要判这一项');
  check(/无关才是常态/.test(sys), '★ 而且明说「无关才是常态」（防它见谁都判有关）');

  const it2 = await ab.judgeIntent('帮我整理一下这个目录', { phrase: async () => '任务\n无关' });
  check(it2.action === 'task' && it2.related === false, '★★ 「整理目录」判成无关');

  // ⚠️⚠️ **只回一行 / 什么都没说明 ⇒ 一律当无关**（宁可不夹带，也不能乱夹带）
  const it3 = await ab.judgeIntent('帮我做个 ppt', { phrase: async () => '任务' });
  check(it3.related === false, '★★ 判定没说明 ⇒ 默认**无关**（保守）');
  const it4 = await ab.judgeIntent('帮我做个 ppt', { phrase: async () => '问：要做几页？\n无关' });
  check(it4.action === 'ask' && it4.related === false, '★ 反问那种也带着这个标记');
  const it5 = await ab.judgeIntent('帮我做个 ppt', { phrase: async () => '问：要讲她自己的事吗' });
  check(it5.related === false, '★★ 第一行反问里带"她"字**不算**有关（只看第二行）');

  // ② 注入块（纯函数，不花钱）
  const no = ab.selfBlock({ related: false });
  check(/和她本人无关/.test(no), '★★ 无关时**明着禁止**夹带（不是"不注入"就算完）', no.slice(0, 30).replace(/\n/g, ' '));
  const yes = ab.selfBlock({
    related: true,
    brief: '她叫丰川祥子',
    aside: '那阵子的事我到现在都没打算原谅谁。',
  });
  check(/和她自己有关/.test(yes), '★★ 有关时给出"夹带私货"的要求');
  check(yes.includes('那阵子的事我到现在都没打算原谅谁。'), '★★ 她本人写的那几句**原样**进提示词');
  check(/一个字都别改/.test(yes), '★ 而且要求原样放进产物里');
  check(/她叫丰川祥子/.test(yes), '★ 顺手给了"她是谁"的简报（不然 agent 写出来的不是她）');

  // ③ 端到端：判定有关 → 提示词带私货（而且是她自己写的那句）；判定无关 → 带禁止
  ab.__reset();
  ab.__setAside(async () => '那几首歌其实挺好听的，别的不说。');
  const got = [];
  ab.__setRunner((task, hooks) => {
    got.push(String(hooks?.selfBlock ?? ''));
    return {
      promise: Promise.resolve({ code: 0, stdout: '做好了', stderr: '', killed: false }),
      kill: () => {},
    };
  });
  ab.__setJudge(async () => ({ action: 'task', related: true }));
  const b = botWith();
  const t1 = '帮我做个描述 crychic 的 ppt';
  await ab.handle(evOf(OWNER, [textSeg(t1)]), [textSeg(t1)], b);
  await wait(60);
  check(got.length === 1 && /和她自己有关/.test(got[0]), '★★ 和她有关的活 ⇒ 提示词里带着"夹带私货"那一段');
  check(got[0].includes('那几首歌其实挺好听的，别的不说。'), '★★ 而且带的是**她自己写的那句**（不是 agent 现编）');

  ab.__reset();
  got.length = 0;
  ab.__setJudge(async () => ({ action: 'task', related: false }));
  const b2 = botWith();
  const t2 = '帮我整理一下这个目录';
  await ab.handle(evOf(OWNER, [textSeg(t2)]), [textSeg(t2)], b2);
  await wait(60);
  check(got.length === 1 && /和她本人无关/.test(got[0]), '★★ 和她无关的活 ⇒ 提示词里明着写"不要夹带"');
  check(got.length === 1 && !/和她自己有关/.test(got[0]), '★★ 而且**没有**那段夹带要求');
  ab.__setAside();
}

console.log('\n【17】★★ 快判别把派活漏掉（@她说「做一个丰川祥子的简历」时真漏过一次）');
{
  check(ab.looksLikeTask('帮我整理一下这个目录') === true, '★ 原来那条「帮我 + 动词」照旧');
  check(ab.looksLikeTask('做一个丰川祥子的简历') === true, '★★ 祈使句开头也算派活 —— 漏判的就是这一句');
  check(ab.looksLikeTask('做一个丰川祥子的简历', { atMe: true }) === true, '★ @了她 + 干活动词也算');
  check(ab.looksLikeTask('这个文件怎么做啊') === false, '★ 普通问句不算（快判别乱开闸）');
  check(ab.looksLikeTask('我今天任务好多啊') === false, '★ 那句老例子照样挡住');

  // 端到端：**就照他当时那句话**再发一遍，必须走任务桥（而不是只聊两句）
  ab.__reset();
  ab.__setJudge(async () => ({ action: 'task', related: true }));
  ab.__setAside(async () => '简历嘛，写清楚就行。');
  const calls = stubRunner();
  const b = botWith();
  const msg = [atSeg(BOT), textSeg('做一个丰川祥子的简历')];
  const handled = await ab.handle(evOf(OWNER, msg), msg, b);
  await wait(60);
  check(handled === true, '★★ 这条被任务桥接管了（不再当闲聊答两句）');
  check(calls.tasks.length === 1, '★★ agent 真开跑了', String(calls.tasks.length));
  check(calls.tasks[0].includes('做一个丰川祥子的简历'), '★ 任务原文原样带下去');
  check(
    b.sent.some((s) => s.text.startsWith('  ')),
    '★ 照旧先回"两个空格开头"的确认',
  );

  // ⚠️⚠️ **第二次漏判**（用户截图：她还是只当闲聊答了两句）：那次事件里是
  //    `at=0 atMe=false 段=text` —— **协议端把 @ 退化成纯文本**，@ 落在正文开头 ✗
  check(
    ab.looksLikeTask('@saki酱saki酱saki酱 做一个丰川祥子的简历') === true,
    '★★ @ 退化成纯文本时也能认出来（先剥掉开头的 @提及再判）',
  );
  check(ab.looksLikeTask('做个梦') === false, '★ 太短的照样挡（连判定模型都不用问）');
  check(
    ab.looksLikeTask('新建一个 probe-test.txt，写一行 hello') === true,
    '★ 「新建…」这种开头也算派活',
  );
  check(ab.looksLikeTask('把这个目录里的 md 汇总一下') === true, '★ 「把…汇总一下」也算');
  check(
    ab.looksLikeTask('做梦呢你') === true,
    '★ 开头是"做"的短句快判会放过 —— **故意的**，判定模型是第二道闸（快判只管省调用）',
  );

  // 端到端：照**真实事件**再发一遍（没有 at 段，@ 就在正文里）→ 必须进任务桥
  ab.__reset();
  ab.__setJudge(async () => ({ action: 'task', related: true }));
  ab.__setAside(async () => '简历嘛，写清楚就行。');
  const calls2 = stubRunner();
  const b2 = botWith();
  const text2 = '@saki酱saki酱saki酱 做一个丰川祥子的简历';
  const msg2 = [textSeg(text2)];
  const h2 = await ab.handle(evOf(OWNER, msg2), msg2, b2);
  await wait(60);
  check(h2 === true, '★★ 文本 @ 的那条也进任务桥了（不再只聊两句）');
  check(calls2.tasks.length === 1, '★★ agent 真开跑了', String(calls2.tasks.length));
  check(
    calls2.tasks[0] === '做一个丰川祥子的简历',
    '★★ 任务原文是**剥掉那个 @ 之后**的（@ 不算内容）',
    calls2.tasks[0],
  );

  // `/任务撤回` 带 @ 前缀也照样认得（同一条"内容用剥过的"规矩）
  ab.__reset();
  const b3 = botWith();
  const m3 = [textSeg('@saki酱saki酱saki酱 /任务撤回')];
  const h3 = await ab.handle(evOf(OWNER, m3), m3, b3);
  check(
    h3 === true && b3.sent.some((s) => /没有在跑/.test(s.text)),
    '★ 带 @ 前缀的 `/任务撤回` 也认得出',
    JSON.stringify(b3.sent.map((s) => s.text)),
  );
  ab.__setAside();
}

console.log('\n【18】★★ 跑法：headless（**有工具、能真动手**），不用那条没有工具的 sdk 路');
{
  const src = readFileSync(join(ROOT, 'src', 'agent-bridge.js'), 'utf8');
  const cfgSrc = readFileSync(join(ROOT, 'src', 'config.js'), 'utf8');
  check(
    /function cliRunner/.test(src) && /let runnerImpl = cliRunner;/.test(src),
    '★★ 干活走的是 headless 那条（`cliRunner`）',
  );
  check(
    /profile: 'headless'/.test(cfgSrc) || /c\.profile \?\? 'headless'/.test(src),
    '★★ 默认 profile = headless（实测：只有这条路的 agent 拿得到工具）',
  );
  check(
    /function pickNewSession/.test(src) && /function sessionDirs/.test(src),
    '★★ 会话 id 从落盘目录里扫回来 —— GUI 里照样看得见（用户要的那条）',
  );
  check(/'--profile', r\.profile, prompt/.test(src), '★★ 任务 + 铁律拼成**一个 argv**（绝不拼 shell）');
  check(
    /progressTimer/.test(src) && /\}, 60000\);/.test(src),
    '★★ 进度那句只在**跑久了**（≥60 秒）才报 —— 开头刚说过"这就去弄"，15 秒再说一遍就是重复',
  );
  check(
    /别把开头那句再重复一遍/.test(src) && /别把刚说过的再重复一遍/.test(src),
    '★★ 而且明着要求她**别重复刚说过的话**（用户：「确认语和她自己的聊天重复了」）',
  );
  check(
    /function sdkJsonRpcRunner/.test(src) && /@deprecated/.test(src),
    '★ 旧的 sdk 入口留着当存档，并且标了"为什么不用它"',
  );
}

console.log('\n【19】★★ 她得知道"自己手上正在做什么"（不然会当场否认）');
{
  ab.__reset();
  check(ab.runningNote() === '', '★ 没有任务在跑 ⇒ 一个字都不加（提示词基线、日常聊天都不受影响）');

  const calls = stubRunner({ autoFinish: false }); // 让它一直跑着
  const b = botWith();
  ab.__setJudge(async () => ({ action: 'task', related: false }));
  const t = '写一份爱音的简历';
  await ab.handle(evOf(OWNER, [textSeg(t)]), [textSeg(t)], b);
  await wait(40);
  const note = ab.runningNote();
  check(
    note.includes(t) && /你手上正在做/.test(note),
    '★★ 任务跑着的时候，聊天提示词里会有「你手上正在做的事」',
    (note.split('\n')[1] ?? '').slice(0, 40),
  );
  check(
    /别否认/.test(note),
    '★★ 而且明说**别否认**（群里那句「谁说要给你写了」就是这么冒出来的）',
  );

  const b2 = botWith();
  await ab.handle(evOf(OWNER, [textSeg('/任务撤回')]), [textSeg('/任务撤回')], b2);
  await wait(40);
  check(ab.runningNote() === '', '★ 任务结束 / 撤回之后又变回空（不残留）');
  void calls;

  const bs = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(/agentBridge\.runningNote\(\)/.test(bs), '★★ 聊天提示词那边**真的调了它**（不然等于没做）');

  // ⚠️⚠️ 2026-10-13 用户：「**掉线之后的补回不要回已经接过任务的话**」——
  //    任务桥接管的那些不进聊天上下文，补看（catchUpMissed）本来不认识它们 ⇒ 她会**又答一遍**
  ab.__reset();
  check(ab.wasHandled('m-没处理过') === false, '★ 没被任务桥接过 ⇒ false（补看照常补）');
  const calls2 = stubRunner();
  const b7 = botWith();
  const ev7 = { ...evOf(OWNER, [textSeg('帮我看看这个目录里有什么')]), message_id: 'm-接过任务的' };
  await ab.handle(ev7, [textSeg('帮我看看这个目录里有什么')], b7);
  await wait(40);
  check(ab.wasHandled('m-接过任务的') === true, '★★ 被任务桥接管的这条被记下来了');
  check(!ab.wasHandled(''), '★ 空 id 不算（别把所有空 id 的旧消息都当成接过的）');
  check(/agentBridge\.wasHandled\(mid\)/.test(bs), '★★ 补看那边**真的照它跳过了**（不然等于没做）');
  void calls2;
}

console.log('\n【20】★★ 活跑着的时候：只有**发起者**能对 agent 插话');
{
  // ① 快筛：闲聊不判（省一次模型调用）
  check(ab.looksLikeInterject('哈哈哈哈') === false, '★★ 普通闲聊不判（省一次模型调用）');
  check(ab.looksLikeInterject('弄好了没') === true, '★ 带"好了没/做完"这类才判');
  check(ab.looksLikeInterject('再多写一页') === true, '★ "再多/再加"也算');
  check(ab.looksLikeInterject('再加一页') === true, '★ "再加"也算');
  check(ab.looksLikeInterject('/任务撤回') === false, '★ 斜杠指令走别的路');
  check(
    ab.looksLikeInterject('随便说点什么', [atSeg(BOT)], { selfId: BOT }) === true,
    '★ @ 了她的、引用了她的也判',
  );

  // ② 判定四种
  check(
    (await ab.judgeInterject('别写了吧', 'x', { phrase: async () => '停' })) === 'stop',
    '★ 叫停 → stop',
  );
  check(
    (await ab.judgeInterject('再加一页', 'x', { phrase: async () => '改' })) === 'change',
    '★ 改要求 → change',
  );
  check((await ab.judgeInterject('好了没', 'x', { phrase: async () => '催' })) === 'ask', '★ 催 → ask');
  check(
    (await ab.judgeInterject('今天天气不错', 'x', { phrase: async () => '无' })) === '',
    '★ 无关 → 空（判定不出来宁可漏）',
  );

  // ③ 发起者说"别写了" ⇒ 真停
  ab.__reset();
  ab.__setJudge(async () => ({ action: 'task', related: false }));
  ab.__setAside(async () => '');
  const calls = stubRunner({ autoFinish: false });
  const b = botWith();
  const t = '写一份爱音的简历';
  await ab.handle(evOf(OWNER, [textSeg(t)]), [textSeg(t)], b);
  await wait(40);
  check(
    calls.tasks.length === 1,
    '★ 先跑起来',
    `实际 ${calls.tasks.length} 次：${JSON.stringify(calls.tasks.map((x) => String(x).slice(0, 24)))}`,
  );
  ab.__setInterject(async () => 'stop');
  const b2 = botWith();
  const m2 = [textSeg('别写了')];
  const h2 = await ab.handle(evOf(OWNER, m2), m2, b2);
  await wait(40);
  check(h2 === true && calls.killed >= 1, '★★ 发起者说「别写了」⇒ 真的停掉', String(calls.killed));
  check(
    b2.sent.some((s) => /停了/.test(s.text) && s.text.startsWith('  ')),
    '★★ 插话让它停 ⇒ 那条也带**两个空格**（用户：「插话成功之后的话开头也要加两个空格」）',
    JSON.stringify(b2.sent.map((s) => s.text.slice(0, 12))),
  );

  // ④ **别人**说"改要求" ⇒ 不动任务（落回去走正常聊天）
  ab.__reset();
  const calls2 = stubRunner({ autoFinish: false });
  const b3 = botWith();
  await ab.handle(evOf(OWNER, [textSeg(t)]), [textSeg(t)], b3);
  await wait(40);
  ab.__setInterject(async () => 'change');
  ab.__setJudge(async () => ''); // 让别人这句话走正常聊天（免得又被判成派活）
  const b4 = botWith();
  const m4 = [textSeg('把我写可爱一点')];
  const h4 = await ab.handle(evOf(OTHER, m4), m4, b4);
  await wait(40);
  check(h4 === false, '★★ 别人说"改要求" ⇒ **不接管**（交回正常聊天）');
  check(calls2.killed === 0 && calls2.tasks.length === 1, '★★ 活照跑、没被搅（kill=0、没重跑）', JSON.stringify({ killed: calls2.killed, runs: calls2.tasks.length }));
  check(!b4.sent.some((s) => s.text.startsWith('  ')), '★ 也没冒出"我去弄"那种确认（没开新任务）');

  // ⑤ ⚠️ 2026-10-13 改：发起者说"改要求" ⇒ **立刻**收掉这轮、带上新要求重跑
  //    （用户：「插话不应该把任务停止了」+「和 ctrl+enter 行为一样」）—— 细节见【26】
  ab.__reset();
  ab.__setAside(async () => '');
  ab.__setJudge(async () => ({ action: 'task', related: false })); // ⚠️ 先还原成"派活"（④ 末尾改成过 ''）
  const calls3 = stubRunner({ autoFinish: false });
  const b5 = botWith();
  await ab.handle(evOf(OWNER, [textSeg(t)]), [textSeg(t)], b5);
  await wait(40);
  check(calls3.tasks.length === 1, '★ 先跑起来（⑤）', String(calls3.tasks.length));
  ab.__setInterject(async () => 'change');
  const b6 = botWith();
  const m6 = [textSeg('再加一页我自己的话')];
  const h6 = await ab.handle(evOf(OWNER, m6), m6, b6);
  await wait(80);
  check(h6 === true && calls3.tasks.length === 2, '★★ 发起者改要求 ⇒ **立刻重跑**', String(calls3.tasks.length));
  check(calls3.killed >= 1, '★★ 旧的那轮被收掉了（但话术里不说"停了"）', String(calls3.killed));
  check(
    !b6.sent.some((s) => /我停了/.test(s.text)),
    '★★ 群里不会出现「行，那个我停了」',
    JSON.stringify(b6.sent.map((s) => s.text.slice(0, 16))),
  );
  ab.__setInterject();
  ab.__reset();

  // ⚠️⚠️ 2026-10-13 用户截图：他 **@Anon** 说「做个你自己的简历」，**saki 抢答了** ✗
  //    根因：任务桥只看"正文剥掉 @ 之后像不像派活"，**没看那个 @ 到底叫谁** ✗
  ab.__reset();
  ab.__setJudge(async () => ({ action: 'task', related: false }));
  const calls9 = stubRunner();
  const b9 = botWith();
  const m9 = [atSeg(OTHER), textSeg('做个你自己的简历')]; // at 段 @ 的是别人
  const h9 = await ab.handle(evOf(OWNER, m9), m9, b9);
  check(h9 === false, '★★ at 段 @ 的是**别人** ⇒ 任务桥一个字都不碰（不抢答、不开工）');
  check(calls9.tasks.length === 0 && b9.sent.length === 0, '★★ 也没跑、也没发任何话', JSON.stringify({ runs: calls9.tasks.length, said: b9.sent.length }));

  const b10 = botWith();
  // ⚠️ 套件里造不出真的同类池（那要群名片 + cast 角色）⇒ 直接把它桩掉
  b10.atTargetsOf = () => [{ uid: OTHER, keys: ['anon', '爱音'] }];
  const m10 = [textSeg('@Anon 做个你自己的简历')]; // 正文形态的 @ 别人
  const h10 = await ab.handle(evOf(OWNER, m10), m10, b10);
  check(h10 === false, '★★ 正文里 @ 的是别人 ⇒ 同样不碰');

  // ⚠️ 但**@ 的是她**（文本形态）时照旧要接 —— 这条是之前修过的，别修回去
  const calls11 = stubRunner();
  const b11 = botWith();
  const t11 = '@saki酱saki酱saki酱 做个你自己的简历';
  const m11 = [textSeg(t11)];
  const h11 = await ab.handle(evOf(OWNER, m11), m11, b11);
  await wait(40);
  check(h11 === true && calls11.tasks.length === 1, '★★ @ 的是她（哪怕退化成纯文本）⇒ 照样开工', String(calls11.tasks.length));
  ab.__reset();
}

console.log('\n【21】★★ 她说的每一句都要进**她自己的上下文**（不然"不知道自己说什么"）');
{
  const src3 = readFileSync(join(ROOT, 'src', 'agent-bridge.js'), 'utf8');
  check(
    /async function taskSay\(/.test(src3) && /recent\.rememberBot\(/.test(src3),
    '★★ 有统一出口 `taskSay`：发完就把话记进上下文',
  );
  check(
    /line\.startsWith\(CONFIRM_PREFIX\) \? line\.slice\(CONFIRM_PREFIX\.length\)/.test(src3),
    '★ 记进上下文时**去掉那两个空格前缀**（前缀是给群里看的标记，不是她的话）',
  );
  // ⚠️ 模块里不许再有"裸发"（除了 taskSay 自己那一处，以及注释里的说明）
  const bare = src3
    .split('\n')
    .filter((l) => /\.sendToGroup\(/.test(l) && !/await bot\.sendToGroup\(gid, line, rest\)/.test(l) && !/^\s*\*/.test(l));
  check(
    bare.length === 0,
    '★★ 模块里**没有裸发**了（每一句都走 taskSay）',
    bare.map((l) => l.trim().slice(0, 44)).join(' | '),
  );

  // ⚠️⚠️ 2026-10-13 用户：「这就这个词出现频率太高了，接受任务和完成的句式也太重复了，
  //    要多样一点，就和日常聊天一样」—— 真因就是提示词里给了句式模板，她照着抄 ✗
  const srcV = readFileSync(join(ROOT, 'src', 'agent-bridge.js'), 'utf8');
  check(!/告诉他你这就去做/.test(srcV), '★★ 提示词里**不再给句式模板**（原来那句"你这就去做"就是「这就」的来源）');
  check(/别老用「这就」/.test(srcV), '★★ 明着点名：**别老用「这就」**');
  check(/说法要活/.test(srcV) && /别每次都用同一个开场/.test(srcV), '★★ 要求每次换开场、换结构');
  check(
    /你刚说过这些/.test(srcV) && /recentItems\?\./.test(srcV),
    '★★ 把她**最近刚说过的几句**贴进去（这一招最管用：那些说法这次不许照抄）',
  );
  check(/voiceImpl\('result', facts, \{ task, gid \}\)/.test(srcV), '★ 说话那层带上了群号（才取得到"最近刚说过的话"）');
  // ⚠️ 2026-10-13 用户：「直接把 喏 这个语气词禁用吧」+「不够活人感」
  check(/不许用「喏」/.test(srcV), '★★ 「喏」被点名禁用（他说得太频繁了）');
  check(
    /别把东西一样样念出来/.test(srcV) && /最多两句、四十字上下/.test(srcV),
    '★★ 禁掉"顿号串成的清单"（那是说明书）+ 限长两句（原话：不够活人感）',
  );

  // ⚠️ 2026-10-13 用户截图：「就在「2026-10-13 2220 做个你自己的简历」里，叫丰川祥子-简历.md」
  //    ⇒「这一段说在哪里的也不要写出来」—— 喂给她之前先把路径抹掉（提示词里也明令禁止）✓
  check(
    /（任务文件夹）/.test(ab.hidePaths('做好了，在 C:\\x\\agentwork\\2026-10-13 2220 做个你自己的简历 里', 'C:\\x\\agentwork\\2026-10-13 2220 做个你自己的简历')),
    '★★ 任务文件夹的路径 / 文件夹名会被抹掉（她说不出"就在「…」文件夹里"）',
  );
  check(!/C:\\/.test(ab.hidePaths('文件在 C:\\a\\b\\c.md', '')), '★ 其它盘符路径也一起抹掉');
  check(
    /不要交代东西放在哪个文件夹/.test(src3),
    '★★ 提示词里也明着禁止提文件夹 / 路径',
  );
}

console.log('\n【22】★★ 群文件：自动建一个文件夹，只往它里面传（名字用她在群里的昵称）');
{
  ab.__reset();
  // ⚠️ 名字：留空 = 用她在那个群的昵称（用户要求）；昵称拿不到就退回人设显示名 ✓
  const keepFolder = config.agent.groupFolder;
  config.agent.groupFolder = '';
  const b0 = botWith();
  b0.call = async (action) => {
    if (action === 'get_group_root_files') return { folders: [] };
    if (action === 'create_group_file_folder') return { groupItem: { folderInfo: { folderId: 'FIDSELF' } } };
    return { status: 'ok' };
  };
  let madeName = '';
  const b0b = botWith();
  b0b.call = async (action, params) => {
    if (action === 'get_group_root_files') return { folders: [] };
    if (action === 'create_group_file_folder') {
      madeName = String(params.name ?? '');
      return { groupItem: { folderInfo: { folderId: 'FIDSELF' } } };
    }
    return { status: 'ok' };
  };
  const sid = await ab.ensureGroupFolder(b0b, GROUP);
  check(sid === 'FIDSELF' && !!madeName, '★★ 留空时用**她自己的群昵称**当文件夹名', madeName || '（名字空了）');
  void b0;
  config.agent.groupFolder = '机器人产物';
  ab.__reset();

  const calls = [];
  let created = 0;
  const b = botWith();
  b.call = async (action, params) => {
    calls.push({ action, params });
    if (action === 'get_group_root_files')
      return { folders: created ? [{ folder_id: 'FID1', folder_name: '机器人产物' }] : [] };
    if (action === 'create_group_file_folder') {
      created++;
      return { groupItem: { folderInfo: { folderId: 'FID1', folderName: params.name } } };
    }
    return { status: 'ok' };
  };
  const id = await ab.ensureGroupFolder(b, GROUP);
  check(id === 'FID1', '★★ 根目录没有 ⇒ 先建一个，拿到 folder_id', id || '（没拿到）');
  check(
    calls.filter((c) => c.action === 'create_group_file_folder').length === 1,
    '★ 只建一次',
    JSON.stringify(calls.map((c) => c.action)),
  );
  const id2 = await ab.ensureGroupFolder(b, GROUP);
  check(
    id2 === 'FID1' && calls.filter((c) => c.action === 'get_group_root_files').length === 1,
    '★★ 第二次走缓存（不再去列一遍目录）',
  );

  // 上传时带上 folder_id
  ab.__reset(); // ⚠️ 清掉上面那份缓存，不然拿到的还是 FID1
  const d = ab.taskDirFor('发个东西测试', GROUP);
  // ⚠️ 2026-10-21 加（用户：「**不同群不应该不是同一个 agent 文件夹吗**」）——
  //    任务目录按群隔离：同样的活名、两个群 ⇒ 两个目录，绝不共用 ✓
  {
    const dA = ab.taskDirFor('同名任务隔离', '999000001');
    const dB = ab.taskDirFor('同名任务隔离', '999000002');
    check(
      dA !== dB && dA.includes('999000001') && dB.includes('999000002'),
      '★★ A/B 群的任务目录各归各的（同一个活名也不共用）',
      `${dA} | ${dB}`,
    );
  }
  writeFileSync(join(d, '报告.md'), 'x'.repeat(20), 'utf8');
  const up = [];
  const b2 = botWith();
  b2.call = async (action, params) => {
    up.push({ action, params });
    if (action === 'get_group_root_files') return { folders: [{ folder_id: 'FID9', folder_name: '机器人产物' }] };
    return { status: 'ok' };
  };
  await ab.sendArtifacts(b2, GROUP, d);
  const u = up.find((x) => x.action === 'upload_group_file');
  check(
    !!u && u.params.folder_id === 'FID9',
    '★★ 上传带上了 folder_id（只往那个文件夹里传）',
    JSON.stringify(u?.params ?? {}),
  );
  // ⚠️ 传进文件夹失败时**退回根目录**（别因为文件夹把文件弄丢）
  ab.__reset();
  const up2 = [];
  const b3 = botWith();
  let firstUpload = true;
  b3.call = async (action, params) => {
    up2.push({ action, params });
    if (action === 'get_group_root_files') return { folders: [{ folder_id: 'FID9', folder_name: '机器人产物' }] };
    if (action === 'upload_group_file' && firstUpload && params.folder_id) {
      firstUpload = false;
      throw new Error('文件夹传不进去');
    }
    return { status: 'ok' };
  };
  await ab.sendArtifacts(b3, GROUP, d);
  const ups = up2.filter((x) => x.action === 'upload_group_file');
  check(
    ups.length === 2 && !!ups[0].params.folder_id && !ups[1].params.folder_id,
    '★★ 传进文件夹失败 ⇒ **退回根目录再传一次**（文件不会被弄丢）',
    JSON.stringify(ups.map((x) => !!x.params.folder_id)),
  );
  rmSync(d, { recursive: true, force: true });
  config.agent.groupFolder = keepFolder;
  ab.__reset();
}

console.log('\n【23】★★ 必须 @ 她才能接任务（用户：「接任务还是要严格一点」）');
{
  const keep = config.agent.requireAt;
  config.agent.requireAt = true; // 套件默认关着，这一段自己打开
  ab.__reset();
  ab.__setJudge(async () => ({ action: 'task', related: false }));
  ab.__setAside(async () => '');
  const calls = stubRunner();
  const b = botWith();
  const taskText = '帮我把这个存档整理一下';

  // ① 没 @ 她 ⇒ 不接（哪怕句子像派活）
  const m1 = [textSeg(taskText)];
  const h1 = await ab.handle(evOf(OWNER, m1), m1, b);
  check(h1 === false, '★★ 没 @ 她 ⇒ **不接**（哪怕句子明显像派活）');
  check(calls.tasks.length === 0 && b.sent.length === 0, '★★ 也不开工、也没回任何话', JSON.stringify({ runs: calls.tasks.length, said: b.sent.length }));

  // ② @ 了她 ⇒ 照常接
  const m2 = [atSeg(BOT), textSeg(taskText)];
  const b2 = botWith();
  const h2 = await ab.handle(evOf(OWNER, m2), m2, b2);
  await wait(40);
  check(h2 === true && calls.tasks.length === 1, '★★ @ 了她 ⇒ 照常接', String(calls.tasks.length));

  // ③ 引用她那条消息 ⇒ 也算（那本来就是冲她说的）
  ab.__reset();
  const calls3 = stubRunner();
  const b3 = botWith();
  const m3 = [{ type: 'reply', data: { id: '1' } }, textSeg(taskText)];
  const h3 = await ab.handle(evOf(OWNER, m3), m3, b3);
  await wait(40);
  check(h3 === true && calls3.tasks.length === 1, '★ 引用她那条 ⇒ 也算在跟她说话', String(calls3.tasks.length));

  // ④ `/任务撤回` 不带 @ 也照旧管用（例外）
  ab.__reset();
  const b4 = botWith();
  const m4 = [textSeg('/任务撤回')];
  const h4 = await ab.handle(evOf(OWNER, m4), m4, b4);
  check(h4 === true && b4.sent.some((s) => /没有在跑/.test(s.text)), '★ 斜杠指令不受影响');

  // ⑤ ⚠️ 僵尸状态：新进程启动时不该还挂着上个进程的"正在跑"
  const s5 = readFileSync(join(ROOT, 'src', 'agent-bridge.js'), 'utf8');
  check(
    /启动时发现上个进程留下的"正在跑"/.test(s5),
    '★★ 启动时会把上个进程留下的 running 清掉（不然之后所有派活都被"手上这个还没弄完"挡）',
  );

  config.agent.requireAt = keep;
  ab.__reset();
}

console.log('\n【24】★★ 前一个没搞完也能直接开新任务（自动停掉旧的）');
{
  ab.__reset();
  ab.__setJudge(async () => ({ action: 'task', related: false }));
  ab.__setAside(async () => '');
  const calls = stubRunner({ autoFinish: false }); // 旧的跑个不停
  const b = botWith();
  const m1 = [atSeg(BOT), textSeg('帮我做第一件事')];
  await ab.handle(evOf(OWNER, m1), m1, b);
  await wait(40);
  check(calls.tasks.length === 1, '★ 第一件跑起来了（一直跑不完）');

  const b2 = botWith();
  const m2 = [atSeg(BOT), textSeg('帮我做第二件事')];
  const h2 = await ab.handle(evOf(OWNER, m2), m2, b2);
  await wait(60);
  check(h2 === true, '★★ 新任务**不被挡**（原来会回"手上这个还没弄完"）');
  check(calls.killed >= 1, '★★ 旧的被自动停掉了', String(calls.killed));
  check(calls.tasks.length === 2, '★★ 新的真开跑了', String(calls.tasks.length));
  check(
    !b2.sent.some((s) => /还没弄完/.test(s.text)),
    '★★ 不再出现"手上这个还没弄完，等会儿再说"',
    JSON.stringify(b2.sent.map((s) => s.text.slice(0, 14))),
  );
  check(
    b2.sent.some((s) => /先放一放/.test(s.text) && s.text.startsWith('  ')),
    '★ 那句提示带两个空格（任务动作，群里能分辨）',
  );
  ab.__reset();
}

console.log('\n【25】★★ 活分段 + 缺信息就让她问（用户：「多分几段工作，多问一下任务细节」）');
{
  // ① 解析 agent 留的那两行
  const p1 = ab.parseAgentTail('做好了第一段\n\n【下一段】把剩下三页补上');
  check(p1.next.includes('剩下三页') && !p1.clean.includes('下一段'), '★★ 抠出【下一段】，并从"给她说的话"里去掉', JSON.stringify(p1));
  const p2 = ab.parseAgentTail('我删了一部分\n【要问】这个表格要 xlsx 还是 md？');
  check(p2.ask.includes('xlsx') && !p2.clean.includes('【要问】'), '★★ 抠出【要问】');
  const p3 = ab.parseAgentTail('干完了');
  check(!p3.next && !p3.ask && p3.clean === '干完了', '★ 没有标记就原样不动');

  const src = readFileSync(join(ROOT, 'src', 'agent-bridge.js'), 'utf8');
  check(/SECTION_RULES/.test(src) && /【下一段】/.test(src) && /【要问】/.test(src), '★★ 这两条规矩真的拼进了提示词');
  check(/别硬扛一个大活/.test(src) && /别猜/.test(src), '★★ 明说"分段"和"缺信息不许猜"');

  // ② 端到端：agent 报"要问" ⇒ 她用自己话问 + 挂起等他答
  ab.__reset();
  ab.__setJudge(async () => ({ action: 'task', related: false }));
  ab.__setAside(async () => '');
  const asks = [];
  ab.__setRunner(() => ({
    promise: Promise.resolve({
      code: 0,
      stdout: '我先弄了一半\n【要问】这个表要 xlsx 还是 md？',
      stderr: '',
      killed: false,
      sessionId: '',
    }),
    kill: () => {},
  }));
  ab.__setVoice(async (kind, facts) => {
    asks.push({ kind, facts: String(facts) });
    return kind === 'clarify' ? '你那个表要 xlsx 还是 md 啊？' : String(facts);
  });
  const b = botWith();
  const m = [atSeg(BOT), textSeg('做个表格')];
  await ab.handle(evOf(OWNER, m), m, b);
  await wait(60);
  check(asks.some((x) => x.kind === 'clarify' && x.facts.includes('xlsx')), '★★ agent 说"要问" ⇒ 先过她自己的口吻');
  check(
    b.sent.some((s) => /xlsx/.test(s.text) && s.text.startsWith('  ')),
    '★★ 那句问话带两个空格发出来了',
    JSON.stringify(b.sent.map((s) => s.text.slice(0, 18))),
  );
  check(!!ab.__state().clarify, '★★ 挂起等他回话（他下一句就是"补充"）');

  // ③ 端到端：agent 报"还有下一段" ⇒ 记住；他说「继续」⇒ 接着做
  ab.__reset();
  const runs = [];
  ab.__setRunner((task, hooks) => {
    runs.push({ task: String(task), dir: String(hooks?.taskDir ?? '') });
    return {
      promise: Promise.resolve({
        code: 0,
        stdout: runs.length === 1 ? '第一段好了\n【下一段】把剩下的补上' : '全好了',
        stderr: '',
        killed: false,
      }),
      kill: () => {},
    };
  });
  ab.__setVoice(async (kind, facts) => String(facts ?? ''));
  const b2 = botWith();
  const m2 = [atSeg(BOT), textSeg('做个大活')];
  await ab.handle(evOf(OWNER, m2), m2, b2);
  await wait(60);
  check(
    runs.length === 1 && !!ab.__state().continues?.[GROUP],
    '★★ 「还有下一段」被记下来了',
    JSON.stringify(Object.keys(ab.__state().continues ?? {})),
  );
  const b3 = botWith();
  const m3 = [textSeg('继续')];
  const h3 = await ab.handle(evOf(OWNER, m3), m3, b3);
  await wait(60);
  check(h3 === true && runs.length === 2, '★★ 他说「继续」⇒ 接着做下一段（不用把整个活重说一遍）', String(runs.length));
  check(
    String(runs[1]?.task ?? '').includes('接着做：') && String(runs[1]?.task ?? '').includes('做个大活'),
    '★★ 新任务 = 原任务 + 接着做的内容',
    String(runs[1]?.task ?? '').slice(0, 46),
  );
  check(runs[1].dir === runs[0].dir, '★★ 复用同一个任务文件夹（产物不散）');
  ab.__reset();
}

console.log('\n【26】★★ 插话 = 立刻带上新要求接着做（且绝不说"我停了"）');
{
  ab.__reset();
  ab.__setJudge(async () => ({ action: 'task', related: false }));
  ab.__setAside(async () => '');
  ab.__setVoice(async (kind, facts) => (kind === 'progress' ? '行，我加上。' : String(facts)));
  const runs = [];
  let killer = null;
  ab.__setRunner((task, hooks) => {
    runs.push({ task: String(task), dir: String(hooks?.taskDir ?? '') });
    // ⚠️ 产物要在"agent 还在跑的时候"写出来 —— 它收尾时才会去扫任务文件夹 ✓
    // ⚠️ 2026-10-20：**必须写进 `产物/` 子目录**（用户：「刚才做动画，又发了散文件出来」）——
    //    新规矩是"位置即意图"：`产物/` 里的才算她声明要交的成品；
    //    写根目录的脚本/音频会被当"她自己干活的工具"跳过 ✓
    try {
      if (hooks?.taskDir) {
        const od = join(String(hooks.taskDir), '产物');
        mkdirSync(od, { recursive: true });
        writeFileSync(join(od, 'x.py'), 'print(1)\n', 'utf8');
      }
    } catch {}
    return {
      // ⚠️ 第一轮**必须一直挂着**（不然插话时"手上没活"，根本走不到插话那条路 ✗）；
      //    被 kill 时才 resolve（模拟"收掉这轮"）
      promise:
        runs.length === 1
          ? new Promise((r) => {
              killer = () => r({ code: 0, stdout: '第一版做好了', stderr: '', killed: true });
            })
          : Promise.resolve({ code: 0, stdout: '红囍字也加上了', stderr: '', killed: false }),
      kill: () => killer?.(),
    };
  });
  const b = botWith();
  const m1 = [atSeg(BOT), textSeg('做个喜庆的界面')];
  await ab.handle(evOf(OWNER, m1), m1, b);
  await wait(30);
  check(runs.length === 1, '★ 先跑起来');

  ab.__setInterject(async () => 'change');
  const b2 = botWith();
  const m2 = [atSeg(BOT), textSeg('再加个红囍字')];
  const h2 = await ab.handle(evOf(OWNER, m2), m2, b2);
  await wait(140);
  check(h2 === true, '★ 插话被接管');
  check(
    !b2.sent.some((s) => /我停了/.test(s.text)),
    '★★ **绝不出现「行，那个我停了」**（用户明确不要这个）',
    JSON.stringify(b2.sent.map((s) => s.text.slice(0, 16))),
  );
  check(
    b2.sent.some((s) => s.text.startsWith('  ') && /加上/.test(s.text)),
    '★★ 回的是「行，我加上」（带两个空格）',
    JSON.stringify(b2.sent.map((s) => s.text.slice(0, 16))),
  );
  check(runs.length === 2, '★★ **立刻**重跑了（不是等这轮跑完）', String(runs.length));
  check(
    String(runs[1]?.task ?? '').includes('做个喜庆的界面') && String(runs[1]?.task ?? '').includes('追加：'),
    '★★ 新的那轮 = 原任务 + 追加的要求',
    String(runs[1]?.task ?? '').slice(0, 40),
  );
  check(runs[1].dir === runs[0].dir, '★★ 复用同一个任务文件夹（产出的东西不散）');
  ab.__setVoice(async (kind, facts) => String(facts ?? ''));
  ab.__reset();
}

console.log('\n【27】★★ 她答不上来时，把问题转给 agent 再问一遍（模型判定）');
{
  ab.__reset();
  ab.__setJudge(async () => ({ action: 'task', related: false })); // ⚠️ 第一轮"做个脚本"得能开跑
  ab.__setAside(async () => '');
  ab.__setVoice(async (k, f) => String(f ?? ''));
  const runs = [];
  ab.__setRunner((task, hooks) => {
    const td = String(hooks?.taskDir ?? '');
    // ⚠️ 2026-10-21：真往 `产物/` 放一份东西 —— 追问判定的"活简介"要靠它认出"这个活做出了 x.py"✓
    //    （位置即意图：`产物/` 里的才是成品，见 `collectArtifacts`）
    try {
      mkdirSync(join(td, '产物'), { recursive: true });
      writeFileSync(join(td, '产物', 'x.py'), 'print(1)', 'utf8');
    } catch {}
    runs.push({ task: String(task), dir: td });
    return {
      promise: Promise.resolve({
        code: 0,
        stdout: runs.length === 1 ? '做好了：x.py，十页' : 'x.py 是跑数据用的，装了 Python 直接 python x.py',
        stderr: '',
        killed: false,
      }),
      kill: () => {},
    };
  });

  // 先真做完一个活（这样才进任务历史）
  const b1 = botWith();
  const m1 = [atSeg(BOT), textSeg('帮我做个 x 的脚本')];
  await ab.handle(evOf(OWNER, m1), m1, b1);
  await wait(80);
  check(runs.length === 1, '★ 先做完一个活');
  check(!!ab.recentDoneTask(), '★ 任务历史里能取到"刚做完的那个"');
  // ⚠️ 2026-10-21 加（用户：「**给模型的还要有之前任务的简介，才能判定到底是在追问什么**」）——
  //    追问判定不许只看到"活的名字"，要看到**这个活做出了什么**
  check(
    /x\.py/.test(ab.taskBriefFor(ab.recentDoneTask().dir, '帮我做个 x 的脚本')),
    '★★ 追问判定的"活简介"里带上了产物名（模型才判得出在问哪件事）',
    ab.taskBriefFor(ab.recentDoneTask().dir, '帮我做个 x 的脚本'),
  );
  check(
    /x\.py/.test(ab.recentDoneNote()),
    '★★ 她的聊天上下文里会带上"最近做完的活 + 产物名"',
    ab.recentDoneNote().split('\n').slice(-1)[0],
  );

  // 他问那个 py 怎么用 ⇒ 模型判定说"问" ⇒ 转给 agent 再问一遍
  ab.__setJudge(async () => ''); // 这句是"问问题"，不是派活
  ab.__setAskAgent(async () => ({ action: 'ask', question: '这个 py 文件怎么用' }));
  const b2 = botWith();
  const m2 = [atSeg(BOT), textSeg('这个 py 文件怎么用')];
  const h2 = await ab.handle(evOf(OWNER, m2), m2, b2);
  await wait(120);
  check(h2 === true, '★★ 这句被接管（转去问 agent）');
  check(runs.length === 2, '★★ **又跑了一轮 agent**', String(runs.length));
  check(runs[1].dir === runs[0].dir, '★★ 复用同一个任务文件夹');
  check(
    String(runs[1]?.task ?? '').includes('追问') && String(runs[1]?.task ?? '').includes('别把整个活重做'),
    '★★ 提示词里明说「只回答这个追问、别重做」',
    String(runs[1]?.task ?? '').slice(0, 56),
  );
  check(
    !b2.sent.some((s) => /哪个 py/.test(s.text)),
    '★★ 不会再反问「哪个 py」（原现场就是这句）',
    JSON.stringify(b2.sent.map((s) => s.text.slice(0, 16))),
  );

  // ⚠️ 判定说"不是" ⇒ 不碰（交回正常聊天）
  ab.__reset();
  ab.__setRunner(() => ({ promise: Promise.resolve({ code: 0, stdout: 'ok', stderr: '', killed: false }), kill: () => {} }));
  const b3 = botWith();
  const m3 = [atSeg(BOT), textSeg('帮我做个 y 的脚本')];
  await ab.handle(evOf(OWNER, m3), m3, b3);
  await wait(60);
  ab.__setAskAgent(async () => ({ action: '', question: '' }));
  const b4 = botWith();
  const m4 = [atSeg(BOT), textSeg('今天天气不错')];
  const h4 = await ab.handle(evOf(OWNER, m4), m4, b4);
  check(h4 === false, '★★ 判定说"不是" ⇒ **不接管**（交回正常聊天）');
  ab.__setAskAgent();
  ab.__reset();
}

console.log(
  '\n【28】★★ 长窗口的"活台账"（用户截图：他问「继续完善昨天的 PPT」，她答「我这边没留底诶」）',
);
{
  // 真因：`recentDoneNote()` 只看**最近 6 小时** ⇒ 昨天做的活早出窗口，
  //   她的上下文里一个字都没有 ⇒ 只能说"没留底"✗
  //   （实测那条记录就在台账里：10-13 15:50「做一个爱音和素世结婚用的PPT」✓）
  // ⇒ 新增 `taskLedgerNote()`：把**6 小时以外**、10 天以内的活列成一张短表。
  ab.__reset();
  ab.__setJudge(async () => ({ action: 'task', related: false }));
  ab.__setAside(async () => '');
  ab.__setVoice(async (k, f) => String(f ?? ''));
  ab.__setRunner(() => ({
    promise: Promise.resolve({ code: 0, stdout: '做好了：婚礼.pptx', stderr: '', killed: false }),
    kill: () => {},
  }));
  const b = botWith();
  const m = [atSeg(BOT), textSeg('做一个爱音和素世结婚用的PPT')];
  await ab.handle(evOf(OWNER, m), m, b);
  await wait(80);

  // ① 刚做完的：由 `recentDoneNote` 负责，台账里**不该**再说一遍
  check(!!ab.recentDoneTask(), '★ 先真做完一个活（进任务历史）');
  check(
    !ab.taskLedgerNote().includes('结婚'),
    '★★ 刚做完（6 小时内）的活**不进**台账 —— 两条分工不重叠、同一件事不说两遍',
  );

  // ② 把"现在"往后推一天 ⇒ 同一条活落进台账（这就是"昨天的 PPT"能接上的原因）
  const tmr = ab.taskLedgerNote({ now: Date.now() + 24 * 3600 * 1000 });
  check(tmr.includes('结婚'), '★★ 一天前做完的活 → **台账里有**（她再也不会说"我这边没留底"）');
  // ⚠️ 这条**不能**断言产物名：套件里的 runner 是 stub，**根本没真写文件** ⇒
  //    `collectArtifacts()` 自然是空的（真实跑时产物名会进台账 ✓ 比如线上台账里那句
  //    「做一个爱音和素世结婚用的PPT → 爱音素世婚礼.pptx」）。
  //    改成断言**文件夹名里带着那次的原话关键词** —— 她照着就能指认是哪一份 ✓
  check(/（文件夹：[^）]*结婚/.test(tmr), '★★ 文件夹名里带着那次的原话关键词（够她指认是哪一份了）');
  check(/文件夹/.test(tmr), '★★ 连产物**文件夹名**一起给（要"接着弄"时知道在哪儿）');
  check(/没留底|发来看看/.test(tmr), '★★ 明着禁止她说"我没留底 / 你说哪份 / 发来看看"');

  // ③ 窗口之外（默认 10 天）⇒ 不再列（提示词不能无限长）
  check(
    !ab.taskLedgerNote({ now: Date.now() + 40 * 24 * 3600 * 1000 }).includes('结婚'),
    '★ 超出窗口（默认 10 天）的不再列',
  );

  // ④ 上限：只列最近 `max` 条
  const one = ab.taskLedgerNote({ now: Date.now() + 24 * 3600 * 1000, max: 1 });
  check(one.split('\n').filter((l) => l.startsWith('· ')).length === 1, '★ max 生效（最多几条）');

  ab.__setRunner();
  ab.__reset();
}

console.log(
  '\n【29】★★★ 她自己决定要不要动电脑（用户：「直接把 agent 设定为 **saki 自己的电脑**，' +
    '由她自己决定什么时候该用电脑」）',
);
{
  // 判据：有人跟她说话、而这句话"光靠聊天答不好、得动那台电脑" ⇒ **她自己上手** ✓
  //   ⚠️ 这一路**不带两个空格** —— 那个前缀是"他派活、我确认"的标记，这里是她自己决定 ✓
  ab.__reset();
  ab.__setJudge(async () => ''); // 不是派活（派活那条路各走各的 ✓）
  ab.__setAside(async () => '');
  ab.__setVoice(async (k, f) => String(f ?? ''));
  const runs = [];
  ab.__setRunner((task, hooks) => {
    runs.push({ task: String(task), dir: String(hooks?.taskDir ?? '') });
    return { promise: Promise.resolve({ code: 0, stdout: 'ok', stderr: '', killed: false }), kill: () => {} };
  });

  // ① 判定说"要动电脑" ⇒ 她自己上手
  ab.__setSelfUse(async () => ({ action: 'use', plan: '翻一下我昨天做的那个 PPT 还在不在' }));
  const b1 = botWith();
  const m1 = [atSeg(BOT), textSeg('昨天那个 PPT 你还留着吗')];
  const h1 = await ab.handle(evOf(OWNER, m1), m1, b1);
  await wait(80);
  check(h1 === true, '★★ 这句被接管（她自己决定动电脑）');
  check(runs.length === 1, '★★ **真的起了一次 agent**', String(runs.length));
  check(
    /昨天|翻一下/.test(String(runs[0]?.task ?? '')),
    '★★ 交给 agent 的是「她打算干什么」',
    String(runs[0]?.task ?? '').slice(0, 36),
  );
  check(
    b1.sent.length > 0 && !String(b1.sent[0]?.text ?? '').startsWith('  '),
    '★★ 她说那句**不带两个空格**（那是"他派活"的标记；这次是她自己动手）',
    JSON.stringify(String(b1.sent[0]?.text ?? '').slice(0, 20)),
  );

  // ② 判定说"不用" ⇒ 一个字都不动（交回正常聊天）
  ab.__reset();
  ab.__setSelfUse(async () => ({ action: '', plan: '' }));
  const b2 = botWith();
  const m2 = [atSeg(BOT), textSeg('今天过得怎么样')];
  const h2 = await ab.handle(evOf(OWNER, m2), m2, b2);
  check(h2 === false, '★★ 判定说"不用" ⇒ 不接管（交回正常聊天）');
  check(runs.length === 1, '★★ 而且**没有再起 agent**', String(runs.length));

  // ③ **明确派活那条路不受它管** —— 照旧走「要 @ 她 + 要确认」那套（规矩一个字不改）
  ab.__reset();
  ab.__setJudge(async () => ({ action: 'task', related: false }));
  ab.__setSelfUse(async () => ({ action: 'use', plan: '不该走到这里' }));
  const b3 = botWith();
  const m3 = [atSeg(BOT), textSeg('帮我做个 PPT')];
  await ab.handle(evOf(OWNER, m3), m3, b3);
  await wait(60);
  check(
    b3.sent.some((s) => String(s.text ?? '').startsWith('  ')),
    '★★ 派活那条路照旧带两个空格（"他派活"的规矩没被这条新路改掉）',
  );
  check(runs.length === 2, '★ 派活也照样起了 agent', String(runs.length));

  ab.__setSelfUse();
  ab.__setJudge();
  ab.__setRunner();
  ab.__reset();
}

console.log(
  '\n【30】★★★ 发进群的话不许提「位置 / 电脑」' +
    '（用户：「我不需要文件在哪里，因为我自己找得到，别人就更不需要了，因为电脑不是他的」）',
);
{
  const f = ab.desensitizeForGroup;
  check(typeof f === 'function', '有这道「去位置化」的口子（它挂在唯一出口 taskSay 上）');
  check(!/工作区/.test(f('东西都在工作区的那个文件夹里')), '「工作区 / 文件夹」被抹掉');
  check(!/C:\\/.test(f('放在 C:\\Users\\<主人>\\OneDrive\\x 里')), '绝对路径被抹掉');
  check(!/文件夹/.test(f('还有两个没发出来（进群文件夹 /abc-123）')), '「（进群文件夹 xxx）」整段抹掉');
  check(!/电脑/.test(f('我电脑上存着呢')), '「电脑」也换成人话');
  check(!/[（(]\s*[）)]/.test(f('这些都没发出来（文件夹 abc）')), '抹完不留空括号');
  // ⚠️ 正常的话必须**原样**活下来（这道口子只去位置，不改内容）
  const keeps = '弄好了，配图我画了两张，先看着别嫌土';
  check(f(keeps) === keeps, '正常的话一个字不动', JSON.stringify(f(keeps)));
  check(f('行，那个我停了（').startsWith('行，那个我停了'), '她的话照旧（只去位置，不改语义）');
}

console.log(
  '\n【31】★★★ 重启不要断掉正在跑的活（用户：「以后重启不要断掉之前的任务，要自动恢复」）',
);
{
  const src = readFileSync(join(ROOT, 'src', 'agent-bridge.js'), 'utf8');
  check(typeof ab.resumePending === 'function', '导出了 resumePending（由 bot 连上之后调）');
  check(
    /state\.resume = \{ \.\.\.state\.running, resumeAt: Date\.now\(\) \}/.test(src),
    '★★ 启动时不再**直接清掉**"正在跑"，而是记进 state.resume',
  );
  check(
    /resumePending/.test(readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8')),
    '★★ bot 连上之后会去调它（不然记下来也没人接着做）',
  );
  // ⚠️ 行为级：真的"接着做"这件事由**下次真重启**验证（套件里没法重启进程）——
  //    这里只把三条接线钉住，别让谁哪天把它删了 ✓
  check(
    /reuseDir: String\(r\.dir \?\? ''\)/.test(src),
    '★★ 恢复时复用**同一个任务文件夹**（它先读 这个活的对话.md 就知道上一轮做到哪儿）',
  );

  ab.__reset();
}

console.log('\n【32】★★★ 快判别把「帮我找点图 / 搜点东西」漏掉（真实漏判一次）');
{
  // 现场：他 @她 说「帮我找点爱祥的图发过来」—— 词表里没有"找/搜" ⇒ 快判说"不是派活"
  //   ⇒ 任务桥不接 ⇒ 她**自己用生图画了一张**（群里那句「行行行，我画。就这一张啊」）✗
  const T = (t, atMe = true) => ab.looksLikeTask(t, { atMe });
  check(T('帮我找点爱祥的图发过来') === true, '★★ 「帮我找点爱祥的图发过来」→ 像派活（原来漏）');
  check(T('搜一下今年的赛程') === true, '★ 「搜一下…」→ 像派活');
  check(T('把配图换成网上的') === true, '★ 「换配图」→ 像派活');
  check(T('帮我挑一张好看的封面') === true, '★ 「帮我挑…」→ 像派活');
  check(T('下载一份官方立绘') === true, '★ 「下载…」→ 像派活');
  // ⚠️ 放宽不等于乱接：**模型判定**还在后面兜着（这里只验快判不把它放进来的那些）
  check(T('今天天气不错') === false, '★ 纯闲聊 → 不像（照旧别接）');
  check(T('我这两天在改论文', false) === false, '★ 没 @ 她 + 说的是他自己 → 不像');
}

console.log('\n【33】★★ 群里必须 @ 她 + 群聊记录只是背景（2026-10-15 两次真实事故）');
{
  const src33 = readFileSync(join(ROOT, 'src', 'agent-bridge.js'), 'utf8');
  // ① 事故一：群里**另一个机器人引用了一条消息**说话 ⇒ 她「她自己决定用电脑」⇒
  //    19 分钟里被反复叫起来开工 6 次 ✗
  //    真因：那条路放行「@ 了她 **或** 消息里有个引用段」，而引用段**不看引用的是谁** ✗
  check(
    /event\?\.message_type === 'group' \? forHer : forHer \|\| atReplySeg2/.test(src33),
    '★★ 「她自己决定动电脑」在群里**只认 @ 了她**（引用不算、@ 别人更不算）',
  );
  // ② 事故二：另一台机器上那个号，把 `群聊记录.md` 当成了"要处理的东西" ⇒
  //    在群里回「我查不到你引用的那条内容」「别把群聊搬给我」「别把我当二传」✗
  check(
    /它是"背景"，不是"要你处理的东西"/.test(src33),
    '★★ 任务提示词写明「群聊记录**是背景**，不是要你处理的东西」',
  );
  check(
    /没有人在给你派活/.test(src33),
    '★ 而且点明"里面没有人在给你派活"（防它去回那些话、去转给谁）',
  );
  // ③ 顺带：建群文件夹失败必须**看得见**
  //    （原来 log.debug ⇒ 默认级别是 info ⇒ 一个字都不写，只能靠"别的号有、它没有"反推）✗
  check(
    /建群文件夹失败（回头再找一遍）/.test(src33) && /^\s+log\.warn\(/m.test(src33),
    '★ 建群文件夹失败提到了 warn（不然"产物为什么散在群文件根目录"查不出来）',
  );
}

console.log(
  '\n【34】★★★ 任务面板**不留"被打断了"的僵尸记录**（2026-10-16 用户两次截图问）',
);
{
  // 用户原话：「**看看为什么这个是被杀的状态，现在不应该有被杀掉的状态吧，
  //   要么重启了之后自动继续，要么是做完了**」
  //   ⚠️ 第二次截图（重启之后又出现）：真因是 `tidyStaleTasks` 的窗口 60 秒
  //      —— 启动那一刻会把历史里的 `running` 全标成 `killed`（endedAt = 启动时刻），
  //         而调用方是**启动后 45 秒**来收拾 ⇒ 45 < 60 ⇒ **被窗口挡掉** ⇒ 永远挂着 ✗
  const idOld = ab.addPrivateHist({ by: '10000009', task: '旧的被打断的' });
  ab.patchPrivateHist(idOld, { status: 'killed', endedAt: Date.now() - 30000 });
  const idNew = ab.addPrivateHist({ by: '10000009', task: '刚刚被打断的' });
  ab.patchPrivateHist(idNew, { status: 'killed', endedAt: Date.now() });
  const idLive = ab.addPrivateHist({ by: '10000010', task: '其实还在跑的' });
  ab.patchPrivateHist(idLive, { status: 'killed', endedAt: Date.now() - 30000 });
  const idAsk = ab.addPrivateHist({ by: '10000009', task: '当时在问他' });
  ab.patchPrivateHist(idAsk, { status: 'asking' });

  const n = ab.tidyStaleTasks((t) => String(t.by) === '10000010');
  const find = (id) => ab.taskHistory(200).find((x) => x.id === id) || {};
  check(
    find(idOld).status === 'done',
    '★★★ 半分钟前那条"被打断了" ⇒ 收拾成"做好了"（面板不留僵尸 ✓）',
    find(idOld).status,
  );
  check(
    find(idLive).status === 'running',
    '★★ 其实**还在跑**的那条 ⇒ 标回"正在做"（不许误标成做好了 ✓）',
    find(idLive).status,
  );
  check(find(idNew).status === 'killed', '★ 刚刚（10 秒内）那条先别动（可能正要自己标 done ✓）', find(idNew).status);
  check(find(idAsk).status === 'asking', '★ "当时在问他"那种一个字都不动（它不是在跑 ✓）', find(idAsk).status);
  check(n >= 1, '★ 返回"收拾了几条"（日志里要看得出 ✓）', String(n));

  const s34 = readFileSync(join(ROOT, 'src', 'agent-bridge.js'), 'utf8');
  check(
    /minAgeMs = 10000/.test(s34),
    '★★★ 窗口是 **10 秒**（60 秒会把"启动时标的那批"漏掉 ⇒ 面板永远挂着 ✗）',
  );
  const p34 = readFileSync(join(ROOT, 'src', 'private-work.js'), 'utf8');
  check(
    // ⚠️ 2026-10-20：45 秒 → **120 秒**（用户：「为什么视频没发出但人物显示完成」）——
    //    resume（60 秒）必须先跑，tidy 收尾（标 done）只能在它后面 ⇒ 120 秒 ✓
    /setTimeout\(tidyOnce, 120000\)/.test(p34) && /setInterval\(tidyOnce, 10 \* 60 \* 1000\)/.test(p34),
    '★★ 开机 120 秒收拾一次（**必须晚于 60 秒那条 resume**，不然被打断的单还没接上就被标 done ✗）+ 之后**每 10 分钟**再收拾一遍 ✓',
  );
  check(
    /if \(tidyTimer\) clearInterval\(tidyTimer\)/.test(p34),
    '★ `stop()` 会把那个定时器清掉',
  );
}

try {
  rmSync(join(ROOT, CFG_REL), { force: true });
  rmSync(join(ROOT, STATE_REL), { force: true });
  rmSync(join(ROOT, HIST_REL), { force: true });
  rmSync(join(ROOT, WS_REL), { recursive: true, force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
