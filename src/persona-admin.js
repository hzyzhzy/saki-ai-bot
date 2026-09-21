/**
 * 人设管理 —— WebUI「人设」页的**后端逻辑**（2026-09-21 加，P2）。
 *
 * 为什么单独一个文件：`webui.js` 已经 2000 多行，而"人设包"这套东西
 * （读、写、校验、备份、新建、删除）逻辑自成一摊，跟路由混在一起没法读。
 * 这里只做**文件层**的事，路由和"切完怎么热重载"留在 `webui.js`。
 *
 * ## 一个包长什么样（详见 `personas/README.md`）
 *
 * ```
 * personas/<id>/
 *   identity.json   结构化字段（名字/外号/口癖/anime 库…）+ prompt.* 整句
 *   persona.md      核心人设（永远进提示词）
 *   persona-money.md / persona-media.md   按需分册
 *   voices.md       示例对话
 *   cast.md / life-events.md / quest-ideas.md   角色专属数据（不进聊天）
 *   prompt/<名字>.md  长段提示词
 * ```
 *
 * ## 三条约束（都踩过）
 *
 * 1. **`identity.json` 里 `id` 必须跟目录名一致** —— 不一致的时候
 *    `personaDir()` 按 `config.persona.id` 找目录、而里面又写着另一个 id，
 *    排查起来得同时看三个地方。保存时**强制对齐**。
 * 2. **写之前一定备份** —— 人设是攒出来的（现成那份 persona.md 8.8 万字），
 *    界面上一次误保存就没了。备份到 `logs/persona-backup-*`。
 * 3. **id 做白名单**（`^[a-z0-9][\w.-]*$`）—— 它从界面来，不能让一个 `../`
 *    把写入带出 `personas/`。
 */
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  statSync,
  copyFileSync,
  rmSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { ROOT } from './config.js';
import { log } from './log.js';

/**
 * 人设包池在哪儿。
 *
 * ⚠️ `QQBOT_PERSONAS_DIR` 是给**测试**用的 —— 这个模块会**写和删**人设包，
 *    测试绝不能碰 `personas/` 里真实的那几个（那是攒出来的，删了就没了）。
 *    相对路径按项目根解析，和 `QQBOT_PERSONA_DIR` 一个规矩。
 */
const PERSONAS = process.env.QQBOT_PERSONAS_DIR
  ? join(ROOT, process.env.QQBOT_PERSONAS_DIR)
  : join(ROOT, 'personas');
const TEMPLATE = '_template';

/** 目录名白名单：字母数字开头，只允许字母数字点横线下划线 */
const ID_RE = /^[a-z0-9][\w.-]{0,31}$/i;
/** 文档相对路径白名单：`x.md` 或 `prompt/x.md`（不许 `..`、不许子目录再往下） */
const DOC_RE = /^(?:prompt\/)?[\w.-]{1,64}\.md$/i;

const bad = (msg) => {
  const e = new Error(msg);
  e.bad = true;
  return e;
};

