/**
 * 「分群调节」测试（2026-09-16）。
 *
 * ## 用户要求（原话）
 *
 *   「把**日常事件的节奏设置**和**二级事件的参数**也加一个**下拉群菜单**分群调节，
 *     注意修改的参数**一定要能真正保存**，而且能在 webui 上**马上看到变化**，
 *     **不同群的数据一定不要混在一起**了」
 *
 * ## 这个套件盯的就是那三句话
 *
 * | 要求 | 这里怎么钉 |
 * | --- | --- |
 * | 参数要**真保存**（存了就得生效） | `life.js` / `quest.js` 内部**一律走 `paramsFor(kind, 群号)`**；`config.js` 对 `groupParams` 做**白名单 + 数值化**（"3" → 3，垃圾丢掉） |
 * | 不同群的**数据不能混** | 每个群**一个状态桶**（`state/life.json` 的 `byGroup`）：A 群发过一条不影响 B 群；老格式会**迁移**且不重复发 |
 * | webui 上**马上看到变化** | 界面拿 `GET /api/group-params?groupId=` 回读"现在生效的值"；`GET /api/life/status?groupId=` 看这个群今天的进度 |
 *
 * ⚠️ 纯单元测试：不起机器人、不连 NapCat、不花钱（状态文件都指到 `logs/`）
 *
 * 用法: node test/group-params.js
 */
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });

const CFG_REL = 'logs/__test-groupparams.yml';
const LIFE_REL = 'logs/__test-groupparams-life.json';
const QUEST_REL = 'logs/__test-groupparams-quest.json';
const STORY_REL = 'logs/__test-groupparams-story.json';

// A 群：每天 1 条、剧情每周 1 次；B 群：每天 5 条、剧情每周 9 次
const GA = '200000001';
const GB = '200000002';
const makeCfg = (extra = []) => [
  'llm:',
  '  baseURL: http://127.0.0.1:1/v1',
  '  apiKey: "sk-test"',
  '  model: test-model',
  'life:',
  '  enable: true',
  '  minPerDay: 3',
  '  maxPerDay: 3',
  '  startHour: 7',
  '  endHour: 24',
  '  cooldownMs: 5400000',
  '  lateToleranceMs: 1800000',
  'quest:',
  '  enable: true',
  '  chance: 0.1',
  '  maxPerWeek: 3',
  '  waitMs: 1800000',
  '  replyMode: normal',
  'trigger:',
  '  allowGroups:',
  `    - "${GA}"`,
  `    - "${GB}"`,
  '  groupRespondTo:',
  `    "${GA}": 1`,
  `    "${GB}": 1`,
  'groupParams:',
  `  "${GA}":`,
  '    life:',
  '      minPerDay: 1',
  '      maxPerDay: 1',
  '    quest:',
  '      maxPerWeek: 1',
  '      replyMode: strict',
  `  "${GB}":`,
  '    life:',
  '      minPerDay: 5',
  '      maxPerDay: 5',
  '    quest:',
  '      maxPerWeek: 9',
  ...extra,
  '',
].join('\n');

writeFileSync(join(ROOT, CFG_REL), makeCfg(), 'utf8');
process.env.QQBOT_CONFIG = CFG_REL;
process.env.QQBOT_LIFE_FILE = LIFE_REL;
process.env.QQBOT_QUEST_FILE = QUEST_REL;
process.env.QQBOT_STORYLINE_FILE = STORY_REL;
for (const f of [LIFE_REL, QUEST_REL, STORY_REL]) rmSync(join(ROOT, f), { force: true });

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const life = await import('../src/life.js');
const quest = await import('../src/quest.js');
const { config, paramsFor, reloadConfig } = await import('../src/config.js');

/** 当天几点几分的时间戳 */
function at(h, m = 0, dayOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}
const rng = () => 0.5;

console.log('\n【1】★ 两套参数各读各的（`paramsFor` 是唯一入口）');
{
  check(paramsFor('life', GA).maxPerDay === 1, 'A 群：每天最多 1 条', String(paramsFor('life', GA).maxPerDay));
  check(paramsFor('life', GB).maxPerDay === 5, 'B 群：每天最多 5 条', String(paramsFor('life', GB).maxPerDay));
  check(
    paramsFor('life', GA).cooldownMs === config.life.cooldownMs,
    'A 群没覆盖的项（间隔）→ 自动继承全局',
  );
  check(paramsFor('quest', GA).maxPerWeek === 1, 'A 群：剧情每周 1 次');
  check(paramsFor('quest', GB).maxPerWeek === 9, 'B 群：剧情每周 9 次');
  check(paramsFor('quest', GA).replyMode === 'strict', 'A 群：群友回复判定用严格档');
  check(paramsFor('quest', GB).replyMode === 'normal', 'B 群没覆盖 → 继承全局');
  // ⚠️ 模块自己的读法（不是我在测试里手算的）
  check(quest.params(GA).maxPerWeek === 1, '★ `quest.params(群号)` 就是那套参数');
}

