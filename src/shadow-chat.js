/**
 * ⚠️⚠️⚠️ 2026-10-22 加（用户：「**先抓下来吧，然后暂时只动私聊工作模式部分**」+
 *    「**我觉得应该要告诉那边的 dsh，在只需要交谈时尽可能减少思考时间和输出 token，
 *      这样就能最大化接近原来的 bot 了**」）——
 *
 * **影子模式（shadow）**：私聊消息**同时**也喂给一个真的 DSH 会话，
 * 但 agent 想说的那句话**只记日志、不发给客户** ✓
 *
 * 目的：拿它跟「现在 bot 的 LLM 说的那句」并排比 —— 看 agent 直接对话到底差多少，
 * 再决定要不要把私聊工作模式整个切过去 ✓
 *
 * 协议层抄自 `qq-bridge`（`src/dsh-client.js`，见 `_ref-qq-bridge/`）：
 *   ① 鉴权：从 `~/.dsh` 的浏览器会话签名密钥**离线铸造 Cookie**；
 *   ② 会话：`workspace/create` → `sessions/create` → `events/follow`（不 follow 收不到 turn）；
 *   ③ 说话：`sessions/prompt { sessionId, mode:'queue', content:[{type:'text'}] }`；
 *   ④ 收回复：`events/mux()` 的事件流里，`turn/start` 建 collector、
 *      `assistant/message` 累文本、`turn/end` 收尾（**别累 `assistant/chunk`**，会翻倍）✓
 *
 * ⚠️ 三条设计约束：
 *   1. **绝不发出去** —— 这个模块只返回文本，调用方记日志；发不发是调用方的事；
 *   2. **每个客户一个会话**（`key = 私聊<QQ>`）⇒ 它天然知道之前聊过什么 ✓
 *   3. **失败一律降级为"没有影子"** —— 连不上 DSH / 超时 ⇒ 返回 `{ ok:false }`，
 *      绝不影响正常那条路（现在线上跑的还是 bot 的 LLM）✓
 */
import { log } from './log.js';
import { config, stateDir } from './config.js';
import fs from 'node:fs';
import path from 'node:path';

// ⚠️⚠️⚠️ 2026-10-24 加（用户：「**做**」—— 让我把会话落盘复用）——
//    原来 `sessions` 只在**内存**里 ⇒ **机器人一重启，影子会话全没了**、每个客户从头开始 ✗
//    ⇒ 落盘到 `state/shadow-sessions.json`（`{ 私聊<QQ>: session-xxx }`），
//      重启后**接着用原来的会话**（DSH 那边历史还在）✓
//    ⚠️ 复用之前必须**验证它还活着**（DSH 重启 / 会话被归档 ⇒ `selectModel` 会报 not-found）
//      ⇒ 报错就丢掉重建 ✓
const SESSIONS_FILE = path.join(stateDir(), 'shadow-sessions.json');

function loadSavedSessions() {
  try {
    const j = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    return j && typeof j === 'object' && j.sessions && typeof j.sessions === 'object'
      ? j.sessions
      : {};
  } catch {
    return {};
  }
}

