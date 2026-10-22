/**
 * B站**主动评论**（2026-10-21 加）
 *
 * ## 用户要求（按时间）
 *   ① 「如果加上**主动在其他视频评论区发评论**的功能，她可以自己回复别人在她评论下发的评论吗」
 *   ② 「继续**主动去别人视频下发评论**的工作」
 *   ③ 「**和分享视频一样，可以差不多直接复用那边的所有设置**」
 *   ④ 「也可以加个**手动发一条**，但是要**显示出来发送的视频链接**」
 *
 * ## 分工
 *   · **这个文件** = 调度（今天该不该发、去哪个视频、发了几条、链接记在哪）
 *   · `tools/bili-proactive-comment.mjs` = 真干活（开浏览器 → 看视频 → 让她写 → 点「发布」）
 *   · 参数在 `config.biliProactive`（形态照 `biliShare` 抄：关键词 / 每天几条 / 时间段）
 *
 * ## ⚠️ 和常驻浏览器抢同一个 Chrome profile
 *   `state/bili-profile` 一个 user-data-dir 只能被一个 Chrome 占着 ⇒
 *   发之前要 `bili-comments.release({pauseMs:0})`（不暂停），发完 `warmup()` 再起回来 ✓
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config, ROOT, stateDir } from './config.js';
import { log } from './log.js';

const SCRIPT = join(ROOT, 'tools', 'bili-proactive-comment.mjs');
/** 历史留多少条（够界面回看就行） */
const KEEP = 60;

export function settings() {
  const c = config.biliProactive || {};
  /* ⚠️ 2026-10-21 用户问「**每天最多为什么还有上限20啊**」
   *   原来上限写死 20（我随手定的），他要设更多就被卡住 ✗
   *   ⇒ 放宽到 **50**。⚠️ 但还是留个上限：一天几百条必被 B站 风控 ✓
   */
  const min = Math.max(1, Math.min(50, Number(c.minPerDay) || 1));
  const max = Math.max(min, Math.min(50, Number(c.maxPerDay) || min));
  return {
    enable: c.enable === true,
    keywords: (Array.isArray(c.keywords) ? c.keywords : String(c.keywords || '').split(/[,，、\n]/))
      .map((s) => String(s).trim())
      .filter(Boolean),
    minPerDay: min,
    maxPerDay: max,
    startHour: Math.max(0, Math.min(23, Number(c.startHour) || 10)),
    endHour: Math.max(0, Math.min(24, Number(c.endHour) || 22)),
    maxResults: Math.max(4, Math.min(20, Number(c.maxResults) || 8)),
    /* ⚠️⚠️ 2026-10-22 加：**两次之间至少隔几分钟**（用户：「我是说 b站是怎么限的，
     *   你再根据 b站的限制对应更改 webui 限制设置逻辑」）
     *
     * ## B站 到底怎么限的（实测 + 公开资料，公开资料没给具体秒数，实测更可信）
     *   · **秒级冷却**：连发第二条直接被拦 —— 实测 00:40:30 成功、00:43 再发就**没提交**
     *     （内容原样留在输入框里）⇒ 3 分钟内连发第二条就失败 ✗
     *   · **被系统折叠的评论删了重发 ⇒ 触发 5 日评论功能限制**
     *     （见 B站《视频流量规则与避坑指南》：https://www.bilibili.com/opus/1042084491958419459）
     *   · 举报这类操作 B站 强制最低 30 秒 ⇒ 说明它确实有秒级节流，而且按操作类型分级
     *   · 刷屏会被限流（社区共识）
     *
     * ⇒ 所以**真正该让用户调的是"间隔"，不是"每天几条"**：
     *   一天 20 条但挤在半小时里发，照样被拦；一天 3 条每 2 小时一条，稳得多 ✓
     *   ⚠️ 下限给 **10 分钟**（比实测的 3 分钟红线留 3 倍余量）；
     *     上限给 **180 分钟**（一天最多 8 次，想更少就调大）
     *   ⚠️ 原来这个间隔是**硬编码 20 分钟**（`tick()` 里写死的），用户改不了 ✗
     */
    intervalMinutes: Math.max(10, Math.min(180, Number(c.intervalMinutes) || 20)),
  };
}

