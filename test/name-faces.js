/**
 * 给 library/ 里的图片批量重命名 + 生成完整的 index.json。
 *
 * 每条包含四样：
 *   tag   —— 模型调用时写的名字
 *   who   —— 图里是谁 / 画的是什么角色（有人问「为什么发这个」时要能答）
 *   when  —— 什么场合用（模型靠这句选图）
 *   desc  —— 画面描述（给自己看的）
 *
 * 「谁是谁」是逐张看图判断的。**不确定的标「角色不确定」**，不硬猜 ——
 * 猜错了比说不知道更糟（群友纠正一次就能补上）。
 *
 * 用法: node test/name-faces.js
 */
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'library');

// [旧文件名, 新基名, tag, who, when, desc]
const MAP = [
  // ── 之前已命名的 12 张 ──
  ['face_daiguo.jpg', 'face_daiguo', '戴锅', '蓝发女仆装的手办（角色不确定）', '看到极其离谱、让人说不出话的发言时；或者对方的要求根本没法接的时候。无语到极点。', '蓝发女仆服手办头顶扣着一个不锈钢锅，表情呆滞'],
  ['face_chigua.jpg', 'face_chigua', '吃瓜', '粉发少女（角色不确定）', '群里有人在争论、吵架、或者有热闹可看，你在旁边围观的时候。', '粉发少女咬着食物，一脸满足地看戏'],
  ['face_yihuo.gif', 'face_yihuo', '疑惑', '动漫毛绒布偶（角色不确定）', '对方说得不清楚、你需要他补充信息、或者觉得他说的不对劲的时候。', '毛绒布偶的近景脸，张嘴一脸疑惑'],
  ['face_momo.gif', 'face_momo', '摸摸', '网络梗图（猪头）', '群友干得漂亮、答对了、或者自我感觉良好的时候，用一种居高临下的调侃式表扬。', '一只手从显示器里伸出来摸猪头，配字「群友不错，摸摸」'],
  ['face_hanxiao.gif', 'face_hanxiao', '憨笑', '粉发毛绒布偶（角色不确定）', '事情顺利、心情好、被夸了、或者只是单纯想回应一下。最百搭的一张。', '粉发布偶眯着眼大笑，双手合十'],
  ['face_dingzhe.jpg', 'face_dingzhe', '盯着', '粉发少女（角色不确定）', '沉默地盯人；对方说了话在等他解释；或者对某个说法表示怀疑、不说话就看着。', '粉发少女瞪大眼睛直勾勾地盯着看'],
  ['face_wuyu.gif', 'face_wuyu', '无语', '灰发少女（角色不确定）', '对方说了很蠢的话、重复问已经答过的问题、或者你在表达「我不想说话了」。', '灰发少女半月眼面无表情，画面色调灰暗'],
  ['face_huanhu.jpg', 'face_huanhu', '欢呼', '黄色方块小人（表情包角色）', '问题解决了、达成目标、服务器修好了、有值得庆祝的好消息。', '黄色方块小人举起双臂欢呼'],
  ['face_haixiu.jpg', 'face_haixiu', '害羞', '白发少女（角色不确定）', '被群友夸了、被戳中、或者要承认自己不知道的时候。', '白发少女脸红捂着脸，表情不知所措'],
  ['face_fue.jpg', 'face_fue', '扶额', '粉色毛绒小动物（角色不确定）', '无奈、头疼、被折腾得不行；比「无语」多一点「我累了」的意思。', '粉色毛绒小动物扶额，一脸疲惫'],
  ['face_daxiao.jpg', 'face_daxiao', '大笑', '粉发毛绒布偶（角色不确定）', '真的被逗乐了、气氛轻松、对方在开玩笑的时候。', '粉发布偶张着嘴大笑'],
  ['face_dede.jpg', 'face_dede', '得意', '棕发少女（角色不确定）', '你占了上风、在调侃对方、或者那种「小样，还跟我斗」的若有若无的得意。', '棕发少女闭眼托腮，微微脸红，一脸「小样」'],

  // ── 用户新传的 ──
  ['face_baozha_xiao.jpg', 'face_baozha_xiao', '爆炸笑', '米色长发毛绒布偶（角色不确定）', '事情出了大乱子、服务器炸了，但你用一种「无所谓，反正炸了」的态度面对。灾难现场的淡定。', '米色长发布偶在爆炸火光前微笑'],
  ['face_baozha_ku.jpg', 'face_baozha_ku', '爆炸哭', '米色长发毛绒布偶（角色不确定）', '出大事了、塌房了、彻底完蛋了 —— 爆炸背景 + 哭脸，比「爆炸笑」更惨。', '米色长发布偶在爆炸火光前含着泪'],
  ['face_gongnu.jpg', 'face_gongnu', '搞女同', '红发少女（角色不确定）', '群友在磕 CP、开百合玩笑时，用来打趣或者假装制止。', '红发少女双手举起一脸为难，配字「搞女同什么的不好吧？」'],
  ['face_gounai.jpg', 'face_gounai', '狗奶', '棕发少女（角色不确定）', '接一些离谱的梗、或者吐槽群里奇怪的东西。纯粹搞笑用。', '少女在喝一盒「粤西特供 野生狗奶」'],
  ['face_xiaozhu.jpg', 'face_xiaozhu', '小猪名单', '绿发少女（角色不确定）', '群友在闹、嘴硬、或者你想把它记上一笔的时候。调侃式威胁。', '绿发少女举着名单，配字「别闹了这名单上有你」，名单写着「小猪名单」'],
  ['face_maimai.jpg', 'face_maimai', '呆萌', '棕发少女（角色不确定）', '单纯发呆、卖萌、或者不知道说什么但想冒个泡。', '棕发少女的可爱大头，微微冒汗，一脸呆萌'],
  ['face_keaide.jpg', 'face_keaide', '磕到了', '网络梗图（真人，不是二次元）', '群友分享了好东西、或者磕到 CP、或者表达「这个我喜欢」。', '男人扶着抽油烟机一脸陶醉，配字「磕到美的了」'],
  ['face_zhemeqiang.jpg', 'face_zhemeqiang', '这么强', '青发少女（角色不确定）', '群友干了件厉害的事、或者展示了一个意想不到的操作，你在表达震惊和佩服。', '青发少女瞪大眼睛，配字「这么强？？？」'],
  ['face_guodong.jpg', 'face_guodong', '裹冬', '粉发毛绒布偶（角色不确定）', '天冷、卖萌、或者一种缩起来很可爱的姿态。也可以用在「我很乖」的场合。', '粉发布偶穿黄色青蛙睡衣坐在影院座位上，乖巧可爱'],
  ['face_moqi.jpg', 'face_moqi', '摸鳍', '两只毛绒小动物（角色不确定）', '安慰人、或者表达「没事的」的时候。比「摸摸」温和。', '一只粉色小动物在安慰一只哭着的棕色小动物'],
  ['face_tieba.jpg', 'face_tieba', '贴贴', '两个女孩子（角色不确定）', '群友在互相夸、气氛很好、或者你想表达友善的时候。', '两个女孩子抱在一起，一个开心一个无奈'],
  ['face_pinjian.jpg', 'face_pinjian', '品鉴', '戴墨镜的企鹅（网络梗图）', '对方发了个东西要你评价、或者你在仔细研究某个东西的时候。', '戴墨镜和厨师帽的企鹅在盯着看，配字「品鉴中。。。」'],
  ['face_chaoxihuan.gif', 'face_chaoxihuan', '超喜欢', '黑发少女（角色不确定）', '群友分享了很棒的东西、或者你想表达强烈的喜欢和认可。', '黑发少女微笑，周围飘着爱心，配字「超喜欢」'],
  ['face_sikao.gif', 'face_sikao', '思考', '棕发少女（角色不确定）', '你需要想一想、或者对方说的东西让你疑惑不解。比「疑惑」更偏向「我在琢磨」。', '棕发少女托腮思考，头顶一个问号和一团烟'],
  ['face_shengqi.png', 'face_shengqi', '生气', '绿发少女（扎大蝴蝶结，角色不确定）', '真的被惹到了、要发火的时候（服主已授权可以生气）。', '绿发少女皱眉头顶冒十字，一脸不爽但还是笑着'],
  ['face_bishou.gif', 'face_bishou', '比手', '灰发少女（角色不确定）', '准备好要干活、或者「交给我吧」的姿态。', '灰发少女做出起手式，一脸认真'],
  ['face_kuku.gif', 'face_kuku', '哭哭', '棕发毛绒布偶（角色不确定）', '委屈、惨、或者撒娇式的抱怨。', '棕发布偶眼泪汪汪，一脸要哭的样子'],
  ['face_canmou.gif', 'face_canmou', '参谋', '黑发少女（角色不确定）', '你在出主意、分析问题、或者「让我看看」的姿态。', '黑发少女从后面凑过来看着，表情专注'],
  ['face_yue.jpg', 'face_yue', '阅读', '黄色表情脸（表情包角色）', '对方发了长内容要你看、或者你在「查资料」。', '黄色表情脸拿着手机在看'],
  ['face_xiaozhu2.jpg', 'face_xiaozhu2', '小猪', '一只小猪（网络梗图）', '群友在卖萌或者干了件傻事，轻轻地取笑。', '一只小猪配字「你是小猪」'],
  ['face_huashou.gif', 'face_huashou', '挥手', '黄色圆脸小人（表情包角色）', '打招呼、说再见、或者「交给我」的轻松姿态。', '黄色圆脸小人挥着手笑'],
  ['face_chihe.jpg', 'face_chihe', '吃喝', '白鹅（网络梗图）', '无关紧要的闲聊、或者表示「我就在旁边玩」。', '白鹅叼着薯条，一脸无所谓'],

  // ── 这一轮补的 ──
  ['face_chushou.gif', 'face_chushou', '出手', '银白发少女（穿水手服，角色不确定）', '准备动手、或者「我来」的时候，比「比手」更有攻击性一点。', '银白发少女握着拳头，另一只手抬起，准备出手'],
  ['face_wuyu_phone.png', 'face_wuyu_phone', '无语看手机', '粉发少女（旁边的金发少女是同伴，角色不确定）', '看到群友发的东西之后一脸无语地低头看手机；或者「让我看看你发了什么」。', '粉发少女皱着眉头盯着手机，一脸嫌弃，旁边有个金发少女在笑'],
  ['face_buyao.gif', 'face_buyao', '不要啊', '白粉发色的卡通角色（角色不确定）', '拒绝、抗拒、或者「别这样」的夸张反应。', '白粉发色角色闭着眼抗拒，粉色背景'],
  ['face_baobao.gif', 'face_baobao', '抱抱', '两个女孩子（金发插紫花的是主要角色，角色不确定）', '群友情绪低落、或者你想表达亲近和支持的时候。', '一个金发女孩开心地抱住一个黑长直女孩，被抱的那个一脸无奈'],
];

