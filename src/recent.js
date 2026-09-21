/**
 * 群聊上下文缓存。
 *
 * 机器人只被 @ 或者主动接话时，如果只看到当前那一句，很容易答歪
 * （不知道前面在聊什么）。所以每个群维护一小段最近的消息，
 * 回答时一起给模型，让它知道来龙去脉。
 *
 * 只在内存里，重启就清空 —— 这是「当前话题上下文」，不是长期记忆。
 *
 * ⚠️⚠️ 2026-09-17 改：**现在会落盘了**（见下面「落盘」那一节）。
 *    用户原话：「**重启能不能保留上下文**」—— 他说的场景是：
 *    群里先聊过「@某某 能介绍一下嘛」，重启之后再问，她答"不知道"，
 *    因为那条聊天记录**连同被介绍人的名字**一起没了。
 *    机器人一天要重启好几次（改代码 / 看门狗补起 / NapCat 掉线），
 *    每重启一次群里就失忆一次，代价太大。
 *    ⚠️ 但仍然**不是长期记忆**：只存 12 小时以内、每群最多 300 条。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { config, ROOT, CONFIG_FILE } from './config.js';
import { log } from './log.js';
import * as persona from './persona.js';

/** group_id -> [{ name, userId, text, at, atMe, time }] */
const store = new Map();

// ─────────────────────────────────────────────────────────────
// 落盘（2026-09-17 加，见顶部注释）
// ─────────────────────────────────────────────────────────────

const STATE_DIR = join(ROOT, 'state');

/**
 * 状态文件落在哪 —— 沿用 `tic.js` / `meal.js` 那套三步优先：
 *   ① `QQBOT_RECENT_FILE` 显式指定（单测）
 *   ② 配置文件带 `test` → 隔离到 `state/__test-*.json`（跑套件自动生效）
 *   ③ 否则才是真实的 `state/recent.json`
 */
function recentStateFile() {
  const explicit = process.env.QQBOT_RECENT_FILE;
  if (explicit) return join(ROOT, explicit);
  const cfgName = basename(CONFIG_FILE ?? '');
  if (/test/i.test(cfgName)) {
    return join(STATE_DIR, `__test-${cfgName.replace(/\.ya?ml$/i, '')}-recent.json`);
  }
  return join(STATE_DIR, 'recent.json');
}

const RECENT_FILE = recentStateFile();

/** 测试/自检用：看它把状态落在哪了 */
export function path() {
  return RECENT_FILE;
}

let saveTimer = null;

