/**
 * 「自动清理」的回归（2026-10-06 加，用户要求）。
 *
 * 用户原话：「机器人自己 QQ 的聊天文件缓存占多少？我觉得可以加个自动清理的功能了，
 *   因为对机器人没用」。
 *
 * ## 这个套件盯什么（三件一样重要）
 *   ① **该删的真的删了**（超期的文件缓存 / 测试临时目录 / 按天日志 / 待审表情）；
 *   ② **⚠️⚠️ 白名单一个字都不许碰** —— `发布凭据.md`（GitHub PAT！）、`*.json`、
 *      `*.bak-*`、`*备份*` 就算放了一百天、就算很大，也必须原样在；
 *   ③ **没超期的不许删**（今天是几号就删几天前的，差一天都不行）。
 *
 * ⚠️ 这个模块干的是 `unlinkSync` / `rmSync` —— 所以测试**必须在临时根目录里跑**：
 *    `QQBOT_CLEANUP_ROOT` 指到 `logs/__test-cleanup-root`（见 `src/cleanup.js` 顶部）。
 *    没有这一层隔离，这个套件本身就是个事故。
 *
 * ⚠️ 纯离线：不连 QQ、不调模型、不花钱。
 * 用法: node test/cleanup.js
 */
import { mkdirSync, writeFileSync, utimesSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(ROOT, 'logs', '__test-cleanup-root');
const CFG = 'logs/__test-cleanup.yml';

// ⚠️⚠️ 两个 env 都必须在 import `src/*` **之前**设好（模块加载时就求值，踩过好几次）
process.env.QQBOT_CLEANUP_ROOT = TMP;
process.env.QQBOT_CONFIG = CFG;
mkdirSync(join(ROOT, 'logs'), { recursive: true });
writeFileSync(
  join(ROOT, CFG),
  ['llm:', '  baseURL: http://127.0.0.1:1/v1', '  apiKey: "sk-test"', '  model: t', ''].join('\n'),
  'utf8',
);

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const cleanup = await import('../src/cleanup.js');
const { config } = await import('../src/config.js');

const DAY = 24 * 60 * 60 * 1000;
/** 把某个文件/目录的 mtime 改成 N 天前（"放了多久"就靠它） */
const aged = (rel, days) => {
  const t = new Date(Date.now() - days * DAY);
  utimesSync(join(TMP, rel), t, t);
};
/** 造一个文件（顺带设年龄） */
const mk = (rel, days = 0, content = 'x') => {
  const p = join(TMP, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf8');
  if (days) aged(rel, days);
  return p;
};
const there = (rel) => existsSync(join(TMP, rel));

/** 每次重新造一遍场景（`run()` 会真删东西） */
function buildScene() {
  rmSync(TMP, { recursive: true, force: true });
  // ① 该删的
  mk('logs/_uploaded/old-big.zip', 5, 'x'.repeat(2048)); // 群友发来的文件（默认保留 3 天）
  mk('logs/__know-old/friends.md', 5); // 测试临时目录（3 天）
  // ⚠️ 目录**本身**的 mtime 也要改老 —— `scan()` 判的是目录自己的时间（不是里面文件的），
  //    只改里面文件的话这个目录永远"不超期"（第一版就是这么假失败的）
  aged('logs/__know-old', 5);
  mk('logs/__gen-photo-old', 5); // 生图产物（3 天）
  mk('logs/bot-2026-09-01.log', 30); // 按天日志（7 天）
  mk('logs/test-old.log', 30); // 套件日志（7 天）
  mk('library/_pending/c_old.jpg', 20); // 待审表情（14 天）
  // ② 不该删的（没超期）
  mk('logs/_uploaded/new-small.zip', 1);
  mk('logs/__know-new/friends.md', 1);
  mk(`logs/bot-${new Date().toISOString().slice(0, 10)}.log`, 0);
  mk('library/_pending/c_new.jpg', 1);
  // ③ ⚠️⚠️ 白名单：放一百天、而且"看起来很该删"，也必须一个都不动
  mk('logs/发布凭据.md', 100);
  mk('logs/config.yml.bak-20260101', 100);
  mk('logs/persona.备份-旧.md', 100);
  mk('logs/some-state.json', 100);
  mk('logs/keep.keep', 100);
  mk('logs/other.yml', 100);
}

console.log('\n【1】规则与白名单的形状');
{
  const rules = cleanup.__rules();
  check(rules.length >= 5, `规则条数正常（${rules.length} 条）`);
  check(
    rules.every((r) => !r.dir.startsWith('/') && !r.dir.includes('..')),
    '★ 每条规则都是 ROOT 内的相对目录（没有绝对路径 / 没有 ..）',
  );
  const never = cleanup.__never();
  check(never.some((s) => s.includes('md')), '★ 白名单里有 md（发布凭据.md 靠它保命）');
  check(never.some((s) => s.includes('json')), '白名单里有 json');
  check(never.some((s) => s.includes('bak')), '白名单里有 bak（退路）');
}

console.log('\n【2】★ 扫描：该删的都在清单里，白名单一条都不在里面');
buildScene();
{
  const { hits, totalBytes } = cleanup.scan();
  const rels = hits.map((h) => h.rel);
  const has = (s) => rels.some((r) => r.includes(s));

  check(has('old-big.zip'), '★ 超期的文件缓存 → 在清单里');
  check(has('__know-old'), '★ 超期的测试临时目录 → 在清单里');
  check(has('__gen-photo-old'), '★ 超期的生图产物 → 在清单里');
  check(has('bot-2026-09-01.log'), '★ 超期的按天日志 → 在清单里');
  check(has('test-old.log'), '★ 超期的套件日志 → 在清单里');
  check(has('c_old.jpg'), '★ 超期的待审表情 → 在清单里');

  check(!has('new-small.zip'), '没超期的文件缓存 → 不删');
  check(!has('__know-new'), '没超期的临时目录 → 不删');
  check(!has('c_new.jpg'), '没超期的待审表情 → 不删');
  check(!/bot-\d{4}-\d{2}-\d{2}\.log$/.test(rels.find((r) => r.includes('bot-')) ?? '') || !has(new Date().toISOString().slice(0, 10)), '今天的按天日志 → 不删');

  // ⚠️⚠️ 这一组是**这个套件存在的意义**
  for (const f of ['发布凭据.md', 'config.yml.bak-20260101', 'persona.备份-旧.md', 'some-state.json', 'keep.keep', 'other.yml']) {
    check(!has(f), `★★ 白名单不碰：${f}（放了一百天也不删）`);
  }
  check(totalBytes > 0, `清单里有可省的空间（${(totalBytes / 1024).toFixed(1)} KB）`);
}

console.log('\n【3】dryRun：只报不删');
{
  buildScene();
  const r = cleanup.run({ dryRun: true });
  check(r.dryRun === true, '标记成演练');
  check(r.freedBytes > 0 && r.deleted.length > 0, `报出了可省的（${r.deleted.length} 项）`);
  check(there('logs/_uploaded/old-big.zip'), '★ 演练之后文件**还在**（没真删）');
  check(there('logs/__know-old/friends.md'), '★ 演练之后目录**还在**');
}

console.log('\n【4】★★ 真删：删对的、留对的');
{
  buildScene();
  const r = cleanup.run();
  check(r.dryRun === false, '真删模式');
  check(!there('logs/_uploaded/old-big.zip'), '★ 超期文件缓存删掉了');
  check(!there('logs/__know-old'), '★ 超期测试目录整棵删掉了');
  check(!there('logs/__gen-photo-old'), '★ 超期生图产物删掉了');
  check(!there('logs/bot-2026-09-01.log'), '★ 超期按天日志删掉了');
  check(!there('logs/test-old.log'), '★ 超期套件日志删掉了');
  check(!there('library/_pending/c_old.jpg'), '★ 超期待审表情删掉了');

  check(there('logs/_uploaded/new-small.zip'), '没超期的文件缓存留着');
  check(there('logs/__know-new/friends.md'), '没超期的测试目录留着');
  check(there('library/_pending/c_new.jpg'), '没超期的待审表情留着');
  // ⚠️ 最关键的一条
  check(there('logs/发布凭据.md'), '★★★ 发布凭据.md **还在**（这是这个功能最不能出错的地方）');
  check(there('logs/config.yml.bak-20260101'), '★★ 配置备份还在');
  check(there('logs/persona.备份-旧.md'), '★★ 人设备份还在');
  check(there('logs/some-state.json'), '★ json 状态文件还在');
  check(r.freedBytes > 2048, `省下的字节数是算出来的（${(r.freedBytes / 1024).toFixed(1)} KB）`);
}

console.log('\n【5】关掉开关就完全不删');
{
  buildScene();
  const before = config.cleanup.enable;
  config.cleanup.enable = false;
  const r = cleanup.run();
  check(r.ok === false && r.skipped === 'cleanup.enable=false', '返回"没干活"并说明原因', JSON.stringify(r.skipped));
  check(there('logs/_uploaded/old-big.zip'), '★ 关掉之后超期文件也**一个没删**');
  config.cleanup.enable = before;
}

console.log('\n【6】status()：给界面看的占用与待清');
{
  buildScene();
  const s = cleanup.status();
  check(Array.isArray(s.dirs) && s.dirs.length >= 4, `列了几处占用（${s.dirs.length} 处）`);
  check(s.dirs.some((d) => d.rel === 'logs/_uploaded' && d.bytes > 0), '★ 文件缓存那处的体积算出来了');
  check(s.dueCount > 0 && s.dueBytes > 0, `待清项也报出来了（${s.dueCount} 项）`);
  check(typeof s.days.uploadedDays === 'number', '暴露了各保留期（界面要显示）');
}

// ── 收尾：临时根目录和测试配置都清掉 ──
try {
  rmSync(TMP, { recursive: true, force: true });
  rmSync(join(ROOT, CFG), { force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
