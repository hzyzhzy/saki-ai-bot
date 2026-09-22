/**
 * 「这次到底要拍一张什么照片」—— **单独跑一次模型理解**（2026-09-22 用户要求）。
 *
 * 用户原话：「后加的提示词要有**时间，地点，是否自拍**，这些要先**经过 llm 理解
 * 需要拍什么照片**得出」。
 *
 * ## 为什么要单独来一次，而不是让她在聊天回复里顺手写
 *
 * 实测（2026-09-22）：让她在说「行，等我一下」的**同一条回复**里附带场景描述，
 * **场景细节的遵守度很差** —— 提示词里写的是「回头看镜头」，出图却是正面站着。
 * 她说话时注意力全在"像不像她"上，拍什么只是顺带的。
 * ⇒ 拍照片这件事值得**单独一次理解**，专门把"拍什么"想清楚。
 *
 * ## 分工（用户拍板：「以真实状态为准，LLM 只能微调」）
 *
 * | 字段 | 谁说了算 |
 * | --- | --- |
 * | **时间 / 地点** | **系统的真实状态** —— `where.current()` 优先，回落日程 `whereAmI()` |
 * | **拍什么 / 有没有她** | 这次 LLM 理解 |
 * | 时间 / 地点的**微调** | LLM 可以给（群友明确要求「拍昨天那张」时）；留空 = 用系统的 |
 * | **画风**（写实 / 二次元 / 随手拍） | `config.imagegen.style`，界面上改 —— 见 `imagegen.js` |
 *
 * ⚠️ 事实由调用方（`bot.js`）算好传进来，本模块**不 import bot.js**
 *    （`bot.js` 已经很大，别再绕出循环依赖）。
 */
import { config } from './config.js';
import { log } from './log.js';
import { streamChat } from './llm.js';

const PROMPT = [
  '你要判断「她这次该拍一张什么样的照片」，然后给出结构化结果，用来生成那张图。',
  '',
  '# 照片分两种，必须选一个',
  '- withSelf = true  → 画面里**有她本人**（自拍，或者朋友帮她拍）',
  '- withSelf = false → 画面里**没有她**，是她**拍下来的东西或地方**（校门、街景、货架、天空、吃的东西…）',
  '',
  '# 硬规则（违反了这次照片就是错的）',
  '1. 「拍什么」写**一句看得见的画面**：在哪、在干什么、什么光。**不要抽象词**（"很美""很有氛围"没用）。',
  '2. 只能拍**她此刻有办法拍到的**东西 —— 她在哪，就拍那附近。她**不能**凭空出现在别的地方。',
  '3. ⚠️⚠️ **分清"拍你"和"拍你那儿"**（这是最容易判错的一条）：',
  '   - 「拍张**你**现在的样子 / 来张自拍 / 让我看看你 / 你长什么样」→ withSelf = **true**：他要看的是**你本人**。',
  '   - 「**你那儿**什么样 / 拍张你周围的 / 给我看看教室·外面·你那边的天」→ withSelf = false：他要看的是**环境**。',
  '   - 「发张照片看看」这种**两边都行**的：她写了 `[拍照]` 就 true、写了 `[拍]` 就 false；没写就拍她眼前的东西。',
  '   ⚠️ 别把"你现在的样子"当成"你现在的环境" —— 那句话的主语是**她本人**。',
  '   ⚠️⚠️ 写自拍时**绝对不要写"举着手机 / 拿着手机 / 举起手机 / 对着手机"** ——',
  '      自拍时手机在**镜头后面**、画面里根本看不到它；写了它模型就会**把手机画进画面**，',
  '      于是照片变成"别人举着手机在给她拍"（2026-09-22 实测踩过，用户一眼就看出来了）。',
  '      写"看镜头 / 抬眼看镜头 / 对着镜头"就够，**不要提手机**。',
  '4. 群友点名要拍某个地方/东西（"拍张校门"）时，按他说的拍；如果那地方不在她附近，就让照片**没有她**（她自己也没到那儿，但可以想象/以前拍的 → 这种情况 place 写那个地方）。',
  '5. ⚠️⚠️ **光线要平淡，别挑"好看"的光**：',
  '   不要日落、逆光、丁达尔光、樱花、晚霞、风景名胜这种**摄影作品式的光和景** ——',
  '   那是别人扛相机去拍的。手机随手拍是**普通的日常光**：室内顶灯、阴天、便利店的白光、',
  '   教室里那种平光。背景也是**随手一看就是它**的地方，不是精心找的机位。',
  '   用户原话：「感觉画风还是有点不像手机拍出来的，过于完美了」—— 越是"唯美的光"越像相机拍的。',
  '',
  '# 时间和地点',
  '默认**就用下面给的事实**（那是她真实的处境）—— 但你可以把它**细化成照片里看得见的说法**：',
  '事实是"在家（晚上）"，place 就可以写"家里的书桌前"；事实是"在便利店值班"，就写"便利店的收银台后面"。',
  '⚠️ **不许改成和事实矛盾的地方**（事实写"在便利店"，你不能给"教室"）。',
  '只有群友**明确要求了别的时间/地点**（"拍一张昨天的""你上次说的那个地方"）才偏离事实。',
  '实在没什么好细化的，place / time 留空字符串即可。',
  '',
  '# 输出',
  '只输出一行 JSON，**不要任何别的字**：',
  '{"withSelf":true,"what":"...","place":"","time":""}',
].join('\n');

