/**
 * 人设管理（`src/persona-admin.js`）—— WebUI「人设」页的文件层（2026-09-21 加，P2）。
 *
 * ## 这个套件盯什么
 *
 * 这一层会**写、创建、删除**人设包 —— 出错的代价是"用户攒了很久的人设没了"。
 * 所以重点全在**拦得住**上：
 *   ① 列包：`_template` 不算，坏包（identity.json 读不了）要能标出来而不是整个崩；
 *   ② 保存：`id` 强制对齐目录名、空「全名 / 自称」要拒绝、**写之前必须留备份**；
 *   ③ 路径：`id` 和文档名都做白名单 —— `../` 绝不能把读写带出 `personas/`；
 *   ④ 新建：`id` 换成新目录名（照抄模板会把模板的 id 带进来）；
 *   ⑤ 删除：**改名挪走 + 留 persona.md 备份**，不是真销毁。
 *
 * ⚠️ 隔离：`QQBOT_PERSONAS_DIR` 指到 `logs/__test-personas`（**绝不能碰真实包**）。
 *    ⚠️ 必须**动态 import** —— `PERSONAS` 是模块加载时求值的，
 *       写在文件顶上的静态 import 会在设 env 之前就把它固定住。
 *
 * 用法: node test/persona-admin.js
 */
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const POOL = 'logs/__test-personas';
const CFG = 'logs/__test-persona-admin.yml';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

// ⚠️ env 必须在 import 之前设好（见文件头）
process.env.QQBOT_PERSONAS_DIR = POOL;
process.env.QQBOT_CONFIG = CFG;
mkdirSync(join(ROOT, 'logs'), { recursive: true });
writeFileSync(
  join(ROOT, CFG),
  ['llm:', '  baseURL: http://203.0.113.10:1/v1', '  apiKey: "sk-test"', '  model: t', 'persona:', '  id: alpha', ''].join(
    '\n',
  ),
  'utf8',
);

// 造一个池：`_template` + 两个包（其中一个 identity.json 是坏的）
rmSync(join(ROOT, POOL), { recursive: true, force: true });
mkdirSync(join(ROOT, POOL, '_template'), { recursive: true });
mkdirSync(join(ROOT, POOL, 'alpha', 'prompt'), { recursive: true });
mkdirSync(join(ROOT, POOL, 'broken'), { recursive: true });
writeFileSync(
  join(ROOT, POOL, '_template', 'identity.json'),
  JSON.stringify({ id: 'miku', name: '角色全名（例：初音未来）', selfName: 'Miku' }, null, 2),
  'utf8',
);
writeFileSync(
  join(ROOT, POOL, '_template', 'persona.md'),
  '# 模板人设\n\n（模板）\n',
  'utf8',
);
writeFileSync(
  join(ROOT, POOL, 'alpha', 'identity.json'),
  JSON.stringify({ id: 'alpha', name: '阿尔法', selfName: 'Al', nicknames: ['小阿'] }, null, 2),
  'utf8',
);
writeFileSync(join(ROOT, POOL, 'alpha', 'persona.md'), '# 人设\n\n你是阿尔法。\n', 'utf8');
writeFileSync(join(ROOT, POOL, 'alpha', 'prompt', 'guide.md'), '长段提示词\n', 'utf8');
writeFileSync(join(ROOT, POOL, 'broken', 'identity.json'), '{ 这不是 JSON', 'utf8');

const pa = await import('../src/persona-admin.js');

const cleanup = () => {
  for (const p of [POOL, CFG]) {
    try {
      rmSync(join(ROOT, p), { recursive: true, force: true });
    } catch {}
  }
  try {
    for (const f of readdirSync(join(ROOT, 'logs'))) {
      if (/^persona-(backup|removed)-/.test(f)) rmSync(join(ROOT, 'logs', f), { force: true, recursive: true });
    }
  } catch {}
};

console.log('\n【1】列包：模板不算，坏包要标出来而不是崩');
{
  const packs = pa.listPacks();
  const ids = packs.map((p) => p.id);
  check(ids.includes('alpha') && ids.includes('broken'), '列出了两个包', ids.join(', '));
  check(!ids.includes('_template'), '★ `_template` **不在**列表里（它是模板，不是人设）');
  check(
    packs.find((p) => p.id === 'broken')?.broken?.includes('JSON'),
    '★ 坏包标了原因（identity.json 读不了），没让整个列表崩',
    packs.find((p) => p.id === 'broken')?.broken ?? '',
  );
  check(packs.find((p) => p.id === 'alpha')?.name === '阿尔法', '好包的名字读对了');
}

