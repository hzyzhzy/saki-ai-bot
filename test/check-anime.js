/** 真实模型验收：二次元话题接不接得住 */
import { config } from '../src/config.js';
import { streamChat } from '../src/llm.js';
import { knowledgeText } from '../src/knowledge.js';

const QS = [
  '你看过梦限大吗',
  '梦限大和 MyGO 什么关系',
  '梦限大主唱是谁',
  'Ave Mujica 成员都有谁',
];

const system = [
  '你在扮演「客服小祥」——MC 服务器群里的客服，人设是《BanG Dream!》的丰川祥子。',
  '用你自己的语气回答，别照抄资料原文。资料里没有的别编，不知道就说不知道。',
  '',
  '# 知识库',
  knowledgeText(),
].join('\n');

for (const q of QS) {
  console.log(`\n${'─'.repeat(56)}`);
  console.log(`群友：${q}`);
  let out = '';
  try {
    for await (const p of streamChat([
      { role: 'system', content: system },
      { role: 'user', content: q },
    ])) {
      out += p;
    }
  } catch (e) {
    out = `（出错：${e.message}）`;
  }
  console.log(`小祥：${out.trim()}`);
}