function saveNow() {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const groups = {};
    for (const [k, list] of store) {
      if (list.length) groups[k] = list.slice(-BUFFER_MAX);
    }
    const tmp = `${RECENT_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ at: Date.now(), groups }), 'utf8');
    renameSync(tmp, RECENT_FILE);
  } catch (e) {
    log.debug(`上下文写盘失败：${e.message}`);
  }
}

/**
 * 节流写。
 *
 * ⚠️ 群消息很密，**每条都落盘会拖慢主流程** —— 所以合并成"最多每 3 秒写一次"。
 *    代价：进程被强杀时最多丢 3 秒的消息（这个代价可以接受）。
 */
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 3000);
  saveTimer.unref?.();
}

/**
 * 从磁盘恢复 —— **模块加载时**调（和 `tic.js` / `meal.js` 同一个做法）。
 * 不在这里恢复的话，重启后 `store` 仍是空的，落盘就白做了。
 */
export function reload() {
  try {
    if (!existsSync(RECENT_FILE)) return;
    const j = JSON.parse(readFileSync(RECENT_FILE, 'utf8'));
    const maxAge = bufferMaxAge();
    const now = Date.now();
    const next = new Map();
    for (const [k, list] of Object.entries(j?.groups ?? {})) {
      if (!Array.isArray(list)) continue;
      const keep = list
        .filter((x) => x && typeof x.text === 'string')
        // ⚠️ 只恢复 12 小时以内的 —— 再多就成"假长期记忆"了（那该由群记忆负责）
        .filter((x) => now - (Number(x.time) || 0) < maxAge)
        .slice(-BUFFER_MAX);
      if (keep.length) next.set(String(k), keep);
    }
    store.clear();
    for (const [k, v] of next) store.set(k, v);
    const n = [...next.values()].reduce((a, l) => a + l.length, 0);
    if (n) log.info(`[上下文] 重启恢复：${next.size} 个群 / ${n} 条（只恢复 12 小时内的）`);
  } catch (e) {
    // ⚠️⚠️ 2026-09-20 改 `debug` → **`warn`**：这条原来是 debug，而 `logLevel: info`
    //    ⇒ **它永远不会落盘** —— 于是"重启恢复没生效"这种事故**完全查不到原因**
    //    （实测：`state/recent.json` 里明明有 5 条、过滤条件也全满足，
    //      `reload()` 却恢复 0 条，而日志里一个字都没有。）
    log.warn(`[上下文] 读取失败（当作空的）：${e.message}`);
  }
}

// ⚠️⚠️ 2026-09-20 修（用户问「重启能不能不忘记上下文？」—— 一查发现**从来没生效过**）：
//
//    原来 `reload()` 就调在这一行（模块顶层靠前的位置），可是它内部用到了
//    `const BUFFER_MAX`（`slice(-BUFFER_MAX)`），而那个常量定义在**文件后半段**。
//    `const` **不提升**（TDZ）→ 每次都抛
//      `Cannot access 'BUFFER_MAX' before initialization`
//    → 被 catch 里的 `log.debug` 吞掉（而 `logLevel: info` ⇒ **永远不落盘**）
//    → 表现就是：`state/recent.json` 里明明有 5 条、过滤条件也全满足，
//      重启后她却说「没上下文，不明指向」，而日志里一个字都没有。
//
//    ⇒ 调用**挪到文件末尾**（那时所有常量都已初始化）。
//    ⚠️ 别再挪回上面 —— 这个坑没有报错、没有日志，只能靠"她怎么又失忆了"发现。

/**
 * 语气记录：`group_id -> { challenges, at }`
 *
 * ⚠️⚠️ 为什么需要（2026-09-14 用户反馈：「和人交流的时候有时会出现这种
 *   **不断反驳**的情况…我希望机器人对人**更温柔**」）：
 *
 *   他看到的（某群友在说自己买的 OPPO Watch）——
 *
 *     对方：oppo watch 约等于手机了          → 她：那么小的屏，**打字不累吗**
 *     对方：为了买这个表我上交了半年的零花钱  → 她：半年零花钱**就换这个**？
 *     对方：自带浏览器                       → 她：拿手表刷网页，**图什么呢**
 *
 *   **单看每一句都不算过分，连在一起就是在抬杠。**
 *   对方的体验是"我说什么你都要挑一句" —— 那已经不是傲娇了，是不友好。
 *
 * ⚠️ 光写进人设（`persona.md` 那条「别一直质疑对方」）**不够** ——
 *   模型看不到"我刚连着挑了两句"这件事，每一轮都是**孤立**地生成一句话，
 *   所以它不会觉得自己在抬杠。这里就是补上那个"连着"的视角：
 *   记着**最近连着质疑了几句**，到阈值就往提示词里塞一句"这句必须接住"。
 *
 * 判据（`looksLikeChallenge`）刻意**保守** —— 宁可漏，别乱扣：
 *   · 出现明确的挑刺词（就这 / 图什么 / 值吗 / 不累吗 …）
 *   · 或者句末是问句、而且问的是「你/这/那」（把人推到要解释的位置）
 * 而且**只在对方"不是在问你问题"时才累加** ——
 *   对方真在问你，你回一句反问是正常的，不该算抬杠。
 */
const tone = new Map();

/** 跳转"对方在分享"之后，隔多久算断开了 */
const TONE_WINDOW_MS = 10 * 60 * 1000;

/** 明确的挑刺词 */
const CHALLENGE_RE =
  /(就这|图什么|图啥|值吗|值得吗|值不值|不累吗|不觉得|有什么用|至于吗|至于嘛|何必|亏不亏|你确定|认真的吗|这也能|这也算|有必要|谁会)/;

/**
 * 这句回复是不是"质疑/挑刺"口气？
 * 只看文本，纯启发式 —— 用来发现"连着抬杠"，不拿它当结论。
 */
export function looksLikeChallenge(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (CHALLENGE_RE.test(t)) return true;
  // 句末是问句，而且问的是「你/这/那」→ 也是在让人辩解
  const isQ = /[？?]\s*$/.test(t) || /[吗呢]\s*$/.test(t);
  if (!isQ) return false;
  return /(你|这|那|不)/.test(t.slice(-10));
}

/** 对方这句是在**问问题**吗？（在问就不算他"在分享"，反问不记仇） */
export function isQuestionLike(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (/[？?]\s*$/.test(t) || /[吗嘛呢]\s*$/.test(t)) return true;
  return /(怎么|如何|为什么|为啥|多少|哪里|哪个|能不能|可不可以|是不是|有没有)/.test(t);
}

/** 取这个群最后一条"人"说的（跳过机器人自己） */
function lastHuman(key) {
  const list = store.get(key) ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].self) continue;
    return list[i];
  }
  return null;
}

/**
 * 更新"连着质疑"的计数。**必须在 push 自己这条之前调用** ——
 * 那时候 `lastHuman()` 才是"刚被回答的那条"。
 */
function noteTone(key, selfText) {
  const prev = lastHuman(key);
  const rec = tone.get(key) ?? { challenges: 0, at: 0 };
  // ⚠️ `!rec.at` 这条不能少 —— 第一次根本没有记录（at 是 0），
  //    光比时间差会算成"隔太久了"，于是**第一句永远计不上**（差一位）。
  const fresh = !rec.at || Date.now() - Number(rec.at) < TONE_WINDOW_MS;

  if (!fresh) {
    rec.challenges = 0;
  } else if (prev && isQuestionLike(prev.text)) {
    // 对方在问你 → 回一句反问是正常的，清零
    rec.challenges = 0;
  } else if (looksLikeChallenge(selfText)) {
    rec.challenges = Number(rec.challenges || 0) + 1;
  } else {
    // 这句接住了 → 断链
    rec.challenges = 0;
  }
  rec.at = Date.now();
  tone.set(key, rec);
}

/**
 * 机器人在这个群**连着质疑了几句**？0 = 没有。
 * 给 `buildSystemPrompt` 用来决定要不要塞"这句接住"的提示。
 */
export function challengeStreak(event) {
  if (!event || event.message_type !== 'group') return 0;
  const rec = tone.get(String(event.group_id));
  if (!rec) return 0;
  if (Date.now() - Number(rec.at || 0) > TONE_WINDOW_MS) return 0;
  return Number(rec.challenges) || 0;
}

/** ⚠️ 测试专用：直接读/清语气记录 */
export function __toneForTest() {
  return tone;
}

/** 一条消息太长就截断，免得把上下文撑爆 */
const MAX_MSG_CHARS = 200;

/**
 * 缓冲区最多留几条（**内部上限**，不是给模型的窗口）。
 *
 * ⚠️⚠️ 2026-09-13 用户反馈后从"按时间裁"改成"按条数留"：
 *
 *   真实踩的（截图）：群里先说「心上江渡轮站那个入口太像足球门了」，
 *   隔了几分钟 <主人> 问「准备改成什么球门」，机器人答「……什么球门，你要改哪个」
 *   —— **它前面那条足球门根本没看到**。
 *
 *   根因：`remember()` 存的时候就**同时按时间裁**（`maxAgeMs` 默认 30 分钟），
 *   那条消息被**物理删掉**了，后面无论怎么取都取不到。
 *
 *   用户的要求（原话）：「看上文不仅要看最近时间的消息，
 *   **只要是多少条范围内都得看进来**」——
 *   也就是**按条数**给窗口，别让"几分钟前"变成看不看得到的界线。
 *
 *   所以现在分工：
 *     · 缓冲区：**按条数**留（下面这个 `BUFFER_MAX`），时间只做很宽的上限兜底
 *     · 给模型的窗口：`contextText()` 取**最后 maxMessages 条**（纯按条数）
 */
const BUFFER_MAX = 300;

/**
 * 缓冲区的时间上限 —— 只是兜底，别让它当窗口用。
 * ⚠️ 原来这里直接用 `config.context.maxAgeMs`（默认 30 分钟），
 *    那才是把「足球门」删掉的元凶。现在取一个**很宽**的值（默认 12 小时），
 *    真正决定"看多少"的是条数。
 */
function bufferMaxAge() {
  const wide = Number(config.context?.bufferMaxAgeMs);
  if (Number.isFinite(wide) && wide > 0) return wide;
  return 12 * 60 * 60 * 1000;
}

/**
 * 记一条群消息。
 * @param {object} event OneBot 消息事件
 * @param {{text:string, isAtMe:boolean}} parsed
 */
export function remember(event, parsed = {}) {
  if (!config.context?.enable) return;
  if (event.message_type !== 'group') return;
  // ⚠️ 这里原来还有一道 `limit <= 0` 的闸门 —— `limit` 是**给模型的窗口条数**，
  //    不是缓冲区大小。用它当"要不要记"的开关是错位的（窗口调小就不记上文了）。
  //    缓冲区只受 `context.enable` 控制。

  const key = String(event.group_id);
  const list = store.get(key) ?? [];

  let text = String(parsed.text ?? '').slice(0, MAX_MSG_CHARS);
  if (!text && parsed.isAtMe) text = '（@了机器人）';
  // 纯图片消息也记一笔，让模型知道刚才有人发过图
  if (!text) text = '（发了一张图）';

  // ⚠️⚠️ 2026-09-20 加（用户抓到的真实案例：**她把「白天」记到错的人头上**）：
  //
  //    上下文里引用只显示成 `[引用#-795241984]` —— 模型**看不到被引的是谁、说了什么**，
  //    于是几轮之后就把话归错人。真实链条（群 200000006）：
  //      羽衫: 可是我这边是白天诶          ← 「白天」是**羽衫**说的
  //      …（她正确接了两轮）…
  //      26无线电讯号: 睡觉了 / 她说「白天还睡觉啊」
  //      26无线电讯号: [引用#-795241984] 你跑美国了是吧   ← 引用的其实是**她自己**那句话
  //      她: 谁跑美国了（**是你说白天**，我才问的 ✗      ← 归错人了
  //
  //    ⚠️ 用户还提了「为什么不能把编号换成群昵称加编号」——
  //       我们的做法**比那个更好**：能查到就显示「**引用谁说的 + 原文**」。
  //    ⚠️⚠️ 2026-09-20 再改：**优先用调用方查好的**（`bot.fetchQuoted()` 走 OneBot 的
  //       `get_msg`，连**不在本地缓冲里**的消息也能拿到"谁说的 + 原文"）；
  //       查不到才退回本地缓冲查找。显示见 `contextText()`。
  let replyTo = null;
  {
    const segs0 = Array.isArray(event.message) ? event.message : [];
    const rid = String(segs0.find((s) => s && s.type === 'reply')?.data?.id ?? '').trim();
    const given = parsed.replyTo;
    if (given && (given.name || given.text)) {
      replyTo = {
        id: rid || String(given.id ?? ''),
        self: given.self === true || given.fromBot === true,
        name: String(given.name ?? ''),
        text: String(given.text ?? '').slice(0, 60),
      };
    } else if (rid) {
      const hit = list.find((m) => m.messageId && String(m.messageId) === rid);
      replyTo = hit
        ? {
            id: rid,
            self: hit.self === true,
            name: String(hit.name ?? ''),
            text: String(hit.text ?? '').slice(0, 60),
          }
        : { id: rid }; // 不在缓冲里 → 只留 id（显示成编号，聊胜于无）
    }
  }

  list.push({
    name: event.sender?.card || event.sender?.nickname || String(event.user_id),
    userId: String(event.user_id),
    // ⚠️ 记 message_id：剔除「当前这条」时靠它，别靠文本比对（见 contextText 的注释）
    messageId: event.message_id !== undefined ? String(event.message_id) : '',
    text,
    replyTo,
    atMe: parsed.isAtMe === true,
    time: Date.now(),
    // ⚠️⚠️ 把图片的 `file` 也存下来（2026-09-13 加）。
    //
    //    用户反馈：群里 大豆 发了张「MRT 足铁」的图，陌拜说「神了」，
    //    机器人回「神什么了，发我看」—— **它看不到那张图**。
    //    后来又有人说「神在原后面」（那是接着那张图玩的语序梗），
    //    它还是「这什么暗号，我又不懂了」。
    //
    //    根因：`recent` 只存文本，图片消息被存成「（发了一张图）」——
    //    **`file` 丢了**，所以后面无论谁提那张图，它都没有图可看。
    //
    //    现在把 `file` 存下来，`handle` 里发现「当前消息在指代前面的东西」时
    //    可以把这几张图**补做识别**（见 `recentImages` + bot.js 里那段）。
    imageFiles: Array.isArray(parsed.imageFiles) ? parsed.imageFiles.slice(0, 4) : [],
  });

  // ⚠️ 缓冲区**按条数**留（用户 2026-09-13：「只要是多少条范围内都得看进来」）。
  //    时间上限只做很宽兜底 —— 原来这里是 `config.context.maxAgeMs`（默认 30 分钟），
  //    那条「足球门」就是被它删掉的。
  const maxAge = bufferMaxAge();
  const now = Date.now();
  const trimmed = list.filter((m) => now - m.time < maxAge).slice(-BUFFER_MAX);
  store.set(key, trimmed);
  scheduleSave();
}

/**
 * 取「最近这几条消息里附带的图片 file」—— 给「当前消息在指代前面那张图」用。
 *
 * ⚠️ 场景（2026-09-13，用户反馈）：
 *    大豆发了张图 → 陌拜说「神了」 → 机器人回「神什么了，发我看」
 *    → 有人接着说「神在原后面」（接着那张图玩的梗）
 *    **机器人看不到图，所以完全接不上。**
 *    这个函数就是让它在这种时候能把那几张图**补做一次识别**。
 *
 * @param {string} groupId
 * @param {{excludeIds?: string[], maxAgeMs?: number, limit?: number}} [opts]
 * @returns {Array<{file:string, name:string}>}
 */
export function recentImages(groupId, opts = {}) {
  const list = store.get(String(groupId)) ?? [];
  const now = Date.now();
  const maxAge = opts.maxAgeMs ?? 5 * 60 * 1000;
  const exclude = (opts.excludeIds ?? []).map(String);
  const out = [];
  // 从新到旧，最近的优先
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (now - m.time > maxAge) continue;
    if (m.messageId && exclude.includes(m.messageId)) continue;
    for (const f of m.imageFiles ?? []) {
      if (f && !out.some((x) => x.file === f)) out.push({ file: f, name: m.name });
    }
    if (out.length >= (opts.limit ?? 2)) break;
  }
  return out.slice(0, opts.limit ?? 2);
}

