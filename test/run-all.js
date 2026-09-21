/**
 * 并行跑所有回归测试。
 *
 * ⚠️ 为什么需要（2026-09-13，用户反馈「跑回归时间太长了」）：
 *    9 个测试套件串行跑要 **287 秒**（4.8 分钟），而其中
 *    **127 秒是各测试里固定的 `sleep()`**（"睡 3.5 秒等机器人回复"那种），
 *    剩下的是 9 次 node 启动开销。
 *
 *    **它们互不干扰** —— 每个测试用**自己独立的端口区间**（实测无冲突）：
 *      e2e 39001-39002 / cs 39101-39104 / teach 39501-39502
 *      face 39601-39602 / webui 39701 / attitude 39801-39802
 *      behavior 40001-40002 / natural-teach 40101-40102
 *    所以那些 `sleep` 可以**并行地等**，总时间由最慢的那个决定。
 *
 * 用法：
 *   node test/run-all.js            # 默认 5 个并行
 *   node test/run-all.js --jobs 8   # 指定并行数
 *   node test/run-all.js --jobs 1   # 退化成串行（排查用）
 *
 * 输出：每个套件一行（耗时 + 结果），最后给总耗时和失败清单。
 */
import { spawn } from 'node:child_process';
import { readdirSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** 回归套件（顺序无关，各用独立端口） */
const SUITES = [
  'behavior',
  'attitude',
  'face',
  // ⚠️ 2026-09-20 加：解题模式判据（「带图 + 短消息」那条踩过两次 —— 见 test/solve.js 头注释）
  'solve',
  'webui',
  'cs',
  'teach',
  'learned-edit',
  'spend',
  'earn-prompt',
  'balance',
  'affinity',
  'qzone',
  'observe-compress',
  'monthly-report',
  'context',
  'presearch',
  'bilibili-scope',
  // ⚠️ 2026-09-15 加：对话状态机（他/别人/没在聊三态 + 喂给说话判断的那段状态）
  'dialogue',
  // ⚠️ 2026-09-15 加：掉线补看（10 分钟内的 @ / 关键词 / 服务器问题，三道防重闸）
  'catchup',
  // ⚠️ 2026-09-15 晚加：引用（引用她 = 直接对她说话；她上次说话隔 ≥4 条就要引用；
  //    引用够了不许再补 @；余额见底那条的 @ 不许动）
  'quote',
  // ⚠️ 2026-09-15 晚加：知识库**分群**（群资料库只给那个群；共享文件的「群标签块」按群生效；
  //    二次元库仍然全局可用）
  'knowledge-groups',
  // ⚠️ 2026-09-15 晚加：好友/好感度接线（到线通知只发一次 + 被回应加分 + `/好感度` 出榜）。
  //    它一直在仓库里但**没进过回归名单**（用户要求加进来）。
  'friend',
  'follow-up',
  'tic',
  'meal',
  // ⚠️ 2026-09-18：「她人在哪 / 在做什么」的状态机（跟 meal 同一类东西）
  'where',
  // ⚠️ 2026-09-18：「几点提醒我干什么」的定时提醒（记下来 / 到点 @ 他 / 找不到的人不 @）
  'remind',
  'cooldown',
  // ⚠️ 2026-09-16 加：连发碎片自动续窗（「你/可/以/一/个/一/个/字/说/话/吗」那种一个字一条
  //    的消息，整串当成一句话只回一次；私聊也走合并；正常消息与 @她 的短窗口没被拖慢）
  //    顺带钉住「一个字一条」的回复彩蛋（她可以一个字一个气泡回；私聊随便玩、
  //    群里只在 @她/引用她 时，最多 8 个字，同会话 30 分钟一次）
  'burst',
  // ⚠️ 2026-09-16 加：戳一戳交给模型回（不再随机挑那四句写死的；进上下文、进记忆；
  //    戳=明确召唤；防刷屏冷却与文字兜底都还在）
  'poke',
  // ⚠️ 2026-09-16 加：喊妈妈（第一次拒绝；还喊就认了并切白祥模式；按群、落盘、能退出；
  //    别误伤「我妈/你妈的/妈呀」）
  'mama',
  // ⚠️ 2026-09-16 加：分群调节（日常事件的节奏 + 二级剧情的参数都按群；
  //    参数白名单/数值化"存了必须生效"；状态按群分桶"不同群的数据不混"；老格式迁移）
  'group-params',
  // ⚠️ 2026-09-16 加：这个点她在哪（上学日白天在教室、放学后才到客服室；
  //    不许说"坐了一天"、不许凭空放假 —— 用户截图报的人设/时间表冲突）
  'schedule',
  'join-scope',
  'at-other',
  'tone',
  'watchdog-state',
  'qq-qrcode',
  'provider',
  // ★ 开机自启：唯一一个会写**用户注册表**的功能 —— 盯"真写进去了 / 换了目录认得出 /
  //   关得掉"（值名走 QQBOT_AUTOSTART_VALUE，绝不碰用户真实的 SakiBot 那一项）
  'autostart',
  // ★ 跟群友要钱：真事故（「能收啊，你要发？」）—— 那是个**真 QQ 号**，收到就是真钱。
  //   纯单元、不起进程；【2】那组反例和【1】一样重要（拦错了＝她突然不说话，更难查）
  'money',
  // ★ 有人在骂她 → 好感度 -2（用户 2026-09-17：「不能每次和她说话都是加…
  //   而且减2，因为加上来很容易」）。纯单元；【2】那组"不许误判"比【1】更重要 ——
  //   误伤表现为"一个老群友被莫名冷落"，他自己根本不知道哪儿错了。
  'insult',
  // ★ 私聊记忆（用户 2026-09-17）：「私聊也应该和群里一样记下性格和事件」
  //   +「私聊和群用一套资料库」。盯两件事：① 私聊归到**他共有的那个群**（不分裂成两份）
  //   ② 查不到共有群时**绝不能掉进共享的 group-memory.md**（那文件所有群都看得到）
  'dm-memory',
  // ★ 复读机：群里刷同一句话时她也跟一句 +1（用户 2026-09-17 要求）。
  //   重点盯两条：①「有人打断 → 链断，不会接着接」②「一条链只接一次」
  'repeat',
  'storyline',
  'life',
  'holiday',
  'quest',
  'outbox',
  'napcat-recover',
  'punctuation',
  'e2e',
  'natural-teach',
  'sensitivity',
];

/** 已知的、用户明确说过不用修的项目（不算失败） */
const KNOWN_OK_FAILURES = ['上下文里有前面那句「我刚买了 OP」', '当前消息没有重复出现在上下文里'];

const args = process.argv.slice(2);
const jobsArg = args.indexOf('--jobs');
/**
 * 默认并发 = **2**。
 *
 * ⚠️ 2026-09-13 从 5 改成 2：并发 5 时有几套会**间歇性失败**，而且每次挂的项不一样
 *    （e2e 的「私聊消息得到回复」、sensitivity 的「小祥会冒泡」、cs 的在线名单…）。
 *    单独跑 / 并发 2 跑都全绿 —— 是假 MC、假模型、假 NapCat 一起抢 CPU 导致的超时，
 *    **不是代码问题**，但会让我每次都被假警报牵着走，浪费很多时间去查不存在的 bug。
 *
 *    实测：并发 2 → 12/12 全绿（154 秒）；并发 3 → sensitivity 偶发挂（125 秒）；
 *    并发 5 → 常有 1~2 套挂（100 秒）。回归**绿**比快 50 秒重要。
 *    想快点就自己传 `--jobs 5`，但要知道那点失败是噪音。
 */
const jobs = Math.max(
  1,
  Number(jobsArg >= 0 ? args[jobsArg + 1] : 0) || 2,
);

/**
 * ⚠️⚠️ **每个套件都发一份隔离的 state 路径**（2026-09-15 加，是个真 bug 的修法）。
 *
 * 踩到的：`test/behavior.js` **不设** `QQBOT_STORYLINE_FILE` / `QQBOT_AFFINITY_FILE`，
 * 而它 import 了 `bot.js`（bot.js 又 import 了 storyline / affinity / friend）——
 * 于是那几套的 `noteInteraction()` 直接**写进了真实的 `state/*.json`**。
 *
 * 证据（真实文件里翻出来的）：
 *   · `state/affinity.json` 里有个 `u30003`，note 是「回应了她」—— **30003 是测试用的 QQ 号**
 *   · `state/storyline.json` 里有 `路人说：那我现在去试试` —— **这句台词在 behavior.js 里**
 *
 * 后面的套件自己设了环境变量（覆盖这份默认值），所以这里给**默认值**就能一次盖住全部 33 套。
 * ⚠️ 加新套件时不用管 —— 不设就是这份隔离路径，不会再碰真实文件。
 */
function isolatedStateEnv(name) {
  const safe = String(name).replace(/[^\w.-]/g, '_');
  const p = (what) => `logs/__run-${safe}-${what}.json`;
  return {
    // ⚠️ 故意**不动 `QQBOT_CONFIG`** —— 指向一个不存在的文件会让 config.js 拿不到配置。
    //    哪个套件要自己的配置就自己设（它们本来就会设）。
    QQBOT_SPEND_FILE: p('spend'),
    QQBOT_SPEND_BASE: p('spendbase'),
    QQBOT_BALANCE_FILE: p('balance'),
    QQBOT_MONTHLY_FILE: p('monthly'),
    QQBOT_TIC_FILE: p('tic'),
    QQBOT_MEAL_FILE: p('meal'),
    // ⚠️ 2026-09-18：不加这条，`test/where.js` 就会去写真实的 `state/where.json`
    QQBOT_WHERE_FILE: p('where'),
    // ⚠️ 2026-09-18：定时提醒也会落盘（"重启不能忘"），同样要各写各的
    QQBOT_REMIND_FILE: p('remind'),
    // ⚠️ 2026-09-17：`recent.js` 也会落盘了（"重启不丢上下文"）——
    //    套件必须各写各的，否则会互相串、也会污染真实的 state/recent.json
    QQBOT_RECENT_FILE: p('recent'),
    QQBOT_QZONE_FILE: p('qzone'),
    QQBOT_DIGEST_FILE: p('digest'),
    QQBOT_AFFINITY_FILE: p('affinity'),
    QQBOT_OBSERVE_FILE: p('observe'),
    QQBOT_STORYLINE_FILE: p('story'),
    QQBOT_LIFE_FILE: p('life'),
    QQBOT_QUEST_FILE: p('quest'),
    QQBOT_FRIEND_FILE: p('friend'),
    QQBOT_OUTBOX_FILE: p('outbox'),
    // ⚠️ 2026-09-15 加：QQ号→名字（群名片/昵称）那张表。
    //    不隔离的话，测试跑起来会往**真实的** `state/names.json` 里塞假名字。
    QQBOT_NAMES_FILE: p('names'),
    // ⚠️ 2026-09-16 加：「喊妈妈」的计数与白祥模式状态（`state/mama.json`）。
    //    不隔离的话，测试里那些假群友只要说一句带"妈"的话，
    //    就会往**真实的**状态里记一笔（甚至把真群切进白祥模式）。
    QQBOT_MAMA_FILE: p('mama'),
    // ⚠️ 这条**一定不能漏**：漏了的话测试跑起来会往真实的
    //    `state/napcat-restart.request` 写条子 → 看门狗真去重启协议端。
    QQBOT_NAPCAT_REQ_FILE: p('napcatreq'),
  };
}

/**
 * ⚠️⚠️ **每个套件也发一份隔离的 `knowledge/` 副本**（2026-09-15，用户要求「隔离」）。
 *
 * 踩到的：`isolatedStateEnv()` 只管 `state/*.json`，**knowledge/ 一直是共用的真实目录**。
 * 而至少有 **五个**套件会真的去写它（都是靠"先备份、跑完还原"）：
 *   `webui` / `learned-edit` / `teach` / `natural-teach` / `observe-compress`
 *
 * 证据（跑一轮回归后 `knowledge/_backup/` 里多出来的）：
 *   10:31:44 persona.md / 10:31:46 learned.md / 10:31:52 learned.md
 *   10:32:25 learned.md / 10:32:40 learned.md
 *
 * 核过哈希：**目前没坏**（内容和跑之前逐字节一致）。但**只要套件中途崩一次**，
 * 真实的 `persona.md`（6.8 万字，攒了很多天）就会留在测试内容上。
 *
 * 做法：给每个套件复制一份 `knowledge/*.md`，用 `QQBOT_KNOWLEDGE_DIR` 指过去
 * （见 `config.js` 的 `KNOWLEDGE_DIR`；那 9 个用到 knowledge 的模块都从那儿拿路径）。
 * ⚠️ 只复制**顶层的 .md** —— 加载器只读那些；`_backup/` 建个空目录就行，别把历史备份也拷一遍。
 */
function isolatedKnowledgeDir(name) {
  const safe = String(name).replace(/[^\w.-]/g, '_');
  const rel = `logs/__know-${safe}`;
  const abs = join(ROOT, rel);
  try {
    rmSync(abs, { recursive: true, force: true });
    mkdirSync(abs, { recursive: true });
    for (const f of readdirSync(join(ROOT, 'knowledge'))) {
      if (!f.toLowerCase().endsWith('.md')) continue;
      copyFileSync(join(ROOT, 'knowledge', f), join(abs, f));
    }
    mkdirSync(join(abs, '_backup'), { recursive: true });
    return rel;
  } catch (e) {
    console.warn(`  ⚠️ 给 ${name} 准备 knowledge 副本失败：${e.message}`);
    return null;
  }
}

/**
 * 跑一个套件，返回 { name, sec, result, fails, timedOut }
 *
 * ⚠️ 用 stdout 管道收集 —— 实测这个沙箱允许（管道本身没问题）。
 *    每个套件的完整输出会写进 `logs/test-<name>.log`，失败时方便翻。
 */
function runSuite(name) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const know = isolatedKnowledgeDir(name);
    const child = spawn(process.execPath, [join(HERE, `${name}.js`)], {
      cwd: ROOT,
      // ⚠️ 这些测试有的会调真实模型/真实网络，必须带上代理配置
      //    （跟 `_run-bot.bat` 里那套一致，别漏 NO_PROXY —— 漏了会砸掉本机请求）
      env: {
        ...process.env,
        // ⚠️ 隔离路径放在**后面**，保证它一定生效（别被外面同名变量盖掉）
        ...isolatedStateEnv(name),
        ...(know ? { QQBOT_KNOWLEDGE_DIR: know } : {}),
        HTTP_PROXY: process.env.HTTP_PROXY ?? 'http://127.0.0.1:7890',
        HTTPS_PROXY: process.env.HTTPS_PROXY ?? 'http://127.0.0.1:7890',
        NODE_USE_ENV_PROXY: '1',
        NO_PROXY: '127.0.0.1,localhost,::1',
        no_proxy: '127.0.0.1,localhost,::1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => {
      resolve({ name, sec: 0, result: `启动失败: ${e.message}`, fails: [], raw: out });
    });
    child.on('close', () => {
      const sec = Math.round((Date.now() - t0) / 100) / 10;
      // 取最后一条「结果: …」
      const m = [...out.matchAll(/结果:\s*(.+)/g)].pop();
      const result = m ? m[1].trim() : '（无结果行）';
      const fails = [...out.matchAll(/❌\s*(.+)/g)]
        .map((x) => x[1].trim())
        .filter((t) => !KNOWN_OK_FAILURES.some((k) => t.includes(k)));
      resolve({ name, sec, result, fails, raw: out });
    });
  });
}

