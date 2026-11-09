// Word（.docx）导出：零依赖，手写 WordprocessingML + ZIP。
//
// 一份给编辑的稿子：书名页、可选的创作说明、分卷页、每章另起一页；
// A4、宋体 12pt、1.95 倍行距、首行缩进两字，页脚居中页码（书名页不编号）。
// 分页、页码都交给 Word 自己的排版引擎，不在服务端算页。
import { chapterVolumeIds, countWords, volumeLabel, chapterTitleText } from './store.js';
import { submissionFacts, submissionNote } from './manuscript.js';
import { zip } from './zip.js';

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const FONT = '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体" w:cs="Times New Roman" w:hint="eastAsia"/>';
const INK = '17181B';
const MUTED = '595959';
const FAINT = '8A8A8F';

const str = (v) => String(v ?? '').trim();
const num = (v) => Number(v || 0).toLocaleString('zh-CN');

/** 去掉 XML 1.0 不允许的控制字符，别让一段脏字把整份稿子弄成「无法打开」 */
function clean(s) {
  return String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function esc(s) {
  return clean(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function chapterLabel(c) {
  const title = chapterTitleText(c?.title);
  return `第${c?.no}章${title ? ` ${title}` : ''}`;
}

/** 正文一行一段，空行丢掉；首行缩进交给 Word 的段落格式 */
function paragraphs(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** 书名页上那行小字：全书 / 节选 / 单章 / 定稿 */
function scopeLine(chapters, extras, words) {
  if (extras.single && chapters.length === 1) {
    return `第 ${chapters[0].no} 章 · 约 ${num(words)} 字`;
  }
  const parts = [];
  if (extras.range) {
    const r = extras.range;
    parts.push(`节选 · 第 ${r.lo === r.hi ? r.lo : `${r.lo}–${r.hi}`} 章`);
  }
  const scope = extras.onlyDone ? '定稿' : extras.range ? '共' : '全书';
  parts.push(`${scope} ${chapters.length} 章 · 约 ${num(words)} 字`);
  return parts.join(' · ');
}

/** 与 TXT / Markdown / EPUB / 打印稿共用一套「章节 → 卷」规则 */
function volumeOf(novel) {
  const vols = novel.outline?.volumes || [];
  const ids = chapterVolumeIds(novel);
  const index = new Map((novel.chapters || []).map((c, i) => [c.id, i]));
  return (ch) => {
    const at = index.get(ch.id);
    if (at === undefined) return null;
    const v = vols.find((x) => x.id === ids[at]);
    if (!v) return null;
    return { id: v.id, no: vols.indexOf(v) + 1, name: str(v.name), desc: str(v.desc) };
  };
}

/** 一个文字 run；size 是半磅（24 = 12pt） */
function run(text, { bold = false, size = 24, color = null, spacing = 0 } = {}) {
  return `<w:r><w:rPr>${FONT}${bold ? '<w:b/>' : ''}`
    + `${color ? `<w:color w:val="${color}"/>` : ''}`
    + `${spacing ? `<w:spacing w:val="${spacing}"/>` : ''}`
    + `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>`
    + `<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

/**
 * 一个段落。pPr 子元素按 OOXML 顺序排：pStyle / keepNext / pageBreakBefore /
 * spacing / ind / jc；顺序错了 Word 也可能能开，但严格的阅读器会挑刺。
 */
function para(inner, {
  style = null, align = null, before = 0, after = 0, line = 468,
  indent = 0, keepNext = false, pageBreak = false,
} = {}) {
  const pPr = [
    style ? `<w:pStyle w:val="${style}"/>` : '',
    keepNext ? '<w:keepNext/>' : '',
    pageBreak ? '<w:pageBreakBefore/>' : '',
    `<w:spacing w:before="${before}" w:after="${after}" w:line="${line}" w:lineRule="auto"/>`,
    `<w:ind w:firstLine="${indent}" w:firstLineChars="${indent ? 200 : 0}"/>`,
    align ? `<w:jc w:val="${align}"/>` : '',
  ].join('');
  return `<w:p><w:pPr>${pPr}</w:pPr>${inner || ''}</w:p>`;
}

function titlePage(novel, chapters, extras, words) {
  const genre = str(novel.genre);
  const author = str(novel.author);
  const contact = str(novel.meta?.contact);
  const logline = str(novel.meta?.logline);
  const out = [];
  out.push(para(run(genre || '长篇小说', { size: 20, color: MUTED, spacing: 30 }), {
    align: 'center', before: 3000, after: 800, line: 260,
  }));
  out.push(para(run(str(novel.title) || '未命名作品', { bold: true, size: 60, spacing: 20 }), {
    style: 'Title', align: 'center', after: 0, line: 360,
  }));
  if (author) {
    out.push(para(run(author, { size: 28, spacing: 20 }), {
      align: 'center', before: 560, line: 360,
    }));
  }
  if (contact) {
    out.push(para(run(contact, { size: 20, color: MUTED }), {
      align: 'center', before: 140, line: 300,
    }));
  }
  if (logline) {
    out.push(para(run(logline, { size: 22, color: '4A4B50' }), {
      align: 'center', before: 720, line: 360,
    }));
  }
  out.push(para(run(scopeLine(chapters, extras, words), { size: 20, color: FAINT }), {
    align: 'center', before: 900, line: 300,
  }));
  return out.join('\n');
}

function notePage(novel, bookWords) {
  const facts = submissionFacts(novel, bookWords);
  const note = submissionNote(novel);
  const out = [];
  out.push(para(run('创作说明', { bold: true, size: 32 }), {
    style: 'Heading1', align: 'center', pageBreak: true, after: 720, line: 360, keepNext: true,
  }));
  for (const f of facts) {
    out.push(para(
      run(f.label, { bold: true, size: 22, color: MUTED }) + run(`　${f.value}`, { size: 22 }),
      { align: 'left', after: 80, line: 360 },
    ));
  }
  if (note) {
    out.push(para(run('给编辑的话', { bold: true, size: 24 }), {
      align: 'left', before: 360, after: 180, line: 360, keepNext: true,
    }));
    for (const line of paragraphs(note)) {
      out.push(para(run(line), { align: 'both', indent: 480, line: 468 }));
    }
  }
  return out.join('\n');
}

function volumePage(v) {
  const out = [];
  out.push(para(run(volumeLabel(v, v.no), { bold: true, size: 36 }), {
    style: 'Heading2', align: 'center', pageBreak: true, before: 4500,
    after: v.desc ? 300 : 0, line: 360, keepNext: true,
  }));
  if (v.desc) {
    out.push(para(run(v.desc, { size: 22, color: MUTED }), {
      align: 'center', line: 360,
    }));
  }
  return out.join('\n');
}

function chapterPage(c) {
  const body = paragraphs(c.content);
  const out = [];
  out.push(para(run(chapterLabel(c), { bold: true, size: 34 }), {
    style: 'Heading1', align: 'center', pageBreak: true, after: 480, line: 360, keepNext: true,
  }));
  if (body.length) {
    for (const line of body) {
      out.push(para(run(line), { align: 'both', indent: 480, line: 468 }));
    }
  } else {
    out.push(para(run('（本章还没有正文）', { size: 22, color: '9A9BA1' }), {
      align: 'center', before: 480, line: 360,
    }));
  }
  return out.join('\n');
}

function contentTypesXml() {
  return `${XML_HEAD}
<Types xmlns="${NS_CT}">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
<Override PartName="/word/footer2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
}

function rootRels() {
  return `${XML_HEAD}
<Relationships xmlns="${NS_REL}">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function documentRels() {
  return `${XML_HEAD}
<Relationships xmlns="${NS_REL}">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer2.xml"/>
</Relationships>`;
}

function stylesXml() {
  return `${XML_HEAD}
<w:styles xmlns:w="${NS_W}">
<w:docDefaults>
<w:rPrDefault><w:rPr>${FONT}<w:color w:val="${INK}"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="468" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal">
<w:name w:val="Normal"/><w:qFormat/>
<w:pPr><w:widowControl/><w:spacing w:after="0" w:line="468" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr>
<w:rPr>${FONT}<w:color w:val="${INK}"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>
</w:style>
<w:style w:type="paragraph" w:styleId="Title">
<w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:spacing w:after="0" w:line="360" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>
<w:rPr><w:b/><w:color w:val="${INK}"/><w:sz w:val="60"/><w:szCs w:val="60"/></w:rPr>
</w:style>
<w:style w:type="paragraph" w:styleId="Heading1">
<w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
<w:pPr><w:keepNext/><w:spacing w:before="0" w:after="480" w:line="360" w:lineRule="auto"/><w:jc w:val="center"/><w:outlineLvl w:val="0"/></w:pPr>
<w:rPr><w:b/><w:color w:val="${INK}"/><w:sz w:val="34"/><w:szCs w:val="34"/></w:rPr>
</w:style>
<w:style w:type="paragraph" w:styleId="Heading2">
<w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
<w:pPr><w:keepNext/><w:spacing w:before="0" w:after="300" w:line="360" w:lineRule="auto"/><w:jc w:val="center"/><w:outlineLvl w:val="1"/></w:pPr>
<w:rPr><w:b/><w:color w:val="${INK}"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr>
</w:style>
</w:styles>`;
}

function footerXml(withPageNumber) {
  const pPr = '<w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>';
  if (!withPageNumber) {
    return `${XML_HEAD}
<w:ftr xmlns:w="${NS_W}"><w:p>${pPr}</w:p></w:ftr>`;
  }
  const rPr = `<w:rPr>${FONT}<w:color w:val="${FAINT}"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>`;
  return `${XML_HEAD}
<w:ftr xmlns:w="${NS_W}">
<w:p>${pPr}<w:fldSimple w:instr=" PAGE "><w:r>${rPr}<w:t>1</w:t></w:r></w:fldSimple></w:p>
</w:ftr>`;
}

function coreXml(novel) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const title = str(novel.title) || '未命名作品';
  const author = str(novel.author);
  const genre = str(novel.genre);
  const logline = str(novel.meta?.logline);
  return `${XML_HEAD}
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${esc(title)}</dc:title>
${author ? `<dc:creator>${esc(author)}</dc:creator>` : ''}
${genre ? `<dc:subject>${esc(genre)}</dc:subject>` : ''}
${logline ? `<dc:description>${esc(logline)}</dc:description>` : ''}
<cp:lastModifiedBy>书匠</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

function appXml() {
  return `${XML_HEAD}
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
<Application>书匠</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>
<LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged>
<AppVersion>1.0</AppVersion>
</Properties>`;
}

function documentXml(body) {
  return `${XML_HEAD}
<w:document xmlns:w="${NS_W}" xmlns:r="${NS_R}">
<w:body>
${body}
<w:sectPr>
<w:footerReference w:type="default" r:id="rId2"/>
<w:footerReference w:type="first" r:id="rId3"/>
<w:pgSz w:w="11906" w:h="16838"/>
<w:pgMar w:top="1247" w:right="1134" w:bottom="1247" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/>
<w:titlePg/>
</w:sectPr>
</w:body>
</w:document>`;
}

/**
 * 生成完整的 Word 文件 Buffer。
 * @param {object} novel 作品
 * @param {object[]} chapters 本次要导出的章节
 * @param {object} extras { range, onlyDone, single, note }
 * @returns {Buffer}
 */
export function buildDocx(novel, chapters = [], extras = {}) {
  const list = Array.isArray(chapters) ? chapters.filter(Boolean) : [];
  const words = list.reduce((sum, c) => sum + countWords(c.content), 0);
  // 「全书约 N 字」说的是整本，不是本次导出的那几章；没有附言就不用算
  const bookWords = extras.note
    ? (novel.chapters || []).reduce((sum, c) => sum + countWords(c.content), 0)
    : 0;
  const volOf = volumeOf(novel);

  const body = [titlePage(novel, list, extras, words)];
  if (extras.note) body.push(notePage(novel, bookWords));
  let lastVol = '';
  for (const c of list) {
    const v = volOf(c);
    if (v && v.id !== lastVol) body.push(volumePage(v));
    lastVol = v ? v.id : '';
    body.push(chapterPage(c));
  }

  const files = [
    { name: '[Content_Types].xml', data: contentTypesXml() },
    { name: '_rels/.rels', data: rootRels() },
    { name: 'docProps/core.xml', data: coreXml(novel) },
    { name: 'docProps/app.xml', data: appXml() },
    { name: 'word/document.xml', data: documentXml(body.join('\n')) },
    { name: 'word/_rels/document.xml.rels', data: documentRels() },
    { name: 'word/styles.xml', data: stylesXml() },
    { name: 'word/footer1.xml', data: footerXml(true) },
    { name: 'word/footer2.xml', data: footerXml(false) },
  ];
  return zip(files);
}
