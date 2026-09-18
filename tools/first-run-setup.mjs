/**
 * 首次运行配置（安装器调它，手动装的人也能用）。
 *
 * ## 它干什么
 *   1. 用 `config.example.yml` 生成 `config.yml`（填 QQ 号 / API Key / token / 要监听的群）
 *   2. 把 `knowledge/*.example.md` 复制成真文件（**已存在就不动**，不会覆盖你写过的东西）
 *   3. 建好 `logs/` `state/` `manual/` 这些目录
 *   4. 把**生成出来的 token 写进 `安装信息.txt`** —— 手动装 NapCat 的人要拿它去填
 *
 * ## 用法
 * ```bash
 * # 安装器调用（推荐）：把向导里问到的答案放一个 json 里传进来
 * node tools/first-run-setup.mjs --answers C:\Temp\saki-answers.json --force
 *
 * # 手动用：直接给参数
 * node tools/first-run-setup.mjs --bot-qq 123456 --owner-qq 654321 \
 *      --api-key sk-xxx --groups 111111,222222
 *
 * # 只想看看会改成什么（不写盘）
 * node tools/first-run-setup.mjs --bot-qq 1 --owner-qq 2 --api-key k --dry-run
 * ```
 *
 * ⚠️ 已经存在 `config.yml` 时：**先备份成 `config.yml.bak-<时间戳>` 再写**（不静默覆盖）。
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

/** 取 `--key value` 形式的参数 */
function arg(name, def = '') {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : def;
}
const has = (name) => argv.includes(`--${name}`);

const dryRun = has('dry-run');
const force = has('force');

// ── 收答案：优先 --answers 里的 json，其次命令行参数 ──────────
let answers = {};
const answersPath = arg('answers');
if (answersPath) {
  if (!existsSync(answersPath)) {
    console.error(`✗ 找不到答案文件：${answersPath}`);
    process.exit(1);
  }
  try {
    // ⚠️ 2026-09-17：**必须先剥掉 BOM** —— Windows 上很多工具（记事本、PowerShell 的
    //    `Set-Content -Encoding UTF8`）写 JSON 会带 BOM，而 `JSON.parse` 见到 BOM 直接
    //    报「Unexpected token ''」。（实测踩过：我自己的测试脚本就这么挂了。）
    const raw = readFileSync(answersPath, 'utf8').replace(/^\uFEFF/, '');
    answers = JSON.parse(raw);
  } catch (e) {
    console.error(`✗ 答案文件不是合法 JSON：${e.message}`);
    process.exit(1);
  }
}

/** 只留数字（群号 / QQ 号） */
const digits = (s) => String(s ?? '').replace(/\D/g, '');

const botQQ = digits(answers.botQQ ?? arg('bot-qq'));
const ownerQQ = digits(answers.ownerQQ ?? arg('owner-qq'));
// ⚠️ API Key / token 里可能有引号或反斜杠，会破坏 YAML → 直接剔掉（正常的 Key 用不到这些字符）
const clean = (s) => String(s ?? '').replace(/["'\\\r\n\t]/g, '').trim();
const apiKey = clean(answers.apiKey ?? arg('api-key'));
const token = clean(answers.token ?? arg('token')) || randomBytes(24).toString('hex');
const groups = String(answers.groups ?? arg('groups', ''))
  .split(/[,，、\s]+/)
  .map(digits)
  .filter((g) => g.length >= 5 && g.length <= 12);

const problems = [];
if (!botQQ) problems.push('没给机器人 QQ 号（--bot-qq）');
if (!ownerQQ) problems.push('没给主人的 QQ 号（--owner-qq）');
if (!apiKey) problems.push('没给大模型 API Key（--api-key）。可以留空，装好后在管理界面里填');

const examplePath = join(ROOT, 'config.example.yml');
if (!existsSync(examplePath)) {
  console.error(`✗ 找不到模板 ${examplePath} —— 这个脚本要在机器人目录里跑（tools/ 的上一级）`);
  process.exit(1);
}

let yaml = readFileSync(examplePath, 'utf8');
const notFound = [];
/** 换掉模板里的占位符；换不到就记下来（说明模板改过了，要同步改这个脚本） */
function fill(placeholder, value, label) {
  if (!yaml.includes(placeholder)) {
    notFound.push(label);
    return;
  }
  yaml = yaml.split(placeholder).join(value);
}
fill('<机器人的 QQ>', botQQ || '<机器人的 QQ>', 'botQQ');
fill('<主人的 QQ>', ownerQQ || '<主人的 QQ>', 'ownerQQ');
fill('<你的大模型 API Key>', apiKey || '<你的大模型 API Key>', 'llm.apiKey');
fill('<你的 NapCat token，要和 NapCat 界面里设的一致>', token, 'onebot.accessToken');

/**
 * 把一段「键 + 它下面所有**更缩进**的行」整块换掉。
 *
 * ⚠️⚠️ 2026-09-17 修的真 bug（第一次自测就抓到了）：
 *    原来的循环判断是「这行有缩进就继续吃」（`/^\s+\S/`），结果
 *    **把同级键也一起吃了** —— 换掉 `  allowGroups:` 时，
 *    紧跟其后的 `  respondTo:` `  requireAtInGroup:` …… 直到 `context:`
 *    全被删掉，生成出来的 config.yml 少了半个 trigger 段。
 *    正确判据：**缩进比键那行更深**才算它的子行；碰到同级或更外层就停。
 */
function replaceBlock(text, keyLine, newLines) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l === keyLine);
  if (i < 0) return { text, ok: false };
  const indent = keyLine.match(/^\s*/)[0].length;
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j];
    if (l.trim() === '') break; // 空行 = 块结束
    if (l.match(/^\s*/)[0].length <= indent) break; // 同级 / 更外层 = 块结束
    j += 1;
  }
  const out = [...lines.slice(0, i), keyLine, ...newLines, ...lines.slice(j)];
  return { text: out.join('\n'), ok: true };
}

