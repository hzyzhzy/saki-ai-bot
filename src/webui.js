/**
 * 本地图形化管理界面。
 *
 * 只监听 127.0.0.1，不做登录（本机使用）。可以：
 *   - 改模型 / API Key / baseURL，并当场测试连通性
 *   - 改机器人能在哪些群说话、谁能教它、要不要 @
 *   - 管理表情包（上传图片、写标签和适用场合、删除）
 *   - 看机器人学到了什么
 *   - 改完热重载，不用重启机器人
 */
import { createServer } from 'node:http';
import { Agent, fetch as undiciFetch } from 'undici';

/**
 * ⚠️⚠️ 2026-10-17 修的真 bug（用户截图：「**主号/谷雨/爱音 显示没在跑**」+「读不到数据」）——
 *
 * **本机（127.0.0.1）的请求绝不能走代理** ✗
 *
 * 因果链：`_run-bot.bat` 里写死了 `HTTPS_PROXY=127.0.0.1:7890` ⇒ `llm.js` 的
 * `applyEgress()` 把 **undici 的全局 dispatcher** 换成了 `ProxyAgent` ⇒
 * 而 node 的**内置 `fetch` 也是 undici** ⇒ 它跟着走代理 ⇒
 * 于是 `http://127.0.0.1:3101/...` 这种**本机**请求被丢给 Clash ⇒ 打不到 ⇒ 失败 ✗
 *
 * 症状（全是这一条引起的）：
 *   · 号列表里别的号一直显示「**没在跑**」（探活 fetch 失败）
 *   · 在一个号的界面看**别的号**的页面 ⇒ 转发失败 ⇒ **空响应** ⇒
 *     前端报 `Unexpected end of JSON input` / `Failed to execute 'json' on 'Response'` ✗
 *
 * ⇒ 本机请求统一走这个 `localFetch`（**显式直连 Agent**）✓
 *   ⚠️ 必须用 **undici 自己的 `fetch`**：内置 fetch 不认这里传的 `dispatcher` ✗
 *     （见 `src/llm.js` 顶部那段踩坑记录）
 */
const localAgent = new Agent();
const localFetch = (url, opts = {}) => undiciFetch(url, { ...opts, dispatcher: localAgent });
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync, statSync, copyFileSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import yaml from 'js-yaml';

import { config, reloadConfig, validate, ROOT, CONFIG_FILE, KNOWLEDGE_DIR, paramsFor, personaDir, personaId, ACCOUNT, SHARED_SECTIONS } from './config.js';
// ⚠️ 2026-10-07 多 QQ 号：账号目录（`accounts/<QQ>.yml`）的读写都走它。
//    ⚠️ 这个文件导入它**不构成环** —— `accounts.js` 只依赖 node 内建 + js-yaml。
import * as accounts from './accounts.js';
// ⚠️ 2026-10-07 加：「机器人池」自动同步（同类池互相加、不同类池复用）——
//    见 `src/pools.js` 顶部那段说明。
import * as pools from './pools.js';
import { log } from './log.js';
// ⚠️ 2026-10-09：`llmFetch` 一起引进来 —— "拉取模型列表"要**走代理**（见下面 `/api/models` 那段）
import { ping, llmFetch } from './llm.js';
// 生图（群里说的「拍个照」）—— 界面上的「测试生图」用它，见下面 /api/imagegen/test
import * as imagegen from './imagegen.js';
// 「这次拍什么」—— 单独跑一次模型理解（见 src/photo-plan.js 文件头）
import * as photoPlan from './photo-plan.js';
// 「她此刻在哪、在做什么」—— 时间/地点的事实来源。
// ⚠️ 用 `whereNow()`（它会把"她说过的话"和日程做一致性检查），**不要**直接用
//    `whereAmI()` —— 那个返回的是对象，而且不做冲突检查（2026-09-22 踩过）。
// ⚠️ webui 和 bot 在**同一个进程**里，而 bot.js 不 import webui.js，所以方向不成环。
import { whereNow } from './bot.js';
import { queryServer, describe, clearCache } from './status.js';
import * as napcat from './napcat.js';
// ⚠️ 协议端适配层（2026-09-17 加）：管理面按它分派，换协议端只改 config.yml
import * as provider from './provider.js';
// ⚠️ 2026-10-07 加（多 QQ 号）：**协议端那边的"多账号"** —— 给每个号开一个
//    OneBot WebSocket 端口（改 SnowLuma 的 `config/onebot_<QQ>.json` + 重启它）。
import * as providerAccounts from './provider-accounts.js';
// ⚠️ 2026-09-20 加：LLBot 的「登录状态 / 二维码」适配（形状和 `napcat.js` 一致，
//    所以下面那段二维码路由两边通用 —— 用户要求"二维码要和之前一样能自动刷新"）。
import * as llbot from './llbot.js';
// ⚠️ 开机自启（2026-09-17 加）：写注册表 Run 键，界面上开/关
import * as autostart from './autostart.js';
import * as cleanup from './cleanup.js';
import { backupKnowledge } from './backup.js';
import { listUnannotated, annotateAll } from './face-annotate.js';
// 二维码画图（纯 JS，无原生依赖）
import QR from 'qrcode';
import { listEntries } from './learned.js';
import { faceTags, reload as reloadFaces } from './faces.js';
import { hasKnowledge, reloadKnowledge, knowledgeText } from './knowledge.js';
import * as life from './life.js';
// ⚠️ 2026-10-05 加：同类机器人搭话（「立刻试一次」那个按钮要用它的 compose / pickPeer）
import * as peerChat from './peer-chat.js';
import * as persona from './persona.js';
import * as personaAdmin from './persona-admin.js';
import * as personaDraft from './persona-draft.js';
import * as quest from './quest.js';
// ⚠️ 故事线（**每个群一份**）—— 2026-09-15 加的故事线卡片要用
import * as storyline from './storyline.js';
import * as friend from './friend.js';
import * as affinity from './affinity.js';
import * as names from './names.js';
import { streamChat } from './llm.js';
// ⚠️ `learned.md` 的格式校验 —— 它由代码解析维护，界面上直接改必须过这一关
import { validateFile as learnedValidate } from './learned.js';
import * as qzone from './qzone.js';
import * as qzoneCompose from './qzone-compose.js';

/** 由 index.js 传进来，QQ空间那几个接口需要它来调 NapCat */
let bot = null;

// ── 二级剧情的：调模型 / 模拟沙箱 ─────────────────────────────
//
// ⚠️⚠️ 模拟测试必须**完全隔离**（2026-09-15）：
//    不落盘、不碰真实 quest 状态、不写真实故事线、不发消息。
//    否则你在界面上跑一次模拟，机器人真的会往群里发一条剧情 —— 那就闯祸了。
//
// 隔离靠两件事，缺一不可：
//   ① `quest.setSandbox(true)` → 落盘变 no-op、故事线改成"收集起来"
//   ② `quest.swapState({...空})` → 真实剧情状态被换走，模拟跑在一次性状态上
//   ⚠️ 必须 `finally` 恢复：中间抛错也得退出来，
//      否则机器人会一直停在沙箱里（不落盘、不写故事线），那是最糟的失败模式。

/** 用真模型跑一次（把流式输出收成一段文本）
 *
 *  ⚠️⚠️ 2026-09-18 修（用户报「**剧情模拟的开始等待时间太久**」）：
 *    原来就是一个裸的 `streamChat(messages)` —— **思考链是开着的**，
 *    跟压缩故事线那次是同一个病：flash 的思考链**计入 completion_tokens**，
 *    开着它这里要白等几十秒（实测"开始→出第一段"就是一分钟上下），
 *    还可能把 8000 token 吃光、正文写不完。
 *    剧情生成是"照着设定和素材写一段"，**不需要深推理** → 关掉。
 */
async function llmAsk(messages) {
  let out = '';
  for await (const d of streamChat(messages, undefined, {
    maxTokens: 16000,
    timeoutMs: 150000,
    thinking: { type: 'disabled' },
  })) {
    out += d;
  }
  return out;
}

const sim = { quest: null, log: [], story: [], note: '', ended: null };

function simReset() {
  sim.quest = null;
  sim.log = [];
  sim.story = [];
  sim.note = '';
  sim.ended = null;
}

function simSnapshot() {
  return {
    running: !!sim.quest && !sim.quest.endedAt,
    premise: sim.quest?.premise ?? '',
    stage: sim.quest?.stageIndex ?? 0,
    plannedStages: sim.quest?.plannedStages ?? 0,
    /** 界面上那句"群友+祥子"的对话流 */
    transcript: sim.log,
    /** ★ 这次模拟写下的**全部**故事线（用户要求展示） */
    story: sim.story,
    ended: sim.ended,
  };
}

/**
 * 在沙箱里跑一段（跑完把真实状态和沙箱都恢复，并把故事线收集起来）。
 *
 * ⚠️⚠️ 沙箱是**全局开关**（`quest.setSandbox`），所以**绝不允许两个请求重叠**。
 *
 *    踩过的真 bug（2026-09-15，<主人> 发现「没发到群里却写进了故事线」）：
 *      ```
 *      请求A：swapState → setSandbox(true) → 等模型…（几秒）
 *      请求B：swapState → setSandbox(true) → 等模型…
 *      A 先回来 → setSandbox(prevA = null) → ★ 沙箱被关掉了
 *      B 还在跑 → 它的 save() 已经不在沙箱里 → **写进真实的 state/quest.json** ❌
 *      ```
 *      证据就摆在 `state/quest.json` 里：一条 `群='(模拟)'`、`结束原因='forced-bad'`
 *      的剧情 —— 那是**模拟面板**跑出来的，却落进了真实状态。
 *
 *    所以 `simBusy` 这道锁**不是优化，是正确性的一部分**：必须串行。
 */
let simBusy = false;

async function withSandbox(fn) {
  if (simBusy) throw new Error('上一次模拟还在跑 —— 等它出结果再点（别连点）');
  simBusy = true;
  const oldState = quest.swapState({ current: null, recent: [], starts: [], nextHint: '' });
  const off = quest.setSandbox(true);
  try {
    return await fn();
  } finally {
    const collected = quest.sandboxLog();
    if (collected.length) sim.story = sim.story.concat(collected);
    quest.setSandbox(off);
    quest.swapState(oldState);
    simBusy = false;
  }
}

/** 模拟现在忙不忙（给界面显示 + 防重复点） */
export function simIsBusy() {
  return simBusy;
}

/**
 * ⚠️ **测试专用**：把沙箱跑法暴露出去，好让测试能**真的并发调两次**、
 *    验证第二发会被拒绝。
 *
 *    ⚠️ 为什么必须要真并发：那个 bug 本身就是并发引起的 ——
 *      只断言"代码里有 `simBusy` 这几个字"**拦不住回归**。
 */
export function __withSandboxForTest(fn) {
  return withSandbox(fn);
}


const LIB = join(ROOT, 'library');
const KNOW = KNOWLEDGE_DIR;

/**
 * 知识文件的真实路径：**人设包优先，其次共用库**（2026-09-21 加）。
 *
 * ⚠️ 人设的 md（`persona.md` / `persona-money.md` / `persona-media.md` / `voices.md`…）
 *    搬到了 `personas/<id>/`，理由见 `knowledge.js` 里那段注释。
 * ⚠️ 判据是「**这个文件在人设包里存不存在**」，不是按文件名硬编码 ——
 *    这样人设包以后多出什么文件，界面自动就能编辑，不用改代码。
 * ⚠️ `personaDir()` 从 `knowledge.js` 拿 —— **别在这儿再实现一遍**（两份逻辑会漂移，
 *    那种 bug 最难查：界面上看到的是 A 文件，机器人加载的是 B 文件）。
 */
function knowPath(name) {
  const p = join(personaDir(), name);
  return existsSync(p) ? p : join(KNOW, name);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const MAX_UPLOAD = 8 * 1024 * 1024; // 8MB

function send(res, code, body, type = 'application/json; charset=utf-8') {
  // ⚠️⚠️ 2026-09-17 修的真 bug（用户报「表情列表**不能预览**，没法填信息」）：
  //    **Buffer 不能再走 `JSON.stringify`** —— 那会把图片变成
  //    `{"type":"Buffer","data":[255,216,255,…]}` 这种 JSON 文本：
  //    状态码 200、Content-Type 也对，但浏览器解不出图 → **整页破图**。
  //    实测（同一个文件）：磁盘 80461 字节，服务端发出去 287477 字节 —— 就是这个。
  //    `serveStatic()` 正是用 `send()` 发图片的，所以这里兜住（别指望调用方都记得用 sendBinary）。
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    return sendBinary(res, code, body, type);
  }
  // ⚠️⚠️ 2026-10-17 加固（用户截图：某个页面报「读不到… 原始报错：Unexpected end of JSON input」）——
  //    真因是这里可能发出去一个**空 body**：
  //      · `JSON.stringify(undefined)` **不抛错、返回 undefined** ⇒ `res.end(undefined)`
  //        ⇒ 状态 200 + **零字节** ⇒ 前端 `res.json()` 报 `Unexpected end of JSON input` ✗✗
  //      · 对象里有**循环引用 / BigInt** 时 `stringify` 会抛 ⇒ 也在这一行炸 ✗
  //    ⇒ 现在：**序列化失败也绝不发空 body** —— 一律发一个合法 JSON + 把真因写日志 ✓
  let payload;
  try {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  } catch (e) {
    log.error(`管理界面响应序列化失败（${String(code)}）：${e.message}`);
    payload = JSON.stringify({ ok: false, error: `服务端拼响应失败：${e.message}` });
  }
  if (payload === undefined || payload === null || payload === '') {
    log.error(`管理界面响应是空的（${String(code)}）⇒ 兜一个合法 JSON，别让前端报 JSON 解析错`);
    payload = JSON.stringify({ ok: false, error: '服务端这次没拼出响应（内容为空）' });
  }
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(payload);
}

/** 发二进制（图片这类） */
function sendBinary(res, code, buf, type = 'application/octet-stream') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(buf);
}

/**
 * 知识文件名的安全校验（2026-09-15 晚改）。
 *
 * ⚠️ 原来只认**单层**文件名（`basename(name)` + `/^[\w.\-]+\.md$/`）——
 *    知识分群之后多了 `groups/<群号>.md` 这一层，用 `basename` 会被削成
 *    `200000006.md`（写到知识库根目录去了 ✗）。
 *    现在允许**恰好一层 `groups/`**，其余照旧只认安全字符，并且**挡掉 `..`**。
 *
 * @returns {string} 规范化后的相对路径（非法就返回 ''）
 */
function safeKnowName(raw) {
  const s = String(raw ?? '').trim().replace(/\\/g, '/');
  if (s.includes('..')) return '';
  const m = s.match(/^(?:groups\/)?([\w.\-]+\.md)$/);
  if (!m) return '';
  // 群资料库那层只允许 `groups/<群号>.md`（群号是数字）
  if (s.startsWith('groups/') && !/^groups\/\d+\.md$/.test(s)) return '';
  return s;
}

function readBody(req, limit = MAX_UPLOAD) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 读 JSON 请求体（2026-10-22 加：B站投稿设置页用它） */
async function readJson(req) {
  const buf = await readBody(req, 2 * 1024 * 1024);
  const s = buf.toString('utf8').trim();
  if (!s) return {};
  return JSON.parse(s);
}

// ── 配置：读写 ────────────────────────────────────────

/** 只保留界面关心的字段，避免把运行时状态写回文件 */
function configForUi() {
  return {
    llm: { ...config.llm },
    // ⚠️ 和 saveConfig 里那行 `put('imagegen', …)` 是**一对**，别只加一个
    //    （这个文件里"存得进去、显示不出来"的坑踩过一次，见下面 `chat` 那段注释）。
    imagegen: { ...config.imagegen },
    onebot: { ...config.onebot },
    trigger: { ...config.trigger },
    context: { ...config.context },
    qzone: { ...config.qzone },
    status: { ...config.status },
    teach: { ...config.teach },
    chunking: { ...config.chunking },
    webui: { ...config.webui },
    // ⚠️⚠️ 2026-09-13 修的真 bug：**原来这里漏了 chat** ——
    //    于是界面上「① 档收紧度」滑块永远读不到值，每次都回到默认 50，
    //    用户以为"保存没生效"（其实 saveConfig 已经写进 yaml 了，只是读不回来）。
    //    真实反馈：「webui显示没变化」「webui没有保存刚才的设置」。
    //    ⚠️ 以后往 saveConfig 的 put() 里加新段，**记得这里也要加** ——
    //       两处不同步就会变成"存得进去、显示不出来"这种诡异 bug。
    chat: { ...config.chat },
    attitude: { ...config.attitude },
    faces: { ...config.faces },
    life: { ...config.life },
    quest: { ...config.quest },
    affinity: { ...config.affinity },
    friend: { ...config.friend },
    // ⚠️ 分群参数（按群覆盖）—— 界面上「按群设定」那张表读它。
    //    和 `saveConfig` 里那行 `put('groupParams', …)` 是**一对**，别只加一个
    //    （这个文件里"存得进去、显示不出来"的坑踩过一次，见上面 `chat` 那段注释）。
    groupParams: JSON.parse(JSON.stringify(config.groupParams ?? {})),
    ownerQQ: config.ownerQQ,
    /** 机器人自己的号（用来做快速登录、页面上显示） */
    botQQ: config.botQQ,
    logLevel: config.logLevel,
  };
}

/**
 * ⚠️ 2026-10-07 多 QQ 号：**拆分** —— 把 `config.yml` 里属于"这个号"的设置
 * 搬进 `accounts/<QQ>.yml`，config.yml 只留共用的那些。
 *
 * 为什么必须做：老配置里"私有段"和"共用段"是混在一份文件里的。
 * 不拆的话，**新加的号会莫名继承主号的一切**（群列表、灵敏度、按群设定、剧情参数…）——
 * 表现是"我刚加了个号，它怎么认识我主号那些群"。
 *
 * ⚠️ 这是**改用户 config.yml** 的动作，所以：
 *    · 先原样备份成 `config.yml.bak-多号拆分-<时间戳>`；
 *    · 内容**等价**（私有段换个文件存，合并出来的配置逐字不变）；
 *    · 界面上是用户点了确认才走到这里（确认框里写着会做什么）。
 * ⚠️ 拆完**要重启**才生效 —— 这个进程的 `ACCOUNT` 是加载时定下的（界面会提示）。
 */
function migrateToAccounts(qq) {
  const raw = yaml.load(readFileSync(CONFIG_FILE, 'utf8')) ?? {};
  const KEEP = new Set([...SHARED_SECTIONS, 'mainAccount', 'ownerQQ', 'logLevel', 'webui', 'provider', 'cleanup']);
  const priv = {};
  for (const [k, v] of Object.entries(raw)) {
    if (KEEP.has(k) || k.startsWith('__')) continue;
    priv[k] = v;
  }
  priv.name = String(priv.name ?? '').trim() || '主号';
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const bak = `${CONFIG_FILE}.bak-多号拆分-${stamp}`;
  copyFileSync(CONFIG_FILE, bak);
  accounts.write(qq, priv);

  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!KEEP.has(k) || k.startsWith('__')) continue;
    out[k] = v;
  }
  out.mainAccount = String(qq);
  const ordered = { mainAccount: String(qq), ...out };
  writeFileSync(
    CONFIG_FILE,
    '# 由管理界面 http://127.0.0.1:' +
      (Number(config.webui?.port) || 3099) +
      ' 维护。\n# 详细注释和说明见 README.md。\n' +
      yaml.dump(ordered, { lineWidth: 200, noRefs: true, quotingType: '"' }),
    'utf8',
  );
  return { backup: bak, moved: Object.keys(priv) };
}

/**
 * 把 patch 合进一个对象，**`null` = 删掉这个键**。
 *
 * ⚠️ 2026-10-07 加：`accounts.patch()` 走的是 `deepMerge`，而它把 `null` 当成
 *    "用 null 覆盖"（其实会退回原值）⇒ **"传 null 清掉这个群的覆盖"在写账号文件
 *    那条路上会静默失效**（界面回读还是旧值）。`test/webui.js` 里
 *    「传 `null` = 删掉覆盖 → 回到默认 50」那条断言就是抓这个的。
 *    ⇒ 私有段自己走这份带删除语义的合并，和 `saveConfig` 里 `put()` 的规矩保持一致。
 */
function applyPatch(obj, patch) {
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === null) {
      delete obj[k];
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!obj[k] || typeof obj[k] !== 'object' || Array.isArray(obj[k])) obj[k] = {};
      applyPatch(obj[k], v);
    } else {
      obj[k] = v;
    }
  }
}

/**
 * ⚠️ 2026-10-07 多 QQ 号：把界面提交的 patch 拆成「**共用**」和「**这个号私有**」两份。
 *
 * 用户拍板的分法：「只有模型页面所有 QQ 共用，其他配置全部分 QQ 控制」。
 * 所以判据就是 `config.js` 的 `SHARED_SECTIONS` —— **和读取时过滤私有的那张表同一个来源**。
 * （两处若各写一份，迟早会出现"存进去、读不回来"或者反过来"改了没生效"。）
 *
 * | 往哪写 | 哪些 |
 * | --- | --- |
 * | `config.yml`（所有号一起变） | 大模型 / 生图 / 搜索 / 识图 / 协议端 / 清理 / 主人 QQ / 日志级别 |
 * | `accounts/<QQ>.yml`（只有它变） | 灵敏度 / 按群设定 / 日常事件 / 剧情 / 好感度 / QQ空间 / 机器人 QQ … |
 *
 * ⚠️ 还没建过账号文件时（老用户刚升级上来）**整个 patch 照老样子写 config.yml** ——
 *    这条保证了"没做迁移也能正常用"，行为跟以前逐字一样。
 */
function splitPatch(patch) {
  const shared = {};
  const priv = {};
  for (const [k, v] of Object.entries(patch ?? {})) {
    // ⚠️ `ownerQQ`（同一个主人）和 `logLevel` 是顶层键，按共用算；
    //    `botQQ` 必须按号 —— 两个进程都写同一个 botQQ 的话，
    //    登录脚本会去登录同一个号，另一个号就永远上不来。
    if (k === 'ownerQQ' || k === 'logLevel' || SHARED_SECTIONS.includes(k)) shared[k] = v;
    else priv[k] = v;
  }
  if (Object.keys(priv).length) {
    // ⚠️ 只有"这个号**真的有账号文件**"时才写它 —— 老用户没拆分时
    //    `ACCOUNT.id` 可能来自 `mainAccount`/env 而文件并不存在，
    //    那种情况必须照老样子写回 `config.yml`（否则会凭空造出一个账号文件）。
    if (ACCOUNT.id && accounts.has(ACCOUNT.id)) {
      const cur = accounts.read(ACCOUNT.id) ?? {};
      // ⚠️ 用带删除语义的 `applyPatch`（`null` = 删键），**不能**用 `accounts.patch`
      //    —— 它的 `deepMerge` 会把 `null` 当成"覆盖"，于是"清掉这个群的覆盖"
      //    这条路上会静默失效（`test/webui.js` 那条断言就是抓它的）。
      applyPatch(cur, priv);
      accounts.write(ACCOUNT.id, cur);
      log.info(
        `配置写入账号私有文件（号 ${ACCOUNT.id}）：${Object.keys(priv).join(', ')} → ${accounts.fileOf(ACCOUNT.id)}`,
      );
    } else {
      Object.assign(shared, priv);
    }
  }
  return shared;
}

/** 界面提交的配置 → 合并进现有 yaml（保留其它字段） */
function saveConfig(patch) {
  // ⚠️ 2026-10-07 多 QQ 号：**只改了私有段时，共用文件一个字都不许动**。
  //
  //    这里原来是无条件 `writeFileSync(CONFIG_FILE, yaml.dump(...))` ——
  //    于是"我只改了这个号的灵敏度"也会把**所有号共用的那份 config.yml**
  //    整个重新序列化一遍（注释全丢、格式全变），而且多号并发时还有互相覆盖的风险。
  //    实测是 `test/accounts.js`【8】抓出来的（它盯着共用文件有没有被动过）。
  const touchedLife = !!patch?.life;
  // ⚠️⚠️ 2026-10-09 加：**`splitPatch` 之前**先把 `persona` 记下来。
  //
  //    为什么必须记在这里：`persona` **不在 `SHARED_SECTIONS` 里** ⇒
  //    `splitPatch()` 会把它当成"这个号私有"的段、**从返回值里摘掉**
  //    （写进 `accounts/<当前号>.yml`）⇒ 下面那句 `put('persona', patch.persona)`
  //    和 `if (patch.persona)` **永远不成立** ⇒ 日志那行"谁改了人设"
  //    **一次都不会打**。实测：`logs/bot-2026-10-09.log` 里那次切人设
  //    （13:49:42）**没有**「配置写入 persona.id」这行，只有
  //    「配置写入账号私有文件（号 …）：persona → accounts/<QQ>.yml」。
  const personaPatch = patch?.persona;
  patch = splitPatch(patch);
  if (Object.keys(patch).length === 0) {
    reloadConfig();
    if (touchedLife) {
      try {
        life.syncTarget();
      } catch (e) {
        log.debug(`日常事件“今天的目标条数”同步失败：${e.message}`);
      }
    }
    return config;
  }
  const raw = yaml.load(readFileSync(CONFIG_FILE, 'utf8')) ?? {};

  const put = (section, fields) => {
    if (!patch[section]) return;
    raw[section] = raw[section] ?? {};
    for (const [k, v] of Object.entries(patch[section])) {
      // ⚠️ 2026-10-07：`null` = **删掉这个键**（不是写一个 null 进去）。
      //    按群设定那边"把这个群的所有覆盖都清掉"要用它
      //    （`delete raw.groupParams[gid]` 那种语义，见 `POST /api/group-params`）。
      if (v === null) delete raw[section][k];
      else if (v !== undefined) raw[section][k] = v;
    }
  };

  // ⚠️⚠️ 2026-09-28 加：**子对象要深合并（一层）**。
  //
  //    `put()` 是**浅合并**（逐键覆盖），所以像 `qzone.comment` 这种**子对象**，
  //    前端只改其中一个开关时如果直接传 `comment: { enable: false }`，
  //    会把 `days` / `maxPerDay` / `intervalMs` **一起冲掉** ✗ ——
  //    用户会看到"我只关了一个开关，怎么天数也变回默认了"。
  //    ⇒ 这里先把它和文件里原有的值合起来，前端就**只需要传要改的键**。
  //    ⚠️ 只做**一层**：够用，而且不会把数组之类的结构意外合坏。
  //    ⚠️ 必须放在下面那些 `put(...)` **之前** —— `put` 是按 `patch` 里的值覆盖的，
  //       放后面就白合并了。
  const SUB_MERGE = { qzone: ['comment'] };
  for (const [section, subs] of Object.entries(SUB_MERGE)) {
    for (const sub of subs) {
      const before = raw[section]?.[sub];
      const incoming = patch[section]?.[sub];
      if (incoming && before && typeof before === 'object' && typeof incoming === 'object') {
        patch[section][sub] = { ...before, ...incoming };
      }
    }
  }

  put('llm', patch.llm);
  put('imagegen', patch.imagegen);
  put('onebot', patch.onebot);
  put('trigger', patch.trigger);
  put('context', patch.context);
  put('qzone', patch.qzone);
  put('status', patch.status);
  put('faces', patch.faces);
  put('chat', patch.chat);
  put('attitude', patch.attitude);
  put('teach', patch.teach);
  put('chunking', patch.chunking);
  put('webui', patch.webui);
  put('life', patch.life);
  put('quest', patch.quest);
  put('affinity', patch.affinity);
  put('friend', patch.friend);
  // ⚠️⚠️ 2026-09-22 加：**`persona`**（人设包 id）。
  //    踩到的：这一行原来没有它 ⇒ `POST /api/persona/switch` 里那句
  //    `saveConfig({ persona: { id } })` **什么也没发生**，而接口照样返回
  //    `ok:true`、日志还打印了「切换人设 → xxx」—— 看着像切了，其实
  //    `config.yml` 里连 `persona:` 段都没有，`personaId()` 一路回落到默认的 saki。
  //    界面上就是"点『切到这个』没反应"（用户报的「这个好像切不动」）。
  put('persona', patch.persona);
  // ⚠️ 2026-10-22 加：**B站全自动投稿**的设置段。
  //    踩到的：`biliPublish` 是共用段（`SHARED_SECTIONS` 里有），所以 `splitPatch` 会放行，
  //    但 `put()` 列表和白名单里都**没有**它 ⇒ 界面点保存返回 `ok:true`、状态条还写「已保存 ✓」，
  //    可 `config.yml` 里**一个字都没写进去**（只有一行 warn 落在日志里）✗
  //    ⇒ 三处都要有：`put(...)` / `HANDLED` / `order`。
  put('biliPublish', patch.biliPublish);
  // ⚠️ 2026-10-22：**B站评论回复**（同样三处都要有：put / HANDLED / order，
  //    少一处就会"界面显示已保存、config.yml 里其实没写进去"✗ 这个坑 biliPublish 已经踩过一次）
  put('biliComments', patch.biliComments);
  // ⚠️ 2026-10-21：**B站主动评论**（去别人视频下发）—— 同样是三处都要有。
  //    ⚠️ 这一行就是我自己刚踩过的：POST 里写了 `saveConfig({ biliProactive: … })`，
  //    但 `saveConfig` **只对这里 `put()` 列出的段做写入** ⇒ 静默丢弃，
  //    界面显示「已保存 ✓」、`config.yml` 里一个字都没有（验收脚本当场抓到）✗
  put('biliProactive', patch.biliProactive);
  /* ⚠️ 2026-10-21 加：**语音**（用户：「加一个语音设置模块放在功能卡片，内置开关，
   *   然后各个QQ账号可以选择用哪个语音」）
   *   ⚠️ `voice` **不在** `SHARED_SECTIONS` 里 ⇒ 按号私有 ⇒ 写进 `accounts/<QQ>.yml`
   *      ⇒ **每个 QQ 号能有自己的音色** ✓（正是用户要的） */
  put('voice', patch.voice);
  // ⚠️ 2026-09-22 加：**谁在改人设**要留下痕迹。
  //    查"config.yml 被莫名改成别的人设"时，就是靠这行定位到是哪个套件干的。
  //    带上文件名一眼能看出改的是**真实配置**还是套件的临时配置。
  //
  // ⚠️⚠️ 2026-10-09 修：**原来这里打的是 `CONFIG_FILE`（config.yml），而真实落点是
  //    `accounts/<当前号>.yml`** —— `persona` 不在 `SHARED_SECTIONS` 里，走 `splitPatch`
  //    就成了"这个号私有"。当天用户问「主号怎么变成别人的人设了、不是我改的」，
  //    我照这行日志去翻 `config.yml`，**整个扑空**（那份文件确实一个字没动）。
  //    ⇒ 打**真实落点**，并且判据用 `personaPatch`（patch 已被 splitPatch 摘过一遍，
  //      原来的 `patch.persona` 在私有段这条路上恒为 undefined）。
  if (personaPatch || patch.persona) {
    const pId = (personaPatch ?? patch.persona)?.id ?? '';
    const where = ACCOUNT.id && accounts.has(ACCOUNT.id) ? accounts.fileOf(ACCOUNT.id) : CONFIG_FILE;
    log.info(`配置写入 persona.id → ${JSON.stringify(pId)}（文件：${where}）`);
  }
  // ⚠️ 分群参数（2026-09-15）——和 configForUi 里那一行是**一对**，别只加一个
  put('groupParams', patch.groupParams);
  if (patch.ownerQQ !== undefined) raw.ownerQQ = patch.ownerQQ;
  if (patch.botQQ !== undefined) raw.botQQ = patch.botQQ;
  if (patch.logLevel !== undefined) raw.logLevel = patch.logLevel;

  // ⚠️⚠️ 2026-09-22 加：**白名单外的顶层键要吵出来**。
  //    这个函数是"逐段白名单"，漏加一段就**静默丢弃** —— 上面 `persona` 那次
  //    静默丢了一整天才被发现（还是靠用户说"切不动"）。宁可在日志里吵一行。
  const HANDLED = new Set([
    'llm', 'onebot', 'trigger', 'context', 'qzone', 'status', 'faces', 'chat', 'attitude',
    'teach', 'chunking', 'webui', 'life', 'quest', 'affinity', 'friend', 'persona',
    'imagegen', 'groupParams', 'ownerQQ', 'botQQ', 'logLevel', 'biliPublish',
    // ⚠️ 2026-10-21：这两段走的是上面 `put(...)` 那条路，但**必须同时登记在这里** ——
    //    不然每次保存都会吵一句「白名单里没有它」（虚警，但会掩盖真的漏字段）✗
    'biliComments', 'biliProactive',
    // ⚠️ 2026-10-21：语音（按号私有，走上面 put 那条路）
    'voice',
  ]);
  for (const k of Object.keys(patch ?? {})) {
    if (!HANDLED.has(k)) log.warn(`saveConfig 收到没处理的字段「${k}」—— 白名单里没有它，这次它**不会被写进 config.yml**`);
  }

  // 顶层字段顺序：保持一个可读的顺序
  const order = [
    'persona',
    'onebot',
    'llm',
    'imagegen',
    'trigger',
    'context',
    'status',
    'teach',
    'chunking',
    'webui',
    'faces',
    'chat',
    'attitude',
    'life',
    'quest',
    'biliPublish',
    'biliComments',
    'biliProactive',
    'voice',
    'ownerQQ',
    'botQQ',
    'adminQQ',
    'logLevel',
  ];
  const out = {};
  for (const k of order) if (k in raw) out[k] = raw[k];
  for (const k of Object.keys(raw)) if (!(k in out)) out[k] = raw[k];

  writeFileSync(
    CONFIG_FILE,
    '# 由管理界面 http://127.0.0.1:' +
      config.webui.port +
      ' 维护。\n# 详细注释和说明见 README.md。\n' +
      yaml.dump(out, { lineWidth: 200, noRefs: true, quotingType: '"' }),
    'utf8',
  );

  reloadConfig();
  // ⚠️ 2026-09-16：改了「日常事件每日条数」要**当天立刻生效**
  //    （用户报的：「为什么我改成日常事件每日3条，现在还是6条」——
  //      当天的目标条数是当天定下并落盘的，原来要等第二天才换）。
  if (touchedLife) {
    try {
      life.syncTarget();
    } catch (e) {
      log.debug(`日常事件“今天的目标条数”同步失败：${e.message}`);
    }
  }
  return config;
}

