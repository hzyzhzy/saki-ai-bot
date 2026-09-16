/** 真实模型验收：存档相关问题答得对不对 */
import { config } from '../src/config.js';
import { streamChat } from '../src/llm.js';
import { knowledgeText } from '../src/knowledge.js';
import { log } from '../src/log.js';

const QUESTIONS = [
  '买存档有什么好处？怎么买？',
  '存档多大？我硬盘够不够',
  '整合包在哪下',
  '我买了存档怎么拿op',
  '存档是什么版本',
  '大足区能随便建吗',
];

const kb = knowledgeText();
const system = [
  '你在扮演「客服小祥」——一个 MC 服务器群里的客服。用你自己的语气回答，别照抄资料原文。',
  '信息必须准确，数字、链接、版本号一个都不能错。资料里没有的不要编。',
  '',
  '# 知识库',
  kb,
].join('\n');

for (const q of QUESTIONS) {
  console.log(`\n${'─'.repeat(58)}`);
  console.log(`群友：${q}`);
  let out = '';
  try {
    for await (const piece of streamChat([
      { role: 'system', content: system },
      { role: 'user', content: q },
    ])) {
      out += piece;
    }
  } catch (e) {
    out = `（出错：${e.message}）`;
  }
  console.log(`小祥：${out.trim()}`);
}
