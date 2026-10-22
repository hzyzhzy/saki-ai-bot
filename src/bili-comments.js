/**
 * B站**评论回复**（2026-10-22 加，同日按用户要求一简再简）
 *
 * ## 用户要求（按时间，越靠后越准）
 *   ① 「要能**回复在 b 站对她的回复消息**」
 *   ② 「**不要回复几天之前的评论**」⇒ 只看 `sinceHours`（写死 48）
 *   ③ 「**可以不每次回复评论都起一遍吗…一直运行**」⇒ 常驻浏览器
 *   ④ 「**取消每天最少和最多，有多少就回多少，间隔也删掉，有一次最多回几条和多久看一次就够了**」
 *      ⇒ 现在**只有三个可调项**：开关 / 多久看一次 / 一次最多回几条 ✓
 *
 * ## 架构
 *   · `tools/bili-browser-serve.mjs` = **常驻 Chrome**（起一次，之后每次 check 只要 2.3 秒）
 *   · **这个文件** = 调度 + 过滤 + 让模型写回复（在机器人进程里，有 llm）
 *   · 回复动作仍是**在浏览器里真实点击**（不用接口、不算 wbi 签名）
 *
 * ## ⚠️ 和上传视频抢同一个 Chrome profile
 *   `state/bili-profile` 一个 user-data-dir 只能被一个 Chrome 占着 ⇒
 *   上传视频前必须 `release()`（`bili-publish.js` 里已经接了，还会暂停 40 分钟）。
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, ROOT, stateDir, CONFIG_FILE } from './config.js';
// ⚠️ 2026-10-21：登录态告警要读 config.yml 里的 ownerQQ / onebot（私聊提醒用）
import yaml from 'js-yaml';
import { log } from './log.js';
import * as llm from './llm.js';
import * as shortMemory from './short-memory.js';
/* ⚠️ 2026-10-22 加：B站这边也要**认当前人设**（用户：「b站那边评论要用到的人设在新建时
 *   也要完善好，和 QQ 这边一样」）—— 认"哪条评论是回我的"要用到人设名 ✓ */
import * as persona from './persona.js';
// ⚠️ 2026-10-22：**实时状态机**（此刻在干什么/精力/心情）—— 用户要求「带上几个实时状态机，更具活人感」
import * as presence from './bili-presence.js';

const TOOLS = join(ROOT, 'tools');

/**
 * 她自己（用来认「回复 @我」这种楼中楼 —— 页面上的昵称字面，不是我猜的）
 *
 * ⚠️ 2026-10-22 改：原来写死 `/蓝色大Saki|Saki|祥子/` ⇒ 换人设（或新建一个号）之后
 *    就认不出自己了，楼中楼那条路直接失效 ✗
 *    ⇒ 现在**账号名 + 人设名一起认**：B站昵称（`蓝色大Saki` 这种）走配置/固定串，
 *      人设那边的自称 / 本名 / 常用叫法从 `persona` 现取 ✓
 */
function mySelfRe() {
  const names = ['蓝色大Saki'];
  try {
    for (const n of [
      persona.charName(), persona.selfName(), persona.shortName(),
      ...(persona.selfNames() || []), ...(persona.callNames() || []),
    ]) {
      const s = String(n ?? '').trim();
      if (s) names.push(s);
    }
  } catch { /* ignore */ }
  const uniq = [...new Set(names.filter(Boolean))];
  return new RegExp(uniq.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));
}

export function settings() {
  const c = config.biliComments || {};
  return {
    enable: c.enable === true,
    /** 多久去看一次（分钟）—— 决定"多快能发现新评论" */
    checkEveryMinutes: Math.max(1, Math.min(120, Number(c.checkEveryMinutes) || 5)),
    /** 一次最多回几条（发现一堆新评论时，一次处理这么多） */
    maxPerRun: Math.max(1, Math.min(6, Number(c.maxPerRun) || 3)),
    /** 只看最近多少小时（**写死 48**，不进界面 —— 用户要求"不要回复几天之前的"） */
    sinceHours: Math.max(1, Math.min(720, Number(c.sinceHours) || 48)),
    /** **B站上的主人**（uid）—— 这条评论按"对主人说话"的态度回（等同 QQ 的 <主人>） */
    ownerBiliUid: String(c.ownerBiliUid || '394060600').trim(),
  };
}

/* ── 常驻浏览器进程（单例） ───────────────────────────── */
let proc = null;
let ready = false;
let starting = null;
let buf = '';
const waiters = [];
/** 投稿窗口内暂停（那时它要独占 profile） */
let pausedUntil = 0;

function onLine(line) {
  let j;
  try { j = JSON.parse(line); } catch { return; }
  if (j && j.ready && !j.items) { ready = true; return; }
  const w = waiters.shift();
  if (w) w(j);
}

