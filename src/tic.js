/**
 * 「口癖节流」—— 防止同一个开场白反复出现（2026-09-14 用户要求）。
 *
 * 用户原话：
 *   「**问这个干嘛**这种反问感觉**过于频繁**，有点**不亲近**的感觉，可以适当抑制一下」
 *
 * ## 为什么光改人设不够
 *
 * 这已经是**第二次**同一个毛病了。上一次是「被抓了别报我名字」（`persona.md`
 * 里记着：实测 10 次里出现了 6 次）。那次只在提示词里写「别当口癖」，
 * 结果这次换了个句子接着犯（「问这个干嘛」）。
 *
 * **原因**：人设里鼓励「留个口子、别下结论」（那条本身是对的，
 * 用户要的"真人感"就靠它），但模型会把它**塌缩成一句固定套话** ——
 * 而且**提示词是"无状态"的，它根本不知道上一句自己说了什么**。
 * 所以它没法自己发现"我这句话说了三遍了"。
 *
 * 所以这里补一道**代码层**的：把机器人最近说过的开头记下来，
 * 发现某个开头短时间内反复出现时，**把"你最近老这么开头，换个说法"写进提示词**。
 *
 * ⚠️ 注意这不是"禁用某句话"（那样写死就没法维护，也没法发现新的口癖）。
 *    这里盯的是**"重复"这个行为本身** —— 换一句新口癖它照样能抓住。
 *
 * ## 状态为什么落盘
 *
 * 用户重启机器人的时候（我自己一天就重启好几次），如果记录只在内存里，
 * 那道闸就归零了 —— 正好会让"刚重启完连着说三次同一句话"发生。
 * 跟着 `digest.js` / `qzone.js` 的做法，原子写 `state/tic.json`。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { ROOT, config, CONFIG_FILE } from './config.js';
import { log } from './log.js';

const STATE_DIR = join(ROOT, 'state');

/**
 * ⚠️⚠️ 状态文件落在哪 —— 必须保证**测试不污染真实记录**。
 *
 * 真实踩过（2026-09-14）：修完「问这个干嘛」之后一跑回归，
 * `state/tic.json` 里立刻被灌进了 `good我来 ×4`、`这是一条 ×2`、
 * `啊对了还`、`Hell`…… **全是假模型造出来的句子**。
 *
 * 根因：`tic.note()` 是**机器人进程自己**调的（不像 `spend.js` / `balance.js`
 * 那些套件是**在测试进程内**直接调模块、顺手设个 `QQBOT_*_FILE` 就隔离了）。
 * 这里写盘的是**子进程里的机器人**，而十几个测试套件各自 spawn 它时
 * 并没有传 `QQBOT_TIC_FILE` —— 逐个去补 18 处 spawn 不现实，也必然会漏。
 *
 * 所以改成**自动判断**：这些套件**本来就都设了** `QQBOT_CONFIG` 指向
 * `config.*-test.yml`（那是既成事实，不用我再去改任何一个套件）。
 * 配置文件名里带 `test` → 状态就写到 `state/__test-<配置文件>.json`。
 *
 * 三步优先：
 *   ① `QQBOT_TIC_FILE` 显式指定（单测用）
 *   ② 配置文件带 `test` → 隔离到 `state/__test-…json`（**永不与真实记录混**）
 *   ③ 否则才是真实的 `state/tic.json`
 */
function stateFile() {
  const explicit = process.env.QQBOT_TIC_FILE;
  if (explicit) return join(ROOT, explicit);
  const cfgName = basename(CONFIG_FILE ?? '');
  if (/test/i.test(cfgName)) {
    return join(STATE_DIR, `__test-${cfgName.replace(/\.ya?ml$/i, '')}.json`);
  }
  return join(STATE_DIR, 'tic.json');
}

const STATE_FILE = stateFile();

/** 测试专用：看它到底把状态落在哪了 */
export function path() {
  return STATE_FILE;
}

/** 每个群最多记多少条最近的开场白（够判断"重复"就行，别无限长） */
const MAX_RECORDS = 60;

const cfg = () => config.tic ?? {};

