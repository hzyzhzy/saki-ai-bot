/**
 * 「自动清理」—— 把机器人在运行期攒下的临时产物按期限删掉（2026-10-06 用户要求）。
 *
 * 用户原话：「现在机器人自己 QQ 的聊天文件缓存占多少？我觉得可以加个自动清理的功能了，
 *   因为对机器人没用」
 *
 * ## ⚠️⚠️ 设计原则：**清单式删除**，不是"把旧的都删了"
 *
 * 只删下面 `RULES` 里**明确列出的模式**。理由是实测出来的：
 * `logs/` 里同时躺着 **`发布凭据.md`（GitHub PAT）**、人设/知识库的**备份**、
 * 以及各种 `.json` 状态快照 —— 为了省 100 MB 冒"删掉退路/删掉凭据"的风险，完全不值。
 *
 * 所以：
 *   · **白名单永远优先**：`*.md` / `*.json` / `*.bak-*` / `*.备份-*` / `*.keep` 一律不碰，
 *     哪怕它们长得像日志、哪怕它们很大；
 *   · 每条规则的**范围都限死在 ROOT 下的具体目录**，路径先解析再校验（防穿越）；
 *   · 删之前**逐条打日志**（删了哪个、多少 MB），出问题能查；
 *   · 支持 `dryRun`：只报不删（测试和界面预览都用它）。
 *
 * ## 收益最大的一条
 *
 * `logs/_uploaded/` —— **群友发给机器人看的文件**（`src/mc-log.js` 下载到这里）：
 * 实测 84.4 MB，里面是两份 38 MB 的整合包 zip、几份资源包、错误报告。
 * ⚠️ 她**读完就没用了**，但**正在读的时候不能删** ⇒ 所以按"保留 N 天"处理，
 * 而不是"入库就删"。
 */
import { readdirSync, statSync, unlinkSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { ROOT as PROJECT_ROOT, config } from './config.js';
import { log } from './log.js';

/**
 * ⚠️⚠️ **测试专用**：`QQBOT_CLEANUP_ROOT` 指到临时目录 ⇒ 绝不在真实 `logs/` 上做删除测试。
 *    （这个模块干的是 `unlink` / `rm -rf`，测试里演一遍"删对了"必须隔着临时目录。）
 * ⚠️ 必须在 `import` **之前**设好 —— 模块加载时求值，和本项目其它状态文件同一个规矩。
 */
const ROOT = process.env.QQBOT_CLEANUP_ROOT || PROJECT_ROOT;

const DAY = 24 * 60 * 60 * 1000;

/**
 * ⚠️ 这几条是**唯一**会被删的东西。加新规则之前先问自己：
 *    「它是可再生的吗？删了会不会丢凭据/退路？」
 */
const RULES = [
  {
    id: 'uploaded',
    label: '群友发给机器人看的文件（读完就没用）',
    dir: 'logs/_uploaded',
    days: () => days().uploadedDays,
    match: () => true,
  },
  {
    id: 'testtmp',
    label: '测试留下的临时目录（__know-* / __test-*）',
    dir: 'logs',
    days: () => days().tmpDays,
    match: (n) => /^__know-/.test(n) || /^__test-/.test(n),
    isDir: true,
  },
  {
    id: 'genphoto',
    label: '生图/临时图片产物（__gen-photo*）',
    dir: 'logs',
    days: () => days().tmpDays,
    match: (n) => /^__gen-photo/.test(n),
  },
  {
    id: 'botlog',
    label: '按天日志（bot-YYYY-MM-DD.log）',
    dir: 'logs',
    days: () => days().logDays,
    // ⚠️ 2026-10-07 多 QQ 号：非主号的日志带号后缀（`bot-<日期>-<QQ>.log`），
    //    这条规则要一起收，否则那些号的日志会**永远留在盘上**。
    match: (n) => /^bot-\d{4}-\d{2}-\d{2}(-\d{5,12})?\.log$/.test(n),
  },
  {
    id: 'testlog',
    label: '套件日志（test-*.log）',
    dir: 'logs',
    days: () => days().logDays,
    match: (n) => /^test-.*\.log$/.test(n),
  },
  {
    id: 'pending',
    label: '没收审核的待审表情',
    dir: 'library/_pending',
    days: () => days().pendingDays,
    match: () => true,
  },
];

/** ⚠️ 白名单：命中这些名字的**永远不删**，先于任何规则判断 */
const NEVER = [
  /\.md$/i, // ⚠️⚠️ 发布凭据.md 就在这一类里
  /\.json$/i, // 状态快照 / 凭据 / 配置
  /\.bak/i, // *.bak-* 退路
  /备份/, // *.备份-* 退路
  /\.keep$/i,
  /\.ya?ml$/i, // 配置
];

/** 各保留期（天）—— 配置能改，默认值在这里兜底 */
function days() {
  const c = config.cleanup ?? {};
  const n = (v, d) => {
    const x = Number(v);
    return Number.isFinite(x) && x >= 0 ? x : d;
  };
  return {
    uploadedDays: n(c.uploadedDays, 3),
    tmpDays: n(c.tmpDays, 3),
    logDays: n(c.logDays, 7),
    pendingDays: n(c.pendingDays, 14),
  };
}

/** 关掉了吗（`cleanup.enable === false` = 完全不干活，只报状态） */
function off() {
  return config.cleanup?.enable === false;
}

/**
 * 扫一遍：哪些**已经超期**、会被删。
 *
 * ⚠️ 不删任何东西（`run()` 才删）—— 界面预览和测试都用它。
 * @returns {{hits: Array<{path:string,rel:string,bytes:number,rule:string,isDir:boolean,ageDays:number}>, totalBytes:number}}
 */
export function scan() {
  const now = Date.now();
  const hits = [];
  for (const r of RULES) {
    const dir = resolve(join(ROOT, r.dir));
    // ⚠️ 路径必须在 ROOT 之内（防规则写错时删到外面）
    if (!dir.startsWith(resolve(ROOT) + sep)) {
      log.warn(`[清理] 规则 ${r.id} 的目录跑到 ROOT 外面了，跳过：${dir}`);
      continue;
    }
    if (!existsSync(dir)) continue;
    let names = [];
    try {
      names = readdirSync(dir);
    } catch (e) {
      log.debug(`[清理] 读不了 ${r.dir}：${e.message}`);
      continue;
    }
    const limit = r.days() * DAY;
    for (const name of names) {
      if (NEVER.some((re) => re.test(name))) continue; // ⚠️ 白名单先挡
      if (!r.match(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (r.isDir && !st.isDirectory()) continue;
      if (!r.isDir && st.isDirectory()) continue;
      const age = now - st.mtimeMs;
      if (age < limit) continue; // 还没超期
      hits.push({
        path: full,
        rel: `${r.dir}/${name}`,
        bytes: st.isDirectory() ? dirBytes(full) : st.size,
        rule: r.id,
        isDir: st.isDirectory(),
        ageDays: Math.floor(age / DAY),
      });
    }
  }
  return { hits, totalBytes: hits.reduce((n, h) => n + h.bytes, 0) };
}

/** 递归算一个目录的字节数（删之前要报"省了多少"，得算） */
function dirBytes(dir) {
  let n = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) n += dirBytes(p);
      else {
        try {
          n += statSync(p).size;
        } catch {}
      }
    }
  } catch {}
  return n;
}

