/**
 * 查询 MC 服务器实时状态（「有人吗」「几个人在线」「服务器开了吗」）。
 *
 * ⚠️⚠️ 2026-09-13 大改：**从"依赖第三方 API"改成"自己查"**。
 *
 * 起因：用户问「为什么刚才机器人直接说服务器离线了？实际没有」。
 * 查证过程：
 *    · 用户服务器走 frp 内网穿透，域名**只有 SRV 记录、没有 A 记录**：
 *        _minecraft._tcp.mc.example.com → frp.example.com:12345
 *    · mcstatus.io 有时**漏解析 SRV**（返回 `srv_record: null`），
 *      然后按默认端口连 `host:25565` → 域名无 A 记录 → 连不上 → 报 `online: false`。
 *    · 但**即使我们明确把 `frp.example.com:12345` 交给它，它照样说离线** ——
 *      而同一时刻我自己用 MC 协议握手能拿到完整状态（含 favicon）。
 *    → **结论：那个第三方 API 不可靠，服务器一直是活的。**
 *
 * 所以现在**优先自己查**（标准 Server List Ping 协议），第三方只作兜底：
 *    · 自己查：先解析 SRV → 拿真实地址 → TCP 握手 → 拿 JSON 状态
 *    · 兜底：自己查失败才去问 mcstatus.io
 *
 * 好处：**不再受第三方抽风影响**，而且少一次外网往返（更快）。
 */
import { createConnection } from 'node:net';
import { Resolver } from 'node:dns/promises';
import { log } from './log.js';
import { config } from './config.js';

/** 简化版缓存，避免群友连问时反复查 */
let cache = { at: 0, data: null, error: null };
/** 上一次**成功**的查询结果 —— 用来在偶发失败时兜底 */
let lastGood = { at: 0, data: null };

/** 失败后的短退避（毫秒）。**必须短**，见 queryServer 里的注释。 */
const FAIL_RETRY_MS = 8000;

/** 查询端点。**只在"自己查"失败时兜底用**。 */
function apiBase() {
  return (config.status.apiBase ?? 'https://api.mcstatus.io/v2/status/java').replace(/\/+$/, '');
}

/** 把 n 编码成 Minecraft 的 VarInt */
function varint(n) {
  const out = [];
  let v = n >>> 0;
  for (;;) {
    if ((v & ~0x7f) === 0) {
      out.push(v);
      break;
    }
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return Buffer.from(out);
}

/**
 * 解析域名该连哪儿（SRV 记录）。
 *
 * ⚠️ 这一步**必须自己做**：用户的服务器只有 SRV 记录、没有 A 记录，
 *    不解析 SRV 就会去连一个不存在的地址。
 *
 * @returns {Promise<{host:string, port:number, srv:boolean}>}
 */
async function resolveTarget(host, explicitPort) {
  // ⚠️ 支持 `域名:端口` 这种写法（配置里可能这么写；测试也用它来指向假服务器）。
  //    不解析的话会把 "127.0.0.1:39104" 当成域名去查 SRV，必然失败。
  let h = String(host ?? '').trim();
  let p = explicitPort ? Number(explicitPort) : 0;
  const m = /^([^:\[\]]+|\[[^\]]+\]):(\d+)$/.exec(h);
  if (m) {
    h = m[1];
    p = Number(m[2]);
  }
  if (p) return { host: h, port: p, srv: false };

  try {
    const rec = await new Resolver().resolveSrv(`_minecraft._tcp.${h}`);
    if (Array.isArray(rec) && rec.length) {
      // RFC 2782：先按 priority 升序，同优先级按 weight 降序
      rec.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
      return { host: rec[0].name, port: rec[0].port, srv: true };
    }
  } catch (e) {
    log.debug(`SRV 解析失败（${e.code ?? e.message}），按默认端口 25565 查`);
  }
  return { host: h, port: 25565, srv: false };
}

