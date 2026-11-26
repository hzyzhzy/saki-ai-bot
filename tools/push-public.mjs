#!/usr/bin/env node
/**
 * 把本目录**脱敏导出**到 `../qq-ai-bot-public`，再推到公开仓库 `hzyzhzy/saki-ai-bot`。
 *
 * ## 🚫 这是**手动工具**，不许建计划任务（2026-11-27 定）
 * 原话：「**公开不要自动推，自动推不会重新检查一遍**」。
 * 理由站得住：机器只能扫**清单里已经列出来的**那些形态，扫不出"这轮新写进来的一种真数据"；
 * 公开仓库一旦推上去就收不回来，所以推之前**必须有人（我）真的看一遍会推什么**。
 * ⇒ 唯一正确用法：`--dry` 跑一遍 → 把「会推什么 + 检查结果」报给用户 → 他点头 → 再去掉 `--dry` 真推。
 * ⚠️ 私人仓库（`push-private.mjs`）可以自动跑，它不外发，泄漏不了什么。
 *
 * 用法：
 *   node tools/push-public.mjs --dry     # 导出 + 检查 + 报"会推什么"，不 commit 也不 push（**先用这个**）
 *   node tools/push-public.mjs           # 导出 → 安全检查 → commit → push（连不上会重试 3 次）
 *
 * ## 为什么要有「安全检查」这一层
 * `make-public.cjs` 已经做了脱敏（252 文件 / 1684 处）+ 作者信息自检，但它**不知道
 * 哪些是"这一轮新写进来的真数据"**。公开仓库一旦推上去就不可逆，所以推之前再自己扫一遍：
 * 命中就**中止**，一个字节都不推 ✗
 *
 * ## ⚠️ 这个脚本自己也得干净
 * 待禁的真值（真 QQ / 真群号 / access token / 域名 / 本机路径）**一律不写在这里** ——
 * 写了就等于把它们一起送进公开仓库（第一版就踩了这个：扫描器把自己拦下来了 ✓ 它是对的）。
 * ⇒ 真值放在 `logs/public-deny.txt`（一行 `模式<TAB>说明`），那个目录被 `.gitignore`
 *   和 `make-public.cjs` 双重排除，永远不会外发 ✓
 * 脚本里只留**通用形态**（`sk-…`、`github_pat_`），它们不是隐私。
 *
 * ## 重新导出会不会毁掉公开副本的 git 历史
 * 不会。`make-public.cjs` 的跳过清单里有 `.git`，它只重建工作区文件 ✓
 * （这也是能自动化的前提：`qq-ai-bot-public/.git` 留着，每次只多一个 commit）
 */
import { readFileSync, appendFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DST = join(ROOT, '..', 'qq-ai-bot-public');
const REPO = 'hzyzhzy/saki-ai-bot';
const PROXY = 'http://127.0.0.1:7890';
const LOGFILE = join(ROOT, 'logs', 'public-backup.log');
const DENYFILE = join(ROOT, 'logs', 'public-deny.txt');
const dry = process.argv.includes('--dry');

/** 只扫这些后缀（`library/*.gif` 是二进制，扫了也没意义还拖慢） */
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.md', '.yml', '.yaml', '.json', '.ps1', '.html', '.py', '.ts', '.txt', '.css', '.bat', '.vbs']);

/** 本脚本 / push-private 里有"要禁的东西"的**字面形态**（正则源码、提示文字），跳过它们 */
const SELF_FILES = new Set(['tools/push-public.mjs', 'tools/push-private.mjs']);

/** 通用形态（不涉及任何具体的人） */
const GENERIC = [
  ['github_pat_', 'GitHub PAT'],
  ['sk-[A-Za-z0-9]{20,}', 'API key 形态'],
];

/** 读本地禁止清单：一行 `模式<TAB>说明`；`#` 开头是注释 */
function loadDeny() {
  const out = [...GENERIC];
  if (!existsSync(DENYFILE)) {
    console.error(`⚠️ 没有 ${DENYFILE} ⇒ 只查通用形态（真 QQ / 群号 / token 一条都没查！）`);
    return out;
  }
  for (const line of readFileSync(DENYFILE, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    // 第一列是模式，后面（空格或 Tab 之后）全是说明 —— 两种分隔都认，免得手写时踩空格/制表符
    const i = t.search(/\s/);
    const pat = (i < 0 ? t : t.slice(0, i)).trim();
    const label = (i < 0 ? '' : t.slice(i)).trim();
    if (pat) out.push([pat, label || '本地禁止清单']);
  }
  return out;
}

function sleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ }
}

function writeLog(tag, text) {
  try {
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
    appendFileSync(LOGFILE, `[${stamp}] ${tag} ${String(text).replace(/\s+/g, ' ').slice(0, 300)}\n`, 'utf8');
  } catch { /* 日志写不进去不该影响主流程 */ }
}

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

const PATTERNS = loadDeny();

// ── ① 导出（`make-public.cjs` 只读本目录、只写副本）
console.log('[1] 导出脱敏副本…');
const mk = spawnSync(process.execPath, [join(ROOT, 'tools', 'make-public.cjs')], { cwd: ROOT, encoding: 'utf8' });
if (mk.status !== 0) {
  console.error('✗ 导出失败：');
  console.error((mk.stdout ?? '') + (mk.stderr ?? ''));
  writeLog('FAIL', `导出失败 status=${mk.status}`);
  process.exit(1);
}
console.log((mk.stdout ?? '').trim().split('\n').slice(-4).join('\n'));

