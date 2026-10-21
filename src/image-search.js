/**
 * 「搜图」工具 —— 边搜边发、直接发图片、每张配她一句话（2026-10-19 加）
 *
 * ## 用户原话
 *   「接活接到刚刚群里那种搜图时的场景可以优化一下，**找到一张能发的就先发出来**，
 *     并且**不要以文件发出来，直接以图片形式发出来**，然后**配一句 bot 自己的评论**，
 *     一次搜图**发 3-5 张**就可以了。直接打包成一个新的工具吧，搜图场景直接代替之前用的接活工具。」
 *   +「**如果第二次搜相同的内容，注意不要发出相同的图**」
 *   +「**不是拿到一张就发，要 agent 觉得这张图不错再发**」
 *
 * ## 现场（截图，01:4x）
 *   她其实搜到 **14 张**，但走的是「产物打包发群文件」那条老路 ——
 *   `sendArtifacts()` 最多发 3 个、**还是当文件发**，剩下的只能让她说
 *   「有十四个东西太大，群里一次发不完，就留在我这儿存着了」✗
 *   ⇒ 用户还得再补一句「随便发一张出来吧」⇒ 观感就是"她明明有，非要你再问一遍"。
 *
 * ## 所以这个工具**不走产物那条路**
 *   ① 起任务带 `mode: 'image'` ⇒ `sendArtifacts()` 跳过图片（不再当文件发）；
 *   ② **边跑边扫**任务文件夹，但**只发 agent 自己挑过的**（见下）；
 *   ③ 每张**配一句她自己的话**（`voiceize`），**先说话再发图** —— 真人就是这么发的；
 *   ④ 一次发几张：他说「三张」就三张，没指定就 **3~5 张随机**（`cap`，硬上限 `MAX_IMAGES`）。
 *
 * ## ⭐ 「要 agent 觉得不错才发」怎么落地
 *   agent 下载时**看得到网页标题 / 来源**（bot 看不到图，判断不了好不好），所以由它挑：
 *   任务文件夹里的 **`挑好的.md`**，一行一张：`文件名 | 好在哪（一短句）`。
 *   · 有清单 ⇒ **只发清单里的**，顺序照它写的，那句"好在哪"给她当话的素材；
 *   · **没清单** ⇒ 运行期一张都不发；等任务结束**才兜底发 1 张**
 *     （既不至于"一张都没有"，也不至于把没挑过的十几张全倒进群 ✗）。
 *
 * ## ⭐ 跨次去重
 *   发之前先算 **aHash**（8×8 灰度指纹，64 bit）—— 同一张图哪怕换了尺寸/重新压缩也认得出。
 *   跟 `state/__image-search-sent.json` 里最近 500 条比，**汉明距离 ≤ 6 就算同一张** ⇒ 跳过。
 *   （跨号、跨群共用一个库：同一张图在两个群各发一遍同样很烦 ✓）
 *
 * ## 两个"别发出去"的兜底
 *   · 太小的（< 8KB）= 图标 / 占位图 / 没下下来的空壳 ⇒ 跳过；
 *   · 刚写进去的（mtime 距今 < 1.5 秒）= 可能还在下载 ⇒ 下一轮再看（发半张坏图最难看）。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { log } from './log.js';
import { describeImage } from './vision.js';
import { runningDir, startRun, voiceize, workspace } from './agent-bridge.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SENT_FILE = join(ROOT, 'state', '__image-search-sent.json');
// ⚠️ 登记「哪些文件夹是搜图任务」—— 清理**只认这些**（私聊产物 / 模型权重一个不碰）
const DIRS_FILE = join(ROOT, 'state', '__image-search-dirs.json');
const PICK_FILES = ['挑好的.md', '挑好的.txt'];

const IMG_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;
const MIN_BYTES = 8 * 1024; // 比这还小的，多半是图标 / 占位 / 没下下来的空文件
const SETTLE_MS = 1500; // 刚写进去的图可能还在下载 ⇒ 这一轮先不发
const TICK_MS = 3000; // 多久扫一遍任务文件夹
const MAX_IMAGES = 10; // **硬上限**（实际发几张见下面 `cap`：他说"三张"就三张，没说就 3~5 随机）
const DUP_DISTANCE = 6; // 指纹汉明距离 ≤ 这个数就算"同一张"
const SENT_KEEP = 500; // 指纹库里留多少条
const MAX_CACHE_MB = 200; // 任务文件夹里的图超过这个数就开始滚动清理（用户定的 200MB）
const MAX_DELETE = 200; // 一次最多删多少张（防"堆了几 GB"时一口气删掉几千张）
const MAX_IMG_B64 = 6 * 1024 * 1024; // base64 超过这个就不硬发了（协议端会拒；15MB 原图 base64 后 20MB）

/**
 * 从他的话里**读出"要几张"**（2026-10-19 加，用户要求）。
 *
 * 用户原话：「加一个找图数量控制，当我说**找一张 / 拿两张 / 搜三张 XX 图**的时候，
 *   要**真的一共发那么多张**图；如果是**发几张**的话，数量还是和之前一样**随机**」
 *
 * 判据：
 *   · 认出「一/两/二/三/…/十」或「1~10」+「张 / 幅 / 个」⇒ 就发那么多张；
 *   · **「几张」= 没指定**（「几」不在数字表里，所以不会误判）⇒ 交给随机（3~5 张）✓
 *
 * @param {string} text 他的话（不要传**我们自己拼的任务模板** —— 那里面别有数字）
 * @returns {number} 0 = 没指定
 */
