/**
 * MC 崩溃日志分析。
 *
 * 需求（用户原话）：「自动下载下来…下载的缓存24小时后自动清理…自动解压并读取内容，
 * 然后给出一个可靠的解决方案」。
 *
 * 用法：群友直接把日志文件发进群（.log / .txt / .zip / .gz / crash-report），
 * 服务端会把文件推送过来，这里负责：
 *   ① 按 file_id 拉下来（OneBot 的 get_file）
 *   ② 存进缓存目录（24 小时后自动清理）
 *   ③ 是压缩包就解压（zip 用 zlib 裸解析，不引第三方依赖）
 *   ④ 解析出「崩溃签名」：异常类型、关键行、涉及的模组
 *   ⑤ 交给模型给出**可靠**的方案（不许编，不确定就说不确定）
 *
 * 为什么不引 adm-zip 之类：这台机器依赖越少越好，而且 zip 的 deflate 用内置 zlib 就够。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { inflateRawSync, gunzipSync } from 'node:zlib';
import { config, ROOT } from './config.js';
import { log } from './log.js';

const CACHE_DIR = join(ROOT, 'logs', '_uploaded');
/** 缓存 24 小时（用户要求） */
const TTL_MS = 24 * 60 * 60 * 1000;
/** 单个文件上限：日志一般几 MB，压得太狠反而丢信息 */
const MAX_BYTES = 40 * 1024 * 1024;
/** 解压后最多读这么多字符（够定位问题了，再多是浪费 token） */
const MAX_TEXT = 120 * 1024;

/**
 * **头尾都读**（2026-11-05 修，真现场）
 *
 * ⚠️⚠️ 现场：2026-11-04 22:57 群 200000007，群友发了 `latest.log`（2045.8KB / 10053 行）。
 *   日志里明确写着 `[日志] 解析 latest.log → 757 行` —— **只解析到 757 行**，
 *   而那份日志真正的崩溃结尾在第 9000 多行 ✗
 *   ⇒ 她说的「最后真正崩掉那块没截全」不是客套，是**文件末尾压根没被读进来**：
 *     MC 的 latest.log / crash-report 一律把 `Caused by` 压在**末尾**，
 *     而原来只 `toString('utf8', 0, MAX_TEXT)` ⇒ **只读前 120KB**（约 757 行）✗
 *
 * ⇒ 超出上限时改成 **头 35% + 尾 65%**（尾部权重更大，崩溃信息在那儿）✓
 */
function headTailText(buf, max = MAX_TEXT) {
  if (!buf || !buf.length) return '';
  if (buf.length <= max) return buf.toString('utf8');
  const head = Math.floor(max * 0.35);
  const tail = max - head;
  const a = buf.toString('utf8', 0, head).replace(/\uFFFD+$/g, '');
  const b = buf.toString('utf8', buf.length - tail).replace(/^\uFFFD+/g, '');
  return `${a}\n……（中间省略 ${Math.max(0, buf.length - max)} 字节）……\n${b}`;
}

