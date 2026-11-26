// 记忆页要列的东西：全都按"记忆"归类，而不是按"知识库"。
//
// ⚠️⚠️ 2026-11-27 两次返工，别再把这里写回"只按整份文件列"：
//   ① 有些"记忆"不是一整份 md，而是**某份文件中间的一段**（自动维护区）：
//      · `owner.md` 的 `OWNER-RECENT` —— 他最近在忙什么，48 小时滚动（`owner-recent.js` 写）
//      · `group-memory.md` / `groups/<群号>.md` 的 `AUTO-OBSERVE` —— 对群和群友的印象（`observe.js`）
//      · `learned.md` 的 `LEARNED` —— 她自己的笔记（`learned.js`）
//      条目带 `seg`：**只读那一段、只写那一段**（整份存回去会把别的内容冲掉 ✗）
//   ② 有些记忆是**各号共用**的（同一个主人、同一批梗），而副号的知识目录是
//      `knowledge/accounts/<QQ>/`，里面**没有** `owner.md` ⇒ 副号进来一片空白
//      （用户截图：「还是没看到」）。所以共享文件要能**回落到共用知识目录**。
//      ⚠️ 只有真共享的才回落 —— `group-memory.md` / `groups/` / `learned.md` / `dm/`
//      是每号自己的，回落会串号（B 号看到 A 号跟那些群的印象）✗
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { KNOWLEDGE_DIR } from './config.js';
// ⚠️ 认识视图要按 QQ 号合并（昵称可以改），映射在 `state/people.json`
import * as people from './people.js';

/** 各号共用、找不到时回落到共用知识目录的那几份（每个号都该看到同一个主人） */
const SHARED = new Set([
  'owner.md',
  'relationship.md',
  'friends.md',
  'recent-events.md',
  'nicknames.md',
  'memes.md',
  'memes-auto.md',
]);

/** 这个文件该去哪些目录里找（私有在前，共享的再回落一层） */
function dirsFor(kdir, rel) {
  const out = [kdir];
  if (SHARED.has(rel) && KNOWLEDGE_DIR && KNOWLEDGE_DIR !== kdir) out.push(KNOWLEDGE_DIR);
  return out;
}

const fmtTime = (ms) => {
  try {
    if (!Number(ms)) return '';
    const d = new Date(Number(ms));
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch {
    return '';
  }
};

/** 整份文件的显示信息（读不到就是 null） */
function infoIn(dir, rel, label, desc, extra = {}) {
  const p = join(dir, rel);
  try {
    const st = statSync(p);
    return { name: rel, label, desc, size: st.size, mtime: fmtTime(st.mtimeMs), ...extra };
  } catch {
    return null;
  }
}

/** 整份文件：私有优先，共享的会回落 */
function info(kdir, rel, label, desc, extra = {}) {
  for (const d of dirsFor(kdir, rel)) {
    const it = infoIn(d, rel, label, desc, extra);
    if (it) return it;
  }
  return null;
}

/**
 * 找出 `<!-- SEG:BEGIN …-->` 与 `<!-- SEG:END -->` **所在的行号**。
 *
 * ⚠️⚠️ 两个坑（各踩一次）：
 *   ① **不能要求标记独占一行**：`owner.md` 的 BEGIN 前面还挂着半句说明
 *      （`> ⚠️ … ✗ <!-- OWNER-RECENT:BEGIN（…）-->`），`group-memory.md` 的 END 后面拖着 ` ---` ✗
 *   ② **也不能简单 `includes`**：文件头说明里会同时提到 BEGIN 和 END（拿来给人对照），
 *      那一行会先被命中 ⇒ 取出来的"正文"是半行字、写回去更会把别的内容冲掉 ✗
 *   ⇒ 判据：**同一行里只有 BEGIN 或只有 END 的才算真标记**，两个都有的那行是说明，跳过。
 */
function locateSegment(lines, seg) {
  const beginMark = `<!-- ${seg}:BEGIN`;
  const endMark = `<!-- ${seg}:END`;
  let bi = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/\r$/, '');
    const hasBegin = l.includes(beginMark);
    const hasEnd = l.includes(endMark);
    if (hasBegin && hasEnd) continue; // 说明行，跳过
    if (bi < 0) {
      if (hasBegin) bi = i;
      continue;
    }
    if (hasEnd) return { bi, ei: i };
  }
  return null;
}

/**
 * 取某份文件里 `<!-- XXX:BEGIN -->` 和 `<!-- XXX:END -->` 之间的正文。
 * ⚠️ BEGIN 行本身可能带说明 ⇒ 只从**该行之后**开始取。
 */