export function countFromTask(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  const cn = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  // ① 汉字数字（「两张」「三幅」）
  const a = /([一二两三四五六七八九十])\s*[张幅]/g.exec(s);
  if (a && cn[a[1]]) return Math.min(10, cn[a[1]]);
  // ② 阿拉伯数字（「2 张」「10张」）
  const b = /(\d{1,2})\s*[张幅]/.exec(s);
  if (b) {
    const n = Number(b[1]);
    if (n >= 1) return Math.min(10, Math.floor(n));
  }
  return 0;
}

/**
 * **这个任务是不是"要图"** —— 搜图的兜底判据（`bot.js` 和 `agent-bridge.js` 共用）。
 *
 * 为什么需要（2026-10-19 当天实测）：`[搜图]` 的日志**一次都没出现过** ——
 *   模型两次都拿「动这一单」去搜图（"找点爱祥图过来"），提示词加强两轮也没用 ✗
 *   更狠的是：**派活那条路（`agentBridge.handleTask`）压根不经过 bot 层**
 *   ⇒ 只在这里补一道，走到哪儿都能转过来 ✓
 *
 * ⚠️ 这是**兜底**、不是主判据（模型选对工具时根本走不到）——
 *    按 AGENTS 的规矩，关键词只当兜底可以，当主判据不行 ✓
 *
 * 判据：**带"图"类名词** + **带"要图"类动词**，且**不带文档类词**。
 * @param {string} task
 * @returns {boolean}
 */
export function looksLikeImageTask(task) {
  const s = String(task ?? '');
  if (!s) return false;
  // ① 得是图
  // ⚠️⚠️ 2026-10-19 修（用户：「找两张长沙的**照片**」⇒ 竟然没走搜图，当成普通任务派给 agent 了）——
  //    原来只认「图 / 立绘 / 壁纸 / 插画 / 原画 / 截图 / 表情包」，
  //    **「照片」「相片」「写真」「头像」一个都不认** ✗
  //    而"找几张 XX 的照片"是**最常用**的说法之一（风景、人物、实物都这么说）✗
  //    ⇒ 补上这几个词 ✓
  //    ⚠️ 「帮我修照片」「这张照片拍得怎么样」这种**不是"去找图"**的，靠后面的动词判据挡
  //      （要带 找/搜/弄/来/发/给/扒/挑/下载/收集/翻）——「修」不在里面 ✓
  if (!/[图照相片绘]|壁纸|头像|素材|表情|立绘|海报|封面|画面|写真/.test(s)) return false;
  // ② 得是在"要 / 找"它 —— ⚠️ 2026-10-19 也改成**字根族**（用户：「**关键是动作和要找的东西
  //    同时符合搜图的特征就可以**」）——
  //    原来动作侧是词表（找|搜|弄|来|发|给|扒|挑|下载|收集|翻）⇒ 「**要**几张海报」漏了 ✗
  //    ⇒ 单字族：找 搜 来 给 弄 要 发 挑 扒 收 翻 拿 捞 搞 整 求 下（下载）
  //    ⚠️ 目标侧 + 动作侧**同时命中**才认 ⇒ 「修照片」「照片拍得怎么样」「这图不错」
  //      这些动作侧没有这类字，照样不抢 ✓
  if (!/[找搜来给弄要发挑扒收翻拿捞搞整求下]/.test(s)) return false;
  // ③ 文档 / 代码类的活**不算**（那是「动这一单」的地盘）
  if (/(ppt|pptx|文档|论文|报告|表格|代码|脚本|简历|作业)/i.test(s)) return false;
  return true;
}

