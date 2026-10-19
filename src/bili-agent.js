/**
 * B站问答：「丢给 agent 去查 → bot 用自己的人设润色 → 分条发」（2026-10-19 加）
 *
 * ## 用户原话
 *   「把**询问 b站内容的问题**都接入 b站工具，**直接把问题丢给 agent**，
 *     但是让 agent 的回复**尽量快速简短，节约时间和 token**，
 *     然后把拿到的信息交给 bot **润色一遍**，还是和之前一样要**带上 bot 的人设**，
 *     并且**分条逻辑也正常应用**」
 *   （定时分享那条「不要动」⇒ 这个文件只管**问答**，不碰 `bili-share`）
 *
 * ## 为什么不再直接调 B 站接口
 *   原来那两条（`hotFacts()` / `ownerVideoFacts()`）是**判据命中就直接答复**：
 *   · 判据窄 ⇒ 换个说法就不认（"B站最近有啥好看的"未必命中）
 *   · 接口变了/限流 ⇒ 只能说"没查到"，她也没别的办法
 *   ⇒ 现在**问题原样交给 agent**（它有联网能力，能自己换关键词、翻页面），
 *     拿回来再由她用自己的话说 —— 事实来自 agent，语气来自她 ✓
 *
 * ## 三处讲究
 *   ① **agent 只回要点**：任务里明写"别写文件、别解释过程、数字照抄别算" ⇒
 *      又快又省 token（`mode: 'quick'` 那边还额外把超时压到 90 秒、一句播报都不发）；
 *   ② **润色只换说法、不许改事实**（`voiceize('result')`，它本身就带她的人设）；
 *   ③ **分条照旧走 `bot.sendChunk()`** —— 分条、清洗、表情标记、引用规则全都还是她那套 ✓
 */

import { fileURLToPath } from 'node:url';
import { log } from './log.js';
import * as llm from './llm.js';
import { startRun, voiceize, busyTask } from './agent-bridge.js';

/**
 * 起一次 B 站问答（**同步返回**，调用方不许 await）。
 *
 * @param {{bot:object, gid:string, by:string, byName:string, question:string, event:object}} p
 * @returns {boolean} 有没有接上（没接到就返回 false，调用方可以走别的路）
 */
export function askBili({ bot, gid, by, byName, question, event }) {
  const q = String(question ?? '').trim().slice(0, 300);
  if (!q || !gid) return false;

  // ⚠️⚠️ 2026-10-19 加（活着踩到的）：`startRun()` 一进去就**把正在跑的那个活杀掉**
  //    ⇒ 群里随口问一句 B 站，会把别人正在干的长活砍了 ✗
  //    ⇒ **agent 忙的时候不抢**，返回 false 让调用方走原来那条接口直查（快、不打断）✓
  const busy = busyTask();
  if (busy) {
    log.info(`[B站] agent 正在干别的活（${busy.slice(0, 24)}）⇒ 不打断它，走接口直查`);
    return false;
  }

  // ⚠️ agent 的任务要**极短**：只交代"查什么"和"回成什么样"，
  //    别写格式模板（一写模板它就照着抄，反而慢又长）
  // ⚠️ 给它一条**现成的命令** —— 不然它会自己开网页翻 HTML：又慢又费 token，标题还容易抄错 ✗
  //    （脚本本身是 `tools/bili.mjs`，输出就是「一行一条」的纯文本，照抄即可 ✓）
  const tool = fileURLToPath(new URL('../tools/bili.mjs', import.meta.url));
  const task =
    `查一下 B 站：${q}\n` +
    '⚠️ **直接用这条现成命令查**，别自己上网翻网页（那样又慢又容易抄错）：\n' +
    `  node "${tool}" up 频道名 8        ← ★ 问「某个 UP 主 / 频道 / 博主发了什么」就用这个\n` +
    `  node "${tool}" search 关键词 8     ← 只在问「某个话题有什么视频」时才用\n` +
    '（还有 hot 热门榜 / video BV号；参数不够用就 `raw 函数名 --key=值` 自己组合，不带参数会打用法）\n' +
    '⚠️⚠️ **问「某个人 / 频道 / 博主自己发的视频」时，必须用 `up`**（按作者查）。\n' +
    '   `search` 搜出来的是"标题或简介里提到这个词的视频"，**经常是别人做的**，不是他要的那个频道 ✗\n' +
    '⚠️ **只要结果**：一两条最关键的（谁 / 什么视频 / 多少播放 / 什么时候），数字照抄，别自己算；' +
    '别写文件、别解释过程、别列清单。\n' +
    '⚠️⚠️ 工具报「查不到」或「被风控」（B 站会限流）⇒ **你自己再想办法**：' +
    '换个说法、换个参数、换个接口（`raw` 里有全部函数）再跑一遍，或者直接搜网页版把结果抄回来。' +
    '**别一句"查不到"就交差** —— 真的怎么都查不到，才说查不到。';

  const p = startRun({
    bot,
    gid: String(gid),
    by: String(by ?? ''),
    byName: String(byName ?? ''),
    task,
    // ⚠️ `related: false`：快速查询**没有产物**，夹带私货那一步（两次模型调用）纯拖时间 ✗
    //    她自己的口气由底下 `voiceize` 注入（它自带 `selfIdentity()`）⇒ 这里不必 ✓
    related: false,
    mode: 'quick', // 快速查询型：不发任何播报、超时压到 90 秒
  });

  p.then(async (r) => {
    const facts = String(r?.text ?? '').trim();
    if (!r?.ok || !facts) {
      // ⚠️ 没查到 / 超时 / 被中断 ⇒ **不能一声不吭**（问了没回应最难受）⇒
      //    兜一句人话（照样过 `voiceize`，保持她的口气；超时压到 8 秒，不让对面干等）✓
      log.warn('[B站] 快速查询没拿到结果');
      const sorry = String(
        (await voiceize('result', 'B 站那边没翻着，直说没查到就行，别编', {
          task,
          gid: String(gid),
          timeoutMs: 8000,
        }).catch(() => '')) ?? '',
      ).trim();
      if (sorry) await bot.sendChunk(event, sorry).catch(() => {});
      return;
    }
    // ⚠️ 润色：**只换说法、不许改事实**（数字、标题、时间一个都不能动）
    const line = String(
      (await voiceize(
        'result',
        `查到的：${facts}\n` +
          '用你自己的话把这些说给他 —— ⚠️ **事实一个都不许改**（数字、视频名、时间照原样），' +
          '只是换成你平时那个口气；别念清单、别提"查到/搜索/接口"。',
        { task, gid: String(gid), timeoutMs: 15000 },
      ).catch(() => '')) ?? '',
    ).trim();
    if (!line) return;
    // ⚠️ **分条逻辑照旧** —— 走 `sendChunk`（分条、清洗、表情、引用全是她那套）✓
    await bot.sendChunk(event, line).catch((e) => log.warn(`[B站] 发出去出错：${e.message}`));
    log.info(`[B站] 快速查询已回：${line.replace(/\s+/g, ' ').slice(0, 60)}`);
  }).catch((e) => log.warn(`[B站] 快速查询出错：${e.message}`));

  return true;
}