/** 包里挑哪份文本：崩溃报告 > latest.log > 普通 .log > .txt > debug.log（噪音最次） */
function rankOfName(n) {
  const s = String(n ?? '').toLowerCase();
  if (/crash-?report/.test(s)) return 0; // 崩溃报告：最有用
  if (/latest\.log$/.test(s)) return 1; // 最近这一次的日志
  if (/debug\.log$/.test(s)) return 9; // DEBUG 噪音：最次
  if (/\.log$/.test(s)) return 2;
  if (/\.txt$/.test(s)) return 3;
  return 5;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 「看日志」工具（2026-11-05 要求）
 *
 * 用户原话：「**不能让模型自行选择读哪些部分吗**」
 *
 *   背景：那天我把崩溃日志的摘法从"从头扫关键词"改成"开头 50 条 + 末尾 80 行"——
 *   这**又是在代码里猜"哪一段重要"**，跟项目铁律（理解人话的交给模型、别用判据替她决定）
 *   是拧着的 ✗ 而且那天的真因（只读前 120KB）本来就该由"能按需读"来根治：
 *   **给她一把能翻整份日志的钥匙，她自己看哪儿** ✓
 *
 * ⇒ 落两件：
 *   ① `logBlock()` 进提示词的仍是**摘要**（省 token），但末尾告诉她"完整版在，
 *      你可以自己翻"，并给三个现成写法；
 *   ② 她在思考链里写 `[工具:看日志 …]` ⇒ 走 `readLog()`，从**原始文件**按需切行：
 *      · 不给参数          ⇒ 目录（总行数 + 可疑行号）
 *      · `{"关键字":"x"}`  ⇒ 含这个词的行（正则）
 *      · `{"行":9200,"行数":150}` ⇒ 某一段原文
 *      · `{"尾":150}`      ⇒ 最后 150 行
 *   ⚠️ 读的是 `logs/_uploaded/` 里那份**原始上传件**（不经过 `headTailText` 截断）✓
 * ══════════════════════════════════════════════════════════════════════════ */

/** 工具读全文的上限（8MB 以内就不截；再大多半不是日志） */
const MAX_TOOL_TEXT = 8 * 1024 * 1024;

/** 完整文本，**不截头尾** —— 只给「看日志」工具用 */
function rawTexts(name, buf) {
  const lower = String(name ?? '').toLowerCase();
  const clip = (b) => String(b?.toString('utf8', 0, Math.min(b.length, MAX_TOOL_TEXT)) ?? '');
  if (lower.endsWith('.zip')) {
    try {
      return unzip(buf).map((f) => ({ name: f.name, text: clip(f.data) }));
    } catch {
      return [];
    }
  }
  if (lower.endsWith('.gz')) {
    try {
      return [{ name: basename(lower, '.gz'), text: clip(gunzipSync(buf)) }];
    } catch {
      return [];
    }
  }
  return [{ name: name || 'log', text: clip(buf) }];
}

/** 最近一份群友发来的日志（工具从它读；没有就 '' ） */
export function lastUpload() {
  try {
    ensureDir();
    const files = readdirSync(CACHE_DIR)
      .map((f) => ({ f, m: statSync(join(CACHE_DIR, f)).mtimeMs }))
      .filter((x) => /\.[a-z0-9]+$/i.test(x.f))
      /* ⚠️⚠️⚠️ 2026-11-21 修（用户：「**看日志的工具写的提示词绝对有问题**，
       *   ds4.1flash 一样调不出来」）——
       *
       *   **`.json` 是"分析结果"，不是"群友发来的日志"** ✗
       *   2026-11-21 加了"分析结果落盘"（`<缓存名>.json`）之后，
       *   它总比原文件**新** ⇒ 按 mtime 排永远挑到它 ⇒
       *   `readLog` 把一份单行的 json 当成日志塞给她（实测"共 1 行"），
       *   等于这个工具彻底废掉 ✗✗
       *
       *   ⇒ 排除 `.json`（那是给 `loadAnalysis()` 用的，不是给人翻的正文）✓
       */
      .filter((x) => !/\.json$/i.test(x.f))
      .sort((a, b) => b.m - a.m);
    return files[0] ? join(CACHE_DIR, files[0].f) : '';
  } catch {
    return '';
  }
}

/** 把一份缓存文件拆成完整行（挑包里最该看的那份） */
function fullLinesOf(p) {
  try {
    const buf = readFileSync(p);
    const texts = rawTexts(basename(p), buf);
    if (!texts.length) return [];
    texts.sort((a, b) => rankOfName(a.name) - rankOfName(b.name) || b.text.length - a.text.length);
    return String(texts[0].text ?? '').split(/\r?\n/);
  } catch {
    return [];
  }
}

/** 目录：总行数 + 可疑行号（她要"自己翻"时的起点） */
export function logIndex() {
  const p = lastUpload();
  if (!p) return { ok: false, text: '这会儿还没有人发过日志文件。' };
  const lines = fullLinesOf(p);
  if (!lines.length) return { ok: false, text: '缓存里那份日志读不出来（可能是压缩包）。' };
  const susp = [];
  for (let i = 0; i < lines.length; i++) {
    if (/Caused by|Exception|ERROR|FATAL|crash|mixin|ClassNotFound|FAILED/i.test(lines[i])) susp.push(i + 1);
  }
  /* ⚠️ 2026-11-05：**均匀抽**，别只报前 60 个 —— 头一版就是从头顶数满 60 条就停，
   *    结果报出来的行号全挤在第 4~117 行（等于把读者又按回开头）✗
   *    这些行号是给她**导航**用的，必须覆盖整份文件 ✓ */
  const SAMPLE = 60;
  const shown =
    susp.length <= SAMPLE
      ? susp
      : [...new Set(Array.from({ length: SAMPLE }, (_, k) => susp[Math.floor((k * (susp.length - 1)) / (SAMPLE - 1))]))];
  return {
    ok: true,
    text: [
      `文件：${basename(p)}　共 ${lines.length} 行（完整原文，不是摘要）`,
      susp.length
        ? `可疑行号（Caused by / Exception / ERROR / ClassNotFound 等，**共 ${susp.length} 处**，下面是均匀抽的 ${shown.length} 个）：${shown.join(', ')}`
        : '（没扫到明显的报错行，可以直接读尾部）',
      '',
      '接着可以这样翻（参数随便挑一个）：',
      '  {"关键字":"Caused by"} — 含这个词的行（正则）',
      '  {"行":1234,"行数":150} — 从第 1234 行读 150 行',
      '  {"尾":150} — 最后 150 行',
    ].join('\n'),
  };
}

/**
 * **这个群**最近收下的那份日志（给提示词用：让她知道"有东西可看"）。
 *
 * ⚠️ 2026-11-23 加（现场：<主人> 连问两次「解读一下这个日志」，
 *   她一次去翻群公告、一次回「啥都没发现？」）——
 *   真因之一：**她不知道**那份日志还躺在缓存里、随时能用「看日志」翻。
 *   上下文里只有 `[文件:latest.log]` 这个占位符，光看它推不出"能读全文" ⇒
 *   只能靠猜或者按提示词那条"服务器的事先读公告"跑偏 ✗
 *
 * ⚠️ 必须**按群**过滤：缓存目录是全局的，别的群发的日志不能拿到这个群里说 ✗
 * @param {string|number} gid 群号（空 = 不限群）
 */
export function lastUploadOf(gid) {
  const g = String(gid ?? '').trim();
  try {
    ensureDir();
    let best = null;
    for (const f of readdirSync(CACHE_DIR)) {
      if (!/\.json$/i.test(f)) continue;
      let o;
      try {
        o = JSON.parse(readFileSync(join(CACHE_DIR, f), 'utf8'));
      } catch {
        continue;
      }
      if (!o?.fileName) continue;
      if (g && String(o.group ?? '') !== g) continue;
      const m = statSync(join(CACHE_DIR, f)).mtimeMs;
      if (!best || m > best.m) best = { m, o };
    }
    if (!best) return null;
    return {
      file: String(best.o.fileName ?? ''),
      inner: String(best.o.innerFile ?? ''),
      lines: Number(best.o.lines ?? 0),
      uploader: String(best.o.uploader?.name ?? ''),
      messageId: String(best.o.messageId ?? ''),
      at: Number(best.o.at ?? 0),
    };
  } catch {
    return null;
  }
}

/**
 * 按她的要求切一份日志给模型。
 * @param {{关键字?:string, grep?:string, 行?:number, from?:number, 行数?:number, count?:number, 尾?:number, tail?:number}} args
 */
export function readLog(args = {}) {
  const p = lastUpload();
  if (!p) return { ok: false, text: '这会儿还没有人发过日志文件。' };
  const lines = fullLinesOf(p);
  const total = lines.length;
  if (!total) return { ok: false, text: '缓存里那份日志读不出来（可能是压缩包）。' };

  const num = (v, def = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  };
  const fmt = (start, arr) =>
    arr.map((l, i) => `${start + i + 1}: ${String(l).slice(0, 300)}`).join('\n');

  // ① 按关键字找行
  const kw = String(args.关键字 ?? args.关键词 ?? args.grep ?? args.搜 ?? '').trim();
  if (kw) {
    let re;
    try {
      re = new RegExp(kw, 'i');
    } catch {
      return { ok: false, text: `「${kw}」不是合法的正则，换个词试试（比如 Caused by）` };
    }
    const hits = [];
    for (let i = 0; i < total && hits.length < 40; i++) {
      if (re.test(lines[i])) hits.push(`${i + 1}: ${lines[i].slice(0, 300)}`);
    }
    return {
      ok: true,
      text: hits.length
        ? `含「${kw}」的行（共 ${total} 行里找到这些，最多给 40 条）：\n${hits.join('\n')}`
        : `整份日志（${total} 行）里没有「${kw}」这个字样。`,
    };
  }

  // ② 最后 N 行
  const tailN = num(args.尾 ?? args.tail, 0);
  if (tailN > 0) {
    const n = Math.min(400, Math.max(1, tailN));
    const start = Math.max(0, total - n);
    return { ok: true, text: `最后 ${Math.min(n, total)} 行：\n${fmt(start, lines.slice(start))}` };
  }

  // ③ 指定某一段
  const from = num(args.行 ?? args.from ?? args.起, 0);
  if (from > 0) {
    const start = Math.max(0, Math.min(total - 1, from - 1));
    const n = Math.min(400, Math.max(1, num(args.行数 ?? args.count ?? args.多少, 120)));
    return {
      ok: true,
      text: `第 ${start + 1} 行起 ${Math.min(n, total - start)} 行（共 ${total} 行）：\n${fmt(start, lines.slice(start, start + n))}`,
    };
  }

  // ④ 什么都没给 ⇒ 先把目录给她
  return logIndex();
}

function ensureDir() {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
  } catch {}
}

