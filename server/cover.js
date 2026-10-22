// EPUB 封面：按书名 / 作者 / 题材现画一张 SVG 封面；也负责存用户自己的封面图。
//
// 为什么自己画而不是让用户传图：导出物是唯一离开这个应用的东西，
// 书库里长什么样全靠这张封面；而写书的人不该被逼去找一张图。
//
// 为什么是 SVG 而不是 PNG：不用内嵌中文字体（阅读器用自己的字体渲染，
// 文件还小得多），EPUB 3 也允许 SVG 充当 cover-image。
//
// 版式沿用应用自己的审美：深色底、细边框、一根强调线、居中的字。
// 同一本书永远拿到同一套配色（按书名哈希选），换台电脑导出也是同一张。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';

const W = 1600;
const H = 2400;

// 六套深色底 + 暖白字 + 一个强调色。
// 刻意压低饱和度，避免花哨；都是能压住正文文字的深色。
const PALETTES = [
  { bg: ['#151821', '#23283a'], ink: '#e8e6df', accent: '#c9a86a' }, // 夜蓝 · 金
  { bg: ['#171512', '#282219'], ink: '#efe8da', accent: '#c99b56' }, // 暖褐 · 铜
  { bg: ['#131a18', '#1e2c27'], ink: '#e2ece6', accent: '#7fb39c' }, // 松绿 · 玉
  { bg: ['#1a1418', '#2c2028'], ink: '#efe2e6', accent: '#c5869a' }, // 酒红 · 玫
  { bg: ['#141416', '#212125'], ink: '#e6e6e8', accent: '#8e9cb8' }, // 石墨 · 钢蓝
  { bg: ['#1c1714', '#2b231c'], ink: '#f1e9dc', accent: '#d6b463' }, // 赭石 · 藤黄
];

// 封面用衬线中文，浏览器 / 阅读器都能找到近似字体
const FONT = "'Songti SC','SimSun','Noto Serif CJK SC','Source Han Serif SC','STSong',serif";

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** FNV-1a：稳定跨平台，用来按书名挑配色 */
function hashOf(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 估算一个字符占多宽（单位 em）。没有字体度量，只能近似，但够排版用。 */
function charWidth(ch) {
  if (isWide(ch)) return 1;
  if (ch === ' ') return 0.3;
  if ('iljI.,\'!|;:`'.includes(ch)) return 0.3;
  if (ch >= 'A' && ch <= 'Z') return 0.64;
  if (ch >= 'a' && ch <= 'z') return 0.53;
  if (ch >= '0' && ch <= '9') return 0.56;
  return 0.5;
}

// 不许出现在行首的标点（避头点）
const NO_START = '，。、；：？！）」』】》〉…—·,.!?;:)]}’”';

/** 是否是「宽字符」：汉字这类要自己单独成字，不能从中间断开 */
function isWide(ch) {
  const c = ch.codePointAt(0);
  return (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6)
  );
}

/**
 * 切成排版单元：宽字符各自成字，西文按单词整体保留（不然会断在词中间）。
 */
function tokenize(text) {
  const tokens = [];
  let word = '';
  const flushWord = () => {
    if (!word) return;
    tokens.push({ t: word, kind: 'word' });
    word = '';
  };
  for (const ch of text) {
    if (isWide(ch)) {
      flushWord();
      tokens.push({ t: ch, kind: 'wide' });
    } else if (ch === ' ') {
      flushWord();
      tokens.push({ t: ' ', kind: 'space' });
    } else {
      word += ch;
    }
  }
  flushWord();
  return tokens;
}

function wordWidth(word) {
  let w = 0;
  for (const ch of word) w += charWidth(ch);
  return w;
}

/** 一个词自己都放不下（长 URL 之类），只能硬切 */
function splitLongWord(word, maxUnits) {
  const parts = [];
  let cur = '';
  let w = 0;
  for (const ch of word) {
    const cw = charWidth(ch);
    if (w + cw > maxUnits && cur) {
      parts.push(cur);
      cur = '';
      w = 0;
    }
    cur += ch;
    w += cw;
  }
  if (cur) parts.push(cur);
  return parts;
}

