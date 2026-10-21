/**
 * 聊天记录 → 视频（B站投稿用）—— 把群里的真实对话渲染成聊天界面视频。
 *
 * ## 用户定调（2026-10-20）
 *   「视频是她上传**自己的聊天记录里的趣事**，**间接展示这个机器人的功能**」
 *
 * ⇒ 所以内容不是"她拍的照片"，而是**群里真实发生过的对话**：
 *   用户问一句、她答一句，把"她真的会记事 / 会接梗 / 会干活"演给人看。
 *
 * ## 数据从哪来
 *   `state/recent.json` → `groups[<群号>]` → 最多 300 条，每条：
 *     `{ name, userId, text, time, atMe, imageFiles, atNames }`
 *   （这就是机器人拼提示词用的那份上下文，**已经落盘**，不用重新抓）
 *
 * ## ⚠️ 隐私（这个必须守住）
 *   群里那些是**真人**。所以：
 *   · **绝不显示 QQ 号**（只显示昵称）✓
 *   · 昵称按配置脱敏（默认保留，`--mask` 时换成「群友A / 群友B」）✓
 *   · 图片只显示成「[图片]」，**不把图塞进去**（图里可能有真人信息）✓
 *   · 她自己那个号（`--self`）会标成"她"，气泡靠右、颜色不同 ✓
 *
 * ## 怎么出片
 *   ① 生成一个 HTML（聊天气泡，逐条淡入 + 轻微上浮）
 *   ② Playwright 开**系统 Chrome**（真字体、真渲染）录屏 → webm
 *   ③ ffmpeg 转 mp4（H.264，B站要的格式）
 *   ⚠️ ffmpeg 用系统里现成的（`C:\Users\<你>\AppData\Roaming\bilibili\ffmpeg\ffmpeg.exe`
 *      那个是 B站客户端自带的，有 libx264 ✓），**不额外装**
 *
 * ## 用法
 *   node tools/bili-make-video.mjs --group 200000001 --last 20 --out logs/bili/demo.mp4
 *   node tools/bili-make-video.mjs --group 200000001 --last 20 --mask --out ...   # 昵称脱敏
 *   node tools/bili-make-video.mjs --file state/recent.json --group 200000001 --seed 3
 */
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME =
  process.env.BILI_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const FFMPEG =
  process.env.BILI_FFMPEG || 'C:\\Users\\<主人>\\AppData\\Roaming\\bilibili\\ffmpeg\\ffmpeg.exe';

const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = (n) => argv.includes('--' + n);

const GROUP = arg('group', '200000001');
const LAST = Math.max(6, Math.min(40, Number(arg('last', '18')) || 18));
const OUT = resolve(arg('out', join(ROOT, 'logs', 'bili', `chat-${Date.now()}.mp4`)));
const SELF = arg('self', '');

/** 是不是「她自己」说的？—— recent.json 里她自己那条的 userId 是 **__self__**
 *  （实测：某群 49 条都是 __self__，不是 QQ 号 —— 这是个坑，别再用 QQ 号判断） */
const isSelfUid = (uid) => String(uid) === '__self__' || (SELF && String(uid) === SELF); // 她自己的 QQ 号（用来把她的话靠右、标成"她"）
const MASK = flag('mask');
const SRC = resolve(arg('file', join(ROOT, 'state', 'recent.json')));
const TITLE = arg('title', '');