/**
 * 多久之内算"最近"。
 *
 * ⚠️ 默认 2 小时：隔了一天再说是口癖就没意义了（人也记不住）。
 *    但也不能太短 —— 群里聊得慢的时候，两条回复可能隔半小时。
 */
const windowMs = () => {
  const v = Number(cfg().windowMs);
  return Number.isFinite(v) && v > 0 ? v : 2 * 60 * 60 * 1000;
};

/**
 * 多少次算"太频繁"。
 *
 * ⚠️ 默认 3 次是个折中：说两遍还算正常（同一个话题接着问就会这样），
 *    三遍就明显是套话了。
 */
const repeatLimit = () => {
  const v = Number(cfg().repeatLimit);
  return Number.isFinite(v) && v > 0 ? v : 3;
};

/** groupId -> [{ g, kind, at }]，按时间顺序（老的在前）。kind: 'head' | 'clause' */
let store = new Map();

export function reload() {
  try {
    if (!existsSync(STATE_FILE)) return;
    const j = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    const next = new Map();
    for (const [k, list] of Object.entries(j?.groups ?? {})) {
      if (!Array.isArray(list)) continue;
      next.set(
        String(k),
        list
          .filter((x) => x && Number.isFinite(Number(x.at)))
          // ⚠️ 兼容两种老格式：`{head}`（只有开场白）和 `{g,kind}`（新）
          .map((x) => {
            const g = String(x.g ?? x.head ?? '');
            return { g: g.slice(0, 16), kind: x.kind === 'clause' ? 'clause' : 'head', at: Number(x.at) };
          })
          .filter((x) => x.g),
      );
    }
    store = next;
  } catch (e) {
    log.debug(`口癖记录读取失败（当作空的）：${e.message}`);
    store = new Map();
  }
}

function save() {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const groups = {};
    for (const [k, list] of store) groups[k] = list;
    const tmp = `${STATE_FILE}.tmp`;
    // ⚠️ 原子写（先写 .tmp 再 rename）—— 直接覆盖的话，
    //    写到一半崩了会留下一个坏 JSON，下次启动就读不出来（`digest.js` 同款做法）
    writeFileSync(tmp, JSON.stringify({ groups }, null, 0), 'utf8');
    renameSync(tmp, STATE_FILE);
  } catch (e) {
    log.debug(`口癖记录写盘失败：${e.message}`);
  }
}

/**
 * 取一句话的「开场白」特征。
 *
 * ⚠️ 为什么用"前 4 个字"而不是整句：
 *    口癖的特征在**开口那几个字**（「问这个干嘛」「你问这」「怎么突然问」），
 *    后面接什么每次都不一样。比整句的话永远匹配不上。
 *
 * ⚠️ 标点要先剔掉，否则「问这个干嘛。」和「问这个干嘛，」会被当成两句。
 *
 * @param {string} text
 * @returns {string} 空串 = 这句话没有可跟踪的开头（太短 / 纯表情）
 */