/** 简单并发池：一次最多 jobs 个 */
async function pool(items, jobs, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(jobs, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return results;
}

console.log(`\n并行跑回归（${jobs} 个并行，共 ${SUITES.length} 套）…\n`);
const t0 = Date.now();
const results = await pool(SUITES, jobs, runSuite);
const total = Math.round((Date.now() - t0) / 100) / 10;

// 落盘每套的完整输出（失败时方便查）
const { writeFileSync } = await import('node:fs');
mkdirSync(join(ROOT, 'logs'), { recursive: true });
for (const r of results) {
  try {
    writeFileSync(join(ROOT, 'logs', `test-${r.name}.log`), r.raw ?? '', 'utf8');
  } catch {}
}

for (const r of results) {
  const ok = r.result.includes('全部通过');
  const mark = ok ? '✅' : '❌';
  console.log(`  ${mark} ${r.name.padEnd(15)} ${String(r.sec).padStart(6)} 秒   ${r.result}`);
  for (const f of r.fails) console.log(`        ↳ ${f}`);
}

const failed = results.filter((r) => !r.result.includes('全部通过'));
console.log(`\n  总耗时 ${total} 秒（并行 ${jobs}）`);
console.log(`  套件 ${results.length - failed.length}/${results.length} 全过`);
if (failed.length) {
  console.log(`  未过：${failed.map((r) => r.name).join(', ')}`);
  console.log(`  完整输出在 logs/test-<套件名>.log`);
}
process.exit(failed.length ? 1 : 0);