// ── 处理 ──
const seenHash = new Map();
const faces = [];
let renamed = 0;
let dupes = 0;
let missing = [];

for (const [oldName, base, tag, who, when, desc] of MAP) {
  // 先按原样找，找不到就模糊匹配（防止文件名有笔误）
  let src = join(LIB, oldName);
  if (!existsSync(src)) {
    const prefix = oldName.slice(0, 20).toLowerCase();
    const hit = readdirSync(LIB).find((n) => n.toLowerCase().startsWith(prefix));
    if (hit) {
      src = join(LIB, hit);
      console.log(`  ~  文件名笔误，按前缀匹配到 ${hit}`);
    } else {
      missing.push(oldName);
      console.log(`  ⏭  找不到 ${oldName}`);
      continue;
    }
  }

  const buf = readFileSync(src);
  const realName = src.split(/[\\/]/).pop();
  const ext = realName.split('.').pop().toLowerCase();
  const hash = createHash('md5').update(buf).digest('hex');

  if (seenHash.has(hash)) {
    unlinkSync(src);
    dupes++;
    console.log(`  ♻️  重复删除 ${realName}（与 ${seenHash.get(hash)} 相同）`);
    continue;
  }
  seenHash.set(hash, realName);

  const newName = `${base}.${ext}`;
  const dest = join(LIB, newName);
  if (realName !== newName) {
    if (existsSync(dest)) unlinkSync(dest);
    renameSync(src, dest);
    renamed++;
  }
  faces.push({ tag, file: newName, who, when, desc });
}

