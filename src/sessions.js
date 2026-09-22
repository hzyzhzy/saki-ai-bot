/**
 * 玩家在线时长跟踪 —— **自己轮询服务器状态，记录每个人什么时候上来的**。
 *
 * 用户需求（2026-09-12）：「顺便问一下，现在能读取玩家上线时间吗」
 *
 * 背景（真实踩过）：机器人答「就 luomoSan 一个人，**刚上来的**」，
 * luomoSan 当场纠正「我已经上来半小时以上了」。
 *
 * ⚠️ 为什么以前做不到：mcstatus.io 的 `players` 字段**只有**
 *    `{online, max, list}` —— **没有任何时间信息**。所以"刚上来的"是它编的。
 *
 * ✅ 但现在可以做到了：**我们自己做**。
 *    每 `checkIntervalMs` 查一次在线名单，记下「谁第一次出现的时间」。
 *    有人在名单里出现 → 记 `since`；从名单里消失 → 结算时长并移到历史。
 *
 *    这不依赖 API 提供时间，只要它给名单就行。
 *
 * ⚠️ 精度就是轮询间隔（默认 60 秒）—— 所以对外说的时候说"大概""半小时左右"，
 *    别精确到秒（那是假的精确）。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { config, ROOT } from './config.js';
import { log } from './log.js';
import { queryServer } from './status.js';

// ⚠️ 给测试留出口（和 `QQBOT_AFFINITY_FILE` / `QQBOT_QZONE_FILE` 一个套路）。
//    为什么必须能钉住（2026-09-22 踩了）：提示词里那段 **【在线情况】** 只在
//    「最后一个人下线距今 ≤ 12 小时」时才输出 —— 见下面 `sessionsText()`。
//    于是 `test/prompt-snapshot.js` 拿真实 state 跑时，那段**有没有**取决于
//    "最近 12 小时有没有人在服务器上"⇒ 提示词行数跟着变 ⇒ 快照哨兵**有一半时间是红的**。
//    指向测试自己的文件之后，套件写一份固定历史，那段就**永远在**。
const STATE = process.env.QQBOT_SESSIONS_FILE
  ? join(ROOT, process.env.QQBOT_SESSIONS_FILE)
  : join(ROOT, 'state', 'player-sessions.json');

/** { since: {玩家名: 时间戳}, history: [{name, from, to, minutes}] } */
let state = { since: {}, history: [] };

/**
 * 结束**所有**在线会话（服务器关机 / 连不上时用）。
 *
 * ⚠️ 关键：结算时间用 `at`（**最后一次成功看到他在线**的时间），
 *    **不是 now** —— 否则"从最后一次看到他，到发现服务器关了"这段
 *    也会被算成在线（比如找了 5 小时才发现服务器关了）。
 */
function endAllSessions(at, why) {
  const names = Object.keys(state.since);
  if (!names.length) return;
  for (const n of names) {
    const from = state.since[n];
    const minutes = Math.round((at - from) / 60000);
    delete state.since[n];
    // 太短的（<1 分钟）不记 —— 那多半是查询间隔造成的毛刺
    if (minutes >= 1) {
      state.history.push({ name: n, from, to: at, minutes, note: why });
      if (state.history.length > 200) state.history = state.history.slice(-200);
    }
    log.info(`[在线] ${n} 结束（${why}），在线约 ${minutes} 分钟`);
  }
}

function load() {
  try {
    if (!existsSync(STATE)) return;
    const j = JSON.parse(readFileSync(STATE, 'utf8'));
    if (j && typeof j === 'object') {
      state = {
        since: j.since ?? {},
        history: Array.isArray(j.history) ? j.history : [],
        // ⚠️ 这几个也要存盘（2026-09-13 加）：
        //    lastSeenAt    = 最后一次成功查到名单的时间（结算停机时要用它）
        //    lastOfflineAt = 上次发现服务器离线的时间（恢复时可以说"刚重启"）
        lastSeenAt: Number(j.lastSeenAt) || 0,
        lastOfflineAt: Number(j.lastOfflineAt) || 0,
        lastOnlineAt: Number(j.lastOnlineAt) || 0,
        offlineStreak: Number(j.offlineStreak) || 0,
      };
      log.debug(`已载入玩家在线记录（当前 ${Object.keys(state.since).length} 人，历史 ${state.history.length} 条）`);
    }
  } catch (e) {
    log.warn(`载入玩家在线记录失败：${e.message}`);
  }
}

/** 原子写（写 .tmp 再 rename）—— 参考 digest.js / qzone.js 的做法 */
function save() {
  try {
    mkdirSync(dirname(STATE), { recursive: true });
    const tmp = STATE + '.tmp';
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    renameSync(tmp, STATE);
  } catch (e) {
    log.warn(`保存玩家在线记录失败：${e.message}`);
  }
}

load();

/**
 * 查一次名单并更新记录。
 * @returns {Promise<{online:string[]}>}
 */
