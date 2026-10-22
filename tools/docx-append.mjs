#!/usr/bin/env node
/**
 * 在**原文档的副本**上加内容 —— 格式、图片、页眉页脚、样式**一个字都不动**。
 *
 * ## 为什么要这个脚本（2026-10-19 用户原话）
 *
 *   「**文档还是直接新建的文档，里面的图片和格式丢了。我需要直接复制一份文档
 *     然后直接在上面增加内容，格式完全不变。**」
 *
 *   以前的毛病：拿到一份 `课程设计报告.docx`、要往里面填内容 ⇒ 让模型**新建**一个
 *   docx 重新写一遍 ⇒ 封面版式、表格、字体、页边距、图片**全没了** ✗
 *   而他要的是**在原件上续写**，交上去还得是原来那个样子 ✓
 *
 * ## 做法（就三步，没有一步靠"重写"）
 *
 *   1. `cpSync(原件, 副本)` —— **字节级复制**，格式/图片/样式一个都不碰；
 *   2. Word COM 打开**副本**，在指定位置 `InsertAfter` 一段文字（继承那段自己的样式）；
 *   3. `Save()` 存回去（还是 `.docx`，不转格式、不另存成别的）。
 *
 * ⚠️ **不许**用"读文本 → 重新生成 docx"那条路 —— 那就又丢格式了 ✗
 *
 * ## 用法
 *
 *   node tools/docx-append.mjs --from "原件.docx" --out "副本.docx" --text-file "要加的内容.txt"
 *   node tools/docx-append.mjs --from "原件.docx" --out "副本.docx" --text "一句话"
 *   node tools/docx-append.mjs --from "原件.docx" --out "副本.docx" --text-file a.txt --after "第二章"
 *   node tools/docx-append.mjs --from "原件.docx" --check-only    # 只看看它是不是能处理
 *
 *   · `--out` 不写 ⇒ 自动 `原名（续写）.docx`（**绝不覆盖原件**）
 *   · `--after "某段文字"` ⇒ 插在那段**之后**；不写 ⇒ 加在**末尾**
 *   · `--new-page` ⇒ 加之前先分页（写新章节时用）
 *
 * ## 退出码
 *   0 = 成了（stdout 打一行 `OK <副本绝对路径>`）
 *   2 = 参数 / 文件不对
 *   3 = 本机没有 Word（COM 起不来）—— 此时会**退化成"只复制不追加"**，并明说
 */
import { existsSync, copyFileSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (name, dflt = '') => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : dflt;
};
const has = (name) => argv.includes(`--${name}`);

const from = arg('from');
if (!from) {
  console.error('缺少 --from <原件>');
  process.exit(2);
}
const src = resolve(from);
if (!existsSync(src)) {
  console.error(`原件不存在：${src}`);
  process.exit(2);
}
const ext = extname(src).toLowerCase();
if (!['.docx', '.doc'].includes(ext)) {
  console.error(`只处理 .docx / .doc（这份是 ${ext || '没有后缀'}）`);
  process.exit(2);
}
if (has('check-only')) {
  console.log(`OK 可以处理：${src}`);
  process.exit(0);
}

// ── 1. 副本路径（默认绝不覆盖原件）──
const outArg = arg('out');
const dst = outArg
  ? resolve(outArg)
  : join(dirname(src), `${basename(src, extname(src))}（续写）${ext}`);
if (dst === src) {
  console.error('--out 和 --from 是同一个文件（那就把原件改掉了）⇒ 换一个输出名');
  process.exit(2);
}

// ── 2. 要加的内容 ──
let text = arg('text');
const tf = arg('text-file');
if (!text && tf) {
  const p = resolve(tf);
  if (!existsSync(p)) {
    console.error(`--text-file 不存在：${p}`);
    process.exit(2);
  }
  text = readFileSync(p, 'utf8');
}
if (!text) {
  console.error('没给内容（--text 或 --text-file 二选一）；只想复制一份就自己 cp');
  process.exit(2);
}

// ── 3. 先字节级复制（格式全保留）──
copyFileSync(src, dst);
console.log(`已复制：${basename(src)} → ${basename(dst)}（${statSync(dst).size} 字节）`);