console.log('\n【2】读包 + 文档清单');
{
  const r = pa.readPack('alpha');
  check(r.identity.name === '阿尔法', 'identity 读到了');
  const paths = r.docs.map((d) => d.path);
  check(paths.includes('persona.md') && paths.includes('prompt/guide.md'), '文档列出了根目录和 prompt/ 下的', paths.join(' '));
  check(pa.readDoc('alpha', 'prompt/guide.md') === '长段提示词\n', '读得到长段提示词');
}

console.log('\n【3】★★ 保存：id 对齐 + 拒绝空必填 + 必须留备份');
{
  const saved = pa.saveIdentity('alpha', { id: '别人的id', name: '阿尔法', selfName: 'Al' });
  check(saved.id === 'alpha', '★ id 被**强制对齐**成目录名（照抄别人的 id 最难查）', String(saved.id));
  const onDisk = JSON.parse(readFileSync(join(ROOT, POOL, 'alpha', 'identity.json'), 'utf8'));
  check(onDisk.id === 'alpha', '★ 写进文件的 id 也是目录名');

  let threw = '';
  try {
    pa.saveIdentity('alpha', { name: '', selfName: 'Al' });
  } catch (e) {
    threw = e.message;
  }
  check(/全名/.test(threw), '★ 空「角色全名」被拒绝', threw);

  threw = '';
  try {
    pa.saveIdentity('alpha', { name: '阿尔法', selfName: '  ' });
  } catch (e) {
    threw = e.message;
  }
  check(/自称/.test(threw), '★ 空「自称」被拒绝', threw);

  const baks = readdirSync(join(ROOT, 'logs')).filter((f) => /^persona-backup-alpha-/.test(f));
  check(baks.length >= 1, '★★ 保存前**留了备份**（人设是攒出来的，一次误存不能没退路）', `${baks.length} 份`);
}

console.log('\n【4】★★ 路径白名单：`../` 出不去');
{
  let threw = '';
  try {
    pa.readPack('../../etc');
  } catch (e) {
    threw = e.message;
  }
  check(/不合法/.test(threw), '★ 非法 id（`../`）被拒绝', threw);

  threw = '';
  try {
    pa.readDoc('alpha', '../../../config.yml');
  } catch (e) {
    threw = e.message;
  }
  check(/不合法/.test(threw), '★ 非法文档名（`../`）被拒绝', threw);

  threw = '';
  try {
    pa.saveDoc('alpha', '../x.md', 'x');
  } catch (e) {
    threw = e.message;
  }
  check(/不合法/.test(threw), '★ 写文档也过同一道白名单', threw);
}

console.log('\n【5】写文档 + 新建 + 删除');
{
  pa.saveDoc('alpha', 'prompt/new.md', '新的一段\n');
  check(pa.readDoc('alpha', 'prompt/new.md') === '新的一段\n', '写进 `prompt/` 的新文档读得回来');
  // ⚠️ 第一次写**新文件**时没有可备份的东西（不该凭空造一份），所以这里写第二版
  pa.saveDoc('alpha', 'prompt/new.md', '第二版\n');
  const baks = readdirSync(join(ROOT, 'logs')).filter((f) => /^persona-backup-alpha-.*new/.test(f));
  check(baks.length >= 1, '★ 覆盖已有文档也留备份（写新文件时本来就没东西可备份）', `${baks.length} 份`);

  const made = pa.createPack('beta');
  check(made.id === 'beta', '新建了 beta');
  const bi = JSON.parse(readFileSync(join(ROOT, POOL, 'beta', 'identity.json'), 'utf8'));
  check(bi.id === 'beta', '★★ 新包的 id 是**新目录名**（照抄模板会把 `miku` 带进来）', String(bi.id));
  // ⚠️ 2026-09-22 改：现在是**整包复制** —— `_template` 里有 persona.md 就带过来，
  //    只有源包**没有**的文档才写骨架。（旧行为是"永远写骨架"，那根本不叫复刻。）
  check(
    readFileSync(join(ROOT, POOL, 'beta', 'persona.md'), 'utf8').includes('模板人设'),
    '★ 源包里的 persona.md 被**复制**过来了（不是无视它去写骨架）',
  );
  check(
    readFileSync(join(ROOT, POOL, 'beta', 'voices.md'), 'utf8').includes('示例对话'),
    '★ 源包**没有**的文档才写骨架（beta 的 voices.md 是骨架）',
  );
  check(bi.name === '', '★ 从 `_template` 复制时，说明性的名字被清掉', JSON.stringify(bi.name));

  // ★★ 2026-09-22 加：从**真实角色**复制 = 完整副本（这才是这个下拉框最常用的用法）
  {
    pa.createPack('gamma', 'alpha');
    const gdir = join(ROOT, POOL, 'gamma');
    check(existsSync(join(gdir, 'prompt', 'guide.md')), '★★ 从真实包复制会带上 `prompt/` 下的长段提示词');
    check(readFileSync(join(gdir, 'persona.md'), 'utf8').includes('你是阿尔法'), '★★ 也带上了它的人设正文');
    const gi = JSON.parse(readFileSync(join(gdir, 'identity.json'), 'utf8'));
    check(gi.id === 'gamma', '★ 但 `id` 换成了新目录名');
    check(gi.name === '阿尔法', '★ 名字**保留**（从真实角色复制时不清空 —— 用户想要的是"另一个它"）');
    pa.removePack('gamma');
  }

  let threw = '';
  try {
    pa.createPack('alpha');
  } catch (e) {
    threw = e.message;
  }
  check(/已经存在/.test(threw), '★ 重名不许新建', threw);

  pa.removePack('beta');
  check(!existsSync(join(ROOT, POOL, 'beta')), 'beta 删掉了');
  check(
    readdirSync(join(ROOT, 'logs')).some((f) => /^persona-removed-beta-.*persona\.md$/.test(f)),
    '★★ 删之前把 persona.md **留了一份备份**（不是真销毁）',
  );
}

