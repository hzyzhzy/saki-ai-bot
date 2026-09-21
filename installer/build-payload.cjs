/**
 * 生成安装器要装的内容（payload）。
 *
 * ## 为什么有这么个脚本
 *   安装器里装的东西**必须和公开副本一致**（同一份脱敏产物），不能拿工作目录里的
 *   私有知识库/密钥去打包 —— 那等于把用户资料打进分发文件里。
 *   所以：**从 `qq-ai-bot-public/` 拷**，再补上三样公开副本里没有的东西：
 *     ① `node/node.exe`（内嵌的 Node 运行时 —— 用户就不用自己装 Node 了）
 *     ② `node/LICENSE-node.txt` + `THIRD-PARTY-NOTICES.md`（第三方许可声明）
 *     ③ `build-info.txt`（这次打包用的是哪一版）
 *
 * ## 用法（在 qq-ai-bot 目录里）
 * ```bash
 * node installer/build-payload.cjs             # 直接用现在的公开副本
 * node installer/build-payload.cjs --refresh   # 先重跑 tools/make-public.cjs 再打包
 * ```
 *
 * 产物：`installer/build/payload/`（Inno 脚本 `saki-bot.iss` 就装这个目录）
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LIVE = path.resolve(__dirname, '..'); // qq-ai-bot
/**
 * 装什么进 payload？默认「脱敏后的公开副本」。
 * ⚠️ 但**克隆公开仓库的人**没有那个目录（公开仓库本身就是内容源）→ 那就退化成"用仓库自己"。
 *    两种情况都安全：跳过清单里已经排除了 config.yml / state / logs / installer 这些。
 */
const PUBLIC_SIBLING = path.resolve(LIVE, '..', 'qq-ai-bot-public');
const srcArgIdx = process.argv.indexOf('--src');
const SRC = path.resolve(
  srcArgIdx >= 0 && process.argv[srcArgIdx + 1]
    ? process.argv[srcArgIdx + 1]
    : fs.existsSync(PUBLIC_SIBLING)
      ? PUBLIC_SIBLING
      : LIVE,
);
const DST = path.join(__dirname, 'build', 'payload');

const argv = process.argv.slice(2);
const refresh = argv.includes('--refresh');

// ── 不进安装包的东西 ─────────────────────────────────────
// ⚠️ 判断依据：「用户装了也没用」或者「装了反而不该给」。
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'logs', // 运行期
  'state', // 运行期（含聊天记录、榜单）
  'manual', // 从 README 生成的说明书（本地看就行）
  'installer', // 安装器自己的源码/产物（否则自我递归，还会把 100MB payload 打进去）
  '_pending', // 表情待标注队列
  '_old', // 表情旧图
  '_toobig', // 超大表情
  '.github',
]);
const SKIP_FILES = [/^config\.yml$/, /^安装信息\.txt$/, /\.bak-/, /^\.napcat/];

/**
 * 递归拷贝。
 * ⚠️ `useSkip` 默认 true：按上面的跳过清单过滤。
 *    拷 `node_modules` 时必须传 **false** —— 否则它自己就在跳过清单里，
 *    结果是"拷了 0 个文件"却**不报错**（我第一次就是这么把依赖弄丢的）。
 */
function copyTree(src, dst, rel = '', useSkip = true) {
  const st = fs.statSync(src);
  const base = path.basename(src);
  if (st.isDirectory()) {
    if (useSkip && SKIP_DIRS.has(base)) return { files: 0, bytes: 0, skipped: [rel + '/'] };
    fs.mkdirSync(dst, { recursive: true });
    let files = 0;
    let bytes = 0;
    const skipped = [];
    for (const e of fs.readdirSync(src)) {
      const r = copyTree(path.join(src, e), path.join(dst, e), rel ? `${rel}/${e}` : e, useSkip);
      files += r.files;
      bytes += r.bytes;
      skipped.push(...r.skipped);
    }
    return { files, bytes, skipped };
  }
  if (useSkip && SKIP_FILES.some((re) => re.test(base))) return { files: 0, bytes: 0, skipped: [rel] };
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return { files: 1, bytes: st.size, skipped: [] };
}

// ── 0. 可选：先刷新公开副本 ──────────────────────────────
if (refresh) {
  const mk = path.join(LIVE, 'tools', 'make-public.cjs');
  if (!fs.existsSync(mk)) {
    // 克隆公开仓库的人没有这个脚本（它本身不进公开版）—— 那就直接用手上的内容
    console.log('【0】没有 tools/make-public.cjs（公开副本里不带它）→ 跳过刷新，直接用当前内容');
  } else {
    console.log('【0】先重跑 tools/make-public.cjs（刷新脱敏副本）…');
    execFileSync(process.execPath, [mk], { cwd: LIVE, stdio: 'inherit' });
  }
}

if (!fs.existsSync(SRC)) {
  console.error(`✗ 找不到内容源：${SRC}`);
  console.error('  用 --src <目录> 指定，或者在工作目录里先跑一次 `node tools/make-public.cjs`');
  process.exit(1);
}

