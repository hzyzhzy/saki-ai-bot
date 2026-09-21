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

const { readFileSync, writeFileSync, existsSync, rmSync } = await import('node:fs');
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
  );
}

// ── 场景集：覆盖几种"提示词形状"完全不同的情况 ─────────
// ⚠️ 加场景要克制：每个场景都是一份 5 万字符的提示词，快照文件会变大。
//    要覆盖的是**结构差异**（群/私聊、服主/群友、戳一戳、带图），不是随机多凑几个。
const G = '200000001';
const OWNER = '10000001';
const MEMBER = '30001';
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
};

// ── 生成 ────────────────────────────────────────────────
const { Bot } = await import('../src/bot.js');

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

const sceneCount = Object.keys(now).length;
console.log(`\n提示词快照（${sceneCount} 个场景）`);

// ── 收尾：清掉隔离文件，别在 logs/ 留一堆垃圾 ──
for (const v of Object.values(ISOLATED)) {
  try {
    rmSync(join(ROOT, v), { force: true });
  } catch {}
}

// ── 存 或 比 ────────────────────────────────────────────
if (saveMode || !existsSync(SNAP_FILE)) {
  writeFileSync(SNAP_FILE, JSON.stringify(now, null, 1), 'utf8');
  const why = saveMode ? '（--save）' : '（原来没有基线）';
  console.log(`  📝 已存基线 ${why}：${SNAP_FILE}`);
  console.log(`     改完人设相关代码后，跑不带 --save 的这次，必须**零差异**。`);
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

console.log(
  failures === 0
    ? '\n结果: 全部通过 ✅（提示词与基线逐字节一致）\n'
    : `\n结果: ${failures} 项失败 ❌\n`,
);
process.exit(failures === 0 ? 0 : 1);
