#!/usr/bin/env node
/**
 * 把当前项目推一份到**私有备份仓库** `hzyzhzy/sakibot`（防数据丢失）。
 *
 * ⚠️ 和公开的 `hzyzhzy/saki-ai-bot` 是**两个不同的仓库**，各推各的：
 *   · 公开那份走 `tools/make-public.cjs` 导出到 `qq-ai-bot-public/`，它自己排除
 *     `personas/` / `knowledge/` / `logs/` / `state/` 那些；
 *   · 私有这份**就是这个目录本身**（含 config.yml、accounts、personas/<主人> 人设），
 *     所以才会被 `.gitignore` 挡住的那些敏感东西要格外注意 ✓
 *
 * 用法：
 *   node tools/push-private.mjs            # 推 master
 *   node tools/push-private.mjs --dry      # 只看会推什么，不真推
 *
 * ⚠️ 三件事这个脚本替你兜住了：
 *   ① GitHub 这台机器**必须走代理 7890**（hosts 被加速器写死了，直连必失败）；
 *   ② token 会出现在 git 的参数和报错里 ⇒ 输出**一律打码**再打印，别把 token 漏进日志 ✗；
 *   ③ 推之前**校验一遍**：`logs/ state/ knowledge/ library/ node_modules/` 一个都不许进 ✗
 */
import { readFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'hzyzhzy/sakibot';
const PROXY = 'http://127.0.0.1:7890';

const dry = process.argv.includes('--dry');

// ── ① 读 token（在 logs/发布凭据.md，那个文件被 .gitignore 挡着，不会进仓库 ✓）
let tok = '';
try {
  tok = readFileSync(join(ROOT, 'logs', '发布凭据.md'), 'utf8').match(/github_pat_[A-Za-z0-9_]+/)?.[0] ?? '';
} catch {}
if (!tok) {
  console.error('✗ 没找到 GitHub PAT —— 应该在 logs/发布凭据.md 里（`github_pat_…` 开头）');
  process.exit(1);
}
/** ⚠️ 任何要打印的东西都过一遍它，别把 token 漏出去 ✗ */
const mask = (s) => String(s ?? '').split(tok).join('***');

function git(args, opts = {}) {
  return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
}

// ── ② 推之前校验：这些目录一个都不许在版本库里
const FORBIDDEN = ['logs/', 'state/', 'knowledge/', 'library/', 'node_modules/'];
const tracked = git(['ls-files']).stdout ?? '';
const files = tracked.split('\n').filter(Boolean);
const bad = files.filter((f) => FORBIDDEN.some((d) => f.startsWith(d)));
if (bad.length) {
  console.error(`✗ 版本库里混进了不该推的东西（${bad.length} 个），先处理再推：`);
  for (const b of bad.slice(0, 10)) console.error(`   · ${b}`);
  process.exit(1);
}
console.log(`✓ 校验通过：版本库 ${files.length} 个文件，${FORBIDDEN.join(' / ')} 一个都没进 ✓`);

if (dry) {
  const st = git(['status', '--short']).stdout ?? '';
  console.log(`\n[dry] 未提交的改动：\n${st.trim() || '（干净）'}`);
  console.log(`\n[dry] 真推的话会推 master 到 https://github.com/${REPO}.git`);
  process.exit(0);
}

// ── ③ 推（走代理；⚠️ token 走 URL，别写进 .git/config ✗）
const r = git([
  '-c',
  `http.proxy=${PROXY}`,
  '-c',
  `https.proxy=${PROXY}`,
  'push',
  `https://x-access-token:${tok}@github.com/${REPO}.git`,
  'master',
]);
const out = mask(`${r.stdout ?? ''}${r.stderr ?? ''}`).trim();

/**
 * ⚠️ 2026-10-19 加：**记一行到 `logs/private-backup.log`** ——
 *    这个脚本会被**计划任务**每天跑一次（没人看着），失败必须留痕，
 *    不然"备份已经三天没推成功"这种事故根本发现不了 ✓
 *    ⚠️ 日志也在 `logs/` 里（被 gitignore 挡着）⇒ 不会自己推自己 ✓
 */
function writeLog(ok, text) {
  try {
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
    appendFileSync(
      join(ROOT, 'logs', 'private-backup.log'),
      `[${stamp}] ${ok ? 'OK  ' : 'FAIL'} ${mask(text).replace(/\s+/g, ' ').slice(0, 300)}\n`,
      'utf8',
    );
  } catch {}
}

if (r.status === 0) {
  console.log(out ? `✓ 推好了\n${out}` : '✓ 推好了（没有新提交，已经是最新）');
  writeLog(true, out || '没有新提交');
} else {
  console.error(`✗ 推失败（退出码 ${r.status}）：\n${out}`);
  writeLog(false, `退出码 ${r.status}｜${out}`);
  if (/403|Write access to repository not granted/i.test(out)) {
    console.error(
      '\n⇒ 这是 **token 权限**问题（不是代码问题）：\n' +
        `   去 GitHub → Settings → Developer settings → Fine-grained tokens →\n` +
        `   那个 token 的 Repository access 里勾上 sakibot，Contents 给 Read and write ✓`,
    );
  }
  if (/Connection was reset|Could not resolve|Failed to connect/i.test(out)) {
    console.error('\n⇒ 连不上 GitHub ⇒ 先确认代理 7890 开着（这台机器的 hosts 被加速器写死了）✗');
  }
  process.exit(1);
}