/** 人看的 MB */
function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 真删（或 dryRun 只报）。
 *
 * @param {{dryRun?:boolean}} [opts]
 * @returns {{ok:boolean, dryRun:boolean, deleted:Array<{rel:string,bytes:number,rule:string}>, freedBytes:number, skipped:string}}
 */
export function run(opts = {}) {
  const dryRun = opts.dryRun === true || config.cleanup?.dryRun === true;
  if (off()) return { ok: false, dryRun, deleted: [], freedBytes: 0, skipped: 'cleanup.enable=false' };

  const { hits } = scan();
  const deleted = [];
  let freed = 0;
  for (const h of hits) {
    if (dryRun) {
      deleted.push({ rel: h.rel, bytes: h.bytes, rule: h.rule });
      freed += h.bytes;
      continue;
    }
    try {
      if (h.isDir) rmSync(h.path, { recursive: true, force: true });
      else unlinkSync(h.path);
      deleted.push({ rel: h.rel, bytes: h.bytes, rule: h.rule });
      freed += h.bytes;
      log.info(`[清理] 删掉 ${h.rel}（${mb(h.bytes)}，放了 ${h.ageDays} 天，规则 ${h.rule}）`);
    } catch (e) {
      log.warn(`[清理] 删不掉 ${h.rel}：${e.message}`);
    }
  }
  if (deleted.length) {
    log.info(
      `[清理] ${dryRun ? '（演练）' : ''}共 ${deleted.length} 项，${dryRun ? '可省' : '省下'} ${mb(freed)}`,
    );
  } else {
    log.debug('[清理] 没有超期的临时产物');
  }
  return { ok: true, dryRun, deleted, freedBytes: freed, skipped: '' };
}

/**
 * 给界面看的：各处占用 + 超期待清的。
 *
 * ⚠️ 只统计**我们管得着的目录** —— 协议端（SnowLuma）那 80 多 MB 是它的数据库，
 *    不在这里（那个只能在它自己的管理页处理）。
 */
export function status() {
  const now = Date.now();
  const dirs = [
    ['logs/_uploaded', '群友发来的文件缓存'],
    ['logs', '日志目录（含临时产物）'],
    ['library/_pending', '待审表情'],
    ['library', '表情库'],
    ['state', '运行期状态'],
  ];
  const sizes = dirs.map(([rel, label]) => {
    const full = join(ROOT, rel);
    let files = 0;
    let bytes = 0;
    if (existsSync(full)) {
      const walk = (d) => {
        try {
          for (const e of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isDirectory()) walk(p);
            else {
              files += 1;
              try {
                bytes += statSync(p).size;
              } catch {}
            }
          }
        } catch {}
      };
      walk(full);
    }
    return { rel, label, files, bytes };
  });
  const { hits, totalBytes } = scan();
  return {
    enable: !off(),
    dryRun: config.cleanup?.dryRun === true,
    days: days(),
    dirs: sizes,
    dueCount: hits.length,
    dueBytes: totalBytes,
    due: hits.map((h) => ({ rel: h.rel, bytes: h.bytes, ageDays: h.ageDays, rule: h.rule })),
    now,
  };
}

/** 测试专用：拿到规则清单（断言用） */
export function __rules() {
  return RULES.map((r) => ({ id: r.id, dir: r.dir }));
}

/** 测试专用 */
export function __never() {
  return NEVER.map((re) => re.source);
}
