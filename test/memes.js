/**
 * 梗库测试（`node test/memes.js`）。
 *
 * 重点**不是**"能不能认出梗"，而是**"会不会把普通词认成梗"** ——
 * 用户原话：「得把梗认出来，但也不要把所有同一种词都当玩梗」。
 * 所以下面每个用例都成对：该认的要认，**不该认的必须一个字都不注入**。
 *
 * ⚠️ 这个测试**不联网、不读配置**，只读 `knowledge/memes.md`
 *    （`memes.js` 里 `reload()` 现读盘）。
 */
import { memesFor, reload } from '../src/memes.js';

let pass = 0;
let fail = 0;

/** @param {string} name @param {boolean} want @param {string} text */
function check(name, want, text) {
  const out = memesFor(text);
  const got = !!out;
  const ok = got === want;
  if (ok) pass++;
  else fail++;
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(
    `${tag} ${name}｜want=${want ? '梗' : '普通'} got=${got ? '梗' : '普通'}｜「${text}」`,
  );
  if (!ok && got) console.log('      注入内容：\n      ' + out.split('\n').slice(0, 4).join('\n      '));
  return out;
}

reload(); // 现读盘，保证测的是当前文件

console.log('== ① 「典」：独立出现算梗，出现在「经典/词典/典礼」里不算 ==');
check('裸「典」', true, '典');
check('典中典 + 笑声', true, '典中典哈哈哈哈');
check('经典案例', false, '这是经典案例');
check('词典在哪', false, '嗯那些词典在哪');
check('开学典礼', false, '明天有开学典礼');
check('很典型', false, '这个现象很典型');

console.log('\n== ② 「急了」：独立出现算梗，被「着急/急诊」包住不算 ==');
check('你急了', true, '你急了你急了');
check('别急', true, '别急别急');
check('着急出门', false, '你着急出门就先走');
check('挂了急诊', false, '他半夜挂了急诊');
check('急事', false, '我这儿有点急事');
// ⚠️ 裸「急」**故意不算** —— 中文里它太常见（急着/急性/急用…），
//    认它必然误伤。这条守住"不要把普通词当玩梗"的底线。
check('裸「急」不当梗', false, '急');

console.log('\n== ③ 完全无关的话：一个字都不该注入 ==');
check('闲聊', false, '今天心情好');
check('问服务器', false, '服务器现在几个人在线');
check('空串', false, '');
check('纯符号', false, '。。。');

console.log('\n== ④ 命中的注入块要自带"防抖机灵"的总规则 ==');
const block = memesFor('典中典哈哈哈哈');
const must = ['平时就是普通词', '按字面正常回'];
for (const s of must) {
  const ok = block.includes(s);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} 注入块含「${s}」`);
}

console.log('\n== ⑤~⑧ 敏感类已迁到独立全局库，不再由梗库按需注入 ==');
// 2026-09-25：敏感词必须**始终在提示词里**，不能等命中才补；
// 它现在住在 knowledge/sensitive/sensitive-words.md（全局注入），
// 所以 memesFor() 对这些词返回空是**正确行为** —— 两边不能各存一份。
const migratedSensitive = [
  '你当我老婆吧', '来贴贴', '要抱抱', '你这个舔狗',
  'ghs', '来开车', '社保', '打桩机', '瑟瑟',
  '欧派', '这腿玩年', '巨乳', '就一个飞机场', '蜜桃臀',
  '大雷', '小雷', '什么罩杯', '奈子', '奶量',
];
for (const t of migratedSensitive) {
  check('敏感词已迁出梗库（全局库负责）', false, t);
}
// 防误伤的字面反例照旧：普通词任何时候都不该被当成敏感词/梗。
check('粘贴文件', false, '把这段粘粘贴到文档里');
check('老婆饼', false, '给我带两个老婆饼');
check('开车回家', false, '我先开车回家了');
check('社保卡', false, '社保卡在哪儿办');
check('瑟瑟发抖', false, '外面冷得我瑟瑟发抖');
check('欧派橱柜', false, '我家装的欧派橱柜');
check('去飞机场', false, '我明天去飞机场接人');
check('今天打雷了', false, '外面今天打雷了');
check('奈良', false, '奈良的小鹿真可爱');

console.log('\n== ⑨ 二次元·明日方舟：认得联动，但别把服主「方舟酱」误当游戏 ==');
// 该认的：谈方舟游戏内容 → 命中（玩梗类，不标"只认不接"）
for (const t of ['明日方舟真好玩', '阿米娅好可爱', '罗德岛招人吗', '这源石怎么回事', '泰拉大陆']) {
  const out = memesFor(t);
  const hit = !!out;
  const ok = hit && !out.includes('只认不接');
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} 方舟命中「${t}」got=${hit ? '认' : '漏'}`);
}
// 不该认的：服主昵称「方舟酱 / <主人> / 粥粥」和字面词，必须一个字都不注入
check('方舟酱', false, '方舟酱在吗');
check('诺亚方舟', false, '诺亚方舟的故事');
check('方舟子', false, '方舟子又发博了');
check('泰拉瑞亚', false, '昨晚打泰拉瑞亚打到很晚');
check('罗德岛战记', false, '罗德岛战记是部老番');

console.log('\n== ⑩ 7999 DPS 名梗：认得（关于她自己），但普通数字不误伤 ==');
// 该认的：出现 7999dps / dps7999 / 祥子7999 → 命中（玩梗类）
for (const t of ['7999dps', 'dps7999', '祥子7999', '这 7999 dps 也太离谱了']) {
  const out = memesFor(t);
  const hit = !!out;
  const ok = hit && !out.includes('只认不接');
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} 7999命中「${t}」got=${hit ? '认' : '漏'}`);
}
// 不该认的：7999 只是普通数字（价格/人数）→ 触发词不含裸 7999，必须一个字都不注入
check('手机7999元', false, '这个手机 7999 元');
check('7999人', false, '现场有 7999 人');
check('7999年', false, '那是 7999 年的事');

console.log('\n================');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
// ⚠️ run-all.js 靠 `结果:\s*(.+)` 抓**最后一条** —— 少了这行会被当成「（无结果行）」判失败。
console.log(`结果: ${fail === 0 ? '全部通过 ✅' : `${fail} 项失败 ❌`}`);
process.exit(fail ? 1 : 0);