/**
 * 「这句是不是在让她去找图 / 照片」—— **模型兜底**（2026-10-19 加）。
 *
 * ⚠️⚠️ 用户原话：「**判据不要太死板了，要写成「图」「图片」之类同义词，
 *    不要做的效果和关键词快判一样**」
 *    背景：先是漏了「照片」（"找两张长沙的照片"被派给 agent 还发了文件），
 *    我补了四个词 —— 用户当场指出**那本质还是词表**，换第 11 个说法又漏 ✗
 *    `looksLikeImageTask()` 现在已改成"字根族"（图/照/相/片/绘 + 几个名词），
 *    但**字根终究还是字**：「给我来点长沙的样子」「搞几张橘子洲的景色」照样漏 ✗
 * ⇒ 字根**没命中**时再问模型一句（小模型、几个 token）：
 *    命中就直接 true（省这次调用），没命中才问 ✓
 *    ⇒ 「换个说法就漏」这件事从根上没了 —— 判的是**意思**，不是字 ✓
 *
 * ⚠️ 这是 async；同步的地方（`bot.js` 的 `looksLikeImageTask` 兜底）照旧用字根版 ✓
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function judgeImageAsk(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 200) return false;
  if (!t) return false;
  if (looksLikeImageTask(t)) return true; // 字根命中 ⇒ 不必花这次调用
  try {
    const llm = await import('./llm.js');
    const ans = await llm.phrase({
      system: [
        '判断他这句话**是不是在让她去找图**（图片 / 照片 / 壁纸 / 立绘 / 截图这类视觉素材）。',
        '',
        '· 是：「找两张长沙的照片」「来点安岛的图」「搞几张橘子洲的景色」「给我弄点壁纸」',
        '  —— 他要的是一张张**图片文件** ✓',
        '· 否：让她做文档 / PPT / 表格 / 写东西、让她**画**一张（那是生图，不是搜图）、',
        '  讨论某张图好不好看、问服务器 / 问账、普通闲聊 ✗',
        '',
        '⚠️ 拿不准就答「否」（判错会白发一堆图）。',
        '只回答一个字：是 或 否。',
      ].join('\n'),
      user: `他说：「${t.slice(0, 150)}」`,
      maxTokens: 8,
      timeoutMs: 6000,
    });
    return /^\s*是/.test(String(ans ?? ''));
  } catch (e) {
    log.debug(`[搜图] 判「是不是要图」失败（当成不是）：${e.message}`);
    return false;
  }
}

/** 任务文件夹里的图片（**跳过 `我的样子/`** —— 那是给她画图用的参考图，不是成果） */
function listImages(dir) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 2) return;
    let items = [];
    try {
      items = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const p = join(d, it.name);
      if (it.isDirectory()) {
        if (it.name === '我的样子') continue; // ⚠️ 她自己的参考图，别当搜图成果发出去
        walk(p, depth + 1);
        continue;
      }
      if (!IMG_RE.test(it.name)) continue;
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.size < MIN_BYTES) continue;
      if (Date.now() - st.mtimeMs < SETTLE_MS) continue;
      out.push({ path: p, name: it.name, size: st.size, mtime: st.mtimeMs, why: '' });
    }
  };
  walk(String(dir), 0);
  return out.sort((a, b) => a.mtime - b.mtime);
}

/**
 * agent **实际下载了哪些**（`预览-<id>` + `candidates.json` → 按收藏数排序）。
 *
 * ⚠️⚠️ 2026-10-19 加（实测）：agent 并不总是照 RULES 写 `挑好的.md` ——
 *    它自己搜 Pixiv、写 `candidates.json`（48 条候选）、下 16 张 `预览-<id>`，
 *    **就是没写清单** ⇒ 原来那条"只发挑过的"读不到东西 ⇒ 运行期一张都不发、只兜底 1 张 ✗
 *
 * 判据：**它肯下载，本来就已经挑过一轮**（48 条里只下 16 张）⇒
 *   把"下载过的那几张"当它的选择，再按 `bookmarks`（人气）排一下，
 *   人气高的先发（同一批图里人气高的通常也更"像样"）✓
 * @param {string} dir 任务文件夹
 * @param {Array<{name:string,path:string,size:number,mtime:number}>} all 已扫描到的图片
 * @returns {Array|null} 挑好的（含 `why` = 作品标题）；没有候选清单就 `null`
 */
