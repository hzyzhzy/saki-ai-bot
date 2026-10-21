/**
 * B站**全自动投稿**（2026-10-22 用户定，A 档 = 生成 + 直接发布）
 *
 * ## 用户原话（这一版就是照着这些改的）
 *   「A，设置一个时间段，每天随机在这段时间制作发送。**由 agent 来做视频、封面、简介全部 agent 完成**。
 *     群里有趣事就发送群里有趣的聊天内容，类型就和刚才做的那个一样，如果没有就自己搜寻
 *     设置好的题材制作视频，如果连续两天都是群里的内容，下一天就必须自己制作题材视频。
 *     然后和手动转发视频一样也加一个自定义输入题材然后制作视频发送的选项。
 *     在功能卡片里新增一个 b 站投稿设置页，所有设置都放在里面」
 *   「加一个，每条视频都要有 live2d 和 saki 自己的台词和语音」
 *   「**改一下，题材不是定死的，分区也不是定死的**，而是输入和 b 站分享的那些标签一样**划定范围**就可以了，
 *     **由 agent 自己搜寻当下比较火的题材创作并自己选好分区**，**只有分享群内趣事这个题材是定死的**，
 *     脚本也是之前写好的，**但是时长也是由 agent 自己决定的**」
 *   「**不是交给模型，是直接交给做视频的 agent，全部统一一起搞**」
 *
 * ## 所以这个文件**只做四件事**（⚠️ 一行内容判断都不许往这里加）
 *   ① **什么时候做**：每天在 `windowStart~windowEnd` 里随机挑一个时刻，一天只做一次
 *   ② **把活整个交给"做视频的 agent"** —— 一段任务说明 + `runTask()`，
 *      题材 / 时长 / 分区 / 台词 / 语音 / 动作 / 群聊挑哪几条 / 封面 / 标题 / 简介 / 上传，
 *      **全部由那个 agent 一条龙干完**（它的作业手册：`docs/bili-agent手册.md`）
 *   ③ **事后硬校验**：Live2D 录像在不在、配音有没有 ≥4 段、成片是不是空文件 ——
 *      不合格就当失败（用户要求「每条视频都要有 live2d 和 saki 自己的台词和语音」）
 *   ④ **记账 + 通知主人**：成功失败都发一条私聊（全自动最怕"挂了没人知道"）
 *
 * ## ⚠️⚠️ 为什么这里**不再调模型**
 *   2026-10-22 之前这一版是"脚本里塞几个 LLM 调用"（自己定题材、自己写台词）。
 *   用户否掉了：「不是交给模型，是直接交给做视频的 agent，全部统一一起搞」——
 *   因为选题要**联网看当下什么在火**、台词要跟**动作/群聊画面**配得上、
 *   标题简介要跟**封面**配得上，这些是一件事，拆成几个独立的小调用反而各说各话 ✗
 *   ⇒ 现在只有**一个** agent 从头干到尾，它自己决定中间每一步 ✓
 *
 * ## ⚠️ 唯一定死的题材
 *   「分享群内趣事」—— 这条走**之前写好的那套流程**（群聊内容当画面底部滚动），
 *   不用 agent 重新发明。是否走这条由 **agent 自己判断**（`streakGroup` 规则由这里告诉它）。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import yaml from 'js-yaml';
import { config, ROOT, stateDir, CONFIG_FILE } from './config.js';
import { log } from './log.js';
import { runTask, busyTask } from './agent-bridge.js';

const TOOLS = join(ROOT, 'tools');
const OUT_DIR = join(ROOT, 'logs', 'bili', 'auto');
const MANUAL = join(ROOT, 'docs', 'bili-agent手册.md');
/** 给做视频那个 agent 的时间上限（配音 2 分 + 出片 3 分 + 上传 2 分 + 余量） */
const AGENT_TIMEOUT_MS = 45 * 60 * 1000;

