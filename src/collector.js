/**
 * 表情包自动收集与热度统计。
 *
 * 两个作用：
 *   1. 群里有人发图时把它存下来（图还在 NapCat 缓存里的时机），进 pending 队列等打标签
 *   2. 记录每张图被谁发过、发过几次 —— 高频的图说明是群里的「通用梗」，
 *      机器人跟着用就不会突兀
 *
 * 存在 library/_pending/，由管理界面审核后进入正式表情库。
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, config } from './config.js';
import { isStickerSeg } from './message.js';
import { log } from './log.js';

const LIB = join(ROOT, 'library');
const PENDING = join(LIB, '_pending');
const STATS = join(LIB, '_stats.json');
/** 群友常用表情的本地缓存（为了能原样发回去） */
const COMMON = join(LIB, '_common');

/** 超过这个大小多半是截图/照片，不是表情包 */
const MAX_SIZE = 400 * 1024;
/** pending 队列上限，防止无限堆积 */
const MAX_PENDING = 200;
/** 已经落到正式库的文件名，用于跳过 */
let knownFiles = new Set();
/** 正式库里每张图的内容 hash，用来认出「这张已经在库里了」 */
let knownHashes = new Set();
let pendingCount = 0;
let inFlight = 0;

function ensureDirs() {
  try {
    mkdirSync(PENDING, { recursive: true });
  } catch {}
}

/** 启动时统计一下现状 */
export function initCollector(existingFaceFiles = []) {
  ensureDirs();
  knownFiles = new Set(existingFaceFiles);
  // ⚠️ 还要记住**正式库里每张图的内容 hash**。
  //    原因：收集时按内容 hash 判断「这张是不是新的」，但正式库的文件名是 face_xxx
  //    （不是 hash），光比文件名认不出来。结果库里已经有的表情会被反复收进 _pending，
  //    而且被当成「新表情」—— 触发多余的回复（真实踩过：欢呼那张库里库外各一份）。
  knownHashes = new Set();
  for (const f of existingFaceFiles) {
    try {
      const buf = readFileSync(join(LIB, f));
      knownHashes.add(createHash('md5').update(buf).digest('hex').slice(0, 12));
    } catch {}
  }
  try {
    pendingCount = readFileSync(join(PENDING, '_list.json'), 'utf8')
      ? JSON.parse(readFileSync(join(PENDING, '_list.json'), 'utf8')).length
      : 0;
  } catch {
    pendingCount = 0;
  }
  log.info(`表情收集器就绪（待审核 ${pendingCount} 张，已知 ${knownHashes.size} 张内容 hash）`);
}

function readStats() {
  try {
    return JSON.parse(readFileSync(STATS, 'utf8'));
  } catch {
    return { images: {} };
  }
}

function writeStats(s) {
  try {
    writeFileSync(STATS, JSON.stringify(s, null, 2), 'utf8');
  } catch {}
}

/** 记一笔使用情况（不下载图片，只统计） */
export function tallyUsage(imageKey, userId) {
  if (!imageKey) return;
  const s = readStats();
  const k = String(imageKey);
  s.images[k] = s.images[k] ?? { count: 0, users: [] };
  s.images[k].count++;
  const u = String(userId);
  if (!s.images[k].users.includes(u)) s.images[k].users.push(u);
  if (s.images[k].users.length > 30) s.images[k].users = s.images[k].users.slice(-30);
  writeStats(s);
}

/** 排在前面的是群里用得最多的几张（供参考） */
export function topUsed(limit = 20) {
  const s = readStats();
  return Object.entries(s.images)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, limit)
    .map(([file, v]) => ({ file, count: v.count, users: v.users.length }));
}

