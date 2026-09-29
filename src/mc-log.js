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
      texts.push({ name: f.name, text: f.data.toString('utf8', 0, Math.min(f.data.length, MAX_TEXT)) });
    }
    return texts;
  }
  if (lower.endsWith('.gz')) {
    try {
      const d = gunzipSync(buf);
      return [{ name: basename(lower, '.gz'), text: d.toString('utf8', 0, Math.min(d.length, MAX_TEXT)) }];
    } catch (e) {
      log.debug(`[日志] gzip 解压失败：${e.message}`);
      return [];
    }
  }
  return [{ name: name || 'log', text: buf.toString('utf8', 0, Math.min(buf.length, MAX_TEXT)) }];
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

  return {
    lines: lines.length,
    chars: src.length,
    exceptions: exLines.slice(0, 12),
    mods: mods.slice(0, 25),
    stack: stackFrames.slice(0, 25),
    known,
    // 给模型看的精简片段：异常 + 堆栈前几十行（比整份日志省 token）
    digest: buildDigest(lines, exLines, stackFrames),
  };
}

/** 挑出最相关的行给模型（整份日志几万行，全塞进去浪费） */
function buildDigest(lines, exLines, stack) {
  const out = [];
  const push = (s) => {
    if (s && out.length < 160) out.push(s);
  };
  for (const e of exLines.slice(0, 8)) {
    push(e.type === 'Description' ? `Description: ${e.msg}` : `${e.type}: ${e.msg}`);
  }
  // 报错关键词所在的行（前后各一行上下文）
  const kw = /Exception|Error|Caused by|FAILED|crash|conflict|missing|duplicate|mixin/i;
  for (let i = 0; i < lines.length && out.length < 120; i++) {
    if (kw.test(lines[i])) {
      push(lines[i].trim().slice(0, 400));
    }
  }
  for (const s of stack.slice(0, 20)) push(s.slice(0, 300));
  return out.join('\n');
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
  const rankOf = (n) => {
    const s = String(n ?? '').toLowerCase();
    if (/crash-?report/.test(s)) return 0; // 崩溃报告：最有用
    if (/latest\.log$/.test(s)) return 1; // 最近这一次的日志
    if (/debug\.log$/.test(s)) return 9; // DEBUG 噪音：最次
    if (/\.log$/.test(s)) return 2;
    if (/\.txt$/.test(s)) return 3;
    return 5;
  };
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
  return { ok: true, parsed, texts: texts.map((t) => t.name), cached: safe };
}

/**
 * 拼给模型看的分析材料。**强调不许编**。
 * @param {object} parsed
 */
export function logBlock(parsed) {
  const parts = ['', '# 【群友发来的崩溃日志】以下是系统解析出来的真实内容', ''];
  parts.push(`文件：${parsed.fileName ?? '(未知)'}　共 ${parsed.lines} 行`);
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
  parts.push('', '## 日志关键片段', '```', parsed.digest.slice(0, 6000), '```');
  parts.push(
    '',
    '## 怎么回答',
    '',
    // ⚠️⚠️ 2026-09-29 用户要求（起因：她在群里那条回复）：
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
    // ⚠️ 2026-09-29 用户要求：「再靠近一点**日常聊天**的语气，不要太轻浮」。
    //    ⚠️ "一句话"**不等于电报体**：短的是句子成分，不是语气词。
    '  ⚠️ 但**语气词留着**（「就行」「吧」「啊」）—— 短 ≠ 干巴巴：',
    '    「装 Java 21，17 必崩。」比「Java 版本不兼容，请安装 21」像人得多。',
    '- 没命中「已知问题」时：**先说结论**（这是什么问题），再给步骤，别把日志念一遍。',
    '- **匹配不到就别硬编原因**。可以说「这个报错我不太确定，你把 `Caused by` 那几行发出来」，',
    '  或者让他找 Ch1hayaAnonQWQ（技术问题归他）。',
    '- 步骤要能照做：说清楚改哪个文件、哪个选项、改成什么值。',
  );
  return parts.join('\n');
}

/** 判断一个消息段是不是「日志文件」 */
export function looksLikeLogFile(seg) {
  // ⚠️ 2026-09-29：段类型的大小写/别名都容一手（协议端换过，SnowLuma 给的是小写 file，
  //    但别的实现可能是 `File`）。
  if (String(seg?.type ?? '').toLowerCase() !== 'file') return false;
  // ⚠️ 2026-09-29：**文件名字段也放宽**。原来只认 `name` / `file`，
  //    而各协议端还见过 `filename` / `file_name` / `fileName` 这几种写法 ——
  //    认不出名字就等于**默默跳过整个文件**（现场那次就是这么漏的）。
  const d = seg.data ?? {};
  const n = String(d.name ?? d.file ?? d.filename ?? d.file_name ?? d.fileName ?? '');
  return /\.(log|txt|zip|gz|crash|json|yml|yaml|toml|md)$/i.test(n);
}
