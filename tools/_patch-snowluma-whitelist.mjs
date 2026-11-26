// 给 SnowLuma 的 readUinWhitelist 打回退：环境变量没设时读 config/runtime.json 的 uinWhitelist。
// 2026-11-06 那个"根修"在 11-21 升级时丢了 —— 结果只要不是从带环境变量的 vbs 启动
// （自愈 / 裸 node / 双击旧 vbs），白名单就是空 ⇒ **所有登录的号都被注入**（含主人自己的号）。
// ⚠️ 本地自用补丁，不对外分发。
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const P = 'C:/SnowLuma/index.mjs';
const src = readFileSync(P, 'utf8');
const lines = src.split('\n');

const start = lines.findIndex((l) => l.includes('function readUinWhitelist()'));
if (start < 0) throw new Error('找不到 readUinWhitelist');
if (lines[start].includes('__patched')) {
  console.log('已经打过补丁，跳过');
  process.exit(0);
}

// 这个函数体是 3 行：签名 / return / }
if (!lines[start + 1].includes('SNOWLUMA_UIN_WHITELIST')) throw new Error('函数体不像预期的样子');
if (lines[start + 2].trim() !== '}') throw new Error('函数结尾不像预期');

const patched = [
  lines[start],
  '\t/* ⚠️ 2026-11-27 本地补丁 __patched：环境变量没设时就回退读 config/runtime.json 的 uinWhitelist。',
  '\t *    原版只认 SNOWLUMA_UIN_WHITELIST ⇒ 不走那个 vbs 启动（自愈/裸 node）时白名单是空的',
  '\t *    ⇒ 本机登录的**所有**号都会被注入（连主人自己的号）。 */',
  '\tconst fromEnv = String(process.env.SNOWLUMA_UIN_WHITELIST || "").split(",").map((x) => x.trim()).filter(Boolean);',
  '\tif (fromEnv.length) return fromEnv;',
  '\ttry {',
  '\t\tconst _fs = process.getBuiltinModule?.("node:fs");',
  '\t\tconst _path = process.getBuiltinModule?.("node:path");',
  '\t\tconst _p = _path && _path.join(process.cwd(), "config", "runtime.json");',
  '\t\tconst _j = _fs && _p ? JSON.parse(_fs.readFileSync(_p, "utf8")) : null;',
  '\t\tconst _list = Array.isArray(_j?.uinWhitelist)',
  '\t\t\t? _j.uinWhitelist.map((x) => String(x).trim()).filter(Boolean)',
  '\t\t\t: [];',
  '\t\tif (_list.length) {',
  '\t\t\tconsole.log("[UIN白名单] 环境变量没设 ⇒ 从 config/runtime.json 读到 %d 个号：%s", _list.length, _list.join(","));',
  '\t\t\treturn _list;',
  '\t\t}',
  '\t} catch (e) {',
  '\t\tconsole.warn("[UIN白名单] 读 config/runtime.json 失败（当作没白名单）：%s", e && e.message);',
  '\t}',
  '\treturn [];',
  '}',
];

const out = [...lines.slice(0, start), ...patched, ...lines.slice(start + 3)].join('\n');
copyFileSync(P, `${P}.bak-加白名单回退-${new Date().toISOString().replace(/[:.]/g, '-')}`);
writeFileSync(P, out, 'utf8');
console.log('已打补丁（原文备份 *.bak-加白名单回退-*）');