/**
 * 清掉超过 24 小时的缓存（用户要求「下载的缓存24小时后自动清理」）。
 * 每次收文件时顺手跑一次，不用单独定闹钟。
 * @returns {number} 删了几个
 */
export function cleanCache(ttlMs = TTL_MS) {
  ensureDir();
  const now = Date.now();
  let n = 0;
  try {
    for (const f of readdirSync(CACHE_DIR)) {
      const p = join(CACHE_DIR, f);
      try {
        if (now - statSync(p).mtimeMs > ttlMs) {
          unlinkSync(p);
          n++;
        }
      } catch {}
    }
  } catch {}
  if (n) log.info(`[日志] 清理了 ${n} 个过期缓存（超过 ${Math.round(ttlMs / 3600000)} 小时）`);
  return n;
}

/**
 * 读「已经分析好的」崩溃报告（2026-11-21 加，用户要求：
 *   「现在自动分析里应该已经有产物内容供工具读取了吧」
 *   「分析完的内容作为分析错误工具需要调用的内容，24小时删」）
 *
 * 文件一来就自动 `analyzeFile()` ⇒ 结果落成 `<缓存名>.json` ⇒ 这里直接读，
 * **不用再下再解**（省好几秒）✓
 *
 * @param {object} [want]
 *   · `want.qq`   只要这个人上传的（QQ 号）
 *   · `want.name` 只要文件名里带这几个字的
 *   · `want.since` 只要这个时间点之后的
 * @returns {{analysis:object, ageMs:number}|null}
 */