/**
 * 从 Buffer 里按 Minecraft 的 VarInt 规则读一个整数。
 *
 * ⚠️⚠️ 2026-09-13 修：**别用 `|=` + `<<`**，会溢出。
 *
 *    第一版写的是：
 *      `value |= (b & 0x7f) << (7 * size)`
 *    —— JS 的位运算是 **32 位有符号**，`<< 14` / `<< 21` 会把低位挤掉。
 *    实测真实服务器返回的包长是 `ae c0 01`（3 字节 VarInt = 24622），
 *    这样算出来是错的 —— 于是 `body` 的起点偏了，JSON 从中间开始解析 →
 *    `Unexpected token '\ufffd'` → 状态查询永远失败。
 *
 *    （真实症状：用户问服务器，机器人回「暂时查不到」。
 *      注意这跟 6 秒硬超时**无关** —— 服务器 145ms 就回了，只是我们解错了。）
 *
 *    正确做法：用**乘法**累加（和编码端 `writeVarInt` 对称）。
 */
function readVarInt(buf, offset = 0) {
  let value = 0;
  let size = 0;
  for (;;) {
    if (offset + size >= buf.length) return null; // 还没收全
    const b = buf[offset + size];
    value += (b & 0x7f) * Math.pow(2, 7 * size);
    size++;
    if ((b & 0x80) === 0) break;
    if (size > 5) return null; // 畸形
  }
  return { value, size };
}

/**
 * **自己实现** Server List Ping（1.7+ 协议）。
 *
 * 流程：TCP 连接 → 发 Handshake(nextState=1) → 发 Status Request →
 *       读 VarInt 长度 + Packet ID + JSON 字符串。
 *
 * @returns {Promise<{online:true, version:string, players:{online:number,max:number,names:string[]}}>}
 */
