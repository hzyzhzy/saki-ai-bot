/**
 * 提示词快照：证明「把人设抽出代码」没有改变她的任何一句话（2026-09-21 加）。
 *
 * ## 为什么需要它
 *   做「人设模块化」时要把散在 `llm.js` / `bot.js` / `life.js` … 里的人设文案
 *   抽成 `identity.json` + 占位符。**这类改动最容易悄悄改味** ——
 *   少一个「⚠️」、把「客服 Saki」写成「客服小祥」、语气词漏掉，
 *   代码照样跑、测试照样绿，但她在群里说话就变味了。
 *
 *   ⇒ 所以给"改之前 / 改之后"的**完整提示词逐行做 diff**：
 *     抽完代码之后，这个套件必须是**全绿**的（一个字都没变）。
 *     它红了 = 我改味了，而不是"快照过时了"。
 *
 * ## 用法
 *   node test/prompt-snapshot.js            # 和基线对比（回归里跑的就是这个）
 *   node test/prompt-snapshot.js --save     # 存/更新基线（**故意**改人设时才用）
 *
 * ## ⚠️ 三条必须知道的
 *   ① **快照文件放 `state/`，不许进公开副本** —— 提示词里含真实 QQ 号与群号
 *      （实测一个场景就命中 10 行）。`state/` 已被 gitignore。
 *   ② **改了知识库也会让快照变** —— 这是对的（人设变了嘛），
 *      但要清楚：那说明你动了人设，不是我改了代码。
 *   ③ 归一化只处理"每次都不一样"的部分（今天几号、几点），
 *      其余**逐字节**比。别为了让它变绿去放宽归一化 —— 那等于把哨兵拆了。
 * 用法: node test/prompt-snapshot.js
 */

// ⚠️⚠️ 隔离环境必须在 import 业务模块**之前**设好 —— 但 ESM 的静态 import 会被提升，
//     所以下面这一整段只能用**动态 import**（静态写法会让 env 晚一步生效，
//     快照就会读到真实的 recent/好感度/说说记录，每次跑都不一样）。
const ISOLATED = {
  QQBOT_RECENT_FILE: 'logs/__snap-recent.json',
  QQBOT_AFFINITY_FILE: 'logs/__snap-affinity.json',
  QQBOT_NAMES_FILE: 'logs/__snap-names.json',
  QQBOT_QZONE_FILE: 'logs/__snap-qzone.json',
  QQBOT_DIGEST_FILE: 'logs/__snap-digest.json',
  QQBOT_OBSERVE_FILE: 'logs/__snap-observe.json',
  QQBOT_STORYLINE_FILE: 'logs/__snap-story.json',
  QQBOT_LIFE_FILE: 'logs/__snap-life.json',
  QQBOT_QUEST_FILE: 'logs/__snap-quest.json',
  QQBOT_FRIEND_FILE: 'logs/__snap-friend.json',
  QQBOT_OUTBOX_FILE: 'logs/__snap-outbox.json',
  QQBOT_TIC_FILE: 'logs/__snap-tic.json',
  QQBOT_MEAL_FILE: 'logs/__snap-meal.json',
  QQBOT_WHERE_FILE: 'logs/__snap-where.json',
  QQBOT_REMIND_FILE: 'logs/__snap-remind.json',
  QQBOT_MAMA_FILE: 'logs/__snap-mama.json',
  QQBOT_SPEND_FILE: 'logs/__snap-spend.json',
  QQBOT_BALANCE_FILE: 'logs/__snap-balance.json',
  QQBOT_MONTHLY_FILE: 'logs/__snap-monthly.json',
  QQBOT_NAPCAT_REQ_FILE: 'logs/__snap-napcatreq',
  QQBOT_LOCK_FILE: 'logs/__snap.lock',
};
for (const [k, v] of Object.entries(ISOLATED)) process.env[k] = v;

const { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, cpSync } = await import('node:fs');
const { join, dirname } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// ⚠️ 放 state/（gitignore）—— 提示词里有真实号，绝不能进公开副本
const SNAP_FILE = process.env.QQBOT_PROMPT_SNAPSHOT || join(ROOT, 'state', '__prompt-snapshot.json');
const saveMode = process.argv.includes('--save');

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

/**
 * 归一化：只替换「每次跑都不一样」的东西。
 * ⚠️ 规则要**紧**着写 —— 放宽一条就等于在这里挖掉一个哨兵。
 */
