/**
 * 「@她 + 人话让她忘掉刚记的那条」的回归（2026-10-05 加）。
 *
 * ## 用户原话
 *   「在机器人记群里内容的时候，加一个能撤回记住的机制，只要 @机器人 然后以自然语言
 *     说出**忘记刚才那个** 之类的话，就撤回记住的那条，**区别于 / 的命令**」
 *
 * 拍板（问过两个来回）：粒度 = **撤销最近一次总结**；权限 = **服主 / 管理员 / 群管**。
 *
 * ## 这个套件盯两件事（一样重要）
 *   ① **判据要准**：三个条件缺一不可 —— 明确对着她说 + 有"忘/删/撤"动词 +
 *      挨着「刚才/那条/这个」这种指代。⚠️ 拦错了的后果是**她的记忆被随口删掉**，
 *      而漏判的后果只是"她没听懂" ⇒ 所以【2】那组反例比【1】更重要。
 *   ② **撤回只撤这个群**那一次 —— 一次总结会给好几个群各写一次，
 *      不能把别的群的记录一起卷回来。
 *
 * ⚠️ 纯离线：不起进程、不连 QQ、不调模型（撤回是纯文件操作）。
 * 用法: node test/observe-undo.js
 */
import { writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ⚠️ 必须在 import src/* 之前设好（config.js 是加载时读的）
process.env.QQBOT_OBSERVE_UNDO_FILE = 'logs/__test-observe-undo.json';
// ⚠️⚠️⚠️ 2026-10-05 —— **这一行是血的教训，别删**：
//    这个套件会往 `KNOWLEDGE_DIR/groups/<群号>.md` 写测试数据、收尾再删掉。
//    第一次我**单独跑**它（没有 run-all 注入的隔离 env）⇒ `KNOWLEDGE_DIR` 指向**真实**
//    `knowledge/`，它用真实群号 200000001 / 200000006 覆盖并**删掉了用户两个群的资料库**
//    （20KB + 18KB，翻遍提示词快照和旧备份都救不回来，只能走 OneDrive 回收站）✗✗
//    ⇒ 隔离知识库目录 + 下面一律用**假群号**，两道保险缺一不可。
process.env.QQBOT_KNOWLEDGE_DIR = 'logs/__test-observe-undo-kb';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const { KNOWLEDGE_DIR, ROOT } = await import('../src/config.js');
const observe = await import('../src/observe.js');
const { Bot } = await import('../src/bot.js');

// ⚠️ **一律用假群号** —— 这个套件会真的建文件，用真实群号就等于在真实数据上动手。
const GROUP = '999000001';
const OTHER = '999000002';
const BOT = '10000002';
const OWNER = '10000001';
const MEMBER = '10000003';

const atSeg = (qq) => ({ type: 'at', data: { qq: String(qq) } });
const textSeg = (text) => ({ type: 'text', data: { text } });
const evOf = (userId = OWNER, message = []) => ({
  message_type: 'group',
  group_id: GROUP,
  user_id: String(userId),
  self_id: BOT,
  message,
  sender: { user_id: String(userId), nickname: '某群友' },
});

const botWith = (role = 'owner') => {
  const b = new Bot();
  b.selfId = BOT;
  b.speakerRole = () => role;
  // 只测「@她」这条路：引用/点名那两条 stub 掉（它们各自有别的套件盯着）
  b.isQuoteOfMe = () => false;
  b.calledByName = () => '';
  // ⚠️⚠️ 2026-10-13 加（用户要求：「记住 / 忘记应该在**命中关键词之后
  //    再用模型判定一遍**是否执行」）：`tryForgetMemory` 现在会在命中之后
  //    `await this.judgeMemoryCommand('forget', …)` —— 那是**一次模型调用**，
  //    而本套件是"纯离线、不调模型"的，所以这里把它桩成"判定通过"；
  //    「判定说不是指令 → 不许删」那一条单独在【7】里测（桩成 false）。
  b.judgeMemoryCommand = async () => ({ do: true, why: '套件桩：当它是指令' });
  b.sent = [];
  b.sendToGroup = async (g, t) => {
    b.sent.push(String(t));
  };
  return b;
};

// 造一个"群里已经有观察内容"的文件
function makeMemory(gid, before, after) {
  const dir = join(KNOWLEDGE_DIR, 'groups');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${gid}.md`);
  writeFileSync(
    file,
    `# 群资料（这个群自己的）\n\n<!-- AUTO-OBSERVE:BEGIN -->\n${after}<!-- AUTO-OBSERVE:END -->\n`,
    'utf8',
  );
  return file;
}

const UNDO_FILE = join(ROOT, 'logs', '__test-observe-undo.json');
const clearUndo = () => rmSync(UNDO_FILE, { force: true });

console.log('\n【1】该处理的（@她 + 动词 + 指代）');
for (const t of [
  '忘记刚才那个',
  '忘掉刚才那个吧',
  '把刚才那条删了',
  '刚才那条忘掉',
  '别记这个了',
  '撤回刚刚记的那个',
  '这个不用记',
  // ★ 2026-10-05 实测补的：用户 @ 她只说了「撤回」两个字 ⇒ 第一版**完全没反应** ✗
  //    「撤回 / 撤销」是明确指令词 ⇒ @她的前提下单独出现就该算（见 tryForgetMemory 的注释）
  '撤回',
  '撤回吧',
  '撤销一下',
]) {
  clearUndo();
  const b = botWith('owner');
  // 塞一条快照，好让撤回真的能成
  observe.__pushUndoForTest({ file: makeMemory(GROUP, '- 旧\n', '- 旧\n- 新\n'), gid: GROUP, before: '- 旧\n', after: '- 旧\n- 新\n' });
  const r = await b.tryForgetMemory(evOf(OWNER, [atSeg(BOT), textSeg(t)]), [atSeg(BOT), textSeg(t)]);
  check(r === true, `处理掉：${t}`, b.sent.join(' / ').slice(0, 40));
}

console.log('\n【2】★ 不许误处理的（群里正常说话）');
for (const t of [
  '我忘记带钥匙了', // 有"忘记"但**没有指代"刚记的"**
  '忘了他吧', // 有动词没指代
  '刚才那集真好看', // 有指代没动词
  '删掉这条消息', // 是"删消息"不是"删记忆"
  '这个不用记了谢谢你', // ⚠️ 这条**会**命中（"不用记"+"这个"）—— 见下面那条注释
]) {
  clearUndo();
  const b = botWith('owner');
  const r = await b.tryForgetMemory(evOf(OWNER, [atSeg(BOT), textSeg(t)]), [atSeg(BOT), textSeg(t)]);
  // ⚠️ 最后一条是**已知会命中**的边界（"这个不用记"确实是在让她别记）——
  //    不算误伤，所以这里单独放行它，其余必须 false。
  const expect = t === '这个不用记了谢谢你' ? true : false;
  check(r === expect, `不误处理：${t}`, `实际 ${r}`);
}

console.log('\n【3】没 @她 / 没对着她说 → 不管');
{
  clearUndo();
  const b = botWith('owner');
  const msg = [textSeg('忘记刚才那个')]; // 没 @
  check((await b.tryForgetMemory(evOf(OWNER, msg), msg)) === false, '没 @ 她 → 不处理（只是群里闲聊）');
}
{
  clearUndo();
  const b = botWith('owner');
  const msg = [atSeg('10000009'), textSeg('忘记刚才那个')]; // @ 的是别人
  check((await b.tryForgetMemory(evOf(OWNER, msg), msg)) === false, '@ 的是别人 → 不处理');
}

console.log('\n【4】权限：普通群友说这句 → 婉拒，但**不动记忆**');
{
  clearUndo();
  const file = makeMemory(GROUP, '- 旧\n', '- 旧\n- 新\n');
  observe.__pushUndoForTest({ file, gid: GROUP, before: '- 旧\n', after: '- 旧\n- 新\n' });
  const b = botWith('member');
  const msg = [atSeg(BOT), textSeg('忘记刚才那个')];
  const r = await b.tryForgetMemory(evOf(MEMBER, msg), msg);
  check(r === true, '命令被处理了（她得有回应，不能装没听见）');
  check(
    b.sent.some((t) => /只有服主和管理员/.test(t)),
    '★ 回的是"只有服主和管理员能用"',
    b.sent.join(' / '),
  );
  check(observe.undoCount(GROUP) === 1, '★★ 记忆**一条都没动**（权限挡住了，不是"撤了但没说"）');
}

console.log('\n【5】★★ 撤回：把内容写回改动前，而且**只撤这个群**');
{
  clearUndo();
  const BEFORE = '- 甲：老的观察\n';
  const AFTER = '- 甲：老的观察\n- 乙：这次新记的\n- 丙：这次新记的\n';
  const fileA = makeMemory(GROUP, BEFORE, AFTER);
  const fileB = makeMemory(OTHER, '- 丁：别的群的\n', '- 丁：别的群的\n- 戊：别的群新记的\n');
  observe.__pushUndoForTest({ file: fileB, gid: OTHER, before: '- 丁：别的群的\n', after: '- 丁：别的群的\n- 戊：别的群新记的\n' });
  observe.__pushUndoForTest({ file: fileA, gid: GROUP, before: BEFORE, after: AFTER });

  const r = observe.undoLast(GROUP);
  check(r.ok === true, '撤回成功');
  check(r.removed === 2, `报告的条数 = 2（实际 ${r.removed}）`);
  const nowA = readFileSync(fileA, 'utf8');
  check(nowA.includes('老的观察'), '★ 改动前的内容还在');
  check(!nowA.includes('这次新记的'), '★★ 这次新记的两条被撤掉了');
  const nowB = readFileSync(fileB, 'utf8');
  check(nowB.includes('别的群新记的'), '★★ 别的群的记录**一点没动**');
  check(observe.undoCount(GROUP) === 0, '这个群的快照用掉了');
  check(observe.undoCount(OTHER) === 1, '别的群那份快照还在');
}

console.log('\n【6】没有可撤的时候 → 明确回一句，不许装死');
{
  clearUndo();
  const b = botWith('owner');
  const msg = [atSeg(BOT), textSeg('忘记刚才那个')];
  const r = await b.tryForgetMemory(evOf(OWNER, msg), msg);
  check(r === true, '命令被处理了');
  check(b.sent.some((t) => /没有什么可撤/.test(t)), '★ 回了"没有什么可撤的"', b.sent.join(' / '));
}

console.log('\n【7】★★ 关键词命中了、但模型说"不是在让她忘" → **一个字都不许动**');
{
  // 现场（用户截图 + 日志实锤，2026-10-13 14:29:56）：
  //   他说「我**都忘记**那个开关了，是之前加黑祥的时候加的」——
  //   「忘」+ 指代「那个」命中判据 ⇒ 她**真撤掉**了「服务器规则」那条教学 ✗
  //   他说的"忘"是**他自己忘**。
  // ⇒ 判据只当"可能是指令"，命中之后由 `judgeMemoryCommand` 再确认一次（模型判定）；
  //   判定为"否"或**判不出来**都**不执行** —— 误删是真动数据，宁可这次不做。
  clearUndo();
  const file = makeMemory(GROUP, '- 旧\n', '- 旧\n- 服务器规则：白名单要申请\n');
  observe.__pushUndoForTest({
    file,
    gid: GROUP,
    before: '- 旧\n',
    after: '- 旧\n- 服务器规则：白名单要申请\n',
  });
  const b = botWith('owner');
  b.judgeMemoryCommand = async () => ({ do: false, why: '是说话的人自己忘了什么' });
  const msg = [atSeg(BOT), textSeg('我都忘记那个开关了，是之前加黑祥的时候加的')];
  const r = await b.tryForgetMemory(evOf(OWNER, msg), msg);
  check(r === false, '★ 不当撤回指令（返回 false，交给正常聊天）', `实际 ${r}`);
  check(readFileSync(file, 'utf8').includes('白名单要申请'), '★★ 那条知识**还在**（一个字都没动）');
  check(observe.undoCount(GROUP) === 1, '★★ 快照也没被消费掉（还能撤）');
  check(!b.sent.some((t) => /我忘了|删了/.test(t)), '★ 没有发"我忘了"那种回执');

  // 判定**失败**（模型调用挂了 / 解析不出来）→ 同样不执行（保守）
  clearUndo();
  const file2 = makeMemory(GROUP, '- 旧\n', '- 旧\n- 又一条\n');
  observe.__pushUndoForTest({ file: file2, gid: GROUP, before: '- 旧\n', after: '- 旧\n- 又一条\n' });
  const b2 = botWith('owner');
  b2.judgeMemoryCommand = async () => ({ do: false, why: '判定出错：fetch failed', failed: true });
  const msg2 = [atSeg(BOT), textSeg('忘记刚才那个')];
  const r2 = await b2.tryForgetMemory(evOf(OWNER, msg2), msg2);
  check(r2 === false, '★ 判定失败 → 也不执行（保守，宁可这次不撤）', `实际 ${r2}`);
  check(readFileSync(file2, 'utf8').includes('又一条'), '★★ 判定失败时那条也**没被删**');
}

try {
  clearUndo();
  for (const g of [GROUP, OTHER]) rmSync(join(KNOWLEDGE_DIR, 'groups', `${g}.md`), { force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