function selfPing(addr, port, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: addr, port, timeout: timeoutMs });
    let buf = Buffer.alloc(0);
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {}
      fn(v);
    };

    sock.on('connect', () => {
      try {
        const hostBuf = Buffer.from(addr, 'utf8');
        const portBuf = Buffer.alloc(2);
        portBuf.writeUInt16BE(port);
        // Handshake：protocol(-1 表示只问状态) + addr + port + nextState(1)
        const hs = Buffer.concat([
          Buffer.from([0x00]),
          varint(0x7fffffff), // protocol version（随便给，服务端不管）
          varint(hostBuf.length),
          hostBuf,
          portBuf,
          Buffer.from([0x01]),
        ]);
        sock.write(Buffer.concat([varint(hs.length), hs]));
        // Status Request：空包，id=0
        sock.write(Buffer.concat([varint(1), Buffer.from([0x00])]));
      } catch (e) {
        done(reject, e);
      }
    });

    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      // ⚠️⚠️ 2026-09-13 重写：**按 MC 协议正经解包**，别再 `indexOf('{')`。
      //
      //    原来的写法是「在缓冲区里找第一个 `{`，从那儿开始 JSON.parse」。
      //    它踩了一个很隐蔽的坑（cs 测试因此**偶发**卡 28 秒，查了很久）：
      //
      //      握手包和 Status Request 是**两次 write**，但 TCP 会把它们
      //      合进同一个 segment 发出去 —— 于是假服务端（真实服务端也一样）
      //      **收到一次 data 事件却回了两条完整响应**，
      //      两条响应粘在同一个 TCP 包里到达。
      //
      //      缓存区内容大致是：   [len1][id1][json1: {"version":…}][len2][id2][json2]
      //      我们只取「第一个 `{`」→ 拿到的是 **json1 的一部分**
      //      （长度位被当成 JSON 开头）→ JSON.parse 抛错 → catch 静默吞掉
      //      → **永远等不到第二条**（因为第二条被我们丢在 buf 里没再用）
      //      → 干等到 12 秒超时 → 重试 → 28 秒。
      //
      //    现在：读 VarInt 长度 → 等够那么多字节 → 取包内 JSON。
      //    顺便**支持粘包**（一次 data 里含多条响应，逐条处理）。
      const view = buf;
      const head = readVarInt(view, 0);
      if (!head) return; // 长度还没收全，等下一块
      if (view.length < head.size + head.value) return; // 包体还没收全
      // ⚠️ 头部结构（实测真实服务器 + 假 MC 都是这个）：
      //      [长度 VarInt][包ID VarInt][又是一个长度 VarInt][JSON…]
      //      e.g.  ae c0 01 | 00 | aa c0 01 | 7b 22 66 61 76 …   （真实服，24KB）
      //            7b       | 00 | 7b       | 7b 22 76 65 72 …   （小响应）
      //      长度=24622 包ID=0  长度=24622  {"favicon"…
      //
      //    ⚠️⚠️ 必须**按结构解**，别「找第一个 `{`」。
      //      `{` = 0x7B，而 **VarInt 长度 123 的第一个字节正好就是 0x7B**！
      //      小响应（比如 cs 测试的假服务器，约 123 字节）就会**把长度字节
      //      当成 JSON 起点** → 从中间解析 → `Unexpected token` → 静默丢包。
      //      （这就是「实时结果里带上了在线玩家名单」那条偶发失败的真因 ——
      //        响应刚好跨过 123 字节这个坎，就会失败。）
      const body = view.subarray(head.size, head.size + head.value);
      const idv = readVarInt(body, 0);
      if (!idv) return; // 包ID 还没收全
      const slen = readVarInt(body, idv.size);
      // 结构完整时：JSON 长度就在包ID 后面。读不到就退回「找 `{`」（兜底，
      // 但那次要能确认 `{` 后面确实是合法 JSON，否则等下一块）。
      let jsonBuf = null;
      if (slen && body.length >= idv.size + slen.size + slen.value) {
        jsonBuf = body.subarray(idv.size + slen.size, idv.size + slen.size + slen.value);
      } else {
        const brace = body.indexOf(0x7b, idv.size);
        if (brace < 0) return; // 正文还没到
        jsonBuf = body.subarray(brace);
      }
      const jsonStr = jsonBuf.toString('utf8');
      let j;
      try {
        j = JSON.parse(jsonStr);
      } catch {
        // ⚠️ 2026-09-17 临时诊断（查 cs 那条"玩家名单"偶发）
        log.debug(
          `[MC] JSON 解析失败 buf=${view.length} 头=${head.size}+${head.value} 串长=${jsonStr.length} 前 60 字=${jsonStr.slice(0, 60)}`,
        );
        // 解不出来就别当成本次的结果 —— 丢掉这包，等下一包（别静默死等）
        buf = view.subarray(head.size + head.value);
        return;
      }
      // ⚠️ 2026-09-17 临时诊断：看这次到底拿到没有名单
      log.debug(
        `[MC] 解析成功 buf=${view.length} 串长=${jsonStr.length} 在线=${j.players?.online}/${j.players?.max} 名单=${(j.players?.sample ?? []).length} 人`,
      );
      done(resolve, {
        online: true,
        version: j.version?.name ?? '',
        players: {
          online: Number(j.players?.online ?? 0),
          max: Number(j.players?.max ?? 0),
          names: (j.players?.sample ?? []).map((p) => p?.name).filter(Boolean),
        },
      });
    });

    sock.on('error', (e) => done(reject, e));
    sock.on('timeout', () => done(reject, new Error('连接超时')));
  });
}

/**
 * 查一次服务器状态。
 *
 * 顺序：**自己查（含 SRV）→ 失败才问第三方 API**。
 *
 * @param {string} host 服务器地址（含 SRV 记录的域名即可，不用写端口）
 * @param {number} ttl 缓存毫秒
 */