function say(s) {
  console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${s}`);
}

if (!existsSync(SRC)) {
  say(`❌ 找不到聊天记录：${SRC}`);
  process.exit(1);
}
if (!existsSync(FFMPEG)) {
  say(`❌ 找不到 ffmpeg：${FFMPEG}`);
  process.exit(1);
}

/* ── ① 取素材 ─────────────────────────────────────── */
const j = JSON.parse(readFileSync(SRC, 'utf8'));
const all = (j.groups || {})[GROUP];
if (!Array.isArray(all) || !all.length) {
  say(`❌ 群 ${GROUP} 没有记录（现有：${Object.keys(j.groups || {}).join(', ')}）`);
  process.exit(1);
}

// 去掉纯表情 / 空的，留有字儿的（视频里"[表情包]"没意义）
const usable = all.filter((m) => {
  const raw = String(m.text ?? '').trim();
  // ⚠️ 2026-10-20 改：以前把纯图片/表情的整条扔掉 ⇒ 群里大量是这种 ⇒ 剩下四五条，
  //    9:16 竖屏根本填不满（大半屏是黑的）✗ 现在**保留**，渲染成 [图片] / [表情] ✓
  const hasImg = Array.isArray(m.imageFiles) && m.imageFiles.length > 0;
  if (!raw && !hasImg) return false;
  return true;
});
/**
 * ⚠️ 2026-10-20 加（--auto-pick）：**自动挑一段最像"趣事"的对话**。
 *
 * 为什么不能只取最后 N 条：最后几条经常是「谁加入了群」「谁退出了群」这种
 * 系统通知，或者半截话 —— 做成视频毫无看点 ✗
 *
 * 评分规则（不用模型、不花钱，纯规则）：
 *   +3  **里面有她说话**（这才是"展示机器人"的主体）
 *   +2  **她说完之后有人接**（有来有回才像对话，不像独白）
 *   +2  **说话人多**（3 个以上不同的人 ⇒ 热闹）
 *   +1  她的发言平均字数 ≥ 12（有内容，不是"嗯""哦"）
 *   −2  **出现加入/退出/撤回/禁言这类系统词**（做视频没意义）
 *   −1  时间跨度 > 1 小时（不连续，看着像拼的）
 */
function pickBestWindow(list, win) {
  const sysRe = /(加入了|退出了|撤回|禁言|全员禁言|邀请|群公告|拍了拍|戳了戳)/;
  let best = null;
  const stride = Math.max(1, Math.floor(win / 4));
  for (let i = 0; i + win <= list.length; i += stride) {
    const w = list.slice(i, i + win);
    let score = 0;
    const speakers = new Set();
    let herIdx = [];
    for (let k = 0; k < w.length; k++) {
      const m = w[k];
      speakers.add(String(m.userId ?? ''));
      if (sysRe.test(String(m.text ?? ''))) score -= 2;
      if (isSelfUid(m.userId)) {
        herIdx.push(k);
        const len = String(m.text ?? '').length;
        if (len >= 12) score += 1;
      }
    }
    if (herIdx.length) score += 3;
    if (herIdx.length && herIdx.some((k) => k < w.length - 1)) score += 2;
    if (speakers.size >= 3) score += 2;
    const t0 = Number(w[0]?.time ?? 0);
    const t1 = Number(w[w.length - 1]?.time ?? 0);
    if (t0 && t1 && t1 - t0 > 3600 * 1000) score -= 1;
    if (!best || score > best.score) best = { score, at: i, win: w, her: herIdx.length };
  }
  return best;
}

const AUTO_PICK = flag('auto-pick');
let msgs;
if (AUTO_PICK) {
  // 只看最近 24 小时的（太旧的做视频没时效性）
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const recent = usable.filter((m) => Number(m.time ?? 0) >= dayAgo);
  const pool = recent.length >= LAST ? recent : usable;
  const best = pickBestWindow(pool, LAST);
  if (best && best.her === 0) {
    say('❌ 最近这段时间里**她一句都没说** ⇒ 做出来就不是"展示机器人"了，先不出片');
    say('   （等她说过话再跑；或者用 --last 往前多取一些、去掉 --auto-pick）');
    process.exit(3);
  }
  if (best) {
    msgs = best.win;
    say(
      `自动挑片段：第 ${best.at} 条起，共 ${best.win.length} 条，` +
        `评分 ${best.score}（她说了 ${best.her} 句）`,
    );
  } else {
    msgs = pool.slice(-LAST);
    say('自动挑片段：没挑出更好的，退回取最后 N 条');
  }
} else {
  msgs = usable.slice(-LAST);
}
if (msgs.length < 4) {
  say(`❌ 可用的对话太少（${msgs.length} 条），换个大点的群或放宽 --last`);
  process.exit(1);
}
say(`群 ${GROUP}：取到 ${msgs.length} 条对话（原始 ${all.length} 条）`);

/* 昵称脱敏：同一个 uid → 同一个假名 */
const nameMap = new Map();
function displayName(m) {
  const uid = String(m.userId ?? '');
  // ⚠️ 她自己一律显示成「她」（视频是给外人看的，"你"会让人懵）
  if (isSelfUid(uid)) return '她';
  const raw = String(m.name ?? '').trim() || '某人';
  if (!MASK) return raw;
  if (!nameMap.has(uid)) nameMap.set(uid, `群友${String.fromCharCode(65 + nameMap.size)}`);
  return nameMap.get(uid);
}

/* ── ② 生成 HTML ──────────────────────────────────── */
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function bubble(m, idx) {
  const me = isSelfUid(m.userId);
  const nm = displayName(m);
  const hasImg = Array.isArray(m.imageFiles) && m.imageFiles.length > 0;
  const txt = (String(m.text ?? '').trim() || (hasImg ? '[图片]' : ''))
    .replace(/\[(表情包|图片|表情)\]/g, '［图］')
    .replace(/\[引用#[^\]]*\]/g, '')
    .trim()
    .slice(0, 220);
  const av = esc(nm.slice(0, 1));
  return `
  <div class="row ${me ? 'me' : ''}" data-i="${idx}">
    <div class="av" style="background:${me ? '#f0932b' : `hsl(${(nm.charCodeAt(0) * 37) % 360} 55% 58%)`}">${av}</div>
    <div class="col">
      <div class="nm">${esc(nm)}</div>
      <div class="bub">${esc(txt)}</div>
    </div>
  </div>`;
}

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 1080px; height: 1920px; overflow: hidden; }
  body {
    background: radial-gradient(1200px 700px at 20% 0%, #1b2330 0%, #0e1116 60%, #0a0d11 100%);
    font-family: "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
    color: #e8eaed; display: flex; flex-direction: column;
  }
  .top {
    padding: 34px 60px 26px; display: flex; align-items: baseline; gap: 18px;
    border-bottom: 1px solid rgba(255,255,255,.07);
  }
  .top .title { font-size: 40px; font-weight: 700; letter-spacing: 1px; }
  .top .sub { font-size: 20px; color: #7c8794; }
  .feed { flex: 1; overflow: hidden; padding: 36px 34px; display: block; }
  .row {
    display: flex; gap: 16px; align-items: flex-start; max-width: 980px; margin-bottom: 24px;
    opacity: 0; transform: translateY(14px);
    transition: opacity .38s ease, transform .38s ease;
  }
  .spacer { display: none; }
  .row.on { opacity: 1; transform: translateY(0); }
  .row.me { flex-direction: row-reverse; align-self: flex-end; }
  .av {
    width: 74px; height: 74px; border-radius: 18px; flex: 0 0 74px;
    display: flex; align-items: center; justify-content: center;
    font-size: 36px; font-weight: 700; color: #fff; box-shadow: 0 4px 14px rgba(0,0,0,.35);
  }
  .col { display: flex; flex-direction: column; gap: 7px; max-width: 840px; }
  .row.me .col { align-items: flex-end; }
  .nm { font-size: 25px; color: #8b96a3; padding: 0 4px; }
  .bub {
    font-size: 40px; line-height: 1.5; padding: 24px 30px; border-radius: 20px;
    background: #232a34; color: #eef1f5; word-break: break-word;
    box-shadow: 0 6px 20px rgba(0,0,0,.28); border: 1px solid rgba(255,255,255,.05);
  }
  .row.me .bub { background: linear-gradient(135deg, #2b6cb0, #1d4ed8); border-color: rgba(255,255,255,.10); }
</style></head><body>
  <div class="top">
    <div class="title">${esc(TITLE || '群里真实发生过的一段对话')}</div>
    <div class="sub">（QQ 群聊 · 昵称已隐去 QQ 号）</div>
  </div>
  <div class="feed" id="feed">${msgs.map(bubble).join('')}</div>
<script>
  // 逐条淡入；滚动跟随（多了会自动往上推）
  const rows = [...document.querySelectorAll('.row')];
  const feed = document.getElementById('feed');
  let i = 0;
  window.__step = function () {
    if (i >= rows.length) return false;
    const r = rows[i++];
    r.classList.add('on');
    // ⚠️⚠️ 关键：让**刚亮起来的这一条**贴着容器底部（真 QQ 的行为）。
    //    别用 scrollTop = scrollHeight - clientHeight —— 所有行都占着位置
    //    （没亮的也占），滚到底会露出「后面还没亮的那几条」，看着就是下面一大片黑 ✗
    const fr = feed.getBoundingClientRect();
    const rr = r.getBoundingClientRect();
    const delta = rr.bottom - fr.bottom + 30; // 底部留 30px 呼吸
    if (delta > 0) feed.scrollTop += delta;
    return true;
  };
  window.__done = () => i >= rows.length;
</script>
</body></html>`;

const work = join(ROOT, 'logs', 'bili', `work-${Date.now()}`);
mkdirSync(work, { recursive: true });
const htmlPath = join(work, 'chat.html');
writeFileSync(htmlPath, html, 'utf8');
say(`HTML 已生成：${htmlPath.replace(ROOT + '\\', '')}`);
say(`共 ${msgs.length} 条，逐条显示（每条 ${(1.6).toFixed(1)} 秒左右）`);

/* ── ③ 录屏 ───────────────────────────────────────── */
const secsPerMsg = 1.9;
const tail = 2.2; // 结尾留一点停顿再收
const totalSec = msgs.length * secsPerMsg + tail;
say(`预计成片约 ${Math.round(totalSec)} 秒`);

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--disable-blink-features=AutomationControlled', '--force-device-scale-factor=1'],
});
const ctx = await browser.newContext({
  viewport: { width: 1080, height: 1920 },
  recordVideo: { dir: work, size: { width: 1080, height: 1920 } },
});
const page = await ctx.newPage();
await page.goto('file:///' + htmlPath.replace(/\\/g, '/'), { waitUntil: 'load' });
await page.waitForTimeout(1200);
// ⚠️ 诊断：把 .feed 的真实尺寸/对齐方式打出来 —— 比猜 CSS 快一百倍
{
  const diag = await page.evaluate(() => {
    const f = document.getElementById('feed');
    const cs = getComputedStyle(f);
    const bodyCs = getComputedStyle(document.body);
    return {
      bodyH: document.body.clientHeight,
      bodyDisplay: bodyCs.display,
      bodyFlexDir: bodyCs.flexDirection,
      feedH: f.clientHeight,
      feedScrollH: f.scrollHeight,
      feedJustify: cs.justifyContent,
      feedDisplay: cs.display,
      feedFlex: cs.flex,
      rows: document.querySelectorAll('.row').length,
      spacerH: (document.querySelector('.spacer') || {}).clientHeight,
    };
  });
  console.log('[布局诊断]', JSON.stringify(diag));
}

