/**
 * 「介绍 saki 自己」的短视频（9:16）—— 文案由**她自己的口吻**生成。
 *
 * ## 用户定的规矩（2026-10-20）
 *   「如果你要发一个视频测试的话，建议先做一个介绍 saki 自己的视频」
 *   「**以 saki 自己的口吻**」「**所有发的视频都要这样**」
 *
 * ⇒ 所以这些字不是第三人称介绍（"她是一个AI客服…"），而是**她自己在说话**：
 *   短句、有点傲娇、不客服腔（persona 的硬要求）。生成用她人设里的
 *   `prompt.personaLine` + `prompt.styleLine` 当 system，模型只负责把话写成她的口气。
 *
 * ## 为什么不用硬编码文案
 *   硬编码那几句是我替她写的，风格一旦跑偏（写成产品介绍味儿）就全错了，
 *   而且她的人设以后还会改。⇒ 每次现生成，和人设保持同步 ✓
 *
 * ## 素材
 *   personas/saki/identity.json  —— 名字 / 自称 / 工作 / 生日 / 性格
 *   personas/saki/avatar.png     —— 她的头像（直接嵌进画面）
 *   personas/saki/persona.md     —— 只取「说话的方式」那几行当风格约束（不整篇塞）
 *
 * 用法：
 *   node tools/bili-intro.mjs --out logs/bili/intro.mp4
 *   node tools/bili-intro.mjs --lines "…" "…" --out ...     # 用手写的句子（跳过模型）
 */
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME =
  process.env.BILI_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const FFMPEG =
  process.env.BILI_FFMPEG || 'C:\\Users\\<主人>\\AppData\\Roaming\\bilibili\\ffmpeg\\ffmpeg.exe';
const PERSONA = 'saki';

const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = (n) => argv.includes('--' + n);
const OUT = resolve(arg('out', join(ROOT, 'logs', 'bili', `intro-${Date.now()}.mp4`)));
const TITLE = arg('title', '');
const MANUAL = (() => {
  const i = argv.indexOf('--lines');
  if (i < 0) return [];
  const out = [];
  for (let k = i + 1; k < argv.length && !argv[k].startsWith('--'); k++) out.push(argv[k]);
  return out;
})();

