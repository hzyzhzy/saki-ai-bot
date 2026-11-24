#!/usr/bin/env node
/**
 * 客户端版 OneBot v11 协议端 —— 用 QQ 客户端（UIA + 键鼠）替代 SnowLuma。
 *
 * ## 它做什么
 *   1. 起一个 **WebSocket 服务端**（默认 6700），等机器人连上来；
 *   2. 机器人连上后，按 OneBot v11 契约回应：
 *        · 生命周期：`meta_event.lifecycle`、`meta_event.heartbeat`
 *        · 查询类 API：`get_login_info` / `get_group_list` / `get_friend_list` / `get_status` / `get_version_info`
 *        · 发送类 API：`send_group_msg` / `send_private_msg` / `send_msg` / `delete_msg`(不支持)
 *   3. **收消息**：轮询 `tools/qq-inbox.mjs`（读 QQ 界面）→ 发现新的 → 包装成 `post_type:message` 事件推给机器人；
 *   4. **发消息**：`tools/qq-client.mjs send`（切群 → 点输入框 → paste → 回车）。
 *
 * ## 为什么用「假协议端」而不是改 bot
 *   bot 只认 OneBot v11。让它连这个假协议端，**bot 一行代码都不用改**，
 *   而且随时能改回 SnowLuma（改一行 `onebot.url` 即可）✓
 *
 * ## 用法
 *   node tools/qq-onebot.mjs --port 6700 --pid 33932 --hwnd 17437954
 *   node tools/qq-onebot.mjs --once        # 只跑一轮轮询就退出（自测用）
 *
 * ## 安全
 *   · 只读 UIA + 键鼠，不改 QQ 任何文件
 *   · 发消息前核对群名（防止发错群），发完把窗口藏回托盘
 */

