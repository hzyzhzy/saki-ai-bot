/**
 * 「他的资料自动更新」套件（2026-10-03 加，配合 src/owner-update.js）。
 *
 * ## 用户的三句口径（就是这三句，别改）
 *   ①「我和她聊到**我的生活有什么变化**时，**我的资料库里面的对应的信息应该要自动更新**，比如毕业了」
 *   ②「**不用分区，直接修改**，因为我可以去检查来修正错误」
 *   ③「**完全后台**」
 *
 * ## 这个套件要钉死的东西
 *   · **只收私聊 + 只对他本人**（群里、别人私聊都不许进来）
 *   · 模型给的提案**三条底线**：`old` 必须原样存在 / 不许把内容改没 / 不许写敏感信息
 *   · 真改动之前**必须备份**（用户明说了他会去检查）
 *   · 没改动就**不写文件**
 *
 * ⚠️⚠️ 这个套件**绝不能碰真的 `knowledge/owner.md`** —— 用 `QQBOT_KNOWLEDGE_DIR`
 *    把整个知识库目录搬到 `logs/__ownerup-knowledge/`，在里面造假 data。
 *
 * ⚠️ 纯离线：假模型（`maybeUpdate` 的 `ask` 注入），不起进程、不碰真 QQ、不花钱。
 * 用法: node test/owner-update.js
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KNOW_REL = 'logs/__ownerup-knowledge';
const STATE_REL = 'logs/__ownerup-state.json';
const CFG_REL = 'logs/__ownerup-config.yml';
const OWNER = join(ROOT, KNOW_REL, 'owner.md');

// ⚠️ 全部必须在 import 之前设好（config.js / knowledge.js 都是加载时读 env 的）
process.env.QQBOT_KNOWLEDGE_DIR = KNOW_REL;
process.env.QQBOT_OWNER_UPDATE_FILE = STATE_REL;
process.env.QQBOT_CONFIG = CFG_REL;
writeFileSync(
  join(ROOT, CFG_REL),
  [
    '# 测试用（别删：owner-update 套件要它）',
    'ownerQQ: "88800001"',
    'botQQ: "88800002"',
    'logLevel: info',
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
    '  apiKey: test',
    '  model: test',
    '',
    'ownerUpdate:',
    '  enable: true',
    '  minMessages: 2',
    '  minIntervalMs: 3600000',
    '',
  ].join('\n'),
  'utf8',
);

const ownerUpdate = await import('../src/owner-update.js');
const config = (await import('../src/config.js')).config;

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const ME = String(config.ownerQQ);
const OTHER = '39999';
const GID = '888001';

/** 原始资料：故意留一条会被改的（"本科在读"）和一条不该动的 */
const ORIGINAL = [
  '# <主人>（服主）· 专属知识',
  '',
  '## 二、他的经历',
  '',
  '- **科班出身**：**湖南工程学院 · 软件工程**本科在读（2023 级，**2027 届**）。',
  '- **生日**：**2005 年 7 月 16 日**。',
  '',
].join('\n');

function seed() {
  rmSync(join(ROOT, KNOW_REL), { recursive: true, force: true });
  rmSync(join(ROOT, STATE_REL), { force: true });
  mkdirSync(join(ROOT, KNOW_REL), { recursive: true });
  writeFileSync(OWNER, ORIGINAL, 'utf8');
  ownerUpdate.reset();
}

/** 假模型：回一段固定 JSON */
const fakeAsk = (obj) => async () => JSON.stringify(obj);

console.log('\n【1】只收"他本人的私聊"——群消息和别人私聊都不进');
{
  seed();
  check(ownerUpdate.note({ message_type: 'group', group_id: GID, user_id: ME }, '我毕业了') === false, '★ 群里说的不收');
  check(ownerUpdate.note({ message_type: 'private', user_id: OTHER }, '我毕业了') === false, '★ 别人私聊不收');
  check(ownerUpdate.note({ message_type: 'private', user_id: ME }, '我毕业了') === true, '★ 他本人私聊 → 收下');
  check(ownerUpdate.pendingCount() === 1, `攒下 1 条（实际 ${ownerUpdate.pendingCount()}）`);
  check(existsSync(join(ROOT, STATE_REL)), '★ 攒的消息**落了盘**（这机器人重启很频繁，只放内存等于永远攒不够）');
}

console.log('\n【2】攒够才跑；没攒够不跑');
{
  seed();
  ownerUpdate.note({ message_type: 'private', user_id: ME }, '我毕业了');
  check(ownerUpdate.due().ok === false, '只攒 1 条（门槛 2）→ 先不跑');
  ownerUpdate.note({ message_type: 'private', user_id: ME }, '学位证也拿到了');
  check(ownerUpdate.due().ok === true, '★ 攒够 2 条 → 该跑了');
  const r = await ownerUpdate.maybeUpdate(Date.now(), { ask: fakeAsk({ updates: [] }) });
  check(r.ok === true && r.changed === 0, '没提案 → 不报错、改动 0');
  check(ownerUpdate.pendingCount() === 0, '★ 核对过的那批清掉了（不会下一轮又喂一遍）');
}

