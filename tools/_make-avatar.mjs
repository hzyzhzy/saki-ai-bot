// 从花亦山 wiki 取「沈南柯」立绘，裁头肩做头像（写进 personas/shenche/）。
import { writeFileSync, mkdirSync } from 'node:fs';
import sharp from 'sharp';

const PAGE = 'https://wiki.biligame.com/hysxzy/' + encodeURIComponent('名士图鉴');
const NAME = '沈南柯';
const OUT = 'personas/shenche';

const UA = { 'User-Agent': 'Mozilla/5.0 Chrome/120', Referer: 'https://wiki.biligame.com/hysxzy/' };
const html = await (await fetch(PAGE, { headers: UA })).text();

const re = new RegExp(`https://patchwiki\\.biligame\\.com/images/hysxzy/(thumb/[^"')]*?/\\d+px-${encodeURIComponent(NAME)}\\.(png|jpg))`);
const m = re.exec(html);
if (!m) throw new Error('页面上没找到这个角色的图');
const thumb = m[1];
const origUrl = 'https://patchwiki.biligame.com/images/hysxzy/' + thumb.replace(/^thumb\//, '').replace(/\/\d+px-.*$/, '');
console.log('原图地址：', origUrl);

const res = await fetch(origUrl, { headers: UA });
if (!res.ok) throw new Error(`原图下载失败 HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
mkdirSync('logs/_avatar-cand', { recursive: true });
writeFileSync('logs/_avatar-cand/shen-orig.png', buf);

const meta = await sharp(buf).metadata();
console.log('原图尺寸：', meta.width, 'x', meta.height);

// ⚠️ wiki 给的原图本身就是方形头肩像（200px 那张圆形头像就是它的缩略图）⇒ 不用裁，直接用
const square = await sharp(buf).resize(800, 800, { fit: 'cover' }).png({ compressionLevel: 9 }).toBuffer();

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/avatar.png`, square);

// 立绘参考（生图/拍照用）
writeFileSync(`${OUT}/ref.webp`, await sharp(buf).resize(720, 1280, { fit: 'inside' }).webp({ quality: 88 }).toBuffer());
console.log(`写入 ${OUT}/avatar.png（1024×1024）和 ref.webp`);