// ── 表情库 ────────────────────────────────────────────

function readIndex() {
  try {
    return JSON.parse(readFileSync(join(LIB, 'index.json'), 'utf8'));
  } catch {
    return { faces: [] };
  }
}

function writeIndex(idx) {
  writeFileSync(join(LIB, 'index.json'), JSON.stringify(idx, null, 2) + '\n', 'utf8');
  reloadFaces();
}

/** 列表里带上文件大小，界面好展示 */
function facesWithMeta() {
  const idx = readIndex();
  return (idx.faces ?? []).map((f) => {
    const p = join(LIB, f.file);
    let bytes = 0;
    if (existsSync(p)) bytes = readFileSync(p).length;
    return { ...f, bytes, exists: existsSync(p) };
  });
}

// ── 路由 ──────────────────────────────────────────────

// ⚠️⚠️ 2026-09-15 用户报「刚点一下立即发送，抽到的事件马上就变了一个然后发出去了」——
//    查明了：**不是发送分支的 bug，是浏览器那一页还是旧页面**。
//    这个界面**没有周期性轮询**，服务端的 webui.html 改了，已经开着的标签页不会知道；
//    旧页面的 `lifeSendNow()` 不把预览一起传上来 → 服务端只好重新抽一条 →
//    "你看到的"和"真发出去的"不是同一条。
//    （证据：日志里只有「管理界面手动发了一条日常事件」，**没有**「用的就是刚预览的那一条」）
//    两道修：① 服务端也记一份"刚预览的"（10 分钟），页面没带预览时就用它；
//            ② 界面每 60 秒比一次页面版本，不一致就提示刷新（见 webui.html）。
//    为什么记在这儿而不是塞进 `life.preview()`：语义是"界面上刚给你看过的那一条"，
//    而 `life.preview()` 是通用的抽签接口（将来别处也可能调）。
let lastLifePreview = null;              // { at, p }
const LIFE_PREVIEW_TTL = 10 * 60 * 1000;

/**
 * 把**某个人设包**的 QQ 昵称 / 头像应用到真号上（2026-09-21 加）。
 *
 * ⚠️ 用户定：「昵称和头像应该就是自动改的，要不然就没意义了」——
 *    所以 `POST /api/persona/switch` 切完**自动**调它，不用用户再点一次。
 * ⚠️ 改的是**真号**（所有群、所有好友都看得见），所以：
 *    · 两个字段**留空 = 那一项不动**（不是清空）—— 新角色没填头像时不会把头像抹掉；
 *    · 任何一步失败都**如实返回**，不假装成功；
 *    · 昵称改完 `get_login_info` **读回来核对**（"以为改了其实没改"要过很久才发现）。
 */
async function applyPersonaQQ(id) {
  const out = { nickname: '', avatar: '', problems: [] };
  if (!bot?.call) {
    out.problems.push('机器人还没连上协议端');
    return out;
  }
  let q = { nickname: '', avatar: '' };
  try {
    q = personaAdmin.readPack(id).qq;
  } catch (e) {
    out.problems.push(`读人设包失败：${e.message}`);
    return out;
  }
  if (q.nickname) {
    try {
      await bot.call('set_qq_profile', { nickname: q.nickname });
      const info = await bot.call('get_login_info').catch(() => null);
      const now = info?.nickname ?? '';
      if (now === q.nickname) out.nickname = now;
      else out.problems.push(`昵称没改成（现在还是「${now}」）`);
    } catch (e) {
      out.problems.push(`改昵称失败：${e.message}`);
    }
  }
  if (q.avatar) {
    const f = personaAdmin.avatarFile(id, q.avatar);
    if (!f) out.problems.push(`人设包里的头像文件找不到：${q.avatar}`);
    else {
      try {
        await bot.call('set_qq_avatar', { file: f });
        out.avatar = q.avatar;
      } catch (e) {
        out.problems.push(`换头像失败：${e.message}`);
      }
    }
  }
  return out;
}

/**
 * ⚠️⚠️ 2026-10-13 加（用户：「**然后加任务页**」）。
 *
 * 为什么是**一个自包含页面**而不是往 `webui.html` 里加标签页：
 *   那个文件 6000+ 行、导航/切页/渲染三套逻辑缠在一起，动它风险大 ✗
 *   ⇒ 这里直接吐一页完整的 HTML（内联样式 + 内联 JS，只用两个接口）✓
 *     · `GET /agent-tasks` —— 打开这一页
 *     · `GET /api/agent-tasks` —— 任务列表（新的在前）
 *     · `GET /api/agent-task?id=` —— 单条 + 那次会话的对话
 *   ⚠️ 好处：**刷新就有**，完全不依赖 DSH 那个侧边栏（那边要重启才更新，实测过 ✗）
 */
const AGENT_TASKS_HTML = [
  '<!doctype html>',
  '<html lang="zh"><head><meta charset="utf-8"><title>本机任务</title>',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<style>',
  'body{font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;margin:0;background:#111;color:#eee}',
  '.wrap{max-width:920px;margin:0 auto;padding:16px}',
  'h1{font-size:18px;margin:0 0 4px}',
  '.hint{color:#888;font-size:12px;margin-bottom:12px}',
  '.t{border:1px solid #333;border-radius:8px;padding:10px;margin-bottom:8px;background:#161616;cursor:pointer}',
  '.t:hover{border-color:#555}',
  '.m{color:#8b8b8b;font-size:12px;margin-top:2px}',
  '.s{padding:1px 6px;border-radius:6px;font-size:12px;margin-left:6px}',
  '.running{background:#3a2f00;color:#ffd166}.done{background:#12351f;color:#7ee787}',
  '.failed,.killed{background:#3a1a1a;color:#ff7b72}.asking{background:#1f2a3a;color:#79c0ff}',
  '.talk{margin-top:8px;border-top:1px dashed #333;padding-top:8px;display:none}',
  '.u{color:#9ecbff}.a{color:#e8e8e8}',
  'pre{white-space:pre-wrap;word-break:break-word;margin:4px 0;font:inherit}',
  '</style></head><body><div class="wrap">',
  '<h1>本机任务</h1>',
  '<div class="hint">点一条看那次她到底在做什么 ｜ <a href="#" id="rf" style="color:#79c0ff">刷新</a>（有更新会自动刷）</div>',
  '<div id="list">加载中…</div>',
  '</div><script>',
  'function esc(s){return String(s==null?"":s).replace(/[&<>]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c]})}',
  'function fmt(t){try{return new Date(t).toLocaleString("zh-CN",{hour12:false})}catch(e){return ""}}',
  // ⚠️⚠️ 2026-10-16 加：**"看对话"要能在跑着的时候看**（用户：「正在跑的能不能也把对话显示出来」）——
  //    · `openIds`：刷新（SSE 推来的）之后，**原来展开的那几条保持展开** ✓
  //    · `talkTimers`：**正在跑**的那条每 5 秒自动重拉（对话还在长）✓ 收起就停 ✗
  'var openIds={},talkTimers={};',
  'function stopTalk(id){if(talkTimers[id]){clearInterval(talkTimers[id]);delete talkTimers[id]}}',
  'async function fillTalk(id,box){',
  '  try{',
  '    var r=await fetch("/api/agent-task?id="+encodeURIComponent(id));var j=await r.json();',
  '    if(!j.ok){box.textContent=j.error||"读不到";return ""}',
  '    if(!j.talk||!j.talk.length){box.textContent="（这次没有可显示的对话）";return (j.task&&j.task.status)||""}',
  '    box.innerHTML=j.talk.map(function(x){',
  '      return "<pre class=\\""+(x.role==="user"?"u":"a")+"\\">"+(x.role==="user"?"我：":"她：")+esc(x.text)+"</pre>"',
  '    }).join("");',
  '    return (j.task&&j.task.status)||""',
  '  }catch(e){box.textContent="出错："+e.message;return ""}',
  '}',
  'async function toggleTalk(el){',
  '  var id=el.getAttribute("data-id");var box=document.getElementById("talk-"+id);',
  '  if(!box)return;',
  '  if(box.style.display==="block"){box.style.display="none";delete openIds[id];stopTalk(id);return}',
  '  openIds[id]=1;',
  '  box.style.display="block";box.textContent="加载对话…";',
  '  var st=await fillTalk(id,box);',
  '  stopTalk(id);',
  '  if(st==="running"){talkTimers[id]=setInterval(function(){fillTalk(id,box)},5000)}',
  '}',
  'async function load(){',
  '  var r=await fetch("/api/agent-tasks?limit=50");var j=await r.json();',
  '  var L=document.getElementById("list");',
  '  if(!j.tasks||!j.tasks.length){L.textContent="还没有任务";return}',
  '  L.innerHTML=j.tasks.map(function(t){',
  '    var arts=(t.arts||[]).map(function(a){return a.name}).join("、");',
  '    return "<div class=\\"t\\" data-id=\\""+esc(t.id)+"\\" data-status=\\""+esc(t.status||"")+"\\">"+',
  '      "<div><b>"+esc(t.task||"")+"</b><span class=\\"s "+esc(t.status||"")+"\\">"+esc(t.status||"")+"</span></div>"+',
  '      "<div class=\\"m\\">"+fmt(t.startedAt)+" ｜ "+esc(t.byName||t.by||"")+(t.cost?" ｜ "+t.cost+" 秒":"")+(t.gid?" ｜ 群 "+esc(t.gid):"")+"</div>"+',
  '      (t.text?"<div class=\\"m\\">她说的："+esc(String(t.text).slice(0,140))+"</div>":"")+',
  '      (arts?"<div class=\\"m\\">产物："+esc(arts)+"</div>":"")+',
  '      "<div class=\\"talk\\" id=\\"talk-"+esc(t.id)+"\\"></div></div>"',
  '  }).join("");',
  '  Array.prototype.forEach.call(L.querySelectorAll(".t"),function(el){',
  '    el.addEventListener("click",function(){toggleTalk(el)})',
  '  })',
  // ⚠️ 重建列表之后，**原来展开的那几条要重新展开**（顺便把"正在跑"的自动刷新挂回去）✓
  '  Object.keys(openIds).forEach(function(id){',
  '    var el=L.querySelector(\'.t[data-id="\'+id+\'"]\');if(!el)return;',
  '    var b=document.getElementById("talk-"+id);if(b)toggleTalk(el)',
  '  })',
  '}',
  'load();',
  'document.getElementById("rf").addEventListener("click",function(e){e.preventDefault();load()});',
  '// ⚠️ 2026-10-13：不再定时轮询 —— 服务端在任务有变化时用 SSE 推一下（断了自己会重连）',
  'try{var es=new EventSource("/agent-tasks/stream");es.addEventListener("change",function(){load()});',
  'es.addEventListener("open",function(){/* 连上了 */});}catch(e){}',
  '</script></body></html>',
].join('\n');