/* ── 状态（今天发了几条 + 历史链接） ─────────────────── */
function stateFile() {
  const dir = stateDir();
  try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return join(dir, 'bili-proactive.json');
}

function load() {
  try {
    const o = JSON.parse(readFileSync(stateFile(), 'utf8')) || {};
    return {
      day: String(o.day || ''),
      count: Number(o.count) || 0,
      target: Number(o.target) || 0,
      sent: Array.isArray(o.sent) ? o.sent : [],
      /* ⚠️⚠️ 2026-10-21 用户：「**评论视频一定不要重复评论**」
       *   `sent` 只留最近 60 条（界面回看用），**被挤掉之后就会重复评论同一个视频** ✗
       *   ⇒ 单独存一份**永久的 bvid 名单**（`visited`），**一条都不裁** ——
       *     一个 BV 号才 12 字节，攒到一万条也才 120KB，根本不占地方 ✓
       */
      visited: Array.isArray(o.visited) ? o.visited : [],
    };
  } catch {
    return { day: '', count: 0, target: 0, sent: [], visited: [] };
  }
}

function save(st) {
  const p = stateFile();
  const tmp = p + '.tmp';
  // ⚠️ 原子写（先 tmp 再 rename）—— 写到一半被杀不会留下半截 JSON ✓
  writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8');
  renameSync(tmp, p);
}

function dayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 跨天就重置"今天发了几条"，并**重新随机**今天的目标条数 */
function rollDay(st, c) {
  const t = dayStr();
  if (st.day === t) return st;
  const span = Math.max(1, c.maxPerDay - c.minPerDay + 1);
  st.day = t;
  st.count = 0;
  st.target = c.minPerDay + Math.floor(Math.random() * span);
  log.info(`[B站主动评论] 新的一天（${t}），今天打算发 ${st.target} 条`);
  return st;
}

/**
 * 现在该不该发一条？
 * @returns {{ok:boolean, why?:string}}
 */
export function due(now = new Date()) {
  const c = settings();
  if (!c.enable) return { ok: false, why: '没开' };
  if (!c.keywords.length) return { ok: false, why: '关键词是空的' };
  const st = rollDay(load(), c);
  save(st);
  const h = now.getHours();
  // 跨零点的时段（比如 22~2）也要能用
  const inWin = c.startHour <= c.endHour ? h >= c.startHour && h < c.endHour : h >= c.startHour || h < c.endHour;
  if (!inWin) return { ok: false, why: `不在 ${c.startHour}~${c.endHour} 点` };
  if (st.count >= st.target) return { ok: false, why: `今天已经发满 ${st.count}/${st.target} 条` };
  return { ok: true };
}

/* ── 挑一个视频 ─────────────────────────────────── */
/**
 * 按关键词搜一个视频（挑播放量最高的那条，且**今天没在她自己发过的里面挑过**）
 * @returns {Promise<{bvid:string, url:string, title:string, up:string, play:number, keyword:string}|null>}
 */
export async function pickVideo() {
  const c = settings();
  if (!c.keywords.length) return null;
  const st = load();
  // ⚠️ 用**永久名单**去重（不是 sent，sent 会被裁掉 ⇒ 裁掉之后就会重复评论 ✗）
  const done = new Set([...(st.visited || []), ...(st.sent || []).filter((x) => x.ok).map((x) => String(x.bvid || ''))].filter(Boolean));
  const bili = await import('./bilibili.js');
  // 打乱后依次试：某个词搜不到就换下一个（和 bili-share 一个路子）
  const order = c.keywords.slice().sort(() => Math.random() - 0.5);
  for (const kw of order) {
    try {
      const list = await bili.topicVideos(kw, { limit: c.maxResults });
      const fresh = (list || []).filter((v) => {
        const bv = (String(v.url || '').match(/video\/(BV[0-9A-Za-z]+)/) || [])[1] || '';
        return bv && !done.has(bv);
      });
      if (!fresh.length) {
        /* ⚠️ 2026-10-21 踩到：搜**限流**时接口返回空数组，这里就报「都评论过了」——
         *   用户看到日志"所有关键词都评论过了"，其实一条都没评论过 ✗
         *   ⇒ 分开说：搜到 0 条 = 可能被限流/这个词没结果；搜到了但都发过 = 真都发过 ✓ */
        log.info((list || []).length
          ? `[B站主动评论] 「${kw}」搜到 ${list.length} 条，但都评论过了，换下一个词`
          : `[B站主动评论] 「${kw}」**搜到 0 条**（可能被限流了 / 这个词没结果），换下一个词`);
        continue;
      }
      fresh.sort((a, b) => (Number(b.play) || 0) - (Number(a.play) || 0));
      const v = fresh[0];
      const bvid = (String(v.url || '').match(/video\/(BV[0-9A-Za-z]+)/) || [])[1] || '';
      if (!bvid) continue;
      return { bvid, url: `https://www.bilibili.com/video/${bvid}`, title: String(v.title || ''), up: String(v.up || ''), play: Number(v.play) || 0, keyword: kw };
    } catch (e) {
      log.warn(`[B站主动评论] 搜「${kw}」失败：${e.message}`);
    }
  }
  return null;
}