function normalize(s) {
  // ⚠️ 用"按行状态机"处理**会整段变**的东西（见下面那两条注释）
  let inLive = false;
  let inTime = false;
  let inFaces = false;
  const lines = String(s)
    // ⚠️⚠️ 按 `\r?\n` 切，**不是**按 `\n` 切：同一段提示词在 JS 源码里是 CRLF、
    //    搬到 md 之后可能是 LF（或反过来），而 `\n` 切法会把 `\r` 留在行尾 ⇒
    //    报"131 行有 130 行不同"，盯着两行一样的字看半天（2026-09-21 实测）。
    //    行尾风格**不是人设内容**（对模型都是换行），归一化掉才对。
    .split(/\r?\n/)
    .map((line) => {
      // ⚠️⚠️ `machine.js` 注入的**本机实时状态**（主机名 / CPU 占用 / 内存 / 系统盘 /
      //    显卡 / 电池 / 已开机）—— **每次跑都不一样**。
      //     实测踩过：第一次跑 CPU 占用 39%，第二次 30% ⇒ 快照永远红，
      //     而"永远红"的哨兵等于没有哨兵（人会开始无视它）。
      //     ⚠️ 整行换掉：这是环境信息，跟人设一个字都不沾，规则宽一点零风险。
      // ⚠️⚠️ **别要求后面跟冒号**：`系统盘剩余：102.4 GB` 里"系统盘"后面跟的是"剩余"，
      //     第一版写成 `(系统盘|…)[：:]` 就漏了它 ⇒ 快照又因为磁盘剩余变了 0.1GB 而红（实测）。
      if (/^(主机名|CPU|内存|系统盘|显卡|电池|已开机)/.test(line)) return '<MACHINE>';

      // ⚠️⚠️ 「## 现在的时间」这一节**整节随时段变**（2026-09-21 踩出来的）：
      //     23:01 跑是「（深夜）」+ 一段「深夜。**语气上软一点…**」，
      //     白天跑是「（晚上）」而且**没有**那段 ⇒ 连归一化后的**行数**都不一样
      //     （1947 → 1949）⇒ 跨时段跑快照必然红，还会被误当成"改了人设"。
      //     ⚠️ 这一节是**环境数据**（现在几点、她这个点该在哪、今天是不是节假日），
      //        不是人设内容 —— 整节吃掉不会削弱"检测人设改动"的能力。
      //     ⚠️ 实测它还兜住了「今天 <DATE>，**放假**（敬老の日）」那几行
      //        （也是随日期变的）⇒ 跨天跑也不会红。
      //     ⚠️ 结束条件必须是**下一个 `## `**（不是任意标题）：因为
      //        「### ⏰ 这个点你应该在哪」和它下面的内容也属于这一节。
      if (/^## 现在的时间/.test(line)) {
        inTime = true;
        return '## 现在的时间 <NOW_BLOCK>';
      }
      if (inTime) {
        if (/^## /.test(line)) {
          inTime = false;
          return line;
        }
        return null;
      }

      // ⚠️⚠️ 「→ 现在 HH:MM，按你的一天：<时段描述>」这一行**随时段变**。
      //     实测踩过：21:5x 跑是「不上学的白天 —— 可能在客服室排班…」，
      //     22:0x 再跑就成了「在家（晚上，写作业/练琴…）」⇒ 同一批改动看起来**偶发红**，
      //     而"偶发红"的哨兵等于没有哨兵。时段不是人设，整行归一化。
      if (/^→ 现在/.test(line)) return '→ 现在 <NOW>；按你的一天：<WHEN>';

      // ⚠️⚠️ MC 服务器的**实时在线情况** —— 这个比机器状态还活：几分钟就变一次。
      //     实测踩过两次：先是「大约 24 分钟前 → 27 分钟前」，
      //     后来整段从「现在没人在线」变成「<主人>：在线约 5 分钟」（有人上线了）。
      //     ⇒ 所以不只归一化"多久前"，**整段**都得吃掉（从标题吃到下一个标题）。
      //     ⚠️ 它是环境数据、不是人设 —— 归一化它**不会**削弱"检测人设改动"的能力，
      //        因为我们本来就不该拿服务器在线状况当人设的哨兵。
      if (/^#{1,3} 【在线(情况|时长)】/.test(line)) {
        inLive = true;
        return '# 【在线状态】<LIVE>';
      }
      if (inLive) {
        if (/^#{1,3} /.test(line)) {
          inLive = false; // 碰到下一个标题 ⇒ 这段结束了
          return line;
        }
        // ⚠️⚠️ 中间的行**全部丢掉**，不要一行换一个 `<LIVE>` ——
        //     那段的行数**本身就在变**（「现在没人在线」是一行，列出几个人就是好几行），
        //     按行替换会让"归一化之后的行数"也跟着变 ⇒ 后面**所有行错位**，
        //     报出来是"上百行不同、还少一行"，看着像大改，其实只是错位（2026-09-21 实测踩过）。
        return null;
      }

      // ⚠️⚠️ 2026-10-06 加：**表情库整段吃掉**（她一直在自己收表情：64 → 66 → …）。
      //    起因：我改了黑祥人设，跑这个套件却红了 8 个场景、报"两百行不同" ——
      //    真相是**表情库涨了 2 张**（运行期数据），跟人设一个字都不沾。
      //    只归一化「你手上有 N 张」那句**不够**：多一张表情就多一行，
      //    行数一变后面全都错位 ⇒ 又变成"看着像大改"。
      //    ⇒ 从「你手上有 N 张表情包」那句开始，吃到下一个标题为止，整段折成一行
      //      （和上面 `inLive` 同一个写法、同一个理由）。
      //    ⚠️ 表情能不能发、发哪张、标记剥没剥干净，有 `test/face.js` 专门盯 ——
      //       人设回归本来就不该拿表情库当哨兵。
      if (/你手上有 \d+ 张表情包/.test(line)) {
        inFaces = true;
        return '[表情库] <FACES>';
      }
      if (inFaces) {
        if (/^#{1,3} /.test(line)) {
          inFaces = false;
          return line;
        }
        return null;
      }
      return line;
    })
    .filter((x) => x !== null)
    .join('\n');
  return (
    lines
      // 「今天 2026年9月21日 周一，放假」这种"今天"行
      .replace(/今天\s*\d{4}年\d{1,2}月\d{1,2}日\s*周[日一二三四五六]/g, '今天 <DATE> <WEEKDAY>')
      .replace(/\d{4}年\d{1,2}月\d{1,2}日/g, '<DATE>')
      .replace(/\d{4}-\d{2}-\d{2}/g, '<DATE>')
      .replace(/\d{1,2}月\d{1,2}日/g, '<DATE>')
      .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '<TIME>')
      .replace(/周[日一二三四五六]/g, '<WEEKDAY>')
      // ⚠️⚠️ 2026-10-06 加：**表情库是运行期数据**（她会自己收表情、审核新表情，
      //    64 → 66 张是常态）—— 不归一化的话，**每收一次新表情就把这个套件弄红**，
      //    而红的样子是"提示词变了、两百行不同"，看起来像**人设被改坏了**
      //    （今晚就是这么白查了一轮：我明明改的是黑祥人设，红的却是表情数量）。
      //    ⇒ 数量归一成占位符 + 清单行整行归一（表情的"用途说明"不属于人设回归）。
      //    ⚠️ 两条缺一不可：只归一数量的话，新增表情多出来的行照样让行数对不上。
      .replace(/你手上有 \d+ 张表情包/g, '你手上有 N 张表情包')
      .replace(/^\[[^\]\n]+\][^\n]*用于：[^\n]*$/gm, '[表情] 用于：…')
  );
}

