/**
 * 往群里发一条**语音消息**（测试 IndexTTS 合成效果用）。
 *
 * 为什么单独一个工具：机器人本体只收发文字/图片，发语音没走过；
 * 而"她自己的声音像不像"只能真发到群里听——所以先做个能手动跑的入口。
 *
 * 用法：
 *   node tools/send-voice.mjs --file logs/bili/test.mp3 --group 200000001
 *   node tools/send-voice.mjs --file xxx.mp3 --group 200000001 --text "附一句话"
 *   node tools/send-voice.mjs --file xxx.mp3 --group 200000001 --dry   只校验不发
 *
 * 端口：主号 10000002 的 HTTP 服务是 3000（见 C:\SnowLuma\config\onebot_10000002.json）。
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = (n) => argv.includes('--' + n);

const FILE = arg('file');
const GROUP = arg('group', '200000001');
const TEXT = arg('text', '');
const PORT = Number(arg('port', '3000'));
const TOKEN = arg('token', 'F_8CSrAATSNvPa4QwdhomDbMmJl86pDgwow7-3FMoYg');
const DRY = flag('dry');

function say(s) {
  console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${s}`);
}

if (!FILE) {
  say('❌ 要 --file <音频文件>');
  process.exit(1);
}
const path = resolve(FILE);
if (!existsSync(path)) {
  say(`❌ 文件不存在：${path}`);
  process.exit(1);
}
const size = statSync(path).size;
if (size > 8 * 1024 * 1024) {
  say(`⚠️ 文件 ${(size / 1024 / 1024).toFixed(1)} MB，QQ 语音一般限 60 秒，先切短`);
}
say(`音频：${path}（${(size / 1024).toFixed(0)} KB）→ 群 ${GROUP}`);

const b64 = readFileSync(path).toString('base64');
const message = [{ type: 'record', data: { file: `base64://${b64}` } }];
if (TEXT) message.unshift({ type: 'text', data: { text: TEXT } });

if (DRY) {
  say(`dry：将要发 ${message.length} 段，base64 长度 ${b64.length}`);
  process.exit(0);
}

const url = `http://127.0.0.1:${PORT}/send_group_msg`;
say(`POST ${url}`);
let res;
try {
  res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ group_id: Number(GROUP), message }),
  });
} catch (e) {
  say(`❌ 连不上协议端（${PORT}）：${e.message}`);
  process.exit(2);
}
const body = await res.text();
let j = null;
try {
  j = JSON.parse(body);
} catch {
  /* 非 JSON，原样打 */
}
if (j && (j.status === 'ok' || j.retcode === 0)) {
  say(`✅ 已发送（message_id=${j.data?.message_id ?? '-'}）`);
} else {
  say(`❌ 发送失败 HTTP ${res.status}：${body.slice(0, 400)}`);
  process.exit(3);
}