// ── 1. 清空重建 ──────────────────────────────────────────
fs.rmSync(DST, { recursive: true, force: true });
fs.mkdirSync(DST, { recursive: true });

// ── 2. 拷公开副本 ────────────────────────────────────────
const r = copyTree(SRC, DST);
console.log(`【1】公开副本 → payload：${r.files} 个文件 / ${(r.bytes / 1048576).toFixed(1)} MB`);
if (r.skipped.length) {
  console.log(`      跳过 ${r.skipped.length} 项：${r.skipped.slice(0, 8).join('、')}${r.skipped.length > 8 ? ' …' : ''}`);
}

// ── 3. 内嵌 Node 运行时 ──────────────────────────────────
//
// ⚠️ Node 是 MIT 许可，**可以随安装包分发**（附上许可声明即可）。
//    用当前这台机器上正在跑的 node.exe（= 官方 Windows x64 构建）。
//    想换成指定版本：把官方 zip 里的 node.exe 放进 installer/vendor/ 再打包。
const vendorNode = path.join(__dirname, 'vendor', 'node.exe');
const nodeSrc = fs.existsSync(vendorNode) ? vendorNode : process.execPath;
fs.mkdirSync(path.join(DST, 'node'), { recursive: true });
fs.copyFileSync(nodeSrc, path.join(DST, 'node', 'node.exe'));
const nodeMb = (fs.statSync(nodeSrc).size / 1048576).toFixed(1);
let nodeVer = '';
try {
  nodeVer = execFileSync(nodeSrc, ['--version'], { encoding: 'utf8' }).trim();
} catch {}
console.log(`【2】内嵌 Node：${nodeVer}（${nodeMb} MB）← ${nodeSrc === vendorNode ? 'installer/vendor' : '当前运行的这个 node'}`);

fs.writeFileSync(
  path.join(DST, 'node', 'LICENSE-node.txt'),
  [
    'Node.js is licensed for use as follows:',
    '',
    '"""',
    'Copyright Node.js contributors. All rights reserved.',
    '',
    'Permission is hereby granted, free of charge, to any person obtaining a copy',
    'of this software and associated documentation files (the "Software"), to',
    'deal in the Software without restriction, including without limitation the',
    'rights to use, copy, modify, merge, publish, distribute, sublicense, and/or',
    'sell copies of the Software, and to permit persons to whom the Software is',
    'furnished to do so, subject to the following conditions:',
    '',
    'The above copyright notice and this permission notice shall be included in',
    'all copies or substantial portions of the Software.',
    '',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
    'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
    'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
    'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING',
    'FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS',
    'IN THE SOFTWARE.',
    '"""',
    '',
    `（本安装包内嵌的版本：${nodeVer}，来源：https://nodejs.org/ 官方 Windows x64 构建）`,
    '',
  ].join('\n'),
  'utf8',
);

// ── 3.5 npm 依赖（**别忘了！漏了就是"装完跑不起来"**）────────
//
// ⚠️⚠️ 2026-09-17 踩的坑：第一版 payload 没带 node_modules，
//    装出来的版本一启动就 `ERR_MODULE_NOT_FOUND: Cannot find package 'ws'`。
//    这个坑只有在"装完真的启动一次"时才会暴露 —— 所以下面那步自检是必须的。
//
// 做法：优先直接拷工作目录里已经装好的 `node_modules`（离线、和开发环境一致）；
//      没有才现场 `npm install --omit=dev`。
const deps = Object.keys(require(path.join(DST, 'package.json')).dependencies || {});
const liveModules = path.join(LIVE, 'node_modules');
const dstModules = path.join(DST, 'node_modules');
if (fs.existsSync(liveModules)) {
  const r2 = copyTree(liveModules, dstModules, 'node_modules', false); // false = 不要套跳过清单
  console.log(`【2.5】npm 依赖：从工作目录拷了 ${r2.files} 个文件 / ${(r2.bytes / 1048576).toFixed(1)} MB（${deps.length} 个依赖）`);
} else {
  console.log('【2.5】工作目录没有 node_modules → 现场 npm install --omit=dev …');
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: DST,
    stdio: 'inherit',
  });
}

// 自检：package.json 里写的依赖必须真的都在 payload 里
const missingDeps = deps.filter((d) => !fs.existsSync(path.join(dstModules, ...d.split('/'))));
if (missingDeps.length) {
  console.error('✗ payload 里缺这些依赖，装出来会跑不起来：');
  missingDeps.forEach((d) => console.error(`    ${d}`));
  console.error('  → 先在工作目录 `npm install`，再重新打包');
  process.exit(1);
}