function picksFromCandidates(dir, all) {
  const f = join(dir, 'candidates.json');
  if (!existsSync(f)) return null;
  let arr = [];
  try {
    arr = JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || !arr.length) return null;
  const out = [];
  for (const c of arr) {
    const id = String(c?.id ?? '').trim();
    if (!id) continue;
    // 文件名是 `预览-<id>.png` 这种 —— 用 id 去撞（别写死前缀，agent 命名会变）
    const hit = all.find((x) => x.name.includes(id));
    if (!hit) continue;
    out.push({
      ...hit,
      why: String(c?.title ?? '')
        .replace(/[「」“”"]/g, '')
        .slice(0, 60),
      // ⚠️⚠️ 2026-10-19 加（用户截图：**安岛**的图被她认成「高松灯」）——
      //    识图只会描述画面（"两个女孩，生日蛋糕…"），**不会告诉你这是哪个作品** ⇒
      //    她拿自己的 MyGO 知识库去套，套到了同世界观的别人身上 ✗
      //    ⇒ 把作品的**标签**（`アダチとシマムラ` / `安達としまむら` 这种）一起交给她，
      //      她看到作品名就能从**对应那份动画库**里认人 ✓
      tags: (Array.isArray(c?.tags) ? c.tags : [])
        .map((x) => String(x).replace(/_/g, ' '))
        .slice(0, 10)
        .join(' / '),
      bookmarks: Number(c?.bookmarks ?? 0),
    });
  }
  if (!out.length) return null;
  out.sort((a, b) => b.bookmarks - a.bookmarks);
  log.info(`[搜图] 没等到「挑好的.md」⇒ 用它下载过的 ${out.length} 张（按人气排序）`);
  return out;
}

/** 读 agent 挑过的图：先认 `挑好的.md/.txt`，没有就退回"它下载过的"（见上） */
function readPicks(dir, all = []) {
  for (const name of PICK_FILES) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    let txt = '';
    try {
      txt = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    const out = [];
    for (const line of txt.split(/\r?\n/)) {
      // 容忍 `- 搜图-x.png | …` / `1. 搜图-x.png | …` 这种写法
      const t = line.replace(/^\s*(?:[-*+]|\d+[.、)])\s*/, '').trim();
      if (!t || t.startsWith('#') || t.startsWith('|')) continue;
      const parts = t.split('|');
      const fn = String(parts[0] ?? '')
        .replace(/[`「」"']/g, '')
        .trim();
      if (!fn || !IMG_RE.test(fn)) continue;
      out.push({ name: fn, why: parts.slice(1).join('|').trim() });
    }
    if (out.length) {
      // 把清单里的名字对回实际文件（沙盒里可能不在同一个层级）
      const picked = [];
      for (const it of out) {
        const hit = all.find((x) => x.name === it.name);
        if (hit) picked.push({ ...hit, why: it.why });
      }
      if (picked.length) return picked;
    }
  }
  return picksFromCandidates(dir, all);
}

/** aHash 指纹：8×8 灰度，比均值大的记 1 ⇒ 16 个 hex 字符（64 bit） */
async function fingerprint(filePath) {
  try {
    const raw = await sharp(filePath).grayscale().resize(8, 8, { fit: 'fill' }).raw().toBuffer();
    if (!raw.length) return '';
    let sum = 0;
    for (const v of raw) sum += v;
    const avg = sum / raw.length;
    let hex = '';
    for (let i = 0; i < raw.length; i += 4) {
      let nib = 0;
      for (let j = 0; j < 4; j++) nib = (nib << 1) | (raw[i + j] > avg ? 1 : 0);
      hex += nib.toString(16);
    }
    return hex;
  } catch {
    return '';
  }
}

/** 两个指纹差几位 */
function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/** 登记过的搜图任务文件夹（最近 30 个） */
function loadSearchDirs() {
  try {
    const a = JSON.parse(readFileSync(DIRS_FILE, 'utf8'));
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x) : [];
  } catch {
    return [];
  }
}

/** 这次是搜图任务 ⇒ 把它的文件夹登记下来（清理时只认「登记过的」+「`搜图-` 命名」） */
function rememberDir(dir) {
  const d = String(dir ?? '').trim();
  if (!d) return;
  try {
    const list = loadSearchDirs().filter((x) => x !== d);
    list.unshift(d);
    mkdirSync(dirname(DIRS_FILE), { recursive: true });
    writeFileSync(DIRS_FILE, JSON.stringify(list.slice(0, 30)), 'utf8');
  } catch (e) {
    log.debug(`[搜图] 登记目录失败：${e.message}`);
  }
}

function loadSent() {
  try {
    const o = JSON.parse(readFileSync(SENT_FILE, 'utf8'));
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

function saveSent(obj) {
  try {
    const keys = Object.keys(obj);
    if (keys.length > SENT_KEEP) {
      keys.sort((a, b) => (obj[a]?.at ?? 0) - (obj[b]?.at ?? 0));
      for (const k of keys.slice(0, keys.length - SENT_KEEP)) delete obj[k];
    }
    mkdirSync(dirname(SENT_FILE), { recursive: true });
    writeFileSync(SENT_FILE, JSON.stringify(obj), 'utf8');
  } catch (e) {
    log.debug(`[搜图] 记指纹失败：${e.message}`);
  }
}

/**
 * 变成能直接发出去的 `base64://`。
 *
 * ⚠️ 为什么 base64：项目里发图的既有口径就是它（`bot.js` 发表情那段、`test/face.js` 还断言不许用 file://）✓
 * ⚠️ 为什么先压一道：搜来的是几 MB 原图，直接 base64 会给协议端十几 MB；
 *    压到 1600px / JPEG 86 通常只剩 200~400KB，群里照样清楚 ✓
 * ⚠️ 压不动（极少数格式 sharp 不认）⇒ **原样发**，别因为压不了把图丢了 ✗
 */
async function toSendable(filePath) {
  try {
    const buf = await sharp(filePath)
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 86 })
      .toBuffer();
    return `base64://${buf.toString('base64')}`;
  } catch {
    return `base64://${readFileSync(filePath).toString('base64')}`;
  }
}

/**
 * 发一条"只有图"的群消息。
 *
 * ⚠️⚠️ 2026-10-19 修（用户截图：**评论一条条发出来了、图一张都没有**）——
 *    image 段的格式是 `{ type:'image', data: { file: 'base64://…' } }`，
 *    也就是 **`data` 是对象、图放 `file` 里**（见 `bot.js` 的 `imageRef()` 那段）。
 *    我第一版写成 `data: 'base64://…'`（字符串）⇒ 协议端不认 ⇒ 每张都失败，
 *    而评论是**先发**的、所以群里只看到一串"这张给你"✗
 */
async function sendImageMsg(bot, gid, filePath) {
  const ref = await toSendable(filePath);
  // ⚠️ base64 太大就别硬发了（15MB 的原图 base64 之后 20MB，协议端会拒）
  if (ref.length > MAX_IMG_B64) {
    throw new Error(`图太大（base64 ${Math.round(ref.length / 1024 / 1024)}MB）`);
  }
  const payload = {
    group_id: String(gid),
    message: [{ type: 'image', data: { file: ref } }],
  };
  // ⚠️⚠️ 2026-10-19 加（用户：「**752 群搜图这次只发了一张图**」）——
  //    现场日志：第 1 张发了，第 2 张 `调用 send_group_msg 超时`，**一次超时就放弃了** ✗
  //    ⇒ 说 2 张只出 1 张。
  //    图已经压到几百 KB（1600px / JPEG86），30 秒本来不该不够 ⇒ 多半是协议端/网络那一阵子慢。
  //    ⇒ ① 超时放宽到 **60 秒**（`bot.call` 支持 `opts.timeoutMs`）；
  //      ② **失败重试一次**（多花几秒，比少发一张强）✓
  //    ⚠️ 只重试"超时/网络"这一类；「图太大」重试也没用，直接抛 ✓
  let lastErr;
  for (let i = 0; i < 2; i += 1) {
    try {
      return await bot.call('send_group_msg', payload, { timeoutMs: 60000 });
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message ?? '');
      if (/太大/.test(msg)) throw e;
      if (i === 0) {
        log.warn(`[搜图] 这张发送失败（${msg.slice(0, 40)}）⇒ 1.5 秒后重试一次`);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  throw lastErr;
}

/**
 * 自动清理：**只清「搜图」产出的图**，超过 `MAX_CACHE_MB` 就把最早的滚动删掉。
 *
 * ## 用户原话（2026-10-19）
 *   「加一个自动清理吧，所有搜图的文件夹大于 200mb 就清 10 张最早的，**滚动删除**，
 *     防止（清理以后）**不能对比重复图片**」
 *   +「**要分清搜图的文件夹和其他 agent 工作的文件夹**」
 *
 * ## ⚠️⚠️ 为什么必须"分清"（2026-10-19 我自己踩的）
 *   第一版是**扫整个 workspace** 的图片 —— 一统计吓一跳：
 *   `私聊/` 一个文件夹就 2437MB，里面是**用户真正的活**（`实训项目.zip` 158MB、
 *   `零件缺陷检测/weights/best.pth` 74MB、`last.pth` 222MB…）。
 *   照那版跑，200MB 阈值一触发就会**把用户的实训项目和模型权重当"缓存"删掉** ✗✗
 *   ⇒ 范围收窄成**只有搜图的图**：
 *     · 在 `state/__image-search-dirs.json` 里登记过的**搜图任务文件夹**里的图；
 *     · 兜底：名字以 `搜图-` 开头的（RULES 规定的命名，覆盖登记之前的历史）。
 *   `私聊/`、PPT、论文、模型权重、`_残留/` **一个字节都不碰** ✓
 *
 * ## 两条底线（**别改**）
 *   ① ⚠️⚠️ **只删图片文件，绝不碰 `state/__image-search-sent.json`** ——
 *      去重靠的是**那张指纹表**（aHash），它跟图片文件是分开存的；
 *      删了原图**照样能认出"这张以前发过"** ✓（这正是用户担心的那点）
 *   ② 🚫 **`我的样子/` 里的参考图不删** —— 那是给人设画图用的 ✗
 *
 * ## 怎么删
 *   · 每次只删 `batch` 张（用户的"10 张"），删完再看总量，还超就**接着删下一批** —— 这就是"滚动"；
 *   · 按 **mtime 最早**先删；一次最多删 `MAX_DELETE` 张；正在跑的任务文件夹跳过（`keepDir`）。
 *
 * @param {{maxMB?:number, batch?:number, keepDir?:string}} opts
 */
export function sweepImageCache({ maxMB = MAX_CACHE_MB, batch = 10, keepDir = '' } = {}) {
  const root = (() => {
    try {
      return String(workspace() ?? '');
    } catch {
      return '';
    }
  })();
  if (!root || !existsSync(root)) return { totalMB: 0, removed: 0, freedMB: 0 };

  const searchDirs = new Set(loadSearchDirs());
  const imgs = [];
  let total = 0;
  const keep = String(keepDir ?? '').replace(/[\\/]+$/, '');
  const walk = (d, depth, inSearch) => {
    // ⚠️⚠️ 2026-10-19 改（用户：「**把在群里开的任务都收到一个文件夹里**」，同时提醒「不要影响到自动清理」）：
    //    群任务从 `agentwork/<任务文件夹>` 挪进了 `agentwork/群任务/<任务文件夹>` —— **多了一层** ✗
    //    这里原来是 `depth > 3`，多一层之后最深那几层的图就**扫不到**了
    //    （扫不到 ⇒ 不计入总量 ⇒ 永远清不掉 ⇒ 缓存会一直涨）⇒ 放宽到 4 ✓
    if (depth > 4) return;
    // ⚠️ 目录本身登记过（或上级登记过）⇒ 这棵子树里的图都算"搜图产物"
    const search = inSearch || searchDirs.has(d);
    let items = [];
    try {
      items = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const p = join(d, it.name);
      if (it.isDirectory()) {
        if (it.name === '我的样子') continue; // 🚫 人设参考图，不许删
        walk(p, depth + 1, search);
        continue;
      }
      if (!IMG_RE.test(it.name)) continue;
      // 🚫🚫 **不是搜图的图，一律不管**（用户的实训 zip / 模型权重 / 私聊截图都在这儿）
      if (!search && !it.name.startsWith('搜图-')) continue;
      if (keep && (p === keep || p.startsWith(keep + '\\') || p.startsWith(keep + '/'))) continue;
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      imgs.push({ path: p, size: st.size, mtime: st.mtimeMs });
      total += st.size;
    }
  };
  walk(root, 0, false);

  const totalMB = total / 1024 / 1024;
  if (totalMB <= maxMB) return { totalMB: Math.round(totalMB), removed: 0, freedMB: 0 };

  imgs.sort((a, b) => a.mtime - b.mtime); // 最老的先走
  let removed = 0;
  let freed = 0;
  let i = 0;
  while (total / 1024 / 1024 > maxMB && i < imgs.length && removed < MAX_DELETE) {
    let n = 0;
    while (i < imgs.length && n < batch && removed < MAX_DELETE) {
      const it = imgs[i++];
      try {
        unlinkSync(it.path);
        total -= it.size;
        freed += it.size;
        removed++;
        n++;
      } catch {
        /* 删不掉就跳过（可能正被别的进程读写）*/
      }
    }
    if (n === 0) break; // 一整批都没删掉 ⇒ 别再空转了
  }

  if (removed) {
    log.info(
      `[搜图] 图片缓存清了 ${removed} 张（最早的一批），腾出 ${Math.round(freed / 1024 / 1024)}MB；` +
        `现在约 ${Math.round(total / 1024 / 1024)}MB（阈值 ${maxMB}MB）`,
    );
  }
  return { totalMB: Math.round(total / 1024 / 1024), removed, freedMB: Math.round(freed / 1024 / 1024) };
}

/**
 * 起一次「搜图」。
 * ⚠️ **同步返回**（调用方不许 await）—— 和 `startRun()` 一样，这活要跑一两分钟 ✗
 *
 * @param {{bot:object, gid:string, by:string, byName:string, task:string}} p
 * @returns {{stop:Function}} 想提前收手就调 `.stop()`
 */
/*
 * ⚠️⚠️ 2026-10-19 加：**这个群现在有没有搜图在跑**。
 *
 * 为什么需要它（用户截图抓到）：搜图途中她冒出「翻了几下，还没找着几个像样的，再给我两分钟」
 * —— 那就是**阶段话**，用户早说过「搜图工具中不要发，只发开始搜图的话 + 图片 + 评论」✗
 * 真因：「半句话补完」那边只挡了 `agentBridge.runningMode() === 'image'`，
 *   可**搜图根本不走 `startRun`** ⇒ 那个 mode 永远是空的 ⇒ 拦不住 ✗
 * ⇒ 搜图自己记一笔「我在跑」，让那边也能看见 ✓
 */
const busyMap = new Map();

/** @param {string} gid @returns {boolean} */
export function busy(gid) {
  return (busyMap.get(String(gid ?? '')) ?? 0) > 0;
}

/**
 * 给 **agent** 的搜图任务文本（2026-10-19 抽出来，为了能离线测）。
 *
 * ## 用户原话（这一条是这个函数存在的理由）
 *   「**要让 agent 也一张一张发，并且要符合描述且质量高，
 *     然后要接收到我这边说的搜图数量**」
 *
 * ## 真事故（为什么要写这些规则）
 *   原来只给它一句「搜「XX」的图，挑出几张好的发到群里」，**一条规则都没给** ⇒ 它自由发挥：
 *     · 先把 48 条候选攒成 `candidates.json`，**再**一口气扒 17 张
 *     · 好几张 4~10MB 的 PNG
 *   ⇒ 前两三分钟文件夹空的 ⇒ `tick`（每 3 秒扫一次）没东西可发
 *   ⇒ 699 群那次**从开搜到第一张用了 3 分 18 秒**；752 群那次 1 分 24 秒（因为它下得少）✗
 *   ⚠️ 发送端（`tick`）**早就**是"下一张发一张"了（见那边注释）——
 *      卡住的是**上游下得慢、下得多** ✗
 *
 * ⚠️ 第 1 条是**用户点名要的**：「接收到我这边说的搜图数量」= 说 2 张就只下 2 张，
 *    不是"下 17 张然后发 2 张" ✗
 * @param {string} task 原始任务（「搜「XX」的图…」）
 * @param {number} cap 这次要几张（已经算好：说了数字就用数字，没说就 3~5 随机）
 */
export function imageAgentTask(task, cap) {
  const n = Math.max(1, Math.floor(Number(cap) || 1));
  return (
    `${task}\n` +
    '⚠️ 这条活的**硬规则**（照做，别自由发挥）：\n' +
    `1. **只要 ${n} 张**：够数就停。🚫 别一口气扒十几张、别"多下几张备着" —— 每张都是原图，很慢 ✗\n` +
    '2. **边搜边下、下一张算一张**：🚫 **别先攒一张候选清单再统一下载**' +
    '（那样前几分钟文件夹是空的，群里那边一直在等）—— 找到一张合的就**立刻下到当前文件夹** ✓\n' +
    '3. **必须符合描述**：作品 / 角色对不上的一律不要，认不准就换一张，🚫 别拿"有点像"的凑数 ✗\n' +
    '4. **要高清**：下原图（宽度 ≥ 1000）；缩略图 / 带大字水印 / 糊掉的不要 ✗\n' +
    '5. 🚫 **不用写任何清单文件**（`挑好的.md` / `candidates.json` 都不用）——' +
    '   下到文件夹里的就是挑好的，有人盯着这个文件夹**直接发** ✓\n' +
    '6. 文件名统一 `搜图-<作品或角色>-<序号>.jpg`，别用奇怪的符号 ✓'
  );
}
export function startImageSearch({ bot, gid, by, byName, task, reuseDir = '', max = 0 }) {
  // ⚠️ 记一笔「这个群在搜图」（收尾时 `release()` 减掉；见 `stopWatch`）✓
  const gidKey = String(gid ?? '');
  busyMap.set(gidKey, (busyMap.get(gidKey) ?? 0) + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const n = (busyMap.get(gidKey) ?? 1) - 1;
    if (n > 0) busyMap.set(gidKey, n);
    else busyMap.delete(gidKey);
  };
  // ⚠️⚠️ 2026-10-19 加（用户：「**找一张 / 拿两张 / 搜三张 XX 图** ⇒ 要**真的一共发那么多张**；
  //    如果是「发几张」的话，数量还是和之前一样**随机**」）
  //    · 说准了张数（`max` 或他的话里带「N 张」）⇒ **就发那么多张**（1~10，硬上限 MAX_IMAGES）；
  //    · 没指定（"几张"/"来点"）⇒ **3~5 张随机**（之前一直是固定的 4 张）✓
  const want = Number(max) > 0 ? Math.floor(Number(max)) : countFromTask(task);
  const cap = want > 0 ? Math.min(MAX_IMAGES, want) : 3 + Math.floor(Math.random() * 3);
  log.info(`[搜图] 这次发 ${cap} 张${want > 0 ? `（他说了要 ${want} 张）` : '（他没说张数 ⇒ 3~5 随机）'}`);
  const sentLib = loadSent();
  const tried = new Set(); // 这一轮试过的（发过 / 撞过 / 发失败的都算，别反复试）
  let sentCount = 0;
  let closed = false;
  let timer = null;

  const stopWatch = () => {
    closed = true;
    release(); // 搜图结束 ⇒ 这个群不再算在搜图（半句话那边恢复）
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  // ⚠️ 开搜之前先清一次图片缓存（用户要求：超过 200MB 就滚动删最早的）——
  //    ⚠️ 只删图片文件，**指纹表 `__image-search-sent.json` 不动** ⇒
  //       清完照样能对比出"这张以前发过"，去重不受影响 ✓
  try {
    sweepImageCache();
  } catch (e) {
    log.debug(`[搜图] 清理缓存失败：${e.message}`);
  }

  // ⚠️ `startRun()` 里 `state.running.dir` 是**同步**赋值完才走到第一个 await，
  //    所以函数一返回就读，这时候已经在了 ✓（不用每轮都去问）
  // ⚠️⚠️⚠️ 2026-10-19 加（用户：「**要让 agent 也一张一张发，并且要符合描述且质量高，
  //    然后要接收到我这边说的搜图数量**」）——
  //    真因：`startRun()` 原来只拿到一句「搜「XX」的图，挑出几张好的发到群里」，
  //    **一条搜图规则都没给** ⇒ agent 自己发挥：
  //      · 先把 48 条候选攒成一个 `candidates.json`，**再**一口气扒 17 张
  //      · 好些是 4~10MB 的 PNG
  //    ⇒ 前两三分钟文件夹是空的、`tick` 没东西可发
  //      ⇒ 699 群那次**从开搜到第一张用了 3 分 18 秒**（752 群那次 1 分 24 秒，因为它下得少）✗
  //    ⚠️ `tick()` 那边**早就**做到"下一张发一张"了（见那边的注释）——
  //       卡住的是**上游下得慢、下得多**，不是发送端 ✗
  //    ⇒ 把规则写进它的任务里（`task` 会原样进它的提示词）✓
  const agentTask = imageAgentTask(task, cap);
  const p = startRun({ bot, gid, by, byName, task: agentTask, related: true, reuseDir, mode: 'image' });
  const dir = runningDir();
  log.info(`[搜图] 开搜：${String(task).slice(0, 40)}｜文件夹=${dir ? dir.split(/[\\/]/).pop() : '（没拿到）'}`);
  rememberDir(dir); // ⚠️ 登记一下：清理时**只认这些文件夹**（私聊产物 / 模型权重一个不碰）

  /**
   * 扫一轮。
   * @param {boolean} final 任务已经结束（最后一轮）—— 没清单时**只在这时**兜底发 1 张
   */
  const tick = async (final = false) => {
    if (closed || sentCount >= cap) return;
    if (!dir) return;
    const all = listImages(dir);
    if (!all.length) return;

    // ⚠️⚠️ 2026-10-19 改（用户：「**有一张符合条件的就立刻发出来，不是到最后一次全发出来**」）——
    //    原来没有清单就 `return`（一直等到任务结束才发）⇒ 而 agent 的
    //    `candidates.json` / `挑好的.md` 往往**最后**才写出来 ⇒ 群里就成了"最后一口气全倒"✗
    //    ⇒ 现在**不等清单**：agent 肯把这张下下来，本身就是它挑过了
    //      （实测它 48 条候选只下 16 张 ✓）——**下载完一张就发一张** ✓
    //      有清单就按清单 / 人气排，没有就按它下载的先后（`all` 已按 mtime 升序）✓
    const picks = readPicks(dir, all);
    const cands = picks && picks.length ? picks : all;
    if (!cands.length) return;
    void final;

    for (const it of cands) {
      if (closed || sentCount >= cap) return;
      if (tried.has(it.path)) continue;
      tried.add(it.path);

      // ⭐ 跨次去重：这张以前发过就别再发了（换了尺寸/重压过也认得出）
      const fp = await fingerprint(it.path);
      if (fp) {
        const dup = Object.keys(sentLib).find((k) => hamming(k, fp) <= DUP_DISTANCE);
        if (dup) {
          log.info(`[搜图] 这张以前发过（${it.name} ≈ ${sentLib[dup]?.name ?? '?'}）⇒ 跳过`);
          continue;
        }
      }

      try {
        // ⚠️⚠️ 2026-10-19 改（用户截图：**评论发了 5 条、图一张没有**）——
        //    原来是"先说话、再发图"：图一发失败，群里就只剩一串"这张给你"✗
        //    ⇒ 现在**先发图，成功之后再说那句**（图发不出去就不吭声）✓
        await sendImageMsg(bot, gid, it.path);
        // ⚠️⚠️ 2026-10-19 改（用户截图：一串「给，这张最好看」「这张你肯定喜欢」「这张你看」——
        //    「这种话太多了，我要的是**她自己的评论要多一点**」）：
        //    真因是**她压根没看到图** —— 原来只给她一个作品标题 ⇒ 她只能"把图递过去"✗
        //    ⇒ 现在发图前先**识图**，把"图里是什么"当素材交给她，
        //      让她说**自己对这张的看法**（哪里好看 / 喜不喜欢 / 想到什么）✓
        const desc = String(
          (await describeImage(it.path, { maxBytes: 2 * 1024 * 1024 }).catch(() => '')) ?? '',
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 420);
        const facts =
          '你要把一张图发到群里给他看。' +
          (desc ? `这张图里是：${desc}\n` : '') +
          (it.why ? `（出处/标题：${it.why}）\n` : '') +
          // ⚠️⚠️ 2026-10-19 加（用户截图：**安岛**的图被她认成「高松灯」）——
          //    识图只说画面、不知道作品；她拿自己的知识库硬套 ⇒ 套到同世界观的别人头上 ✗
          //    ⇒ ① 作品标签给她（她就能去**对应那份动画库**里认人）；
          //      ② **认不准就别硬认**（认错人比不认人难看得多）✓
          (it.tags ? `（它的作品/标签：${it.tags}）\n` : '') +
          '⚠️⚠️ **认人规矩**：图里是谁，**只按"作品/标签"对得上的那份资料来认**；' +
          '拿不准是谁就**别硬认**（说"这俩人"、"图里这个"都行）——' +
          '🚫 **绝对不许**把别的作品/别的角色往上套（认错人比不认人难看得多）✗\n' +
          '⚠️ 用**你自己的说话方式**说**一两句**：**你怎么看这张** —— ' +
          '哪里好看、你喜不喜欢、让你想到什么，说完顺手递给他看。' +
          '⚠️ **按你自己的性格来说**：图里要是**你自己或你认识的人**，就说你**真会有的反应**' +
          '（害羞 / 嘴硬 / 得意 / 吐槽 / 别扭，都行）；🚫 别装成不认识的旁观者，也别用客套话。' +
          '🚫 只说"这张你看 / 给你 / 这张不错 / 这张你肯定喜欢"这种**递图的话**不行（太敷衍、像客服）；' +
          '🚫 别提"搜图""搜索""文件""图片""文件夹"，也别说什么第几张。';
        const line = String(
          (await voiceize('result', facts, { task, gid, timeoutMs: 12000 }).catch(() => '')) ?? '',
        ).trim();
        if (line) await bot.sendToGroup(gid, line);
        sentCount++;
        if (fp) {
          sentLib[fp] = { at: Date.now(), name: it.name, gid: String(gid) };
          saveSent(sentLib);
        }
        log.info(`[搜图] 已发第 ${sentCount} 张：${it.name}（${Math.round(it.size / 1024)}KB）`);
      } catch (e) {
        // ⚠️⚠️ 2026-10-19 加（用户：「**752 群搜图这次只发了一张图**」）——
        //    原来失败之后**这张就一直算"试过了"**（`tried.add()` 在循环开头就记了）⇒
        //    下轮 `tick` 直接跳过它 ⇒ 说 2 张只出 1 张，永远补不回来 ✗
        //    ⇒ 发失败就把它**从 tried 里摘掉**，让下一次 tick 再试 ✓
        //      （`sentCount` 没加，配额还在；`sendImageMsg()` 内部已经重试过一次了）
        tried.delete(it.path);
        log.warn(`[搜图] 这一张没发成（${it.name}）：${e.message}（下一轮再试）`);
      }
    }
  };

  // 任务跑完（成功 / 失败 / 被她叫停）⇒ **最后再扫一遍收尾**，然后停监视
  p.catch((e) => log.warn(`[搜图] 任务出错：${e.message}`)).finally(() => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    void tick(true)
      .catch(() => {})
      .finally(stopWatch);
  });

  // ⚠️⚠️ 2026-10-19 修（实测：一次性发了 **6 张**，而上限是 4）——
  //    `tick` 每 3 秒触发一次，但里面每张都要等 `voiceize`（模型说那句，几秒）⇒
  //    **多个 tick 会同时跑**，各自看到 `sentCount` 还没到上限 ⇒ 一起发 ⇒ 超发 ✗
  //    ⇒ 这里加一道**防重入**：上一轮没跑完，这一轮直接跳过 ✓
  let ticking = false;
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void tick(false)
      .catch(() => {})
      .finally(() => {
        ticking = false;
      });
  }, TICK_MS);
  // ⚠️ 别让这个定时器把 node 钉住（机器人退出时它得能走）
  if (timer && typeof timer.unref === 'function') timer.unref();

  return { stop: stopWatch };
}