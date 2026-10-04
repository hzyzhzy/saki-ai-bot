/**
 * 「撤回扩展到教学」的回归（2026-10-06 加）。
 *
 * ## 用户原话
 *   「**把撤回扩展到教学**」
 *
 * ## 背景（为什么以前撤不了）
 *   2026-10-05 加的撤回只覆盖**自动观察**（群里闲聊攒出来的群记忆，写在
 *   `knowledge/groups/<群号>.md` 的 `<!-- AUTO-OBSERVE -->` 标记区里）。
 *   而群主**教**给她的知识走的是 `learned.js` → `server-basic.md` /
 *   `server-rules.md` / `server-world.md` / `server-people.md` 那几份**全局知识库**
 *   （散文式，**没有标记区**）⇒ **一个字都撤不掉**，教错一条只能去界面上手改。
 *
 * ## 这个套件盯四件事
 *   ① 教学写成功之后**真的记了快照**（不然"撤回"仍然只会说"没有什么可撤的诶"）；
 *   ② 撤回时**整文件还原**，而且**不许**给散文式知识库套上 `AUTO-OBSERVE` 标记 ——
 *      那正是"图省事复用 `patchFile`"会犯的错（它只认标记区，没有就自己包一个）；
 *   ③ 两类快照**共用一条队列** ⇒ 撤回的永远是**最近发生的那一次**，
 *      不管它是观察还是教学（用户要的粒度就是"撤回最近一次"）；
 *   ④ 快照**按会话归档** —— A 群一句"撤回"绝不能把 B 群刚教的东西抹掉。
 *
 * ⚠️ 纯离线：假 LLM 起在本进程（127.0.0.1:39092），不碰真模型、不花钱。
 * ⚠️ **必须单独一个进程 + 自己的配置 + 隔离知识库目录**：
 *   `config.js` 在**启动时**读 `QQBOT_CONFIG`，而静态 `import` 会被提升到最前面
 *   ⇒ 那时 env 还没设，就会读到**真实的 config.yml**（拿真 key 调真模型），
 *   而 `KNOWLEDGE_DIR` 不隔离就会往**用户真实的知识库**里写测试教学。
 *   所以下面全部用 `await import()`。
 * 用法: node test/teach-undo.js
 */