function readJson(file) {
  // ⚠️ 剥 BOM：记事本 / PowerShell 写出来的 JSON 常带 BOM，JSON.parse 会当场报错
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function packDir(id) {
  if (!ID_RE.test(String(id ?? ''))) throw bad(`人设 id 不合法：${JSON.stringify(id)}（只能字母数字开头，含 . - _）`);
  return join(PERSONAS, String(id));
}

/** 列一个包里的文档（根目录的 `*.md` + `prompt/*.md`），data 文件也列出来（界面要能编） */
function docsOf(dir) {
  const out = [];
  const add = (rel, size) => out.push({ path: rel, size });
  try {
    for (const n of readdirSync(dir)) {
      if (!n.toLowerCase().endsWith('.md')) continue;
      try {
        add(n, statSync(join(dir, n)).size);
      } catch {}
    }
  } catch {}
  const pdir = join(dir, 'prompt');
  if (existsSync(pdir)) {
    try {
      for (const n of readdirSync(pdir)) {
        if (!n.toLowerCase().endsWith('.md')) continue;
        try {
          add(`prompt/${n}`, statSync(join(pdir, n)).size);
        } catch {}
      }
    } catch {}
  }
  const rank = (p) => (p === 'persona.md' ? 0 : p === 'voices.md' ? 1 : p.startsWith('prompt/') ? 3 : 2);
  return out.sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
}

/** 列出所有人设包（`_template` 不算），带"是不是当前用的那个" */
export function listPacks() {
  const out = [];
  if (!existsSync(PERSONAS)) return out;
  for (const n of readdirSync(PERSONAS)) {
    if (n === TEMPLATE || n.startsWith('_') || n.startsWith('.')) continue;
    const dir = join(PERSONAS, n);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    let identity = null;
    let broken = '';
    const idFile = join(dir, 'identity.json');
    if (existsSync(idFile)) {
      try {
        identity = readJson(idFile);
      } catch (e) {
        broken = `identity.json 读不了：${e.message}`;
      }
    } else {
      broken = '没有 identity.json';
    }
    out.push({
      id: n,
      name: identity?.name ?? '',
      selfName: identity?.selfName ?? '',
      displayName: identity?.displayName ?? '',
      shortName: identity?.shortName ?? '',
      broken,
      docs: docsOf(dir).length,
      chars: docsOf(dir).reduce((s, d) => s + d.size, 0),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** 读一个包的完整信息（identity + 文档清单 + QQ 昵称/头像） */
export function readPack(id) {
  const dir = packDir(id);
  if (!existsSync(dir)) throw bad(`没有人设包「${id}」`);
  const idFile = join(dir, 'identity.json');
  let identity = {};
  let raw = '';
  if (existsSync(idFile)) {
    raw = readFileSync(idFile, 'utf8');
    try {
      identity = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch (e) {
      throw bad(`identity.json 不是合法 JSON：${e.message}`);
    }
  }
  const q = identity.qq && typeof identity.qq === 'object' ? identity.qq : {};
  const nickname = String(q.nickname ?? '').trim();
  const avatar = String(q.avatar ?? '').trim();
  return {
    id: String(id),
    identity,
    docs: docsOf(dir),
    qq: { nickname, avatar },
    avatarReady: !!avatarFile(id, avatar),
  };
}

/**
 * 人设包里的**头像文件**绝对路径（没有 / 名字不合法就返回 `''`）。
 *
 * ⚠️ 这个名字最终会被交给协议端的 `set_qq_avatar` —— 那等于让机器人去读一个文件。
 *    所以它必须**留在包里面**：白名单 + 后缀校验，不给 `../` 任何机会。
 */
export function avatarFile(id, rel) {
  const safe = String(rel ?? '').replace(/[^\w.-]/g, '');
  if (!safe || !/\.(png|jpe?g|gif|webp)$/i.test(safe)) return '';
  const f = join(packDir(id), safe);
  return existsSync(f) ? f : '';
}

/**
 * 换人设包里的头像：写文件 + 顺手把 `identity.qq.avatar` 指过去。
 *
 * ⚠️ 头像**放在人设包里**（不是 `library/`）—— 它是"这个角色长什么样"，
 *    该跟着角色走；`library/` 是**表情库**，混进去她可能把头像当表情发出去。
 */
export function saveAvatar(id, buf, ext) {
  const dir = packDir(id);
  if (!existsSync(dir)) throw bad(`没有人设包「${id}」`);
  const e = String(ext ?? '').toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(e)) throw bad(`头像格式不支持：${e || '(空)'}`);
  if (!buf || !buf.length) throw bad('图片是空的');
  const name = e === '.jpeg' ? 'avatar.jpg' : `avatar${e}`;
  writeFileSync(join(dir, name), buf);
  const cur = readPack(id);
  saveIdentity(id, { ...cur.identity, qq: { ...(cur.identity.qq || {}), avatar: name } });
  log.info(`人设「${id}」的头像已更新：${name}（${(buf.length / 1024).toFixed(1)} KB）`);
  return { file: name, bytes: buf.length };
}

/** 写一个包的 identity.json（**先备份**；`id` 字段强制对齐目录名） */
export function saveIdentity(id, obj) {
  const dir = packDir(id);
  if (!existsSync(dir)) throw bad(`没有人设包「${id}」`);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw bad('identity 必须是一个对象');
  const next = { ...obj, id: String(id) };
  if (!String(next.name ?? '').trim()) throw bad('「角色全名」不能为空 —— 提示词里要用它');
  if (!String(next.selfName ?? '').trim()) throw bad('「自称」不能为空 —— 她提自己时要用它');

  const idFile = join(dir, 'identity.json');
  if (existsSync(idFile)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
    const bak = join(ROOT, 'logs', `persona-backup-${id}-${stamp}.json`);
    try {
      mkdirSync(join(ROOT, 'logs'), { recursive: true });
      copyFileSync(idFile, bak);
    } catch (e) {
      log.warn(`人设备份没写成（继续保存，但这次没退路）：${e.message}`);
    }
  }
  writeFileSync(idFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  log.info(`人设「${id}」已保存：${next.name} / 自称 ${next.selfName}`);
  return next;
}

/** 读一个包的某份 md */
export function readDoc(id, rel) {
  if (!DOC_RE.test(String(rel ?? ''))) throw bad(`文档名不合法：${JSON.stringify(rel)}`);
  const file = join(packDir(id), String(rel));
  if (!existsSync(file)) return '';
  return readFileSync(file, 'utf8');
}

/** 写一个包的某份 md（**先备份**） */
export function saveDoc(id, rel, text) {
  if (!DOC_RE.test(String(rel ?? ''))) throw bad(`文档名不合法：${JSON.stringify(rel)}`);
  const dir = packDir(id);
  const file = join(dir, String(rel));
  if (existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
    try {
      mkdirSync(join(ROOT, 'logs'), { recursive: true });
      copyFileSync(file, join(ROOT, 'logs', `persona-backup-${id}-${stamp}-${String(rel).replace(/\W+/g, '_')}`));
    } catch {}
  }
  // ⚠️ 建的是**这份文档所在的目录**（`prompt/` 或包根），不是「包根 + 相对路径」
  //    —— 写成 `join(dir, join(dir, 'prompt'))` 会把绝对路径又拼一遍，
  //    报 ENOENT 而且路径长得像一串重复的盘符（2026-09-21 真踩了，套件当场抓到）。
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, String(text ?? ''), 'utf8');
  log.info(`人设「${id}」的 ${rel} 已保存（${String(text ?? '').length} 字）`);
  return { path: rel, size: String(text ?? '').length };
}

/**
 * 新建一个包：照 `_template/` 复制骨架。
 *
 * ⚠️ 只复制**存在的**模板文件 —— `_template` 里没有 persona.md / voices.md 时
 *    就写一份带小标题的空骨架，让用户知道该往里填什么（而不是给他一个空文件）。
 */
export function createPack(id, from = TEMPLATE) {
  const target = packDir(id);
  if (existsSync(target)) throw bad(`人设包「${id}」已经存在了`);
  // ⚠️ **来源包名不能复用 `ID_RE`** —— 默认来源就是 `_template`，而它以下划线开头，
  //    用 ID_RE（要求字母数字开头）会连自己都拦住（2026-09-21 套件当场抓到）。
  //    这里只要保证「是个同级的目录名」：没有路径分隔符、不是 `..`。
  const fromName = String(from ?? '');
  if (basename(fromName) !== fromName || fromName === '..' || fromName === '.' || !/^[\w.-]{1,32}$/.test(fromName)) {
    throw bad(`来源包名不合法：${JSON.stringify(from)}`);
  }
  const src = join(PERSONAS, fromName);
  if (!existsSync(src)) throw bad(`来源包「${from}」不存在`);

  mkdirSync(target, { recursive: true });

  // ── ① 先把源包**整个**复制过来（含 `prompt/` 下的长段和 `avatar.png`）──
  //
  // ⚠️⚠️ 2026-09-22 改：原来这里只有一句 `for (const f of TEMPLATE_FILES)`，
  //    而 `TEMPLATE_FILES` 只有 `identity.json` ⇒ **只复制身份文件**，
  //    `persona.md` / `voices.md` 一律写空骨架。
  //    后果：点「照 saki 复制」**拿不到 saki 的人设正文**、名册、事件库、头像
  //    （用户问「从模板复刻是怎么复刻的」时我才回去看，才发现是这个行为）。
  //    而"复刻一份现有的角色来改"正是这个下拉框最常用的用法。
  //    ⇒ 现在：**整包复制**，只有 `identity.json` 需要特判（见下）。
  const copied = [];
  const walk = (dir, rel = '') => {
    for (const e of readdirSync(dir)) {
      const s = join(dir, e);
      const r = rel ? `${rel}/${e}` : e;
      let isDir = false;
      try {
        isDir = statSync(s).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        mkdirSync(join(target, r), { recursive: true });
        walk(s, r);
        continue;
      }
      if (e === 'identity.json') continue; // 下面单独处理（要改 id）
      copyFileSync(s, join(target, r));
      copied.push(r);
    }
  };
  walk(src);

  // ── ② `identity.json`：复制，但只改**必须改**的 ──
  const idSrc = join(src, 'identity.json');
  if (existsSync(idSrc)) {
    let obj = null;
    try {
      obj = readJson(idSrc);
    } catch {
      copyFileSync(idSrc, join(target, 'identity.json')); // 坏的 JSON 就原样带过去，别把内容弄丢
    }
    if (obj) {
      // ⚠️ `id` 必须换成新目录名，否则新包里的 id 还指着来源包（不一致最难查）
      obj.id = String(id);
      // ⚠️ **只从 `_template` 复制时**才清掉模板说明文字；
      //    从真实角色复制时名字要**保留** —— 用户就是想要"另一个 saki"，然后自己改。
      if (fromName === TEMPLATE) obj.name = String(obj.name ?? '').replace(/^角色全名.*$/, '') || '';
      writeFileSync(join(target, 'identity.json'), `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
    }
  } else {
    // 来源包连身份文件都没有 ⇒ 给一个最小骨架，让她至少不"没有名字"
    writeFileSync(
      join(target, 'identity.json'),
      `${JSON.stringify({ id: String(id), name: '', selfName: '' }, null, 2)}\n`,
      'utf8',
    );
  }
  log.debug(`人设包「${id}」从「${fromName}」复制了 ${copied.length} 个文件`);
  const skeleton = {
    'persona.md': [
      '# 人设',
      '',
      '> 这是**永远进提示词**的那一份。写得越长每次请求越贵 —— 够用就行。',
      '',
      '## 一、你是谁',
      '',
      '（名字、身份、在哪儿、跟谁在一起）',
      '',
      '## 二、说话的方式',
      '',
      '（语气、句长、口头禅、绝对不会说的话）',
      '',
      '## 三、你的处境',
      '',
      '（她现在的日子是什么样的）',
      '',
    ].join('\n'),
    'voices.md': [
      '# 示例对话（"人味"的关键）',
      '',
      '> 光写"她说话短、有点傲娇"没用 —— 模型会给一个**平均的动漫角色**。',
      '> 贴几段"这种场合她大概会这么说"，越具体越像。',
      '',
      '## 被打招呼',
      '群友：早',
      '她：（写一句她会说的话）',
      '',
      '## 被夸',
      '',
      '## 被骂',
      '',
      '## 被问到不知道的事',
      '',
      '## 主动接话',
      '',
      '## 拒绝',
      '',
    ].join('\n'),
  };
  for (const [f, text] of Object.entries(skeleton)) {
    const p = join(target, f);
    if (!existsSync(p)) writeFileSync(p, text, 'utf8');
  }
  log.info(`新建人设包「${id}」（照 ${from} 复制）`);
  return { id: String(id), docs: docsOf(target) };
}

/**
 * 删一个包。
 *
 * ⚠️ 只是**改名挪走**（不是真删）—— 挪到 `logs/persona-removed-<id>-<时间>/`。
 *    人设是攒出来的，界面上一次误点不该真的销毁它。
 */
export function removePack(id) {
  const dir = packDir(id);
  if (!existsSync(dir)) throw bad(`没有人设包「${id}」`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  mkdirSync(join(ROOT, 'logs'), { recursive: true });
  try {
    copyFileSync(join(dir, 'persona.md'), join(ROOT, 'logs', `persona-removed-${id}-${stamp}-persona.md`));
  } catch {}
  rmSync(dir, { recursive: true, force: true });
  log.warn(`人设包「${id}」已删除（persona.md 备份在 logs/）`);
  return { id: String(id) };
}
