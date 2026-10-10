/**
 * 生日 + **动态年龄** 的自检（2026-10-09 用户要求）。
 *
 * 用户原话：
 *   「把所有角色的信息**只留下生日**，**年龄变为真实动态的**，
 *     这样随机事件和剧情可以出现**互相庆祝生日**的好事」
 *   「但是她们**就读的学校和学历这一点不能变**」
 *
 * ## 这个套件盯什么
 *   ① **年龄必须是"按当天日期算"的** —— 写死在文本里的岁数过一年就不对了
 *      （而且两个号会越差越多）。这里用**固定的几个日期**验算：
 *      saki 生日 2/14、出生年 2011 ⇒ 2026-02-13 = 14 岁、2026-02-14 = 15 岁、
 *      2027-03-01 = 16 岁。**生日当天就算长了一岁**（这正是最容易被写错的一天）。
 *   ② 同一天里结果**稳定**（不能同一天两个答案）。
 *   ③ ⚠️⚠️ **学校 / 年级 / 学历一个字都不许被这段逻辑碰**（用户补的硬约束）——
 *      所以这里断言 `note()` 的输出里**不含**「羽丘 / 月之森 / 高一 / 高二 / 高三」。
 *      这一条是防"为了做生日把学历一起动了"的。
 *   ④ 数据缺失时**不许炸**（新人设包还没填生日 ⇒ 返回 null / 空串，照跑）。
 *
 * ⚠️ 本套件**只读** `personas/<id>/identity.json`，不写任何 state ⇒ 不会污染真实数据。
 *    （⚠️ 注释里别写带星号的通配路径：**星号紧跟斜杠**会提前结束块注释，
 *      后面的字全被当代码 —— 我在这里连踩两次，第一次就是这么把语法写坏的。）
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, label) => {
  if (ok) console.log(`  ✅ ${label}`);
  else {
    failures++;
    console.log(`  ❌ ${label}`);
  }
};

const bd = await import('../src/birthday.js');

// 固定几个日期来验算（不依赖"今天正好是哪天"，否则套件会随日子变红变绿）
const D = (s) => new Date(`${s}T12:00:00`).getTime();

console.log('\n【1】每个在用的人设包都该有生日（月日合法）');
{
  const want = ['saki', 'anon', 'mortis', 'sakiko-dark'];
  for (const id of want) {
    const o = bd.of(id);
    check(
      !!o && o.month >= 1 && o.month <= 12 && o.day >= 1 && o.day <= 31,
      `${id} 的生日读得出来（${o ? `${o.month} 月 ${o.day} 日` : '⚠️ 没有'}）`,
    );
  }
  // 每人一个生日（两个号不能在同一个包上打转）
  const seen = want.map((id) => bd.of(id)).filter(Boolean).map((o) => `${o.month}-${o.day}`);
  check(new Set(seen).size >= 2, '至少不是所有人都同一天（不然"互相庆祝"没意义）');

  // ⚠️⚠️ 年龄基准要能看出「**从官方故事背景年份反推出生年**」这条推法 ——
  //    用户连着纠正过：「出生年份不对，不是官方设定的年份」→「从官方故事背景的年份反推出生年份」。
  const s = bd.of('saki');
  check(
    !!s?.ageBase && s.ageBase.year > 2000 && s.ageBase.age >= 10 && s.ageBase.age <= 30,
    `年龄基准里有"故事背景年份 + 那时几岁"（${
      s?.ageBase ? `${s.ageBase.year} 年 ${s.ageBase.age} 岁` : '⚠️ 没有'
    }）`,
  );
  for (const id of want) {
    const p = join(ROOT, 'personas', id, 'identity.json');
    if (!existsSync(p)) continue;
    const j = JSON.parse(readFileSync(p, 'utf8'));
    check(j.birthYear === undefined, `${id} 里**没有**自造的 birthYear 字段`);
    const ag = j.age ?? {};
    check(
      !!ag.storyYear && !!ag.atStory && !!ag.bornYear,
      `${id} 的 age 里有 storyYear / atStory / bornYear（年份 → 年龄 → 出生年 三段都在）`,
    );
    check(
      ag.bornYear === ag.storyYear - ag.atStory,
      `${id} 的出生年**确实是从故事背景年份推出来的**（${ag.storyYear} − ${ag.atStory} = ${ag.bornYear}）`,
    );
    check(ag.derived === true, `${id} 标了 derived: true（明说这是推出来的，不是官方原文）`);
  }
}

console.log('\n【2】★★★ 年龄是**按当天日期算**的（不是写死的）');
{
  const m = bd.of('saki');
  if (!m || !m.birthYear) {
    console.log('  ⚠️ saki 没配 birthYear —— 后面这几条跳过');
  } else {
    const bdMD = `${String(m.month).padStart(2, '0')}-${String(m.day).padStart(2, '0')}`;
    // ⚠️ 这里**不写死具体岁数**（故事背景年一改，绝对数字就全错）——只验"关系"：
    //    生日前一天 / 生日当天 / 第二年，必须依次 +1；生日当天就算长了一岁。
    const before = bd.ageOf('saki', D(`2026-02-13`)); // 生日前一天
    const onDay = bd.ageOf('saki', D(`2026-02-14`)); // 生日当天
    const after = bd.ageOf('saki', D(`2027-03-01`)); // 第二年
    check(onDay === before + 1, `生日**当天**就算长了一岁（前一天 ${before} → 当天 ${onDay}）`);
    check(after === onDay + 1, `过一年自动再长一岁（${onDay} → ${after}）`);
    check(after > onDay, '★ 年龄确实**随日期长大**（这就是"真实动态"的含义）');
    // 同一天里必须稳定
    check(
      bd.ageOf('saki', D('2026-06-01')) === bd.ageOf('saki', D('2026-06-01')),
      '同一天里算两次结果一样（不能抖）',
    );
    check(bd.daysUntil('saki', D(`2026-${bdMD}`)) === 0, '★ 生日当天 `daysUntil` = 0');
    check(bd.isToday('saki', D(`2026-${bdMD}`)) === true, '★ 生日当天 `isToday` = true');
  }
}

console.log('\n【3】★★★ 生日逻辑**一个字都不许碰学校 / 年级 / 学历**（用户的硬约束）');
{
  const txt = [
    bd.note(D('2026-02-14'), { selfId: 'saki', peerIds: ['anon'] }),
    bd.note(D('2026-09-08'), { selfId: 'saki', peerIds: ['anon'] }),
    bd.note(D('2026-06-01'), { selfId: 'saki', peerIds: ['anon'] }),
    bd.note(D('2026-02-14'), { selfId: 'anon', peerIds: ['saki'] }),
  ].join('\n');
  for (const w of ['羽丘', '月之森', '高一', '高二', '高三', '初三', '学园']) {
    check(!txt.includes(w), `输出里不出现「${w}」（学校 / 学历归人设说了算，这段只算岁数和生日）`);
  }
  check(!/学校|年级|学历/.test(txt), '也不出现「学校 / 年级 / 学历」这类字眼');
}

console.log('\n【4】生日当天 / 临近，都该说得出话（"互相庆祝"的素材）');
{
  const mine = bd.note(D('2026-02-14'), { selfId: 'saki', peerIds: [] });
  check(/今天是你自己的生日/.test(mine), '★ 自己生日当天：明确告诉她「今天是你自己的生日」');
  // ⚠️ 别写死"15 岁"：故事背景年份一改，具体岁数就变（这里只验"确实给了岁数"）
  check(
    new RegExp(`${bd.ageOf('saki', D('2026-02-14'))} 岁`).test(mine),
    '★ 而且把**算好的岁数**给她（她自己算不准）',
  );

  // 把窗口开大，验证"另一个号快过生日"这条路（真实默认是 14 天）
  const peer = bd.note(D('2026-09-01'), { selfId: 'saki', peerIds: ['anon'], soonDays: 14 });
  check(/爱音/.test(peer) && /还有 7 天/.test(peer), '★ 同类那个号快过生日时，提示词里点出**名字 + 还有几天**');
  check(/别提前说破/.test(peer), '★ 而且要求她别提前说破（留出"悄悄准备"的空间）');

  // ⚠️ 注意：只要"自己"那边拿得到数据，`note()` **总会**给出年龄那一行
  //    （那正是设计要的：她必须知道自己几岁）⇒ "空串"这条只能用**完全没数据**的场景测。
  const none = bd.note(D('2026-06-01'), { selfId: '', peerIds: ['anon'], soonDays: 3 });
  check(none === '', '★ 拿不到自己、别人也没有临近生日时 → **返回空串**（不占提示词字数、也不破坏缓存前缀）');
  const onlyMe = bd.note(D('2026-06-01'), { selfId: 'saki', peerIds: ['anon'], soonDays: 3 });
  check(
    // ⚠️ 同样**不写死岁数**（故事背景年一改就变）
    new RegExp(`${bd.ageOf('saki', D('2026-06-01'))} 岁`).test(onlyMe) && !/爱音/.test(onlyMe),
    '★ 只有自己的年龄要说时，就**不提别人的生日**（别人离得远就不罗列）',
  );
}

console.log('\n【5】数据缺失不许炸（新人设包还没填生日）');
{
  check(bd.of('不存在的包') === null, '不存在的包 → null（不抛异常）');
  check(bd.ageOf('不存在的包', Date.now()) === null, '没出生年 → 年龄 null（不瞎猜）');
  check(bd.note(Date.now(), { selfId: '', peerIds: [] }) === '', '什么都没配 → 空串');
  check(typeof bd.personaIdOfQQ('10000002') === 'string', '`personaIdOfQQ` 读不到也返回字符串（不抛）');
}

console.log('\n【6】人设里**不许再写死岁数**（源头这一条也要守住）');
{
  for (const p of ['personas/saki/persona.md', 'personas/anon/persona.md']) {
    const f = join(ROOT, p);
    if (!existsSync(f)) continue;
    const t = readFileSync(f, 'utf8');
    // 允许出现在"否定的说明"里（比如「别报 15 岁这种具体数字」），但不许是"设定值"
    check(
      !/\|\s*年龄[^|]*\|\s*\**\s*\d{1,2}\s*岁/.test(t),
      `${p} 的「年龄」那一行不再写死岁数`,
    );
    check(/生日/.test(t), `${p} 里有生日这一行`);
  }
  // 模板也要教对人（不然新建的角色又会写死岁数）
  const tpl = join(ROOT, 'personas/_template/persona.md');
  if (existsSync(tpl)) {
    const t = readFileSync(tpl, 'utf8');
    check(!/年龄 \/ 学年 \| （例：15 岁，高一）/.test(t), '模板里那行「年龄 / 学年（例：15 岁）」已经改掉');
    check(/不许写死岁数/.test(t), '★ 模板明确写了「不许写死岁数」');
    check(/生日[\s\S]{0,40}必填/.test(t), '★ 模板把生日标成**必填**（随机事件和剧情要用它）');
  }
}

console.log('\n【7】★★★ 名册里的人也要有生日（日常事件 / 剧情靠它出「互相庆祝」）');
{
  // ## 为什么
  //   用户要的是「随机事件和剧情可以出现**互相庆祝生日**的好事」——
  //   光知道"我自己几岁"没用，得知道**灯哪天过生日**。
  //   名册里的生日写在 `personas/<id>/cast.md`，两种写法：
  //     `- 生日：**11 月 22 日**`（具名角色）/ `> 生日：户山香澄 8/12、…`（整团）。
  const cast = bd.castBirthdays();
  check(cast.length >= 30, `从 cast.md 解析出 ${cast.length} 个角色生日（≥30 才说明两段格式都认了）`);
  check(
    cast.some((c) => c.name === '高松灯' && c.month === 11 && c.day === 22),
    '★ 具名角色那种写法认得出来（高松灯 11/22）',
  );
  check(
    cast.some((c) => /香澄/.test(c.name) && c.month === 8 && c.day === 12),
    '★ 整团那种写法也认得出来（户山香澄 8/12）',
  );

  // 用「灯生日那天」验 life / quest 两段提示词
  const D1122 = D('2026-11-22');
  const life = bd.lifeNote(D1122, { selfId: 'saki' });
  check(/高松灯/.test(life) && /今天是/.test(life), '★ 日常事件那段会点出「今天是高松灯的生日」');
  check(
    /按你和她的关系/.test(life),
    '★★ 而且要求**按关系定分寸** —— 不许一律热络（会演成客服式祝福），也不许当没看见',
  );
  const q = bd.questNote(D1122, { selfId: 'saki' });
  check(/高松灯/.test(q), '★ 剧情那段也带上最近要过生日的人');
  check(/可以用，也可以不用/.test(q), '★★ 剧情里只当**线索**，不是任务（不硬塞桥段）');
  // ⚠️ 2026-10-09 用户点名要的两种桥段（原话：「可以有去对方家里参加生日派对的剧情，
  //    或者送礼物的剧情」）—— 提示词里得**真的写出这些**，否则模型多半只会说句"生日快乐"。
  check(/去对方家里/.test(q), '★★ 剧情那段给了「**去对方家里**参加生日派对」这种桥段');
  check(/礼物/.test(q), '★★ 也给了「**送礼物**」那条（含"准备了但没送出去"）。');
  check(/挑一个/.test(q), '★★ 而且写明"挑一个，别全塞"（四件事挤一段就成了流水账）');
  check(/别提前说破/.test(q), '★★ 惊喜的底线还在：本人不能先知道细节');

  // ⚠️ 硬约束照旧：这两段也不许碰学校 / 学历（用户：「就读的学校和学历这一点不能变」）
  for (const w of ['羽丘', '月之森', '高一', '高二', '高三']) {
    check(!life.includes(w) && !q.includes(w), `生日那两段里不出现「${w}」（学校 / 学历归人设说了算）`);
  }

  // 两段都已经接进 life.js / quest.js（不然上面验得再对也没用）
  const lifeSrc = readFileSync(join(ROOT, 'src', 'life.js'), 'utf8');
  check(/birthday\.lifeNote\(/.test(lifeSrc), '★★★ `src/life.js` 真的调了 `birthday.lifeNote()`（日常事件）');
  const questSrc = readFileSync(join(ROOT, 'src', 'quest.js'), 'utf8');
  check(/birthday\.questNote\(/.test(questSrc), '★★★ `src/quest.js` 真的调了 `birthday.questNote()`（剧情）');
}

console.log(
  '\n【8】★★★ 群友的生日从 QQ 个人资料里取（**好感度 90 以上**才祝贺，@ 他）' +
    '（2026-10-09 用户：「机器人可以直接 @ 那个过生日的人」「还可以对好感度 90 以上群友庆祝生日」' +
    '「日期直接从个人名片那里取」）',
);
{
  const mb = await import('../src/member-birthday.js');

  // ① 协议端给的生日字段格式乱七八糟，几种写法都得认（`''` / `0000-00-00` = 没填）
  for (const [raw, m, d] of [
    ['1998-01-01', 1, 1],
    ['2003/9/8', 9, 8],
    ['01-01', 1, 1],
    ['1/1', 1, 1],
    ['0101', 1, 1],
    ['', null, null],
    ['0000-00-00', null, null],
    ['不知月日', null, null],
  ]) {
    const r = mb.parseBirthday(raw);
    check(
      m === null ? r === null : !!r && r.month === m && r.day === d,
      `生日字段「${raw || '空'}」解析对不对`,
    );
  }

  // ② 存 / 取（隔离文件：`run-all` 会注入 QQBOT_MEMBER_BD_FILE）
  mb.__reset({ '999000001': {} });
  mb.noteList('999000001', [
    { user_id: '10000001', card: '张三', birthday: '1998-10-09' },
    { user_id: '10000002', card: '李四', birthday: '' },
  ]);
  const t1 = mb.today('999000001', { now: D('2026-10-09') });
  check(t1.some((x) => x.name === '张三'), '★ 今天过生日的群友取得出来（名字用群名片）');
  check(!t1.some((x) => x.name === '李四'), '★ 名片里没填生日的人**不会**冒出来');
  check(mb.today('999000001', { now: D('2026-10-10') }).length === 0, '★ 换一天就没人过生日了');

  // ③ 好感度门槛（用户要的"90 以上"）—— 门槛由 `affinity.atOrAbove` 注入
  const t2 = mb.today('999000001', {
    now: D('2026-10-09'),
    minScore: 90,
    atOrAbove: () => [{ userId: '10000002', score: 95 }],
  });
  check(t2.length === 0, '★★ 好感度名单里没有他 ⇒ **不祝贺**（门槛真的在起作用）');
  const t3 = mb.today('999000001', {
    now: D('2026-10-09'),
    minScore: 90,
    atOrAbove: () => [{ userId: '10000001', score: 95 }],
  });
  check(t3.length === 1 && t3[0].score === 95, '★★ 好感度够高 ⇒ 才带上他（顺带记下分数）');

  // ④ 真的接进了主流程（不然上面验得再对也没用）
  const srcBot = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const srcMb = readFileSync(join(ROOT, 'src', 'member-birthday.js'), 'utf8');
  check(/memberBirthday\.noteList\(/.test(srcBot), '★★★ `bot.seedNames()` 顺手从成员资料里取生日（不额外发请求）');
  check(/memberBirthday\.note\(/.test(srcBot), '★★★ 聊天提示词里用的是 `memberBirthday.note()`（和日常事件/剧情同一段文案）');
  check(/minScore = MIN_SCORE/.test(srcMb) && /MIN_SCORE = 90/.test(srcMb), '★★ 门槛写死一处（`MIN_SCORE = 90`）');
  check(/你可以直接 @ 他/.test(srcMb), '★★★ 提示词里明确说**可以直接 @ 那个过生日的人**');
  // ⚠️ 源码里那是**模板字符串里的转义反引号**（`` \`@${p.name}\` ``）⇒ 正则别把反斜杠写死
  check(/@\$\{p\.name\}/.test(srcMb), '★★ 而且教了她写法（`@名字`，发送层会转成真正的 at 段）');
  // ⚠️ 日常事件 / 剧情也得接上群友生日，否则"给群友过生日"永远不会发生（我第一版就漏了这步）
  for (const f of ['life.js', 'quest.js']) {
    const t = readFileSync(join(ROOT, 'src', f), 'utf8');
    check(
      /memberBirthday\.note\(/.test(t),
      `★★★ \`src/${f}\` 也把群友生日拼进了提示词（不然那条路只有聊天里能看到）`,
    );
  }
}

console.log(
  '\n【9】★★★ 生日**只在当天出现**，不提前（2026-10-09 用户给的 反例：' +
    '「后天巴过生日，不知道该送什么」）',
);
{
  // ## 用户要的
  //   「有人生日的话**不用提前几天**出现剧情，**只用当天有**就行了」
  // ## 反例哪来的
  //   三个入口的默认窗口都太宽（聊天 14 天 / 日常 7 天 / 剧情 14 天）⇒
  //   10-09 那天就冒出「后天巴过生日」（宇田川巴 10-11）✗
  // ## 修法
  //   三处默认 `soonDays` 全改成 **0**（= 只当天）✓
  const src9 = readFileSync(join(ROOT, 'src', 'birthday.js'), 'utf8');
  check(!/soonDays = 14/.test(src9), '★★★ 聊天那段不再用 14 天窗口');
  check(!/soonDays = 7/.test(src9), '★★★ 日常事件那段不再用 7 天窗口');
  check(
    (src9.match(/soonDays = 0/g) || []).length >= 3,
    '★★★ 三个入口的默认窗口都是 **0（只当天）**（聊天 / 日常 / 剧情）',
  );

  // 拿用户那个反例当守卫：10-09 时，两天后的宇田川巴**不该**被提起 ✓
  const d = D('2026-10-09');
  const ln = bd.lifeNote(d, { selfId: 'saki' });
  check(!/宇田川巴|还有 2 天|后天/.test(ln), '★★★ 反例守卫：日常事件那段不再说"后天巴过生日"');
  const qn = bd.questNote(d, { selfId: 'saki' });
  check(!/宇田川巴/.test(qn), '★★★ 剧情那段也不提前提人');
  const cn = bd.note(d, { selfId: 'saki', peerIds: ['anon'] });
  check(!/还有 2 天/.test(cn), '★★★ 聊天提示词那段同样不提前（只当天说"今天谁生日"）');
}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
