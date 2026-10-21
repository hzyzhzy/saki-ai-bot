/**
 * 吐槽视频：**saki 自己说话当主线**，聊天记录当画面。
 *
 * ## 用户定的方向（2026-10-20）
 *   「以后做视频都要以 **saki 自己在说的话为主**，相当于**吐槽视频**，
 *     配上聊天记录或者其他素材就行了」
 *   「所有发的视频都要这样（用她自己的口吻）」
 *
 * ⇒ 结构从「滚动聊天记录」改成「**旁白 + 画面**」：
 *     · 声音：她拿这段对话开涮（4~6 句，短、带刺、不客套）
 *     · 画面：那段聊天记录按她的节奏往下滚（每条停留时间跟着旁白走）
 *     · 合成：ffmpeg 拼成一条 9:16 的 mp4
 *
 * ## 为什么旁白要模型现写
 *   硬编码的吐槽不是她说的话，风格一跑偏整条就废（而且人设以后会改）。
 *   现写 + 她的人设当 system ⇒ 每次都是她的口气 ✓
 *
 * ## 声音
 *   edge-tts（免费，微软音色）。⚠️ **不克隆真人声优**（侵权 + B站会封），
 *   只用通用音色并在简介里标「AI 合成音」。
 *
 * 用法：
 *   node tools/bili-narrate.mjs --group 200000001 --last 18 --out logs/bili/roast.mp4
 *   node tools/bili-narrate.mjs --group ... --voice zh-CN-XiaoyiNeural --rate=+5%
 */
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
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

const GROUP = arg('group', '200000001');
const LAST = Math.max(8, Math.min(30, Number(arg('last', '16')) || 16));
const OUT = resolve(arg('out', join(ROOT, 'logs', 'bili', `roast-${Date.now()}.mp4`)));
const VOICE = arg('voice', 'zh-CN-XiaoyiNeural'); // 仅 --tts edge 时用
const RATE = arg('rate', '+5%');
const SELF_QQ = arg('self', '');
const MASK = flag('mask');

/**
 * 配音走哪条路：
 *   idx  = 本地 IndexTTS-2.5，**能带情感**（默认）—— 见 tools/saki-tts.py
 *   edge = 微软 edge-tts，只有音色、没有情绪（备用/兜底）
 */
const TTS = arg('tts', 'idx');
const VOICE_REF = resolve(
  // 默认音色 = 从「祥子纯人声」素材第 5 段（340s）切的原声
  // ✅ 2026-10-20 用户听了群里 16:22 那条确认「这个音色对」
  arg('voice-ref', join(ROOT, 'logs', 'bili', 'voice-ref', 'saki_ref_sakiko2.wav')),
);
const ALPHA = Number(arg('alpha', '0.7')) || 0.7; // 情感强度：0.6~0.8 最自然
const IDX_ROOT = process.env.INDEX_TTS_ROOT || 'C:\\IndexTTS';
// ⚠️ 直接用 venv 里的 python，**不要 `uv run --project`** —— uv run 会去对齐
//    pyproject/uv.lock，环境被手装过时它会重装一遍（实测又卡在下载上）✗
const IDX_PY =
  process.env.INDEX_TTS_PY || join(IDX_ROOT, '.venv', 'Scripts', 'python.exe');

