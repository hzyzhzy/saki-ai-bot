/**
 * 知识库**分群**（2026-09-15 晚 <主人> 要求）。
 *
 * ## 用户原话
 *
 * > 「建议群资料库也可以开始分群了，因为最开始的群只玩 mc，但是这个 699 开头的群，
 * >   群友玩的游戏很多，活跃人数也多。如果可以的话，把现在的那个资料库里能识别到的
 * >   那个 699 的群信息**复制出来不是剪切出来**做一个新资料库，**回答问题时也要选对**，
 * >   并且**正确屏蔽错误群资料库**，但是**二次元库依然可以调用**。」
 *
 * 所以这里盯四件事：
 *   ① `knowledge/groups/<群号>.md` **只**在那个群注入（别的群一个字都看不到）
 *   ② 共享文件里的「群标签块」`<!-- 群:xxx -->…<!-- /群 -->`：
 *      只有那个群看得见；而那个群**已经有自己的资料库**时，共享里那块会被丢掉（免得注入两遍）
 *   ③ 选择（`selectFor`）得挑对：699 聊明日方舟 → 带上 699 那份；别的群 → 什么都不带
 *   ④ 二次元库（anime.md）**两边都能用**（它不分群）
 *
 * ⚠️ 全离线：把知识库整个搬到临时目录（`QQBOT_KNOWLEDGE_DIR`），不碰真实 knowledge/。
 *
 * 用法: node test/knowledge-groups.js
 */
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = 'logs/__test-know-groups';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