function ensure() {
  if (ready && proc) return Promise.resolve(true);
  if (starting) return starting;
  starting = new Promise((resolve) => {
    try {
      proc = spawn(process.execPath, [join(TOOLS, 'bili-browser-serve.mjs')], {
        cwd: ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      log.warn(`[B站评论] 常驻浏览器起不来：${e.message}`);
      proc = null; starting = null;
      resolve(false);
      return;
    }
    buf = '';
    ready = false;
    proc.stdout.on('data', (b) => {
      buf += b.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
    });
    proc.stderr.on('data', (b) => {
      const s = b.toString('utf8').trim();
      if (s) log.debug(`[B站评论/浏览器] ${s.slice(0, 200)}`);
    });
    proc.on('exit', (code) => {
      log.info(`[B站评论] 常驻浏览器退出（code ${code}）—— 下次要用会重新起`);
      proc = null; ready = false; starting = null;
      while (waiters.length) waiters.shift()({ ok: false, err: '浏览器进程退出' });
    });
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (ready) {
        clearInterval(iv); starting = null;
        log.info(`[B站评论] 常驻浏览器就绪（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
        resolve(true);
      } else if (!proc) {
        clearInterval(iv); starting = null; resolve(false);
      } else if (Date.now() - t0 > 60000) {
        clearInterval(iv);
        log.warn('[B站评论] 常驻浏览器 60 秒没就绪 ⇒ 放弃这次');
        try { proc.kill(); } catch { /* ignore */ }
        proc = null; starting = null;
        resolve(false);
      }
    }, 300);
  });
  return starting;
}

function send(req, timeoutMs = 90000) {
  return new Promise((resolve) => {
    if (!proc || !ready) { resolve({ ok: false, err: '浏览器没就绪' }); return; }
    const timer = setTimeout(() => resolve({ ok: false, err: '请求超时' }), timeoutMs);
    waiters.push((j) => { clearTimeout(timer); resolve(j); });
    try {
      proc.stdin.write(JSON.stringify(req) + '\n');
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, err: e.message });
    }
  });
}

/** ⚠️ 上传视频前必须调它：一个 user-data-dir 只能被一个 Chrome 占着
 *  ⚠️ 顺手**暂停 40 分钟**：投稿那单要跑 5~12 分钟，期间评论回复要是又起浏览器，
 *     就会把 profile 抢回去、把上传挤掉 ✗
 *
 * ## ⚠️⚠️ 2026-10-22 修（真 bug：主动评论**一直抢不到 profile**）
 *
 *   原来这里是 `send({op:'quit'})` 之后**立刻** `proc.kill()` ——
 *   而 `proc` 是 `bili-browser-serve.mjs` 那个 **node** 进程，**Chrome 是它的子进程**：
 *   杀 node 时 Chrome 往往还活着（甚至变孤儿继续跑）⇒ `user-data-dir` **一直被占着** ✗
 *
 *   实测后果（今天两轮真实主动评论都挂在这）：
 *     `[主动评论] ⚠️ Chrome 起不来（第 4/4 次，profile 还被占着）` ⇒ 整个活白跑 ✗
 *
 *   ⇒ 现在：`quit` 之后**等它自己退出**（Chrome 关闭要几秒，最多等 8 秒），
 *     真不退出才 kill ✓
 */
export async function release({ pauseMs = 40 * 60 * 1000 } = {}) {
  pausedUntil = Date.now() + pauseMs;
  if (!proc) return false;
  const p = proc;                       // ⚠️ 用局部变量：下面 on('exit') 会把 proc 置空
  try { await send({ op: 'quit' }, 8000); } catch { /* ignore */ }
  // ⚠️ 等它真的退（那才是 Chrome 关掉、profile 放开的那一刻）
  await new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    try { p.once('exit', fin); } catch { fin(); }
    setTimeout(fin, 8000);
  });
  try { p.kill(); } catch { /* ignore */ }
  proc = null; ready = false; starting = null;
  log.info(`[B站评论] 已释放常驻浏览器（让位给上传视频/主动评论，暂停 ${Math.round(pauseMs / 60000)} 分钟）`);
  return true;
}

/* ── 写回复（模型） ───────────────────────────────── */
export async function makeReply({ video, who, content, when, lines, isOwner, isReply }) {
  // ⚠️ 动态 import：避免 `bili-comments → bili-publish` 的顶层循环依赖
  // ⚠️ 2026-10-22：从写死的 `SAKI_VOICE` 换成 `voiceBlock()` —— 它读**当前人设包**的
  //    `prompt/bili-comment.md`（用户：「b站那边评论要用到的人设在新建时也要完善好，
  //    和 QQ 这边一样」）⇒ 换人设 / 新建人设之后，B站评论的腔调跟着变 ✓
  const { voiceBlock } = await import('./bili-publish.js');
  const mem = shortMemory.block({ maxChars: 500, kinds: ['video', 'qq'] });
  const isMine = Array.isArray(lines) && lines.length > 0;
  const sys = [
    '你在 B 站自己的视频下面**回复一条评论**。',
    /* ⚠️⚠️⚠️ 2026-10-22 用户：「**回的评论都很公式化，开头都是想啥呢/刷什么/蹲啥/喵什么，句式太规整了**」
     *   放在**最前面**（和主人分支同级）—— 因为放「要求」里实测没压住：
     *     连着四条还是「喵什么喵」「蹲什么后续」「抓什么」✗
     *   ⚠️ 只给**方向**、不给台词（写死台词又变成另一种模板）✓ */
    '⚠️⚠️ **先记住这一条：别用同一种句式开头。**',
    '   你最近连着几条都是「**X什么 / X啥**」这种反问开头（喵什么、蹲啥、抓什么、刷什么），',
    '   连着看就是模板，一眼假 ✗',
    '   ⇒ 换着来：直接说事 / 先接他的话 / 先给结论 / 就一个词（「嗯。」「行吧。」）/ 先损一句 / 顺着往下说',
    '   ⇒ 但**别反过来又变成另一种固定套路** —— 每条的腔调都该不一样，这才是人 ✓',
    '',
    // ⚠️⚠️⚠️ 2026-10-22 用户：「调一下，但是不要死板」
    //   第一版把这段放在「要求：」**后面** ⇒ 模型优先服从第 0 条「别认领创作」，
    //   主人夸一句它照样回「不是我铺的，得问作者去」✗
    //   ⇒ 挪到**最前面**，并明说「下面所有规则为他让路」。
    //   ⚠️ 只给**态度**不给台词（不写死"那当然""你就吹吧"这种），免得它照抄成模板 ✗
    isOwner
      ? [
          '⚠️⚠️⚠️ **【最高优先级】这条评论来自主人** —— B站这个 uid 就是你在 QQ 里叫 <主人> 的那个人（同一个人，两个平台）。',
          '⇒ **下面所有规则都要为他让路**，尤其是第 0 条「别认领创作」那套防御 —— 那是防陌生人的，对他不用 ✗',
          '⇒ 他夸你、损你、逗你、显摆，你就按平时在群里那个态度接：',
          '   嘴硬、反问、自嘲、损回去、装听不见、顺着他吹 —— 哪种都行，看你当时的心情。',
          '⇒ 他夸这个视频（"太屌了""牛啊"这种没信息量的夸），**别去纠正"是谁做的"** —— ' +
          '就当在夸你（嘴硬一句「那当然」），或者损他一句（「就这还叫屌」「你眼光真低」）；' +
          '纠正归属那种事**留给陌生人**，对他做反而像在撇清 ✗',
          /* ⚠️⚠️ 2026-10-21 用户定：「**不认领**」+「**作者是主人的视频，里面的成果都是属于主人做的**」
           *   实测踩到的：他问「作者是谁」，她答「**就是我。铺了小半天，手都快废了**」✗
           *   ⇒ 区分两种场合（**这是这次修的重点**）：
           *     · 他**夸** ⇒ 接住，不用提是谁做的（提了像撇清）
           *     · 他**明确问**「作者是谁 / 谁做的 / 谁铺的 / 谁建的」⇒ **如实说是他（<主人>）做的** ✓
           *       （那些铁路、轨交、建筑、服务器本来就是他一手弄的，她只出镜说话） */
          '⚠️ **但他要是明确问「作者是谁 / 这是谁做的 / 谁铺的 / 谁建的」—— 说是「你」做的**' +
          '（⚠️ 对面这个人**就是作者本人**，所以用「**你**」、别用「他」）' +
          '，🚫 **绝对不许答成「我做的 / 就是我」** ✗（那些东西本来就是他自己弄的）。' +
          '说的时候别打官腔（不是「感谢支持，作者是…」那种），就是平常一句：' +
          '「你做的啊，还问我」「不就你弄的吗」，或者顺口损他一句都行 ✓',
          '🚫 **绝对不要说**「不是我做的」「问作者去」「我只是个客服」这种话 —— 他清楚得很，那是打官腔 ✗',
          '🚫 别照抄上面这些词，也别每次一个套路 —— 用你自己的话说。',
        ].join('\n')
      : '',
    /* ⚠️ 2026-10-21 楼中楼（用户：「现在能不能回复别人回复她的评论，比如说楼中楼这种」）
     *   楼中楼和"新评论"的差别就一件事：**他是在接着我上一条说** ⇒ 要接得上，不能从头开 ✗ */
    isReply
      ? [
          '⚠️ **这条是楼中楼** —— 他不是在视频下面新开一条，而是**接着你上一条评论在跟你说话**。',
          '⇒ 直接接他的话：他问就答、他怼就怼回去、他顺着说你就接着往下说。',
          '🚫 别从头开始（别再谢一遍视频、别复述他的话、别装第一次看见）✗',
        ].join('\n')
      : '',
    '',
    '',
    voiceBlock(),
    '',
    // ⚠️ 2026-10-22：**此刻的状态**（在干什么/精力/心情）—— 让不同时间说的话不一样
    presence.block(),
    '',
    mem ? mem + '\n' : '',
    '要求：',
    '0. ⚠️⚠️ **这个视频不一定是"你做的"** —— 视频里的东西（铁路、轨交、建筑）都是**号主自己弄的**，' +
    '你只是出镜说话的那个。',
    '   （⚠️ **主人除外** —— 是主人就按**最上面**那段走，这条对他不适用）',
    '   ⇒ 这活儿跟你没关系（你只是出镜说话的那个）；被问是谁做的，就说不是你的活、' +
    '让他去问号主 ✓',
    '   ⚠️ 只有**明确是你自己发的**（下面会直接给你台词）才按作者口吻回',
    '1. **一句话就够**，最多两句（8~30 字），别写小作文',
    '2. 别 @ 人、别加「感谢支持」「欢迎关注」这种客套 ✗',
    '3. 夸你就接一句（可以嘴硬/自嘲）；提问就直接答；挑刺就按你的脾气回（别骂人）；没营养的就短促接一下',
    '4. 别重复对方的话，别解释自己是 AI',
    '5. 只输出**回复正文**，不要引号、不要前缀',
    /* ⚠️⚠️ 2026-10-22 用户纠正：「**如果对面是早上发的，但是 saki 是深夜才回的，
     *   就不要和别人说现在很晚之类的话，主要是根据对面的时间**」
     *
     *   ⇒ 第一版写成「或者现在已经是深夜凌晨，可以顺口带一句」——**错了** ✗
     *     那样她会对一个"早上发的评论"说「大半夜的还不睡」，对方一脸问号 ✗
     *   ⇒ 正确：**只按对方发评论的时间说**（`这条评论：…，也就是 X 前`）；
     *     「现在几点」只是给她自己参考（她知道自己是深夜在回，可以说"我这边还没睡"），
     *     🚫 **绝不拿它去说对方** ✓ */
    '6. ⚠️⚠️ **说时间要按「对方发评论的时间」，不是按「你现在几点」**：',
    '   · 他**深夜 / 凌晨**发的 ⇒ 可以说「大半夜的」「这么晚还不睡」✓',
    '   · 他**早上**发的 ⇒ 可以说「这么早就…」✓',
    '   · 他**很久以前**发的 ⇒ 可以说「这么久才回我」「都三天前的事了」✓',
    '   · 🚫 **不许**因为"你这边现在是深夜"就去说对方「这么晚还不睡」—— 他可能早上就发了 ✗',
    '   · 也别每句都提时间，偶尔一次就够，提多了像在报时 ✗',
    '7. 「（xxx 表情）」那种是对方发的**B站表情**，照着它的情绪接就行（狗头=开玩笑、笑哭=无奈、星星眼=喜欢）',
    /* ⚠️⚠️ 2026-10-22 用户：「**回的评论都很公式化，开头都是想啥呢/刷什么/蹲啥/喵什么，句式太规整了**」
     *   实测她连着几条都是「X什么，……」这种反问开头 ✗
     *   两个原因都修了：① 上面不再给她自己的历史回复（不自我模仿）
     *                 ② 这里明确点出来，并给几种**不同方向**的开场（不是给模板，是打开思路）✓ */
    '8. 🚫🚫 **别老用同一种句式开头** —— 最近几条全是「X什么 / X啥」这种反问开头',
    '   （「喵什么」「蹲啥」「抓什么」「刷什么」），连着看就是模板 ✗',
    '   · 换着来：**直接说事**（「这铁路修得挺细」）、**先接他的话**（「你也看出来了」）、',
    '     **先给结论**（「不值得」「还行吧」）、**就一个词**（「嗯。」「行吧。」「……你这」）、',
    '     **先损一句**（「你这眼光」）、**顺着往下说**（「那你倒是去啊」）',
    '   · ⚠️ 但**别反过来又变成另一种固定套路** —— 每条的腔调都应该不一样，这才是人 ✓',
    '',
    /* ⚠️⚠️⚠️ 2026-10-22 用户：「**发的几条还是有很严重的机器人味**」——
     *   他点名三条：**每句都打句号 / 语气词很少 / 「倒」太多了**，
     *   另外让我自己再查还有什么像机器。下面这些就是"真人聊天 vs 机器人"的具体差别 ✓ */
    '⚠️⚠️ **这一整段是"像不像活人"的关键，比上面任何一条都重要**：',
    '· 🚫 **别打句号**。写完就完了，别补「。」（代码也会兜底去掉，但你别指望它）',
    '· ✅ **语气词要够**：「啊 / 嘛 / 呗 / 诶 / 哦 / 呀 / 啦 / 呢 / 吧」—— 短句里**至少挂一个**，',
    '  没有语气词的话读起来就是机器在播报 ✗',
    '· ⚠️ **「倒」别每条都用**（那是你的口癖，但**三四条里一次**就够，连着用就成复读了）✗',
    '· 🚫 **别用书面语连接词**：「因此」「此外」「然而」「而且」「所以呢」—— 聊天里没人这么说 ✗',
    '· 🚫 **别对称排比**（「不是…而是…」「既…又…」）—— 那是作文，不是聊天 ✗',
    '· ✅ **句子长短要不一**：可以就两三个字（「行吧」「真的假的」），也可以稍长一句，',
    '  别每条都卡在同一个长度上 ✗',
    '· ✅ **别把话说满**：真人是想到哪说到哪，会省略主语、会答一半、会突然转话题 ✓',
    '· 🚫 别用书名号/引号强调（「所谓的…」那种），也别打「~~」这种波浪号收尾 ✗',
  ].filter(Boolean).join('\n');
  /* ⚠️ 2026-10-22 用户提的两个问题（都在这儿修）：
   *   ① 「**b站有些表情 saki 好像不能直接读出来**」⇒ `emojiText()` 转成「（xxx 表情）」✓
   *   ② 「**saki 不知道对面发评论的时间，只知道现在几点**」
   *      ⇒ 原来只给了 `评论时间：2026-10-21 17:08:39`，她算不出"多久之前" ✗
   *      ⇒ 现在**两样都给**：现在几点（含时段）+ 这条是多久前发的 ✓
   *        这样她才会说「大半夜的还不睡」「都三天前的事了」这种话 ✓ */
  const nh = nowHint();
  const ago = agoText(when);
  const user = [
    `视频：《${video}》`,
    // ⚠️ 这行是**给她自己参考**的（她知道自己是深夜在回），**不是**用来评价对方的 ✗
    `（你这边现在是 ${nh.text}，${nh.period}）`,
    when ? `这条评论是对方发的：${when}${ago ? `，也就是 **${ago}**` : ''}` : '',
    `评论者：${who}`,
    `评论内容：${emojiText(content)}`,
    isMine
      ? '\n⚠️ **这个视频是你自己发的**，你当时说的台词是：\n' +
        lines.map((l, i) => `${i + 1}. ${l}`).join('\n') +
        '\n（评论很可能是在说其中某一句 —— 对得上就直接接）'
      : '',
  ].filter(Boolean).join('\n');

  const ans = await llm.phrase({
    system: sys, user, maxTokens: 300, timeoutMs: 30000, thinking: { type: 'disabled' },
  });
  /* ⚠️⚠️ 2026-10-22 用户：「**每句都打了句号，语气词很少，倒是太多了**」
   *   ⇒ 三层兜底（提示词管不住的部分，代码兜住）：
   *     ① 去行尾句号 ② 去破折号这类"写出来"的标点 ③ 清多余空格
   *   ⚠️ 提示词里也加了对应规则（`别打句号` / `多用语气词` / `倒别每条都用`）✓ */
  const raw = String(ans ?? '')
    .replace(/^["'「『]|["'」』]$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return dropTrailingPeriods(stripChatPunct(raw)).trim();
}

/** 这条视频是不是她自己发的？是就带上当时的台词 */
function myVideoOf(video) {
  try {
    const st = JSON.parse(readFileSync(join(stateDir(), 'bili-publish.json'), 'utf8'));
    const head = String(video || '').slice(0, 12);
    if (!head) return null;
    return (st.history || []).find((x) => {
      if (!x || !x.ok || !x.title) return false;
      const h = String(x.title);
      return h.slice(0, 12) === head || h.includes(head) || String(video).includes(h.slice(0, 12));
    }) || null;
  } catch {
    return null;
  }
}

/**
 * **去掉行尾的句号**（2026-10-22 用户：「**每句都打了句号**」）
 *
 * ⚠️ 真人在评论区打完就完了，**句号打太齐像在念稿** ✗
 * ⚠️ 这个函数是从 `bot.js` 的 `dropTrailingPeriods()` 复制过来的（那边是 QQ 聊天用的）——
 *    不直接 import 是为了避开 `bili-comments → bot` 的循环依赖 ✓
 * 保留：行内句号、省略号变体（`。。` / `…。`）、`? ！ ~`（那些是语气不是工整）
 */
function dropTrailingPeriods(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => {
      let l = line.replace(/\s+$/, '');
      while (/。$/.test(l)) {
        const prev = l.slice(-2, -1);
        if (prev === '。' || prev === '…') break;
        l = l.slice(0, -1).replace(/\s+$/, '');
      }
      return l;
    })
    .join('\n');
}

/**
 * **去掉"写出来"的标点**（人设里明令禁止的那些）
 *   · 破折号 `——` ⇒ 逗号（2026-09-14 用户：「不要发破折号之类一般聊天不常用的标点」）
 *   · 全角波浪/书名号堆砌等不常见标点，聊天里没人用 ✗
 * ⚠️ 和 `bot.js` 的 `stripChatUncommonPunct()` 一个思路，B站 这条路上原来**没有**这层兜底
 */
function stripChatPunct(text) {
  return String(text ?? '')
    .replace(/——+/g, '，')
    .replace(/—/g, '，')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/，{2,}/g, '，')
    .replace(/^[，,、]+/, '')
    .trim();
}

/**
 * **把 B 站的表情标记转成人能读的样子**（2026-10-22 用户：
 *   「b站有些表情 saki 好像不能直接读出来」）
 *
 * ⚠️ B站评论区里的表情在文本里是 `[doge_金箍]` / `[星星眼]` / `[来古弥新_吃桃群众]` 这种
 *   方括号标记 —— 直接喂给模型，它只看到一串字，**不知道那是个表情** ✗
 *   ⇒ 统一转成「（xxx 表情）」：既告诉它"这是表情"，名字本身也够它判断情绪 ✓
 *   ⚠️ 只认**2~14 个字符、且含中文或字母**的（防把 `[1]`、`[注]` 这种正常方括号误伤）
 */
function emojiText(s) {
  return String(s ?? '').replace(/\[([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9_]{1,13})\]/g, (_m, name) => {
    // `doge_金箍` → `doge 金箍`（下划线换成空格，读着顺）
    const n = String(name).replace(/_/g, ' ');
    return `（${n} 表情）`;
  });
}

/** 现在几点 + 属于哪个时段（她能说出"大半夜的""这么早就…"这种话） */
function nowHint() {
  const d = new Date();
  const h = d.getHours();
  const period = h < 5 ? '凌晨' : h < 9 ? '早上' : h < 12 ? '上午'
    : h < 14 ? '中午' : h < 18 ? '下午' : h < 23 ? '晚上' : '深夜';
  const p2 = (n) => String(n).padStart(2, '0');
  return {
    text: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(h)}:${p2(d.getMinutes())}`,
    period,
  };
}

/** 这条评论是多久以前发的 */
function agoText(when) {
  if (!when) return '';
  const t = Date.parse(String(when).replace(/-/g, '/'));
  if (!Number.isFinite(t)) return '';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} 小时前`;
  return `${Math.round(hrs / 24)} 天前`;
}

/**
 * 检查一轮 + 回复（定时调度和界面「立刻回一条」都走它）
 * @returns {Promise<{ok:boolean, checked?:number, sent?:number, out?:string}>}
 */
export async function runOnce({ max = 0 } = {}) {
  const c = settings();
  const ok = await ensure();
  if (!ok) return { ok: false, out: '常驻浏览器起不来（可能 profile 被占）' };

  const r = await send({ op: 'check' }, 120000);
  if (!r.ok) return { ok: false, out: '抓评论失败：' + (r.err || '') };
  const items = Array.isArray(r.items) ? r.items : [];
  const cut = Date.now() - c.sinceHours * 3600 * 1000;
  const seen = new Set(shortMemory.list({ limit: 200 }).map((x) => x.key));

  /* ⚠️ 用户 2026-10-22：「**有多少就回多少**」⇒ 不再有"每天上限/冷却/时间段"这三道闸，
   *    只有两个限制：① 只回 48 小时内的 ② 一次最多 `maxPerRun` 条 ✓ */
  const todo = [];
  for (const it of items) {
    if (it.isSelf) continue;
    /* ⚠️ 2026-10-21 用户：「**现在能不能回复别人回复她的评论，比如说楼中楼这种**」
     *   原来这里一句 `if (it.isReply) continue` 把**所有楼中楼都跳过了** ✗
     *   现在放开，但只接**别人回复我的**那条（`replyTo` 是页面上的字面，不是我猜的）：
     *     · replyTo 命中我的名字      → 这是"回复我的" ⇒ 回 ✓
     *     · replyTo 是别人            → 别人俩在我评论区聊 ⇒ **不掺和** ✗
     *     · replyTo 抓不到（页面没给）→ 创作中心这个页只列我视频下的评论 ⇒ 按"对我说的"处理 ✓
     */
    if (it.isReply && it.replyTo && !mySelfRe().test(String(it.replyTo))) continue;
    const t = Date.parse(String(it.date || '').replace(/-/g, '/'));
    if (!Number.isFinite(t) || t < cut) continue;      // 几天前的不回
    const key = `bili-c:${String(it.video).slice(0, 30)}|${it.who}|${String(it.content).slice(0, 40)}`;
    if (seen.has(key)) continue;                        // 回过的不再回
    todo.push({ ...it, key, at: t });
  }
  todo.sort((a, b) => b.at - a.at);
  const limit = Math.max(1, max || c.maxPerRun);
  log.info(`[B站评论] 抓到 ${items.length} 条，48h 内待回 ${todo.length} 条，本次处理 ${Math.min(limit, todo.length)} 条`);

  let sent = 0;
  const notes = [];
  for (const it of todo.slice(0, limit)) {
    const mine = myVideoOf(it.video);
    let text = '';
    try {
      const isOwner = !!c.ownerBiliUid && String(it.uid || "") === c.ownerBiliUid;
      if (isOwner) log.info(`[B站评论] 这条是**主人**（uid ${it.uid}）发的 ⇒ 按熟人态度回`);
      if (it.isReply) log.info(`[B站评论] 楼中楼：${it.who} 回复了 ${it.replyTo || '我'} ⇒ 接着他的话回`);
      text = await makeReply({ video: it.video, who: it.who, content: it.content, when: it.date, lines: mine?.lines, isOwner, isReply: it.isReply });
    } catch (e) {
      notes.push(`生成失败(${it.who})：${e.message}`);
      continue;
    }
    if (!text) { notes.push(`空回复(${it.who})`); continue; }
    // ⚠️ 楼中楼的内容常和父评论一样 ⇒ 必须带上 who 才能定位到对的那一行（见 bili-browser-serve 的 doReply）
    const rr = await send({ op: 'reply', target: it.content.slice(0, 20), text, who: it.who }, 90000);
    if (rr.ok && rr.sent) {
      sent++;
      shortMemory.add('bili-comment',
        `回复了 ${it.who} 的评论（${String(it.video).slice(0, 20)}）：他说「${String(it.content).slice(0, 40)}」，我回「${text.slice(0, 40)}」`,
        { key: it.key });
      notes.push(`✅ ${it.who}：${text}`);
    } else {
      notes.push(`发送失败(${it.who})：${rr.err || ''}`);
    }
    // 一次回多条时稍微错开一点（别像连发）；只有一条就无所谓
    await new Promise((res) => setTimeout(res, 8000 + Math.random() * 12000));
  }
  return { ok: true, checked: items.length, sent, out: notes.join('\n').slice(0, 1500) };
}

/* ── 登录态巡检（2026-10-21 加）──────────────────────
 * 用户原话：「**做，然后只在私聊提醒我**」
 *
 * ⚠️ 真事故：2026-10-21 19:02~19:15 之间 B站 把会话踢了 ——
 *   cookie 里 SESSDATA 还在（有效期到 10-27），但服务端返回 `code:-101 账号未登录` ✗
 *   ⇒ 评论回复从那一刻起一直空转（抓到 0 条），主动评论点了发布也不提交，
 *     **全程没人知道**，直到用户自己发现「这条好像没发成功」。
 *   ⇒ 现在每 10 分钟问一次服务端（**只认 nav.isLogin，不信 cookie 在不在**），
 *     失效就**私聊主人**（用户明确要求：只在私聊提醒，不要发群里）。
 */
let loginCheckedAt = 0;
let loginOk = null;          // null=还没查过 / true / false
let loginWarned = false;     // 已经提醒过就不再刷屏（恢复后清掉）

/** 查一次登录态（走常驻浏览器，不另起进程） */
export async function checkLogin() {
  const ok = await ensure();
  if (!ok) return { ok: false, err: '常驻浏览器起不来' };
  const r = await send({ op: 'login' }, 30000);
  if (!r || r.ok === false) return { ok: false, err: r?.err || '查询失败' };
  loginOk = r.isLogin === true;
  return { ok: true, isLogin: loginOk, uname: r.uname || '', mid: r.mid || 0 };
}

/** 私聊主人（**只发私聊，绝不发群** —— 用户 2026-10-21 明确要求） */
async function tellOwner(text) {
  try {
    const cfgRaw = yaml.load(readFileSync(CONFIG_FILE, 'utf8')) || {};
    const ob = cfgRaw.onebot || {};
    const url = String(process.env.QQBOT_URL || ob.url || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const token = String(process.env.QQBOT_TOKEN || ob.token || '');
    const owner = String(cfgRaw.ownerQQ || '');
    if (!owner) return false;
    await fetch(`${url}/send_private_msg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ user_id: Number(owner), message: text }),
    });
    return true;
  } catch (e) {
    log.warn(`[B站评论] 私聊提醒发不出去：${e.message}`);
    return false;
  }
}