function writeSavedSessions(obj) {
  try {
    fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
    const tmp = `${SESSIONS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ sessions: obj ?? {} }, null, 2), 'utf8');
    fs.renameSync(tmp, SESSIONS_FILE);
  } catch (e) {
    log.debug(`[影子] 会话落盘失败：${e.message}`);
  }
}

function saveSavedSession(key, sid) {
  const cur = loadSavedSessions();
  cur[String(key)] = String(sid);
  writeSavedSessions(cur);
}

function dropSavedSession(key) {
  const cur = loadSavedSessions();
  delete cur[String(key)];
  writeSavedSessions(cur);
}

// ⚠️⚠️⚠️ 2026-10-24 加（用户：「**自动降级那一套也要复用过去，全部保持一致。
//    只要这边 bot 能说话，agent 那边也要能说话**」）——
// **降级链和 bot 完全一致**：直接读 `llm.providers`（顺序 = 优先级，第 0 个是主模型），
// 把每个 baseURL 映射到 DSH 里的 provider 名：
//   · `ai.example.top` ⇒ DSH 的 `chihaya`（中转站）
//   · `generativelanguage.googleapis.com` / `googleapis` ⇒ DSH 的 `google`
// ⚠️ 映射不出来的**跳过**（宁可不试，也别拿错的地址瞎试）✓
const PROVIDER_BY_HOST = [
  ['example', 'chihaya'],
  ['generativelanguage', 'google'],
  ['googleapis', 'google'],
  // ⚠️ 官方 deepseek 那个 key 没余额（402），所以**不放进来**；哪天充了钱再加 ✓
];

/**
 * ⚠️⚠️ 2026-10-27 加（真事：bot 的模型换成 `minimax-m3` 之后，DSH 报
 *    `model "minimax-m3" does not support reasoning effort "low"` ⇒
 *    **每个新会话都白失败一次**才降级到 `deepseek-v4.1-flash` ✗）——
 *    失败过的组合记这里，下次直接跳过 ✓
 */
const badCombos = new Set();

/** 从 bot 的配置推出「DSH 上的候选模型链」（顺序 = 优先级） */
function candidates() {
  const out = [];
  // ⚠️⚠️⚠️ 2026-10-24 实测（重要）：
  //    `reasoningEffort: 'off'` ⇒ **它不细读工作区那 15KB 规则** ⇒
  //    「把封面上那几行横线补齐」它**不问确认直接开干**（60~120 秒没说完）✗✗
  //    ⇒ **交谈用 `low`**（有一点思考，会读规则、守两道闸）；`off` 只当兜底 ✓
  //    ⚠️ 想让某一轮更快可以临时设 `QQBOT_DSH_EFFORT=off`（但那时它可能又不守闸）✗
  const effort = String(process.env.QQBOT_DSH_EFFORT ?? 'low');
  const push = (provider, model) => {
    if (!provider) return;
    const key = `${provider}|${model}`;
    if (out.some((x) => `${x.provider}|${x.model}` === key)) return;
    out.push({ provider, model: String(model ?? ''), effort });
  };
  const ps = Array.isArray(config?.llm?.providers) ? config.llm.providers : [];
  // ⚠️⚠️⚠️ 2026-10-27 加（用户：「**再加一个私聊工作模式使用的模型的选项，和日常主模型隔离开**」）——
  //    **私聊工作模式专用的那个排第一**（`privateWork.ai = { baseURL, model }`）：
  //    在界面上选过 ⇒ 就用它，**跟日常聊天的模型分开** ✓
  //    没选过 ⇒ 什么都不变，还是跟着日常主模型走 ✓
  {
    const ai = config?.privateWork?.ai;
    const u = String(ai?.baseURL ?? '').trim().toLowerCase();
    const mm = String(ai?.model ?? '').trim();
    if (u && mm) {
      const hit = PROVIDER_BY_HOST.find(([host]) => u.includes(host));
      if (hit) push(hit[1], mm);
      else log.warn(`[影子] 工作模式模型的站点认不出来（${ai.baseURL}）⇒ 退回日常主模型`);
    }
  }
  for (const p of ps) {
    const url = String(p?.baseURL ?? '').trim().toLowerCase();
    const hit = PROVIDER_BY_HOST.find(([host]) => url.includes(host));
    if (hit) push(hit[1], p?.model);
  }
  // 扁平字段（没配 providers 时 bot 用的就是这套）
  if (!out.length) {
    const url = String(config?.llm?.baseURL ?? '').trim().toLowerCase();
    const hit = PROVIDER_BY_HOST.find(([host]) => url.includes(host));
    if (hit) push(hit[1], config?.llm?.model);
  }
  // 最后兜底：中转站 + 已验证可用的模型 ✓
  push('chihaya', 'deepseek-v4.1-flash');

  // 失败过的（这个 provider/model + 这个 effort 不行）⇒ 跳过；全废了就退回最后一个 ✓
  const usable = out.filter((x) => !badCombos.has(`${x.provider}|${x.model}|${x.effort}`));
  return usable.length ? usable : out.slice(-1);
}

/** 当前降级到第几个候选（0 = 没降级）；以及"保持降级"到什么时候 */
let degradeIndex = 0;
let degradeUntil = 0;
// ⚠️ 和 bot 一样：降级后**保持 2 分钟**再回去试主模型（`llm.js` 的 `FALLBACK_HOLD_MS`）
const HOLD_MS = 2 * 60 * 1000;


const DSH_BASE = String(process.env.QQBOT_DSH_BASE ?? 'http://127.0.0.1:3080').trim();
const DEFAULT_TIMEOUT_MS = 60000;

let api = null; // NodeApiClient
let apiPromise = null;
let muxStarted = false;

/** key → sessionId（每个私聊一个会话，持久在内存里；重启后会重建） */
const sessions = new Map();
/** workspace 目录 → workspaceId（⚠️ 2026-10-24：「**可以设在同一个工作区**」⇒ 共用一份，别每次建）*/
const workspaces = new Map();
/** sessionId → collector（正在收的回合） */
const collectors = new Map();
/**
 * sessionId → **排队等回话的 waiter 数组**：`[{ turn, resolve, timer, usage }]`
 *
 * ⚠️⚠️ 2026-11-09 改（实测踩到的真 bug：**客户连发两条，第二条 0 秒返回空话**）——
 *   原来一个会话只放**一个** waiter，而且收到 `turn/end` **不看是哪一轮**就 resolve ⇒
 *     · 第一条说了第一段就提前返回（这一轮其实还在收尾）；
 *     · 第二条马上挂上新的 waiter；
 *     · 第一条那一轮的 `turn/end` 半秒后到 ⇒ **被当成"第二条说完了"** ⇒ 空 ✗
 *   ⇒ 现在两条都改：
 *     ① 每个 waiter **认自己那一轮**（`turn/start` 绑号；别轮的 `turn/end` 一律忽略）；
 *     ② **允许排队**（连发两条 ⇒ 第二条真的等第一轮跑完再开）✓
 */
const waiters = new Map(); // sid → waiter[]
/** sid → **已经绑过 waiter 的最后一个 turn 号**（`step/start` 每步都发，靠它去重） */
const lastBound = new Map();
/**
 * ⚠️⚠️ 2026-10-24 加（用户：「**agent 不应该常驻吗，每句话只是向 agent 发送信息，
 *    信息量少的话应该才几分钱**」）——
 * 实测确认：**有 prompt caching**（`assistant/message` 的 `usage.cacheReadTokens`）：
 *   · 「在吗」      → 新输入 171 + **缓存命中 37248**（99.5%）、输出 8
 *   · 「报告还记得吗」→ 新输入 963 + **缓存命中 38016**（97.3%）、输出 77
 * ⇒ **每句几分钱**（不是几毛）✓ 但**step 数**是成本主因（每调一次工具就重发一遍上下文）：
 *   纯聊天 1 step ≈ 一分钱；翻文件的 3~5 step ≈ 几分钱 ✓
 * ⇒ 这里把每句的 usage 攒下来，日志里一起打（能算每天花多少）✓
 */
// ⚠️ 2026-11-09：原来这里有张 `usageAcc`（sessionId → token 账），**已经删掉** ——
//    连发两条时两个 waiter 的用量会串到一起，也不利于算"这一句花了多少" ✗
//    ⇒ 现在每个 waiter 自己带一份（`w.usage`），由 `shadowSay` 取走 ✓

/** 结掉一个 waiter：从队列里摘掉、停表、把结果给它 */
function settleWaiter(sid, w, text) {
  const list = waiters.get(sid) ?? [];
  const i = list.indexOf(w);
  if (i >= 0) list.splice(i, 1);
  if (!list.length) waiters.delete(sid);
  clearTimeout(w.timer);
  w.resolve(text);
}

/** 懒加载：连不上就返回 null（调用方按"没有影子"处理） */
async function ensureApi() {
  if (api) return api;
  if (apiPromise) return apiPromise;
  apiPromise = (async () => {
    try {
      const m = await import('./dsh-client.js');
      const cookie = await m.discoverDshSessionCookie(DSH_BASE);
      if (!cookie) {
        log.warn('[影子] 拿不到 DSH 的会话 Cookie（DSH 没起？）⇒ 影子模式这次不算');
        return null;
      }
      const c = new m.NodeApiClient(DSH_BASE, 20000, cookie);
      await c.ensureAuth();
      api = c;
      log.info(`[影子] 已连上 DSH（${DSH_BASE}）✓`);
      return api;
    } catch (e) {
      log.warn(`[影子] 连 DSH 失败（不影响正常回复）：${e.message}`);
      return null;
    }
  })();
  return apiPromise;
}

/** 事件流：一条常驻循环，把 session/event 喂给对应的 collector */
async function ensureMux(c) {
  if (muxStarted) return;
  muxStarted = true;
  const { createTurnCollector, blocksToText } = await import('./dsh-client.js');
  (async () => {
    for (;;) {
      try {
        for await (const envelope of c.events.mux({})) {
          const frame = envelope?.payload;
          if (frame?.type !== 'session/event') continue; // session/snapshot 不用
          const sid = frame.sessionId;
          const ev = frame.event;

          // ⚠️⚠️⚠️ 2026-10-24 改（真踩到：第 3 句「行，那你继续弄吧」**120 秒超时**）——
          //    原来只等 `turn/end`，可那句它**直接开干**了（改报告，要跑十几分钟）⇒
          //    "等它这一轮全部结束"根本不是我们要的语义 ✗✗
          //    ⇒ **收到它说的第一段话就返回**（`assistant/message` 有文本）——
          //      话先发出去，活让它后台接着干 ✓（这也是 GUI 里"边说边干"的样子）
          // ── 回合开始：把「第一个还没绑号的 waiter」绑到这一轮 ──
          // ⚠️ 2026-11-09 加：有了这一行，下面两个判定才知道"这一轮是谁的"
          // ⚠️ 实测：**第一轮只有 `step/start`、没有 `turn/start`**（`turn/start` 从第二轮才有）
          //    ⇒ 两种都要认，否则第一条消息永远绑不上号 ✗
          //    ⚠️ 但 `step/start` **每步都发**（同一 turn 会来好几次）⇒ 用 `lastBound`
          //      记住"绑到第几轮了"，只有 turn 号变大才绑下一个 waiter ✓
          if (ev?.type === 'turn/start' || ev?.type === 'step/start') {
            const turn = Number(ev.data?.turn ?? 0);
            const prev = lastBound.get(sid) ?? 0;
            if (turn > prev) {
              const w = (waiters.get(sid) ?? []).find((x) => x.turn === null);
              if (w) {
                w.turn = turn;
                lastBound.set(sid, turn);
              }
            }
            continue;
          }
          if (ev?.type === 'assistant/message') {
            const list = waiters.get(sid) ?? [];
            const turn = Number(ev.data?.turn ?? 0);
            // **只认我这一轮**；没绑上号（`turn/start` 没收到那种）就按这一轮算（兜底）
            const w = list.find((x) => x.turn === turn) || list.find((x) => x.turn === null);
            if (!w) continue;
            if (w.turn === null) w.turn = turn;
            // ⚠️ usage 记在**这个 waiter** 上（原来按 session 累加 ⇒ 连发两条会串账 ✗）
            //    `assistant/message` 里才有这几个字段（`assistant/attempt` 里没有）✓
            const u = ev.data?.usage;
            if (u) {
              const cur = w.usage ?? { in: 0, out: 0, cache: 0, steps: 0 };
              cur.in += Number(u.inputTokens || 0);
              cur.out += Number(u.outputTokens || 0);
              cur.cache += Number(u.cacheReadTokens || 0);
              cur.steps += 1;
              w.usage = cur;
            }
            const text = String(blocksToText(ev.data?.message?.content) ?? '').trim();
            if (text) settleWaiter(sid, w, text);
            continue;
          }
          // `turn/end`：它一句都没说（纯工具调用 / 出错）⇒ 用空串收尾，别让调用方干等 ✓
          // ⚠️⚠️ **只认自己绑的那一轮** —— 别轮的收尾一律忽略（这就是"第二条 0 秒空话"的根）
          if (ev?.type === 'turn/end') {
            const list = waiters.get(sid) ?? [];
            const turn = Number(ev.data?.turn ?? 0);
            const w = list.find((x) => x.turn === turn);
            collectors.delete(sid);
            if (!w) continue;
            const errMsg =
              ev.data?.reason?.kind === 'error'
                ? String(ev.data?.reason?.error?.message ?? ev.data?.reason?.kind)
                : '';
            settleWaiter(sid, w, errMsg ? `__ERR__${errMsg}` : '');
            continue;
          }
          // 其余事件照旧喂 collector（它只认 turn/start / assistant/message / turn/end）
          const col = collectors.get(sid);
          if (col) col.push(ev);
        }
      } catch (e) {
        log.debug(`[影子] 事件流断了（3 秒后重连）：${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 3000).unref?.());
    }
  })();
}