function say(s) {
  console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${s}`);
}

/* ── ① 读人设 ─────────────────────────────────── */
const id = JSON.parse(readFileSync(join(ROOT, 'personas', PERSONA, 'identity.json'), 'utf8'));
const isSelf = (uid) => String(uid) === '__self__' || (SELF_QQ && String(uid) === SELF_QQ);

/* ── ② 挑一段聊天 ─────────────────────────────── */
const rj = JSON.parse(readFileSync(join(ROOT, 'state', 'recent.json'), 'utf8'));
const all = (rj.groups || {})[GROUP] || [];
if (!all.length) {
  say(`❌ 群 ${GROUP} 没有聊天记录`);
  process.exit(1);
}
const usable = all.filter((m) => {
  const t = String(m.text ?? '').trim();
  const hasImg = Array.isArray(m.imageFiles) && m.imageFiles.length;
  return t || hasImg;
});
// 挑「她说过话 + 有人接」的那段（规则跟 bili-make-video 一样）
const sysRe = /(加入了|退出了|撤回|禁言|邀请|群公告|拍了拍|戳了戳)/;
let best = null;
const stride = Math.max(1, Math.floor(LAST / 4));
for (let i = 0; i + LAST <= usable.length; i += stride) {
  const w = usable.slice(i, i + LAST);
  let sc = 0;
  const who = new Set();
  let her = 0;
  for (const m of w) {
    who.add(String(m.userId ?? ''));
    if (sysRe.test(String(m.text ?? ''))) sc -= 2;
    if (isSelf(m.userId)) { her++; if (String(m.text ?? '').length >= 12) sc += 1; }
  }
  if (her) sc += 3;
  if (who.size >= 3) sc += 2;
  const t0 = Number(w[0]?.time ?? 0), t1 = Number(w[w.length - 1]?.time ?? 0);
  if (t0 && t1 && t1 - t0 > 3600e3) sc -= 1;
  if (!best || sc > best.sc) best = { sc, w, her };
}
const msgs = best ? best.w : usable.slice(-LAST);
say(`取到 ${msgs.length} 条（她说了 ${best?.her ?? 0} 句，评分 ${best?.sc ?? '-'}）`);

/* 昵称脱敏 */
const nameMap = new Map();
const dispName = (m) => {
  const uid = String(m.userId ?? '');
  if (isSelf(uid)) return '我';
  const raw = String(m.name ?? '').trim() || '某人';
  if (!MASK) return raw;
  if (!nameMap.has(uid)) nameMap.set(uid, `群友${String.fromCharCode(65 + nameMap.size)}`);
  return nameMap.get(uid);
};

/* ── ③ 让她写吐槽 ─────────────────────────────── */
const cfg = yaml.load(readFileSync(join(ROOT, 'config.yml'), 'utf8')) || {};
const llm = cfg.llm || {};
const sys = [
  id.prompt?.personaLine || `你是${id.name}，自称${id.selfName}。`,
  id.prompt?.styleLine || '',
  `性格：${id.style?.tsundere ? '有点傲娇' : '随和'}，说话短、自然，绝对不要客服腔。`,
  // ── 固定设定（2026-10-20 用户定：「这些固定设定以后做视频都要用」）──
  //    完整清单见 docs/bili-固定设定.md，改之前先问
  '⚠️ 身份设定（固定）：你是**在一个 MC 服务器群里打工的人**。',
  '🚫 绝对不许说自己是机器人 / AI / 程序 / 模型 / 助手，也不许说"我是被谁养着的"。',
  '「大肥鱼」是 DeepSeek Harness 的形象（一只胖鲸鱼），**是你在用它、不是你被它养**。',
  '⚠️ 你在录一条 B站**吐槽视频**：拿群里一段真实对话开涮。',
  '要求：**第一人称、你的口气**。短句，带点刺，别客套，别喊口号，别写成总结。',
  '不编不存在的事（吐槽只能基于对话里真有的东西）。',
].filter(Boolean).join('\n');

const transcript = msgs
  .map((m) => `${dispName(m)}：${String(m.text ?? '').trim() || '[图片]'}`)
  .join('\n');

const userPrompt = `这是群里刚才的一段对话：

${transcript}

请以**你自己的口气**写 4~6 句吐槽，用 JSON 数组输出，每句一个对象：
{"text": "要念出来的那句话", "vec": [高兴, 愤怒, 悲伤, 害怕, 厌恶, 忧郁, 惊讶, 平静]}

要求：
- text：12~28 个字，口语、短句，能直接念出来
- vec：**8 个 0~1 的数**，依次代表「高兴 / 愤怒 / 悲伤 / 害怕 / 厌恶 / 忧郁 / 惊讶 / 平静」。
  这是**配音的情绪强度**，要跟这句话的内容对得上，各句之间要有差别（全表平淡最难看）。
  ⚠️ 她是**冷淡型**，不是元气型：**「平静」不要低于 0.5**，「高兴」一般不超过 0.2；
  看不惯就抬「厌恶」，被气到抬「愤怒」，只有真觉得好笑才给一点「高兴」。
  例：[0.05, 0, 0, 0, 0.3, 0, 0, 0.65] = 冷淡里带点嫌弃（吐槽的常用档）
  反例：[0.9, 0, 0, 0, 0, 0, 0, 0.1] = 太兴奋了，不像她，禁止
- 按对话推进的顺序吐槽（开头一句带出这场景，中间几句抓具体的点，最后一句收）
- 可以点出"这帮人"的毛病，但别骂人、别点名羞辱
- 不要旁白腔（"接下来我们看到"这种一律不要），要像你本人在旁边说话
- 只输出 JSON 数组，例如
  [{"text":"这帮人凌晨三点还在群里对暗号","vec":[0.3,0,0,0,0.2,0,0,0.5]},
   {"text":"我在这看着都替他们累","vec":[0.1,0,0,0,0.3,0,0,0.6]}]`;

say('正在写吐槽…');
let lines = [];
try {
  const res = await fetch(`${String(llm.baseURL || '').replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
    body: JSON.stringify({
      model: llm.model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.95,
      // ⚠️ 2026-10-20 踩过的坑：`deepseek-flash` 是思考型模型，
      //    原来只给 800，**思考链把 800 全吃光**（实测 `finish_reason=length`、
      //    `reasoning_tokens=800`、正文空 ⇒ 报「模型没给 JSON 数组」）。
      //    写 4~6 句吐槽不需要长思考 ⇒ 直接关掉思考链，又快又不会被截断 ✓
      max_tokens: 2000,
      thinking: { type: 'disabled' },
    }),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status} ${bodyText.slice(0, 300).replace(/\s+/g, ' ')}` +
        `（model=${llm.model} base=${llm.baseURL} key=${String(llm.apiKey || '').slice(0, 6)}…）`,
    );
  }
  let j = null;
  try {
    j = JSON.parse(bodyText);
  } catch {
    throw new Error(`返回的不是 JSON：${bodyText.slice(0, 300)}`);
  }
  const raw = j?.choices?.[0]?.message?.content ?? '';
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) {
    throw new Error(
      `模型没给 JSON 数组（raw 前 200 字：${String(raw).slice(0, 200) || '空'}）` +
        `｜finish_reason=${j?.choices?.[0]?.finish_reason} usage=${JSON.stringify(j?.usage)}`,
    );
  }
  // 兼容三种形态：纯字符串（旧）/ {text,emo} / {text,vec[8]}（新）
  lines = JSON.parse(m[0])
    .map((x) => {
      if (typeof x === 'string') return { text: x.trim(), emo: '', vec: null };
      const v = Array.isArray(x?.vec) ? x.vec.map((n) => Number(n)).slice(0, 8) : null;
      return {
        text: String(x?.text ?? '').trim(),
        emo: String(x?.emo ?? '').trim(),
        vec: v && v.length === 8 && v.every((n) => Number.isFinite(n)) ? v : null,
      };
    })
    .filter((x) => x.text);
} catch (e) {
  say(`❌ 写吐槽失败：${e.message}`);
  process.exit(2);
}
if (!lines.length) {
  say('❌ 一句都没写出来');
  process.exit(2);
}
const EMO_NAMES = ['高兴', '愤怒', '悲伤', '害怕', '厌恶', '忧郁', '惊讶', '平静'];
const vecText = (v) =>
  v
    .map((n, i) => (n >= 0.15 ? `${EMO_NAMES[i]}${n.toFixed(2)}` : ''))
    .filter(Boolean)
    .join(' ') || '全平';
lines.forEach((l, i) =>
  say(`  ${i + 1}.${l.vec ? `[${vecText(l.vec)}]` : l.emo ? `[${l.emo}]` : ''} ${l.text}`),
);
// ⚠️ 固定设定自检（docs/bili-固定设定.md）：**不许暴露机器人/AI 身份**
const BANNED_IDENTITY = /机器人|人工智能|AI助手|大模型|程序|被养|被训练|我是AI/i;
const badLines = lines.filter((l) => BANNED_IDENTITY.test(l.text));
if (badLines.length) {
  say('⚠️ 以下台词踩了身份设定的红线（不许提机器人/AI/程序），建议重跑：');
  badLines.forEach((l) => say(`   · ${l.text}`));
}
writeFileSync(
  join(ROOT, 'logs', 'bili', '__roast_script.txt'),
  lines.map((l) => `${l.text}\t${l.vec ? vecText(l.vec) : l.emo}`).join('\n'),
  'utf8',
);

/* ── ④ TTS（逐句，便于算时长）─────────────────── */
const work = join(ROOT, 'logs', 'bili', `roast-work-${Date.now()}`);
mkdirSync(work, { recursive: true });
const pieces = [];

const addPiece = (f, dur) => {
  pieces.push({ f, dur: Number(dur) + 0.45 }); // 每句后留一点呼吸
};

if (TTS === 'idx') {
  /* 本地 IndexTTS-2.5：音色 = VOICE_REF，情绪 = 每句的 emo（这是"带感情"的关键） */
  say(`配音：本地 IndexTTS（音色 ${basename(VOICE_REF)}，情感强度 ${ALPHA}）`);
  const linesJson = join(work, 'lines.json');
  writeFileSync(
    linesJson,
    JSON.stringify(
      lines.map((l) => {
        const o = { text: l.text };
        if (l.vec) o.vec = l.vec; // 走 emo_vector ⇒ 不加载那 1.1 GB 情绪文本模型（快 96 倍）
        else if (l.emo) {
          o.emo = l.emo;
          o.alpha = ALPHA;
        }
        return o;
      }),
      null,
      2,
    ),
    'utf8',
  );
  const r = spawnSync(
    IDX_PY,
    [
      join(ROOT, 'tools', 'saki-tts.py'),
      '--json', linesJson,
      '--voice', VOICE_REF,
      '--outdir', work,
      '--alpha', String(ALPHA),
    ],
    {
      encoding: 'utf8',
      timeout: 40 * 60 * 1000,
      cwd: IDX_ROOT,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PYTHONPATH: IDX_ROOT, HF_ENDPOINT: 'https://hf-mirror.com' },
    },
  );
  const out = String(r.stdout || '');
  out
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('SAKI-TTS '))
    .forEach((l) => say('  ' + l.trim()));
  const tag = out.split('\n').reverse().find((l) => l.trim().startsWith('SAKI-TTS '));
  if (!tag) {
    const errTail = String(r.stderr || '').split('\n').filter(Boolean).slice(-5).join(' | ');
    say(`❌ IndexTTS 没出结果（退出码 ${r.status}）${errTail ? '：' + errTail : ''}`);
    say('   想先用微软音色出片：加 --tts edge');
    process.exit(3);
  }
  const pack = JSON.parse(tag.trim().slice('SAKI-TTS '.length));
  for (const it of pack.items) addPiece(it.file, it.dur);
} else {
  /* edge-tts：只有音色、没有情绪 */
  say(`配音：edge-tts（${VOICE}，⚠️ 这个没有情感控制）`);
  for (let i = 0; i < lines.length; i++) {
    const f = join(work, `v${i}.mp3`);
    const r = spawnSync(
      'python',
      ['-m', 'edge_tts', `--voice=${VOICE}`, `--rate=${RATE}`, `--text=${lines[i].text}`, `--write-media=${f}`],
      { encoding: 'utf8', timeout: 60000 },
    );
    if (r.status !== 0 || !existsSync(f)) {
      say(`❌ 第 ${i + 1} 句合成失败：${String(r.stderr || '').slice(-200)}`);
      process.exit(3);
    }
    const pr = spawnSync(FFMPEG, ['-hide_banner', '-i', f], { encoding: 'utf8' });
    const mm = String(pr.stderr || '').match(/Duration: (\d+):(\d+):([\d.]+)/);
    const dur = mm ? Number(mm[1]) * 3600 + Number(mm[2]) * 60 + Number(mm[3]) : 2;
    addPiece(f, dur);
    say(`  第 ${i + 1} 句 → ${dur.toFixed(1)} 秒`);
  }
}

const totalDur = pieces.reduce((a, b) => a + b.dur, 0);
say(`旁白总长 ${totalDur.toFixed(1)} 秒`);

/* 拼成一条音轨（句间加静音）
   ⚠️ 不能用 `-c copy`：IndexTTS 出的是 wav、edge 出的是 mp3，混在一起必须重编码。
   另外每句之间补 0.45 秒静音（和 `addPiece` 里的呼吸对齐），否则听着会"抢话"。 */
const listFile = join(work, 'list.txt');
const gapFile = join(work, 'gap.wav');
spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '0.45', gapFile], {
  encoding: 'utf8', timeout: 30000,
});
const hasGap = existsSync(gapFile);
const listLines = [];
pieces.forEach((p, i) => {
  listLines.push(`file '${p.f.replace(/\\/g, '/')}'`);
  if (hasGap && i < pieces.length - 1) listLines.push(`file '${gapFile.replace(/\\/g, '/')}'`);
});
writeFileSync(listFile, listLines.join('\n'), 'utf8');
const voiceFile = join(work, 'voice.m4a');
const cr = spawnSync(
  FFMPEG,
  ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-ar', '24000', '-ac', '1', '-c:a', 'aac', '-b:a', '192k', voiceFile],
  { encoding: 'utf8', timeout: 180000 },
);
if (cr.status !== 0 || !existsSync(voiceFile)) {
  say(`❌ 音轨拼接失败：${String(cr.stderr || '').split('\n').slice(-4).join(' | ')}`);
  process.exit(4);
}

/* ── ⑤ 画面：聊天记录按旁白节奏滚 ─────────────── */
// 每条消息停留时间 = 总时长 / 条数（跟旁白对齐，看着就是"她边看边说"）
const perMsg = Math.max(0.9, totalDur / msgs.length);
say(`画面：${msgs.length} 条，每条 ${perMsg.toFixed(2)} 秒`);

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const rows = msgs
  .map((m) => {
    const me = isSelf(m.userId);
    const nm = dispName(m);
    const txt =
      String(m.text ?? '').replace(/\[(表情包|图片|表情)\]/g, '［图］').replace(/\[引用#[^\]]*\]/g, '').trim() ||
      '[图片]';
    return `
  <div class="row ${me ? 'me' : ''}">
    <div class="av" style="background:${me ? '#f0932b' : `hsl(${(nm.charCodeAt(0) * 37) % 360} 55% 58%)`}">${esc(nm.slice(0, 1))}</div>
    <div class="col"><div class="nm">${esc(nm)}</div><div class="bub">${esc(txt.slice(0, 220))}</div></div>
  </div>`;
  })
  .join('');

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 1080px; height: 1920px; overflow: hidden; }
  body { background: radial-gradient(1200px 700px at 20% 0%, #1b2330 0%, #0e1116 60%, #0a0d11 100%);
    font-family: "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif; color: #e8eaed;
    display: flex; flex-direction: column; }
  .top { padding: 30px 34px 22px; border-bottom: 1px solid rgba(255,255,255,.07); }
  .tt { font-size: 36px; font-weight: 700; }
  .ss { font-size: 20px; color: #7c8794; margin-top: 8px; }
  .feed { flex: 1; overflow: hidden; padding: 30px 30px; display: block; }
  .row { display: flex; gap: 16px; align-items: flex-start; max-width: 980px; margin-bottom: 22px;
    opacity: 0; transform: translateY(14px); transition: opacity .35s ease, transform .35s ease; }
  .row.on { opacity: 1; transform: translateY(0); }
  .row.me { flex-direction: row-reverse; margin-left: auto; }
  .av { width: 72px; height: 72px; border-radius: 18px; flex: 0 0 72px; display: flex;
    align-items: center; justify-content: center; font-size: 34px; font-weight: 700; color: #fff; }
  .col { display: flex; flex-direction: column; gap: 7px; max-width: 830px; }
  .row.me .col { align-items: flex-end; }
  .nm { font-size: 24px; color: #8b96a3; padding: 0 4px; }
  .bub { font-size: 38px; line-height: 1.5; padding: 22px 28px; border-radius: 20px;
    background: #232a34; box-shadow: 0 6px 20px rgba(0,0,0,.28); word-break: break-word; }
  .row.me .bub { background: linear-gradient(135deg, #2b6cb0, #1d4ed8); }
</style></head><body>
  <div class="top"><div class="tt">${esc(arg('title', '群里这帮人'))}</div>
    <div class="ss">（真实群聊 · 已隐去 QQ 号）</div></div>
  <div class="feed" id="feed">${rows}</div>
<script>
  const rows = [...document.querySelectorAll('.row')];
  const feed = document.getElementById('feed');
  let i = 0;
  window.__step = function () {
    if (i >= rows.length) return false;
    const r = rows[i++];
    r.classList.add('on');
    const fr = feed.getBoundingClientRect(), rr = r.getBoundingClientRect();
    const d = rr.bottom - fr.bottom + 40;
    if (d > 0) feed.scrollTop += d;
    return true;
  };
</script></body></html>`;

const htmlPath = join(work, 'feed.html');
writeFileSync(htmlPath, html, 'utf8');

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
await page.waitForTimeout(1000);

// 按 perMsg 节奏逐条显示；最后一条多停留一会儿
for (let k = 0; k < msgs.length; k++) {
  await page.evaluate(() => window.__step());
  await page.waitForTimeout(Math.round(perMsg * 1000));
}
await page.waitForTimeout(1200);

const video = page.video();
await ctx.close();
await browser.close();
const webm = await video.path();

/* ── ⑥ 合成：画面 + 旁白 ───────────────────────── */
mkdirSync(dirname(OUT), { recursive: true });
const r = spawnSync(
  FFMPEG,
  ['-y', '-i', webm, '-i', voiceFile,
   '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-pix_fmt', 'yuv420p',
   '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', OUT],
  { encoding: 'utf8', timeout: 8 * 60 * 1000 },
);
if (r.status !== 0) {
  say(`❌ 合成失败：${String(r.stderr || '').split('\n').slice(-6).join(' | ')}`);
  process.exit(4);
}
say(`✅ 成片（带配音）：${OUT}`);
say(`   ${(statSync(OUT).size / 1024 / 1024).toFixed(2)} MB / 约 ${totalDur.toFixed(0)} 秒`);
say('');
say('下一步（真发才加 --publish）：');
say(`  node tools/bili-upload.mjs --video "${OUT}" --title "…" --desc "…（注明 AI 合成音）" --tags "AI,QQ机器人" --declare ai`);
try { rmSync(work, { recursive: true, force: true }); } catch {}
