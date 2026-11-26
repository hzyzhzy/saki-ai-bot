import fs from 'node:fs';
const j = JSON.parse(fs.readFileSync('state/remind.json', 'utf8'));
const a = j.items.find((x) => x.id === 990);
if (a) {
  console.log('id990 sent=' + (a.sentAt ? new Date(a.sentAt).toLocaleTimeString('zh-CN') : '未发'));
  console.log('  until=' + (a.until ? new Date(a.until).toLocaleTimeString('zh-CN') : '无') + ' mention=' + a.mention);
  console.log('  history ' + (a.history?.length || 0) + ' 条');
  for (const h of a.history || []) {
    console.log('    · ' + new Date(h.at).toLocaleTimeString('zh-CN') + ' — 「' + String(h.note).slice(0, 70) + '」');
  }
}
const live = j.items.filter((x) => !x.sentAt);
console.log('\n还挂着 ' + live.length + ' 条');
for (const x of live) {
  console.log('  id' + x.id + ' at=' + new Date(x.at).toLocaleTimeString('zh-CN') + ' until=' + (x.until ? new Date(x.until).toLocaleTimeString('zh-CN') : '无') + ' —— ' + String(x.what).slice(0, 30));
}
