/**
 * 一次跑**四种完全不同的剧情开头**，每种 30 轮，输出到桌面**四个分开的文件**
 * —— 2026-10-23 加（用户要求）。
 *
 * 用户原话：「**刚才输出的 txt 太乱了，把四次穿插到一起了，这次把四次分开，
 *   然后你写四种完全不同的剧情开始提示词，这次一次 30 轮，再测一遍**」
 *
 * 为什么要有批处理，而不是手敲四遍：
 *   ① 四场戏的**运行态必须各自独立**（不然并行跑会互相读对方的上下文和轮次，
 *      "四场戏"就变成一场戏的四段了 ✗）—— 每个场景给一个 `QQBOT_QSIM_DIR`；
 *   ② 桌面那份必须**分开**（`--desk-name` 给不同文件名，都进桌面的 `剧情模拟` 文件夹）；
 *   ③ 跑完顺手出一份 `00-说明.txt`，把四场的起因和体检表摆在一起 —— 否则又要在四个
 *      文件之间来回翻着对比 ✗
 *
 * 用法：
 *   node tools/quest-sim-batch.mjs                 # 四种 × 30 轮（默认）
 *   node tools/quest-sim-batch.mjs --rounds=15     # 改轮数
 *   node tools/quest-sim-batch.mjs --only=s2,s3    # 只跑其中几种
 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, existsSync, statSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const arg = (name, dflt = '') => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const eq = hit.indexOf('=');
  return eq >= 0 ? hit.slice(eq + 1) : '1';
};
const ROUNDS = Math.max(1, Number(arg('rounds', '30')) || 30);
const ONLY = String(arg('only', '')).split(',').map((s) => s.trim()).filter(Boolean);

/**
 * 四种**完全不同的开头** —— 场景、身体空间、情绪引子各不一样，
 * 这样才能看出提示词是"真的会演"，还是只在某一条戏上碰巧好看。
 */