export async function tick() {
  if (config.sessions?.enable === false) return { online: [] };
  const s = config.status ?? {};
  if (!s.enable || !s.host) return { online: [] };

  let data;
  try {
    // ⚠️ 这里 ttl 传 0 强制实查（不然会命中 status 的缓存，看不到变化）
    data = await queryServer(s.host, 0);
  } catch (e) {
    log.debug(`在线时长跟踪：查询失败 ${e.message}`);
    return { online: [] };
  }

  // ⚠️⚠️ 2026-09-13 修的重大 bug：**服务器关机/连不上时，必须结束所有会话**。
  //
  //    原来这里是一句 `if (!data?.ok || !data.online) return { online: [] };`
  //    —— 服务器一关就什么都不做，于是**停机时间被算成了在线时间**。
  //
  //    真实数据（用户的服务器 03:13~08:39 关机）：
  //        <主人>   22:35:32 → 12:22:00   约 826 分钟   ← 近 14 小时！
  //        luomoSan  23:00:25 → 12:22:00   约 802 分钟   ← 13 小时！
  //    中间那 5 小时服务器压根没开，却被算进去了。
  //    用户反馈：「服务器上线和下线时间还有点不对」。
  //
  //    现在的处理：**关机 = 大家都下线了**，按"最后一次成功看到他在线"结算，
  //    而不是按"现在"。这样停机那段不会被算进去。
  if (!data?.ok || !data.online) {
    // ⚠️ **别一次失败就把所有人都判下线** —— 网络抖一下就会误判。
    //    连续 CONFIRM_OFFLINE 次查不到才算"服务器真关了"。
    //    （一轮 = checkIntervalMs，默认 60 秒 → 3 轮 ≈ 3 分钟容错）
    state.offlineStreak = (state.offlineStreak ?? 0) + 1;
    const CONFIRM_OFFLINE = 3;
    if (state.offlineStreak < CONFIRM_OFFLINE) {
      log.debug(
        `在线时长跟踪：查不到（第 ${state.offlineStreak}/${CONFIRM_OFFLINE} 次），先不动记录`,
      );
      return { online: [] };
    }
    const why = data?.ok ? '服务器离线' : `查询失败（${data?.error ?? '未知'}）`;
    if (Object.keys(state.since).length) {
      const at = state.lastSeenAt ?? Date.now();
      endAllSessions(at, `服务器关了/连不上（${why}）`);
      state.lastOfflineAt = Date.now();
      save();
    }
    return { online: [] };
  }
  // 查到了 → 清零
  state.offlineStreak = 0;

  // 服务器又活了 → 记下来（对外说的时候可以提"刚重启"）
  if (state.lastOfflineAt) {
    state.lastOnlineAt = Date.now();
    log.info(`[在线] 服务器恢复了（之前至少离线到 ${new Date(state.lastOfflineAt).toLocaleTimeString('zh-CN', { hour12: false })}）`);
    state.lastOfflineAt = 0;
  }
  state.lastSeenAt = Date.now();

  const names = data.players?.names ?? [];
  if (!names.length) {
    // 名单为空有两种可能：真没人了，或者服务端不公开名单。
    // ⚠️ 如果是"不公开名单"，这里把所有人结算成下线就全错了。
    //    判据：之前有记录、而现在 online 数 > 0 但名单为空 → 说明不公开，别动。
    if ((data.players?.online ?? 0) > 0) {
      log.debug('在线时长跟踪：服务端未公开名单，跳过本次更新');
      return { online: [] };
    }
  }

  const now = Date.now();
  const before = new Set(Object.keys(state.since));
  const after = new Set(names);

  state.lastSeen = state.lastSeen ?? {};

  // 新来的（或重启后仍在线但没记录的）→ 记下起始时间
  //
  // ⚠️ 关于精度（2026-09-13，用户反馈「玩家上服和下服的时间不对」）：
  //    我们的时间戳精度**上限就是轮询间隔**（默认 60 秒）——
  //    他可能在两次轮询之间的任何时刻上线的，我们只能记"第一次看到他"的时间。
  //    · 加入时间：最快只能准到"上一轮之后"，所以**最多可能晚一个间隔**
  //    · 离开时间：用 `state.lastSeen[n]`（**最后一次看到他在线**的时刻），
  //      而不是 `now` —— 否则他 13:00:30 下线、我 13:01:00 才发现，
  //      会记成 13:01，白多算 30 秒。
  //    所以对外说的时候仍然要求"说得含糊一点"（见 sessionsText）。
  for (const n of after) {
    if (!state.since[n]) {
      state.since[n] = now;
      log.info(`[在线] ${n} 上来了`);
    }
    // 每次看到都刷新"最后一次在线"
    state.lastSeen[n] = now;
  }

  // 走了的 → 结算时长（用"最后一次看到他在线"，不是 now）
  for (const n of before) {
    if (!after.has(n)) {
      const from = state.since[n];
      const leftAt = state.lastSeen[n] ?? now;
      const minutes = Math.round((leftAt - from) / 60000);
      delete state.since[n];
      delete state.lastSeen[n];
      if (minutes >= 1) {
        state.history.push({ name: n, from, to: leftAt, minutes });
        // 历史只留最近 200 条
        if (state.history.length > 200) state.history = state.history.slice(-200);
      }
      log.info(`[在线] ${n} 下线了（在线约 ${minutes} 分钟）`);
    }
  }
  save();
  return { online: [...after] };
}

