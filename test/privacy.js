/**
 * `src/privacy.js`（脱敏层）自测。
 *
 * 跑法：`node test/privacy.js`
 *
 * ⚠️ 全程**隔离**：映射表写临时目录（`QQBOT_PRIVACY_FILE`），
 *    实体源也指向临时 fixture（`QQBOT_GROUP_NAMES_FILE` / `QQBOT_NAMES_FILE`）
 *    —— 绝不碰生产那一份 `state/privacy-map.json`，也不受真实群名/昵称表变化影响
 *    （不然今天多一个群名，明天这套件就红了，看着像代码坏了）。
 *
 * ⚠️ `privacy.js` 用**动态 import**：ESM 的静态 import 会被提升到文件最前面执行，
 *    那样 `process.env.*` 还没来得及设，模块就已经算过路径了。
 */

import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/* ⚠️ 子进程模式（跨进程还原那条用例）：它**必须**沿用父进程的环境变量。
 *    第一版这里没区分，子进程照旧 `mkdtempSync` 又造了个新临时目录 ⇒
 *    映射表路径跟着变 ⇒ 读不到表 ⇒ 还原失败（看着像脱敏坏了，其实是测试自己写错）。 */
const IS_CHILD = process.argv[2] === '--child-unmask';

const TMP = IS_CHILD ? '' : mkdtempSync(join(tmpdir(), 'qqbot-privacy-test-'));
const MAP_FILE = IS_CHILD ? '' : join(TMP, 'privacy-map.json');
const GROUP_FILE = IS_CHILD ? '' : join(TMP, 'group-names.json');
const NAMES_FILE = IS_CHILD ? '' : join(TMP, 'names.json');

if (!IS_CHILD) {
  process.env.QQBOT_PRIVACY_FILE = MAP_FILE;
  process.env.QQBOT_GROUP_NAMES_FILE = GROUP_FILE;
  process.env.QQBOT_NAMES_FILE = NAMES_FILE;

  /* ── fixture（故意混进几个"陷阱形状"）─────────────────────────────
   * · 第二个群的名字就是 `-`：不拦的话全文连字符都会被换成占位符
   * · 昵称里有纯 emoji / 单字：应当被过滤掉
   */
  writeFileSync(
    GROUP_FILE,
    JSON.stringify({
      groups: {
        999000001: {name: '测试群甲'},
        999000002: {name: '-'},
        999000003: {name: '🎮'},
      },
    }),
    'utf8',
  );
  writeFileSync(
    NAMES_FILE,
    JSON.stringify({
      nick: {10000001: '阿明', 10000002: '小红', 10000003: 'X'},
      card: {10000001: '小明'},
    }),
    'utf8',
  );
}

const privacy = await import('../src/privacy.js');