export async function queryServer(host, ttl = 60000) {
  // ⚠️⚠️ 硬超时（2026-09-13 加）。
  //
  //    这个查询在**回复的关键路径上** —— `handle` 里 `await queryServer(...)`
  //    之后才去建提示词、调模型。所以它一卡，**整条回复就卡**，
  //    用户看到的就是「机器人没回我」。
  //
  //    实测踩到过：cs 回归里约 1/4 概率卡 **28 秒**（「问在线人数」那步
  //    模型调用一直不发生 → 测试超时）。根因没完全定位
  //    （`selfPing` 内部查过、TCP 走代理的假设也排除了），
  //    所以这里加一道**确定性的保险**：
  //      · 正常只花 1~50ms，这个超时根本不会触发
  //      · 真卡住时最多等 6 秒 → 用上次成功的数据兜底，或报"查不到"
  //      · **回复永远不会被它拖死**
  //
  //    这不是掩盖 bug，而是把「查不到」和「卡死」分开 ——
  //    宁可回一句"我这会儿查不到"，也别让用户干等半分钟。
  const HARD_TIMEOUT_MS = 6000;
  log.debug(`实查开始：host="${host}" ttl=${ttl}`);
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('__TIMEOUT__'), HARD_TIMEOUT_MS);
    timer.unref?.();
  });
  const r = await Promise.race([queryServerInner(host, ttl), timeout]);
  clearTimeout(timer);
  if (r !== '__TIMEOUT__') return r;

  log.warn(`查询服务器状态超过 ${HARD_TIMEOUT_MS / 1000} 秒，放弃本次实查`);
  if (lastGood.data && Date.now() - lastGood.at < 5 * 60 * 1000) {
    const stale = { ...lastGood.data, stale: true };
    cache = { at: Date.now(), data: stale, error: null };
    return stale;
  }
  const data = { ok: false, error: `查询超时（超过 ${HARD_TIMEOUT_MS / 1000} 秒）` };
  cache = { at: Date.now() - ttl + FAIL_RETRY_MS, data, error: data.error };
  return data;
}

async function queryServerInner(host, ttl = 60000) {
  const now = Date.now();
  if (cache.data && now - cache.at < ttl) {
    return cache.data;
  }

  // ① 先自己查
  try {
    const target = await resolveTarget(host);
    log.debug(`实查目标：${target.host}:${target.port}${target.srv ? '（SRV）' : ''}`);
    const r = await selfPing(target.host, target.port);
    log.debug(`自己查成功：${r.version} ${r.players?.online}/${r.players?.max} 名单 ${r.players?.names?.length ?? 0} 人`);
    const data = {
      ok: true,
      online: true,
      version: r.version,
      players: r.players,
      viaSrv: target.srv,
      source: 'self',
    };
    cache = { at: now, data, error: null };
    lastGood = { at: now, data };
    return data;
  } catch (e) {
    log.debug(`自己查失败（${e.code ?? e.message}），改用第三方 API 兜底`);
  }

  // ② 兜底：第三方 API
  try {
    const data = await queryViaApi(host);
    cache = { at: now, data, error: null };
    lastGood = { at: now, data };
    return data;
  } catch (e) {
    log.warn(`查询服务器状态失败: ${e.message}`);

    // ⚠️ 失败缓存策略（2026-09-12 修）：失败只短退避 8 秒，
    //    别把一次抖动放大成一分钟"读不到"（用户反馈过）。
    //    有上次成功的数据就用它兜底，并注明是刚才的数据。
    if (lastGood.data && now - lastGood.at < 5 * 60 * 1000) {
      log.info(`服务器查询失败，用 ${Math.round((now - lastGood.at) / 1000)}s 前的成功数据兜底`);
      const stale = { ...lastGood.data, stale: true };
      cache = { at: now, data: stale, error: null };
      return stale;
    }

    const data = { ok: false, error: e.message };
    cache = { at: now - ttl + FAIL_RETRY_MS, data, error: e.message };
    return data;
  }
}

