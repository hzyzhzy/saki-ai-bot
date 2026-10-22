/**
 * B站视频投稿 —— 用**真实 Chrome**（复用 `bili-login.mjs` 留下的登录态）
 * 走**投稿页面**，全程模拟真人操作。**不走 HTTP 接口**。
 *
 * ## 用户要求（2026-10-20）
 *   「**视频。直接调用一个 agent 发视频，完全模仿真人操作**」
 *
 * ## 为什么不用接口
 *   B站投稿接口要 wbi 签名 + 分片上传 + 一堆前端参数，而且**风控极狠**
 *   （新号 / 纯接口 / 无浏览器指纹基本必挂）。用真 Chrome 操作投稿页，
 *   指纹、行为、上传链路全是官方的，等于人自己在点 ✓
 *
 * ## 安全默认：**只填不提交**
 *   · 不加 `--publish` ⇒ 填完所有字段 + 截图 ⇒ **停在投稿按钮前面**等你确认
 *   · 加 `--publish` ⇒ 才真的点「立即投稿」（**发出去就收不回来**）
 *
 * ## 用法
 *   node tools/bili-upload.mjs --video "D:\out\v.mp4" --title "今天在排练室…" \
 *        --desc "…" --tid 21 --tags "日常,vlog" [--cover cover.jpg] [--publish]
 *
 *   ⚠️ `--tid` 是**分区 id**（21=日常，138=搞笑，172=校园学习…），
 *      不传就停在分区选择那一步让人工选。
 *
 * ## 每一步都截图
 *   存到 `logs/bili-upload-<时间>/`，出问题一眼能看出卡在哪
 *   （B站投稿页 DOM 会改，别指望选择器永远有效 ⇒ 找不到就报错 + 截图，**不瞎点**）
 */
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// ⚠️ 2026-10-22：统一在这里决定用哪个浏览器
//    （系统 Chrome 优先 + 独立 profile；没有 Chrome 才用内置 Chromium）
import { browserOpts , biliProfileDir } from './lib/browser.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME =
  process.env.BILI_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// ⚠️ 2026-10-21：**按 QQ 号分 profile**（主号走老路径 state/bili-profile，别的号 state/bili-profile-<QQ>）
const PROFILE = biliProfileDir();
const UPLOAD_URL = 'https://member.bilibili.com/platform/upload/video/frame';

/* ── 参数 ─────────────────────────────────────────── */
const argv = process.argv.slice(2);
const arg = (name, dflt = '') => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes('--' + name);

const VIDEO = arg('video');
const TITLE = arg('title');
const DESC = arg('desc');
const TID = arg('tid');
const TAGS = arg('tags');
const COVER = arg('cover');
const ZONE = arg('zone', '生活');      // 一级分区名（游戏/生活/知识…）
const ZONE2 = arg('zone2', '');     // 二级分区名（可不填，B站常会自动选第一个）
const DECLARE = arg('declare', 'ai'); // ai=含AI生成内容 | none=内容无需标注 | fiction=含虚构演绎内容
const PUBLISH = flag('publish');
const HEADLESS = flag('headless');

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const SHOT_DIR = join(ROOT, 'logs', `bili-upload-${stamp}`);
mkdirSync(SHOT_DIR, { recursive: true });

