/**
 * 给 library/ 里的图片重命名 + 生成 index.json。
 * 名字和「适用场合」是人工看过图之后写的 —— 这一步没法自动，只能看图。
 *
 * 用法: node test/label-faces.js
 */
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'library');

// 旧文件名 → { 新名, tag, when, desc }
const MAP = {
  // 蓝发女仆手办头顶不锈钢锅，表情呆滞
  'e94bbc9327270937e5f3d5b549455f49.jpg': {
    tag: '戴锅',
    file: 'face_daiguo.jpg',
    when: '无语、被整不会了、接别人离谱发言的时候',
    desc: '蓝发女仆服手办头顶一个不锈钢锅，表情呆滞',
  },
  // 粉毛在吃棒状食物，腮红
  '3dfb7bb3b32731ef0932a9809bb682c8.jpg': {
    tag: '吃瓜',
    file: 'face_chigua.gif',
    when: '看热闹、围观群友吵架、有事发生时的吃瓜姿态',
    desc: '粉发少女咬着食物，一脸满足地看戏',
  },
  // 毛绒布偶脸，微微张嘴，疑惑
  '3AD2F6D6E4649BEB22CC1DE3286575EF.gif': {
    tag: '疑惑',
    file: 'face_yihuo.gif',
    when: '没听懂、觉得对方说的不对劲、需要对方说清楚',
    desc: '动漫毛绒布偶的近景脸，张嘴疑惑',
  },
  // 屏幕伸出一只手摸猪头，「群友不错，摸摸」
  '92EC29DE4EA307BA8F79C6144585FC55.gif': {
    tag: '摸摸',
    file: 'face_momo.gif',
    when: '群友表现好、答对了、干了件漂亮事的时候，带点调侃的表扬',
    desc: '手从显示器里伸出来摸猪头，配字「群友不错，摸摸」',
  },
  // 粉发布偶眯眼憨笑，双手合十
  '533966891d43af7aa45892fa7a3372e2.gif': {
    tag: '憨笑',
    file: 'face_hanxiao.gif',
    when: '事情顺利、开心、被夸了、心情好的时候',
    desc: '粉发布偶眯眼大笑，双手合十',
  },
  // 粉毛少女猥琐盯，眼睛瞪大
  'a8aa67306159050a36d90c0f2cda5612.jpg': {
    tag: '盯着',
    file: 'face_dingzhe.jpg',
    when: '沉默地盯人、察觉不对劲、等对方解释',
    desc: '粉发少女瞪大眼睛直勾勾盯着看',
  },
  // 灰发少女半月眼，生无可恋
  '67FE1CF19B49629A02D4A6969308CFD6.gif': {
    tag: '无语',
    file: 'face_wuyu.gif',
    when: '非常无语、不想说话、看到离谱发言的时候',
    desc: '灰发少女半月眼，面无表情，色调灰暗',
  },
  // 黄块小人举双手欢呼
  '7da5a33b5ea3148773b4f3ea17ad537d.jpg': {
    tag: '欢呼',
    file: 'face_huanhu.jpg',
    when: '达成目标、服务器修好了、好消息、庆祝',
    desc: '黄色方块小人举起双臂欢呼',
  },
  // 粉毛布偶害羞捂脸
  '8ef91028df4910f9b2066a4bbfbe526b.jpg': {
    tag: '害羞',
    file: 'face_haixiu.jpg',
    when: '被夸、不好意思、被戳中',
    desc: '白发少女脸红捂着脸，表情不知所措',
  },
  // 粉色毛绒生物扶额，疲惫
  'b14225eebeaf765a2ea91a07fbaf3b9b.jpg': {
    tag: '扶额',
    file: 'face_fue.jpg',
    when: '无奈、头疼、被折腾得不行、扶额叹气',
    desc: '粉色毛绒小动物扶额，一脸疲惫',
  },
  // 粉毛布偶大笑
  '2fb3bd8c78c3bb36857e6f92e950eeb9.jpg': {
    tag: '大笑',
    file: 'face_daxiao.jpg',
    when: '觉得好笑、被逗乐、气氛轻松',
    desc: '粉发布偶张着嘴大笑',
  },
};

// 明确不要的：不合适出现在服务器群里的
const REJECT = {
  'f643f547da6cb959e3ae96ed1f2c161b.png': '流鼻血的 ecchi 暗示图，不适合',
  'e801ad6ae32026b31c3ff61ccf1cb389.gif': '半裸同人图，不适合',
};

let moved = 0;
let removed = 0;
const faces = [];

for (const [oldName, info] of Object.entries(MAP)) {
  const src = join(LIB, oldName);
  if (!existsSync(src)) {
    console.log(`  找不到 ${oldName}，跳过`);
    continue;
  }
  const dest = join(LIB, info.file);
  if (existsSync(dest)) unlinkSync(dest);
  renameSync(src, dest);
  moved++;
  faces.push({ tag: info.tag, file: info.file, when: info.when, desc: info.desc });
  console.log(`  ${info.tag.padEnd(4)} ${oldName.slice(0, 16)}… → ${info.file}`);
}

for (const [name, why] of Object.entries(REJECT)) {
  const p = join(LIB, name);
  if (existsSync(p)) {
    unlinkSync(p);
    removed++;
    console.log(`  删除 ${name.slice(0, 20)}…（${why}）`);
  }
}

// 清掉遗留的临时文件
for (const junk of ['group_00.jpg', 'index.json']) {
  const p = join(LIB, junk);
  if (junk === 'index.json') continue;
  if (existsSync(p)) unlinkSync(p);
}

writeFileSync(
  join(LIB, 'index.json'),
  JSON.stringify(
    {
      _说明: '表情包素材库。file 是 library/ 下的文件名，when 是适用场合，tag 是模型调用时写的名字。',
      _来源: '群友发的表情包（管理界面上传）+ 群里自动收集。加新图用管理界面拖进去即可。',
      _注意: 'tag 只能用这些，模型自己编的标签会被忽略。when 写得越具体，用得越准。',
      faces,
    },
    null,
    2,
  ) + '\n',
  'utf8',
);

console.log(`\n整理完成：${moved} 张入库，${removed} 张删除`);
console.log(`index.json 里现在有 ${faces.length} 个标签：${faces.map((f) => f.tag).join(' / ')}`);
