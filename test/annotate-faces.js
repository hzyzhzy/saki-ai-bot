/**
 * 命令行版：给表情补注释。
 *
 * ⚠️ 逻辑都在 `src/face-annotate.js` 里（管理界面的「自动补注释」按钮用的是同一个模块），
 *    这个脚本只是命令行入口，别在这里再写一套（会更难维护）。
 *
 * 用法：
 *   node test/annotate-faces.js                  只处理注释不全的
 *   node test/annotate-faces.js --all            全部重做（会覆盖手写的，慎用）
 *   node test/annotate-faces.js --dry            只看要做哪些，不真跑
 *   node test/annotate-faces.js --limit=3        只做前 3 张（试跑用）
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/config.js';
import { listUnannotated, annotateAll } from '../src/face-annotate.js';

const LIB = join(ROOT, 'library');
const INDEX = join(LIB, 'index.json');

const args = process.argv.slice(2);
const ALL = args.includes('--all');
const DRY = args.includes('--dry');
const LIMIT = Number((args.find((a) => a.startsWith('--limit=')) ?? '').replace('--limit=', '')) || 0;

function load() {
  return JSON.parse(readFileSync(INDEX, 'utf8'));
}

function save(idx) {
  const tmp = `${INDEX}.tmp`;
  writeFileSync(tmp, JSON.stringify(idx, null, 2), 'utf8');
  renameSync(tmp, INDEX);
}

/** 改完通知机器人重载（不用重启） */
async function notifyReload() {
  const port = process.env.WEBUI_PORT || 3099;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/reload`, { method: 'POST' });
    if (r.ok) console.log('已通知机器人重载表情库（不用重启）');
    else console.log(`⚠️ 通知重载失败（HTTP ${r.status}），可在界面上点「重新加载」`);
  } catch {
    console.log('⚠️ 机器人没在跑（或界面端口不是 3099），下次启动会自动读到新注释');
  }
}

async function main() {
  const idx = load();
  const faces = idx.faces ?? [];

  // --all：把注释清空，让它们重新进「待补」队列
  if (ALL) {
    for (const f of faces) {
      f.who = '';
      f.when = '';
      f.desc = '';
      f._未完善 = true;
    }
    console.log('（--all：全部标成待补，手写的注释会被覆盖）');
  }

  const todo = listUnannotated(faces);
  console.log(`表情库共 ${faces.length} 张，要处理 ${LIMIT ? Math.min(LIMIT, todo.length) : todo.length} 张`);
  if (!todo.length) {
    console.log('都注释齐了，不用处理');
    return;
  }

  if (DRY) {
    for (const f of todo) {
      console.log(`  ${f.file}  (who:${f.who ? '有' : '空'} when:${f.when ? '有' : '空'})`);
    }
    console.log('\n（--dry 模式，没跑模型、没写入）');
    return;
  }

  const r = await annotateAll(faces, {
    limit: LIMIT || undefined,
    save: (fs) => save({ ...idx, faces: fs }),
    onProgress: (done, total, face, note) => {
      console.log(`  [${done}/${total}] ${face.file} → ${note}`);
    },
  });

  console.log(`\n完成：成功 ${r.ok}，失败 ${r.failed}`);
  if (r.ok > 0) await notifyReload();
}

main().catch((e) => {
  console.error('出错：', e.message);
  process.exit(1);
});