/**
 * 拿/建这个私聊的 DSH 会话。
 * ⚠️ 工作区 = 那个客户自己的工作区（`agentwork/私聊/<QQ>`）⇒ agent 能看到他的文件 ✓
 */
async function ensureSession(c, key, cwd, wsDir = '') {
  const old = sessions.get(key);
  if (old) return old;
  const m = await import('./dsh-client.js');

  // ⚠️⚠️⚠️ 2026-10-24 加（用户：「**做**」—— 会话落盘复用）——
  //    **先试上次落盘的那个会话**：机器人重启了，但 DSH 那边的历史还在 ⇒
  //    接着用它 ⇒ 攒的数据才是连续的 ✓
  //    ⚠️ 用 `selectModel` 探一下它还活着（DSH 重启 / 会话被归档 ⇒ 报 not-found）
  //      ⇒ 用不了就丢掉、重建 ✓
  {
    const saved = loadSavedSessions()[String(key)];
    if (saved) {
      try {
        const list0 = candidates();
        const cand0 = list0[Math.min(degradeIndex, list0.length - 1)] || list0[0];
        m.unwrap(
          await c.sessions.selectModel({
            sessionId: String(saved),
            provider: cand0.provider,
            model: cand0.model,
            reasoningEffort: cand0.effort,
          }),
          'session.selectModel',
        );
        sessions.set(key, String(saved));
        c.events.follow(String(saved));
        log.info(`[影子] **复用上次的会话** ${key} → ${saved}（历史接着用 ✓）`);
        return String(saved);
      } catch (e) {
        log.info(`[影子] 上次的会话用不了了（${e.message}）⇒ 重建一个`);
        dropSavedSession(key);
      }
    }
  }
 // ⚠️⚠️ 2026-10-24：「**按群聊和私聊分开建立会话即可，一个群或好友对应一个会话，
  //    而且可以设在同一个工作区**」——
  //    ⇒ **session 按 key 分**（`私聊<QQ>` / 群聊以后用 `群<GID>`），
  //      **workspace 可以共用**（传 `wsDir` 就复用那一份，不再每个好友建一个）✓
  //    ⚠️ 共用 workspace 的代价：agent 在这个目录里**能看到别的客户的文件** ——
  //      单纯"说话"没问题；万一它去翻，可能翻到别人的东西。
  //      ⇒ 默认还是**每个客户自己的工作区**，要共用就用 `QQBOT_SHADOW_WS` 显式指定 ✓
  const wsPath = String(wsDir || cwd);
  let wsId = workspaces.get(wsPath);
  if (!wsId) {
    const ws = m.unwrap(await c.workspace.create({ path: wsPath }), 'workspace.create');
    wsId = String(ws.workspace.workspaceId);
    workspaces.set(wsPath, wsId);
  }
  const v = m.unwrap(await c.sessions.create({ workspaceId: wsId }), 'session.create');
  const sid = String(v.sessionId);
  // ⚠️⚠️⚠️ 2026-10-24 改（用户：「**自动降级那一套也要复用过去，全部保持一致。
  //    只要这边 bot 能说话，agent 那边也要能说话**」）——
  //    选模型改成**按候选链逐个试**（顺序来自 bot 的 `llm.providers`）：
  //    前一个不行（402 没钱 / 401 key 无效 / provider 不存在）⇒ **自动降一个** ✓
  //    ⚠️ 降级后**保持 2 分钟**（和 `llm.js` 的 `FALLBACK_HOLD_MS` 一致），到点回主模型再试 ✓
  {
    if (degradeIndex > 0 && Date.now() > degradeUntil) {
      degradeIndex = 0;
      log.info('[影子] 降级保持到点了 ⇒ 回主模型再试一次');
    }
    const list = candidates();
    let picked = null;
    for (let i = Math.min(degradeIndex, list.length - 1); i < list.length; i++) {
      const cand = list[i];
      try {
        m.unwrap(
          await c.sessions.selectModel({
            sessionId: sid,
            provider: cand.provider,
            model: cand.model,
            reasoningEffort: cand.effort,
          }),
          'session.selectModel',
        );
        picked = cand;
        if (i !== degradeIndex) {
          degradeIndex = i;
          degradeUntil = Date.now() + HOLD_MS;
          log.warn(`[影子] 模型降级到第 ${i + 1}/${list.length} 个：${cand.provider}/${cand.model}`);
        } else if (i === 0) {
          log.info(`[影子] 用主模型 ${cand.provider}/${cand.model}（思考强度 ${cand.effort}）`);
        }
        break;
      } catch (e) {
        const msg = String(e?.message ?? e);
        // ⚠️ 只有**永久性**的（模型不支持这个思考强度 / worker 里没这个模型）才拉黑；
        //    网络抖动、超时不算 ⇒ 下次还试 ✓
        if (/does not support reasoning effort|model-unavailable|not found/i.test(msg)) {
          badCombos.add(`${cand.provider}|${cand.model}|${cand.effort}`);
        }
        log.warn(`[影子] ${cand.provider}/${cand.model} 选不上（${msg}）⇒ 试下一个`);
      }
    }
    if (!picked) throw new Error('候选链上一个模型都选不上');
    var pickedName = `${picked.provider}/${picked.model}`;
  }
  sessions.set(key, sid);
  // ⚠️ 2026-10-24：新建的会话**落盘**（重启后能接着用）✓
  saveSavedSession(key, sid);
  c.events.follow(sid); // ⚠️ 不 follow 收不到 turn 事件
  log.info(`[影子] 建了会话 ${key} → ${sid}（工作区 ${cwd}，模型 ${pickedName}）`);
  return sid;
}

