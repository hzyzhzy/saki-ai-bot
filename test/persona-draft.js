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
import { existsSync, readdirSync } from 'node:fs';
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

console.log(
  failures === 0
    ? '\n结果: 全部通过 ✅（动画库清单 / 联网前校验 / 字数上限）\n'
    : `\n结果: ${failures} 项失败 ❌\n`,
);
process.exit(failures === 0 ? 0 : 1);
