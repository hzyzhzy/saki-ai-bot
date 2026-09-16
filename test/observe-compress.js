/**
 * 「群记忆按时间压缩」测试（2026-09-14 用户要求）。
 *
 * 用户原话：「再加一个**按时间压缩**的功能，**压缩不重要的事情**，
 *   但是**性格要不断细化，不能删除**，**好感度也不能修改**。」
 *
 * 这个套件盯三条：
 *   ① 压缩**能把大事压短**
 *   ② ★★ **性格条数不许变少** —— 少了就整次作废、不写盘（代码级保险）
 *   ③ **距上次压缩不够久就不压**（别白花调用），而且"上次时间"要**落盘**
 *
 * ⚠️ 用假模型（假 SSE 接口），**不调真模型、不联网**。
 * ⚠️ `QQBOT_OBSERVE_FILE` 让"上次压缩时间"走临时文件，不碰真实 state。
 *
 * 用法: node test/observe-compress.js
 */
import { createServer } from 'node:http';
import { writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** ⚠️ knowledge 目录跟着 `QQBOT_KNOWLEDGE_DIR` 走（回归时是各套件自己的副本） */
const KNOW = process.env.QQBOT_KNOWLEDGE_DIR
  ? join(ROOT, process.env.QQBOT_KNOWLEDGE_DIR)
  : join(ROOT, 'knowledge');
mkdirSync(join(ROOT, 'logs'), { recursive: true });

const LLM_PORT = 40501;
const CFG_REL = 'logs/__test-obs-compress.yml';
const STATE_REL = 'logs/__test-obs-state.json';
const MEM_REL = 'logs/__test-group-memory.md';

writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    `  baseURL: http://127.0.0.1:${LLM_PORT}/v1`,
    '  apiKey: "sk-test"',
    '  model: test-model',
    '  timeout: 8000',
    'observe:',
    '  enable: true',
    '  threshold: 120',
    '  keepPeople: 60',
    '  keepEvents: 20',
    '  compress:',
    '    enable: true',
    '    minIntervalMs: 259200000',
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;
// ⚠️ 这两个都必须指走，否则测试会写真实 state/ 和 knowledge/
process.env.QQBOT_OBSERVE_FILE = STATE_REL;
process.env.QQBOT_GROUP_MEMORY = MEM_REL;
rmSync(join(ROOT, STATE_REL), { force: true });

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

/** 假模型：返回 `nextReply` 里设好的内容（SSE） */
let nextReply = '';
let calls = 0;
const llm = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    for (const p of String(nextReply).match(/[\s\S]{1,40}/g) ?? []) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => llm.listen(LLM_PORT, '127.0.0.1', r));

// ⚠️ observe.js 的 FILE 指向 `knowledge/group-memory.md`（现在跟 `KNOWLEDGE_DIR` 走）。
//    跑回归时它已经是**这套件自己的副本**了；单独跑（没设环境变量）时指的才是真实文件，
//    所以这里照样先备份、测试完还原。
const REAL_MEM = join(KNOW, 'group-memory.md');
const memBackup = readFileSync(REAL_MEM, 'utf8');

/** 造一份"自动区里已经有内容"的观察，然后 import 模块 */
async function freshModule(body) {
  const raw = memBackup.replace(
    /(<!-- AUTO-OBSERVE:BEGIN -->)[\s\S]*?(<!-- AUTO-OBSERVE:END -->)/,
    `$1\n${body}\n$2`,
  );
  writeFileSync(REAL_MEM, raw, 'utf8');
  return import(`../src/observe.js?t=${Date.now()}${Math.random()}`);
}

const PEOPLE = Array.from({ length: 8 }, (_, i) => `- 群友${i}：爱发脑洞梗，接住他的梗就高兴，说话短`);
const EVENTS = Array.from({ length: 12 }, (_, i) => `- 9/${i + 1}：某人随便聊了几句无关紧要的话`);
const BIG_BODY = ['### 群友', '', ...PEOPLE, '', '### 大事', '', ...EVENTS].join('\n');

console.log('\n【1】★ 正常压缩：性格不许变少，大事可以压短');
{
  const obs = await freshModule(BIG_BODY);
  nextReply = ['### 群友', '', ...PEOPLE, '', '### 大事', '', '- 9 月上旬：群里几次闲聊，无大事'].join('\n');
  const before = calls;
  const r = await obs.compress({ force: true });
  check(r.ok === true, '压缩成功', r.reason ?? '');
  check(calls > before, '确实调了一次模型');
  check(r.peopleBefore === 8, `压前 8 条性格（${r.peopleBefore}）`);
  check(r.peopleAfter >= 8, `★ 压后性格没变少（${r.peopleAfter}）`);
  check(r.eventsAfter < r.eventsBefore, `大事被压短了（${r.eventsBefore} → ${r.eventsAfter}）`);

  const written = readFileSync(REAL_MEM, 'utf8');
  check(written.includes('群友0'), '性格内容写进文件了');
  check(!written.includes('9/12：某人随便聊了'), '被压掉的大事不在文件里了');
}