/**
 * 记一条**机器人自己**发的消息。
 *
 * ⚠️ 这个非常关键：不记自己的发言，模型就不知道上一句自己说了什么，
 *    于是群友说「你刚才说的那句」时它会一脸茫然，甚至把群友的话当成自己的
 *    （真实踩过：它去复述对方的消息，然后反问「你是想说这句吗」）。
 */
/**
 * 把**她自己发出去的话**记进这个群的上下文。
 *
 * @param {object} event 借一个群消息的形状（只用 group_id）
 * @param {string} text 她说的话（不带 @ 段那种）
 * @param {string} [messageId] 这条消息的 `message_id`
 *   ⚠️ 2026-09-15 晚加：**群友引用她**的时候要靠它认出"被引的是她自己发的"
 *      （见 `isOwnMessage` / `bot.isQuoteOfMe`）。能拿到就传 —— 拿不到也只是
 *      少一条兜底（主力判据是 `bot.myMsgIds`）。
 */
/**
 * 回填「这条消息引用的是谁、说了什么」—— 由 `bot.js` 查完 `get_msg` 之后调用。
 *
 * ⚠️⚠️ 2026-09-20 加这个函数的原因（**是我自己引入的回归**）：
 *    我一开始是在 `onRaw` 里先 `await fetchQuoted(payload)` **再** `remember` ——
 *    结果**"记上下文"被一次网络调用拖慢**，而 `handle` 是异步的：
 *    用户连发两条时，第二条刚发出、`remember` 还没跑完，**她就已经在读上下文生成回复了**
 *    ⇒ 表现就是「**没读到上文**」。真实案例（群 200000001，01:06）：
 *      <主人> 发「对」→ 紧接着「f3加f4也可以调」；她只看到前者，
 *      回成「对什么对，都困得只会说单字了（」—— 完全没接 MC 那个话题。
 *    ⇒ 所以改成：**先立刻 `remember`（不等查询）**，查到了再用这个函数**回填**。
 *    ⚠️ 代价：本条消息**自己**的引用信息会晚几十毫秒；但"**别人引用她**"的那些
 *      早在别人发消息时就存好了，回答时用不到本条自己的引用 —— 不影响。
 */