/* ── 真发一条 ───────────────────────────────────── */
/**
 * 跑一次"看视频 + 写评论 + 发布"
 * @param {{bvid?:string, url?:string, manual?:boolean}} o
 * @returns {Promise<{ok:boolean, video?:string, title?:string, comment?:string, err?:string}>}
 */
export async function runOnce({ bvid = '', url = '', manual = false } = {}) {
  if (!existsSync(SCRIPT)) return { ok: false, err: `找不到 ${SCRIPT}` };
  const args = [SCRIPT];
  if (bvid) args.push('--bvid', bvid);
  else if (url) args.push('--url', url);
  else return { ok: false, err: '没给 bvid / url' };

  /* ⚠️⚠️ 2026-10-21 用户：「**评论视频一定不要重复评论**」
   *   进脚本**之前**先挡一道（手动点两次、或者定时和手动撞一起，都在这里拦住）：
   *   这个 BV 号只要在永久名单里，就直接拒绝，连浏览器都不开 ✓
   */
  const bvIn = (String(bvid || '').match(/BV[0-9A-Za-z]+/) || [])[0]
    || (String(url || '').match(/BV[0-9A-Za-z]+/) || [])[0] || '';
  {
    const pre = load();
    if (bvIn && ((pre.visited || []).includes(bvIn))) {
      log.warn(`[B站主动评论] ${bvIn} **以前评论过了** ⇒ 不重复评论（用户明确要求）`);
      return { ok: false, already: true, err: `这个视频已经评论过了（${bvIn}），不重复评论` };
    }
  }

  // ⚠️ 让位：常驻浏览器占着同一个 profile，它不停这个脚本就起不来
  //   ⚠️ 2026-10-21 修：原来这里传 `pauseMs: 0` ⇒ 暂停**零毫秒**，
  //     而评论回复的 tick 每 60 秒就会 `ensure()` 起浏览器 ⇒ **跑到一半被抢 profile** ✗
  //     现在按脚本最长耗时（4 分钟）暂停，跑完再 `resume()` + `warmup()` 把它起回来 ✓
  let bc = null;
  try {
    bc = await import('./bili-comments.js');
    await bc.release({ pauseMs: 4 * 60 * 1000 });
  } catch { /* 没装/没起过都无所谓 */ }

  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true });
    let so = '';
    let se = '';
    const timer = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } }, 4 * 60 * 1000);
    p.stdout.on('data', (d) => { so += String(d); });
    p.stderr.on('data', (d) => { se += String(d); });
    p.on('close', () => { clearTimeout(timer); resolve({ so, se }); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ so, se: se + e.message }); });
  });

  // 脚本最后一行是 JSON 回执
  let res = null;
  for (const line of out.so.trim().split(/\r?\n/).reverse()) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try { res = JSON.parse(s); break; } catch { /* 不是回执 */ }
  }
  if (!res) {
    const tail = (out.so + out.se).trim().split(/\r?\n/).slice(-3).join(' ｜ ');
    return { ok: false, err: `脚本没给回执：${tail.slice(0, 300)}` };
  }

  // 记一笔（用户要的「显示出来发送的视频链接」就靠这个 sent 列表）
  const st = load();
  const bv = (String(res.video || '').match(/video\/(BV[0-9A-Za-z]+)/) || [])[1] || bvid || bvIn || '';
  st.sent = [{ at: Date.now(), bvid: bv, url: String(res.video || ''), title: String(res.title || ''), text: String(res.comment || ''), ok: res.ok === true, manual: !!manual }, ...(st.sent || [])].slice(0, KEEP);
  /* ⚠️ 只要**发成功**（或者脚本发现"页面上已经有我的评论了"），就把这个 BV 记进**永久名单**
   *   ⇒ 以后不管 sent 怎么裁，都不会再去同一个视频下发第二次 ✓
   * ⚠️ 2026-10-21 加 `uncertain`：脚本"点了发布但没核实到"时也记进名单 ——
   *   用户的要求是「**一定不要重复评论**」，所以宁可这条不再重试（他去 B站 看一眼就知道有没有）✓ */
  if (bv && (res.ok === true || res.already === true || res.uncertain === true)) {
    st.visited = [...new Set([...(st.visited || []), bv])];
  }
  if (res.ok && !manual) {
    st.count = (Number(st.count) || 0) + 1;
    if (!st.day) st.day = dayStr();
  }
  save(st);

  // 发完把常驻浏览器起回来（不然下次评论回复要等 2 秒冷启动）
  if (bc) {
    try { bc.resume(); bc.warmup(); } catch { /* ignore */ }
  }
  return res;
}