console.log('\n【2】★ 日常事件：每个群各排各的（条数不混）');
{
  life.__clear();
  const pA = life.plan(at(12, 0), rng, GA);
  const pB = life.plan(at(12, 0), rng, GB);
  check(life.status(GA).target === 1, '★ A 群今天的目标 = 1（用它自己的参数）', String(life.status(GA).target));
  check(life.status(GB).target === 5, '★ B 群今天的目标 = 5', String(life.status(GB).target));
  check(pA.fire === true || pA.reason === '还没到点', `A 群排程正常：${pA.reason || '到点'}`);
  check(pB.fire === true || pB.reason === '还没到点', `B 群排程正常：${pB.reason || '到点'}`);
}

console.log('\n【3】★★ A 群发过一条，**不影响** B 群（数据不混）');
{
  const t = at(12, 30);
  life.commit(
    { slot: '中午', template: { text: '测试事件', w: 2, tags: [] } },
    '测试事件',
    t,
    { groupId: GA, groups: [GA], skipStoryline: true },
  );
  check(life.status(GA).fired === 1, 'A 群今天已发 1 条', String(life.status(GA).fired));
  check(life.status(GB).fired === 0, '★★ B 群今天**还是 0 条**', String(life.status(GB).fired));
  check(life.todayPlan(GA).remaining === 0, 'A 群配额用完（1/1）');
  check(life.todayPlan(GB).remaining === 5, 'B 群还剩 5 条');
  // 落盘里也必须是两个桶
  const j = JSON.parse(readFileSync(join(ROOT, LIFE_REL), 'utf8'));
  check(!!j.byGroup?.[GA] && !!j.byGroup?.[GB], '★ 落盘是 `byGroup` 两个桶（不是一份全局状态）');
  check(j.byGroup[GA].fired === 1 && j.byGroup[GB].fired === 0, '两个桶的数各是各的');
}

console.log('\n【4】★ 按群关掉日常事件（只关这一个群）');
{
  config.groupParams[GA].life = { ...config.groupParams[GA].life, enable: false };
  check(life.plan(at(13, 0), rng, GA).fire === false, 'A 群关掉 → 不发');
  check(/没开/.test(life.plan(at(13, 0), rng, GA).reason), '原因说清了"没开"');
  check(life.targetGroups().includes(GB), '★ B 群还在收日常事件（没被连累）');
  check(!life.targetGroups().includes(GA), 'A 群从"收日常事件的群"里去掉');
  config.groupParams[GA].life = { minPerDay: 1, maxPerDay: 1 }; // 还原
  check(life.targetGroups().includes(GA), '还原之后 A 群又回来了');
}

console.log('\n【5】★★ 「参数一定要能真正保存」：白名单 + 数值化');
{
  // 模拟"界面传上来的是字符串/垃圾"（真保存下去的话，必须是能参与计算的数）
  writeFileSync(
    join(ROOT, CFG_REL),
    [
      'llm:',
      '  baseURL: http://127.0.0.1:1/v1',
      '  apiKey: "sk-test"',
      '  model: test-model',
      'life:',
      '  minPerDay: 3',
      '  maxPerDay: 3',
      'quest:',
      '  maxPerWeek: 3',
      'trigger:',
      '  allowGroups:',
      `    - "${GA}"`,
      `    - "${GB}"`,
      '  groupRespondTo:',
      `    "${GA}": 1`,
      `    "${GB}": 1`,
      'groupParams:',
      `  "${GB}":`,
      '    life:',
      '      minPerDay: "2"', // 字符串 → 要变成数字 2
      '      maxPerDay: "abc"', // 垃圾 → 要丢掉（退回全局）
      '      cooldownMs: "600000"',
      '    quest:',
      '      chance: 5', // 越界 → 夹到 1
      '      maxPerWeek: "4"',
      '    chat:',
      '      strictness: "150"', // 越界 → 夹到 100
      '',
    ].join('\n'),
    'utf8',
  );
  reloadConfig();
  const L = paramsFor('life', GB);
  const Q = paramsFor('quest', GB);
  const C = paramsFor('chat', GB);
  check(L.minPerDay === 2, '★ 字符串 "2" → 数字 2（能真正参与计算）', String(L.minPerDay));
  check(L.maxPerDay === config.life.maxPerDay, '★ 垃圾 "abc" 被丢掉 → 退回全局', String(L.maxPerDay));
  check(L.cooldownMs === 600000, '字符串毫秒也认');
  check(Q.chance === 1, '★ 越界的概率 5 → 夹到 1');
  check(Q.maxPerWeek === 4, '字符串 "4" → 数字 4');
  check(C.strictness === 100, '★ 越界的收紧度 150 → 夹到 100');
  // ⚠️ 存的不该是字符串（否则"存了但不生效"）
  check(
    typeof config.groupParams[GB].life.minPerDay === 'number',
    '★ 落进 config 的就是数字类型（不是 "2"）',
    typeof config.groupParams[GB].life.minPerDay,
  );
  // 恢复成【1】那份配置，免得影响后面的用例
  writeFileSync(join(ROOT, CFG_REL), makeCfg(), 'utf8');
  reloadConfig();
}