export function loadAnalysis(want = {}) {
  ensureDir();
  let files;
  try {
    files = readdirSync(CACHE_DIR).filter((f) => /\.json$/i.test(f));
  } catch {
    return null;
  }
  if (!files.length) return null;

  const rows = [];
  for (const f of files) {
    const p = join(CACHE_DIR, f);
    try {
      const st = statSync(p);
      const a = JSON.parse(readFileSync(p, 'utf8'));
      rows.push({ a, mtime: st.mtimeMs });
    } catch {
      /* 坏文件跳过 */
    }
  }
  if (!rows.length) return null;

  const qq = String(want?.qq ?? '').trim();
  const nm = String(want?.name ?? '').trim();
  const since = Number(want?.since ?? 0);

  let hit = rows;
  if (qq) {
    const byQq = hit.filter((r) => String(r.a?.uploader?.qq ?? '') === qq);
    if (byQq.length) hit = byQq;
  }
  if (nm) {
    const byName = hit.filter((r) => String(r.a?.fileName ?? '').includes(nm));
    if (byName.length) hit = byName;
  }
  if (since > 0) {
    const byTime = hit.filter((r) => Number(r.a?.at ?? 0) >= since);
    if (byTime.length) hit = byTime;
  }
  if (!hit.length) return null;

  hit.sort((x, y) => y.mtime - x.mtime);
  const pick = hit[0];
  return { analysis: pick.a, ageMs: Date.now() - pick.mtime };
}

export function cacheStats() {
  ensureDir();
  const now = Date.now();
  let count = 0;
  let bytes = 0;
  try {
    for (const f of readdirSync(CACHE_DIR)) {
      const p = join(CACHE_DIR, f);
      try {
        const st = statSync(p);
        count++;
        bytes += st.size;
      } catch {}
    }
  } catch {}
  return { dir: CACHE_DIR, count, mb: Math.round((bytes / 1048576) * 10) / 10, ttlHours: TTL_MS / 3600000 };
}

// ── zip 解压（只用内置 zlib，不引依赖）────────────────

/**
 * 从一段 Buffer 里解出 zip 中的文件。
 *
 * ⚠️ 这里只处理最常见的「单个 deflate 压缩的 zip」——
 *    MC 日志包基本都是这个形态。遇到不认识的结构就返回空，调用方退回当普通文本读。
 *
 * @returns {Array<{name:string, data:Buffer}>}
 */
export function unzip(buf) {
  const out = [];
  // 找 End of Central Directory（EOCD）：签名 0x06054b50
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return out;

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break; // central directory 签名
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    off += 46 + nameLen + extraLen + commentLen;

    if (!name || name.endsWith('/')) continue;
    // 只要文本类文件，别的（图片等）跳过
    if (!/\.(log|txt|json|yml|yaml|toml|md|crash|txt\.gz)$/i.test(name)) continue;

    try {
      // 局部文件头：签名 0x04034b50，长度在偏移 26
      const lh = localOff;
      if (buf.readUInt32LE(lh) !== 0x04034b50) continue;
      const lNameLen = buf.readUInt16LE(lh + 26);
      const lExtraLen = buf.readUInt16LE(lh + 28);
      const dataStart = lh + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
      out.push({ name, data });
    } catch (e) {
      log.debug(`[日志] zip 里 ${name} 解压失败：${e.message}`);
    }
  }
  return out;
}

/** 按扩展名挑出可能的文本内容 */
export function extractTexts(name, buf) {
  const lower = String(name ?? '').toLowerCase();
  const texts = [];

  if (lower.endsWith('.zip')) {
    for (const f of unzip(buf)) {
      texts.push({ name: f.name, text: headTailText(f.data) });
    }
    return texts;
  }
  if (lower.endsWith('.gz')) {
    try {
      const d = gunzipSync(buf);
      return [{ name: basename(lower, '.gz'), text: d.toString('utf8') }];
    } catch (e) {
      log.debug(`[日志] gzip 解压失败：${e.message}`);
      return [];
    }
  }
  /* ⚠️⚠️ 2026-11-22 修（用户：「**日志是不是没进上下文**」）——
   *
   *   现场：群友发 `latest.log` **5.95 MB / 6236705 字节**，日志里写着
   *   `[日志] 解析 latest.log → 648 行`、`parsed.chars = 115597`。
   *   115597 ÷ 6236705 ≈ **1.9%** —— 也就是说**98% 的日志压根没被解析**，
   *   她拿到的只有头 42KB + 尾 78KB，中间真正的报错全在黑洞里 ✗
   *   （她于是只能说「啥都没发现？」，而在她那边这确实是"没发现"）
   *
   *   根因：这里原来走 `headTailText(buf)`（只保头尾 120KB）——
   *   那个函数是**给模型看**的裁剪器，**不该用来当"扫描源"**。
   *   ⇒ 未压缩的 .log / .txt **一律读全文**（上限 `MAX_BYTES` 40MB），
   *     裁剪交给后面的 `buildDigest()` / `clipMiddle()`（它只把片段送模型）✓ */
  return [{ name: name || 'log', text: buf.toString('utf8') }];
}

// ── 解析 ──────────────────────────────────────────────

