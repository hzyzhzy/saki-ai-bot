/**
 * 往 QQ 群发**视频**（用户 2026-10-21：「以后视频要全自动发送」）
 *
 * 和 send-voice.mjs 的区别：
 *   · 消息段类型是 `video`（语音是 `record`）
 *   · 视频动辄 15~25 MB，**不能走 base64**（编码后 27 MB+，OneBot 端会拒/超时）
 *     ⇒ 优先传**本地绝对路径**（`file:///…`），让协议端自己去读文件
 *     ⇒ 失败再退 base64（小文件才试）
 *
 * 用法：
 *   node tools/send-video.mjs --file logs/bili/final.mp4 --group 200000001
 *   node tools/send-video.mjs --file … --group … --dry     只校验不发
 *   node tools/send-video.mjs --file … --group … --text "第 1 条发出来了"
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes('--' + n);
const say = (s) => console.log(`[video] ${s}`);

const FILE = arg('file');
const GROUP = arg('group', '200000001');
const TEXT = arg('text', '');
if (!FILE) { say('❌ 要 --file <视频文件>'); process.exit(2); }
const path = resolve(FILE);
if (!existsSync(path)) { say('❌ 文件不存在：' + path); process.exit(2); }
const mb = statSync(path).size / 1024 / 1024;
say(`文件：${path}（${mb.toFixed(2)} MB）`);

// 群号白名单：只允许 config.yml 里配过的群（防手滑发错群）
const cfg = yaml.load(readFileSync(join(ROOT, 'config.yml'), 'utf8')) || {};
const groups = (cfg.groups || []).map(String);
if (groups.length && !groups.includes(String(GROUP))) {
  say(`⚠️ 群 ${GROUP} 不在 config.yml 的 groups 里（现有：${groups.join(', ')}）`);
  if (!has('force')) { say('   确认要发就加 --force'); process.exit(3); }
}

if (has('dry')) {
  say(`✅ 校验通过（--dry 没发）：会发到群 ${GROUP}` + (TEXT ? `，附文「${TEXT}」` : ''));
  process.exit(0);
}

const token = process.env.QQBOT_TOKEN || cfg.onebot?.token || '';
const base = String(process.env.QQBOT_URL || cfg.onebot?.url || 'http://127.0.0.1:3000').replace(/\/+$/, '');

const post = async (message) => {
  const res = await fetch(`${base}/send_group_msg`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ group_id: Number(GROUP), message }),
  });
  const body = await res.text();
  let j = null;
  try { j = JSON.parse(body); } catch { /* 非 JSON 也算失败 */ }
  return { ok: res.ok && j && (j.status === 'ok' || j.retcode === 0), status: res.status, body: body.slice(0, 300) };
};

// ① 先试本地路径（协议端自己读文件，不传大 base64）
const uri = 'file:///' + path.replace(/\\/g, '/');
say(`发送（本地路径）：${uri}`);
let r = await post([{ type: 'video', data: { file: uri } }]);
say(`  → ${r.ok ? '成功' : '失败'} ${r.ok ? '' : r.body}`);

// ② 小文件（<8MB）才退回 base64
if (!r.ok && mb < 8) {
  say('退回 base64 发送…');
  const b64 = readFileSync(path).toString('base64');
  r = await post([{ type: 'video', data: { file: `base64://${b64}` } }]);
  say(`  → ${r.ok ? '成功' : '失败'} ${r.ok ? '' : r.body}`);
}

if (!r.ok) {
  say('❌ 视频没发出去');
  say('   常见原因：文件太大、协议端不支持本地路径、或该群被限制媒体');
  process.exit(1);
}

if (TEXT) {
  const t = await post([{ type: 'text', data: { text: TEXT } }]);
  say(`附文 → ${t.ok ? '成功' : '失败 ' + t.body}`);
}
say('✅ 已发送');