const SCENES = [
  {
    key: 's1',
    title: '旅店只剩一间双人房',
    premise:
      '演出结束已经很晚了，外面在下雪，回不去。前台说只剩最后一间双人房，两张床中间隔着一盏落地灯。' +
      '房卡一直在我手里，她在旁边站着没说话，两个人都没提要不要换一家。',
    seed: '那你说怎么办，就这一间了。',
  },
  {
    key: 's2',
    title: '半夜照顾发烧',
    premise:
      '她烧到三十八度多，我半夜起来给她换了两回毛巾。刚才量完体温，她说不冷，可人一直往我这边缩。' +
      '她屋里只开了一盏小台灯，桌上摆着喝了一半的水和没拆完的退烧药。',
    seed: '我真不冷，你别管我了，睡你的去。',
  },
  {
    key: 's3',
    title: '真心话大冒险输了',
    premise:
      '刚才那局我输了，她们说惩罚是让我当着她的面说一句实话。人都散了，只剩我俩还坐在沙发上，' +
      '她没走，我手里那杯饮料已经不冰了，客厅只留了一盏壁灯。',
    seed: '行啊，那你说吧，我听着呢。',
  },
  {
    key: 's4',
    title: '深夜排练室只剩两人',
    premise:
      '排练到最后一个走，只剩我和她。琴还没收，谱架倒在地上，隔音门关着，走廊的灯是感应式的，' +
      '不动一会儿就灭。我刚把外套脱下来搭在音箱上，她坐在鼓凳上看着我。',
    seed: '就我们俩了，你还练不练。',
  },
  // ⚠️ 2026-10-23 加这两场（用户：「**写两个新开头，只跑 2 场 × 30 轮**」）——
  //    挑这两个是因为它们**天生就带着"贴上去"的由头**（黑暗中靠得很近 / 低头给人上药），
  //    正好用来验新加的那条「进入正题要有原因、而且原因要写出来」✓
  {
    key: 's5',
    title: '停电的器材室',
    premise:
      '体育馆后面的器材室，灯管坏了，只有走廊的光从门缝底下漏进来一条。外面雨还在下，' +
      '远处有人在喊名字，我们俩蹲在一堆垫子后面没出声。刚才跑得太急，两个人的呼吸到现在都没匀下来。',
    seed: '别出声……好像还没走远。',
  },
  {
    key: 's6',
    title: '给她擦药',
    premise:
      '她从台阶上摔下来，膝盖擦破一大片。我拿了药水和棉签，跪在她面前给她擦，她一条腿搭在我膝盖上。' +
      '屋里只开了客厅一盏灯，我低着头，离她的腿很近，能看清那一片渗出来的血珠。',
    seed: '嘶——轻点，你别拿棉签戳。',
  },
  // ⚠️ 2026-10-23 加这两场（用户：「**如果开场原因直接触及到下面的话，比如不小心碰到之类的，
  //    也可以自由发挥一下，然后跨过亲吻的阶段直接进入正题。这个原因可以随机发挥是触及哪里，
  //    但是这次测试一下两次都是直接跨过亲吻的**」）：
  //    ⇒ 两场的起因**一上来手就在靠下的位置**（按腰 / 拉卡住的拉链），
  //      由头天然落在更后面 ⇒ 用来验「③ 接吻可以不发生」这条 ✓
  {
    key: 's7',
    title: '帮她按腰',
    premise:
      '她连着两天弯腰蹲着收拾东西，腰直不起来。我让她趴到沙发上，跪在她旁边给她按。' +
      '屋里暖气开得有点足，她后颈那片头发被汗黏住了，我手掌一按下去她就哼了一声。',
    seed: '你手别往上，就那儿，按那儿。',
  },
  {
    key: 's8',
    title: '拉链卡住了',
    premise:
      '她那条裙子的后背拉链卡住了，拉不上去也拽不下来。她背对着我站着，让我从后面帮她弄。' +
      '手指伸进那条缝里，才觉出来是卡在靠下的地方，得再往下探一点才够得着。',
    seed: '你别拽，先把上面那截对正了再说。',
  },
  // ⚠️ 2026-10-23 再加四场（用户：「**做 8 次 30 轮，并且使用新剧情开头**」）——
  //    这四场分别给了 SM（打赌输了要听话）、道具（刚到的快递 / 系带）、
  //    水（泡澡）的**天然由头**，正好用来验新加的那几条 ✓
  {
    key: 's9',
    title: '打赌输了',
    premise:
      '刚才那个赌我输了，说好输的人一晚上听对方安排。她坐在床沿上等我开口，屋里灯已经关了，' +
      '只剩窗帘缝透进来的一道亮。',
    seed: '说吧，你要我做什么。',
  },
  {
    key: 's10',
    title: '搬家收拾到半夜',
    premise:
      '她搬进来第三天，箱子还堆在客厅没拆。今晚收拾到半夜，两个人都出了一身汗，' +
      '最后那只箱子压在最底下，外面写着勿压。',
    seed: '这只要不要现在拆？',
  },
  {
    key: 's11',
    title: '试新裙子',
    premise:
      '她买的那件裙子今天到了，非让我看她穿。后背的系带她自己够不着，站在镜子前转过身让我帮她系。' +
      '屋里就开了床头那盏灯，镜子里能看见她后颈到肩胛那一段。',
    seed: '你帮我系一下，别系太紧。',
  },
  {
    key: 's12',
    title: '浴室的热水',
    premise:
      '热水器修好了，她非要试第一缸水。浴室里全是蒸汽，镜子早就看不清了，' +
      '她泡在里面喊我把毛巾递过去。洗手台上还放着她刚拆开的那个盒子。',
    seed: '毛巾递我，快点，水要凉了。',
  },
];

const pick = ONLY.length ? SCENES.filter((s) => ONLY.includes(s.key)) : SCENES;

// ── 桌面 ────────────────────────────────────────────────
const deskDir = () => {
  const env = process.env.QQBOT_DESKTOP;
  if (env) return env;
  for (const c of ['E:\\Desktop', join(homedir(), 'Desktop')]) {
    try {
      if (statSync(c).isDirectory()) return c;
    } catch {
      /* 试下一个 */
    }
  }
  return '';
};
const DESK = deskDir();
const DESK_FOLDER = DESK ? join(DESK, '剧情模拟') : '';
if (DESK_FOLDER) mkdirSync(DESK_FOLDER, { recursive: true });