/** 从日志文本里抽出「崩溃签名」 */
export function parseLog(text) {
  const src = String(text ?? '');
  const lines = src.split(/\r?\n/);

  // 异常类型：crash-report 里的 Description / 第一行 Exception，或日志里的 Caused by
  const exLines = [];
  const modRefs = new Set();
  const stackFrames = [];

  for (const l of lines) {
    // net.minecraftforge / java.lang.* / mixin 报错
    const m1 = l.match(/(?:Caused by:\s*)?((?:[a-z][\w$]*\.){2,}[\w$]*(?:Exception|Error|Throwable))(?::\s*(.*))?/);
    if (m1) {
      exLines.push({ type: m1[1], msg: (m1[2] ?? '').trim() });
    }
    // 崩溃报告里的描述块
    if (/^\s*Description:\s*(.+)$/.test(l)) exLines.push({ type: 'Description', msg: l.replace(/^\s*Description:\s*/, '').trim() });
    // 模组 id：mixins / mod id 出现在各种地方
    for (const mm of l.matchAll(/\b([a-z][a-z0-9_]{2,30})\.mixins?\b/g)) modRefs.add(mm[1]);
    for (const mm of l.matchAll(/\bat\s+([a-z][a-z0-9_]{2,30})\./g)) modRefs.add(mm[1]);
    if (/^\s+at\s+/.test(l) && stackFrames.length < 40) stackFrames.push(l.trim());
  }

  // 剔掉噪声：Java 包名根、以及不是模组 id 的东西
  const NOISE = new Set([
    'java', 'javax', 'sun', 'jdk', 'net', 'com', 'org', 'io', 'it', 'cpw', 'joptsimple',
    'org_spongepowered', 'mixin', 'mods', 'minecraft', 'forge', 'neoforge', 'fabric',
  ]);
  const mods = [...modRefs]
    .map((m) => m.trim())
    .filter((m) => m.length >= 3 && !NOISE.has(m) && !/^\d+$/.test(m))

  // 常见崩溃模式（这些是 MC 圈里最典型的，命中率最高）
  const known = [];
  const has = (re) => re.test(src);
  if (has(/java\.lang\.OutOfMemoryError/)) {
    known.push({
      id: 'oom',
      what: '内存不足（OutOfMemoryError）',
      fix: '把启动器分配的内存调大（整合包建议 6~8G），并确认用的是 64 位 Java。',
    });
  }
  if (has(/UnsupportedClassVersionError|class file version/i)) {
    known.push({
      id: 'javaversion',
      what: 'Java 版本不对',
      fix: '这个整合包要 Java 21（用 17 会崩）。启动器里把 Java 路径指到 21。',
    });
  }
  if (has(/Missing or unsupported mandatory dependencies|Mod ID:.*requires/i)) {
    known.push({
      id: 'missingdep',
      what: '缺前置模组 / 模组版本不匹配',
      fix: '按报错里点名的模组，把前置装上或把版本对齐（多半是整合包没更新到最新）。',
    });
  }
  if (has(/Duplicate mods|DuplicateModsFoundException|已存在.*模组/i)) {
    known.push({
      id: 'duplicate',
      what: '模组重复（同一个模组装了两份）',
      fix: '去 mods 文件夹删掉重复的那一份。常见于增量更新时新旧版本同时存在。',
    });
  }
  if (has(/Mixin.*(apply|transform).*failed|MixinApplyError|MixinTransformerError/i)) {
    known.push({
      id: 'mixin',
      what: 'Mixin 注入失败（模组之间打架）',
      fix: '看报错里提到的两个模组，通常是加速渲染类（Sodium/Embeddium）和别的渲染模组冲突，禁用其中一个。',
    });
  }
  if (has(/Pixel format not accelerated|Failed to create (window|context)|OpenGL/i)) {
    known.push({
      id: 'gl',
      what: 'OpenGL / 显卡问题',
      fix: '更新显卡驱动；笔记本确认用的是独显不是核显；跨屏/远程桌面下容易出这个。',
    });
  }
  if (has(/LWJGL|Failed to locate library|UnsatisfiedLinkError/i)) {
    known.push({
      id: 'lwjgl',
      what: 'LWJGL 本地库有问题',
      fix: '启动器自带的 LWJGL 出问题。FCL 用户把 FCL 更新到最新版；其他启动器试试重新安装这个版本。',
    });
  }
  if (has(/The game crashed whilst|has crashed|崩溃报告/i) && !known.length) {
    known.push({
      id: 'generic',
      what: '游戏崩溃（具体原因见异常堆栈）',
      fix: '把日志里 Caused by 那几行发出来能更准。',
    });
  }

  /* ⚠️ 2026-11-22 加：**全文统计**。
   *   "解读一下这个日志" 这种问法要的是**能直接说出口的数字**（几万行、多少 ERROR、
   *   跑了多久、是崩了还是正常退），而不是一句"0 个异常、0 条命中"◇
   *   （她上次就是拿着这句回了「啥都没发现？」，等于什么都没解读）*/
  let errors = 0;
  let warns = 0;
  let firstTs = '';
  let lastTs = '';
  let tailLine = '';
  const tsRe = /\[(\d{2}:\d{2}:\d{2})\]/;
  for (const l of lines) {
    if (!l) continue;
    if (l.includes('ERROR')) errors++;
    else if (l.includes('WARN')) warns++;
    const m = tsRe.exec(l);
    if (m) {
      if (!firstTs) firstTs = m[1];
      lastTs = m[1];
    }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] && lines[i].trim()) {
      tailLine = lines[i].trim().slice(0, 200);
      break;
    }
  }
  const normalStop = /Stopping!|client stopping|Saving configuration|shutting down|shutdown/i.test(tailLine);

  return {
    lines: lines.length,
    chars: src.length,
    exceptions: exLines.slice(0, 12),
    mods: mods.slice(0, 25),
    stack: stackFrames.slice(0, 25),
    known,
    stats: { errors, warns, firstTs, lastTs, tailLine, normalStop },
    // 给模型看的精简片段：异常 + 堆栈前几十行（比整份日志省 token）
    digest: buildDigest(lines, exLines, stackFrames),
  };
}

