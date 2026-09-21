/**
 * QQ 空间发布。
 *
 * 用 NapCat 的扩展接口 send_qzone_msg：
 *   { content, images?, ugc_right?, target_uins? }
 *   ugc_right: 1 所有人可见 / 4 好友可见 / 16 部分好友 / 64 仅自己 / 128 部分不可见
 *
 * 发布是**不可撤销**的（发出去好友就看到了），所以这里做了三道闸门：
 *   ① 每天最多几条
 *   ② 两次之间最短间隔
 *   ③ 素材不够新、不够多就不发
 */
import { config, ROOT } from './config.js';
import { log } from './log.js';
import { facePath } from './faces.js';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import * as digest from './digest.js';

/** 今天已发几条、上次什么时候发的（持久化，见下面的 loadState/saveState） */
let today = { date: '', count: 0 };
let lastPostAt = 0;

const STATE_DIR = join(ROOT, 'state');
// ⚠️ 路径可以用环境变量覆盖 —— **给测试用**（2026-09-14 加）。
//
//    原来这里是写死的 `join(STATE_DIR, 'qzone-count.json')`，
//    于是测试想验"发完有没有落盘"就只能**备份+改写真实文件** ——
//    太危险了（跑崩了就丢掉真实的冷却/计数状态）。
//    和 `QQBOT_TIC_FILE` / `QQBOT_SPEND_FILE` 一个套路。
//
//    ⚠️ 注意这个文件是**模块加载时**决定路径的（`loadState()` 在模块尾部调用），
//       所以测试必须在 import 之前设好环境变量。
const STATE_FILE = process.env.QQBOT_QZONE_FILE
  ? join(ROOT, process.env.QQBOT_QZONE_FILE)
  : join(STATE_DIR, 'qzone-count.json');

/**
 * 跨天就重置计数。
 *
 * ⚠️ 这两个计数**必须落盘**：原来只在内存里，机器人一重启
 *    「今天已发几条」就归零、冷却也清零 → 同一天可能超发
 *    （本该最多 3 条，重启一次又能再发 3 条）。
 *    调试期间频繁重启会把这个坑放大（真实踩过）。
 */
function rollDay() {
  const d = new Date().toISOString().slice(0, 10);
  if (today.date !== d) {
    today = { date: d, count: 0 };
    saveState();
  }
}

function loadState() {
  try {
    if (!existsSync(STATE_FILE)) return;
    const j = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    const d = new Date().toISOString().slice(0, 10);
    today = j.date === d ? { date: d, count: Number(j.count) || 0 } : { date: d, count: 0 };
    lastPostAt = Number(j.lastPostAt) || 0;

    // ⚠️⚠️ **跨天时不许信那个陈旧的时间戳**（2026-09-14 加的第二道防线）。
    //
    //    配合上面那个"发布不落盘"的 bug：文件里的 `lastPostAt` 可能是
    //    **好几天前**的（实测见过停在 9/12 的）。那种值一到手就是
    //    `left < 0` → **冷却直接放行** → 一开机就可能发一条。
    //
    //    判据：`lastPostAt` 属于**今天**才采信。不是今天的（或者时间戳在未来 ——
    //    时钟被改过）就当作 `0`，也就是"**今天还没发过**"。
    //    这比"当成刚发过"更符合直觉：新的一天，额度本来就该是满的。
    if (lastPostAt) {
      const postDay = new Date(lastPostAt).toISOString().slice(0, 10);
      if (postDay !== d || lastPostAt > Date.now()) {
        log.debug(
          `空间计数：文件里的 lastPostAt 是 ${postDay} 的（不是今天），不采信 —— 当作今天还没发过`,
        );
        lastPostAt = 0;
      }
    }
  } catch (e) {
    log.debug(`读空间计数失败：${e.message}`);
  }
}

function saveState() {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ date: today.date, count: today.count, lastPostAt }, null, 2),
      'utf8',
    );
    renameSync(tmp, STATE_FILE);
  } catch (e) {
    log.warn(`保存空间计数失败：${e.message}`);
  }
}