export function headOf(text) {
  const t = String(text ?? '')
    // 去掉开头的引号、表情标记、空白
    .replace(/^[\s"'「『（(【\[]+/, '')
    // 去掉所有标点和空白（中文标点 + ASCII 标点）
    .replace(/[\s，。！？!?；;、：:,.…~～—－\-"'「」『』（）()【】\[\]]+/g, '');
  if (t.length < 4) return '';
  return t.slice(0, 4);
}

/**
 * 取一句话里**重复出现的短串**（句中口癖）—— 2026-09-14 加。
 *
 * ## 为什么需要（`headOf` 的盲区）
 *
 * 用户反馈：「"**哪看到的**"这个小句子发的频率有点略高了」，
 * 后来补了一句关键的：**「我不是说完全不能说，而是遣词造句要有一点变化，
 * 要不然我不会记忆这么深刻」** —— 也就是**重复本身就够让人记住了**，
 * 不需要高频。
 *
 * 而那两条实例：
 * ```
 * 「中国人能飞」……哪看来的，你倒是说说        ← 在句中
 * 哪看到的？想看登录设备的话，QQ 设置里能翻到   ← 字面还变了（看来的/看到的）
 * ```
 * `headOf` 只记**开头 4 个字**，所以**完全管不到**——这就是盲区。
 *
 * ## 判据：**同一句回复里、跨句重复的短串**
 *
 * ⚠️ 我试过"最常出现的 4 个字"，**不行**：
 *    「哪看到的」里含 **`看到的`**，而那是个**正常词组**
 *    （「看到的都告诉你」完全正常）→ 会误伤一大堆正常句子。
 *
 * ✅ 换成这条判据就干净了：**同一个回复里、出现在 ≥2 个句子中的 n-gram**。
 *    理由很实在：**写东西的人不会在同一句里重复一个词** ——
 *    出现就说明那是**套话/模板**，不是遣词。
 *
 *    实例：「哪看到的？…哪看到的…」→ `哪看到的` 跨 2 句 → 抓 ✅
 *    反例：「…看到的都…」只出现一次 → **不抓** ✅
 *
 * @param {string} text
 * @returns {string[]} 最多 3 条，长的优先
 */
export function clausesOf(text) {
  const raw = String(text ?? '');
  if (!raw) return [];
  // 按句末标点切句（逗号不算 —— 它切得太碎，会把一个词切两半）
  const sentences = raw
    .split(/[。！？!?；;\n…]+/)
    .map((s) => s.replace(/[\s，,、：:""''「」『』（）()【】\[\]]+/g, ''))
    .filter((s) => s.length >= 4);
  if (sentences.length < 2) return []; // 只有一句 → 无法"跨句重复"，直接跳过

  // 统计每个 n-gram 出现在**几个不同的句子**里
  const inSentences = new Map();
  for (const s of sentences) {
    const seen = new Set();
    for (let n = 4; n <= 6; n += 1) {
      for (let i = 0; i + n <= s.length; i += 1) seen.add(s.slice(i, i + n));
    }
    for (const g of seen) inSentences.set(g, (inSentences.get(g) ?? 0) + 1);
  }

  // 只留"跨 ≥2 句"的，然后去掉被更长候选包含的（留最长的那个更可读）
  const hits = [...inSentences.entries()]
    .filter(([, c]) => c >= 2)
    .map(([g]) => g)
    .sort((a, b) => b.length - a.length);

  const out = [];
  for (const h of hits) {
    if (out.some((o) => o.includes(h))) continue; // 已被更长的覆盖
    out.push(h);
    if (out.length >= 3) break;
  }
  return out;
}


/**
 * 记一句机器人说过的话。
 *
 * ⚠️ **这是同步函数，不要加 `async`。**
 *    第一版写成了 `async`，而调用处（`bot.js` 和测试）都是**当同步用的**
 *    —— 于是只有函数体里第一个 `await` 之前的部分会执行，
 *    后面的 `store.set(...)` / `save()` **悄悄不跑了**。
 *    表现是"记了但没记上、而且不报错"，查了好一会儿。
 *    现在没有真实 IO，也就不需要 `async`（`writeFileSync` 是同步的）。
 *
 * @param {string|number} groupId
 * @param {string} text
 */
export function note(groupId, text) {
  // ⚠️ 私聊没有 `group_id`。第一版没挡，于是私聊的回复被记进了
  //    `"undefined"` 这个组（回归里真的出现过一条 `<undefined> → Hell`）。
  //    私聊不该走这套 —— 那是 1v1，不存在"群里老这么开口"的问题。
  if (groupId === undefined || groupId === null || groupId === '') return;
  const key = String(groupId);
  const now = Date.now();
  const fresh = [];

  // ① 开场白（老机制，管"每次都这么开口"）
  const head = headOf(text);
  if (head) fresh.push({ g: head, kind: 'head', at: now });

  // ② 句中重复的短串（2026-09-14 加，管「哪看到的」这种）
  for (const g of clausesOf(text)) fresh.push({ g, kind: 'clause', at: now });

  if (!fresh.length) return;

  const list = store.get(key) ?? [];
  list.push(...fresh);
  store.set(
    key,
    list.filter((x) => now - x.at < windowMs()).slice(-MAX_RECORDS),
  );
  save();
}

/**
 * 有没有哪个词/开场白最近说得太多了？
 *
 * @param {string|number} groupId
 * @returns {{g:string, kind:'head'|'clause', count:number}|null}
 */
export function repeated(groupId) {
  const list = store.get(String(groupId)) ?? [];
  const now = Date.now();
  const recent = list.filter((x) => now - x.at < windowMs());
  if (!recent.length) return null;

  const tally = new Map(); // `${kind}:${g}` -> {g, kind, count}
  for (const x of recent) {
    const k = `${x.kind}:${x.g}`;
    const e = tally.get(k) ?? { g: x.g, kind: x.kind, count: 0 };
    e.count += 1;
    tally.set(k, e);
  }

  let worst = null;
  for (const e of tally.values()) {
    if (e.count < repeatLimit()) continue;
    if (!worst) {
      worst = { ...e };
      continue;
    }
    // ⚠️ 平票时**句中(clause)优先于开头(head)**（2026-09-14）。
    //
    //    为什么会平票：**同一个说法可以同时是开头和句中**——
    //    用户报的「哪看来的」正是这样：
    //      · 「哪看来的？我哪看来的还要报备」→ head 记一次、clause 也记一次
    //      · 三条这样的回复 → head 3 次、clause 3 次
    //    这时候提哪一条更准？**句中那条** ——
    //    它对应的提示是「这个说法别再用」，而 head 那条说的是
    //    「别用这个开头」——后者会漏掉"句中又说了两次"这个事实。
    if (e.count > worst.count) worst = { ...e };
    else if (e.count === worst.count && e.kind === 'clause' && worst.kind === 'head') {
      worst = { ...e };
    }
  }
  return worst;
}

/**
 * 生成一段"你最近老这么说"的提示词片段；没有口癖就返回空串。
 *
 * ⚠️ 措辞要**给出替代方案**，光说"别用"模型会换一句新的套话。
 *
 * @param {string|number} groupId
 * @returns {string}
 */
export function ticHint(groupId) {
  if (cfg().enable === false) return '';
  const r = repeated(groupId);
  if (!r) return '';
  const samples = (store.get(String(groupId)) ?? [])
    .filter((x) => x.g === r.g)
    .map((x) => `「${x.g}」`);

  const isClause = r.kind === 'clause';
  return [
    isClause ? '## ⚠️ 你最近老用同一句措辞（换个说法）' : '## ⚠️ 你最近老这么开口（换个说法）',
    '',
    `你最近 **${r.count} 次**都用了这个说法：${samples.slice(0, 4).join('、')}`,
    '',
    '**这就是口癖** —— 同一个人反复用同一句话，听着特别假，也没意思。',
    '用户的原话是：**「不是说完全不能说，而是遣词造句要有一点变化」** ——',
    '意思是：**这个意思你可以表达，但每次换个说法**。',
    '',
    isClause
      ? '- 🚫 这次**别再用这个说法**了 —— 换个词、换个句式都行'
      : '- 🚫 这次**别再用这个开头**了（换个说法，或者直接说事）',
    '- ✅ 最好的做法是**开口就正面回答**，把话说明白',
    '- ⚠️ 别只是"换一句同样味道的套话" —— 换掉的是**那个姿态**，不是那几个字',
  ].join('\n');
}

/** 给管理界面/自检看 */
export function status(groupId) {
  const list = groupId === undefined ? [] : (store.get(String(groupId)) ?? []);
  return {
    groups: store.size,
    records: [...store.values()].reduce((n, l) => n + l.length, 0),
    windowMs: windowMs(),
    repeatLimit: repeatLimit(),
    repeated: groupId === undefined ? null : repeated(groupId),
    recent: list.slice(-8).map((x) => x.g),
  };
}

/** 测试专用 */
export function __clear() {
  store = new Map();
  save();
}

// ⚠️ 模块加载时就恢复 —— 和 `qzone.js` 的 `loadState()` 同一个做法。
//    不在这里加载的话，`bot.js` 里那句 `tic.ticHint()` 会永远看到空记录，
//    这道闸就等于没接上（而且**不会报错**，只是静默失效）。
reload();