/** 挑出最相关的行给模型（整份日志几万行，全塞进去浪费） */
function buildDigest(lines, exLines, stack) {
  const out = [];
  const push = (s) => {
    if (s && out.length < 200) out.push(s);
  };
  for (const e of exLines.slice(0, 8)) {
    push(e.type === 'Description' ? `Description: ${e.msg}` : `${e.type}: ${e.msg}`);
  }
  /* ⚠️⚠️ 2026-11-05 修（现场：2026-11-04 22:57 群 200000007 那份 latest.log）
   *
   *   用户看到的那条回复是：「满屏都是 ClassNotFound……最后真正崩掉那块没截全，
   *   你把日志最底下带 Caused by 的那几行发出来看看」。
   *   ⇒ **她没说错**：那份日志 757 行、12 个异常，可她看到的只有**开头**那一段。
   *
   *   真因就是这里：原来从头扫关键词，配额 120 条**全被前面的重复错误吃掉**，
   *   而 MC 崩溃报告/日志里**真正的因果（Caused by / Suppressed）几乎都压在文件末尾** ✗
   *   （日志越靠后越接近崩溃那一刻，这是所有人的习惯）
   *   ⇒ 两头都给：开头关键词只留 **50 条**，**末尾 80 行原文必须整段带上** ✓
   */
  const kw = /Exception|Error|Caused by|FAILED|crash|conflict|missing|duplicate|mixin/i;
  let fromHead = 0;
  for (let i = 0; i < lines.length && fromHead < 50; i++) {
    if (kw.test(lines[i])) {
      push(lines[i].trim().slice(0, 400));
      fromHead++;
    }
  }
  for (const s of stack.slice(0, 12)) push(s.slice(0, 300));

  // ★ 尾部原文：不受上面 `push` 的条数上限约束（这 80 行是诊断的命根子）
  const TAIL = 80;
  const start = Math.max(0, lines.length - TAIL);
  const tail = [];
  for (let i = start; i < lines.length; i++) tail.push(lines[i].trim().slice(0, 500));
  return [out.join('\n'), '', `……（中间省略 ${start} 行）……`, '', ...tail].join('\n');
}

/**
 * **保头保尾**地截断。
 *
 * ⚠️ 2026-11-05：`logBlock` 原来是 `digest.slice(0, 6000)` —— 从**头**切，
 *   等于刚刚补上的尾部原文又被切掉一次 ✗（同一个病犯了两次）
 * ⇒ 中间省略、两头都留 ✓
 */
function clipMiddle(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.45);
  const tail = max - head;
  return `${s.slice(0, head)}\n……（中间省略 ${s.length - max} 字）……\n${s.slice(-tail)}`;
}

/**
 * 处理一个用户发来的日志文件。
 *
 * @param {{name:string, buf:Buffer}} file
 * @returns {{ok:boolean, reason?:string, parsed?:object, texts?:Array}}
 */
export function analyzeFile(file) {
  const name = String(file?.name ?? 'log');
  const buf = file?.buf;
  // ⚠️ 2026-11-21 加：**这份是谁发的**（用户要求「要把每个错误文件的主人分清楚，
  //   防止回话时引用错消息」）—— 多人都发过崩溃报告时必须分清，
  //   所以让调用方把 uploader 传进来，一起存进分析结果 ✓
  const uploader = file?.uploader ?? {};
  if (!buf || !buf.length) return { ok: false, reason: '文件是空的' };
  if (buf.length > MAX_BYTES) {
    return { ok: false, reason: `文件太大（${(buf.length / 1048576).toFixed(1)}MB > ${MAX_BYTES / 1048576}MB）` };
  }

  cleanCache();
  ensureDir();
  const safe = `${Date.now()}_${basename(name).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_')}`.slice(0, 120);
  try {
    writeFileSync(join(CACHE_DIR, safe), buf);
  } catch (e) {
    log.debug(`[日志] 缓存写入失败：${e.message}`);
  }

  const texts = extractTexts(name, buf);
  if (!texts.length) {
    return { ok: false, reason: '压缩包里没找到可读的日志文本' };
  }
  // ⚠️⚠️ 2026-09-29 修（现场：北辰发的那份「错误报告-2026-9-29_21.47.12.zip」
  //    被解析成 **0 个异常、0 条命中**，等于白读）。
  //
  //    原因就是这一行**按大小挑**：「最大的那个文本」在他那个包里是 `debug.log`
  //    （553 行 DEBUG 级噪音），真正的崩溃证据（crash-report / latest.log）
  //    **根本轮不到** ✗
  //
  //    ⇒ 改成**按文件名优先级**排，同档再比大小。
  //      `debug.log` 永远排最后 —— 它只会把结论淹掉。
  const rankOf = rankOfName;
  texts.sort((a, b) => rankOf(a.name) - rankOf(b.name) || b.text.length - a.text.length);
  const main = texts[0];
  log.info(
    `[日志] 包内候选：${texts.map((t) => `${t.name}(档${rankOf(t.name)})`).join('、')} → 选 ${main.name}`,
  );
  const parsed = parseLog(main.text);
  parsed.fileName = main.name;

  log.info(
    `[日志] 解析 ${name} → ${parsed.lines} 行，${parsed.exceptions.length} 个异常，` +
      `命中 ${parsed.known.length} 条已知模式`,
  );

  /* ⚠️⚠️ 2026-11-21 加（用户：「**现在自动分析里应该已经有产物内容供工具读取了吧**」
   *   「分析完的内容作为分析错误工具需要调用的内容，24小时删」）——
   *
   * 原来 `parsed` 只在内存里返给当次调用，**没落盘** ⇒
   *   · 文件来了自动分析完，结果就丢了；
   *   · 她后来想起来"再看看那份"，只能重新下载 + 重新解压 + 重新解析（白花好几秒）✗
   *
   * ⇒ 现在把分析结果存成 `<缓存名>.json`：
   *   · 跟原文件放同一个 `logs/_uploaded/`，`cleanCache()` 按 mtime 一起清（24h）✓
   *   · 里面有 `uploader`（谁发的）+ `fileName` + `parsed`（异常/命中）+ `at`
   *   · `loadAnalysis()` 读它 ⇒ 工具直接拿"已分析好的"内容，不用再下再解 ✓
   */
  const analysis = {
    at: Date.now(),
    fileName: name,
    innerFile: main.name,
    uploader: {
      qq: String(uploader?.qq ?? ''),
      name: String(uploader?.name ?? ''),
    },
    group: String(uploader?.group ?? ''),
    messageId: String(uploader?.messageId ?? ''),
    lines: parsed.lines,
    exceptions: parsed.exceptions?.length ?? 0,
    known: parsed.known?.length ?? 0,
    parsed,
    cached: safe,
  };
  try {
    writeFileSync(join(CACHE_DIR, safe + '.json'), JSON.stringify(analysis), 'utf8');
  } catch (e) {
    log.debug(`[日志] 分析结果落盘失败：${e.message}`);
  }
  return { ok: true, parsed, texts: texts.map((t) => t.name), cached: safe, analysis };
}

