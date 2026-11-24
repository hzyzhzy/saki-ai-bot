// 验「卡片 bug 修好了」：模拟"第一轮失败 → 重跑成功"那两步
//   期望：
//     ① 第一轮失败后：stage=failed、reply 空、note 有失败原因
//     ② 重跑成功后：  stage=**done**、reply 有 30 字、**note 被清空**
import { start, finish, all, clear } from '../src/think-log.js';

clear();

console.log('=== ① 第一轮失败（模拟 400 超限）===');
const id = start({ group: '200000001', self: '10000002', who: 'Anon', text: '帮我看看刚才的错误文件这个是怎么出错的' });
finish(id, {
  reply: '',
  failed: true,
  note: 'LLM 接口返回 400 Bad Request :: request (117925 tokens) exceeds',
});
let c = all().find((x) => x.id === id);
console.log('  stage =', c.stage);
console.log('  reply =', JSON.stringify(c.reply));
console.log('  note  =', JSON.stringify(String(c.note ?? '').slice(0, 60)));
console.log('  → 卡片上应该是「失败」+「(还没开始写)」', c.stage === 'failed' && !c.reply ? '✓ 和截图一致' : '✗');

console.log('\n=== ② 重跑成功（模拟回主模型重跑出 30 字）===');
finish(id, { reply: '这个错误报告我看过了，崩在 mtr 缺 Architectury API，装一个就好' });
c = all().find((x) => x.id === id);
console.log('  stage =', c.stage);
console.log('  reply =', JSON.stringify(c.reply.slice(0, 30) + '…'));
console.log('  note  =', JSON.stringify(String(c.note ?? '')));
const pass = c.stage === 'done' && String(c.reply).trim().length > 0 && !String(c.note ?? '').trim();
console.log('  → 期望 done + 有回复 + note 空：', pass ? '✓ 修好了' : '✗ 还有问题');

clear();
process.exit(pass ? 0 : 1);
