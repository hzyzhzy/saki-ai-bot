/**
 * 工具调用次数统计（2026-10-19 用户要求）。
 *
 * 用户原话：「在**功能卡片**加一个**工具调用入口**，里面以**长条卡片**形式展示
 *            **所有目前已启用的工具**，并且在后面显示**累计调用次数**和**今日调用次数**」。
 *
 * ## 记什么
 * 每调一次工具 ⇒ `hit(名字)` ⇒ 存两本账：
 *   · `total[名字]`：**累计**（跨天不清）
 *   · `days['2026-10-19'][名字]`：**当天**（留着 30 天，够看"最近几天"）
 * ⚠️ 按天聚合 ⇒ 文件不会无限长大；30 天前的自动清 ✓
 *
 * ## 落哪
 * `state/tool-stats.json`（`state/` 不进版本库，这是运行期数据）。
 * ⚠️ 写盘**不 await**（调用方都是热路径，别为记账拖慢回复）；失败只记 debug ✓
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, stateDir } from './config.js';
import { log } from './log.js';

const FILE = process.env.QQBOT_TOOL_STATS_FILE
  ? join(ROOT, process.env.QQBOT_TOOL_STATS_FILE)
  : join(stateDir(), 'tool-stats.json');

const KEEP_DAYS = 30;

/**
 * **所有工具**的目录（界面按这个顺序展示）——
 * `scope`：`work` = 只有工作模式（工作号私聊）才有；`any` = 全场景（开思考链时就有）。
 */
export const CATALOG = [
  // ⚠️ 2026-10-19：这三条**群里也能用**（主人专用，闸在 `bot.js` 的 `runGroupTool`）——
  //    群里那条路做完的产物由 `agent-bridge.startRun()` 里的 `sendArtifacts` 发到群 ✓
  { name: '动这一单', scope: 'work', desc: '让她真去动手改/重做（私聊=假装延迟交付；**群里主人用=真开做，产物发群**）' },
  { name: '催进度', scope: 'work', desc: '派只读小代理看一眼做到哪了（群里主人用=看那件活到哪一步）' },
  { name: '停', scope: 'work', desc: '把这单停掉（群里主人用=停群里那件）' },
  { name: '交付', scope: 'work', desc: '发产物（范围/文件/时间都由她说；无延迟那档是立刻发）' },
  { name: '够开工', scope: 'work', desc: '材料齐了 ⇒ 进"问他要不要开始"那一档' },
  { name: '补收', scope: 'work', desc: '再拉一遍没下好的文件' },
  {
    name: '补发',
    scope: 'work',
    desc: '他说之前发的文件丢了 ⇒ 主对话点名 + 立刻发；那份已经不在了就如实说',
  },
  { name: '报价', scope: 'work', desc: '把"他在问价"报给主人' },
  { name: '收款码', scope: 'work', desc: '发收款码 + 润一句（20 条内不重复发）' },
  { name: '退款', scope: 'work', desc: '骂人 / 退款 ⇒ 记状态 + 报主人' },
  { name: '加急', scope: 'work', desc: '把交付时间往前赶' },
  { name: '截图', scope: 'work', desc: '真截一张（网页 / 文档都行）' },
  { name: '打住', scope: 'work', desc: '下一句不接（像人一样收住）' },
  { name: '搜', scope: 'any', desc: '真去联网搜，材料塞回上下文再重生成' },
  { name: '拍照', scope: 'any', desc: '真去生成一张图并单独发（工作模式禁用）' },
  { name: '查服务器', scope: 'any', desc: '查服务器开没开 / 怎么进' },
  { name: '花了多少', scope: 'any', desc: '查今天/这个月花了多少' },
  { name: '学到什么', scope: 'any', desc: '查她学过哪些东西' },
  { name: '好感度', scope: 'any', desc: '查某人跟她的好感度' },
  { name: '戳回去', scope: 'any', desc: '戳回对方一下' },
  { name: '闭嘴', scope: 'any', desc: '这个群先别说话（最多 30 分钟）' },
  { name: '查车次', scope: 'any', desc: '查火车车次（时刻表/途经站，走联网搜索）' },
  // ⚠️ 2026-10-19 工具化第三、四批 —— **加新工具一定要同步这张表**，
  //    不然她执行了、`hit()` 也记了，可界面那页根本不显示它（等于白统计）✗
  { name: '记住', scope: 'any', desc: '真写进学习档案（先过他"这话是不是他说的"那道闸）' },
  { name: '忘掉', scope: 'any', desc: '撤掉这个群最近记下的那条（服主/管理员）' },
  { name: '提醒', scope: 'any', desc: '定一条提醒（时间只认固定格式，算不出就问她）' },
  { name: '引用', scope: 'any', desc: '点名引用某条消息（省掉那次模型判定）' },
];

let data = null;

function load() {
  if (data) return data;
  try {
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    data = j && typeof j === 'object' ? j : {};
  } catch {
    data = {};
  }
  if (!data.total || typeof data.total !== 'object') data.total = {};
  if (!data.days || typeof data.days !== 'object') data.days = {};
  return data;
}

function save() {
  try {
    writeFileSync(FILE, JSON.stringify(data), 'utf8');
  } catch (e) {
    log.debug(`[工具统计] 写盘失败（不影响功能）：${e.message}`);
  }
}

function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 记一次调用（同步、便宜；失败也不抛 ✓） */
export function hit(name) {
  try {
    const n = String(name ?? '').trim();
    if (!n) return;
    const d = load();
    d.total[n] = Number(d.total[n] || 0) + 1;
    const k = dayKey();
    const day = d.days[k] ?? (d.days[k] = {});
    day[n] = Number(day[n] || 0) + 1;
    // 清 30 天前的
    const now = Date.now();
    for (const key of Object.keys(d.days)) {
      const t = new Date(`${key}T00:00:00`).getTime();
      if (Number.isFinite(t) && now - t > KEEP_DAYS * 86400000) delete d.days[key];
    }
    save();
  } catch (e) {
    log.debug(`[工具统计] 记录失败（不影响功能）：${e.message}`);
  }
}

/**
 * 给界面用：**所有工具** + 累计 / 今日次数。
 * @param {{workEnabled?: boolean}} opts `workEnabled` = 这个号开没开工作模式
 *        （关着的号不显示那 12 个工作模式工具 ✓）
 */
export function snapshot({ workEnabled = false } = {}) {
  const d = load();
  const today = d.days[dayKey()] ?? {};
  const list = CATALOG.filter((x) => x.scope === 'any' || workEnabled).map((x) => ({
    name: x.name,
    scope: x.scope,
    desc: x.desc,
    total: Number(d.total[x.name] || 0),
    today: Number(today[x.name] || 0),
  }));
  const sum = (k) => list.reduce((s, x) => s + Number(x[k] || 0), 0);
  return {
    workEnabled: !!workEnabled,
    list,
    totalAll: sum('total'),
    todayAll: sum('today'),
    day: dayKey(),
  };
}

/** 测试用 */
export function __reset() {
  data = { total: {}, days: {} };
}
