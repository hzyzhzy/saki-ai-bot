/**
 * 「界面直接改 learned.md」的**格式校验**测试（2026-09-14 用户要求）。
 *
 * 用户原话：「顺便把 **learned.md 也能修改**，在群里一句一句修改还是有点麻烦」。
 *
 * ## 为什么必须先校验才能放开
 *
 * `learned.md` **和别的知识库不一样** —— 别的 md 是纯给模型读的散文，
 * 而这个是**代码在解析和维护**的：
 *   · 条目必须是 `## 主题` + 正文（`parseEntries` 靠 `^##\s+` 切）
 *   · 必须有 `<!-- LEARNED:BEGIN -->` / `<!-- LEARNED:END -->` 两行标记
 *
 * 界面上把这些改坏（删标记、把 `##` 改成 `#`），`learn()` / `forget()` /
 * `listEntries()` 会**静默失效** —— 群主在群里说「记住：xxx」就没反应，
 * 而且很难查。所以保存前先校验，不合格就**拒绝保存并说清原因**。
 *
 * ⚠️ 纯离线：不发请求、不碰真实 learned.md（只调纯函数）。
 *
 * 用法: node test/learned-edit.js
 */
import { writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** ⚠️ knowledge 目录跟着 `QQBOT_KNOWLEDGE_DIR` 走（回归时是各套件自己的副本） */
const KNOW = process.env.QQBOT_KNOWLEDGE_DIR
  ? join(ROOT, process.env.QQBOT_KNOWLEDGE_DIR)
  : join(ROOT, 'knowledge');
mkdirSync(join(ROOT, 'logs'), { recursive: true });

const CFG_REL = 'logs/__test-learned-edit.yml';
writeFileSync(
  join(ROOT, CFG_REL),
  ['llm:', '  baseURL: http://127.0.0.1:1/v1', '  apiKey: "sk-test"', '  model: test-model', ''].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const learned = await import('../src/learned.js');
const V = learned.validateFile;

const BEGIN = '<!-- LEARNED:BEGIN -->';
const END = '<!-- LEARNED:END -->';
const good = (body) => `# 学习档案\n\n${BEGIN}\n\n${body}\n\n${END}\n\n## 修改记录\n\n- 无\n`;

console.log('\n【1】合格的格式要放行');
{
  const r = V(good('## 白名单说明\n\n直接下整合包就能进。\n\n> 由 <主人> 于 2026-09-14 通过群聊教学录入。'));
  check(r.ok === true, '标准格式 → 通过', r.error ?? '');
  check(r.entries === 1, `解析出 1 条（实际 ${r.entries}）`);

  const r2 = V(good('## A\n\n内容一。\n\n## B\n\n内容二。'));
  check(r2.ok === true && r2.entries === 2, `两条也能解析（${r2.entries} 条）`);

  // 空档案（没有条目、也没有多余文字）是合法的 —— 刚初始化时就这样
  const r3 = V(good(''));
  check(r3.ok === true && r3.entries === 0, '空档案 → 通过（不是错误）');
}

console.log('\n【2】★ 删掉标记必须拒绝（这是最容易犯的）');
{
  const noBegin = `# 学习档案\n\n## 白名单说明\n\n直接下整合包就能进。\n\n${END}\n`;
  const r1 = V(noBegin);
  check(r1.ok === false, '缺 BEGIN 标记 → 拒绝');
  check(/BEGIN/.test(r1.error ?? ''), `错误信息点明了是 BEGIN（"${r1.error}"）`);

  const noEnd = `# 学习档案\n\n${BEGIN}\n\n## 白名单说明\n\n直接下整合包就能进。\n`;
  const r2 = V(noEnd);
  check(r2.ok === false && /END/.test(r2.error ?? ''), `缺 END → 拒绝（"${r2.error}"）`);

  const swapped = `# 学习档案\n\n${END}\n\n## A\n\nx\n\n${BEGIN}\n`;
  const r3 = V(swapped);
  check(r3.ok === false, `两个标记顺序反了 → 拒绝（"${r3.error}"）`);
}

console.log('\n【3】★ 有文字但一条条目都没有 → 拒绝（等于内容丢了）');
{
  // ⚠️ 这个最阴：文件看着还有字，但解析器眼里是**空档案**
  const r = V(good('白名单说明：直接下整合包就能进。'));
  check(r.ok === false, 'BEGIN/END 之间只有文字、没有 `## 主题` → 拒绝');
  check(/## 主题/.test(r.error ?? ''), `错误信息教了正确格式（"${r.error}"）`);
}

console.log('\n【4】条目本身不完整 → 拒绝并指出是哪条');
{
  const emptyBody = good('## 白名单说明\n\n## 另一个主题\n\n有内容');
  const r1 = V(emptyBody);
  check(r1.ok === false && /白名单说明/.test(r1.error ?? ''), `指出是哪个条目空着（"${r1.error}"）`);

  const badTitle = good('## 带#号的主题\n\n内容');
  const r2 = V(badTitle);
  check(r2.ok === false, `主题里含 # → 拒绝（"${r2.error}"）`);
}

console.log('\n【5】空输入 / 乱输入不能抛异常');
{
  for (const t of ['', '   ', '随便一段话', null, undefined]) {
    let threw = false;
    try {
      V(t);
    } catch {
      threw = true;
    }
    check(!threw, `「${String(t).slice(0, 10)}」不抛异常`);
  }
}

console.log('\n【6】★ 真实的 learned.md 必须通过校验（别把线上文件判成坏的）');
{
  const real = readFileSync(join(KNOW, 'learned.md'), 'utf8');
  const r = V(real);
  check(r.ok === true, `线上 learned.md 通过校验（${r.entries} 条知识）`, r.error ?? '');
  // 顺带确认解析器和校验器的口径一致
  const entries = learned.listEntries();
  check(
    entries.length === r.entries,
    `校验器的条数和 listEntries() 一致（${r.entries} vs ${entries.length}）`,
  );
}

console.log('\n【7】界面那边不许再写死只读（踩过：服务端放开了、界面还锁着）');
{
  const src = readFileSync(join(ROOT, 'src', 'webui.html'), 'utf8');
  // ⚠️ 必须**先剥掉注释再搜** —— 我在注释里写了这句（解释历史原因），
  //    直接搜会搜到注释 → 假失败（第一版就是这样挂的）。
  const codeOnly = src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  check(
    !/name === 'learned\.md'/.test(codeOnly),
    "代码里没有写死的 `name === 'learned.md'` 只读判断（注释里提到不算）",
  );
  check(/meta\?\.readonly === true/.test(src), '只读与否完全由服务端 meta.readonly 决定');

  const js = readFileSync(join(ROOT, 'src', 'webui.js'), 'utf8');
  check(/readonly: false/.test(js), '服务端把 learned.md 的 readonly 设为 false');
  check(/learnedValidate/.test(js), '保存 learned.md 时会过格式校验');
  check(
    /reloadKnowledge\(\)/.test(js.split("'POST /api/reload'")[1] ?? ''),
    '★ /api/reload 里也重载了知识库（用户要求）',
  );
}

try {
  rmSync(join(ROOT, CFG_REL), { force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