/**
 * 这句话**是不是在打听 B 站上的东西** —— ⚠️ **交给模型判，不用关键词**。
 *
 * ⚠️⚠️ 2026-10-19 加（用户截图：她 @ 她说「找找 dev 通道的新视频」⇒ 派给了普通 agent，
 *    它**写了个 `.md` 发进群**，而且拿回来的是**关键词搜出来的视频**、不是那个频道自己的投稿 ✗
 *    ——用户原话：「查 b 站视频的时候不用发文件」）
 *    真因：`bilibili.hotQuery()` 那条判据只认「热门/榜/某个 UP 主有什么视频」这类说法，
 *    「找找 dev 通道的新视频」**一个都不沾** ⇒ 走不到这里 ⇒ 落回普通派活 ⇒ 建文件 + 发文件 ✗
 *    ⇒ 所以这里**不扩关键词**（AGENTS 铁律：理解人话的判据别用关键词），改成问模型一句 ✓
 */
async function isBiliAsk(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length < 2 || t.length > 200) return false;
  try {
    const ans = await llm.phrase({
      system: [
        '判断他这句话**是不是在打听 B 站（哔哩哔哩）上的东西**。',
        '',
        '· 是：问某个 B 站 UP 主 / 频道 / 博主最近发了什么视频，某个视频多少播放，',
        '  B 站上最近有什么火的，「去 B 站看看…」「b 站上那个…」这类 ✓',
        '· 否：一般闲聊、问服务器、让做文档 / PPT / 表格、要图 ✗',
        '',
        '⚠️ **只要提到 B 站 / b站 / bilibili / 哔哩哔哩 就算"是"**，哪怕只是顺口一提在找视频；',
        '⚠️ **一个字都没提 B 站的，一律算"否"** —— 别的网站、别的平台都不是。',
        '⚠️ 拿不准就答「否」（判错了会白查一趟）。',
        '只回答一个字：是 或 否。',
      ].join('\n'),
      user: `他说：「${t.slice(0, 150)}」`,
      maxTokens: 8,
      timeoutMs: 6000,
    });
    return /^\s*是/.test(String(ans ?? ''));
  } catch (e) {
    log.debug(`[B站] 判「是不是问 B 站」失败（当成不是）：${e.message}`);
    return false;
  }
}

/**
 * 这次活是"打听 B 站" ⇒ 走快速查询那条（**agent 只交要点 → 她用自己的话分条说**）。
 *
 * ⚠️ 走这条路**不会发任何文件**（`startRun` 的 `quick` 模式把产物也跳过了）✓
 * @returns {Promise<boolean>} true = 已经接下了
 */
export async function startBiliAsk({ bot, gid, by, byName, question, event }) {
  if (!(await isBiliAsk(question))) return false;
  return askBili({ bot, gid, by, byName, question, event });
}