export function readSegment(dir, rel, seg) {
  const p = join(dir, rel);
  let text = '';
  let mtimeMs = 0;
  try {
    text = readFileSync(p, 'utf8');
    mtimeMs = statSync(p).mtimeMs;
  } catch {
    return null;
  }
  const lines = text.split('\n');
  const at = locateSegment(lines, seg);
  if (!at) return null;
  const body = lines
    .slice(at.bi + 1, at.ei)
    .join('\n')
    .trim();
  return { body, mtimeMs };
}

/**
 * 只替换那一段的正文，**BEGIN 行（含括号里那句说明）和 END 行原样留着**。
 * @returns {string|null} 新版全文；找不到标记返回 null
 */
export function replaceSegment(text, seg, content) {
  const lines = String(text ?? '').split('\n');
  const at = locateSegment(lines, seg);
  if (!at) return null;
  const body = String(content ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
  // ⚠️ 内容没变就原样返回 —— 保证"读出来再存回去"不会让文件悄悄多出空行
  if (lines.slice(at.bi + 1, at.ei).join('\n').trim() === body) return String(text);
  const mid = body ? ['', ...body.split('\n'), ''] : [''];
  return [...lines.slice(0, at.bi + 1), ...mid, ...lines.slice(at.ei)].join('\n');
}

/**
 * 区段条目：只显示那一段（size/count 按段算，不按整份文件）。
 * @param {{countBy?: 'bullet'|'heading'}} [extra] 条数怎么数：
 *   `bullet`（默认，`- xxx` 一行一条，近况/群印象用）、`heading`（`## 主题` 一条，笔记用）
 */
function segInfoIn(dir, rel, seg, label, desc, extra = {}) {
  const got = readSegment(dir, rel, seg);
  if (!got) return null;
  const by = extra.countBy === 'heading' ? /^\s*##\s+\S/ : /^\s*[-*·]/;
  const lines = got.body.split('\n').filter((l) => by.test(l));
  return {
    name: rel,
    seg,
    label,
    desc,
    size: got.body.length,
    count: lines.length,
    mtime: fmtTime(got.mtimeMs),
    ...extra,
  };
}

/** 区段：私有优先，共享的会回落 */
function segInfo(kdir, rel, seg, label, desc, extra = {}) {
  for (const d of dirsFor(kdir, rel)) {
    const it = segInfoIn(d, rel, seg, label, desc, extra);
    if (it) return it;
  }
  return null;
}

/**
 * @param {string} kdir 这个号的知识目录（`knowledgePrivateDir()`）
 * @returns {{sections:Array, planned:Array}}
 */
export function memoryOverview(kdir) {
  const sections = [];
  const pick = (arr) => arr.filter(Boolean);

  // ① 她对群和群友的印象（`observe.js` 自动维护那段）
  const groups = [];
  const gdir = join(kdir, 'groups');
  try {
    for (const f of readdirSync(gdir)) {
      if (!f.endsWith('.md')) continue;
      const gid = f.replace(/\.md$/, '');
      // ⚠️ 名字必须带 `groups/` 前缀 —— 界面拿它去读写接口，那条路认的是相对知识目录的路径
      const it = segInfoIn(
        kdir,
        `groups/${f}`,
        'AUTO-OBSERVE',
        `群 ${gid}`,
        /^\d+$/.test(gid) ? '这个群自己的印象：谁是谁、什么性格、群里发生过什么' : '',
        { readonly: true },
      );
      if (it) groups.push(it);
    }
  } catch {
    /* 还没有 groups/ 目录 */
  }
  groups.sort((a, b) => b.size - a.size);
  sections.push({
    key: 'group',
    title: '群里的印象',
    desc:
      '她自己在群里攒下来的：谁是谁、什么性格、群里发生过什么。' +
      '这一段由「群观察」自动维护（每群每 30 分钟到 6 小时跑一次），界面只读 —— ' +
      '要改就直接打开整份文件改（那样会被下次观察重新融合）。',
    items: pick([
      segInfo(kdir, 'group-memory.md', 'AUTO-OBSERVE', '共享群记忆', '所有群共用的那一份（老数据在这里）', {
        readonly: true,
      }),
      ...groups,
    ]),
  });

  // ② 主人与熟人（这几份是各号共用的 ⇒ 副号也能看到同一个主人）
  sections.push({
    key: 'people',
    title: '主人与熟人',
    desc:
      '关于你、你的朋友、你和她的相处事实。⚠️ 写进来她会当成真事记着。' +
      '（`owner.md` 里除了这段「近况」，其余是你本人的静态资料 —— 在「知识库」页改。）',
    items: pick([
      segInfo(
        kdir,
        'owner.md',
        'OWNER-RECENT',
        '你最近在忙什么',
        '机器人自己攒的，超过 48 小时自动消失；这一段就是「你对主人的动态记忆」',
      ),
      info(kdir, 'relationship.md', '你和她的关系', '相处方式、称呼、约定'),
      info(kdir, 'friends.md', '熟人 / 朋友', '你现实里的朋友、老同学（谁问都读）'),
    ]),
  });

  // ③ 她学到的（笔记是每号自己的；黑话和梗库共用）
  sections.push({
    key: 'learned',
    title: '学过的',
    desc:
      '她自己的笔记（是什么 / 什么时候用 / 别弄错）+ 听懂的黑话、梗。' +
      '笔记由群里教的和观察时自己听到的攒成，同一件事会合并进已有那条。',
    items: pick([
      segInfo(kdir, 'learned.md', 'LEARNED', '她的笔记', '每条以 `## 主题` 开头；正文三段，标记别删', {
        countBy: 'heading',
      }),
      info(kdir, 'nicknames.md', '名词 / 黑话对照', '群里那些词指的是什么（听到就按这里理解）'),
      info(kdir, 'memes.md', '梗库（人工确认过）', '命中触发词才会被带上，不常驻提示词'),
      info(kdir, 'memes-auto.md', '梗库 · 自动收录', '`memes-auto.js` 每 16 分钟重写，别手改', {
        readonly: true,
      }),
    ]),
  });

  // ④ 口癖库（动态：群观察会往里补；界面可改，改完立刻生效）
  sections.push({
    key: 'phrases',
    title: '口癖库',
    desc:
      '她和群里这些人平时**真会说的词 + 怎么用**（动态库：群观察每批会往里补）。' +
      '⚠️ 口癖会随时代变 —— **过时的直接删**，这条比"只增不减"重要。改完立刻生效（不用重启）。',
    items: pick([
      segInfo(
        kdir,
        'phrases.md',
        'PHRASES',
        '人工底本（自动流程不动它）',
        '你确认过的词；⚠️ 自动学习一个字都不许改这里。过时的直接删',
      ),
      segInfo(
        kdir,
        'phrases.md',
        'PHRASES-AUTO',
        '自动攒的',
        '群观察每批往这里补；**同一个词只完善用法，不会重复起一行**',
      ),
    ]),
  });

  // ⑤ 日记（她自己写的一天一篇；文件在 `diary/YYYY-MM-DD.md`）
  //    ⚠️ 这里直接扫目录、不 import `diary.js` —— 那个模块会连带 llm/recent，
  //    而这一页只是"列文件"，没必要把整条回答链拉进来。
  const diaries = [];
  const diaryDir = join(kdir, 'diary');
  try {
    const names = readdirSync(diaryDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .slice(0, 30);
    for (const f of names) {
      const p = join(diaryDir, f);
      let text = '';
      let st = null;
      try {
        text = readFileSync(p, 'utf8');
        st = statSync(p);
      } catch {
        continue;
      }
      const body = text
        .split('\n')
        .filter((l) => l.trim() && !l.startsWith('# '))
        .join('\n')
        .trim();
      diaries.push({
        name: `diary/${f}`,
        label: f.replace(/\.md$/, ''),
        desc: body.split('\n')[0]?.slice(0, 80) ?? '',
        size: st.size,
        mtime: fmtTime(st.mtimeMs),
      });
    }
  } catch {
    /* 还没写过日记 */
  }
  sections.push({
    key: 'diary',
    title: '日记',
    desc:
      '她自己写的一天一篇（每天夜里写，只给她自己和主人看）。' +
      '写的是当天具体的人和事 —— 别指望它像总结报告。点开能改、也能删。',
    items: diaries,
  });

  // ⑤ 私聊记忆
  const dms = [];
  const ddir = join(kdir, 'dm');
  try {
    for (const f of readdirSync(ddir)) {
      if (!f.endsWith('.md')) continue;
      const qq = f.replace(/\.md$/, '');
      const it = infoIn(kdir, `dm/${f}`, `私聊 ${qq}`, '只在跟他私聊时读到');
      if (it) dms.push(it);
    }
  } catch {
    /* 没有 dm/ */
  }
  dms.sort((a, b) => b.size - a.size);
  if (dms.length) {
    sections.push({ key: 'dm', title: '私聊记忆', desc: '跟某个人私聊攒下来的事，只在那个私聊里读得到。', items: dms });
  }

  // 她已经认识的人（只读聚合视图，数据来自上面那几份群记忆）
  const peopleKnown = recognize(kdir);
  // 最近发生的事（汇总各群记忆的「大事」）
  const recent = recentEvents(kdir);

  // 还没做的（现在两件都做完了，留着这个字段给界面用）
  const planned = [];

  // ⚠️ 「日记」就算一篇都没有也要留着这一块 —— 否则界面上连"会写日记"这件事都看不到
  return {
    sections: sections.filter((s) => s.items.length || s.key === 'diary'),
    recognize: peopleKnown,
    recent,
    planned,
  };
}

/** 给 `/api/memory/segment` 用：允许编辑的区段白名单（别的名字一律拒） */
export const EDITABLE_SEGMENTS = new Set(['OWNER-RECENT', 'LEARNED', 'PHRASES', 'PHRASES-AUTO']);

/** 这个区段是否在这份文件里（写之前先确认，免得凭空建出一个坏文件） */
export function segmentExists(dir, rel, seg) {
  return Boolean(readSegment(dir, rel, seg)) && existsSync(join(dir, rel));
}

/**
 * 昵称归一化 —— 同一个人常被写成好几种：
 * `Anon` / `新成员Anon` / `Anon（补充三）` / `**Anon**`。
 * ⚠️ 群记忆里这些是**分三次写的**（观察每批只认当批看到的写法），
 *    不归一化的话「认识」里同一个人会站三排 ✗（实测：Anon 就是这么三条）
 * ⚠️ 只在这个只读视图里归并，**不动源文件**（改数据要先问用户）。
 */
function normName(raw) {
  return String(raw ?? '')
    .replace(/\*\*/g, '')
    .replace(/^\s*(?:新成员|新增|补充|备注|观察|性格)\s*/, '')
    .replace(/[（(]\s*(?:再\s*补充|补充|新增|备注|观察|续写)[^）)]{0,6}[）)]\s*$/, '')
    .replace(/[（(]\s*\d+\s*[）)]\s*$/, '')
    .replace(/\s+/g, '')
    .trim();
}

/**
 * 「最近发生的事」—— 从各群记忆的「大事」那节汇总出来（只读）。
 *
 * ⚠️ 为什么不是直接显示 `knowledge/recent-events.md`（2026-11-27 用户问「为什么都是空的」）：
 *    那份文件的文件头写着"她自己可以用 `[工具:记住]` 追加" —— 但 `记住` 工具化之后走的是
 *    `learn()`（写 learned / server-*），**根本没人往这个文件里写** ⇒ 那格永远是空的。
 *    所以这里改成汇总**真实在产生**的东西：群记忆里每批观察写下的「大事」。
 *    ⚠️ 那个文件仍然保留（他自己手写的那份），下面 `handwritten` 把它带出来。
 * @returns {{items:Array<{text:string,from:string}>, handwritten:boolean}}
 */
export function recentEvents(kdir) {
  const seen = new Set();
  const items = [];
  const push = (text, from) => {
    const t = String(text ?? '')
      .replace(/^\s*[-*·]\s*/, '')
      .replace(/\*\*/g, '')
      .trim();
    if (!t || t.length < 6) return;
    const key = t.replace(/\s+/g, '').slice(0, 14);
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ text: t, from });
  };

  const scan = (dir, rel, from) => {
    const got = readSegment(dir, rel, 'AUTO-OBSERVE');
    if (!got) return;
    const parts = got.body.split(/^#{2,3}\s*大事/m);
    if (parts.length < 2) return;
    for (const line of parts[1].split('\n')) {
      if (/^#{2,3}\s/.test(line.trim())) break; // 到下一节就停
      push(line, from);
    }
  };
  scan(kdir, 'group-memory.md', '共享');
  try {
    for (const f of readdirSync(join(kdir, 'groups'))) {
      if (!f.endsWith('.md')) continue;
      scan(kdir, `groups/${f}`, f.replace(/\.md$/, ''));
    }
  } catch {
    /* 没有 groups/ */
  }

  // 他自己手写的那份（`recent-events.md`）—— 只判断"有没有真内容"，不当主展示
  let handwritten = false;
  try {
    const raw = readFileSync(join(kdir, 'recent-events.md'), 'utf8');
    handwritten = raw
      .split('\n')
      .filter((l) => l.trim().startsWith('-') || /^\s*[^#>（(].{5,}$/.test(l))
      .filter((l) => !/^[#>\s]*$/.test(l))
      .some((l) => !/还没记|同上/.test(l));
  } catch {
    /* 没有这份文件 */
  }

  return { items: items.slice(0, 30), handwritten };
}

/**
 * 她对每一个人的认识 —— 把散在各个群记忆「### 群友」那一节里的
 * `- 昵称：评价` 抽出来，按昵称合并（同一个昵称取最长的那条评价，并记下来源群）。
 *
 * ⚠️ 为什么单独做这一个视图（2026-11-27，记忆页的「认识」）：她的记忆是**按群分开**存的
 *    （699 群的人和 752 群的人各一份 —— 这是故意的，群里的事不串群），
 *    而**同一个人靠昵称归一化来合并**。所以"她认识谁"这件事要看全貌，得把这几个文件摊平。
 *    ⚠️ 这个视图**只读、零模型调用**，数据全部来自她已经在写的那几份群记忆。
 * ⚠️ 「大事」那节不算认识（那是事件，不是人）⇒ 只取「大事」之前的部分。
 */
export function recognize(kdir) {
  const byName = new Map();
  const add = (name, note, from, lineUid = '') => {
    const norm = normName(name);
    if (norm.length < 1 || norm.length > 24) return;
    const n = String(note ?? '').trim();
    if (n.length < 4) return;
    // ⚠️ **优先按 QQ 号合并**（2026-11-27 用户要求：「应该按QQ号合并，然后只显示那个人的昵称
    //    而不是群昵称」）—— 昵称可以随便改，同一个人在记忆里会被写成十几种（实测 Anon 13 种）。
    //    ① 条目上直接带 `<!--u:QQ号-->`（新观察写的）优先；
    //    ② 老条目没有 ⇒ 去 `state/people.json` 按 QQ 昵称 / 群名片反查；
    //    ③ 都认不出 ⇒ 退回按昵称归一化合并。
    const uid = lineUid || people.uidOfName(name) || people.uidOfName(norm);
    const key = uid ? `u:${uid}` : `n:${norm}`;
    // 显示用 **QQ 昵称**（不是群名片）；没有就退回记忆里那个写法
    const display = (uid && people.nickOf(uid)) || norm;
    const cur = byName.get(key);
    if (!cur) {
      byName.set(key, { name: display, uid, note: n, from: [from], aliases: 1 });
      return;
    }
    if (!cur.from.includes(from)) cur.from.push(from);
    cur.aliases += 1;
    // 同一个人的多处评价：留信息最多的那条（不拼接，避免两句并存越写越长）
    if (n.length > cur.note.length) cur.note = n;
  };

  const scan = (dir, rel, from) => {
    const got = readSegment(dir, rel, 'AUTO-OBSERVE');
    if (!got) return;
    const peoplePart = got.body.split(/^#{2,3}\s*大事/m)[0];
    for (const line of peoplePart.split('\n')) {
      const raw = line.replace(/^[-*·]\s*/, '').trim();
      if (!raw || raw.length < 4) continue;
      // ⚠️ 跳过标记行 / 标题 / 引用（`<!-- AUTO-OBSERVE:BEGIN -->` 里也有冒号 ⇒
      //    不跳的话它会被当成一个叫「<!-- AUTO-OBSERVE」的"人"混进来，真实踩过）
      if (/^(<!--|#|>|\|)/.test(raw)) continue;
      // 条目自带 QQ 号（新观察写的 `<!--u:123-->`）
      const mu = /<!--\s*u:(\d+)\s*-->/.exec(raw);
      const t = raw.replace(/<!--\s*u:\d+\s*-->/g, '').trim();
      const m = /^(.{1,24}?)[：:]\s*(.+)$/.exec(t);
      if (!m) continue;
      const name = m[1].replace(/\*\*/g, '').trim();
      if (!name || /[<>]/.test(name)) continue;
      add(name, m[2], from, mu ? mu[1] : '');
    }
  };

  scan(kdir, 'group-memory.md', '共享');
  try {
    for (const f of readdirSync(join(kdir, 'groups'))) {
      if (!f.endsWith('.md')) continue;
      scan(kdir, `groups/${f}`, f.replace(/\.md$/, ''));
    }
  } catch {
    /* 没有 groups/ */
  }

  return [...byName.values()]
    .sort((a, b) => b.note.length - a.note.length)
    .slice(0, 60)
    .map((x) => ({ name: x.name, uid: x.uid || '', note: x.note, from: x.from, aliases: x.aliases }));
}
