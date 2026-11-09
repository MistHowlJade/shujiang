// 书匠 · 打印稿 / PDF
//
// 导出窗口选「打印稿 / PDF」时，把这次要导出的章节排成一份 A4 文档：
// 书名页、可选的创作说明、分卷页、每章另起一页，正文宋体 12pt、首行缩进两字。
// 浏览器打开后点「打印 / 存为 PDF」，在打印对话框里选「另存为 PDF」即可。
//
// 分页交给浏览器的打印引擎（CSS 的 break-before）。屏幕上看到的是连续的 A4 长卷，
// 真正分页以打印结果为准；不引第三方分页库，也不在服务端生成 PDF。
import { chapterVolumeIds, countWords, volumeLabel, chapterTitleText } from './store.js';
import { submissionFacts, submissionNote } from './manuscript.js';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const str = (v) => String(v ?? '').trim();
const num = (v) => Number(v || 0).toLocaleString('zh-CN');

/** 章节标题：没有标题就只写章号，别留一个尾巴 */
function chapterLabel(c) {
  const title = chapterTitleText(c?.title);
  return `第${c?.no}章${title ? ` ${title}` : ''}`;
}

/** 正文按行拆段：一行一段，空行丢掉；首行缩进交给 CSS，所以每行先 trim */
function paragraphs(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${esc(line)}</p>`)
    .join('\n');
}

/** 与 TXT / Markdown / EPUB 用同一套「章节 → 卷」规则 */
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

/** 书名页上那行小字：让人一眼看出这是全书、节选还是单章 */
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

function titlePage(novel, chapters, extras, words) {
  const genre = str(novel.genre);
  const author = str(novel.author);
  const contact = str(novel.meta?.contact);
  const logline = str(novel.meta?.logline);
  return `<section class="titlepage">
  <p class="tp-kicker">${esc(genre || '长篇小说')}</p>
  <h1>${esc(str(novel.title) || '未命名作品')}</h1>
  ${author ? `<p class="tp-author">${esc(author)}</p>` : ''}
  ${contact ? `<p class="tp-contact">${esc(contact)}</p>` : ''}
  ${logline ? `<p class="tp-logline">${esc(logline)}</p>` : ''}
  <p class="tp-meta">${esc(scopeLine(chapters, extras, words))}</p>
</section>`;
}

function notePage(novel, bookWords) {
  const facts = submissionFacts(novel, bookWords);
  const note = submissionNote(novel);
  return `<section class="note-page">
  <h2>创作说明</h2>
  <dl class="facts">
    ${facts.map((f) => `<div class="fact"><dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`).join('\n    ')}
  </dl>
  ${note ? `<h3>给编辑的话</h3>\n  ${paragraphs(note)}` : ''}
</section>`;
}

function volumePage(v) {
  return `<section class="volume">
  <h2>${esc(volumeLabel(v, v.no))}</h2>
  ${v.desc ? `<p class="vol-desc">${esc(v.desc)}</p>` : ''}
</section>`;
}

function chapterPage(c) {
  const body = paragraphs(c.content);
  return `<section class="chapter">
  <h2>${esc(chapterLabel(c))}</h2>
  ${body || '<p class="empty">（本章还没有正文）</p>'}
</section>`;
}

/* ---------------- 打印版式 ---------------- */

/** 可选纸张：屏幕上按同一尺寸预览，打印时交给 @page */
export const PRINT_PAGE_SIZES = {
  a4: {
    label: 'A4', width: '210mm', height: '297mm',
    marginY: '22mm', marginX: '20mm',
    titleScreen: '190mm', titlePrint: '210mm',
    volumeScreenMargin: '30mm', volumeScreenPad: '36mm', volumePrintPad: '80mm',
  },
  a5: {
    label: 'A5', width: '148mm', height: '210mm',
    marginY: '16mm', marginX: '14mm',
    titleScreen: '128mm', titlePrint: '140mm',
    volumeScreenMargin: '20mm', volumeScreenPad: '24mm', volumePrintPad: '52mm',
  },
};

export const PRINT_FONT_SIZES = [10.5, 12, 14];
export const PRINT_LEADINGS = [1.5, 1.95, 2.2];

/** 把 query / UI 传来的字符串收成合法版式；不认识的值一律退回默认 */
export function normalizePrintLayout(input = {}) {
  const key = String(input.size ?? input.paper ?? '').toLowerCase();
  const font = Number(input.font);
  const leading = Number(input.leading);
  return {
    size: PRINT_PAGE_SIZES[key] ? key : 'a4',
    font: PRINT_FONT_SIZES.includes(font) ? font : 12,
    leading: PRINT_LEADINGS.includes(leading) ? leading : 1.95,
    title: !(input.title === false || input.title === '0' || input.title === 0 || input.noTitle === true),
  };
}

/** 版式覆盖样式：接在基础 STYLE 后面，只改纸张 / 字号 / 行距 / 书名页 */
function layoutStyle(layout) {
  const page = PRINT_PAGE_SIZES[layout.size];
  return `
/* 版式：${page.label} · ${layout.font}pt · ${layout.leading} 行距 */
body { font-size: ${layout.font}pt; line-height: ${layout.leading}; }
.sheet {
  width: min(${page.width}, calc(100vw - 28px));
  min-height: ${page.height};
  padding: ${page.marginY} ${page.marginX};
}
.titlepage { min-height: ${page.titleScreen}; }
.volume { margin-top: ${page.volumeScreenMargin}; padding-top: ${page.volumeScreenPad}; }
@page { size: ${page.label}; margin: ${page.marginY} ${page.marginX}; }
@media print {
  .titlepage { min-height: ${page.titlePrint}; }
  .volume { padding-top: ${page.volumePrintPad}; }
}
${layout.title ? '' : `
/* 没有书名页时，第一章直接从页首开始，别留一条没有上文的装饰线 */
body.no-titlepage .sheet > .chapter:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
@page :first { @bottom-center { content: counter(page); } }`}
`;
}

const STYLE = `
:root {
  --ink: #17181b;
  --muted: #6f7076;
  --faint: #9a9ba1;
  --line: #e7e7ea;
  --paper: #ffffff;
  --desk: #ececef;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--desk);
  color: var(--ink);
  font-family: "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", "STSong", serif;
  font-size: 12pt;
  line-height: 1.95;
  -webkit-font-smoothing: antialiased;
}

/* 顶部工具栏：只在屏幕上出现，打印时藏起来 */
.bar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 20px;
  background: rgba(255, 255, 255, .88);
  -webkit-backdrop-filter: saturate(180%) blur(14px);
  backdrop-filter: saturate(180%) blur(14px);
  border-bottom: 1px solid var(--line);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 13px;
  line-height: 1.4;
}
.bar-main { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.bar-eyebrow { color: var(--faint); font-size: 11px; letter-spacing: .12em; white-space: nowrap; }
.bar-main strong {
  font-weight: 600;
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bar-meta { color: var(--muted); font-size: 12px; white-space: nowrap; }
.bar-actions { display: flex; align-items: center; gap: 16px; flex-shrink: 0; }
.bar-hint { color: var(--faint); font-size: 12px; }
.bar-actions button {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 15px;
  border: 0;
  border-radius: 999px;
  background: var(--ink);
  color: #fff;
  font: inherit;
  font-weight: 500;
  cursor: pointer;
  transition: background .15s ease;
}
.bar-actions button:hover { background: #000; }
.bar-actions button:focus-visible { outline: 2px solid #7aa7ff; outline-offset: 2px; }
.bar-actions a { color: var(--muted); text-decoration: none; font-size: 12px; }
.bar-actions a:hover { color: var(--ink); }

/* A4 纸：屏幕上是一张连续的长卷，打印时由 @page 接管页边距 */
.sheet {
  /* 窗口比 A4 窄时按窗口收一点，仍然是一张有页边距的纸；宽屏就是标准 210mm */
  width: min(210mm, calc(100vw - 28px));
  min-height: 297mm;
  margin: 26px auto 80px;
  padding: 22mm 20mm;
  background: var(--paper);
  box-shadow: 0 1px 2px rgba(0, 0, 0, .05), 0 20px 48px rgba(0, 0, 0, .12);
}
.sheet p { margin: 0; text-indent: 2em; }

/* 书名页 */
.titlepage {
  min-height: 190mm;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
}
.tp-kicker {
  margin: 0 0 14mm;
  text-indent: 0;
  color: var(--muted);
  font-size: .8em;
  letter-spacing: .38em;
}
.titlepage h1 {
  margin: 0;
  font-size: 2.45em;
  font-weight: 600;
  letter-spacing: .1em;
  line-height: 1.4;
}
.tp-author {
  margin: 10mm 0 0;
  text-indent: 0;
  font-size: 1.12em;
  letter-spacing: .22em;
}
.tp-contact {
  margin: 2.5mm 0 0;
  text-indent: 0;
  color: var(--muted);
  font-size: .82em;
  letter-spacing: .04em;
}
.tp-logline {
  max-width: 24em;
  margin: 13mm 0 0;
  text-indent: 0;
  color: #4a4b50;
  font-size: .93em;
  line-height: 1.95;
}
.tp-meta {
  margin: 16mm 0 0;
  text-indent: 0;
  color: var(--faint);
  font-size: .8em;
  letter-spacing: .04em;
}

/* 创作说明 */
.note-page { padding-top: 4mm; }
.note-page h2 {
  margin: 0 0 12mm;
  text-align: center;
  font-size: 1.35em;
  font-weight: 600;
  letter-spacing: .12em;
}
.note-page .facts { margin: 0 0 10mm; }
.note-page .fact {
  display: flex;
  gap: 10mm;
  margin: 0 0 2mm;
  font-size: .9em;
  line-height: 1.8;
}
.note-page .fact dt { flex: 0 0 5em; color: var(--muted); }
.note-page .fact dd { margin: 0; }
.note-page h3 { margin: 0 0 4mm; font-size: 1em; font-weight: 600; }

/* 分卷页 */
.volume {
  margin-top: 30mm;
  padding: 36mm 0 8mm;
  border-top: 1px solid var(--line);
  text-align: center;
}
.volume h2 {
  margin: 0;
  font-size: 1.5em;
  font-weight: 600;
  letter-spacing: .08em;
  line-height: 1.5;
}
.volume .vol-desc {
  max-width: 24em;
  margin: 5mm auto 0;
  text-indent: 0;
  color: var(--muted);
  font-size: .92em;
  line-height: 1.9;
}

/* 章节 */
.chapter {
  margin-top: 26mm;
  padding-top: 12mm;
  border-top: 1px solid var(--line);
}
.chapter h2 {
  margin: 0 0 10mm;
  text-align: center;
  font-size: 1.4em;
  font-weight: 600;
  letter-spacing: .03em;
  line-height: 1.5;
}
.chapter .empty {
  margin: 18mm 0 0;
  text-indent: 0;
  text-align: center;
  color: var(--faint);
}

/* 打印：每章另起一页，页边距交给 @page；分页由浏览器决定 */
@page { size: A4; margin: 22mm 20mm; }
@page { @bottom-center { content: counter(page); font-family: "Songti SC", "SimSun", serif; font-size: 9pt; color: #8a8a8f; } }
@page :first { @bottom-center { content: none; } }
@media print {
  html, body { background: #fff; }
  .bar { display: none !important; }
  .sheet {
    width: auto;
    min-height: 0;
    margin: 0;
    padding: 0;
    box-shadow: none;
  }
  /* 只在「下一块」上写 break-before：书名页 → 创作说明 → 卷页 → 章，
     每个分页点都只强制一次，免得相邻两条规则叠出空白页 */
  .titlepage { min-height: 210mm; }
  .note-page { padding-top: 0; page-break-before: always; break-before: page; }
  .volume {
    margin: 0;
    padding: 80mm 0 0;
    border: 0;
    page-break-before: always;
    break-before: page;
  }
  .chapter {
    margin: 0;
    padding: 0;
    border: 0;
    page-break-before: always;
    break-before: page;
  }
  .chapter h2 { page-break-after: avoid; break-after: avoid; }
  .chapter p { orphans: 3; widows: 3; }
}

/* 窗口不宽时先收起工具栏上的长提示，别把书名挤没 */
@media (max-width: 900px) {
  .bar-hint { display: none; }
}

@media (max-width: 640px) {
  .bar { position: static; flex-wrap: wrap; align-items: flex-start; }
  .bar-actions { width: 100%; justify-content: flex-end; }
  .bar-hint { display: none; }
  .sheet {
    width: 100%;
    min-height: 0;
    margin: 0;
    padding: 26px 22px 60px;
    box-shadow: none;
  }
  .titlepage { min-height: 0; padding: 40px 0 36px; }
  .chapter { margin-top: 28px; padding-top: 16px; }
  .volume { margin-top: 32px; padding: 32px 0 8px; }
}
`;

/**
 * 生成一份可直接打印的 A4 HTML。
 * @param {object} novel 作品
 * @param {object[]} chapters 本次要打印的章节
 * @param {object} extras { range, onlyDone, single, note, autoprint, layout }
 *   autoprint 为 true 时（PDF 导出）页面加载完自动弹出打印对话框
 *   layout 可指定纸张 / 字号 / 行距 / 是否含书名页，见 normalizePrintLayout
 * @returns {string} 完整 HTML 文档
 */
export function buildPrintHtml(novel, chapters = [], extras = {}) {
  const list = Array.isArray(chapters) ? chapters.filter(Boolean) : [];
  const autoprint = !!extras.autoprint;
  const layout = normalizePrintLayout(extras.layout || {});
  const page = PRINT_PAGE_SIZES[layout.size];
  const words = list.reduce((sum, c) => sum + countWords(c.content), 0);
  const bookWords = (novel.chapters || []).reduce((sum, c) => sum + countWords(c.content), 0);
  const volOf = volumeOf(novel);

  const body = [];
  let lastVol = '';
  for (const c of list) {
    const v = volOf(c);
    if (v && v.id !== lastVol) body.push(volumePage(v));
    lastVol = v ? v.id : '';
    body.push(chapterPage(c));
  }

  const title = str(novel.title) || '未命名作品';
  const meta = `${page.label} · ${layout.font}pt · ${layout.leading} 行距 · ${list.length} 章 · 约 ${num(words)} 字`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<title>《${esc(title)}》· ${autoprint ? 'PDF' : '打印稿'}</title>
<style>${STYLE}${layoutStyle(layout)}</style>
</head>
<body${layout.title ? '' : ' class="no-titlepage"'}>
<header class="bar">
  <div class="bar-main">
    <span class="bar-eyebrow">${autoprint ? 'PDF 导出' : '打印预览'}</span>
    <strong>《${esc(title)}》</strong>
    <span class="bar-meta">${esc(meta)}</span>
  </div>
  <div class="bar-actions">
    <span class="bar-hint">A4 · 每章另起一页 · ${autoprint ? '打印对话框里选「另存为 PDF」' : '打印时选「另存为 PDF」'}</span>
    <button id="printBtn" type="button" aria-label="打印或存为 PDF">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9V3h12v6"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/></svg>
      打印 / 存为 PDF
    </button>
    <a href="/">回到书匠</a>
  </div>
</header>
<main class="sheet">
${layout.title ? titlePage(novel, list, extras, words) : ''}
${extras.note ? notePage(novel, bookWords) : ''}
${body.join('\n')}
</main>
<script>
  (() => {
    const btn = document.getElementById('printBtn');
    if (btn) btn.addEventListener('click', () => window.print());
    // PDF 导出：排版稳定后自动弹打印框，少点一次；加 #noauto 可只看不打印
    const autoPrint = ${autoprint ? 'true' : 'false'};
    if (autoPrint && !location.hash.includes('noauto')) {
      window.addEventListener('load', () => setTimeout(() => window.print(), 300));
    }
  })();
</script>
</body>
</html>`;
}