// ── 造一份临时知识库（必须在 import src/* 之前设好）────────────────
const G699 = '200000006';
const GMC = '200000001';
// ⚠️ 2026-09-21：人设的 md（`persona.md`）现在住在**人设包**里，不在 `knowledge/`。
//    所以这个套件要**同时**把两处都搬到临时目录 —— 否则要么加载不到人设，
//    要么误读真实的那份（而真实那份是用户的，测试绝不能碰）。
const PERSONA_TMP = 'logs/__test-persona-groups';
rmSync(join(ROOT, TMP), { recursive: true, force: true });
rmSync(join(ROOT, PERSONA_TMP), { recursive: true, force: true });
mkdirSync(join(ROOT, TMP, 'groups'), { recursive: true });
mkdirSync(join(ROOT, TMP, 'anime'), { recursive: true });
mkdirSync(join(ROOT, PERSONA_TMP), { recursive: true });
writeFileSync(join(ROOT, PERSONA_TMP, 'persona.md'), '# 人设\n\n你叫祥子。\n', 'utf8');
// ⚠️ 2026-09-21：动画库从"根目录一个共用 `anime.md`"改成 **`anime/<库名>.md` + 人设声明**
//    （`identity.anime.works`）。所以这里必须连 `identity.json` 一起造 ——
//    没有它 `animeWorks()` 返回空数组，**动画库一份都不会加载**，断言就假红了。
writeFileSync(
  join(ROOT, PERSONA_TMP, 'identity.json'),
  JSON.stringify({ id: 'test', name: '测试角色', anime: { works: ['bangdream'] } }, null, 2),
  'utf8',
);
writeFileSync(
  join(ROOT, TMP, 'anime', 'bangdream.md'),
  '# 二次元常识\n\nBanG Dream / MyGO 的常识都在这儿。\n',
  'utf8',
);
// 共享群记忆：里面夹一个"只在 699 用"的标签块（模拟"复制出来之后原文还留着"）
writeFileSync(
  join(ROOT, TMP, 'group-memory.md'),
  [
    '# 群记忆',
    '',
    '- 小夏KID：这个是 MC 群的人。',
    '',
    '<!-- 群:200000006 -->',
    '- 这是共享文件里标着 699 的一段（699 已经有自己的资料库了 → 这段应该被丢掉）',
    '<!-- /群 -->',
    '',
    '<!-- 群:888888888 -->',
    '- 这是只属于 888888888 的一段。',
    '<!-- /群 -->',
    '',
  ].join('\n'),
  'utf8',
);
writeFileSync(
  join(ROOT, TMP, 'groups', `${G699}.md`),
  [
    '# 群资料 · 200000006（只给这个群用）',
    '',
    '这个群**明日方舟**聊得多。',
    '',
    '## 群友',
    '',
    '- **猫尾不打烊**：明日方舟玩家。',
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_KNOWLEDGE_DIR = TMP;
// ⚠️ 人设包也要搬走 —— 人设的 md 在那儿，不搬就加载不到（会变成"没性格"）
process.env.QQBOT_PERSONA_DIR = join(ROOT, PERSONA_TMP);

const K = await import('../src/knowledge.js');

console.log('\n【1】★★ `groups/<群号>.md` 只给那个群');
{
  check(K.hasGroupFile(G699) === true, '★★ 699 有自己的一份');
  check(K.hasGroupFile(GMC) === false, '★ MC 群没有（照旧用共享的那份）');
  const a = K.knowledgeText({ groupId: G699 });
  check(/【这个群自己的资料】/.test(a), '★★ 699 的提示词里带上了「这个群自己的资料」');
  check(a.includes('猫尾不打烊'), '★ 而且真的带上了 699 的人');
  const b = K.knowledgeText({ groupId: GMC });
  check(!b.includes('猫尾不打烊'), '★★ **别的群一个字都看不到 699 的人**（＝正确屏蔽）');
  check(!/【这个群自己的资料】/.test(b), '★ 别的群也不会带上"群自己的资料"那一段');
  check(b.includes('小夏KID'), '★ 但它照样看得到共享的群记忆（MC 群自己的人还在）');
}

console.log('\n【2】★★ 共享文件里的「群标签块」按群生效');
{
  const a = K.knowledgeText({ groupId: G699 });
  // 699 自己那份文件已经覆盖了 → 共享里标着 699 的那块**要被丢掉**（不然注入两遍）
  check(!a.includes('标着 699 的一段'), '★★ 699 已经有自己的资料库 → 共享里那块被丢掉（不重复注入）');
  check(a.includes('猫尾不打烊'), '★ 内容仍然在（在它自己那份文件里）');
  const b = K.knowledgeText({ groupId: GMC });
  check(!b.includes('标着 699 的一段'), '★★ 别的群看不到标着 699 的那块');
  check(!b.includes('只属于 888888888'), '★★ 别的群的标签块也不会漏出去');
  const c = K.knowledgeText({ groupId: '888888888' });
  check(c.includes('只属于 888888888'), '★ 标着 888888888 的块，在那个群里能看到');
  check(!c.includes('标着 699 的一段'), '★ 而且它看不到 699 那块');
  // 私聊（没有群号）→ 所有群标签块都不带
  const d = K.knowledgeText({});
  check(!d.includes('标着 699') && !d.includes('只属于 888888888'), '★ 没有群号（私聊）→ 所有群标签块都不带');
}

console.log('\n【3】★★ 选择：这个群自己的资料该进来时才进来');
{
  const pick699 = K.selectFor('明日方舟 EX8 怎么打', { groupId: G699 });
  check(
    pick699.names.includes(`groups/${G699}.md`),
    '★★ 699 里问明日方舟 → 把 699 那份挑进来',
    JSON.stringify(pick699.names),
  );
  const pickMC = K.selectFor('明日方舟 EX8 怎么打', { groupId: GMC });
  check(!pickMC.names.some((n) => n.startsWith('groups/')), '★★ 别的群问同一句 → **不挑任何群资料库**');
  const pickChat = K.selectFor('今天天气不错', { groupId: G699 });
  check(!pickChat.names.some((n) => n.startsWith('groups/')), '★ 无关闲聊也不会硬塞（省提示词）');
}

console.log('\n【4】★★ 二次元库依然全局可用（用户明确要求）');
{
  for (const g of [G699, GMC, '']) {
    const t = K.knowledgeText({ groupId: g });
    check(t.includes('BanG Dream'), `★ ${g || '(私聊)'} 都能读到二次元库`);
  }
  const p1 = K.selectFor('梦限大是谁', { groupId: G699 }).names;
  const p2 = K.selectFor('梦限大是谁', { groupId: GMC }).names;
  check(
    p1.includes('anime/bangdream.md') && p2.includes('anime/bangdream.md'),
    '★★ 问二次元 → 两个群都会带上动画库（anime/bangdream.md）',
  );
}

console.log('\n【5】★ 界面/观察那边的接线（源码层面）');
{
  const webui = readFileSync(join(ROOT, 'src', 'webui.js'), 'utf8');
  check(/function safeKnowName/.test(webui), '★ 界面文件名校验放开了 `groups/<群号>.md`（原来是 basename，会被削掉）');
  // ⚠️ 源码里那是一条**正则字面量**，所以文本里带着反斜杠 —— 别按"纯文本"去匹配
  check(
    webui.includes('groups\\/\\d+\\.md') || /groups[\\/]+\d\+/.test(webui),
    '★ 而且只允许 `groups/<纯数字群号>.md` 这一层',
  );
  check(/群资料库 · \*\*只给群/.test(webui), '★ 界面上会标明"只给群 xxx 用"');
  const obs = readFileSync(join(ROOT, 'src', 'observe.js'), 'utf8');
  check(/function targetFileFor/.test(obs), '★★ 自动观察**按群**写文件（有群资料库就写它）');
  // ⚠️ 2026-09-17：这里原来钉的是 `groupId: String(event.group_id` 那行字面量，
  //    后来改成走 `scopeFor(event)`（群→群号；私聊→他共有的那个群 / dm:），
  //    所以断言跟着改成"**经 scopeFor 决定作用域**" + "scopeFor 里确实用了 group_id"。
  //    ⚠️ 这类"读源码做断言"的写法天生脆弱（改实现就会假冒警报），
  //    但它能挡住一件真事：**有人图省事把群号硬写死/忘了带群号**。
  check(
    /groupId: scopeFor\(event\)/.test(obs) && /String\(event\?\.group_id/.test(obs),
    '★ 攒消息时就记下是哪个群的（走 scopeFor）',
  );
  const know = readFileSync(join(ROOT, 'src', 'knowledge.js'), 'utf8');
  check(/scopeForGroup/.test(know), '★ 共享文件过一遍"群归属"过滤');
}

console.log('\n【6】★★ 真实知识库的现状（699 那份确实建起来了）');
{
  // 用**真实** knowledge/ 目录看一眼（只读，不改）
  const real = join(ROOT, 'knowledge');
  const g = readFileSync(join(real, 'groups', `${G699}.md`), 'utf8');
  check(g.includes('猫尾不打烊') && g.includes('喵喵三三'), '★★ 699 那份里有它的人（复制过来了）');
  check(/游戏常识/.test(g), '★ 而且留了「游戏常识（待补）」的位置（用户：总结好几个游戏之后再补常识）');
  const gm = readFileSync(join(real, 'group-memory.md'), 'utf8');
  check(!gm.includes('猫尾不打烊'), '★★ 共享文件里已经看不到 699 的人（别的群不会再看到）');
  check(gm.includes('一条没丢'), '★ 共享文件里留了说明（说明搬哪儿去了、备份在哪儿）');
}

console.log('\n【7】★★ "连不上"的说法必须能把**服务器库**带进来（2026-09-15 晚补的坑）');
{
  // ⚠️ 真实踩过：群友问「怎么连接超时了，难道要加速器？」——
  //    原来的注入判据里只有「连不上」，**没有「超时/连接/加速器/登录」** ✗
  //    → 服务器库压根没进提示词 → 她只能凭通用知识瞎答（那次就冒出了自造的「回滚点」）。
  //    所以这里既验判据、也真跑一遍 `selectFor`（往临时知识库里放一份服务器库）。
  writeFileSync(
    join(ROOT, TMP, 'hzymtr-server.md'),
    ['# 服务器库（测试用）', '', '连接超时的话：**不需要加速器**，先查自己网络，再问管理员。', ''].join('\n'),
    'utf8',
  );
  K.reloadKnowledge();
  const hit = (q) => K.selectFor(q, {}).names.includes('hzymtr-server.md');
  check(hit('怎么连接超时了，难道要加速器？') === true, '★★ 「怎么连接超时了，难道要加速器？」→ 带服务器库');
  check(hit('卡在登录界面进不去') === true, '★ 「卡在登录界面」→ 带服务器库');
  check(hit('要开加速器吗') === true, '★ 「要开加速器吗」→ 带服务器库（正是要纠正的那类问题）');
  check(hit('服务器进不去') === true, '★ 老判据（服务器/进不去）没被改坏');
  check(hit('今天午饭吃什么') === false, '★ 无关闲聊**不会**白白带上（省提示词）');
  // 内容层面：那三步顺序必须写清楚（用户定的：不用加速器 → 查自己网络 → 再问管理员）
  const srv = readFileSync(join(ROOT, 'knowledge', 'hzymtr-server.md'), 'utf8');
  check(/不需要加速器/.test(srv), '★★ 资料里写明了「不需要加速器」（这服直连）');
  check(/先查[^\n]{0,8}网络/.test(srv), '★★ 而且写明"先查自己网络"');
  check(/再问管理员/.test(srv), '★ 最后一步是"一直进不去再问管理员"');
  check(/跟备份一点关系都没有/.test(srv), '★ 仍然写着"跟备份没关系"（上次那条没丢）');
  // ⚠️ 这里读的是**真实**的人设包（不是上面那份临时的）——
  //    这条断言盯的是"用户实际的人设里有没有这段话"，所以必须在搬走之前读。
  check(
    /回滚点/.test(readFileSync(join(ROOT, 'personas', 'saki', 'persona.md'), 'utf8')),
    '★ 人设里那条"别造词"也在（拿回滚点当反例）',
  );
}

rmSync(join(ROOT, TMP), { recursive: true, force: true });
console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