/** 配置（config.yml 的 `biliPublish` 段；界面「B站投稿设置」页写的也是它） */
export function settings() {
  const c = config.biliPublish || {};
  return {
    enable: c.enable === true,
    windowStart: String(c.windowStart || '20:00'),
    windowEnd: String(c.windowEnd || '23:00'),
    group: String(c.group || ''),
    /** ⚠️ 题材**不是**清单，这里只是"她能聊的范围"（用户 2026-10-22 改口） */
    scope: Array.isArray(c.scope) && c.scope.length
      ? c.scope.map(String).filter(Boolean)
      : ['AI', '二次元', '游戏服务器 / MC', '日常吐槽', '打工 / 兼职'],
    /** 时长由 agent 定；这里只有上限（下限 20 秒写死） */
    durationMax: Math.max(25, Math.min(120, Number(c.durationMax) || 60)),
    /** 兜底分区（agent 自己挑；它挑的名字不在清单里时才用这个） */
    zone: String(c.zone || '生活'),
    zone2: String(c.zone2 || '日常'),
    tags: Array.isArray(c.tags) ? c.tags : ['AI', '日常', 'vlog'],
    groupMaxStreak: Math.max(1, Number(c.groupMaxStreak) || 2),
    notifyOwner: c.notifyOwner !== false,
  };
}

/* ── 状态（一天只跑一次、连续群聊天数、历史记录） ── */
const statePath = () => join(stateDir(), 'bili-publish.json');
export function loadState() {
  try {
    const j = JSON.parse(readFileSync(statePath(), 'utf8'));
    return {
      lastDay: '', nextAt: 0, streakGroup: 0, done: {}, history: [], usedTopics: [],
      /** 指定某天直接发**现成文件**（用户 2026-10-22：「明天投稿的视频先定为今天做的桌面上那个」）
       *  形如 `{ day: '2026-10-22', video: 'E:\\Desktop\\xxx.mp4', note: '' }` */
      queued: null,
      running: false, ...j,
    };
  } catch {
    return {
      lastDay: '', nextAt: 0, streakGroup: 0, done: {}, history: [], usedTopics: [],
      queued: null, running: false,
    };
  }
}
function saveState(s) {
  try {
    mkdirSync(dirname(statePath()), { recursive: true });
    // ⚠️ 必须用 Node 写（PowerShell 的 utf8 会带 BOM ⇒ JSON.parse 直接崩）
    writeFileSync(statePath(), JSON.stringify(s, null, 2), 'utf8');
  } catch (e) { log.warn(`[B站投稿] 存状态失败：${e.message}`); }
}

