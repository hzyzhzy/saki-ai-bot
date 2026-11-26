// 只捞「他说话」的原文：〔问答〕〔言语〕六、言、他写的书简、第一人称〔记〕。
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const FILE = 'E:/Downloads/沈策古风剧情设定完整版.txt';
const buckets = { qa: new Set(), speak: new Set(), note: new Set(), letter: new Set() };
let letterOpen = false;

const rl = createInterface({ input: createReadStream(FILE, 'utf8'), crlfDelay: Infinity });
for await (const raw of rl) {
  const t = raw.replace(/^[\s　]+/, '').trim();
  if (!t) continue;

  // 〔问答〕〔言语〕
  let m = /^〔问答[一二三四五六七八九十]*〕(.+)$/.exec(t);
  if (m && buckets.qa.size < 40) { buckets.qa.add(m[1]); continue; }
  m = /^〔言语〕(.+)$/.exec(t);
  if (m && buckets.speak.size < 40) { buckets.speak.add(m[1]); continue; }

  // 他写的信：〔书 第 N 通〕沈策 致 X
  m = /^〔书\s*第\s*\d+\s*通〕(.+)$/.exec(t);
  if (m) { letterOpen = /沈策|沈澈/.test(m[1]); continue; }
  if (letterOpen && buckets.letter.size < 6) {
    if (/^〔/.test(t)) continue;
    if (t.length > 4) buckets.letter.add(t);
  }

  // 第一人称记事（他的内心话，最能看出语感）
  m = /^〔(记[一二三四五六七八九十]*|夜记)〕(.+)$/.exec(t);
  if (m && buckets.note.size < 40) buckets.note.add(m[2]);
}
rl.close();

const show = (name, set, n) => {
  console.log(`\n===== ${name}（唯一 ${set.size} 条）=====`);
  [...set].slice(0, n).forEach(x => console.log('·', x.slice(0, 120)));
};
show('问答', buckets.qa, 18);
show('言语（纯台词）', buckets.speak, 40);
show('他写的书简', buckets.letter, 6);
show('第一人称记事', buckets.note, 18);
