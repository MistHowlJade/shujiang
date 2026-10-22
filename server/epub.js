// EPUB 3 导出：零依赖，手写 ZIP + XHTML。
// 只做正文阅读所需的最小结构：标题页、目录、分卷、章节、少量排版 CSS。
import { deflateRawSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { chapterVolumeIds, countWords, volumeLabel } from './store.js';
import { coverSvg, readCoverImage } from './cover.js';
import { outlineRows, characterRows } from './manuscript.js';

const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>';
const CHAPTER_FILE = (i) => `chapter-${String(i + 1).padStart(3, '0')}.xhtml`;

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function chapterLabel(c) {
  const title = String(c.title || '').trim();
  return `第${c.no}章${title ? ` ${title}` : ''}`;
}

function paragraphs(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${esc(line)}</p>`)
    .join('\n');
}

function page(title, body, bodyClass = '') {
  return `${XML_HEAD}
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${esc(title)}</title>
<link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ''}>
${body}
</body>
</html>
`;
}

/** 卷归属：与 TXT / Markdown 导出使用同一套章节 → 卷规则 */
function volumeGroups(novel, chapters) {
  const vols = novel.outline?.volumes || [];
  const ids = chapterVolumeIds(novel);
  const index = new Map((novel.chapters || []).map((c, i) => [c.id, i]));
  const groups = [];
  for (const ch of chapters) {
    const at = index.get(ch.id);
    const vol = at === undefined ? null : vols.find((v) => v.id === ids[at]) || null;
    const key = vol ? vol.id : '';
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, vol, chapters: [] };
      groups.push(group);
    }
    group.chapters.push(ch);
  }
  return groups.map((g) => ({
    ...g,
    vol: g.vol
      ? { id: g.vol.id, no: vols.indexOf(g.vol) + 1, name: g.vol.name || '未命名' }
      : null,
  }));
}

const STYLE = `body { margin: 0 6%; line-height: 1.8; font-family: serif; color: #1b1b1b; }
h1 { margin: 2.4em 0 1.6em; font-size: 1.45em; line-height: 1.45; text-align: center; font-weight: 600; }
p { margin: 0; text-indent: 2em; }
p.volume { margin: 0 0 1.8em; text-align: center; text-indent: 0; color: #777; font-size: .88em; letter-spacing: .04em; }
.titlepage { margin-top: 22%; text-align: center; }
.titlepage h1 { margin: 0 0 .5em; font-size: 2.2em; }
.titlepage .author { margin: 0 0 1.8em; text-indent: 0; color: #555; font-size: 1.05em; }
.titlepage .contact { margin: -1.2em 0 1.8em; text-indent: 0; color: #888; font-size: .9em; }
.titlepage .meta { text-indent: 0; color: #888; font-size: .9em; }
.titlepage .logline { margin: 2.2em auto 0; max-width: 26em; text-indent: 0; color: #666; font-size: .92em; line-height: 1.9; }
body.cover-body { margin: 0; }
.coverpage { margin: 0; text-align: center; }
.coverpage img { display: block; width: 100%; height: auto; }
nav ol { margin: .6em 0 1.2em; padding-left: 1.4em; }
nav li { margin: .35em 0; }
nav a { color: #1b1b1b; text-decoration: none; }
nav span { color: #666; }

/* 随稿附带的材料：全书大纲 / 人物小传 */
.ol-page h1 { margin-bottom: 1.2em; }
.ol-page h2 { margin: 2em 0 .6em; font-size: 1.2em; font-weight: 600; }
.ol-page h3 { margin: 1.6em 0 .4em; font-size: 1.05em; font-weight: 600; }
.ol-page .vol-desc { margin: 0 0 1em; color: #666; font-size: .92em; }
.ol-page .ol-words { color: #888; font-size: .82em; font-weight: 400; }
.ol-page .ol-field { margin: .2em 0; text-indent: 0; font-size: .95em; line-height: 1.75; }
.ol-page .ol-field b { margin-right: .8em; color: #555; font-weight: 600; }
.ol-page .ol-note { margin-top: 2em; color: #888; font-size: .88em; text-indent: 0; }
`;

function navPage(groups, chapters, extras = {}) {
  const fileOf = new Map(chapters.map((c, i) => [c.id, CHAPTER_FILE(i)]));
  const links = groups.map((g) => {
    const items = g.chapters
      .map((c) => `<li><a href="${fileOf.get(c.id)}">${esc(chapterLabel(c))}</a></li>`)
      .join('\n');
    if (!g.vol) return items;
    return `<li><span>${esc(volumeLabel(g.vol, g.vol.no))}</span>\n<ol>\n${items}\n</ol>\n</li>`;
  }).join('\n');
  // 随稿附带的材料：目录里也给出入口
  const extraLinks = [];
  if (extras.outline) extraLinks.push('<li><a href="outline.xhtml">全书大纲</a></li>');
  if (extras.characters) extraLinks.push('<li><a href="characters.xhtml">人物小传</a></li>');
  return `<nav epub:type="toc" id="toc">
<h1>目录</h1>
<ol>
<li><a href="cover.xhtml">封面</a></li>
<li><a href="title.xhtml">书名页</a></li>
${extraLinks.join('\n')}
${links}
</ol>
</nav>
<nav epub:type="landmarks" hidden="hidden">
<ol>
<li><a epub:type="cover" href="cover.xhtml">封面</a></li>
<li><a epub:type="bodymatter" href="${chapters.length ? fileOf.get(chapters[0].id) : 'title.xhtml'}">正文</a></li>
</ol>
</nav>`;
}

/** 随稿附带的「全书大纲」页 */
function outlinePage(novel, chapters) {
  const o = outlineRows(novel, chapters);
  const body = o.volumes.map((v) => `
<h2>第${v.no}卷 ${esc(v.name)}</h2>
${v.desc ? `<p class="vol-desc">${esc(v.desc)}</p>` : ''}
${v.entries.map((e) => `<section class="ol-entry">
<h3>${e.no ? `第${e.no}章 ` : ''}${esc(e.title)}${e.words ? `　<span class="ol-words">${e.words} 字</span>` : ''}</h3>
${e.fields.map((f) => `<p class="ol-field"><b>${esc(f.label)}</b>${esc(f.value)}</p>`).join('\n')}
</section>`).join('\n')}`).join('\n');
  const missing = o.missing ? `<p class="ol-note">另有 ${o.missing} 章还没写章纲。</p>` : '';
  return `<section epub:type="chapter" class="ol-page">
<h1>全书大纲</h1>
${body}
${missing}
</section>`;
}

/** 随稿附带的「人物小传」页 */
function charactersPage(novel) {
  const rows = characterRows(novel);
  const body = rows.map((c) => `
<section class="ol-entry">
<h3>${esc(c.name)}</h3>
${c.fields.map((f) => `<p class="ol-field"><b>${esc(f.label)}</b>${esc(f.value)}</p>`).join('\n')}
${c.relations.length ? `<p class="ol-field"><b>关系</b>${esc(c.relations.map((r) => `与 ${r.to}（${r.type}${r.note ? ` · ${r.note}` : ''}）`).join('；'))}</p>` : ''}
</section>`).join('\n');
  return `<section epub:type="chapter" class="ol-page">
<h1>人物小传</h1>
${body}
</section>`;
}

function titlePage(novel, chapters, words = 0) {
  const meta = [novel.genre, `共 ${chapters.length} 章`, `约 ${words.toLocaleString('zh-CN')} 字`]
    .filter(Boolean)
    .join(' · ');
  return `<section epub:type="titlepage" class="titlepage">
<h1>${esc(novel.title || '未命名作品')}</h1>
${novel.author ? `<p class="author">${esc(novel.author)}</p>` : ''}
${novel.meta?.contact ? `<p class="contact">${esc(novel.meta.contact)}</p>` : ''}
<p class="meta">${esc(meta)}</p>
${novel.meta?.logline ? `<p class="logline">${esc(novel.meta.logline)}</p>` : ''}
</section>`;
}

function packageFile(novel, chapters, cover, extras = {}) {
  const description = novel.meta?.logline || novel.meta?.synopsis || '';
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />',
    '<item id="css" href="style.css" media-type="text/css" />',
    // cover-image 挂在图片本身（不是引用它的 xhtml）上，这是 EPUB 3 的要求
    `<item id="cover-img" href="${cover.href}" media-type="${cover.media}" properties="cover-image" />`,
    '<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml" />',
    '<item id="title" href="title.xhtml" media-type="application/xhtml+xml" />',
    ...(extras.outline ? ['<item id="outline" href="outline.xhtml" media-type="application/xhtml+xml" />'] : []),
    ...(extras.characters ? ['<item id="characters" href="characters.xhtml" media-type="application/xhtml+xml" />'] : []),
    ...chapters.map((c, i) => `<item id="ch${i + 1}" href="${CHAPTER_FILE(i)}" media-type="application/xhtml+xml" />`),
  ].join('\n');
  const spine = [
    '<itemref idref="cover" />',
    '<itemref idref="title" />',
    '<itemref idref="nav" />',
    ...(extras.outline ? ['<itemref idref="outline" />'] : []),
    ...(extras.characters ? ['<itemref idref="characters" />'] : []),
    ...chapters.map((_, i) => `<itemref idref="ch${i + 1}" />`),
  ].join('\n');
  return `${XML_HEAD}
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">urn:uuid:${randomUUID()}</dc:identifier>
<dc:title>${esc(novel.title || '未命名作品')}</dc:title>
<dc:language>zh-CN</dc:language>
${novel.author ? `<dc:creator>${esc(novel.author)}</dc:creator>` : ''}
${novel.genre ? `<dc:subject>${esc(novel.genre)}</dc:subject>` : ''}
${description ? `<dc:description>${esc(description)}</dc:description>` : ''}
<meta property="dcterms:modified">${modified}</meta>
<meta name="cover" content="cover-img" />
</metadata>
<manifest>
${manifest}
</manifest>
<spine page-progression-direction="ltr">
${spine}
</spine>
</package>
`;
}

/* ---------------- ZIP（store / deflate，无第三方依赖） ---------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const now = new Date();
  const time = ((now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)) & 0xffff;
  const date = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  const local = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const method = file.store ? 0 : 8;
    const body = method === 0 ? raw : deflateRawSync(raw, { level: 9 });
    const sum = crc32(raw);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);       // 文件名 UTF-8
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(sum, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(sum, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += header.length + name.length + body.length;
  }

  const centralSize = central.reduce((sum, buf) => sum + buf.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...local, ...central, end]);
}

/** 生成完整的 EPUB 文件 Buffer */
export function buildEpub(novel, chapters = novel.chapters || [], extras = {}) {
  const list = (chapters || []).slice();
  const groups = volumeGroups(novel, list);
  const kicker = new Map();
  for (const group of groups) {
    if (group.vol && group.chapters[0]) kicker.set(group.chapters[0].id, group.vol);
  }
  const words = list.reduce((sum, c) => sum + countWords(c.content), 0);

  // 封面：用户传过自己的图就用那张，没传就现画一张
  const custom = readCoverImage(novel);
  const cover = custom
    ? { href: `cover.${custom.ext}`, media: custom.mime, data: custom.data }
    : { href: 'cover.svg', media: 'image/svg+xml', data: coverSvg(novel, { words, chapters: list.length }) };

  const files = [
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    {
      name: 'META-INF/container.xml',
      data: `${XML_HEAD}
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles>
<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" />
</rootfiles>
</container>
`,
    },
    { name: 'OEBPS/content.opf', data: packageFile(novel, list, cover, extras) },
    { name: 'OEBPS/nav.xhtml', data: page('目录', navPage(groups, list, extras)) },
    { name: 'OEBPS/style.css', data: STYLE },
    { name: `OEBPS/${cover.href}`, data: cover.data },
    {
      name: 'OEBPS/cover.xhtml',
      data: page(
        '封面',
        `<section epub:type="cover" class="coverpage">
<img src="${cover.href}" alt="${esc(novel.title || '封面')}" />
</section>`,
        'cover-body'
      ),
    },
    { name: 'OEBPS/title.xhtml', data: page(novel.title || '书名页', titlePage(novel, list, words)) },
  ];

  // 随稿附带的材料：全书大纲、人物小传
  if (extras.outline) {
    files.push({ name: 'OEBPS/outline.xhtml', data: page('全书大纲', outlinePage(novel, list)) });
  }
  if (extras.characters) {
    files.push({ name: 'OEBPS/characters.xhtml', data: page('人物小传', charactersPage(novel)) });
  }

  list.forEach((ch, i) => {
    const vol = kicker.get(ch.id);
    const body = `<section epub:type="chapter">
${vol ? `<p class="volume">${esc(volumeLabel(vol, vol.no))}</p>` : ''}
<h1>${esc(chapterLabel(ch))}</h1>
${paragraphs(ch.content)}
</section>`;
    files.push({ name: `OEBPS/${CHAPTER_FILE(i)}`, data: page(chapterLabel(ch), body) });
  });

  return zip(files);
}
