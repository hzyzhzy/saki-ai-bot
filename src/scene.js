/**
 * 剧情「现场状态机」—— 道具 / 攻受方 / 身体进度，三个维度一起记。
 *
 * ⚠️⚠️ 2026-10-24 加（用户：「**能不能像位置和吃饭一样加一个状态机？**」
 *    后来又补：「**除了道具，攻受方，身体状态之类都可以记下来**」）
 *
 * 要解决的问题（都是实测过的真毛病）：
 *   ① **道具用到后面就被忘掉** —— 只靠提示词提醒只能捞回 1~2 轮 ✗
 *   ② **攻受（S/M）模糊** —— 同一个人第 10 轮发命令、第 14 轮又被按住，读者跟不上 ✗
 *   ③ **身体状态回退** —— 前面已经湿过了，后面又写"开始湿了" ✗
 *   ④ **太快到顶** —— 说了 18 轮之前不许到，它还是第 12 轮就写"到了" ✗
 *
 * ⇒ 做法和 `where.js`（位置）/ `meal.js`（吃饭）一样：**状态存盘 + 每轮注入一句**。
 *    但**状态由她自己报**（正文末尾一行），代码只负责【解析 → 存 → 下一轮提醒 → 剥掉那一行】✓
 *    ⇒ 完全符合「工具/判断只能由她自己来，代码不许猜」那条铁律 ✓
 *
 * 标记协议（她自己写，代码只认这个固定开头 —— 协议，不是猜人话）：
 *    （状态：湿2 到顶1 衣1 攻=爱音 道具=那根/前面/开）
 *    · 湿 = 0 没 / 1 有点 / 2 明显 / 3 止不住
 *    · 到顶 = 到过几次
 *    · 衣 = 0 整齐 / 1 乱了 / 2 褪了
 *    · 攻 = 现在谁是 S（填名字）
 *    · 道具 = 名称/位置/开关（开 或 关）；没有就写 道具=无
 *
 * 生命周期：**一条剧情 = 一份状态**（`reset(groupId)` 在开剧情时清掉）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const FILE = process.env.QQBOT_SCENE_FILE
  ? String(process.env.QQBOT_SCENE_FILE)
  : join(process.cwd(), 'state', 'scene.json');

let data = null;
const load = () => {
  if (data) return data;
  try {
    data = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
    if (!data || typeof data !== 'object') data = {};
  } catch {
    data = {};
  }
  return data;
};
const save = () => {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(load(), null, 2), 'utf8');
  } catch {
    /* 存不下就算了 —— 这只是提醒，不该把主流程搞挂 */
  }
};

export function path() {
  return FILE;
}

export function reset(groupId) {
  const g = String(groupId ?? '');
  if (!g) return;
  const d = load();
  if (d[g]) {
    delete d[g];
    save();
  }
}

/** 合并式更新（只给变化的那几项就行） */
export function apply(groupId, patch) {
  const g = String(groupId ?? '');
  if (!g || !patch) return;
  const d = load();
  const prev = d[g] ?? {};
  d[g] = {
    wet: patch.wet === undefined ? prev.wet : Number(patch.wet),
    climax: patch.climax === undefined ? prev.climax : Number(patch.climax),
    cloth: patch.cloth === undefined ? prev.cloth : Number(patch.cloth),
    top: patch.top === undefined ? prev.top : String(patch.top || ''),
    prop: patch.prop === undefined ? prev.prop : patch.prop,
    at: Date.now(),
  };
  save();
}

/** 状态的有效期 —— 超过就当成没有（和 where.js 的"说过的话会过期"同一个思路） */
export const KEEP_MS = 3 * 60 * 60 * 1000;

export function current(groupId, now = Date.now()) {
  const v = load()[String(groupId ?? '')];
  if (!v) return null;
  // ⚠️ 过期就当没有 —— 不然上一条剧情的状态会串到这一条上（开新剧情忘了清的时候）✗
  if (v.at && now - Number(v.at) > KEEP_MS) return null;
  return JSON.parse(JSON.stringify(v));
}

const WET = ['', '有点潮', '明显湿了', '止不住'];
const CLOTH = ['穿着', '衣服乱了', '衣服褪了'];

/** 拼进提示词的那一句。没状态 ⇒ ''（日常聊天一个字都不加） */
export function hint(groupId) {
  const v = current(groupId);
  if (!v) return '';
  const bits = [];
  if (v.wet) bits.push(WET[v.wet] || `湿度${v.wet}`);
  if (v.climax) bits.push(`已经到过 ${v.climax} 次`);
  if (v.cloth) bits.push(CLOTH[v.cloth] || `衣服${v.cloth}`);
  if (v.top) bits.push(`现在是 ${v.top} 主导（S）`);
  if (v.prop?.item) {
    const p = [v.prop.item];
    if (v.prop.where) p.push(v.prop.where);
    if (v.prop.on) p.push('还开着');
    bits.push(`道具「${p.join('·')}」`);
  }
  if (!bits.length) return '';
  return (
    `📌 **现场状态**（上一轮你自己报的 —— 这一轮**不许和它矛盾**）：${bits.join('｜')}\n` +
    `　· 🚫 湿过就别再写"开始湿了"；到过顶就是"还没缓过来"，不许再写第一次；\n` +
    `　· 🚫 衣服褪了别再写去解扣子；攻方是**那个**就保持那个（要换必须明确换）；\n` +
    `　· 🚫 道具当它不存在 ⇒ 至少用半句交代它现在什么状态 ✓`
  );
}

