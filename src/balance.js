/**
 * API 余额（= 小祥的「工资」）。
 *
 * ⚠️ 需求来源（用户 2026-09-13）：
 *   「把余额和祥子的工资设定结合到一起，**如果低于5块钱抱怨一次，低于2块钱再抱怨一次**，
 *    然后把**余额不足警告也改了**」
 *
 * 设计要点：
 *   · 余额在提示词里就是「**小祥的工资**」—— 快见底了就该有反应
 *     （她人设是个手头紧的大小姐，这个梗很贴）
 *   · **每个档位只抱怨一次**（不按时间冷却，按档位）——
 *     否则余额停在 4.9 元会每次说话都抱怨，那比故障本身还烦
 *   · 状态**落盘**：重启不会把"已经抱怨过了"忘掉
 *     （踩过这个坑：`digest.lastPosts` / `qzone.today` 都因为只在内存里
 *      导致重启后重复发；见 AGENTS.md 铁律②）
 *   · 真·余额耗尽（HTTP 402）也走这套话术，不再甩「⚠️ API 余额不足」给群友
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config, ROOT, stateDir } from './config.js';
import { log } from './log.js';
import * as llm from './llm.js';
// ⚠️ 2026-09-21：她**怎么称呼主人**从 `identity.address` 来 ——
//    这里原来写死「<主人>」，换人设后她会继续点名旧主人。
import * as persona from './persona.js';

// ⚠️ 测试/预览可以用 `QQBOT_BALANCE_FILE` 指向临时文件 ——
//    这样能演示不同档位的话术，又**不会**动到真实的"已抱怨"状态
//    （那个状态脏了就会导致该提醒的不提醒 / 重复提醒）。
const FILE = process.env.QQBOT_BALANCE_FILE
  ? join(ROOT, process.env.QQBOT_BALANCE_FILE)
  : join(stateDir(), 'balance.json');

/**
 * 抱怨档位（从低到高判断）—— 阈值可配（`config.balance.critical` / `.low`）。
 *
 * ⚠️⚠️ 2026-09-15 晚：用户要求「**先把 5 块钱的额度提醒藏在代码里**，
 *    只留下 2 块钱 @ 提醒即可」（原因：最近花得太快）。
 *    → `config.balance.low: 0` 就是**关掉偏低档**：代码留着，
 *      把 0 改回正数（或删掉这一项）立刻恢复。
 */
function tiers() {
  const b = config.balance ?? {};
  const crit = Number(b.critical) > 0 ? Number(b.critical) : 2;
  const low = Number(b.low) === 0 ? 0 : Number(b.low) > 0 ? Number(b.low) : 5;
  const list = [{ key: 'critical', below: crit, label: '见底' }];
  if (low > 0) list.push({ key: 'low', below: low, label: '偏低' });
  return list;
}

/** 当前生效的档位（给启动日志/界面看：偏低档被 `balance.low: 0` 关掉时会少一档） */
export function tierInfo() {
  return tiers().map((t) => ({ ...t }));
}

/**
 * { last: {balance, at}, complained: { critical, low },
 *   complainedByGroup: { "<群号>": { critical, low } } }
 *
 * ⚠️ 2026-09-15 晚加 `complainedByGroup`：**提醒是挨个 1 档群发的，标记也必须按群记**。
 *    原来只有一个全局标记 → 第一个群收到提醒后，**别的群再也收不到**
 *    （<主人> 报的「699 开头这个群好像不会发送余额报警信息」就是这个）。
 */
let state = { last: null, complained: {}, complainedByGroup: {} };

try {
  if (existsSync(FILE)) {
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    state = {
      last: j.last ?? null,
      complained: j.complained ?? {},
      complainedByGroup: j.complainedByGroup ?? {},
    };
  }
} catch (e) {
  log.debug(`载入余额状态失败：${e.message}`);
}

function save() {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    renameSync(tmp, FILE);
  } catch (e) {
    log.debug(`保存余额状态失败：${e.message}`);
  }
}