export function fillReplyInfo(groupId, messageId, info) {
  if (!info) return false;
  const list = store.get(String(groupId));
  if (!list?.length) return false;
  const id = String(messageId ?? '');
  if (!id) return false;
  const hit = list.find((m) => m.messageId && String(m.messageId) === id);
  if (!hit) return false;
  hit.replyTo = {
    id: hit.replyTo?.id || '',
    self: info.self === true,
    name: String(info.name ?? ''),
    text: String(info.text ?? '').slice(0, 60),
  };
  scheduleSave();
  return true;
}

export function rememberBot(event, text, messageId = '') {
  if (!config.context?.enable) return;
  if (event.message_type !== 'group') return;
  // ⚠️ 这里原来还有一道 `limit <= 0` 的闸门 —— 那个 `limit` 是**给模型的窗口**，
  //    不是缓冲区大小。用它当"要不要记"的开关是错位的（窗口设小一点就不记了）。
  //    缓冲区该不该记，只看 context.enable。

  const key = String(event.group_id);
  const list = store.get(key) ?? [];

  const body = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_MSG_CHARS);
  if (!body) return; // 纯表情包不占位，免得刷屏

  // ⚠️ 必须在 push 自己这条**之前**更新语气计数 ——
  //    noteTone 里的 lastHuman() 要拿"刚被回答的那条"。
  noteTone(key, body);

  // ⚠️ 昵称跟着自称走（2026-09-13 用户：「祥子的话遇到没看过 MyGO 的
  //    很容易误认为骆驼祥子」）—— 自己在上下文里显示成「你（Saki）」，
  //    否则模型会照抄那个名字当自称。
  list.push({
    name: `你（${persona.selfName()}）`,
    userId: '__self__',
    text: body,
    atMe: false,
    self: true,
    time: Date.now(),
    // ⚠️ 记下 message_id：群友**引用她**时要靠它认出来（见 `isOwnMessage`）
    messageId: String(messageId ?? '').trim(),
  });

  // 同上：按条数留，时间只做宽兜底
  const maxAge = bufferMaxAge();
  const now = Date.now();
  store.set(key, list.filter((m) => now - m.time < maxAge).slice(-BUFFER_MAX));
  scheduleSave();
}

