/**
 * 复读机：群里一堆人刷同一句话时，她也跟着 **+1**（2026-09-17 用户要求）。
 *
 * 用户原话：
 *   「如果群友全部变成复读机（+1）时，机器人可以在复读到**第 3 句或更多**时直接 +1，
 *     **第三句接复读概率最大，然后依次减小**，
 *     注意**不要有人打断复读时还在接复读**」
 *
 * 截图里那个场景：六个人连着发「怎么下这么早」。
 *
 * ## 三条设计要点
 *
 * ① **按群各记各的**（跟好感度/故事线/余额提醒一个套路）——
 *    A 群在复读，不该影响 B 群的判断。
 *
 * ② **"打断"= 链断**：来一句不一样的，计数**立刻回 1**，
 *    所以「有人插话之后她还在接」这种情况**结构上不可能发生**。
 *    这也是用户特意点出来的那条。
 *
 * ③ **一条链只接一次**：她在第 3 句接了 +1，后面第 4、5、6 句**不再接** ——
 *    否则就成了"她一个人在那儿 +1 个没完"，比不接还难看。
 *
 * ## 什么算"同一句"
 *
 * 归一化之后比：去掉空白、去掉图片/表情占位符、截断到 40 字。
 * 所以「怎么下这么早」和「怎么下这么早 」「怎么下这么早！」算同一句（末尾标点被去掉），
 * 而带不同图片的两条**不算**（图不一样，其实是在发不同的图）。
 * ⚠️ 纯图片/纯表情的消息归一化后是空的 → **不参与复读**（也不打断，见 `observe`）。
 */

/** 一个群最多记这么多（够用，也让 Map 不会无限涨） */
const MAX_GROUPS = 200;

/** 群号 -> { text, count, joined, at } */
const chains = new Map();

/**
 * 群号 -> 上次"接过复读"的时间戳。
 * ⚠️ 跟 `chains` 分开存：链断了（有人插话）之后，冷却**仍然要算数** ——
 *    否则一群人可以靠"插一句话再复读"来让她无限 +1。
 */
const lastJoinAt = new Map();

/**
 * 归一化：让"看起来是同一句"的算同一句。
 *
 * ⚠️ 图片/表情占位符**要留下**（不能删掉），因为它们本来就是内容 ——
 *    删了的话"六个人连着发同一张图"会被当成六条空消息，反而检测不出来。
 */
export function norm(text) {
  return String(text ?? '')
    .replace(/\s+/g, '')
    // 末尾的标点去掉（「怎么下这么早！」和「怎么下这么早」是一句）
    .replace(/[。，,！!？?~～、；;：:]+$/g, '')
    .slice(0, 40);
}

const key = (groupId) => String(groupId ?? '').trim();

/** 忘掉某个群的链（测试 / 有人被踢 / 群号变了都用得上） */
export function reset(groupId) {
  if (groupId === undefined) {
    chains.clear();
    lastJoinAt.clear();
  } else {
    chains.delete(key(groupId));
    lastJoinAt.delete(key(groupId));
  }
}

/**
 * 记一条**群友**发的消息，返回它把这条复读链推到了第几层。
 *
 * ⚠️ 机器人自己说的话**不要喂进来** —— 她的 +1 不该被算成"复读又加了一层"。
 *    （接线的地方会先按 selfId 过滤；这里也可以靠 `opts.isSelf` 兜一道。）
 *
 * @param {string|number} groupId
 * @param {string} text
 * @param {{isSelf?:boolean}} [opts]
 * @returns {number} 连续第几句（1 = 新起头；被打断后也是 1）
 */
export function observe(groupId, text, opts = {}) {
  if (opts.isSelf) return current(groupId);
  const gid = key(groupId);
  if (!gid) return 0;

  const t = norm(text);
  // ⚠️ 归一化后为空（纯图片/纯表情/空消息）：**不参与、也不打断** ——
  //    它既不是"又复读了一句"，也不是"有人插话了"。
  if (!t) return current(gid);

  const prev = chains.get(gid);
  let next;
  if (prev && prev.text === t) {
    next = { text: t, count: prev.count + 1, joined: prev.joined, at: Date.now() };
  } else {
    // 新的一句 / 被打断 → 重新起链。**打断后计数回 1，所以不可能"接着旧链接"**。
    next = { text: t, count: 1, joined: false, at: Date.now() };
  }

  // 简单限容：超了就丢最早的那批（Map 保序）
  if (chains.size >= MAX_GROUPS && !chains.has(gid)) {
    const oldest = chains.keys().next().value;
    if (oldest !== undefined) chains.delete(oldest);
  }
  chains.set(gid, next);
  return next.count;
}

/** 这条链现在到第几句了（没链 = 0） */
export function current(groupId) {
  return chains.get(key(groupId))?.count ?? 0;
}

/** 这条链接过了没有 */
export function hasJoined(groupId) {
  return !!chains.get(key(groupId))?.joined;
}

/** 标记"这条链她已经接过一次了"（一条链只接一次） */
export function markJoined(groupId) {
  const st = chains.get(key(groupId));
  if (st) st.joined = true;
}

/**
 * 第 `count` 句时她跟一句 "+1" 的概率。
 *
 * 用户的规矩：**第三句最大，然后依次减小**。
 * 默认表 `[0.6, 0.4, 0.25, 0.15]`（第 3 / 4 / 5 / 6+ 句），可以在 config 里覆盖。
 * ⚠️ 前两句**恒为 0** —— 两个人说了同一句话而已，还谈不上"复读机"。
 */
export function joinChance(count, probs) {
  const n = Number(count) || 0;
  if (n < 3) return 0;
  const table = Array.isArray(probs) && probs.length ? probs : [0.6, 0.4, 0.25, 0.15];
  const idx = Math.min(n - 3, table.length - 1);
  const v = Number(table[idx]);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

/**
 * 该不该接这条复读 —— 把三件事一起判了，接线的地方只需要看 `.join`。
 *
 * @returns {{count:number, chance:number, join:boolean, why:string}}
 */
export function shouldJoin(groupId, opts = {}) {
  const count = current(groupId);
  if (opts.enable === false) return { count, chance: 0, join: false, why: '功能关了' };
  if (count < 3) return { count, chance: 0, join: false, why: `才第 ${count} 句` };
  if (hasJoined(groupId)) return { count, chance: 0, join: false, why: '这条链已经接过一次' };
  // 冷却：同一个群刚接过就先别接（哪怕是另一条链）
  const cd = Number(opts.cooldownMs) || 0;
  if (cd > 0 && Date.now() - (lastJoinAt.get(key(groupId)) ?? 0) < cd) {
    return { count, chance: 0, join: false, why: '这个群刚接过，冷却中' };
  }
  const chance = joinChance(count, opts.probs);
  return { count, chance, join: chance > 0, why: `第 ${count} 句，概率 ${chance}` };
}

/**
 * 记下"刚刚接了这条复读" —— 同时做两件事：
 *   · 标记这条链已经接过（同一条链只接一次）
 *   · 记时间戳（给上面那个按群的冷却用）
 */
export function noteJoined(groupId) {
  const gid = key(groupId);
  lastJoinAt.set(gid, Date.now());
  markJoined(gid);
}

/** 测试用 */
export function __state(groupId) {
  return chains.get(key(groupId));
}
