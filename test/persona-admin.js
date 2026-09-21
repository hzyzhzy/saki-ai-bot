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
  check(
    existsSync(join(ROOT, POOL, 'beta', 'persona.md')) && existsSync(join(ROOT, POOL, 'beta', 'voices.md')),
    '★ 骨架里的 persona.md / voices.md 都生成了（没模板文件也得有骨架）',
  );
  check(
    readFileSync(join(ROOT, POOL, 'beta', 'persona.md'), 'utf8').includes('一、你是谁'),
    '骨架是"带小标题的空架子"，不是一个空文件',
  );

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

cleanup();

console.log(
  failures === 0
    ? '\n结果: 全部通过 ✅（id 对齐 / 必填校验 / 路径白名单 / 备份 / 新建改名 / 删除留底）\n'
    : `\n结果: ${failures} 项失败 ❌\n`,
);
process.exit(failures === 0 ? 0 : 1);
