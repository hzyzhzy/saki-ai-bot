/**
 * 用 AE 渲一段分镜动画（2026-11-08）
 *
 * 用户原话：「最好直接用 ae 做动效，html 不适合用来做视频」
 *          「要是那种能**帮助观众理解**视频的动画」
 *
 * 和 `ae-intro.mjs` 的分工：
 *   · `ae-intro.mjs` —— **一张标题卡**（3 秒）
 *   · `ae-scenes.mjs` —— **整条片子的分镜**（按 `scenes` 一段一段做，每段一个画面）
 *
 * 用法：
 *   node tools/ae-scenes.mjs --scenes scenes.json --out logs/bili/scenes_take
 *   node tools/ae-scenes.mjs --demo --out logs/bili/scenes_take     # 用内置样例
 *
 * `scenes.json` 形如：
 *   [
 *     {"type":"title","text":"它从来不说自己不知道","em":"自己不知道","sub":"问它的时候，永远是这句：","sec":3},
 *     {"type":"compare","left":"我不知道","right":"这要看具体情况","cap":"我要的就是左边那一句","sec":3.5},
 *     {"type":"list","head":"然后它给我排上三条","items":["这要看你的具体场景","主要有三种可能性","建议你先试试再说"],"sec":4},
 *     {"type":"bars","left":{"label":"它那段话","pct":92},"right":{"label":"我那句","pct":14},"quote":"饼是硬的，话是滑的","sec":3.5}
 *   ]
 *
 * 输出：`<out>/scene_00001.png …`（1080×1920 / 带 alpha / 25fps）
 *       `<out>/scenes.json`（这次用的分镜，便于复现）
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const say = (s) => console.log(`[ae-scenes] ${s}`);

const OUT = resolve(arg('out', join(ROOT, 'logs', 'bili', 'scenes_take')));
const TIMEOUT_S = Number(arg('timeout', '300'));
const KEEP = argv.includes('--keep-open') ? ['--keep-open'] : [];

const DEMO = [
  { type: 'title', text: '它从来不说', em: '自己不知道', sub: '问它的时候，永远是这句：', sec: 3 },
  { type: 'compare', left: '我不知道', right: '这要看具体情况', cap: '我要的就是左边那一句', sec: 3.5 },
  {
    type: 'list',
    head: '然后它给我排上三条',
    items: ['这要看你的具体场景', '主要有三种可能性', '建议你先试试再说'],
    sec: 4,
  },
  {
    type: 'bars',
    left: { label: '它那段话', pct: 92 },
    right: { label: '我那句', pct: 14 },
    quote: '饼是硬的，话是滑的',
    sec: 3.5,
  },
];

/* ① 分镜数据 */
let scenes = DEMO;
const sf = arg('scenes', '');
if (sf && !argv.includes('--demo')) {
  const p = resolve(sf);
  if (!existsSync(p)) {
    console.log(JSON.stringify({ ok: false, why: `scenes 文件不存在：${p}` }));
    process.exit(1);
  }
  scenes = JSON.parse(readFileSync(p, 'utf8'));
} else {
  say('用的是内置样例分镜');
}
if (!Array.isArray(scenes) || !scenes.length) {
  console.log(JSON.stringify({ ok: false, why: 'scenes 不是非空数组' }));
  process.exit(1);
}
const totalSec = scenes.reduce((a, s) => a + (Number(s.sec) || 3), 0);
say(`共 ${scenes.length} 段 / ${totalSec} 秒`);

/* ② 工作目录（和 AE 对齐：都用 Node 的 tmpdir） */
const AE_OUT = join(tmpdir(), 'ds1-ae-scenes');
rmSync(AE_OUT, { recursive: true, force: true });
mkdirSync(AE_OUT, { recursive: true });
writeFileSync(join(AE_OUT, 'scenes.json'), JSON.stringify(scenes, null, 0), 'utf8');

/* ③ jsx 复制到 ASCII 目录，并注入 OUT 绝对路径
 *    ⚠️ 和 ae-intro 同一个坑：jsx 里不能依赖 TEMP —— AE 的 TEMP 和 Node 的 tmpdir 常常不是同一个 */
const runDir = mkdtempSync(join(tmpdir(), 'ds1-ae-scenes-jsx-'));
const jsxCopy = join(runDir, 'ae-scenes.jsx');
const jsxSrc = readFileSync(join(ROOT, 'tools', 'ae-scenes.jsx'), 'utf8');
const jsxPatched = jsxSrc.replace(/var OUT = 'INJECT_OUT';/, `var OUT = '${AE_OUT.replace(/\\/g, '/')}';`);
if (jsxPatched === jsxSrc) say('⚠️ OUT 没注入成功（模板里的占位符可能改了）');
writeFileSync(jsxCopy, jsxPatched, 'utf8');
const doneFile = join(AE_OUT, 'ae-scenes.jsx.done');

/* ④ 交给 ae-run（启动 AE / 等就绪 / 等 done / 收尾） */
say('交给 AE 渲染…');
const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'ae-run.mjs'), jsxCopy, '--timeout', String(TIMEOUT_S), ...KEEP], {
  encoding: 'utf8',
  timeout: (TIMEOUT_S + 120) * 1000,
});
say(String(r.stdout ?? '').trim().slice(0, 500));
if (String(r.stderr ?? '').trim()) say('stderr: ' + String(r.stderr).trim().slice(0, 300));

let doneText = '';
try {
  doneText = readFileSync(doneFile, 'utf8');
} catch {
  /* ignore */
}
if (doneText) say('AE 回执：' + doneText.replace(/\s+/g, ' ').slice(0, 300));

/* ⑤ 收 PNG */
const pngs = existsSync(AE_OUT) ? readdirSync(AE_OUT).filter((f) => /^scene_\d+\.png$/i.test(f)).sort() : [];
if (!pngs.length) {
  console.log(JSON.stringify({ ok: false, why: 'AE 没渲出 PNG（看上面回执 / AE 是否就绪）', dir: AE_OUT }));
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
for (const f of pngs) copyFileSync(join(AE_OUT, f), join(OUT, f));
writeFileSync(join(OUT, 'scenes.json'), JSON.stringify(scenes, null, 2), 'utf8');

say(`✅ ${OUT}（${pngs.length} 帧 / ${totalSec} 秒）`);
console.log(JSON.stringify({ ok: true, out: OUT, frames: pngs.length, seconds: totalSec }));
