/**
 * 「喊妈妈」测试（2026-09-16）。
 *
 * ## 用户要求
 *
 *   「群友喊机器人妈妈的时候反应可以改改，**第一次可以和之前一样表示拒绝**，
 *     但是如果**还喊**的话可以**接受**，并且**切换白祥模式**」
 *
 * ## 规则（这个套件就是把这几条钉死）
 *
 * | 情况 | 结果 |
 * | --- | --- |
 * | 同一个人**第一次**叫 | 明确拒绝（`refuseHint`） |
 * | 同一个人**第二次**叫（或群里累计 3 次＝一群人在起哄） | **认了 + 切白祥模式** |
 * | 白祥模式开着时再叫 | 续期（不重复说"我认了"） |
 * | 有人说「别当妈了 / 黑祥」 | 退出白祥模式 |
 * | 说「我妈今天做了饭」「你妈的」「妈呀」 | **不算**叫她（宁可漏、别误伤） |
 *
 * 白祥 = 粉丝对"家里出事之前的祥子"的叫法（温柔、耐心、会照顾人），
 * 对应的是家道中落之后那副冷硬的「黑祥」。
 *
 * ⚠️ 纯单元测试：不起机器人、不连 NapCat、不花钱
 *    （状态写到 `logs/__test-mama.json`，不碰真实 state）
 *
 * 用法: node test/mama.js
 */
import { writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });

// ⚠️ 配置路径与状态路径都必须在 import `src/*` **之前**设好
const CFG_REL = 'logs/__test-mama.yml';
const STATE_REL = 'logs/__test-mama.json';
writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
    '  apiKey: "sk-test"',
    '  model: test-model',
    'mama:',
    '  enable: true',
    '  perUser: 2',
    '  groupTotal: 3',
    '  windowMs: 1800000',
    '  modeMs: 7200000',
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;
process.env.QQBOT_MAMA_FILE = STATE_REL;
rmSync(join(ROOT, STATE_REL), { force: true });

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const mama = await import('../src/mama.js');
const botMod = await import('../src/bot.js');
const { config } = await import('../src/config.js');
const BotClass = botMod.Bot ?? botMod.default ?? null;

const G1 = '200000001';
const G2 = '200000002';

console.log('\n【1】判据：什么算「叫她妈妈」（宁可漏、别误伤）');
{
  const yes = ['妈妈', '妈咪', '祥妈', '小祥妈妈', '妈妈~', '妈妈带我', '妈', '妈妈你真好',
    // ⚠️ 2026-09-16 深夜：**带占位符的**也要算 —— 群里真实那条是「引用 + @她 + 妈妈」，
    //    取出来是 `[引用#123]妈妈`，原来判成"不算" → 一次都没记账，
    //    白祥模式永远不启动（用户报的「妈妈模式没正常启动」）。
    '[引用#123]妈妈', '[图片]妈妈', '[表情包]妈'];
  const no = [
    '我妈今天做红烧肉',
    '你妈的',
    '他妈的',
    '妈呀',
    '妈耶',
    '我妈妈说我该睡了',
    '今天回家看我妈',
  ];
  for (const t of yes) {
    check(mama.isMomCall(t) === true, `「${t}」→ 算`, '');
  }
  for (const t of no) {
    check(mama.isMomCall(t) === false, `「${t}」→ 不算`);
  }
  // @ 她 / 引用她 → 只要"妈"像在叫她就算（哪怕句子长一点）
  check(mama.isMomCall('你可以当我妈妈吗', { isAtMe: true }) === true, '@她 + 「当我妈妈」→ 算');
  check(mama.isMomCall('叫你一声妈行不行', { isAtMe: true }) === true, '「叫你一声妈」→ 算（那是在让她当妈）');
  check(
    mama.isMomCall('这个人能不能当妈') === false,
    '光「当妈」两个字（没 @ 她、没指向）→ 不算（指不定在说谁）',
  );
  check(mama.isMomCall('妈'.repeat(40)) === false, '太长的句子不算（多半在说别人的妈）');
}

console.log('\n【2】★ 第一次拒绝、第二次就认了并切白祥模式');
{
  mama.__clear();
  const r1 = mama.note(G1, '40001');
  check(r1.phase === 'refuse', '★ 同一个人第一次 → 还是拒绝', r1.phase);
  check(mama.modeOf(G1).active === false, '此时白祥模式没开');

  const r2 = mama.note(G1, '40001');
  check(r2.phase === 'accept', '★ 还喊 → 认了', r2.phase);
  check(r2.userCount === 2, '同一个人第 2 次', String(r2.userCount));
  const m = mama.modeOf(G1);
  check(m.active === true, '★ 白祥模式开了');
  check(m.by === '40001', '记下是谁喊开的', m.by);
  check(m.until - Date.now() > 3600 * 1000, '默认 2 小时（还有 1 小时以上）');

  const r3 = mama.note(G1, '40001');
  check(r3.phase === 'keep', '模式开着时再喊 → 续期，不再重复"我认了"', r3.phase);
  check(mama.modeOf(G1).until >= m.until, '续期后到期时间不早于之前');
}

console.log('\n【3】★ 一群人在起哄也算「还喊」（3 个不同的人各一次）');
{
  mama.__clear();
  const a = mama.note(G2, '50001');
  const b = mama.note(G2, '50002');
  const c = mama.note(G2, '50003');
  check(a.phase === 'refuse' && b.phase === 'refuse', '前两个人都只是"第一次" → 拒绝');
  check(c.phase === 'accept', '★ 第三个人再叫 → 一群人在起哄，认了', c.phase);
  check(mama.modeOf(G2).active === true, '白祥模式开了');
}

