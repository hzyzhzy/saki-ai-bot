/**
 * 「她吃了没」状态机测试（2026-09-17）。
 *
 * 用户原话：「可以加个**吃饭的状态机**，有什么影响吃饭的事件会被计入，
 *   下次有人喊她，他自己就知道**吃过没有了**，然后她**吃饭的时长可以设定为 10 分钟**」。
 *
 * ⚠️ 这个套件里最该盯死的是【2】：**问句不算**。
 *    `note()` 的调用点在"她发出去之后"，所以群友的问句不会进来；
 *    但她**自己**也可能回一句「你吃了吗？」—— 第一版没挡，那一句会把她的状态
 *    改成"正在吃饭"，然后她就一本正经地跟人说"我正在吃"。
 *
 * 用法: node test/meal.js
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });

// ⚠️ 两个环境变量必须在 import `src/*` **之前**设好
//    （`config.js` / `meal.js` 都是模块加载时就初始化）
const CFG_REL = 'logs/__test-meal.yml';
const MEAL_FILE_REL = 'logs/__test-meal-state.json';
writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
    '  apiKey: "sk-test"',
    '  model: test-model',
    'meal:',
    '  enable: true',
    '  minutes: 10',
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;
process.env.QQBOT_MEAL_FILE = MEAL_FILE_REL;

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const MEAL_PATH = join(ROOT, MEAL_FILE_REL);
rmSync(MEAL_PATH, { force: true });

const meal = await import('../src/meal.js');
const { config } = await import('../src/config.js');

const fresh = () => {
  meal.__clear();
  meal.reload();
};

console.log('\n【1】她说「去吃饭」→ 正在吃，寿命 10 分钟');
{
  fresh();
  check(meal.current().status === 'none', '一开始是"没在吃"');
  check(meal.note('我先去吃饭了，回头聊', '测试') === true, '记账成功');
  const s = meal.current();
  check(s.status === 'eating', `状态 = 正在吃（${s.status}）`);
  check(s.until - s.at === 10 * 60 * 1000, '★ 寿命正好 10 分钟（用户拍板）');
}

console.log('\n【2】★ 问句不算 —— 她在问别人，不是在报自己的状态');
{
  fresh();
  check(meal.note('你吃了吗？') === false, '★ 「你吃了吗？」不算');
  check(meal.current().status === 'none', '状态没被改');
  check(meal.note('吃饭了没呢') === false, '★ 「吃饭了没呢」也不算（"吃饭了"在词表里，全靠问句闸挡住）');
  check(meal.current().status === 'none', '状态仍然没变');
  check(meal.hint() === '', '所以也不会往提示词里塞东西');
}

console.log('\n【3】★ 到点自动算吃完（这就是"时长 10 分钟"的意思）');
{
  fresh();
  meal.note('去吃饭了');
  check(meal.current().status === 'eating', '先是正在吃');
  // ⚠️ 不真等 10 分钟：把 until 往前挪，再 reload
  const j = JSON.parse(readFileSync(MEAL_PATH, 'utf8'));
  j.until = Date.now() - 1000;
  writeFileSync(MEAL_PATH, JSON.stringify(j), 'utf8');
  meal.reload();
  const s = meal.current();
  check(s.status === 'done', '★ 到点了 → 自动变成"吃过了"');
  check(readFileSync(MEAL_PATH, 'utf8').includes('"done"'), '而且**落盘**了（不是只在内存里变）');
}

console.log('\n【4】明说吃完 / 不吃，也要接得住');
{
  fresh();
  meal.note('吃完了，撑死我了');
  check(meal.current().status === 'done', '「吃完了」→ 吃过了');
  fresh();
  meal.note('不吃了，减肥');
  check(meal.current().status === 'none', '「不吃了」→ 没在吃');
  fresh();
  // ⚠️ 判据顺序：`done` 必须在 `eating` 前面 —— 「刚吃完了」里两个词表都有命中点
  meal.note('刚吃完了');
  check(meal.current().status === 'done', '★ 「刚吃完了」判成"吃过了"（不是"正在吃"）');
}

console.log('\n【5】提示词里怎么告诉她（光报状态没用，得有指令）');
{
  fresh();
  check(meal.hint() === '', '没在吃也没吃过 → 一个字都不注入（不白占提示词）');
  meal.note('去吃饭了');
  const h = meal.hint();
  check(/正在吃饭/.test(h), '正在吃 → 提示里写了');
  check(/别又答应一顿/.test(h), '★ 给了行为指令（别又答应一顿）');
  check(/照样答/.test(h), '⚠️ 但说明"别的正事照样答"（别把吃饭当万能借口）');
  fresh();
  meal.note('吃完了');
  const h2 = meal.hint();
  check(/已经吃过饭/.test(h2), '吃过 → 提示里写了');
  check(/别再答应吃一顿/.test(h2), '★ 同样给了指令');
  check(/下一顿/.test(h2), '★ 但留了余地：明说是下一顿时正常答应');
}

console.log('\n【6】重启还记得（落盘 + 模块加载时恢复）');
{
  fresh();
  meal.note('刚吃完了');
  check(existsSync(MEAL_PATH), '写了 state 文件');
  // ⚠️ 用干净子进程验"加载即有记录" —— 只 grep 源码的话，把 reload() 挪进别的函数也能骗过
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(
    process.execPath,
    ['-e', `const m = await import('./src/meal.js'); console.log(JSON.stringify(m.current()));`, '--input-type=module'],
    { cwd: ROOT, env: { ...process.env, QQBOT_MEAL_FILE: MEAL_FILE_REL }, encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .pop();
  check(JSON.parse(out).status === 'done', '★ 新进程一加载就读到了"吃过了"');
}

console.log('\n【7】★ 不能污染真实状态文件 / 开关能关');
{
  const real = join(ROOT, 'state', 'meal.json');
  check(meal.path() !== real, `测试用的不是真实 state/meal.json（${meal.path().split(/[\\/]/).pop()}）`);
  check(process.env.QQBOT_MEAL_FILE === MEAL_FILE_REL, '走的是 QQBOT_MEAL_FILE');

  fresh();
  const before = config.meal.enable;
  config.meal.enable = false;
  check(meal.note('去吃饭了') === false, 'enable=false → 不记账');
  check(meal.hint() === '', 'enable=false → 不注入（回到改动前的行为）');
  config.meal.enable = before;
}

console.log('\n【8】status() 给管理界面看');
{
  fresh();
  meal.note('去吃饭了');
  const s = meal.status();
  check(s.status === 'eating' && s.enable === true, `状态 + 开关都给了（${s.status} / ${s.enable}）`);
  check(s.minutes === 10, `时长也给了（${s.minutes} 分钟）`);
  check(s.leftMs > 0 && s.leftMs <= 10 * 60 * 1000, `剩余时间算得出（${Math.round(s.leftMs / 1000)} 秒）`);
}

console.log('\n【9】★★ 记下「吃了什么」（用户 2026-09-18 要求）');
{
  fresh();
  meal.note('我下楼吃碗牛肉面');
  const s = meal.status();
  check(s.what === '我下楼吃碗牛肉面', '★★ 原话存下来了', JSON.stringify(s.what));
  check(/牛肉面/.test(meal.hint()), '★★ 提示词里带上了"吃了什么"（不然群友问她只能现编）');
  check(/别另编一个/.test(meal.hint()), '提示词里明确写了"别另编一个"');
}

console.log('\n【10】★★ 状态最多留 2 天（用户：「吃饭状态保留两天的就行了」）');
{
  fresh();
  meal.note('我吃过了');
  const now = Date.now();
  check(
    meal.current(now + 36 * 3600 * 1000).status === 'done',
    '一天半之后还记得（还在保留期内）',
  );
  const gone = meal.current(now + 3 * 24 * 3600 * 1000);
  check(gone.status === 'none', '★★ 三天后**忘掉**（当没吃）', gone.status);
  check(gone.what === '', '★★ 连"吃了什么"一起忘掉');
  check(meal.hint(now + 3 * 24 * 3600 * 1000) === '', '★★ 忘掉之后提示词里也不再提');
  check(meal.DEFAULT_KEEP_DAYS === 2, '默认保留 2 天');
}

console.log('\n【11】★★ 宽松判据（用户：「放宽吧」）');
{
  // ✅ 用户举的那类说法：以前**一个都不命中**（关键词表里没有"楼下吃"）
  const yes = ['我去楼下吃碗牛肉面', '出门吃点东西', '去食堂随便吃点', '马上吃饭了'];
  let okAll = true;
  for (const s of yes) {
    fresh();
    meal.note(s);
    if (meal.status().status !== 'eating') {
      okAll = false;
      console.log(`      （漏了：「${s}」）`);
    }
  }
  check(okAll, '★★ 这些说法现在都认得出"正在吃"', yes.join(' / '));

  // ❌ 但"吃×"不是吃饭 —— **一个字都不许记**
  const no = ['今天吃瓜吃爽了', '我好吃惊', '别让我吃亏', '这瓜吃得真香'];
  let cleanAll = true;
  for (const s of no) {
    fresh();
    meal.note(s);
    if (meal.status().status !== 'none') {
      cleanAll = false;
      console.log(`      （误记了：「${s}」）`);
    }
  }
  check(cleanAll, '★★ "吃×"（吃瓜 / 吃惊 / 吃亏）一个字都不许记', no.join(' / '));

  // ⚠️ 否定必须排在"正在吃"前面
  fresh();
  meal.note('我还没吃饭');
  check(meal.status().status === 'none', '★★ 「还没吃饭」记成"没在吃"（不是"正在吃"）');
  fresh();
  meal.note('今天不吃了');
  check(meal.status().status === 'none', '「不吃了」也是"没在吃"');
  fresh();
  meal.note('刚吃完了');
  check(meal.status().status === 'done', '「刚吃完了」还是"吃过了"（done 最优先）');
}

try {
  rmSync(MEAL_PATH, { force: true });
  rmSync(join(ROOT, CFG_REL), { force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
