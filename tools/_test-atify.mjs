/**
 * 验证 `atifyText()` / `matchNameToUid()`：
 *   「正文里的 `@我` 被换成 `@78404832`」这个 bug 修好了没有。
 *
 * 做法：把 `src/bot.js` 里那两段真实源码**原样抠出来**跑（不是抄一份，
 *       抄一份就只能证明抄的那份对）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'src', 'bot.js'), 'utf8');

// 抠 [AT_PRONOUNS 定义 → atifyText 结束]
const a = src.indexOf('const AT_PRONOUNS = new Set([');
const b = src.indexOf('function atifyText(', a);
const c = src.indexOf('\n}\n', src.indexOf('return out.filter((x) => !(x && x.type', b));
if (a < 0 || b < 0 || c < 0) {
  console.error('抠不到源码，位置：', { a, b, c });
  process.exit(1);
}
const code = src.slice(a, c + 3);

// ── 桩：一个真实感的群成员名单（含那个「我没有钱=）」）
const memberCache = new Map([
  [
    '200000007',
    [
      { uid: '78404832', name: '我没有钱=）', nick: '我没有钱=）' },
      { uid: '10000001', name: '<主人>', nick: '<主人>' },
      { uid: '10000013', name: 'Anon', nick: 'anon酱' },
    ],
  ],
]);
const names = {
  findByName: (q) => (q === '<主人>' ? '10000001' : q === 'anon' || q === 'anon酱' ? '10000013' : ''),
};
const aliasesOf = () => [];

const { matchNameToUid, atifyText } = new Function(
  'names',
  'aliasesOf',
  'memberCache',
  `${code}; return { matchNameToUid, atifyText };`,
)(names, aliasesOf, memberCache);

const GID = '200000007';
let bad = 0;
const ok = (n, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${n}${extra ? '  ' + extra : ''}`);
  if (!cond) bad++;
};

const texts = (segs) => (Array.isArray(segs) ? segs : [{ type: 'text', data: { text: String(segs ?? '') } }])
  .filter((s) => s.type === 'text')
  .map((s) => String(s.data?.text ?? ''))
  .join('');
const ats = (segs) => (Array.isArray(segs) ? segs : []).filter((s) => s.type === 'at').map((s) => String(s.data?.qq));

console.log('—— 一、matchNameToUid 直接测 ——');
ok('「我」不认（原来会认成 78404832）', matchNameToUid('我', GID) === '', `→ "${matchNameToUid('我', GID)}"`);
ok('「你」不认', matchNameToUid('你', GID) === '');
ok('「大家」不认', matchNameToUid('大家', GID) === '');
ok('单个「爱」不认（「爱音」的前缀）', matchNameToUid('爱', GID) === '');
ok('「<主人>」仍然认（2 字以上正常名字不能误伤）', matchNameToUid('<主人>', GID) === '10000001', `→ "${matchNameToUid('<主人>', GID)}"`);

console.log('\n—— 二、atifyText 整条消息测（这才是发出去那道闸）——');
{
  const segs = atifyText('……嗯？。今天怎么这么闲，还专门 @我', GID);
  ok('「@我」一个 at 段都不许有', ats(segs).length === 0, `at=${JSON.stringify(ats(segs))}`);
  ok('「@我」原样留在正文里', texts(segs).includes('@我'), `text="${texts(segs)}"`);
}
{
  const segs = atifyText('@你 刚才说的那个版本号是多少', GID);
  ok('「@你」不转', ats(segs).length === 0, `at=${JSON.stringify(ats(segs))}`);
}
{
  const segs = atifyText('@<主人> 群里那个包更新了', GID);
  ok('「@<主人>」照旧转成真 at', ats(segs).join(',') === '10000001', `at=${JSON.stringify(ats(segs))}`);
  ok('「@<主人>」那段文字从正文里去掉', !texts(segs).includes('@<主人>'), `text="${texts(segs)}"`);
}
{
  const segs = atifyText('@Anon 你也来看看', GID);
  ok('「@Anon」照旧转', ats(segs).join(',') === '10000013', `at=${JSON.stringify(ats(segs))}`);
}
{
  // 标点不能被抓进名字里（原来 `{1,16}` 会贪婪吃一串）
  const segs = atifyText('@我。今天怎么这么闲', GID);
  ok('「@我。」整句不被当成一个名字', ats(segs).length === 0, `at=${JSON.stringify(ats(segs))}`);
}
{
  const segs = atifyText('那就 @<主人>，让他看看', GID);
  ok('「@<主人>，」尾逗号不影响识别', ats(segs).join(',') === '10000001', `at=${JSON.stringify(ats(segs))}`);
}

console.log(bad === 0 ? '\n全部通过 ✓' : `\n${bad} 项没过 ✗`);
process.exit(bad === 0 ? 0 : 1);
