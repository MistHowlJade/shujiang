// Word（.docx）导入：只读 word/document.xml，把段落还原成纯文本。
//
// 这里不做排版还原，只做「能接着写」的正文提取：
// - 修订删除（w:del）的内容不导入，修订插入（w:ins）的内容保留
// - 批注、页眉页脚、脚注、图片不导入
// - 用段落样式 / outlineLvl 判断标题，默认跳过书名页和「创作说明」
// - 章节怎么切仍然交给 server.js 里现有的 parseManuscript
import { unzipEntry } from './zip.js';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const PARA_RE = /<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g;
const TEXT_RE = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:(tab|br|cr|noBreakHyphen|softHyphen)\b[^>]*\/>/gi;

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (all, code) => {
    const key = code.toLowerCase();
    if (key[0] === '#') {
      const n = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[key] ?? all;
  });
}

function cleanText(s) {
  return String(s)
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim();
}

function paragraphStyle(inner) {
  const pPr = (inner.match(/<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/i) || [])[1] || '';
  const style = (pPr.match(/<w:pStyle\b[^>]*\bw:val="([^"]*)"/i) || [])[1] || '';
  const outlineRaw = (pPr.match(/<w:outlineLvl\b[^>]*\bw:val="([^"]*)"/i) || [])[1];
  const outline = outlineRaw == null ? NaN : Number(outlineRaw);
  return { style, outline };
}

function headingLevel(style, outline) {
  const s = String(style || '').trim().toLowerCase();
  if (/^(title|subtitle|标题|副标题)$/i.test(s)) return 0;
  if (/^(heading|标题)\s*1$/i.test(s) || s === '1') return 1;
  if (/^(heading|标题)\s*2$/i.test(s) || s === '2') return 2;
  if (Number.isInteger(outline) && outline >= 0 && outline <= 8) {
    return Math.min(outline + 1, 6);
  }
  return 0;
}

function paragraphText(inner) {
  let out = '';
  let m;
  TEXT_RE.lastIndex = 0;
  while ((m = TEXT_RE.exec(inner))) {
    if (m[1] != null) out += decodeEntities(m[1]);
    else if (m[2] === 'tab') out += '\t';
    else if (m[2] === 'br' || m[2] === 'cr') out += '\n';
    else if (m[2] === 'noBreakHyphen') out += '\u2011';
    else if (m[2] === 'softHyphen') out += '\u00ad';
  }
  return cleanText(out);
}

function joinParagraphs(paras) {
  return paras.map((p) => p.text).filter((t) => t.trim()).join('\n\n');
}

function isCreationNote(text) {
  return /^创作说明[：:]?$/.test(String(text || '').replace(/[\s\u3000]/g, ''));
}

function isNoteSubheading(text) {
  const t = String(text || '').replace(/[\s\u3000]/g, '');
  return /^(篇幅|字数|字数统计|篇幅统计|进度|作品信息|基本信息|稿件信息|投稿信息|联系方式|联系信息|给编辑的话|附言|说明|作品简介)$/.test(t);
}

/**
 * 从 Word XML 里抽段落。返回段落文本、标题级别，以及修订标记数量。
 * @param {string} xml
 */
function parseParagraphs(xml) {
  const deleted = (xml.match(/<w:del\b/g) || []).length;
  const inserted = (xml.match(/<w:ins\b/g) || []).length;
  const body = xml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<w:del\b[\s\S]*?<\/w:del>/gi, '')
    .replace(/<w:moveFrom\b[\s\S]*?<\/w:moveFrom>/gi, '');

  const paras = [];
  let m;
  PARA_RE.lastIndex = 0;
  while ((m = PARA_RE.exec(body))) {
    const inner = m[1] || '';
    const { style, outline } = paragraphStyle(inner);
    paras.push({
      text: paragraphText(inner),
      level: headingLevel(style, outline),
    });
  }
  return { paras, deleted, inserted };
}

/**
 * 把段落拼成正文，并找出需要跳过的前置内容。
 * 第一个标题之前的内容（书名页等）默认算前置；如果第一个标题是「创作说明」，
 * 连同它下面的说明一起跳过，正文从下一个标题开始。
 */
function buildText(paras) {
  const firstHeading = paras.findIndex((p) => p.level > 0);
  if (firstHeading < 0) {
    return {
      text: joinParagraphs(paras),
      frontMatter: '',
      headings: 0,
      frontMatterHeadings: 0,
      paragraphs: paras.filter((p) => p.text.trim()).length,
    };
  }

  let start = firstHeading;
  while (start < paras.length && isCreationNote(paras[start].text)) {
    let next = start + 1;
    // 说明页里的已知小标题（篇幅、字数等）也算前置，遇到未知标题即停
    while (next < paras.length) {
      const p = paras[next];
      if (p.level > 0 && !isNoteSubheading(p.text)) break;
      next++;
    }
    if (next >= paras.length) break;
    start = next;
  }

  const front = paras.slice(0, start);
  const body = paras.slice(start);
  return {
    text: joinParagraphs(body),
    frontMatter: joinParagraphs(front),
    headings: body.filter((p) => p.level > 0).length,
    frontMatterHeadings: front.filter((p) => p.level > 0).length,
    paragraphs: body.filter((p) => p.text.trim()).length,
  };
}

/**
 * 解析 .docx，返回可交给 /api/novels/:id/import 的正文。
 * @param {Buffer} buf
 * @returns {{text: string, frontMatter: string, paragraphs: number, headings: number, frontMatterHeadings: number, deleted: number, inserted: number}}
 */
export function extractDocxText(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('文件是空的');
  const xml = unzipEntry(buf, 'word/document.xml').toString('utf8').replace(/^\uFEFF/, '');
  if (!/<w:document\b/i.test(xml)) throw new Error('不是 Word 正文（缺少 w:document）');

  const { paras, deleted, inserted } = parseParagraphs(xml);
  const built = buildText(paras);
  if (!built.text.trim()) throw new Error('Word 里没有可导入的正文');

  return {
    text: built.text,
    frontMatter: built.frontMatter,
    paragraphs: built.paragraphs,
    headings: built.headings,
    frontMatterHeadings: built.frontMatterHeadings,
    deleted,
    inserted,
  };
}