console.log('\n【4】按群隔离 + 退出口');
{
  mama.__clear();
  mama.note(G1, '40001');
  mama.note(G1, '40001'); // G1 认了
  check(mama.modeOf(G1).active === true, 'G1 白祥模式开着');
  check(mama.modeOf(G2).active === false, '★ G2 不受影响（按群隔离）');

  check(mama.isExitPhrase('别当妈了') === true, '「别当妈了」是退出暗号');
  check(mama.isExitPhrase('黑祥') === true, '「黑祥」也是');
  check(mama.isExitPhrase('妈妈今天真好看') === false, '正常叫妈不是退出暗号');
  check(mama.exitMode(G1, '测试') === true, '退出成功');
  check(mama.modeOf(G1).active === false, '★ 退出后模式关了');

  // 计数窗口：太久没叫，重新从"第一次"算
  mama.__clear();
  mama.note(G1, '40001');
  const later = Date.now() + config.mama.windowMs + 1000;
  const again = mama.note(G1, '40001', later);
  check(again.phase === 'refuse', '★ 隔了超过窗口期再叫 → 又算"第一次"（还是拒绝）', again.phase);
}

console.log('\n【5】★ 落盘（重启不能忘 —— 她刚认的妈不能一重启就不认了）');
{
  mama.__clear();
  mama.note(G1, '40001');
  mama.note(G1, '40001');
  const f = join(ROOT, STATE_REL);
  check(existsSync(f), '状态文件写出来了');
  const j = JSON.parse(readFileSync(f, 'utf8'));
  const b = j?.byGroup?.[G1];
  check(!!b, '里面有这个群');
  check(b?.users?.['40001']?.count === 2, '记了这个人的次数', String(b?.users?.['40001']?.count));
  check(Number(b?.mode?.until) > Date.now(), '★ 白祥模式的到期时间落了盘');
}

console.log('\n【6】提示词真的注入了（拒绝 / 认了 / 白祥模式）');
{
  check(!BotClass ? false : true, '拿到了 Bot 类');
  const b = new BotClass();
  const ev = (extra) => ({
    message_type: 'group',
    group_id: G1,
    user_id: '40001',
    sender: { user_id: '40001', nickname: '测试' },
    ...extra,
  });
  mama.__clear();

  const sysRefuse = b.buildSystemPrompt('', ev({ _mama: 'refuse' }), null, '妈妈');
  check(sysRefuse.includes('第一次'), '★ 第一次 → 提示词里是"明确拒绝"');
  check(!sysRefuse.includes('现在是【白祥模式】'), '此时没有白祥模式那段');
  // ⚠️ 方向（2026-09-16 用户专门提醒：「是她当群友的妈妈，而不是群友当她的妈妈」）
  check(/你是被叫的那一个/.test(sysRefuse), '★ 第一次那段写明了方向：他管你叫妈');

  const sysAccept = b.buildSystemPrompt('', ev({ _mama: 'accept' }), null, '妈妈');
  check(/认了吧/.test(sysAccept), '★ 还喊 → 提示词里是"认了吧"');
  check(/从这一刻起你是他妈/.test(sysAccept), '★ 「认了」= 你当他妈（不是他当你妈）');

  // 模式开着（落盘状态还在）→ 每句都带白祥模式那段
  mama.note(G1, '40001');
  mama.note(G1, '40001');
  const sysMode = b.buildSystemPrompt('', ev({}), null, '今天天气不错');
  check(sysMode.includes('【白祥模式】'), '★ 模式开着 → 普通消息也带白祥模式那段');
  check(/温柔/.test(sysMode) && /当妈的样子/.test(sysMode), '那段写清了"温柔 / 当妈的样子"');
  check(/你是妈，他们是儿子/.test(sysMode), '★★ 白祥模式第一句就是方向：你是妈，他们是儿子/闺女');
  check(/别管他们叫/.test(sysMode), '★★ 反向禁令在：不许管他们叫「妈妈」');
  check(/别自称"女儿"/.test(sysMode), '★★ 也不许自称女儿 / 说「妈妈我错了」这种');
  check(/温柔 ≠ 没底线/.test(sysMode), '★ 也写了边界（温柔 ≠ 没底线，别发嗲、别客服腔）');
  mama.exitMode(G1, '测试结束');
  const sysOff = b.buildSystemPrompt('', ev({}), null, '今天天气不错');
  check(!sysOff.includes('【白祥模式】'), '退出之后就不带了');
}

console.log('\n【7】代码层：接线别再被拆掉');
{
  const src = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(/import \* as mama from '\.\/mama\.js'/.test(src), 'bot.js 引入了 mama 模块');
  check(/event\._mama = r\.phase/.test(src), '★ 判定结果挂到了事件上（提示词靠它）');
  check(/mama\.isMomCall\(/.test(src), '★ `handle()` 里真的在判"叫她妈妈"');
  check(/mama\.exitMode\(/.test(src), '★ 退出暗号接上了');
  check(/mama\.modeHint\(event\.group_id\)/.test(src), '★ 白祥模式那段真的在注入');
  check(
    /event\.message_type === 'group' && config\.mama\?\.enable !== false/.test(src),
    '★ 只在群里判（私聊喊妈不算"群友起哄"）',
  );
  const m = readFileSync(join(ROOT, 'src', 'mama.js'), 'utf8');
  check(/QQBOT_MAMA_FILE/.test(m), '状态文件有测试出口（QQBOT_MAMA_FILE）');
  check(/renameSync/.test(m), '原子写盘（先写 .tmp 再 rename）');
}

console.log(
  failures === 0
    ? '\n结果: 全部通过 ✅（第一次拒绝、还喊就认并切白祥模式；按群、落盘、能退出）\n'
    : `\n结果: ${failures} 项失败 ❌\n`,
);
process.exit(failures === 0 ? 0 : 1);