/**
 * 拼成给模型看的上下文文本。
 *
 * ⚠️⚠️ 窗口是**按条数**的，**不按时间**（2026-09-13 用户要求）。
 *
 *    用户原话：「看上文不仅要看最近时间的消息，**只要是多少条范围内都得看进来**」。
 *
 *    起因（截图）：群里先说「心上江渡轮站那个入口太像足球门了」，
 *    几分钟后 <主人> 问「准备改成什么球门」，机器人答「……什么球门，你要改哪个」。
 *    —— 前一条**不在它看到的上下文里**。
 *
 *    现在取**最后 `context.maxMessages` 条**（默认 15），
 *    一条消息只要还在这 15 条之内，**不管它是几秒前还是半小时前**都会给模型。
 *
 * @param {string} groupId
 * @param {string} excludeText 当前这条消息的内容（避免重复出现）
 * @param {string[]} [excludeIds]
 * @param {{limit?:number}} [opts]
 */
export function contextText(groupId, excludeText = '', excludeIds = [], opts = {}) {
  if (!config.context?.enable) return '';
  const stored = store.get(String(groupId)) ?? [];
  if (!stored.length) return '';

  // ⚠️ **按条数**取窗口（用户要求）。原来直接把整个 buffer 都塞进去，
  //    而 buffer 是被时间裁的 —— 等于窗口由时间决定。
  const want = Number.isFinite(Number(opts.limit))
    ? Math.max(1, Number(opts.limit))
    : Math.max(1, Number(config.context?.maxMessages ?? 15));
  const list = stored.slice(-want);

  const now = Date.now();
  const lines = [];
  for (const m of list) {
    // ⚠️ 跳过「当前这条」。**优先按 message_id 排除** —— 文本比对太脆弱：
    //    @机器人的剥离方式、tidy 的空格处理、连发消息合并，
    //    都会让两边的文本微妙不等，结果当前这句话又出现在上下文里，
    //    模型把它当成「前面有人说过」，于是答非所问（真实踩过）。
    //    文本比对只留作兜底。
    if (m.messageId && excludeIds.length && excludeIds.map(String).includes(String(m.messageId))) {
      continue;
    }
    if (excludeText && m.text === excludeText.slice(0, MAX_MSG_CHARS)) continue;
    const ago = Math.round((now - m.time) / 1000);
    const when = ago < 60 ? `${ago}秒前` : `${Math.round(ago / 60)}分钟前`;
    // 自己发的要**显式标出来**，否则模型分不清哪句是自己说的
    const who = m.self ? '【你自己说的】' : '';
    const at = m.atMe ? '[@了你] ' : '';
    // ⚠️ 带上 QQ 号。用户反馈「多人高密度发言时还是认错人」——
    //    只给昵称的话，一堆人同时说话时很容易把事对错人。
    //    自己那行不用带（已经标了【你自己说的】）。
    const id = m.self || !m.userId ? '' : `(${m.userId})`;
    // ⚠️⚠️ 2026-09-19 修（用户报：她在群里字面发出 `[图片]` / `[表情包]`）：
    //    **根因是她照着上下文学**——别人发的图在我们这边是占位符 `[图片]`，
    //    她看到"是bro的大豆：[图片]"，就以为**方括号是能用的标记**，
    //    自己回复时也写一个 → 而那不是表情库里的名字 → 解析不出来 → 字面发进群 ✗
    //    （用户指出的关键：那几张图**不是同一张**、根本没触发斗图复读，
    //      所以这纯粹是"她模仿了占位符"，不是复读功能的问题。）
    //    ⇒ 给模型看的文本里**别用方括号**，直接说人话：`（发了张图）`。
    //      这样她学不到"方括号=标记"这个错概念；真要发表情，写法由表情清单单独教。
    // ⚠️⚠️ 2026-09-20 加：把 `[引用#id]` 换成**看得懂**的（被引内容在 remember() 里就存好了）。
    //    案例见 `remember()` 里那段注释：别人引用**她自己**说的话，而她的上下文里只有
    //    一个编号 ⇒ 看不到引的是谁 ⇒ 把「白天」归错了人。
    let body = String(m.text ?? '');
    if (m.replyTo?.id) {
      const who = m.replyTo.self
        ? '【引用你自己说的】'
        : m.replyTo.name
          ? `【引用${m.replyTo.name}说的】`
          : '【引用】';
      const quote = m.replyTo.text ? `：${m.replyTo.text}` : `（#${m.replyTo.id}）`;
      body = `${who}${quote} ${body.replace(/\[引用#[^\]]*\]/g, '').trim()}`.trim();
    }
    // ⚠️ 方括号占位符一律换成人话（她照着上下文学方括号那个坑，见下面的长注释）
    body = body.replace(
      /\[(图片|照片|表情包|动画表情|动图|贴纸|gif|sticker|img|image)\]/gi,
      '（发了张图）',
    );
    lines.push(`${who}${m.name}${id}（${when}）${at}${body}`);
  }
  if (!lines.length) return '';
  return lines.join('\n');
}