/* ── 定时调度 ───────────────────────────────────── */
let running = false;
let lastTryAt = 0;

/** 每 30 秒被 `index.js` 调一次 */
export function tick() {
  const c = settings();
  if (!c.enable) return;
  if (running) return;
  const d = due();
  if (!d.ok) return;
  // 别一直试：两次尝试之间至少隔 `intervalMinutes` 分钟（⚠️ 2026-10-22 从硬编码 20 分钟改成可配）
  //   搜不到视频、发失败了都算一次 ⇒ 避免疯狂重试把 B站 惹毛
  if (Date.now() - lastTryAt < c.intervalMinutes * 60 * 1000) return;
  lastTryAt = Date.now();
  running = true;
  log.info('[B站主动评论] 到点了，去找个视频说两句…');
  void (async () => {
    const v = await pickVideo();
    if (!v) { log.warn('[B站主动评论] 没挑到合适的视频（关键词都搜空了/都评论过了）'); return; }
    log.info(`[B站主动评论] 挑中《${v.title}》（${v.play} 播放，词：${v.keyword}）→ ${v.url}`);
    const r = await runOnce({ bvid: v.bvid });
    if (r.ok) log.info(`[B站主动评论] ✅ 发出去了：${r.video}｜「${String(r.comment || '').slice(0, 40)}」`);
    else if (r.uncertain) log.warn(`[B站主动评论] ⚠️ 点了发布但没核实到（${r.video}）—— 自己去 B站 看一眼有没有`);
    else log.warn(`[B站主动评论] ❌ 没发成：${r.err || ''}`);
  })()
    .catch((e) => log.warn(`[B站主动评论] 出错：${e.message}`))
    .finally(() => { running = false; });
}

export function status() {
  const c = settings();
  const st = load();
  const today = dayStr();
  return {
    ...c,
    running,
    today,
    countToday: st.day === today ? st.count : 0,
    targetToday: st.day === today ? st.target : 0,
    /** 最近发过的（界面「显示出来发送的视频链接」就是读它） */
    recent: (st.sent || []).slice(0, 20),
  };
}

export function __reset() {
  save({ day: '', count: 0, target: 0, sent: [], visited: [] });
  lastTryAt = 0;
}

/**
 * 这个视频是不是**已经评论过**了？（用户：「评论视频一定不要重复评论」）
 * ⚠️ 给界面用：手动发之前先问一句，好当场提示「已经评论过了」，而不是等日志里才看到 ✓
 */
export function alreadyCommented(bvidOrUrl = '') {
  const bv = (String(bvidOrUrl).match(/BV[0-9A-Za-z]+/) || [])[0] || '';
  if (!bv) return false;
  const st = load();
  return (st.visited || []).includes(bv);
}