if (!existsSync(join(DST, '.git'))) {
  console.error(`✗ ${DST} 里没有 .git —— 公开副本的仓库没了，先手工修好再自动推 ✗`);
  writeLog('FAIL', '公开副本缺少 .git');
  process.exit(1);
}

// ── ② 安全检查：扫散落的真数据
console.log(`\n[2] 安全检查（${PATTERNS.length} 个模式）…`);
const hits = [];
let scanned = 0;
(function walk(dir) {
  let ents = [];
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name === '.git') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) { walk(full); continue; }
    if (!TEXT_EXT.has(extname(e.name).toLowerCase())) continue;
    let txt = '';
    try { txt = readFileSync(full, 'utf8'); } catch { continue; }
    scanned++;
    const rel = relative(DST, full).replace(/\\/g, '/');
    if (SELF_FILES.has(rel)) continue;
    for (const [pat, label] of PATTERNS) {
      const needRe = /[\[\](){}*+?^$|\\]/.test(pat);
      let n = 0;
      try {
        n = needRe ? (txt.match(new RegExp(pat, 'g')) ?? []).length : txt.split(pat).length - 1;
      } catch { continue; } // 清单里写坏的正则不该把整个检查搞崩
      if (n > 0) hits.push({ file: rel, label, n });
    }
  }
})(DST);

console.log(`    扫了 ${scanned} 个文本文件`);
if (hits.length) {
  console.error(`\n✗ 找到 ${hits.length} 处不该出现在公开副本里的东西 ⇒ **中止，一个字节都不推**：`);
  for (const h of hits.slice(0, 15)) console.error(`   · ${h.file}　${h.label} × ${h.n}`);
  writeLog('ABORT', `安全检查未通过 ${hits.length} 处：${hits.slice(0, 5).map((h) => `${h.file}(${h.label})`).join(', ')}`);
  process.exit(2);
}
console.log('    ✓ 全部 0 命中');

// ── ③ 会推什么
const st = git(['status', '--porcelain'], DST).stdout ?? '';
const changed = st.split('\n').filter(Boolean);
if (!changed.length) {
  console.log('\n[3] 没有改动 ⇒ 不需要提交，也不用推 ✓');
  writeLog('OK', '没有改动');
  process.exit(0);
}
console.log(`\n[3] 有 ${changed.length} 个文件变了（前 12）：`);
for (const c of changed.slice(0, 12)) console.log(`    ${c}`);

if (dry) {
  console.log('\n[dry] 到此为止：没 commit、没 push。');
  console.log(`[dry] 真跑的话会：git add -A && commit → push 到 https://github.com/${REPO}.git（main）`);
  process.exit(0);
}

// ── ④ commit（只在有改动时）
const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
const add = git(['add', '-A'], DST);
if (add.status !== 0) {
  console.error('✗ git add 失败：' + (add.stderr ?? add.stdout));
  writeLog('FAIL', 'git add 失败');
  process.exit(1);
}
const ci = git(['commit', '-m', `自动同步 ${stamp}`], DST);
if (ci.status !== 0) {
  console.error('✗ git commit 失败（可能没配 user.email）：' + (ci.stderr ?? ci.stdout));
  writeLog('FAIL', 'git commit 失败');
  process.exit(1);
}
console.log(`\n[4] 已提交：自动同步 ${stamp}`);

// ── ⑤ push（走代理 + PAT；连不上就重试）
/* ⚠️ 重试只防"当时代理没起"，不代替人看 —— 见文件头「这是手动工具」那段 */
let tok = '';
try {
  tok = readFileSync(join(ROOT, 'logs', '发布凭据.md'), 'utf8').match(/github_pat_[A-Za-z0-9_]+/)?.[0] ?? '';
} catch {}
if (!tok) {
  console.error('✗ 没找到 GitHub PAT —— 应该在 logs/发布凭据.md 里');
  writeLog('FAIL', '没有 PAT');
  process.exit(1);
}
const url = `https://x-access-token:${tok}@github.com/${REPO}.git`;
const mask = (s) => String(s ?? '').split(tok).join('***');

for (let attempt = 1; attempt <= 3; attempt++) {
  const r = git(['-c', `http.proxy=${PROXY}`, '-c', `https.proxy=${PROXY}`, 'push', url, 'main'], DST);
  const out = mask(`${r.stdout ?? ''}${r.stderr ?? ''}`).trim();
  if (r.status === 0) {
    console.log(`✓ 推好了（第 ${attempt} 次）\n${out}`);
    writeLog('OK', out || '已是最新');
    process.exit(0);
  }
  console.error(`✗ 第 ${attempt} 次推送失败：${out.slice(0, 200)}`);
  if (attempt < 3) {
    /* ⚠️ 4 点那种时间点代理常常还没起来 —— 隔 5 分钟再试。
     *    计划任务里没人看着，"等一会儿"比"当天就算了"强得多 ✓ */
    console.log(`   5 分钟后重试（${attempt}/3）…`);
    sleep(5 * 60 * 1000);
  } else {
    writeLog('FAIL', `3 次都失败：${out}`);
    process.exit(1);
  }
}