// ── 场景集：覆盖几种"提示词形状"完全不同的情况 ─────────
// ⚠️ 加场景要克制：每个场景都是一份 5 万字符的提示词，快照文件会变大。
//    要覆盖的是**结构差异**（群/私聊、服主/群友、戳一戳、带图），不是随机多凑几个。
const G = '200000001';
const OWNER = '10000001';
const MEMBER = '30001';
// ⚠️ 2026-10-07 加：**同类机器人**那条路要用**单独的群号** ——
//    同类池是**按群配**的（`groupParams.<群>.peers`），借用 `G` 会把上面
//    那些场景的提示词也一起改掉（每个都多出"同类"那一节），基线跟着乱。
const GPA = '200000002';
const PEER = '10000009';
const seg = (t) => [{ type: 'text', data: { text: t } }];

const SCENES = {
  'group-at-server': {
    ev: { message_type: 'group', group_id: G, user_id: MEMBER, message: seg('服务器怎么进') },
    text: '服务器怎么进',
  },
  'group-at-chat': {
    ev: { message_type: 'group', group_id: G, user_id: MEMBER, message: seg('今天好累啊') },
    text: '今天好累啊',
  },
  // ⚠️ 2026-09-26 加：**「问某个人是谁」那条路**（`whoIsBrief()` 的"就近摘要"）。
  //
  //    为什么：用户报「机器人不认得几个管理员了，在群里问的时候会直接说不认识」。
  //    查下来信息**确实在提示词里**，但落在 60%~70% 的**中段**，问句在末尾 ⇒ 模型翻不到
  //    （中段迷失）。修法是让 `whoIsBrief()` 也扫服务器库里的人员名录，
  //    把被问到的那一行**单独拎到提示词末尾**。
  //
  //    ⚠️ 这条路径原来**一个场景都没覆盖** —— 我加完 `whoIsBrief` 的改动后，
  //       那 10 个场景**全部逐字节一致**（因为它们的文本都没提到人名）。
  //       「全绿」在这里等于"没测到"，所以必须补这一个场景当哨兵。
  'group-at-who': {
    ev: { message_type: 'group', group_id: G, user_id: MEMBER, message: seg('Luminiflux是谁') },
    text: 'Luminiflux是谁',
  },
  'private-owner': {
    ev: { message_type: 'private', user_id: OWNER, message: seg('在吗') },
    text: '在吗',
  },
  'private-stranger': {
    ev: { message_type: 'private', user_id: '39999', message: seg('你好') },
    text: '你好',
  },
  poke: {
    ev: {
      message_type: 'group',
      group_id: G,
      user_id: MEMBER,
      message: seg('[戳一戳]'),
      _poke: true,
      _pokeText: '捏一捏',
    },
    text: '[戳一戳]',
  },
  // ⚠️ 2026-09-21 加：`gentleHint()`（对方在说自己的烦心事 → 切温柔）那条路
  //    原来不在场景里 ⇒ 抽人设时它**没有保护**。这里补上。
  'group-upset': {
    ev: { message_type: 'group', group_id: G, user_id: MEMBER, message: seg('我太没用了') },
    text: '我太没用了',
  },
  // ⚠️ 2026-09-21 加：**主动接话**那条路（`voluntary`）——「有人聊到你，你自己冒泡接一句」。
  //    那段提示词里也有她的名字，原来不在场景里 ⇒ 抽人设时同样是盲区。
  'group-voluntary': {
    ev: { message_type: 'group', group_id: G, user_id: MEMBER, message: seg('小祥最近怎么样') },
    voluntary: 'mention',
    text: '小祥最近怎么样',
  },
  // ⚠️⚠️ 2026-10-07 加：**同类机器人发来的消息**（`isPeerBot()` 为真）那条路。
  //
  //    为什么必须补这一个：用户截图报「bot 之间的对话很容易陷进吵嘴死循环」，
  //    我为此在那条路上加了一整节「把事往前推，别原地顶嘴」。
  //    加完跑 `--save` —— 结果 **13 个场景逐字节一致** ⇒ 说明**那段提示词
  //    一个场景都没覆盖** ✗（"全绿"在这里恰恰等于"没测到"，和上面
  //    `group-at-who` 那次一模一样）。
  //
  //    ⚠️ 用 `GPA`（单独的群）+ 一个不在任何池里的号当发送者，
  //      这样只影响这一个场景。
  'group-peer-bot': {
    ev: { message_type: 'group', group_id: GPA, user_id: PEER, message: seg('嫌我软就别站风里呗') },
    text: '嫌我软就别站风里呗',
  },
};