/**
 * 取**上一条人类（非机器人）消息**。
 *
 * ⚠️ 为什么需要（2026-09-13 真实踩过）：
 *   用户分两条发 ——
 *     ①「现在服务器也可以导入地图画了，按 i 导入，按 p 放置」   ← 要记的内容
 *     ②「@机器人 记一下」                                      ← 只是触发词
 *   教学逻辑**只拿当前这条**去抽知识，于是「记一下」里没有可记的内容 →
 *   机器人回「这话里我没找出能记下来的信息。你直接说内容就行」——
 *   **明明内容就在上一句**。
 *
 * 所以教不出内容时，回退到上一条人类消息试试。
 *
 * @param {string|number} groupId
 * @param {{excludeIds?:string[], maxChars?:number}} [opts]
 * @returns {{name:string, text:string, userId:string, atMe:boolean, time:number, messageId:string}|null}
 */
export function lastHumanMessage(groupId, opts = {}) {
  const list = store.get(String(groupId)) ?? [];
  if (!list.length) return null;
  const exclude = (opts.excludeIds ?? []).map(String);
  const maxChars = opts.maxChars ?? MAX_MSG_CHARS;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.self) continue; // 跳过自己说的
    if (m.messageId && exclude.includes(String(m.messageId))) continue;
    const text = String(m.text ?? '').trim();
    // ⚠️⚠️ 2026-09-18 修（用户截图：他**只 @ 了她一下**，她回「嗯？」而没接上一条）：
    //    「只 @ 她、一个字没打」的消息在缓冲里存成的是**占位符**「（@了机器人）」——
    //    它**不是空串**（6 个字 ≥ 4），于是把**真正有内容的那条挡住了**
    //    （他上一条是「起来看日出」，追接逻辑却拿到「（@了机器人）」→ 她当然只能回「嗯？」）✗
    //    修法：**去掉括号里的东西就什么都不剩**的，一律当成"没内容"跳过
    //    （「（图片）」「（表情）」这类也一并跳过 —— 它们同样不是可以接的话）。
    if (!text.replace(/[（(][^）)]*[）)]/g, '').trim()) continue;
    // 太短的（「对」「嗯」）不像知识内容
    if (text.length < 4) continue;
    if (text.length > maxChars * 2) continue;
    return {
      name: m.name ?? '',
      text,
      userId: String(m.userId ?? ''),
      atMe: !!m.atMe,
      // ⚠️ 2026-09-15 晚加：剧情那边要判断"她接的这句话是不是**这一段之后**才来的"
      //    （不是的话说明早就消化过了，别再塞回去）—— 所以时间戳和 message_id 都得带出来
      time: Number(m.time ?? 0),
      messageId: String(m.messageId ?? ''),
    };
  }
  return null;
}