console.log('\n【6】★ 生图参考图（立绘）：和头像是**两个字段两个文件**');
{
  const dir = join(ROOT, POOL, 'alpha');
  const img = Buffer.from('not-really-a-png-but-fine');
  // ⚠️ `persona.js` 读的是 **`QQBOT_PERSONA_DIR`（单个包）**，
  //    而 `persona-admin.js` 读的是 `QQBOT_PERSONAS_DIR`（包池）—— 两个变量不是一回事，
  //    少设这个的话 `persona.refImages()` 会去读**真实的 personas/**（这套件就白测了）。
  process.env.QQBOT_PERSONA_DIR = join(POOL, 'alpha');

  // ① 先只设头像 —— 参考图应当**退回头像**（"刚配好就能用"）
  pa.saveAvatar('alpha', img, '.png');
  const persona = await import('../src/persona.js');
  persona.reload();
  check(persona.qq().avatar === 'avatar.png', '头像存成 `avatar.png` 并写进 `qq.avatar`', persona.qq().avatar);
  check(
    persona.refImages().length === 1 && /avatar\.png$/.test(persona.refImages()[0]),
    '★ 没配参考图时**退回头像**（否则生图直接没参考图可用）',
    persona.refImages()[0] || '(空)',
  );

  // ② 传立绘
  const r = pa.saveRefImage('alpha', img, '.png');
  check(r.file === 'ref.png', '立绘存成独立文件 `ref.png`', r.file);
  const pack = pa.readPack('alpha');
  check(pack.identity.image?.refs?.[0] === 'ref.png', '★★ 写进 `identity.image.refs`（**不碰** `qq.avatar`）');
  check(pack.identity.qq?.avatar === 'avatar.png', '★ 头像字段**没被动过**（两个字段各管各的）');
  persona.reload();
  check(/ref\.png$/.test(persona.refImages()[0]), '★ 配了立绘之后，`refImages()` 优先用它');

  // ③ 换扩展名：旧文件要删掉，不然包里躺两张、下次看目录会以为是两张参考图
  pa.saveRefImage('alpha', img, '.webp');
  check(pa.readPack('alpha').identity.image.refs[0] === 'ref.webp', '换格式后 refs 指向新文件');
  check(!existsSync(join(dir, 'ref.png')), '★★ 旧的 `ref.png` 被删掉了（不留两张）');
  check(existsSync(join(dir, 'ref.webp')), '新文件在');

  // ④ 校验：不认的格式要拒绝
  let threw = '';
  try {
    pa.saveRefImage('alpha', img, '.txt');
  } catch (e) {
    threw = e.message;
  }
  check(/不支持/.test(threw), '不认的格式被拒', threw);

  let threw2 = '';
  try {
    pa.saveRefImage('alpha', Buffer.alloc(0), '.png');
  } catch (e) {
    threw2 = e.message;
  }
  check(/空/.test(threw2), '空文件被拒', threw2);

  // ⑤ 路径白名单：参考图也走同一套（这是要读进内存、发到外部 API 的路径）
  check(pa.avatarFile('alpha', '../../secret.png') === '', '★★ `../` 出不去（复用同一套白名单）');
  check(pa.avatarFile('alpha', 'ref.webp') !== '', '正常文件名能解析到绝对路径');
}

cleanup();

console.log(
  failures === 0
    ? '\n结果: 全部通过 ✅（id 对齐 / 必填校验 / 路径白名单 / 备份 / 新建改名 / 删除留底 / 生图参考图）\n'
    : `\n结果: ${failures} 项失败 ❌\n`,
);
process.exit(failures === 0 ? 0 : 1);