// ── 生成 ────────────────────────────────────────────────

// ⚠️⚠️ 2026-09-22 加：**把"玩家在线记录"钉成一份固定历史**。
//
//    为什么要这一手：提示词里那段 `# 【在线情况】` 只在
//    「最后一个人下线距今 ≤ 12 小时」时才输出（见 `src/sessions.js` 的 `sessionsText()`）。
//    以前这里读的是**真实的** `state/player-sessions.json`，于是：
//      · 有人在服务器上玩过 → 那段在  → 基线对得上 ✅
//      · 超过 12 小时没人上  → 那段没了 → 提示词**少一行** → 后面整体错位，
//        报出来是"上百行不同"（2026-09-22 就是这么红的，看着像改了人设）
//    ⇒ 一个哨兵有一半时间是红的 = 没有哨兵。
//
//    ⚠️ 钉住它**不会**削弱"检测人设改动"的能力：这段是**环境数据**，
//       本来就不该当人设的哨兵（和上面归一化 `# 【在线情况】` 整段是同一个理由）。
const SESS_FILE = 'logs/__snapshot-sessions.json';
process.env.QQBOT_SESSIONS_FILE = SESS_FILE;

// ⚠️⚠️ 2026-09-23 加、**2026-09-30 修**：把知识库也钉住。
//
//    为什么需要：这个套件读的是**真实的 `knowledge/`** —— `run-all.js` 的隔离只管
//    `state/*.json`（它自己那句注释就写着「knowledge/ 一直是共用的真实目录」）。
//    于是**群主在群里教一句、或更正一条**，提示词就变 ⇒ 快照无缘无故变红。
//    实测（00:0x）：只有 `group-voluntary` 一个场景变了，多出一段
//    「# 【最高优先级】群主后来补充/更正的知识」—— 它恰好选中了那段。
//
//    ⇒ 首次运行时把**当前的知识库复制一份固定的**（放 `logs/`，不进版本库），
//      之后一直用它 —— 和上面【玩家在线记录】是同一个道理：
//      **哨兵不能取决于会变的东西**。
//
//    ⚠️⚠️ **2026-09-30 的位置修正（这段原来放晚了，等于没生效）**：
//       `src/config.js` 里 `KNOWLEDGE_DIR` 是 `export const`（**import 那一刻**就求值），
//       而这段原来排在 `await import('../src/config.js')` **之后** ⇒
//       env 设晚了一步、常量早就固化成真实 `knowledge/` 了 ⇒ 隔离形同虚设。
//       实测：<主人> 16:10 在群里教学录入一条「服务器新增屏幕广告」，
//       16:18 回归里 `group-at-server` 立刻红（多出那 6 行）。
//       ⇒ 必须排在**任何 `config.js` 的 import 之前**（`ROOT`/`join` 上面已经准备好了）。
const KDIR = 'logs/__snapshot-knowledge';
const kAbs = join(ROOT, KDIR);
if (!existsSync(kAbs)) {
  mkdirSync(kAbs, { recursive: true });
  cpSync(join(ROOT, 'knowledge'), kAbs, { recursive: true });
}
process.env.QQBOT_KNOWLEDGE_DIR = KDIR;
mkdirSync(join(ROOT, 'logs'), { recursive: true });
writeFileSync(
  join(ROOT, SESS_FILE),
  JSON.stringify({
    // `since` 空 = 现在没人在线 ⇒ 走"报最后一个在线的人"那条分支（就是会被归一化那条）
    since: {},
    // `to` 用"半小时前" ⇒ 永远落在 12 小时窗口内 ⇒ 那段**永远在**
    history: [{ name: '（快照占位）', from: Date.now() - 3600000, to: Date.now() - 1800000, minutes: 30 }],
  }),
  'utf8',
);