loadState();

/**
 * 现在能不能发？返回 null 表示可以，否则返回不能发的原因。
 *
 * @param {boolean} [isAuto] 自动模式（额外要求素材够多、够新）
 * @param {{manual?:boolean}} [opts] `manual: true` = 人在界面上点「立刻发送说说」
 *   ⚠️ 2026-09-15 深夜修：**手动不受"冷却/间隔"限制**。
 *      那是个手动覆盖（按钮还有二次确认 + 每天上限兜着），而冷却/素材新旧
 *      本来就是给"自动发"用的密度闸门。
 *      bot.js 里那句注释写的就是「手动也要守**每天上限**」——实现漏了排除冷却，
 *      于是"她 12 分钟前刚发过一条"会把手动也挡住 ✗（真实踩过：
 *      <主人> 点了立刻发送，界面上只看到「失败： undefined」）。
 */
export function whyNot(isAuto = true, opts = {}) {
  const q = config.qzone ?? {};
  if (!q.enable) return 'QQ空间功能没开';

  rollDay();
  if (today.count >= (q.maxPerDay ?? 3)) {
    return `今天已经发了 ${today.count} 条（上限 ${q.maxPerDay ?? 3}）`;
  }

  // ⚠️ 冷却只挡"自动发"；手动是明确点出来的，不受它限制（见上面注释）
  if (!opts.manual) {
    const cool = q.cooldownMs ?? 4 * 3600 * 1000;
    const left = cool - (Date.now() - lastPostAt);
    if (lastPostAt && left > 0) {
      return `离上次发布还不到 ${Math.round(cool / 60000)} 分钟（还有 ${Math.round(left / 60000)} 分钟）`;
    }
  }

  // 自动模式额外要求：素材要够多、够新
  if (isAuto) {
    const s = digest.stats();
    if (s.count < (q.minMaterial ?? 8)) {
      return `素材只有 ${s.count} 条，不够 ${q.minMaterial ?? 8} 条`;
    }
    // ⚠️⚠️ 2026-09-13 修的单位 bug：`s.newest` 是**分钟**，
    //    而 `q.maxMaterialAgeMs` 是**毫秒**（配置里写 3600000）。
    //    原来的 `s.newest > q.maxMaterialAgeMs` 是「几分钟 > 3600000」——
    //    **永远为假**，也就是这个"素材太旧就别发"的检查**从来没生效过**。
    //    结果：素材放了一整天也会照发（可能发过时的内容）。
    //    现在把 `s.newest` 换成毫秒再比。
    const newestMs = s.newest * 60000;
    if (newestMs > (q.maxMaterialAgeMs ?? 60 * 60 * 1000)) {
      return `最近的素材已经是 ${s.newest} 分钟前的了，群里没动静`;
    }
  }

  return null;
}

