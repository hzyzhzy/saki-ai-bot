/**
 * 「机器人池」自动同步（2026-10-07 用户要求）。
 *
 * 用户原话：
 *   「把这里登上的所有 QQ 自动互相加入同类池，以后每次加号都能自动互相加池，
 *     然后不同类池也要自动复用」
 *
 * ## 两个池的语义（别搞混，它们是**相反**的）
 *
 * | 池 | 存哪 | 意思 | 这里的同步规则 |
 * | --- | --- | --- | --- |
 * | **同类池** `peers` | `groupParams[群].peers` | **跟它聊天的同类机器人**（会互相搭话） | **互相加**：我们管的每个号，都进其它号的池 |
 * | **不同类池** `otherBots` | `groupParams[群].otherBots` | **完全不回应的**别的机器人（比如小豆那种） | **复用**：把所有号已经配过的并集抄给每个号 |
 *
 * ⚠️ 为什么 ② 是"并集复用"、不是"互相加"：`otherBots` 里装的是**别人家的机器人**，
 *    它们不是我们管的号，谈不上互相加；"复用"的意思就是"你在 A 号上配过一次，
 *    新加的 B 号不用再配一遍"。
 *
 * ## 两个关键设计（错了会很难查）
 *
 * 1. **只追加、不删除**（`add` 语义）。用户手配的黑祥、小豆那些号必须留着 ——
 *    同步是"补齐"，不是"按我算的重写"。所以这里绝不整体覆盖 `peers` 数组。
 * 2. "**这个号在哪些群**"用的是它自己的 `trigger.allowGroups`（配置里那份名单），
 *    不是去问协议端要实时群列表 —— 后者要机器人连着、还会把"刚拉进去还没说过话的群"
 *    算进来。配置名单是**她自己认的群**，和"要不要在那个群说话"本来就是一件事。
 *    ⇒ 只有**两个号都在名单里**的群，才会互相加池。
 */

import * as accounts from './accounts.js';

/** 把各种形状的群号列表收敛成 Set<string> */
function toSet(list) {
  return new Set(
    (Array.isArray(list) ? list : [])
      .map((x) => String(x ?? '').trim())
      .filter((x) => /^\d{5,12}$/.test(x)),
  );
}

/** 这个号认哪些群（读它自己的 allowGroups） */
function groupsOf(qq, fallback) {
  const a = accounts.read(qq) ?? {};
  const own = toSet(a.trigger?.allowGroups);
  if (own.size) return own;
  return toSet(fallback); // 没写就从外面传进来的那份兜底（通常是主号的）
}

/**
 * 跑一次同步。
 *
 * @param {object} [opt]
 * @param {string[]} [opt.ids]     指定要同步哪些号（默认：账号目录里全部）
 * @param {boolean} [opt.dryRun]   只算不改（界面预览 / 测试用）
 * @returns {{ok:boolean, changed:Array, notes:string[]}}
 */
export function sync(opt = {}) {
  const ids = (opt.ids ?? accounts.ids()).map(String);
  const notes = [];
  if (ids.length < 2) {
    return { ok: true, changed: [], notes: ['只有一个号，没有"同类"可加（加第二个号时会自动做）'] };
  }

  // ① 每个号认哪些群
  const all = new Set();
  for (const qq of ids) for (const g of groupsOf(qq, [])) all.add(g);
  const fallback = [...all]; // 给"自己没写 allowGroups"的号兜底
  const groups = new Map();
  for (const qq of ids) groups.set(qq, groupsOf(qq, fallback));

  // ② 不同类池的并集（所有人的 otherBots 合起来），⚠️ 排除我们自己管的号
  const mine = new Set(ids);
  const otherUnion = new Set();
  for (const qq of ids) {
    const gp = (accounts.read(qq) ?? {}).groupParams ?? {};
    for (const g of Object.values(gp)) {
      for (const b of g?.otherBots ?? []) {
        const s = String(b ?? '').trim();
        if (/^\d{5,12}$/.test(s) && !mine.has(s)) otherUnion.add(s);
      }
    }
  }

  const changed = [];

  // ③ 逐号算要补什么
  for (const qq of ids) {
    if (!accounts.has(qq)) continue;
    const acc = accounts.read(qq) ?? {};
    const myGroups = groups.get(qq) ?? new Set();
    const patch = {};
    const report = { qq, peersAdded: [], otherAdded: [], groups: [] };

    for (const gid of myGroups) {
      // 同类池：**其它**号里，也认得这个群的
      const peerWanted = ids.filter((x) => x !== qq && (groups.get(x) ?? new Set()).has(gid));
      const curPeers = toSet(acc.groupParams?.[gid]?.peers);
      const addPeers = peerWanted.filter((p) => !curPeers.has(p));

      // 不同类池：并集里这个号还没有的
      const curOther = toSet(acc.groupParams?.[gid]?.otherBots);
      const addOther = [...otherUnion].filter((b) => !curOther.has(b));

      if (!addPeers.length && !addOther.length) continue;

      patch[gid] = {};
      if (addPeers.length) {
        patch[gid].peers = [...curPeers, ...addPeers];
        report.peersAdded.push(...addPeers);
      }
      if (addOther.length) {
        patch[gid].otherBots = [...curOther, ...addOther];
        report.otherAdded.push(...addOther);
      }
      report.groups.push(gid);
    }

    if (!Object.keys(patch).length) continue;
    if (!opt.dryRun) {
      // ⚠️ `accounts.patch` 是**深合并** ⇒ 这个群里原有的 chat / life / quest /
      //    以及已配的 peers 都不会被冲掉（只动我们写的那两个键）。
      accounts.patch(qq, { groupParams: patch });
    }
    report.peersAdded = [...new Set(report.peersAdded)];
    report.otherAdded = [...new Set(report.otherAdded)];
    changed.push(report);
  }

  if (!changed.length) notes.push('已经是最新的，没有要补的');
  return { ok: true, changed, notes, otherUnion: [...otherUnion] };
}