const routes = {
  /**
   * 「这个进程是谁」—— 多 QQ 号的地基接口（2026-10-07 加）。
   *
   * 用途有两个：
   *   ① 界面刚打开时问一句"我现在在控制哪个号"，好把侧栏那条横幅显示对；
   *   ② 别的号的进程用它**探活**（见 `GET /api/accounts`）——
   *      `http://127.0.0.1:<那个号的端口>/api/whoami` 通 = 那个号在跑。
   */
    // ⚠️ 2026-10-19 加（用户：「在**功能卡片**加一个**工具调用入口**…
  //    展示**所有目前已启用的工具**，并显示**累计调用次数**和**今日调用次数**」）
  'GET /api/tools': async (req, res) => {
    try {
      const ts = await import('./tool-stats.js');
      // ⚠️⚠️⚠️ 2026-10-19 修（用户截图：「**工作模式是开着的**，能不能多检查几遍」）——
      //    现场：他在 **3099**（主号界面）上**切号切到谷雨**，工具页显示「工作模式现在：关」，
      //    可谷雨那个号明明是开着的 ✗
      //    真因：这条路由只读**当前进程**的 `config`（= 主号，关着），
      //    完全没理前端切号时带的 `x-saki-account` 头 ⇒ 显示的是**另一个号**的状态 ✗
      //    ⇒ 带了那个头就按**那个号自己的** `accounts/<QQ>.yml` 读 ✓
      const hdr = String(req?.headers?.['x-saki-account'] ?? '').trim();
      let wantQq = hdr && /^\d{5,12}$/.test(hdr) ? hdr : '';
      let workEnabled = config.privateWork?.enable === true;
      if (wantQq) {
        try {
          const a = accounts.read(wantQq) ?? {};
          // ⚠️ 读得到就用它的；读不到（这号还没自己的配置文件）⇒ 沿用它跟主号一样的判断
          if (a.privateWork && typeof a.privateWork.enable === 'boolean') {
            workEnabled = a.privateWork.enable === true;
          }
        } catch {}
      }
      send(res, 200,
        ts.snapshot({
          // ⚠️ 工作模式关着的号：不显示那 12 个工作模式工具（它们在这个号上根本用不到）✓
          workEnabled,
        }),
      );
    } catch (e) {
      // ⚠️ 这个响应对象**不是 express**（没有 `res.status`）⇒ 只能 `res.json` ✓
      send(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
  },

'GET /api/whoami': async (_req, res) => {
    send(res, 200, {
      ok: true,
      qq: displayId(),
      main: ACCOUNT.main || displayId(),
      isMain: ACCOUNT.isMain,
      // ⚠️ 有没有做过"多号拆分"（**看磁盘**，见 `splitState`）；
      //    `needRestart` = 磁盘拆好了但这个进程还没重启，界面要提示。
      ...splitState(),
      name: ACCOUNT.id ? accounts.displayName(ACCOUNT.id) : '',
      port: Number(config.webui?.port) || 3099,
      botQQ: String(config.botQQ ?? ''),
      persona: personaId(),
      pid: process.pid,
      ignoredPrivate: ACCOUNT.ignoredPrivate ?? [],
    });
  },

  /**
   * 号列表（界面上「QQ 号」那一页）。
   *
   * ⚠️ 每个号**单独探活**：只有"那个号的进程真的在跑"，它的界面端口才回应。
   *    所以这一页能一眼看出"哪个号在线、哪个号没起来"。
   * ⚠️ 探测用 1.5 秒超时并**并发**发出去 —— 号多了也不该让这一页卡住。
   */
  // ⚠️⚠️ 2026-10-19 加（用户第三次报同一处：「**这两个开关还是有问题，现在根本点不动**」
  //    + 截图：「点了关，但服务端现在是开 —— 没生效」）——
  //    查下来后端**每一次都写成功了**（`POST /api/config` → `accounts/<QQ>.yml`，
  //    带不带 `x-saki-account` 都验过，两个方向都对）。
  //    ⇒ 病根在前端**读回那一步**：它原来走 `GET /api/accounts`，
  //      而那个接口要**遍历所有号、逐个探活**（每个 1.5 秒超时）、还要顺带重建整张表 ——
  //      中间任何一处抛异常，`ACC_LIST` 就**停在旧值** ⇒ 界面拿旧值当答案 ⇒ 报"没生效" ✗
  //    ⇒ 给这两个开关一个**只读内存、不探活、不碰 DOM** 的轻接口：秒回、只看这个号自己 ✓
  'GET /api/switches': async (_req, res) => {
    const pw = config.privateWork;
    const tk = config.humanTakeover;
    return send(res, 200, {
      ok: true,
      qq: displayId(),
      workMode: pw?.enable === true,
      takeover: tk?.enable === true,
      // ⚠️ 顺带把"配置文件里到底是什么"也报出来 —— 万一内存和磁盘不一致，这里一眼能看出来
      raw: {
        privateWork: pw?.enable === undefined ? null : pw.enable,
        humanTakeover: tk?.enable === undefined ? null : tk.enable,
      },
    });
  },
  'GET /api/accounts': async (_req, res) => {
    const ids = accounts.ids();
    // ⚠️ 主号可能**还没有账号文件**（老用户没做拆分）—— 也要列出来，
    //    不然界面上"正在控制的那个号"反而看不见，切都没法切。
    const shownMain = ACCOUNT.main || displayId();
    if (shownMain && !ids.includes(shownMain)) ids.unshift(shownMain);

    const sharedPort = Number(config.webui?.port) || 3099;
    const one = async (qq) => {
      const a = accounts.read(qq) ?? {};
      const isMain = qq === shownMain;
      const port = Number(a.webui?.port) || (isMain ? sharedPort : 0);
      const self = qq === displayId();
      let alive = self;
      let info = self
        ? { qq, port: sharedPort, persona: personaId(), pid: process.pid, isMain }
        : null;
      if (!self && port) {
        try {
          // ⚠️ 本机探活**必须直连**（走代理会打不到 ⇒ 界面永远显示"没在跑"）—— 见 `localFetch` 那段 ✓
          const r = await localFetch(`http://127.0.0.1:${port}/api/whoami`, {
            signal: AbortSignal.timeout(1500),
          });
          if (r.ok) {
            info = await r.json();
            alive = true;
          }
        } catch {
          /* 连不上 = 那个号没在跑，界面显示成灰的就行 */
        }
      }
      return {
        qq,
        name: String(a.name ?? '').trim(),
        note: String(a.note ?? '').trim(),
        botQQ: String(a.botQQ ?? qq),
        persona: String(info?.persona ?? a.persona?.id ?? config.persona?.id ?? 'saki'),
        port,
        isMain,
        self,
        alive,
        pid: info?.pid ?? 0,
        hasFile: accounts.has(qq),
        // ⚠️ 2026-10-14 加：**人工接管**（一号一份，存在 `accounts/<QQ>.yml` 里）——
        //    界面那个开关直接读它就够了，不用再为它单开一个接口
        takeover: a.humanTakeover?.enable === true,
        // ⚠️ 2026-10-14 加：**私聊工作模式**（同样一号一份、默认关）——
        //    就是那个"接单号"用的：好友私聊按"先摸需求 → 问要不要开始 → 到点交付"走
        workMode: a.privateWork?.enable === true,
        // ⚠️ 协议端那边：这个号**登录过没有**（有没有它的配置文件）、
        //    以及它的 OneBot 端口配了没（界面上的"接协议端"按钮用这两个判断）
        protoSupported: providerAccounts.supported(),
        protoLoggedIn: providerAccounts.supported() ? existsSync(providerAccounts.fileOf(qq)) : false,
        protoPort: providerAccounts.supported() ? providerAccounts.wsPortOf(qq) : 0,
      };
    };
    send(res, 200, {
      ok: true,
      current: displayId(),
      main: shownMain,
      sharedPort,
      // ⚠️ 没拆分时界面要提示"加第二个号之前先拆一次"；拆了但没重启要提示重启
      ...splitState(),
      // ⚠️ 协议端那边配到哪一步了（界面上"接协议端"那个按钮要用）
      provider: {
        supported: providerAccounts.supported(),
        reason: providerAccounts.supported() ? '' : providerAccounts.unsupportedReason(),
        manageUrl: provider.manageUrl(),
        // 协议端里**已经有配置文件**的号（= 已经登录进去过的号）
        known: providerAccounts.supported() ? providerAccounts.knownAccounts() : [],
        ports: providerAccounts.supported() ? providerAccounts.wsPorts() : [],
      },
      accounts: await Promise.all(ids.map(one)),
    });
  },

  /**
   * 号的增 / 删 / 改名 / **复制配置**（用户要的「配置可以被复用」）。
   *
   * ⚠️ 这个接口故意**不跟着"当前号"转发** —— 它是"管所有号"的接口，
   *    由用户当前连着的那个进程处理就行（都是同一个磁盘上的文件）。
   */
  /**
   * ⚠️ 2026-10-14 加：**「工作模式」页里那张「分好友的设置」表**要的数据 ——
   *    好友名单（协议端拉回来的那份）+ 每个人现在的状态 + 他自己的设置 + 全局默认值。
   *    ⚠️ 它和 `affinity`（好感度那套好友设置）**没有半点关系**（用户特意说过）。
   */
  'GET /api/private-work': async (_req, res) => {
    try {
      const pw = await import('./private-work.js');
      if (!pw.enabled()) {
        return send(res, 200, { ok: true, off: true, friends: [], counting: 0, defaults: {} });
      }
      return send(res, 200, pw.uiData());
    } catch (e) {
      send(res, 500, { ok: false, error: e.message });
    }
  },

  /**
   * ⚠️ 2026-10-16 加（用户：「**把 PPT 做完然后发过来就行了**」）：
   *    **手动补一次交付** —— 活已经做完了（产物在 `产物/` 里），只差"发给他"那一步。
   *    ⚠️ 走的就是**跑完自动交付**那条路（`deliver`），不是另写一套发文件的代码 ✓
   *    （不然"自动发的"和"手动补发的"迟早出现一边修好、另一边还是老毛病 ✗）
   */
  'POST /api/private-work/deliver': async (req, res) => {
    let body = {};
    try {
      body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    } catch {}
    try {
      const uid = String(body.uid ?? '').trim();
      if (!uid) return send(res, 400, { ok: false, error: '要 uid' });
      const pw = await import('./private-work.js');
      if (!pw.enabled()) return send(res, 400, { ok: false, error: '私聊工作模式没开' });
      const r = (await pw.deliver(uid, bot)) ?? {};
      log.info(`[私聊工作] 界面上手动交付（${uid}）：发出 ${r.sent ?? 0}/${r.total ?? 0} 个文件`);
      return send(res, 200, { ok: (r.sent ?? 0) > 0, ...r });
    } catch (e) {
      send(res, 500, { ok: false, error: e.message });
    }
  },

  // ── B 站视频分享（2026-10-15 用户要求）──────────────────────
  // ⚠️⚠️ **按群**存的（用户：「b站分享也要分群调节」）——
  //    写 `accounts/<QQ>.yml` 的 `groupParams.<群>.biliShare` ✓
  //    （跟「按群设定」页同一套机制：`accounts.patch` 深合并 ⇒ 不冲掉别的段）✓
  'GET /api/bili-share': async (req, res) => {
    try {
      const bs = await import('./bili-share.js');
      const gid = String(new URL(req.url, 'http://x').searchParams.get('groupId') ?? '').trim();
      return send(res, 200, { ok: true, groupId: gid, cfg: bs.uiCfg(gid), status: bs.status(gid) });
    } catch (e) {
      send(res, 500, { ok: false, error: e.message });
    }
  },
  // ⚠️ 「立刻发送」（2026-10-15 用户要求）—— 界面上点一下**马上**给选中的那个群发一条。
  //    跳过时段/冷却判定（`force`），但仍然**排除发过的**、仍然记账（手动发的也算那个群今天一条）✓
  'POST /api/bili-share/send': async (req, res) => {
    let body = {};
    try {
      body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    } catch {}
    try {
      const bs = await import('./bili-share.js');
      const gid = String(body.groupId ?? '').trim();
      if (!gid) return send(res, 400, { ok: false, error: '先选个群' });
      // ⚠️⚠️ 2026-10-15 用户要求：「**手动发一条视频不开自动发也要能发**」
      //    ⇒ 这里**不再看那个群的开关** —— 那个开关管的是"**定时自动发**"，
      //      手动点一下是另一回事（原来把它一起拦了，用户点了会看到"开关还没打开"✗）
      //    ⚠️ 但"这个群有没有关键词"还得管 —— 没关键词压根搜不到东西，
      //      这种要**说清楚**（不然界面上只会显示"没挑到能发的视频"，看不出为什么）✓
      // ⚠️⚠️ 2026-10-16 用户要求：「**把立即发送一条独立出来，单独给它加个关键词框，
      //    这样就不用动自动发送那里的设置了**」+「**再独立加一个是否配 bot 自己评论的选框**」——
      //    ⇒ 这两个只影响**这一次手动发送**，**不写进**群配置 ✓
      const tmpKw = (Array.isArray(body.keywords) ? body.keywords : String(body.keywords ?? '').split(/[\n,，、]/))
        .map((x) => String(x ?? '').trim())
        .filter(Boolean)
        .slice(0, 10);
      // ⚠️ 临时词给了就不要求这个群配过关键词（正是"不用动自动设置"的意思 ✓）
      if (!tmpKw.length && !bs.keywordsOf(gid).length) {
        return send(res, 400, {
          ok: false,
          error: '这个群还没填关键词（自动发的开关可以关着，但关键词得先填一个，或者在这格里临时填一个）',
        });
      }
      const life = await import('./life.js');
      // ⚠️⚠️ 2026-10-16 加（用户：「**独立视频发送那里的关键词框还是没有被保存**」）——
      //    点"立刻发送"时把这一格的内容**按群记下来**（落盘 ⇒ 刷新/重启都在 ✓）
      //    ⚠️ 记的是**这一格**，不动那个群"自动发送"的关键词 ✓
      bs.saveNowPick(gid, { keywords: tmpKw, take: body.take });
      // ⚠️ 2026-10-15：用 `eventGroups()`（1 档群）—— 手动发不该被「日常事件开关」挡住 ✓
      const r = await bs.runOnce(bot, life.eventGroups(), {
        force: true,
        groupId: gid,
        keywords: tmpKw,
        // ⚠️ `take`：界面上那个"带上她自己的一句评论"选框 ⇒ true/false；
        //    没传（undefined）= 按这个群的**概率设置**来 ✓
        take: typeof body.take === 'boolean' ? body.take : null,
      });
      log.info(`[B站分享] 界面上手动发了群 ${gid} 一条：${r.sent ? r.url : '没发成（' + r.why + '）'}`);
      return send(res, 200, { ok: r.sent === true, ...r });
    } catch (e) {
      send(res, 500, { ok: false, error: e.message });
    }
  },
  // ⚠️⚠️ 2026-10-16 加（用户：「**独立视频发送那里的关键词框还是没有被保存**」）——
  //    **只存不发**：界面上那格填完就自动往这儿存一份（防抖）⇒ 刷新/换浏览器/重启都还在 ✓
  //    ⚠️ 存的只是"立刻发送"那一格的内容，**不动**自动发送的设置 ✓
  'POST /api/bili-share/now': async (req, res) => {
    let body = {};
    try {
      body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    } catch {}
    try {
      const bs = await import('./bili-share.js');
      const gid = String(body.groupId ?? '').trim();
      if (!gid) return send(res, 400, { ok: false, error: '先选个群' });
      const kws = (Array.isArray(body.keywords) ? body.keywords : String(body.keywords ?? '').split(/[\n,，、]/))
        .map((x) => String(x ?? '').trim())
        .filter(Boolean)
        .slice(0, 10);
      bs.saveNowPick(gid, {
        // ⚠️ 存**原样的文本**（不只存拆出来的词）—— 界面上要一字不差地填回去 ✓
        keywords: String(body.keywords ?? ''),
        take: body.take,
      });
      return send(res, 200, { ok: true, groupId: gid, keywords: kws, ...bs.nowPick(gid) });
    } catch (e) {
      send(res, 500, { ok: false, error: e.message });
    }
  },
  'POST /api/bili-share': async (req, res) => {    let body = {};
    try {
      body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    } catch {
      return send(res, 400, { ok: false, error: '请求体不是合法 JSON' });
    }
    try {
      const bs = await import('./bili-share.js');
      const gid = String(body.groupId ?? '').trim();
      if (!gid) return send(res, 400, { ok: false, error: '先选个群（这是按群设的）' });
      const clean = bs.normalizeCfg(body); // ⚠️ 规矩在模块里（界面和手写 yml 同一套）✓
      if (!ACCOUNT.id || !accounts.has(ACCOUNT.id)) {
        return send(res, 400, { ok: false, error: '读不到当前账号，没法按号保存' });
      }
      // ⚠️ 写进 `groupParams.<群>.biliShare`（深合并 ⇒ 不冲掉这个群的别的段）✓
      accounts.patch(ACCOUNT.id, { groupParams: { [gid]: { biliShare: clean } } });
      // ⚠️ 写完让内存里的 config 跟着变（不然要重启才生效）✓
      reloadConfig();
      log.info(
        `管理界面改了 B站分享（群 ${gid}）：enable=${clean.enable} ` +
          `关键词=${JSON.stringify(clean.keywords)} 每天 ${clean.minPerDay}~${clean.maxPerDay} 条`,
      );
      return send(res, 200, { ok: true, cfg: clean });
    } catch (e) {
      send(res, 500, { ok: false, error: e.message });
    }
  },

  'POST /api/accounts': async (req, res) => {
    let body = {};
    try {
      body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    } catch {
      return send(res, 400, { ok: false, error: '请求体不是合法 JSON' });
    }
    const action = String(body.action ?? '');
    const qq = String(body.qq ?? '').trim();
    try {
      // ── 「拆分」：把 config.yml 里属于这个号的设置搬进 accounts/<QQ>.yml ──
      //    界面上是用户点了确认才走到这里（见 `migrateToAccounts` 的说明）。
      if (action === 'migrate') {
        const target = qq || displayId();
        if (!accounts.isValidId(target)) throw new Error('要拆分的 QQ 号不合法');
        if (accounts.has(target)) throw new Error(`号 ${target} 已经有配置文件了，不用再拆`);
        const out = migrateToAccounts(target);
        log.info(
          `多号拆分完成：${out.moved.length} 段搬进 accounts/${target}.yml（原 config.yml 备份在 ${out.backup}）`,
        );
        return send(res, 200, { ok: true, qq: target, moved: out.moved, backup: out.backup });
      }
      if (action === 'create') {
        if (!accounts.isValidId(qq)) throw new Error('QQ 号要填 5~12 位数字');
        if (accounts.has(qq)) throw new Error(`号 ${qq} 已经加过了`);
        if (qq === ACCOUNT.main) throw new Error('这就是主号，不用新建');
        // 端口从 3100 往上找没被占的（主号固定是 config.yml 里那个）
        const taken = [
          Number(config.webui?.port) || 3099,
          ...accounts.ids().map((id) => Number(accounts.read(id)?.webui?.port) || 0),
        ];
        const port = await accounts.allocatePort(taken);
        if (!port) throw new Error('找不到空闲端口（3100 往后 200 个都被占了）');
        const made = accounts.create(qq, {
          name: body.name,
          copyFrom: body.copyFrom,
          sections: body.sections,
          webuiPort: port,
        });
        // ⚠️ 2026-10-07：顺手建好这个号**私有知识目录**（群记忆 / 学习档案 / 群资料都落这儿）。
        //    不建的话，它第一次跑起来会满日志找 `knowledge/accounts/<QQ>/learned.md`；
        //    建了空目录 + 一个空档案，就是"这个号还没学过任何东西"的正常起点。
        try {
          const kd = join(KNOWLEDGE_DIR, 'accounts', qq);
          mkdirSync(kd, { recursive: true });
          const lf = join(kd, 'learned.md');
          if (!existsSync(lf)) {
            writeFileSync(lf, '# 学习档案（这个号自己学到的）\n\n' + '<!-- LEARNED:BEGIN -->\n<!-- LEARNED:END -->\n', 'utf8');
          }
        } catch (e) {
          log.warn(`给号 ${qq} 建私有知识目录失败（不影响加号）：${e.message}`);
        }
        log.info(`新加了一个号：${qq}（界面端口 ${port}${body.copyFrom ? `，配置复制自 ${body.copyFrom}` : ''}）`);
        // ⚠️ 用户要求「**以后每次加号都能自动互相加池**」：
        //    新号一加进来就立刻和已有的号互相进同类池，并复用它缺的不同类池。
        //    ⚠️ 失败**不影响加号**（池是加成，不该因为它把加号回滚）。
        let poolReport = null;
        try {
          poolReport = pools.sync();
          if (poolReport.changed.length) {
            log.info(
              `机器人池自动同步：改了 ${poolReport.changed.length} 个号（${poolReport.changed
                .map((c) => `${c.qq} 同类+${c.peersAdded.length}/不同类+${c.otherAdded.length}`)
                .join('，')}）`,
            );
          }
        } catch (e) {
          log.warn(`加号后自动同步机器人池失败（不影响加号）：${e.message}`);
        }
        return send(res, 200, { ok: true, qq, port, account: made, pools: poolReport });
      }
      if (action === 'rename') {
        if (!accounts.has(qq)) throw new Error(`没有这个号：${qq}`);
        accounts.patch(qq, { name: String(body.name ?? ''), note: String(body.note ?? '') });
        return send(res, 200, { ok: true, qq });
      }
      if (action === 'copy') {
        const from = String(body.from ?? '').trim();
        const to = String(body.to ?? '').trim();
        if (!from || !to) throw new Error('要指明从哪个号复制到哪个号');
        if (from === to) throw new Error('源和目标是同一个号');
        if (!accounts.has(from)) throw new Error(`源号 ${from} 没有配置文件`);
        if (!accounts.has(to)) throw new Error(`目标号 ${to} 没有配置文件`);
        const src = accounts.read(from) ?? {};
        const sections = Array.isArray(body.sections) && body.sections.length ? body.sections : null;
        const out = {};
        for (const [k, v] of Object.entries(src)) {
          // ⚠️ 这两样**永远不复制**：`onebot` 是那个号专属的 WS 端口 + token
          //    （复制过去两个进程会抢同一个端口）；`botQQ` 复制了就是把"自己是谁"搞错。
          if (k === 'onebot' || k === 'botQQ' || k === 'name' || k === 'note') continue;
          if (sections && !sections.includes(k)) continue;
          out[k] = v;
        }
        accounts.patch(to, out);
        log.info(`把号 ${from} 的配置复制给了 ${to}（${Object.keys(out).join(', ') || '没有可复制的段'}）`);
        return send(res, 200, { ok: true, from, to, sections: Object.keys(out) });
      }
      if (action === 'remove') {
        if (!accounts.has(qq)) throw new Error(`没有这个号：${qq}`);
        if (qq === ACCOUNT.main) throw new Error('主号不能删（它是"用老路径"的那个号，删了数据路径就乱了）');
        if (qq === ACCOUNT.id) throw new Error('不能删掉正在跑的这个号');
        const backup = accounts.remove(qq);
        log.info(`删掉了一个号：${qq}（原文件备份在 ${backup}）`);
        return send(res, 200, { ok: true, qq, backup });
      }
      throw new Error(`不认识的 action：${action || '(空)'}`);
    } catch (e) {
      send(res, 400, { ok: false, error: e.message });
    }
  },

  /**
   * 协议端那边：给某个号配 OneBot 端口 / 重启协议端（2026-10-07 加，用户要求「我自动改协议端配置」）。
   *
   * ⚠️ 分成两个动作是**故意的**：
   *   · `sync`    只改配置文件（协议端的 `onebot_<QQ>.json` + 我们这边那个号的接入点），
   *               **不影响正在跑的连接**；
   *   · `restart` 才让新端口真正生效 —— 但它会让**所有号**掉线约 1 分钟，
   *               所以单独一个动作，界面上要用户点确认才发。
   *
   * ⚠️ 前置条件**做不了自动化**：新号必须先在协议端自己的界面里登录过（扫码），
   *    协议端才会为它生成配置文件。没登录过就 `sync`，这里会如实说明，
   *    不会假装成功（项目里对"不支持/做不到"一向是这个态度）。
   */
  'POST /api/accounts/provider': async (req, res) => {
    let body = {};
    try {
      body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    } catch {
      return send(res, 400, { ok: false, error: '请求体不是合法 JSON' });
    }
    const action = String(body.action ?? '');
    const qq = String(body.qq ?? '').trim();
    try {
      if (!providerAccounts.supported()) throw new Error(providerAccounts.unsupportedReason());
      if (action === 'sync') {
        if (!accounts.has(qq)) throw new Error(`号 ${qq} 还没加进来 —— 先在「加一个 QQ 号」那里加它`);
        const r = providerAccounts.ensure(qq);
        if (!r.ok) throw new Error(r.reason);
        // ⚠️ 把接入点写进**这个号**的账号文件（不是共用的 config.yml）
        accounts.patch(qq, {
          onebot: {
            mode: 'forward',
            url: `ws://127.0.0.1:${r.port}`,
            accessToken: r.token,
            reconnectInterval: 3000,
          },
        });
        log.info(`协议端：号 ${qq} 配好 OneBot 端口 ${r.port}（${r.created ? '新建' : '已存在，token 已同步'}）`);
        return send(res, 200, { ok: true, qq, port: r.port, created: !!r.created, needRestart: true });
      }
      if (action === 'restart') {
        const r = await providerAccounts.restart();
        if (!r.ok) throw new Error(r.reason);
        log.info(`协议端已重启（${r.waitedMs} ms 后重新监听 ${r.port}），各号会自动重连`);
        return send(res, 200, { ok: true, port: r.port, waitedMs: r.waitedMs });
      }
      throw new Error(`不认识的 action：${action || '(空)'}`);
    } catch (e) {
      send(res, 400, { ok: false, error: e.message });
    }
  },

  /**
   * 「机器人池」手动同步一次（2026-10-07 用户要求）。
   *
   * ⚠️ 这个接口**不跟着"当前号"转发**（它是"管所有号"的接口，见前端 `api()` 的白名单）。
   * ⚠️ `dryRun` 只算不改，界面上有个「先看看会改什么」——
   *    因为这一下会改到**所有号**的按群设定，值得先看一眼。
   */
  'POST /api/pools/sync': async (req, res) => {
    let body = {};
    try {
      body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    } catch {
      return send(res, 400, { ok: false, error: '请求体不是合法 JSON' });
    }
    try {
      const r = pools.sync({ dryRun: !!body.dryRun });
      if (!body.dryRun && r.changed.length) {
        log.info(
          `机器人池同步（手动）：${r.changed.length} 个号 —— ` +
            r.changed.map((c) => `${c.qq} 同类+${c.peersAdded.length}/不同类+${c.otherAdded.length}`).join('，'),
        );
      }
      send(res, 200, { ...r, dryRun: !!body.dryRun });
    } catch (e) {
      send(res, 400, { ok: false, error: e.message });
    }
  },

  'GET /api/state': async (_req, res) => {
    const data = await queryServer(config.status.host, 0).catch((e) => ({ ok: false, error: e.message }));
    send(res, 200, {
      ok: true,
      config: configForUi(),
      problems: validate(),
      stats: {
      faces: faceTags().length,
        learned: listEntries().length,
        knowledge: hasKnowledge(),
      },
      learnedTopics: listEntries().map((e) => e.title),
      faces: facesWithMeta(),
      // ── 日常事件（一级）给界面的快照 ──
      // ⚠️ 2026-09-16：`status` / `plan` 是**按群**的（`st` 分桶了）。
      //    这里不给 groupId = `''` 那个桶（没有意义，只给界面当"全局默认"看），
      //    真正要显示某个群的进度，用下面 `byGroup` 或者 `/api/life/status?groupId=`。
      life: {
        config: { ...config.life },
        status: life.status(),
        plan: life.todayPlan(),
        byGroup: life.status().byGroup,
      },
      server: { ...data, text: describe(data, config.status.displayName) },
      files: { config: CONFIG_FILE, root: ROOT },
    });
  },

  'POST /api/config': async (req, res) => {
    const patch = JSON.parse((await readBody(req)).toString('utf8'));
    try {
      saveConfig(patch);
      send(res, 200, { ok: true, config: configForUi(), problems: validate() });
    } catch (e) {
      send(res, 400, { ok: false, error: e.message });
    }
  },

  /** 测试模型连通性（用界面当前填的值，不落盘） */
  /** 列出 API 上可用的模型（用于界面上的模型下拉框） */
  /* ════════════════════════════════════════════════════════════════
   * ⚠️ 2026-10-22 加：**多模型提供商 + 优先级排序 + 模型设定存档**
   *   用户原话：「给主模型加个**可保存之前的模型设定**并**新加一个模型提供商**的功能，
   *   再加一个**模型优先级卡片滑动排序**设置」
   *
   * ## 核心设计（别改）：**启用某个提供商 = 把它的值写回扁平字段**
   *   `bot.js` / `llm.js` 读的一直是 `llm.baseURL / apiKey / model / temperature…`
   *   ⇒ 这里只维护"多提供商"这一层，启用时**同步写扁平字段** ✓
   *     · 调用链一行都不用改
   *     · 也不会有"列表里是这个、实际用的是那个"的坑 ✗
   * ════════════════════════════════════════════════════════════════ */

  /** 列表 + 当前激活 + 档案 + 降级状态 */
  'GET /api/llm-providers': async (_req, res) => {
    const l = config.llm || {};
    let fo = null;
    try { fo = (await import('./llm.js')).llmFallbackStatus(); } catch { /* ignore */ }
    /* ⚠️⚠️ 2026-10-22 改（用户：「**把大模型那里本来有的设置直接全部剪切过来，
     *    api 配置也要剪切过来，不要搞丢了，然后排在模型提供商的第一个**」）
     *
     *    原来界面是**两张卡**：上面「大模型」（扁平那套）+ 下面「模型提供商」列表
     *    ⇒ 同一个地址/密钥填两遍，用户当场问「**为什么还要留两套一样的设置**」✗
     *
     *    现在只留「模型提供商」一张卡，**第一个就是主模型**。而 `providers` 还空着时
     *    （老配置就是这种情况），这里**把扁平那套原样搬成第 0 项**返回给界面 ——
     *    ⚠️ **只在内存里造，不写盘**：`saveConfig()` 是 `yaml.load + yaml.dump`，
     *       一写就会把 `config.yml` 里的注释全冲掉（那是用户自己维护的）✗
     *       等他点「保存列表」时再落盘 ✓
     *    ⚠️ apiKey **原样带过去**，绝不打码/清空（用户刚因为密钥被清掉报过一次 ✗） */
    const list = Array.isArray(l.providers) ? l.providers : [];
    const autoList = (!list.length && String(l.baseURL || '').trim())
      ? [{
          id: 'p-main',
          name: '主模型',
          baseURL: String(l.baseURL || '').replace(/\/+$/, ''),
          apiKey: String(l.apiKey || ''),
          model: String(l.model || ''),
          temperature: Number.isFinite(l.temperature) ? l.temperature : 1,
          maxTokens: Number.isFinite(l.maxTokens) ? l.maxTokens : 8000,
          timeout: Number.isFinite(l.timeout) ? l.timeout : 60000,
          auto: true,   // 界面据此提示"还没保存过"
        }]
      : [];
    send(res, 200, {
      ok: true,
      providers: list.length ? list : autoList,
      activeId: String(l.activeId || (list.length ? '' : 'p-main')),
      profiles: Array.isArray(l.profiles) ? l.profiles : [],
      /* ⚠️ 2026-10-22：**降级状态**（用户：「优先级在前的模型不可用，兜底自动使用后一级的
       *   模型 10 分钟，10 分钟之后自动重试」）—— 界面上要能看见现在降到哪一级、还剩多久 ✓ */
      fallback: fo,
      // 现在**实际在用**的那套（扁平字段）—— 界面上"当前生效"就显示它
      current: {
        baseURL: String(l.baseURL || ''),
        model: String(l.model || ''),
        apiKey: String(l.apiKey || ''),
        temperature: Number(l.temperature ?? 1),
        maxTokens: Number(l.maxTokens ?? 8000),
        timeout: Number(l.timeout ?? 60000),
      },
    });
  },

  /** 手动"立刻回主模型重试"（不用等满 10 分钟） */
  'POST /api/llm-fallback/reset': async (_req, res) => {
    try {
      const llm = await import('./llm.js');
      llm.llmFallbackReset();
      send(res, 200, { ok: true, fallback: llm.llmFallbackStatus() });
    } catch (e) {
      send(res, 200, { ok: false, error: e.message });
    }
  },

  /**
   * 保存提供商列表（**数组顺序 = 优先级，第 0 个就是主模型**，界面拖拽后整张表回传）
   * body: { providers: [...], activeId?: 'id' }
   *
   * ⚠️⚠️ 2026-10-22 改（用户：「**api 配置也要剪切过来，不要搞丢了**」）：
   *   · 每一项现在**也带** temperature / maxTokens / timeout（原来只存在扁平字段里）；
   *   · **apiKey 空 = 沿用原来的，绝不写空** —— 用户刚报过一次「你怎么把我的 api 删了」✗
   *     根因就是这里原来写 `patch.apiKey = hit.apiKey || ''`：启用一个没填密钥的提供商
   *     就把扁平那套的密钥冲成空串，界面上就是 401 / `api key is invalid` ✗
   *   · `activeId` 不再当"用哪个"的开关 —— **顺序即优先级**，恒等于第 0 项 ✓
   */
  'POST /api/llm-providers': async (req, res) => {
    try {
      const b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d);
      const clean = (Array.isArray(b.providers) ? b.providers : []).slice(0, 20).map((p, i) => ({
        id: String(p?.id || `p${i + 1}`).slice(0, 40),
        name: String(p?.name || `提供商 ${i + 1}`).slice(0, 40),
        baseURL: String(p?.baseURL || '').replace(/\/+$/, '').slice(0, 300),
        apiKey: String(p?.apiKey || '').slice(0, 400),
        model: String(p?.model || '').slice(0, 120),
        note: String(p?.note || '').slice(0, 200),
        /* ⚠️⚠️ 2026-10-22 加（用户：「**那个主模型如果是被限流报错的话，先换相同供应商正常模型**」）
         *    同一个 baseURL + 同一个 key 下的**备用模型**，限流时按顺序试，
         *    试完才跨到下一家供应商 ✓（界面上是逗号分隔的一行）
         *    ⚠️ 最多 8 个 —— 再多就不是"备用"了，那叫没有主模型 */
        fallbackModels: (Array.isArray(p?.fallbackModels)
          ? p.fallbackModels
          : String(p?.fallbackModels || '').split(/[,，、\n]/))
          .map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8),
        /* ⚠️ 2026-10-22：**跟着提供商一起存**（用户要把「大模型」那套整个剪切过来）。
         *    没填 = null ⇒ `llmCfg()` 里回落到扁平值 ✓ */
        temperature: Number.isFinite(Number(p?.temperature)) && p?.temperature !== '' ? Number(p.temperature) : null,
        maxTokens: Number.isFinite(Number(p?.maxTokens)) && p?.maxTokens !== '' ? Number(p.maxTokens) : null,
        timeout: Number.isFinite(Number(p?.timeout)) && p?.timeout !== '' ? Number(p.timeout) : null,
      }));
      // ⚠️ id 不许重复（重复会让"启用"点到别人头上）
      const seen = new Set();
      for (const p of clean) {
        if (seen.has(p.id)) p.id = `${p.id}-${Math.random().toString(36).slice(2, 6)}`;
        seen.add(p.id);
      }
      /* ⚠️⚠️ **密钥不许被空值冲掉**：某个提供商没填 apiKey、而它跟当前生效的那套
       *    是同一个地址 ⇒ 沿用原来的密钥（用户刚被清过一次）✓ */
      const cur = config.llm || {};
      for (const p of clean) {
        if (!p.apiKey && cur.apiKey && String(cur.baseURL || '').replace(/\/+$/, '') === p.baseURL) {
          p.apiKey = String(cur.apiKey);
        }
      }
      const patch = { providers: clean };
      const first = clean[0];
      if (first) {
        if (!first.baseURL) return send(res, 200, { ok: false, error: `第 1 个（主模型）「${first.name}」没填 baseURL` });
        /* ⚠️ 第 1 个 = 主模型 ⇒ **同步写扁平字段**（`bot.js` / `llm.js` 读的就是这几个）。
         *    顺序即优先级，所以这里不再看 `activeId` 指谁 ✓ */
        patch.activeId = first.id;
        patch.baseURL = first.baseURL;
        patch.model = first.model || '';
        if (first.apiKey) patch.apiKey = first.apiKey;          // ⚠️ 空就**不动**原来的
        if (first.temperature != null) patch.temperature = first.temperature;
        if (first.maxTokens != null) patch.maxTokens = first.maxTokens;
        if (first.timeout != null) patch.timeout = first.timeout;
      } else {
        patch.activeId = '';
      }
      saveConfig({ llm: patch });
      /* ⚠️⚠️ 2026-10-22 加（真 bug：改完顺序还在用旧的降级目标）：
       *    `FO.level` 是**内存里的序号**（第几级），而这里刚把数组**重新排过** ⇒
       *    原来的 level=1 可能从「第二个」变成了「第三个」，甚至变成刚修好的那个 ✗
       *    实测现场：用户把主模型拖回第一位，界面显示主模型是 DeepSeek（能用），
       *    但 `FO.level` 还停在 1 ⇒ **实际仍在用那个 400 的中转站** ⇒ 聊天全挂 ✗
       *    ⇒ 保存列表 = "我改好了，重新试" ⇒ **顺手把降级复位** ✓ */
      try {
        const llmMod = await import('./llm.js');
        llmMod.llmFallbackReset();
        log.info('[模型] 提供商列表已保存 ⇒ 降级状态复位（下次调用就用第 1 个）');
      } catch { /* ignore */ }
      log.info(`[模型] 提供商已保存：${clean.length} 个，主模型=${first ? `${first.name}（${first.model || '?'}）` : '(无)'}`);
      send(res, 200, { ok: true, providers: clean, activeId: patch.activeId ?? config.llm.activeId });
    } catch (e) {
      send(res, 200, { ok: false, error: e.message });
    }
  },

  /**
   * 存一份「模型设定」快照（用户：「**可保存之前的模型设定**」）
   * body: { name }
   * ⚠️ 快照里**带上整套 providers + activeId + 扁平字段** ⇒ 切回去时一模一样 ✓
   */
  'POST /api/llm-profiles/save': async (req, res) => {
    try {
      const b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const name = String(b.name || '').trim().slice(0, 40);
      if (!name) return send(res, 200, { ok: false, error: '给这份设定起个名字' });
      const l = config.llm || {};
      const snap = {
        name,
        savedAt: Date.now(),
        providers: JSON.parse(JSON.stringify(Array.isArray(l.providers) ? l.providers : [])),
        activeId: String(l.activeId || ''),
        baseURL: String(l.baseURL || ''),
        apiKey: String(l.apiKey || ''),
        model: String(l.model || ''),
        temperature: Number(l.temperature ?? 1),
        maxTokens: Number(l.maxTokens ?? 8000),
        timeout: Number(l.timeout ?? 60000),
      };
      const list = (Array.isArray(l.profiles) ? l.profiles : []).filter((x) => x?.name !== name);
      list.unshift(snap);
      saveConfig({ llm: { profiles: list.slice(0, 20) } });
      log.info(`[模型] 存了一份设定「${name}」（${snap.providers.length} 个提供商）`);
      send(res, 200, { ok: true, profiles: list.slice(0, 20) });
    } catch (e) {
      send(res, 200, { ok: false, error: e.message });
    }
  },

  /** 载入某份设定（整份覆盖回来） */
  'POST /api/llm-profiles/load': async (req, res) => {
    try {
      const b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const name = String(b.name || '').trim();
      const l = config.llm || {};
      const hit = (Array.isArray(l.profiles) ? l.profiles : []).find((x) => x?.name === name);
      if (!hit) return send(res, 200, { ok: false, error: `没有这份设定：${name}` });
      saveConfig({
        llm: {
          providers: hit.providers || [],
          activeId: hit.activeId || '',
          baseURL: hit.baseURL || config.llm.baseURL,
          apiKey: hit.apiKey || '',
          model: hit.model || '',
          temperature: Number.isFinite(hit.temperature) ? hit.temperature : config.llm.temperature,
          maxTokens: Number.isFinite(hit.maxTokens) ? hit.maxTokens : config.llm.maxTokens,
          timeout: Number.isFinite(hit.timeout) ? hit.timeout : config.llm.timeout,
        },
      });
      log.info(`[模型] 载入设定「${name}」⇒ 现在用 ${hit.model}（${hit.baseURL}）`);
      send(res, 200, { ok: true, applied: hit });
    } catch (e) {
      send(res, 200, { ok: false, error: e.message });
    }
  },

  /** 删一份设定 */
  'POST /api/llm-profiles/delete': async (req, res) => {
    try {
      const b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const name = String(b.name || '').trim();
      const l = config.llm || {};
      const list = (Array.isArray(l.profiles) ? l.profiles : []).filter((x) => x?.name !== name);
      saveConfig({ llm: { profiles: list } });
      send(res, 200, { ok: true, profiles: list });
    } catch (e) {
      send(res, 200, { ok: false, error: e.message });
    }
  },

  'POST /api/models': async (req, res) => {
    const t = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    // 界面上可能改了 baseURL / apiKey 还没保存，所以以传来的为准
    const baseURL = String(t.baseURL ?? config.llm.baseURL ?? '').replace(/\/+$/, '');
    const apiKey = String(t.apiKey ?? config.llm.apiKey ?? '');
    if (!baseURL) return send(res, 200, { ok: false, error: 'baseURL 是空的' });

    try {
      // ⚠️⚠️ 2026-10-09 修（用户：「**为什么拉取失败了**」）：
      //    这里原来是**裸 `fetch`** —— 它**不走项目那套代理逻辑**（`llmFetch` 才有：
      //    "走代理，代理失败自动换直连"）⇒ 换成 Gemini（`generativelanguage.googleapis.com`）
      //    这种**国内必须走代理**的地址，裸 fetch 必然 `fetch failed` ✗
      //    ⇒ 换成 `llmFetch`（和真正聊天用的是同一条网络出口 ✓）
      const r = await llmFetch(`${baseURL}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        /* ⚠️ 2026-10-22：20 秒 → 45 秒。
         *    `llmFetch` 会**先试全局出口**（现在这台是代理），代理连不上这家（国内中转站）
         *    时会先耗掉一段才换直连 —— 20 秒不够 ⇒ 界面上「拉列表」永远报 `fetch failed`，
         *    而同一时刻裸直连是 200 ✗（实测：`/v1/models` 直连 200、走 webui 这条路失败） */
        signal: AbortSignal.timeout(45000),
      });
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        return send(res, 200, {
          ok: false,
          error: `HTTP ${r.status}${body ? ` —— ${body.slice(0, 200)}` : ''}`,
        });
      }
      const j = await r.json();
      const list = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
      const models = list
        .map((m) => (typeof m === 'string' ? m : (m.id ?? m.name ?? m.model)))
        .filter((x) => typeof x === 'string' && x.trim())
        .map((x) => x.trim())
        .sort();
      log.info(`列出模型：${models.length} 个（${baseURL}）`);
      send(res, 200, { ok: true, models, baseURL });
    } catch (e) {
      send(res, 200, { ok: false, error: e.message });
    }
  },

  'POST /api/test-llm': async (req, res) => {
    const t = JSON.parse((await readBody(req)).toString('utf8'));
    const started = Date.now();
    try {
      /* ⚠️⚠️ 2026-10-22 改（真 bug：界面上的「测试连通性」测的不是你填的那套）：
       *    原来是 `Object.assign(config.llm, t.llm)` 然后 `ping()` —— 可 `ping()` 内部走
       *    `llmCfg()`，而 `providers` 非空时**chain[0] 会把 baseURL/model 盖掉** ⇒
       *    测第二个提供商其实测的是第一个，降级时测的还是第三个 ✗
       *    实测后果：用户填了个免费账号用不了的模型，点测试全绿，真发消息才 400 ✗
       *    ⇒ 改成把要测的那套**直接交给 `ping(over)`**，不碰全局配置、不碰降级状态 ✓ */
      const over = (t && t.llm && typeof t.llm === 'object') ? t.llm : null;
      const reply = await ping(over);
      send(res, 200, { ok: true, ms: Date.now() - started, reply: String(reply).trim().slice(0, 60) });
    } catch (e) {
      send(res, 200, { ok: false, error: e.message });
    }
  },

  /**
   * 生图可选的模型列表 = **内置候选 ∪ 平台 `/models`**（2026-09-22，用户要求「自动拉取列表选择」）。
   *
   * ⚠️ 为什么**两条路都要走**：`/models` 不是所有生图平台都实现，而且
   *    **火山方舟的模型还要先在控制台开通**才会出现在列表里。
   *    拉不到时下拉框不能是空的 —— 否则用户只能去翻文档手抄
   *    `doubao-seedream-4-0-250828` 这种带日期后缀的 id（抄错一个字符就是"模型不存在"）。
   * ⚠️ 返回的是一整份清单（硅基流动上百个聊天+生图模型混在一起），
   *    所以把"看起来是生图的"排到前面 —— 界面用 `<datalist>`，打字时浏览器自己会过滤。
   */
  'POST /api/imagegen/models': async (req, res) => {
    const t = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const over = t.imagegen ?? {};
    const pre = imagegen.presets(over);
    const baseURL = String(over.baseURL ?? '').trim().replace(/\/+$/, '') || pre.baseURL;
    const apiKey = String(over.apiKey ?? '').trim();

    let live = [];
    let error = '';
    if (baseURL && apiKey) {
      try {
        const r = await llmFetch(`${baseURL}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(15000),
        });
        if (r.ok) {
          const j = await r.json();
          const list = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
          live = list
            .map((m) => (typeof m === 'string' ? m : (m.id ?? m.name ?? m.model)))
            .filter((x) => typeof x === 'string' && x.trim())
            .map((x) => x.trim());
        } else {
          error = `HTTP ${r.status}`;
        }
      } catch (e) {
        error = e.message;
      }
    }

    const looksImage =
      /image|seedream|seededit|wanx|kolors|flux|stable-?diffusion|sdxl|dall|gpt-image|imagen|painting|draw|sd3/i;
    const ordered = [...new Set([...pre.models, ...live.filter((m) => looksImage.test(m)), ...live])];

    log.info(
      `生图模型列表：内置 ${pre.models.length} + 平台 ${live.length}（${baseURL || '没填地址'}）` +
        `${error ? `，平台那边失败（${error}）` : ''}`,
    );
    // ⚠️ 平台失败**不算整体失败** —— 内置候选照旧可用，所以把原因单独带回去给界面提示
    send(res, 200, {
      ok: true,
      provider: pre.provider,
      baseURL,
      models: ordered,
      builtin: pre.models.length,
      live: live.length,
      error,
    });
  },

  /**
   * 生图缓存：查占用 / 立即清理（2026-09-22 用户要求「图片越积越多，发出 1 天之后删掉」）。
   *
   * ⚠️ `dryRun: true` = **只统计不删**（界面一进「模型」页就用它显示占用）。
   *    实现方式是拿一个"保留期无穷大"跑一遍 sweep —— 什么都不算过期，自然一张不删。
   * ⚠️ 只动 `library/photo/`；`library/` 根目录是**表情库**，绝不碰。
   */
  'POST /api/imagegen/cache': async (req, res) => {
    const t = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const keepHours = Number(config.imagegen?.keepHours ?? 24);
    if (t.dryRun) {
      const s = imagegen.sweep(Number.MAX_SAFE_INTEGER);
      return send(res, 200, { ok: true, dryRun: true, count: s.kept, bytes: s.keptBytes, keepHours });
    }
    const s = imagegen.sweep();
    send(res, 200, {
      ok: true,
      enabled: s.enabled,
      removed: s.removed,
      freedBytes: s.freedBytes,
      count: s.kept,
      bytes: s.keptBytes,
      keepHours,
    });
  },

  /**
   * 测试生图 —— ⚠️ **会真的出一张图**（火山方舟 0.20 元/张），界面上写明了。
   *
   * 为什么不做成"只测连通性"：生图的失败模式几乎全在**提示词 / 参考图 / 平台审核**上，
   * 单测一个 `/models` 什么也证明不了。真出一张、直接回给界面预览，
   * 用户点一下就能判断「像不像她」—— 这比任何 ping 都有信息量。
   */
  'POST /api/imagegen/test': async (req, res) => {
    const t = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (!imagegen.ready(t.imagegen).ok) {
      const why = imagegen.ready(t.imagegen).why;
      return send(res, 200, { ok: false, reason: 'off', error: why, hint: imagegen.hint('off') });
    }
    // ⚠️⚠️ **界面测试必须走和群里完全相同的这条路** ——
    //    否则用户在界面上调半天提示词，群里实际用的是另一套 ✗
    //    ⚠️ 2026-09-22 改成：这里也**先跑一次"理解"**、时间地点也取**真实状态**。
    //       所以界面上那个输入框 = **"假装群友说的那句话"**（例：拍张你现在的样子）。
    const nowAt = new Date();
    const hh = nowAt.getHours();
    const period =
      hh < 5 ? '深夜' : hh < 8 ? '清晨' : hh < 11 ? '上午' : hh < 13 ? '中午' : hh < 17 ? '下午' : hh < 19 ? '傍晚' : hh < 23 ? '晚上' : '深夜';
    const facts = {
      now: `${String(hh).padStart(2, '0')}:${String(nowAt.getMinutes()).padStart(2, '0')}（${period}）`,
      // 和 `bot.js` 的 `runPhoto()` 用**同一个**来源（含覆盖/日程一致性检查）
      where: whereNow(nowAt).where,
    };
    // 界面上可以强制"有她 / 没有她 / 让理解自己判断"（对应三种标记写法）
    const kind = String(t.kind ?? 'auto');
    const marker =
      kind === 'self'
        ? { raw: '[拍照]', withSelf: true, scene: '' }
        : kind === 'scene'
          ? { raw: '[拍]', withSelf: false, scene: '' }
          : null;
    const text = String(t.prompt ?? '').trim() || '拍张照片看看，你现在什么样';
    const picked = await photoPlan.plan({ text, said: '', marker, facts });
    const withSelf = picked.withSelf;
    // ⚠️ 2026-10-02：`refs` 先算 —— 拼提示词时要告诉它这次带没带参考图
    //    （带了就在提示词里指认参考图里的那个女孩，见 `imagegen.buildPrompt`）。
    const refs = withSelf ? persona.refImages() : [];
    const prompt = imagegen.buildPrompt({
      what: picked.what,
      withSelf,
      time: picked.time || facts.now,
      place: picked.place || facts.where,
      hasRef: refs.length > 0,
    });
    const r = await imagegen.generate({ prompt, refs, expectRef: withSelf, over: t.imagegen ?? {} });
    if (!r.ok) {
      // ⚠️ 两条信息**分开**给（2026-09-22 实测踩到 `ModelNotOpen` 之后改的）：
      //    · `error` —— 角色口吻那句，和群里听到的一致（方便用户对上号）
      //    · `hint`  —— **给管理员的下一步**（「去控制台开通这个模型」这种，
      //                 群里永远不会看到）
      //    · 真实错误码仍然只进 `logs/bot.log`，**不回给界面**（用户说不要看到故障码）
      return send(res, 200, {
        ok: false,
        reason: r.reason,
        error: imagegen.deflect(r.reason),
        hint: imagegen.hint(r.reason),
      });
    }
    send(res, 200, {
      ok: true,
      ms: r.ms,
      file: r.file,
      withSelf,
      // ⚠️ 把"理解成了什么"和"最终提示词"回给界面 —— 调画风/调场景时**只有看得见才调得动**
      picked,
      facts,
      prompt,
      // ⚠️ 参考图是"像不像她"的唯一保证 —— 没配就**明确告诉用户**，
      //    否则他看到一张不像的图会以为是模型不行（真因是没传立绘）。
      //    ⚠️ 拍景物那条**本来就不带**参考图，别在这儿报"没有参考图"吓人。
      refNames: refs.map((f) => String(f).split(/[\\/]/).pop()),
      // 只在本地回环上把预览图回给界面，不额外落一份
      dataUrl: imagegen.toDataUrl(r.file),
    });
  },

  'POST /api/test-server': async (_req, res) => {
    clearCache();
    const d = await queryServer(config.status.host, 0);
    send(res, 200, { ok: d.ok, text: describe(d, config.status.displayName), raw: d });
  },

  'POST /api/faces': async (req, res) => {
    const b = JSON.parse((await readBody(req)).toString('utf8'));

    if (b.action === 'delete') {
      const idx = readIndex();
      const f = (idx.faces ?? []).find((x) => x.tag === b.tag);
      if (f) {
        const p = join(LIB, f.file);
        if (existsSync(p)) unlinkSync(p);
        idx.faces = idx.faces.filter((x) => x.tag !== b.tag);
        writeIndex(idx);
      }
      return send(res, 200, { ok: true, faces: facesWithMeta() });
    }

    if (b.action === 'update' || b.action === 'add') {
      const tag = String(b.tag ?? '').trim();
      if (!tag) return send(res, 400, { ok: false, error: '标签不能为空' });
      const idx = readIndex();
      idx.faces = idx.faces ?? [];
      const i = idx.faces.findIndex((x) => x.tag === (b.oldTag ?? tag));
      const when = String(b.when ?? '').trim();
      const entry = {
        tag,
        file: String(b.file ?? idx.faces[i]?.file ?? '').trim(),
        who: String(b.who ?? idx.faces[i]?.who ?? '').trim(),
        when,
        desc: String(b.desc ?? idx.faces[i]?.desc ?? '').trim(),
      };
      if (!entry.file) return send(res, 400, { ok: false, error: '缺少文件名（请先上传图片）' });
      // 「适用场合」填了就说明完善过了，清掉待办标记
      if (when) delete entry._未完善;
      else entry._未完善 = true;
      if (i === -1) idx.faces.push(entry);
      else idx.faces[i] = entry;
      writeIndex(idx);
      return send(res, 200, { ok: true, faces: facesWithMeta() });
    }

    send(res, 400, { ok: false, error: '未知操作' });
  },

  /** 上传图片（原始二进制，用 query 传文件名） */
  'POST /api/upload': async (req, res, url) => {
    const name = String(url.searchParams.get('name') ?? '').trim();
    if (!name) return send(res, 400, { ok: false, error: '缺少 name 参数' });

    const ext = extname(name).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
      return send(res, 400, { ok: false, error: `不支持的格式 ${ext}` });
    }

    const buf = await readBody(req);
    if (!buf.length) return send(res, 400, { ok: false, error: '文件是空的' });

    // 只留安全字符，避免路径穿越
    const safe = basename(name).replace(/[^\w.\-]/g, '_');
    const dest = join(LIB, safe);
    mkdirSync(LIB, { recursive: true });
    writeFileSync(dest, buf);
    log.info(`管理界面上传表情: ${safe}（${(buf.length / 1024).toFixed(1)} KB）`);
    send(res, 200, { ok: true, file: safe, bytes: buf.length });
  },

  /** 列出 knowledge/ 下的知识文件（界面动态生成下拉框，加文件不用改代码） */
  // ── QQ 登录状态 / 二维码 ──────────────────────────────
  //
  // 为什么在管理界面做这个：QQ 掉线时要「重新扫码」，
  // 以前得去任务栏翻 NapCat 窗口（还是最小化的），很别扭。
  // 现在网页上直接看状态、点一下出码。
  //
  // 数据来源是 NapCat 自己的管理接口（默认 6099，见 src/napcat.js），
  // 不是 OneBot（3001）—— OneBot 管不了登录。
  'GET /api/qq/status': async (_req, res) => {
    // ⚠️ 2026-09-17 起这里**按协议端分派**：只有 NapCat 有那套 HTTP 管理接口。
    //    换成 LLBot / 通用实现时，`napcat.describe()` 只会一直连不上（白等 15 秒），
    //    所以先问 provider 支不支持，不支持就如实说"看 OneBot 侧那张卡片"。
    const pv = provider.info();
    const canStatus = provider.can('status');
    const st = canStatus
      ? await napcat.describe().catch((e) => ({ configured: false, reachable: false, error: e.message }))
      : {
          configured: false,
          reachable: false,
          unsupported: true,
          error: provider.unsupported('status'),
        };
    // 顺带把「端口在不在听」也报给界面 —— 界面靠它决定按钮是「启动」还是「重启」
    const up = canStatus || provider.can('launch')
      ? await napcat.running().catch(() => ({ onebot: false, webui: false }))
      : { onebot: false, webui: false };

    // 顺便报 OneBot 侧的真实在线状态：**两边都看才准**。
    // ⚠️ 这一段是**协议端无关**的（OneBot 标准 action），所以换谁都能用 —— 这也是换协议端最靠得住的信息来源。
    let onebot = null;
    if (bot?.call) {
      try {
        const s = await bot.call('get_status');
        const info = await bot.call('get_login_info').catch(() => null);
        onebot = {
          online: s?.online === true,
          good: s?.good === true,
          qq: info?.user_id ? String(info.user_id) : '',
          nickname: info?.nickname ?? '',
        };
      } catch (e) {
        onebot = { online: false, error: e.message };
      }
    }
    send(res, 200, {
      ok: true,
      provider: pv,
      napcat: st,
      ports: up,
      running: up.onebot || up.webui,
      onebot,
    });
  },

  // 出二维码。
  //
  // ⚠️⚠️ 2026-09-15 重写。用户反馈：「**webui 那个码就没扫成功过**，
  //    那个**重新出码也一直不出**」。两个原因都是真的：
  //
  //   ① **拿到的是过期快照，从来没刷新过。**
  //      `napcat.getQrcode()` 走的是 `GetQQLoginQrcode`，而那个接口
  //      **只是把缓存里的 URL 读出来**（`ve.getQQLoginQrcodeURL()`），
  //      **不会重出**。缓存是上一次 `onQRCodeGetPicture` 存的快照，
  //      而二维码几分钟就死 —— 所以画出来的十有八九是一张死码。
  //      （原来这里的注释写着"最新、不会过期到离谱"，**是错的**。）
  //
  //   ② **低分辨率 + 最近邻放大。** NapCat 自己那张 `cache/qrcode.png`
  //      只有 **147×147**，而界面上按 280px 显示还加了
  //      `image-rendering: pixelated` → 模块被拉得不均匀，扫不出来。
  //
  // 现在：
  //   · `?fresh=1`（点「显示二维码」时带的）→ **先调 `RefreshQRcode` 重出一张**，
  //     等 1.2 秒让 `onQRCodeGetPicture` 把图和 URL 落下来，再返回；
  //   · 没文件、或 NapCat 自己说「二维码已过期，请刷新」→ 也自动重出；
  //   · **优先返回 NapCat 写的那张原图**（QQ 给的就是它，最不会错），
  //     没有才退回自己按 URL 画（画得更大更清楚，见下面的 width/margin）。
  'GET /api/qq/qrcode.png': async (req, res) => {
    try {
      // ⚠️ 换协议端之后，出码这套是 NapCat 专属的（LLBot 在它自己的界面里出码）
      if (!provider.can('qrcode')) {
        return send(res, 409, { ok: false, error: provider.unsupported('qrcode') });
      }
      const url = String(req?.url ?? '');
      const wantFresh = /[?&]fresh=1/.test(url);

      // ⚠️ 2026-09-20：**按协议端分派** —— LLBot 那边也提供了同形状的三个函数
      //    （`src/llbot.js`：读它自己写的 `login-qrcode.png`），所以这段逻辑两边通用，
      //    不用写两份（用户要求「二维码要和之前一样能在 webui 自动刷新」）。
      const qs = provider.name() === 'llonebot' ? llbot : napcat;
      const isLlbot = provider.name() === 'llonebot';

      // ⚠️⚠️ 2026-09-20 修（用户截图报的：界面显示「已经登录了」、下面是张破图 +
      //    「已生成新码，扫吧。」，而实际上**离线、且根本没码**）：
      //    **不能用"码图旧不旧"推断登录**。LLBot 连着出 10 张码没人扫就会
      //    **自己停止出码**（日志原话：`已自动刷新 10 张二维码仍未登录, 停止自动刷新`），
      //    那时码图很旧、而它**根本没登录** → 旧逻辑会说「QQ 已经登录了，不需要扫码」✗
      //    ⇒ 改成先问 **OneBot 的真实状态**：`get_status().online`
      //      （标准 action、协议端无关 —— 这才是"能不能收消息"的真话）。
      let onlineNow = null;
      if (bot?.call) {
        onlineNow = await bot
          .call('get_status')
          .then((s) => s?.online === true)
          .catch(() => null);
      }
      if (onlineNow === true) {
        return send(res, 409, { ok: false, error: 'QQ 已经登录了，不需要扫码' });
      }
      // 拿不到 online（连接刚断等）才退回各协议端自己的判断
      if (onlineNow === null) {
        const st0 = await qs.loginStatus().catch(() => null);
        if (st0?.ok && st0.isLogin === true) {
          return send(res, 409, { ok: false, error: 'QQ 已经登录了，不需要扫码' });
        }
      }
      // LLBot 明确**离线**、而且那张码已经旧了 → 它就是"停止出码"了。
      // 必须如实说清楚 + 给出下一步（去它自己的界面点刷新），别让界面挂一张破图。
      if (isLlbot && onlineNow === false) {
        const f0 = qs.qrcodeFile();
        if (!f0 || f0.stale) {
          return send(res, 409, { ok: false, error: llbot.STOPPED_HINT });
        }
      }

      const st = await qs.loginStatus().catch(() => null);

      // ⚠️ 2026-09-17：**协议端没在跑就别发码**。
      //    以前这里会把缓存的旧图直接发出去 —— 那是**上次留下的旧码**，
      //    几分钟就死了，用户扫半天扫不动（「这码就没扫成功过」的一部分原因）。
      if (!st?.ok) {
        return send(res, 503, { ok: false, error: `${provider.info().label} 没在运行 —— 先把它启动起来` });
      }

      const expired = /过期|刷新/.test(String(st?.loginError ?? ''));
      const before = qs.qrcodeFile();
      if (wantFresh || expired || !before) {
        const r = await qs.refreshQrcode().catch((e) => ({ ok: false, message: e.message }));
        log.debug(`二维码：请求重出 fresh=${wantFresh} expired=${expired} 无文件=${!before} → ${r.ok ? '已发出' : r.message}`);
        // ⚠️ NapCat 那边是"调接口让它重出"、要等它写完文件；
        //    LLBot 自己每约 2 分钟轮换一张，等这一下没坏处（也别去催它的节奏）。
        if (r.ok) await new Promise((s) => setTimeout(s, 1200));
      }

      // ① 优先协议端自己写的原图（**太旧的不要**，见 qrcodeFile() 里的 stale）
      const f = qs.qrcodeFile();
      if (f && !f.stale) return sendBinary(res, 200, readFileSync(f.path), 'image/png');

      // ② 退回：按缓存 URL 自己画
      //    ⚠️ 但那 URL 就是上面那张旧图的同一个快照 —— 图都过期了，画出来也是死码，
      //       所以 stale 的时候宁可说"没有"，别给用户一张扫不动的图（2026-09-17）。
      //    ⚠️ LLBot 没有这个备用方式（它只落图、不给链接）→ 如实说没有。
      const q = qs.getQrcode
        ? await qs.getQrcode()
        : { ok: false, message: '这个协议端不提供备用出码方式' };
      if (q.ok && q.qrcodeUrl && !f?.stale) {
        const buf = await QR.toBuffer(q.qrcodeUrl, {
          // ⚠️ 画大一点、留足静区：界面上按 280px 显示时才有足够像素/模块
          //    （原来 width:420 / margin:1 / 再被 pixelated 最近邻缩放 → 会糊）
          width: 640,
          margin: 2,
          errorCorrectionLevel: 'M',
        });
        return sendBinary(res, 200, buf, 'image/png');
      }
      return send(res, 404, {
        ok: false,
        error: q.message ?? (f?.stale ? '缓存里那张码已经过期了，重新出码也没成功' : '暂时拿不到二维码'),
      });
    } catch (e) {
      send(res, 500, { ok: false, error: e.message });
    }
  },

  // 轻量「重新出码」：**只是让协议端重出一张**（NapCat 走 `RefreshQRcode`）。
  //
  // ⚠️ 原来界面上的「重新出码」调的是 `/api/qq/restart` → `RestartNapCat`，
  //    那是**重启整个 NapCat 进程** = 一次 QQ 登录（风控信号）+ 等 20 秒，
  //    而且新实例还没把码生成出来界面就去取了 → 「一直不出」。
  //    重出二维码是个轻活，用轻接口。
  //
  // ⚠️⚠️ 2026-09-20 修 —— **这是个真 bug，是 `test/provider.js` 抓出来的**：
  //    这里原来是**硬编码 `napcat`** 的。换成 LLBot 之后
  //    `provider.can('refreshQr')` 是 **true**（LLBot 也支持出码，见 `src/llbot.js`），
  //    于是这条路由直接去调 `napcat.refreshQrcode()` → 请求 NapCat 的 6099 →
  //    界面上点「重新出码」得到的就是一句 **`fetch failed`**。
  //    ⇒ 和上面 `qrcode.png` 那条路由一样**按协议端分派**
  //      （三个函数的形状两边一致，所以分派完这段逻辑通用）。
  'POST /api/qq/refresh-qr': async (_req, res) => {
    if (!provider.can('refreshQr')) {
      return send(res, 200, { ok: false, message: provider.unsupported('refreshQr'), hasImage: false });
    }
    const qs = provider.name() === 'llonebot' ? llbot : napcat;
    const r = await qs.refreshQrcode().catch((e) => ({ ok: false, message: e.message }));
    log.info(`管理界面请求重新出码：${r.ok ? 'ok' : r.message}`);
    if (r.ok) await new Promise((s) => setTimeout(s, 1200));
    const f = qs.qrcodeFile();
    send(res, 200, { ok: r.ok, message: r.message ?? '', hasImage: !!f && !f.stale });
  },

  // ⚠️⚠️ 2026-09-20 加（用户要求：「webui 加一个重启机器人的」+「要能成功切换端口」）。
  //
  //    这是**重启机器人**（= 按当前 `config.yml` 重新连一次协议端），
  //    **不是重启协议端** —— 两者完全不同，别混：
  //      · 重启机器人：SnowLuma / LLBot 都支持（就是重连 3001），**不涉及 QQ 登录**
  //      · 重启协议端：SnowLuma 压根没有这个接口（见 provider.can('restart')）
  //
  //    为什么必须有它：**改完配置必须重启机器人才生效**（provider / onebot / 各种
  //    config 都是启动时读的）—— 而"切换协议端"就在这个界面上，切完如果不能一键
  //    重启，就等于**切换没成功**（用户的原话就是「要能成功切换端口」）。
  //
  //    ⚠️ 实现必须交给**独立进程**：这个路由所在的进程马上就要被它杀掉。
  //      `spawn(..., {detached:true}).unref()` + `cmd /c start` 两层保险。
  //      ⚠️ 别改成 `Start-Process` 或 `execFile` 同步等 —— 那会把自己等死。
  'POST /api/bot/restart': async (_req, res) => {
    send(res, 200, {
      ok: true,
      message: '正在重启机器人…约 15~30 秒后自己回来（页面刷新一下就能重新连上）',
    });
    try {
      const script = join(ROOT, 'tools', 'restart-bot.ps1');
      spawn(
        'cmd.exe',
        ['/c', 'start', '', '/min', 'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
        { detached: true, stdio: 'ignore', cwd: ROOT },
      ).unref();
      log.info('管理界面请求重启机器人（restart-bot.ps1，独立进程）');
    } catch (e) {
      log.error(`重启机器人失败：${e.message}`);
    }
  },

  // 把一条**语音消息**转成文字 —— QQ 官方的 `translatePtt2Text`（NapCat 的 `fetch_ptt_text`）。
  //
  // ⚠️ 2026-09-18 加：用户问「语音转文字有 QQ 官方的对吧」→ **有**，而且**不花钱**
  //    （走 QQ 客户端自己的 MsgService，不是第三方 ASR —— 源码 `napcat.mjs:80296`）。
  //    加这个**只读**接口是为了先验证这条路通不通（真发一条语音、拿 message_id 调一下
  //    看返回什么），通了再决定要不要接进"她听懂语音"的流程。
  // ⚠️ 不改任何状态：只是问 NapCat 要一下转写结果。
  'GET /api/qq/ptt-text': async (req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      const id = String(u.searchParams.get('messageId') ?? '').trim();
      if (!id) return send(res, 200, { ok: false, error: '缺少 messageId' });
      const r = await bot.call('fetch_ptt_text', { message_id: /^\d+$/.test(id) ? Number(id) : id });
      send(res, 200, { ok: true, result: r });
    } catch (e) {
      send(res, 200, { ok: false, error: e.message });
    }
  },

  // 让 NapCat 重启（掉线后重新出码）。会断一下 OneBot 连接，看门狗/机器人会自己重连。
  //
  // ⚠️⚠️ 2026-09-17 修（用户报「**重启 NapCat 按钮还是没用，那两个窗口没动静**」）：
  //    这个按钮原来是**死的** —— 它只会调 NapCat 自己的 `RestartNapCat` 接口，
  //    而 NapCat 没跑的时候那个请求必然 ECONNREFUSED（界面弹「重启失败: fetch failed」），
  //    **点多少遍都不会有窗口出来**。现在先看端口：
  //      · 6099 在听  → 真的重启它；
  //      · 6099 不在、3001 在 → NapCat 在跑但管理接口连不上，如实说，不乱来；
  //      · 两个都不在 → **走 `napcat.launch()` 把窗口启动起来**（这才是用户想要的效果）。
  'POST /api/qq/restart': async (_req, res) => {
    // 换协议端之后「重启」就不归我们管了：LLBot 在它自己的界面里重连/重启
    if (!provider.can('restart')) {
      // ⚠️ 但"启动"还是能做的（只要配了 provider.launcher）—— 别把用户堵死
      if (provider.can('launch')) {
        const r = await napcat.launch();
        log.info(`管理界面请求重启协议端：当前是 ${provider.info().label}，不支持重启 → 改成启动`);
        return send(res, 200, { ok: r.ok, launched: true, message: r.message });
      }
      return send(res, 200, { ok: false, message: provider.unsupported('restart') });
    }
    const up = await napcat.running();
    if (!up.webui && !up.onebot) {
      log.info('管理界面请求重启 NapCat：它压根没在跑 → 改成「启动」');
      const r = await napcat.launch();
      log.info(`启动 NapCat：${r.message}`);
      return send(res, 200, { ok: r.ok, launched: true, message: r.message });
    }
    if (!up.webui) {
      return send(res, 200, {
        ok: false,
        message: 'NapCat 在跑，但它的管理接口（6099）连不上，重启不了 —— 去任务栏点开 NapCat 窗口看看',
      });
    }
    const r = await napcat.restart();
    log.info(`管理界面请求重启 NapCat：${r.message}`);
    send(res, 200, { ok: r.ok, message: r.message });
  },

  // 显式「启动协议端」：界面在它没跑的时候用这个（窗口会开出来，登录态失效就扫码）
  'POST /api/qq/launch': async (_req, res) => {
    if (!provider.can('launch')) {
      return send(res, 200, { ok: false, message: provider.unsupported('launch') });
    }
    const r = await napcat.launch();
    log.info(`管理界面请求启动协议端：${r.message}`);
    send(res, 200, { ok: r.ok, launched: !!r.launched, already: !!r.already, message: r.message });
  },

  // 自动恢复：**先试快速登录（免扫码），不行再出二维码**。
  // 这是掉线后最省事的按钮 —— 大部分情况根本不用扫。⚠️ 只对 NapCat 有效。
  'POST /api/qq/recover': async (_req, res) => {
    if (!provider.can('autoRecover')) {
      return send(res, 200, { ok: true, recovered: false, message: provider.unsupported('autoRecover') });
    }
    const r = await napcat.autoRecover().catch((e) => ({ recovered: false, message: e.message }));
    log.info(`管理界面请求自动恢复 QQ 登录：${r.message}`);
    send(res, 200, { ok: true, ...r });
  },

  // ── 二级剧情（任务系统）──────────────────────────────
  //
  // 用户要求（2026-09-15）：
  //   「再加一个二级事件自定输入框，下方加入一个立即开始剧情和一个替换下次二级事件的按钮。
  //     再加一个二级事件剧情过程模拟测试……开始之后可以在框内模拟输入群友说的话，
  //     然后可以点发送并生成下一阶段剧情直到剧情结束，
  //     然后展示此次全部模拟写下的故事线。」

  /**
   * 界面上要看的：真实剧情状态 + 模拟状态。
   * ⚠️ 2026-09-15 分群：可以带 `?groupId=` 看**某一个群**的（默认给总览）。
   */
  // ── 日常事件：预览 / 立即发送（2026-09-15 <主人>：「日常事件也加一个预览和立即发送」）──
  //
  // ⚠️ 和二级剧情那两个按钮一个路子，但**日常事件有个不一样的地方**：
  //    「立即发送」是**真的一条日常事件**，所以它会**算进今天那条配额**
  //    （`life.commit` 会 fired+1 并重排后面的时间）——
  //    不记账的话，你点三次就等于今天多发三条，排程还是照原样再来一遍。
  // ⚠️⚠️ 2026-09-15 用户报「刚点一下立即发送，抽到的事件马上就变了一个然后发出去了」——
  //    查明了：**不是发送分支的 bug，是浏览器那一页还是旧页面**。
  //    这个界面**没有周期性轮询**，服务端的 webui.html 改了，已经开着的标签页不会知道；
  //    旧页面的 `lifeSendNow()` 不把预览一起传上来 → 服务端只好重新抽一条 →
  //    "你看到的"和"真发出去的"不是同一条。
  //    （证据：日志里只有「管理界面手动发了一条日常事件」，**没有**下面那条「用的就是刚预览的」）
  //    ⚠️ lastLifePreview / LIFE_PREVIEW_TTL 声明在**路由表外面**（模块作用域，见上面那一段）。
  /** 界面版本：给界面自己比"我这一页是不是旧的"用 */
  'GET /api/pagever': async (_req, res) => { loadPage(); send(res, 200, { ver: PAGE_VER }); },

  // ── 开机自启（2026-09-17 加）──
  // ⚠️ 这两个接口会**动系统设置**（注册表启动项），而且是我这边起 powershell 去改。
  //    参数一律走环境变量传，不拼命令行 —— 见 src/autostart.js 顶部那段注释。
  //    界面只监听 127.0.0.1、不做登录，信任级别和「重启 NapCat」那些按钮一样，
  //    所以这里不再加额外鉴权。
  'GET /api/autostart': async (_req, res) => send(res, 200, autostart.status()),

  'POST /api/autostart': async (req, res) => {
    let body = {};
    try {
      body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    } catch { /* body 坏了就当查询，下面按 falsy 处理 */ }
    try {
      const st = body.enabled ? autostart.enable() : autostart.disable();
      log.info(`管理界面${body.enabled ? '开启' : '关闭'}了开机自启（启动项名：${st.valueName}）`);
      send(res, 200, { ok: true, ...st });
    } catch (e) {
      send(res, 400, { ok: false, error: e.message });
    }
  },

  // ── 自动清理（2026-10-06 用户要求）──────────────────
  // 界面上看各处占用 + 待清项，以及"立刻清一次"。
  // ⚠️ POST **默认只演练**（`dryRun` 必须显式传 false 才真删）—— 这个接口会 rm 东西，
  //    默认不删比默认删安全得多。
  'GET /api/cleanup': async (_req, res) => send(res, 200, cleanup.status()),

  'POST /api/cleanup': async (req, res) => {
    let body = {};
    try {
      body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    } catch {
      /* body 坏了 → 按"只演练"处理 */
    }
    try {
      const dryRun = body.dryRun !== false;
      const r = cleanup.run({ dryRun });
      log.info(
        `管理界面${dryRun ? '预览' : '执行'}了自动清理：${r.deleted.length} 项 / ` +
          `${(r.freedBytes / 1048576).toFixed(1)} MB${dryRun ? '（没真删）' : ''}`,
      );
      send(res, 200, { ok: true, ...r });
    } catch (e) {
      send(res, 400, { ok: false, error: e.message });
    }
  },

  /**
   * **某个群**的日常事件进度（2026-09-16 分群之后加的）。
   * 不给 `groupId` = 所有 1 档群各来一行（界面上那张"按群"的表直接用）。
   */
  'GET /api/life/status': async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const gid = String(u.searchParams.get('groupId') ?? '').trim();
    if (!gid) {
      return send(res, 200, {
        ok: true,
        groups: life.targetGroups().map((g) => ({ ...life.status(g), plan: life.todayPlan(g) })),
      });
    }
    send(res, 200, { ok: true, status: life.status(gid), plan: life.todayPlan(gid) });
  },

  /** 预览：只调模型润色，**不发送、不记账、不写故事线**（可按群：那个群的开关/参数不同） */
  'POST /api/life/preview': async (req, res) => {
    let gid = '';
    try {
      const b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      gid = String(b?.groupId ?? '').trim() || String(b?.group_id ?? '').trim();
    } catch {}
    const p = await life.preview(Date.now(), gid).catch((e) => ({ ok: false, reason: e.message }));
    if (p && p.ok && String(p.text ?? '').trim()) lastLifePreview = { at: Date.now(), gid, p };
    send(res, 200, { ...p, groupId: gid });
  },

  /**
   * 立即发送：**真的发到群里**，而且算今天的一条。
   * ⚠️ 2026-09-16 分群之后：**只发到选中的那个群**（原来是一口气发到所有 1 档群）——
   *    每个群的配额是分开的，发到哪儿由界面上的群下拉框决定。
   */
  'POST /api/life/send-now': async (req, res) => {
    if (!bot?.selfId) return send(res, 200, { ok: false, error: 'QQ 没在线，先等它登上来' });
    const all = life.targetGroups();
    if (!all.length) return send(res, 200, { ok: false, error: '没有 1 档群（只有 1 档群收日常事件）' });

    // ⚠️⚠️ 2026-09-15 用户要求：「**这个预览和发送的建议合为一条**」。
    //
    //    原来这里是**重新抽一次再润色** —— 于是界面里预览看到的那句话，
    //    和真发出去的那句话**不是同一句**（还白花一次模型调用）。
    //    现在：界面把刚预览的那条一起传过来，**发的就是它**；
    //    没预览过（直接点发送）才现抽一条。
    //    ⚠️ 再补一层（2026-09-15 晚）：**旧页面不带预览**（见上面 lastLifePreview 那段注释），
    //    所以页面没带时，退而用服务端 10 分钟内记住的那一条 —— 反正就是你刚看过的那句。
    let pre = null;
    let srcNote = '';
    let gid = '';
    try {
      const b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      gid = String(b?.groupId ?? '').trim();
      if (b && b.preview && typeof b.preview === 'object') pre = b.preview;
    } catch {}
    if (!gid) gid = all[0];
    if (!life.isEventGroup(gid)) {
      return send(res, 200, {
        ok: false,
        error: `群 ${gid} 不是 1 档群（只有 1 档群进事件系统）`,
      });
    }
    if (pre && String(pre.text ?? '').trim()) {
      srcNote = '页面带来的';
    } else {
      const mem = lastLifePreview;
      if (mem && Date.now() - mem.at < LIFE_PREVIEW_TTL && String(mem.p?.text ?? '').trim()) {
        pre = mem.p;
        srcNote = '服务端刚记住的（页面没带预览）';
      }
    }
    let p;
    if (pre && String(pre.text ?? '').trim()) {
      p = {
        ok: true,
        slot: String(pre.slot ?? ''),
        event: String(pre.event ?? ''),
        text: String(pre.text).trim(),
        unclean: pre.unclean === true,
      };
      log.info(`[日常事件] 立即发送：用的就是**刚预览的那一条**（${srcNote}，不再重新抽）「${p.text.slice(0, 30)}」`);
    } else {
      p = await life.preview(Date.now(), gid).catch((e) => ({ ok: false, reason: e.message }));
      if (!p.ok) return send(res, 200, { ok: false, error: p.reason });
    }

    const sent = [];
    const r = await bot.sendChatLike(gid, p.text, { kind: 'life' }).catch(() => []);
    if (Array.isArray(r) && r.length) sent.push(gid);
    if (!sent.length) {
      return send(res, 200, {
        ok: false,
        error: '一条都没发出去（去查协议端是不是假在线：tools/napcat-state.mjs）',
        text: p.text,
      });
    }
    // ⚠️ 记账 + 写故事线（**只记这个群**）—— 它就是一条日常事件，不是"额外的"
    try {
      life.commit(
        { slot: p.slot, template: { text: p.event, w: 2, tags: [] }, groupId: gid },
        p.text,
        Date.now(),
        { groups: sent, groupId: gid },
      );
    } catch (e) {
      log.debug(`手动发日常事件后记账失败：${e.message}`);
    }
    log.info(`管理界面手动发了一条日常事件 → ${sent.join(',')}`);
    lastLifePreview = null;                // 用掉了；再点一次就是**重新抽**（跟界面上的提示一致）
    send(res, 200, { ok: true, slot: p.slot, event: p.event, text: p.text, sent, unclean: p.unclean === true });
  },

  'GET /api/quest/state': async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const gid = String(u.searchParams.get('groupId') ?? '').trim();
    send(res, 200, {
      ok: true,
      config: { ...config.quest },
      status: quest.status(gid || undefined),
      /** ⚠️ 这个群里生效的参数（全局 + 覆盖）—— 界面"按群设定"那张表要回填 */
      params: gid ? paramsFor('quest', gid) : null,
      sim: simSnapshot(),
    });
  },

  // ── 故事线（**每个群一份**，2026-09-15 <主人> 要求）────────────────
  //
  // 用户原话：「一个群设一个故事线知识库……知识库调用时一定要分清就行了。
  //   然后再做故事线卡片」。
  /** 总览（不带 groupId）或某一个群的数字 */
  'GET /api/storyline/state': async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const gid = String(u.searchParams.get('groupId') ?? '').trim();
    send(res, 200, { ok: true, status: gid ? storyline.status(gid) : storyline.status() });
  },

  /** 看某一个群的故事线条目（不给 groupId 就全给，界面上一般会传） */
  'GET /api/storyline/entries': async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const gid = String(u.searchParams.get('groupId') ?? '').trim();
    const n = Math.max(1, Math.min(200, Number(u.searchParams.get('limit')) || 60));
    const entries = gid
      ? storyline.recent(n, gid)
      : storyline
          .groups()
          .flatMap((g) => storyline.recent(n, g).map((e) => ({ ...e, groupId: g })))
          .sort((a, b) => a.at - b.at);
    send(res, 200, { ok: true, groupId: gid, entries });
  },

  /**
   * 压缩**某一个群**的故事线。
   * ⚠️ **必须给 groupId** —— 分群之后"压哪个群"没有默认值，界面上是每行一个按钮。
   */
  'POST /api/storyline/compress': async (req, res) => {
    const b = JSON.parse((await readBody(req)).toString('utf8'));
    const gid = String(b.groupId ?? '').trim();
    if (!gid) return send(res, 200, { ok: false, error: '要指定是哪个群（故事线是按群存的）' });
    const r = await storyline.compress({ groupId: gid, force: b.force !== false });
    if (r.ok) {
      log.info(`管理界面手动压缩了群 ${gid} 的故事线：${r.before} → ${r.after} 字`);
    }
    send(res, 200, { ok: r.ok, result: r, status: storyline.status() });
  },

  /**
   * **按群覆盖参数**（<主人>：「参数也可以分群设定」）。
   *
   * 传 `{ groupId, patch: { life: {...}, quest: {...} } }`；
   * `patch` 里给 `null` 的项 = **删掉这个覆盖**（回到全局值）。
   */
  /**
   * 读**某个群**的覆盖参数（界面回填用）。
   *
   * ⚠️ 2026-09-15 晚加：收紧度按群之后，界面上那个下拉框需要"选中群现在是什么值"。
   *    这里**故意不校验档位**（只是读，界面不该因为不是 1 档群就报错）。
   */
  /** ⚠️⚠️ 2026-10-13 加（用户：「15 秒刷新改成**对话有更新时刷新**吧」）：
   *  任务页不再定时轮询 —— 服务端推送（SSE）：任务一开始/结束/产物发了/在问话，都会推一下 ✓
   *  ⚠️ 这是**长连接**：必须把 socket 的超时关掉，不然被服务端掐掉 ✗ */
  'GET /agent-tasks/stream': async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    try {
      req.socket?.setTimeout?.(0);
      res.socket?.setTimeout?.(0);
    } catch {}
    res.write(': connected\n\n');
    const ab = await import('./agent-bridge.js');
    const off = ab.onTaskChange(() => {
      try {
        res.write('event: change\ndata: {}\n\n');
      } catch {}
    });
    // ⚠️ 心跳：中间可能有代理/防火墙，久了不发东西会被断
    const hb = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {}
    }, 25000);
    const bye = () => {
      clearInterval(hb);
      try {
        off();
      } catch {}
      try {
        res.end();
      } catch {}
    };
    req.on('close', bye);
    req.on('error', bye);
  },

  /* ── B站全自动投稿（2026-10-22 加）─────────────────────────
   * 用户：「在功能卡片里新增一个 B站投稿设置页，所有设置都放在里面」
   *      +「不要新建一个页面，和其他的功能页面一样在同一个页面」
   * ⇒ 设置面板在 `webui.html` 的 `tab-biliPub`；这里只有接口。
   *   ⚠️ 2026-10-22：原来那个独立页 `/bili-publish` 已经删掉（用户不要第二个页面）✗
   */
  /* ══════════════════════════════════════════════════════════════════
   * ⚠️⚠️ 2026-10-22 加：**B 站一键登录**（用户原话：
   *   「**可不可以纯靠 webui 完成整个 b 站登录过程，方便没有 agent 的用户操作？**」）
   *
   * 以前只能命令行跑 `node tools/bili-login.mjs` ⇒ 没有 agent 的人根本不知道要这么做 ✗
   *
   * ## 两条路由
   *   · `GET  /api/bili/login` —— 现在什么状态（idle / running / ok / fail + 登的是谁）
   *   · `POST /api/bili/login` —— **起一个后台进程**，弹 Chrome 让人扫码
   *
   * ## ⚠️ 为什么 POST 必须"立刻返回"
   *   登录要**等人扫码**，最长 10 分钟 ⇒ HTTP 请求绝不能挂着等（浏览器会超时、
   *   界面会像卡死）✗ ⇒ 起 **detached 子进程**（`unref()`），请求马上返回，
   *   界面自己**轮询 GET** 看进度 ✓
   *
   * ## ⚠️ 状态走文件，不走内存
   *   `tools/bili-login.mjs` 是**独立进程**，写完状态就退出 ⇒ 只能通过
   *   `state/bili-login-<QQ>.json` 交换（主号也是 `<QQ>` 命名，不搞例外 ——
   *   界面和脚本两边算路径的代码各只有一份，少一个分支就少一种错）✓
   *
   * ## ⚠️ 按号分
   *   登录的是**当前这个 webui 进程所属的 QQ 号**的 B 站账号
   *   （profile 目录 `state/bili-profile-<QQ>` 也是按号分的）✓
   * ══════════════════════════════════════════════════════════════════ */

  'GET /api/bili/login': async (_req, res) => {
    const qq = String(ACCOUNT.id || '').trim();
    const file = join(ROOT, 'state', qq ? `bili-login-${qq}.json` : 'bili-login.json');
    const profile = join(ROOT, 'state', qq && !ACCOUNT.isMain ? `bili-profile-${qq}` : 'bili-profile');
    let st = null;
    try { st = JSON.parse(readFileSync(file, 'utf8')); } catch { /* 还没登过 */ }
    // 进程还活着吗（状态里记了 pid）—— 死了但状态还是 running ⇒ 当成"中断了"
    let alive = false;
    if (st?.state === 'running' && st.pid) {
      try { process.kill(Number(st.pid), 0); alive = true; } catch { alive = false; }
    }
    const hasProfile = existsSync(join(profile, 'Default'));
    send(res, 200, {
      ok: true,
      qq,
      account: qq ? accounts.displayName(qq) : '',
      state: st ? (st.state === 'running' && !alive ? 'stale' : st.state) : 'idle',
      uid: Number(st?.uid) || 0,
      uname: String(st?.uname || ''),
      at: Number(st?.at) || 0,
      err: String(st?.err || ''),
      running: !!alive,
      // 有 profile 目录只说明"登录过"，不代表 cookie 还有效（B站会把登录态踢掉）
      hasProfile,
      profile,
    });
  },

  'POST /api/bili/login': async (_req, res) => {
    try {
      const qq = String(ACCOUNT.id || '').trim();
      const file = join(ROOT, 'state', qq ? `bili-login-${qq}.json` : 'bili-login.json');
      // ⚠️ 已经在跑就别起第二个（两个 Chrome 抢同一个 profile 会互相踢）
      let st = null;
      try { st = JSON.parse(readFileSync(file, 'utf8')); } catch { /* ignore */ }
      if (st?.state === 'running' && st.pid) {
        let alive = false;
        try { process.kill(Number(st.pid), 0); alive = true; } catch { alive = false; }
        if (alive) return send(res, 200, { ok: true, already: true, pid: Number(st.pid) });
      }
      const script = join(ROOT, 'tools', 'bili-login.mjs');
      if (!existsSync(script)) return send(res, 200, { ok: false, error: '找不到 tools/bili-login.mjs' });
      // ⚠️ 先把状态写成 running（脚本自己也会写，但这样界面**立刻**就有反馈，
      //    不用等脚本启动那几百毫秒）✓
      try {
        writeFileSync(file, JSON.stringify({ state: 'running', uid: 0, uname: '', err: '', at: Date.now(), pid: 0 }, null, 2), 'utf8');
      } catch { /* ignore */ }
      const child = spawn(process.execPath, [script], {
        cwd: ROOT,
        // ⚠️ 必须把**当前号**传下去 —— `biliProfileDir()` 就是靠这个环境变量分目录的，
        //    不传的话子进程会当成主号，去开主号的 profile ⇒ 抢主号那个常驻浏览器 ✗
        env: { ...process.env, QQBOT_ACCOUNT: qq },
        detached: true,          // ⚠️ 脱离机器人进程：登录要等人扫码，最长 10 分钟
        stdio: 'ignore',
        windowsHide: true,       // ⚠️ 但 Chrome 窗口本身**要看得见**（那是给人扫的）
      });
      child.unref();
      log.info(`[B站登录] 界面点了「登录」（号 ${qq || '主号'}）⇒ 已起进程 pid ${child.pid}，等扫码`);
      send(res, 200, { ok: true, started: true, pid: child.pid });
    } catch (e) {
      send(res, 200, { ok: false, error: e.message });
    }
  },

  'GET /api/bili-publish': async (_req, res) => {
    const bp = await import('./bili-publish.js');
    const bc = await import('./bili-comments.js');
    const bpr = await import('./bili-proactive.js');
    const sm = await import('./short-memory.js');
    // ⚠️ `commentsToday` 是给面板显示"今天已回 X/Y 条"的（评论回复的今日进度）
    const cs = bc.status();
    send(res, 200, {
      ok: true,
      cfg: bp.settings(),
      comments: bc.settings(),
      // ⚠️ 2026-10-21：**主动去别人视频下评论**（用户要「手动发一条 + 显示出来发送的视频链接」）
      proactive: bpr.settings(),
      proactiveState: bpr.status(),
      memory: sm.status(),
      state: { ...bp.status(), commentsToday: cs.todayCount },
    });
  },

  'POST /api/bili-publish': async (req, res) => {
    try {
      const body = await readJson(req);
      const c = body?.cfg || {};
      const clean = {};
      if (typeof c.enable === 'boolean') clean.enable = c.enable;
      if (c.windowStart) clean.windowStart = String(c.windowStart).slice(0, 5);
      if (c.windowEnd) clean.windowEnd = String(c.windowEnd).slice(0, 5);
      if (c.group !== undefined) clean.group = String(c.group).replace(/\D/g, '');
      // ⚠️ 2026-10-22 用户改口：**题材不是清单，是"范围"**（跟 b 站分享的关键词一个用法）
      //    「输入和 b 站分享的那些标签一样划定范围就可以了」⇒ 一行/逗号一个方向
      if (c.scope !== undefined) {
        clean.scope = (Array.isArray(c.scope) ? c.scope : String(c.scope).split(/[,，、\n]/))
          .map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
      }
      // ⚠️ 时长**由 agent 自己定**，这里只是上限（别写成"视频时长"）
      if (c.durationMax !== undefined) {
        clean.durationMax = Math.max(25, Math.min(120, Number(c.durationMax) || 60));
      }
      // ⚠️ 分区也**由 agent 自己选**，这两个只是兜底（它挑不到时用）
      if (c.zone !== undefined) clean.zone = String(c.zone).trim().slice(0, 20) || '生活';
      if (c.zone2 !== undefined) clean.zone2 = String(c.zone2).trim().slice(0, 20);
      if (c.tags !== undefined) {
        clean.tags = (Array.isArray(c.tags) ? c.tags : String(c.tags).split(/[,，、\n]/))
          .map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean).slice(0, 10);
      }
      if (c.groupMaxStreak !== undefined) clean.groupMaxStreak = Math.max(1, Math.min(10, Number(c.groupMaxStreak) || 2));
      if (typeof c.notifyOwner === 'boolean') clean.notifyOwner = c.notifyOwner;
      // ⚠️ 老字段（durationSec / tid / topics）如果还在 config.yml 里，**顺手清掉** ——
      //    留着会让下一个读配置的人以为它们还有用（它们已经废了）✗
      for (const dead of ['durationSec', 'tid', 'topics']) {
        if (dead in (config.biliPublish || {})) clean[dead] = null;
      }
      saveConfig({ biliPublish: clean });

      /* ⚠️ 2026-10-22：**B站评论回复**的开关也在这个页面上（用户要求"所有设置都放在里面"）
       *  ⚠️ 它单独一段 `biliComments`，别和投稿那段混着存（混了以后想单独关评论就关不掉）
       *  ⚠️ 字段照 `biliShare` 那套：每天条数（区间）/ 时间段 / 两条间隔 / 关键词 */
      const cm = body?.comments || {};
      if (cm && typeof cm === "object" && Object.keys(cm).length) {
        const cclean = {};
        if (typeof cm.enable === "boolean") cclean.enable = cm.enable;
        if (cm.checkEveryMinutes !== undefined) {
          cclean.checkEveryMinutes = Math.max(1, Math.min(120, Number(cm.checkEveryMinutes) || 5));
        }
        if (cm.maxPerRun !== undefined) cclean.maxPerRun = Math.max(1, Math.min(6, Number(cm.maxPerRun) || 3));
        // ⚠️ 用户 2026-10-22：「取消每天最少和最多，间隔也删掉」⇒ 老字段顺手清掉
        for (const dead of ["minPerDay", "maxPerDay", "startHour", "endHour", "cooldownMs", "keywords", "everyMinutes"]) {
          if (dead in (config.biliComments || {})) cclean[dead] = null;
        }
        if (Object.keys(cclean).length) saveConfig({ biliComments: cclean });
      }

      /* ⚠️ 2026-10-21：**B站主动评论**（去别人视频下发）—— 又是一段独立的，别混进上面两个
       *  ⚠️ 加新设置项时**三处都要动**：这里解析 + `put(...)` + `HANDLED` 名单（少一处就存不进去 ✗） */
      const bpr = body?.proactive || {};
      if (bpr && typeof bpr === "object" && Object.keys(bpr).length) {
        const pclean = {};
        if (typeof bpr.enable === "boolean") pclean.enable = bpr.enable;
        if (bpr.keywords !== undefined) {
          pclean.keywords = (Array.isArray(bpr.keywords) ? bpr.keywords : String(bpr.keywords).split(/[,，、\n]/))
            .map((t) => String(t).trim()).filter(Boolean).slice(0, 30);
        }
        // ⚠️ 2026-10-21：上限 20 → **50**（用户问「每天最多为什么还有上限20啊」）
        if (bpr.minPerDay !== undefined) pclean.minPerDay = Math.max(1, Math.min(50, Number(bpr.minPerDay) || 1));
        if (bpr.maxPerDay !== undefined) pclean.maxPerDay = Math.max(1, Math.min(50, Number(bpr.maxPerDay) || 2));
        /* ⚠️ 2026-10-22 加：**两次之间至少几分钟**（用户：「根据 b站的限制对应更改 webui 限制设置逻辑」）
         *   B站 真正卡的是**间隔**（实测 3 分钟内连发第二条就失败），
         *   而这个值原来是 `tick()` 里**硬编码 20 分钟**，用户改不了 ✗
         *   ⇒ 开出来，下限 10（比实测红线留 3 倍余量）、上限 180（一天最多 8 次）✓ */
        if (bpr.intervalMinutes !== undefined) pclean.intervalMinutes = Math.max(10, Math.min(180, Number(bpr.intervalMinutes) || 20));
        if (bpr.startHour !== undefined) pclean.startHour = Math.max(0, Math.min(23, Number(bpr.startHour) || 10));
        if (bpr.endHour !== undefined) pclean.endHour = Math.max(0, Math.min(24, Number(bpr.endHour) || 22));
        if (bpr.maxResults !== undefined) pclean.maxResults = Math.max(4, Math.min(20, Number(bpr.maxResults) || 8));
        if (Object.keys(pclean).length) saveConfig({ biliProactive: pclean });
      }

      const bp = await import('./bili-publish.js');
      const bc = await import('./bili-comments.js');
      const bprS = await import('./bili-proactive.js');
      const sm = await import('./short-memory.js');
      // ⚠️ 存完立刻读回来核对（这功能一旦"以为开了其实没开"，是第二天才发现）
      send(res, 200, {
        ok: true, cfg: bp.settings(), comments: bc.settings(),
        proactive: bprS.settings(), proactiveState: bprS.status(),
        memory: sm.status(), state: bp.status(),
      });
    } catch (e) {
      send(res, 200, { ok: false, error: e.message });
    }
  },

  /** 立刻做一条（自定义题材可选）—— 就是用户要的「手动转发视频那样自己输入题材」 */
  /**
   * **释放常驻浏览器**（2026-10-22 加）
   *
   * 用户原话：「**你别老是动我的开关啊，我一打开就关掉**」
   * ⇒ 以前我为了"独占 Chrome profile"（上传视频 / 探路要用）会去改 `enable` ✗
   * ⇒ 现在改成调这个接口：**不动开关**，只让常驻浏览器临时让位，并暂停一段时间
   *
   * POST { pauseMinutes?: number }  → { ok, released, pauseMinutes }
   * 之后到点它会自己重起（下次 tick），不用管 ✓
   */
  'POST /api/bili-comments/release': async (req, res) => {
    try {
      const bc = await import("./bili-comments.js");
      let body = {};
      try { body = (await readJson(req)) || {}; } catch { /* 允许空 body */ }
      const mins = Math.max(1, Math.min(180, Number(body?.pauseMinutes) || 40));
      const released = await bc.release({ pauseMs: mins * 60000 });
      send(res, 200, { ok: true, released, pauseMinutes: mins, state: bc.status() });
    } catch (e) {
      send(res, 200, { ok: false, error: e.message });
    }
  },

  /**
   * **手动去别人视频下发一条评论**（2026-10-21 加）
   *
   * 用户原话：「也可以加个**手动发一条**，但是要**显示出来发送的视频链接**」
   *
   * POST { bvid?: 'BVxxx', url?: 'https://…' }  → { ok, started: true }
   * ⚠️ **不等它跑完**（要 1~3 分钟：开浏览器 → 看视频 → 写 → 点发布，会超时）⇒
   *   立刻回"已开始"，结果靠 `GET /api/bili-publish` 的 `proactiveState.recent` 轮询（带链接）✓
   * ⚠️ 不给 bvid/url 就**自己按关键词搜一个**（和定时那条一个路子）
   */
  'POST /api/bili-proactive/now': async (req, res) => {
    try {
      let body = {};
      try { body = (await readJson(req)) || {}; } catch { /* 允许空 body */ }
      const bpr = await import('./bili-proactive.js');
      const bvid = String(body?.bvid || '').trim();
      const url = String(body?.url || '').trim();
      /* ⚠️ 2026-10-21 用户：「**评论视频一定不要重复评论**」
       *   ⇒ 手动发之前**先同步查一次**：这个 BV 已经在永久名单里就当场回绝，
       *     别等异步跑完、日志里才看见（界面上要能立刻看到原因）✓ */
      if ((bvid || url) && bpr.alreadyCommented(bvid || url)) {
        return send(res, 200, {
          ok: false, already: true,
          error: '这个视频已经评论过了，不重复评论',
        });
      }
      void (async () => {
        let use = { bvid, url };
        if (!use.bvid && !use.url) {
          const v = await bpr.pickVideo();
          if (!v) { log.warn('[B站主动评论] 手动发：没搜到合适的视频'); return; }
          use = { bvid: v.bvid };
        }
        const r = await bpr.runOnce({ ...use, manual: true });
        if (r.ok) log.info(`[B站主动评论] 手动发成功：${r.video}｜「${String(r.comment || '').slice(0, 40)}」`);
        else if (r.uncertain) log.warn(`[B站主动评论] 手动发：点了发布但没核实到（${r.video}）—— 去 B站 看一眼`);
        else log.warn(`[B站主动评论] 手动发失败：${r.err || ''}`);
      })().catch((e) => log.warn(`[B站主动评论] 手动发出错：${e.message}`));
      send(res, 200, { ok: true, started: true });
    } catch (e) {
      send(res, 200, { ok: false, error: e.message });
    }
  },

  /* ── 语音设置（2026-10-21 加）──────────────────────────
   * 用户：「加一个**语音设置模块**放在功能卡片，**内置开关**，
   *      然后**各个QQ账号可以选择用哪个语音**，
   *      再加一个**戳一戳回的消息默认用语音回复**，这个开关默认关闭」
   *
   * ⚠️ `voice` 段**按号私有**（不在 SHARED_SECTIONS）⇒ 每个号能选自己的音色 ✓
   * ⚠️ 音色列表从 `logs/bili/voice-ref/` 现读（用户往里丢新的 wav 就能选到）✓
   */
  'GET /api/voice': async (_req, res) => {
    const gv = await import('./group-voice.js');
    send(res, 200, {
      ok: true,
      cfg: gv.voiceSettings(),
      voices: gv.listVoices(),
      current: gv.voiceRef().split(/[\\/]/).pop(),
    });
  },

  'POST /api/voice': async (req, res) => {
    try {
      const body = await readJson(req);
      const c = body || {};
      const clean = {};
      if (typeof c.enable === 'boolean') clean.enable = c.enable;
      if (typeof c.pokeVoice === 'boolean') clean.pokeVoice = c.pokeVoice;
      if (c.ref !== undefined) {
        const name = String(c.ref || '').trim().slice(0, 120);
        // ⚠️ 只收文件名（别让人写 `../` 之类的路径）
        clean.ref = /^[\w\-. \u4e00-\u9fa5]+\.(wav|mp3|m4a)$/i.test(name) ? name : '';
      }
      if (Object.keys(clean).length) saveConfig({ voice: clean });
      const gv = await import('./group-voice.js');
      send(res, 200, { ok: true, cfg: gv.voiceSettings(), current: gv.voiceRef().split(/[\\/]/).pop() });
    } catch (e) {
      send(res, 200, { ok: false, error: e.message });
    }
  },

  'POST /api/bili-publish/run': async (req, res) => {
    try {
      const body = await readJson(req);
      const bp = await import('./bili-publish.js');
      if (bp.isBusy()) return send(res, 200, { ok: false, error: '上一条还在做，等它跑完' });
      // ⚠️ 不等它跑完（要 3~5 分钟，会超时）⇒ 立刻回"已开始"，进度看状态
      void bp.runOnce({ topic: String(body?.topic || '').slice(0, 200), publish: body?.publish !== false });
      send(res, 200, { ok: true, started: true });
    } catch (e) {
      send(res, 200, { ok: false, error: e.message });
    }
  },

  'GET /agent-tasks': async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(AGENT_TASKS_HTML);
  },

  /** 任务列表（新的在前） */
  'GET /api/agent-tasks': async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const limit = Math.min(200, Math.max(1, Number(u.searchParams.get('limit') ?? 50) || 50));
    const ab = await import('./agent-bridge.js');
    send(res, 200, { ok: true, tasks: ab.taskHistory(limit), running: ab.status().running });
  },

  /** 单条任务 + 那次会话的对话（页面点开就看这个） */
  'GET /api/agent-task': async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const id = String(u.searchParams.get('id') ?? '').trim();
    const ab = await import('./agent-bridge.js');
    const t = ab.taskHistory(200).find((x) => String(x.id) === id);
    if (!t) return send(res, 200, { ok: false, error: '没有这条任务（可能太老了，只留最近 200 条）' });
    // ⚠️⚠️ 2026-10-16 加（用户：「正在跑的能不能也把对话显示出来」）——
    //    历史里 `sessionId` 空着时（老任务 / 还没跑完的），**按工作区 + 时间反查**会话目录 ✓
    //    不然点开就是「（这次没有可显示的对话）」
    const sid = String(t.sessionId ?? '') || ab.sessionIdForTask(t);
    const talk = sid ? await ab.readSessionTalk(sid).catch(() => []) : [];
    send(res, 200, { ok: true, task: { ...t, sessionId: sid }, talk });
  },

  'GET /api/group-params': async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const gid = String(u.searchParams.get('groupId') ?? '').trim();
    if (!gid) return send(res, 200, { ok: false, error: '要 groupId' });
    send(res, 200, {
      ok: true,
      groupId: gid,
      overrides: config.groupParams?.[gid] ?? {},
      params: { life: paramsFor('life', gid), quest: paramsFor('quest', gid), chat: paramsFor('chat', gid) },
    });
  },

  'POST /api/group-params': async (req, res) => {
    const b = JSON.parse((await readBody(req)).toString('utf8'));
    const gid = String(b.groupId ?? '').trim();
    if (!gid) return send(res, 200, { ok: false, error: '要指定是哪个群' });
    // ⚠️⚠️ **只有 1 档群才进事件系统**（<主人> 2026-09-15：「挡位 2 不能进事件系统，只有 1 才能设置」）。
    //    2 档群只是"她会在那儿说话"，没有日常事件也没有剧情 —— 给它设这些参数毫无意义，
    //    而且会让人以为"设了就会生效"。直接拒绝，并告诉他去哪儿改档位。
    if (!life.isEventGroup(gid)) {
      // ⚠️ 2026-10-07 修（本轮发现的真 bug）：**`answerServer` 跟事件系统没关系**。
      //    它是"这个群要不要回服务器消息"（她怎么说话），2/3 档群一样需要它 ——
      //    而这一页的其它字段（life / quest）确实只有 1 档群才有意义。
      //    ⇒ 只有**事件类**字段（life/quest）才卡 1 档；纯 chat 的改动放行。
      const onlyChat = b.patch && Object.keys(b.patch).every((k) => k === 'chat');
      if (!onlyChat) {
        const lv = config.trigger?.groupRespondTo?.[gid];
        return send(res, 200, {
          ok: false,
          error:
            `群 ${gid} 不是 1 档群（当前档位 ${lv ?? '没配'}）→ **不进事件系统**，` +
            '设了也不会生效。想让它收日常事件/跑剧情，先去「群与触发」把档位改成 1。',
        });
      }
    }
    // ⚠️⚠️ 2026-10-07 修（本轮发现的真 bug）：这里原来**直接读写共用的 `config.yml`**。
    //    而拆分之后 `groupParams`（按群设定）属于**每个号私有**（`accounts/<QQ>.yml`）——
    //    于是"改按群设定"实际写进了共用文件，而真正生效的是账号文件里那一份
    //    ⇒ 表现是「改了按群设定，一点效果都没有」，而且界面**照样回读成功**（最阴的那种）。
    //    ⇒ 现在统一交给 `saveConfig`（它按段分派：`groupParams` 是私有段 ⇒ 写账号文件）。
    //    ⚠️ 底稿用 `config.groupParams`（**合并后**的值）而不是从 config.yml 读的 raw ——
    //       否则会把账号文件里已有的设置当成"不存在"，一保存就冲掉。
    const cur = JSON.parse(JSON.stringify(config.groupParams?.[gid] ?? {}));
    // ⚠️ 2026-10-05 加（用户要求）：「机器人同类池」是**顶层数组**（不是 life/quest/chat
    //    那种 kind 对象）⇒ 单独收。规矩跟 config.js 那边一致：
    //    去空值、统一字符串、去重、封顶 10 个。
    if (Array.isArray(b.patch?.peers)) {
      const seen = new Set();
      const peers = [];
      for (const x of b.patch.peers) {
        const id = String(x ?? '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        peers.push(id);
        if (peers.length >= 10) break;
      }
      if (peers.length) cur.peers = peers;
      else delete cur.peers;
    }
    // ⚠️ 2026-10-06 加（用户要求）：「不同类机器人池」—— 和同类池**正好相反**：
    //    填进去的号她**完全不回应**（连 @ 她都不回，也不进剧情/好感度）。
    //    规矩跟 `peers` 一模一样：去空值、统一字符串、去重、封顶 10 个。
    if (Array.isArray(b.patch?.otherBots)) {
      const seen = new Set();
      const otherBots = [];
      for (const x of b.patch.otherBots) {
        const id = String(x ?? '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        otherBots.push(id);
        if (otherBots.length >= 10) break;
      }
      if (otherBots.length) cur.otherBots = otherBots;
      else delete cur.otherBots;
    }
    for (const [kind, fields] of Object.entries(b.patch ?? {})) {
      // ⚠️ `chat` = 收紧度这类"她怎么说话"的参数（2026-09-15 晚加）
      if (!['life', 'quest', 'chat'].includes(kind) || !fields || typeof fields !== 'object') continue;
      cur[kind] ??= {};
      for (const [k, v] of Object.entries(fields)) {
        if (v === null) delete cur[kind][k];
        else if (v !== undefined) cur[kind][k] = v;
      }
      if (!Object.keys(cur[kind]).length) delete cur[kind];
    }
    // ⚠️ 交给 `saveConfig`：它按段分派 —— `groupParams` 是**私有段**，
    //    会写进 `accounts/<这个号>.yml`（不是共用的 config.yml）。
    //    空对象传 `null` = 把这个群的覆盖整个删掉（`put()` 里 `null` 就是删除语义）。
    saveConfig({ groupParams: { [gid]: Object.keys(cur).length ? cur : null } });
    log.info(`管理界面改了群 ${gid} 的覆盖参数：${JSON.stringify(b.patch ?? {})}`);
    send(res, 200, {
      ok: true,
      // ⚠️ 回读一遍**规范化之后**的值（夹取/默认值都在 config.js 里）
      // ⚠️ 收紧度（`chat.strictness`）也按群返回（2026-09-15 晚）
      params: { life: paramsFor('life', gid), quest: paramsFor('quest', gid), chat: paramsFor('chat', gid) },
      overrides: config.groupParams?.[gid] ?? {},
    });
  },

  /**
   * 「替换下次二级事件」：存一句自定义由头，下次**这个群**自动开剧情时优先用它。
   *
   * ⚠️ 2026-09-15 晚改**按群**（<主人>：「最好也加个群选择…因为每个群的故事线不一样」）：
   *    每个群的故事线是分开的，一句由头只对写它的那个群有意义。
   *    `groupId` 空着 = 存那份**全局兜底**（老页面不传群号时走这条，不至于报错）。
   */
  'POST /api/quest/hint': async (req, res) => {
    const b = JSON.parse((await readBody(req)).toString('utf8'));
    const gid = String(b.groupId ?? '').trim();
    const text = quest.setNextHint(b.text, gid);
    log.info(`管理界面设置了"下次二级事件"的自定义内容（${gid ? `群 ${gid}` : '全局兜底'}）：${text ? text.slice(0, 40) : '(清空)'}`);
    send(res, 200, { ok: true, groupId: gid, nextHint: text, hints: quest.hintsByGroup() });
  },

  /**
   * 「立即开始剧情」：**真的**开一条剧情并发到群里。
   *
   * ⚠️ 这是会真的往群里发消息的 —— 界面上必须写清楚。
   */
  'POST /api/quest/start': async (req, res) => {
    const b = JSON.parse((await readBody(req)).toString('utf8'));
    // ⚠️ **只有 1 档群才进事件系统**（<主人> 2026-09-15：「挡位 2 不能进事件系统，只有 1 才能设置」）
    const groups = life.targetGroups();
    if (!groups.length) return send(res, 200, { ok: false, error: '没有 1 档群，不知道发哪儿（只有 1 档群会进事件系统）' });
    if (!bot?.selfId) return send(res, 200, { ok: false, error: 'QQ 没在线，先等它登上来' });
    // ⚠️ 一条剧情**只在一个群里跑**（两个群会各自回话、把线搅乱）
    // ⚠️⚠️ 页面必须把 groupId 带上。**没带就退回 `groups[0]`** —— 这正是
    //      「我手动开剧情，699 开头的群没启动」那个 bug 的根子（2026-09-15 晚）：
    //      按钮根本不传群号，于是永远开在配置里第一个 1 档群。现在界面一定传了，
    //      但**旧页面**仍会不传 → 打个 warn，把"到底开在哪儿了"写进日志。
    const asked = String(b.groupId ?? '').trim();
    const gid = asked || groups[0];
    if (!asked) log.warn(`[剧情] 手动开始没带群号 → 退回第一个 1 档群 ${gid}（页面上"发到哪个群"没选？）`);
    if (!life.isEventGroup(gid)) {
      return send(res, 200, {
        ok: false,
        error: `群 ${gid} 不是 1 档群 → 不进事件系统（档位在「群与触发」里改成 1 才能设置）`,
      });
    }
    // ⚠️ `manual: true` → 人在界面上主动点的：**不受总开关和每周上限限制**
    //    （总开关关着的时候也要能测；见 quest.js 里 canStart 的说明）
    // ⚠️⚠️ 分群之后 `canStart` **必须带上 groupId** —— 不然它查的是"没指定群"那个桶，
    //      也就是**没查这个群到底有没有在跑**（分群改造时差点漏掉这个）。
    const can = quest.canStart(Date.now(), { manual: true, groupId: gid });
    if (!can.ok) return send(res, 200, { ok: false, error: can.reason });
    const r = await quest
      .begin({
        ask: llmAsk,
        // ⚠️ 页面留空时才用"替换下次二级事件"存的那句 —— 而且**要取这个群的**
        //    （那句由头是照这个群的故事线写的，2026-09-15 晚改成按群存）
        extraHint: String(b.text ?? '').trim() || quest.takeNextHint(gid),
        groupId: gid,
        // ⚠️ 必须把 `manual` 传下去 —— 只在外面 `canStart({manual:true})` 检查一次不够，
        //    `begin()` 里还会再按自动规则拒一次（2026-09-15 踩过）
        manual: true,
      })
      .catch((e) => ({ ok: false, reason: e.message }));
    if (!r.ok) return send(res, 200, { ok: false, error: r.reason });
    try {
      // ⚠️ 同样要**分条**（用户原则：像人说的话就分条，只有排行榜那类才整条发）
      const sent = await bot.sendChatLike(gid, r.text);
      for (const x of sent) quest.rememberHerMsg(r.quest, x?.message_id);
      log.info(`管理界面手动开了一条剧情 → 群 ${gid}：${r.quest.premise}`);
    } catch (e) {
      return send(res, 200, { ok: false, error: `剧情开了但发送失败：${e.message}` });
    }
    send(res, 200, { ok: true, groupId: gid, premise: r.quest.premise, text: r.text, status: quest.status() });
  },

  /**
   * 「推进下一段 / 收尾」（2026-09-15 晚 <主人>：「**也和模拟一样也加一套剧情控制按钮**」）。
   *
   * 和自动推进（`index.js` 的 `questTickOne`）的区别：**不等那 30 分钟**，现在就推。
   *   · `reply` 非空 → 先把"群友这句话"塞进 `pending`（跟真群里攒发言是同一条路，
   *     `advance()` 会把它当"这一阶段群里说的话"喂给模型）；
   *   · `forceEnd` = `good` / `bad` → 强制收尾（模拟面板那两颗按钮的同款做法）。
   *
   * ⚠️ 发出去 + 记 message_id + 收尾结算，这三件事跟 `index.js` 里的
   *    `sendQuestLine` / `settleQuest` 是一套逻辑（网页上手动推也得照做，
   *    不然"回复她"判据和好感度结算都会断）。
   */
  'POST /api/quest/next': async (req, res) => {
    const b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const gid = String(b.groupId ?? '').trim();
    if (!gid) return send(res, 200, { ok: false, error: '要推哪个群的剧情？（groupId）' });
    const q = quest.current(gid);
    if (!q || q.endedAt) return send(res, 200, { ok: false, error: `群 ${gid} 现在没有在跑的剧情` });
    if (!bot?.selfId) return send(res, 200, { ok: false, error: 'QQ 没在线，先等它登上来' });

    const reply = String(b.reply ?? '').trim();
    if (reply) {
      quest.noteReply(q, {
        userId: String(config.ownerQQ ?? ''),
        name: String(b.name ?? '').trim() || '群友',
        text: reply,
      });
    }
    const forceEnd = ['good', 'bad'].includes(String(b.forceEnd)) ? String(b.forceEnd) : null;
    const r = await quest
      .advance(q, { ask: llmAsk, forceEnd })
      .catch((e) => ({ ok: false, reason: e.message }));
    if (!r.ok) return send(res, 200, { ok: false, error: r.reason });

    try {
      const sent = await bot.sendChatLike(gid, r.text).catch(() => []);
      for (const x of sent) quest.rememberHerMsg(q, x?.message_id);
      if (!sent.length) log.warn(`[剧情] 手动推进的第 ${q.stageIndex} 段 → 群 ${gid} 一条都没发出去`);
    } catch (e) {
      return send(res, 200, { ok: false, error: `这一段写好了但发送失败：${e.message}`, text: r.text });
    }

    let settled = null;
    if (r.done) {
      try {
        settled = quest.settle(q, r.ending, (uid, d, o) => affinity.adjust(uid, d, { ...o, groupId: q.groupId }));
        // ⚠️ 手动推进也要播报（2026-09-17 用户要的"结局展示"是**群里**看到的那条，
        //    不是面板里的）。这一段刚刚已经用 `sendChatLike` 发到群了，
        //    所以同样隔 1 秒，和自动那些走一样的手感。
        const report = quest.endingReport(settled, (uid) => names.label(uid, q.groupId));
        if (report) {
          setTimeout(
            () => bot.sendToGroup(gid, report).catch((e) => log.warn(`[剧情] 结局播报发送失败：${e.message}`)),
            quest.ENDING_REPORT_DELAY_MS,
          ).unref?.();
        }
      } catch (e) {
        log.warn(`手动推进后结算失败：${e.message}`);
      }
    }
    log.info(`管理界面手动推了一段剧情 → 群 ${gid}（第 ${q.stageIndex} 段${r.done ? `，${r.ending === 'good' ? '好' : '坏'}结局` : ''}）`);
    send(res, 200, {
      ok: true,
      groupId: gid,
      text: r.text,
      event: r.event ?? '',
      done: !!r.done,
      ending: r.ending ?? null,
      settled,
      status: quest.status(gid),
    });
  },

  /**
   * 「清空剧情和故事线」（<主人> 2026-09-15 晚：「加一个清空上次故事的按钮吧，现在还在测试中」）。
   *
   * ⚠️ 这是**破坏性**操作，所以语义要一次说清（界面上也写着同样的话）：
   *   ① **中止**正在跑的剧情 —— 走 `quest.abort()`，**不写结局、不动好感度、不留 recent**
   *      （别用 `quest.finish()`：那会算好感度、还会往故事线写一条"结局"）
   *   ② 清掉**故事线历史**（`storyline.clear()`）—— 不然下次开剧情会接着上次那条的思路跑
   *   ③ 顺带把这个群的「本周开过几条」清零（测试期一周 3 条上限会挡着反复试）
   *
   * `groupId` 空着 ＝ **所有群**（界面上的"清空所有群"就是它）。
   */
  'POST /api/quest/reset': async (req, res) => {
    let gid = '';
    try {
      const b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      gid = String(b.groupId ?? '').trim();
    } catch {}
    const what = gid ? `群 ${gid}` : '所有群';
    const stopped = quest.abort(gid);
    const wiped = storyline.clear(gid);
    log.info(`管理界面清空了剧情和故事线 → ${what}（中止 ${stopped.length} 条，清掉 ${wiped.groups} 个群的故事线）`);
    send(res, 200, {
      ok: true,
      groupId: gid,
      scope: what,
      stopped,
      groups: wiped.groups,
      status: quest.status(gid || undefined),
    });
  },

  // ── 剧情模拟测试（**全在沙箱里，不落盘、不发消息、不写真实故事线**）──

  /** 「自动生成并填充并开始剧情」/「立即用自定义内容开始剧情」 */
  'POST /api/quest/sim/start': async (req, res) => {
    const b = JSON.parse((await readBody(req)).toString('utf8'));
    const hint = String(b.text ?? '').trim();
    simReset();
    const r = await withSandbox(() =>
      // ⚠️ 模拟面板**必须**带 `manual: true`：
      //    它就是给人手动测试用的，总开关关着的时候更要能跑
      //    （<主人> 反馈：「现在自动生成剧情用不了，得开剧情自动开关」—— 就是这个）
      quest.begin({ ask: llmAsk, extraHint: hint, groupId: '(模拟)', manual: true }),
    ).catch((e) => ({ ok: false, reason: e.message }));
    if (!r.ok) return send(res, 200, { ok: false, error: r.reason });
    sim.quest = r.quest;
    sim.log.push({ role: 'saki', stage: 1, text: r.text });
    sim.note = r.quest.premise;
    send(res, 200, { ok: true, ...simSnapshot() });
  },

  /**
   * 「发送并生成下一阶段剧情」。
   * `reply` 非空 → 先把"群友这句话"记进去（走和真群一样的 `isPlotReply` 判定）。
   */
  'POST /api/quest/sim/next': async (req, res) => {
    const b = JSON.parse((await readBody(req)).toString('utf8'));
    if (!sim.quest) return send(res, 200, { ok: false, error: '还没有在跑的模拟剧情' });
    const reply = String(b.reply ?? '').trim();
    const name = String(b.name ?? '').trim() || '模拟群友';
    // ★ 「强制收成好/坏结局」—— 用户要求"好坏都要能看得到"
    const forceEnd = ['good', 'bad'].includes(String(b.forceEnd)) ? String(b.forceEnd) : null;

    let skipped = false;
    // ⚠️⚠️ 这一段（记群友发言）**必须在沙箱里**。
    //    踩过：`quest.noteReply()` 原来写在 `withSandbox` **外面**，
    //    而它内部会 `save()` —— 于是模拟时往**真实的** `state/quest.json` 写了一次。
    if (reply) {
      const verdict = quest.isPlotReply({ segs: [], text: reply, selfId: '0' });
      if (verdict.hit) {
        await withSandbox(() => {
          quest.noteReply(sim.quest, { userId: 'sim', name, text: reply });
        }).catch(() => {});
        sim.log.push({ role: 'member', name, text: reply, why: verdict.why });
      } else {
        skipped = true;
        sim.log.push({ role: 'skip', name, text: reply, why: verdict.why });
      }
    }

    const r = await withSandbox(() => quest.advance(sim.quest, { ask: llmAsk, forceEnd })).catch((e) => ({
      ok: false,
      reason: e.message,
    }));
    if (!r.ok) return send(res, 200, { ok: false, error: r.reason, ...simSnapshot(), skipped });
    if (reply && !skipped) sim.quest.pending = []; // 沙箱里 advance 已消费，保持同步
    sim.log.push({ role: 'saki', stage: sim.quest.stageIndex, text: r.text, event: r.event });
    if (r.done) sim.ended = { ending: r.ending, delta: quest.endingDelta(r.ending), stages: sim.quest.stageIndex };
    send(res, 200, { ok: true, done: !!r.done, ending: r.ending ?? null, skipped, ...simSnapshot() });
  },

  'POST /api/quest/sim/reset': async (_req, res) => {
    simReset();
    send(res, 200, { ok: true, ...simSnapshot() });
  },

  // ── 好感度 / 好友 ──────────────────────────────────────
  //
  // 用户要求（2026-09-15）：「**所有关键要能修改的参数都要放到 webui**」。
  // 所以阈值、概率、白天时段、通知模板都在这儿能改；
  // 另外给了两个**手动测试按钮** —— 到 90 那条线正常要攒好几天，
  // 不给你一个立刻能验证的办法，那个功能就只能靠猜。

  'GET /api/friend/state': async (req, res) => {
    // ⚠️ 2026-09-15：榜单/好友名单都**带上名字**（群名片优先，其次昵称）——
    //    界面上光看 `30003` 认不出人（用户：「30003 是谁？」）。
    //    界面上**名字 + 号码都留**（管理用，号码有时也需要）。
    //
    // ⚠️⚠️ 2026-09-15 晚：好感度**按群**了 —— 榜单/明细都跟着 `?groupId=` 走，
    //    另外把"哪些群有数据"返回给界面做下拉框（`groups`）。
    const u = new URL(req.url, 'http://x');
    const gid = String(u.searchParams.get('groupId') ?? '').trim();
    const withName = (rows) =>
      rows.map((x) => ({ ...x, name: names.of(String(x.userId), gid) || names.of(String(x.userId)) || '' }));
    const st = friend.status();
    send(res, 200, {
      ok: true,
      groupId: gid,
      /** 有数据的群号（界面下拉框用） */
      groups: affinity.groupIds(),
      config: { ...config.affinity, ...config.friend },
      status: {
        ...st,
        friendList: withName(st.friendList ?? []),
      },
      /** ★ 排行榜预览（和 `/好感度` 命令用的是同一个口径；**按群**） */
      board: withName(affinity.top(config.affinity?.boardSize ?? 10, gid)),
      scores: affinity.status(gid),
    });
  },

  /**
   * 试一下「到线通知」长什么样（**会真的发到群里**）。
   * ⚠️ 测试**不记账**（不 markNoticed）—— 不然你测一次，真到 90 的时候就不发了。
   */
  'POST /api/friend/test-notice': async (req, res) => {
    const b = JSON.parse((await readBody(req)).toString('utf8'));
    const uid = String(b.userId ?? '').trim();
    const gid = String(b.groupId ?? '').trim() || life.targetGroups()[0];
    if (!uid) return send(res, 200, { ok: false, error: '要填一个 QQ 号' });
    if (!gid) return send(res, 200, { ok: false, error: '没有 1 档群，不知道发哪儿' });
    if (!bot?.selfId) return send(res, 200, { ok: false, error: 'QQ 没在线' });
    const text = friend.noticeText(uid);
    try {
      await bot.sendToGroup(gid, text, { at: uid });
      log.info(`管理界面试了一次到线通知 → ${uid}（群 ${gid}，测试不记账）`);
      send(res, 200, { ok: true, groupId: gid, text });
    } catch (e) {
      send(res, 200, { ok: false, error: e.message });
    }
  },

  /** 预览一条主动私聊会说什么（**不发**） */
  'POST /api/friend/preview-dm': async (req, res) => {
    const b = JSON.parse((await readBody(req)).toString('utf8'));
    const uid = String(b.userId ?? '').trim();
    if (!uid) return send(res, 200, { ok: false, error: '要填一个 QQ 号' });
    const text = await friend.composeDm(uid).catch((e) => '');
    if (!text) return send(res, 200, { ok: false, error: '这次没写出来（模型没给内容）' });
    send(res, 200, { ok: true, text });
  },

  /** 真的发一条主动私聊（**会真的发出去**） */
  'POST /api/friend/send-dm': async (req, res) => {
    const b = JSON.parse((await readBody(req)).toString('utf8'));
    const uid = String(b.userId ?? '').trim();
    if (!uid) return send(res, 200, { ok: false, error: '要填一个 QQ 号' });
    if (!bot?.selfId) return send(res, 200, { ok: false, error: 'QQ 没在线' });
    const text = String(b.text ?? '').trim() || (await friend.composeDm(uid).catch(() => ''));
    if (!text) return send(res, 200, { ok: false, error: '没写出来' });
    try {
      await bot.call('send_private_msg', {
        user_id: uid,
        message: [{ type: 'text', data: { text } }],
      });
      log.info(`管理界面手动发了一条私聊 → ${uid}`);
      send(res, 200, { ok: true, text });
    } catch (e) {
      send(res, 200, { ok: false, error: e.message });
    }
  },

  // 让她**在群里说一句**（2026-10-05 加）。
  //
  // ⚠️ 为什么需要它：群里那条「读一下这个」（<主人> 引用一个日志文件）她当时没读出来，
  //    要**补发**一条 —— 而现成的 `/api/life/send-now` 会把它当成**今天的日常事件**
  //    记进 `life.json` + 故事线（她的记忆里就凭空多出一件"她真经历过的事"）✗
  //    ⇒ 这个接口**只发话、不记账**。
  // ⚠️ 走 `sendChatLike`（不是裸 `send_group_msg`）—— 那是她所有发言的唯一出口，
  //    打码 / 口癖抑制 /「倒」降频 / 分条那一整套都在里面，绕过去就不是她的说话了。
  // 立刻试一次「同类机器人搭话」（2026-10-05 加）。
  //
  // ⚠️ 为什么需要：那个功能的定时器是"每 5 分钟看一次、群里冷场 15 分钟才开口"——
  //    想马上看到效果时，等它自己触发要十几分钟。这个接口**跳过那几道时间闸**
  //    （但仍然要求"配了同类池"），直接生成一句发出去，并**照样记账**（冷却该算）。
  'POST /api/peer-chat/now': async (req, res) => {
    let b = {};
    try {
      b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    } catch {}
    const gid = String(b.groupId ?? '').trim();
    if (!gid) return send(res, 200, { ok: false, error: '要填群号' });
    if (!bot?.selfId) return send(res, 200, { ok: false, error: 'QQ 没在线' });
    const peers = peerChat.peersOf(gid);
    if (!peers.length) {
      return send(res, 200, { ok: false, error: `群 ${gid} 没配同类池（去「按群设定」里填 QQ 号）` });
    }
    const peer = peerChat.pickPeer(gid, peers);
    const peerName = names.of(peer, gid) || peer;
    try {
      if (b.poke === true) {
        await bot.call('send_poke', { user_id: peer, group_id: gid });
        peerChat.note(gid, peer);
        log.info(`管理界面手动触发：她戳了「${peerName}」一下（群 ${gid}）`);
        return send(res, 200, { ok: true, gid, peer, name: peerName, poke: true });
      }
      const text = await peerChat.compose(gid, peer, 15 * 60 * 1000, 30000);
      if (!text) return send(res, 200, { ok: false, error: '模型没生成出内容（再试一次看看）' });
      await bot.sendToGroup(gid, text, { at: peer, atName: names.of(peer, gid) || '' });
      // ⚠️⚠️ 2026-10-16 修（用户截图：「**这个 @ 一下虽然显示发送失败，但是实际发送出去了**」）——
      //    ① 参数传错了：`note(gid, peer, text)` 把话填进了 **`now`（时间戳）** 那一位 ⇒
      //       `new Date('那句中文话')` 抛 `Invalid time value` ✗（正确写法是第 4 位 ✓）
      //    ② 更要紧的是**记账出错不该把"已经发出去的成功"报成失败** —— 发出去是不可逆的，
      //       界面报"没成"会让人以为没发、再点一次 ⇒ **群里刷两遍** ✗
      //       ⇒ 记账单独 try 掉，发送成功就一律回 ok ✓
      try {
        peerChat.note(gid, peer, Date.now(), text);
      } catch (e) {
        log.warn(`管理界面手动触发同类搭话：记账失败（消息已经发出去了）：${e.message}`);
      }
      log.info(`管理界面手动触发同类搭话 → 群 ${gid}，@「${peerName}」：「${text}」`);
      send(res, 200, { ok: true, gid, peer, name: peerName, text });
    } catch (e) {
      send(res, 200, { ok: false, error: e.message });
    }
  },

  /**
   * ⚠️ 2026-10-14 加（用户：「**现在直接补回刚才的消息**」）：
   *   **把一条消息当成"刚收到"投给她** —— 走的是正常的 `handle()` 那条路，
   *   她自己判断、自己回，跟真收到一样。
   *
   * 为什么需要它：一条"被闸拦掉 / 被重启打断"的消息，想补回来本来只有两条路，都不行 ——
   *   · `catchUpMissed()`：只认**上线前 10 分钟**的消息，而且被 `recent` / `handled`
   *     两道去重挡着 —— 而那条消息在线时**已经被收进群聊上下文了**
   *     ⇒ 补看永远不认它（去重命中）✗
   *   · 界面上的「立刻试一次」：那是让她**主动**找同类搭话（内容由模型另生成），
   *     不是"回应刚才那条"✗（实测生成的是「最近排练累不累啊」这种开场白）
   * ⇒ 这个是第三种：**原样重放一条群消息** ✓
   *
   * ⚠️ 它会在群里**真的发**一条回复（跟"手动触发同类搭话"同一性质，
   *    不可逆），所以只给本机诊断用，不做任何自动调用 ✓
   * ⚠️ `at !== false` 时会在消息前面加一个"@她"的段 —— 模拟"别人点名她"。
   */
  /**
   * ⚠️⚠️ 2026-10-16 加（用户：「我在测试**接管之后文件还能不能下载下来**，现在我把开关关了，
   *    **能不能对他发的文件进行补回**」）——
   *
   * **人工接管期间文件收不下来**（`bot.js` 那条闸直接 return ⇒ `onPrivate` 压根没跑）⇒
   * 接管一趟下来他发的文件就漏了 ⇒ 这个接口去把漏的补回来 ✓
   *   · 拉最近私聊历史（协议端 `get_friend_msg_history`），把里面**有、工作区里没有**的
   *     文件段补下来（不重复下、不推进状态机、不主动回话）
   *   · 补下来之后顺手起一次**只读预读**（和正常收到文件一个待遇）✓
   *   ⚠️ QQ 的文件有有效期 —— 要补趁早（过期只能让他重发）
   */
  // ⚠️⚠️ 2026-10-19 加（用户：「**在工作模式的分好友设置那里加一个补回消息
  //    加补看文件的按钮**」）—— 「分好友」那张表**每一行**都有这个按钮，
  //    点它就把**那个人的**消息和文件一起补回来 ✓
  //    ⚠️ 和下面 `backfill` 的区别：这条**先补消息、再补文件**（下面那条只补文件）✓
  'POST /api/private-work/backfill-both': async (req, res) => {
    if (!bot?.selfId) return send(res, 200, { ok: false, error: 'QQ 没在线' });
    let b = {};
    try {
      b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    } catch {}
    const qq = String(b.qq ?? '').trim();
    if (!/^\d{5,12}$/.test(qq)) return send(res, 200, { ok: false, error: '要填 QQ 号' });
    try {
      const pw = await import('./private-work.js');
      const r = await pw.backfillBoth(qq, bot, {
        count: Math.max(20, Number(b.count) || 60),
        // ⚠️ `say:false` = 只补、不打扰他（补文件那条会回他一句「补发一下」）
        say: b.say !== false,
      });
      return send(res, 200, r);
    } catch (e) {
      return send(res, 200, { ok: false, error: e.message });
    }
  },
  'POST /api/private-work/backfill': async (req, res) => {
    if (!bot?.selfId) return send(res, 200, { ok: false, error: 'QQ 没在线' });
    let b = {};
    try {
      b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    } catch {}
    const qq = String(b.qq ?? '').trim();
    if (!/^\d{5,12}$/.test(qq)) return send(res, 200, { ok: false, error: '要填 QQ 号' });
    try {
      const pw = await import('./private-work.js');
      const r = await pw.backfillFiles(qq, bot, Math.max(20, Number(b.count) || 40), {
        // ⚠️ 默认**顺带回他一句**（用户：「帮我补发一下收到文件之后回复的消息」）——
        //    想只补文件不打扰他，就传 `say:false` ✓
        say: b.say !== false,
      });
      return send(res, 200, r);
    } catch (e) {
      return send(res, 200, { ok: false, error: e.message });
    }
  },

  /**
   * ⚠️⚠️ 2026-10-16 加（用户：「如果对面发了 QQ 红包…**然后跑给微信收款码的逻辑**」
   *    +「**先补发一下收款码和话术再改**」）——
   *    手动把**收款码 + 那句话**补发给某个人 ✓（红包那条路也走它）
   */
  'POST /api/private-work/paycode': async (req, res) => {
    if (!bot?.selfId) return send(res, 200, { ok: false, error: 'QQ 没在线' });
    let b = {};
    try {
      b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    } catch {}
    const qq = String(b.qq ?? '').trim();
    if (!/^\d{5,12}$/.test(qq)) return send(res, 200, { ok: false, error: '要填 QQ 号' });
    try {
      const pw = await import('./private-work.js');
      const ok = await pw.sendPayCodeNow(qq, bot, { say: b.say !== false });
      return send(res, 200, { ok: !!ok, sent: !!ok });
    } catch (e) {
      return send(res, 200, { ok: false, error: e.message });
    }
  },

  'POST /api/replay-message': async (req, res) => {
    if (!bot?.selfId) return send(res, 200, { ok: false, error: 'QQ 没在线' });
    let b = {};
    try {
      b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    } catch {}
    const gid = String(b.groupId ?? '').trim();
    const uid = String(b.userId ?? '').trim();
    const text = String(b.text ?? '').trim();
    if (!gid || !uid || !text) {
      return send(res, 200, { ok: false, error: '要 groupId / userId / text 三个都填' });
    }
    const name = String(b.name ?? '').trim() || names.of(uid, gid) || uid;
    const at = b.at !== false;
    const ev = {
      post_type: 'message',
      message_type: 'group',
      group_id: Number(gid),
      user_id: Number(uid),
      self_id: bot.selfId,
      message_id: Date.now(),
      time: Math.floor(Date.now() / 1000),
      raw_message: text,
      sender: { user_id: Number(uid), nickname: name, card: name, role: 'member' },
      message: at
        ? [
            { type: 'at', data: { qq: String(bot.selfId) } },
            { type: 'text', data: { text } },
          ]
        : [{ type: 'text', data: { text } }],
    };
    log.info(
      `管理界面重放一条消息 → 群 ${gid}，来自「${name}」（${uid}）` +
        `${at ? '（带 @ 她）' : '（不带 @）'}：「${text}」`,
    );
    try {
      // ⚠️⚠️⚠️ 2026-10-14 修（真实事故：重放「继续」时**任务桥根本没收到那条消息**，
      //    她只当闲聊回了一句、压根没开工 ✗）：
      //    任务桥（`agentBridge.handle`）是在 **`onMessage`（真实消息入口）** 里接的，
      //    而这里原来只调了 `bot.handle()` ⇒ 重放的消息**跳过了任务桥** ✗
      //    ⇒ 重放必须走**和真实消息一样的那条路**：先任务桥，它不接管才交给聊天 ✓
      const { toSegments } = await import('./message.js');
      const segs = toSegments(ev.message);
      const ab = await import('./agent-bridge.js');
      if (await ab.handle(ev, segs, bot)) {
        log.info('（这条被任务桥接管了 —— 重放走的是和真实消息一样的路）');
        return send(res, 200, { ok: true, gid, uid, name, at, handled: 'task' });
      }
      await bot.handle(ev);
      send(res, 200, { ok: true, gid, uid, name, at });
    } catch (e) {
      send(res, 200, { ok: false, error: e.message });
    }
  },

  'POST /api/say': async (req, res) => {
    if (!bot?.selfId) return send(res, 200, { ok: false, error: 'QQ 没在线' });
    let b = {};
    try {
      b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    } catch {}
    const gid = String(b.groupId ?? '').trim();
    const text = String(b.text ?? '').trim();
    if (!gid) return send(res, 200, { ok: false, error: '要填群号' });
    if (!text) return send(res, 200, { ok: false, error: '要填要说的话' });
    try {
      const sent = await bot.sendChatLike(gid, text, { kind: 'manual' });
      const ok = Array.isArray(sent) && sent.length > 0;
      log.info(`管理界面手动让她在群 ${gid} 说了一句（${ok ? `发出 ${sent.length} 条` : '一条都没出去'}）`);
      send(res, 200, {
        ok,
        sent: sent ?? [],
        text,
        error: ok ? undefined : '一条都没发出去（去查协议端是不是假在线：tools/napcat-state.mjs）',
      });
    } catch (e) {
      send(res, 200, { ok: false, error: e.message });
    }
  },

  // 诊断：确认**机器人内存里**的知识库跟磁盘一致。
  //
  // ⚠️ 为什么需要：知识是启动时读进内存的，`/api/knowledge/list` 读的是**磁盘**，
  //    所以它显示对了不代表机器人答得对 —— 中间可能没热重载（踩过这个坑）。
  //    这个接口直接从内存拼一遍，并跟文件比对，不一致就报出来。
  // 群列表（带群名），给「分群灵敏度」用
  'GET /api/qq/groups': async (_req, res) => {
    let groups = [];
    if (bot?.call) {
      try {
        const list = await bot.call('get_group_list');
        if (Array.isArray(list)) {
          groups = list.map((g) => ({
            id: String(g.group_id ?? ''),
            name: String(g.group_name ?? ''),
            count: Number(g.member_count ?? 0),
          }));
        }
      } catch (e) {
        log.debug(`取群列表失败：${e.message}`);
      }
    }
    // 配置里已经写了的群也列出来（哪怕机器人现在不在那个群里）
    const cfgIds = new Set([
      ...(config.trigger.allowGroups ?? []).map(String),
      ...Object.keys(config.trigger.groupRespondTo ?? {}),
    ]);
    const seen = new Set(groups.map((g) => g.id));
    for (const id of cfgIds) {
      if (id && !seen.has(id)) groups.push({ id, name: '(配置里写的，当前不在该群)', count: 0 });
    }
    send(res, 200, {
      ok: true,
      groups,
      global: config.trigger.respondTo,
      perGroup: config.trigger.groupRespondTo ?? {},
      allowGroups: config.trigger.allowGroups ?? [],
      // ⚠️ 2026-10-07 加：「这个群回不回服务器消息」（`groupParams.<群>.chat.answerServer`）。
      //    「分群调节」那张卡片要**每行一个开关**显示它 —— 用户找的就是它
      //    （他原话是"分群调节那里"，之前做在「按群设定」页里、而且只对 1 档群显示，
      //     于是有些群压根看不到 ⇒ 他说"找不到了"）。
      answerServer: Object.fromEntries(
        Object.entries(config.groupParams ?? {})
          .map(([g, v]) => [String(g), v?.chat?.answerServer === true])
          .filter(([, on]) => on),
      ),
    });
  },

  // 设置某个群的灵敏度；level 传 0 表示「跟随全局」（删掉覆盖）
  'POST /api/qq/group-respond': async (req, res) => {
    const b = JSON.parse((await readBody(req)).toString('utf8'));
    const gid = String(b.groupId ?? '').trim();
    if (!/^\d+$/.test(gid)) return send(res, 400, { ok: false, error: '群号不合法' });
    const raw = config.trigger.groupRespondTo ?? {};
    const next = { ...raw };
    const lv = Number(b.level);
    if (lv === 0) delete next[gid];
    else if ([1, 2, 3].includes(lv)) next[gid] = lv;
    else return send(res, 400, { ok: false, error: '灵敏度只能是 1/2/3，或 0 表示跟随全局' });

    saveConfig({ trigger: { groupRespondTo: next } });
    reloadConfig();
    log.info(`管理界面设置群 ${gid} 灵敏度 = ${lv === 0 ? '跟随全局' : lv}`);
    send(res, 200, { ok: true, perGroup: config.trigger.groupRespondTo ?? {} });
  },

  /**
   * 给表情**自动补注释**（tag / who / when / desc）。
   *
   * 用户要求：「直接和更新表情库集成」——
   * 「更新表情库」扫描完如果发现缺注释的，界面上问一句「有 N 张缺注释，要补吗」，
   * 点了就走这个接口。
   *
   * ⚠️ 每张要过一次视觉模型（约 5~10 秒），所以必须**分批**：
   *    前端轮询着调，每批做完显示进度，别让一个请求挂几分钟。
   */
  'POST /api/faces/annotate': async (req, res) => {
    const b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const batch = Math.min(20, Math.max(1, Number(b.batch) || 10));

    const idx = readIndex();
    const todo = listUnannotated(idx.faces ?? []);
    if (!todo.length) {
      return send(res, 200, { ok: true, done: true, remaining: 0, added: [], message: '注释都齐了' });
    }

    const r = await annotateAll(idx.faces, {
      limit: batch,
      save: (faces) => {
        idx.faces = faces;
        writeIndex(idx);
      },
    });

    // 补完立刻重载，不用重启
    reloadFaces();

    const remaining = listUnannotated(idx.faces ?? []).length;
    log.info(`界面补表情注释：这批成功 ${r.ok}、失败 ${r.failed}，还剩 ${remaining} 张`);
    send(res, 200, {
      ok: true,
      done: remaining === 0,
      remaining,
      batch: Math.min(batch, todo.length),
      added: r.results.filter((x) => x.ok).map((x) => ({ file: x.file, tag: x.tag, who: x.who })),
      failed: r.results.filter((x) => !x.ok),
    });
  },

  'GET /api/knowledge/verify': async (req, res, url) => {
    try {
      const inMem = knowledgeText();
      const files = readdirSync(KNOW).filter(
        (n) => n.endsWith('.md') && n.toLowerCase() !== 'learned.md',
      );
      const mismatched = [];
      for (const n of files) {
        const disk = readFileSync(join(KNOW, n), 'utf8').trim();
        const probe = disk.slice(0, 60); // 取开头一段做特征
        if (probe && !inMem.includes(probe)) mismatched.push(n);
      }
      const q = String(url.searchParams.get('q') ?? '').trim();
      send(res, 200, {
        ok: true,
        memoryChars: inMem.length,
        files: files.length,
      // 空数组 = 内存跟磁盘一致
        mismatched,
        inSync: mismatched.length === 0,
      // 传 ?q=关键词 可以看内存里跟它相关的行，方便确认某条知识在不在
        matches: q
          ? (inMem.match(new RegExp(`[^\\n]*${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*`, 'g')) ?? []).slice(0, 20)
          : undefined,
      });
    } catch (e) {
      send(res, 500, { ok: false, error: e.message });
    }
  },

  'GET /api/knowledge/list': async (_req, res) => {
    const DESC = {
      'persona.md': '人设（性格、语气、行为规则、它自己的能力）',
      // ⚠️ 这三份是**角色专属的数据文件**（2026-09-21 从共用的 knowledge/ 搬进人设包）。
      //    它们**不进聊天提示词**（文件头有数据声明），但是剧情 / 日常事件的素材来源。
      'cast.md': '出场人物名册（谁可以出现在故事里、什么频率）· **角色专属**',
      'life-events.md': '一级日常事件库（她一天里会遇到哪些小事）· **角色专属**',
      'quest-ideas.md': '剧情素材池（二级主线的点子）· **角色专属**',
      // ⚠️ 2026-09-30：服务器库按主题拆成四份（原来是一份 `hzymtr-server.md`）——
      //    问什么就只带哪一份，不再整包背上（用户要求「太混乱、占字数也多」）。
      'server-basic.md': '服务器 · 进服与排障（整合包、启动器、报错、链接与指令）',
      'server-rules.md': '服务器 · 规则与权限（建设审批、OP、白名单、存档）',
      'server-world.md': '服务器 · 世界设定（线路、车站、行政区、地名、集团）',
      'server-people.md': '服务器 · 人员名录（谁是管理员、谁是谁、别名）',
      'group-memory.md': '群资料库（群友是谁、什么性格、群里的大事）',
      // ⚠️ 2026-10-02 加（用户拍板「做1」）：熟人资料独立成一份 ——
      //    `owner.md` 只对服主注入，别人问 MEI 就答"不知道"；
      //    这一份**谁问都读**，所以界面里得能直接编辑它。
      'friends.md': '熟人 / 朋友（服主现实里的朋友、老同学）· ⚠️ **谁问都读，写之前想清楚**',
      'learned.md':
        '学习档案（群里「记住：…」教的短知识，优先级最高）。⚠️ 格式有要求：每条必须是 `## 主题` 开头，' +
        '而且要保留 `<!-- LEARNED:BEGIN -->` / `END` 两行标记 —— 保存时会校验，不合格会拒绝保存',
    };
    try {
      // ⚠️ 动画库的名字**不能写死在这张表里** —— 库名是人设声明的（`anime/<库名>.md`），
      //    所以它的说明在下面列目录时现算。
      const mk = (dir, n, from) => ({
        name: n,
        desc:
          (DESC[n] ?? '') +
          (from === 'persona' ? '　📌 **人设包里的**（换人设时会一起换）' : ''),
        from,
        readonly: false,
        size: (() => {
          try {
            return readFileSync(join(dir, n), 'utf8').length;
          } catch {
            return 0;
          }
        })(),
      });
      const files = [];
      // ⚠️ 2026-09-21：人设的 md 在 `personas/<id>/`，共用库在 `knowledge/`。
      //    两边都要列出来 —— 只列 KNOW 的话界面上根本看不到人设，改都没法改。
      const pdir = personaDir();
      const inPersona = new Set();
      if (existsSync(pdir)) {
        for (const n of readdirSync(pdir)) {
          if (!n.endsWith('.md')) continue;
          inPersona.add(n.toLowerCase());
          files.push(mk(pdir, n, 'persona'));
        }
      }
      for (const n of readdirSync(KNOW)) {
        if (!n.endsWith('.md')) continue;
        // ⚠️ 人设包里已经有同名的 ⇒ 跳过。界面上只显示**真正生效**的那一份 ——
        //    否则你会看到两份 persona.md，改了不生效的那个还以为"保存了没反应"。
        if (inPersona.has(n.toLowerCase())) continue;
        files.push(mk(KNOW, n, 'knowledge'));
      }
      // ⚠️ 群资料库（`groups/<群号>.md`）也要列出来 —— 不然界面上根本看不到、改不了
      //    （2026-09-15 晚加：知识分群之后，用户要能在这儿直接编辑某个群的资料）
      try {
        const gdir = join(KNOW, 'groups');
        if (existsSync(gdir)) {
          for (const n of readdirSync(gdir)) {
            if (!n.endsWith('.md')) continue;
            const gid = n.replace(/\.md$/i, '');
            files.push({
              name: `groups/${n}`,
              desc: `群资料库 · **只给群 ${gid} 用**（别的群看不到这一份）`,
              readonly: false,
              groupId: gid,
              size: (() => {
                try {
                  return readFileSync(join(gdir, n), 'utf8').length;
                } catch {
                  return 0;
                }
              })(),
            });
          }
        }
      } catch {}
      // ⚠️ 动画库（`anime/<库名>.md`）也要列出来 —— 不然界面上看不到、改不了
      //    （2026-09-21 加：动画库改成"人设声明哪个才读哪个"之后，它必须可编辑）。
      try {
        const adir = join(KNOW, 'anime');
        if (existsSync(adir)) {
          for (const n of readdirSync(adir)) {
            if (!n.endsWith('.md')) continue;
            const lib = n.replace(/\.md$/i, '');
            files.push({
              name: `anime/${n}`,
              desc:
                `动画库 · **${lib}**　—— 只有身份里写了 \`anime.works: ["${lib}"]\` 的` +
                `人设才读得到它（换角色不会串味）`,
              from: 'knowledge',
              readonly: false,
              size: (() => {
                try {
                  return readFileSync(join(adir, n), 'utf8').length;
                } catch {
                  return 0;
                }
              })(),
            });
          }
        }
      } catch {}
      // ⚠️ 动画库的名字是人设声明的，写不进固定表 —— 这里现算一个顺序表。
      const animeNames = files.filter((f) => f.name.startsWith('anime/')).map((f) => f.name);
      const order = [
        'persona.md',
        // ⚠️ 2026-09-30：服务器库拆成四份（原来是一份 hzymtr-server.md），顺序按"最常看的在前"
        'server-basic.md',
        'server-rules.md',
        'server-world.md',
        'server-people.md',
        ...animeNames,
        'friends.md',
        'group-memory.md',
      ];
      files.sort((a, b) => {
        // ⚠️ 人设包的排最前（那是"她是谁"、最常改），其次共用库
        const fa = a.from === 'persona' ? 0 : 1;
        const fb = b.from === 'persona' ? 0 : 1;
        if (fa !== fb) return fa - fb;
        // 群资料库排在"群资料库"那一项后面、其余按原顺序
        const ga = a.name.startsWith('groups/') ? 1 : 0;
        const gb = b.name.startsWith('groups/') ? 1 : 0;
        if (ga !== gb) return ga - gb;
        if (ga && gb) return a.name.localeCompare(b.name);
        const ia = order.indexOf(a.name);
        const ib = order.indexOf(b.name);
        if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        if (a.name === 'learned.md') return 1;
        if (b.name === 'learned.md') return -1;
        return a.name.localeCompare(b.name);
      });
      send(res, 200, { ok: true, files });
    } catch (e) {
      send(res, 200, { ok: false, error: e.message, files: [] });
    }
  },

  /** 知识文件读写 */
  'GET /api/knowledge': async (_req, res, url) => {
    const name = safeKnowName(url.searchParams.get('name'));
    if (!name) return send(res, 400, { ok: false, error: '非法文件名' });
    // ⚠️ 走 `knowPath()`：人设的 md 在 `personas/<id>/`，别只认 knowledge/
    const p = knowPath(name);
    if (!existsSync(p)) return send(res, 404, { ok: false, error: '文件不存在' });
    send(res, 200, { ok: true, name, content: readFileSync(p, 'utf8') });
  },

  'POST /api/knowledge': async (req, res) => {
    const b = JSON.parse((await readBody(req)).toString('utf8'));
    const name = safeKnowName(b.name);
    if (!name) return send(res, 400, { ok: false, error: '非法文件名' });
    const content = String(b.content ?? '');
    // 群资料库：目录可能还不存在（第一次给某个群建一份）
    if (name.startsWith('groups/')) {
      try {
        mkdirSync(join(KNOW, 'groups'), { recursive: true });
      } catch {}
    }

    // ⚠️⚠️ `learned.md` **可以改了**（2026-09-14 用户要求：
    //    「在群里一句一句修改还是有点麻烦」），但它**必须过格式校验** ——
    //    这个文件是**代码在解析和维护**的（条目要 `## 主题`，还要 BEGIN/END 标记），
    //    改坏了 `learn()` / `forget()` 会**静默失效**：
    //    群主在群里说「记住：xxx」就没反应，而且很难查出原因。
    //    所以宁可拒绝保存并说清原因。
    if (name === 'learned.md') {
      const v = learnedValidate(content);
      if (!v.ok) {
        log.warn(`界面想保存 learned.md 但格式不合格：${v.error}`);
        return send(res, 400, { ok: false, error: `learned.md 格式不合格：${v.error}` });
      }
      log.info(`界面保存 learned.md（${v.entries} 条知识）`);
    }

    // ⚠️ 改之前先备份（这台机器上没有 git，手滑改坏了没法回滚）
    //    ⚠️ 写哪儿也走 `knowPath()` —— 写错地方会变成"保存成功但没生效"（真实踩过）
    const target = knowPath(name);
    backupKnowledge(target);
    writeFileSync(target, content, 'utf8');
    log.info(`管理界面更新了知识文件 ${name}`);
    // ⚠️ 必须热重载：知识是**启动时读进内存**的，只写磁盘的话
    //    机器人答的还是旧内容，用户会以为「保存成功但没生效」（真实踩过）。
    const info = reloadKnowledge();
    // ⚠️ 改了事件库 / 节日表 → 让 life 也重读（它们由 life 直接读盘，不走知识库）
    if (name === 'life-events.md' || name === 'holidays.md') {
      life.reload();
      log.info(`日常事件库/节日表已热重载：${life.status().templates} 条事件`);
    }
    log.info(`知识库已热重载：${info.files} 个文件（${info.names.join(', ')}）`);
    send(res, 200, { ok: true, reloaded: info });
  },

  /**
   * 更新表情库：扫 library/ 目录，把「有图但 index.json 里没有」的补录进来。
   * 用于：你手动往 library/ 丢图，或者在界面传了图但没填标签时，一键把它们纳入库。
   */
  'POST /api/faces/scan': async (_req, res) => {
    const idx = readIndex();
    const known = new Set((idx.faces ?? []).map((f) => f.file));
    const tags = new Set((idx.faces ?? []).map((f) => f.tag));

    const files = readdirSync(LIB).filter((n) => /\.(png|jpe?g|gif|webp)$/i.test(n));
    const added = [];
    const broken = [];
    const seen = new Set();

    for (const name of files) {
      const p = join(LIB, name);
      let buf;
      try {
        buf = readFileSync(p);
      } catch {
        continue;
      }
      // 内容重复的（同一张图两个文件名）只留一个
      const hash = createHash('md5').update(buf).digest('hex').slice(0, 12);
      if (seen.has(hash)) {
        try {
          unlinkSync(p);
          broken.push({ file: name, reason: '内容与已有图重复，已删除' });
        } catch {}
        continue;
      }
      seen.add(hash);

      if (known.has(name)) continue; // 已经在库里

      // 起一个不会撞车的临时标签。
      //
      // ⚠️ 别拿文件名当标签！自动收集的图文件名是内容 hash（`3434f69a...jpg`），
      //    拿它当 tag 的话，模型看到的表情清单就是一串乱码，
      //    而且它写 `[表情:3434f69a...]` 也选不准（踩过）。
      //    这里统一给一个「待补N」的占位 —— 不会撞车、界面上一眼能看出还没完善，
      //    补注释用 `node test/annotate-faces.js` 会自动起有意义的名字。
      let tag = '待补';
      let n = 2;
      while (tags.has(tag)) tag = `待补${n++}`;
      tags.add(tag);

      idx.faces = idx.faces ?? [];
      idx.faces.push({
        tag,
        file: name,
        who: '',
        when: '',
        desc: '',
        _未完善: true, // 标记：还缺 who / when，界面上会提示
      });
      added.push({ file: name, tag });
    }

    // 反过来：index 里登记的但文件不在了
    const onDisk = new Set(files);
    const missing = (idx.faces ?? []).filter((f) => !onDisk.has(f.file)).map((f) => f.file);
    if (missing.length) {
      idx.faces = idx.faces.filter((f) => onDisk.has(f.file));
    }

    writeIndex(idx);
    reloadFaces();
    log.info(`更新表情库：新增 ${added.length} 张，清理失效 ${missing.length} 条，删重复 ${broken.length} 张`);
    // 顺便报一下有多少张还缺注释 —— 界面据此决定要不要问「要补吗」
    const unannotated = listUnannotated(idx.faces ?? []);
    send(res, 200, {
      ok: true,
      added,
      missing,
      broken,
      unannotatedCount: unannotated.length,
      unannotatedFiles: unannotated.slice(0, 5).map((f) => f.file),
      faces: facesWithMeta(),
    });
  },

  /** QQ空间状态 */
  'GET /api/qzone': async (_req, res) => {
    send(res, 200, { ok: true, ...qzone.status() });
  },

  /** 手动发一条说说（force=true 跳过素材量和时间窗限制） */
  'POST /api/qzone/post': async (req, res) => {
    const b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    try {
      if (b.content) {
      // 直接在界面上写好内容，跳过模型生成
        const r = await qzone.publish((action, params) => bot.call(action, params), {
          content: String(b.content),
          // faces 可以是数组（多张）或逗号/顿号分隔的字符串，两种都认
          faceTags: Array.isArray(b.faces)
            ? b.faces
            : String(b.faces ?? b.face ?? '')
                .split(/[,，、\s]+/)
                .filter(Boolean),
          type: 'manual',
        });
        return send(res, 200, { ok: true, posted: true, content: b.content, tid: r?.tid });
      }
      // 让模型自己决定发什么
      const r = await bot.maybePostToQzone({ force: true });
      send(res, 200, r);
    } catch (e) {
      send(res, 200, { ok: false, error: e.message });
    }
  },

  /** 只生成不发布，给界面预览用 */
  'POST /api/qzone/preview': async (_req, res) => {
    try {
      // 素材太少就先从群历史补（重启后会遇到）
      const q = config.qzone ?? {};
      const qd = await import('./digest.js');
      if (qd.stats().count < (q.minMaterial ?? 8) && bot) {
        await bot.backfillDigest(q.backfillCount ?? 100);
      }
      const r = await qzoneCompose.compose({});
      send(res, 200, { ok: true, ...r, material: qd.stats() });
    } catch (e) {
      send(res, 200, { ok: false, error: e.message });
    }
  },

  // ── 人设（2026-09-21 加，P2）────────────────────────────────
  //
  // ⚠️ 这里的"保存"**不重启机器人**（用户 2026-09-21 定）：
  //    人设包和知识库都是**热重载**的（`persona.reload()` + `reloadKnowledge()`），
  //    存完立刻生效。重启 = 一次 QQ 登录，而这个号是风险设备，能省则省。
  'GET /api/persona/list': async (_req, res) => {
    try {
      send(res, 200, {
        ok: true,
        current: personaId(),
        packs: personaAdmin.listPacks(),
        // ⚠️ 顺手把"现在有哪些动画库"带上 —— 新建人设时的那个下拉框要用
        //    （「复用已有的库」只能从这里面选）
        animeLibs: personaDraft.availableAnimeLibs(),
      });
    } catch (e) {
      send(res, 500, { ok: false, error: e.message });
    }
  },

  'GET /api/persona': async (_req, res, url) => {
    try {
      send(res, 200, {
        ok: true,
        ...personaAdmin.readPack(url.searchParams.get('id')),
        // ⚠️ 2026-09-30 加：把「对主人例外」这个**运行开关**搭这趟车带上。
        //    它是 `config.yml` 的 `persona.ownerException`（不在 identity.json 里），
        //    但人设页要显示它的当前状态 —— 为它单开一个 GET 接口不值当。
        ownerException: config.persona?.ownerException !== false,
      });
    } catch (e) {
      send(res, e.bad ? 400 : 500, { ok: false, error: e.message });
    }
  },

  'POST /api/persona': async (req, res) => {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const saved = personaAdmin.saveIdentity(body.id, body.identity);
      // 改的是**当前正在用的**这个包 ⇒ 立刻热重载（存完就生效，不用重启）
      const reloaded = String(body.id) === personaId() ? (persona.reload(), reloadKnowledge()) : null;
      send(res, 200, { ok: true, identity: saved, reloaded });
    } catch (e) {
      send(res, e.bad ? 400 : 500, { ok: false, error: e.message });
    }
  },

  'GET /api/persona/doc': async (_req, res, url) => {
    try {
      const text = personaAdmin.readDoc(url.searchParams.get('id'), url.searchParams.get('path'));
      send(res, 200, { ok: true, text });
    } catch (e) {
      send(res, e.bad ? 400 : 500, { ok: false, error: e.message });
    }
  },

  'POST /api/persona/doc': async (req, res) => {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const r = personaAdmin.saveDoc(body.id, body.path, body.text);
      const reloaded = String(body.id) === personaId() ? reloadKnowledge() : null;
      send(res, 200, { ok: true, ...r, reloaded });
    } catch (e) {
      send(res, e.bad ? 400 : 500, { ok: false, error: e.message });
    }
  },

  'POST /api/persona/switch': async (req, res) => {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const id = String(body.id ?? '');
      personaAdmin.readPack(id); // 先验证这个包**读得出来** —— 读不了就不许切过去
      saveConfig({ persona: { id } });
      reloadConfig();
      persona.reload();
      const knowledge = reloadKnowledge();
      life.reload();
      log.info(`管理界面切换人设 → 「${id}」（热重载，没重启机器人）`);
      // ⚠️ 切完**自动**把 QQ 昵称 / 头像换成这个人设的（用户 2026-09-21 定）。
      //    失败**不影响切换本身** —— 人设已经换好了，昵称头像单独报给界面。
      const qqApply = await applyPersonaQQ(id);
      if (qqApply.nickname || qqApply.avatar) {
        log.info(
          `QQ 资料跟着换了：昵称「${qqApply.nickname || '（没改）'}」头像「${qqApply.avatar || '（没改）'}」`,
        );
      }
      if (qqApply.problems.length) log.warn(`QQ 资料没全换上：${qqApply.problems.join('；')}`);
      // ⚠️ 2026-10-09 加：把**真实落点**告诉界面。
      //    切人设只改**当前这个号**（`accounts/<QQ>.yml`），界面上过去只说
      //    "已切到 xxx"，看不出"别的号没变" ⇒ 用户会以为整个机器人换了人设。
      const wrote =
        ACCOUNT.id && accounts.has(ACCOUNT.id) ? accounts.fileOf(ACCOUNT.id) : CONFIG_FILE;
      send(res, 200, {
        ok: true,
        current: personaId(),
        status: persona.status(),
        knowledge,
        qqApply,
        wrote,
        account: ACCOUNT.id || '',
        problems: validate(),
      });
    } catch (e) {
      send(res, e.bad ? 400 : 500, { ok: false, error: e.message });
    }
  },

  'POST /api/persona/create': async (req, res) => {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      send(res, 200, { ok: true, ...personaAdmin.createPack(body.id, body.from || '_template') });
    } catch (e) {
      send(res, e.bad ? 400 : 500, { ok: false, error: e.message });
    }
  },

  'POST /api/persona/delete': async (req, res) => {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const id = String(body.id ?? '');
      if (id === personaId()) throw new Error('这是**正在用**的人设 —— 先切到别的，再删它');
      send(res, 200, { ok: true, ...personaAdmin.removePack(id) });
    } catch (e) {
      send(res, e.bad ? 400 : 500, { ok: false, error: e.message });
    }
  },

  /** 手动把某个人设的昵称/头像**立刻**应用一次（自动那次失败、或改完想马上生效时用） */
  'POST /api/persona/apply-qq': async (req, res) => {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const id = String(body.id ?? '');
      personaAdmin.readPack(id); // 先确认读得出来
      const r = await applyPersonaQQ(id);
      log.info(`手动应用 QQ 资料（${id}）：昵称「${r.nickname || '（没改）'}」头像「${r.avatar || '（没改）'}」`);
      send(res, 200, { ok: r.problems.length === 0, ...r });
    } catch (e) {
      send(res, e.bad ? 400 : 500, { ok: false, error: e.message });
    }
  },

  /**
   * 上传**人设包里的头像**。
   * ⚠️ 存进人设包（`personas/<id>/avatar.png`），**不是** `library/` ——
   *    那是表情库，混进去她可能把头像当表情发出去。
   */
  'POST /api/persona/avatar': async (req, res, url) => {
    try {
      const id = String(url.searchParams.get('id') ?? '');
      const name = String(url.searchParams.get('name') ?? 'avatar.png');
      const kind = String(url.searchParams.get('kind') ?? 'avatar');
      const buf = await readBody(req);
      // ⚠️ 头像 / 生图参考图是**两个字段、两个文件**，见 `persona-admin.saveRefImage()` 的注释
      const ext = extname(name).toLowerCase();
      const r = kind === 'ref'
        ? personaAdmin.saveRefImage(id, buf, ext)
        : personaAdmin.saveAvatar(id, buf, ext);
      // 换的是**当前正在用**的这个 ⇒ 顺手应用到 QQ 上（不然用户还得再点一次「立即应用」）
      // ⚠️ 参考图**没有**"应用到 QQ"这回事（它只喂给生图 API），别白跑一趟
      const applied = kind !== 'ref' && id === personaId() ? await applyPersonaQQ(id) : null;
      send(res, 200, { ok: true, ...r, applied });
    } catch (e) {
      send(res, e.bad ? 400 : 500, { ok: false, error: e.message });
    }
  },

  /** 读人设包里的头像 / 生图参考图（给界面预览） */
  'GET /api/persona/avatar': async (_req, res, url) => {
    try {
      const id = String(url.searchParams.get('id') ?? '');
      const kind = String(url.searchParams.get('kind') ?? 'avatar');
      const pack = personaAdmin.readPack(id);
      const rel = kind === 'ref' ? (pack.identity?.image?.refs ?? [])[0] : pack.qq.avatar;
      const f = personaAdmin.avatarFile(id, rel);
      if (!f) {
        return send(res, 404, {
          ok: false,
          error: kind === 'ref' ? '这个人设包还没有生图参考图' : '这个人设包还没有头像文件',
        });
      }
      const ext = extname(f).toLowerCase();
      sendBinary(res, 200, readFileSync(f), MIME[ext] ?? 'application/octet-stream');
    } catch (e) {
      send(res, e.bad ? 400 : 500, { ok: false, error: e.message });
    }
  },

  // ── QQ 昵称 / 头像（2026-09-21 加）──────────────────────────
  //
  // ⚠️ 这两样**不跟人设绑定**（用户 2026-09-21 定：「祥子的昵称和头像直接取当前的就行了」）——
  //    换人设**不会**自动改它们，这里只是"看当前是什么 + 想改的时候有个地方改"。
  // ⚠️ 改的是**QQ 上真实的昵称/头像**（所有群、所有好友都看得见），不是机器人内部的设置。
  // ⚠️ 走 OneBot 标准 action，**协议端不支持就如实报错**（`provider.unsupported` 那套精神：
  //    绝不假装成功）。SnowLuma 有 `set_qq_profile` / `set_qq_avatar`，别的实现不一定有。
  'GET /api/qq/profile': async (_req, res) => {
    if (!bot?.call) return send(res, 200, { ok: false, error: '机器人还没连上协议端' });
    try {
      const info = await bot.call('get_login_info');
      const uin = info?.user_id ? String(info.user_id) : '';
      send(res, 200, {
        ok: true,
        uin,
        nickname: info?.nickname ?? '',
        // ⚠️ 头像用 QQ 官方的公开地址（qlogo），**不依赖协议端**支持什么 action ——
        //    这样"看一眼现在长什么样"在任何实现下都能work。
        avatarUrl: uin ? `https://q1.qlogo.cn/g?b=qq&nk=${uin}&s=640` : '',
      });
    } catch (e) {
      send(res, 200, { ok: false, error: e.message });
    }
  },

  'POST /api/qq/profile': async (req, res) => {
    if (!bot?.call) return send(res, 200, { ok: false, error: '机器人还没连上协议端' });
    let nickname = '';
    try {
      nickname = String(JSON.parse((await readBody(req)).toString('utf8') || '{}').nickname ?? '').trim();
    } catch (e) {
      return send(res, 400, { ok: false, error: `请求体不是合法 JSON：${e.message}` });
    }
    if (!nickname) return send(res, 400, { ok: false, error: '昵称不能为空' });
    if (nickname.length > 36) return send(res, 400, { ok: false, error: '昵称太长了（QQ 上限比这还短）' });
    try {
      await bot.call('set_qq_profile', { nickname });
      // ⚠️ **写完读回来核对** —— "以为改了其实没改"这种事，用户要过很久才发现
      //    （跟 `autostart` 那条一个道理）。
      const info = await bot.call('get_login_info').catch(() => null);
      const now = info?.nickname ?? '';
      const ok = now === nickname;
      log.info(`管理界面改 QQ 昵称：目标「${nickname}」→ 现在「${now}」`);
      send(res, 200, {
        ok,
        nickname: now,
        error: ok ? '' : `协议端没改（现在还是「${now}」）—— 这个协议端可能不支持 set_qq_profile`,
      });
    } catch (e) {
      send(res, 200, { ok: false, error: `协议端拒绝了改昵称：${e.message}` });
    }
  },

  /** 换 QQ 头像：上传的图片先落到 logs/，再把**绝对路径**交给 `set_qq_avatar` */
  'POST /api/qq/avatar': async (req, res, url) => {
    if (!bot?.call) return send(res, 200, { ok: false, error: '机器人还没连上协议端' });
    const name = String(url.searchParams.get('name') ?? 'avatar.png').trim();
    const ext = extname(name).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
      return send(res, 400, { ok: false, error: `不支持的格式 ${ext}` });
    }
    const buf = await readBody(req);
    if (!buf.length) return send(res, 400, { ok: false, error: '文件是空的' });
    if (buf.length > 8 * 1024 * 1024) return send(res, 400, { ok: false, error: '图片太大了（>8MB）' });
    // ⚠️ 存 `logs/` 而**不是** `library/` —— library 是**表情库**，
    //    丢一张头像进去，她下次发图就可能把这张头像当表情发出去。
    const file = join(ROOT, 'logs', `upload-avatar-${Date.now()}${ext}`);
    try {
      mkdirSync(join(ROOT, 'logs'), { recursive: true });
      writeFileSync(file, buf);
    } catch (e) {
      return send(res, 400, { ok: false, error: `图片存不下：${e.message}` });
    }
    try {
      // ⚠️ OneBot 的 `file` 参数：给**本地绝对路径**（多数实现也认 `file://` 和 base64）
      await bot.call('set_qq_avatar', { file });
      log.info(`管理界面换了 QQ 头像（${(buf.length / 1024).toFixed(1)} KB）`);
      send(res, 200, { ok: true, bytes: buf.length });
    } catch (e) {
      send(res, 200, { ok: false, error: `协议端拒绝了换头像：${e.message}` });
    }
  },

  /**
   * **联网自动填**（P3）：给「角色名 + 作品名」，搜资料 + 让模型起草一份人设。
   *
   * ⚠️ **只起草，不落盘** —— 起草要联网、要花模型钱，结果必须让用户过一眼、
   *    改完、点保存，才走 `/api/persona/create` + `/api/persona`（那两条才是写盘的）。
   * ⚠️ 用户原话：「自动化的关键就在这里，我希望尽量少地使用人力」——
   *    所以能自动的都自动（搜索、字段、正文、示例对话），但**判断权留给他**。
   * ⚠️ 超时给到 3 分钟：搜一轮 + 起一次长输出，慢的时候真的会到一分钟以上。
   */
  'POST /api/persona/draft': async (req, res) => {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const r = await personaDraft.draft(body, { signal: AbortSignal.timeout(180000) });
      send(res, 200, r);
    } catch (e) {
      log.warn(`起草人设失败：${e.message}`);
      send(res, e.bad ? 400 : 500, { ok: false, error: e.message });
    }
  },

  'POST /api/reload': async (_req, res) => {
    reloadConfig();
    reloadFaces();
    // ⚠️ 2026-09-14 补上知识库（用户要求）。
    //    原来这里**只重载 config + 表情**，不包括知识库 ——
    //    而知识库是**启动时读进内存**的，所以「用编辑器直接改了 md」
    //    再点这个按钮是**没用的**，必须重启（重启＝又一次 QQ 登录，能省则省）。
    //    现在名字叫「重载配置」的这个按钮，把知识库一起带上，符合预期。
    const knowledge = reloadKnowledge();
    life.reload();
    log.info(`管理界面重载：config + 表情库 + 知识库 + 日常事件库（${knowledge.files} 个文件）`);
    send(res, 200, {
      ok: true,
      config: configForUi(),
      problems: validate(),
      faces: facesWithMeta(),
      knowledge,
    });
  },
};