if (groups.length) {
  const r1 = replaceBlock(yaml, '  allowGroups:', groups.map((g) => `    - '${g}'`));
  yaml = r1.text;
  if (!r1.ok) notFound.push('trigger.allowGroups');
  // 每个群都给最活跃档（1 档）；想分档之后在管理界面「按群设定」里改
  const r2 = replaceBlock(yaml, '  groupRespondTo:', groups.map((g) => `    '${g}': 1`));
  yaml = r2.text;
  if (!r2.ok) notFound.push('trigger.groupRespondTo');
  // 老字段（现在只当"默认群"用）跟着设成第一个群
  yaml = yaml.replace(/^  group: '.*'$/m, `  group: '${groups[0]}'`);
}

// ── 写盘 ────────────────────────────────────────────────
// ── 写盘前的自检 ─────────────────────────────────────────
// ⚠️⚠️ 为什么要这一步：上面那种「整块替换」翻车过一次 —— 生成出来的 config.yml
//    少了半个 trigger 段，但**没有任何报错**，用户装完才发现机器人不按要求接话。
//    所以写盘前先确认这些关键行还在；少一个就**直接报错不写**（宁可失败，也别给半成品）。
const MUST_HAVE = [
  'onebot:',
  'llm:',
  'trigger:',
  '  respondTo:',
  '  requireAtInGroup:',
  '  groupRespondTo:',
  '  historyRounds:',
  'context:',
  'status:',
  'webui:',
  'ownerQQ:',
  'botQQ:',
];
const missing = MUST_HAVE.filter((k) => !yaml.includes(`\n${k}`) && !yaml.startsWith(k));
if (missing.length) {
  console.error('✗ 生成出来的 config.yml 缺了这些关键行，已中止（没有写盘）：');
  missing.forEach((m) => console.error(`    ${m}`));
  console.error('  → 多半是 config.example.yml 的结构改了，需要同步改 tools/first-run-setup.mjs');
  process.exit(2);
}