/**
 * 记「某人在某个群用了某个表情」。
 *
 * ⚠️ 关键：**按「群 + 内容 hash」去重计次**，不是每条消息加一。
 *
 * 为什么（用户要求）：「表情包重复统计可以跨群统计，也就是说如果同一个人
 * 在不同群分别发一次相同表情包，也能判断为重复。」
 * 所以这里记的是**他在这几个群里都用过这张**：
 *   - 同一个群发 10 次 → 只算 1（那是同一批观众反复看，不代表这是他的常发图）
 *   - 两个群各发 1 次 → 算 2（说明他跨群都在用这张，更像「他的招牌表情」）
 *
 * 存储结构：byUser[userId][imageKey] = { count: 用到过几个群, groups: [群号...] }
 * 兼容旧数据：旧格式是纯数字，读到时按「1 个群」处理。
 */
/**
 * ⚠️ 「同一个人在同一个群里连发同一张表情」的计数（2026-09-13 加）。
 *
 * **这是和上面 `tallyPerUser` 完全不同的需求**，之前混成一个了：
 *
 * | 需求 | 判据 | 用途 |
 * | --- | --- | --- |
 * | 跨群统计 | 他**在几个群**用过这张 | 判断"这是他的招牌表情" |
 * | **同群连发** | 他**在一个群里连发了几次** | **斗图 —— 他连发同款，我跟着复读** |
 *
 * 用户反馈（2026-09-13）：「检测到三条相同表情就机器人复读这个表情」——
 * 但这个机制**一直没生效**，因为 `tallyPerUser` 的 count 是"用到过几个群"，
 * **同一个群发 10 次只算 1**，而 `echoMinTimes` 要 2 → **在单个群里永远触发不了**。
 *
 * 所以单独记一份**短窗口内的同群连发次数**：
 *   - 只算**同一个群**（换群不算）
 *   - 有时间窗口（默认 5 分钟，隔太久重新数）
 *   - 内存态即可（重启就忘也没关系 —— 那是"刚才在斗图"，不是长期数据）
 */
const recentSame = new Map(); // `${groupId}:${userId}` → { key, count, at }

function countSameInGroup(userId, imageKey, groupId = '', windowMs = 5 * 60 * 1000) {
  if (!groupId || !imageKey) return 0;
  const k = `${groupId}:${userId}`;
  const now = Date.now();
  const cur = recentSame.get(k);
  if (!cur || now - cur.at > windowMs) {
    recentSame.set(k, { key: String(imageKey), count: 1, at: now });
    return 1;
  }
  if (cur.key === String(imageKey)) {
    cur.count++;
    cur.at = now;
  } else {
    // 换了一张 → 重新数（斗图时他会一直发同一张才算"连发"）
    recentSame.set(k, { key: String(imageKey), count: 1, at: now });
  }
  return recentSame.get(k).count;
}

/** 给测试/排查看：某人此刻在群里连发了同一张几次 */
export function sameGroupCount(userId, imageKey, groupId) {
  const cur = recentSame.get(`${groupId}:${userId}`);
  if (!cur || cur.key !== String(imageKey)) return 0;
  return cur.count;
}

function tallyPerUser(userId, imageKey, groupId = '') {
  const s = readStats();
  s.byUser = s.byUser ?? {};
  const u = String(userId);
  s.byUser[u] = s.byUser[u] ?? {};
  const k = String(imageKey);
  const g = String(groupId || '');

  const cur = s.byUser[u][k];
  if (cur === undefined) {
    // 第一次见
    s.byUser[u][k] = { count: 1, groups: g ? [g] : [] };
  } else if (typeof cur === 'number') {
    // 旧格式（纯次数）→ 升级成新格式，保留原来的次数当初始值
    s.byUser[u][k] = { count: cur, groups: g ? [g] : [] };
  } else {
    const groups = Array.isArray(cur.groups) ? cur.groups : [];
    if (g && !groups.includes(g)) {
      groups.push(g);
      cur.count = groups.length; // 用到过的群数 = 重复度
      if (groups.length > 20) groups.splice(0, groups.length - 20);
    }
    cur.groups = groups;
    // 没群号信息（私聊）时至少别再涨，免得把私聊也算成「跨群」
    if (!g && !groups.length) cur.count = Math.max(cur.count ?? 1, 1);
    s.byUser[u][k] = cur;
  }
  writeStats(s);
}