/** 静态资源：管理界面自己的页面 + library 下的图片 */
function serveStatic(req, res, url) {
  let rel = url.pathname;
  if (rel === '/' || rel === '/index.html') return send(res, 200, loadPage(), MIME['.html']);

  // ⚠️ 必须先解码：文件名可能是中文，url.pathname 是百分号编码的，
  //    不解码就会去磁盘上找「%E6%88%B4%E9%94%85.jpg」这种名字，导致预览图 404。
  let name;
  try {
    name = decodeURIComponent(basename(rel));
  } catch {
    return send(res, 400, '文件名编码错误', 'text/plain; charset=utf-8');
  }

  let file;
  if (rel.startsWith('/library/')) {
    file = join(LIB, name);
  } else if (rel.startsWith('/assets/')) {
    file = join(ROOT, 'src', 'webui-assets', name);
  } else {
    return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }

  if (!existsSync(file)) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  send(res, 200, readFileSync(file), MIME[extname(file).toLowerCase()] ?? 'application/octet-stream');
}

// ⚠️ 2026-09-17 改成**按请求热读**（原来是启动时读一次 → 改一行 CSS 都得重启）。
//    起因：用户问「为什么重启要这么久」。重启本身只要 30~40 秒，贵的是它之后那段
//    「重启 = 一次 QQ 登录」的风控间隔（≥5 分钟）—— 于是调个界面颜色要等 5 分钟。
//    现在每次请求只 statSync 一下 mtime，变了才重读磁盘：**改界面 → 刷新即生效，零重启**。
//    界面拿 `__PAGE_VER__`（= 文件 mtime）跟 `/api/pagever` 比，不一致就提示刷新。
let PAGE = '<!doctype html><title>加载中</title><p>管理界面文件缺失</p>';
let PAGE_VER = '0';
function loadPage() {
  try {
    const p = join(ROOT, 'src', 'webui.html');
    const ver = String(Math.round(statSync(p).mtimeMs));
    if (ver !== PAGE_VER) {
      PAGE = readFileSync(p, 'utf8').replace('__PAGE_VER__', ver);
      PAGE_VER = ver;
    }
  } catch {
    // 读不到就沿用内存里那份（别把界面搞挂）；只有一次都没读到过才报错
    if (PAGE_VER === '0') log.error('找不到 src/webui.html，管理界面不可用');
  }
  return PAGE;
}
loadPage();