import { createServer } from 'node:http';
import {
  runPy as anodeRunPy,
  parseLastJson as anodeJson,
  acquireLease as anodeLease,
  findQQHwnd as anodeFindQQ,
} from './anode-call.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
// 稳定伪号 / 稳定消息 id（2026-11-17：抽到库里，主脚本和测试共用）
import { pseudoUid, msgIdOf } from './lib/qq-pure.mjs';
// 2026-11-17：发消息时给 daemon 让路（它轮转切群要 2.5~3.3 秒）
import { writeFileSync as _wHold, unlinkSync as _rmHold } from 'node:fs';
import { join as _joinPath } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
// 脱敏/控件层用 Python（uiautomation 库那条通道，读树深度够）
const PYTHON = 'C:\\Temp\\dbenv\\Scripts\\python.exe';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const num = (n, d) => {
  const x = Number(arg(n));
  return Number.isFinite(x) ? x : d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ⚠️ ws 帧级诊断日志（默认关，刷屏太厉害；排查协议问题时用 --ws-debug 打开）
const WS_DEBUG = argv.includes('--ws-debug');

const PORT = num('port', 6700);
const PID = num('pid', 33932);
// ⚠️ 2026-11-15：默认改成 0 = **启动时自动探测**。
//    seat 里的 QQ 每次重启 hwnd 都会变（1902218 → 132512 → …），写死就得每次改代码。
//    显式传 `--hwnd N` 时仍以命令行优先（便于调试）。
let HWND = num('hwnd', 0);
const SELF_QQ = String(num('self', 10000002));
const POLL_MS = num('poll', 4000);
const ONCE = argv.includes('--once');
// 要读的群名（可选）：给了就要求当前会话必须是它，防止把别的群消息当成本群的
const groupHint = String(arg('group', '') || '').trim();

const STATE_DIR = join(ROOT, 'state');
const GROUPS_FILE = join(STATE_DIR, 'group-names.json');
const LOG_FILE = join(STATE_DIR, 'qq-onebot.log');

function log(...a) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`;
  console.log(line);
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    // ⚠️ 第一次文件还不存在 —— 之前直接 readFileSync 会抛 ENOENT 被 catch 吞掉，
    //    结果日志文件**从来没被创建过**（排查时白白找了半天）✗
    let prev = "";
    try { prev = readFileSync(LOG_FILE, "utf8"); } catch {}
    writeFileSync(LOG_FILE, prev + line + "\n", "utf8");
  } catch {}
}

/* ────────────────────────── 极简 WebSocket 服务端 ──────────────────────────
 * 不想引 ws 依赖（这台机器 node_modules 里有没有不确定），自己按 RFC6455 实现：
 * 只支持「服务端接受握手 + 收发文本帧 + ping/pong + 关闭」，OneBot 够用。
 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAccept(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

/** 解一帧；返回 {opcode, payload, consumed} 或 null（数据不够） */
function wsParse(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const hi = buf.readUInt32BE(2);
    const lo = buf.readUInt32BE(6);
    len = hi * 4294967296 + lo;
    off = 10;
  }
  let mask = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    mask = buf.slice(off, off + 4);
    off += 4;
  }
  if (buf.length < off + len) return null;
  let payload = buf.slice(off, off + len);
  if (mask) {
    const out = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
    payload = out;
  }
  return { opcode, payload, consumed: off + len };
}

/** 组一帧（服务端不需要 mask） */
function wsFrame(payload, opcode = 1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let head;
  if (len < 126) {
    head = Buffer.allocUnsafe(2);
    head[0] = 0x80 | opcode;
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.allocUnsafe(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.allocUnsafe(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeUInt32BE(0, 2);
    head.writeUInt32BE(len, 6);
  }
  return Buffer.concat([head, data]);
}

/* ────────────────────────── 工具：调子脚本 ────────────────────────── */
// ⚠️ 实测踩过：轮询和我手动跑的 qq-inbox 同时操作同一个 QQ 窗口 ⇒ **双双卡死**，
//    子进程不退出、适配器 CPU 停在 1 秒、API 请求全部超时 ✗
//    ⇒ 进程内串行化：同一时刻只跑一个读界面的子进程。
let _qqBusy = false;
async function withLock(fn) {
  const t0 = Date.now();
  while (_qqBusy) {
    if (Date.now() - t0 > 120000) throw new Error("等锁超时（另一个读界面任务卡住了）");
    await new Promise((r) => setTimeout(r, 200));
  }
  _qqBusy = true;
  try {
    return await fn();
  } finally {
    _qqBusy = false;
  }
}

function runNode(script, args = [], timeout = 120000) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [join(HERE, script), ...args],
      { cwd: ROOT, timeout, maxBuffer: 40 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        let json = null;
        const txt = String(stdout || '');
        for (const line of txt.split(/\r?\n/).reverse()) {
          if (!line.trim()) continue;
          try {
            json = JSON.parse(line);
            break;
          } catch {}
        }
        resolve({ ok: !err && !!json?.ok, json, stdout: txt, stderr: String(stderr || ''), error: err?.message });
      },
    );
  });
}

/* ────────────────────────── 状态 ────────────────────────── */
const conns = new Set(); // 连上来的 WebSocket
let lastSnapshot = new Set();
// ⚠️ 2026-11-18：去重 key → 上次推送时间戳。用来把"永久去重"改成"5 分钟窗口"，
//   否则同一个人重发同一句话会被永远吞掉（用户调试时就是这样哑掉的）。
let lastSeenAt = new Map();
// ── 扫会话（2026-11-17 恢复）：群名 → 上次见到的摘要，变了才考虑切过去读
const sessionSig = new Map();
let scanReady = false;
// 只有这些摘要才算"在找她"：@她 / 戳她（后面必须跟「你」）/ 私聊单独判
const HOT_RE = /\[有人@我\]|@Saki|Saki酱|(?:捏了捏|拍了拍|戳了戳|揉了揉)\s*你/i; // key = gid|who|text（去重）
// ⚠️ 第一轮只建基线不推送 —— 实测踩过：轮询比机器人连接早 20 秒，
//    6 条事件推给了「还没人连上」的空连接列表 ⇒ 全丢 ✗
let baselineReady = false;
let lastGroups = {}; // 群号 → 群名
let stats = { received: 0, sent: 0, pushed: 0, errors: 0, lastPollAt: 0, lastPollMs: 0 };

function loadGroups() {
  try {
    const j = JSON.parse(readFileSync(GROUPS_FILE, 'utf8'));
    lastGroups = j.groups || {};
  } catch {
    lastGroups = {};
  }
  return lastGroups;
}

function nameToGid(name) {
  const clean = String(name || '').trim();
  if (!clean) return '';
  // 先按群名精确/包含匹配（群名是主键的反面：这里只用来把界面上的群名换回群号）
  for (const [gid, g] of Object.entries(lastGroups)) {
    if (String(g.name || '').trim() === clean) return gid;
  }
  for (const [gid, g] of Object.entries(lastGroups)) {
    const gn = String(g.name || '').trim();
    if (gn && (gn.includes(clean) || clean.includes(gn))) return gid;
  }
  // 本身就是数字 ⇒ 当群号
  if (/^\d{6,}$/.test(clean)) return clean;
  return '';
}

/* ────────────────────────── 发消息到所有已连客户端 ────────────────────────── */
function send(obj) {
  const s = JSON.stringify(obj);
  // 2026-11-17：加成功/失败计数 —— 原来 `catch {}` 把写失败吞得一点痕迹都没有，
  // 结果"适配器说推了、bot 那边一条没有"这种问题只能靠猜。
  let _ok = 0;
  let _bad = 0;
  let _why = '';
  for (const c of conns) {
    try {
      c.socket.write(wsFrame(s));
      _ok++;
    } catch (e) {
      _bad++;
      _why = String(e.message || e).slice(0, 60);
    }
  }
  if (obj && (obj.post_type === 'message' || obj.post_type === 'notice') && (_bad || !_ok)) {
    log(
      'send: ' +
        String(obj.post_type) +
        ' 写出 ' +
        _ok +
        '/' +
        conns.size +
        ' 个连接' +
        (_bad ? '，失败 ' + _bad + '（' + _why + '）' : '，但一个连接都没有 ⇒ bot 没连上') ,
    );
  }
}

/* ────────────────────────── OneBot message → 纯文本 ────────────────────────── */
/**
 * OneBot 的 message 是**段数组**（[{type:"text",data:{text:"…"}}, {type:"at",…}]），
 * ⚠️ 直接 String() 会得到 "[object Object]" 并发出去（实测踩过）。
 * 客户端方案只能发文字，所以这里只取文本段，@ 和其他段转成可读文字。
 */
function oneBotToText(message) {
  if (message == null) return "";
  if (typeof message === "string") return message;
  if (!Array.isArray(message)) {
    if (typeof message === "object" && message.data) return String(message.data.text ?? "");
    return String(message);
  }
  const parts = [];
  for (const seg of message) {
    if (!seg || typeof seg !== "object") { if (seg) parts.push(String(seg)); continue; }
    const t = String(seg.type || "");
    const d = seg.data || {};
    if (t === "text") parts.push(String(d.text ?? ""));
    else if (t === "at") {
      const qq = String(d.qq ?? "");
      parts.push(qq === "all" ? "@全体成员 " : `@${d.name || qq} `);
    } else if (t === "face") parts.push("[表情]");
    else if (t === "image") parts.push("[图片]");
    else if (t === "reply") { /* 引用，跳过 */ }
    else if (d.text) parts.push(String(d.text));
  }
  return parts.join("").trim();
}

/* ────────────────────────── OneBot API 实现 ────────────────────────── */
// ⚠️⚠️ 2026-11-19 修（用户报：「一条拆成 3 条的消息发很久，而且中途一直在切窗口，
//    锁根本没生效一样」）——
//    真因：hold 是**每条 `send_*` 各写一次、发完立刻删**。
//    一次回复拆成 3 条 ⇒ 写了删、写了删、写了删，**条与条之间有空档**
//    ⇒ daemon 就在那几十毫秒里跑了一轮、切了窗口 ⇒ 和下一条的发送抢界面 ✗
//    ⇒ 改成**延迟释放**：每次 send 都把"释放计时"重置，最后一次发完
//      `HOLD_RELEASE_MS` 内没有新的 send 才真的删掉 hold 文件。
//      这样整批发送期间 hold 一直在，daemon 全程让路 ✓
//    ⚠️ 6 秒 < daemon 的 `HOLD_STALE_SEC`(15 秒)，不会被它当成"发送方崩了"清掉 ✓
const HOLD_RELEASE_MS = 6000;
let holdReleaseTimer = null;

async function callApi(action, params = {}) {
  // ⚠️ 2026-11-17：**发消息时让 daemon 让路**。
  //    daemon 为了轮转读别的群，每轮都要切群（2.5~3.3 秒）；它一暂停，
  //    发送就不用再切群 ⇒ 用户看到"生成完到发出去"从 5 秒压到 2 秒内。
  if (/^send_/.test(String(action))) {
    const holdPath = _joinPath(process.cwd(), 'state', 'daemon-hold');
    if (holdReleaseTimer) {
      clearTimeout(holdReleaseTimer);
      holdReleaseTimer = null;
    }
    try {
      _wHold(holdPath, String(Date.now()), 'utf8');
    } catch {}
    try {
      return await callApiInner(action, params);
    } finally {
      // ⚠️ 不立刻删 —— 一批多条时条间只有几十毫秒，立刻删就等于给 daemon 开门
      if (holdReleaseTimer) clearTimeout(holdReleaseTimer);
      holdReleaseTimer = setTimeout(() => {
        holdReleaseTimer = null;
        try {
          _rmHold(holdPath);
        } catch {}
      }, HOLD_RELEASE_MS);
      try {
        holdReleaseTimer.unref?.();
      } catch {}
    }
  }
  return callApiInner(action, params);
}

async function callApiInner(action, params = {}) {
  switch (action) {
    case 'get_login_info':
      return { status: 'ok', retcode: 0, data: { user_id: Number(SELF_QQ), nickname: 'Saki' } };
    case 'get_group_list': {
      loadGroups();
      const data = Object.entries(lastGroups).map(([gid, g]) => ({
        group_id: Number(gid),
        group_name: String(g.name || ''),
        member_count: Number(g.count || 0),
      }));
      return { status: 'ok', retcode: 0, data };
    }
    case 'get_friend_list':
      return { status: 'ok', retcode: 0, data: [] };
    case 'get_status':
      return {
        status: 'ok',
        retcode: 0,
        data: { online: true, good: true, app_initialized: true, app_enabled: true },
      };
    case 'get_version_info':
      return { status: 'ok', retcode: 0, data: { app_name: 'qq-onebot-client', app_version: '0.1.0', protocol_version: 'v11' } };
    case 'can_send_image':
    case 'can_send_record':
      return { status: 'ok', retcode: 0, data: { yes: false } };
    // ⚠️⚠️ 2026-11-19 加（用户：「然后回戳工具调用了没反应」）——
    //    这之前**根本没有这个 case** ⇒ bot 调 `send_poke` 直接落到 default、
    //    连一行日志都不打 ⇒ 她"戳回去"永远没有动作，用户看到的就是"没反应" ✗✗
    //    客户端方案没有 OneBot 的戳接口，只能走 UI：`qq-poke.py`（右键头像 → 戳一戳）。
    //    ⚠️ UIA 不暴露 QQ 号 ⇒ 只能**按昵称定位**；bot 侧已经在传 `nickname` ✓
    case 'send_poke': {
      const who = String(params.nickname || '').trim();
      if (!who) {
        log('❌ send_poke：没收到 nickname（客户端只能按昵称定位，UIA 不暴露 QQ 号）');
        stats.errors++;
        return { status: 'failed', retcode: 1400, msg: '客户端 poke 需要 nickname' };
      }
      try {
        const out = await anodeRunPy('qq-poke.py', ['--hwnd', String(HWND), '--to', who], {
          timeoutMs: 120000,
        });
        const j = anodeJson(String(out || ''));
        if (j && j.ok) {
          log('👉 戳回去了：「' + who + '」');
          return { status: 'ok', retcode: 0, data: { nickname: who } };
        }
        log('❌ 戳不回去（' + who + '）：' + JSON.stringify(j || {}).slice(0, 180));
        stats.errors++;
        return { status: 'failed', retcode: 1401, msg: String(j?.error || 'poke failed') };
      } catch (e) {
        log('❌ send_poke 出错：' + String(e.message || e).slice(0, 140));
        stats.errors++;
        return { status: 'failed', retcode: 1402, msg: String(e.message || e) };
      }
    }
    case 'send_group_msg':
    case 'send_msg': {
      const gid = String(params.group_id || '');
      const text = oneBotToText(params.message).trim();
      // ⚠️⚠️ 2026-11-21 加**发图 / 发表情**（「把表情和发照片都做成工具，anode 模式也要能正常调用」）——
      //    `sendFace()` / `sendFaceFile()` / `runPhoto()` 都是
      //    `sendText(event, '', { faceFile })` ⇒ 最终 `send_group_msg` 的 message 里是
      //    `[{type:'image', data:{file:'<本地路径>'}}]`，**text 是空的**。
      //    而下面原来那条 `if (!text) return 消息为空` 会把它**直接拒掉** ✗✗
      //    ⇒ 先提取图片段；只有图没字的也算合法消息 ✓
      //
      //    ⚠️ 客户端发图走 `qq-send-image.py`（点「图片」按钮 → 文件对话框 → 输入路径 → 发送），
      //      和文字是**两条路**（一条消息只能是其中一种）。
      //      图和字同时有时：**先发图、再发字**（她在群里连发两条的样子）✓
      const imgPaths = [];
      if (Array.isArray(params.message)) {
        for (const seg of params.message) {
          if (!seg || seg.type !== 'image') continue;
          const f = String(seg.data?.file ?? '').trim();
          if (f) imgPaths.push(f);
        }
      }
      if (!gid) return { status: 'failed', retcode: 100, msg: '缺少 group_id' };
      if (!text && !imgPaths.length) return { status: 'failed', retcode: 100, msg: '消息为空' };
      const groupName = lastGroups[gid]?.name || '';
      if (!groupName) {
        log('❌ 拒绝发送：群', gid, '没有群名映射（防止发错群）');
        stats.errors++;
        return { status: 'failed', retcode: 100, msg: '群名未知，拒绝发送' };
      }
      log('📤 发送 →', gid, groupName, ':', text.slice(0, 40));
    // ⚠️ 2026-11-17 21:20 握手：先让 daemon 切过去（它只要 0.4 秒，我这里切要 3 秒）
    let _noSwitch = false;
    try {
      const reqP = _joinPath(process.cwd(), 'state', 'daemon-switch-to');
      const ackP = _joinPath(process.cwd(), 'state', 'daemon-switched');
      _wHold(reqP, groupName, 'utf8');
      try {
        _rmHold(ackP);
      } catch {}
      const t0 = Date.now();
      // ⚠️⚠️ 2026-11-19 修（用户：「发送速度还是很慢」）——
      //    实测每条 `📤 发送 → ✅ 已发出` 要 **11~17 秒**，而 qq-py.py 内部只占 2.4 秒，
      //    剩下全耗在**等握手**上：我上一版把等待放到 8 秒，daemon 一忙（切群+等渲染+
      //    读消息要 3~6 秒）适配器就干等满 8 秒，然后才走"自己切" ✗✗
      //    ⇒ 收到确认最多等 **3 秒**（daemon 现在一轮 0.63 秒，3 秒足够它响应）；
      //      等不到就自己切（约 3 秒）⇒ 最坏 6 秒，比干等 8 秒好得多 ✓
      while (Date.now() - t0 < 5000) {
        try {
          const ack = readFileSync(ackP, 'utf8').trim();
          if (ack === groupName) {
            _noSwitch = true;
            log('🤝 daemon 已切到「' + groupName + '」（' + (Date.now() - t0) + 'ms），跳过自己切群');
            // ⚠️⚠️ 2026-11-18 修（实测：**一次发送触发了 7 次握手 / 3.3 秒**）——
            //    请求文件原来要等到 qq-py.py 跑完（2.4~4 秒）才删，而 daemon 每轮
            //    都会看到它 ⇒ **每轮都再切一次群**（日志：连续 7 条「握手：替发送方切到…」，
            //    每次 356~542ms，全白白烧掉）✗
            //    ⇒ 收到确认就**立刻删请求**（daemon 已经切好了，留着只会让它重复切）。
            try {
              _rmHold(reqP);
            } catch {}
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 150));
      }
      if (!_noSwitch) log('😐 daemon 没在 5 秒内切好，走老路自己切');
    } catch (e) {
      log('握手出错：' + String(e.message || e).slice(0, 60));
    }
            // ⚠️ 用 Python 版 qq-py.py（纯控件层，实测可用）：
      //    ① 切群：window.SetActive() + InvokePattern.Invoke（不 SetActive 会静默失效）
      //    ② 已在目标群就**不再切**（再切会把会话关掉）
      //    ③ 聚焦：SetFocus（不动鼠标）
      //    ④ 输入：SendKeys（**只有这步要前台**，ProseMirror 不能写值）
      //    ⑤ 发送：找「发送」按钮走 InvokePattern（不动鼠标）
      //    ⑥ 验证：核对 chat-header 群名 + 输入框清空
      // ⚠️⚠️ 2026-11-21 加**引用**（客户端模式原来只能读不能发）——
      //    bot 侧调 `[工具:引用 {"引用谁":"张三"}]` 之后，`send_group_msg` 的
      //    `message` 里会多一个 `{type:'reply', data:{id:<message_id>}}`（SnowLuma 就吃这个）。
      //
      //    ⚠️ 但客户端这边的 `message_id` 是 **`msgIdOf()` 算的哈希假 ID**（不可逆）✗
      //      ⇒ 只能**遍历 `state/qq-seen.jsonl` 重算一遍**、匹配出那条消息的 `who` ✓
      //      （`msgIdOf` 的公式就是 `群|谁|正文` 的 FNV 哈希，见 `lib/qq-pure.mjs`）
      //    ⇒ 拿到 `who` 之后传给 `qq-py.py send --quote <who>`，
      //      它在打字之前会**右键那个人的气泡 → 点「引用」** ✓
      const quoteWho = (() => {
        try {
          const segs = Array.isArray(params.message) ? params.message : [];
          const rep = segs.find((s) => s && s.type === 'reply');
          const wantId = String(rep?.data?.id ?? '').trim();
          if (!wantId) return '';
          const fpath = _joinPath(process.cwd(), 'state', 'qq-seen.jsonl');
          let raw = '';
          try {
            raw = readFileSync(fpath, 'utf8');
          } catch {
            return '';
          }
          // 从后往前找（最近的更可能是她要引的那条）
          const lines = raw.split('\n').filter((x) => x.trim());
          for (let i = lines.length - 1; i >= 0; i--) {
            let o;
            try {
              o = JSON.parse(lines[i]);
            } catch {
              continue;
            }
            if (String(o.g || '') !== groupName) continue;
            const who = String(o.w || '');
            if (!who) continue;
            const id = String(msgIdOf(String(o.g || ''), { who, text: String(o.t || '') }));
            if (id === wantId) return who;
          }
          log('引用：message_id=' + wantId.slice(0, 12) + ' 在落盘记录里找不到对应的人 ⇒ 不引用');
          return '';
        } catch (e) {
          log('引用：反查出错（照常发普通消息）：' + String(e.message || e).slice(0, 80));
          return '';
        }
      })();
      if (quoteWho) log('引用：要引「' + quoteWho + '」那条 ⇒ 走 UI 右键气泡');

      // ⚠️⚠️ 2026-11-21 加**发图**（表情包 / 拍照 / 截图都走这条）——
      //    `qq-send-image.py`：点「图片」按钮 → 系统文件对话框 → 输入路径 → 回车 → 点发送。
      //    ⚠️ **图在字之前发**：一条 QQ 消息只能是"图"或"字"，
      //      图和字同时有时，她在群里看起来就是连发两条 ✓
      //    ⚠️ 发图失败**不挡后面的文字**（用户至少还能收到她说的话）✓
      let imgOk = 0;
      let imgErr = '';
      if (imgPaths.length) {
        for (const p of imgPaths.slice(0, 3)) {
          try {
            // ⚠️⚠️ 2026-11-21 **必须带 --group**（用户：「肯定是爱音那边啊，sl 怎么可能有这种低级错误」）——
            //    `qq-send-image.py` 原来只往**当前打开的会话**发图、不切群 ✗
            //    而 daemon 一直在后台按需切群 ⇒ 图会发到 daemon 当时切过去的那个群 ✗✗
            //    文字那条（`qq-py.py send --group`）一直有切群+header 校验，只有图这条漏了。
            //    ⇒ 现在把 groupName 传进去，脚本内部切群 + 校验 header，对不上就不发 ✓
            const out = await withLock(async () =>
              anodeRunPy(
                'qq-send-image.py',
                ['--hwnd', String(HWND), '--file', p, '--group', groupName],
                { timeoutMs: 180000 },
              ),
            );
            const s = String(out || '');
            if (/"ok":\s*true/.test(s)) {
              imgOk++;
              log('🖼 图已发：' + String(p).split(/[\\/]/).pop());
            } else {
              imgErr = s.slice(-200);
              log('❌ 发图失败：' + imgErr.slice(0, 160));
            }
          } catch (e) {
            imgErr = String(e.message || e).slice(0, 160);
            log('❌ 发图出错：' + imgErr);
          }
        }
        // 纯图片消息（没有文字）⇒ 发完就算成功，不再走文本那条路
        if (!text) {
          try {
            _rmHold(_joinPath(process.cwd(), 'state', 'daemon-switch-to'));
            _rmHold(_joinPath(process.cwd(), 'state', 'daemon-switched'));
          } catch {}
          stats.sent = (stats.sent || 0) + (imgOk ? 1 : 0);
          if (!imgOk) stats.errors++;
          return imgOk
            ? { status: 'ok', retcode: 0, data: { message_id: `img-${Date.now()}` } }
            : { status: 'failed', retcode: 1501, msg: '图片没发出去: ' + imgErr.slice(0, 120) };
        }
      }

      const pyRet = await withLock(async () => {
        const { execFile } = await import('node:child_process');
        return new Promise((resolve) => {
          // ⚠️ 2026-11-15 改：在 seat 里发送（`anode exec -- python qq-py.py send`）。
          //    实测 seat 里 **3.4 秒一次成功**，而且**不抢用户前台** ✓
          anodeRunPy('qq-py.py', ['send', '--hwnd', String(HWND), '--group', groupName, '--text', text, ...(quoteWho ? ['--quote', quoteWho] : []), ...(_noSwitch ? ['--no-switch'] : [])], {
            timeoutMs: 240000,
          })
            .then((out) => {
              const ok = /发送成功|已点发送/.test(String(out || '')); // 2026-11-17：提速后输出是「已点发送（不等验证）」
              resolve({ ok, code: ok ? 0 : 1, out: String(out || '').slice(-1200), err: '' });
            })
            .catch((err) => resolve({ ok: false, code: 1, out: '', err: String(err.message || err).slice(-400) }));
        });
      });
      // ⚠️⚠️ 2026-11-17 23:03：**握手请求必须删掉**，否则 daemon 每轮都看到它、
      //    一直切群（实测连切 6 次），还会卡在"让路"状态不再正常轮转 ✗
      try {
        _rmHold(_joinPath(process.cwd(), 'state', 'daemon-switch-to'));
      } catch {}
      try {
        _rmHold(_joinPath(process.cwd(), 'state', 'daemon-switched'));
      } catch {}
      const r = { ok: pyRet.ok, json: { error: pyRet.ok ? '' : pyRet.out || pyRet.err } };
      if (!r.ok) {
        stats.errors++;
        log('❌ 发送失败:', JSON.stringify(r.json?.error || r.error || r.stderr).slice(0, 200));
        return { status: 'failed', retcode: 100, msg: '发送失败：' + (r.json?.error || r.error || '') };
      }
      stats.sent++;
      const mid = Date.now();
      log('✅ 已发出 message_id=', mid);
      return { status: 'ok', retcode: 0, data: { message_id: mid } };
    }
    case 'get_group_msg_history': {
      // ⚠️⚠️ 2026-11-17 19:38（用户：「历史不是本来就是一直在落盘的吗，为什么还要现调啊」）：
      //    daemon 每轮切群读整个窗口，**读到的全落盘**在 state/qq-seen.jsonl（上限 300 条）。
      //    补看直接查这个文件就行 —— 不用再读界面（界面可能已被 daemon 切走，会读错群）。
      const wantGid2 = String(params.group_id || params.group || '');
      const lim2 = Math.max(1, Math.min(300, Number(params.count || params.limit || 20) || 20));
      try {
        loadGroups();
        const wantName =
          String(lastGroups[wantGid2]?.name || '') || String(params.group_name || '') || '';
        const fpath = _joinPath(process.cwd(), 'state', 'qq-seen.jsonl');
        let raw = '';
        try {
          raw = readFileSync(fpath, 'utf8');
        } catch {
          raw = '';
        }
        const rows = [];
        // ⚠️⚠️⚠️ 2026-11-21 **修串群**（「不能是调到其他群的聊天记录」）——
        //    原来写的是 `if (wantName && String(o.g) !== wantName) continue;`
        //    ⇒ **`wantName` 为空时整条 if 不成立 ⇒ 完全不过滤** ✗✗
        //    实测现场：`group_id=999999999`（这个群**根本不存在**）也返回了 50 条，
        //    而那 50 条是 seen.jsonl 里**所有群混在一起**的最后 50 条 ✗
        //
        //    `wantName` 什么时候会空？
        //      · `lastGroups[gid].name` 没有（群列表还没同步 / 新拉进群 / 映射丢了）
        //      · 且调用方没传 `group_name`
        //    ⇒ 那一刻"不知道这个 gid 对应哪个群名"，而数据只能按**群名**过滤
        //      （`qq-seen.jsonl` 里存的 `g` 是**群名**，不是群号）。
        //
        //    ⇒ 现在的规矩：**映射不到就返回空** —— 宁可这条历史查不到，
        //      也绝不把别的群的聊天记录当成这个群的给她 ✗
        //      （真缺映射就往 `state/groups.json` 补，别在数据上猜）
        if (!wantName) {
          log('⚠️ get_group_msg_history：群 ' + (wantGid2 || '(空)') + ' 没有群名映射 ⇒ 返回空（不猜、不串群）');
        }
        for (const line of raw.split('\n')) {
          if (!wantName) break;
          const t = line.trim();
          if (!t) continue;
          try {
            const o = JSON.parse(t);
            if (String(o.g || '') !== wantName) continue;
            rows.push(o);
          } catch {}
        }
        const tail = rows.slice(-lim2);
        const msgs = tail.map((o) => {
          const who = String(o.w || '');
          const uid = pseudoUid(who);
          const segs = [];
          if (o.img) {
            segs.push({ type: 'image', data: { file: _joinPath(process.cwd(), 'state', String(o.img)) } });
          }
          segs.push({ type: 'text', data: { text: String(o.t || '') } });
          return {
            message_id: msgIdOf(String(o.g || ''), { who, text: String(o.t || '') }),
            time: Number(o.ts || 0),
            sender: { user_id: uid, nickname: who, card: who, role: 'member' },
            message: segs,
            raw_message: String(o.t || ''),
            _atMe: !!o.at,
            _self: !!o.self,
            _quote: String(o.q || ''),
          };
        });
        log('补看(落盘)：' + (wantName || wantGid2) + ' 共 ' + rows.length + ' 条，取最后 ' + msgs.length + ' 条');
        return { status: 'ok', retcode: 0, data: { messages: msgs, _total: rows.length, _from: 'seen.jsonl' } };
      } catch (e) {
        return { status: 'ok', retcode: 0, data: { messages: [], _err: String(e.message || e).slice(0, 100) } };
      }
    }
    case 'get_group_info': {
      loadGroups();
      const gid2 = String(params.group_id || '');
      const g2 = lastGroups[gid2];
      if (!g2) return { status: 'failed', retcode: 1404, msg: '没有这个群' };
      return {
        status: 'ok',
        retcode: 0,
        data: { group_id: Number(gid2), group_name: String(g2.name || ''), member_count: Number(g2.count || 0) },
      };
    }
    case 'get_group_member_list': {
      /* 客户端方案实现：先切到那个群（`Invoke` 不需要前台），读右侧「群成员列表」面板，
       * 读完切回原来的会话。
       * ⚠️ 代价：每次调用约 2~4 秒（切群 1.2s + 读树 0.4s + 切回 1.2s）。
       * ⚠️ 如果当前已经是目标群，会跳过切换（`do_switch` 里的判断）。 */
      const gidm = String(params.group_id || '');
      const gm = lastGroups[gidm];
      if (!gm) return { status: 'failed', retcode: 1404, msg: '没有这个群' };
      const gname = String(gm.name || '');
      const mr = await withLock(async () => {
        const { execFile } = await import('node:child_process');
        return new Promise((resolve) => {
          // ⚠️ 2026-11-15 改：在 seat 里读群成员 ✓
          anodeRunPy('qq-members.py', ['--hwnd', String(HWND)], { timeoutMs: 180000 })
            .then((out) => {
              const json = anodeJson(out);
              resolve({ ok: !!json?.ok, json, err: json ? '' : 'anode exec 没返回 JSON' });
            })
            .catch((err) => resolve({ ok: false, json: null, err: String(err.message || err) }));
        });
      });
      if (!mr.ok || !mr.json) {
        return { status: 'failed', retcode: 1500, msg: '读群成员失败：' + (mr.json?.error || mr.err || '未知') };
      }
      // ⚠️ 校验读到的群是不是目标群（否则返回的是别的群的人）
      const gotGroup = String(mr.json.group || '');
      if (gname && gotGroup && !gotGroup.includes(gname.slice(0, 6)) && !gname.includes(gotGroup.slice(0, 6))) {
        return { status: 'failed', retcode: 1500, msg: `读到的不是目标群（当前=${gotGroup}，要=${gname}）` };
      }
      const list = (mr.json.list || []).map((m) => ({
        group_id: Number(gidm),
        user_id: 0, // ⚠️ 客户端读不到 QQ 号（UIA 不暴露），只能给 0
        nickname: String(m.nickname || ''),
        card: String(m.card || m.nickname || ''),
        role: m.role === 'owner' ? 'owner' : m.role === 'admin' ? 'admin' : 'member',
      }));
      return { status: 'ok', retcode: 0, data: list };
    }
    case 'get_file': {
      // 2026-11-17（用户：「读日志也补好」）：
      //   bot.js 的 `fetchLogFile()` 第三条路就是 `get_file` —— 拿到本地路径就 readFileSync，
      //   再交给 `mclog.analyzeFile()` 解析（实测能解析用户的 latest.log：350 行 / 12 个异常）。
      //   客户端方案下没有 file_id，只能**按文件名**找那条文件消息再右键「保存」。
      const want = String(params.file_id || params.name || params.file || '').trim();
      if (!want) return { status: 'failed', retcode: 1400, msg: '要 file_id 或 name（客户端方案按文件名找）' };
      try {
        const out = await anodeRunPy('qq-save-file.py', ['--hwnd', String(HWND), '--name', want], {
          timeoutMs: 240000,
        });
        const j2 = anodeJson(String(out || ''));
        if (j2?.ok && j2.path) {
          log('取文件成功：' + want + ' → ' + j2.path + '（' + j2.size + ' 字节）');
          return { status: 'ok', retcode: 0, data: { file: String(j2.path), size: Number(j2.size || 0), name: want } };
        }
        log('取文件失败：' + want + ' / ' + String(j2?.error || '无返回').slice(0, 80));
        return { status: 'failed', retcode: 1500, msg: '取文件失败：' + String(j2?.error || '没返回路径') };
      } catch (e) {
        return { status: 'failed', retcode: 1500, msg: '取文件异常：' + String(e.message || e).slice(0, 80) };
      }
    }
    case 'get_msg':
      return { status: 'failed', retcode: 1404, msg: '客户端方案不支持按 id 取消息' };
    case 'set_group_ban':
    case 'set_group_kick':
    case 'set_group_whole_ban':
      return { status: 'failed', retcode: 1404, msg: '客户端方案不支持群管理操作' };
    case 'delete_msg':
      return { status: 'failed', retcode: 1404, msg: '客户端方案不支持撤回' };
    default:
      return { status: 'failed', retcode: 1404, msg: `不支持的 action: ${action}` };
  }
}

/* ────────────────────────── 轮询 QQ 界面 → 推事件 ────────────────────────── */
/**
 * 扫会话列表，返回**摘要变了的**会话（参考 QuitBot 的 `MessageCursor`：
 * 靠"上次见到什么"推进，而不是靠时间或位置）。
 *
 * ⚠️ 只读列表、**不切群** —— 实测 `qq-sessions.py` 2~3 秒，切群才是 10~20 秒。
 */
async function scanSessionsOnce() {
  const out = await anodeRunPy('qq-sessions.py', ['--hwnd', String(HWND), '--wake'], {
    timeoutMs: 120000,
  });
  const j = anodeJson(String(out || ''));
  const all = Array.isArray(j?.all) ? j.all : [];
  const changed = [];
  for (const x of all) {
    const nm = String(x.name || '').trim();
    if (!nm) continue;
    const sig = String(x.summary || '') + '|' + String(x.kind || '');
    const prev = sessionSig.get(nm);
    sessionSig.set(nm, sig);
    if (!scanReady) continue; // 第一轮只建基线
    if (prev !== sig) changed.push({ name: nm, summary: String(x.summary || ''), kind: String(x.kind || '') });
  }
  scanReady = true;
  return changed;
}

// ⚠️⚠️ 2026-11-17 19:00（用户：「只留一个」「同一条消息又回了两次」）：
//    **停掉这条路径** —— 现在消息只由 `/push`（daemon）推。
//    原因：pollOnce 和 daemon 各有一份内存去重集合（`lastSnapshot` / `SEEN`），
//    谁重启谁清空 ⇒ 屏幕上的历史又被推一遍 ⇒ 她重复回 ✗
//    daemon 已有视口过滤 / 摘要驱动 / 每群基线 / self 过滤 / 私聊判据 / 引用解析，
//    一条路就够；两条路并行只会互相不知道对方推过什么。
let _pollIdle = 0;
async function pollOnce() {
  _pollIdle++;
  if (_pollIdle % 60 === 0) {
    log('（轮询空闲：消息由 daemon 推，pollOnce 不再读界面）');
  }
  return 0;
}

async function pollOnceLegacy() {
  return withLock(async () => {
  const t0 = Date.now();
  const args = ['--pid', String(PID)];
  if (HWND) args.push('--hwnd', String(HWND));
  // ⚠️ 2026-11-15 改：**在 Anode 的 seat 里读**（`anode exec -- python qq-read.py`）。
  //    QQ 现在跑在 seat（独立 Session 2），那条路实测：799 节点、结构化正确、
  //    而且 seat 有自己的前台/焦点 ⇒ **完全不碰用户的桌面** ✓
  //    ⚠️ **这里不能再包一层 withLock** —— pollOnce 整个已经在锁里了，
  //       再套一层会自己等自己，报「等锁超时」永久死锁 ✗
  // 2026-11-16 实测：QQ 窗口不活跃时不渲染新消息，界面里没有、UIA 就读不到
  // ⇒ 读之前先 SetActive 一下（放在 python 里做，只多一次 exec 的开销）
  const args2 = ['--hwnd', String(HWND), '--limit', '40', '--wake'];
  if (groupHint) args2.push('--group', groupHint);
  let r;
  try {
    const out = await anodeRunPy('qq-read.py', args2, { timeoutMs: 120000 });
    const json = anodeJson(out);
    r = { ok: !!json?.ok, json, stdout: String(out || '').slice(-800), error: json ? null : 'anode exec 没返回 JSON' };
  } catch (e) {
    r = { ok: false, json: null, error: String(e.message || e) };
  }
  const j = r.json;
  const groupName = String(j.group || '');
  const gid = nameToGid(groupName);
  if (!gid) {
    log('⚠️ 当前会话「' + groupName + '」对不上群号，跳过这一轮');
    return 0;
  }
  let pushed = 0;
  // ⚠️ 第一轮：把界面上的消息全部记为已读，一条都不推
  if (!baselineReady) {
    for (const m of j.messages || []) {
      if (!m.who || !m.text) continue;
      lastSnapshot.add(`${gid}|${m.who}|${m.text}`);
    }
    baselineReady = true;
    log(`📌 已建立基线（当前 ${lastSnapshot.size} 条，不推送）`);
    return 0;
  }
  for (const m of j.messages || []) {
    const who = String(m.who || '').trim();
    const text = String(m.text || '').trim();
    if (!text) continue;
    if (!who) continue; // 系统提示不推
    const key = `${gid}|${who}|${text}`;
    if (lastSnapshot.has(key)) continue;
    lastSnapshot.add(key);
    // 2026-11-17 16:51（用户：「明显就是把自己的话当成别人发的了」）：
    //   这里原来**没有 `m.self` 过滤** ⇒ 她自己发的每一句都被当成"群里某人说的"推回去
    //   ⇒ 她再说 ⇒ 再推 ⇒ **复读机无限循环**（她的原话：「别再把我自己的话喂回来了」）✗✗
    //   自己发的**只进快照、不外推**（她说了什么 bot 侧 `recent.rememberBot` 早就记着）。
    if (m.self) {
      stats.selfSkipped = (stats.selfSkipped || 0) + 1;
      continue;
    }
    stats.received++;
    stats.pushed++;
    pushed++;
    // 稳定 id（同一句话永远同一个号）—— 原来是时间戳+随机，每次都不一样，
    // bot 侧 `handled` 去重和补看都靠它，不能变
    const msgId = msgIdOf(groupName, m);
    // 引用内容（同上：拼到正文前一行）
    const quote2 = String(m.quote || '').trim();
    const textQ = quote2 ? `[引用] ${quote2}\n${text}` : text;
    const ev = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      time: Math.floor(Date.now() / 1000),
      self_id: Number(SELF_QQ),
      group_id: Number(gid),
      user_id: pseudoUid(who),
      message_id: msgId,
      raw_message: textQ,
      // ⚠️ 不要往正文里拼 `@Saki` —— 那会让"@别人"的消息也被当成在叫她。
      //    真被 @ 时给一个标准 at 段（OneBot 的 isAt(selfId) 靠它判断）
      message: (m.atMe
        ? [{ type: 'at', data: { qq: String(SELF_QQ), name: 'Saki' } }, { type: 'text', data: { text: textQ } }]
        : [{ type: 'text', data: { text: textQ } }]),
      sender: { user_id: pseudoUid(who), nickname: who, card: who, role: 'member' },
      _client: { who, atMe: !!m.atMe, groupName, y: m.y, quote: quote2 },
    };
    log('📥 收到 ·', groupName, '「' + who + '」', text.slice(0, 36));
    send(ev);
  }
  // 快照别无限涨
  if (lastSnapshot.size > 4000) lastSnapshot = new Set([...lastSnapshot].slice(-2000));
  // ── 扫别的会话：只有「在找她」的才切过去读 ──
  //    （参考 QuitBot：只推 incoming + 准备好的；这里用 msgIdOf 稳定哈希去重）
  try {
    const changed = await scanSessionsOnce();
    const hot = changed
      .filter((c) => c.name && c.name !== groupName)
      .filter((c) => String(c.kind) === 'private' || HOT_RE.test(c.summary))
      .slice(0, 1); // 一次只切一个：切群 10~20 秒，多了轮询就跟不上
    for (const c of hot) {
      log('扫到「' + c.name + '」有新动态：' + c.summary.slice(0, 36) + ' → 切过去读');
      try {
        await anodeRunPy('qq-py.py', ['switch', '--hwnd', String(HWND), '--group', c.name], {
          timeoutMs: 120000,
        });
        const sOut = await anodeRunPy('qq-read.py', ['--hwnd', String(HWND), '--limit', '20', '--wake'], {
          timeoutMs: 120000,
        });
        const sj = anodeJson(String(sOut || ''));
        if (sj?.ok) {
          const gidS = nameToGid(String(sj.group || c.name));
          let nS = 0;
          for (const m of sj.messages || []) {
            const whoS = String(m.who || '').trim();
            const txtS = String(m.text || '').trim();
            // 参考 QuitBot 的 `message_ready`：正文空的、自己的，都不算"准备好了"
            if (!whoS || !txtS || m.self) continue;
            const idS = msgIdOf(String(sj.group || c.name), m);
            if (lastSnapshot.has(idS)) continue;
            lastSnapshot.add(idS);
            if (!gidS) continue;
            pushed++;
            stats.pushed++;
            send({
              post_type: 'message',
              message_type: 'group',
              sub_type: 'normal',
              time: Math.floor(Date.now() / 1000),
              self_id: Number(SELF_QQ),
              group_id: Number(gidS),
              user_id: pseudoUid(whoS),
              message_id: idS,
              raw_message: txtS,
              message: m.atMe
                ? [{ type: 'at', data: { qq: String(SELF_QQ), name: 'Saki' } }, { type: 'text', data: { text: txtS } }]
                : [{ type: 'text', data: { text: txtS } }],
              sender: { user_id: pseudoUid(whoS), nickname: whoS, card: whoS, role: 'member' },
              _client: { who: whoS, atMe: !!m.atMe, groupName: sj.group, via: 'scan' },
            });
            log('收到(扫会话) ·', sj.group, '「' + whoS + '」', txtS.slice(0, 30));
            nS++;
          }
          if (nS) log('扫会话推了 ' + nS + ' 条（' + sj.group + '）');
        }
      } finally {
        // 切回原来的会话，别让下一轮读错群
        try {
          await anodeRunPy('qq-py.py', ['switch', '--hwnd', String(HWND), '--group', groupName], {
            timeoutMs: 120000,
          });
        } catch {}
      }
    }
  } catch (e) {
    log('扫会话出错（不影响主轮询）：' + String(e.message || e).slice(0, 80));
  }
  return pushed;
  });
}

/* ───────────── 常驻 daemon 的接收端（6701 /push） ─────────────
 *
 * 2026-11-17（用户：「改常驻进程」）：
 *   原来每一轮都要 `anode exec` 跑一次短命 `qq-read.py` —— 光进程启动 + UIA/COM 初始化
 *   就 2000~3000ms。`qq-daemon.py` 常驻在座位里反复读，实测**每次只要 375ms**（快 5~8 倍），
 *   它把新消息 POST 到这里，适配器只负责转成 OneBot 事件发给 bot。
 *
 * ⚠️ 这一版 daemon **只读当前会话、不切群**（切群是下一步）。
 */
const PUSH_PORT = num('pushPort', 6701);
function startPushServer() {
  try {
    const srv = createServer((req, res) => {
      if (req.method !== 'POST' || !req.url || !req.url.startsWith('/push')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"ok":false}');
        return;
      }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          res.writeHead(400).end('{"ok":false,"error":"bad json"}');
          return;
        }
        const group = String(body.group || '');
        const gid = nameToGid(group);
        // ⚠️ 2026-11-17 19:58：**戳一戳**（daemon 从灰字提示里解析出来的）
        // ⚠️⚠️ 2026-11-19 补齐描述（用户：「戳一戳的描述还不够完善，要传给 bot
        //    完整的戳一戳动作，比如捏了一下 Saki 的脸」）——
        //    原来只把 `action`（"捏了捏"）塞进 `_client`，`raw_message` 干脆没有
        //    ⇒ bot 只知道"捏了捏"，不知道**捏的是谁、捏哪儿** ✗
        //    ⇒ 现在把 daemon 解析好的完整句子（`text`，如「<主人>捏了捏Saki的脸」）
        //      放进 `raw_message`，并把 action/target/suffix 一起带上 ✓
        for (const pk of body.pokes || []) {
          const who = String(pk.who || '').trim();
          if (!gid || !who) continue;
          const uid = pseudoUid(who);
          const act = String(pk.action || '').trim();
          const tgt = String(pk.target || '').trim();
          const suf = String(pk.suffix || '').trim();
          // 完整一句：优先用 daemon 拼好的 text；没有就自己拼
          const full = String(pk.text || '').trim() || (who + (act || '戳了戳') + tgt + suf);
          send({
            post_type: 'notice',
            notice_type: 'notify',
            sub_type: 'poke',
            time: Math.floor(Date.now() / 1000),
            self_id: Number(SELF_QQ),
            group_id: Number(gid),
            user_id: uid,
            target_id: Number(SELF_QQ),
            // ⚠️⚠️ 2026-11-19 修（用户：「戳一戳的描述还不够完善」）——
            //    bot 的 `pokeBack()` 读的是**事件顶层**的 `payload.action` +
            //    `payload.suffix`（SnowLuma 就是这么给的，见 bot.js 那段注释），
            //    而我之前只把它们塞进 `_client` ⇒ 顶层没有 ⇒ 读不到 ⇒
            //    她那边永远只看到"他伸手戳了你一下"，不知道是"捏了捏…的脸" ✗
            //    ⇒ 顶层补上 action / suffix（和 SnowLuma 同形），另外带上完整句子 ✓
            action: act,
            suffix: suf,
            raw_message: full,
            message: [{ type: 'text', data: { text: full } }],
            _client: {
              who,
              action: act,
              target: tgt,
              suffix: suf,
              pokeText: full,
              groupName: group,
              via: 'daemon-poke',
            },
          });
          log('👉 被「' + who + '」' + full.replace(who, '') + '（daemon，完整：' + full + '）');
        }
        let n = 0;
        for (const m of body.messages || []) {
          const who = String(m.who || '').trim();
          const text = String(m.text || '').trim();
          if (!who || !text) continue;
          const mid = msgIdOf(group, { who, text });
          // ⚠️⚠️ 2026-11-17：**去重 key 必须和 pollOnce 用同一种格式**。
          //    pollOnce 用的是 `${gid}|${who}|${text}`，这里原来用 msgIdOf 的哈希数字 ⇒
          //    同一个 lastSnapshot 里两种格式互不认 ⇒ 同一条消息两条路各推一次 ⇒ 她回两次 ✗
          //    （message_id 仍用 mid，那是 bot 侧 handled/补看要的，和去重是两回事）
          const dedupKey = `${gid}|${who}|${text}`;
          // ⚠️⚠️ 2026-11-18 加**时间窗**（用户报：「最近两条又没回」）——
          //    原来这里是**永久去重**（`lastSnapshot` 只在超过 4000 条时清一半）⇒
          //    同一个人**重发同一句话**会被无条件静默吞掉（连日志都没有）✗
          //    而他调试/重试时就是「@Saki在吗」发好几遍 ⇒ 后面几遍永远不回 ✗
          //    ⇒ 改成 5 分钟窗口内才算重复：真·重复（daemon 一轮重复报同一条）挡住，
          //      人过了几分钟重新说一遍，照常推 ✓
          const seenAt = lastSeenAt.get(dedupKey);
          if (lastSnapshot.has(dedupKey) && seenAt && Date.now() - seenAt < 5 * 60 * 1000) {
            log('（5 分钟内重复过，跳过）「' + who + '」' + text.slice(0, 20));
            continue;
          }
          lastSnapshot.add(dedupKey);
          lastSeenAt.set(dedupKey, Date.now());
          if (!gid) {
            log('push: 群「' + group + '」没有群号映射，跳过（防止发错群）');
            continue;
          }
          const uid = pseudoUid(who);
          // 引用内容：拼到正文前面一行（客户端没有 QQ 消息 id，做不了标准 reply 段）
          const quote = String(m.quote || '').trim();
          const textWithQuote = quote ? `[引用] ${quote}\n${text}` : text;
          // 图片消息：按 daemon 传来的屏幕矩形裁一帧，做成标准 image 段
          // （客户端拿不到 QQ 的图片原文件，只能裁屏 —— 这是唯一物理路径）
          let imgSeg = null;
          // ① 优先用 daemon 已经存好的图（`state/<img>`）—— 省掉子进程裁帧的 2~3 秒
          if (m.img) {
            const p2 = _joinPath(process.cwd(), 'state', String(m.img));
            try {
              if (_existsSync(p2)) {
                imgSeg = { type: 'image', data: { file: p2 } };
                log('图片用 daemon 存好的：' + String(m.img));
              }
            } catch {}
          }
          // ② 没有就退回自己裁（老路，慢一点）
          if (!imgSeg && String(m.kind) === 'image' && Array.isArray(m.rect) && m.rect.length === 4) {
            const r = m.rect.map((x) => Number(x) || 0);
            if (r[1] >= 0 && r[2] > r[0] && r[3] > r[1]) {
              try {
                const outPath = join(tmpdir(), `qq-img-${mid}.png`);
                const gOut = await anodeRunPy(
                  'qq-grab-image.py',
                  ['--l', String(r[0]), '--t', String(r[1]), '--r', String(r[2]), '--b', String(r[3]), '--out', outPath],
                  { timeoutMs: 60000 },
                );
                const gj = anodeJson(String(gOut || ''));
                if (gj?.ok && gj.path) {
                  imgSeg = { type: 'image', data: { file: String(gj.path) } };
                  log('图片已裁帧：' + String(gj.path).split(/[\\/]/).pop());
                }
              } catch (e) {
                log('裁图失败：' + String(e.message || e).slice(0, 60));
              }
            }
          }
          send({
            post_type: 'message',
            message_type: 'group',
            sub_type: 'normal',
            time: Math.floor(Date.now() / 1000),
            self_id: Number(SELF_QQ),
            group_id: Number(gid),
            user_id: uid,
            message_id: mid,
            raw_message: textWithQuote,
            message: [
              ...(m.atMe ? [{ type: 'at', data: { qq: String(SELF_QQ), name: 'Saki' } }] : []),
              ...(imgSeg ? [imgSeg] : []),
              { type: 'text', data: { text: textWithQuote } },
            ],
            sender: { user_id: uid, nickname: who, card: who, role: 'member' },
            _client: { who, atMe: !!m.atMe, groupName: group, y: m.y, via: 'daemon', quote },
          });
          log('收到(daemon) · ' + group + ' 「' + who + '」 ' + text.slice(0, 30));
          n++;
        }
        if (n) log('daemon 推了 ' + n + ' 条（' + group + '）');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, accepted: n }));
      });
    });
    srv.listen(PUSH_PORT, '127.0.0.1', () => log('✅ daemon 接收端在听 http://127.0.0.1:' + PUSH_PORT + '/push'));
    srv.on('error', (e) => log('daemon 接收端启动失败：' + String(e.message || e).slice(0, 80)));
  } catch (e) {
    log('daemon 接收端异常：' + String(e.message || e).slice(0, 80));
  }
}
startPushServer();

/* ────────────────────────── 启动 ────────────────────────── */
loadGroups();

// ⚠️ 2026-11-15：启动时**自动探测** seat 里 QQ 的 hwnd。
//    seat 里的 QQ 每次重启 hwnd 都会变（1902218 → 132512 → …），
//    写死一个值的话重启一次就得改代码。
if (!HWND) {
  try {
    log('探测 seat 里的 QQ 窗口…');
    const found = await anodeFindQQ();
    HWND = found.hwnd;
    log(
      `✅ 找到 QQ：hwnd=${found.hwnd} pid=${found.pid} 节点=${found.nodes}` +
        (found.hasItems ? '（有会话列表 ✓）' : '（⚠️ 没有会话列表，可能还没登录）'),
    );
  } catch (e) {
    log('❌ 探测 QQ 窗口失败：' + String(e.message || e).slice(0, 200));
    log('   排查：① anode status 是不是 ready ② seat 里 QQ 是不是在跑');
    process.exit(1);
  }
} else {
  log('用命令行指定的 hwnd=' + HWND);
}

log('客户端 OneBot 启动 | 端口', PORT, '| QQ pid', PID, '| hwnd', HWND, '| 本号', SELF_QQ);
log('群名录:', Object.keys(lastGroups).length, '个');

const server = createServer((req, res) => {
  res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('需要 WebSocket 连接');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = wsAccept(key);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const conn = { socket, alive: true };
  conns.add(conn);
  log('🤝 机器人已连接（当前连接数', conns.size, '）');

  // 连上就发 lifecycle，并补一次 get_login_info 风格的问候
  try {
    socket.write(
      wsFrame(
        JSON.stringify({
          post_type: 'meta_event',
          meta_event_type: 'lifecycle',
          sub_type: 'connect',
          time: Math.floor(Date.now() / 1000),
          self_id: Number(SELF_QQ),
        }),
      ),
    );
  } catch {}

  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    // 诊断：看清收到的原始字节（自写 WS 解析不工作时，这里是唯一线索）
    if (!conn.logged) {
      conn.logged = 0;
    }
    if (conn.logged < 3) {
      conn.logged++;
      log('[ws] 收到 ' + chunk.length + ' 字节: ' + chunk.slice(0, 24).toString('hex'));
    }
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const f = wsParse(buf);
      if (!f) {
        if (WS_DEBUG && conn.logged <= 6) log('[ws] 帧不完整，还差字节 (buf=' + buf.length + ')');
        break;
      }
      if (conn.logged <= 6) log('[ws] 解析出 opcode=0x' + f.opcode.toString(16) + ' payload=' + f.payload.length);
      buf = buf.slice(f.consumed);
      if (f.opcode === 0x8) {
        try { socket.end(); } catch {}
        return;
      }
      if (f.opcode === 0x9) {
        try { socket.write(wsFrame(f.payload, 0xa)); } catch {}
        continue;
      }
      if (f.opcode !== 0x1) continue;
      let req;
      try {
        req = JSON.parse(f.payload.toString('utf8'));
      } catch (e) {
        if (conn.logged <= 6) log('[ws] JSON 解析失败: ' + e.message + ' 原文=' + f.payload.slice(0, 80));
        continue;
      }
      // OneBot：{action, params, echo}
      if (!req || !req.action) { if (conn.logged <= 6) log('[ws] 没有 action: ' + JSON.stringify(req).slice(0, 80)); continue; }
      log('[api] 收到 ' + req.action);
      callApi(String(req.action), req.params || {})
        .then((resp) => {
          try {
            const body = JSON.stringify({ ...resp, echo: req.echo });
            const frame = wsFrame(body);
            log('[api] 回 ' + req.action + ' echo=' + req.echo + ' body=' + body.length + 'B frame=' + frame.length + 'B');
            socket.write(frame);
          } catch (e) {
            log('[api] 写回失败 ' + req.action + ': ' + e.message);
          }
        })
        .catch((e) => {
          try {
            socket.write(wsFrame(JSON.stringify({ status: 'failed', retcode: 100, msg: String(e.message), echo: req.echo })));
          } catch {}
        });
    }
  });
  const bye = () => {
    conns.delete(conn);
    log('👋 机器人断开（剩', conns.size, '）');
  };
  socket.on('close', bye);
  socket.on('error', bye);
});

server.listen(PORT, '127.0.0.1', async () => {
  log('✅ 监听 ws://127.0.0.1:' + PORT);
  if (ONCE) {
    const n = await pollOnce();
    log('--once 完成，本轮推了', n, '条');
    process.exit(0);
  }
  // 心跳
  setInterval(() => {
    try {
      send({
        post_type: 'meta_event',
        meta_event_type: 'heartbeat',
        time: Math.floor(Date.now() / 1000),
        self_id: Number(SELF_QQ),
        status: { online: true, good: true },
        interval: 30000,
      });
    } catch {}
  }, 30000);
  // 轮询
  const loop = async () => {
    try {
      const n = await pollOnce();
      if (n) log('↑ 本轮推送', n, '条新消息');
    } catch (e) {
      stats.errors++;
      log('轮询异常:', e.message);
    }
    setTimeout(loop, POLL_MS);
  };
  loop();
});

process.on('uncaughtException', (e) => log('💥 uncaught:', e.message));
process.on('unhandledRejection', (e) => log('💥 unhandled:', String(e).slice(0, 200)));