import { createServer } from 'node:http';
import { writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ⚠️ 必须在 import src/* 之前设好（config.js 是加载时读的）
process.env.QQBOT_CONFIG = 'config.teach-undo-test.yml';
process.env.QQBOT_KNOWLEDGE_DIR = 'logs/__test-teach-undo-kb';
process.env.QQBOT_OBSERVE_UNDO_FILE = 'logs/__test-teach-undo.json';

const PORT = 39092;
let calls = 0;
// ⚠️ 让不同用例能指定分类：默认 server-basic（走「写专题库」那条路），
//    【6】要测 learned.md 那条路就临时设成 other。
let nextCat = 'server-basic';
const server = createServer((req, res) => {
  const __bodyChunks = [];
  req.on('data', (d) => __bodyChunks.push(d));
  req.on('end', () => {
    // ⚠️ 2026-10-06：**必须先把分片收成 Buffer 再一次性按 UTF-8 解码**。
    //    写成 `body += c`（c 是 Buffer）会让**每个 TCP 分片各自解码** ——
    //    中文正好跨分片时那个字就烂成 ��，断言里 includes 中文就永远匹配不上，
    //    表现为**偶发假失败**（真凶抓到过一次：「在吗，��个事」）。
    const body = Buffer.concat(__bodyChunks).toString('utf8');
    calls++;
    // ⚠️ `phrase()`（教学分类走的就是它）是**非流式** `res.json()` ——
    //    这里回 SSE 会让它解析不出内容（本项目因为"假模型回错格式"踩过四次）。
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        // `learn()` 第一步是 `classify()`，它只认这几个词
        choices: [{ message: { content: `{"cat":"${nextCat}"}` } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }),
    );
  });
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const { ROOT, KNOWLEDGE_DIR, config } = await import('../src/config.js');
// ⚠️ 隔离出来的知识库目录**得先存在** —— `knowledge.js` 是在 import 时扫目录的，
//    目录不在它会打一行 `ERR 加载知识库失败: ENOENT ... scandir` 到 stderr，
//    而 PowerShell 会把 stderr 当成"命令出错"（本项目踩过：git push 成功却报 exit 1）。
mkdirSync(KNOWLEDGE_DIR, { recursive: true });
const observe = await import('../src/observe.js');
const { learn, forget } = await import('../src/learned.js');
const { Bot } = await import('../src/bot.js');

// ⚠️ **一律用假群号** —— 撤回快照是按群存的，用真实群号等于在真实数据上动手。
const GROUP = '999100001';
const OTHER = '999100002';
const BOT = '10000002';
const OWNER = '10000001';
const OWNER_NAME = '服主';

const UNDO_FILE = join(ROOT, 'logs', '__test-teach-undo.json');
const UNDO_BAK = join(ROOT, 'logs', '__test-teach-undo-bak.json');
const CLEAN = join(ROOT, 'logs', '__test-teach-undo-clean.txt');
const CHANGELOG = join(ROOT, 'logs', 'learned-changelog.md');
const clearUndo = () => rmSync(UNDO_FILE, { force: true });

// ⚠️ 教学会往 `logs/learned-changelog.md`（**真实文件**，那个路径没有 env 可覆盖）
//    追加一行流水账 ⇒ 收尾要还原，别把"测试教学"留在用户的账本里。
const changelogBefore = existsSync(CHANGELOG) ? readFileSync(CHANGELOG, 'utf8') : null;

const BASIC = join(KNOWLEDGE_DIR, 'server-basic.md');
const MEM_FILE = join(KNOWLEDGE_DIR, 'groups', `${GROUP}.md`);

const LEARNED_SKELETON =
  '# 学习档案\n\n> 测试用。\n\n<!-- LEARNED:BEGIN -->\n<!-- LEARNED:END -->\n';
const BASIC_TEXT =
  '# 服务器基础\n\n> 测试用。\n\n## 怎么进服\n\n下载整合包，用启动器进。\n';

function seed() {
  mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  writeFileSync(join(KNOWLEDGE_DIR, 'learned.md'), LEARNED_SKELETON, 'utf8');
  writeFileSync(BASIC, BASIC_TEXT, 'utf8');
}

const atSeg = (qq) => ({ type: 'at', data: { qq: String(qq) } });
const textSeg = (text) => ({ type: 'text', data: { text } });
const evOf = (userId = OWNER, message = []) => ({
  message_type: 'group',
  group_id: GROUP,
  user_id: String(userId),
  self_id: BOT,
  message,
  sender: { user_id: String(userId), nickname: OWNER_NAME },
});

const botWith = (role = 'owner') => {
  const b = new Bot();
  b.selfId = BOT;
  b.speakerRole = () => role;
  b.isQuoteOfMe = () => false;
  b.calledByName = () => '';
  b.sent = [];
  b.sendToGroup = async (g, t) => {
    b.sent.push(String(t));
  };
  return b;
};

const teach = (topic, fact) =>
  learn(topic, fact, { by: OWNER, byName: OWNER_NAME, where: `群${GROUP}`, groupId: GROUP });

// ── 【1】教学写成功 → 记快照 ────────────────────────────────
console.log('\n【1】教学之后**记了撤回快照**');
{
  clearUndo();
  seed();
  const before = readFileSync(BASIC, 'utf8');
  const r = await teach('新手指引', '先加群再看公告。');
  check(r.ok === true, '教学成功', JSON.stringify(r));
  check(r.file === 'server-basic.md', `分到了 server-basic.md（实际 ${r.file}）`);
  check(observe.undoCount(GROUP) === 1, '★ 记了 1 条快照');
  const now = readFileSync(BASIC, 'utf8');
  check(now.includes('先加群再看公告'), '内容真的写进文件了');
  check(now.startsWith(before.trimEnd().slice(0, 10)), '原来那份内容还在（是追加，不是覆盖整份）');
}

// ── 【2】撤回 → 整文件还原，且**不许**套上观察标记 ──────────
console.log('\n【2】★ 撤回 = **整文件还原**（不许给散文式知识库套 AUTO-OBSERVE 标记）');
{
  const r = observe.undoLast(GROUP);
  check(r.ok === true, '撤回成功');
  check(r.kind === 'teach', `快照类型是 teach（实际 ${r.kind}）`);
  check(r.title === '新手指引', `报告了主题名（实际「${r.title}」）`);
  const now = readFileSync(BASIC, 'utf8');
  check(now === BASIC_TEXT, '★★ 整份文件回到了教学之前，一个字不差');
  check(!now.includes('先加群再看公告'), '★ 教的那条没了');
  // ⚠️⚠️ 这一条是这个套件里**最重要**的断言：复用 `patchFile` 就会在这里挂。
  check(!/AUTO-OBSERVE/.test(now), '★★★ 没有把观察标记区写进散文式知识库');
  check(observe.undoCount(GROUP) === 0, '快照用掉了');
}

// ── 【3】教到一个**还不存在**的文件里 → 撤回要把文件删掉 ────
console.log('\n【3】文件本来不存在 → 撤回**删掉它**（而不是留一份空骨架）');
{
  clearUndo();
  seed();
  rmSync(BASIC, { force: true });
  const r = await teach('测试主题', '随便写点。');
  check(r.ok === true && r.file === 'server-basic.md', '教学成功（文件是新建的）');
  check(existsSync(BASIC), '教学后文件存在');
  const u = observe.undoLast(GROUP);
  check(u.ok === true, '撤回成功');
  check(!existsSync(BASIC), '★★ 文件被删掉了（没有留下一份凭空多出来的骨架）');
}

// ── 【4】覆盖同名主题 → 撤回还原成旧内容 ───────────────────
console.log('\n【4】同名主题被**覆盖** → 撤回还原成旧的');
{
  clearUndo();
  seed();
  await teach('怎么进服', '第一版答案。');
  const mid = readFileSync(BASIC, 'utf8');
  check(mid.includes('第一版答案'), '第一版写进去了');
  const r2 = await teach('怎么进服', '第二版答案。');
  check(r2.replaced === true, '第二次是覆盖');
  check(readFileSync(BASIC, 'utf8').includes('第二版答案'), '第二版生效');
  observe.undoLast(GROUP);
  const now = readFileSync(BASIC, 'utf8');
  check(now.includes('第一版答案'), '★ 撤回到第一版');
  check(!now.includes('第二版答案'), '★ 第二版没了');
  observe.undoLast(GROUP);
  check(readFileSync(BASIC, 'utf8') === BASIC_TEXT, '★ 再撤一次回到教学之前（原始骨架）');
}

// ── 【5】「@她 忘记刚才那个」→ 回话要说清撤的是**教的那条** ──
console.log('\n【5】人话撤回教学 → 回话分得清"教学"和"闲聊记录"');
{
  clearUndo();
  seed();
  await teach('服务器地址', 'mc.example.com。');
  const b = botWith('owner');
  const msg = [atSeg(BOT), textSeg('忘记刚才那个')];
  const r = b.tryForgetMemory(evOf(OWNER, msg), msg);
  check(r === true, '命令被处理了');
  const said = b.sent.join(' / ');
  check(/服务器地址/.test(said), '★ 回话里点名了撤掉的是哪条教学', said);
  check(!/那次记的/.test(said), '★ 没说成"刚才那次记的"（那是群记忆的话术）');
  check(!readFileSync(BASIC, 'utf8').includes('mc.example.com'), '知识真的撤掉了');
}

// ── 【6】走 `learned.md` 那条路的教学，删掉后也能撤回来 ─────
//    ⚠️ 分类到 other 的（以及分类失败回落的）才写 `learned.md` —— 那里才有条目结构，
//       `/忘记 主题` 才删得动。⚠️ `/忘记` **只认 `learned.md`**，
//       删不到专题库里的条目（那是另一条命令，不在「撤回」这次的范围里）。
console.log('\n【6】learned.md 那条路：`/忘记` 删掉后也能撤回来');
{
  clearUndo();
  seed();
  nextCat = 'other';
  const r = await teach('临时通知', '周三维护。');
  nextCat = 'server-basic';
  check(r.ok === true && r.file === 'learned.md', `落到了 learned.md（实际 ${r.file}）`);
  const del = forget('临时通知', { groupId: GROUP });
  check(del.ok === true, '删条目成功', JSON.stringify(del));
  check(!readFileSync(join(KNOWLEDGE_DIR, 'learned.md'), 'utf8').includes('周三维护'), '删掉了');
  const u = observe.undoLast(GROUP);
  check(u.ok === true && u.kind === 'teach', '★ 能撤回');
  check(
    readFileSync(join(KNOWLEDGE_DIR, 'learned.md'), 'utf8').includes('周三维护'),
    '★ 内容回来了',
  );
}

// ── 【7】两类快照共用队列 → 撤的永远是**最近一次** ──────────
console.log('\n【7】观察 + 教学混着来 → 撤回撤**最近那一次**');
{
  clearUndo();
  seed();
  mkdirSync(dirname(MEM_FILE), { recursive: true });
  const memBefore = '<!-- AUTO-OBSERVE:BEGIN -->\n- 甲：老的\n<!-- AUTO-OBSERVE:END -->\n';
  writeFileSync(MEM_FILE, memBefore, 'utf8');
  // 先来一次"自动观察"
  observe.__pushUndoForTest({
    file: MEM_FILE,
    gid: GROUP,
    before: '- 甲：老的\n',
    after: '- 甲：老的\n- 乙：观察到的\n',
  });
  // 再来一次"教学"（更近）
  await teach('后教的那条', '内容。');
  const r = observe.undoLast(GROUP);
  check(r.kind === 'teach', `★ 撤的是**最近的**那次教学（实际 ${r.kind}）`);
  check(readFileSync(MEM_FILE, 'utf8') === memBefore, '★★ 群记忆**一点没动**');
  const r2 = observe.undoLast(GROUP);
  check(r2.kind === 'observe', '★ 再撤一次才轮到观察那条');
}

// ── 【8】别的群的快照不许被卷进来 ───────────────────────────
console.log('\n【8】★ 别的群教的东西，这个群撤不掉');
{
  clearUndo();
  seed();
  await teach('A 群教的', '内容 A。');
  // 手工造一份"另一个群教过"的快照
  observe.pushTeachUndo({
    file: BASIC,
    gid: OTHER,
    before: BASIC_TEXT,
    after: BASIC_TEXT + '\n## B 群教的\n\n内容 B。\n',
    title: 'B 群教的',
    added: true,
  });
  const r = observe.undoLast(GROUP);
  check(r.ok === true && r.title === 'A 群教的', `★ 撤到的是本群的（实际「${r.title}」）`);
  check(observe.undoCount(OTHER) === 1, '★★ 别的群那份快照还在');
}

// ── 【9】没有可撤的时候 → 明确回一句（老行为不许退化）────────
console.log('\n【9】没有可撤的 → 明确回一句，不许装死');
{
  clearUndo();
  const b = botWith('owner');
  const msg = [atSeg(BOT), textSeg('忘记刚才那个')];
  const r = b.tryForgetMemory(evOf(OWNER, msg), msg);
  check(r === true, '命令被处理了');
  check(b.sent.some((t) => /没有什么可撤/.test(t)), '★ 回了"没有什么可撤的"', b.sent.join(' / '));
}

// ── 收尾 ───────────────────────────────────────────────────
server.close();
try {
  clearUndo();
  rmSync(UNDO_BAK, { force: true });
  rmSync(CLEAN, { force: true });
  rmSync(KNOWLEDGE_DIR, { recursive: true, force: true });
  // ⚠️ 把真实账本还原（见文件头那段说明）
  if (changelogBefore === null) rmSync(CHANGELOG, { force: true });
  else writeFileSync(CHANGELOG, changelogBefore, 'utf8');
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
