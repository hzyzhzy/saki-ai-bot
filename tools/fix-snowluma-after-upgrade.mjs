// SnowLuma 升级后的自检 + 自动重打补丁（幂等）。
//
// 背景：`C:\SnowLuma\index.mjs` 是打包产物，升级会**静默覆盖**两个本地补丁 ——
//   ① 白名单回退读 `config/runtime.json`（不然只有从特定 vbs 启动才带白名单）
//   ② 登录读到非白名单 UIN 就 `unloadProcess`（原版只剩定义、没有调用）
// 丢了会怎样：**主人自己的 QQ 号也被注入**（日志 `[Hook] login detected: … UIN=10000001`）。
//
// 用法：node tools/fix-snowluma-after-upgrade.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SL = 'C:/SnowLuma/index.mjs';
const say = (s) => console.log(s);

if (!existsSync(SL)) {
  say(`❌ 找不到 ${SL}（SnowLuma 装在别处？改这个脚本里的 SL 路径）`);
  process.exit(1);
}

let src = readFileSync(SL, 'utf8');
const has1 = src.includes('__patched');
const has2 = src.includes('__wl__');
say(`① 白名单回退读 runtime.json：${has1 ? '✅ 在' : '❌ 缺（升级覆盖了）'}`);
say(`② 登录即摘（非白名单号 unload）：${has2 ? '✅ 在' : '❌ 缺（升级覆盖了）'}`);

const run = (f) => {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, 'tools', f)], { encoding: 'utf8' });
    say(`   → ${out.trim().split('\n').pop()}`);
  } catch (e) {
    say(`   → ❌ ${f} 失败：${String(e.stderr || e.message).slice(0, 300)}`);
    process.exitCode = 1;
  }
};

if (!has1) run('_patch-snowluma-whitelist.mjs');
if (!has2) run('_patch-snowluma-unload.mjs');

if (!has1 || !has2) {
  // 改完必须过语法检查 —— 这是第三方打包文件，语法坏了 SnowLuma 直接起不来
  try {
    execFileSync(process.execPath, ['--check', SL], { encoding: 'utf8', stdio: 'pipe' });
    say('③ 语法检查：✅ 通过');
  } catch (e) {
    say(`③ 语法检查：❌ 失败 —— 立刻还原最近的 index.mjs.bak-* ！\n${String(e.stderr || '').slice(0, 500)}`);
    process.exitCode = 1;
  }
}

// 顺带看一眼白名单配置
try {
  const j = JSON.parse(readFileSync('C:/SnowLuma/config/runtime.json', 'utf8'));
  const l = Array.isArray(j.uinWhitelist) ? j.uinWhitelist : [];
  say(`④ config/runtime.json 的 uinWhitelist：${l.length ? l.join(',') : '❌ 空的（谁的号都会被注入）'}`);
} catch (e) {
  say(`④ 读 runtime.json 失败：${e.message}`);
}

say('');
say('补完要**重启 SnowLuma** 才生效：');
say('  wscript C:\\SnowLuma\\_start-v2-hidden.vbs');
say('⚠️ 别裸起 `node index.mjs`（那条路没有环境变量，只剩补丁 ① 兜着）。');