function say(s) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${s}`;
  console.log(line);
}

/** 真人感：随机停顿（别用固定 1000ms，那种节奏一看就是机器） */
const nap = (min = 600, max = 1600) =>
  new Promise((r) => setTimeout(r, Math.floor(min + Math.random() * (max - min))));

let step = 0;
async function shot(page, name) {
  step += 1;
  const f = join(SHOT_DIR, `${String(step).padStart(2, '0')}-${name}.png`);
  try {
    await page.screenshot({ path: f, fullPage: false });
    say(`📷 ${f.replace(ROOT + '\\', '')}`);
  } catch (e) {
    say(`📷 截图失败（${name}）：${e.message}`);
  }
}

function die(msg, code = 1) {
  say(`❌ ${msg}`);
  say(`截图都在：${SHOT_DIR}`);
  process.exit(code);
}

/**
 * ⚠️⚠️ 2026-10-20 加（**真踩到**）—— B站的风控弹层：「请完成短信验证」。
 *
 * 现场（第一次跑，13:32）：
 *   `elementHandle.click: Timeout 30000ms exceeded`
 *   `<div class="base-verify-bg">` / `<div class="base-verify risk-captcha sms-verify">`
 *   `<input type="tel" maxlength="1" class="sms-cell"/>`
 * 截图里就是「请完成短信验证，验证码已发送到 193******」。
 *
 * 原因：**新设备（独立 profile）+ 首次投稿** ⇒ B站要验证一次身份。
 * ⇒ 这种事**必须人来做**（收短信、填 6 位），代码不许代填、也过不去。
 * ⇒ 所以这里改成**停下来等**：弹层消了就继续，等 5 分钟还在就报错退出。
 *
 * ⚠️ 顺带把那个「开启视频上传完成第一时间通知」的弹层点掉（挡着表单）。
 */
async function waitCaptcha(page) {
  const sel = '.base-verify.risk-captcha, .base-verify-bg';
  if (!(await page.$(sel).catch(() => null))) return true;
  await shot(page, 'captcha');
  say('');
  say('⚠️⚠️ B站弹了**验证弹层**（短信验证码 / 滑块）');
  say('   ⇒ 请到 Chrome 窗口里手动过掉它（验证码会发到你手机）');
  say('   ⇒ 我在这儿等着，过完自动继续（最多等 5 分钟）');
  const dl = Date.now() + 5 * 60 * 1000;
  while (Date.now() < dl) {
    await new Promise((r) => setTimeout(r, 2000));
    if (!(await page.$(sel).catch(() => null))) {
      say('✅ 验证已过，继续填表单');
      await nap(800, 1600);
      return true;
    }
  }
  say('❌ 等了 5 分钟验证还没过 ⇒ 先停，你过完重跑这条命令');
  return false;
}

/** 把挡路的「知道了 / 关闭」小弹层点掉（没有就跳过） */
async function dismissPopups(page) {
  for (const t of ['知道了', '我知道了', '关闭']) {
    try {
      const btn = page.locator(`button:has-text("${t}"), .bili-modal button:has-text("${t}")`).first();
      if (await btn.count()) {
        if (await btn.isVisible().catch(() => false)) {
          await btn.click({ timeout: 3000 });
          say(`已关掉弹层「${t}」`);
          await nap(400, 900);
        }
      }
    } catch {}
  }
}

if (!VIDEO && !flag('dump-only')) die('缺 --video <mp4 路径>');
const videoPath = resolve(VIDEO);
if (!existsSync(videoPath)) die(`视频文件不存在：${videoPath}`);
if (!TITLE && !flag('dump-only')) die('缺 --title（B站标题，最多 80 字）');
if (!existsSync(PROFILE)) die(`没有登录态目录 ${PROFILE} ⇒ 先跑 node tools/bili-login.mjs`);
if (!existsSync(CHROME)) die(`找不到 Chrome：${CHROME}`);

say(`视频: ${videoPath}`);
say(`标题: ${TITLE}`);
say(`模式: ${PUBLISH ? '⚠️ 正式投稿（会真的发出去）' : '预览模式（填完不提交）'}`);

/* ── 开浏览器 ─────────────────────────────────────── */
const ctx = await chromium.launchPersistentContext(PROFILE, {
  ...browserOpts(),
  headless: HEADLESS,
  viewport: null,
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
});

const page = ctx.pages()[0] || (await ctx.newPage());
page.setDefaultTimeout(30000);

try {
  /* ⚠️ --dump-only：只探查**空页面**结构（注意：没上传视频时表单还没渲染，
        分区/创作声明那些字段根本不在 DOM 里 ⇒ 通常要用「带视频 + --dump」）*/
  if (flag('dump-only')) {
    await page.goto('https://www.bilibili.com', { waitUntil: 'domcontentloaded' });
    const nav0 = await page
      .evaluate(async () => {
        const r = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
        return r.json();
      })
      .catch(() => null);
    say(nav0?.data?.isLogin ? `已登录：uid=${nav0.data.mid}` : '⚠️ 未登录');
    await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded' });
    await nap(3000, 4500);
    await dismissPopups(page);
    if (!(await waitCaptcha(page))) die('验证没过');

    const info = await page.evaluate(() => {
      const out = { selects: [], rows: [], texts: [] };
      document.querySelectorAll('select').forEach((el) => {
        out.selects.push({
          cls: el.className,
          name: el.name,
          options: [...el.options].slice(0, 20).map((o) => o.text.trim()),
        });
      });
      // 找「分区 / 创作声明」那几个表单行：拿它们的 text + 内部可点元素的 class
      const labels = ['分区', '创作声明', '标签', '标题', '封面'];
      document.querySelectorAll('div,span,label').forEach((el) => {
        const t = (el.innerText || '').trim();
        if (!t || t.length > 30) return;
        if (!labels.some((x) => t === x || t === '*' + x)) return;
        const row = el.closest('div[class]');
        if (!row) return;
        out.rows.push({
          label: t,
          rowCls: row.className,
          inner: (row.innerText || '').replace(/\s+/g, ' ').slice(0, 120),
          clickable: [...row.querySelectorAll('[class]')]
            .filter((c) => /select|dropdown|choice|input|trigger/i.test(c.className))
            .slice(0, 6)
            .map((c) => c.className),
        });
      });
      // 页面上所有「像下拉/选择器」的 class
      document.querySelectorAll('[class*="select"], [class*="dropdown"]').forEach((el) => {
        const c = String(el.className || '');
        if (c && out.texts.length < 40 && !out.texts.includes(c)) out.texts.push(c);
      });
      return out;
    });
    say('===== 结构探查结果 =====');
    say(JSON.stringify(info, null, 1).slice(0, 6000));
    await shot(page, 'dump');
    say('（只探查，什么都没改）');
    try { await ctx.close(); } catch {}
    process.exit(0);
  }

  /* ① 先确认登录态还在（B站会过期） */
  await page.goto('https://www.bilibili.com', { waitUntil: 'domcontentloaded' });
  const nav = await page
    .evaluate(async () => {
      const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
        credentials: 'include',
      });
      return r.json();
    })
    .catch(() => null);
  if (!nav?.data?.isLogin) die('B站登录态失效 ⇒ 重新跑 node tools/bili-login.mjs');
  say(`✅ 登录态有效：uid=${nav.data.mid} ${nav.data.uname}`);
  await nap(1200, 2400);

  /* ② 打开投稿页 */
  await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded' });
  await nap(2500, 4000);
  await dismissPopups(page);
  await shot(page, 'upload-page');
  // ⚠️ 一进来就可能弹验证（2026-10-20 实测：新设备 + 首次投稿必弹）
  if (!(await waitCaptcha(page))) die('验证没通过，先停了');
  await dismissPopups(page);

  /* ③ 选文件 —— 找 input[type=file]（B站是隐藏 input，直接 setInputFiles 最稳） */
  const fileInput = await page.$('input[type="file"]');
  if (!fileInput) die('投稿页上找不到 input[type=file]（页面结构可能变了）');
  await fileInput.setInputFiles(videoPath);
  say('已选择视频文件，等上传…');
  await nap(2000, 3000);
  await shot(page, 'after-select');

  /* ④ 等上传完成（进度到 100% / 出现"上传完成"字样）。最多等 10 分钟 */
  const deadline = Date.now() + 10 * 60 * 1000;
  let uploaded = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const txt = await page.evaluate(() => document.body.innerText.slice(0, 6000)).catch(() => '');
    if (/上传完成|上传成功|100%/.test(txt)) {
      uploaded = true;
      break;
    }
  }
  await shot(page, uploaded ? 'uploaded' : 'upload-timeout');
  if (!uploaded) die('视频上传 10 分钟没完成（文件太大 / 网速 / B站转码排队）');
  say('✅ 上传完成');
  await nap(1500, 2500);

  /* ④.5 ⚠️ 上传完 B站可能再弹一次验证 / 通知引导（实测就是这样挡住标题框的） */
  await dismissPopups(page);
  if (!(await waitCaptcha(page))) die('验证没通过，先停了');
  await dismissPopups(page);
  await nap(800, 1500);

  /* ⑤ 标题（B站是 input，placeholder 带"标题"） */
  const titleBox =
    (await page.$('input[placeholder*="标题"]')) ||
    (await page.$('input.input-val[type="text"]')) ||
    (await page.$('.video-title input'));
  if (!titleBox) die('找不到标题输入框');
  await titleBox.click();
  await nap(300, 700);
  await titleBox.fill(TITLE.slice(0, 80));
  say(`已填标题：${TITLE.slice(0, 80)}`);
  await nap(600, 1200);

  /* ⑥ 简介（contenteditable，不是 input） */
  if (DESC) {
    const descBox =
      (await page.$('.desc-container [contenteditable="true"]')) ||
      (await page.$('div[contenteditable="true"]'));
    if (descBox) {
      await descBox.click();
      await nap(300, 700);
      await page.keyboard.type(DESC.slice(0, 2000), { delay: 12 });
      say('已填简介');
      await nap(600, 1200);
    } else {
      say('⚠️ 找不到简介框 ⇒ 跳过（不影响投稿）');
    }
  }

  /* ⑦ 标签（B站的标签输入，回车确认）
   * ⚠️ 2026-10-21 实测：草稿/自动标签会先占位（最多 10 个），
   *    直接往后加会被挤掉 ⇒ 先清空、再逐个加、加完逐个核对 ✓ */
  if (TAGS) {
    const wantTags = TAGS.split(/[,，]/).map((x) => x.trim()).filter(Boolean).slice(0, 10);
    const tagInput = () =>
      page.$('input[placeholder*="标签"]').then((x) => x || page.$('.tag-input input'));
    const tagBox = await tagInput();
    if (tagBox) {
      const cleared = await page.evaluate(() => {
        const chips = [...document.querySelectorAll('.label-item-v2-container')];
        for (const c of chips) {
          const close = c.querySelector('.close');
          if (close) close.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }
        return chips.length;
      });
      if (cleared) {
        say(`已清掉原有标签 ${cleared} 个`);
        await nap(600, 1200);
      }
      for (const t of wantTags) {
        const box = (await tagInput()) || tagBox;
        await box.click();
        await nap(200, 500);
        await box.fill(t);
        await nap(400, 800);
        await page.keyboard.press('Enter');
        await nap(500, 900);
      }
      const readTags = () =>
        page.evaluate(() =>
          [...document.querySelectorAll('.label-item-v2-content')].map((x) => x.innerText.trim()),
        );
      let got = await readTags();
      let missing = wantTags.filter((t) => !got.includes(t));
      if (missing.length) {
        say(`⚠️ 少了 ${missing.join('、')} ⇒ 再补一次`);
        for (const t of missing) {
          const box = (await tagInput()) || tagBox;
          await box.click();
          await box.fill('');
          await page.keyboard.type(t, { delay: 60 });
          await nap(500, 900);
          await page.keyboard.press('Enter');
          await nap(500, 900);
        }
        got = await readTags();
        missing = wantTags.filter((t) => !got.includes(t));
      }
      say(`已加标签：${got.join(',')}${missing.length ? `（仍缺：${missing.join('、')}）` : ''}`);
    } else {
      say('⚠️ 找不到标签框 ⇒ 跳过');
    }
  }

  /* ⑧ 封面
   * ⚠️ 2026-10-21 实测（**踩过**）：直接把文件塞给页面上第二个 file input，
   *    日志会显示「已上传封面」，但投稿时照样报「请先上传封面」⇒ 根本没生效 ✗
   *    正确流程：点「添加封面」→ 弹层里塞图片 input → 等预览/「完成」可点 → 点完成 ✓ */
  if (COVER && existsSync(resolve(COVER))) {
    try {
      const openCover = page.locator('text=添加封面').first();
      if (await openCover.count()) {
        await openCover.click();
        await nap(1200, 2000);
      }
      const imgInput = await page.$('input[type="file"][accept*="image"]');
      if (!imgInput) throw new Error('封面弹层里找不到图片 input');
      await imgInput.setInputFiles(resolve(COVER));
      say('已选封面图，等上传…');
      let doneBtn = null;
      const coverDl = Date.now() + 90 * 1000;
      while (Date.now() < coverDl) {
        await new Promise((r) => setTimeout(r, 1500));
        // ⚠️ 这个「完成」是 <div class="button submit">，不是 <button> —— 按 tag 找必然找不到 ✗
        const b = page.locator('.cover-editor-content-right-bottom .button.submit').first();
        if ((await b.count()) && (await b.isVisible().catch(() => false))) {
          doneBtn = b;
          break;
        }
      }
      if (!doneBtn) throw new Error('封面弹层没等到「完成」按钮');
      await doneBtn.click();
      await nap(1000, 1800);
      /* ⚠️ 点「完成」后 B站还会弹一次确认：
       *   「检测到个人空间封面（16:9）未修改…是否将 4:3 的改动同步到 16:9？」
       *   ⇒ 必须点「确认同步」，否则弹层一直盖着，后面连「立即投稿」都点不到 ✗ */
      const syncBtn = page.locator('.videoup-confirm-modal .button:has-text("确认同步")').first();
      if ((await syncBtn.count()) && (await syncBtn.isVisible().catch(() => false))) {
        await syncBtn.click();
        say('已确认同步 4:3 → 16:9 封面');
        await nap(1000, 1800);
        const done2 = page.locator('.cover-editor-content-right-bottom .button.submit').first();
        if ((await done2.count()) && (await done2.isVisible().catch(() => false))) {
          await done2.click();
          await nap(1000, 1800);
        }
      }
      // 等弹层真的关掉，再往下走（否则分区/投稿都会被它挡住）
      const closeDl = Date.now() + 20 * 1000;
      while (Date.now() < closeDl) {
        const open = await page.evaluate(() => {
          const el = document.querySelector('.cover-editor');
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (!open) break;
        await new Promise((r) => setTimeout(r, 800));
      }
      const stillEmpty = await page.evaluate(() => {
        const el = document.querySelector('.cover-empty');
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      say(stillEmpty ? '⚠️ 封面区还是空态 ⇒ 可能没传上' : '✅ 封面已上传');
    } catch (e) {
      say(`⚠️ 封面上传失败（不影响继续）：${e.message}`);
    }
  }

  /* ⚠️⚠️ 2026-10-22 加：`--dump-zones` —— **抓 B站现在真实的分区清单**
   *
   * 为什么要这个：用户报「分区不是定死的」，但 `src/bili-publish.js` 里那份 ZONES
   *   是照老结构写的（「生活/日常」那套），**B站已经改版了**，清单里的名字在页面上
   *   一个都点不到 ⇒ 每条视频都落到默认分区 ✗（实测落到 vlog）
   * 分区控件**要上传完视频才渲染** ⇒ 只能用真视频探一次（用 `--video` 传个小文件）。
   * 输出：一行 JSON（一级 → 二级数组），直接贴进 `bili-publish.js` 的 ZONES 就行 ✓
   */
  if (flag('dump-zones')) {
    const out = {};
    /* ⚠️ 一定要用「分区」那个 H3 定位（页面里还有别的 .select-controller，
     *    第一个是标签分类 ⇒ 点错了只会抓到「音乐」这种无关值 ✗ 2026-10-22 实测踩到） */
    const openZone = async () => {
      const ok = await page.evaluate(() => {
        const h3 = [...document.querySelectorAll('h3')].find((el) => (el.innerText || '').trim() === '分区');
        if (!h3) return false;
        h3.scrollIntoView({ block: 'center' });
        let box = h3;
        for (let i = 0; i < 6 && box; i++) {
          box = box.parentElement;
          if (!box) break;
          const c = box.querySelector('.select-controller');
          if (c) { c.click(); return true; }
        }
        return false;
      });
      if (ok) await nap(700, 1200);
      return ok;
    };
    const listItems = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.drop-list-v2-item, .select-item-cont, .select-item')]
          .filter((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
          .map((x) => (x.innerText || '').trim())
          .filter((t) => t && t.length <= 12),
      );
    const clickItem = (txt) =>
      page.evaluate((t) => {
        const items = [...document.querySelectorAll('.drop-list-v2-item, .select-item-cont, .select-item')]
          .filter((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
        const hit = items.find((x) => (x.innerText || '').trim() === t);
        if (!hit) return false;
        hit.click();
        return true;
      }, txt);

    if (!(await openZone())) die('点不开分区控件（找不到「分区」H3 或它旁边的 .select-controller）');
    const lvl1 = [...new Set(await listItems())];
    say(`一级分区 ${lvl1.length} 个：${lvl1.join(' / ')}`);
    const TRY_SUB = new Set(['生活', '游戏', '知识', '人工智能', '动画', '娱乐']);
    for (const z1 of lvl1) {
      if (!TRY_SUB.has(z1)) { out[z1] = []; continue; }
      if (!(await openZone())) continue;
      if (!(await clickItem(z1))) continue;
      await nap(600, 1000);
      const subs = [...new Set(await listItems())].filter((x) => x !== z1);
      out[z1] = subs;
      say(`  ${z1} → ${subs.join('、') || '（没有二级）'}`);
    }
    await shot(page, 'zones');
    console.log('===== ZONES_JSON =====');
    console.log(JSON.stringify(out, null, 2));
    say('（只探查，什么都没提交）');
    try { await ctx.close(); } catch {}
    process.exit(0);
  }

  /* ⚠️⚠️ 2026-10-20 加：**分区 + 创作声明** —— 这两个是 B站投稿的必填项，
     不填就停在 B站默认的「游戏」区、且可能被要求补声明。
     结构（上传视频后 dump 到的，都是 B站自己的组件、不是 <select>）：
       · 分区：.select-controller（点开弹 .select-item-cont 列表，两级）
       · 创作声明：.bcc-select-input-wrap（点开 .bcc-select-option-list）
     ⚠️ 创作声明里 B站现在有「含AI生成内容」这一项 —— **saki 的视频必须选它**
        （诚实标注，也是平台合规要求），所以默认就是 ai ✓ */
  if (ZONE) {
    try {
      /* ⚠️⚠️ 2026-10-21 修正：页面里不止一个 .select-controller（标签分类那个也是），
       *   querySelector 拿到的第一个是**标签分类**（值长得像「绘画」）
       *   ⇒ 原来点开的是标签下拉、分区一直停在默认值 ✗
       *   正确做法：先找到「分区」那个 H3，再在它所属的 section 里找 controller ✓ */
      const opened = await page.evaluate(() => {
        const h3 = [...document.querySelectorAll('h3')].find((el) => (el.innerText || '').trim() === '分区');
        if (!h3) return false;
        let box = h3;
        for (let i = 0; i < 6 && box; i++) {
          box = box.parentElement;
          if (!box) break;
          const c = box.querySelector('.select-controller');
          if (c) { c.click(); return true; }
        }
        return false;
      });
      if (opened) {
        await nap(600, 1100);
        // 在弹出来的列表里按文字点（一级优先，其次二级）
        const picked = await page.evaluate(
          ({ z1, z2 }) => {
            const items = [...document.querySelectorAll('.drop-list-v2-item, .select-item-cont, .select-item, li')]
              .filter((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
            const hit1 = items.find((x) => (x.innerText || '').trim() === z1);
            if (hit1) {
              hit1.click();
              return 'lvl1:' + z1;
            }
            const hit2 = z2 ? items.find((x) => (x.innerText || '').trim() === z2) : null;
            if (hit2) {
              hit2.click();
              return 'lvl2:' + z2;
            }
            return '';
          },
          { z1: ZONE, z2: ZONE2 },
        );
        if (picked) say(`已选分区：${picked}`);
        else say(`⚠️ 分区列表里没找到「${ZONE}」⇒ 保持 B站默认`);
        // 调试：一级选完后，二级到底是没渲染、还是换了控件（2026-10-21）
        try {
          const dbg = await page.evaluate(() => {
            const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
            const items = [...document.querySelectorAll('.drop-list-v2-item, .select-item-cont, .select-item, li')]
              .filter(vis).map((x) => (x.innerText || '').trim()).slice(0, 50);
            const net = [...document.querySelectorAll('*')]
              .filter((el) => !el.children.length && (el.innerText || '').includes('网络游戏'))
              .map((el) => ({ t: el.innerText.trim(), cls: String(el.className || '').slice(0, 80), vis: vis(el) }));
            const h3 = [...document.querySelectorAll('h3')].find((el) => (el.innerText || '').trim() === '分区');
            let box = h3;
            for (let i = 0; i < 4 && box; i++) box = box.parentElement;
            return { items, net: net.slice(0, 10), zoneText: (box?.innerText || '').replace(/\s+/g, ' ').slice(0, 200) };
          });
          say('[zone-debug] ' + JSON.stringify(dbg).slice(0, 1500));
        } catch {}
        await nap(700, 1300);
        // 两级分区：选完一级会再弹一次二级，缺省选第一个
        if (ZONE2) {
          const picked2 = await page.evaluate((z2) => {
            const items = [...document.querySelectorAll('.drop-list-v2-item, .select-item-cont, .select-item, li')]
              .filter((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
            const hit = items.find((x) => (x.innerText || '').trim() === z2);
            if (hit) { hit.click(); return true; }
            return false;
          }, ZONE2);
          say(picked2 ? `已选二级分区：${ZONE2}` : `⚠️ 没找到二级分区「${ZONE2}」`);
          await nap(500, 900);
        }
      } else {
        say('⚠️ 找不到分区控件（分区 section 里没有 .select-controller）⇒ 保持默认');
      }
    } catch (e) {
      say(`⚠️ 选分区失败（不影响继续）：${e.message}`);
    }
  }

  if (DECLARE) {
    try {
      const txt =
        DECLARE === 'none'
          ? '内容无需标注'
          : DECLARE === 'fiction'
            ? '含虚构演绎内容'
            : '含AI生成内容';
      const clicked = await page.evaluate(() => {
        const w = document.querySelector('.bcc-select-input-wrap, .bcc-select');
        if (!w) return false;
        w.click();
        return true;
      });
      if (clicked) {
        await nap(500, 1000);
        const ok = await page.evaluate((want) => {
          const opt = [...document.querySelectorAll('.bcc-select-option, .bcc-select-option-list li, .bcc-select-option-list div')]
            .find((x) => (x.innerText || '').includes(want));
          if (!opt) return false;
          opt.click();
          return true;
        }, txt);
        say(ok ? `已选创作声明：${txt}` : `⚠️ 创作声明里没找到「${txt}」`);
        await nap(600, 1200);
      } else {
        say('⚠️ 找不到创作声明控件（.bcc-select）');
      }
    } catch (e) {
      say(`⚠️ 选创作声明失败（不影响继续）：${e.message}`);
    }
  }

  await shot(page, 'form-filled');
  say('表单已填完');

  /* ⚠️ 2026-10-20：把「分区 / 创作声明」那两块的真实 DOM 打出来 ——
     它们不是 <select>，是 B站自己的下拉组件，而且**只有上传视频之后才渲染**
     （空页面 dump 出来是空的，白跑一次）。拿到结构才能写准确的点选逻辑。 */
  if (flag('dump')) {
    // ⚠️ 分区可能收在「更多设置」里（2026-10-21 页面上没直接看到）⇒ 先展开再 dump
    try {
      const more = page.locator('text=更多设置').first();
      if (await more.count()) { await more.click({ timeout: 4000 }); await nap(700, 1200); }
    } catch {}
    const dom = await page.evaluate(() => {
      const out = { rows: [], clickable: [], zoneHits: [], around: '' };
      // 找带「分区」「创作声明」字样的表单行
      for (const kw of ['分区', '创作声明']) {
        const all = [...document.querySelectorAll('div,span,label')];
        for (const el of all) {
          const t = (el.innerText || '').trim();
          if (t !== kw && t !== '*' + kw) continue;
          let node = el;
          for (let up = 0; up < 4 && node; up++) {
            node = node.parentElement;
            if (!node) break;
            const cand = [...node.querySelectorAll('[class]')].filter((c) =>
              /select|dropdown|choice|controller|trigger|input/i.test(String(c.className)),
            );
            if (cand.length) {
              out.rows.push({
                kw,
                up,
                rowCls: String(node.className || '').slice(0, 120),
                text: (node.innerText || '').replace(/\s+/g, ' ').slice(0, 100),
                clickable: cand.slice(0, 8).map((c) => ({
                  tag: c.tagName,
                  cls: String(c.className || '').slice(0, 100),
                  txt: (c.innerText || '').replace(/\s+/g, ' ').slice(0, 40),
                })),
              });
              break;
            }
          }
        }
      }
      document.querySelectorAll('[class*="select"], [class*="dropdown"]').forEach((el) => {
        const c = String(el.className || '');
        if (c && out.clickable.length < 30 && !out.clickable.some((x) => x.cls === c)) {
          out.clickable.push({ cls: c, txt: (el.innerText || '').replace(/\s+/g, ' ').slice(0, 40) });
        }
      });
      // ⚠️ 专门找「分区」两个字（可能不叫「分区」而是「分区：」/「投稿分区」）
      document.querySelectorAll('*').forEach((el) => {
        if (el.children.length) return;
        const t = (el.innerText || '').trim();
        if (t && t.length < 60 && t.includes('分区') && out.zoneHits.length < 20) {
          out.zoneHits.push({
            tag: el.tagName,
            cls: String(el.className || '').slice(0, 80),
            text: t,
            parentCls: String(el.parentElement?.className || '').slice(0, 100),
            rowText: (el.closest('div[class]')?.innerText || '').replace(/\s+/g, ' ').slice(0, 160),
          });
        }
      });
      const body = document.body.innerText || '';
      const i = body.indexOf('分区');
      out.around = i >= 0 ? body.slice(Math.max(0, i - 150), i + 300).replace(/\s+/g, ' ') : '(页面上没有「分区」两个字)';
      return out;
    });
    say('===== 分区/创作声明 结构 =====');
    say(JSON.stringify(dom, null, 1).slice(0, 7000));
  }

  /* ⑨ 预览模式：停在这里 */
  if (!PUBLISH) {
    say('');
    say('🟡 **预览模式：没有提交**');
    say(`   请到 Chrome 窗口里自己看一眼（标题/简介/分区/封面）`);
    say(`   截图：${SHOT_DIR}`);
    say('   要真发：加 --publish 重跑，或直接在窗口里点「立即投稿」');
    say('   ⏳ 窗口留 10 分钟给你看，到点自动关');
    // ⚠️ 别用 `await new Promise(()=>{})` 无限挂 —— 那样脚本永远不退出，
    //    外部（定时任务 / 我）没法知道它到底完没完。给个 10 分钟的窗口 ✓
    await new Promise((r) => setTimeout(r, 10 * 60 * 1000));
    say('⏰ 10 分钟到了，关窗口');
    try {
      await ctx.close();
    } catch {}
    process.exit(0);
  }

  /* ⑩ 正式投稿（⚠️ 发出去收不回来） */
  const submit = await page
    .$('span.submit-btn, .submit-btn, button:has-text("立即投稿"), span:has-text("立即投稿")')
    .catch(() => null);
  if (!submit) die('找不到「立即投稿」按钮（可能分区分区没选，B站会禁用提交）');
  await nap(1200, 2600);
  await submit.click();
  say('已点击「立即投稿」');
  await nap(3000, 5000);
  await shot(page, 'after-submit');

  const after = await page.evaluate(() => document.body.innerText.slice(0, 3000)).catch(() => '');
  const ok = /投稿成功|已提交|审核中|稿件投递成功/.test(after);
  writeFileSync(
    join(SHOT_DIR, 'result.txt'),
    `title=${TITLE}\nvideo=${videoPath}\npublished=${ok}\n---\n${after}`,
    'utf8',
  );
  say(ok ? '✅ 投稿成功（B站会先审核）' : '⚠️ 点过按钮了，但没看到"投稿成功"字样 ⇒ 看截图确认');
} catch (e) {
  say(`❌ 出错：${e.message}`);
  try {
    await shot(page, 'error');
  } catch {}
  say(`截图：${SHOT_DIR}`);
  process.exitCode = 1;
} finally {
  if (PUBLISH) {
    await new Promise((r) => setTimeout(r, 4000));
    try {
      await ctx.close();
    } catch {}
  }
}