console.log('\n【2】★★ 模型想删性格条 → 整次作废、不写盘');
{
  const obs = await freshModule(BIG_BODY);
  const snapshot = readFileSync(REAL_MEM, 'utf8');
  // ⚠️ 模拟"模型自作主张把性格砍成 2 条"
  nextReply = ['### 群友', '', '- 群友0：爱发脑洞梗', '- 群友1：说话短', '', '### 大事', '', '- 无'].join('\n');
  const r = await obs.compress({ force: true });
  check(r.ok === false, `★ 被拒绝了（reason: ${r.reason}）`);
  check(/砍到|变少/.test(r.reason ?? ''), '理由说清了是"性格变少"');
  check(r.peopleBefore === 8 && r.peopleAfter === 2, `报出了前后条数（${r.peopleBefore} → ${r.peopleAfter}）`);
  check(readFileSync(REAL_MEM, 'utf8') === snapshot, '★ 文件**一个字都没动**（作废生效）');
}

console.log('\n【3】★ 模型返回空 → 也不许动文件');
{
  const obs = await freshModule(BIG_BODY);
  const snapshot = readFileSync(REAL_MEM, 'utf8');
  nextReply = '';
  const r = await obs.compress({ force: true });
  check(r.ok === false, '拒绝了');
  check(readFileSync(REAL_MEM, 'utf8') === snapshot, '文件没动');
}

console.log('\n【4】★ 距上次压缩不够久 → 不压（省调用）');
{
  const obs = await freshModule(BIG_BODY);
  // 先真的压一次，让它记住"上次时间"
  nextReply = ['### 群友', '', ...PEOPLE, '', '### 大事', '', '- 9 月上旬：闲聊'].join('\n');
  const r1 = await obs.compress({ force: true });
  check(r1.ok === true, '第一次（force）压成功');

  const before = calls;
  const r2 = await obs.compress(); // 不带 force
  check(r2.ok === false, '紧接着再压 → 被拒绝');
  check(/不到|还有/.test(r2.reason ?? ''), `理由提到时间间隔（"${r2.reason}"）`);
  check(calls === before, '★ 根本没调模型（省了一次调用）');
}

console.log('\n【5】★「上次压缩时间」要落盘（不然重启就能反复压）');
{
  check(existsSync(join(ROOT, STATE_REL)), '状态文件写出来了');
  const j = JSON.parse(readFileSync(join(ROOT, STATE_REL), 'utf8'));
  check(Number(j.lastCompressAt) > 0, `文件里有 lastCompressAt（${j.lastCompressAt}）`);

  // 模拟重启：新模块实例应当读到那个时间，仍然拒绝立刻再压
  const obs2 = await freshModule(BIG_BODY);
  const before = calls;
  const r = await obs2.compress();
  check(r.ok === false, '★ 重启后**仍然**不会立刻再压（说明时间真的读回来了）');
  check(calls === before, '没白花调用');
}

console.log('\n【6】内容太少就不压（压了也没意义）');
{
  const obs = await freshModule(['### 群友', '', '- 群友0：随便一个人', '', '### 大事', '', '- 9/1：一件小事'].join('\n'));
  rmSync(join(ROOT, STATE_REL), { force: true });
  const before = calls;
  const r = await obs.compress({ force: true });
  check(r.ok === false && /还不多/.test(r.reason ?? ''), `理由合理（"${r.reason}"）`);
  check(calls === before, '没调模型');
}

console.log('\n【7】★ 观察频率相关的配置（用户要求"提升记录频率"）');
{
  const src = readFileSync(join(ROOT, 'src', 'observe.js'), 'utf8');
  // 一次写的群友条数上限：5 → 12（原来 5 会把细节扔掉）
  check(/people\.length < 12/.test(src), '一次最多记 12 条性格（原 5）');
  // 性格保留上限：20 → 60（原来攒到 20 条就开始挤掉最老的）
  const cfg = readFileSync(join(ROOT, 'config.yml'), 'utf8');
  check(/keepPeople:\s*60/.test(cfg), 'config 里 keepPeople = 60');
  check(/threshold:\s*120/.test(cfg), 'config 里 threshold = 120（原 200）');
  check(/群友观察尽量多写/.test(src), '提示词里明确要求"群友观察尽量多写"');
  // ⚠️ 提示词里的条数必须和代码里的上限一致 —— 我第一版改了代码忘了改提示词
  check(/群友观察尽量多写\*\*（最多 12 条）/.test(src), '提示词里的条数和代码上限一致（12）');
}

// ── 收尾：还原真实 group-memory.md ──────────────────────
writeFileSync(REAL_MEM, memBackup, 'utf8');
try {
  rmSync(join(ROOT, CFG_REL), { force: true });
  rmSync(join(ROOT, STATE_REL), { force: true });
} catch {}
rmSync(join(ROOT, MEM_REL), { force: true });
await new Promise((r) => llm.close(r));

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