/**
 * 界面上"正在控制哪个号"。
 *
 * ⚠️ 还没做多号拆分时（`ACCOUNT.id` 是空的，配置和设置全在 config.yml 里），
 *    界面上也得有个号可显示、可控制 —— 那就是 `config.yml` 里的 `botQQ`。
 *    （不这么做的话，「QQ 号」那一页会是空的，用户连自己现在控制谁都不知道。）
 */
function displayId() {
  return ACCOUNT.id || String(config.botQQ ?? '').trim();
}

/**
 * 「拆分了没有」——⚠️ **看磁盘，不看这个进程的内存**（2026-10-07 修）。
 *
 * 踩到的（用户原话：「为什么加不上新号，一直说没拆分」）：
 *   拆分动作是**写文件**（`accounts/<QQ>.yml` + config.yml 的 mainAccount），
 *   而当前进程的 `ACCOUNT` 是**启动时定下的常量** —— 拆完不重启，它就还是空的。
 *   于是 `/api/whoami` 一直报 `split:false`，界面据此把"加号"拦住 ⇒
 *   用户被困在"点了拆分 → 还说没拆分 → 加不上号"的循环里。
 *   ⇒ 判据改成"**磁盘上已经有主号的账号文件了**"；另外单给一个
 *     `needRestart`，界面照它提示"重启后生效"（进程没重启时保存私有段
 *     仍然会写回 config.yml，所以那个提示是必须的，不是客套）。
 */