// ── 先把上一批散落在桌面根目录的旧报告归档（用户说"太乱了"）──
if (DESK) {
  const OLD = join(DESK_FOLDER, '旧-之前的20轮');
  for (const f of readdirSync(DESK)) {
    if (!/^剧情模拟.*\.txt$/.test(f)) continue;
    try {
      mkdirSync(OLD, { recursive: true });
      renameSync(join(DESK, f), join(OLD, f));
      console.log(`归档：${f} → 剧情模拟\\旧-之前的20轮\\`);
    } catch (e) {
      console.log(`⚠️ 归档 ${f} 失败：${e.message}`);
    }
  }
}

// ── 并行跑 ──────────────────────────────────────────────
// ⚠️ `--repeat=N`：同一场戏**重复跑 N 遍**（2026-10-23 用户要「跑 5~8 次，还是 30 轮」）——
//    同一条起因换一次随机，看到的就是"稳定性"，而不是"这一遍碰巧好看" ✓
const REPEAT = Math.max(1, Number(arg('repeat', '1')) || 1);
// ⚠️ 2026-10-23 加：让调用方指定用哪家模型（用户要用中转站的 ds4.1）
const PROVIDER = String(arg('provider', '')).trim();
const runs = [];
for (let r = 1; r <= REPEAT; r++) for (const sc of pick) runs.push({ sc, r });
console.log(`跑 ${pick.length} 种开头 × ${REPEAT} 遍 = ${runs.length} 场，每场 ${ROUNDS} 轮（并行）…\n`);

const runOne = ({ sc, r }) =>
  new Promise((resolve) => {
    const dir = r === 1 ? `logs/qsim/${sc.key}` : `logs/qsim/${sc.key}-r${r}`;
    mkdirSync(join(ROOT, dir), { recursive: true });
    const logPath = join(ROOT, dir, 'stdout.log');
    const fd = openSync(logPath, 'w');
    const args = [
      join(ROOT, 'tools', 'quest-sim.mjs'),
      `--rounds=${ROUNDS}`,
      `--premise=${sc.premise}`,
      `--seed=${sc.seed}`,
      ...(PROVIDER ? [`--provider=${PROVIDER}`] : []),
      `--out=${dir}/report.md`,
      `--desk-name=${sc.key}-${sc.title}-${ROUNDS}轮${r === 1 ? '' : `-第${r}遍`}.txt`,
    ];
    const env = { ...process.env, QQBOT_QSIM_DIR: dir };
    const t0 = Date.now();
    const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', fd, fd] });
    child.on('exit', (code) => {
      closeSync(fd);
      resolve({ sc, r, code, ms: Date.now() - t0, dir, logPath });
    });
    child.on('error', (e) => {
      closeSync(fd);
      resolve({ sc, r, code: -1, ms: Date.now() - t0, dir, logPath, err: e.message });
    });
  });

const results = await Promise.all(runs.map(runOne));

