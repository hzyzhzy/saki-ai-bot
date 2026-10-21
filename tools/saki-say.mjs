/**
 * 一句话测试台：**用 saki 的声音说一句 → 直接发到群里听**。
 *
 * 为什么要有：IndexTTS 的参考音色 / 情感强度 / emo 描述这三样都得反复试，
 * 而"像不像"只有耳朵能判。每次手敲两条命令太麻烦 ⇒ 合成 + 发送一步到位。
 *
 * 用法：
 *   node tools/saki-say.mjs --text "喂，听得见吗？"                        # 只合成，不发送
 *   node tools/saki-say.mjs --text "…" --emo "嘴硬，装得不屑" --send        # 合成并发群
 *   node tools/saki-say.mjs --text "…" --alpha 0.9 --send --group 200000001
 *   node tools/saki-say.mjs --file 台词.txt --send                         # 多行，逐句合成再拼一条
 *
 * 依赖：C:\\IndexTTS 的 venv（IndexTTS-2.5）+ tools/saki-tts.py
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG =
  process.env.BILI_FFMPEG || 'C:\\Users\\<主人>\\AppData\\Roaming\\bilibili\\ffmpeg\\ffmpeg.exe';
const IDX_ROOT = process.env.INDEX_TTS_ROOT || 'C:\\IndexTTS';
// 直接用 venv 里的 python（`uv run` 会去对齐 uv.lock，可能重装一遍）
const IDX_PY =
  process.env.INDEX_TTS_PY || join(IDX_ROOT, '.venv', 'Scripts', 'python.exe');

const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = (n) => argv.includes('--' + n);
const say = (s) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${s}`);

const TEXT = arg('text', '');
const FILE = arg('file', '');
const EMO = arg('emo', '');
const ALPHA = arg('alpha', '0.7');
const VOICE_REF = resolve(
  // 默认音色 = 素材第 5 段（340s）切的原声（用户确认音色对）
  arg('voice-ref', join(ROOT, 'logs', 'bili', 'voice-ref', 'saki_ref_sakiko2.wav')),
);
const GROUP = arg('group', '200000001');
const SEND = flag('send');
const OUTDIR = resolve(arg('outdir', join(ROOT, 'logs', 'bili', 'say')));

let lines = [];
if (FILE) {
  const p = resolve(FILE);
  if (!existsSync(p)) {
    say(`❌ 文件不存在：${p}`);
    process.exit(1);
  }
  const raw = readFileSync(p, 'utf8');
  if (/\.json$/i.test(p)) {
    // ⚠️ *.json 必须走 JSON.parse —— 2026-10-20 踩过：
    //   原来只按行切，把 JSON 的每一行（`{`、`"text": "..."`）都当成台词念了 ✗
    let arr;
    try {
      arr = JSON.parse(raw);
    } catch (e) {
      say(`❌ JSON 解析失败：${e.message}`);
      process.exit(1);
    }
    lines = arr
      .map((x) =>
        typeof x === 'string'
          ? { text: x.trim(), emo: '', vec: null }
          : {
              text: String(x?.text ?? '').trim(),
              emo: String(x?.emo ?? '').trim(),
              vec: Array.isArray(x?.vec) ? x.vec.map(Number) : null,
            },
      )
      .filter((x) => x.text);
  } else {
    lines = raw
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((t) => {
        // 支持「[情绪] 正文」写法
        const m = t.match(/^[\[【](.+?)[\]】]\s*(.+)$/);
        return m ? { text: m[2], emo: m[1], vec: null } : { text: t, emo: EMO, vec: null };
      });
  }
} else if (TEXT) {
  lines = [{ text: TEXT, emo: EMO, vec: null }];
}
if (!lines.length) {
  say('❌ 要 --text 或 --file');
  process.exit(1);
}
if (!existsSync(VOICE_REF)) {
  say(`❌ 参考音色不存在：${VOICE_REF}`);
  process.exit(1);
}

mkdirSync(OUTDIR, { recursive: true });
const stamp = Date.now();
const jsonPath = join(OUTDIR, `lines-${stamp}.json`);
writeFileSync(
  jsonPath,
  JSON.stringify(
    lines.map((l) => {
      const o = { text: l.text };
      if (l.vec && l.vec.length === 8) o.vec = l.vec; // 走 emo_vector，不加载 1.1 GB 情绪模型
      else if (l.emo) {
        o.emo = l.emo;
        o.alpha = Number(ALPHA);
      }
      return o;
    }),
    null,
    2,
  ),
  'utf8',
);

say(`合成 ${lines.length} 句（音色 ${VOICE_REF.split(/[\\/]/).pop()}，情感强度 ${ALPHA}）`);
const r = spawnSync(
  IDX_PY,
  [join(ROOT, 'tools', 'saki-tts.py'),
    '--json', jsonPath, '--voice', VOICE_REF, '--outdir', OUTDIR, '--alpha', String(ALPHA)],
  {
    encoding: 'utf8',
    timeout: 20 * 60 * 1000,
    cwd: IDX_ROOT,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PYTHONPATH: IDX_ROOT, HF_ENDPOINT: 'https://hf-mirror.com' },
  },
);
const out = String(r.stdout || '');
out.split('\n').filter((l) => l.trim() && !l.trim().startsWith('SAKI-TTS ')).forEach((l) => say('  ' + l.trim()));
const tag = out.split('\n').reverse().find((l) => l.trim().startsWith('SAKI-TTS '));
if (!tag) {
  const err = String(r.stderr || '').split('\n').filter(Boolean).slice(-6).join(' | ');
  say(`❌ 合成失败（退出码 ${r.status}）${err ? '：' + err : ''}`);
  process.exit(2);
}
const pack = JSON.parse(tag.trim().slice('SAKI-TTS '.length));
let final = pack.items[0].file;

// 多句：拼成一条（句间 0.35 秒静音），发群时才需要
if (pack.items.length > 1) {
  const listFile = join(OUTDIR, `list-${stamp}.txt`);
  const gap = join(OUTDIR, 'gap.wav');
  if (!existsSync(gap)) {
    spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'anullsrc=r=24000:cl=mono', '-t', '0.35', gap], { encoding: 'utf8' });
  }
  const rows = [];
  pack.items.forEach((it, i) => {
    rows.push(`file '${it.file.replace(/\\/g, '/')}'`);
    if (i < pack.items.length - 1) rows.push(`file '${gap.replace(/\\/g, '/')}'`);
  });
  writeFileSync(listFile, rows.join('\n'), 'utf8');
  const merged = join(OUTDIR, `say-${stamp}.mp3`);
  const cr = spawnSync(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-ar', '24000', '-ac', '1', '-b:a', '64k', merged], { encoding: 'utf8', timeout: 120000 });
  if (cr.status === 0 && existsSync(merged)) final = merged;
  else say(`⚠️ 拼接失败，只发第一句`);
}

say(`成品：${final}（${(statSync(final).size / 1024).toFixed(0)} KB）`);
if (!SEND) {
  say('（没加 --send，只合成不发送）');
  process.exit(0);
}

const sr = spawnSync(
  process.execPath,
  [join(ROOT, 'tools', 'send-voice.mjs'), '--file', final, '--group', GROUP],
  { encoding: 'utf8', timeout: 120000, cwd: ROOT },
);
process.stdout.write(String(sr.stdout || ''));
if (sr.status !== 0) process.exit(3);