/** 把 (可能是旧格式的) 记录统一成 {count, groups} */
function normEntry(v) {
  if (v === undefined || v === null) return { count: 0, groups: [] };
  if (typeof v === 'number') return { count: v, groups: [] };
  return { count: Number(v.count) || 0, groups: Array.isArray(v.groups) ? v.groups : [] };
}

/**
 * 某个人的「常用表情」按次数从多到少。
 * @returns {Array<{key:string, count:number}>}
 */
export function userStickers(userId) {
  const s = readStats();
  const m = s.byUser?.[String(userId)] ?? {};
  return Object.entries(m)
    .map(([key, v]) => {
      const e = normEntry(v);
      return { key, count: e.count, groups: e.groups };
    })
    .sort((a, b) => b.count - a.count);
}

/**
 * 这张是不是「他常用的」？
 *
 * 判定：他**在几个群里用过**这张 >= minTimes，且是他自己用得最多的那几张之一。
 * ⚠️ count 现在是「用到过的**群数**」，不是消息条数（跨群去重，用户要求）。
 *    所以默认门槛用 2 更合理 —— 在 2 个群都用过同一张，基本就是他的招牌表情了。
 *
 * @param {string} userId
 * @param {string} imageKey
 * @param {number} minTimes 至少用过几个群才算常用（默认 2）
 */
export function isTheirSticker(userId, imageKey, minTimes = 2) {
  const list = userStickers(userId);
  if (!list.length) return false;
  const hit = list.find((x) => x.key === String(imageKey));
  if (!hit || hit.count < minTimes) return false;
  // 还得排在前 3（免得用得杂的人随便一张都算）
  return list.slice(0, 3).some((x) => x.key === String(imageKey));
}

/**
 * 找一个表情的本地文件路径（用于原样发回去）。
 *
 * 找的顺序：正式库 → 待审核目录 → 常用表情缓存。
 * 找不到返回 null（那就只能从自己库里挑一张）。
 */
export function stickerFile(imageKey) {
  const k = String(imageKey ?? '');
  if (!k) return null;

  // ① 正式库：index.json 里登记的 face_*.xxx（按内容 hash 对不上，所以这里只试文件名）
  const guess = join(LIB, k);
  if (existsSync(guess)) return guess;

  // ② 待审核目录：收集时按内容 hash 命名，形如 c_<hash12>.<ext>
  try {
    const f = readdirSync(PENDING).find((n) => n.startsWith(`c_${k}`) || n === k);
    if (f) return join(PENDING, f);
  } catch {}

  // ③ 常用表情缓存。⚠️ saveCommon 存的是 `<key>.<ext>`（带扩展名），
  //    所以不能直接 join(COMMON, k) —— 得按前缀扫（踩过这个坑）。
  try {
    const f = readdirSync(COMMON).find((n) => n === k || n.startsWith(`${k}.`));
    if (f) return join(COMMON, f);
  } catch {}

  return null;
}

/**
 * 把某个表情存进「常用表情缓存」，这样之后能原样发回去。
 *
 * 为什么单独存：待审核目录会被管理界面清理，正式库只收进 index.json 的图，
 * 而群友常用的表情大部分不在库里 —— 想「原样发回去」就得自己留一份。
 */
export function saveCommon(imageKey, buf) {
  const k = String(imageKey ?? '');
  if (!k || !buf || !buf.length) return null;
  try {
    mkdirSync(COMMON, { recursive: true });
    const fmt = sniff(buf) ?? 'jpg';
    const p = join(COMMON, `${k}.${fmt}`);
    if (!existsSync(p)) writeFileSync(p, buf);
    return p;
  } catch (e) {
    log.debug(`保存常用表情失败：${e.message}`);
    return null;
  }
}

function sniff(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return 'webp';
  return null;
}

/**
 * 从一条消息里收集表情。
 *
 * @returns {Promise<{sawImage:boolean, isNew:boolean, newFiles:string[]}>}
 *   isNew 表示**见到了从没见过的表情** —— 上层用它决定要不要接这个梗。
 *   普通表情（库里已有的）不该每条都回，那样很机器。
 *
 * @param {object} event OneBot 消息事件
 * @param {(file:string)=>Promise<{file?:string,url?:string}>} getImage 取图函数
 */