// ── 从每份 md 里抠体检表 ────────────────────────────────
const KEYS = [
  ['旧三样', /部位·旧三样[^|]*\|\s*(\d+)/],
  ['肩', /部位·肩[^|]*\|\s*(\d+)/],
  ['别的', /部位·别的[^|]*\|\s*(\d+)/],
  ['湿', /\|\s*湿\s*\|\s*(\d+)/],
  ['汗', /\|\s*汗\s*\|\s*(\d+)/],
  ['元层面', /元层面[^|]*\|\s*(\d+)/],
  ['时间前推', /时间前推[^|]*\|\s*(\d+)/],
  ['括号', /\|\s*括号舞台指示\s*\|\s*(\d+)/],
  ['平均字数', /平均字数\s*\|\s*(\d+)/],
];
const row = (r) => {
  const f = join(ROOT, r.dir, 'report.md');
  if (!existsSync(f)) return { ...r, stat: {}, ran: 0 };
  const t = readFileSync(f, 'utf8');
  const stat = {};
  for (const [k, re] of KEYS) {
    const m = t.match(re);
    stat[k] = m ? Number(m[1]) : '—';
  }
  const ran = (t.match(/###\s*\d+\s+\w+（/g) ?? []).length;
  return { ...r, stat, ran };
};
const rows = results.map(row);

// ── 00-说明.txt ────────────────────────────────────────
const lines = [];
lines.push('='.repeat(70));
lines.push(`  剧情模拟 · 四种完全不同的开头，每种 ${ROUNDS} 轮`);
lines.push(`  ${new Date().toLocaleString('zh-CN')}`);
lines.push('='.repeat(70));
lines.push('');
lines.push('这是**本地跑**的，没有发到任何 QQ 群。用的是机器人真实的提示词和真实模型，');
lines.push('只是把"发到群里"这一步换成本地记录 —— 所以它写出来的东西，就是她在群里会写的东西。');
lines.push('');
lines.push('四份正文各自一个文件，文件名就是这四场戏的名字：');
lines.push('');
for (const r of rows) {
  const st = r.stat;
  lines.push(`  ${r.sc.key}${r.r > 1 ? `-第${r.r}遍` : ``}  ${r.sc.title}`);
  lines.push(`      跑完 ${r.ran}/${ROUNDS} 轮${r.code !== 0 ? `  ⚠️ 退出码 ${r.code}` : ''}`);
  lines.push(`      起因：${r.sc.premise}`);
  lines.push('');
}
lines.push('-'.repeat(70));
lines.push('  体检表（关键词统计，只是给你快速扫一眼，不是判据）');
lines.push('-'.repeat(70));
lines.push('');
const head = '场景'.padEnd(22) + ['旧三样', '肩', '别的', '湿', '汗', '元层', '时间推', '括号', '字数'].map((s) => s.padStart(6)).join('');
lines.push(head);
for (const r of rows) {
  const st = r.stat;
  const cells = [st['旧三样'], st['肩'], st['别的'], st['湿'], st['汗'], st['元层面'], st['时间前推'], st['括号'], st['平均字数']]
    .map((v) => String(v ?? '—').padStart(6))
    .join('');
  lines.push(`${r.sc.key}${r.r > 1 ? `-${r.r}` : ``} ${r.sc.title}`.padEnd(22) + cells);
}
lines.push('');
lines.push('  怎么读这张表：');
lines.push('    · 旧三样（后背/腰/脖子）—— 你点名过"像互相按摩"的那一片，越少越好；');
lines.push('      但它"路过"是正常的，看他是不是停在那儿反复揉。');
lines.push('    · 别的（锁骨/胸口/小腹/胯/腿根…）—— 越多说明手真的在往下走。');
lines.push('    · 湿 / 汗 —— 要湿不要汗（汗不能拿来顶替）。');
lines.push('    · 元层 —— 「剧本 / 设定 / 演哪出」这种跳出剧情的词，应该是 0。');
lines.push('    · 时间推 —— 「明天 / 放学 / 晚安」这种把时间往前拉的词，越少越好。');
lines.push('    · 括号 —— 舞台指示那种写法，应该是 0。');
lines.push('    · 字数 —— 平均每轮多少字（太短就是一笔带过）。');
lines.push('');
if (DESK_FOLDER) lines.push(`（桌面上的「剧情模拟」文件夹里还有更早那批 20 轮的，挪进「旧-之前的20轮」了）`);
lines.push('');

const outTxt = join(
  DESK_FOLDER || join(ROOT, 'logs/qsim'),
  // ⚠️ 只跑了几种时**不要覆盖全量的说明**（那会把另外几场的表抹掉）
  ONLY.length ? `剧情模拟-说明-${pick.map((s) => s.key).join('')}.txt` : '剧情模拟-四种开头-说明.txt',
);
writeFileSync(outTxt, lines.join('\r\n'), 'utf8');

console.log(lines.join('\n'));
console.log(`\n说明文件：${outTxt}`);
for (const r of rows) {
  console.log(`${r.sc.key}${r.r > 1 ? `-第${r.r}遍` : ``} ${r.sc.title} → ${r.ran}/${ROUNDS} 轮，${Math.round(r.ms / 1000)} 秒${r.code !== 0 ? `（退出码 ${r.code}，日志 ${r.logPath}）` : ''}`);
}
process.exit(0);