/**
 * 拼给模型看的分析材料。**强调不许编**。
 * @param {object} parsed
 */
export function logBlock(parsed) {
  const parts = ['', '# 【群友发来的崩溃日志】以下是系统解析出来的真实内容', ''];
  parts.push(`文件：${parsed.fileName ?? '(未知)'}　共 ${parsed.lines} 行`);
  /* ⚠️ 2026-11-22 加：**概况优先**。
   *   她上次拿到的全部材料是「648 行，0 个异常，0 条命中」⇒ 只能回「啥都没发现？」。
   *   而"解读日志"要的是这几个数：几行、多少 ERROR/WARN、跑了多久、有没有正常退出。 */
  const st = parsed.stats;
  if (st) {
    parts.push('', '## 概况（**全文**统计，可以直接照着说）');
    parts.push(`- 一共 ${parsed.lines} 行`);
    parts.push(`- ERROR ${st.errors} 条 / WARN ${st.warns} 条`);
    if (st.firstTs && st.lastTs) parts.push(`- 时间跨度：${st.firstTs} → ${st.lastTs}`);
    if (st.tailLine) {
      parts.push(
        `- 最后一行：${st.tailLine}` +
          (st.normalStop ? '　⇒ **这次是正常退出/关闭，不是崩溃**' : ''),
      );
    }
    if (!parsed.exceptions.length && !parsed.known.length && st.errors === 0) {
      parts.push(
        '- ⚠️ 没有任何 ERROR、也没匹配到崩溃模式 ⇒ **照实说"这份日志里没崩"**，' +
          '然后按上面的概况把"跑了多久、有多少警告、是什么阶段退的"讲给他听；' +
          '**不许编一个不存在的问题** ✗',
      );
    }
  }
  if (parsed.exceptions.length) {
    parts.push('', '## 检测到的异常');
    for (const e of parsed.exceptions) {
      parts.push(e.type === 'Description' ? `- 描述：${e.msg}` : `- ${e.type}${e.msg ? `: ${e.msg}` : ''}`);
    }
  }
  if (parsed.mods.length) {
    parts.push('', `## 日志里出现的模组/包名`, parsed.mods.join('、'));
  }
  if (parsed.known.length) {
    parts.push('', '## 系统匹配到的**已知问题**（这些是可靠的，优先照它答）');
    for (const k of parsed.known) parts.push(`- ${k.what}\n  → 解决：${k.fix}`);
  }
  parts.push('', '## 日志关键片段', '```', clipMiddle(parsed.digest, 12000), '```');
  parts.push(
    '',
    '## 怎么回答',
    '',
 // ⚠️⚠️ 2026-09-29 要求（起因：她在群里那条回复）：
    //    「这种**经典问题直接简短一点**就行了，要不然群友反而会看不懂」。
    //    事实现场：那次回了 140 字，里面还带着 `class file 65.0` 的版本号，
    //    以及「要么换 Iris、要么升 Java」两个选择 —— 用户当场说「这样肯定不行」。
    //    ⇒ 命中「已知问题」= 这是群里答过很多遍的**经典问题**：
    //      **一句话给唯一答案**，不解释原理、不给备选、不念堆栈。
    '- ⚠️⚠️ **命中「已知问题」时，一句话就够** —— 那是**经典问题**，别展开：',
    '  ✅ 就这个长度：「装 Java 21，17 必崩。」「内存调大到 6~8G。」「渲染模组装多了，删一个。」',
    '  🚫 **别解释原理**（版本号、为什么崩、是哪个模组带崩的），别念异常堆栈。',
    '  🚫 **别给两个选择**（「要么换模组、要么升 Java」）—— 直接给那个**最省事**的。',
    '  🚫 别写小标题、别分点列三条以上 —— 群里没人看那么长。',
 // ⚠️ 2026-09-29 要求：「再靠近一点**日常聊天**的语气，不要太轻浮」。
    //    ⚠️ "一句话"**不等于电报体**：短的是句子成分，不是语气词。
    '  ⚠️ 但**语气词留着**（「就行」「吧」「啊」）—— 短 ≠ 干巴巴：',
    '    「装 Java 21，17 必崩。」比「Java 版本不兼容，请安装 21」像人得多。',
    '- 没命中「已知问题」时：**先说结论**（这是什么问题），再给步骤，别把日志念一遍。',
    '- **匹配不到也别急着让人补发** —— 先自己翻（见下面「想看得更细」）：',
    '  很多"没看到"只是上面这段摘出来的没摘到，原文里其实有的。真翻不到再说「你把 Caused by 那几行发出来」。',
    '  实在不懂就让他找 Ch1hayaAnonQWQ（技术问题归他）。',
    '- 步骤要能照做：说清楚改哪个文件、哪个选项、改成什么值。',
    '',
    '## 想看得更细（**关键**）',
    '',
    '上面给你的只是**摘出来的一段**，不是全文。整份日志在服务器上，你**随时可以自己翻**：',
    '在**思考链**里写下面任意一种，系统会把那几行原文给你：',
    '',
    '```',
    '[工具:看日志]                                  ← 先拿目录：总行数 + 可疑行号',
    '[工具:看日志 {"关键字":"Caused by"}]            ← 找含这个词的行（正则也行）',
    '[工具:看日志 {"行":9200,"行数":150}]            ← 从第 9200 行读 150 行',
    '[工具:看日志 {"尾":150}]                        ← 读最后 150 行',
    '```',
    '',
    '⚠️ 崩溃日志的真正原因（`Caused by` / `Suppressed` / 第一个 ERROR）**大多在很靠后的位置**，',
    '  上面那段只摘了头尾，中间可能就藏着答案 ⇒ **别凭"没看到"就说没截全，先自己查一次**。',
    '⚠️ 查完还是不对、或者日志本身残缺（比如被截断了），再让群友重发 —— 那时候说得出"我要哪几行"就够专业了。',
  );
  return parts.join('\n');
}

