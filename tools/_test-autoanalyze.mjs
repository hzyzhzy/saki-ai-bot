// 隔离验证：构造一个"带 file 段的收到消息"事件，直调 bot 内部那条自动分析+引用逻辑
//   为什么这么测：OneBot 的 send_group_msg 发不出 `type:'file'` 段（只能上传群文件），
//   而真实场景是"群友在群里拖一个 zip 进去"⇒ 那条消息**带 file 段**。
//   所以这里直接造事件，走 bot.js 里同一段代码（analyzeLogFile）。
import fs from 'node:fs';
import path from 'node:path';

// 动态 import bot 的模块（它依赖 config，得在项目根跑）
const { default: Bot } = await import('../src/bot.js').catch(async () => {
  const m = await import('../src/bot.js');
  return { default: m.Bot || m.default };
});

// ── 造一个假 event ────────────────────────────────────────
const FILE_NAME = '错误报告-测试用-20261121.zip';
const MSG_ID = '444496408'; // 拿一个真实的文件消息 id 来验引用
const ev = {
  post_type: 'message',
  message_type: 'group',
  group_id: 200000001,
  user_id: 3922540227,
  message_id: MSG_ID,
  sender: { user_id: 3922540227, card: '华南', nickname: '华南' },
  message: [
    { type: 'file', data: { name: FILE_NAME, file: '/b8267aa4-b8e7-45a2-86fd-408b00b0c14f', file_size: 39818 } },
  ],
  raw_message: `[CQ:file,name=${FILE_NAME}]`,
};

console.log('=== 造的事件 ===');
console.log('  群:', ev.group_id, '| 发件人:', ev.sender.card, '| message_id:', ev.message_id);
console.log('  file 段:', JSON.stringify(ev.message[0].data));

// ── 拿 bot 实例 ───────────────────────────────────────────
let bot = null;
try {
  // Bot 是 class，需要账号配置；这里只借用它的方法，构造一个最薄的实例
  const Ctor = Bot;
  // 试试能不能 new（构造函数可能要参数）
  bot = new Ctor({ account: '10000002' });
} catch (e) {
  console.log('  new Bot 失败（正常，构造函数要真实环境）:', e.message.slice(0, 80));
}

if (!bot) {
  console.log('\n⚠️ 拿不到 bot 实例 ⇒ 改测 mc-log 那一层（核心逻辑在那边）');
  const { analyzeFile, loadAnalysis } = await import('../src/mc-log.js');
  const buf = fs.readFileSync('state/_t_____-21-11-2026____1.22.10.zip');
  const r = analyzeFile({
    name: FILE_NAME,
    buf,
    uploader: { qq: String(ev.user_id), name: ev.sender.card, group: String(ev.group_id), messageId: MSG_ID },
  });
  console.log('  analyzeFile ok:', r.ok, '| 异常:', r.analysis?.exceptions);
  console.log('  uploader:', JSON.stringify(r.analysis?.uploader));
  console.log('  messageId:', r.analysis?.messageId);
  const back = loadAnalysis({ qq: String(ev.user_id) });
  console.log('  按 qq 读回:', back?.analysis?.uploader?.name, '| msgId:', back?.analysis?.messageId);
  process.exit(0);
}

// ── 有实例就直调 analyzeLogFile ───────────────────────────
console.log('\n=== 直调 analyzeLogFile ===');
const out = await bot.analyzeLogFile(ev, ev.message[0]);
console.log('  返回材料长度:', String(out || '').length, '字');
console.log('  前 200 字:', String(out || '').slice(0, 200).replace(/\n/g, ' | '));
console.log('  _forceQuoteId =', JSON.stringify(ev._forceQuoteId), '（应该等于', MSG_ID, '）');