const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const hhmm = (s) => {
  const m = String(s).match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** 在窗口内挑一个随机时刻（同一天只挑一次，存进状态） */
function planFor(day) {
  const st = loadState();
  if (st.nextAt && st.lastDay === day) return st.nextAt;
  const c = settings();
  const a = hhmm(c.windowStart) ?? 1200; // 20:00
  const b = hhmm(c.windowEnd) ?? 1380;   // 23:00
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const at = lo + Math.floor(Math.random() * Math.max(1, hi - lo));
  const d = new Date();
  d.setHours(Math.floor(at / 60), at % 60, Math.floor(Math.random() * 60), 0);
  const ts = d.getTime();
  saveState({ ...st, lastDay: day, nextAt: ts });
  log.info(`[B站投稿] 今天（${day}）的发布时间定在 ${d.toLocaleTimeString('zh-CN', { hour12: false })}`);
  return ts;
}

/* ── 给主人发通知（全自动最怕"挂了没人知道"） ── */
async function notify(text) {
  const c = settings();
  if (!c.notifyOwner) return;
  try {
    const cfgRaw = yaml.load(readFileSync(CONFIG_FILE, 'utf8')) || {};
    const ob = cfgRaw.onebot || {};
    const url = String(process.env.QQBOT_URL || ob.url || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const token = String(process.env.QQBOT_TOKEN || ob.token || '');
    const owner = String(cfgRaw.ownerQQ || '');
    if (!owner) return;
    await fetch(`${url}/send_private_msg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ user_id: Number(owner), message: text }),
    });
  } catch (e) { log.warn(`[B站投稿] 通知发不出去：${e.message}`); }
}

/** 分区清单（一级 → 二级）。**给 agent 照着选**，它选了不在清单里的就用兜底 */
const ZONES = {
  生活: ['日常', '搞笑', '手工', '绘画', '运动', '汽车', '其他'],
  游戏: ['单机游戏', '网络游戏', '手机游戏', '电子竞技', '桌游棋牌'],
  知识: ['科学科普', '社科·法律·心理', '人文历史', '财经商业', '校园学习', '职业职场', '设计·创意', '野生技术协会'],
  科技: ['数码', '软件应用', '计算机技术', '科工机械', '极客DIY'],
  动画: ['MAD·AMV', 'MMD·3D', '短片·手书·配音', '手办·模玩', '综合'],
  娱乐: ['综艺', '明星综合', '娱乐杂谈', '粉丝创作'],
  音乐: ['原创音乐', '翻唱', '演奏', '音乐综合'],
  鬼畜: ['鬼畜调教', '音MAD', '人力VOCALOID', '鬼畜剧场'],
  美食: ['美食制作', '美食侦探', '美食测评', '田园美食', '美食记录'],
  动物圈: ['喵星人', '汪星人', '野生动物', '动物综合'],
};
const zoneListText = () =>
  Object.entries(ZONES).map(([z1, subs]) => `  ${z1}：${subs.join('、')}`).join('\n');

/**
 * 组这段任务说明 —— **这是这个文件里唯一"给内容定方向"的地方**，而且只给方向和边界，
 * 具体选什么题材、多长、发哪个分区、说什么话，全部由 agent 自己定 ✓
 */
function buildPrompt({ workDir, topic, publish, streak, reuse }) {
  const c = settings();
  const group = c.group || '200000001';

  /* ── ① 复用现成视频（用户指定"明天就发这条"）──────────────────────
   * 用户 2026-10-22：「明天投稿的视频先定为今天做的桌面上那个」
   * ⇒ 这种日子**不做出片**，只写标题/简介/封面/选分区 + 上传。
   *   ⚠️ 也别让它"顺手优化一下"（转码/裁剪会掉画质，而且用户要的就是这条）✗
   */
  if (reuse) {
    return [
      '# 今天的活：把一条**已经做好的**视频发到 B 站（全自动，没人盯）',
      '',
      '## 零、先说清楚：**今天不做视频**',
      `用户已经指定了成品（2026-10-22 定的），直接用它：\`${reuse.video}\``,
      '⚠️ **原样上传**：不要重做、不要转码、不要裁剪、不要重新配音 —— 用户要的就是这个文件 ✗',
      '',
      `⚠️ 你的作业手册（要看的是"上传 + 自检"那几节，以及踩过的坑）：\`${MANUAL}\``,
      '',
      '## 一、你要做的四件事',
      '1. **标题 / 简介 / 标签** —— 必须是她自己的人设（先读 `personas/saki/persona.md`）',
      '   她是祥子（Saki），在一个 MC 服务器的 QQ 群里兼职当客服；短句、不客套、不客服腔',
      '   简介别写"这是旧视频/复用的"这种话，就当今天发的',
      '2. **分区** —— 从下面清单里挑最贴内容的一组（一级 + 二级），名字要一字不差：',
      zoneListText(),
      `   （拿不准就用「${c.zone} / ${c.zone2}」）`,
      '   ⚠️⚠️ **这份清单可能过时**（B站改过分区）—— **以页面上真弹出来的分区为准**：',
      '   清单里没有的名字，就用页面上最贴近的那个，并把它**真实的名字**写进 result.json 的 zone/zone2 ✓',
      '   （2026-10-22 实测：清单里的「生活/日常」已经没了，实际是 vlog）',
      `3. **封面** —— 从这条视频里截一帧 + 标题字 → \`${join(workDir, 'cover.jpg')}\``,
      '   ⚠️ `drawbox` 的 `t=fill` 在本机 ffmpeg 3.0.1 上不认 ⇒ 用 `t=<高度>`',
      '4. **上传**：',
      '   ```',
      `   node "${join(TOOLS, 'bili-upload.mjs')}" --video "${reuse.video}" \\`,
      '     --title "…" --desc "…" --zone "<一级>" --zone2 "<二级>" --tags "…" \\',
      `     --cover "${join(workDir, 'cover.jpg')}"${publish ? ' --publish' : ''}`,
      '   ```',
      publish ? '   （**--publish = 直接发出去**，今天这条是要真发的）' : '   （今天只填表、别点发布）',
      '',
      '## 二、干完必须写这个文件（脚本靠它记账和校验）',
      `\`${join(workDir, 'result.json')}\`：`,
      '```json',
      '{"ok":true,"source":"reuse","topic":"这条讲什么","title":"B站标题","desc":"简介",',
      ' "tags":["…"],"zone":"生活","zone2":"日常","duration":34,',
      ` "video":"${reuse.video.replace(/\\/g, '\\\\')}","cover":"<封面绝对路径>","uploaded":true,"note":"…"}`,
      '```',
      '⚠️ 失败也要写，`ok` 设 false 并在 `note` 里写清卡在哪一步。',
      '',
      '## 三、禁止事项',
      '- 🚫 不许往任何 QQ 群/私聊发消息（这是全自动的，你只在机器上干活）',
      `- 🚫 不许动那个成品文件本身（只读它）`,
      '',
      '## 四、今天的状态',
      `- 日期：${dayKey()}`,
      `- 你的工作目录（产物都放这儿）：\`${workDir}\``,
      reuse.note ? `- 用户的备注：${reuse.note}` : '',
      '',
      '干完之后 stdout 只回一句人话：发了什么、标题是什么、发没发出去。',
    ].filter((x) => x !== '').join('\n');
  }

  return [
    '# 今天的活：做一条 B 站短视频并发上去（全自动，没人会在旁边盯）',
    '',
    `⚠️⚠️ **先完整读一遍你的作业手册**：\`${MANUAL}\``,
    '里面是全部流程、固定设定、六步管线、自检清单和踩过的坑。**照它做，别自己另发明一套**。',
    '',
    '## 一、这条视频要满足的硬要求（用户定的，不可变通）',
    '1. **必须有你的 Live2D 形象**（半身、会张嘴对口型、有手部/头部动作）—— 没有这条不算成品 ✗',
    '2. **台词全部是你自己说的话**（第一人称），并且**配成真人语音**（IndexTTS），不是字幕、不是旁白',
    '3. **竖屏 1080×1920**，字幕大、居中',
    '4. **不碰政治、真人隐私、骂战、低俗**',
    '5. ⚠️⚠️ **台词必须是她自己的人设**（用户 2026-10-22 特意补的一条）：',
    '   动笔前**先读** `personas/saki/persona.md`（她的说话方式、态度、她经历过什么、在意什么），',
    '   用**她自己的说法**写 —— 有她的口气、她的看法、她的小习惯、该嘴硬就嘴硬。',
    '   尤其**自制题材**那种最容易写成"科普 / 讲解 / 人生感悟"——那是任何人套上都能说的废话 ✗',
    '   判断标准：把台词里的"我"换成别人，还说得通 ⇒ 就是没带上她的人设，重写。',
    '',
    '## 二、题材（用户 2026-10-22 改口，别做错）',
    '⚠️ **题材不是定死的**。你只能在这个**范围**里选：',
    ...c.scope.map((s) => `  · ${s}`),
    '',
    '怎么选：',
    '- **自己去搜"当下在火什么"** —— B 站热门榜 / 搜索联想词 / 各方向的真实视频播放量',
    '  （工具：`node "' + TOOLS + '\\bili.mjs" hot` 拿热门榜；`search 关键词` 搜视频；',
    '   `tools/bili-upload.mjs` 旁边的 `src/search.js` 里也有接口，用现成命令最快）',
    '- 从里面挑一个**跟你的身份对得上**的角度：你是在一个 MC 服务器 QQ 群里兼职当客服的祥子，',
    '  平时帮人查东西、写东西，自己也做视频 —— 讲"这个话题你能讲、别人讲不出的东西"',
    '- 🚫 别照抄别人的热门视频，别做新闻搬运',
    '- 🚫 别跟你最近做过的重复（下面"最近做过"里列了）',
    '',
    '**唯一定死的题材是「分享群内趣事」**：',
    `- 群号 \`${group}\`，消息在 \`${join(ROOT, 'state', 'recent.json')}\` 里`,
    '- 群里真有事发生（谁在折腾什么、互相吐槽、聊了个好玩的东西）⇒ 就做这个，',
    '  **用之前已经写好的那套流程**（群聊内容当画面底部滚动的背景），别重新发明',
    '- 只是碎话、复读、表情 ⇒ 别硬做，走上面的"自己找题材"',
    streak.forced
      ? `- ⚠️⚠️ **今天必须做自制题材**（不是群聊）：已经连续 ${streak.group} 天用的是群聊内容，用户明确要求隔一天必须自制 ✗`
      : (streak.group ? `- （目前连续 ${streak.group} 天用了群聊内容；到 ${c.groupMaxStreak} 天就必须改自制）` : ''),
    '',
    '## 三、时长和分区也由你自己定',
    `- **时长**：按内容实际需要定，**20~${c.durationMax} 秒之间**。别为凑时长灌水，也别硬压。`,
    '  ⚠️ 手册里那条「**先定时长，再压配音**」照旧 —— 定了多长，配音就用 `tools/fit-audio.mjs` 卡到多长',
    '- **分区**：从下面这份清单里挑**最贴内容**的一组（一级 + 二级），名字要**一字不差**（上传脚本按名字点）：',
    zoneListText(),
    `  （拿不准就用「${c.zone} / ${c.zone2}」）`,
    '  ⚠️⚠️ **这份清单可能过时**（B站改过分区）——**以页面上真弹出来的分区为准**：',
    '  清单里没有的名字，就用页面上最贴近的那个，并把它**真实的名字**写进 result.json 的 zone/zone2 ✓',
    '  （2026-10-22 实测：清单里的「生活/日常」已经没了，实际是 vlog）',
    '',
    '## 四、干活的顺序（一条龙，别中途停下等人）',
    `1. 定题材 / 时长 / 分区（读下面"今天的状态"和最近做过的东西）`,
    `2. 写台词 → \`${join(workDir, 'lines.json')}\`（格式照手册）`,
    '3. 出片：一条命令，别一步步手搓（`--auto` 会让管线自己把动作表和群聊记录排出来）',
    '   ```',
    `   node "${join(TOOLS, 'bili-pipeline.mjs')}" --group ${group} --lines "${join(workDir, 'lines.json')}" \\`,
    `     --voice "${join(workDir, 'voice')}" --duration <你定的秒数> --force-tts --auto \\`,
    `     --out "${join(workDir, 'video.mp4')}" --no-desktop`,
    '   ```',
    '   ⚠️ 动作表和群聊挑选是**你来做**：跑完 `--auto` 那个草稿后，**自己读一遍**',
    '   `logs/bili/actions.json` 和 `logs/bili/chat_picked.json`，不对就自己改（手册里有标准）',
    `4. 封面：从录屏截一帧 + 标题字 → \`${join(workDir, 'cover.jpg')}\``,
    '',
    '   ⚠️⚠️ **自制题材（不是群内趣事）必须加 AE 片头**（用户 2026-10-22：',
    '   「群里的趣事类不用变，**agent 自己搜集题材做的才要用上 ae**」）——',
    '   群聊那条**不要**加（它是纪实感，加了反而假）：',
    '   ```',
    `   node "${join(TOOLS, 'ae-intro.mjs')}" --line1 "<大标题 10 字内>" --line2 "<副标题 18 字内>" \\`,
    `     --out "${join(workDir, 'intro')}"`,
    '   ```',
    `   然后把 \`--intro "${join(workDir, 'intro')}"\` 传给**合成**那一步 —— 它会叠在**前 3 秒**，`,
    '   时间轴一个字都不动（不要自己 concat，那样口型/字幕全要重算）✓',
    '   ⚠️ AE 渲一次 1~3 分钟，也可能失败 ⇒ **别卡在这里**：失败就把原因写进 `result.json` 的 `note`，',
    '   没有片头照样发（片头是加分项，不是硬要求）✓',
    '',
    '5. 自检**必须过**（手册"步骤 6"）：抽帧看音画同步、看有没有张嘴、看片尾字幕有没有被裁',
    '6. 上传：',
    '   ```',
    `   node "${join(TOOLS, 'bili-upload.mjs')}" --video "${join(workDir, 'video.mp4')}" \\`,
    '     --title "…" --desc "…" --zone "<一级>" --zone2 "<二级>" --tags "…" \\',
    `     --cover "${join(workDir, 'cover.jpg')}"${publish ? ' --publish' : ''}`,
    '   ```',
    publish
      ? '   （**--publish = 直接发出去**，今天这条是要真发的）'
      : '   （今天是**手动试做**，别带 --publish，只把表单填好、别点发布）',
    '',
    '## 五、干完必须写这个文件（脚本靠它记账和校验，不写就当失败）',
    `\`${join(workDir, 'result.json')}\`：`,
    '```json',
    '{"ok":true,"source":"group|topic","topic":"今天这条讲什么","title":"B站标题",',
    ' "desc":"简介","tags":["…"],"zone":"生活","zone2":"日常","duration":42,',
    ' "video":"<成片绝对路径>","cover":"<封面绝对路径>","uploaded":true,"note":"踩了什么坑/有什么要留意的"}',
    '```',
    '⚠️ 失败了也要写，把 `ok` 设成 false 并用 `note` 写清卡在哪一步（不要只在 stdout 里说）',
    '',
    '## 六、禁止事项',
    '- 🚫 **不许往任何 QQ 群/私聊发消息**（这条是全自动的，你只在机器上干活）',
    '- 🚫 不许把中间产物散落在工作区之外',
    '- 🚫 不许跳过 Live2D、不许用静音/占位配音糊过去',
    '',
    '## 七、今天的状态',
    `- 日期：${dayKey()}`,
    `- 你的工作目录（产物都放这儿）：\`${workDir}\``,
    topic ? `- ⚠️ **用户指定了题材**：${topic}（就用它，不用自己找）` : '- 题材：按上面第二节自己定',
    `- 最近做过的（别重复）：${(loadState().usedTopics || []).slice(-6).join(' / ') || '（还没有）'}`,
    '',
    '干完之后 stdout 只回一句人话：做了什么、多长、发没发出去。',
  ].join('\n');
}

/* ── 跑一单 ── */
let busy = false;
let currentKill = null;
export function isBusy() { return busy; }

/**
 * 立刻做一条（定时到点 / 界面手动触发）。
 * @param {{topic?:string, publish?:boolean}} opt
 */
export async function runOnce({ topic = '', publish = true } = {}) {
  if (busy) { log.warn('[B站投稿] 上一条还没跑完，跳过'); return { ok: false, why: 'busy' }; }

  // ⚠️ 做视频要跑十几分钟，会**独占** DSH agent（同时只跑一个活）。
  //    别的活正在干（群任务/私聊派活）⇒ 不抢，10 分钟后再看（tick 每 30 秒会再来）。
  const other = busyTask();
  if (other) {
    log.info(`[B站投稿] agent 正在干别的活（${String(other).slice(0, 24)}）⇒ 这一轮先不做`);
    return { ok: false, why: 'agent-busy' };
  }

  busy = true;
  const c = settings();
  const st = loadState();
  const day = dayKey();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const workDir = join(OUT_DIR, stamp);
  mkdirSync(workDir, { recursive: true });

  const streak = { group: Number(st.streakGroup) || 0, forced: (Number(st.streakGroup) || 0) >= c.groupMaxStreak };

  /* 用户指定了"今天直接发这个现成文件"（2026-10-22：「明天投稿的视频先定为今天做的桌面上那个」）
   * ⚠️ 只认**当天**那条：`queued.day` 对不上就当没有（免得以后哪天又把它发一遍）✗ */
  const q = st.queued;
  const reuse = q && String(q.day || '') === day && q.video && existsSync(String(q.video))
    ? { video: String(q.video), note: String(q.note || '') }
    : null;
  if (q && !reuse) log.info(`[B站投稿] 预设视频对不上今天（${q.day || '?'} / 文件${q.video ? '在' : '不在'}）⇒ 按平常做`);

  try {
    const prompt = buildPrompt({ workDir, topic: String(topic || '').slice(0, 200), publish, streak, reuse });
    writeFileSync(join(workDir, 'task.txt'), prompt, 'utf8');
    log.info(`[B站投稿] 把活交给做视频的 agent（工作目录 ${workDir}）${topic ? '｜指定题材：' + topic : ''}`);

    // ⚠️ `permission: danger-full-access`：它要写项目里的 logs/、跑 Playwright 上传 B 站、
    //    读 state/recent.json —— 这些都在 `cwd`（工作目录）之外，
    //    `workspace-write` 会被拒 ⇒ 会表现为"上传那一步莫名其妙失败" ✗
    const { promise, kill } = runTask(prompt, {
      cwd: workDir,
      rawPrompt: true,
      permission: 'danger-full-access',
      timeoutMs: AGENT_TIMEOUT_MS,
    });
    currentKill = kill;
    const timer = setTimeout(() => {
      log.warn(`[B站投稿] agent 超过 ${Math.round(AGENT_TIMEOUT_MS / 60000)} 分钟没干完 ⇒ 停掉`);
      try { kill(); } catch { /* ignore */ }
    }, AGENT_TIMEOUT_MS);

    const res = await promise;
    clearTimeout(timer);
    currentKill = null;

    const said = String(res?.stdout || '').trim();
    log.info(`[B站投稿] agent 回来了（exit ${res?.code}）：${said.slice(0, 160) || '（没说话）'}`);

    // ① 读它写的 result.json
    let r = {};
    try { r = JSON.parse(readFileSync(join(workDir, 'result.json'), 'utf8')); } catch { /* 下面按缺文件处理 */ }

    // ② 硬校验（用户要求「每条视频都要有 live2d 和 saki 自己的台词和语音」）
    //    ⚠️ 复用现成视频那天（`reuse`）**不查 Live2D/配音** —— 那天根本没跑管线，
    //       查了必然失败。改查：那个文件还在、够大、agent 写了 result.json ✓
    const video = String(r.video || (reuse ? reuse.video : join(workDir, 'video.mp4')));
    const voiceDir = join(workDir, 'voice');
    const wavCount = existsSync(voiceDir)
      ? readdirSync(voiceDir).filter((f) => /^v\d+\.wav$/i.test(f)).length
      : 0;
    const l2dMeta = join(ROOT, 'logs', 'bili', 'l2d_take', 'meta.json');
    const sizeMb = existsSync(video) ? statSync(video).size / 1024 / 1024 : 0;

    if (!existsSync(video)) throw new Error('失败：没有成片' + (r.note ? '（' + r.note + '）' : ''));
    if (sizeMb < 1) throw new Error(`失败：成片只有 ${sizeMb.toFixed(2)}MB（疑似空文件）`);
    if (!reuse) {
      if (!existsSync(l2dMeta)) throw new Error('失败：没有 Live2D 录像（人物缺失）');
      if (wavCount < 4) throw new Error(`失败：配音只有 ${wavCount} 段（她的语音缺失）`);
    }
    if (!existsSync(join(workDir, 'result.json'))) throw new Error('失败：agent 没写 result.json（没法记账/通知）');
    if (r.ok === false) throw new Error('失败：' + String(r.note || 'agent 报的'));

    log.info(
      reuse
        ? `[B站投稿] 校验通过（复用现成视频）：${video} ${sizeMb.toFixed(1)}MB ✓`
        : `[B站投稿] 校验通过：Live2D ✓ 配音 ${wavCount} 段 ✓ 成片 ${sizeMb.toFixed(1)}MB ✓` +
          ` 时长 ${r.duration || '?'}s 分区 ${r.zone || '?'}/${r.zone2 || ''}`,
    );

    // ③ 记账
    const st2 = loadState();
    st2.history = [{
      at: new Date().toISOString(), day,
      source: String(r.source || 'topic'),
      topic: String(r.topic || ''),
      title: String(r.title || ''),
      ok: true, video, duration: Number(r.duration) || 0,
      zone: String(r.zone || ''), zone2: String(r.zone2 || ''),
    }, ...(st2.history || [])].slice(0, 60);
    if (r.source === 'group') st2.streakGroup = (st2.streakGroup || 0) + 1;
    else {
      st2.streakGroup = 0;
      if (r.topic) st2.usedTopics = [...new Set([...(st2.usedTopics || []), String(r.topic)])].slice(-10);
    }
    st2.done = { ...(st2.done || {}), [day]: true };
    // 复用那条已经发掉了 ⇒ 清掉预设（否则哪天忘了，它会把这同一条又发一遍 ✗）
    if (reuse) st2.queued = null;
    saveState(st2);

    await notify(
      `B站投稿完成 ✅\n标题：${r.title || '（没写）'}\n` +
      `来源：${reuse ? '复用的成品（用户指定）' : r.source === 'group' ? '群聊内容' : '自制题材'}` +
      `${r.topic ? '（' + r.topic + '）' : ''}\n` +
      `时长 ${r.duration || '?'}s · 分区 ${r.zone || '?'}${r.zone2 ? '/' + r.zone2 : ''}\n` +
      (r.uploaded ? '已发布' : '已填表未发布') +
      (r.note ? `\n备注：${String(r.note).slice(0, 200)}` : ''),
    );
    return { ok: true, title: r.title || '', video, cover: r.cover || '' };
  } catch (e) {
    log.error(`[B站投稿] ${e.message}`);
    saveState({
      ...loadState(),
      history: [{
        at: new Date().toISOString(), day, ok: false, why: e.message,
      }, ...(loadState().history || [])].slice(0, 60),
    });
    await notify(`B站投稿失败 ❌\n原因：${String(e.message).slice(0, 300)}\n工作目录：${workDir}`);
    return { ok: false, why: e.message };
  } finally {
    busy = false;
    currentKill = null;
  }
}

/* ── 定时入口：index.js 每 30 秒调一次 ── */
export function tick() {
  const c = settings();
  if (!c.enable) return;
  const day = dayKey();
  const st = loadState();
  if (st.done && st.done[day]) return;             // 今天已经做过了
  const at = planFor(day);
  if (Date.now() < at) return;
  if (busy) return;
  log.info('[B站投稿] 到点了，开始今天的自动投稿');
  void runOnce({ publish: true });
}

/** 给界面看的当前状态 */
export function status() {
  const c = settings();
  const st = loadState();
  const day = dayKey();
  return {
    enable: c.enable,
    window: `${c.windowStart}~${c.windowEnd}`,
    nextAt: st.lastDay === day && st.nextAt ? new Date(st.nextAt).toLocaleString('zh-CN', { hour12: false }) : '（未排）',
    todayDone: !!(st.done && st.done[day]),
    streakGroup: st.streakGroup || 0,
    groupMaxStreak: c.groupMaxStreak,
    running: busy,
    history: (st.history || []).slice(0, 10),
  };
}