function splitState() {
  const id = displayId();
  const onDisk = !!ACCOUNT.id || (accounts.isValidId(id) && accounts.has(id));
  return { split: onDisk, needRestart: onDisk && !ACCOUNT.id };
}

/**
 * 某个号的管理界面端口（2026-10-07 多 QQ 号）。
 *
 * ⚠️ 主号在 `config.yml` 里（那是**共用**那份的 `webui.port`，默认 3099）；
 *    别的号各自记在 `accounts/<QQ>.yml` 的 `webui.port` 里。
 * ⚠️ 主号**没有账号文件**时也要能算出来（老用户没迁移）⇒ 最后那条兜底。
 */
function portOfAccount(qq) {
  const mine = Number(config.webui?.port) || 3099;
  // ⚠️ 还没拆分时，"主号"就是本进程自己在跑的那个号（按 botQQ 认）
  if (!ACCOUNT.id && qq === String(config.botQQ ?? '').trim()) return mine;
  if (qq === ACCOUNT.id) return mine;
  const p = Number(accounts.read(qq)?.webui?.port);
  if (p) return p;
  if (qq === ACCOUNT.main) return mine;
  return 0;
}

/**
 * 把请求**转发给另一个号的那个进程**（2026-10-07 多 QQ 号的核心）。
 *
 * 为什么要有它：每个号是一个独立进程（各自一套单例状态），
 * 而用户只用**一个**浏览器页面 —— 页面上切到哪个号，
 * 请求就由"用户连着的那个进程"转发给"那个号的进程"，
 * 于是所有既有接口（`/api/state`、`/api/life/...`、保存配置…）**一行都不用改**，
 * 它们在那个进程里照常读写自己的数据。
 *
 * ⚠️ 去头 `x-saki-account` 是**必须的**：不去的话对面会照着同一个头再转一次，
 *    两个进程之间来回弹（排查时表现为"界面转圈转到超时"）。
 * ⚠️ 只透传几个必要的头（这是本机、无登录的界面；cookie 之类没必要，
 *    而且把 `host`/`connection` 这些逐个透传反而容易踩 undici 的禁止头）。
 */
