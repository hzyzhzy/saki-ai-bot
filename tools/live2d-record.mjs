/**
 * 录 bdon.moe 的 Live2D 画面（真模型、带动作/表情/呼吸）→ 绿幕视频 + 元数据
 *
 * 为什么在这录：CDN 上的模型是 Unity prefab **format 2**，npm 的 ournotes-player
 * 所有版本只认 format 3 ⇒ 自己渲染必失败；而 bdon.moe 站内做了转换层 ✓
 *
 * ── 为什么是「原生录屏 + 后期裁 canvas」而不是逐帧截图（2026-10-21 定）──
 *   · 逐帧 `page.screenshot()` 实测要 **134 ms/帧**，而 12fps 只给 83 ms
 *     ⇒ 绝对时间轴一路欠账，画面内容的时间跨度被压短 ⇒ **音画必然不同步** ✗
 *   · 而 `recordVideo` 是浏览器自己按 **~25fps** 出帧，时间轴天然真实 ✓
 *   · 代价：录的是整页 ⇒ 后期按 canvas 坐标 `crop` 裁出来即可（坐标写进 meta.json）
 *   · 页面在录制前已经**刷绿 + 藏掉全部 UI** ⇒ 裁出来的就是「纯绿底 + 人物」✓
 *
 * ── 为什么**加载段要留到后期裁掉**，而不是"加载完再开录" ──
 *   · Playwright 的 recordVideo 从 **context 创建那一刻**就开始录，没法延后
 *   · 所以：录 → 记下"可以开演"的时刻（prepEndMs）→ 后期 `-ss` 精确裁掉前面那段 ✓
 *
 * 用法：
 *   node tools/live2d-record.mjs --model adv_live2d_sakiko_010_casual_spring_01 \
 *        --seconds 41 --actions "0.4:motion:smile01_R,2.2:motion:check01_C,…"
 *   # 输出：<outdir>/live2d.webm + meta.json（含 trimStart / crop / 帧尺寸）
 *
 * 退路：--boxed 不刷绿（后期直接带框放进去）
 */
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync, readdirSync, writeFileSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME =
  process.env.BILI_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const say = (s) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${s}`);

const MODEL = arg('model', 'adv_live2d_sakiko_010_casual_spring_01');
const SECONDS = Number(arg('seconds', '41'));
const OUTDIR = resolve(arg('outdir', join(ROOT, 'logs', 'bili', 'l2d_take')));
const URL0 = arg('url', 'https://bdon.moe/tools/live2d');
const WAIT = Number(arg('wait', '180000'));
// ⚠️ dsf（devicePixelRatio）默认 1，别设 2：
//    dsf=2 时 canvas 背板 = 1400×1200×4 = **672 万像素**，页面渲染跟不上 ⇒
//    25fps 里 26% 是重复帧（实测 1777 帧里丢了 456 帧，内容只有 18.6fps）⇒ 动作顿挫 = 「跳帧」✗
//    设 1 只少 4 倍像素；而人物在背板里已有 590×856，合成时缩到 800 高 ⇒ **1:1，不糊** ✓
const DSF = Number(arg('dsf', '2'));
// 人物要「半身 + 放大」（用户 2026-10-21）：
//   页面自带缩放控件是**居中放大**，点 3 次到 195% 头就出画了 ✗
//   ⇒ 自己给模型容器加 transform：scale(zoom) + 顶部对齐
//   ⚠️ 必须同时把 dpr 提到 2：canvas 的绘制分辨率 = CSS 尺寸 × dpr，
//      只做 CSS 放大就是放大像素，会糊；dpr=2 后 1:1 映射，放大后依然清晰 ✓
const ZOOM = Number(arg('zoom', '2'));
const BOXED = argv.includes('--boxed');
const KEEP_UI = argv.includes('--keep-ui');
// 口型轨（tools/mouth-track.mjs 生成）：不给就是闭嘴状态，说话时嘴不动 ✗
const MOUTH = arg('mouth', '');
// 张嘴幅度增益：这个模型 ParamMouthOpenY=1 时只是很小一条缝，放大一点才看得出在说话
const MOUTH_GAIN = Number(arg('mouth-gain', '1.6'));
let mouthTrack = null;
if (MOUTH) {
  const p = resolve(MOUTH);
  if (!existsSync(p)) { say('❌ 口型轨不存在：' + p); process.exit(2); }
  mouthTrack = JSON.parse(readFileSync(p, 'utf8'));
  say(`口型轨：${mouthTrack.totalFrames} 帧 @ ${mouthTrack.fps}fps（${mouthTrack.audioDur}s 配音）`);
}
const VW = 1400;
const VH = 1200; // ⚠️ 必须容得下整个 canvas（y=271 + 758 = 1029），1000 高会裁掉底部 ✗

mkdirSync(OUTDIR, { recursive: true });

const browser = await chromium.launch({
  executablePath: CHROME,
  // ⚠️⚠️ **必须 headless: true**（2026-10-21 实测，被用户当场打回）：
  //   我一度为了"录屏合成器帧率"改成有头模式（窗口挪到屏幕外），结果 **Live2D 动画反而跳了** ✗
  //   —— 窗口不可见时 Chrome 会给它降帧（occluded 优化），Live2D 的 update 跟着变稀
  //   ⇒ **headless 才是这套的正确选择**，别为了"看起来更真实"去改它。
  headless: true,
  ignoreDefaultArgs: ['--enable-automation'],
  // ⚠️ --no-proxy-server：CDN（storage.bdon.moe）**直连只要 1.6 秒**，
  //    走本机 7890 代理反而卡在 1.8/5.8 MB 动不了 ✗
  args: [
    '--disable-blink-features=AutomationControlled',
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',
    '--no-proxy-server',
  ],
});

const tRec = Date.now();
const ctx = await browser.newContext({
  viewport: { width: VW, height: VH },
  deviceScaleFactor: DSF,
  ignoreHTTPSErrors: true,
  locale: 'zh-CN',
  // ⚠️ recordVideo.size 必须是**CSS 尺寸**：写成 DSF 倍尺寸时 Playwright 不会放大画面，
  //    而是把页面画在视频左上角 1/4、其余留灰（实测 2800×2400 视频里页面只占 1400×1200 ✗）
  recordVideo: { dir: OUTDIR, size: { width: VW, height: VH } },
});

/* ── 口型：hook Cubism core 的 Model.prototype.update ──
 * 为什么能这么干：页面用的是 Cubism 5 core（全局 `Live2DCubismCore`），
 *   它的 `Model.prototype.update` 每帧都会跑 ⇒ patch 它就能
 *   ① 抓到 Model 实例（实测拿得到，210 个参数）
 *   ② 在**每帧 update 之前**写入 `ParamMouthOpenY`
 *      （player 自己写参数在这个之前 ⇒ 我们最后写，必然生效）
 * ⚠️ 必须用 addInitScript（页面脚本之前注入），否则 core 已实例化、抓不到
 * ⚠️ 时间锚点在"演出起点"那一刻由脚本设 `window.__dshMouth.anchor = performance.now()`，
 *   之后按 (now - anchor) 索引轨道 ⇒ 与配音严格同轴 ✓
 */
await ctx.addInitScript(({ track, fps, gain }) => {
  window.__dshMouth = { track, fps, gain, anchor: null, models: 0, err: null };
  const patch = () => {
    const core = window.Live2DCubismCore;
    if (!core || !core.Model || !core.Model.prototype) return false;
    const proto = core.Model.prototype;
    if (proto.__dshPatched) return true;
    const origUpdate = proto.update;
    proto.update = function (...args) {
      const M = window.__dshMouth;
      if (M) {
        if (!this.__dshSeen) { this.__dshSeen = true; M.models++; window.__dshModel = this; }
        if (M.track && M.anchor !== null) {
          const idx = Math.floor((performance.now() - M.anchor) / (1000 / M.fps));
          const raw = idx >= 0 && idx < M.track.length ? M.track[idx] : 0;
          const v = Math.min(M.gain || 1, raw * (M.gain || 1));
          // ⚠️ 必须走**实例方法** `this.setParameterValueById`：
          //    core 把它定义在 Model 实例上而不是 prototype 上，
          //    在 patch 时提前抓 `proto.setParameterValueById` 会拿到 undefined，
          //    `.call()` 直接抛错、又被 catch 吞掉 ⇒ 嘴一动不动（真实踩过 ✗）
          // ⚠️⚠️ core 里**没有 setParameterValueById**（实例上也没有！实测报
          //    "this.setParameterValueById is not a function"）⇒ 之前一直静默失败、
          //    嘴从来没动过（用户连着两次说「还是明显没有张嘴」就是这个原因）✗
          //    唯一可靠的写法：**直接写 parameters.values 数组** ✓
          try {
            const P = this.parameters;
            const ids = P.ids;
            if (!this.__mouthIdx) {
              // ⚠️ 要收集**所有** ParamMouth* 索引：动作/表情会把整批嘴部参数写回去，
              //    只写 OpenY 会被它们压成"一条缝"（2026-10-21 实测：点过动作后
              //    单写 OpenY 只是小缝；把其余嘴部参数一起清零才明显张开 ✓）
              const mi = { open: -1, others: [] };
              for (let i = 0; i < ids.length; i++) {
                const sid = String(ids[i]);
                if (!/^ParamMouth/i.test(sid)) continue;
                if (sid === 'ParamMouthOpenY') mi.open = i;
                else mi.others.push(i);
              }
              this.__mouthIdx = mi;
            }
            const mi = this.__mouthIdx;
            if (mi.open >= 0) P.values[mi.open] = v;
            // 闭嘴开关 / 歪斜 / 强度一律清零，免得把张开度吃掉
            for (const i of mi.others) P.values[i] = 0;
            M.lastOk = { idx, v, ok: mi.open >= 0 };
          } catch (e) { M.err = e.message; }
        }
      }
      return origUpdate.apply(this, args);
    };
    proto.__dshPatched = true;
    return true;
  };
  if (!patch()) {
    const t = setInterval(() => { if (patch()) clearInterval(t); }, 200);
    setTimeout(() => clearInterval(t), 90000);
  }
}, { track: mouthTrack ? mouthTrack.values : null, fps: mouthTrack ? mouthTrack.fps : 25, gain: MOUTH_GAIN });

const page = await ctx.newPage();

/* ── 拦截 CDN 请求，命中本地缓存就返回本地文件 ──
   ⚠️ Chrome 里下那个 5.8 MB 的 prefab 会卡在 2 KB 不动，
      而 curl 同一条 URL 2.4 秒就下完 ⇒ 先用 tools/live2d-cache.mjs 缓存 ✓ */
const CACHE = join(ROOT, 'logs', 'bili', 'l2dcache', MODEL);
if (!existsSync(CACHE)) say(`⚠️ 本地缓存不存在：${CACHE}（先跑 node tools/live2d-cache.mjs）`);
await page.route('**/storage.bdon.moe/moenotes/**', async (route) => {
  const rel = route.request().url().split('/moenotes/')[1]?.split('?')[0];
  if (!rel) return route.continue();
  const f = join(CACHE, rel);
  if (existsSync(f)) {
    return route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' },
      path: f,
    });
  }
  return route.continue();
});

say(`打开 ${URL0}?model=${MODEL}`);
await page.goto(`${URL0}?model=${encodeURIComponent(MODEL)}`, {
  waitUntil: 'domcontentloaded', timeout: 90000,
}).catch((e) => say('goto: ' + e.message));

/* ── 等模型真的加载完：判据要**连续 3 次稳定**（单次会因文案切换误判 ✗） ── */
const t0 = Date.now();
let stable = 0;
let lastPct = '';
while (Date.now() - t0 < WAIT && stable < 3) {
  const st = await page.evaluate(() => {
    const txt = document.body.innerText;
    return {
      loaded: !/正在加载模型|模型就绪|正在加载模型列表/.test(txt),
      pct: (txt.match(/(正在加载模型|模型就绪|正在加载模型列表)[^\n]{0,40}/) || [''])[0],
    };
  });
  if (st.pct && st.pct !== lastPct) { say('  ' + st.pct); lastPct = st.pct; }
  stable = st.loaded ? stable + 1 : 0;
  await page.waitForTimeout(1000);
}
if (stable < 3) { say('❌ 等到超时还没加载完，放弃'); await ctx.close(); await browser.close(); process.exit(2); }
say('✅ 模型加载完成（连续 3 次判据稳定）');
await page.waitForTimeout(2500); // 让呼吸/待机动作跑起来

/* ── 放大取半身（用户 2026-10-21：「人物直接用半身，放大一点更好」）──
 * 为什么不用页面自带的缩放按钮：它是**居中放大**，点到 195% 头就出画了 ✗
 * 做法：把模型容器提成 fixed 铺满视口 + `transform: scale(ZOOM)` 顶部对齐
 *   · fixed ⇒ 脱离祖先的 overflow:hidden，放大后不会被卡片裁掉 ✓
 *   · origin top center ⇒ 头顶对齐视口顶部，放大只会把下半身推出画面 = 半身 ✓
 *   · 同时 dpr 提到 2：canvas 的绘制分辨率 = CSS 尺寸 × dpr（2800×2400），
 *     放大 2 倍后有效分辨率仍 ≥ 视频尺寸 ⇒ **不糊** ✓（只做 CSS 放大会放大像素 ✗）
 *   · 容器自己铺绿底 ⇒ 视口内除人物全是纯绿，连 UI 都不用逐个藏（z-index 压住）✓
 */
const zoomDone = await page.evaluate(({ zoom, vw, vh }) => {
  const walk = (root, out) => {
    for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); }
    return out;
  };
  const canvas = walk(document, []).find((e) => e.tagName === 'CANVAS');
  const host = canvas?.getRootNode().host;
  if (!host) return false;
  host.style.setProperty('position', 'fixed', 'important');
  host.style.setProperty('left', '0', 'important');
  host.style.setProperty('top', '0', 'important');
  host.style.setProperty('width', vw + 'px', 'important');
  host.style.setProperty('height', vh + 'px', 'important');
  host.style.setProperty('transform', `scale(${zoom})`, 'important');
  host.style.setProperty('transform-origin', 'top center', 'important');
  host.style.setProperty('z-index', '2147483000', 'important');
  host.style.setProperty('background', '#00FF00', 'important');
  return true;
}, { zoom: ZOOM, vw: VW, vh: VH });
say(`放大 ${ZOOM}× 取半身：${zoomDone ? '已套用' : '❌ 没找到 canvas 宿主'}`);
await page.waitForTimeout(1500); // 等 player 按新尺寸重渲染

/* ── 定位 canvas（穿透 shadow DOM）→ 藏 UI → 刷绿 ── */
const prep = await page.evaluate(({ boxed, keepUi }) => {
  const walk = (root, out) => {
    for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); }
    return out;
  };
  const all = walk(document, []);
  const canvas = all.find((e) => e.tagName === 'CANVAS');
  if (!canvas) return { err: 'no canvas（模型没起来？）' };
  const host = canvas.getRootNode().host;
  // ⚠️ 加了 transform:scale 之后 getBoundingClientRect 返回的是**放大后**的超大矩形
  //   （左边界可能是负数、底部远超视口）⇒ 必须 clamp 到视口内，否则 ffmpeg crop 会报越界 ✗
  const rb = canvas.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const x0 = Math.max(0, Math.min(vw, Math.round(rb.left)));
  const y0 = Math.max(0, Math.min(vh, Math.round(rb.top)));
  const x1 = Math.max(0, Math.min(vw, Math.round(rb.right)));
  const y1 = Math.max(0, Math.min(vh, Math.round(rb.bottom)));
  const rect = { x: x0, y: y0, w: Math.max(2, x1 - x0), h: Math.max(2, y1 - y0) };
  const r = { left: rect.x, top: rect.y, right: rect.x + rect.w, bottom: rect.y + rect.h, width: rect.w, height: rect.h };

  // canvas 的祖先集合（这些绝不能藏/不能当成覆盖层）
  const keep = new Set();
  let p = canvas;
  while (p) { keep.add(p); p = p.parentElement || p.getRootNode()?.host || null; }

  // ① 藏掉压在 canvas 上的 UI：**document + 所有 shadow root 都要扫**
  //    ⚠️ 水印/全屏/筛选/缩放条是 light DOM 的兄弟节点（不在 canvas 的 shadow root 里），
  //       只扫 shadow root 会一个都找不到（hidden=0，UI 照样进画面 ✗）
  let hidden = 0;
  if (!keepUi) {
    const seen = new Set();
    const scan = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) scan(el.shadowRoot);
        if (seen.has(el) || keep.has(el) || el === canvas) continue;
        seen.add(el);
        const er = el.getBoundingClientRect();
        if (!er.width || !er.height) continue;
        const overlap = !(er.right < r.left || er.left > r.right || er.bottom < r.top || er.top > r.bottom);
        if (!overlap) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
        el.style.setProperty('display', 'none', 'important');
        hidden++;
      }
    };
    scan(document);
  }

  // ② 刷绿：host 往上每一层祖先 + body/html（透明区渗色就是这么来的）
  let painted = 0;
  if (!boxed) {
    const paint = (el) => {
      if (!el || !el.style) return;
      el.style.setProperty('background', '#00FF00', 'important');
      el.style.setProperty('background-image', 'none', 'important');
      el.style.setProperty('box-shadow', 'none', 'important');
      el.style.setProperty('border', '0', 'important');
      el.style.setProperty('border-radius', '0', 'important');
      painted++;
    };
    let q = host;
    let n = 0;
    while (q && q !== document.documentElement && n < 16) { paint(q); q = q.parentElement; n++; }
    paint(document.body);
    paint(document.documentElement);
  }
  return { rect, hidden, painted, host: host.tagName + '.' + String(host.className).slice(0, 40) };
}, { boxed: BOXED, keepUi: KEEP_UI });

if (prep.err) { say('❌ ' + prep.err); await ctx.close(); await browser.close(); process.exit(2); }

// ③ 整个页面刷绿（不只 canvas 祖先链）
//    ⚠️ 录的是**整页**，裁 canvas 时只要边界差几像素就会把白色侧栏裁进来 ⇒ 全页刷绿最保险
//    canvas 在 shadow DOM 里，这条选择器碰不到它，模型本身不受影响 ✓
if (!BOXED) {
  await page.addStyleTag({ content: `
    html, body, body *:not(canvas) {
      background: #00FF00 !important;
      background-image: none !important;
      box-shadow: none !important;
    }
  `});
}

say(`canvas：${prep.rect.w}×${prep.rect.h} @ (${prep.rect.x},${prep.rect.y})`);
say(`藏掉覆盖 UI ${prep.hidden} 个；刷绿 ${prep.painted} 层；模式=${BOXED ? 'boxed（不抠图）' : '绿幕'}`);
await page.waitForTimeout(600); // 等重绘稳定

/* ── 从这里开始才算"演出时间"：之前的加载/刷绿全部留给后期裁掉 ── */
const prepEndMs = Date.now() - tRec;
say(`演出起点 = 录制开始后 ${(prepEndMs / 1000).toFixed(2)}s（后期从这个点裁开）`);

/* ── 动作编排：按**台词时间轴**在指定秒数点动作/表情按钮 ──
 * 两种来源：
 *   --actions "秒:motion:名,秒:expression:名,…"   （手写）
 *   --actions-file actions.json                    （**agent 产出**，推荐）
 *     json 形如 [{ "at": 0.4, "name": "smile01_R", "kind": "motion", "why": "开场打招呼" }, …]
 */
const actionsFile = arg('actions-file', '');
let actions = [];
if (actionsFile && existsSync(resolve(actionsFile))) {
  const j = JSON.parse(readFileSync(resolve(actionsFile), 'utf8'));
  const list = Array.isArray(j) ? j : (j.actions || []);
  actions = list
    .map((a) => ({
      at: Number(a.at ?? a.t ?? a.time),
      kind: a.kind || 'motion',
      name: String(a.name || a.motion || a.expression || ''),
    }))
    .filter((a) => a.name && Number.isFinite(a.at));
  say(`动作表来自 ${actionsFile}（${actions.length} 条）`);
} else {
  actions = (arg('actions', '') || '')
    .split(',').map((x) => x.trim()).filter(Boolean)
    .map((pair) => { const [t, kind, name] = pair.split(':'); return { at: Number(t), kind, name }; });
}
actions = actions.sort((a, b) => a.at - b.at);

// ⚠️ 按钮在**页面本体**（含 shadow root）里，按文本精确匹配
const clickByName = (name) => page.evaluate((nm) => {
  const btns = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('button')) btns.push(el);
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
  };
  walk(document);
  const btn = btns.find((b) => b.textContent.trim() === nm);
  if (btn && !btn.disabled) { btn.click(); return true; }
  return false;
}, name);

/* ── 口型锚点：必须在"演出起点"这一刻设，之后嘴型才和配音同轴 ── */
if (mouthTrack) {
  const mm = await page.evaluate(() => {
    const M = window.__dshMouth;
    M.anchor = performance.now();
    let range = null;
    try {
      const m = window.__dshModel;
      if (m && m.getParameterMaximumValue) {
        range = {
          min: m.getParameterMinimumValue('ParamMouthOpenY'),
          max: m.getParameterMaximumValue('ParamMouthOpenY'),
        };
      }
    } catch (e) { range = 'err:' + e.message; }
    return {
      models: M.models,
      hasTrack: !!M.track,
      trackLen: M.track ? M.track.length : 0,
      range,
      patched: !!window.Live2DCubismCore?.Model?.prototype?.__dshPatched,
    };
  });
  say(`口型锚点已设：抓到 ${mm.models} 个模型实例；轨道 ${mm.hasTrack ? mm.trackLen + ' 帧' : '❌ 没注入'}` +
      `${mm.patched ? '' : '（⚠️ hook 没挂上）'}`);
  say(`口型增益 ${MOUTH_GAIN}×；写入方式=parameters.values 数组`);

  // ⚠️⚠️ **不要往页面里塞任何额外的 rAF 循环**（2026-10-21 被用户当场打回两次）：
  //    我为了查跳帧，在这里加过一个"每秒统计帧率"的 rAF 自循环（永不停止），
  //    结果它和 player 的渲染循环抢主线程 ⇒ **Live2D 动画和聊天滚动双双开始跳帧** ✗
  //    诊断代码要么放在录制之外测，要么测完就删 —— 别留在生产路径上。
}

const tStart = Date.now();
let ai = 0;
let clicked = 0;
say(`录 ${SECONDS}s，${actions.length} 个动作 → ${OUTDIR}`);
while (Date.now() - tStart < SECONDS * 1000) {
  const elapsed = (Date.now() - tStart) / 1000;
  while (ai < actions.length && actions[ai].at <= elapsed) {
    const a = actions[ai++];
    const okBtn = await clickByName(a.name);
    if (okBtn) clicked++;
    else say(`  [${a.at}s] ${a.name} → 没找到按钮 ✗`);
  }
  await page.waitForTimeout(80); // 别把主线程占满（页面还要渲染动画）
}
say(`动作已点 ${clicked}/${actions.length}`);

const liveSec = (Date.now() - tStart) / 1000;

// 口型诊断：录完把 hook 的真实状态打出来（不然"没张嘴"只能靠猜 ✗）
if (mouthTrack) {
  const diag = await page.evaluate(() => {
    const M = window.__dshMouth || {};
    const idxNow = M.anchor != null ? Math.floor((performance.now() - M.anchor) / (1000 / M.fps)) : -1;
    return {
      models: M.models, err: M.err || null, lastOk: M.lastOk || null,
      anchor: M.anchor, idxNow, trackLen: M.track ? M.track.length : 0,
      valNow: M.track && idxNow >= 0 ? M.track[Math.min(idxNow, M.track.length - 1)] : null,
      patched: !!window.Live2DCubismCore?.Model?.prototype?.__dshPatched,
    };
  });
  say('口型诊断：' + JSON.stringify(diag));

  if (diag.err) say('❌ 口型写入报错：' + diag.err);
  if (!diag.lastOk) say('❌ hook 里从来没成功写过一次参数（检查 parameters/ids 结构）');
}
await page.close();      // ⚠️ 必须 close 才会把 webm flush 到盘
await ctx.close();
await browser.close();

const webms = readdirSync(OUTDIR).filter((f) => f.endsWith('.webm'));
if (!webms.length) { say('❌ 没录到 webm'); process.exit(2); }
// 取最新那个
webms.sort((a, b) => statSync(join(OUTDIR, b)).mtimeMs - statSync(join(OUTDIR, a)).mtimeMs);
const raw = join(OUTDIR, webms[0]);
const out = join(OUTDIR, 'live2d.webm');
if (raw !== out) renameSync(raw, out);

const meta = {
  model: MODEL,
  video: out,
  trimStart: +(prepEndMs / 1000).toFixed(3), // 裁掉开头这么多秒（加载+刷绿）
  liveSeconds: +liveSec.toFixed(3),          // 演出段真实长度
  canvasCss: prep.rect,                      // 视频就是 CSS 尺寸 ⇒ crop 直接用这组数
  dsf: DSF,
  videoSize: { w: VW, h: VH },
  crop: { ...prep.rect },                    // 偶数化留给合成脚本做
  boxed: BOXED,
  actions,
  actionAt: tStart - tRec - prepEndMs,       // 动作时间轴相对"演出起点"的偏移（应为 0）
};
writeFileSync(join(OUTDIR, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
say(`✅ 录像：${out}`);
say(`   meta：trimStart=${meta.trimStart}s  crop=${meta.crop.w}×${meta.crop.h}+${meta.crop.x}+${meta.crop.y}`);
process.exit(0);