// ── 4. Word COM 在副本上追加 ──
// ⚠️ 参数一律走**环境变量**：这个项目的路径里有空格 + 中文，拼命令行必掉进引号地狱 ✗
const ps = `
$ErrorActionPreference = 'Stop'
# ⚠️⚠️⚠️ 2026-10-21 加（用户截图：Word 弹「**Word 无法创建工作文件，请检查临时环境变量**」）——
#    实测这台机器的 TEMP 已经涨到 **22.69GB**（里头有个 7.68GB 的旧目录），
#    文件数多到连统计都超时 ⇒ **Word 在里头建临时文件会失败** ⇒ 弹框卡死
#    ⇒ COM 调用全部 25 秒超时 ⇒ agent 以为 Word 坏了 ✗✗
#    ⇒ **给 Word 一个专用的干净临时目录**（固定路径、只有它自己用），别用系统 TEMP ✓
$wordTmp = Join-Path $env:LOCALAPPDATA 'Temp\\word-safe'
try { New-Item -ItemType Directory -Force -Path $wordTmp | Out-Null } catch {}
$env:TEMP = $wordTmp
$env:TMP = $wordTmp
# ⚠️⚠️ 2026-10-21 加（用户截图：Word 弹「**文件正在使用：xxx.docx 被 "zy hg" 锁定，无法编辑**」）——
#    真因：每次用 Word 都留下**没退出的残留实例**（实测一次操作堆了 4 个 WINWORD），
#    实例一直锁着文档 ⇒ 下次打开就弹"只读副本 / 合并更改 / 等通知"那个框，
#    而 agent **没有鼠标、点不了这个框** ⇒ 卡死、报"命令失败"、最后误以为 Word 坏了 ✗✗
#    ⇒ **打开前先把坑清掉**：
#      ① 杀掉**没有主窗口标题**的 WINWORD（有标题的是用户自己开着的，别动 ✓）
#      ② 删掉同目录的 ~$xxx.docx 锁文件
try {
  Get-Process WINWORD -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -eq '' } |
    ForEach-Object { try { $_.Kill() } catch {} }
  Start-Sleep -Milliseconds 300
} catch {}
try {
  Get-ChildItem (Split-Path $env:DOCX_FILE) -Filter '~$*' -Force -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
} catch {}
try {
  $w = New-Object -ComObject Word.Application
} catch {
  Write-Output 'NOWORD'
  exit 0
}
try {
  $w.Visible = $false
  $w.DisplayAlerts = 0
  # ⚠️ Open 的四个参数都显式给：ConfirmConversions=false（别弹"转换格式"框）、
  #    ReadOnly=false、AddToRecentFiles=false ⇒ 少一个都可能弹框 ✓
  $d = $w.Documents.Open($env:DOCX_FILE, $false, $false, $false)
  $anchor = $env:DOCX_AFTER
  $insert = $env:DOCX_TEXT
  if ($env:DOCX_NEWPAGE -eq '1') {
    $d.Content.InsertParagraphAfter()
    $d.Content.InsertBreak(7)   # wdPageBreak
  }
  if ($anchor -ne '') {
    # ⚠️ 在指定那段**之后**插：找不到就退到末尾（别把内容丢了）
    $found = $false
    foreach ($p in $d.Paragraphs) {
      if ($p.Range.Text.Trim() -eq $anchor.Trim()) {
        $p.Range.InsertParagraphAfter()
        $p.Next.Range.Text = $insert
        $found = $true
        break
      }
    }
    if (-not $found) { $d.Content.InsertAfter([char]13 + $insert) }
  } else {
    $d.Content.InsertAfter([char]13 + $insert)
  }
  $d.Save()
  $d.Close(0)
  Write-Output 'DONE'
} catch {
  Write-Output ('ERR ' + $_.Exception.Message)
} finally {
  try { $w.Quit() } catch {}
}
`;

const r = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(ps, 'utf16le').toString('base64')],
  {
    env: {
      ...process.env,
      DOCX_FILE: dst,
      DOCX_TEXT: String(text).replace(/\r\n/g, '\n').replace(/\n/g, '\r'),
      DOCX_AFTER: arg('after'),
      DOCX_NEWPAGE: has('new-page') ? '1' : '0',
    },
    encoding: 'utf8',
    timeout: 120000,
  },
);

const outTxt = String(r.stdout ?? '').trim();
if (outTxt.includes('NOWORD')) {
  // ⚠️ 没有 Word 也别假装成功：明说"只复制了、没加内容"，让调用方自己决定
  console.error('⚠️ 本机起不来 Word（COM 不可用）⇒ **只复制了原件，内容没加进去**');
  console.log(`PARTIAL ${dst}`);
  process.exit(3);
}
if (outTxt.startsWith('ERR')) {
  console.error(`⚠️ Word 处理出错（副本还在，内容可能没加全）：${outTxt}`);
  console.log(`PARTIAL ${dst}`);
  process.exit(3);
}
if (!outTxt.includes('DONE')) {
  console.error(`⚠️ 没拿到 Word 的确认（stderr: ${String(r.stderr ?? '').slice(0, 300)}）`);
  console.log(`PARTIAL ${dst}`);
  process.exit(3);
}
console.log(`OK ${dst}`);
