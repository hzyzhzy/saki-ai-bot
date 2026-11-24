/**
 * 信息型动效样片（2026-11-08）
 *
 * 用户原话：「不是这种简单的动画啊，**要是那种能帮助观众理解视频的动画**」
 *          「真的是**太死板了**」
 *
 * 现在 `bili-intro3.mjs` 是「一张背景 + 人物 + 整段字幕」，从头到尾一个镜头 ⇒
 * 无论往背景叠什么动效都只是同一张画面在动 ✗
 *
 * 这条样板验证的是**另一种形态**：把台词拆成要点，每个要点配一个画面
 *   · 要点 1：「它从来不说自己不知道」  → 大字砸下来
 *   · 要点 2：「先来一句这要看具体情况」→ 左右对比
 *   · 要点 3：「再给我排上三条」        → 三条卡片依次落
 *   · 要点 4：饼是硬的、话是滑的        → 对比条（信息量可视化）
 *
 * 做法：HTML + `window.__seek(t)` 精确设帧 → Playwright 逐帧截图 → ffmpeg 合成
 *      （和 bili-intro3 同一套思路，但**画面是分镜的**，不是一张背景）
 *
 * 用法：node tools/motion-demo.mjs [--fps 25] [--w 1080] [--h 1920] [--out logs/motion-demo.mp4]
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const FFMPEG = process.env.BILI_FFMPEG || 'C:\\Users\\<主人>\\AppData\\Roaming\\bilibili\\ffmpeg\\ffmpeg.exe';

const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const FPS = Number(arg('fps', '25'));
const W = Number(arg('w', '1080'));
const H = Number(arg('h', '1920'));
const OUT = resolve(arg('out', join(ROOT, 'logs', 'motion-demo.mp4')));
const WORK = join(ROOT, 'logs', 'motion-demo-work');
const DUR = 12;

const say = (s) => console.log(`[动效] ${s}`);

/* ── 分镜数据：每段 3 秒 ── */
const SCENES = [
  { t: 0, dur: 3 },
  { t: 3, dur: 3 },
  { t: 6, dur: 3 },
  { t: 9, dur: 3 },
];

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:${W}px; height:${H}px; overflow:hidden;
    background:#0a0d11; color:#fff;
    font-family:"Microsoft YaHei","Noto Sans SC",sans-serif;
    -webkit-font-smoothing:antialiased; }
  #stage { position:relative; width:${W}px; height:${H}px; }
  .scene { position:absolute; inset:0; opacity:0; }
  .center { display:flex; align-items:center; justify-content:center; flex-direction:column; height:100%; }

  /* ── S1 大字 ── */
  #s1 .big { font-size:64px; font-weight:800; line-height:1.35; text-align:center; letter-spacing:2px; }
  #s1 .big em { font-style:normal; color:#7ee0c9; }
  #s1 .sub { margin-top:38px; font-size:30px; color:#8b97a8; }

  /* ── S2 左右对比 ── */
  #s2 .row { display:flex; gap:44px; align-items:stretch; padding:0 60px; width:100%; }
  .card { flex:1; border-radius:22px; padding:40px 32px; min-height:300px; display:flex;
    align-items:center; justify-content:center; text-align:center; font-size:36px; line-height:1.5; }
  .card.good { background:rgba(126,224,201,.12); border:3px solid #7ee0c9; color:#c9fff2; }
  .card.bad  { background:rgba(255,255,255,.05); border:3px solid #37414f; color:#9aa7b8; }
  #s2 .cap { margin-top:46px; font-size:30px; color:#8b97a8; }

  /* ── S3 三张卡片 ── */
  #s3 .head { font-size:40px; color:#c9d4e2; margin-bottom:40px; }
  #s3 .stack { width:860px; display:flex; flex-direction:column; gap:26px; }
  #s3 .item { background:rgba(255,255,255,.06); border-left:8px solid #f0b429;
    border-radius:14px; padding:32px 34px; font-size:34px; color:#e7edf5; }

  /* ── S4 对比条 ── */
  #s4 .barwrap { width:900px; }
  #s4 .label { font-size:30px; color:#9aa7b8; margin-bottom:14px; }
  #s4 .track { height:56px; border-radius:28px; background:rgba(255,255,255,.07); overflow:hidden; margin-bottom:44px; }
  #s4 .fill { height:100%; border-radius:28px; }
  #s4 .f1 { background:#5b6b80; }
  #s4 .f2 { background:#7ee0c9; }
  #s4 .quote { margin-top:10px; font-size:34px; color:#c9d4e2; text-align:center; line-height:1.6; }
  #s4 .quote em { font-style:normal; color:#f0b429; }
</style></head><body><div id="stage">

  <div class="scene" id="s1"><div class="center">
    <div class="big" id="s1a">它从来不说<em>自己不知道</em></div>
    <div class="sub" id="s1b">问它的时候，永远是这句：</div>
  </div></div>

  <div class="scene" id="s2"><div class="center">
    <div class="row">
      <div class="card good" id="s2a">我不知道</div>
      <div class="card bad"  id="s2b">这要看具体情况</div>
    </div>
    <div class="cap" id="s2c">我要的就是左边那一句</div>
  </div></div>

  <div class="scene" id="s3"><div class="center">
    <div class="head">然后它给我排上三条</div>
    <div class="stack">
      <div class="item" id="s3a">这要看你的具体场景</div>
      <div class="item" id="s3b">主要有三种可能性</div>
      <div class="item" id="s3c">建议你先试试再说</div>
    </div>
  </div></div>

  <div class="scene" id="s4"><div class="center">
    <div class="barwrap">
      <div class="label">它那段话</div>
      <div class="track"><div class="fill f1" id="s4a"></div></div>
      <div class="label">我那句</div>
      <div class="track"><div class="fill f2" id="s4b"></div></div>
      <div class="quote" id="s4c">饼是硬的，话是滑的<br>咽下去都<em>不是一个味儿</em></div>
    </div>
  </div></div>

</div>
<script>
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const ease = (x) => { const t = clamp01(x); return t * t * (3 - 2 * t); };
const set = (id, props) => { const el = document.getElementById(id); if (el) Object.assign(el.style, props); };

/* ⚠️ 整条片子由这一个函数决定"第 t 秒画面长什么样" —— 和 bili-intro3 的 __seekFrame 一个思路：
 *    确定性逐帧，不靠真实播放，时间轴绝对均匀 ✓ */
window.__seek = (t) => {
  /* 场景切换：淡入淡出 0.35 秒 */
  const scenes = [['s1',0],['s2',3],['s3',6],['s4',9]];
  for (const [id, start] of scenes) {
    const local = t - start;
    let op = 0;
    if (local >= 0 && local < 3) {
      op = ease(local / 0.35) * (local > 2.6 ? ease((3 - local) / 0.4) : 1);
    }
    set(id, { opacity: String(op) });
  }

  /* ── S1：大字从左滑入 ── */
  {
    const l = t;
    const a = ease(clamp01((l - 0.15) / 0.5));
    set('s1a', { opacity: String(a), transform: \`translateY(\${(1 - a) * 40}px)\` });
    const b = ease(clamp01((l - 1.0) / 0.5));
    set('s1b', { opacity: String(b) });
  }

  /* ── S2：两张卡从左右挤进来 ── */
  {
    const l = t - 3;
    const a = ease(clamp01((l - 0.2) / 0.55));
    set('s2a', { opacity: String(a), transform: \`translateX(\${(1 - a) * -160}px)\` });
    const b = ease(clamp01((l - 0.75) / 0.55));
    set('s2b', { opacity: String(b), transform: \`translateX(\${(1 - b) * 160}px)\` });
    const c = ease(clamp01((l - 1.55) / 0.5));
    set('s2c', { opacity: String(c) });
  }

  /* ── S3：三张依次落下（每张错开 0.5 秒） ── */
  {
    const l = t - 6;
    const items = [['s3a', 0.25], ['s3b', 0.85], ['s3c', 1.45]];
    for (const [id, dly] of items) {
      const k = ease(clamp01((l - dly) / 0.45));
      set(id, { opacity: String(k), transform: \`translateY(\${(1 - k) * -50}px)\` });
    }
  }

  /* ── S4：两条对比条从 0 长到目标宽度 ── */
  {
    const l = t - 9;
    const a = ease(clamp01((l - 0.2) / 0.9));
    set('s4a', { width: \`\${a * 92}%\` });
    const b = ease(clamp01((l - 1.2) / 0.7));
    set('s4b', { width: \`\${b * 14}%\` });
    const c = ease(clamp01((l - 2.0) / 0.5));
    set('s4c', { opacity: String(c) });
  }
};
</script></body></html>`;

mkdirSync(WORK, { recursive: true });
const htmlPath = join(WORK, 'demo.html');
writeFileSync(htmlPath, html, 'utf8');
say(`HTML 已写：${htmlPath}`);

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-proxy-server'],
});
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.goto('file:///' + htmlPath.replace(/\\/g, '/'), { waitUntil: 'load' });
await page.waitForTimeout(300);

const shotsDir = join(WORK, 'frames');
mkdirSync(shotsDir, { recursive: true });
const N = Math.round(DUR * FPS);
say(`逐帧 ${N} 帧 @ ${FPS}fps…`);
for (let i = 0; i < N; i++) {
  await page.evaluate((tt) => window.__seek(tt), i / FPS);
  await page.screenshot({ path: join(shotsDir, `f${String(i).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 92 });
  if (i > 0 && i % 100 === 0) say(`  ${i}/${N}…`);
}
await ctx.close();
await browser.close();

const r = spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
  '-framerate', String(FPS), '-i', join(shotsDir, 'f%05d.jpg'),
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart', OUT], { encoding: 'utf8', timeout: 300000 });

if (r.status !== 0 || !existsSync(OUT)) {
  say('❌ 合成失败：' + String(r.stderr || '').slice(-400));
  process.exit(1);
}
rmSync(shotsDir, { recursive: true, force: true });
say(`✅ ${OUT}（${(existsSync(OUT) ? (await import('node:fs')).statSync(OUT).size / 1024 / 1024 : 0).toFixed(2)} MB）`);