export function status(groupId) {
  return current(groupId);
}

/**
 * ⚠️⚠️ 2026-10-24 加（用户：「**只要开头提到道具，就直接把那个道具提示词优先级放到最高，
 * 把手的动作大部分都换成道具动作**」）
 *
 * 只在**这一场真的有道具**时返回（她自己报过 `prop`）；比 `hint` 更硬：
 * 不是"别忘了它"，而是"**这一轮主要是它在做，手只是扶着**" ✓
 */
export function hasProp(groupId) {
  const v = current(groupId);
  return !!(v && v.prop && v.prop.item);
}

export function propHint(groupId) {
  const v = current(groupId);
  if (!v || !v.prop || !v.prop.item) return '';
  const where = v.prop.where
    ? `（现在在${v.prop.where}${v.prop.on ? '，还开着）' : '）'}`
    : v.prop.on
      ? '（还开着）'
      : '';
  return [
    `🔴🔴 **这一场「${v.prop.item}」已经用上了${where} ⇒ 这一轮它不是配角，是主线**：`,
    '　· ✅ **大部分动作换成用它做**：不用手指了 —— 用它抵着 / 扶着往里 / 推 / 压住 / 隔着磨；',
    '　· ✅ 手只干两件事：**扶着它**（对准、固定、别滑出去）和**按住她**（不让她躲、不让她合腿）；',
    '　· ✅ 每写一处接触，先问一句「这一处能不能用它」—— 能就换掉；',
    '　· 🚫 别写着写着又回去用手指，也别把它晾在一边 ✗',
  ].join('\n');
}

export function __clear() {
  data = {};
  save();
}

/**
 * 从正文里认出并剥掉那一行状态标记。
 * @returns {{text:string, patch:object|null}}
 */
export function takeMarker(raw) {
  const s = String(raw ?? '');
  const re = /[（(]\s*状态\s*[:：]([^）)\n]{0,120})[）)]/;
  const m = s.match(re);
  if (!m) return { text: s, patch: null };
  const body = m[1].trim();
  const text = s.replace(re, '').replace(/\n{3,}/g, '\n\n').trim();
  const patch = {};
  // ⚠️ 两种写法都要认：「湿2」和「湿=2」「湿 2」——
  //    第一版只认带等号的，结果她写「湿3 攻=祥子」时湿那项**整个被漏掉** ✗
  const grab = (key) => {
    const r = new RegExp(key + '\\s*[=＝:：]?\\s*([^\\s·,，、｜|]+)');
    const mm = body.match(r);
    return mm ? mm[1] : '';
  };
  const wet = grab('湿');
  if (wet) patch.wet = Math.max(0, Math.min(3, Number(wet) || 0));
  const cl = grab('到顶');
  if (cl) patch.climax = Math.max(0, Math.min(9, Number(cl) || 0));
  const cb = grab('衣');
  if (cb) patch.cloth = Math.max(0, Math.min(2, Number(cb) || 0));
  const top = grab('攻');
  if (top) patch.top = top;
  // 道具：名称/位置/开关（用 / 或 ／ 分段，别把整串吞成一个名字 ✗ 第一版就是）
  const it = body.match(/道具\s*[=＝:：]?\s*([^/\／\s·,，、｜|]+)(?:[/／]([^/\／\s·,，、｜|]+))?(?:[/／]([^/\／\s·,，、｜|]+))?/);
  if (it) {
    const name = it[1] ?? '';
    if (/^(无|没有|none|0)$/i.test(name)) patch.prop = null;
    else {
      // ⚠️ 2026-10-24 修：她有时候把一整句写进名字里（实测出现过 `item: "那根滚到被子边上了"`）
      //    ⇒ 名字只留前 8 个字、逗号句号之后的都不算名字 ✓
      const clean = String(name)
        .split(/[，。！？、…；：]/)[0]
        .trim()
        .slice(0, 8);
      patch.prop = {
        item: clean || '那个东西',
        where: it[2] ?? '',
        on: /^(开|开着|on|响|震)$/i.test(it[3] ?? '') ? true : /^(关|关了|off)$/i.test(it[3] ?? '') ? false : undefined,
      };
    }
  }
  return { text, patch };
}