// ⚠️⚠️ 2026-09-22 加：**把生图钉成"已经配好了"**，别跟着用户的 `config.yml` 变。
//
//    为什么：人设里那段「你可以拍照」**只在 `imagegen.ready().ok` 时才注入**
//    （那是故意的 —— 没配就一个字都不提，免得冒出"相机没带"这种莫名其妙的台词，
//      见 `src/bot.js` 的 `buildSystemPrompt`）。
//    于是用户在管理界面**一开生图**，提示词就多 14 行 ⇒ 快照立刻红，
//    而且报出来像"人设被改了"（2026-09-22 实测：用户启用生图之后就是这么红的）。
//
//    ⇒ **一个哨兵取决于用户的开关 ＝ 没有哨兵**（和上面【在线情况】那段同一个道理）。
//      钉成"开"还有个好处：那段也就进了哨兵的保护范围（以后改它能被抓到）。
const { config: cfg } = await import('../src/config.js');
cfg.imagegen = { ...(cfg.imagegen ?? {}), enable: true, apiKey: 'sk-snapshot-fake' };

// ⚠️ 2026-09-30：**知识库钉住那段搬到前面去了**（`QQBOT_SESSIONS_FILE` 那行下面）——
//    它必须在**第一次 `import('../src/config.js')` 之前**执行，原因见那儿的注释。