for (let k = 0; k < msgs.length; k++) {
  await page.evaluate(() => window.__step());
  // 真人感：按字数给不同的停顿
  const len = String(msgs[k].text ?? '').length;
  const wait = Math.min(3200, 1100 + len * 26);
  await page.waitForTimeout(wait);
}
await page.waitForTimeout(tail * 1000);

const video = page.video();
await ctx.close();
await browser.close();

const webm = await video.path();
say(`录屏完成：${webm}`);

/* ── ④ 转 mp4（B站要 H.264）──────────────────────── */
mkdirSync(dirname(OUT), { recursive: true });
const r = spawnSync(
  FFMPEG,
  ['-y', '-i', webm, '-c:v', 'libx264', '-preset', 'medium', '-crf', '22',
   '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', OUT],
  { encoding: 'utf8', timeout: 5 * 60 * 1000 },
);
if (r.status !== 0) {
  say(`❌ ffmpeg 转码失败：${(r.stderr || '').split('\n').slice(-6).join(' | ')}`);
  process.exit(1);
}
say(`✅ 成片：${OUT}`);
const sz = existsSync(OUT) ? (await import('node:fs')).statSync(OUT).size : 0;
say(`   大小 ${(sz / 1024 / 1024).toFixed(1)} MB`);
try {
  rmSync(work, { recursive: true, force: true });
} catch {}
say('');
say('下一步（真发才加 --publish）：');
say(`  node tools/bili-upload.mjs --video "${OUT}" --title "…" --desc "…" --tags "AI,QQ机器人"`);