function say(s) {
  console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${s}`);
}

/* ── ① 读人设 ─────────────────────────────────────── */
const idPath = join(ROOT, 'personas', PERSONA, 'identity.json');
if (!existsSync(idPath)) {
  say(`❌ 找不到人设：${idPath}`);
  process.exit(1);
}
const id = JSON.parse(readFileSync(idPath, 'utf8'));
const avatarPath = join(ROOT, 'personas', PERSONA, id?.qq?.avatar || 'avatar.png');
say(`人设：${id.displayName || id.name}（自称 ${id.selfName}）`);

/* ── ② 生成文案（她的口吻）─────────────────────────── */
const cfg = yaml.load(readFileSync(join(ROOT, 'config.yml'), 'utf8')) || {};
const llm = cfg.llm || {};

const sys = [
  id.prompt?.personaLine || `你是${id.name}，自称${id.selfName}。`,
  id.prompt?.styleLine || '',
  `性格：${id.style?.tsundere ? '有点傲娇' : '随和'}，说话短，自然，**绝对不要客服腔**。`,
  id.style?.verbalTics?.length ? `口癖：${id.style.verbalTics.join('、')}（少而准，别每句都挂）。` : '',
  `生日 ${id.birthday?.month} 月 ${id.birthday?.day} 日；工作是${id.work?.org || '一个群'}的${id.work?.title || '客服'}。`,
  '⚠️ 场景（用户 2026-10-20 定）：这是你**第一次在 B 站发视频**。',
  '  「**大肥鱼**」是 **DeepSeek Harness** 的形象（一条胖鱼，B站上大家都这么叫它）。',
  '  你**就是跑在它上面**的 —— 你能开口说话、能把这个视频弄出来，都是借它的手。',
  '  ⚠️ 这一点要**说清楚、而且要说得让人有代入感**（比如"我住在大肥鱼上头"这种说法），',
  '  但别写成广告、别喊口号、别谢个没完 —— 你不欠谁的，用你自己的口气带过就行。',
  '  这是给外面的人看的，跟群里聊天不一样，但**口气还是你自己的**。',
  '要求：**第一人称、用你自己的口气**（短句、有点傲、不客套）。不要写"大家好我是XX"这种模板。',
  '不许编不存在的事（别加你没有的经历，别提你不确定的东西）。',
].filter(Boolean).join('\n');

const userPrompt = `写 7 行字，是要在视频画面上一条条打出来的。按这个顺序：
- 第 1 行：**第一次来 B 站，先问个好**，并**说清你和"大肥鱼"的关系**：
  大肥鱼是 DeepSeek Harness 的形象，你是跑在它上面的 —— 视频也是借它的手弄出来的。
  要有画面感/代入感（别写成说明书），别当成广告词
- 第 2 行：你是谁（本名/群里怎么叫你，用你平时的口气）
- 第 3 行：你在 QQ 那边干什么活（什么群、什么岗位）
- 第 4 行：你平时怎么跟人说话 / 什么脾气
- 第 5 行：一件你真正在意的事（别喊口号）
- 第 6 行：收尾，可以说以后会在这儿发什么
要求：
- 每行 10~22 个字，短句，不要标点堆叠，不要分点序号，不要客套话
- 不要"大家好我是XX"这种模板开头
- 只输出 JSON 数组，例如 ["…","…","…","…","…","…"]`;

let lines = MANUAL;
if (!lines.length) {
  say('正在用她的口吻生成文案…');
  try {
    const res = await fetch(`${String(llm.baseURL || '').replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${llm.apiKey}`,
      },
      body: JSON.stringify({
        model: llm.model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.9,
        // ⚠️ 和 bili-narrate 同一个坑：思考型模型会把小预算全吃在 reasoning 上
        //    （实测 700 全没了 ⇒ `finish_reason=length`、正文空）⇒ 关掉思考链
        max_tokens: 2000,
        thinking: { type: 'disabled' },
      }),
    });
    const bodyText = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${bodyText.slice(0, 200)}`);
    let j = null;
    try {
      j = JSON.parse(bodyText);
    } catch {
      throw new Error(`返回的不是 JSON：${bodyText.slice(0, 200)}`);
    }
    const raw = j?.choices?.[0]?.message?.content ?? '';
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) {
      throw new Error(
        `模型没给 JSON（raw：${raw.slice(0, 120) || '空'}）` +
          `｜finish_reason=${j?.choices?.[0]?.finish_reason} usage=${JSON.stringify(j?.usage)}`,
      );
    }
    lines = JSON.parse(m[0]).map((s) => String(s).trim()).filter(Boolean);
    say(`生成了 ${lines.length} 行`);
  } catch (e) {
    say(`❌ 生成失败（${e.message}）⇒ 用占位文案，你先看画面效果`);
    lines = [
      `头一回来B站，靠大肥鱼才张得开嘴`,
      `我是${id.selfName}，群里叫我客服小祥`,
      `在${id.work?.org || '一个群'}里当${id.work?.title || '客服'}`,
      '说话短，别指望我跟你说客套话',
      '生日那天记得来，别装作不知道',
      '就这样吧',
    ];
  }
}
if (!lines.length) {
  say('❌ 一行文案都没有');
  process.exit(1);
}
lines.forEach((l, i) => say(`  ${i + 1}. ${l}`));

/* ── ③ 渲染 HTML（9:16）───────────────────────────── */
let avatarData = '';
if (existsSync(avatarPath)) {
  const b = readFileSync(avatarPath);
  const ext = avatarPath.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
  avatarData = `data:image/${ext};base64,${b.toString('base64')}`;
  say(`头像已嵌入（${(b.length / 1024).toFixed(0)} KB）`);
}