/** 按可用宽度（em）折行：中文按字断，西文按词断 */
function wrapTitle(text, maxUnits) {
  const tokens = tokenize(text);
  const lines = [];
  let cur = '';
  let w = 0;
  const flush = () => {
    const t = cur.replace(/\s+$/, '');
    if (t) lines.push(t);
    cur = '';
    w = 0;
  };
  for (const tk of tokens) {
    if (tk.kind === 'space') {
      if (cur) {
        cur += ' ';
        w += 0.3;
      }
      continue;
    }
    const tw = tk.kind === 'wide' ? 1 : wordWidth(tk.t);
    if (tw > maxUnits) {
      flush();
      const parts = splitLongWord(tk.t, maxUnits);
      for (const p of parts.slice(0, -1)) lines.push(p);
      cur = parts[parts.length - 1];
      w = wordWidth(cur);
      continue;
    }
    if (cur && w + tw > maxUnits) {
      // 避头点：标点跟着上一行走，不另起一行
      if (tk.kind === 'wide' && NO_START.includes(tk.t)) {
        cur += tk.t;
        w += tw;
        continue;
      }
      flush();
    }
    cur += tk.t;
    w += tw;
  }
  flush();
  return lines.length ? lines : [''];
}

/**
 * 找一个塞得下标题的字号：从大到小试，先看行数（不超过 5 行）再看总高。
 * 找不到就用最小字号硬塞。
 */
function fitTitle(text, boxW, boxH, maxSize, minSize) {
  for (let size = maxSize; size >= minSize; size -= 4) {
    const lines = wrapTitle(text, boxW / size);
    if (lines.length > 5) continue;
    const lh = size * 1.32;
    if (lines.length * lh <= boxH) return { size, lines, lh };
  }
  const size = minSize;
  return { size, lines: wrapTitle(text, boxW / size).slice(0, 6), lh: size * 1.32 };
}

/** 千分位 / 万位，封面上的数字要一眼能读 */
function cnNumber(n) {
  if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)} 万`;
  return n.toLocaleString('zh-CN');
}

/**
 * 生成封面 SVG。
 * @param {object} novel 作品
 * @param {{words?: number, chapters?: number}} info 章节数与总字数
 */
export function coverSvg(novel = {}, info = {}) {
  const title = String(novel.title || '').trim() || '未命名作品';
  const author = String(novel.author || '').trim();
  const genre = String(novel.genre || '').trim();
  const words = Number(info.words) || 0;
  const chapters = Number(info.chapters) || 0;

  const pal = PALETTES[hashOf(title) % PALETTES.length];

  // 版面：外框 + 内发丝线，中间留出标题区
  const boxW = 980;
  const boxH = 900;
  const cy = 1130;
  const fit = fitTitle(title, boxW, boxH, 168, 58);

  // 标题整体垂直居中：首行基线 = 中心 - 上半 + 字高的一部分
  const firstBase = cy - ((fit.lines.length - 1) * fit.lh) / 2 + fit.size * 0.36;
  const titleText = fit.lines
    .map((ln, i) => `<text x="${W / 2}" y="${(firstBase + i * fit.lh).toFixed(1)}" text-anchor="middle" font-family="${FONT}" font-size="${fit.size}" fill="${pal.ink}" letter-spacing="${(fit.size * 0.02).toFixed(1)}">${esc(ln)}</text>`)
    .join('\n');

  const genreText = genre
    ? `<text x="${W / 2}" y="632" text-anchor="middle" font-family="${FONT}" font-size="44" fill="${pal.accent}" opacity="0.92" letter-spacing="18" dx="9">${esc(genre)}</text>`
    : '';

  const authorText = author
    ? `<text x="${W / 2}" y="1768" text-anchor="middle" font-family="${FONT}" font-size="56" fill="${pal.ink}" opacity="0.88">${esc(author)}</text>`
    : '';

  const footBits = [];
  if (chapters) footBits.push(`共 ${chapters} 章`);
  if (words) footBits.push(`约 ${cnNumber(words)} 字`);
  const footText = footBits.length
    ? `<text x="${W / 2}" y="2098" text-anchor="middle" font-family="${FONT}" font-size="34" fill="${pal.ink}" opacity="0.42" letter-spacing="3">${esc(footBits.join('  ·  '))}</text>`
    : '';

  return `<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="covertitle">