/** 兜底：模型没给出可用 JSON 时，就用"她自己写的意图"或最保守的解读 */
function fallback(facts = {}, marker = null) {
  return {
    shoot: true,
    withSelf: marker ? marker.withSelf : false,
    what: String(marker?.scene ?? '').trim() || '随手拍下眼前的样子',
    place: '',
    time: '',
    fallback: true,
    where: facts.where || '',
  };
}

/**
 * @param {{text?:string, said?:string, context?:string, facts?:{now?:string,where?:string,doing?:string}}} p
 * @returns {Promise<{shoot:boolean, withSelf:boolean, what:string, place:string, time:string}>}
 */
export async function plan(p = {}) {
  const facts = p.facts ?? {};
  const user = [
    '# 她此刻的真实处境（这是事实，不是她的想象）',
    `- 现在的时间：${facts.now || '（未知）'}`,
    `- 她此刻在哪、在做什么：${facts.where || '（未知）'}${facts.doing ? `，${facts.doing}` : ''}`,
    '',
    '# 群里最近的对话（从旧到新）',
    p.context || '（没有更多上下文）',
    '',
    '# 群友刚才说的',
    p.text || '（空）',
    '',
    '# 她准备回的（里面的标记表示她想拍一张）',
    p.said || '（空）',
    '',
    '# 她自己写的意图',
    p.marker
      ? `- 她写的是「${p.marker.raw}」（"${p.marker.withSelf ? '拍照' : '拍'}"，暗示画面里${p.marker.withSelf ? '有' : '没有'}她本人）` +
        (p.marker.scene
          ? `\n- 她还写明了想拍什么：${p.marker.scene}（**尽量尊重**，除非和上面的事实矛盾）`
          : '\n- 她**没写**具体拍什么 → 就看上面的对话和你对事实的理解')
      : '（没有标记 —— 那就完全靠对话判断）',
    '',
    '这次该拍一张什么样的照片？',
  ].join('\n');

  const timeoutMs = Math.max(2000, Number(config.imagegen?.planTimeoutMs) || 10000);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('拍照理解超时')), timeoutMs);

  let raw = '';
  try {
    for await (const chunk of streamChat(
      [
        { role: 'system', content: PROMPT },
        { role: 'user', content: user },
      ],
      ctl.signal,
    )) {
      raw += chunk;
      if (raw.length > 600) break; // 够解析了
    }
  } catch (e) {
    log.warn(`[拍照理解] 调用失败（${e.message}），用兜底解读`);
    return fallback(facts, p.marker);
  } finally {
    clearTimeout(timer);
  }

  const m = String(raw).match(/\{[\s\S]*\}/);
  if (!m) {
    log.warn(`[拍照理解] 没给出 JSON（${String(raw).slice(0, 60)}），用兜底解读`);
    return fallback(facts, p.marker);
  }

  let j;
  try {
    j = JSON.parse(m[0]);
  } catch (e) {
    log.warn(`[拍照理解] JSON 解析失败（${e.message}），用兜底解读`);
    return fallback(facts, p.marker);
  }

  // ⚠️ 截到 80 字（原来 120）：官方建议中文提示词别超 300 字，
  //    而固定的画风段本来就占 ~200 字。场景写太长会让模型"信息分散、忽略细节"。
  const what = String(j.what ?? '').trim().slice(0, 80);
  const out = {
    // ⚠️ 标记是她自己写的，所以默认就是"要拍"；这一栏只用来挡"模型判断这根本不是在要照片"
    shoot: j.shoot !== false,
    // ⚠️ 判断不出来时**偏向 false**（没有她）：宁可少画一个人，也别在"拍校门"里
    //    硬塞一个她进去 —— 而且没有参考图时凭空画人出来的脸本来就不像她。
    withSelf: j.withSelf === true,
    what: what || fallback(facts, p.marker).what,
    place: String(j.place ?? '').trim().slice(0, 40),
    time: String(j.time ?? '').trim().slice(0, 20),
  };
  log.debug(
    `[拍照理解] withSelf=${out.withSelf} what=「${out.what}」` +
      `${out.place ? ` place=「${out.place}」` : ' place=用事实'}` +
      `${out.time ? ` time=「${out.time}」` : ' time=用事实'}`,
  );
  return out;
}