console.log('\n【6】★★ 老格式（一份全局状态）→ 迁移到分群，而且**不重复发**');
{
  for (const f of [LIFE_REL]) rmSync(join(ROOT, f), { force: true });
  // 老格式：顶层直接是那一份状态（分群之前的写法）
  writeFileSync(
    join(ROOT, LIFE_REL),
    JSON.stringify(
      { day: new Date().toISOString().slice(0, 10), target: 6, fired: 2, lastFireAt: at(10, 0), nextAt: 0, recent: [] },
      null,
      2,
    ),
    'utf8',
  );
  life.__reloadState();
  check(!!life.status(GA).day, 'A 群桶建出来了');
  check(
    life.status(GA).fired === 2 && life.status(GB).fired === 2,
    '★★ 1 档群**继承了今天的进度**（不会因为迁移又发一轮）',
    `A ${life.status(GA).fired} / B ${life.status(GB).fired}`,
  );
  check(life.status(GA).target > 0, '目标条数也带过来了（之后按各群配置夹取）');
  const backups = readFileSync(join(ROOT, LIFE_REL), 'utf8');
  check(/byGroup/.test(backups), '★ 迁移之后落盘就是分群格式');
}

console.log('\n【7】代码层：别再退回"读全局那一份"');
{
  const src = readFileSync(join(ROOT, 'src', 'life.js'), 'utf8');
  check(/paramsFor\('life', gid\)/.test(src), '★ life.js 用 `paramsFor(\'life\', 群号)` 读参数');
  check(
    !/num\(cfg\(\)\.minPerDay/.test(src) && !/num\(cfg\(\)\.cooldownMs/.test(src),
    '★ 排程里不再直接读全局 `config.life`（读了分群就白设）',
  );
  check(/byGroup/.test(src) && /bucketOf\(/.test(src), '★ 状态是按群分桶的');
  const q = readFileSync(join(ROOT, 'src', 'quest.js'), 'utf8');
  check(/cfgFor\(/.test(q) && /paramsFor\('quest'/.test(q), '★ quest.js 同样是按群读参数');
  const idx = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8');
  check(/life\.plan\(Date\.now\(\), Math\.random, g\)/.test(idx), '★ 定时器**挨个群问**（不是问一次发所有群）');
  check(/quest\.params\(g\)/.test(idx), '★ 掷骰用那个群的概率');
  const html = readFileSync(join(ROOT, 'src', 'webui.html'), 'utf8');
  check(/id="gp-group"/.test(html), '★ 界面上有**下拉群菜单**（gp-group）');
  check(/gp-life-min|gp-life-cool/.test(html), '★ 日常事件的节奏也能按群设');
  check(/gp-quest-wait|gp-quest-stages/.test(html), '★ 二级剧情的参数也能按群设');
  check(/fillGroupParams\(\)/.test(html), '★ 保存后回读（"马上看到变化"）');
}

console.log(
  failures === 0
    ? '\n结果: 全部通过 ✅（参数分群生效、数据各是各的、保存的一定是有效数字）\n'
    : `\n结果: ${failures} 项失败 ❌\n`,
);
try {
  for (const f of [LIFE_REL, QUEST_REL, STORY_REL]) rmSync(join(ROOT, f), { force: true });
} catch {}
process.exit(failures === 0 ? 0 : 1);