const { Bot } = await import('../src/bot.js');

// ⚠️ 2026-10-07 加：给 `group-peer-bot` 那个场景配一个**同类池** ——
//    没有它 `isPeerBot()` 为假，"同类"那一节提示词就不会注入，场景等于白加。
cfg.groupParams ??= {};
cfg.groupParams[GPA] = { ...(cfg.groupParams[GPA] ?? {}), peers: [PEER] };

const bot = new Bot();
bot.selfId = '10002';

const now = {};
for (const [name, s] of Object.entries(SCENES)) {
  try {
    now[name] = normalize(bot.buildSystemPrompt('', s.ev, s.voluntary ?? null, s.text));
  } catch (e) {
    // ⚠️ 生成失败要**大声报**，不能静默跳过 —— 否则"少了一个场景"看起来像全绿
    console.log(`  ❌ 场景 ${name} 生成失败：${e.message}`);
    failures++;
  }
}
// ── 额外场景：不走 `buildSystemPrompt`、但同样是人设文案的那些 ──────
// ⚠️ 为什么需要：`balance.js` 的余额提醒走 `llm.phrase`，不在上面那 5 个场景里 ——
//    抽人设（把提示词里的「<主人>」换成 `address.owner`）时它**没有保护**，
//    改坏了也看不出来。这类"散落在别的调用路径"的提示词在这里补上，别留盲区。
{
  const bal = await import('../src/balance.js');
  const extras = [
    ['balance-remind-critical', () => bal.remindSystem(true)],
    ['balance-remind-low', () => bal.remindSystem(false)],
  ];
  for (const [name, fn] of extras) {
    try {
      now[name] = normalize(fn());
    } catch (e) {
      // ⚠️ 失败要大声报，不能静默跳过 —— 少一个场景看起来像全绿
      console.log(`  ❌ 额外场景 ${name} 生成失败：${e.message}`);
      failures++;
    }
  }
}

// ⚠️ 2026-09-21 加：**空间说说的写作指南**（`qzone-compose.js` 的 POST_GUIDE）——
//    那是一整段身份描写 + 性格 + 分寸，走的是"写说说"那条路，同样不在上面 5 个场景里。
//    抽人设时它是**最大的盲区**（131 行）。
{
  const qz = await import('../src/qzone-compose.js');
  try {
    now['qzone-guide'] = normalize(qz.postGuide());
  } catch (e) {
    console.log(`  ❌ 额外场景 qzone-guide 生成失败：${e.message}`);
    failures++;
  }
}

// ⚠️ 2026-09-26 加：**「账上紧」那一段**（`balance.balanceNote()`）原来**不在任何场景里**。
//
//    用户为这条路报过**两次**问题（先"话术雷同" → 再"每回一句话都夹一句催充钱"），
//    而它**每一轮都注入**（`buildSystemPrompt` 无条件调）、影响面比 `remindSystem` 还大
//    ⇒ 必须有哨兵盯着，不然下次改坏了还是"全绿"。
//
//    ⚠️ 放在**最后**：`setLastForPreview()` 改的是 `balance.js` 的**内部状态**，
//       放中间会污染后面那些场景生成的提示词。
{
  const bal = await import('../src/balance.js');
  try {
    // ⚠️ 两个都要覆盖：**0 元和"快见底"是两句不同的话**（用户 2026-09-26 纠正：
    //    「这个不是快没钱，是完全没钱的状态」）。原来只 mock 了 1.2，测不到 0 那条分支。
    bal.setLastForPreview(0); // 完全没钱
    now['balance-note-empty'] = normalize(bal.balanceNote());
    bal.setLastForPreview(1.2); // 快见底
    now['balance-note-critical'] = normalize(bal.balanceNote());
  } catch (e) {
    // ⚠️ 失败要大声报 —— 少一个场景看起来像全绿
    console.log(`  ❌ 额外场景 balance-note-* 生成失败：${e.message}`);
    failures++;
  }
}

const sceneCount = Object.keys(now).length;
console.log(`\n提示词快照（${sceneCount} 个场景）`);

// ── 收尾：清掉隔离文件，别在 logs/ 留一堆垃圾 ──
for (const v of Object.values(ISOLATED)) {
  try {
    rmSync(join(ROOT, v), { force: true });
  } catch {}
}