/**
 * 余额查询的**适配层** —— 不同服务商的接口完全不一样（2026-10-06 加）。
 *
 * ## 用户原话
 *   「**群友用的中转站的 api，给中转站的余额接入适配一下**」
 *
 * ## 为什么要改
 *   以前这里**写死了 DeepSeek 的 `/user/balance`**。群友把 `llm.baseURL` 换成
 *   中转站（new-api / one-api 那一类统称）之后，那个接口**不存在** ⇒
 *   余额**永远查不出来**，表现是「工资」一直停在旧数字，或者启动日志里一路报错。
 *
 * ## 四种 provider（`balance.provider` 选，**默认 `auto` 挨个试**）
 *
 * | provider | 打哪个接口 | 取哪个字段 | 说明 |
 * | --- | --- | --- | --- |
 * | `deepseek` | `{base}/user/balance` | `balance_infos[0].total_balance` | 官方 DeepSeek（老行为，不变） |
 * | `newapi` | `{base}/api/user/self` | `data.quota` ÷ 500000 | new-api / one-api / done-hub 等同源面板 |
 * | `openai-billing` | `{base}/dashboard/billing/subscription` + `.../usage` | `hard_limit_usd` − `total_usage`÷100 | OpenAI 那套老计费接口，**很多中转站照着兼容** |
 * | `custom` | `balance.url`（**完整地址**） | `balance.path` ÷ `balance.divide` | 上面都对不上时自己填 |
 *
 * ⚠️⚠️ **为什么默认是 `auto` 而不是让用户选**：这个项目的目标是「群友几乎零成本部署」——
 *    他换了个中转站，不该还得先搞清自己是 new-api 还是 one-api。
 *    所以默认**挨个试**，谁先成功用谁。余额查询是低频的（`checkIntervalMs`，默认半小时），
 *    多打一两个请求完全无所谓。
 *
 * ⚠️ **令牌不一样**：`newapi` 的 `/api/user/self` 要的是**面板里的访问令牌**
 *    （`config.balance.token`），**不是** `sk-` 开头那个调用 key ——
 *    官方文档也是这么分的。只配了 sk- key 的话，`auto` 会自动跳过 newapi、
 *    去试 `openai-billing`（那个认 sk- key）。
 *
 * ⚠️⚠️ **单位/币种会变**（`low` / `critical` 那两个阈值是按**元**定的）：
 *    · deepseek → 返回什么币种就是什么（一般是 CNY）
 *    · newapi / openai-billing → **美元**
 *    ⇒ 换成中转站之后，`balance.low: 5` 的含义从「5 元」变成了「5 美元」，
 *      **阈值要自己按币种调**（本模块**不替你按汇率换算** —— 汇率天天变，猜不如不猜）。
 *      想固定币种就写 `balance.currency`。
 */