// ── 4. 第三方许可声明 ────────────────────────────────────
//
// ⚠️⚠️ 这一节是**法律要求**，不是客套：NapCat 的协议里明确写着重分发要附许可、标来源。
//     我们的做法是**不分发 NapCat**（让用户自己去官方下），所以这里只做声明与指引。
fs.writeFileSync(
  path.join(DST, 'THIRD-PARTY-NOTICES.md'),
  `# 第三方组件与许可声明

本安装包/本仓库**只分发自己的代码**，以及一个 Node.js 运行时。用到的第三方组件如下。

## 1. Node.js（**内嵌**在 \`node\\node.exe\`）

- 许可：MIT
- 版权：Copyright Node.js contributors
- 完整许可文本见 \`node\\LICENSE-node.txt\`
- 官方：https://nodejs.org/

## 2. SnowLuma（**没有内嵌**，需要你自己安装）

- 一份 OneBot 11 协议端实现（独立应用，不依赖 QQ 客户端的快速登录凭据）。
- 项目：https://github.com/SnowLuma/SnowLuma （官方发行包在它的 Releases 里）
- 许可：**SnowLuma Source-Available Non-Commercial License**（**不是** OSI 开源许可），要点：
  1. 可以查看、学习、**非商业**自用，并在规定条件下修改或再分发；
  2. **不得用于任何商业用途**；
  3. **公开发布修改版或衍生版，须事先取得著作权人的书面授权**；
  4. 官方发行包中的**专有组件**不在源码许可范围内 —— 其 EULA 第 5.4 条明确要求
     事先书面授权，才能「将其并入第三方安装包或 Docker 镜像」或「通过自动化脚本部署」。
- 本项目因此：**既不打包它、也不自动下载/部署它** —— 安装器只把 \`config.yml\` 里的
  协议端写对，剩下的按它的官方渠道**由你自己安装**（**这一步是你与它作者之间的关系**）。
- ⚠️ 顺带一句：它是**注入式**的（会注入所有被发现的 QQ 进程）⇒ 建议只登机器人那一个号。

## 3. NapCatQQ（**没有内嵌**，需要你自己安装）

- 项目：https://github.com/NapNeko/NapCatQQ
- 许可：**Limited Redistribution License for NapCat**（Copyright © 2024 Mlikiowa）
  —— **这不是一个标准开源许可**，要点：
  1. 未经作者明确许可，禁止未授权的使用/复制/修改/分发；
  2. **允许再分发，但必须附上该许可全文、并明确标注来源与版权**；
     为再分发做的小修改可以，但**改过的代码不得公开**；
  3. **不得用于任何商业用途**；
  4. 其它权利需向作者申请。
- 本项目因此：**不打包、不再分发 NapCat**，只在安装器里给你官方下载地址，
  由你自行下载安装（**这一步是你与 NapCat 作者之间的关系**）。
- ⚠️ 因为依赖 NapCat，**本项目的整体使用也不得用于商业用途**。

## 4. 表情图片（\`library\\\` 目录）

- 来源：网络与群聊，版权归各自原作者，仅作演示；
  介意的话把 \`library\\\` 换成你自己的图片（或整个删掉，机器人只是没有表情包可用）。

## 5. 其它依赖

- \`package.json\` 里列出的 npm 包，各自的许可见 \`node_modules\\<包>\\LICENSE\`。

## ⚠️ 风险提示

本程序通过第三方协议端（NapCat / SnowLuma / LLBot 等）接入 QQ，**这可能违反腾讯的服务条款**，
账号存在被限制/风控的风险，请自行评估。本程序按"原样"提供，不提供任何担保。
`,
  'utf8',
);

// ── 5. 打包信息（出问题时能对上"这是哪一版"）──────────────
let gitHead = '';
try {
  gitHead = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: LIVE, encoding: 'utf8' }).trim();
} catch {}
let pubHead = '';
try {
  pubHead = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: SRC, encoding: 'utf8' }).trim();
} catch {}
fs.writeFileSync(
  path.join(DST, 'build-info.txt'),
  [
    '客服小祥 · 安装内容信息',
    `打包时间：${new Date().toISOString()}`,
    `内嵌 Node：${nodeVer}`,
    `工作目录提交：${gitHead || '(无 git)'}`,
    `公开副本提交：${pubHead || '(无 git)'}`,
    '',
    '（这份文件是打包时自动生成的，用来对"这一版到底装了什么"。）',
  ].join('\n'),
  'utf8',
);

// ── 6. 统计 ──────────────────────────────────────────────
function dirStat(dir) {
  let files = 0;
  let bytes = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const s = dirStat(p);
      files += s.files;
      bytes += s.bytes;
    } else {
      files += 1;
      bytes += fs.statSync(p).size;
    }
  }
  return { files, bytes };
}
const total = dirStat(DST);
console.log(`【3】payload 完成：${total.files} 个文件 / ${(total.bytes / 1048576).toFixed(1)} MB`);
console.log('      下一步：用 Inno 编译安装器 →');
console.log(`        & '${path.join(process.env.LOCALAPPDATA, 'Programs', 'Inno Setup 6', 'ISCC.exe')}' '${path.join(__dirname, 'saki-bot.iss')}'`);