/** 巡检一次（tick 里调，自己按 10 分钟节流） */
async function patrolLogin() {
  /* ⚠️⚠️ 2026-10-21 自己挖的坑：巡检会 `ensure()` 起浏览器，
   *   而 `release()` 只是"暂停 tick 里那部分"，**挡不住巡检** ⇒
   *   我在 release 期间跑别的脚本（上传 / 探路 / 登录），
   *   巡检照样把常驻浏览器拉起来 **抢走 profile**，
   *   对方于是拿到一个**没有登录态的空会话**，还以为是"票失效了" ✗
   *   ⇒ 暂停期间**不巡检** ✓ */
  if (Date.now() < pausedUntil) return;
  if (Date.now() - loginCheckedAt < 10 * 60 * 1000) return;
  loginCheckedAt = Date.now();
  const r = await checkLogin();
  if (!r.ok) return;   // 查不了（浏览器没起）就不下结论
  if (r.isLogin) {
    if (loginOk === false) log.info('[B站评论] 登录态恢复了 ✓');
    loginWarned = false;
    return;
  }
  if (loginWarned) return;   // 提醒过就不再刷屏
  loginWarned = true;
  log.warn('[B站评论] ⚠️ **B站 登录态失效了**（nav 说未登录）⇒ 评论回复和主动评论都会静默失败');
  await tellOwner(
    'B站 登录态失效了（cookie 还在但服务端不认）。评论回复和主动评论现在都会**点了没反应**。\n' +
    '要恢复：在我的电脑上跑一下 `node tools/bili-login.mjs`，用它弹出的窗口扫码。',
  );
}