<title id="covertitle">${esc(title)}${author ? ` · ${esc(author)}` : ''}</title>
<defs>
<linearGradient id="cvg" x1="0" y1="0" x2="0.35" y2="1">
<stop offset="0" stop-color="${pal.bg[0]}"/>
<stop offset="1" stop-color="${pal.bg[1]}"/>
</linearGradient>
</defs>
<rect width="${W}" height="${H}" fill="url(#cvg)"/>
<rect x="150" y="150" width="${W - 300}" height="${H - 300}" fill="none" stroke="${pal.accent}" stroke-width="3" opacity="0.5"/>
<rect x="186" y="186" width="${W - 372}" height="${H - 372}" fill="none" stroke="${pal.ink}" stroke-width="1" opacity="0.12"/>
<line x1="${W / 2 - 60}" y1="516" x2="${W / 2 + 60}" y2="516" stroke="${pal.accent}" stroke-width="3" opacity="0.75"/>
${genreText}
${titleText}
<line x1="${W / 2 - 70}" y1="1610" x2="${W / 2 + 70}" y2="1610" stroke="${pal.accent}" stroke-width="2" opacity="0.55"/>
${authorText}
${footText}
</svg>
`;
}

/* ---------------- 用户自己的封面图 ---------------- */

export const COVER_DIR = path.join(DATA_DIR, 'covers');

// 只收 EPUB 规范里的核心图片格式。
// 不收 SVG —— SVG 里能塞脚本，预览时会在浏览器里执行，不安全。
const RASTER = {
  'image/png': { ext: 'png', media: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  'image/jpeg': { ext: 'jpg', media: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  'image/gif': { ext: 'gif', media: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38] },
};

const MAX_COVER_BYTES = 8 * 1024 * 1024;

function validId(id) {
  return /^n_[a-z0-9]{6,}$/.test(String(id || ''));
}

function coverPath(id, ext) {
  return path.join(COVER_DIR, `${id}.${ext}`);
}

/** 存一张自定义封面；校验通过才落盘，返回写进作品记录的说明 */
export function saveCoverImage(id, buf, mime) {
  if (!validId(id)) throw new Error('作品不存在');
  const kind = RASTER[String(mime || '').toLowerCase().split(';')[0].trim()];
  if (!kind) throw new Error('只支持 PNG / JPG / GIF 图片');
  if (!buf || !buf.length) throw new Error('图片是空的');
  if (buf.length > MAX_COVER_BYTES) throw new Error('图片太大了（上限 8 MB）');
  // 看文件头是不是真的这种格式，不能只信 Content-Type
  const head = buf.subarray(0, kind.magic.length);
  if (!kind.magic.every((byte, i) => head[i] === byte)) {
    throw new Error('这不像是一个有效的图片文件');
  }
  fs.mkdirSync(COVER_DIR, { recursive: true });
  // 换了格式就把旧的那张删掉，别留下两份
  for (const one of Object.values(RASTER)) {
    fs.rmSync(coverPath(id, one.ext), { force: true });
  }
  fs.writeFileSync(coverPath(id, kind.ext), buf);
  return { ext: kind.ext, mime: kind.media, size: buf.length, ts: Date.now() };
}

/** 读自定义封面；没有就返回 null（导出时退回自动生成的 SVG） */
export function readCoverImage(novel) {
  const meta = novel?.cover;
  if (!meta || !meta.ext) return null;
  if (!validId(novel.id)) return null;
  const file = coverPath(novel.id, meta.ext);
  try {
    if (!fs.existsSync(file)) return null;
    const kind = Object.values(RASTER).find((k) => k.ext === meta.ext);
    return {
      data: fs.readFileSync(file),
      ext: meta.ext,
      mime: meta.mime || kind?.media || 'application/octet-stream',
    };
  } catch {
    return null;
  }
}

/** 删掉自定义封面（之后导出又回到自动生成） */
export function deleteCoverImage(id, meta) {
  if (!validId(id)) return;
  const exts = meta?.ext ? [meta.ext] : Object.values(RASTER).map((k) => k.ext);
  for (const ext of exts) fs.rmSync(coverPath(id, ext), { force: true });
}

/** 给前端看的一句话说明 */
export function coverLabel(novel) {
  const meta = novel?.cover;
  if (!meta || !meta.ext) return '自动生成';
  return `自定义（${meta.ext.toUpperCase()}）`;
}