console.log('\n【3】★★ 三条底线：模型乱写的提案一律拒掉');
{
  seed();
  const before = readFileSync(OWNER, 'utf8');
  ownerUpdate.note({ message_type: 'private', user_id: ME }, '我毕业了');
  ownerUpdate.note({ message_type: 'private', user_id: ME }, '顺便说一句');
  const r = await ownerUpdate.maybeUpdate(Date.now(), {
    ask: fakeAsk({
      updates: [
        // ① old 在资料里不存在（模型编的）
        { old: '**清华大学**本科在读', new: '**清华大学**已毕业', why: '编的' },
        // ② new 比 old 短太多（等于把内容删了）
        { old: '**生日**：**2005 年 7 月 16 日**。', new: '生日。', why: '删内容' },
        // ③ 敏感信息
        { old: '**生日**：**2005 年 7 月 16 日**。', new: '**生日**：**2005 年 7 月 16 日**，电话 13800001111。', why: '塞手机号' },
      ],
    }),
  });
  check(r.changed === 0, '★ 三条全被拒（改动 0）', `rejected=${r.rejected?.length}`);
  check(r.rejected.some((x) => /找不到/.test(x.why)), '★ ① old 不存在 → 拒（不做模糊替换）');
  check(r.rejected.some((x) => /短太多/.test(x.why)), '★ ② 想把内容改没 → 拒');
  check(r.rejected.some((x) => /敏感/.test(x.why)), '★ ③ 提案里带手机号 → 拒');
  check(readFileSync(OWNER, 'utf8') === before, '★★ 一个字节都没写进 owner.md');
}

console.log('\n【4】★★ 正常改动：写盘 + 先备份 + 逐条留痕');
{
  seed();
  ownerUpdate.note({ message_type: 'private', user_id: ME }, '我毕业了，2026 年 6 月拿的证');
  ownerUpdate.note({ message_type: 'private', user_id: ME }, '现在在找工作了');
  // ⚠️ 备份落在**知识库目录自己的** `_backup/` 里（见 backup.js 的 BACKUP），
  //    不是 logs/knowledge.bak —— 第一版就是查错了目录，断言假红。
  const bakDir = join(ROOT, KNOW_REL, '_backup');
  const beforeBak = existsSync(bakDir) ? readdirSync(bakDir).length : 0;
  const r = await ownerUpdate.maybeUpdate(Date.now(), {
    ask: fakeAsk({
      updates: [
        {
          old: '- **科班出身**：**湖南工程学院 · 软件工程**本科在读（2023 级，**2027 届**）。',
          new: '- **科班出身**：**湖南工程学院 · 软件工程**本科**已毕业**（2023 级，2026 年 6 月拿证）。',
          why: '他说「我毕业了，2026 年 6 月拿的证」',
        },
      ],
    }),
  });
  check(r.changed === 1, '★ 改动了 1 处', `changed=${r.changed}`);
  const now = readFileSync(OWNER, 'utf8');
  check(now.includes('已毕业'), '★★ owner.md 里那条真的改了');
  check(!now.includes('本科在读'), '★ 旧的"本科在读"没了（是替换，不是追加）');
  check(now.includes('**生日**：**2005 年 7 月 16 日**。'), '★ 别的行一个字没动');
  const afterBak = existsSync(bakDir) ? readdirSync(bakDir).length : 0;
  check(afterBak > beforeBak, '★★ 改之前**备份**了（用户明说了他会去检查）');
  check(ownerUpdate.status().changed === 1, 'status() 里记着改了几处');
}

console.log('\n【5】她说的"毕业了"这种一次性玩笑，不许被当成事实');
{
  // 这一条是**提示词层**的约束，代码这边只能保证"模型不提案就不动"
  seed();
  const before = readFileSync(OWNER, 'utf8');
  ownerUpdate.note({ message_type: 'private', user_id: ME }, '要是我毕业了就去躺平');
  ownerUpdate.note({ message_type: 'private', user_id: ME }, '今天好困');
  const r = await ownerUpdate.maybeUpdate(Date.now(), { ask: fakeAsk({ updates: [] }) });
  check(r.changed === 0, '模型不提案 → 一个字不改');
  check(readFileSync(OWNER, 'utf8') === before, '★ 文件没动');
}

console.log('\n【6】开关：enable=false 时连攒都不攒');
{
  seed();
  const old = config.ownerUpdate.enable;
  config.ownerUpdate.enable = false;
  check(ownerUpdate.note({ message_type: 'private', user_id: ME }, '我毕业了') === false, '★ 关掉之后不收');
  check(ownerUpdate.due().ok === false, '★ 关掉之后也不跑');
  config.ownerUpdate.enable = old;
}

try {
  rmSync(join(ROOT, KNOW_REL), { recursive: true, force: true });
  rmSync(join(ROOT, STATE_REL), { force: true });
  rmSync(join(ROOT, CFG_REL), { force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