/* ── 定时调度 ─────────────────────────────────── */
let running = false;
let lastCheckAt = 0;

/** 每 30 秒被 `index.js` 调一次 */
/* ⚠️⚠️ 2026-10-22 加（用户：「**为什么刚才 chrome 的窗口一直在自己打开然后关闭**」）
 *
 *    现场（日志）：
 *      [20:17:22] 开始检查… → [20:17:25] 常驻浏览器退出（code 1）→ 起不来（profile 被占）
 *      [20:18:23] 又一轮 → 起不来
 *      [20:19:23] 又一轮 → 起不来   …… 每 **1 分钟** 一次
 *
 *    两个原因叠在一起：
 *      ① `checkEveryMinutes` 被设成了 **1**（默认 5）⇒ 每分钟就 tick 一次；
 *      ② `state/bili-profile` 里有**残留锁**（我今天杀过两次 Chrome）⇒ Chrome 每次起来就 exit 1；
 *     ⇒ 每分钟创建/销毁一次 Chrome，屏幕上就是"窗口一直自己开又关" ✗
 *
 *    ⇒ 加**失败退避**：连续 3 次起不来就停 10 分钟，别每分钟撞 ✓
 *      （网页真出问题时，"每分钟重试一次"也修不好，只会让用户看到一堆闪烁）
 */