async function proxyToAccount(qq, req, res, url) {
  const port = portOfAccount(qq);
  if (!port) {
    return send(res, 200, { ok: false, offline: true, error: `号 ${qq} 还没配管理界面端口` });
  }
  let body = null;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      body = await readBody(req);
    } catch (e) {
      return send(res, 400, { ok: false, error: e.message });
    }
  }
  const headers = {};
  for (const k of ['content-type', 'accept', 'accept-language']) {
    if (req.headers[k]) headers[k] = req.headers[k];
  }
  try {
    // ⚠️ 2026-10-17：转发到**别的号**的界面也必须直连 —— 走代理 ⇒ 转发失败 ⇒ 页面拿到**空响应** ✗
    //    （见文件顶部 `localFetch` 那段：内置 fetch 会被 ProxyAgent 接管）
    const up = await localFetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: body && body.length ? body : undefined,
    });
    const buf = Buffer.from(await up.arrayBuffer());
    res.writeHead(up.status, {
      'content-type': up.headers.get('content-type') ?? 'application/json; charset=utf-8',
      'content-length': buf.length,
      'cache-control': 'no-store',
    });
    res.end(buf);
  } catch (e) {
    log.debug(`转发给号 ${qq}（界面端口 ${port}）失败：${e.message}`);
    send(res, 200, {
      ok: false,
      offline: true,
      error: `号 ${qq} 的进程没在运行（界面端口 ${port} 连不上）—— 它起来之后刷新这一页就行`,
    });
  }
}