/**
 * 判断一个消息段是不是「日志文件」。
 *
 * ⚠️⚠️ 2026-10-16 修（用户截图 + 日志实证的真 bug）：
 *    现场：工作号那个**客户发来的 `实训.zip`（90MB 实训项目）** 被判成"崩溃日志"⇒
 *      ① 绕过「接不接」的判定（`hit: 'logfile'`）；② **真去把 90MB 拖下来了**
 *      （`[日志] 取到「实训.zip」…94398192 字节`）然后才说"太大不分析" ✗；
 *      ③ 那一轮用的是"崩溃日志"那套提示词 ✗
 *    真因：老判据把 `.zip / .json / .md / .txt / .yml …` **一律**当日志 ⇒
 *      世界上所有压缩包都成了"崩溃日志" ✗
 *    ⇒ 现在：**`.log` 无歧义、直接算**；别的扩展名**必须名字里有"像日志"的线索**
 *      （`crash` / `latest` / `error` / `崩溃` / `报错` / `日志`）才算 ✓
 */
export function looksLikeLogFile(seg) {
  // ⚠️ 2026-09-29：段类型的大小写/别名都容一手（协议端换过，SnowLuma 给的是小写 file，
  //    但别的实现可能是 `File`）。
  if (String(seg?.type ?? '').toLowerCase() !== 'file') return false;
  // ⚠️ 2026-09-29：**文件名字段也放宽**。原来只认 `name` / `file`，
  //    而各协议端还见过 `filename` / `file_name` / `fileName` 这几种写法 ——
  //    认不出名字就等于**默默跳过整个文件**（现场那次就是这么漏的）。
  const d = seg.data ?? {};
  const n = String(d.name ?? d.file ?? d.filename ?? d.file_name ?? d.fileName ?? '');
  if (!n) return false;
  if (/\.log$/i.test(n)) return true;
  /* ⚠️⚠️⚠️ 2026-11-21 修（真事故：群里发了「错误报告-2026-11-20_23.08.49.zip」，
   *   她只能看到 `[文件:xxx.zip]`，既没让人解压也没自己读，还反问「错误报告呢」）——
   *
   * 原来的正则只有 `crash|latest|error|exception|stacktrace|崩溃|报错|错误日志|日志`，
   * **没有「错误报告」这四个字** ⇒ PCL / HMCL 导出的崩溃包（默认命名就是
   * `错误报告-<日期>.zip`）**一个都认不出来** ⇒ 整个"自动下载+解压+解析"的路被跳过 ✗✗
   *
   * 按用户指定补上这几类判据：
   *   · 名字带「错误报告」的压缩包（PCL / HMCL 默认命名）
   *   · 名字带 `crash` 的（crash-report / crash-2026-xx.txt）
   *   · `latest.log`
   * 顺带补同义：`report` / `dump` / `闪退` / `异常`
   */
  return /(crash|latest|error|exception|stacktrace|错误报告|错误日志|报错|崩溃|闪退|异常|日志|report|dump)/i.test(
    n,
  );
}

/** 崩溃日志分析的大小上限（`bot.js` 在**下载之前**先拿它比一下 ✓） */
export function maxLogBytes() {
  return MAX_BYTES;
}