export async function collectFromEvent(event, getImage) {
  const result = { sawImage: false, isNew: false, newFiles: [], echoSticker: null };

  if (!config.faces?.collect) return result;
  if (inFlight > 3) return result; // 别把队列压垮
  if (pendingCount >= MAX_PENDING) return result;

  const segs = Array.isArray(event.message) ? event.message : [];
  const imgs = segs.filter((s) => s.type === 'image');
  if (!imgs.length) return result;
  result.sawImage = true;

  // ⚠️ 只收**动画表情**，不收普通图片。
  //
  // QQ 的图片段带一个 `sub_type`：
  //   sub_type: 1 → 动画表情（群友发的表情包）  ★ 我们要的
  //   sub_type: 0 → 普通图片（截图、照片、报错图）✗ 不要
  // ⚠️ **哪个字段代表表情包，各协议端不一样** —— NapCat 用 `sub_type: 1`（下划线），
  //    LLBot 的 ob11 适配器用**驼峰** `subType: 1` → 判定统一走
  //    `message.js` 的 `isStickerSeg()`，**别在这里自己写字段名**
  //    （2026-09-20 换协议端时，这里差点漏改：LLBot 下永远判不出表情包）。
  //
  // 真实踩过：以前只靠「有没有配文字」判断，结果**单独发的截图**（没配字）
  // 被当表情包收进来了 —— 调试截图、聊天记录、启动器界面都进过库。
  const stickers = imgs.filter(isStickerSeg);
  if (!stickers.length) {
    log.debug('消息里有图片但不是动画表情（sub_type≠1），不收集');
    return result;
  }

  // 带文字的多半是「表情包 + 说明」，也可能是截图配字 —— 一律不收
  const text = segs
    .filter((s) => s.type === 'text')
    .map((s) => s.data.text)
    .join('')
    .trim();
  if (text) return result;

  for (const im of stickers) {
    const key = im.data?.file;
    if (!key) continue;

    tallyUsage(key, event.user_id);

    // ⚠️⚠️ **不要在这里因为图太大就 continue**（2026-09-13 修的真 bug）。
    //
    //    原来这里是：
    //        const size = Number(im.data?.file_size ?? 0);
    //        if (size && size > MAX_SIZE) continue;     // ← 400KB 以上的图直接丢
    //    而**计数代码在后面**，于是：
    //        · 一张 1.18MB 的表情 → 连"记一笔是谁用的"都没有
    //        · 更要命：**斗图计数也永远不涨** → 复读机制对它完全瞎
    //    用户反馈「刚刚我连发了三张，没起效」，日志里**一条判重记录都没有** ——
    //    就是被这一行挡掉的。
    //
    //    正确的分工：**「记数」和「进不进表情库」是两件事。**
    //    体积只该卡"能不能当素材入库"，不该卡"这是不是他常发的一张"。
    const size = Number(im.data?.file_size ?? 0);
    const tooBigForLib = size > MAX_SIZE;

    inFlight++;
    try {
      const r = await getImage(key);
      let buf = null;
      if (r?.file && existsSync(r.file)) {
        buf = readFileSync(r.file);
      } else if (r?.url) {
        const resp = await fetch(r.url, { signal: AbortSignal.timeout(20000) });
        if (resp.ok) buf = Buffer.from(await resp.arrayBuffer());
      }
      if (!buf || !buf.length) continue;

      // 就算太大（当不了「表情包素材」），也先记一笔是谁用的 ——
      // 「他常用哪张」和「这张适不适合进表情库」是两件事。
      const hash = createHash('md5').update(buf).digest('hex').slice(0, 12);
      tallyPerUser(event.user_id, hash, event.group_id);

      // ⚠️ **同群连发计数**（斗图用，2026-09-13 加）——
      //    和 tallyPerUser 是两件事（那个数的是"跨了几个群"）。
      const sameTimes = countSameInGroup(event.user_id, hash, event.group_id);

      // ⚠️ 复读**也要在这里判**，不能等到下面（大图会在下面被 continue 掉，
      //    那样斗图就永远不会响应 —— 而斗图用的表情往往就是大图/动图）。
      const sameNeed = Math.max(2, Number(config.faces?.echoSameTimes) || 3);
      if (config.faces?.echoCommon !== false && sameTimes >= sameNeed) {
        // ⚠️ **先存下来再判断能不能复读**（别写 `f || !tooBigForLib` 这种绕的写法 ——
        //    第一版就那么写，结果逻辑判反了，大图永远说"找不到文件"）。
        //    saveCommon 没有体积限制，大图/动图也能存（那正是斗图最常用的）。
        const saved = saveCommon(hash, buf);
        const f = saved ?? stickerFile(hash);
        if (f) {
          result.echoSticker = { key: hash, count: sameTimes, why: `他连发了 ${sameTimes} 次同一张` };
          log.info(
            `[斗图] 他连发 ${sameTimes} 次同一张表情 → 复读回去（${Math.round(buf.length / 1024)}KB）`,
          );
        } else {
          log.info(`[斗图] 他连发了 ${sameTimes} 次，但存不下这张图，跳过`);
        }
        continue;
      }

      if (tooBigForLib || buf.length > MAX_SIZE) {
        log.debug(`表情太大（${Math.round(buf.length / 1024)}KB > ${Math.round(MAX_SIZE / 1024)}KB），只记数不入库`);
        continue;
      }

      const fmt = sniff(buf);
      if (!fmt) continue;

      const name = `c_${hash}.${fmt}`;

      // 已经在正式库或待审核里 → 这个表情见过，不是新的
      // 三种「见过」：文件名在正式库、内容 hash 在正式库、待审核目录里已经有了
      const alreadyKnown =
        knownFiles.has(name) || knownHashes.has(hash) || existsSync(join(PENDING, name));
      log.info(
        `[判重] hash=${hash} name=${name} 文件名在库=${knownFiles.has(name)} ` +
          `hash在库=${knownHashes.has(hash)} pending有=${existsSync(join(PENDING, name))} ` +
          `=> ${alreadyKnown ? '见过的' : '★新的★'}`,
      );
      if (alreadyKnown) {
        // 见过的表情 → **他的招牌表情**（跨群统计那套）：在两个以上群用过这张。
        // 用他的表情回他，比从自己库里挑一张更像真人。
        //
        // ⚠️ 「同群连发就复读」（斗图）已经在**上面**判过了 —— 之所以要在上面，
        //    是因为大图会在到达这里之前被体积闸 continue 掉，
        //    而斗图用的往往正是大图/动图（2026-09-13 踩过）。
        if (config.faces?.echoCommon !== false && isTheirSticker(event.user_id, hash, config.faces?.echoMinTimes ?? 3)) {
          saveCommon(hash, buf);
          result.echoSticker = { key: hash, count: userStickers(event.user_id).find((x) => x.key === hash)?.count ?? 0 };
        }
        continue;
      }

      writeFileSync(join(PENDING, name), buf);

      const listPath = join(PENDING, '_list.json');
      let list = [];
      try {
        list = JSON.parse(readFileSync(listPath, 'utf8'));
      } catch {}
      list.push({
        file: name,
        at: new Date().toISOString(),
        from: String(event.user_id),
        fromName: event.sender?.card || event.sender?.nickname || '',
        group: String(event.group_id ?? ''),
        bytes: buf.length,
      });
      writeFileSync(listPath, JSON.stringify(list, null, 2), 'utf8');
      pendingCount = list.length;
      result.isNew = true;
      result.newFiles.push(name);
      log.info(`收集到新表情 ${name}（${(buf.length / 1024).toFixed(0)}KB，来自 ${event.sender?.nickname ?? event.user_id}）`);
    } catch (e) {
      log.debug(`收集表情失败: ${e.message}`);
    } finally {
      inFlight--;
    }
  }
  return result;
}

export function pendingInfo() {
  try {
    const list = JSON.parse(readFileSync(join(PENDING, '_list.json'), 'utf8'));
    return list;
  } catch {
    return [];
  }
}