writeFileSync(
  join(LIB, 'index.json'),
  JSON.stringify(
    {
      _说明: '表情包素材库。tag 是调用名；who 是图里是谁（有人问「为什么发这个」要答得出）；when 是什么场合用（模型靠这句选图）。',
      _来源: '群友整理的二次元表情（管理界面上传）+ 群里自动收集。',
      _注意: 'who 里标「角色不确定」的是我认不出的，群友认出来可以改；别改 tag，改了模型就调不到。',
      _统计: `共 ${faces.length} 张`,
      faces,
    },
    null,
    2,
  ) + '\n',
  'utf8',
);

console.log(`\n改名 ${renamed} 个，删重复 ${dupes} 个，找不到 ${missing.length} 个`);
console.log(`表情库现在有 ${faces.length} 张`);

const named = new Set(faces.map((f) => f.file));
const leftover = readdirSync(LIB).filter(
  (n) => /\.(png|jpe?g|gif|webp)$/i.test(n) && !named.has(n),
);
if (leftover.length) {
  console.log(`\n⚠️ 还有 ${leftover.length} 张没命名：`);
  for (const n of leftover) console.log(`   ${n}`);
} else {
  console.log('\n✅ library/ 下的图全部已命名');
}
if (missing.length) {
  console.log(`\n⚠️ MAP 里这些没找到（可能已改名）：${missing.join(', ')}`);
}