/** 第三方 API（只在"自己查"失败时用） */
async function queryViaApi(host) {
  const target = await resolveTarget(host);
  const q = target.port && target.srv ? `${target.host}:${target.port}` : host;
  const res = await fetch(`${apiBase()}/${encodeURIComponent(q)}`, {
    headers: { 'User-Agent': 'qq-ai-bot/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return {
    ok: true,
    online: !!j.online,
    version: j.version?.name_clean ?? '',
    players: {
      online: j.players?.online ?? 0,
      max: j.players?.max ?? 0,
      names: (j.players?.list ?? []).map((p) => p.name_clean).filter(Boolean),
    },
    viaSrv: target.srv,
    apiSrv: j.srv_record ?? null,
    source: 'api',
  };
}

/** 把状态整理成给模型看的一段文字 */
export function describe(data, serverName = '服务器') {
  // ⚠️ 这段文字是**实查完立刻**塞进提示词的 —— 数据已经在模型手里了。
  //    但模型经常回「我这边看一下……稍等」然后就没了下文（用户反馈），
  //    因为它以为「查」是它接下来要做的事。所以这里必须明说：**现在就说，别答应稍等**。
  const head = [
    `# 【服务器实时状态】系统已经帮你查好了，**现在就直接回答**`,
    '',
    '⚠️ **数据就在下面，别再说「我看一下」「稍等」「我去查查」这种话** ——',
    '你没有下一步动作，说完就没有下文了，对方会觉得你放了他鸽子。',
    '**直接把人数据念出来就行。** 也别把这段格式原样贴出去，用你自己的话说。',
    '',
  ].join('\n');

  if (!data?.ok) {
    return `${head}${serverName}状态：暂时查不到（${data?.error ?? '未知错误'}）。请直接告诉群友查询失败，不要编造。`;
  }
  if (!data.online) {
    return `${head}${serverName}状态：当前未开机 / 无法连接（离线）。`;
  }
  const { online, max, names } = data.players;
  const list = names.length ? `，在线玩家：${names.join('、')}` : '（服务端未公开玩家名单）';
  // ⚠️ 如果这份是**上次成功的数据**（这次查询失败了），要注明，
  //    免得它把一分钟前的人数当成"现在"来说（2026-09-12 加）。
  const staleNote = data.stale
    ? '\n\n⚠️ **这份数据是刚才查到的（这次查询失败，用的是上一份）** ——' +
      '人数/名单可能已经变了。说的时候**别把话说得太绝对**，' +
      '可以说「刚看了一眼是…」而不是「现在就是…」。'
    : '';
  // ⚠️ 2026-09-12：原来这段是"你绝对不知道他什么时候上来的"。
  //    但**现在系统自己记了在线时长**（sessions.js 每 60 秒查一次名单），
  //    那段会一起拼进提示词。所以这里改成「**只以那份数据为准**」——
  //    没记录的人才不许猜。
  const noTime = [
    '',
    '## ⚠️ 关于「他什么时候上来的 / 在线多久」',
    '',
    '上面这份状态里**只有名字和人数，没有时间**。',
    '**如果提示词里另有一段「【在线时长】」** → 照那段说（那是系统实测记下来的）。',
    '**如果那个人不在那段里** → 就**不知道**他什么时候上来的，',
    '**不许说**「他刚上来的」「他上线多久了」这种话（真实踩过：',
    '说「就 luomoSan 一个人，刚上来的」，被 luomoSan 当场纠正「我已经上来半小时以上了」）。',
    '',
    '不知道时就说「我不知道他上来多久了」，或者直接问他本人。',
  ].join('\n');
  return `${head}${serverName}状态：在线。版本 ${data.version}，当前在线 ${online}/${max} 人${list}。${noTime}${staleNote}`;
}

export function clearCache() {
  cache = { at: 0, data: null, error: null };
}
