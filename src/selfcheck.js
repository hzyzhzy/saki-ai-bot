/**
 * 自检脚本：不启动机器人，只检查配置、依赖和模型连通性。
 * 用法: npm run check
 */
import { config, validate } from './config.js';
import { log } from './log.js';
import { ping } from './llm.js';
import { toSegments, extractText, isAt } from './message.js';
import * as history from './history.js';

let failed = 0;
const pass = (s) => console.log(`  ✅ ${s}`);
const fail = (s) => {
  failed++;
  console.log(`  ❌ ${s}`);
};

console.log('\n[1/5] 依赖与配置加载');
try {
  log.info('（以下 debug 日志可忽略）');
  pass('config.yml 解析成功');
} catch (e) {
  fail(`配置解析失败: ${e.message}`);
  process.exit(1);
}

console.log('\n[2/5] 配置项校验');
const problems = validate();
if (problems.length === 0) {
  pass('配置项完整');
} else {
  for (const p of problems) fail(p);
}

console.log('\n[3/5] 消息解析');
try {
  const cq = toSegments('[CQ:at,qq=10001] 你好 [CQ:image,file=a.jpg]');
  if (cq.length === 3 && cq[0].type === 'at') pass('CQ 码解析正常');
  else fail('CQ 码解析异常');

  const arr = toSegments([{ type: 'text', data: { text: 'hi' } }]);
  if (arr.length === 1 && arr[0].data.text === 'hi') pass('消息段数组解析正常');
  else fail('消息段数组解析异常');

  if (isAt(cq, 10001) && isAt(cq, '10001')) pass('@ 检测正常');
  else fail('@ 检测异常');

  const text = extractText(cq).trim();
  if (text === '你好 [图片]') pass(`文本提取正常 -> "${text}"`);
  else fail(`文本提取异常 -> "${text}"`);
} catch (e) {
  fail(`消息解析抛错: ${e.message}`);
}

console.log('\n[4/5] 上下文记忆');
try {
  const key = 'test:1';
  const keep = Math.max(1, config.trigger.historyRounds);
  // 塞进超出上限的轮数，确认只保留最近 keep 轮
  for (let i = 0; i < keep + 3; i++) history.remember(key, `u${i}`, `a${i}`);
  const h = history.getHistory(key);
  const expected = keep * 2;
  if (h.length === expected) pass(`记忆裁剪正常（保留最近 ${keep} 轮 / ${expected} 条）`);
  else fail(`记忆裁剪异常: 期望 ${expected} 条，实际 ${h.length} 条`);
  if (h.at(-1)?.content === `a${keep + 2}`) pass('记忆顺序正确（最新的在最后）');
  else fail(`记忆顺序异常: 最后一条是 ${h.at(-1)?.content}`);

  history.clearHistory(key);
  if (history.getHistory(key).length === 0) pass('清空记忆正常');
  else fail('清空记忆失败');
} catch (e) {
  fail(`记忆模块抛错: ${e.message}`);
}

console.log('\n[5/5] 大模型连通性');
if (problems.some((p) => p.includes('apiKey'))) {
  console.log('  ⏭  跳过（API Key 未填写）');
} else {
  process.stdout.write(`  正在请求 ${config.llm.baseURL} … `);
  try {
    const reply = await ping();
    console.log('');
    pass(`模型可用，返回: "${String(reply).trim().slice(0, 40)}"`);
  } catch (e) {
    console.log('');
    fail(`模型调用失败: ${e.message}`);
  }
}

console.log(`\n结果: ${failed === 0 ? '全部通过 ✅' : `${failed} 项失败 ❌`}\n`);
process.exit(failed === 0 ? 0 : 1);
