#!/usr/bin/env node
/**
 * 渲一个 AE 片头（**只有"agent 自己搜集题材"那种视频要用**，2026-10-22 用户定）
 *
 * 用户原话：「群里的趣事类不用变，agent 自己搜集题材做的才要用上 ae」
 *
 * 为什么走 AE：群聊那条是"纪实感"（画面就是真聊天记录），不需要包装；
 *   自制题材是"她讲一个话题"，开头需要一个**像样的标题卡**，不然很像随手拍的 ✗
 *
 * 用法：
 *   node tools/ae-intro.mjs                                  # 用默认文案
 *   node tools/ae-intro.mjs --line1 "翻一页要算 66 万次" --line2 "MC 卡顿到底怪谁"
 *   node tools/ae-intro.mjs --out logs/bili/intro_take
 *
 * 输出：
 *   <out>/intro_00001.png …（1080×1920 / 25fps / 3 秒 / **透明背景**）
 *   <out>/intro.txt（这次用的文案，便于复现）
 *   <out>/saki_intro.aep（工程文件，想改效果直接开）
 *
 * 用法（合成那一步）：`bili-intro3.mjs --intro <out>` ⇒ 叠在正片前 3 秒（时间轴不变 ✓）
 *
 * ⚠️ 三个坑：
 *   ① **jsx 必须复制到 ASCII 临时目录再跑** —— ExtendScript 处理中文路径会静默失败
 *   ② AE 启动可能被一个**空标题模态框**挡住（`#32770`）⇒ 那是 `ae-run.mjs` 的活，别自己起 AfterFX
 *   ③ `rq.items.add(comp)` **之后**才能拿 `outputModule(1)`，否则报"范围没有值"
 */
import { spawn } from 'node:child_process';
import {
  mkdtempSync, copyFileSync, writeFileSync, existsSync, readdirSync, rmSync,
  mkdirSync, readFileSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const say = (s) => console.log(`[ae-intro] ${s}`);

const LINE1 = arg('line1', '祥子');
const LINE2 = arg('line2', 'Saki · 客服日常');
const OUT = resolve(arg('out', join(ROOT, 'logs', 'bili', 'intro_take')));
const TIMEOUT_S = Number(arg('timeout', '900'));
/** 渲完把 AE 留着（连着渲好几条时省一次冷启动；默认渲完关掉，省内存） */
const KEEP = argv.includes('--keep-open') ? ['--keep-open'] : [];

// AE 那边的固定输出目录（jsx 里写死这个 —— 只用来放 png，最后再搬到 OUT）
const AE_OUT = join(tmpdir(), 'ds1-ae-intro');

function sh(cmd, args, opts = {}) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    let out = '';
    p.stdout?.on('data', (b) => { out += b.toString('utf8'); });
    p.stderr?.on('data', (b) => { out += b.toString('utf8'); });
    p.on('close', (code) => res({ code, out }));
    p.on('error', (e) => res({ code: -1, out: String(e.message) }));
  });
}

/* ① 准备：清掉上次的 png、写这次的文案 */
mkdirSync(AE_OUT, { recursive: true });
for (const f of readdirSync(AE_OUT)) {
  if (/^intro_\d+\.png$/i.test(f)) { try { rmSync(join(AE_OUT, f)); } catch { /* ignore */ } }
}
// ⚠️ **两边都要清**：只清 AE_OUT 的话，上一轮多出来的帧（比如 75 帧 vs 这轮 30 帧）
//    会一直留在 OUT 里，合成时把旧画面也叠上去 ✗
if (existsSync(OUT)) {
  for (const f of readdirSync(OUT)) {
    if (/^intro_\d+\.png$/i.test(f)) { try { rmSync(join(OUT, f)); } catch { /* ignore */ } }
  }
}
writeFileSync(join(AE_OUT, 'intro.txt'), JSON.stringify({ line1: LINE1, line2: LINE2 }), 'utf8');
say(`文案：${LINE1} / ${LINE2}`);
/* ② jsx 复制到 ASCII 临时目录（⚠️ 中文路径会把 ExtendScript 搞死） */
const runDir = mkdtempSync(join(tmpdir(), 'ds1-ae-jsx-'));
const jsxCopy = join(runDir, 'ae-intro.jsx');
copyFileSync(join(ROOT, 'tools', 'ae-intro.jsx'), jsxCopy);
const doneFile = jsxCopy + '.done';

/* ③ 交给 ae-run.mjs（它管启动 AE、等就绪、等 .done、收尾关掉） */
say('启动 AE 渲染片头（第一次可能要 1~3 分钟）…');
const r = await sh(process.execPath, [join(ROOT, 'tools', 'ae-run.mjs'), jsxCopy, '--timeout', String(TIMEOUT_S), ...KEEP]);
say(String(r.out).trim().slice(0, 500));

let doneText = '';
try { doneText = readFileSync(doneFile, 'utf8'); } catch { /* ignore */ }
if (doneText) say('AE 回执：' + doneText.replace(/\s+/g, ' ').slice(0, 300));

/* ④ 收产物 */
const pngs = existsSync(AE_OUT) ? readdirSync(AE_OUT).filter((f) => /^intro_\d+\.png$/i.test(f)) : [];
if (!pngs.length) {
  console.log(JSON.stringify({ ok: false, why: 'AE 没渲出 PNG（看上面回执）' }));
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
for (const f of pngs) copyFileSync(join(AE_OUT, f), join(OUT, f));
writeFileSync(join(OUT, 'intro.txt'), JSON.stringify({ line1: LINE1, line2: LINE2 }), 'utf8');
if (existsSync(join(AE_OUT, 'saki_intro.aep'))) {
  try { copyFileSync(join(AE_OUT, 'saki_intro.aep'), join(OUT, 'saki_intro.aep')); } catch { /* ignore */ }
}
say(`✅ ${OUT}（${pngs.length} 帧 PNG，带 alpha）`);
console.log(JSON.stringify({ ok: true, out: OUT, frames: pngs.length, line1: LINE1, line2: LINE2 }));