const cards = lines
  .map(
    (t, i) => `
  <div class="card" data-i="${i}"><div class="txt">${String(t)
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])}</div></div>`,
  )
  .join('');

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 1080px; height: 1920px; overflow: hidden; }
  body {
    background: radial-gradient(900px 900px at 50% 18%, #1e2a3a 0%, #12161d 55%, #0a0d12 100%);
    font-family: "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
    color: #eef1f5; display: flex; flex-direction: column; align-items: center;
    justify-content: center;
    padding: 80px 70px;
  }
  .av {
    width: 300px; height: 300px; border-radius: 50%; object-fit: cover;
    border: 5px solid rgba(119,153,204,.55); box-shadow: 0 18px 60px rgba(0,0,0,.55);
    background: #1b2330;
  }
  .nm { font-size: 62px; font-weight: 800; letter-spacing: 3px; margin-top: 34px; }
  .sub { font-size: 26px; color: #7f8b9b; margin-top: 12px; letter-spacing: 1px; }
  .cards { margin-top: 64px; width: 100%; display: flex; flex-direction: column; gap: 34px; }
  .card {
    opacity: 0; transform: translateY(16px);
    transition: opacity .45s ease, transform .45s ease;
    background: rgba(35,42,52,.92); border: 1px solid rgba(255,255,255,.07);
    border-radius: 22px; padding: 30px 34px; box-shadow: 0 10px 30px rgba(0,0,0,.35);
  }
  .card.on { opacity: 1; transform: translateY(0); }
  .txt { font-size: 44px; line-height: 1.5; }
  .card:first-child .txt { font-size: 48px; font-weight: 700; }
</style></head><body>
  <img class="av" src="${avatarData}" alt="">
  <div class="nm">${(id.displayName || id.name || '').replace(/[<>&]/g, '')}</div>
  <div class="sub">${(id.name || '').replace(/[<>&]/g, '')}　·　生日 ${id.birthday?.month ?? '?'}/${id.birthday?.day ?? '?'}</div>
  <div class="cards" id="cards">${cards}</div>
<script>
  const cs = [...document.querySelectorAll('.card')];
  let i = 0;
  window.__step = function () {
    if (i >= cs.length) return false;
    cs[i++].classList.add('on');
    return true;
  };
</script>
</body></html>`;

const work = join(ROOT, 'logs', 'bili', `intro-work-${Date.now()}`);
mkdirSync(work, { recursive: true });
const htmlPath = join(work, 'intro.html');
writeFileSync(htmlPath, html, 'utf8');

/* ── ④ 录屏 ───────────────────────────────────────── */
const perCard = 3.0;
const tail = 2.5;
say(`录屏约 ${Math.round(lines.length * perCard + tail)} 秒`);

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
await page.waitForTimeout(1500);
// 头像和名字先亮相，再一条条出字
await page.waitForTimeout(1200);
for (let k = 0; k < lines.length; k++) {
  await page.evaluate(() => window.__step());
  await page.waitForTimeout(perCard * 1000);
}
await page.waitForTimeout(tail * 1000);

const video = page.video();
await ctx.close();
await browser.close();
const webm = await video.path();

/* ── ⑤ 转 mp4 ─────────────────────────────────────── */
mkdirSync(dirname(OUT), { recursive: true });
const r = spawnSync(
  FFMPEG,
  ['-y', '-i', webm, '-c:v', 'libx264', '-preset', 'medium', '-crf', '21',
   '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', OUT],
  { encoding: 'utf8', timeout: 5 * 60 * 1000 },
);
if (r.status !== 0) {
  say(`❌ ffmpeg 失败：${(r.stderr || '').split('\n').slice(-5).join(' | ')}`);
  process.exit(1);
}
say(`✅ 成片：${OUT}`);
say(`   大小 ${(statSync(OUT).size / 1024 / 1024).toFixed(2)} MB`);
if (!TITLE) say('（标题建议也用她的口吻，用 --title 传）');
try {
  rmSync(work, { recursive: true, force: true });
} catch {}
say('');
say('下一步（真发才加 --publish）：');
say(`  node tools/bili-upload.mjs --video "${OUT}" --title "…" --desc "…" --tags "AI,QQ机器人" --zone 生活 --declare ai`);