/** 清掉某个群的上下文（比如被要求「清空对话」时） */
export function clear(groupId) {  store.delete(String(groupId));  tone.delete(String(groupId));
}

/**
 * 这个群最近见过这条消息吗（按 `message_id`）。
 *
 * ⚠️ 用途（2026-09-15）：**掉线补看要去重**。
 *    重连之后会去拉群历史，把"掉线期间 @ 她的"补回来 ——
 *    但历史里也包含**这条连接已经处理过的**消息，
 *    不按 id 去重就会**同一个问题答两遍**。
 *    （另一道保险是 `time < listenStartedAt`，见 `bot.catchUpMissed()`。）
 */
export function hasMessageId(groupId, id) {
  const want = String(id ?? '');
  if (!want) return false;
  const list = store.get(String(groupId)) ?? [];
  return list.some((m) => m.messageId && String(m.messageId) === want);
}

/**
 * 这条 `message_id` 是不是**她自己发的**（缓冲里 `self: true` 那些）。
 *
 * ⚠️ 用途（2026-09-15 晚）：群友**引用她**的消息时要知道被引的是不是她 ——
 *    「引用但是没有 @ 机器人，应该也要直接回话」（<主人> 原话）。
 *    光靠 `bot.myMsgIds` 不够：那份只在内存、重启就空；
 *    这里再从上下文缓冲里兜一层（她自己发的都会进缓冲，见 `rememberBot`）。
 */