/**
 * 影子说一句：把 `text`（客户的话 + 上下文）喂给 agent，等它这一轮说完，返回它说的话。
 *
 * @returns {Promise<{ok:boolean, reply?:string, sessionId?:string, ms?:number, why?:string}>}
 *   ⚠️ **只返回文本**，绝不发送 —— 发不发由调用方决定 ✓
 */
export async function shadowSay({ key, cwd, text, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const t0 = Date.now();
  try {
    const c = await ensureApi();
    if (!c) return { ok: false, why: '连不上 DSH' };
    await ensureMux(c);
    const { createTurnCollector } = await import('./dsh-client.js');
    const sid = await ensureSession(
      c,
      String(key),
      String(cwd),
      String(process.env.QQBOT_SHADOW_WS ?? ''), // ⚠️ 想所有会话共用一个工作区就设它 ✓
    );
    collectors.set(sid, createTurnCollector());
    let w = null;
    const done = new Promise((resolve, reject) => {
      w = { turn: null, resolve, timer: null, usage: null };
      w.timer = setTimeout(() => {
        // 超时 ⇒ 把自己从队列里摘掉（不然后面的排队全堵死）
        const l0 = waiters.get(sid) ?? [];
        const i0 = l0.indexOf(w);
        if (i0 >= 0) l0.splice(i0, 1);
        if (!l0.length) waiters.delete(sid);
        collectors.delete(sid);
        reject(new Error('等它说完超时'));
      }, Math.max(5000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
      w.timer.unref?.();
      // ⚠️ 2026-11-09：**允许排队**（原来这里直接 `return {ok:false, why:'上一轮还没说完'}`）——
      //    客户连发两条时，第二条就该排队等第一轮跑完、再由 agent 说一句 ✓
      const list = waiters.get(sid) ?? [];
      list.push(w);
      waiters.set(sid, list);
    });

    await c.sessions.prompt({
      sessionId: sid,
      mode: 'queue',
      content: [{ type: 'text', text: String(text ?? '') }],
    });

    const raw = await done;
    // ⚠️ 2026-11-09：usage 从**自己这个 waiter** 上取（不再全局按 session 攒）
    const usage = w?.usage ?? null;
    const costTag = usage
      ? `｜新${usage.in}+缓存${usage.cache}｜出${usage.out}｜${usage.steps}步`
      : '';
    // ⚠️ `__ERR__` 是 mux 那边约定的"这一轮报错了"（402/401/额度/内部错误）
    if (String(raw).startsWith('__ERR__')) {
      return { ok: false, why: String(raw).slice(7), sessionId: sid, ms: Date.now() - t0, usage, costTag };
    }
    return { ok: true, reply: String(raw), sessionId: sid, ms: Date.now() - t0, usage, costTag };
  } catch (e) {
    return { ok: false, why: e.message, ms: Date.now() - t0 };
  }
}

/** 影子模式现在有几个会话（给面板/日志看） */
export function shadowStatus() {
  let waiting = 0;
  for (const list of waiters.values()) waiting += Array.isArray(list) ? list.length : 0;
  return { connected: !!api, sessions: sessions.size, waiting };
}