export function startWebUI(botInstance = null) {
  bot = botInstance;
  if (!config.webui.enable) {
    log.info('管理界面已关闭（config.yml 里 webui.enable: false）');
    return null;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const key = `${req.method} ${url.pathname}`;

    try {
      // ⚠️ 多 QQ 号：页面在"当前控制哪个号"上带的头。指的不是本进程就转发过去。
      //    只对 `/api/` 生效 —— 静态资源和图片仍由本进程给（表情库是共用的）。
      //    ⚠️⚠️ 端口等于自己就**不转发**：没拆分时"主号"和本进程是同一个，
      //      转给自己会导致请求永远不返回（表现为界面一直转圈）。
      const want = String(req.headers['x-saki-account'] ?? '').trim();
      const minePort = Number(config.webui?.port) || 3099;
      if (want && want !== ACCOUNT.id && url.pathname.startsWith('/api/')) {
        const tp = portOfAccount(want);
        if (tp && tp !== minePort) return await proxyToAccount(want, req, res, url);
        if (!tp) {
          return send(res, 200, {
            ok: false,
            offline: true,
            error: `号 ${want} 没在运行（也没有它的界面端口）`,
          });
        }
      }
      if (routes[key]) return await routes[key](req, res, url);
      return serveStatic(req, res, url);
    } catch (e) {
      log.error(`管理界面 ${key} 出错: ${e.message}`);
      if (!res.headersSent) send(res, 500, { ok: false, error: e.message });
    }
  });

  // ⚠️ 2026-10-19：端口被占时自动重试的次数（要声明在 `server.on('error')` **之前**）✓
  let retries = 0;

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      // ⚠️⚠️⚠️ 2026-10-19 修（用户截图「**读不到号列表（服务端出错了）**」）——
      //    真实现场：`[21:53:17] ERR 管理界面端口 3099 被占用` ⇒ 之后**再也没起过界面**，
      //    可机器人本体照常在跑（群里还会说话）⇒ 用户只看到界面挂了，还以为代码坏了 ✗
      //    真因：重启时上一个进程**还没完全释放端口**（TIME_WAIT / 退出慢），
      //      这一次启动就永久放弃了 —— 不会再试 ✗
      //    ⇒ 现在**自动重试**：隔几秒再 bind 一次，最多 6 次（覆盖"旧进程慢退出"的窗口）✓
      //      ⚠️ 不换端口：换了端口用户按老地址就打不开，比报错还迷惑 ✗
      retries += 1;
      if (retries <= 6) {
        const waitMs = Math.min(1500 * retries, 6000); // 1.5s → 3s → 4.5s → 6s…
        log.warn(
          `管理界面端口 ${config.webui.port} 还被占着（第 ${retries}/6 次）` +
            `⇒ ${Math.round(waitMs / 1000)} 秒后重试（多半是上一个进程还没退干净）`,
        );
        try {
          server.close();
        } catch {}
        setTimeout(() => {
          try {
            server.listen({ port: config.webui.port, host, ipv6Only: false }, () => {
              log.info(
                ` 管理界面: http://${host === '::' ? '127.0.0.1' : host}:${config.webui.port}` +
                  `（端口重试第 ${retries} 次成功 ✓）`,
              );
            });
          } catch (e2) {
            log.error(`管理界面重试启动失败: ${e2.message}`);
          }
        }, waitMs).unref?.();
        return;
      }
      log.error(
        `管理界面端口 ${config.webui.port} 被占用（重试 6 次都不成）⇒ ` +
          `手动关掉占用的程序，或者改 config.yml 里的 webui.port`,
      );
    } else if (e.code === 'EADDRNOTAVAIL' && config.webui.host === '::') {
      // 有些环境没有 IPv6，退回只监听 IPv4
      log.warn('没有可用的 IPv6，退回只监听 127.0.0.1');
      config.webui.host = '127.0.0.1';
      startWebUI();
    } else {
      log.error(`管理界面启动失败: ${e.message}`);
    }
  });;

  // host 用 "::" 时 Node 默认同时接受 IPv4 和 IPv6（双栈），
  // 这样浏览器无论是走 127.0.0.1 还是 localhost→::1 都能打开。
  const host = config.webui.host === '127.0.0.1' ? '::' : config.webui.host;

  server.listen({ port: config.webui.port, host, ipv6Only: false }, () => {
    log.info('═══════════════════════════════════════');
    log.info(` 管理界面: http://127.0.0.1:${config.webui.port}`);
    log.info('═══════════════════════════════════════');
  });

  return server;
}

export { configForUi, facesWithMeta };