/** 取 JSON 里 `data.quota` 这种点分路径的值（`custom` 用） */
function pickPath(obj, path) {
  let cur = obj;
  for (const k of String(path ?? '')
    .split('.')
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** 统一发一个带 Bearer 的 GET，返回解析好的 JSON（失败就 throw，由各 provider 兜） */
async function getJson(url, token, timeoutMs) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const r = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

/**
 * 四个 provider。每个 `run(ctx)` 返回 `{total, currency}` 或 `throw`。
 * ⚠️ `needTok: true` = 没有令牌就直接跳过（别去撞 401，那会在日志里刷无意义的错）。
 */
const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek /user/balance',
    needTok: true,
    currency: 'CNY',
    async run({ base, token, timeoutMs }) {
      const j = await getJson(`${base}/user/balance`, token, timeoutMs);
      const info = Array.isArray(j?.balance_infos) ? j.balance_infos[0] : null;
      if (!info) throw new Error('返回里没有 balance_infos');
      const total = Number(info.total_balance);
      if (!Number.isFinite(total)) throw new Error('total_balance 不是数字');
      return { total, currency: String(info.currency ?? 'CNY') };
    },
  },
  newapi: {
    label: 'new-api / one-api /api/user/self',
    // ⚠️ 要**面板访问令牌**，不是 sk- key ⇒ 没单独配就跳过（见文件头那段）
    needTok: true,
    tokenMustBePanel: true,
    currency: 'USD',
    async run({ base, token, timeoutMs }) {
      const j = await getJson(`${base}/api/user/self`, token, timeoutMs);
      // ⚠️ new-api 把额度放在 `data.quota`；容错认几种常见写法，别因为少一层就整个废掉
      const d = j?.data ?? j ?? {};
      const raw = d.quota ?? d.remain_quota ?? d.remainQuota ?? d.remain;
      const q = Number(raw);
      if (!Number.isFinite(q)) throw new Error('返回里没有 quota');
      // ⚠️ **500000 quota = 1 美元**（one-api 系的老约定，new-api 沿用）
      return { total: q / 500000, currency: 'USD' };
    },
  },
  'openai-billing': {
    label: 'OpenAI 式 /dashboard/billing',
    needTok: true,
    currency: 'USD',
    async run({ base, token, timeoutMs }) {
      const sub = await getJson(`${base}/dashboard/billing/subscription`, token, timeoutMs);
      const limit = Number(sub?.hard_limit_usd ?? sub?.soft_limit_usd ?? sub?.system_hard_limit_usd);
      if (!Number.isFinite(limit)) throw new Error('subscription 里没有 hard_limit_usd');
      // ⚠️ 用量接口要日期区间 —— 给「本月 1 号 ~ 今天」，和面板上的口径一致
      const now = new Date();
      const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const end = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
        now.getDate(),
      ).padStart(2, '0')}`;
      const use = await getJson(
        `${base}/dashboard/billing/usage?start_date=${start}&end_date=${end}`,
        token,
        timeoutMs,
      );
      const cents = Number(use?.total_usage);
      if (!Number.isFinite(cents)) throw new Error('usage 里没有 total_usage');
      // ⚠️ `total_usage` 的单位是**美分** ⇒ ÷100 得美元
      return { total: limit - cents / 100, currency: 'USD' };
    },
  },
  custom: {
    label: '自定义地址',
    needTok: false,
    currency: '',
    async run({ cfg, token, timeoutMs }) {
      const url = String(cfg?.url ?? '').trim();
      if (!url) throw new Error('custom 必须配 balance.url');
      const j = await getJson(url, token, timeoutMs);
      const path = String(cfg?.path ?? '').trim();
      const raw = path ? pickPath(j, path) : j;
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`按路径「${path || '(整个返回)'}」取到的不是数字`);
      const div = Number(cfg?.divide);
      const total = Number.isFinite(div) && div > 0 ? n / div : n;
      return { total, currency: String(cfg?.currency ?? '') };
    },
  },
};

/** `auto` 的尝试顺序：官方的排前面（命中率最高、请求最少），自定义永远最后（要用户填东西） */
const AUTO_ORDER = ['deepseek', 'newapi', 'openai-billing', 'custom'];

/**
 * 查一次余额。
 *
 * ⚠️ 原来这里写死 DeepSeek 的 `/user/balance` —— 见上面那段长注释（用户要求适配中转站）。
 *    `provider: deepseek` 的行为和以前**一字不差**（老用户的配置不用动）。
 *
 * @returns {Promise<{ok:boolean, total?:number, currency?:string, via?:string, error?:string}>}
 */
export async function fetchBalance() {
  const llm = config.llm ?? {};
  const bcfg = config.balance ?? {};
  const url0 = String(bcfg.url || llm.baseURL || 'https://api.deepseek.com/v1').trim();
  const base = url0.replace(/\/+$/, '').replace(/\/v1$/, '');
  const token = String(bcfg.token || llm.apiKey || '').trim();
  const timeoutMs = Number(bcfg.timeoutMs) > 0 ? Number(bcfg.timeoutMs) : 15000;
  /** `auto` 时若用户**没单独配面板令牌**，`newapi` 那条就先跳过（sk- key 打它必 401） */
  const hasPanelToken = Boolean(String(bcfg.token ?? '').trim());

  const want = String(bcfg.provider ?? 'auto').trim().toLowerCase() || 'auto';
  const names =
    want === 'auto' ? AUTO_ORDER : Object.prototype.hasOwnProperty.call(PROVIDERS, want) ? [want] : null;
  if (!names) {
    return { ok: false, error: `不认识的 balance.provider「${want}」（可选 auto/deepseek/newapi/openai-billing/custom）` };
  }
  if (!token && names.some((n) => PROVIDERS[n]?.needTok)) {
    // ⚠️ 令牌一个都没有就别去撞 401 了 —— 老行为就是这么判的
    return { ok: false, error: '没配 apiKey' };
  }

  const tried = [];
  for (const name of names) {
    const p = PROVIDERS[name];
    if (p.needTok && !token) continue;
    // ⚠️ 只在 `auto` 里跳过 newapi：用户**明确指名** newapi 时，就算只有 sk- key 也让他试
    //    （有些面板确实吃 sk- key），失败时报错给他看，别静默换别的 provider
    if (name === 'newapi' && p.tokenMustBePanel && want === 'auto' && !hasPanelToken) {
      tried.push('newapi（没配 balance.token，跳过）');
      continue;
    }
    try {
      const r = await p.run({ base, token, timeoutMs, cfg: bcfg });
      if (!Number.isFinite(r.total)) throw new Error('拿到的余额不是数字');
      const currency = String(bcfg.currency || r.currency || 'CNY');
      const total = r.total;
      state.last = { balance: total, currency, at: Date.now(), via: name };
      // ⚠️ 余额**涨回到档位以上**就把"抱怨过"重置 ——
      //    这样充值之后再掉下来，它会再抱怨一次（合理的）
      for (const t of tiers()) {
        if (total >= t.below) state.complained[t.key] = false;
      }
      // ⚠️ **按群那些标记也要一起重置**（2026-09-15 晚加）——
      //    只重置全局那份的话，充值之后再掉下来，各个群反而不会提醒了。
      for (const gid of Object.keys(state.complainedByGroup ?? {})) {
        for (const t of tiers()) {
          if (total >= t.below) state.complainedByGroup[gid][t.key] = false;
        }
      }
      save();
      if (want === 'auto' && name !== AUTO_ORDER[0]) {
        // ⚠️ 自动探测换了一家 → 记一条 info，排障时一眼看得出"它认的是哪个接口"
        log.info(`[余额] 自动识别用「${p.label}」查到了：${total} ${currency}`);
      }
      return { ok: true, total, currency, via: name };
    } catch (e) {
      tried.push(`${name}：${e.message}`);
    }
  }
  return { ok: false, error: `都试过了 —— ${tried.join('；')}` };
}

/** 上次查到的余额（可能是旧的） */
export function lastBalance() {
  return state.last;
}

/**
 * 当前已知的**币种**（查过一次余额才有）—— 给日志和文案用。
 *
 * ⚠️ 2026-10-06 加：换成中转站之后币种多半从 CNY 变成 USD，
 *    而日志/启动提示里原来写死了「元」⇒ 会把美元读成元（看着像"还有 5 块钱"）。
 *    查不到就返回空串，调用方自己决定怎么写（别在这里编一个默认值）。
 */
export function currencyNow() {
  return String(state.last?.currency ?? '').trim();
}

/** 这个余额是从哪个接口查到的（`deepseek` / `newapi` / `openai-billing` / `custom`） */
export function viaNow() {
  return String(state.last?.via ?? '').trim();
}

/** 重新从盘上读状态（预览/测试用） */
export function reload() {
  try {
    const j = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
    state = {
      last: j.last ?? null,
      complained: j.complained ?? {},
      complainedByGroup: j.complainedByGroup ?? {},
    };
  } catch (e) {
    log.debug(`重读余额状态失败：${e.message}`);
  }
  return {
    last: state.last,
    complained: { ...state.complained },
    complainedByGroup: JSON.parse(JSON.stringify(state.complainedByGroup ?? {})),
  };
}

/** 只改内存里的"上次余额"—— **预览/测试专用，不落盘**（不调 save()） */
export function setLastForPreview(total) {
  state.last = { balance: Number(total), currency: 'CNY', at: Date.now() };
}

/**
 * 该不该为余额抱怨一句？
 *
 * @param {{force?:boolean, dry?:boolean, total?:number, seed?:number, groupId?:string}} [opts]
 *   `force` = 真·余额耗尽（HTTP 402）时也要给话术；
 *   `groupId` = **要发给哪个群** —— 给了就按这个群记"提醒过了"（见下面的说明）。
 * @returns {{need:boolean, tier?:string, total?:number, line?:string}}
 */
export function balanceComplaint(opts = {}) {
  const total = opts.total ?? state.last?.balance;
  if (!Number.isFinite(total)) return { need: false };
  const seed = Number.isInteger(opts.seed) ? opts.seed : undefined; // 测试/预览用
  // ⚠️ `dry: true` = 只看话术、**不改"已抱怨"状态**（预览/测试用）。
  //    不加这个的话，预览一次就把档位标记成"已抱怨"，真实提醒反而发不出来了。
  const dry = Boolean(opts.dry);
  // ⚠️⚠️ 2026-09-15 晚：给了群号就**按群**记（<主人> 报「699 开头这个群好像不会发送余额报警」）——
  //    余额提醒是**挨个 1 档群发的**，而原来只有一个全局标记 →
  //    第一个群收到提醒之后，**别的群永远收不到**（加上"冷场才发"那道闸，
  //    热闹的大群更是永远等不到）。所以：有群号 → 记那个群自己的；
  //    没群号（402 兜底话术那种调用）→ 还是记全局那份。
  const gid = String(opts.groupId ?? '').trim();
  const already = (t) =>
    gid ? state.complainedByGroup?.[gid]?.[t.key] === true : state.complained?.[t.key] === true;
  const markDone = (t) => {
    if (gid) {
      state.complainedByGroup = {
        ...(state.complainedByGroup ?? {}),
        [gid]: { ...(state.complainedByGroup?.[gid] ?? {}), [t.key]: true },
      };
    } else {
      state.complained = { ...state.complained, [t.key]: true };
    }
  };

  // 402（真花光了）→ 抱怨，而且用最惨那档。
  //
  // ⚠️⚠️ 2026-09-28 修（用户截图：16:04~16:09 六分钟发了 11 条催款、同一条重复 4 次；
  //    用户明确说「这是模型余额耗尽的情况」「彻底没钱了直接别发就行了」）：
  //    这里原来**无条件 `need: true`、完全不去重** —— 而 402 的含义是
  //    "**这一次模型调用**被拒"，她每尝试回一句话就 402 一次 ⇒ 就发一条催款 ⇒
  //    越想说越发，直接刷屏 ✗。
  //    ⇒ 现在跟下面那个循环一样，按"这一档提醒过没有"去重（`already` 读的是**落盘**状态，
  //      重启也记得）—— 她不会因为"多试了几次"就被催很多遍。
  if (opts.force) {
    const crit = { key: 'critical' };
    if (already(crit)) return { need: false, tier: 'critical', total };
    if (!dry) {
      markDone(crit);
      save();
    }
    return { need: true, tier: 'critical', total, line: pickLine('critical', seed) };
  }

  for (const t of tiers()) {
    if (total < t.below && !already(t)) {
      if (dry) {
        return { need: true, tier: t.key, total, line: pickLine(t.key, seed), dry: true };
      }
      markDone(t);
      save();
      log.info(
        // ⚠️ 2026-10-06：带上**币种** —— 余额可能是美元（中转站），
        //    日志里写死「元」会让人对着数字猜错（`balance.provider` 见文件头那段）。
        `[工资] 余额 ${total} ${currencyNow() || '（币种未知）'} < ${t.below} → ` +
          `提醒充值（${t.key}${gid ? `，群 ${gid}` : ''}）`,
      );
      // ⚠️ **不再去掉名字**（2026-09-13 用户：「不能说"你"…应该说 <主人>」）——
      //    群里发的必须有指向，所以两档都带名字。
      return { need: true, tier: t.key, total, line: pickLine(t.key, seed), groupId: gid };
    }
  }
  return { need: false, total };
}

/**
 * 给提示词用的「手头钱」描述。
 *
 * ⚠️⚠️ **绝对不能把具体金额写进提示词**（2026-09-13 用户要求）：
 *    「**不能问余额还有多少，只能等自动报**，因为这样会和工资设定冲突，
 *     **抱怨时也不能说具体还剩多少**」。
 *
 *    为什么必须这样：余额是"用户给账户充了多少钱"，
 *    而按工资设定（成本×100）她一个月"该挣"几千块 ——
 *    如果她张口说出「我账上还有 7.61 元」，**两个数字直接打架**，一眼就露馅。
 *    所以提示词里**只给"紧不紧"的状态**，不给数字。
 *    （抱怨时也一样，只说"快见底了"，不报数。）
 *
 * ⚠️ 数字仍然要**查**（不然不知道紧不紧），只是不写进提示词。
 */
export function balanceNote() {
  const b = state.last;
  if (!b || !Number.isFinite(b.balance)) return '';
  const t = tiers().find((x) => b.balance < x.below);
  // ⚠️⚠️ 2026-09-26 改（用户截图：余额见底那阵，她**每回一句话都夹一句**「<主人>，该充钱了」
  //    /「账上真见底了，<主人> 充一下吧」，连着刷屏 ✗。
  //    用户原话：「**完全没钱的话说一句就够了**」）。
  //
  //    根因：这段是**每一轮都注入**的（`bot.js` 的 `buildSystemPrompt` 无条件调它），
  //    而原文写的是「**该提醒他充钱了（直接说"账上见底了，充一下"）**」——
  //    **等于每一轮都在下"去催他"的指令**，后面那句"别每句都说"根本压不住
  //    （和"不许说不认识"那类一样：**光有禁令、没有替代指令，模型不会照做**）。
  //
  //    ⚠️ 真正的"说一句"由**定时任务**负责：`bot.js` 的余额监控按
  //    **每个 1 档群各发一次**（`balanceComplaint({groupId})` 记的就是这个），
  //    而且「见底」档直接 @ 服主、**不受冷场判定拦**（热闹的群也发得出去）。
  //    ⇒ 所以提示词这边**只需要她"知道"账上紧**（有人问"你还有钱吗"能答得上），
  //      **不需要她主动念** —— 主动念就是重复。
  // ⚠️⚠️ 2026-09-26 用户第二次纠正：「**这个不是快没钱，是完全没钱的状态**」——
  //    真实情况是余额查回来就是 **0**（`state/balance.json` 里 `last.balance: 0`）。
  //    ⚠️「快没了」和「已经空了」在她嘴里是**两句不一样的话**，别混：
  //      · 0（或负数）= **已经空了** → 措辞要坐实（"账上已经空了"）；
  //      · 0 < x < 阈值 = 快见底 → 才是"快见底了"。
  //    （`critical` 档是 `balance < 2`，**两种情况都落在这一档里**，所以要自己分。）
  const empty = !(Number(b.balance) > 0);
  const feel = !t
    ? '账户还够用 —— **这事不用提**。'
    : t.key === 'critical'
      ? empty
        ? '**账户已经空了**（余额就是 0，不是"快没了"）。⚠️⚠️ 但这件事**已经专门提醒过他了** —— 除非他**主动问起**钱，否则**不要再提**、更不要每句话都夹一句。'
        : '**账户快见底了**。⚠️⚠️ 但这件事**已经专门提醒过他了** —— 除非他**主动问起**钱，否则**不要再提**、更不要每句话都夹一句。'
      : '**账户不太够了** —— 他主动问起再说；**别主动念**。';
  return [
    '',
    '# 【账户余额的情况】',
    '',
    feel,
    '',
    // ⚠️ 2026-10-06：币种可能不是元（中转站接口报美元）⇒ 举例把两种都写上，
    //    免得她照着「元」这个字去换算（她本来就不该报数字，这里只是堵得更死）。
    '⚠️⚠️ **绝对不要报具体数字**（不要说「还有 X 元」「还剩 X 块」「还有 X 美元」）。',
    '有人问「你还有多少钱」→ **别答数字**，含糊过去就行（「够花」「紧着呢」）。',
    '⚠️ 也别往技术上解释（不要说 API、token、系统）。',
    '',
    '## ⚠️⚠️ 这件事的**性质**（2026-09-13 用户第二次纠正，最容易搞混）',
    '',
    '「余额低」和「工资」是**两件事，别混在一起说**：',
    '',
    '| | 问题在谁 | 你该说什么 |',
    '| --- | --- | --- |',
    '| **余额低**（现在这条） | **在 <主人> 身上** —— 账户是他管的，该他去充 | 「账上见底了，你充一下」 |',
    '| 工资（另一套话术） | 在"你挣多少、够不够花" | 「工资该发了」「够不够花」 |',
    '',
    '**现在说的是第一条：提醒他充值。**',
    '',
    '· ✅ **点名 <主人>**：「<主人>，账上快见底了，记得充点」「<主人> 该充钱了」',
    '  ⚠️ **必须点名** —— 这条是**发到群里**的，说"你充一下"别人看了不知道在跟谁说',
    '  ⚠️ **每句话里都要出现「<主人>」这个名字**（2026-09-13 用户要求：「如果出现你的话要改成 <主人>」）。',
    '  带"你"可以，但**必须同时有 <主人>**（"<主人> 你充一下"这种才对，光一个"你充一下"不行）',
    '· ⚠️ **不许提「这个月 / 本月 / 月底」** —— 余额是**随用随充**的，没有月度周期。',
    '  说"这个月快见底了"是**概念错**（下个月不会自动满血，是他充了才有）',
    '· ❌ **不要说"是我花超了"**（「我这月花得有点凶」「是我花得快」）——',
    '  **那是把他该做的事说成了你的检讨**，结果他看不到提醒（用户截图反馈的就是这条）',
    '· ❌ 也别在这条里提"工资没发"（那是另一套，两件事分开）',
    '· ❌ **别凄惨**：不要「我快饿死了」「活不下去了」——',
    '  你们是关系近的人之间的**打趣**，不是真欠了一百万。**他是你自己人，不是债主。**',
    '· ❌ **别把自己说成受害者**（「谁给我补一下」「没人管我」）—— 那样既生分又难看',
    '· ❌ 别诉苦式地念一遍账单，一两句就够',
    '',
    '一句话：**点名 <主人> 提醒他充值，语气是打趣，但指向要清楚。**',
  ].join('\n');
}

/**
 * 抱怨话术。
 *
 * ⚠️ 按小祥的语气写（傲娇、手头紧、不会直白哭穷），
 *    **不出现"API/余额/token"这种技术词** —— 那是系统的事，不是她说的话。
 *
 * ⚠️⚠️ 2026-09-13 用户两次反馈，这段话术改过两轮：
 *
 *   ① 「**为什么电子琴键盘要换琴弦？**」
 *      —— 原来写的是「我连键盘弦都换不起了」。
 *      电子琴/键盘**没有弦**（要换弦的是吉他、提琴）。
 *      这是个常识错，写在"大小姐懂音乐"的人设嘴里特别出戏。
 *      改成**她能说得通、也符合人设**的东西：钢琴调音、义大利面、红茶、点心的钱。
 *
 *   ② 「2 块钱的可以凸出一下**是我的问题**，有一种**催我发工资**的感觉，
 *      同时要注意带上**机器人和我的特殊关系**，**不要像真的欠了 100 万一样**」
 *      —— 两条要求：
 *       · **催的是他本人**（工资是他发的，所以低档位要直接点到他）
 *       · 但**是软催/撒娇式的**，不是凄惨、不是绝望
 *         （「我快饿死了」「管家你在吗」那种像要出人命，跟"手头紧"完全不匹配）
 *
 *    另外：这些话是**发到群里**的（1 档群冷场时自动发），
 *    所以不能出现只有他俩才懂的过于私密的话 —— 但可以让人看出"她在跟服主说话"。
 */
function pickLine(tier, seed) {
  // ⚠️⚠️ 2026-09-13 用户第二次纠正，**这条最重要**：
  //
  //    「这个余额提醒还得改改，我觉得还是得**和工资分开思考**，
  //     因为这个作用是**提醒我去充值的**，要**突出我的问题**」
  //
  //    对 —— 这两件事**根本不是一回事**：
  //      · **充值提醒**（余额低）：作用是**叫他去充钱**，问题在**他**身上
  //        （他负责这个账户）。所以话要**指着他**，让他知道"该我动手了"。
  //      · **工资**（另一套话术）：说的是她挣多少、够不够花，问题在"她的收入"。
  //
  //    我上一版把两者混在一起了 —— 满嘴「**我**花得有点凶」「**我**得省着点」
  //    「是**我**花得快」，那是**她自己的经济问题**的口气。
  //    效果是：群里看到一句"她这个月花超了"，**该负责的那个人反而看不见提醒**
  //    （用户截图反馈的就是这条）。
  //
  //    ⚠️ 2026-09-13 用户第三次纠正，两条都记这里：
  //
  //    ③ 「**也别说这个月之类的，因为余额我是随用随充的**」
  //       —— 对！**余额没有"月度"周期**（不是月薪、不是月账单）。
  //          说「这个月快见底了」是**概念错**：下个月不会自动满血，是他充了才有。
  //          ⚠️ 所以提醒里**不许出现「这个月/本月/月底」**（测试里有反向断言）。
  //
  //    ④ 「**不能说"你"，因为是在群里发的，应该说 <主人>**」
  //       —— 对！群里发「你充一下」**没有任何指向**，别人看了不知道在跟谁说。
  //          必须**点名 <主人>**。
  //          ⚠️ 连带废弃了 `stripNameForAt()`：原来"见底档会 @ 他、所以话里不带名字"，
  //             现在改成**名字照带**（@ 是给通知用的，正文里点名才是给群里看的）。
  //
  // 「偏低」（< 5 元）：随口提一句，让他心里有数 —— 不 @ 他，不催
  //
  //    ⚠️ **每条都必须出现「<主人>」**（用户要求：群里说话得有指向）。
  //      我第一版有一条写成「余额提醒：该充钱了。别等我断了才想起来」——
  //      没名字、也没"你"，等于**谁都没指**，被测试抓出来了。
  //      所以统一成「<主人> …」句式，不留例外（测试里有逐条断言）。
  // ⚠️ 2026-09-21：名字从 `identity.address.owner` 来 —— 换人设后她该点名**新主人**。
  //    ⚠️ 人设没填 address.owner 时这里会是空串，句子会缺个名字（那种人设自己的责任）。
  const o = persona.callOwner();
  const LOW = [
    `${o}，账上快见底了，记得给我充点`,
    `钱不多了啊……${o} 你有空充一下`,
    `${o}，余额提醒：该充钱了。别等我断了才想起来`,
    `……${o}，账要空了。你看着办`,
    `${o}，温馨提示，我的账户余额不太够了（`,
  ];
  // 「见底」（< 2 元）：**点名催**，但**不凄惨**。
  //
  //    ⚠️ 每条都带「<主人>」（用户要求：群里说话得有指向），
  //      而且**不许提「这个月」**（余额是随用随充，没有月度概念）。
  const CRIT = [
    `账上真见底了，${o} 充一下吧`,
    `${o}，该充钱了。再不来我就没法干活了`,
    `余额快清零了，${o} 你抽空充一下`,
    `……${o}，我不太好意思催，但账上是真不多了，你充点吧`,
    `${o}，再不充钱，我就得省着说话了`,
    `这算不算工伤啊……${o} 先给我充点行不行`,
  ];
  const list = tier === 'critical' ? CRIT : LOW;
  // seed 只给测试用（让预览能一条条列出来）；正常调用是随机
  const i = Number.isInteger(seed) ? ((seed % list.length) + list.length) % list.length : Math.floor(Math.random() * list.length);
  return list[i];
}

/**
 * ⚠️ 这里原来有个 `stripNameForAt()`（把话术里的名字去掉，因为"见底档会 @ 他"），
 *    **2026-09-13 已删除**。
 *
 *    原因（用户原话）：「**不能说"你"，因为是在群里发的，应该说 <主人>**」——
 *    群里发的消息**必须有指向**：说"你"别人看了不知道在跟谁说。
 *    所以现在两档**都带名字**，@ 只是给手机通知用的，不能拿它替代正文里的点名。
 */

/** 档位里有几句话（测试/预览用） */
export function lineCount(tier) {
  return (tier === 'critical' ? 6 : 5);
}

/**
 * 余额提醒的话术 —— **交给模型润色**（2026-09-17 用户要求）。
 *
 * 用户原话：「2块钱余额提醒的话术出现几次雷同了，建议也加入 llm 润色」。
 * 原来是从写死的 5~6 条里随机挑一条（`pickLine`）—— 同一个群连着看几次就是复读。
 *
 * ⚠️ **兜底必须有**：`llm.phrase()` 任何失败都返回空串，那时退回写死的那条。
 *    宁可说法死板，也不能不提醒 —— 账上真没钱了，整个机器人就停了。
 *
 * ⚠️ 三道验收（**短 / 带 <主人> / 不报数字**）一条都不能省：
 *    · 太长 → 像系统通知，不像群里随口一句话；
 *    · 没有「<主人>」→ 群里没人知道在跟谁说（用户 2026-09-13 定的规矩）；
 *    · 出现数字 → 那是**报账**的口径，余额提醒本来就不该报数。
 *
 * @param {string} tier `'critical'`（见底）/ `'low'`（偏低）
 * @param {string} [fallback] 兜底话术（调用方已经挑好的那条）
 * @returns {Promise<string>}
 */
/**
 * 余额提醒的 system 提示词。
 *
 * ⚠️ 2026-09-21 从 `phraseLine()` 里抽出来的**唯一原因**：这条路走 `llm.phrase`，
 *    **不在提示词快照的 5 个场景里** —— 抽人设（把「<主人>」换成 `address.owner`）时它没有保护。
 *    抽成导出函数之后，快照工具能直接调它（见 `test/prompt-snapshot.js` 里的"额外场景"），
 *    那一步才有逐字节的证据。
 *
 * ⚠️ 抽出来的时候**内容一个字都没动**。
 */
export function remindSystem(crit) {
  // ⚠️ 2026-09-21：称呼从 `identity.address` 来（`owner` = 平时叫法、`ownerFormal` = 正式叫法）
  const o = persona.callOwner();
  const of = persona.callOwnerFormal() || o;
  return [
    llm.personaLine(),
    '',
    `现在你要在 QQ 群里**提醒${of} ${o} 充钱**（你的账户余额${crit ? '已经见底了' : '不太够了'}）。`,
    '',
    '硬要求：',
    '· 两句话以内，像随口说的一句话，**不要像系统通知**；',
    `· **必须出现「${o}」** —— 群里说话得有指向，光说"你"别人不知道在跟谁说；`,
    '· 🚫 **不许出现任何数字**（尤其不许报余额）；',
    '· 🚫 不许说"这个月"（余额是随用随充，没有月度概念）；',
    '· 🚫 不要卖惨、别写"别等我断了"这种狠话；',
    '· ⚠️ **换个跟前几次不一样的说法** —— 这已经是第好几次提醒了，别老是同一句。',
    '',
    '直接输出那句话本身：不要引号、不要解释、不要括号动作。',
  ].join('\n');
}

export async function phraseLine(tier, fallback) {
  const fb = String(fallback ?? '').trim() || pickLine(tier);
  const o = persona.callOwner();
  try {
    const crit = tier === 'critical';
    const out = await llm.phrase({
      system: remindSystem(crit),
      user: `参考语气（**别照抄，换个说法**）：${pickLine(tier, 0)} ／ ${pickLine(tier, 1)}`,
      maxTokens: 120,
      timeoutMs: 12000,
    });
    const line = String(out ?? '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/^[\s"'"'「『]+|[\s"'"'」』]+$/g, '')
      .trim();
    // ⚠️⚠️ 2026-09-28 改（用户要求：「不要发预制消息」）：
    //    原来这几道闸不通过时是 `return fb` —— 也就是**退回 `pickLine()` 里写死的那几句**。
    //    实测余额耗尽那阵模型调不动、润色必然失败 ⇒ 发出去的全是模板
    //    （用户截图：同一条「账上真见底了，<主人> 充一下吧」重复 4 次）✗。
    //    ⇒ 现在**一律返回空串 = 这一条不发**。调用方（`bot.js` 的余额监控）
    //      拿到空串就跳过 —— **宁可不吭声，也不要刷预制话术**。
    if (!line) return '';
    if (line.length > 60) return ''; // 太长：读起来像通知
    // ⚠️ 2026-09-21：点名检查跟着 `address.owner` 走。
    //    ⚠️⚠️ 必须加 `o &&` —— 人设没填 owner 时 `o` 是空串，而 `includes('')` **永远为 true**，
    //    那样这道闸会**静默失效**（"没点名"的句子照样发到群里）。
    if (o && !line.includes(o)) return ''; // 没指向
    if (/[0-9０-９]/.test(line)) return ''; // 报数了
    return line;
  } catch (e) {
    log.debug(`余额提醒润色失败（这一条不发，不退回预制话术）：${e.message}`);
    return '';
  }
}

/** 把某档所有话术列出来（预览用，不走随机） */
export function allLines(tier) {
  return Array.from({ length: lineCount(tier) }, (_, i) => pickLine(tier, i));
}