/**
 * 存基线前先打印「跟现有基线比，到底变了什么」（2026-10-06 加，用户拍板）。
 *
 * ⚠️ 为什么加：基线**陈旧了两轮没人发现** —— 旧基线连更早加的「黑祥」那一节都没有，
 *    直到下一次回归才报「提示词变了，1837 行不同」，看着像我刚把人设改坏了，
 *    其实只是"该存基线了"这件事被攒了两轮 ⇒ 白查一阵。
 *    ⇒ 让 `--save` 这个动作**自带对照**，别让"存基线"变成一次盲操作。
 *
 * ⚠️ 这里只给**粗块**（首个不同行 → 最后一个不同行），不追求精确 diff：
 *    目的是"一眼看出是不是我这次改的那一节"，够用就行（精确 diff 在回归分支里）。
 */
function printSnapshotDelta(now, oldText) {
  let base;
  try {
    base = JSON.parse(oldText);
  } catch (e) {
    console.log(`  ⚠️ 旧基线读不了（当作没有，直接存新的）：${e.message}`);
    return;
  }
  const names = [...new Set([...Object.keys(base), ...Object.keys(now)])].sort();
  let changed = 0;
  const addedAll = new Map();
  for (const n of names) {
    const a = base[n];
    const b = now[n];
    if (a === undefined) {
      console.log(`  · ${n}：**新增的场景**`);
      changed += 1;
      continue;
    }
    if (b === undefined) {
      console.log(`  · ${n}：**这次没生成出来**（要查，别顺手存了）`);
      changed += 1;
      continue;
    }
    if (a === b) continue;
    changed += 1;
    const la = a.split('\n');
    const lb = b.split('\n');
    let p = 0;
    while (p < la.length && p < lb.length && la[p] === lb[p]) p += 1;
    let s = 0;
    while (s < la.length - p && s < lb.length - p && la[la.length - 1 - s] === lb[lb.length - 1 - s]) s += 1;
    const del = la.slice(p, la.length - s);
    const add = lb.slice(p, lb.length - s);
    console.log(`  · ${n}：${la.length} → ${lb.length} 行（这一段里：删 ${del.length} / 增 ${add.length}）`);
    for (const l of add) addedAll.set(l, (addedAll.get(l) ?? 0) + 1);
  }
  if (!changed) {
    console.log('  ✅ 与现有基线**逐字节一致** —— 这次人设其实没变过，存不存都一样');
    return;
  }
  console.log(`\n  共 ${changed} 个场景变了。新增的行（去重后前 12 条，×N = 在几个场景里都出现）：`);
  [...addedAll.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 12)
    .forEach(([l, n]) => console.log(`    ×${n}  ${l.length > 90 ? `${l.slice(0, 90)}…` : l}`));
  console.log('  ⚠️ 扫一眼上面这些 —— **确认都是你这次有意改的**（不是路径、密钥、测试残留）。');
}

/**
 * 存基线前的敏感内容自检（同一次加的）。
 *
 * ⚠️ **只警告不拦**：余额那几个场景的提示词里本来就可能出现 key 字样，
 *    拦下来会让合法流程卡死。但"存的时候顺手看一眼"成本为零。
 */
