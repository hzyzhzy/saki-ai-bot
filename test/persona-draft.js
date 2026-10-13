/**
 * 人设自动起草（`src/persona-draft.js`）—— 只测**不联网、不花模型钱**的那部分（2026-09-21）。
 *
 * ## 为什么只测这么点
 *
 * 起草本身要**联网搜 + 调模型**（几十秒、要花钱）。把它塞进回归 =
 * 每跑一次回归就烧一次钱，而且网一断就红 —— 那种"哨兵"没人会认真看。
 *
 * 所以这里钉的是**不需要网的那几层**：
 *   ① 现有的动画库列得出来（`availableAnimeLibs`）—— 它是"anime.works 只能从这里挑"的依据；
 *   ② 参数校验**在联网之前**就拦住（空角色名、非法 id）。
 *
 * ⚠️ 真链路靠**手工验**（2026-09-21 跑过一次初音未来：18.9 秒 / 10 条资料 /
 *    `anime.works` 正确地留空、没自动新建库 / persona.md 498 字被 note 说明）。
 *
 * 用法: node test/persona-draft.js
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const pd = await import('../src/persona-draft.js');

console.log('\n【1】动画库列得出来（anime.works 只能从这里面挑）');
{
  const libs = pd.availableAnimeLibs();
  check(Array.isArray(libs), '返回的是数组');
  const dir = join(ROOT, 'knowledge', 'anime');
  const onDisk = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith('.md'))
        .map((f) => f.replace(/\.md$/i, ''))
    : [];
  check(
    libs.length === onDisk.length,
    '数量跟 `knowledge/anime/` 里的文件对得上',
    `${libs.length} 个：${libs.join('、') || '（无）'}`,
  );
  check(!libs.some((x) => x.includes('/') || x.includes('.')), '列出来的是**库名**，不是文件名');
}

console.log('\n【2】★★ 参数校验必须在**联网之前**拦住（不然一次误点就白烧一次搜索）');
{
  let threw = '';
  try {
    await pd.draft({ name: '', work: 'x', id: 'abc' });
  } catch (e) {
    threw = e.message;
  }
  check(/角色名/.test(threw), '空「角色名」被拒', threw);

  threw = '';
  try {
    await pd.draft({ name: '初音未来', work: 'VOCALOID', id: '../../etc' });
  } catch (e) {
    threw = e.message;
  }
  check(/id/.test(threw), '★ 非法 id 被拒（且没走到搜索那一步）', threw);

  threw = '';
  try {
    await pd.draft({ name: '初音未来', id: '' });
  } catch (e) {
    threw = e.message;
  }
  check(/id/.test(threw), '空 id 被拒', threw);
}

console.log('\n【3】上限常量在（用户 2026-09-21 定的「限长」）');
{
  check(pd.MAX_PERSONA_CHARS === 3000, 'persona.md 上限 = 3000 字', String(pd.MAX_PERSONA_CHARS));
  check(
    Number.isFinite(pd.MAX_VOICES_CHARS) && pd.MAX_VOICES_CHARS > 0,
    'voices.md 也有上限',
    String(pd.MAX_VOICES_CHARS),
  );
}

console.log('\n【4】★★ 模板字段清单（"按模板填"的唯一依据 —— 模板漏字段，起草就永远填不出来）');
{
  const tpl = pd.templateIdentity();
  check(Object.keys(tpl).length > 0, '读得到 `_template/identity.json`');
  // ⚠️⚠️ 这几个是 2026-09-22 **实测漏过的**：模板里没有 ⇒ 联网起草根本填不出来
  for (const k of ['shortName', 'narrativeName', 'qq', 'voices']) {
    check(k in tpl, `★★ 模板里有 \`${k}\`（曾经漏过）`, k in tpl ? '' : '⚠️ 又漏了');
  }
  const promptKeys = [
    'personaLine',
    'styleLine',
    'quickAside',
    'spokenNames',
    'attributionTone',
    'followUpLine',
    'castNames',
    'questHomeDirs',
    'questPastThreads',
    'questOtherGroups',
  ];
  const miss = promptKeys.filter((k) => !(k in (tpl.prompt || {})));
  check(miss.length === 0, '`prompt` 段里 10 个键都在', miss.length ? `少了：${miss.join('、')}` : '');
  const arrMiss = ['selfNames', 'callNames', 'nicknames', 'matchNames'].filter((k) => !Array.isArray(tpl[k]));
  check(arrMiss.length === 0, '四个"名字数组"都在', arrMiss.length ? `少了：${arrMiss.join('、')}` : '');
  check(!!tpl.anime && Array.isArray(tpl.anime.works), '`anime.works` 在');
  check(!!tpl.qq && 'nickname' in tpl.qq && 'avatar' in tpl.qq, '`qq` 段有 nickname / avatar');
}

console.log('\n【4.5】★★ 关系片段库（用户：「以后建新人设时这种人际关系也要能摘下来」）');
{
  // 2026-10-13 用户要求：新建人设时**人际关系要能摘下来**。
  // ⇒ 片段库 `personas/_template/relations.md` + 起草时挑片段产出 cast.md。
  const cat = pd.relationsCatalog();
  check(cat.length >= 6, `片段库解析出 ${cat.length} 条片段`, cat.map((x) => x.name).join(' / '));
  // 每条片段必须**四行齐全**（关系 / 怎么称呼 / 怎么相处 / 别写）—— 不然摘出来是残的
  const bad = [];
  for (const f of cat) {
    for (const k of ['关系', '怎么称呼', '怎么相处', '别写']) {
      if (!f.body.includes(`- ${k}：`)) bad.push(`${f.name} 缺「${k}」`);
    }
  }
  check(bad.length === 0, '★★ 每条片段四行齐全（关系 / 怎么称呼 / 怎么相处 / 别写）', bad.join('；'));
  check(
    cat.some((x) => /同校同学/.test(x.name)) && cat.some((x) => /直球/.test(x.name)),
    '★ 常用的那几类都在（同校同学 / 直球×端着）',
  );
  check(
    !cat.some((x) => /站在.*这边的写法/.test(x.name)),
    '★★ 「范例」那一节**不算片段**（那是写法示范，不是可摘的类型）',
  );
  const src = readFileSync(join(ROOT, 'personas', '_template', 'relations.md'), 'utf8');
  check(/（二创）/.test(src), '★ 二创设定标了「（二创）」（用户："不符合官方的二创也能加"）');
  check(/爱音/.test(src) && /祥子/.test(src), '★ 范例里那对（爱音 / 祥子）在');

  // 起草要真的把 cast.md 带上（不然新人设还是没有"人际关系"）
  const draftSrc = readFileSync(join(ROOT, 'src', 'persona-draft.js'), 'utf8');
  check(/MAX_CAST_CHARS/.test(draftSrc), '★★ 起草那边有 cast.md 的上限');
  check(/\[\s*'cast\.md',\s*MAX_CAST_CHARS\s*\]/.test(draftSrc), '★★ cast.md 进了"限长并落盘"那张表');
  check(
    /"docs":\s*\{[^}]*cast\.md/.test(draftSrc.replace(/\n/g, '')),
    '★★ 输出格式里要求模型给 cast.md',
  );
  check(/relationsCatalog\(\)/.test(draftSrc), '★ 起草时读了片段库');
  const uiSrc = readFileSync(join(ROOT, 'src', 'webui.html'), 'utf8');
  check(/id="pd-cast"/.test(uiSrc), '★★ 界面上有 cast.md 的编辑框');
  check(/\['cast\.md', 'pd-cast'\]/.test(uiSrc), '★★ 保存时会把 cast.md 写进人设包');
}

console.log('\n【5】★ 动画库选项的校验（全部要在**联网之前**拦住）');
{
  let threw = '';
  try {
    await pd.draft({ name: 'x', id: 'abc', animeMode: 'reuse', animeLib: '根本不存在的库' });
  } catch (e) {
    threw = e.message;
  }
  check(/不存在/.test(threw), '★ 「复用」一个不存在的库被拒', threw);

  const libs = pd.availableAnimeLibs();
  if (libs.length) {
    threw = '';
    try {
      await pd.draft({ name: 'x', id: 'abc', animeMode: 'new', animeName: libs[0] });
    } catch (e) {
      threw = e.message;
    }
    check(/已经存在/.test(threw), '★ 「新建」一个已存在的库名被拒（提示去选"复用"）', threw);
  } else {
    check(true, '（现在一个库都没有，跳过"新建已存在的库"这条）');
  }

  threw = '';
  try {
    await pd.draft({ name: 'x', id: 'abc', animeMode: 'new', animeName: '  ' });
  } catch (e) {
    threw = e.message;
  }
  check(/名字/.test(threw), '★ 「新建」但没给库名被拒', threw);
}

console.log(
  failures === 0
    ? '\n结果: 全部通过 ✅（动画库清单 / 联网前校验 / 字数上限 / 模板字段齐全）\n'
    : `\n结果: ${failures} 项失败 ❌\n`,
);
process.exit(failures === 0 ? 0 : 1);