const cfgPath = join(ROOT, 'config.yml');
const backupNote = [];
if (dryRun) {
  console.log('（--dry-run：不写盘）会生成 config.yml：');
  console.log(yaml.split('\n').slice(0, 12).join('\n') + '\n…');
} else {
  if (existsSync(cfgPath)) {
    const bak = `${cfgPath}.bak-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
    copyFileSync(cfgPath, bak);
    backupNote.push(`旧的 config.yml 已备份成 ${basename(bak)}`);
  } else if (!force) {
    // 没给 --force 也不阻断：安装器第一次跑就是没有这个文件
  }
  writeFileSync(cfgPath, yaml, 'utf8');
}

// 知识库：模板 → 真文件（**已存在就跳过**，绝不覆盖用户写过的内容）
const kdir = join(ROOT, 'knowledge');
const made = [];
if (existsSync(kdir) && !dryRun) {
  for (const f of readdirSync(kdir)) {
    if (!f.endsWith('.example.md')) continue;
    const target = join(kdir, f.replace(/\.example\.md$/, '.md'));
    if (existsSync(target)) continue;
    copyFileSync(join(kdir, f), target);
    made.push(basename(target));
  }
}

// 运行期目录
for (const d of ['logs', 'state', 'manual']) {
  if (!dryRun) mkdirSync(join(ROOT, d), { recursive: true });
}

// ── 安装信息（token 要抄进 NapCat，所以单独写一份文件）─────
if (!dryRun) {
  writeFileSync(
    join(ROOT, '安装信息.txt'),
    [
      '客服小祥 · 安装信息',
      '='.repeat(40),
      '',
      `机器人 QQ：${botQQ || '（没填）'}`,
      `主人 QQ：${ownerQQ || '（没填）'}`,
      `要说话的群：${groups.length ? groups.join('、') : '（还没配 —— 装好后在管理界面「按群设定」里加）'}`,
      '',
      '⚠️ 下面这串 token 要**填进 NapCat**（OneBot WebSocket 服务端的 token）：',
      token,
      '',
      '装 NapCat 的步骤（如果还没装）：',
      '  1. 到官方仓库下载 NapCat.Shell：https://github.com/NapNeko/NapCatQQ/releases',
      '  2. 解压到 <本目录>\\napcat\\NapCat.Shell\\',
      '  3. 双击那个目录里的 launcher-win10-user.bat（会启动 QQ 并注入 NapCat）',
      '  4. 打开 NapCat 的 WebUI（默认 http://127.0.0.1:6099）→ 网络配置 →',
      '     新建 WebSocket 服务端：端口 3001、token 填上面那串',
      '     ★ 懒人做法（推荐）：这串 token **不用手填** —— 服务端建好之后，',
      '       回到本目录跑一次：  node tools\\napcat-align-token.mjs',
      '       它会自动把这串 token 写进 NapCat 的配置（两边本来就是明文 JSON，能对齐）。',
      '       ⚠️ 改完要**重启一次 NapCat** 才生效，跑之前可以先加 --check 只看不动手。',
      '  5. ★★ **反检测一定要开**（不开这个号容易被 QQ 风控）：',
      '       打开 NapCat 的 WebUI（http://127.0.0.1:6099）→ 左侧「系统配置」→「反检测」',
      '       → 把 Hook / Window / Module / Process / Container / JS 六项**全开**，',
      '         O3 Hook 模式也开着 → 点保存 → **然后重启 NapCat**',
      '       （那一页自己写着「修改后需重启生效」）。',
      '  6. 回来双击「一键启动（QQ+机器人）.bat」',
      '',
      '管理界面（机器人自己的）：http://127.0.0.1:3099',
      '',
      '⚠️ NapCat 遵循它自己的 Limited Redistribution License（不得商用）；',
      '   使用第三方 QQ 协议端有账号被风控的风险，请自行评估。',
    ].join('\n'),
    'utf8',
  );
}

// ── 报告 ────────────────────────────────────────────────
console.log('客服小祥 · 首次配置');
console.log('─'.repeat(40));
console.log(`  机器人 QQ     : ${botQQ || '（空）'}`);
console.log(`  主人 QQ       : ${ownerQQ || '（空）'}`);
console.log(`  大模型 Key    : ${apiKey ? '已填（' + apiKey.slice(0, 6) + '…）' : '⚠️ 还没填，装好后在管理界面里填'}`);
console.log(`  要说话的群    : ${groups.length ? groups.join('、') : '（空 —— 装好后在管理界面「按群设定」里加）'}`);
console.log(`  OneBot token  : ${token.slice(0, 8)}…（完整的那串写在 安装信息.txt 里）`);
console.log(`  config.yml    : ${dryRun ? '（演练，没写）' : '已生成'}`);
if (made.length) console.log(`  知识库模板    : ${made.join('、')}`);
if (backupNote.length) backupNote.forEach((n) => console.log(`  ⚠️ ${n}`));
if (notFound.length) {
  console.log(`  ⚠️ 模板里没找到这些占位符（模板改过？）：${notFound.join('、')}`);
}
if (problems.length) {
  console.log('');
  problems.forEach((p) => console.log(`  ⚠️ ${p}`));
}
console.log('─'.repeat(40));
process.exit(0);