/* ── 小工具 ─────────────────────────────────────────────────── */
let pass = 0;
let fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${extra ? ` —— ${extra}` : ''}`);
  }
};
const hr = (t) => console.log(`\n【${t}】`);

/**
 * 多次计时取分布。
 * ⚠️ 为什么不只报"平均"、也不拿"最慢一次"做硬断言：这个进程里前面已经跑过
 *    十几万字符的字符串操作，GC 随时可能插一脚（实测最慢那次 8.8ms，同一段代码
 *    单独跑只有 2.2ms）⇒ 拿单次极值当判据会得到假警报。判据用平均 + p95，
 *    最慢值照打出来给人看。
 */
const measure = (fn, n = 50) => {
  fn(); // warm：让正则/JIT 编译好、实体登记好
  const t = [];
  for (let i = 0; i < n; i += 1) {
    const a = process.hrtime.bigint();
    fn();
    t.push(Number(process.hrtime.bigint() - a) / 1e6);
  }
  t.sort((x, y) => x - y);
  return {
    avg: t.reduce((x, y) => x + y, 0) / t.length,
    median: t[Math.floor(t.length / 2)],
    p95: t[Math.max(0, Math.ceil(t.length * 0.95) - 1)],
    worst: t[t.length - 1],
  };
};
const fmt = (r) =>
  `平均 ${r.avg.toFixed(2)}ms / 中位 ${r.median.toFixed(2)}ms / p95 ${r.p95.toFixed(2)}ms / 最慢 ${r.worst.toFixed(2)}ms`;

/* ══ 子进程模式：只做「读磁盘映射表 + 还原」══
 * 父进程把脱敏后的文本从 argv 传进来，子进程**不共享内存**，
 * 只能靠 state 里那张表还原 —— 这才是"跨进程"的真正含义。 */
if (IS_CHILD) {
  const text = process.argv[3] ?? '';
  process.stdout.write(JSON.stringify({text: privacy.unmask(text)}));
  process.exit(0);
}

/* ══ 0. 环境自检 ══ */
hr('0. 环境');
const st0 = privacy.stats();
console.log(`  开关 enable=${st0.enable} maskNames=${st0.maskNames} maskNumbers=${st0.maskNumbers}`);
console.log(`  映射表 → ${st0.file}`);
ok(st0.file === MAP_FILE, '映射表写在临时目录（不碰生产 state）', st0.file);
if (!st0.enable) console.log('  ⚠️ config.llm.privacy.enable 是关的 —— 本套件测不出脱敏效果');

/* ══ 开关小工具 ══
 * ⚠️ `privacy.js` 每次现读 `config.llm.privacy`、而且规则缓存里有 `maskNames` 这个 key
 *    ⇒ 改完内存里的配置必须 `reloadSources()`，否则还会用旧规则。
 * ⚠️ 生产配置是 **maskNames: false**（昵称不脱，理由见 `src/privacy.js` 的 `maskNamesOn()`）；
 *    下面 【1】~【8】为了把"人名规则本身"也验一遍，临时打开成 true，到【9】再切回来逐项对比。 */
const {config} = await import('../src/config.js');
const PROD_PRIVACY = {...(config.llm.privacy || {})};
const setPrivacy = (patch) => {
  config.llm.privacy = {...PROD_PRIVACY, ...patch};
  privacy.reloadSources();
};

/* ══ 样本文本（真实会出现在提示词里的那些形状）══ */
const RAW = [
  '【群 999000001 测试群甲】阿明（10000001，群名片小明）说：今晚有人打吗',
  '服务器在 https://mc.example.com:25565 上面，密钥 sk-abcdef1234567890 别外传',
  '小红也来了，她的号是 10000002；还有个陌生人 88888888',
  '刚才有人在 203.0.113.10 上试了端口，又有人在 203.0.113.10 上试了一遍',
  '阿明说他明天再来 —— 这条连接符得留着，不能被群名那条规则吃掉',
].join('\n');

/* ══ 1. mask 基本形态 ══
 * 本项**临时打开** `maskNames`（生产默认是关的）—— 目的是把人名规则本身也验一遍。 */
hr('1. 脱敏结果（临时 maskNames=true）');
setPrivacy({maskNames: true});
const m1 = privacy.mask(RAW);
console.log('  ── 原文 ──');
console.log(RAW.split('\n').map((l) => `  | ${l}`).join('\n'));
console.log('  ── 脱敏后 ──');
console.log(m1.text.split('\n').map((l) => `  | ${l}`).join('\n'));

ok(!m1.text.includes('999000001'), '群号 999000001 不见了');
ok(!m1.text.includes('测试群甲'), '群名「示例群」不见了');
ok(!m1.text.includes('阿明'), '昵称「阿明」不见了');
ok(!m1.text.includes('小明'), '群名片「小明」不见了');
ok(!m1.text.includes('10000001'), 'QQ 号 10000001 不见了');
ok(!m1.text.includes('mc.example.com'), '域名 mc.example.com 不见了');
ok(!m1.text.includes('sk-abcdef1234567890'), '密钥不见了');
ok(!m1.text.includes('203.0.113.10'), 'IP 不见了');
ok(m1.text.includes('@GN1@'), '群名换成了 @GNx@');
ok(m1.text.includes('@G1@'), '群号换成了 @Gx@');
ok(m1.text.includes('@S'), '地址换成了 @Sx@');
ok(m1.text.includes('@K1@'), '密钥换成了 @Kx@');
ok(m1.text.includes(' —— '), '正文里的连接符「——」原样保留（群名 `-` 没被当实体）');
ok(m1.text.includes('今晚有人打吗'), '正文内容一个字没动');

/* ══ 2. ① 同一实体 → 同一占位符 ══ */
hr('2. 同一实体多次出现 → 同一占位符');
const dupText = '阿明、阿明、阿明，还有 999000001 和 999000001';
const md = privacy.mask(dupText);
const phOf = (t, v) => {
  // 从结果里反推：该值对应的占位符（用 map 更直接）
  for (const [ph, val] of t.map) if (val === v) return ph;
  return '';
};
const a1 = phOf(md, '阿明');
ok(a1 && md.text.split(a1).length - 1 === 3, `「阿明」3 次 → 同一个占位符 ${a1} ×3`);
const g1 = phOf(md, '999000001');
ok(g1 && md.text.split(g1).length - 1 === 2, `群号 2 次 → 同一个占位符 ${g1} ×2`);
// 跨调用（两次独立的 mask）
const md2 = privacy.mask('阿明又来了');
ok(phOf(md2, '阿明') === a1, '跨多次调用仍是同一个占位符（映射表命中，不重新分配）');

/* ══ 3. ② 往返完全一致 ══ */
hr('3. mask → unmask 往返');
const back = privacy.unmask(m1.text, m1.map);
ok(back === RAW, '往返后与原文**逐字节**完全一致');
if (back !== RAW) {
  console.log('  ── 差异 ──');
  console.log(JSON.stringify(RAW));
  console.log(JSON.stringify(back));
}

/* ══ 4. ③ 正文里不该出现的敏感字面量 ══ */
hr('4. 敏感字面量检查');
const leaks = ['999000001', '测试群甲', '阿明', '小明', '10000001', '10000002', 'mc.example.com', 'sk-abcdef', '203.0.113.10'];
const leaked = leaks.filter((x) => m1.text.includes(x));
ok(!leaked.length, '脱敏后的正文不含任何敏感字面量', leaked.join(', '));

/* ══ 5. ⑤ 跨进程还原（重新从磁盘加载映射表）══ */
hr('5. 跨进程还原');
privacy.flush();
ok(existsSync(MAP_FILE), '映射表已落盘', MAP_FILE);
const self = fileURLToPath(import.meta.url);
const r = spawnSync(process.execPath, [self, '--child-unmask', m1.text], {
  env: process.env,
  encoding: 'utf8',
});
if (r.status !== 0) {
  ok(false, '子进程没跑起来', r.stderr?.slice(0, 300));
} else {
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    /* 下面会报 */
  }
  ok(!!out, '子进程有输出', r.stdout?.slice(0, 200));
  ok(out && out.text === RAW, '子进程（全新进程、只靠磁盘表）还原结果与原文完全一致');
  if (out && out.text !== RAW) console.log('  子进程结果：', JSON.stringify(out.text).slice(0, 300));
}

/* ══ 6. 流式切断（SSE 会把占位符切成两半）══ */
hr('6. 流式 unmask 器（占位符被切断）');
{
  const masked = m1.text;
  for (const size of [1, 2, 3, 7]) {
    const u = privacy.createStreamUnmasker(m1.map);
    let acc = '';
    for (let i = 0; i < masked.length; i += size) acc += u.feed(masked.slice(i, i + size));
    acc += u.flush();
    ok(acc === RAW, `按 ${size} 字一块喂进去，拼回来仍与原文完全一致`);
    if (acc !== RAW) console.log('  拼回来的：', JSON.stringify(acc).slice(0, 400));
  }
  // 极端情况：`@U1@` 正好被切成 "@U" + "1@"，中间那一块不能把半个占位符漏出去
  const u = privacy.createStreamUnmasker(m1.map);
  const ph = phOf(m1, '阿明');
  const half1 = u.feed(`他说${ph.slice(0, 2)}`);
  const half2 = u.feed(`${ph.slice(2)}好`);
  ok(half1 === '他说', '第一块只吐出「他说」，半个占位符被扣住', JSON.stringify(half1));
  ok(`${half1}${half2}` === '他说阿明好', '第二块到了之后才一起还原', `${half1}${half2}`);
}

/* ══ 7. ④ 一万字耗时 ══ */
hr('7. 性能（一万字）');
{
  const unit = `${RAW}\n`;
  let big = '';
  while (big.length < 10000) big += unit;
  big = big.slice(0, 10000);

  // 首次（含建正则、分配新占位符、落盘）
  privacy.reloadSources();
  const t00 = process.hrtime.bigint();
  privacy.mask(big);
  const first = Number(process.hrtime.bigint() - t00) / 1e6;

  const r = measure(() => privacy.mask(big));
  console.log(`  文本长度 ${big.length} 字（含群号/群名/昵称/URL/密钥/IP 各多次）`);
  console.log(`  首次 ${first.toFixed(2)}ms（含建规则 + 新占位符落盘）`);
  console.log(`  稳态 ${fmt(r)}`);
  ok(r.avg < 10, `稳态平均 < 10ms（实测 ${r.avg.toFixed(2)}ms）`);
  ok(r.p95 < 10, `稳态 p95 < 10ms（实测 ${r.p95.toFixed(2)}ms）`);
}

/* ══ 7b. 真实实体源下的性能 ══
 * 上面那项用的是 3 个人名的 fixture；生产里 `state/names.json` 有近三千条昵称，
 * 那才是常见的规模 ⇒ 必须按真实规模再测一次（只读那两个文件，不写它们）。 */
hr('7b. 真实实体源下的性能');
{
  const savedG = process.env.QQBOT_GROUP_NAMES_FILE;
  const savedN = process.env.QQBOT_NAMES_FILE;
  delete process.env.QQBOT_GROUP_NAMES_FILE;
  delete process.env.QQBOT_NAMES_FILE;
  privacy.reloadSources();

  const stR = privacy.stats();
  console.log(
    `  真实实体源：群名 ${stR.rules?.groupNames} / 昵称 ${stR.rules?.personNames} / ` +
      `已知 QQ ${stR.rules?.personIds} / 群号 ${stR.rules?.groupIds}`,
  );
  const unit =
    '阿恺和凌海云烟在群里聊服务器，Saki 说了句 blue 的事，还有 454335、920171 这些号要看。\n';
  let big = '';
  while (big.length < 10000) big += unit;
  big = big.slice(0, 10000);
  const r = measure(() => privacy.mask(big));
  console.log(`  ${big.length} 字：${fmt(r)}`);
  ok(stR.rules?.personNames > 100, `真实昵称表加载成功（${stR.rules?.personNames} 条）`);
  ok(r.avg < 10, `真实规模下平均 < 10ms（实测 ${r.avg.toFixed(2)}ms）`);
  ok(r.p95 < 10, `真实规模下 p95 < 10ms（实测 ${r.p95.toFixed(2)}ms）`);

  if (savedG !== undefined) process.env.QQBOT_GROUP_NAMES_FILE = savedG;
  if (savedN !== undefined) process.env.QQBOT_NAMES_FILE = savedN;
  privacy.reloadSources();
}

/* ══ 8. 映射表膨胀 / 只读统计 ══ */
hr('8. 统计');
{
  const st = privacy.stats();
  console.log(`  实体 ${st.entities} 条：${JSON.stringify(st.byType)}`);
  console.log(`  seq=${JSON.stringify(st.seq)}  规则=${JSON.stringify(st.rules)}`);
  console.log(`  计数=${JSON.stringify(st.counter)}`);
  ok(st.entities > 0, '映射表里有条目');
  ok(st.byType.U > 0 && st.byType.G > 0 && st.byType.GN > 0 && st.byType.S > 0 && st.byType.K > 0, '五类占位符都分配到了');
  const st2 = privacy.stats();
  ok(JSON.stringify(st2.byType) === JSON.stringify(st.byType), 'stats() 是只读的（连调两次结果一致）');
}

/* ══ 9. maskNames 开关（生产默认 **false**：昵称不脱）══
 * 判据：昵称重名太多，脱了也定位不到人；而昵称表里有群友名字就是常用词
 * （或者/今天/时间/默认/哈哈…），一脱会把提示词里的常用词也换成 `@U3@`。 */
hr('9. maskNames 开关（两个方向都验）');
{
  setPrivacy({maskNames: false});
  const tOff = privacy.mask('阿明 / 999000001 / 测试群甲 / 10000001');
  ok(tOff.text.includes('阿明'), 'maskNames=false ⇒ 昵称原样保留（脱了也定位不到人）');
  ok(!tOff.text.includes('999000001'), 'maskNames=false ⇒ 群号照样脱');
  ok(!tOff.text.includes('测试群甲'), 'maskNames=false ⇒ 群名照样脱');
  ok(!tOff.text.includes('10000001'), 'maskNames=false ⇒ QQ 号照样脱（这才是能定位到人的那个）');

  setPrivacy({maskNames: true});
  const tOn = privacy.mask('阿明 / 999000001');
  ok(!tOn.text.includes('阿明'), 'maskNames=true ⇒ 昵称也脱');
  ok(!tOn.text.includes('999000001'), 'maskNames=true ⇒ 群号当然也脱');
  setPrivacy({}); // 回到生产配置
}

/* ══ 9b. 总开关关掉时必须**一个字节都不改** ══
 * 这条比"开着能脱"更重要：开关失灵（比如配置读错了）会让所有消息变成占位符发出去，
 * 那种事故比漏脱敏难查得多。 */
hr('9b. 总开关');
{
  const sample = '阿明 10000001 测试群甲 https://mc.example.com';
  try {
    setPrivacy({enable: false});
    ok(privacy.enabled() === false, 'enable=false 立刻生效（配置每次现读，不固化在加载时）');
    const t = privacy.mask(sample);
    ok(t.text === sample, '关掉之后一个字节都不改');
    ok(t.map.size === 0, '关掉之后不分配占位符');
    const src = [{role: 'user', content: sample}];
    const mm = privacy.maskMessages(src);
    ok(mm.messages === src, 'maskMessages 直接原样返回（连新数组都不造）');
  } finally {
    setPrivacy({}); // 回到生产配置
  }
  ok(privacy.enabled() === true, '恢复开关后又开始脱敏');
}

/* ══ 9c. 模型把占位符写歪了也要能还原 ══ */
hr('9c. 占位符容错');
{
  // ⚠️ 用 QQ 号取占位符，不用昵称 —— 生产配置里昵称压根不脱（maskNames=false）
  const ph = [...privacy.mask('10000001').map].find(([, v]) => v === '10000001')?.[0] ?? '@U1@';
  const crooked = ph.replace(/@/g, '＠').toLowerCase(); // ＠u1＠
  ok(privacy.unmask(crooked) === '10000001', `全角 + 小写的 ${crooked} 也能还原`);
  ok(privacy.unmask('这条里没有占位符') === '这条里没有占位符', '不含占位符的文本原样返回');
  ok(privacy.unmask('@U999@') === '@U999@', '认不出来的编号原样留着（不瞎猜）');
}

/* ══ 10. 真实接入验证（假模型服务 + 真的 streamChat）══
 * 前面几项验的是 `privacy.js` 自己；这一项验**接进 `llm.js` 之后是否真的生效**：
 *   ① 发出去的请求体里必须是占位符（不是真名）
 *   ② 收回来的正文必须是真名（不是占位符）
 *  ③ 流式占位符被 SSE 切成两块时也不能漏
 * ⚠️ 假服务必须按请求体的 `stream` 字段决定回 SSE 还是整块 JSON ——
 *    回错了不会报错，只会让调用方静默走错分支（这个项目里为一个坑白查过很久）。 */
hr('10. 真实接入（假模型）');
{
  // 回到 fixture 实体源（第 7b 项用过真实表）
  process.env.QQBOT_GROUP_NAMES_FILE = GROUP_FILE;
  process.env.QQBOT_NAMES_FILE = NAMES_FILE;
  privacy.reloadSources();

  // ⚠️ 用 **QQ 号**取占位符，不用昵称 —— 生产配置里昵称不脱（maskNames=false），
  //    而 QQ 号是"真能定位到人"的那个，也正是这一项要证明会脱的东西。
  const probe = privacy.mask('10000001');
  const phMing = [...probe.map].find(([, v]) => v === '10000001')?.[0] ?? '@U1@';
  console.log(`  「10000001」的占位符 = ${phMing}`);

  const http = await import('node:http');
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8'); // ⚠️ 必须先拼 Buffer 再解码，否则中文跨分片会烂
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* ignore */
      }
      seen.push(body);
      if (body.stream) {
        res.writeHead(200, {'Content-Type': 'text/event-stream'});
        // 故意把占位符切成两块（模拟 SSE 按 token 切）
        const parts = ['他说' + phMing.slice(0, 2), phMing.slice(2) + '好', '，完了'];
        for (const p of parts) {
          res.write(`data: ${JSON.stringify({choices: [{delta: {content: p}}]})}\n\n`);
        }
        res.write(`data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}]})}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({choices: [{message: {content: `他说${phMing}好`}}]}));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const llm = await import('../src/llm.js');
  const over = {baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'fake-model'};

  // ① 流式
  const sysText = '你是测试群甲的助手，群里有个号 10000001 的人（昵称阿明）。';
  const userText = '10000001 刚发来消息：「今晚有人打吗」';
  const msgs = [
    {role: 'system', content: sysText},
    {role: 'user', content: userText},
  ];
  let out = '';
  for await (const piece of llm.streamChat(msgs, null, over)) out += piece;
  const sent = seen[0];
  const sentText = (sent?.messages || []).map((m) => m.content).join('\n');
  console.log(`  发给模型：${JSON.stringify(sentText)}`);
  console.log(`  收到回复：${JSON.stringify(out)}`);
  ok(!sentText.includes('10000001'), '请求体里没有 QQ 号（已脱敏）');
  ok(!sentText.includes('测试群甲'), '请求体里没有群名（已脱敏）');
  ok(sentText.includes('@U'), '请求体里确实是占位符形态');
  // ⚠️ 昵称「阿明」按生产配置**不脱**（maskNames=false），这里顺带钉住这个行为 ——
  //    哪天有人把开关又打开，这条会红，提醒他"提示词里的常用词会被换掉"。
  ok(sentText.includes('阿明'), '昵称按生产配置原样保留（不脱昵称）');
  ok(out === '他说10000001好，完了', '回复里的占位符换回了真值（包括被 SSE 切成两半的那个）', JSON.stringify(out));

  // ② 非流式那条路（`phrase`）——这里**只验同一套函数，不真发请求**。
  //    ⚠️ 第一版这里真调了 `llm.phrase({...over})`，结果 `phrase()` 根本没有 `over` 参数
  //       （它内部用 `llmCfg()`）⇒ 请求打到了**生产配置的模型**上：
  //       假服务的记录是空的、返回的却是真模型的回答。这种"测试偷偷花钱/上网"最要命，
  //       所以这条路只验函数行为，网络那半段靠第 ① 项（streamChat 走的是同一对函数）。
  const pv = privacy.maskMessages([
    {role: 'system', content: '你是测试群甲的助手'},
    {role: 'user', content: '阿明（10000001）问：今晚打吗'},
  ]);
  const sent2Text = pv.messages.map((m) => m.content).join('\n');
  console.log(`  非流式那条路会发的：${JSON.stringify(sent2Text)}`);
  ok(
    !sent2Text.includes('10000001') && !sent2Text.includes('测试群甲'),
    '非流式那条路（润色 / 说话判断 / 抽取都走它）用的是同一套 maskMessages',
  );
  ok(privacy.unmask(`他说${phMing}好`, pv.map) === '他说10000001好', 'unmask 能把非流式的返回还原（phrase 里就是这么调的）');

  server.close();
  setPrivacy({}); // 还原生产配置（内存里那份）
}

console.log(`结果：${pass} 通过 / ${fail} 失败`);
try {
  rmSync(TMP, {recursive: true, force: true});
} catch {
  /* 临时目录清不掉就算了 */
}
process.exit(fail ? 1 : 0);