function scanSnapshotLeaks(text) {
  const pats = [
    ['绝对路径（C:\\Users…）', /[A-Za-z]:\\Users\\/],
    ['OneDrive 路径', /OneDrive/],
    ['真实 sk- key', /sk-(?!snapshot-fake)[A-Za-z0-9_-]{16,}/],
    ['ark- key', /ark-[a-z0-9-]{16,}/],
    ['OneBot accessToken', /accessToken["'\s:]+[A-Za-z0-9]{16,}/],
  ];
  const hit = pats.filter(([, re]) => re.test(text)).map(([n]) => n);
  if (hit.length) console.log(`  ⚠️ 自检：基线里出现 ${hit.join('、')} —— 确认不是真凭据再往下走`);
  else console.log('  ✅ 自检：没有绝对路径 / 真实 key');
}

// ── 存 或 比 ────────────────────────────────────────────
if (saveMode || !existsSync(SNAP_FILE)) {
  // ⚠️ 2026-10-06：**存之前先对照**（顺序不能反 —— 写完就读不到旧的了）
  if (existsSync(SNAP_FILE)) {
    console.log('\n  ── 跟现有基线比，这次到底变了什么 ──');
    printSnapshotDelta(now, readFileSync(SNAP_FILE, 'utf8'));
    console.log('');
  }
  const text = JSON.stringify(now, null, 1);
  scanSnapshotLeaks(text);
  writeFileSync(SNAP_FILE, text, 'utf8');
  const why = saveMode ? '（--save）' : '（原来没有基线）';
  console.log(`  📝 已存基线 ${why}：${SNAP_FILE}`);
  console.log(`     存完再跑一次**不带 --save** 的，必须零差异。`);
  check(true, `基线已写入（${sceneCount} 个场景）`);
} else {
  let base;
  try {
    base = JSON.parse(readFileSync(SNAP_FILE, 'utf8'));
  } catch (e) {
    console.log(`  ❌ 基线文件读不了：${e.message}`);
    console.log(`     删掉它重跑一次即可：${SNAP_FILE}`);
    failures++;
  }
  if (base) {
    const names = [...new Set([...Object.keys(base), ...Object.keys(now)])];
    for (const n of names) {
      const a = base[n];
      const b = now[n];
      if (a === undefined) {
        check(false, `场景 ${n}：**新增的**（基线里没有）`, '要加就 --save 更新基线');
        continue;
      }
      if (b === undefined) {
        check(false, `场景 ${n}：**基线里有、这次没生成出来**`, '多半是生成抛错了');
        continue;
      }
      if (a === b) {
        check(true, `场景 ${n}：逐字节一致`, `${b.split('\n').length} 行`);
        continue;
      }
      // 报差异：先给统计，再给**前几处**具体行（全打出来会淹掉输出）
      const la = a.split('\n');
      const lb = b.split('\n');
      const diffs = [];
      for (let i = 0; i < Math.max(la.length, lb.length); i++) {
        if (la[i] !== lb[i]) diffs.push(i);
      }
      check(
        false,
        `场景 ${n}：**提示词变了**`,
        `行数 ${la.length} → ${lb.length}，${diffs.length} 行不同`,
      );
      for (const i of diffs.slice(0, 5)) {
        const A = la[i] ?? '(没有这一行)';
        const B = lb[i] ?? '(没有这一行)';
        console.log(`      第 ${i + 1} 行`);
        // ⚠️⚠️ 两句"看起来一模一样"却报不同时，差异在**不可见字符**上
        //     （行尾的 \r、全角空格、不换行空格…）—— 只打文本根本看不出来。
        //     所以这里报**第一个不同的字符位置 + 它的码点**（2026-09-21 吃过这个亏：
        //     盯着两行一样的字看了半天，其实是 CRLF 在作怪）。
        if (A !== B) {
          let k = 0;
          while (k < A.length && k < B.length && A[k] === B[k]) k += 1;
          const codeA = A.charCodeAt(k);
          const codeB = B.charCodeAt(k);
          console.log(
            `        首个不同：第 ${k + 1} 个字符  ` +
              `改前 ${JSON.stringify(A.slice(k, k + 10))}(U+${Number.isNaN(codeA) ? '——' : codeA.toString(16).toUpperCase()})  ` +
              `改后 ${JSON.stringify(B.slice(k, k + 10))}(U+${Number.isNaN(codeB) ? '——' : codeB.toString(16).toUpperCase()})`,
          );
        }
        console.log(`        改前: ${A.slice(0, 110)}`);
        console.log(`        改后: ${B.slice(0, 110)}`);
      }
      if (diffs.length > 5) console.log(`      …还有 ${diffs.length - 5} 行，自行 diff`);
      console.log(`      ⚠️ 如果你**故意**改了人设/知识库，用 --save 更新基线；`);
      console.log(`         否则这就是"改了味"，去把你刚动的地方看一遍。`);
    }
  }
}

// ⚠️ 收尾：把钉住"在线记录"的那份临时状态删掉（`logs/` 不进版本库，但别留垃圾）
try {
  rmSync(join(ROOT, SESS_FILE), { force: true });
} catch {
  /* 删不掉就算了 */
}

console.log(
  failures === 0
    ? '\n结果: 全部通过 ✅（提示词与基线逐字节一致）\n'
    : `\n结果: ${failures} 项失败 ❌\n`,
);
process.exit(failures === 0 ? 0 : 1);
