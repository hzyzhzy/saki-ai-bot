/**
 * 私聊记忆套件（2026-09-17 加）。
 *
 * ## 用户的两句话（口径就是这两句，别改）
 *   ①「机器人和群友的**私聊也应该和群里一样**，记下性格和事件」
 *   ②「我建议**私聊和群用一套**，也就是如果那个人在同一个群时，
 *      现在不会有没有群只加好友的」「**同一套资料库**」
 *
 * ## 这个套件真正要钉住的两件事
 *   ① **归属**：同一个人，私聊和群聊攒进**同一份资料**
 *      （他共有的那个群）—— 否则会分裂成两份记忆，她在私聊里听过的、
 *      到群里就"不记得"了。
 *   ② **兜底不能写错地方**：查不到共有群时只能写 `dm:<QQ号>.md`，
 *      🚫🚫 **绝不能掉进共享的 `group-memory.md`** —— 那个文件**所有群都能看到**，
 *      私聊内容进那儿就是泄漏。
 *
 * ⚠️ 纯离线：不起进程、不碰真 QQ、不花钱。
 * 用法: node test/dm-memory.js
 */
// ⚠️ 必须在 import 之前设 —— `names.js` 是在模块加载时 reload 的（和 tic/qzone 一个套路）
process.env.QQBOT_NAMES_FILE = process.env.QQBOT_NAMES_FILE || 'logs/__dmtest-names.json';

const names = await import('../src/names.js');
const observe = await import('../src/observe.js');

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const GID = '888001';
const ME = '30009';      // 在群里的那个人
const ONLY_DM = '39999'; // 纯好友：一个共有群都没有

console.log('\n【1】准备：让名字表知道"谁在哪个群"');
names.__clear();
names.note({ message_type: 'group', group_id: GID, user_id: ME, sender: { card: '小明' } });
const gids = names.groupsOf(ME);
check(gids.includes(GID), `groupsOf 能查到他在 ${GID}`, `→ [${gids.join(', ')}]`);
check(names.groupsOf(ONLY_DM).length === 0, '纯好友查不到任何群');

console.log('\n【2】★★ 归属：私聊优先归到"他共有的那个群"（这就是"同一套资料库"）');
check(
  observe.scopeFor({ message_type: 'group', group_id: GID, user_id: ME }) === GID,
  '群聊 → 群号',
  observe.scopeFor({ message_type: 'group', group_id: GID, user_id: ME }),
);
check(
  observe.scopeFor({ message_type: 'private', user_id: ME }) === GID,
  '★ 私聊（他在一个群里）→ **那个群号，不是 dm:**',
  observe.scopeFor({ message_type: 'private', user_id: ME }),
);
check(
  observe.scopeFor({ message_type: 'private', user_id: ONLY_DM }) === `dm:${ONLY_DM}`,
  '私聊（一个共有群都没有）→ 才退回 dm:<QQ号>',
  observe.scopeFor({ message_type: 'private', user_id: ONLY_DM }),
);

console.log('\n【3】★★ 兜底绝不能写进共享的群记忆（那个文件所有群都看得到）');
const dmFile = observe.__targetFileFor(`dm:${ONLY_DM}`);
check(/dm/.test(dmFile) && dmFile.endsWith(`${ONLY_DM}.md`), '纯好友私聊 → dm/<QQ号>.md', dmFile);
check(!/group-memory/.test(dmFile), '★★ 纯好友私聊**没有**掉进 group-memory.md', dmFile);

// ⚠️⚠️ 下面这条是**第一版真漏掉的**：私聊归到一个"还没有自己资料库文件"的群时，
//    `targetFileFor` 会掉回共享的 `group-memory.md` → 私聊内容被所有群看到 ✗
const freshPrivate = observe.__targetFileFor(GID, true);
check(!/group-memory/.test(freshPrivate), '★★ 私聊归到"还没资料库的群"时也没掉进共享文件', freshPrivate);
check(
  /groups/.test(freshPrivate) && freshPrivate.endsWith(`${GID}.md`),
  '而是就地给这个群建一份 groups/<群号>.md',
  freshPrivate,
);
// 对照：**群自己的消息**维持老行为（那个群没资料库就写共享文件）—— 不惊动别的群
const freshPublic = observe.__targetFileFor(GID, false);
check(/group-memory/.test(freshPublic), '（对照）群消息在没有资料库时仍写共享文件', freshPublic);

console.log('\n【3b】★★ 已有资料库的群：两种来源进的是**同一个文件**');
// ⚠️ 这一组**不能在隔离环境里硬断言** —— `run-all` 给每个套件发的是 `knowledge/` 的
//    **临时副本**，那份副本里没有真实的 `groups/200000006.md`。所以先看这个环境里
//    那个群到底有没有资料库，有才断言（没有就跳过并说明，不算失败）。
const knownPublic = observe.__targetFileFor('200000006', false);
if (/groups/.test(knownPublic)) {
  const knownPrivate = observe.__targetFileFor('200000006', true);
  check(!/group-memory/.test(knownPublic), '群消息 → groups/200000006.md', knownPublic);
  check(knownPublic === knownPrivate, '★★ 私聊和群消息**同一个文件**（这就是"同一套资料库"）', knownPrivate);
} else {
  console.log(`  ⏭  跳过：这个环境里没有 200000006 的群资料库（隔离副本里本来就没有）`);
  console.log('     —— "同一套资料库"由上面【3】那条"私聊归到群号"间接覆盖');
}

console.log('\n【4】私聊消息确实会被攒起来（原来这里被拦掉了）');
const before = observe.pendingCount();
observe.note({ message_type: 'private', user_id: ME, self_id: '10001', sender: { nickname: '小明' } }, '今天考试考砸了');
check(observe.pendingCount() === before + 1, '私聊消息进了观察队列', `${before} → ${observe.pendingCount()}`);
observe.note({ message_type: 'group', group_id: GID, user_id: ME, self_id: '10001' }, '群里说一句');
check(observe.pendingCount() === before + 2, '群消息照旧进队列', `${observe.pendingCount()}`);

console.log('\n【5】不该收的仍然不收');
const n0 = observe.pendingCount();
observe.note({ message_type: 'private', user_id: '10001', self_id: '10001' }, '她自己在私聊里说的');
check(observe.pendingCount() === n0, '机器人自己说的不算观察');
observe.note({ message_type: 'guild', user_id: '12345' }, '别的消息类型');
check(observe.pendingCount() === n0, '别的 message_type 不收');
observe.note({ message_type: 'private', user_id: '12345' }, '   ');
check(observe.pendingCount() === n0, '空白文本不收');

console.log('\n【6】边界：缺字段不许抛');
for (const ev of [
  { message_type: 'private' },
  { message_type: 'private', user_id: null },
  { message_type: 'group' },
  null,
  undefined,
  {},
]) {
  let ok = true;
  let got = '';
  try {
    got = String(observe.scopeFor(ev));
  } catch (e) {
    ok = false;
    got = e.message;
  }
  check(ok, `scopeFor 安全处理：${JSON.stringify(ev)}`, got);
}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures ? 1 : 0);