/** 起后台轮询（启动时调一次） */
export function startSessionTracker() {
  if (config.sessions?.enable === false) return;
  const activeMs = Number(config.sessions?.checkIntervalMs) || 30000;
  // ⚠️ 自适应间隔（2026-09-13 加）：
  //    用户反馈「玩家上服和下服的时间不对」—— 精度上限就是轮询间隔。
  //    但一直高频轮询又是白白打服务器 API，所以分两档：
  //      · **有人在线** → 用 activeMs（默认 30 秒，尽量准）
  //      · **没人在线** → 用 idleMs（默认 3 分钟，省点力气；
  //        没人时唯一要抓的就是"谁上线了"，晚一两分钟发现也可以接受）
  const idleMs = Math.max(activeMs, Number(config.sessions?.idleIntervalMs) || 180000);

  let timer = null;
  const loop = async () => {
    let online = [];
    try {
      const r = await tick();
      online = r?.online ?? [];
    } catch (e) {
      log.debug(`在线时长跟踪出错：${e.message}`);
    }
    const wait = online.length ? activeMs : idleMs;
    timer = setTimeout(loop, wait);
    timer.unref?.();
  };
  // 启动后先等一会儿（别刚开机就打 API）
  timer = setTimeout(loop, 15000);
  timer.unref?.();
  log.info(
    `在线时长跟踪已启动（有人时每 ${Math.round(activeMs / 1000)} 秒查一次，没人时每 ${Math.round(idleMs / 1000)} 秒）`,
  );
}

/**
 * 拼一段「谁在线、在多久了」给模型看。
 *
 * ⚠️ 说的时候要**含糊一点**（"大概半小时"）—— 精度就是轮询间隔，
 *    说"31 分 27 秒"是假的精确。
 */
export function sessionsText() {
  if (config.sessions?.enable === false) return '';
  const now = Date.now();
  const names = Object.keys(state.since);

  // ── 有人在线：报"谁在、在多久" ──
  if (names.length) {
    const lines = names
      .map((n) => {
        const mins = Math.round((now - state.since[n]) / 60000);
        return `- ${n}：在线约 ${mins} 分钟`;
      })
      .join('\n');
    return [
      '',
      '# 【在线时长】（**系统实测**，可以放心说）',
      '',
      lines,
      '',
      '⚠️ 这些是**真实记下来的**（系统每隔一分钟查一次名单），所以你可以说。',
      '但**说得含糊一点** ——「大概半小时」「有一会儿了」，',
      '别报精确到秒的数字（那是假的精确，本来就有 ±1 分钟的误差）。',
      '⚠️ **不在这个列表里的玩家，就是不知道他什么时候上来的** —— 那种情况别猜。',
    ].join('\n');
  }

  // ── ⚠️ 没人在线：报"最后一个在线的人是什么时候"（2026-09-13 加，用户要求）──
  //
  // 用户原话：「建议如果服务器没人时，也可以说说最后一个在线的人是什么时候」
  //
  // 为什么有用：群里问「有人吗」得到一句干巴巴的「没有」很没意思；
  // 「刚 luomoSan 还在，他下去没一会儿」信息量大得多，也像真人在答话。
  const last = state.history[state.history.length - 1];
  if (!last) return ''; // 从来没记录过，那就别说
  const goneMin = Math.round((now - last.to) / 60000);
  // 太久远（超过 12 小时）就别提了 —— 那是"昨天的事"，拿来当下文说很怪
  if (goneMin > 12 * 60) return '';
  const when =
    goneMin < 1
      ? '刚刚（不到一分钟前）'
      : goneMin < 3
        ? '刚刚'
        : goneMin < 60
          ? `大约 ${goneMin} 分钟前`
          : `大约 ${Math.round(goneMin / 60)} 小时前`;
  return [
    '',
    '# 【在线情况】（**系统实测**，可以放心说）',
    '',
    '**现在没人在线。**',
    `**最后一个在线的是 ${last.name}** —— 他 ${when} 下的，那次在线约 ${last.minutes} 分钟。`,
    '',
    '⚠️ 这是**真实记下来的**（系统每隔一分钟查一次名单），所以你可以说。',
    '⚠️ 说的时候**自然点** —— 像「刚 XX 还在，下去没一会儿」这种，',
    '别像在念报表（「最后在线记录：XX，时间戳…」这样很怪）。',
    '⚠️ **不确定就别加戏** —— 他为什么下线、去干嘛了，**你不知道，别编**。',
  ].join('\n');
}

/** 给管理界面看的 */
export function sessionsStatus() {
  return {
    online: Object.keys(state.since).length,
    history: state.history.length,
    since: { ...state.since },
  };
}

export function clearAll() {
  state = { since: {}, history: [] };
  save();
}
