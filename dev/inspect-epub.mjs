// 一次性校验脚本：把导出的 EPUB 解开，逐字段核对封面。
// 用法：node dev/inspect-epub.mjs <epub路径>
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2] || 'data/_test.epub';
const buf = fs.readFileSync(file);

function unzip(b) {
  const files = {};
  let i = 0;
  while (i < b.length - 4) {
    if (b.readUInt32LE(i) !== 0x04034b50) { i += 1; continue; }
    const method = b.readUInt16LE(i + 8);
    const compSize = b.readUInt32LE(i + 18);
    const nameLen = b.readUInt16LE(i + 26);
    const extraLen = b.readUInt16LE(i + 28);
    const name = b.slice(i + 30, i + 30 + nameLen).toString('utf8');
    const start = i + 30 + nameLen + extraLen;
    const raw = b.slice(start, start + compSize);
    try { files[name] = method === 0 ? raw : zlib.inflateRawSync(raw); } catch { files[name] = Buffer.alloc(0); }
    i = start + compSize;
  }
  return files;
}

const files = unzip(buf);
console.log('== 包内文件 ==');
for (const [name, data] of Object.entries(files)) {
  console.log(`  ${name}  (${data.length} B)`);
}

const opf = files['OEBPS/content.opf'].toString('utf8');
const svg = files['OEBPS/cover.svg'].toString('utf8');
const coverX = files['OEBPS/cover.xhtml'].toString('utf8');

console.log('\n== content.opf: manifest ==');
console.log(opf.split('<manifest>')[1]?.split('</manifest>')[0]);
console.log('\n== content.opf: metadata ==');
console.log(opf.split('<metadata')[1]?.split('</metadata>')[0]);
console.log('\n== content.opf: spine ==');
console.log(opf.split('<spine')[1]?.split('</spine>')[0]);
console.log('\n== cover.xhtml ==\n' + coverX);
console.log('\n== cover.svg ==\n' + svg);