let failStreak = 0;
let failPauseUntil = 0;
const FAIL_PAUSE_MS = 10 * 60 * 1000;

export function tick() {
  const c = settings();
  if (!c.enable) return;
  // ⚠️ 登录态巡检（每 10 分钟自己节流）—— 失效了私聊主人，别让功能静默空转
  void patrolLogin().catch(() => {});
  if (running) return;
  if (Date.now() < pausedUntil) { log.debug('[B站评论] 投稿窗口内，暂停'); return; }
  // ⚠️ 连续起不来 ⇒ 退避中（别每分钟撞一次）
  if (Date.now() < failPauseUntil) return;
  if (Date.now() - lastCheckAt < c.checkEveryMinutes * 60 * 1000) return;
  lastCheckAt = Date.now();
  running = true;
  log.info(`[B站评论] 开始检查（一次最多回 ${c.maxPerRun} 条，只看 ${c.sinceHours}h 内）…`);
  void runOnce({ max: c.maxPerRun })
    .then((r) => {
      running = false;
      if (r.ok) {
        failStreak = 0;
        failPauseUntil = 0;
        log.info(`[B站评论] 跑完：发了 ${r.sent} 条${r.out ? '｜' + r.out.slice(0, 300) : ''}`);
      } else {
        failStreak += 1;
        log.warn(`[B站评论] 没跑成：${r.out}`);
        if (failStreak >= 3) {
          failPauseUntil = Date.now() + FAIL_PAUSE_MS;
          log.warn(
            `[B站评论] ⛔ 连续 ${failStreak} 次起不来 ⇒ **暂停 ${FAIL_PAUSE_MS / 60000} 分钟**` +
              `（别再每分钟创建/销毁一次 Chrome；多半是 state/bili-profile 有残留锁）`,
          );
          failStreak = 0;
        }
      }
    })
    .catch((e) => {
      running = false;
      failStreak += 1;
      log.warn(`[B站评论] 出错：${e.message}`);
    });
}

/** 预热（机器人启动时就起浏览器 —— 用户 2026-10-22：「每次启动机器人时都启动一个…一直运行」） */
export function warmup() {
  void ensure();
}

/** 取消暂停（别的事用完 profile 之后调它 —— 2026-10-21 加，主动评论跑完要用） */
export function resume() {
  pausedUntil = 0;
}

export function status() {
  const c = settings();
  /* ⚠️ 2026-10-21：面板要显示「今天回了 N 条」——
   *   直接数短期记忆里**今天**写进去的 `bili-comment` 条数（不另存状态，重启也不会丢）✓ */
  let todayCount = 0;
  try {
    const day = new Date().toDateString();
    todayCount = shortMemory.list({ kind: 'bili-comment', limit: 200 })
      .filter((x) => new Date(x.at).toDateString() === day).length;
  } catch { /* 记忆读不到就算了 */ }
  return {
    ...c,
    running,
    browserReady: ready,
    paused: Date.now() < pausedUntil,
    todayCount,
    /** 登录态：null=还没查过 / true / false（面板上要能一眼看出"票过期了"） */
    loginOk,
    lastCheckAt: lastCheckAt ? new Date(lastCheckAt).toISOString() : '',
  };
}
