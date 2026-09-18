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
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';

import { config, reloadConfig, validate, ROOT, CONFIG_FILE, KNOWLEDGE_DIR, paramsFor } from './config.js';
import { log } from './log.js';
import { ping } from './llm.js';
import { queryServer, describe, clearCache } from './status.js';
import * as napcat from './napcat.js';
// ⚠️ 协议端适配层（2026-09-17 加）：管理面按它分派，换协议端只改 config.yml
import * as provider from './provider.js';
// ⚠️ 开机自启（2026-09-17 加）：写注册表 Run 键，界面上开/关
import * as autostart from './autostart.js';
import { backupKnowledge } from './backup.js';
import { listUnannotated, annotateAll } from './face-annotate.js';
// 二维码画图（纯 JS，无原生依赖）
import QR from 'qrcode';
import { listEntries } from './learned.js';
import { faceTags, reload as reloadFaces } from './faces.js';
import { hasKnowledge, reloadKnowledge, knowledgeText } from './knowledge.js';
import * as life from './life.js';
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
 *    踩过的真 bug（2026-09-15，HZY 发现「没发到群里却写进了故事线」）：
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
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
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

// ── 配置：读写 ────────────────────────────────────────

/** 只保留界面关心的字段，避免把运行时状态写回文件 */
function configForUi() {
  return {
    llm: { ...config.llm },
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

/** 界面提交的配置 → 合并进现有 yaml（保留其它字段） */
function saveConfig(patch) {
  const raw = yaml.load(readFileSync(CONFIG_FILE, 'utf8')) ?? {};

  const put = (section, fields) => {
    if (!patch[section]) return;
    raw[section] = raw[section] ?? {};
    for (const [k, v] of Object.entries(patch[section])) {
      if (v !== undefined) raw[section][k] = v;
    }
  };

  put('llm', patch.llm);
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
  // ⚠️ 分群参数（2026-09-15）——和 configForUi 里那一行是**一对**，别只加一个
  put('groupParams', patch.groupParams);
  if (patch.ownerQQ !== undefined) raw.ownerQQ = patch.ownerQQ;
  if (patch.botQQ !== undefined) raw.botQQ = patch.botQQ;
  if (patch.logLevel !== undefined) raw.logLevel = patch.logLevel;

  // 顶层字段顺序：保持一个可读的顺序
  const order = [
    'onebot',
    'llm',
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
  if (patch.life) {
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

const routes = {
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
  'POST /api/models': async (req, res) => {
    const t = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    // 界面上可能改了 baseURL / apiKey 还没保存，所以以传来的为准
    const baseURL = String(t.baseURL ?? config.llm.baseURL ?? '').replace(/\/+$/, '');
    const apiKey = String(t.apiKey ?? config.llm.apiKey ?? '');
    if (!baseURL) return send(res, 200, { ok: false, error: 'baseURL 是空的' });

    try {
      const r = await fetch(`${baseURL}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(20000),
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
    const saved = { ...config.llm };
    if (t.llm) Object.assign(config.llm, t.llm);
    const started = Date.now();
    try {
      const reply = await ping();
      send(res, 200, { ok: true, ms: Date.now() - started, reply: String(reply).trim().slice(0, 60) });
    } catch (e) {
      send(res, 200, { ok: false, error: e.message });
    } finally {
      Object.assign(config.llm, saved); // 测试不改真实配置
    }
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

      // 已经登录了就没码可扫（免得界面上挂一张废码让人白扫）
      const st = await napcat.loginStatus().catch(() => null);
      if (st?.ok && st.isLogin === true) {
        return send(res, 409, { ok: false, error: 'QQ 已经登录了，不需要扫码' });
      }

      // ⚠️ 2026-09-17：**NapCat 没在跑就别发码**。
      //    以前这里会把 `cache/qrcode.png` 直接发出去 —— 那是**上次留下的旧码**，
      //    几分钟就死了，用户扫半天扫不动（「这码就没扫成功过」的一部分原因）。
      if (!st?.ok) {
        return send(res, 503, { ok: false, error: 'NapCat 没在运行 —— 先点「启动 NapCat」' });
      }

      const expired = /过期|刷新/.test(String(st?.loginError ?? ''));
      const before = napcat.qrcodeFile();
      if (wantFresh || expired || !before) {
        const r = await napcat.refreshQrcode().catch((e) => ({ ok: false, message: e.message }));
        log.debug(`二维码：请求重出 fresh=${wantFresh} expired=${expired} 无文件=${!before} → ${r.ok ? '已发出' : r.message}`);
        if (r.ok) await new Promise((s) => setTimeout(s, 1200));
      }

      // ① 优先 NapCat 自己写的原图（**太旧的不要**，见 qrcodeFile() 里的 stale）
      const f = napcat.qrcodeFile();
      if (f && !f.stale) return sendBinary(res, 200, readFileSync(f.path), 'image/png');

      // ② 退回：按缓存 URL 自己画
      //    ⚠️ 但那 URL 就是上面那张旧图的同一个快照 —— 图都过期了，画出来也是死码，
      //       所以 stale 的时候宁可说"没有"，别给用户一张扫不动的图（2026-09-17）。
      const q = await napcat.getQrcode();
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

  // 轻量「重新出码」：**只是让 NapCat 重出一张**（`RefreshQRcode`）。
  //
  // ⚠️ 原来界面上的「重新出码」调的是 `/api/qq/restart` → `RestartNapCat`，
  //    那是**重启整个 NapCat 进程** = 一次 QQ 登录（风控信号）+ 等 20 秒，
  //    而且新实例还没把码生成出来界面就去取了 → 「一直不出」。
  //    重出二维码是个轻活，用轻接口。
  'POST /api/qq/refresh-qr': async (_req, res) => {
    if (!provider.can('refreshQr')) {
      return send(res, 200, { ok: false, message: provider.unsupported('refreshQr'), hasImage: false });
    }
    const r = await napcat.refreshQrcode();
    log.info(`管理界面请求重新出码：${r.ok ? 'ok' : r.message}`);
    if (r.ok) await new Promise((s) => setTimeout(s, 1200));
    const f = napcat.qrcodeFile();
    send(res, 200, { ok: r.ok, message: r.message ?? '', hasImage: !!f && !f.stale });
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
  // ── 日常事件：预览 / 立即发送（2026-09-15 HZY：「日常事件也加一个预览和立即发送」）──
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

  // ── 故事线（**每个群一份**，2026-09-15 HZY 要求）────────────────
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
   * **按群覆盖参数**（HZY：「参数也可以分群设定」）。
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
    // ⚠️⚠️ **只有 1 档群才进事件系统**（HZY 2026-09-15：「挡位 2 不能进事件系统，只有 1 才能设置」）。
    //    2 档群只是"她会在那儿说话"，没有日常事件也没有剧情 —— 给它设这些参数毫无意义，
    //    而且会让人以为"设了就会生效"。直接拒绝，并告诉他去哪儿改档位。
    if (!life.isEventGroup(gid)) {
      const lv = config.trigger?.groupRespondTo?.[gid];
      return send(res, 200, {
        ok: false,
        error:
          `群 ${gid} 不是 1 档群（当前档位 ${lv ?? '没配'}）→ **不进事件系统**，` +
          '设了也不会生效。想让它收日常事件/跑剧情，先去「群与触发」把档位改成 1。',
      });
    }
    const raw = yaml.load(readFileSync(CONFIG_FILE, 'utf8')) ?? {};
    raw.groupParams ??= {};
    const cur = raw.groupParams[gid] ?? {};
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
    if (Object.keys(cur).length) raw.groupParams[gid] = cur;
    else delete raw.groupParams[gid];
    // ⚠️ 先备份再写（和其它保存一样，走 `backupKnowledge` 那条路不需要 —— 这是配置文件）
    writeFileSync(CONFIG_FILE, yaml.dump(raw, { lineWidth: 120, noRefs: true }), 'utf8');
    reloadConfig();
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
   * ⚠️ 2026-09-15 晚改**按群**（HZY：「最好也加个群选择…因为每个群的故事线不一样」）：
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
    // ⚠️ **只有 1 档群才进事件系统**（HZY 2026-09-15：「挡位 2 不能进事件系统，只有 1 才能设置」）
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
   * 「推进下一段 / 收尾」（2026-09-15 晚 HZY：「**也和模拟一样也加一套剧情控制按钮**」）。
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
   * 「清空剧情和故事线」（HZY 2026-09-15 晚：「加一个清空上次故事的按钮吧，现在还在测试中」）。
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
      //    （HZY 反馈：「现在自动生成剧情用不了，得开剧情自动开关」—— 就是这个）
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
      'hzymtr-server.md': '服务器知识库（进服、排障、规则、存档）',
      'anime.md': '二次元常识（BanG Dream 各团等）',
      'group-memory.md': '群资料库（群友是谁、什么性格、群里的大事）',
      'learned.md':
        '学习档案（群里「记住：…」教的短知识，优先级最高）。⚠️ 格式有要求：每条必须是 `## 主题` 开头，' +
        '而且要保留 `<!-- LEARNED:BEGIN -->` / `END` 两行标记 —— 保存时会校验，不合格会拒绝保存',
    };
    try {
      const order = ['persona.md', 'hzymtr-server.md', 'anime.md', 'group-memory.md'];
      const files = readdirSync(KNOW)
        .filter((n) => n.endsWith('.md'))
        .map((n) => ({
          name: n,
          desc: DESC[n] ?? '',
          readonly: false,
          size: (() => {
            try {
              return readFileSync(join(KNOW, n), 'utf8').length;
            } catch {
              return 0;
            }
          })(),
        }));
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
      files.sort((a, b) => {
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
    const p = join(KNOW, name);
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
    backupKnowledge(join(KNOW, name));
    writeFileSync(join(KNOW, name), content, 'utf8');
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
      if (routes[key]) return await routes[key](req, res, url);
      return serveStatic(req, res, url);
    } catch (e) {
      log.error(`管理界面 ${key} 出错: ${e.message}`);
      if (!res.headersSent) send(res, 500, { ok: false, error: e.message });
    }
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log.error(`管理界面端口 ${config.webui.port} 被占用，换一个端口或关掉占用的程序`);
    } else if (e.code === 'EADDRNOTAVAIL' && config.webui.host === '::') {
      // 有些环境没有 IPv6，退回只监听 IPv4
      log.warn('没有可用的 IPv6，退回只监听 127.0.0.1');
      config.webui.host = '127.0.0.1';
      startWebUI();
    } else {
      log.error(`管理界面启动失败: ${e.message}`);
    }
  });

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