/** 图片路径 → base64（和表情包发送用同一套逻辑） */
function imageRef(filePath) {
  const buf = readFileSync(filePath);
  const ext = extname(filePath).toLowerCase().replace('.', '');
  const mime =
    ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * 两条说说是不是在讲**同一件事**（粗糙但有效的判重）。
 *
 * ⚠️ 为什么要在代码里判：光靠提示词让它「别重复发同一个话题」不可靠 ——
 *    它换个措辞就发了（真实案例：同一个「轻薄本开整合包卡成 PPT」，
 *    换个角度连发三条）。
 *
 * 做法：先去掉标点/语气词，再看「长词组」的重合度。
 *    重合度高 → 判为同一话题。
 */
export function looksSameTopic(a, b) {
  const norm = (s) =>
    String(s ?? '')
      .replace(/[\s\p{P}\p{S}]/gu, '')
      .replace(/哈哈|草|呃|额|诶|emmm/gi, '');
  const A = norm(a);
  const B = norm(b);
  if (!A || !B) return false;

  // 取 2 字片段集合，算 Jaccard 相似度
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i + 2 <= s.length; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ga = grams(A);
  const gb = grams(B);
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  const union = ga.size + gb.size - inter;
  const jac = union ? inter / union : 0;
  // 阈值 0.3：实测同一个梗换措辞后大概落在 0.3~0.5，不同话题一般 < 0.15
  if (jac >= 0.3) return true;

  // 兜底：找**最长公共子串**，够长（≥8 字）就说明在讲同一件事，
  // 哪怕两句整体措辞差很多（实测「拿轻薄本硬开整合包」这种 9 字片段很常见）
  const longest = longestCommonSubstring(A, B);
  if (longest >= 8) return true;

  return false;
}

/** 最长公共子串长度（A、B 都是几十~几百字，O(n*m) 够用） */
function longestCommonSubstring(a, b) {
  if (!a || !b) return 0;
  let best = 0;
  // 用滚动数组省内存
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/**
 * 发一条说说。
 * @param {object} call 机器人的 call 方法
 * @param {{content:string, faceTag?:string, ugcRight?:number, force?:boolean}} post
 */
export async function publish(call, post) {
  const q = config.qzone ?? {};
  const content = String(post?.content ?? '').trim();
  if (!content) throw new Error('说说内容不能为空');
  if (content.length > (q.maxChars ?? 1000)) {
    throw new Error(`说说太长（${content.length} 字，上限 ${q.maxChars ?? 1000}）`);
  }

  // ⚠️ 硬性判重：跟最近发过的太像就不发（用户要求：「不要发一样的事情」）。
  //    force:true 可以绕过（界面上手动点「立刻发送」时用）。
  if (!post?.force) {
    const recent = digest.posts?.() ?? [];
    for (const p of recent) {
      if (looksSameTopic(content, p.content)) {
        throw new Error(`跟 ${Math.round((Date.now() - p.at) / 60000)} 分钟前发过的那条是同一个话题，跳过`);
      }
    }
  }

  const params = {
    content,
    ugc_right: Number(post.ugcRight ?? q.ugcRight ?? 1),
  };

  // 配图（可选）：从表情库挑**一张**。
  //
  // ⚠️ 一条说说**只配一张图**（用户明确要求：「还是一个一张」）。
  //    以前这里是 `params.images = [一张]`，参数本身支持数组，
  //    但产品上就是一张 —— 别因为接口能传多张就发多张。
  //
  //    「单调」的问题靠**换标签 / 换图**解决：
  //      · compose 会避开最近 3 条用过的标签
  //      · 同一个标签底下有多张备选图时，facePath 会随机挑一张
  const tags = (Array.isArray(post.faceTags) ? post.faceTags : post.faceTag ? [post.faceTag] : [])
    .map((t) => String(t).trim())
    .filter(Boolean);

  let usedTag = '';
  if (tags.length) {
    const tag = tags[0]; // 只取第一个
    const p = facePath(tag); // 同 tag 有多张时这里随机挑
    if (!p) {
      log.warn(`说说配图标签不存在：${tag}`);
    } else {
      try {
        params.images = [imageRef(p)];
        usedTag = tag;
      } catch (e) {
        log.warn(`说说配图失败（${tag}）：${e.message}`);
      }
    }
  }

  // ⚠️⚠️ 2026-09-20：**按协议端分派** —— 换成 LLBot 之后，原来的
  //    `send_qzone_msg`（NapCat 的扩展 action）在它那边**不存在**（查过它的实现清单），
  //    所以发说说必须换条路：
  //      · `napcat`  → 照旧走那个扩展 action（一直这样，不动）
  //      · 其它（现在是 `llonebot`）→ 拿 `get_cookies` 给的 h5.qzone.qq.com cookies，
  //        自己按 QZone 的网页接口发。**原因、风险和"只发文字"的限制都写在
  //        `src/qzone-http.js` 顶部** —— 动这里之前先看那段。
  //    ⚠️ 按协议端**直接分派**，而不是"先试 action、失败再回退"：
  //      后者每次都会先白失败一次 —— 既往日志里灌没用的错，又多送一次可疑信号。
  //    ⚠️ 哪天 LLBot 补上了 `send_qzone_msg`，把这里改回 action 就行（跟着能删掉那个模块）。
  const isNapcat = String(config.provider?.name || 'napcat').toLowerCase() === 'napcat';
  let r;
  if (isNapcat) {
    r = await call('send_qzone_msg', params);
  } else {
    const { publish: publishHttp } = await import('./qzone-http.js');
    const ck = await call('get_cookies', { domain: 'h5.qzone.qq.com' });
    const cookies = String(ck?.cookies ?? '').trim();
    if (!cookies) throw new Error('拿不到 h5.qzone.qq.com 的 cookies（get_cookies 没给东西）');
    const hr = await publishHttp({
      content,
      cookies,
      uin: String(config.botQQ ?? '').trim(),
      // ⚠️ 2026-09-20：**把配图一起带上** —— `params.images` 里是 `imageRef()` 的产物，
      //    也就是 **`data:image/…;base64,…` 这种 data URL**（⚠️ 不是文件路径！
      //    `qzone.js` 自己有 `imageRef()`，和 `bot.js` 那个返回 `base64://` 的不一样）。
      //    模块内部会先上传拿 `richval` 再发布；上传失败自动降级成纯文字。
      images: (Array.isArray(params.images) ? params.images : []).filter(Boolean),
    });
    if (!hr.ok) throw new Error(`空间 HTTP 发送失败：${hr.error}`);
    // ⚠️ 包成和 action 返回一样的形状，下面那段（`r.status` / `r.data.tid`）就不用改
    r = { status: 'ok', data: { tid: hr.tid ?? null } };
  }
  if (r && r.status === 'failed') {
    throw new Error(r.message ?? r.wording ?? '发送失败');
  }

  rollDay();
  today.count++;
  lastPostAt = Date.now();
  digest.markPosted(content, {
    tid: r?.data?.tid ?? null,
    type: post.type ?? 'auto',
    // 记下用了哪个标签 —— 下次 compose 会避开最近用过的，免得看着老是同一张图
    face: usedTag,
  });

  // ⚠️⚠️ **必须在这里落盘**（2026-09-14 修的真 bug）。
  //
  //    原来 `saveState()` 在整个文件里**只有一个调用点** —— `rollDay()` 里
  //    跨天那一次。而这条发布成功路径**只改内存**（`today.count++` /
  //    `lastPostAt = Date.now()`），**从来不写文件**。
  //
  //    后果（用户反馈「QQ空间发说说间隔的设置失效了」）：
  //      · 每发一条，`lastPostAt` 只在内存里更新，文件里永远是旧值
  //      · 一重启就从文件重新加载那个陈旧值 → 冷却等于被重置
  //      · 而 `whyNot()` 里是 `if (lastPostAt && left > 0)` ——
  //        文件缺失/为 0 时**冷却整段跳过**
  //    实测证据：`state/qzone-count.json` 里 `lastPostAt` 停在
  //    **9/12 07:39**（而 9/13、9/14 都发过说说）。
  //    被放大的场景：我调试时一天重启十几次 → 每重启一次冷却清零一次。
  //
  //    ⚠️ 隔壁 `digest.js` 的 `markPosted()` 里就有 `savePosts()`，
  //       还专门注释了「必须落盘，不然重启就忘了发过什么」—— 这里漏了。
  saveState();

  log.info(`已发说说（今天第 ${today.count} 条，tid=${r?.data?.tid ?? '?'}）：${content.slice(0, 60)}`);
  return r?.data ?? r;
}

/** 供管理界面展示的状态 */
export function status() {
  rollDay();
  const q = config.qzone ?? {};
  return {
    enable: q.enable !== false,
    todayCount: today.count,
    maxPerDay: q.maxPerDay ?? 3,
    lastPostAt: lastPostAt || null,
    canPost: whyNot(false) === null,
    blockReason: whyNot(false),
    material: digest.stats(),
    recent: digest.posts(),
  };
}

/** 测试用：重置限流状态 */
export function resetLimits() {
  today = { date: '', count: 0 };
  lastPostAt = 0;
}
