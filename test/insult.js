/**
 * insult 套件 —— 「有人在骂她」的检测（好感度 -2 靠它）。
 *
 * ## 这条规矩的由来
 *   用户 2026-09-17 原话：「日常互动影响的好感度可以改改，不能每次和她说话都是加，
 *   有人骂她那肯定得减，而且减2，因为加上来很容易。」
 *
 * ## ⚠️ 这个套件里**反例比正例重要**
 *   正例判漏了 → 少扣一次分（无所谓，好感度本来就不该大起大落）；
 *   反例判错了 → 一个老群友随口一句「你好笨啊」就被扣 2 分、**语气跟着变冷**，
 *   而他自己根本不知道哪儿说错了。所以【2】那组不许误判的必须逐条钉住。
 *
 * ⚠️ 纯离线：只测纯函数判据，不起进程、不碰真 QQ、不花钱。
 * 用法: node test/insult.js
 */
import { detectInsult, findInsultWord } from '../src/insult.js';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const SELF = '10000002';
const HIM = '30003';
const atHer = [{ type: 'at', data: { qq: SELF } }];
const atOther = [{ type: 'at', data: { qq: HIM } }];
const NAMES = ['祥子', '小祥', '客服小祥', 'saki'];
const d = (segs, text) => detectInsult(segs, text, { selfId: SELF, names: NAMES });

console.log('\n【1】该判成"骂她"的（既骂了、又指向她）');
for (const [segs, text, why] of [
  [atHer, '你就是个傻逼', '@她 + 傻逼'],
  [atHer, '蠢货一个', '@她 + 蠢货'],
  [atHer, 'sb', '@她 + sb'],
  [[], '客服小祥你就是个傻逼', '点名 + 傻逼'],
  [[], '祥子这傻逼', '点名 + 傻逼'],
  [[], '小祥有病吧', '点名 + 有病'],
  [[], '祥子去死', '点名 + 去死'],
  [atOther, '祥子真是个脑残', '@别人但在说她 + 脑残'],
]) {
  const r = d(segs, text);
  check(r.insult, `判为骂她：${text}`, r.insult ? `→ ${r.word}／${r.why}（${why}）` : `（漏了：${r.why}）`);
}

console.log('\n【2】⚠️ 不许误判的（这一组比上一组重要）');
for (const [segs, text, why] of [
  // ── 只是 @ 她，但没骂 ──
  [atHer, '你好', '只是打招呼'],
  [atHer, '在吗', '只是找人'],
  [atHer, '服务器几点开', '正常问事'],
  [atHer, '我喜欢你', '正向'],
  // ⚠️⚠️ 2026-09-17 加（用户拍板）：「**废物**」已经**从词表移除**。
  //    起因：某个群友因为一句含「废物」的话被扣了 2 分
  //    （50→48），而这个词在熟人之间**多半是调侃**（「你个废物哈哈哈」），
  //    不符合本文件头那句「**宁可漏，不可误伤**」。
  //    这条专门钉住"移出去之后不许再被判成骂人"——**别把它挪回上面那组**。
  [atHer, '你这个废物', '⚠️「废物」已移出词表，不该再判骂人'],
  // ── 骂的是**别的东西**，不是她（最常见的误伤来源）──
  [atHer, '这服务器真垃圾', '骂服务器'],
  [atHer, '这个模组真恶心', '骂模组'],
  [atHer, '刚才那个BOSS好恶心', '骂BOSS'],
  [atHer, '我电脑卡死了，真烦', '抱怨自己电脑'],
  [[], '这服务器真垃圾', '没指向她 + 骂服务器'],
  [[], '那个新人真没素质', '骂别人'],
  // ── 熟人之间的轻话（词表故意不收）──
  [[], '祥子你好笨啊', '「笨」不算骂'],
  [[], '小祥好烦', '「烦」不算骂'],
  [[], '客服小祥真讨厌', '「讨厌」不算骂'],
  [[], '祥子你是不是傻', '「傻」不算骂（除非带更重的词）'],
  [atHer, '闭嘴', '「闭嘴」不收（是不耐烦，未必是骂）'],
  [atHer, '幼稚', '「幼稚」不收'],
  // ── 缩写边界：`sb` 不能命中字母串 ──
  [[], 'asb 是什么东西', 'sb 在字母串里'],
  [[], '祥子，xhsb 这个缩写啥意思', '点她名但 sb 在字母串里'],
  [[], 'sbbbb', 'sb 后面还是字母'],
]) {
  const r = d(segs, text);
  check(!r.insult, `放行：${text}`, r.insult ? `→ 误判了！${r.word}（${why}）` : `（${why}）`);
}

console.log('\n【3】findInsultWord：只看"有没有骂人的词"，不看指向');
check(findInsultWord('你就是个傻逼') === '傻逼', '认出「傻逼」', findInsultWord('你就是个傻逼'));
check(findInsultWord('你个SB') === 'sb', '认出「SB」（大小写）', findInsultWord('你个SB'));
check(findInsultWord('asb') === '', '「asb」不算', findInsultWord('asb'));
check(findInsultWord('你好啊') === '', '正常话没有词', findInsultWord('你好啊'));
check(findInsultWord('这服务器真垃圾') === '', '⚠️「垃圾」故意不在表里', findInsultWord('这服务器真垃圾'));
check(findInsultWord('真恶心') === '', '⚠️「恶心」故意不在表里', findInsultWord('真恶心'));

console.log('\n【4】词表自检：这几个词**必须永远不在表里**');
// ⚠️ 这一组是给"以后想加词的人"看的：这几个词在群里太常见，
//    加了必然大面积误伤（尤其「垃圾」，最常见的句式是骂服务器）。
for (const w of ['垃圾', '恶心', '闭嘴', '笨', '烦', '讨厌', '傻', '滚']) {
  check(findInsultWord(`你真是${w}`) === '', `「${w}」不在词表`, findInsultWord(`你真是${w}`) || '（好）');
}

console.log('\n【5】边界：空输入 / 非字符串不许抛错');
for (const v of ['', '   ', null, undefined, 123]) {
  let ok = true;
  let got = '（抛错了）';
  try {
    got = JSON.stringify(detectInsult([], v, { selfId: SELF, names: NAMES }));
  } catch (e) {
    ok = false;
    got = e.message;
  }
  check(ok && got.includes('"insult":false'), `安全处理：${JSON.stringify(v)}`, got);
}
// segs 不是数组也不许抛
for (const segs of [null, undefined, 'x', 123]) {
  let ok = true;
  let got = '（抛错了）';
  try {
    got = String(d(segs, '你就是个傻逼').insult);
  } catch (e) {
    ok = false;
    got = e.message;
  }
  check(ok, `segs 异常也不抛：${JSON.stringify(segs)}`, got);
}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures ? 1 : 0);
