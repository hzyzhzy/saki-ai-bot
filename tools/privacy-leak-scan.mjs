/**
 * 敏感信息扫描：看看**会被发给模型**的那些文件里，还有多少真实身份标识。
 *
 * 用途：脱敏层（`src/privacy.js`）上线前后各跑一次，对比"还没换掉多少东西"。
 * 它**只读**：不改任何文件，也不写生产的映射表（映射表指到临时目录）。
 *
 * 跑法：
 *   node tools/privacy-leak-scan.mjs            # 默认目标（提示词来源 + 今天的日志尾部）
 *   node tools/privacy-leak-scan.mjs a.md b.json
 *   node tools/privacy-leak-scan.mjs --tail=5000
 *
 * ⚠️ 判据用的是 `privacy.mask` 自己的规则（群号/QQ/昵称/群名/URL/IP/密钥），
 *    所以"命中"和"机器人实际会脱敏的东西"是同一套，不存在两套标准。
 * ⚠️ 输出里的原值一律**打码**（这个脚本的输出可能会被贴到对话里）。
 */

import { readFileSync, existsSync, statSync, readdirSync, mkdtempSync } from 'node:fs';
import { join, extname, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// 映射表放临时目录 —— 扫描不该在生产的 state/ 里留下一份新表
process.env.QQBOT_PRIVACY_FILE = join(mkdtempSync(join(tmpdir(), 'pv-scan-')), 'map.json');

/** 项目根 = 这个文件所在目录（tools/）的上一层 */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const privacy = await import('../src/privacy.js');

/** 打码：只留首尾，其余 *。⚠️ 输出会被贴进对话，绝不打印原值 */
function redact(v) {
  const t = String(v);
  const chars = [...t];
  if (chars.length <= 2) return chars[0] + '*';
  if (/^\d+$/.test(t)) return t.slice(0, 3) + '*'.repeat(Math.max(1, t.length - 5)) + t.slice(-2);
  return chars[0] + '*'.repeat(Math.max(1, chars.length - 2)) + chars[chars.length - 1];
}

const TYPE_LABEL = {
  U: '人（QQ 号/昵称/群名片）',
  G: '群号',
  GN: '群名',
  S: '服务器地址/域名/IP',
  K: '密钥/Token',
};

/**
 * 扫一段文本，返回各类命中的实体（去重）。
 * ⚠️ 用 `mask()` 的 map 而不是自己写正则 —— 保证和机器人实际会脱的东西是同一套判据。
 */
function scanText(text) {
  const r = privacy.mask(text);
  const by = {U: [], G: [], GN: [], S: [], K: []};
  for (const [ph, val] of r.map) {
    const m = /^@(GN|U|G|S|K)\d+@$/.exec(ph);
    if (m && by[m[1]]) by[m[1]].push(val);
  }
  return by;
}

/** 读一个目标（文件按整读；`tail` 只取尾部若干行，日志用） */
function readTarget(p, tailLines = 0) {
  if (!existsSync(p)) return null;
  const st = statSync(p);
  if (!st.isFile()) return null;
  const raw = readFileSync(p, 'utf8');
  if (!tailLines) return raw;
  const lines = raw.split('\n');
  return lines.slice(Math.max(0, lines.length - tailLines)).join('\n');
}

function collect(dir, out = []) {
  for (const e of readdirSync(dir, {withFileTypes: true})) {
    const p = join(dir, e.name);
    if (e.isDirectory()) collect(p, out);
    else if (extname(e.name) === '.md') out.push(p);
  }
  return out;
}

/* ── 目标清单 ────────────────────────────────────────────────
 * 分三组，因为"传出去的证据强度"不一样：
 *   A 一定会进提示词（每轮都发）→ 最要紧
 *   B 可能会进（按群/按剧情/私聊工作模式）
 *   C 模型回来的东西（不进提示词，但泄漏面一样要看）
 */
const fileArg = process.argv.find((a) => a.startsWith('--tail='));
const TAIL = fileArg ? Number(fileArg.split('=')[1]) || 3000 : 3000;
const extra = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const TARGETS = extra.length
  ? extra.map((p) => ({p: isAbsolute(p) ? p : join(process.cwd(), p), group: '（指定）', tail: 0}))
  : [
      // A. 每轮都会拼进提示词
      ...collect(join(ROOT, 'knowledge')).map((p) => ({p, group: 'A 知识库（每轮发）', tail: 0})),
      ...collect(join(ROOT, 'personas')).map((p) => ({p, group: 'A 人设（每轮发）', tail: 0})),
      {p: join(ROOT, 'state', 'recent.json'), group: 'A 聊天上下文（每轮发）', tail: 0},
      {p: join(ROOT, 'state', 'names.json'), group: 'A 昵称表（拼上下文用）', tail: 0},
      // B. 视情况拼进提示词
      {p: join(ROOT, 'state', 'storyline.json'), group: 'B 故事线', tail: 0},
      {p: join(ROOT, 'state', 'quest.json'), group: 'B 剧情', tail: 0},
      {p: join(ROOT, 'state', 'quest-shared.json'), group: 'B 剧情（共享）', tail: 0},
      {p: join(ROOT, 'state', 'affinity.json'), group: 'B 好感度', tail: 0},
      {p: join(ROOT, 'state', 'private-work.json'), group: 'B 私聊工作（只读）', tail: 0},
      {p: join(ROOT, 'state', '__prompt-snapshot.json'), group: 'B 提示词快照（历史）', tail: 0},
      // C. 模型回来的
      {p: join(ROOT, 'state', 'think-log.json'), group: 'C 思考链记录', tail: 0},
      // 最新日志（只看尾部：问的是"最近"）
      ...['bot-2026-11-15.log', 'bot-2026-11-15-10000013.log', 'bot-2026-11-15-10000014.log'].map((f) => ({
        p: join(ROOT, 'logs', f),
        group: 'C 最近日志（尾部）',
        tail: TAIL,
      })),
    ];

console.log(`扫描目标 ${TARGETS.length} 个（日志只看尾部 ${TAIL} 行）\n`);
const totals = {U: 0, G: 0, GN: 0, S: 0, K: 0};
const samples = {U: [], G: [], GN: [], S: [], K: []};
let scannedChars = 0;

for (const t of TARGETS) {
  let text;
  try {
    text = readTarget(t.p, t.tail);
  } catch (e) {
    console.log(`  ⚠️ 读不了 ${t.p}：${e.message}`);
    continue;
  }
  if (text == null) continue;
  const t0 = process.hrtime.bigint();
  const by = scanText(text);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  scannedChars += text.length;
  const counts = {};
  let any = 0;
  for (const k of Object.keys(by)) {
    totals[k] += by[k].length;
    if (by[k].length) counts[k] = by[k].length;
    any += by[k].length;
    for (const v of by[k]) if (samples[k].length < 5 && !samples[k].includes(v)) samples[k].push(v);
  }
  const rel = t.p.replace(ROOT + '\\', '').replace(ROOT + '/', '');
  const bad = counts.K ? '  ‼️ 含密钥' : '';
  console.log(
    `${any ? '•' : '·'} [${t.group}] ${rel}  ${text.length} 字 / ${ms.toFixed(0)}ms` +
      (any ? `  → ${JSON.stringify(counts)}${bad}` : '  → 干净'),
  );
}

console.log('\n──────────────── 合计 ────────────────');
console.log(`扫了 ${scannedChars} 字`);
for (const k of ['U', 'G', 'GN', 'S', 'K']) {
  console.log(
    `${k.padEnd(3)} ${TYPE_LABEL[k].padEnd(22)} ${String(totals[k]).padStart(5)} 条` +
      (samples[k].length ? `   样本：${samples[k].map(redact).join(' / ')}` : ''),
  );
}
console.log(
  totals.K
    ? '\n‼️ 有密钥/Token 出现在"会被发出去"的内容里 —— 这是最严重的一类，先查它来自哪个文件（上面那行 ‼️）。'
    : '\n✓ 没有密钥/Token 出现在被扫描的内容里。',
);
if (totals.U + totals.G + totals.GN + totals.S === 0) {
  console.log('✓ 群号 / 群名 / 人名 / 地址 也一条都没有。');
}