export function isOwnMessage(groupId, messageId) {
  const want = String(messageId ?? '').trim();
  if (!want) return false;
  const list = store.get(String(groupId)) ?? [];
  return list.some((m) => m.self && m.messageId && String(m.messageId) === want);
}

/**
 * 某条消息**后面还有几条**别人的消息（＝这条被"刷下去"了没有）。
 *
 * ⚠️ 2026-09-15 晚加（<主人> 截图：「有个 bug，**相邻消息引用了**」）：
 *    光看"她上次说话隔了几条"会误判 —— 她可能 7 分钟没说话，但**她要回的那条
 *    就是群里最新的一条**，这时候引用纯属多余（她的话紧跟着那句话，谁都看得出来）。
 *    所以"该不该引用"还要看：**她要回的那条后面有没有人再说话**。
 *
 * @returns {number} 后面的条数；`0` = 它就是最新的（＝相邻）；
 *   **-1 = 这条不在缓冲里**（不知道，调用方别当成"相邻"，也别当成"被刷下去了"）
 */
export function messagesAfterMe(groupId, messageId) {
  const want = String(messageId ?? '').trim();
  if (!want) return -1;
  const list = store.get(String(groupId)) ?? [];
  const i = list.findIndex((m) => m.messageId && String(m.messageId) === want);
  if (i < 0) return -1;
  return list.length - 1 - i;
}

/**
 * 她上一次说话之后，群里又来了**几条别人的消息**。
 *
 * ⚠️⚠️ 用途（2026-09-15 晚 <主人> 要求）：
 *    「如果检测到机器人自己发出的话距离要回复的那条消息已经**间隔 4 条以上**，
 *      就要**引用那条正在回复的消息**，这就是引用最有用的时候」。
 *    间隔大了，群里的人根本看不出她在答哪一句 —— 这时候引用才是真的有用。
 *
 * @returns {number} 别人的消息条数（**含当前这条**）；
 *   ⚠️ **缓冲里她压根没说过话 → 返回 -1（"不知道"）**，调用方**别把它当"间隔很大"**：
 *      用户的原话是「**检测到**间隔 4 条以上」—— 没检测出来就不该触发。
 *      不这么写的话，新群 / 刚重启（缓冲是空的）会变成"每条回复都引用"，
 *      又回到"满屏引用框像工单系统"那个老毛病（`e2e` 套件就是盯着这条的）。
 */
export function messagesSinceBotLast(groupId) {
  const list = store.get(String(groupId)) ?? [];
  let n = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].self) return n; // 数到她自己那条为止
    n++;
  }
  return -1; // 不知道（她在这个窗口里没说过话）
}

/**
 * 这个群**最后一条消息**是什么时候（毫秒时间戳）；没有记录返回 0。
 *
 * ⚠️ 用途（2026-09-13 用户要求）：工资余额抱怨要「**没人说话时**」才发 ——
 *    群里正聊得热闹的时候插一句"我工资没了"很突兀，
 *    而且会打断当前话题。所以在冷场时自言自语才自然。
 *
 * ⚠️ 注意这只反映**内存里最近 15 条**（`context.maxMessages`）的时间范围 ——
 *    最后一条就是最新的，够用。
 */
export function lastMessageAt(groupId) {
  const list = store.get(String(groupId)) ?? [];
  if (!list.length) return 0;
  return Number(list[list.length - 1].time) || 0;
}

export function clearAll() {
  store.clear();
  tone.clear();
}

/**
 * ⚠️ **测试专用**：直接拿到内部 store（或者把某条消息的时间改老）。
 *
 * 为什么需要：要验"25 分钟前的消息还在不在"这种逻辑，
 * 总不能真等 25 分钟 —— 必须能把时间戳往回拨。
 * 别的模块也有类似的口子（`spend.reload` / `balance.setLastForPreview`）。
 *
 * 生产代码**不要用它**。
 */
export function __storeForTest() {
  return store;
}

export function stats() {
  let total = 0;
  for (const list of store.values()) total += list.length;
  return { groups: store.size, messages: total };
}

// ⚠️⚠️ **恢复必须放在文件最后** —— 见上面那段「2026-09-20 修」的注释：
//    `reload()` 内部用 `const BUFFER_MAX`，而它定义在上面（253 行附近）。
//    放在它前面会抛 TDZ（`Cannot access 'BUFFER_MAX' before initialization`），
//    而且**没有任何日志**，只会表现为"重启又失忆了"。
reload();
