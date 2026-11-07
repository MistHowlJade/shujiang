/* 书匠 · 前端逻辑（原生 ES 模块，无构建步骤） */

import { $, $$, esc, ico, debounce, toast, countWords, createWordCounter, fmtWords, fmtDate, fmtAgo, uid } from './lib/util.js';
import { THREAD_KINDS, memoryItems, revisionsOf, openRevisionCount, splitMemoryCharacters, normalizeCharacterName, buildCharacterAppearances, appearancesForCharacter, collectThreads, threadSearchText, buildMentionIndex, worldMentionChapters, worldMentionKeys, entryStateChanges, filterEntriesBySearch, collectCharacterNodes, findCharacterByMention, buildTimelineEvents, timelineEventSearchText, filterOutlineVolumes, chapterMatchesSearch, chapterBoardMatchesSearch, buildChapterPaletteEntries, buildReaderToc, readerTocGroupKey, defaultReaderTocClosed, normalizeReaderProgress, readerPositionOf, readerChapterRead, readerPercentOf, readerBookPercent, readerChapterLabel, buildContinueReadingEntries, mergeReaderProgress, editorPositionOf, mergeEditorPosition, NOVEL_TAG_LIMIT, parseNovelTags, toggleSearchTerm, shelfTagView, normalizeMentionText, novelSearchText, filterChaptersBySearch, stepSearchCursor, filterNovelsBySearch, sortNovels, SHELF_SORT_OPTIONS, SNAP_KINDS, filterSnapshotsBySearch, filterTrashBySearch, buildCharacterArcs, arcSearchText, searchRelationGraph } from './lib/data.js';
import { BIBLE_TRASH_LIMIT, filterBibleTrash, addBibleTrashRecord, insertBibleTrashItem, hasBibleTrashItem } from './lib/trash.js';
import { PROOF_KINDS, PROOF_MAX_CHAPTER_ISSUES, PROOF_PAGE, proofText, proofParagraphs, proofSnippet, proofIssue, scanProofChapter, buildProofReport, proofSnippetHtml } from './lib/proof.js';
import { buildHealthReport, applyHealthIgnored, healthKey, healthChip, healthOk, healthMarkdown, copyHealthReport } from './lib/health.js';
import { scanConsistency, applyConsistencyIgnored, consistencyKey, consistencyMarkdown, CONSISTENCY_KINDS } from './lib/consistency.js';
import { diffProse, diffHtml, diffSideHtml } from './lib/diff.js';
import { bookGoalOf, fmtGoal, finishEstimate, daysPhrase, datePhrase, goalPanelHtml } from './lib/goal.js';
import { buildSubmitCheck, submitCheckHtml } from './lib/submit.js';
import { PAPER_DEFAULTS, normalizePaper, nextPaperSize, paperVars, paperLabel } from './lib/paper.js';
import { importBibleMarkdown } from './lib/markdown.js';

/* 阅读进度只存在本浏览器，不写作品 JSON，也不走服务端 */
const READER_PROGRESS_KEY = 'shu.reader.progress.v1';
const READER_SIZE_KEY = 'shu.reader.size.v1';
const SHELF_SORT_KEY = 'shu.shelf.sort.v1';
/** 已经展开全部标签的书架卡片（作品 id）；只在本次页面会话里记，不改磁盘。 */
const expandedShelfTags = new Set();
const EDITOR_POS_KEY = 'shu.editor.pos.v1';

/* 章节字数缓存：切章 / 改状态 / 刷进度时不再反复重扫全书 */
const wordsOf = createWordCounter();

function readerProgressMap() {
  try {
    const raw = localStorage.getItem(READER_PROGRESS_KEY);
    const map = raw ? JSON.parse(raw) : {};
    return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  } catch {
    return {};
  }
}

function getReaderProgress(novelId) {
  if (!novelId) return null;
  return normalizeReaderProgress(readerProgressMap()[novelId]);
}

function saveReaderProgress(novelId, data) {
  if (!novelId || !data?.chapterId) return;
  try {
    const map = readerProgressMap();
    const next = mergeReaderProgress(map[novelId], data);
    if (!next) return;
    map[novelId] = next;
    localStorage.setItem(READER_PROGRESS_KEY, JSON.stringify(map));
  } catch {}
}

function clearReaderProgress(novelId) {
  if (!novelId) return;
  try {
    const map = readerProgressMap();
    if (!(novelId in map)) return;
    delete map[novelId];
    if (Object.keys(map).length) localStorage.setItem(READER_PROGRESS_KEY, JSON.stringify(map));
    else localStorage.removeItem(READER_PROGRESS_KEY);
  } catch {}
}

/* 写作位置：切章前把上一章的光标和滚动比例收起来，切回来再放回去 */
const EDITOR_TRACK = { novelId: '', chapterId: '' };

function editorPosMap() {
  try {
    const raw = localStorage.getItem(EDITOR_POS_KEY);
    const map = raw ? JSON.parse(raw) : {};
    return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  } catch {
    return {};
  }
}

function getEditorPosition(novelId, chapterId) {
  return editorPositionOf(editorPosMap(), novelId, chapterId);
}

/** 当前编辑器（或刚切走的那一章）的写作位置；滚动按比例存，换字号 / 窗口宽度后也不至于偏太远 */
function rememberEditorPosition() {
  const ta = $('#chContent');
  if (!ta || !EDITOR_TRACK.novelId || !EDITOR_TRACK.chapterId) return;
  const max = ta.scrollHeight - ta.clientHeight;
  saveEditorPosition(EDITOR_TRACK.novelId, EDITOR_TRACK.chapterId, {
    s: ta.selectionStart ?? 0,
    e: ta.selectionEnd ?? 0,
    ratio: max > 0 ? ta.scrollTop / max : 0,
  });
}

function saveEditorPosition(novelId, chapterId, data) {
  if (!novelId || !chapterId) return;
  try {
    const next = mergeEditorPosition(editorPosMap(), novelId, chapterId, data);
    localStorage.setItem(EDITOR_POS_KEY, JSON.stringify(next));
  } catch {}
}

/** 切回一章时恢复光标和滚动；没记过就回到开头，避免沿用上一章的滚动位置 */
function restoreEditorPosition(novelId, chapterId, ta) {
  const pos = getEditorPosition(novelId, chapterId);
  if (!pos) {
    ta.scrollTop = 0;
    try { ta.setSelectionRange(0, 0); } catch { /* 忽略 */ }
    return;
  }
  const len = ta.value.length;
  const s = Math.min(pos.s, len);
  const e = Math.min(pos.e, len);
  try { ta.setSelectionRange(s, e); } catch { /* 忽略 */ }
  const max = ta.scrollHeight - ta.clientHeight;
  ta.scrollTop = max > 0 ? max * pos.ratio : 0;
}

function readerFontSize() {
  try {
    const n = Math.round(Number(localStorage.getItem(READER_SIZE_KEY)));
    return n >= 15 && n <= 24 ? n : 18;
  } catch {
    return 18;
  }
}

function saveReaderFontSize(size) {
  try { localStorage.setItem(READER_SIZE_KEY, String(size)); } catch {}
}

/** 书架排序偏好：存坏了 / 旧版本留下的键都回落到「最近更新」 */
function shelfSortPreference() {
  try {
    const saved = localStorage.getItem(SHELF_SORT_KEY);
    return SHELF_SORT_OPTIONS.some((option) => option.key === saved) ? saved : 'updated';
  } catch {
    return 'updated';
  }
}

/** 极简 Markdown 渲染（标题 / 加粗 / 列表 / 行内代码），全部转义后拼装，安全 */
function mdLite(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  let inList = false;
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    const li = line.match(/^\s*([-*·]|\d+[.、])\s+(.*)$/);
    if (inList && !li) { out.push('</ul>'); inList = false; }
    if (h) { out.push(`<div class="md-h" style="margin-left:${(h[1].length - 1) * 8}px">${inline(h[2])}</div>`); continue; }
    if (li) { if (!inList) { out.push('<ul>'); inList = true; } out.push(`<li>${inline(li[2])}</li>`); continue; }
    if (!line.trim()) { out.push('<div style="height:6px"></div>'); continue; }
    out.push(`<div>${inline(line)}</div>`);
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

function showModal(html, onMount, opts = {}) {
  const mask = $('#modalMask');
  const box = $('#modal');
  box.classList.toggle('modal-wide', !!opts.wide);
  box.innerHTML = html;
  // 弹窗是同一个容器复用的，不重置的话新弹窗会沿用上一个的滚动位置
  box.scrollTop = 0;
  // 关掉弹窗时能回调一次（模型对比要用它停掉还在跑的流）
  box._onClose = opts.onClose || null;
  mask.hidden = false;
  onMount?.(box);
  return box;
}
function closeModal() {
  const box = $('#modal');
  const fn = box._onClose;
  box._onClose = null;
  try { fn?.(); } catch (err) { console.warn('[modal] onClose 出错', err); }
  $('#modalMask').hidden = true;
  box.innerHTML = '';
}
$('#modalMask').addEventListener('mousedown', (e) => {
  if (e.target.id === 'modalMask' && !S.batchController) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (e.defaultPrevented) return;   // 输入框里的 Esc 已经处理过（例如关命令面板），别再往下退专注
  // 弹窗、命令面板、阅读器、浮层和选中工具条优先处理 Esc，避免误退出专注模式
  if (!$('#modalMask').hidden && !S.batchController) { closeModal(); return; }
  if (S.batchController) return;
  if (studioPane) { closeStudioPane({ returnFocus: true }); return; }
  if ($('#cmdkMask') && !$('#cmdkMask').hidden) return;
  if ($('#readerMask')) return;
  if (document.querySelector('.popmenu')) return;
  if ($('#selToolbar') && !$('#selToolbar').hidden) return;
  if (S.focusMode) exitFocus();
});

/* ============================================================
 * 1. 接口封装
 * ============================================================ */
const api = {
  async get(url) {
    const r = await fetch(url);
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  },
  async send(url, body, method = 'POST') {
    // 只有确实要发数据时才带 body 与 Content-Type。
    // DELETE 带 body 而服务端不读时，连接会被重置（表现为 200 + 空响应 或 Failed to fetch）。
    const opt = { method };
    if (body !== undefined) {
      opt.headers = { 'Content-Type': 'application/json' };
      opt.body = JSON.stringify(body);
    }
    let r;
    try {
      r = await fetch(url, opt);
    } catch {
      // 连不上本地服务（进程没了 / 端口被占）：给一句人话，别把 Failed to fetch 甩给用户
      throw new Error('连不上本地服务（请确认 启动.bat 的窗口还开着）');
    }
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  },
  put(url, body) { return this.send(url, body, 'PUT'); },
  del(url) { return this.send(url, undefined, 'DELETE'); },
  /** 上传二进制（封面图）：不走 JSON，原样把字节发过去 */
  async upload(url, blob) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  },
};

/** 流式生成：逐块回调，返回完整文本 */
async function streamAI(body, { onDelta, onReasoning, onMeta, signal } = {}) {
  // 注入自定义提示词模板
  const cfg = S.config;
  if (cfg?.promptTemplates) {
    body = { ...body, customTemplates: cfg.promptTemplates };
  }
  let res;
  try {
    res = await fetch('/api/ai/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new Error('连不上本地服务（请确认 启动.bat 的窗口还开着）');
  }
  if (!res.ok || !res.body) {
    const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(j.error || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t || !t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let j;
      try { j = JSON.parse(payload); } catch { continue; }
      if (j.shu_meta) { onMeta?.(j.shu_meta); continue; }
      if (j.shu_error) throw new Error(j.shu_error);
      if (j.error) throw new Error(j.error.message || j.error.code || '模型返回错误');
      const d = j.choices?.[0]?.delta || {};
      const think = d.reasoning_content ?? d.reasoning;
      if (think) onReasoning?.(textOf(think));
      const text = textOf(d.content);
      if (text) { full += text; onDelta?.(text); }
    }
  }
  return full;
}

/** 上游 content 可能是字符串，也可能是 [{type:'text',text:'…'}] */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((p) => (typeof p === 'string' ? p : (p && (p.text || p.content)) || '')).join('');
  if (v && typeof v === 'object' && typeof v.text === 'string') return v.text;
  return '';
}

function parseJsonLoose(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const s = t.search(/[[{]/);
  if (s < 0) return null;
  const e = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
  if (e < 0) return null;
  const body = t.slice(s, e + 1);
  try { return JSON.parse(body); } catch { /* 去掉尾逗号再试 */ }
  try { return JSON.parse(body.replace(/,\s*([}\]])/g, '$1')); } catch { return null; }
}

/* ============================================================
 * 2. 全局状态
 * ============================================================ */
const S = {
  view: 'shelf',
  novels: [],
  novel: null,
  chapterId: null,
  config: null,
  dirty: false,
  stats: null,
  statsAt: 0,
  shelfSort: shelfSortPreference(),   // 书架排序：最近更新 / 最近阅读 / 最近创建 / 书名 / 字数
  unsaved: new Set(),   // 还没写进磁盘的章节 id —— 按章追踪，切章后也不会忘
  savingId: null,
  saveErr: null,
  controller: null,
  batchController: null,   // 批量补记忆：跑的时候不许关弹窗，也不许再起别的 AI 任务
  stageFilter: '',         // 章节列表筛选：'' / 'open' / 'draft' / 'revising' / 'done'
  chapterSearch: '',       // 章节列表搜索词：标题 / 章号
  chapterCursor: '',       // 章节搜索的键盘光标：当前高亮结果的章节 id
  focusMode: false,        // 专注写作模式：只留稿纸
  threadFilter: 'all',     // 线索页筛选：all / unresolved / foreshadowing
  bibleSearch: { outline: '', characters: '', world: '', timeline: '', threads: '', arcs: '', relations: '', timelineViz: '' }, // 设定库搜索词，按页签分别记住
  revisionDraftChapterId: null, // 修订输入框里未提交的草稿属于哪一章
  out: '',
  outTask: '',      // 输出区这份内容属于哪个任务：只有正文类任务才显示「写进正文」
  reasoning: '',
  lastOp: null,
  styleDraft: '',
  promptPreview: null,
  // 虚拟滚动状态（章节列表）
  vl: {
    enabled: false,
    itemHeight: 34,       // 章节行预估高度（px），首次渲染后实测修正
    headHeight: 30,       // 卷标题行高度（px），与 .vol-row-head 的 CSS 高度一致
    buffer: 5,            // 可视区上下各多渲染几行
    firstIdx: 0,          // 当前渲染的第一行索引
    lastIdx: -1,          // 当前渲染的最后一行索引
    total: 0,             // 总行数
    rows: [],             // 当前显示的行数据 [{ kind, c, i, group }]
    offsets: [0],         // 每行顶部位置的前缀和（卷标题与章节行高度不同）
    totalHeight: 0,       // 所有行的总高度
    scrollHandler: null,  // 滚动监听器引用
    measureDone: false,   // 是否已实测章节行高
  },
  // 虚拟滚动状态（设定库列表：人物、世界观、时间线、线索、弧光、关系等）
  // 每个列表独立维护虚拟滚动状态，通过 listKey 区分
  bibleVl: {
    lists: {},            // listKey -> { enabled, itemHeight, buffer, firstIdx, lastIdx, total, items, renderItem, listEl, scrollHandler, measureDone }
    // 兼容旧代码：当前激活的列表（用于旧版单列表模式）
    currentKey: null,
    get current() { return this.lists[this.currentKey] || { enabled: false }; },
    set current(v) { if (this.currentKey) this.lists[this.currentKey] = v; },
  },
  // 虚拟滚动状态（章节看板：每列独立）
  kbVl: {
    enabled: false,
    itemHeight: 80,       // 卡片预估高度（px），首次渲染后实测修正
    buffer: 3,            // 可视区上下各多渲染几张卡片
    cols: {},             // stage -> { firstIdx, lastIdx, total, rows, offsets, totalHeight, scrollHandler, measureDone }
  },
};

function setSave(flag, text) {
  const pill = $('#savePill');
  pill.className = `save-pill ${flag || ''}`;
  pill.textContent = text || (flag === 'dirty' ? '未保存' : flag === 'saving' ? '保存中…' : '已保存');
}

/** 保存状态只有一个来源：S.unsaved（哪些章还没落盘）+ S.saveErr。界面从这里推导出来 */
function refreshSavePill() {
  const pill = $('#savePill');
  const n = S.unsaved.size;
  if (n) {
    if (S.saveErr) setSave('dirty', n > 1 ? `保存失败 · ${n} 章待存` : '保存失败 · 重试中');
    else if (S.savingId) setSave('saving');
    else setSave('dirty', n > 1 ? `${n} 章待保存` : '未保存');
  } else {
    setSave('');
  }
  if (pill) {
    pill.title = n
      ? (S.saveErr ? `最近一次保存失败：${S.saveErr}\n点击立即重试` : '点击立即保存')
      : '正文已写入 data/ 目录';
    pill.style.cursor = n ? 'pointer' : '';
  }
}

/* ============================================================
 * 3. 视图
 * ============================================================ */
/* ============================================================
 * 窄窗口：工作台左右栏收成抽屉
 * ============================================================
 * 900 多像素以下一次看不下三栏，但直接 display:none 会让「章节」
 * 和「AI 助手」完全消失。这里保留入口：底部两个按钮打开抽屉，
 * 点遮罩 / 再点按钮 / Esc 关闭。 */
const NARROW_QUERY = window.matchMedia('(max-width: 920px)');
const studioToggleEls = {
  chapters: $('#narrowChaptersBtn'),
  assist: $('#narrowAssistBtn'),
};
let studioPane = '';   // '' | 'chapters' | 'assist'

function syncStudioPaneUI() {
  const studio = $('.studio');
  if (!studio) return;
  studio.classList.toggle('show-chapters', studioPane === 'chapters');
  studio.classList.toggle('show-assist', studioPane === 'assist');
  const backdrop = $('#studioBackdrop');
  if (backdrop) backdrop.hidden = !studioPane;
  for (const [key, btn] of Object.entries(studioToggleEls)) {
    btn?.setAttribute('aria-expanded', String(studioPane === key));
  }
}

function openStudioPane(which) {
  studioPane = which;
  syncStudioPaneUI();
  if (which === 'chapters') $('#chapterSearch')?.focus({ preventScroll: true });
  else $('#assistTabs .on, #assistTabs button')?.focus({ preventScroll: true });
}

function closeStudioPane({ returnFocus = false } = {}) {
  if (!studioPane) return;
  const which = studioPane;
  studioPane = '';
  syncStudioPaneUI();
  if (returnFocus) studioToggleEls[which]?.focus({ preventScroll: true });
}

function toggleStudioPane(which) {
  if (studioPane === which) closeStudioPane({ returnFocus: true });
  else openStudioPane(which);
}

$('#narrowChaptersBtn')?.addEventListener('click', () => toggleStudioPane('chapters'));
$('#narrowAssistBtn')?.addEventListener('click', () => toggleStudioPane('assist'));
$('#studioBackdrop')?.addEventListener('click', () => closeStudioPane({ returnFocus: true }));
NARROW_QUERY.addEventListener?.('change', (e) => { if (!e.matches) closeStudioPane(); });

function setView(v) {
  if (v !== 'studio' && S.focusMode) exitFocus();
  closeStudioPane();
  S.view = v;
  $$('.view').forEach((el) => el.classList.toggle('on', el.id === `view-${v}`));
  $$('#topnav .tab').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  if (v === 'studio') renderStudio();
  if (v === 'bible') { renderBible(); loadStats(); }
  if (v === 'shelf') { renderShelf(); loadStats(); }
  if (v === 'settings') renderSettings();
}
$$('#topnav .tab').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
$('#brandHome').addEventListener('click', () => setView('shelf'));

function renderThemeIcon() {
  const dark = document.body.dataset.theme === 'dark';
  $('#themeBtn').innerHTML = ico(dark ? 'sun' : 'moon');
  $('#themeBtn').title = dark ? '切换到浅色主题' : '切换到深色主题';
}
$('#themeBtn').addEventListener('click', () => {
  const next = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
  document.body.dataset.theme = next;
  renderThemeIcon();
  api.send('/api/config', { ui: { theme: next } }).catch(() => {});
});

/* ============================================================
 * 4. 书架
 * ============================================================ */
async function loadNovels() {
  const { novels } = await api.get('/api/novels');
  S.novels = novels;
  return novels;
}

const COVERS = [
  'linear-gradient(90deg,#5b8cff,#8a6bff)',
  'linear-gradient(90deg,#00c2a8,#4ad9a0)',
  'linear-gradient(90deg,#ff8a65,#ff5e7e)',
  'linear-gradient(90deg,#f0b429,#f97316)',
  'linear-gradient(90deg,#8a6bff,#d16bff)',
  'linear-gradient(90deg,#2f9ee0,#5b8cff)',
  'linear-gradient(90deg,#ef6d8a,#f0b429)',
];
function coverOf(title) {
  let h = 0;
  for (const ch of String(title || 'x')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return COVERS[h % COVERS.length];
}

/**
 * 全书目标：设了就报进度，没设返回 null。
 * 书架卡片拿的是列表数据（words + targetWords），工作台拿的是完整作品（meta + chapters），两种都认。
 */
function renderShelf() {
  const input = $('#shelfSearch');
  const q = (input.value || '').trim();
  const storedProgress = readerProgressMap();
  const progressById = new Map((S.novels || []).map((n) => [n.id, normalizeReaderProgress(storedProgress[n.id])]));
  const readAt = {};
  progressById.forEach((prog, id) => { if (prog?.updatedAt > 0) readAt[id] = prog.updatedAt; });
  const list = sortNovels(filterNovelsBySearch(S.novels, q), S.shelfSort, { readAt });
  const sortOption = SHELF_SORT_OPTIONS.find((option) => option.key === S.shelfSort) || SHELF_SORT_OPTIONS[0];
  const sortBtn = $('#shelfSortBtn');
  if (sortBtn) {
    sortBtn.disabled = S.novels.length < 2;
    sortBtn.title = `书架排序：${sortOption.label}`;
    const label = $('#shelfSortLabel');
    if (label) label.textContent = sortOption.label;
  }
  $('#shelfSearchClear').hidden = !q;
  const grid = $('#shelfGrid');
  grid.innerHTML = '';
  const totalWords = list.reduce((s, n) => s + (n.words || 0), 0);
  if (q) {
    $('#shelfSub').textContent = list.length
      ? `找到 ${list.length} / ${S.novels.length} 部作品 · ${fmtWords(totalWords)} 字 · 全部保存在本机`
      : `没有找到匹配「${q}」的作品 · 共 ${S.novels.length} 部`;
  } else {
    $('#shelfSub').textContent = S.novels.length
      ? `共 ${S.novels.length} 部作品 · ${fmtWords(totalWords)} 字 · 全部保存在本机`
      : '所有作品都保存在本机，不上传云端';
  }
  $('#shelfEmpty').hidden = S.novels.length > 0;

  for (const n of list) {
    const prog = progressById.get(n.id);
    const hasProgress = !!prog;
    const goal = bookGoalOf(n);
    const est = finishEstimate(goal, S.stats);
    const estText = goal
      ? (goal.done
        ? ' · 已达成目标'
        : est?.days
          ? ` · 还差 ${fmtWords(goal.left)} 字 · 按日均 ${fmtWords(est.rate)} 字算${daysPhrase(est.days)}，预计 ${datePhrase(est.date)}完稿`
          : ` · 还差 ${fmtWords(goal.left)} 字`)
      : '';
    const tags = parseNovelTags(n.tags);
    const qKeys = new Set(q ? q.split(/\s+/).map(normalizeMentionText).filter(Boolean) : []);
    const tagView = shelfTagView(tags, expandedShelfTags.has(n.id));
    const tagHtml = tagView.shown.map((tag) => {
      const on = qKeys.has(normalizeMentionText(tag));
      return `<button type="button" class="tag bk-tag${on ? ' tag-info' : ''}" data-tag="${esc(tag)}" aria-pressed="${on}" title="${on ? '取消筛选' : '按标签筛选'}：${esc(tag)}">${esc(tag)}</button>`;
    }).join('');
    const moreTitle = tagView.expanded
      ? '收起多余标签'
      : `展开其余 ${tagView.more} 个标签：${tagView.hidden.join('，')}`;
    const moreHtml = tagView.canToggle
      ? `<button type="button" class="bk-tag-more" aria-expanded="${tagView.expanded}" title="${esc(moreTitle)}">${tagView.expanded ? '收起' : `+${tagView.more}`}</button>`
      : '';
    const readPct = hasProgress ? readerBookPercent(prog, n.chapterCount) : null;
    const readName = hasProgress ? readerChapterLabel(prog) : '';
    const readTitle = hasProgress
      ? `继续阅读：${readName}${readPct === null ? '' : ` · 全书约 ${readPct}%`}${prog.updatedAt ? ` · ${fmtAgo(prog.updatedAt)}` : ''}`
      : '';
    const div = document.createElement('div');
    div.className = 'book';
    div.dataset.id = n.id;
    div.style.setProperty('--cover', coverOf(n.title));
    div.innerHTML = `
      <h3><button type="button" class="bk-open" title="打开《${esc(n.title)}》">${esc(n.title)}</button></h3>
      <div class="bk-genre"><span class="bk-genre-name">${esc(n.genre || '未分类')}</span>${tagHtml}${moreHtml}</div>
      <div class="bk-desc">${esc(n.logline || '还没有写简介')}</div>
      ${hasProgress ? `<button type="button" class="bk-reading" title="${esc(readTitle)}" aria-label="${esc(readTitle)}">
        <span class="bk-reading-label">${ico('book-open')}继续阅读</span>
        <span class="bk-reading-meta">第 ${prog.chapterNo} 章${readPct === null ? '' : ` · ${readPct}%`}</span>
        ${readPct === null ? '' : `<span class="bk-reading-bar" aria-hidden="true"><i style="width:${readPct}%"></i></span>`}
      </button>` : ''}
      <div class="bk-line">
        <span>${n.chapterCount} 章 · ${fmtWords(n.words)} 字${todayOf(n.id) ? ` · <em class="bk-today">今日 ${fmtWords(todayOf(n.id))} 字</em>` : ''}</span>
        <span>${esc(fmtDate(n.updatedAt).slice(5, 10))}</span>
      </div>
      ${goal ? `<div class="bk-goal" title="全书目标 ${fmtGoal(goal.target)} 字 · 已完成 ${goal.pct}%${esc(estText)}">
        <div class="bk-goal-bar"><i style="width:${goal.pct}%"></i></div>
        <span class="bk-goal-text">${goal.done ? '已达成目标' : `目标 ${fmtGoal(goal.target)} 字`}</span>
        <span class="bk-goal-pct">${goal.pct}%</span>
      </div>` : ''}
      <button class="bk-del" title="移到回收站" aria-label="将《${esc(n.title)}》移到回收站">${ico('trash')}</button>`;

    div.addEventListener('click', (e) => {
      const moreBtn = e.target.closest('.bk-tag-more');
      if (moreBtn) {
        e.stopPropagation();
        toggleShelfTagExpansion(n.id);
        return;
      }
      const tagBtn = e.target.closest('.bk-tag');
      if (tagBtn) {
        e.stopPropagation();
        toggleShelfTag(tagBtn.dataset.tag);
        return;
      }
      if (e.target.closest('.bk-del') || e.target.closest('.bk-reading')) return;
      openNovel(n.id);
    });
    if (hasProgress) {
      div.querySelector('.bk-reading').addEventListener('click', (e) => {
        e.stopPropagation();
        continueReading(n.id);
      });
    }
    div.querySelector('.bk-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`将《${n.title}》移入回收站？\n之后可以在书架「回收站」里恢复。`)) return;
      try {
        await api.del(`/api/novels/${n.id}`);
        if (S.novel?.id === n.id) {
          S.novel = null; S.chapterId = null;
          S.unsaved.clear(); S.dirty = false; refreshSavePill();   // 作品都删了，别再去补存
        }
        await loadNovels(); renderShelf(); refreshTrashCount(); toast('已移入回收站');
      } catch (err) {
        toast(`移入回收站失败：${err.message || '未知错误'}`, 'err');
      }
    });
    grid.appendChild(div);
  }

  if (q && !list.length && S.novels.length) {
    const empty = document.createElement('div');
    empty.className = 'shelf-no-match';
    empty.innerHTML = `<p>没有找到匹配「${esc(q)}」的作品</p><button type="button" class="btn btn-sm" id="shelfNoMatchClear">清空搜索</button>`;
    empty.querySelector('#shelfNoMatchClear')?.addEventListener('click', () => clearShelfSearch());
    grid.appendChild(empty);
  }
}

function setShelfSort(key) {
  if (!SHELF_SORT_OPTIONS.some((option) => option.key === key) || key === S.shelfSort) return;
  S.shelfSort = key;
  try { localStorage.setItem(SHELF_SORT_KEY, key); } catch {}
  renderShelf();
  window.scrollTo(0, 0);   // 排完直接看第一本，别停在原来的滚动位置
}

function clearShelfSearch(focus = true) {
  const input = $('#shelfSearch');
  input.value = '';
  $('#shelfSearchClear').hidden = true;
  renderShelf();
  if (focus) input.focus();
}

/** 点击卡片上的标签：把该标签加进搜索框，已有则移除。 */
function toggleShelfTag(tag) {
  const input = $('#shelfSearch');
  const next = toggleSearchTerm(input.value, tag);
  input.value = next;
  $('#shelfSearchClear').hidden = !next;
  renderShelf();
  input.focus();
  try { input.setSelectionRange(next.length, next.length); } catch {}
}

/** 展开 / 收起卡片上的全部标签；重绘后把焦点还给同一个按钮。 */
function toggleShelfTagExpansion(id) {
  if (expandedShelfTags.has(id)) expandedShelfTags.delete(id);
  else expandedShelfTags.add(id);
  renderShelf();
  const card = [...document.querySelectorAll('#shelfGrid .book')].find((el) => el.dataset.id === id);
  card?.querySelector('.bk-tag-more')?.focus();
}

const renderShelfDebounced = debounce(renderShelf, 150);
$('#shelfSearch').addEventListener('input', () => {
  $('#shelfSearchClear').hidden = !$('#shelfSearch').value.trim();
  renderShelfDebounced();
});
$('#shelfSearch').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !$('#shelfSearch').value) return;
  e.preventDefault();
  clearShelfSearch();
});
$('#shelfSearchClear').addEventListener('click', () => clearShelfSearch());
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  if (!$('#modalMask').hidden || $('#readerMask') || S.view !== 'shelf') return;
  const tag = (e.target?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;
  e.preventDefault();
  $('#shelfSearch').focus();
  $('#shelfSearch').select();
});
$('#globalSearchBtn').addEventListener('click', () => openGlobalSearch());
$('#trashBtn').addEventListener('click', () => openTrash());
$('#shelfSortBtn').addEventListener('click', (e) => {
  const anchor = e.currentTarget;
  showPop(anchor, SHELF_SORT_OPTIONS.map((option) => ({
    label: `${option.key === S.shelfSort ? '✓ ' : ''}${option.label}`,
    run: () => setShelfSort(option.key),
  })));
});

function setTrashBadge(count) {
  const n = Math.max(0, Number(count) || 0);
  const badge = $('#trashCount');
  if (badge) {
    badge.hidden = n === 0;
    badge.textContent = n > 99 ? '99+' : String(n);
  }
  $('#trashBtn')?.classList.toggle('has-items', n > 0);
}

async function refreshTrashCount() {
  try {
    const { items } = await api.get('/api/trash');
    setTrashBadge((items || []).length);
    return (items || []).length;
  } catch {
    return 0;
  }
}

function openTrash() {
  showModal(`<h3>回收站</h3>
    <p class="modal-sub">删除的作品会先放在这里；恢复后原样回到书架，版本备份也还在。彻底删除才会清理正文、设定和备份。</p>
    <div class="find-bar">
      <input class="input" id="trashSearch" placeholder="搜索书名 / 作者 / 类型 / 删除日期" title="支持书名、作者、类型和删除日期；Esc 清空" autocomplete="off" />
      <button class="icon-btn sm" id="trashSearchClear" title="清除搜索" aria-label="清除搜索" hidden><svg class="ico"><use href="#i-x" /></svg></button>
      <span class="hist-count" id="trashResultCount"></span>
    </div>
    <div class="trash-list" id="trashList"><div class="find-empty">读取中…</div></div>
    <div class="modal-foot">
      <button class="btn btn-text trash-clear" id="trashClear" disabled>清空回收站</button>
      <button class="btn" id="trashClose">关闭</button>
    </div>`,
  (box) => {
    const listEl = box.querySelector('#trashList');
    const clearBtn = box.querySelector('#trashClear');
    const countEl = box.querySelector('#trashResultCount');
    const qEl = box.querySelector('#trashSearch');
    const qClear = box.querySelector('#trashSearchClear');
    let items = [];
    let lastQuery = '';
    box.querySelector('#trashClose').onclick = closeModal;

    const dateText = (item) => (item.deletedAt ? fmtDate(item.deletedAt) : '未知时间');

    const render = () => {
      const q = qEl.value.trim();
      const queryChanged = q !== lastQuery;
      lastQuery = q;
      const visible = filterTrashBySearch(items, q, dateText);
      qClear.hidden = !q;
      clearBtn.disabled = !items.length;
      setTrashBadge(items.length);
      countEl.textContent = items.length
        ? (q ? `找到 ${visible.length} / ${items.length} 部作品` : `共 ${items.length} 部作品`)
        : '';
      // 换搜索词回到第一条；恢复 / 彻底删除后的刷新保持原位。
      const paint = (html) => {
        const keep = listEl.scrollTop;
        listEl.innerHTML = html;
        listEl.scrollTop = queryChanged ? 0 : keep;
      };
      if (!items.length) {
        paint(`<div class="trash-empty">${ico('trash')}<b>回收站是空的</b>删除的作品会先放在这里，之后可以恢复。</div>`);
        return;
      }
      if (!visible.length) {
        paint(`<div class="trash-empty">没有找到匹配「${esc(q)}」的作品。<br><button type="button" class="btn btn-sm" id="trashNoMatchClear">清空搜索</button></div>`);
        listEl.querySelector('#trashNoMatchClear')?.addEventListener('click', () => clearSearch());
        return;
      }
      paint(visible.map((item) => {
        const meta = [item.author, item.genre].filter(Boolean).map((v) => esc(v)).join(' · ');
        return `<div class="trash-item">
          <div class="trash-cover" style="--cover:${coverOf(item.title)}">${ico('book-open')}</div>
          <div class="trash-main">
            <b class="trash-title">《${esc(item.title)}》</b>
            <span class="trash-meta">${meta || '未分类'} · ${item.chapterCount} 章 · ${fmtWords(item.words)} 字</span>
            <span class="trash-meta">删除于 ${esc(dateText(item))}</span>
          </div>
          <div class="trash-actions">
            <button class="btn btn-sm" data-act="restore" data-id="${esc(item.trashId)}">${ico('undo')}恢复</button>
            <button class="btn btn-sm btn-danger-ghost" data-act="purge" data-id="${esc(item.trashId)}">${ico('trash')}彻底删除</button>
          </div>
        </div>`;
      }).join(''));
    };

    const clearSearch = (focus = true) => {
      qEl.value = '';
      render();
      if (focus) qEl.focus();
    };

    const load = async () => {
      try {
        const data = await api.get('/api/trash');
        items = data.items || [];
        render();
      } catch (err) {
        items = [];
        countEl.textContent = '';
        qClear.hidden = !qEl.value.trim();
        listEl.innerHTML = `<div class="find-empty">读取失败：${esc(err.message || '未知错误')}</div>`;
        clearBtn.disabled = true;
      }
    };

    const doRestore = async (item, btn) => {
      btn.disabled = true;
      try {
        await api.send(`/api/trash/${encodeURIComponent(item.trashId)}/restore`, undefined, 'POST');
        await loadNovels();
        renderShelf();
        await load();
        toast(`已恢复《${item.title}》`, 'ok');
      } catch (err) {
        btn.disabled = false;
        toast(`恢复失败：${err.message || '未知错误'}`, 'err');
      }
    };

    const doPurge = async (item, btn) => {
      if (!confirm(`彻底删除《${item.title}》？\n正文、设定和版本备份都会被清理，无法恢复。`)) return;
      btn.disabled = true;
      try {
        await api.del(`/api/trash/${encodeURIComponent(item.trashId)}`);
        await load();
        toast(`已彻底删除《${item.title}》`);
      } catch (err) {
        btn.disabled = false;
        toast(`彻底删除失败：${err.message || '未知错误'}`, 'err');
      }
    };

    listEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const item = items.find((x) => x.trashId === btn.dataset.id);
      if (!item) return;
      if (btn.dataset.act === 'restore') doRestore(item, btn);
      else doPurge(item, btn);
    });

    qEl.addEventListener('input', render);
    qEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !qEl.value) return;
      e.preventDefault();
      e.stopPropagation();   // 只清空搜索，别把回收站一起关掉
      clearSearch();
    });
    qClear.addEventListener('click', () => clearSearch());
    qEl.focus();

    clearBtn.onclick = async () => {
      if (!items.length) return;
      if (!confirm(`清空回收站？\n将彻底删除 ${items.length} 部作品及其版本备份，无法恢复。`)) return;
      clearBtn.disabled = true;
      try {
        await api.del('/api/trash');
        qEl.value = '';
        lastQuery = '';
        await load();
        renderShelf();
        toast('回收站已清空');
      } catch (err) {
        clearBtn.disabled = false;
        toast(`清空失败：${err.message || '未知错误'}`, 'err');
      }
    };

    load();
  }, { wide: true });
}

/* ============================================================
 * 作品备份与恢复（JSON）
 * ------------------------------------------------------------
 * 备份是原样的作品 JSON，正文 / 设定 / 大纲 / 记忆 / 修订都在里面。
 * 恢复时先新建一部作品，再把内容灌进去：即使选错文件，也不会
 * 覆盖现有稿件。章节 id 会重新生成，避免和旧作品纠缠。
 * ============================================================ */
function readBackupFile(file) {
  if (file.size > 40 * 1024 * 1024) return Promise.reject(new Error('备份文件超过 40 MB'));
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取备份文件失败'));
    reader.readAsText(file, 'utf-8');
  });
}

function parseBackupNovel(text) {
  let data;
  try {
    data = JSON.parse(String(text || '').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('这不是有效的 JSON 文件');
  }
  if (data && typeof data === 'object' && data.novel && typeof data.novel === 'object') data = data.novel;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('这不是书匠的作品备份');
  if (!Array.isArray(data.chapters)) throw new Error('备份里没有章节列表');
  return data;
}

function backupImportPayload(data) {
  const ids = new Set();
  const chapters = data.chapters
    .filter((ch) => ch && typeof ch === 'object' && !Array.isArray(ch))
    .map((ch, i) => {
      let id = uid('c');
      while (ids.has(id)) id = uid('c');
      ids.add(id);
      return {
        ...ch,
        id,
        no: i + 1,
        title: typeof ch.title === 'string' && ch.title.trim() ? ch.title.trim() : `第 ${i + 1} 章`,
        content: typeof ch.content === 'string' ? ch.content : '',
        summary: typeof ch.summary === 'string' ? ch.summary : '',
        stage: ['draft', 'revising', 'done'].includes(ch.stage) ? ch.stage : 'draft',
        outline: ch.outline && typeof ch.outline === 'object' && !Array.isArray(ch.outline) ? ch.outline : null,
        memory: ch.memory && typeof ch.memory === 'object' && !Array.isArray(ch.memory) ? ch.memory : null,
        revisions: Array.isArray(ch.revisions) ? ch.revisions : undefined,
      };
    });
  return {
    title: typeof data.title === 'string' && data.title.trim() ? data.title.trim() : '恢复的作品',
    author: typeof data.author === 'string' ? data.author : '',
    genre: typeof data.genre === 'string' ? data.genre : '',
    tags: parseNovelTags(data.tags),
    meta: data.meta && typeof data.meta === 'object' && !Array.isArray(data.meta) ? data.meta : {},
    bible: data.bible && typeof data.bible === 'object' && !Array.isArray(data.bible) ? data.bible : {},
    outline: data.outline && typeof data.outline === 'object' && !Array.isArray(data.outline) ? data.outline : {},
    chapters,
  };
}

async function restoreNovelBackup(file) {
  if (!file) return;
  const btn = $('#restoreBackupBtn');
  const original = btn?.innerHTML;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '恢复中…';
  }
  let created = null;
  let restoredId = '';
  try {
    const data = parseBackupNovel(await readBackupFile(file));
    const payload = backupImportPayload(data);
    await flushSave().catch(() => {});
    const made = await api.send('/api/novels', {
      title: payload.title,
      author: payload.author,
      genre: payload.genre,
      tags: payload.tags,
    });
    created = made.novel;
    const res = await api.put(`/api/novels/${created.id}`, payload);
    restoredId = res.novel?.id || created.id;
    await loadNovels();
    renderShelf();
    toast(`已恢复《${res.novel?.title || payload.title}》为新的作品`, 'ok');
  } catch (err) {
    if (created && !restoredId) {
      try { await api.del(`/api/novels/${created.id}?permanent=1`); } catch {}
      try { await loadNovels(); renderShelf(); } catch {}
    }
    toast(`恢复失败：${err.message || '未知错误'}`, 'err');
    return;
  } finally {
    if (btn) {
      btn.disabled = false;
      if (original != null) btn.innerHTML = original;
    }
  }
  if (restoredId) await openNovel(restoredId).catch(() => {});
}

$('#restoreBackupBtn')?.addEventListener('click', () => $('#restoreBackupInput')?.click());
$('#restoreBackupInput')?.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (file) restoreNovelBackup(file);
});

function novelDraftFrom(box) {
  return {
    title: box.querySelector('#nvTitle').value.trim() || '导入的作品',
    genre: box.querySelector('#nvGenre').value.trim(),
    author: box.querySelector('#nvAuthor').value.trim(),
    tags: parseNovelTags(box.querySelector('#nvTags').value),
    logline: box.querySelector('#nvLogline').value.trim(),
    platform: box.querySelector('#nvPlatform').value,
  };
}

async function saveNovelDraftMeta(novel, logline, platform) {
  if (!logline && !platform) return;
  novel.meta = { ...(novel.meta || {}), logline, platform };
  await api.put(`/api/novels/${novel.id}`, { meta: novel.meta });
}

function openNewNovelModal() {
  showModal(`
    <h3>新建作品</h3>
    <label class="field-label">书名</label><input id="nvTitle" class="input" placeholder="例如：剑来山海" />
    <div class="field-row">
      <label class="field-label">类型<input id="nvGenre" class="input" placeholder="玄幻 / 都市 / 悬疑…" /></label>
      <label class="field-label">作者名<input id="nvAuthor" class="input" /></label>
    </div>
    <label class="field-label">标签<span class="field-hint">空格或逗号分隔 · 最多 ${NOVEL_TAG_LIMIT} 个</span>
      <input id="nvTags" class="input" placeholder="无限流 群像 复仇" autocomplete="off" />
    </label>
    <label class="field-label">一句话故事<span class="field-hint">可后补</span></label>
    <input id="nvLogline" class="input" placeholder="一个少年背着一把不能出鞘的剑，去杀他师傅。" />
    <label class="field-label">目标平台</label>
    <select id="nvPlatform" class="select">
      <option value="">不限</option><option>番茄小说</option><option>起点中文网</option>
      <option>七猫</option><option>晋江</option><option>出版向</option>
    </select>
    <div class="nv-import">手上有旧稿？<button type="button" class="link-btn" id="nvImportLink">直接导入</button>，不用在这里填完。</div>
    <div class="modal-foot">
      <button class="btn btn-text" id="nvCancel">取消</button>
      <button class="btn btn-primary" id="nvOk">创建</button>
    </div>`, (box) => {
    box.querySelector('#nvCancel').onclick = closeModal;
    box.querySelector('#nvTitle').focus();
    box.querySelector('#nvImportLink').onclick = async () => {
      const linkBtn = box.querySelector('#nvImportLink');
      const okBtn = box.querySelector('#nvOk');
      if (linkBtn.disabled) return;
      linkBtn.disabled = true;
      okBtn.disabled = true;
      const { title, genre, author, tags, logline, platform } = novelDraftFrom(box);
      let novel;
      try {
        ({ novel } = await api.send('/api/novels', { title, genre, author, tags }));
      } catch (err) {
        linkBtn.disabled = false;
        okBtn.disabled = false;
        return toast(err.message, 'err');
      }
      const warnings = [];
      try { await saveNovelDraftMeta(novel, logline, platform); } catch (err) { warnings.push(`简介没保存：${err.message}`); }
      closeModal();
      await loadNovels().catch(() => {});
      try {
        await openNovel(novel.id);
      } catch (err) {
        return toast(`《${novel.title}》已建好，但没能打开：${err.message}`, 'err');
      }
      openImportModal();
      if (warnings.length) toast(`作品已建好；${warnings.join('；')}`, 'err');
      else toast('先导入稿子，导入后可以在标题上改名', 'ok');
    };
    box.querySelector('#nvOk').onclick = async () => {
      const okBtn = box.querySelector('#nvOk');
      if (okBtn.disabled) return;   // 连点两下只建一本书
      const original = okBtn.textContent;
      okBtn.disabled = true;
      okBtn.textContent = '创建中…';
      // 先把要填的内容读出来：后面弹窗可能被 Esc 关掉，节点就没了
      const { title, genre, author, tags, logline, platform } = novelDraftFrom(box);
      let novel;
      try {
        ({ novel } = await api.send('/api/novels', { title, genre, author, tags }));
      } catch (err) {
        okBtn.disabled = false;
        okBtn.textContent = original;
        return toast(err.message, 'err');
      }
      const warnings = [];
      // 简介和目标平台只在真的填了时才写回，省一次请求
      if (logline || platform) {
        try {
          await saveNovelDraftMeta(novel, logline, platform);
        } catch (err) {
          warnings.push(`简介没保存：${err.message}`);
        }
      }
      // 手动新建也顺手建好第一章：新作者不用再找「新建第一章」在哪
      let chapter = null;
      try {
        ({ chapter } = await api.send(`/api/novels/${novel.id}/chapters`, { title: '第 1 章' }));
      } catch (err) {
        warnings.push(`第一章没建成：${err.message}`);
      }
      closeModal();
      await loadNovels().catch(() => {});
      try {
        await openNovel(novel.id, chapter ? { chapterId: chapter.id } : {});
      } catch (err) {
        return toast(`《${novel.title}》已建好，但没能打开：${err.message}`, 'err');
      }
      if (chapter) {
        $('#chContent').focus();
        toast(
          warnings.length ? `《${novel.title}》已建好，但${warnings.join('；')}` : `《${novel.title}》和第一章已准备好，直接写就行`,
          warnings.length ? 'err' : 'ok',
        );
      } else {
        toast(`《${novel.title}》已建好；第一章没建成，点「新建第一章」可以补上`, 'err');
      }
    };
  });
}
$('#newNovelBtn').addEventListener('click', openNewNovelModal);
$('#emptyNewBtn').addEventListener('click', openNewNovelModal);

/* 空书架：没有模型也能先把旧稿搬进来；先建一本空书，再进导入流程 */
function openImportNew() {
  showModal(`
    <h3>导入已有稿子</h3>
    <p class="modal-sub">给这本书起个名字，然后把 .txt / .md / .docx 拖进来，或直接粘贴。导入后还能在标题上随时改。</p>
    <label class="field-label">书名</label>
    <input id="impNewTitle" class="input" placeholder="例如：旧稿《半盏残雪》" autocomplete="off" />
    <div class="modal-foot">
      <button class="btn btn-text" id="impNewCancel">取消</button>
      <button class="btn btn-primary" id="impNewOk">创建并导入</button>
    </div>`, (box) => {
    const titleEl = box.querySelector('#impNewTitle');
    const okBtn = box.querySelector('#impNewOk');
    titleEl.focus();
    const create = async () => {
      if (okBtn.disabled) return;
      okBtn.disabled = true;
      const original = okBtn.textContent;
      okBtn.textContent = '创建中…';
      let novel;
      try {
        ({ novel } = await api.send('/api/novels', { title: titleEl.value.trim() || '导入的作品' }));
      } catch (err) {
        okBtn.disabled = false;
        okBtn.textContent = original;
        return toast(err.message, 'err');
      }
      closeModal();
      await loadNovels().catch(() => {});
      try {
        await openNovel(novel.id);
      } catch (err) {
        return toast(`《${novel.title}》已建好，但没能打开：${err.message}`, 'err');
      }
      openImportModal();
      toast('先导入稿子，导入后可以在标题上改名', 'ok');
    };
    okBtn.onclick = create;
    titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); create(); } });
    box.querySelector('#impNewCancel').onclick = closeModal;
  });
}
$('#emptyImportBtn').addEventListener('click', openImportNew);

/* ============================================================
 * 4.5 一键开书：一句话 → 书名 / 人物 / 大纲 / 第一章
 * ============================================================
 * 只做「从零到能写」这一段：不替作者改稿，也不替作者定稿。
 * 每一步都把结果直接写进作品文件，中途停止 / 某一步失败时，
 * 已经生成的内容仍然留在书架里。
 */
const QUICK_START_STEPS = [
  { key: 'create', label: '建好作品', hint: '先搭一本书的骨架' },
  { key: 'title', label: '起书名', hint: '从想法里挑一个记得住的名字' },
  { key: 'characters', label: '设计人物', hint: '主角、对手和关键配角' },
  { key: 'outline', label: '铺全书大纲', hint: '分卷与章纲，后面写作都靠它' },
  { key: 'chapter', label: '建好第一章', hint: '把第一章的章纲挂上' },
  { key: 'prose', label: '写第一章正文', hint: '一份能读、能改的初稿' },
];

const QUICK_START_SCALES = [
  { key: 'small', title: '先试 3 章', desc: '1 卷 · 先看合不合口味', volumes: 1, perVolume: 3 },
  { key: 'medium', title: '推荐 16 章', desc: '2 卷 · 每卷 8 章', volumes: 2, perVolume: 8 },
  { key: 'large', title: '更完整 24 章', desc: '3 卷 · 每卷 8 章', volumes: 3, perVolume: 8 },
];

/** 服务商是否已经有密钥（页面拿到的 apiKey 永远是空的，只能看 apiKeySet） */
function providerHasKey(provider) {
  return !!provider && (provider.apiKeySet || !!String(provider.apiKey || '').trim());
}

/** 任务对应的模型角色：记忆 / 一致性用 summary，审稿用 review，其余用 write */
const TASK_MODEL_ROLE = { memory: 'summary', consistency: 'summary', review: 'review' };

function taskModelRole(task) {
  return TASK_MODEL_ROLE[task] || 'write';
}

/** 当前任务明确配置过的模型：角色模型 → 全局模型 → 写作模型；不拿列表第一个凑合 */
function configuredModel(task = 'chapter') {
  const cfg = S.config || {};
  const roles = cfg.roleModels || {};
  const role = taskModelRole(task);
  return String(roles[role] || cfg.model || roles.write || '').trim();
}

/** 现在能不能直接发起 AI 调用：至少有一个带 Key 的服务商，并且选过模型 */
function aiModelReady(task = 'chapter', explicitModel = '') {
  const cfg = S.config || {};
  if (!(cfg.providers || []).some(providerHasKey)) return false;
  return !!String(explicitModel || configuredModel(task) || '').trim();
}

/**
 * 找出一键开书真正能用的服务商和模型；缺一个都先去补，别让请求发出去才报错。
 * 只看「明确选过」的模型，不拿列表里第一个凑合：
 * 列表里第一个可能是向量 / 画图模型，用它开书只会得到一堆看不懂的错误。
 */
function quickStartModel() {
  const cfg = S.config || {};
  const usable = (cfg.providers || []).filter(providerHasKey);
  if (!usable.length) return null;
  const model = configuredModel('chapter');
  if (!model) return null;
  // 哪个服务商的列表里有这个模型，就用哪个；都没有就按当前服务商 / 第一个来
  const holder = usable.find((p) => (p.models || []).some((m) => String(m).trim() === model));
  const provider = holder || usable.find((p) => p.id === cfg.activeProviderId) || usable[0];
  return { providerId: provider.id, model, providerName: provider.name || provider.baseUrl || '当前服务商' };
}

/** 模型名去重，保留服务商返回的顺序 */
function quickStartModelList(list) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const name = String(item || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function openQuickStartModal() {
  if (!quickStartModel()) return openQuickStartSetup();

  let activeRun = null;
  showModal(`
    <h3>一键开书</h3>
    <p class="modal-sub">写下一句话想法，AI 会先生成书名和人物，再铺全书大纲，最后把第一章写出来。你随时可以停下来改。</p>
    <label class="field-label">一句话想法<span class="field-hint">必填 · 越具体越好</span></label>
    <input id="qsIdea" class="input" maxlength="200" autocomplete="off" placeholder="例如：一个少年背着一把不能出鞘的剑，去杀他师傅。" />
    <div class="qs-ideas" id="qsIdeas">
      <span>没想好？点一个试试</span>
      <button type="button" data-idea="一个少年背着一把不能出鞘的剑，去杀教他剑法的师傅。">剑与师门</button>
      <button type="button" data-idea="失业青年继承了一家只在深夜营业的旧书店，来的客人都不是活人。">深夜书店</button>
      <button type="button" data-idea="每天醒来都会收到一封明天的自己写的信，信里预告了一场谋杀。">明天的信</button>
    </div>
    <p class="qs-error" id="qsError" hidden>先写一句想法，一句话就够。</p>
    <label class="field-label">类型<span class="field-hint">可留空，让模型判断</span></label>
    <input id="qsGenre" class="input" maxlength="24" autocomplete="off" placeholder="玄幻 / 都市 / 悬疑…" />
    <label class="field-label">篇幅<span class="field-hint">只写第一章，其余章纲留给之后慢慢写</span></label>
    <div class="qs-scale" id="qsScale" role="group" aria-label="开书篇幅">
      ${QUICK_START_SCALES.map((s, i) => `<button type="button" class="qs-scale-btn${i === 1 ? ' on' : ''}" data-scale="${s.key}" aria-pressed="${i === 1}"><b>${s.title}</b><span>${s.desc}</span></button>`).join('')}
    </div>
    <div class="tip qs-tip">${ico('spark')}<span>会用「${esc(quickStartModel().providerName)}」的 <code>${esc(quickStartModel().model)}</code> 调用 4 次模型，通常一两分钟，费用由你的服务商结算。</span></div>
    <div class="modal-foot">
      <button class="btn btn-text" id="qsCancel">取消</button>
      <button class="btn btn-primary" id="qsStart">${ico('spark')}开始生成</button>
    </div>`, (box) => {
    let scaleKey = 'medium';
    const ideaEl = box.querySelector('#qsIdea');
    const errorEl = box.querySelector('#qsError');
    const startBtn = box.querySelector('#qsStart');
    ideaEl.focus();
    ideaEl.addEventListener('input', () => { errorEl.hidden = true; });
    ideaEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); start(); }
    });
    box.querySelectorAll('#qsIdeas [data-idea]').forEach((btn) => {
      btn.addEventListener('click', () => {
        ideaEl.value = btn.dataset.idea || '';
        errorEl.hidden = true;
        ideaEl.focus();
      });
    });
    box.querySelectorAll('.qs-scale-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        scaleKey = btn.dataset.scale;
        box.querySelectorAll('.qs-scale-btn').forEach((b) => {
          const on = b === btn;
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', String(on));
        });
      });
    });
    box.querySelector('#qsCancel').onclick = closeModal;

    const start = () => {
      const idea = ideaEl.value.trim();
      if (!idea) {
        errorEl.hidden = false;
        ideaEl.focus();
        return;
      }
      const scale = QUICK_START_SCALES.find((s) => s.key === scaleKey) || QUICK_START_SCALES[1];
      const run = {
        idea,
        genre: box.querySelector('#qsGenre').value.trim(),
        scale,
        warnings: [],
        title: '',
        novelId: '',
        chapterId: '',
        chapterTitle: '',
        characters: 0,
        outline: null,
        outlineChapters: 0,
        words: 0,
        stopped: false,
        closed: false,
        running: true,
        controller: new AbortController(),
      };
      activeRun = run;
      startBtn.disabled = true;
      renderQuickStartRun(box, run);
    };
    startBtn.onclick = start;
  }, {
    // 生成中直接关掉弹窗：停掉请求，已写盘的内容保留
    onClose: () => {
      if (!activeRun) return;
      activeRun.closed = true;
      activeRun.controller?.abort();
    },
  });
}

/**
 * 模型准备：不把用户直接丢进设置页，而是按当前配置判断缺哪一步：
 *   没有服务商 → 选一家常用服务商，当场填 Key
 *   有服务商没 Key → 当场填 Key
 *   有 Key 没模型 → 自动拉模型列表，选一个；拉不到就手动填
 * 选好后保存配置，再通过 onReady 回到用户本来要做的事。
 * 默认的服务对象是一键开书；其它 AI 操作可传 isReady / onReady 接回原动作。
 */
async function openModelSetup(opts = {}) {
  const {
    introTitle = '还差一步：接入模型',
    introText = '写正文、想大纲、改稿子都要用 AI 模型。接一次，以后都能用。',
    modelTitle = '选一个模型，继续',
    saveLabel = '保存，继续',
    onCancel = null,
  } = opts;
  // renderModel 内部也有一个叫 opts 的渲染参数，这里先留一份，别被它遮住
  const setup = opts;

  if (!S.config) {
    try {
      S.config = await api.get('/api/config');
    } catch (err) {
      showModal(`
        <h3>读不到模型设置</h3>
        <p class="modal-sub">${esc(quickStartErrorText(err))}</p>
        <div class="modal-foot"><button class="btn btn-primary" id="qsCfgRetry">重试</button></div>`, (box) => {
        box.querySelector('#qsCfgRetry').onclick = () => { closeModal(); openModelSetup(opts); };
      });
      return;
    }
  }
  // 配置可能在别处已经改好，能用就别再拦一道
  if ((setup.isReady || quickStartModel)()) {
    (setup.onReady || openQuickStartModal)();
    return;
  }

  let closed = false;
  let finished = false;
  const box = showModal('', null, {
    onClose: () => {
      closed = true;
      // 用户主动关掉弹窗时，让原操作知道这次没继续
      if (!finished) onCancel?.();
    },
  });
  const cfg = () => S.config || {};
  const providers = () => (cfg().providers || []).filter(Boolean);
  const providerById = (id) => providers().find((p) => p.id === id) || null;
  const close = () => closeModal();
  const goSettings = () => { finished = true; closeModal(); setView('settings'); };
  const presetOf = (provider) => PRESETS.find((x) => x.baseUrl && provider?.baseUrl
    && x.baseUrl.replace(/\/+$/, '') === String(provider.baseUrl).replace(/\/+$/, ''));

  function preferredModel(provider, models) {
    if (!models.length) return '';
    const c = cfg();
    const wanted = [c.roleModels?.write, c.model, ...(presetOf(provider)?.models || [])]
      .map((x) => String(x || '').trim())
      .filter(Boolean);
    const hit = wanted.find((m) => models.includes(m));
    if (hit) return hit;
    // 尽量避开向量 / 语音 / 画图 / 补全模型，优先挑常见的聊天模型
    const nonChat = /embed|whisper|tts|dall-?e|image|audio|moderation|rerank|vision|babbage|davinci|ada|curie|similarity|text-search|codex/i;
    const chatLike = /(^|[^a-z0-9])(chat|instruct|gpt|claude|gemini|qwen|deepseek|glm|moonshot|kimi|doubao|llama|mistral|mixtral|ernie|hunyuan|writer|reasoner)([^a-z0-9]|$)/i;
    const slow = /reason|thinking|(^|[^a-z0-9])o[13]([^a-z0-9]|$)/i;
    // 先挑能聊天、又不是慢速推理的模型；开书不需要想太久
    return models.find((m) => chatLike.test(m) && !nonChat.test(m) && !slow.test(m))
      || models.find((m) => chatLike.test(m) && !nonChat.test(m))
      || models.find((m) => !nonChat.test(m))
      || models[0];
  }

  function renderIntro() {
    if (closed) return;
    const quick = PRESETS.filter((p) => !/Ollama/i.test(p.name));
    box.innerHTML = `
      <h3>${esc(introTitle)}</h3>
      <p class="modal-sub">${esc(introText)}</p>
      <div class="qs-setup-steps">
        <div class="qs-setup-step"><b>1</b><div><strong>选一家服务商</strong><em>国内常用 DeepSeek；已经有别家的 Key 也可以直接用。</em></div></div>
        <div class="qs-setup-step"><b>2</b><div><strong>粘贴 API Key</strong><em>在服务商后台创建一个 Key，复制过来。这里不需要注册账号。</em></div></div>
        <div class="qs-setup-step"><b>3</b><div><strong>选一个模型</strong><em>连上后会自动列出可用模型，点一个就能继续。</em></div></div>
      </div>
      <label class="field-label">从常用服务商开始<span class="field-hint">已有 Key 的话，下一步粘贴即可</span></label>
      <div class="qs-preset-grid">
        ${quick.map((p) => `<button type="button" class="qs-preset" data-preset="${PRESETS.indexOf(p)}"><b>${esc(p.name)}</b><span>${esc((p.models || [])[0] || '自定义模型')}</span></button>`).join('')}
        <button type="button" class="qs-preset" data-preset="custom"><b>其他服务商 / 中转站</b><span>自己填 Base URL 和模型名</span></button>
      </div>
      <div class="tip qs-tip">${ico('shield')}<span>密钥只写入本机的 <code>data/config.json</code>，不会上传到别处，也不会随作品导出。</span></div>
      <div class="modal-foot">
        <button class="btn btn-text" id="qsSetupCancel">取消</button>
        <button class="btn btn-text" id="qsSetupSettings">打开设置</button>
      </div>`;
    box.querySelector('#qsSetupCancel').onclick = close;
    box.querySelector('#qsSetupSettings').onclick = goSettings;
    box.querySelectorAll('.qs-preset').forEach((btn) => {
      btn.onclick = () => {
        const key = btn.dataset.preset;
        if (key === 'custom') return renderKey(null, { name: '新服务商', baseUrl: '', models: [] });
        renderKey(null, PRESETS[Number(key)]);
      };
    });
  }

  function renderKey(providerId, preset = null) {
    if (closed) return;
    const provider = providerId ? providerById(providerId) : null;
    if (providerId && !provider) return renderIntro();
    const known = preset || (provider ? presetOf(provider) : null) || {};
    const name = provider?.name || preset?.name || '新服务商';
    const baseUrl = provider?.baseUrl || preset?.baseUrl || '';
    const savedKey = providerHasKey(provider);
    box.innerHTML = `
      <h3>${savedKey ? `重新填写「${esc(name)}」的 API Key` : `接入「${esc(name)}」`}</h3>
      <p class="modal-sub">模型需要用 API Key 验证身份。把服务商后台创建的 Key 粘进来，就能拿到可用模型列表。</p>
      ${known.keyUrl ? `<a class="qs-ext-link" href="${esc(known.keyUrl)}" target="_blank" rel="noopener">打开 ${esc(name)} 的 API Key 页面 ↗</a>` : ''}
      ${providers().length > 1 ? `
        <label class="field-label">要给哪个服务商填 Key</label>
        <select class="select" id="qsProviderPick">
          ${providers().map((p) => `<option value="${esc(p.id)}" ${p.id === providerId ? 'selected' : ''}>${esc(p.name || '未命名服务商')}${p.baseUrl ? ` · ${esc(p.baseUrl)}` : ''}</option>`).join('')}
        </select>` : ''}
      <label class="field-label">Base URL<span class="field-hint">一般不用改，通常以 /v1 结尾</span></label>
      <input id="qsBaseUrl" class="input" autocomplete="off" value="${esc(baseUrl)}" placeholder="https://api.deepseek.com/v1" />
      <label class="field-label">API Key<span class="field-hint">${savedKey ? `已保存 ${esc(provider?.apiKeyMasked || '')}，留空不修改` : '只保存在本机'}</span></label>
      <input id="qsKey" class="input" type="password" autocomplete="off" placeholder="${savedKey ? '留空继续使用已保存的 Key' : 'sk-...'}" />
      <p class="qs-error" id="qsKeyError" hidden></p>
      <div class="tip qs-tip">${ico('shield')}<span>Key 只写入本机的 <code>data/config.json</code>，不会上传到别处，也不会随作品导出。</span></div>
      <div class="qs-setup-links"><button type="button" class="btn btn-text btn-sm" id="qsKeySettings">打开设置里管理服务商</button></div>
      <div class="modal-foot qs-foot">
        <button class="btn btn-text" id="qsKeyCancel">取消</button>
        <button class="btn btn-primary" id="qsKeyConnect">连接并获取模型</button>
      </div>`;
    const baseEl = box.querySelector('#qsBaseUrl');
    const keyEl = box.querySelector('#qsKey');
    const errorEl = box.querySelector('#qsKeyError');
    const pickEl = box.querySelector('#qsProviderPick');
    const connectBtn = box.querySelector('#qsKeyConnect');
    const showError = (text) => {
      errorEl.hidden = false;
      errorEl.textContent = text;
    };
    box.querySelector('#qsKeyCancel').onclick = close;
    box.querySelector('#qsKeySettings').onclick = goSettings;
    pickEl?.addEventListener('change', () => renderKey(pickEl.value));
    keyEl.addEventListener('input', () => { errorEl.hidden = true; });
    baseEl.addEventListener('input', () => { errorEl.hidden = true; });
    keyEl.focus();

    let effectiveId = providerId;
    connectBtn.onclick = async () => {
      const nextBase = baseEl.value.trim();
      const nextKey = keyEl.value.trim();
      if (!nextBase) {
        showError('先填 Base URL。它通常长这样：https://api.deepseek.com/v1');
        baseEl.focus();
        return;
      }
      if (!nextKey && !providerHasKey(provider)) {
        showError('先填 API Key，否则没法连接服务商。');
        keyEl.focus();
        return;
      }
      errorEl.hidden = true;
      connectBtn.disabled = true;
      const oldText = connectBtn.textContent;
      connectBtn.textContent = '正在连接…';
      let configSaved = false;
      try {
        if (!S.config) S.config = await api.get('/api/config');
        const c = S.config;
        if (!Array.isArray(c.providers)) c.providers = [];
        let p = effectiveId ? c.providers.find((x) => x.id === effectiveId) : null;
        if (!p) {
          p = {
            id: uid('p'),
            name: preset?.name || '新服务商',
            baseUrl: nextBase,
            models: preset?.models ? [...preset.models] : [],
            apiKey: nextKey,
          };
          c.providers.push(p);
          effectiveId = p.id;
        } else {
          p.baseUrl = nextBase;
          if (nextKey) p.apiKey = nextKey;
        }
        p.baseUrl = nextBase;
        if (nextKey) p.apiKey = nextKey;
        c.activeProviderId = p.id;
        await api.send('/api/config', configForSave(c));
        configSaved = true;
        S.config = await api.get('/api/config');
        if (closed) return;

        const r = await api.send('/api/config/models', { providerId: effectiveId, baseUrl: nextBase });
        if (closed) return;
        if (!r.ok) {
          renderModel(effectiveId, {
            models: [],
            fetched: true,
            error: r.error || '服务商没有返回模型列表',
            manual: true,
          });
          return;
        }
        const models = quickStartModelList(r.models);
        if (models.length) {
          const saved = providerById(effectiveId);
          if (saved) {
            saved.models = models;
            try {
              await api.send('/api/config', configForSave(S.config));
              S.config = await api.get('/api/config');
            } catch { /* 列表已经拿到了，存不下也不影响这次选择 */ }
          }
        }
        if (closed) return;
        renderModel(effectiveId, {
          models,
          fetched: true,
          error: models.length ? '' : '服务商返回了空列表，可以直接填模型名。',
          manual: !models.length,
        });
      } catch (err) {
        if (closed) return;
        const saved = effectiveId ? providerById(effectiveId) : null;
        if (configSaved && saved) {
          // Key 已经存下来了，只是拉列表失败：让用户手动填模型，不用重来
          renderModel(effectiveId, {
            models: quickStartModelList(saved.models),
            fetched: true,
            error: quickStartErrorText(err),
            manual: true,
          });
          return;
        }
        showError(quickStartErrorText(err));
        connectBtn.disabled = false;
        connectBtn.textContent = oldText;
      }
    };
  }

  async function fetchModels(providerId) {
    const provider = providerById(providerId);
    if (!provider) return renderIntro();
    renderModel(providerId, { loading: true, fetched: true });
    try {
      const r = await api.send('/api/config/models', { providerId, baseUrl: provider.baseUrl });
      if (closed) return;
      if (!r.ok) throw new Error(r.error || '服务商没有返回模型列表');
      const models = quickStartModelList(r.models);
      if (models.length) {
        const saved = providerById(providerId);
        if (saved) {
          saved.models = models;
          try {
            await api.send('/api/config', configForSave(S.config));
            S.config = await api.get('/api/config');
          } catch { /* 列表已经拿到了，存不下也不影响这次选择 */ }
        }
      }
      if (closed) return;
      renderModel(providerId, {
        models,
        fetched: true,
        error: models.length ? '' : '服务商返回了空列表，可以直接填模型名。',
        manual: !models.length,
      });
    } catch (err) {
      if (closed) return;
      renderModel(providerId, {
        models: quickStartModelList(providerById(providerId)?.models),
        fetched: true,
        error: quickStartErrorText(err),
        manual: true,
      });
    }
  }

  function renderModel(providerId, opts = {}) {
    if (closed) return;
    const provider = providerById(providerId);
    if (!provider) return renderIntro();
    const models = quickStartModelList(opts.models ?? provider.models);
    const loading = !!opts.loading;
    const error = String(opts.error || '');
    const manualOpen = !!opts.manual || (!loading && !models.length);
    const picked = opts.picked || preferredModel(provider, models);
    const manualPlaceholder = presetOf(provider)?.models?.[0] || '例如 deepseek-chat';
    box.innerHTML = `
      <h3>${esc(modelTitle)}</h3>
      <p class="modal-sub">服务商「${esc(provider.name || '未命名服务商')}」已经接上。<span class="qs-dim">${esc(provider.baseUrl || '')}</span></p>
      ${loading ? `<div class="qs-fetch"><span class="qs-spinner"></span><span>正在获取可用模型…</span></div>` : ''}
      ${error ? `<div class="qs-warns qs-warns-err"><b>没能自动获取模型列表</b><p>${esc(error)}</p><p>有些服务商不开放这个接口，这不影响使用；在服务商文档里找到模型 ID，填到下面就可以。</p></div>` : ''}
      ${models.length ? `
        <label class="field-label">模型<span class="field-hint">之后也能在设置里改</span></label>
        <select class="select" id="qsModelSelect">
          ${models.map((m) => `<option value="${esc(m)}" ${m === picked ? 'selected' : ''}>${esc(m)}</option>`).join('')}
        </select>` : ''}
      <div id="qsManual" ${manualOpen ? '' : 'hidden'}>
        <label class="field-label">模型名称<span class="field-hint">填服务商文档里的模型 ID</span></label>
        <input id="qsModelInput" class="input" autocomplete="off" placeholder="${esc(manualPlaceholder)}" value="${esc(opts.manualValue || picked || '')}" />
      </div>
      <p class="qs-error" id="qsModelError" hidden></p>
      <div class="qs-setup-links">
        ${models.length ? '<button type="button" class="btn btn-text btn-sm" id="qsManualToggle">列表里没有？手动填写</button>' : ''}
        <button type="button" class="btn btn-text btn-sm" id="qsRefetch">重新获取模型列表</button>
        <button type="button" class="btn btn-text btn-sm" id="qsModelSettings">打开设置</button>
        <button type="button" class="btn btn-text btn-sm" id="qsModelKey">重新填写 Key</button>
      </div>
      <div class="modal-foot qs-foot">
        <button class="btn btn-text" id="qsModelCancel">取消</button>
        <button class="btn btn-primary" id="qsModelUse" ${loading ? 'disabled' : ''}>${esc(saveLabel)}</button>
      </div>`;
    const errorEl = box.querySelector('#qsModelError');
    const manualEl = box.querySelector('#qsModelInput');
    const manualWrap = box.querySelector('#qsManual');
    const selectEl = box.querySelector('#qsModelSelect');
    const useBtn = box.querySelector('#qsModelUse');
    const showError = (text) => {
      errorEl.hidden = false;
      errorEl.textContent = text;
    };
    box.querySelector('#qsModelCancel').onclick = close;
    box.querySelector('#qsModelSettings').onclick = goSettings;
    box.querySelector('#qsModelKey').onclick = () => renderKey(providerId);
    box.querySelector('#qsRefetch').onclick = () => fetchModels(providerId);
    box.querySelector('#qsManualToggle')?.addEventListener('click', () => {
      manualWrap.hidden = false;
      // 手动框默认跟着下拉框走，避免改了下拉、保存的却还是旧模型
      if (selectEl) manualEl.value = selectEl.value;
      manualEl.focus();
    });
    manualEl.addEventListener('input', () => { errorEl.hidden = true; });
    selectEl?.addEventListener('change', () => {
      errorEl.hidden = true;
      if (selectEl.value) manualWrap.hidden = true;
    });
    useBtn.onclick = async () => {
      const manualValue = manualWrap.hidden ? '' : manualEl.value.trim();
      const model = manualValue || String(selectEl?.value || '').trim();
      if (!model) {
        showError('先选一个模型，或填写模型名称。');
        (manualWrap.hidden ? selectEl : manualEl)?.focus();
        return;
      }
      if (closed) return;
      errorEl.hidden = true;
      useBtn.disabled = true;
      const oldText = useBtn.textContent;
      useBtn.textContent = '正在保存…';
      try {
        if (!S.config) S.config = await api.get('/api/config');
        const c = S.config;
        const p = (c.providers || []).find((x) => x.id === providerId);
        if (!p) throw new Error('这个服务商已经不在配置里了，请重新打开设置。');
        p.models = quickStartModelList([...(p.models || []), model]);
        c.activeProviderId = p.id;
        c.model = model;
        c.roleModels = { ...(c.roleModels || {}), write: model };
        await api.send('/api/config', configForSave(c));
        S.config = await api.get('/api/config');
        if (closed) return;
        finished = true;
        closeModal();
        toast(`已选好模型 ${model}`, 'ok');
        (setup.onReady || openQuickStartModal)();
      } catch (err) {
        if (closed) return;
        showError(quickStartErrorText(err));
        useBtn.disabled = false;
        useBtn.textContent = oldText;
      }
    };
    if (!opts.fetched) fetchModels(providerId);
  }

  const all = providers();
  const keyed = all.filter(providerHasKey);
  const active = keyed.find((p) => p.id === cfg().activeProviderId) || keyed[0] || null;
  if (!all.length) return renderIntro();
  if (!active) {
    const pick = all.find((p) => p.id === cfg().activeProviderId) || all[0];
    return renderKey(pick.id);
  }
  const models = quickStartModelList(active.models);
  return renderModel(active.id, { models, fetched: models.length > 0 });
}

/** 一键开书的模型准备：缺什么补什么，补好回到开书表单 */
function openQuickStartSetup() {
  return openModelSetup({
    introTitle: '一键开书还差一步：接入模型',
    introText: '一键开书要请一个 AI 模型来写书名、人物、大纲和第一章。接一次，以后都能用。',
    modelTitle: '选一个模型，继续开书',
    saveLabel: '保存，继续开书',
    isReady: quickStartModel,
    onReady: openQuickStartModal,
  });
}

function renderQuickStartRun(box, run) {
  box.innerHTML = `
    <h3>正在开书…</h3>
    <p class="modal-sub" id="qsRunSub">正在准备…</p>
    <ol class="qs-steps">
      ${QUICK_START_STEPS.map((s) => `
        <li class="qs-step" id="qsStep-${s.key}" data-state="pending">
          <span class="qs-step-dot"></span>
          <div class="qs-step-text"><b>${s.label}</b><em>${s.hint}</em></div>
          <span class="qs-step-state">等待</span>
        </li>`).join('')}
    </ol>
    <div class="qs-preview" id="qsPreview" hidden>
      <div class="qs-preview-head"><span id="qsPreviewLabel">生成中</span><span id="qsPreviewCount"></span></div>
      <pre id="qsPreviewText"></pre>
    </div>
    <div class="qs-note">开书会调用 4 次模型，通常一两分钟。内容会实时保存；中途停止也不会丢掉已经生成的部分。</div>
    <div class="modal-foot qs-foot">
      <button class="btn btn-text" id="qsClose" disabled>关闭</button>
      <button class="btn btn-danger-ghost" id="qsStop">${ico('stop')}停止</button>
    </div>`;
  const stopBtn = box.querySelector('#qsStop');
  stopBtn.onclick = () => {
    if (!run.running) return;
    run.stopped = true;
    run.controller?.abort();
    stopBtn.disabled = true;
    stopBtn.textContent = '正在停止…';
    quickStartSub(box, '正在停止，已经生成的内容会保留…');
  };
  box.querySelector('#qsClose').onclick = closeModal;
  runQuickStart(box, run).catch((err) => {
    run.running = false;
    if (run.closed) return;
    quickStartResult(box, run, 'error', quickStartErrorText(err));
  });
}

/** 快开流程的单步：调用模型、落盘、更新 run；失败按类型处理 */
async function quickStartTitleStep(box, run, novelId, base) {
  quickStartStep(box, 'title', 'running');
  quickStartSub(box, '正在起书名…');
  try {
    const text = await quickStartStream(run, box, 'title', '起书名', {
      ...base,
      task: 'titles',
      novelId,
      payload: { instruction: `这本书的一句话故事是「${run.idea}」。请为它起 8 个书名候选，每个附一句理由，贴合网文平台的搜索习惯。` },
    });
    const title = quickStartPickTitle(text);
    if (!title) {
      quickStartStep(box, 'title', 'skip', '先叫《未命名作品》，之后可改');
      return '书名没生成成功。作品暂时叫《未命名作品》，可以在「设定库 → 大纲」里改名。';
    }
    await api.put(`/api/novels/${novelId}`, { title });
    run.title = title;
    quickStartStep(box, 'title', 'done', `《${title}》`);
    return '';
  } catch (err) {
    if (quickStartIsStop(err, run)) throw err;
    quickStartStep(box, 'title', 'error', '跳过，之后可在设定库改名');
    return `书名没生成成功：${quickStartErrorText(err)}。作品暂时叫《未命名作品》。`;
  }
}

async function quickStartCharactersStep(box, run, novelId, base) {
  quickStartStep(box, 'characters', 'running');
  quickStartSub(box, '正在设计人物…');
  try {
    const text = await quickStartStream(run, box, 'characters', '设计人物', {
      ...base,
      task: 'characters',
      novelId,
      payload: { instruction: `根据这句话故事「${run.idea}」，设计 6 位主要人物（含主角、对手、关键配角）。` },
    });
    const arr = parseJsonLoose(text);
    const rawList = Array.isArray(arr) ? arr : (Array.isArray(arr?.characters) ? arr.characters : []);
    const list = rawList
      .filter((x) => x && typeof x === 'object' && String(x.name || '').trim())
      .map((x) => ({
        ...x,
        id: uid('ch'),
        name: String(x.name).trim(),
        relations: Array.isArray(x.relations) ? x.relations : [],
        keywords: Array.isArray(x.keywords) ? x.keywords : [],
      }));
    if (!list.length) throw new Error('模型返回的人物格式看不懂');
    await api.put(`/api/novels/${novelId}`, { bible: { characters: list } });
    run.characters = list.length;
    quickStartStep(box, 'characters', 'done', `${list.length} 位 · ${list.slice(0, 3).map((x) => x.name).join('、')}${list.length > 3 ? '…' : ''}`);
    return '';
  } catch (err) {
    if (quickStartIsStop(err, run)) throw err;
    quickStartStep(box, 'characters', 'error', '跳过，可在设定库补');
    return `人物没生成成功：${quickStartErrorText(err)}。之后可以在「设定库 → 人物」补。`;
  }
}

async function quickStartOutlineStep(box, run, novelId, base) {
  quickStartStep(box, 'outline', 'running');
  quickStartSub(box, '正在铺全书大纲…');
  try {
    const text = await quickStartStream(run, box, 'outline', '铺全书大纲', {
      ...base,
      task: 'outline',
      novelId,
      payload: {
        templateKey: 'outline:aiFullOutline',
        instruction: quickStartOutlineInstruction(run),
      },
    });
    const parsed = parseOutlineMarkdown(text);
    const total = parsed.reduce((s, v) => s + (v.chapters?.length || 0), 0);
    if (!total) throw new Error('模型没有输出可用的分卷 / 章纲');
    parsed.forEach((v) => { v.id = v.id || uid('v'); });
    await api.put(`/api/novels/${novelId}`, { outline: { volumes: parsed, notes: '' } });
    run.outline = parsed;
    run.outlineChapters = total;
    quickStartStep(box, 'outline', 'done', `${parsed.length} 卷 · ${total} 章`);
    const planned = run.scale.volumes * run.scale.perVolume;
    return total < planned
      ? `模型只排了 ${total} 章（原计划 ${planned} 章）。先按现有大纲写第一章，之后可以在「设定库 → 大纲」继续补。`
      : '';
  } catch (err) {
    if (quickStartIsStop(err, run)) throw err;
    quickStartStep(box, 'outline', 'error', '没能生成可用的分卷大纲');
    throw new Error(`全书大纲没生成成功：${quickStartErrorText(err)}`);
  }
}

async function quickStartChapterStep(box, run, novelId) {
  const first = quickStartFirstChapter(run.outline);
  if (!first) throw new Error('大纲里没有可用的第一章');
  quickStartStep(box, 'chapter', 'running');
  quickStartSub(box, `正在建第一章「${first.chapter.title}」…`);
  const made = await api.send(`/api/novels/${novelId}/chapters`, {
    title: first.chapter.title || '第一章',
    summary: first.chapter.summary || '',
    outline: quickStartChapterOutline(first.chapter),
    outlineId: first.chapter.id,
    volumeId: first.volume.id,
    at: 0,
  });
  run.chapterId = made.chapter.id;
  run.chapterTitle = made.chapter.title;
  quickStartStep(box, 'chapter', 'done', `第 1 章 · ${made.chapter.title}`);
  return first;
}

async function quickStartProseStep(box, run, novelId, chapterId, firstChapter, base) {
  quickStartStep(box, 'prose', 'running');
  quickStartSub(box, '正在写第一章正文…');
  let prose = '';
  try {
    await quickStartStream(run, box, 'prose', '写第一章正文', {
      ...base,
      task: 'chapter',
      novelId,
      chapterId,
      payload: {
        targetWords: 1600,
        instruction: quickStartChapterInstruction(firstChapter.chapter),
      },
    }, (text) => { prose = text; });
    if (!prose.trim()) throw new Error('模型没有返回正文');
    await api.put(`/api/novels/${novelId}/chapters/${chapterId}`, { content: prose.trim() });
    run.words = countWords(prose);
    quickStartStep(box, 'prose', 'done', `${fmtWords(run.words)} 字`);
    return '';
  } catch (err) {
    if (quickStartIsStop(err, run)) {
      // 停止时已经写出来的半章也留下，别让作者白等
      if (prose.trim().length >= 40) {
        await api.put(`/api/novels/${novelId}/chapters/${chapterId}`, { content: prose.trim() }).catch(() => {});
        run.words = countWords(prose);
      }
      throw err;
    }
    quickStartStep(box, 'prose', 'error', '可以先打开作品自己写');
    return `第一章正文没生成成功：${quickStartErrorText(err)}。章纲和空白章已经建好，可以直接开写。`;
  }
}

async function runQuickStart(box, run) {
  const ready = quickStartModel();
  if (!ready) {
    run.running = false;
    if (!run.closed) openQuickStartSetup();
    return;
  }
  const base = { providerId: ready.providerId, model: ready.model };
  try {
    /* 1. 建作品 */
    quickStartStep(box, 'create', 'running');
    quickStartSub(box, '正在建作品…');
    const { novel } = await api.send('/api/novels', { title: '未命名作品', genre: run.genre });
    run.novelId = novel.id;
    quickStartAssertRunning(run);
    await api.put(`/api/novels/${novel.id}`, { meta: { logline: run.idea } });
    quickStartStep(box, 'create', 'done', '作品已建好，设定会随时保存');
    quickStartAssertRunning(run);

    /* 2. 书名 */
    const titleWarning = await quickStartTitleStep(box, run, novel.id, base);
    if (titleWarning) run.warnings.push(titleWarning);
    quickStartAssertRunning(run);

    /* 3. 人物 */
    const charWarning = await quickStartCharactersStep(box, run, novel.id, base);
    if (charWarning) run.warnings.push(charWarning);
    quickStartAssertRunning(run);

    /* 4. 全书大纲 */
    const outlineWarning = await quickStartOutlineStep(box, run, novel.id, base);
    if (outlineWarning) run.warnings.push(outlineWarning);
    quickStartAssertRunning(run);

    /* 5. 建第一章 */
    const first = await quickStartChapterStep(box, run, novel.id);
    quickStartAssertRunning(run);

    /* 6. 第一章正文 */
    const proseWarning = await quickStartProseStep(box, run, novel.id, run.chapterId, first, base);
    if (proseWarning) run.warnings.push(proseWarning);
    quickStartAssertRunning(run);

    run.running = false;
    if (run.closed) return;
    if (run.warnings.length) quickStartResult(box, run, 'success');
    else await openQuickStartNovel(run);
  } catch (err) {
    run.running = false;
    if (run.closed) return;
    if (quickStartIsStop(err, run)) return quickStartResult(box, run, 'stopped');
    quickStartResult(box, run, 'error', quickStartErrorText(err));
  }
}

const QUICK_START_RESUME_LABELS = {
  title: '起书名',
  characters: '设计人物',
  outline: '铺全书大纲',
  chapter: '新建第一章',
  prose: '写第一章正文',
};

/** 弹窗里要不要给「接着补完」：只看本次运行已经知道哪些没做完 */
function quickStartNeedsResume(run) {
  if (!run?.novelId) return false;
  return !run.title || !run.characters || !run.outline || !run.chapterId || !run.words;
}

/** 真正开始补完前读一遍作品：手动改过、已经有正文 / 章节 / 人物的，不覆盖，也不重跑 */
async function quickStartResumeMissing(run) {
  const { novel } = await api.get(`/api/novels/${run.novelId}`);
  const missing = [];
  const title = String(novel.title || '').trim();
  if (title === '' || title === '未命名作品') missing.push('title');
  if (!(novel.bible?.characters || []).length) missing.push('characters');
  if (!(novel.outline?.volumes || []).length) missing.push('outline');
  if (!(novel.chapters || []).length) missing.push('chapter', 'prose');
  else if (!String(novel.chapters[0]?.content || '').trim()) missing.push('prose');
  return { novel, missing };
}

function openQuickStartResumeSetup(run, onReady) {
  return openModelSetup({
    introTitle: '接着补完还差一步：接入模型',
    introText: '补完会继续请 AI 模型接着生成。接一次，以后也能用。',
    modelTitle: '选一个模型，继续补完',
    saveLabel: '保存，继续补完',
    isReady: quickStartModel,
    onReady,
    onCancel: () => toast('还没接入模型，这次补完没开始'),
  });
}

/** 二次确认：把要重跑的步骤列出来，再交给模型 */
async function openQuickStartResume(run) {
  if (!quickStartModel()) return openQuickStartResumeSetup(run, () => openQuickStartResume(run));
  let data;
  try {
    data = await quickStartResumeMissing(run);
  } catch (err) {
    return toast(err.message, 'err');
  }
  const { novel, missing } = data;
  if (!missing.length) return toast(`《${novel.title}》已经补齐了`, 'ok');
  const labels = missing.map((k) => QUICK_START_RESUME_LABELS[k]);
  showModal(`
    <h3>接着补完这本书</h3>
    <p class="modal-sub">只补下面这些，已经生成的内容不会重跑。</p>
    <ol class="qs-resume-list">${labels.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
    <p class="qs-note">会再调用 ${missing.length} 次模型，费用由你的服务商结算。</p>
    <div class="modal-foot">
      <button class="btn btn-text" id="qsResumeCancel">先不开</button>
      <button class="btn btn-primary" id="qsResumeStart">${ico('spark')}开始补完</button>
    </div>`, (box) => {
    box.querySelector('#qsResumeCancel').onclick = closeModal;
    box.querySelector('#qsResumeStart').onclick = () => {
      closeModal();
      openQuickStartResumeRun(run, missing, novel);
    };
  });
}

function renderQuickStartResumeRun(missing) {
  const steps = missing.map((k) => QUICK_START_STEPS.find((s) => s.key === k)).filter(Boolean);
  return `
    <h3>正在补完这本书…</h3>
    <p class="modal-sub" id="qsRunSub">正在准备…</p>
    <ol class="qs-steps">
      ${steps.map((s) => `
        <li class="qs-step" id="qsStep-${s.key}" data-state="pending">
          <span class="qs-step-dot"></span>
          <div class="qs-step-text"><b>${s.label}</b><em>${s.hint}</em></div>
          <span class="qs-step-state">等待</span>
        </li>`).join('')}
    </ol>
    <div class="qs-preview" id="qsPreview" hidden>
      <div class="qs-preview-head"><span id="qsPreviewLabel">生成中</span><span id="qsPreviewCount"></span></div>
      <pre id="qsPreviewText"></pre>
    </div>
    <div class="qs-note">只补空缺，已生成的内容不会重跑。</div>
    <div class="modal-foot qs-foot">
      <button class="btn btn-text" id="qsClose" disabled>关闭</button>
      <button class="btn btn-danger-ghost" id="qsStop">停止</button>
    </div>`;
}

async function openQuickStartResumeRun(run, missing, novel) {
  if (!quickStartModel()) return openQuickStartResumeSetup(run, () => openQuickStartResumeRun(run, missing, novel));
  const rrun = { ...run, controller: new AbortController(), stopped: false, closed: false, running: true, warnings: [] };
  showModal(renderQuickStartResumeRun(missing), (box) => {
    box.querySelector('#qsStop').onclick = () => {
      rrun.stopped = true;
      rrun.controller?.abort();
      quickStartSub(box, '正在停止，已经生成的内容会保留…');
    };
    runQuickStartResume(box, rrun, missing, novel);
  }, {
    onClose: () => { rrun.closed = true; rrun.controller?.abort(); },
  });
}

async function runQuickStartResume(box, rrun, missing, novel) {
  const ready = quickStartModel();
  if (!ready) {
    rrun.running = false;
    if (!rrun.closed) openQuickStartResumeSetup(rrun, () => openQuickStartResume(rrun));
    return;
  }
  const base = { providerId: ready.providerId, model: ready.model };
  const currentOf = async () => (await api.get(`/api/novels/${rrun.novelId}`)).novel;
  try {
    let current = novel;

    /* 书名 */
    if (missing.includes('title')) {
      const t = String(current.title || '').trim();
      if (t && t !== '未命名作品') quickStartStep(box, 'title', 'done', `《${t}》`);
      else {
        const warning = await quickStartTitleStep(box, rrun, current.id, base);
        if (warning) rrun.warnings.push(warning);
        current = await currentOf();
      }
      quickStartAssertRunning(rrun);
    }

    /* 人物 */
    if (missing.includes('characters')) {
      current = await currentOf();
      const existing = (current.bible?.characters || []).length;
      if (existing) quickStartStep(box, 'characters', 'done', `已有 ${existing} 位`);
      else {
        const warning = await quickStartCharactersStep(box, rrun, current.id, base);
        if (warning) rrun.warnings.push(warning);
      }
      quickStartAssertRunning(rrun);
    }

    /* 大纲 */
    if (missing.includes('outline')) {
      current = await currentOf();
      const existing = (current.outline?.volumes || []).length;
      if (existing) {
        rrun.outline = current.outline.volumes;
        rrun.outlineChapters = rrun.outline.reduce((s, v) => s + (v.chapters?.length || 0), 0);
        quickStartStep(box, 'outline', 'done', `${existing} 卷 · ${rrun.outlineChapters} 章`);
      } else {
        const warning = await quickStartOutlineStep(box, rrun, current.id, base);
        if (warning) rrun.warnings.push(warning);
      }
      quickStartAssertRunning(rrun);
    }

    /* 第一章 */
    if (missing.includes('chapter')) {
      current = await currentOf();
      const existing = (current.chapters || []).length;
      if (existing) {
        rrun.chapterId = current.chapters[0].id;
        rrun.chapterTitle = current.chapters[0].title;
        quickStartStep(box, 'chapter', 'done', `第 1 / ${existing} 章 · ${rrun.chapterTitle}`);
      } else {
        if (!rrun.outline?.length) {
          current = await currentOf();
          rrun.outline = current.outline?.volumes || [];
        }
        if (!rrun.outline?.length) throw new Error('大纲还没准备好，先补大纲这一步');
        await quickStartChapterStep(box, rrun, current.id);
      }
      quickStartAssertRunning(rrun);
    }

    /* 第一章正文 */
    if (missing.includes('prose')) {
      current = await currentOf();
      const ch = current.chapters?.[0];
      if (!ch) throw new Error('还没有第一章，先补「新建第一章」这一步');
      if (String(ch.content || '').trim()) {
        rrun.words = countWords(ch.content);
        rrun.chapterId = ch.id;
        rrun.chapterTitle = ch.title;
        quickStartStep(box, 'prose', 'done', `已有 ${fmtWords(rrun.words)} 字`);
      } else {
        if (!rrun.outline?.length) rrun.outline = current.outline?.volumes || [];
        const first = quickStartFirstChapter(rrun.outline);
        if (!first) throw new Error('找不到第一章章纲，先补大纲');
        const warning = await quickStartProseStep(box, rrun, current.id, ch.id, first, base);
        if (warning) rrun.warnings.push(warning);
      }
      quickStartAssertRunning(rrun);
    }

    rrun.running = false;
    if (rrun.closed) return;
    if (rrun.warnings.length) quickStartResult(box, rrun, 'success');
    else await openQuickStartNovel(rrun);
  } catch (err) {
    rrun.running = false;
    if (rrun.closed) return;
    if (quickStartIsStop(err, rrun)) return quickStartResult(box, rrun, 'stopped');
    quickStartResult(box, rrun, 'error', quickStartErrorText(err));
  }
}

function quickStartOutlineInstruction(run) {
  const total = run.scale.volumes * run.scale.perVolume;
  return `你是一位资深网文策划。这本书的一句话故事是「${run.idea}」。${run.genre ? `题材是「${run.genre}」。` : ''}请设计 ${run.scale.volumes} 卷、每卷 ${run.scale.perVolume} 章，共约 ${total} 章的分卷大纲与章纲。

要求：
1. 每卷有卷名和 120-200 字的卷纲，写清主要冲突、人物弧光与收束点。
2. 每章包含章节名、场景、出场人物、核心事件、章末钩子。
3. 第一章要能直接开写：尽快交代主角、目标与第一个冲突，结尾留钩子。
4. 只输出结构化 Markdown，不要解释、不要客套话。格式：
## 第1卷 卷名
> 卷纲…
### 第1章 章节名
- 场景：…
- 出场人物：…
- 核心事件：…
- 章末钩子：…`;
}

function quickStartFirstChapter(volumes) {
  for (const volume of volumes || []) {
    const chapter = (volume.chapters || [])[0];
    if (chapter) return { volume, chapter };
  }
  return null;
}

function quickStartChapterOutline(chapter) {
  const out = {};
  for (const key of ['scene', 'characters', 'summary', 'hook']) {
    const value = String(chapter?.[key] || '').trim();
    if (value) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

function quickStartChapterInstruction(chapter) {
  const clean = (value) => String(value || '').trim().replace(/[。；;]+$/, '');
  const bits = ['这是全书第一章，请按章纲写出完整正文。'];
  if (chapter.scene) bits.push(`场景：${clean(chapter.scene)}。`);
  if (chapter.summary) bits.push(`核心事件：${clean(chapter.summary)}。`);
  if (chapter.hook) bits.push(`结尾落在：${clean(chapter.hook)}。`);
  bits.push('开头尽快进入冲突，不要用大段背景解释。');
  return bits.join('');
}

function quickStartPickTitle(text) {
  const raw = String(text || '');
  const quoted = raw.match(/《([^》\n]{1,30})》/);
  if (quoted) return quoted[1].trim();
  const bold = [...raw.matchAll(/\*\*([^*\n]{1,30})\*\*/g)]
    .map((m) => m[1].replace(/[《》]/g, '').trim())
    .find((s) => s && !/书名|候选|章节|理由|推荐/.test(s));
  return bold || '';
}

/** 跑一步 AI：统一处理步骤状态、实时预览和停止信号 */
async function quickStartStream(run, box, stepKey, label, body, onDelta) {
  quickStartStep(box, stepKey, 'running');
  quickStartSub(box, `正在${label}…`);
  quickStartPreviewStart(box, label);
  let text = '';
  try {
    return await streamAI(body, {
      signal: run.controller.signal,
      onDelta: (delta) => {
        text += delta;
        quickStartPreviewPaint(box, text);
        onDelta?.(text);
      },
    });
  } finally {
    quickStartPreviewEnd(box);
  }
}

function quickStartStep(box, key, state, detail) {
  const li = box.querySelector(`#qsStep-${key}`);
  if (!li) return;
  li.dataset.state = state;
  const labels = { pending: '等待', running: '生成中', done: '完成', skip: '跳过', error: '失败' };
  const stateEl = li.querySelector('.qs-step-state');
  if (stateEl) stateEl.textContent = labels[state] || '';
  const hint = li.querySelector('em');
  if (hint && detail) hint.textContent = detail;
}

function quickStartSub(box, text) {
  const el = box.querySelector('#qsRunSub');
  if (el) el.textContent = text;
}

function quickStartPreviewStart(box, label) {
  const wrap = box.querySelector('#qsPreview');
  if (!wrap) return;
  wrap.hidden = false;
  const labelEl = box.querySelector('#qsPreviewLabel');
  if (labelEl) labelEl.textContent = label;
  const pre = box.querySelector('#qsPreviewText');
  if (pre) { pre.textContent = ''; pre.scrollTop = 0; }
  const count = box.querySelector('#qsPreviewCount');
  if (count) count.textContent = '';
}

function quickStartPreviewPaint(box, text) {
  const pre = box.querySelector('#qsPreviewText');
  if (!pre) return;
  // 长文只显示最近一段，避免弹窗被几万字撑住
  pre.textContent = text.length > 8000 ? `…${text.slice(-8000)}` : text;
  pre.scrollTop = pre.scrollHeight;
  const count = box.querySelector('#qsPreviewCount');
  if (count) count.textContent = `${countWords(text)} 字`;
}

function quickStartPreviewEnd(box) {
  const wrap = box.querySelector('#qsPreview');
  if (wrap) wrap.hidden = true;
}

function quickStartResult(box, run, kind, message = '') {
  const title = run.title || (run.novelId ? '未命名作品' : '');
  const facts = [];
  if (title) facts.push(['书名', `《${title}》`]);
  if (run.characters) facts.push(['人物', `${run.characters} 位`]);
  if (run.outline) facts.push(['大纲', `${run.outline.length} 卷 · ${run.outlineChapters} 章`]);
  if (run.chapterTitle) {
    facts.push(['第一章', `${run.chapterTitle}${run.words ? ` · ${fmtWords(run.words)} 字` : ' · 还没写正文'}`]);
  }
  const needsResume = !!run.novelId && quickStartNeedsResume(run);
  const head = kind === 'stopped' ? '已停止'
    : kind === 'error' ? '开书没走完'
    : needsResume ? '书已经搭好，还差几步'
    : '书已经开好了';
  const sub = kind === 'stopped'
    ? '已经生成并保存的内容都在书架里，可以随时接着写。'
    : kind === 'error'
      ? '已经建好的部分都留在书架里，没有丢。'
      : needsResume
        ? '下面这几步补上，开写会顺很多；已经生成的内容不会重跑。'
        : '有几处模型没配合好，但书已经可以写了。';
  const errHtml = kind === 'error' && message
    ? `<div class="qs-warns qs-warns-err"><b>卡住的原因</b><p>${esc(message)}</p>${run.warnings.length ? '' : '<p>已经生成的内容已保存；可以打开作品继续写，或稍后重试。</p>'}</div>`
    : '';
  const warns = run.warnings.length
    ? `<div class="qs-warns"><b>还需要你看一眼</b><ul>${run.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`
    : '';
  box.innerHTML = `
    <h3>${esc(head)}</h3>
    <p class="modal-sub">${esc(sub)}</p>
    ${facts.length ? `<dl class="qs-facts">${facts.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>` : ''}
    ${errHtml}
    ${warns}
    <div class="modal-foot">
      ${run.novelId ? '<button class="btn btn-text" id="qsShelf">留在书架</button>' : '<button class="btn btn-text" id="qsDone">关闭</button>'}
      ${run.novelId && needsResume ? '<button class="btn btn-primary" id="qsResume" type="button">接着补完</button>' : ''}
      ${run.novelId ? `<button class="${needsResume ? 'btn' : 'btn btn-primary'}" id="qsOpen">${run.chapterId ? '打开作品，开始写' : '打开作品'}</button>` : ''}
    </div>`;
  box.querySelector('#qsDone')?.addEventListener('click', closeModal);
  box.querySelector('#qsShelf')?.addEventListener('click', async () => {
    closeModal();
    await loadNovels().catch(() => {});
    setView('shelf');
  });
  box.querySelector('#qsOpen')?.addEventListener('click', () => openQuickStartNovel(run));
  box.querySelector('#qsResume')?.addEventListener('click', () => openQuickStartResume(run));
}

async function openQuickStartNovel(run) {
  closeModal();
  if (!run.novelId) return;
  try {
    await loadNovels();
    await openNovel(run.novelId, run.chapterId ? { chapterId: run.chapterId } : {});
    if (S.novel?.id !== run.novelId) return;
    const label = run.title ? `《${run.title}》` : '作品';
    toast(run.words ? `${label}已开好，先读一遍第一章，再决定怎么改` : `${label}已开好，可以开始写第一章了`, 'ok');
  } catch (err) {
    toast(`打开作品失败：${err.message}`, 'err');
  }
}

function quickStartAssertRunning(run) {
  if (!run.stopped) return;
  const err = new Error('已停止');
  err.name = 'AbortError';
  throw err;
}

function quickStartIsStop(err, run) {
  return !!run.stopped || err?.name === 'AbortError';
}

function quickStartErrorText(err) {
  const msg = String(err?.message || err || '未知错误').trim().replace(/\s+/g, ' ');
  return msg.length > 180 ? `${msg.slice(0, 180)}…` : msg;
}

$('#quickStartBtn').addEventListener('click', openQuickStartModal);
$('#emptyQuickStartBtn').addEventListener('click', openQuickStartModal);


async function openNovel(id, opts = {}) {
  // 换作品前先把当前作品的改动落盘 —— 一旦换过去，旧作品的内存内容就被替换了，
  // 没落盘的部分谁也救不回来。落不下去时明确问一句，别默默丢。
  if (S.novel && S.novel.id !== id) {
    // 设定库 / 大纲的防抖保存也要先落盘：它记的是旧作品的对象，不能等切完再发
    const partsOk = await saveNovelPart.flush();
    if (!partsOk) {
      const go = confirm(`《${S.novel.title}》的设定或大纲还有改动没能保存。\n继续打开别的作品会丢掉这些改动。仍要继续吗？`);
      if (!go) return;
    }
    if (S.unsaved.size) {
      const ok = await flushSave();
      if (!ok) {
        const go = confirm(`《${S.novel.title}》还有 ${S.unsaved.size} 章没能保存（${S.saveErr || '未知原因'}）。\n继续打开别的作品会丢掉这些改动。仍要继续吗？`);
        if (!go) return;
        S.unsaved.clear();
        S.dirty = false;
        refreshSavePill();
      }
    }
  }
  const { novel } = await api.get(`/api/novels/${id}`);
  S.novel = novel;
  const want = opts.chapterId && novel.chapters.some((c) => c.id === opts.chapterId) ? opts.chapterId : null;
  S.chapterId = want || novel.chapters[0]?.id || null;
  S.out = ''; S.outTask = ''; S.reasoning = '';
  volToggled.clear();          // 折叠状态是「这本书的」，换作品别带过去
  S.stageFilter = '';          // 筛选也一样，换作品先看全貌
  S.chapterSearch = '';        // 章节搜索属于上一本书，别带过去
  S.chapterCursor = '';
  S.threadFilter = 'all';      // 线索页也回到全部
  S.bibleSearch = { outline: '', characters: '', world: '', timeline: '', threads: '', arcs: '', relations: '', timelineViz: '' }; // 搜索词属于上一本书，别带过去
  setView('studio');
  renderStudio();
}

/* ============================================================
 * 今日码字量 / 日更目标（书架与工作台共用）
 * ============================================================
 * 数字由服务端在章节写盘时算（只算正文变多的部分），前端负责显示与设置目标。
 * 刷新有 5 秒节流：每打一句就发一次请求没必要，但也不能让数字看起来是死的。
 */
let statsKeyShown = '';

/** 这部作品今天写了多少字（没写过就是 0） */
function todayOf(novelId) {
  return Number(S.stats?.byNovelToday?.[novelId]) || 0;
}

async function loadStats({ force = false } = {}) {
  if (!force && S.stats && Date.now() - S.statsAt < 5000) return S.stats;
  try {
    S.stats = await api.get('/api/stats?days=14');
    S.statsAt = Date.now();
  } catch {
    return S.stats;                 // 统计读不到不影响写作，静默跳过
  }
  renderStats();
  // 完稿预测要用到日均产出；统计回来后书架上的目标提示要跟着更新
  if (S.view === 'shelf') renderShelf();
  return S.stats;
}

function statChipHTML() {
  const st = S.stats;
  if (!st) return '';
  const goal = st.goal || 0;
  const pct = goal ? Math.min(100, Math.round((st.todayWords / goal) * 100)) : 0;
  const done = goal > 0 && st.todayWords >= goal;
  const tip = `今日 ${fmtWords(st.todayWords)} 字${goal ? ` / 目标 ${fmtWords(goal)} 字` : ''} · 点击查看写作统计`;
  return `<button class="stat-chip${done ? ' done' : ''}" title="${tip}">
    <svg class="ico"><use href="#i-pen" /></svg>
    <span class="sc-num">今日 ${fmtWords(st.todayWords)} 字</span>
    ${goal ? `<span class="sc-track"><i style="width:${pct}%"></i></span>` : ''}
  </button>`;
}

function renderStats() {
  const html = statChipHTML();
  for (const sel of ['#shelfStats', '#footStats']) {
    const el = $(sel);
    if (!el) continue;
    el.innerHTML = html;
    el.firstElementChild?.addEventListener('click', openStatsModal);
  }
  // 书架卡片上的「今日」要跟着变，但只在真的变了才重建列表
  const key = JSON.stringify(S.stats?.byNovelToday || {});
  if (S.view === 'shelf' && key !== statsKeyShown) {
    statsKeyShown = key;
    renderShelf();
  }
}

/**
 * 写作日历热力图：一格一天，按当天字数相对日更目标着色。
 * 布局跟 GitHub 贡献图一样 —— 列是周，行是星期几，最后一列是本周。
 */
function statsHeatmap(days, goal, today) {
  if (!days.length) return '';
  // 补齐到整周：开头补上第一列之前的空位，结尾补满本周
  const first = new Date(days[0].date + 'T00:00:00');
  const lead = (first.getDay() + 6) % 7;         // 周一为第一行
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (const d of days) cells.push(d);
  while (cells.length % 7) cells.push(null);

  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  // 色阶：以日更目标为基准；没设目标就按「这批里的最大值」分档
  const peak = Math.max(1, ...days.map((d) => d.words));
  const base = goal > 0 ? goal : peak;
  const level = (w) => {
    if (!w) return 0;
    if (!w.words) return 0;
    const r = w.words / base;
    if (r >= 1) return 4;
    if (r >= 0.6) return 3;
    if (r >= 0.3) return 2;
    return 1;
  };

  const monthLabels = weeks.map((w, i) => {
    const firstCell = w.find(Boolean);
    if (!firstCell) return '';
    const d = new Date(firstCell.date + 'T00:00:00');
    const prev = i > 0 ? weeks[i - 1].find(Boolean) : null;
    const pd = prev ? new Date(prev.date + 'T00:00:00') : null;
    // 跨月才标一次月份
    return !pd || pd.getMonth() !== d.getMonth() ? `${d.getMonth() + 1}月` : '';
  });

  const grid = weeks.map((w, wi) => `
    <div class="hm-week">
      <span class="hm-month">${monthLabels[wi]}</span>
      <div class="hm-col">
        ${w.map((d) => {
          if (!d) return '<i class="hm-cell empty"></i>';
          const lv = level(d);
          const tip = `${d.date}　${fmtWords(d.words)} 字${goal ? `　目标 ${fmtWords(goal)}` : ''}　点击看当天明细`;
          return `<button type="button" class="hm-cell lv${lv}${d.date === today ? ' today' : ''}" data-date="${d.date}" title="${tip}" aria-label="${tip}"></button>`;
        }).join('')}
      </div>
    </div>`).join('');

  const activeDays = days.filter((d) => d.words > 0).length;
  const best = days.reduce((a, b) => (b.words > (a?.words || 0) ? b : a), null);

  return `
    <div class="hm-wrap">
      <div class="hm-top">
        <div class="hm-weekdays"><span>一</span><span></span><span>三</span><span></span><span>五</span><span></span><span>日</span></div>
        <div class="hm-grid">${grid}</div>
      </div>
      <div class="hm-legend">
        <span>少</span>
        <i class="hm-cell lv0"></i><i class="hm-cell lv1"></i><i class="hm-cell lv2"></i><i class="hm-cell lv3"></i><i class="hm-cell lv4"></i>
        <span>多</span>
        <span class="hm-note">${activeDays} 天有产出${best ? `　最多的一天 ${fmtWords(best.words)} 字` : ''}</span>
      </div>
    </div>`;
}

async function openStatsModal() {
  const st = (await loadStats({ force: true })) || S.stats;
  if (!st) return toast('统计还读不出来', 'err');
  const goal = st.goal || 0;
  const pct = goal ? Math.min(100, Math.round((st.todayWords / goal) * 100)) : 0;
  const left = Math.max(0, goal - st.todayWords);
  const max = Math.max(1, ...st.days.map((d) => d.words));
  const bars = st.days.map((d) => {
    const h = d.words ? Math.max(4, Math.round((d.words / max) * 100)) : 1.5;
    const cls = `stat-col${d.date === st.today ? ' today' : ''}${d.words ? '' : ' zero'}`;
    return `<div class="${cls}" title="${d.date}　${fmtWords(d.words)} 字"><span class="sc-fill"><i style="height:${h}%"></i></span><span class="sc-day">${d.date.slice(8)}</span></div>`;
  }).join('');
  // 热力图要看一整年，单独再取一次长区间数据
  const year = await api.get('/api/stats?days=364').catch(() => null);
  const heat = statsHeatmap((year && year.days) || st.days, goal, st.today);
  // 全书目标与完稿预测：打开作品时才有
  const bookBlock = goalPanelHtml(S.novel, st);
  // 节奏：最近 30 天 vs 前 30 天、最长连续、写得最多的一天
  const wide = year || st;
  const last30 = Number(wide.last30) || 0;
  const prev30 = Number(wide.prev30) || 0;
  const delta = prev30 ? Math.round(((last30 - prev30) / prev30) * 100) : null;
  const bestStreak = wide.bestStreak || { days: 0, to: '' };
  const bestDay = wide.bestDay || { date: '', words: 0 };
  const paceBlock = `
    <div class="pace-block">
      <div class="pace-cell">
        <b>${fmtWords(last30)}</b><span>最近 30 天</span>
        ${delta === null ? '<em>上一个 30 天没有记录</em>' : `<em class="${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '↑' : '↓'} 比前 30 天 ${Math.abs(delta)}%</em>`}
      </div>
      <div class="pace-cell">
        <b>${bestStreak.days}</b><span>最长连续</span>
        <em>${bestStreak.to ? `到 ${bestStreak.to.slice(5).replace('-', ' 月 ')} 日` : '还没开始'}</em>
      </div>
      <div class="pace-cell">
        <b>${bestDay.words ? fmtWords(bestDay.words) : '—'}</b><span>写得最多的一天</span>
        <em>${bestDay.date ? bestDay.date.slice(5).replace('-', ' 月 ') + ' 日' : '还没有记录'}</em>
      </div>
    </div>`;
  showModal(`
    <h3>写作统计</h3>
    <p class="modal-sub">只算你真的写进正文的字。删字、撤销重做还原、导入旧稿、恢复快照、全书替换都不算今天的产出。</p>
    <div class="stat-hero">
      <div class="sh-line">
        <b>${fmtWords(st.todayWords)}</b><span class="sh-unit">字</span>
        ${goal
          ? `<span class="sh-rest${left ? '' : ' ok'}">${left ? `距目标还差 ${fmtWords(left)} 字` : '今日目标已达成'}</span>`
          : '<span class="sh-rest">今天还没设目标</span>'}
      </div>
      ${goal ? `<div class="stat-track big"><i style="width:${pct}%"></i></div>
        <div class="sh-goal">${pct}% · 目标 ${fmtWords(goal)} 字/天</div>` : ''}
    </div>
    ${bookBlock}
    <div class="stat-cap">最近 14 天</div>
    <div class="stat-chart">${bars}</div>
    <div class="stat-foot">最近 7 天 ${fmtWords(st.week)} 字　·　连续 ${st.streak} 天　·　累计 ${fmtWords(st.total)} 字</div>
    <div class="stat-cap" style="margin-top:22px">节奏</div>
    ${paceBlock}
    <div class="stat-cap" style="margin-top:22px">写作日历（近一年）</div>
    ${heat}
    <div class="modal-foot">
      <label class="goal-field">日更目标
        <input id="goalInput" type="number" min="0" max="500000" step="500" value="${goal}" /> 字/天
      </label>
      <button class="btn" id="goalZero">不设目标</button>
      <button class="btn btn-primary" id="goalSave">保存</button>
    </div>
  `, (box) => {
    const saveGoal = async (value) => {
      try {
        const fresh = await api.send('/api/stats', { goal: value });
        S.stats = fresh;
        S.statsAt = Date.now();
        renderStats();
        closeModal();
        toast(value ? `日更目标已设为 ${fmtWords(value)} 字` : '已取消日更目标', 'ok');
      } catch (err) { toast(err.message, 'err'); }
    };
    const input = box.querySelector('#goalInput');
    box.querySelector('#goalSave').addEventListener('click', () => saveGoal(Math.max(0, Math.floor(Number(input.value) || 0))));
    box.querySelector('#goalZero').addEventListener('click', () => saveGoal(0));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') box.querySelector('#goalSave').click(); });
    // 「去设定」：跳到设定库的「文风与规则」页
    box.querySelector('#stSetGoal')?.addEventListener('click', () => {
      closeModal();
      setView('bible');
      bibleTab = 'style';
      $$('#bibleTabs button').forEach((x) => x.classList.toggle('on', x.dataset.bible === 'style'));
      renderBible();
      setTimeout(() => document.querySelector('[data-key="targetWords"]')?.focus(), 120);
    });
    // 日历上点某一天 → 看那天写了什么
    box.querySelectorAll('.hm-cell[data-date]').forEach((cell) => {
      cell.addEventListener('click', () => openStatsDay(cell.dataset.date));
    });
  }, { wide: true });
}

/** 章节标题已经写着「第N章」就别再补一遍序号 */
function dayChapterLabel(c) {
  const title = String(c?.title || '').trim() || '未命名章节';
  if (/第\s*[0-9零一二三四五六七八九十百千]+\s*[章回节]/.test(title)) return title;
  return c?.no ? `第 ${c.no} 章　${title}` : title;
}

/** 点开写作日历上的某一天：那天写了多少、分到哪几部作品、每部动的是哪几章 */
async function openStatsDay(date) {
  let d;
  try {
    d = await api.get(`/api/stats/day?date=${encodeURIComponent(date)}`);
  } catch {
    return toast('这一天的记录读不出来', 'err');
  }
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][new Date(`${date}T00:00:00`).getDay()];
  const goal = Number(d.goal) || 0;
  const pct = goal ? Math.min(100, Math.round((d.words / goal) * 100)) : 0;
  const list = d.novels?.length
    ? d.novels.map((nv) => `
      <div class="day-novel">
        <div class="day-novel-head">
          <span class="day-novel-title">${esc(nv.title)}</span>
          <span class="day-novel-words">${fmtWords(nv.words)} 字</span>
        </div>
        ${nv.chapters.length ? `<ul class="day-chapters">${nv.chapters.map((c) => `
          <li>
            <button type="button" class="day-chapter" data-novel="${esc(nv.novelId)}" data-chapter="${esc(c.chapterId)}">
              <span class="day-chapter-title">${esc(dayChapterLabel(c))}</span>
              <span class="day-chapter-words">${fmtWords(c.words)} 字</span>
            </button>
          </li>`).join('')}</ul>` : '<div class="day-note">这天没有记到具体章节。</div>'}
      </div>`).join('')
    : '<div class="day-empty">这一天没有写作记录。</div>';

  showModal(`
    <h3>${esc(date)} · 周${weekday}</h3>
    <p class="modal-sub">${d.words ? `当天写了 ${fmtWords(d.words)} 字` : '当天没有写作记录'}${goal ? `，日更目标 ${fmtWords(goal)} 字` : ''}。</p>
    ${goal && d.words ? `<div class="stat-track big"><i style="width:${pct}%"></i></div>
      <div class="sh-goal">${pct}% · 目标 ${fmtWords(goal)} 字/天</div>` : ''}
    <div class="day-list">${list}</div>
    <div class="modal-foot"><button class="btn btn-text" id="dayClose">关闭</button></div>`, (box) => {
    box.querySelector('#dayClose').onclick = closeModal;
    box.querySelectorAll('[data-chapter]').forEach((btn) => {
      btn.onclick = async () => {
        const novelId = btn.dataset.novel;
        const chapterId = btn.dataset.chapter;
        closeModal();
        await openNovel(novelId, { chapterId }).catch(() => {});
        toast('已跳到那一章', 'ok');
      };
    });
  });
}

function openHealthReport() {
  if (!S.novel) return toast('先打开一部作品', 'err');
  // 忽略清单：跟校对的忽略机制一样，跟着作品走
  const ignoreList = () => (Array.isArray(S.novel.meta?.healthIgnored) ? S.novel.meta.healthIgnored : []);
  const saveIgnoreList = (list) => {
    S.novel.meta = { ...(S.novel.meta || {}), healthIgnored: list };
    saveNovelPart({ meta: S.novel.meta });
  };
  const r0 = buildHealthReport(S.novel);
  const r = applyHealthIgnored(r0, ignoreList());
  const ignoredCount = ignoreList().length;
  const total = r.chapters.length;
  const written = r.written.length;
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const metric = (value, label, sub) => `<div class="health-metric"><b>${value}</b><span>${label}</span>${sub ? `<em>${sub}</em>` : ''}</div>`;
  // 每一条后面挂一个「忽略」，误报就别再报了
  const withIgnore = (inner, kind, id, label) => `<div class="health-item">
    ${inner}
    <button type="button" class="health-ignore" data-health-ignore="${esc(healthKey(kind, id))}" data-health-label="${esc(label)}" title="忽略这一条（以后不再提示）" aria-label="忽略这一条">×</button>
  </div>`;

  const outlierRows = r.outliers.map((c) => {
    const delta = c.ratio >= 1 ? `偏长 ${Math.round((c.ratio - 1) * 100)}%` : `偏短 ${Math.round((1 - c.ratio) * 100)}%`;
    return withIgnore(`<button type="button" class="health-row" data-health-chapter="${esc(c.id)}">
      <span>第 ${c.no} 章 · ${esc(c.title)}</span><em>${fmtWords(c.words)} 字 · ${delta}</em>
    </button>`, 'outlier', c.id, `第 ${c.no} 章 ${c.title}`);
  }).join('');

  const duplicateRows = r.duplicates.map((d) => withIgnore(`<div class="health-dup">
      <div class="health-quote">${esc(d.sample)}</div>
      <div class="health-dup-meta"><span>${d.count} 次</span>${d.chapters.map((c) => healthChip(c)).join('')}</div>
    </div>`, 'dup', String(d.sample || '').slice(0, 40), `重复段落：${String(d.sample || '').slice(0, 20)}…`)).join('');

  const phraseBtns = r.phrases.map((p) => `<button type="button" class="health-phrase" data-health-phrase="${esc(p.text)}" title="出现在 ${p.chapters.length} 章，共 ${p.count} 次；点击去全书查找">${esc(p.text)}<b>${p.count}</b></button>`).join('');

  const longRows = r.longParagraphs.map((c) => withIgnore(`<button type="button" class="health-row" data-health-chapter="${esc(c.id)}">
    <span>第 ${c.no} 章 · ${esc(c.title)}</span><em>${c.count} 段 · 最长 ${c.max} 字</em>
  </button>`, 'longpara', c.id, `第 ${c.no} 章 ${c.title}`)).join('');

  const gapRows = r.gaps.map((g) => {
    const attr = g.id ? ` data-health-chapter="${esc(g.id)}"` : ' disabled';
    const role = g.role ? `<i>${esc(g.role)}</i>` : '';
    const meta = g.lastNo ? `第 ${g.lastNo} 章后未再出现 · 已隔 ${g.gap} 章` : '尚未在章节记忆中出现';
    return withIgnore(`<button type="button" class="health-row"${attr}><span>${esc(g.name)}${role}</span><em>${meta}</em></button>`, 'gap', g.name, `人物断档：${g.name}`);
  }).join('');

  const threadRows = r.staleThreads.map((t) => withIgnore(`<button type="button" class="health-row" data-health-chapter="${esc(t.latest.id)}">
    <span><b class="health-thread-kind">未决</b>${esc(t.text)}</span><em>第 ${t.latest.no} 章</em>
  </button>`, 'thread', t.text, `未决线索：${String(t.text || '').slice(0, 20)}`)).join('');

  const noMemory = r.written.length > 0 && r.memCount === 0;
  const caution = r.issueKinds > 0 || noMemory;
  const verdict = !r.totalWords
    ? '正文还是空的，先写下第一章再来体检。'
    : noMemory
      ? '正文已经有了，但还没有章节记忆；这次只能检查正文层面的问题，补齐记忆后才能检查人物断档与线索。'
      : r.issueKinds === 0
        ? '整体状态很稳：没有发现明显的章节失衡、重复段落、人物断档或悬空线索。'
        : `发现 ${r.issueKinds} 类可以顺手处理的地方。下面按优先顺序列出，点任意章节可直接跳过去改。`;
  const verdictSub = r.totalWords && r.written.length < 3 ? '当前有正文的章节还少，统计结果仅供参考。' : '';

  showModal(`
    <h3>全书体检</h3>
    <p class="modal-sub">《${esc(r.title)}》 · 全部在本机计算，不调用模型，不消耗 token。</p>
    <div class="health-metrics">
      ${metric(fmtWords(r.totalWords), '总字数', `${written} / ${total} 章有正文`)}
      ${metric(r.avg ? fmtWords(r.avg) : '—', '平均章长', r.longest ? `最长第 ${r.longest.no} 章` : '还没有正文')}
      ${metric(`${total ? Math.round((r.doneCount / total) * 100) : 0}%`, '完稿进度', `${r.doneCount} / ${total} 章已定稿`)}
      ${metric(`${total ? Math.round((r.memCount / total) * 100) : 0}%`, '记忆覆盖', `${r.memCount} / ${total} 章有记忆`)}
    </div>
    <div class="health-verdict${caution ? '' : ' ok'}">
      <svg class="ico"><use href="#${caution ? 'i-info' : 'i-check'}" /></svg>
      <span>${verdict}${verdictSub ? `<em>${verdictSub}</em>` : ''}</span>
    </div>
    <div class="proof-ignored" id="healthIgnoredBox" hidden>
      <div class="proof-ignored-head">
        <span id="healthIgnoredTitle">已忽略</span>
        <span style="flex:1"></span>
        <button class="btn btn-sm btn-text" id="healthRestoreAll">全部恢复</button>
        <button class="icon-btn sm" id="healthIgnoredClose" title="收起" aria-label="收起">${ico('x')}</button>
      </div>
      <div class="proof-ignored-list" id="healthIgnoredList"></div>
    </div>
    <div class="health-grid">
      <section class="health-card">
        <h4>章节长度 <span class="health-count">${r.outlierTotal ? `${r.outlierTotal} 章异常` : '均衡'}</span></h4>
        <p>${written ? `平均 ${fmtWords(r.avg)} 字/章${r.longest ? ` · 最短第 ${r.shortest.no} 章 ${fmtWords(r.shortest.words)} 字` : ''}` : '还没有正文'}</p>
        ${outlierRows ? `<div class="health-rows">${outlierRows}</div>` : healthOk(written >= 4 ? '没有明显过长或过短的章节。' : '章节还少，长度参考意义有限。')}
      </section>

      <section class="health-card">
        <h4>对话密度 <span class="health-count">${pct(r.dialogueAvg)}</span></h4>
        ${r.dialogueAvg
          ? `<p>成对引号内文字约占全书的 ${pct(r.dialogueAvg)}。低于 8% 偏叙述，高于 75% 偏对话推动。</p>`
          : '<p>没有检测到成对引号。可能是叙述型作品，也可能是引号格式不统一。</p>'}
        ${r.lowDialogue.length ? `<div class="health-sub">低于 8%</div><div class="health-chip-row">${r.lowDialogue.map((c) => healthChip(c)).join('')}</div>` : ''}
        ${r.highDialogue.length ? `<div class="health-sub">高于 75%</div><div class="health-chip-row">${r.highDialogue.map((c) => healthChip(c)).join('')}</div>` : ''}
        ${!r.lowDialogue.length && !r.highDialogue.length && r.dialogueAvg ? healthOk('各章对话密度都在常见区间内。') : ''}
      </section>

      <section class="health-card wide">
        <h4>重复段落 <span class="health-count">${r.duplicateTotal ? `${r.duplicateTotal} 组` : '无'}</span></h4>
        <p>按段落去掉空白和标点后比对。重复不一定是错，也可能是刻意回环。</p>
        ${duplicateRows ? `<div class="health-dups">${duplicateRows}</div>` : healthOk('没有发现整段重复的正文。')}
      </section>

      <section class="health-card wide">
        <h4>口头禅 / AI 高频词 <span class="health-count">${r.phrases.length ? `${r.phrases.length} 个` : '无'}</span></h4>
        <p>只统计常见高频表达，不判断好坏。点一下去全书查找，决定要不要换说法。</p>
        ${phraseBtns ? `<div class="health-phrases">${phraseBtns}</div>` : healthOk('没有发现明显扎堆的高频表达。')}
      </section>

      <section class="health-card">
        <h4>超长段落 <span class="health-count">${r.longParagraphTotal ? `${r.longParagraphTotal} 段` : '无'}</span></h4>
        <p>超过 320 字的段落单独列出。手机阅读时，长段落最容易让人滑走。</p>
        ${longRows ? `<div class="health-rows">${longRows}</div>` : healthOk('没有超过 320 字的超长段落。')}
      </section>

      <section class="health-card">
        <h4>人物断档 <span class="health-count">${r.gapTotal ? `${r.gapTotal} 人` : '无'}</span></h4>
        <p>依据章节记忆统计设定库人物，最近一次出场距今 ≥ 5 章会列出来。</p>
        ${gapRows ? `<div class="health-rows">${gapRows}</div>` : healthOk('设定库人物在章节记忆里都有持续出场。')}
      </section>

      <section class="health-card wide">
        <h4>未回收线索 <span class="health-count">${r.unresolved.length ? `${r.unresolved.length} 条未决` : '无'}</span></h4>
        <p>从章节记忆汇总，共 ${r.unresolved.length} 条未决、${r.foreshadowing.length} 条伏笔。是否有回收仍以正文为准，越靠前说明越久没再提。</p>
        ${threadRows ? `<div class="health-rows">${threadRows}</div>` : healthOk('章节记忆里没有未决线索。')}
      </section>
    </div>
    ${r.memCount < total ? `<p class="health-disclaimer">章节记忆覆盖 ${r.memCount}/${total} 章，人物断档与线索统计会受此影响；可在「线索 → 批量补记忆」补齐。</p>` : ''}
    <div class="modal-foot">
      <span class="health-note">本地统计 · 结果仅供参考</span>
      <button class="btn btn-text" id="healthCopy">复制报告</button>
      <button class="btn" id="healthRefresh">重新体检</button>
      <button class="btn btn-primary" id="healthClose">关闭</button>
    </div>
  `, (box) => {
    box.querySelector('#healthClose').onclick = closeModal;
    box.querySelector('#healthRefresh').onclick = () => openHealthReport();
    box.querySelector('#healthCopy').onclick = () => copyHealthReport(r);
    box.querySelector('#healthIgnoredClose')?.addEventListener('click', () => { box.querySelector('#healthIgnoredBox').hidden = true; });
    box.querySelector('#healthRestoreAll')?.addEventListener('click', () => { saveIgnoreList([]); openHealthReport(); });
    box.querySelectorAll('[data-health-chapter]').forEach((el) => {
      el.onclick = () => {
        closeModal();
        openChapterFromIndex(el.dataset.healthChapter);
      };
    });
    box.querySelectorAll('[data-health-phrase]').forEach((el) => {
      el.onclick = () => {
        closeModal();
        openFind(el.dataset.healthPhrase);
      };
    });
    // 忽略：点 × 就把这一条记下来，以后体检不再报
    box.querySelectorAll('[data-health-ignore]').forEach((el) => {
      el.onclick = (e) => {
        e.stopPropagation();
        const list = ignoreList();
        const key = el.dataset.healthIgnore;
        if (list.some((x) => x.key === key)) return;
        list.push({ key, label: el.dataset.healthLabel || '', ts: Date.now() });
        saveIgnoreList(list.slice(-300));
        openHealthReport();   // 重新体检，已忽略的自然不见了
        toast('已忽略这一条', 'ok');
      };
    });
    // 已忽略的清单
    const ignBox = box.querySelector('#healthIgnoredBox');
    if (ignBox) {
      const list = ignoreList();
      ignBox.hidden = !list.length;
      if (list.length) {
        box.querySelector('#healthIgnoredTitle').textContent = `已忽略 ${list.length} 条`;
        box.querySelector('#healthIgnoredList').innerHTML = list.slice().reverse().map((x) => `
          <div class="proof-ignored-row">
            <span class="proof-main"><span class="proof-msg">${esc(x.label || x.key)}</span></span>
            <button type="button" class="btn btn-sm btn-text" data-health-restore="${esc(x.key)}">恢复</button>
          </div>`).join('');
        box.querySelectorAll('[data-health-restore]').forEach((el) => {
          el.onclick = () => {
            saveIgnoreList(ignoreList().filter((x) => x.key !== el.dataset.healthRestore));
            openHealthReport();
          };
        });
      }
    }
  }, { wide: true });
}

$('#healthBtn')?.addEventListener('click', openHealthReport);

async function openProof() {
  if (!S.novel) return toast('先打开作品', 'err');
  await saveChapterNow().catch(() => {});
  const hasChapter = !!currentChapter();
  let scope = hasChapter ? 'chapter' : 'book';
  let report = buildProofReport(S.novel, scope, S.chapterId);
  let filter = 'all';
  let limit = PROOF_PAGE;
  let groupScroll = 0;

  const box = showModal(`
    <h3>文字校对</h3>
    <p class="modal-sub">检查标点、引号、括号、常见叠字和段落收尾。全部在本机用规则扫描，不调用模型，不消耗 token；只提示，不改正文。点任意问题可直接跳到对应位置。</p>
    <div class="proof-top">
      <div class="segmented proof-scope" id="proofScope">
        <button type="button" data-proof-scope="chapter" class="${scope === 'chapter' ? 'on' : ''}" ${hasChapter ? '' : 'disabled'}>当前章</button>
        <button type="button" data-proof-scope="book" class="${scope === 'book' ? 'on' : ''}">全书</button>
      </div>
      <div class="proof-sum" id="proofSum"></div>
    </div>
    <div class="proof-ignored" id="proofIgnoredBox" hidden>
      <div class="proof-ignored-head">
        <span id="proofIgnoredTitle">已忽略</span>
        <span style="flex:1"></span>
        <button class="btn btn-sm btn-text" id="proofRestoreAll">全部恢复</button>
        <button class="icon-btn sm" id="proofIgnoredClose" title="收起" aria-label="收起">${ico('x')}</button>
      </div>
      <div class="proof-ignored-list" id="proofIgnoredList"></div>
    </div>
    <div id="proofBody"></div>
    <div class="modal-foot">
      <span class="proof-note">本地规则 · 不会自动修改正文</span>
      <button class="btn btn-primary" id="proofClose">关闭</button>
    </div>`, (b) => {
    b.querySelector('#proofClose').onclick = closeModal;
    b.querySelector('#proofRestoreAll').onclick = () => { saveIgnoreList([]); render(); };
    b.querySelector('#proofIgnoredClose').onclick = () => { b.querySelector('#proofIgnoredBox').hidden = true; };
    b.querySelectorAll('[data-proof-scope]').forEach((btn) => {
      btn.onclick = () => {
        if (btn.disabled) return;
        scope = btn.dataset.proofScope;
        filter = 'all';
        limit = PROOF_PAGE;
        groupScroll = 0;
        report = buildProofReport(S.novel, scope, S.chapterId);
        b.querySelectorAll('[data-proof-scope]').forEach((x) => x.classList.toggle('on', x === btn));
        render();
      };
    });
  }, { wide: true });

  const sumEl = box.querySelector('#proofSum');
  const bodyEl = box.querySelector('#proofBody');
  const ignoredBox = box.querySelector('#proofIgnoredBox');
  const ignoredListEl = box.querySelector('#proofIgnoredList');
  const ignoredTitleEl = box.querySelector('#proofIgnoredTitle');
  const chapterMap = () => new Map(report.chapters.map((ch) => [ch.id, ch]));

  // 忽略清单：作者认定是误报的，以后不再提示（跟着作品走，换机器也在）
  const ignoreList = () => (Array.isArray(S.novel.meta?.proofIgnored) ? S.novel.meta.proofIgnored : []);
  const saveIgnoreList = (list) => {
    S.novel.meta = { ...(S.novel.meta || {}), proofIgnored: list };
    saveNovelPart({ meta: S.novel.meta });
  };
  const ignoreIssue = (issue) => {
    const list = ignoreList();
    if (list.some((x) => x.key === issue.key)) return;
    list.push({
      key: issue.key, type: issue.type, message: issue.message,
      snippet: String(issue.snippet || '').slice(0, 60),
      no: issue.no, title: issue.title, ts: Date.now(),
    });
    saveIgnoreList(list.slice(-500));
    render();
  };
  const restoreIssue = (key) => {
    saveIgnoreList(ignoreList().filter((x) => x.key !== key));
    render();
  };

  const render = () => {
    const ignored = new Set(ignoreList().map((x) => x.key));
    const allIssues = report.issues.filter((issue) => !ignored.has(issue.key));
    const hidden = report.issues.length - allIssues.length;
    const total = allIssues.length;
    const counts = { punct: 0, quote: 0, typo: 0, ending: 0 };
    for (const issue of allIssues) counts[issue.type] = (counts[issue.type] || 0) + 1;
    const filtered = filter === 'all' ? allIssues : allIssues.filter((issue) => issue.type === filter);
    const shown = filtered.map((issue, idx) => ({ issue, idx })).slice(0, limit);
    const groupCounts = new Map();
    for (const issue of filtered) groupCounts.set(issue.chId, (groupCounts.get(issue.chId) || 0) + 1);
    const chapters = chapterMap();

    sumEl.innerHTML = `扫描 <b>${report.chapters.length}</b> 章 · ${fmtWords(report.words)} 字 · 发现 <b>${total}</b> 处`
      + (hidden ? `　·　<button type="button" class="proof-link" id="proofShowIgnored">已忽略 ${hidden} 处</button>` : '');

    // 已忽略清单
    const list = ignoreList();
    ignoredBox.hidden = !list.length;
    if (list.length) {
      ignoredTitleEl.textContent = `已忽略 ${list.length} 处`;
      ignoredListEl.innerHTML = list.slice().reverse().map((x) => `
        <div class="proof-ignored-row">
          <span class="proof-kind k-${esc(x.type)}">${esc(PROOF_KINDS[x.type] || '问题')}</span>
          <span class="proof-main">
            <span class="proof-msg">${esc(x.message)}</span>
            <span class="proof-snippet">第 ${x.no} 章 · ${esc(x.title || '')}</span>
          </span>
          <button type="button" class="btn btn-sm btn-text" data-proof-restore="${esc(x.key)}">恢复</button>
        </div>`).join('');
    }

    if (!total) {
      bodyEl.innerHTML = `<div class="proof-empty"><b>${report.words ? '没有发现明显问题' : '没有可校对的正文'}</b><span>${report.words ? '标点、引号和段落收尾都在规则范围内。' : '先写一点正文，再回来校对。'}</span></div>`;
      return;
    }

    const filterDefs = [
      { key: 'all', label: '全部', count: total },
      ...Object.entries(PROOF_KINDS)
        .map(([key, label]) => ({ key, label, count: counts[key] || 0 }))
        .filter((item) => item.count > 0),
    ];
    const filters = filterDefs.map((item) => `<button type="button" class="proof-filter${filter === item.key ? ' on' : ''}" data-proof-filter="${item.key}">${item.label}<b>${item.count}</b></button>`).join('');

    const groups = new Map();
    for (const item of shown) {
      let group = groups.get(item.issue.chId);
      if (!group) {
        group = { chId: item.issue.chId, no: item.issue.no, title: item.issue.title, rows: [] };
        groups.set(item.issue.chId, group);
      }
      group.rows.push(item);
    }

    let html = `<div class="proof-filters">${filters}</div><div class="proof-groups">`;
    for (const group of groups.values()) {
      const ch = chapters.get(group.chId);
      const capped = ch?.capped ? ` · 仅显示前 ${PROOF_MAX_CHAPTER_ISSUES} 条` : '';
      html += `<section class="proof-group">
        <div class="proof-group-head"><span>第 ${group.no} 章 · ${esc(group.title)}</span><em>${groupCounts.get(group.chId) || 0} 处${capped}</em></div>`;
      html += group.rows.map(({ issue, idx }) => `<div class="proof-row-wrap">
        <button type="button" class="proof-row" data-proof-row="${idx}" title="跳到正文并选中">
          <span class="proof-kind k-${esc(issue.type)}">${esc(PROOF_KINDS[issue.type] || '问题')}</span>
          <span class="proof-main">
            <span class="proof-msg">${esc(issue.message)}</span>
            ${issue.snippet ? `<span class="proof-snippet">${proofSnippetHtml(issue)}</span>` : ''}
          </span>
          <span class="proof-loc">${esc(issue.loc || '全章')}</span>
        </button>
        <button type="button" class="proof-ignore" data-proof-ignore="${idx}" title="忽略这一处（以后不再提示）">忽略</button>
      </div>`).join('');
      html += '</section>';
    }
    html += '</div>';
    if (filtered.length > limit) {
      html += `<button type="button" class="btn btn-sm proof-more" id="proofMore">再显示 ${Math.min(PROOF_PAGE, filtered.length - limit)} 处</button>`;
    }
    bodyEl.innerHTML = html;
    const groupsEl = bodyEl.querySelector('.proof-groups');
    if (groupsEl) groupsEl.scrollTop = groupScroll;

    bodyEl.querySelectorAll('[data-proof-filter]').forEach((btn) => {
      btn.onclick = () => {
        filter = btn.dataset.proofFilter;
        limit = PROOF_PAGE;
        groupScroll = 0;
        render();
      };
    });
    bodyEl.querySelectorAll('[data-proof-row]').forEach((btn) => {
      btn.onclick = () => {
        const issue = filtered[Number(btn.dataset.proofRow)];
        if (issue) jumpToHit(issue.chId, issue.start, Math.max(0, issue.end - issue.start));
      };
    });
    bodyEl.querySelectorAll('[data-proof-ignore]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const issue = filtered[Number(btn.dataset.proofIgnore)];
        if (issue) ignoreIssue(issue);
      };
    });
    // 已忽略清单在另一个容器里，得从它自己身上找
    ignoredListEl.querySelectorAll('[data-proof-restore]').forEach((btn) => {
      btn.onclick = () => restoreIssue(btn.dataset.proofRestore);
    });
    const showIgnored = sumEl.querySelector('#proofShowIgnored');
    if (showIgnored) showIgnored.onclick = () => { ignoredBox.hidden = !ignoredBox.hidden; };
    const more = bodyEl.querySelector('#proofMore');
    if (more) more.onclick = () => {
      const groupsEl2 = bodyEl.querySelector('.proof-groups');
      groupScroll = groupsEl2 ? groupsEl2.scrollTop : 0;
      limit += PROOF_PAGE;
      render();
    };
  };

  render();
}

$('#proofBtn')?.addEventListener('click', openProof);

/* ============================================================
 * 4.6 分卷：章节目录按卷归组
 * ------------------------------------------------------------
 * 卷本身存在「设定 → 分卷与章纲」里（novel.outline.volumes），这里负责
 * 把章节列表按卷折叠显示，以及就地调整「哪几章归哪一卷」。
 * 归属规则（跟服务端 store.js 的 chapterVolumeIds 是同一套）：
 *   本章或前面章节的显式标记 ＞ 章纲归属（outlineId 落在哪一卷）＞ 未分卷
 * 于是作者只在一卷的第一章上打个标记，后面几十章跟着走，换卷时再打一个；
 * volumeId === '-' 表示「明确不算任何卷」，只影响那一章。
 * ============================================================ */
const volToggled = new Map();      // 卷 id → 作者手动展开/收起（没点过的按默认来）

/** 每章归属的卷 id（与 S.novel.chapters 等长），'' 表示未分卷。规则见 server/store.js 的 chapterVolumeIds */
function effVolumeIds() {
  const n = S.novel;
  if (!n) return [];
  const byOutline = new Map();
  for (const v of (n.outline?.volumes || [])) {
    for (const o of (v.chapters || [])) if (o?.id) byOutline.set(o.id, v.id || '');
  }
  const known = new Set((n.outline?.volumes || []).map((v) => v.id).filter(Boolean));
  let inherit = '';
  return n.chapters.map((c) => {
    const raw = typeof c.volumeId === 'string' ? c.volumeId : null;
    const own = raw === null ? null : raw === '' || raw === '-' ? '' : known.has(raw) ? raw : null;
    if (own !== null) { inherit = own; return own; }
    const o = c.outlineId ? byOutline.get(c.outlineId) : '';
    if (o) { inherit = o; return o; }
    return inherit;
  });
}

const volumesOf = () => (S.novel?.outline?.volumes || []);
const volumeById = (id) => volumesOf().find((v) => v.id === id) || null;
function volumeNo(id) {
  const i = volumesOf().findIndex((v) => v.id === id);
  return i < 0 ? 0 : i + 1;
}
/** 「第 2 卷 · 少年游」；卷名本身就是「第 2 卷」时不再重复前缀；查不到卷时给空串 */
function volumeTitle(id) {
  const v = volumeById(id);
  if (!v) return '';
  const no = volumeNo(id);
  const name = String(v.name || '').trim();
  if (!name || name === `第 ${no} 卷` || name === `第${no}卷` || name === String(no)) return `第 ${no} 卷`;
  return `第 ${no} 卷 · ${name}`;
}

/** 长篇默认只展开当前章所在的那一卷，短篇全展开 */
function isVolOpen(vid) {
  if (volToggled.has(vid)) return volToggled.get(vid);
  const n = S.novel;
  if (!n || n.chapters.length <= 40) return true;
  const i = n.chapters.findIndex((c) => c.id === S.chapterId);
  return vid === (i >= 0 ? effVolumeIds()[i] : '');
}

function toggleVol(vid) {
  volToggled.set(vid, !isVolOpen(vid));
  renderStudio();
}

/** 当前书里实际出现的卷分组（含未分卷 ''），用于全局展开 / 收起 */
function volumeGroupIds() {
  return [...new Set(effVolumeIds())];
}

/** 章节栏的全局按钮：只在「至少两个卷分组」且没有搜索 / 筛选时出现。
 *  搜索 / 筛选会把列表压平成命中章节，这时卷折叠没有意义。 */
function updateVolExpandButton() {
  const btn = $('#volExpandBtn');
  if (!btn) return;
  const vids = S.novel && !S.stageFilter && !S.chapterSearch.trim() ? volumeGroupIds() : [];
  const show = vids.length >= 2;
  btn.hidden = !show;
  if (!show) return;
  const label = vids.every((vid) => isVolOpen(vid)) ? '收起全部卷' : '展开全部卷';
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

/** 全部展开 / 全部收起：只要还有一卷收着就全开，已经全开则全收 */
function toggleAllVolumes() {
  const vids = volumeGroupIds();
  if (vids.length < 2) return;
  const open = !vids.every((vid) => isVolOpen(vid));
  vids.forEach((vid) => volToggled.set(vid, open));
  renderStudio();
}

/** 建一个分卷分组容器，返回往里放章节的 <ul> */
function volGroupEl(ul, vid, group) {
  const v = volumeById(vid);
  const open = isVolOpen(vid);
  const li = document.createElement('li');
  li.className = `vol-group${open ? '' : ' closed'}`;
  const words = group.chapters.reduce((s, c) => s + wordsOf(c), 0);
  li.innerHTML = `
    <div class="vol-head" title="${open ? '点击收起这一卷' : '点击展开这一卷'}">
      <button class="vol-toggle" type="button">${ico('chev-down')}</button>
      <span class="vol-name">${v ? esc(volumeTitle(vid)) : '未分卷'}</span>
      <span class="vol-stat">${group.chapters.length} 章 · ${fmtWords(words)} 字</span>
      <button class="mini-act" data-a="vmenu" type="button" title="本卷操作" aria-label="本卷操作">${ico('more')}</button>
    </div>
    <ul class="vol-items"></ul>`;
  const toggle = () => toggleVol(vid);
  li.querySelector('.vol-toggle').addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  li.querySelector('.vol-head').addEventListener('click', (e) => { if (!e.target.closest('.mini-act')) toggle(); });
  li.querySelector('[data-a="vmenu"]').addEventListener('click', (e) => { e.stopPropagation(); openVolumeGroupMenu(e.currentTarget, vid, group); });
  ul.appendChild(li);
  return li.querySelector('.vol-items');
}

/** 只改卷归属：走单独的接口，避免整本回传时把正在编辑的正文一起覆盖掉 */
async function saveChapterVolumes(sets) {
  const n = S.novel;
  if (!n || !sets.length) return;
  try { await api.send(`/api/novels/${n.id}/chapter-volume`, { set: sets }); }
  catch (err) { toast(`分卷没保存成功：${err.message}`, 'err'); }
}

/**
 * 把第 index 章改成归入 volId（'' 表示未分卷）。
 * 明确值只作用于写下的那一章；但「下一章」如果原本只是跟着上一章走，
 * 会跟着一起变 —— 所以顺手把它的归属写死，只挪一章不会带走后面几十章。
 */
function setChapterVolume(index, volId, { pinAfter = index + 1 } = {}) {
  const n = S.novel;
  const ch = n?.chapters[index];
  if (!ch) return Promise.resolve();
  const eff = effVolumeIds();
  const sets = [];
  const val = volId || '';
  if (ch.volumeId !== val) { ch.volumeId = val; sets.push({ id: ch.id, volumeId: val }); }
  const next = pinAfter >= 0 ? n.chapters[pinAfter] : null;
  if (next && typeof next.volumeId !== 'string') {      // 只有「跟着上一章」的那种才需要钉
    const keep = eff[pinAfter] || '';
    next.volumeId = keep;
    sets.push({ id: next.id, volumeId: keep });
  }
  renderStudio();
  return saveChapterVolumes(sets);
}

/** 把 [from, to] 逐章写成同一种归属：整段操作一律走这里，避免依赖「跟着上一章」带来的连带变化 */
function assignRange(from, to, volId) {
  const n = S.novel;
  if (!n) return Promise.resolve();
  const val = volId || '';
  const sets = [];
  for (let i = from; i <= Math.min(to, n.chapters.length - 1); i += 1) {
    const ch = n.chapters[i];
    if (!ch || ch.volumeId === val) continue;
    ch.volumeId = val;
    sets.push({ id: ch.id, volumeId: val });
  }
  renderStudio();
  return saveChapterVolumes(sets);
}

/** 从 index 起、到「它所在的这一段」结束，整段改成 volId（用于「从此章起新的一卷」） */
function assignRunFrom(index, volId) {
  const eff = effVolumeIds();
  const cur = eff[index] || '';
  let to = index;
  while (to + 1 < eff.length && (eff[to + 1] || '') === cur) to += 1;
  return assignRange(index, to, volId);
}

/** 把 [from, to] 的手动归属清掉：这些章回到「按章纲归组 / 跟着上一章」 */
async function clearRangeVolume(from, to) {
  const n = S.novel;
  if (!n) return;
  const sets = [];
  for (let i = from; i <= Math.min(to, n.chapters.length - 1); i += 1) {
    const ch = n.chapters[i];
    if (!ch || typeof ch.volumeId !== 'string') continue;
    delete ch.volumeId;
    sets.push({ id: ch.id, volumeId: null });
  }
  renderStudio();
  return saveChapterVolumes(sets);
}

/** 这本书有没有章纲（有才谈得上「按章纲归组」） */
const hasOutlineChapters = () => volumesOf().some((v) => (v.chapters || []).length > 0);

/** 根据当前章节反推：它前面最近一个不同的卷（用于「并入上一卷」） */
function neighborVolume(eff, index, dir) {
  const cur = eff[index] || '';
  for (let i = index + dir; i >= 0 && i < eff.length; i += dir) {
    const v = eff[i] || '';
    if (v !== cur) return { id: v, index: i };
  }
  return null;
}

/** 改某一章的状态（不必先切到这一章） */
function setChapterStage(index, stage) {
  const ch = S.novel?.chapters[index];
  if (!ch || !STAGE_LABEL[stage] || stageOf(ch) === stage) return;
  ch.stage = stage;
  markChapterDirty(ch);
  renderStudio();
  toast(`第 ${index + 1} 章已标为「${STAGE_LABEL[stage]}」`, 'ok');
}

/** 把某一章移动到任意位置（1-based 输入，实际按下标处理） */
function openMoveChapterModal(index) {
  const n = S.novel;
  const ch = n?.chapters[index];
  if (!ch) return;
  const max = n.chapters.length;
  showModal(`<h3>移动章节</h3>
    <p class="modal-sub">把第 ${index + 1} 章「${esc(ch.title || '未命名')}」放到指定位置。分卷归属会跟着位置一起调整。</p>
    <label class="field-label">目标位置（1 – ${max}）
      <input id="movePos" class="input" type="number" min="1" max="${max}" step="1" inputmode="numeric" value="${index + 1}" />
    </label>
    <div class="dim small" id="moveHint">当前位于第 ${index + 1} 位。</div>
    <div class="modal-foot">
      <button class="btn btn-text" id="moveCancel">取消</button>
      <button class="btn btn-primary" id="moveOk">移动</button>
    </div>`, (box) => {
    const posEl = box.querySelector('#movePos');
    const hintEl = box.querySelector('#moveHint');
    const okBtn = box.querySelector('#moveOk');
    const sync = () => {
      const pos = Number(posEl.value);
      const valid = Number.isInteger(pos) && pos >= 1 && pos <= max;
      okBtn.disabled = !valid || pos === index + 1;
      hintEl.textContent = !valid
        ? `请输入 1 – ${max} 之间的整数。`
        : pos === index + 1 ? '已经在目标位置。' : `移动后位于第 ${pos} 位。`;
    };
    posEl.addEventListener('input', sync);
    posEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !okBtn.disabled) okBtn.click();
    });
    posEl.focus();
    posEl.select();
    box.querySelector('#moveCancel').onclick = closeModal;
    okBtn.onclick = async () => {
      const pos = Number(posEl.value);
      if (okBtn.disabled) return;
      closeModal();
      const ok = await moveChapter(index, pos - 1);
      if (ok) toast(`已移动到第 ${pos} 位`, 'ok');
    };
    sync();
  });
}

/** 章节右侧 ⋯ 菜单：查看记忆 / 调整这一章归哪一卷、状态 */
function openChapterMenu(anchor, index) {
  const eff = effVolumeIds();
  const cur = eff[index] || '';
  const prev = neighborVolume(eff, index, -1);
  const next = neighborVolume(eff, index, 1);
  const label = (x) => (x ? (volumeTitle(x.id) || '未分卷') : '未分卷');
  const ch = S.novel?.chapters[index];
  const stage = stageOf(ch);
  const listFiltered = !!S.stageFilter || !!S.chapterSearch.trim();
  showPop(anchor, [
    { label: ch?.memory ? '查看章节记忆' : '新建章节记忆', disabled: !ch, run: () => ch && (ch.memory ? openMemoryModal(ch) : openMemoryEditor(ch)) },
    '-',
    { label: `并入上一卷（${label(prev)}）`, disabled: !prev, run: () => setChapterVolume(index, prev ? prev.id : '') },
    { label: `并入下一卷（${label(next)}）`, disabled: !next, run: () => setChapterVolume(index, next ? next.id : '') },
    '-',
    { label: '从此章起新的一卷…', run: () => openVolumeModal(null, index, cur) },
    { label: cur ? '把本章移出分卷' : '不归任何卷（保持不变）', disabled: !cur, run: () => setChapterVolume(index, '') },
    '-',
    { label: `${stage === 'draft' ? '✓ ' : ''}标为草稿`, run: () => setChapterStage(index, 'draft') },
    { label: `${stage === 'revising' ? '✓ ' : ''}标为修改中`, run: () => setChapterStage(index, 'revising') },
    { label: `${stage === 'done' ? '✓ ' : ''}标为定稿`, run: () => setChapterStage(index, 'done') },
    { label: targetOf(ch) ? `改本章目标（${fmtWords(targetOf(ch))} 字）…` : '设置本章目标字数…', disabled: !ch, run: () => openChapterTargetModal(index) },
    '-',
    { label: '拆分本章…', run: () => openSplitChapterModal(index) },
    { label: '合并本章…', disabled: index >= (S.novel?.chapters.length || 0) - 1, run: () => openMergeChapterModal(index) },
    '-',
    { label: listFiltered ? '上移本章（先清除搜索 / 筛选）' : '上移本章', disabled: listFiltered || index === 0, run: () => moveChapter(index, index - 1) },
    { label: listFiltered ? '下移本章（先清除搜索 / 筛选）' : '下移本章', disabled: listFiltered || index >= (S.novel?.chapters.length || 0) - 1, run: () => moveChapter(index, index + 1) },
    { label: listFiltered ? '移动到指定位置…（先清除搜索 / 筛选）' : '移动到指定位置…', disabled: listFiltered, run: () => openMoveChapterModal(index) },
  ]);
}

/** 设置单章目标字数：只影响进度提示，不限制正文长度 */
function openChapterTargetModal(index) {
  const n = S.novel;
  const ch = n?.chapters[index];
  if (!ch) return toast('先打开一章', 'err');
  const words = wordsOf(ch);
  const currentTarget = targetOf(ch);
  const defaultTarget = Math.max(0, Math.floor(Number(n.meta?.targetWordsPerChapter) || 0));
  const presets = [...new Set([defaultTarget, 3000, 5000, 10000])]
    .filter((v) => v > 0 && v <= 1000000);

  showModal(`<h3>设置本章目标</h3>
    <p class="modal-sub">第 ${index + 1} 章「${esc(ch.title || '未命名')}」· 当前 ${fmtWords(words)} 字。<br>目标只用于进度提示，不会限制你写多少；留空或 0 表示不设。</p>
    <label class="field-label">目标字数
      <input class="input" id="tgWords" type="number" min="0" max="1000000" step="100" value="${currentTarget || ''}" placeholder="${defaultTarget ? `例如 ${defaultTarget}` : '留空表示不设目标'}" />
    </label>
    <div class="tg-presets" id="tgPresets">
      ${presets.map((v) => `<button type="button" class="tg-preset" data-v="${v}">${fmtWords(v)} 字</button>`).join('')}
    </div>
    <div class="tg-preview">
      <div class="tg-preview-head"><span id="tgPreviewText"></span><span id="tgPreviewPct"></span></div>
      <div class="tg-preview-bar"><span id="tgPreviewFill"></span></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-text" id="tgClear" ${currentTarget ? '' : 'hidden'}>清除目标</button>
      <button class="btn btn-text" id="tgCancel">取消</button>
      <button class="btn btn-primary" id="tgSave">保存目标</button>
    </div>`, (box) => {
    const input = box.querySelector('#tgWords');
    const previewText = box.querySelector('#tgPreviewText');
    const previewPct = box.querySelector('#tgPreviewPct');
    const previewFill = box.querySelector('#tgPreviewFill');

    const sync = () => {
      const target = Math.max(0, Math.min(1000000, Math.floor(Number(input.value) || 0)));
      const pct = target ? Math.min(100, Math.round((words / target) * 100)) : 0;
      previewText.textContent = target ? `${fmtWords(words)} / ${fmtWords(target)} 字` : `当前 ${fmtWords(words)} 字 · 未设目标`;
      previewPct.textContent = target ? `${pct}%` : '—';
      previewFill.style.width = `${pct}%`;
      previewFill.classList.toggle('done', target > 0 && words >= target);
    };

    const commit = (value) => {
      const target = Math.max(0, Math.min(1000000, Math.floor(Number(value) || 0)));
      if (target === currentTarget) {
        closeModal();
        return;
      }
      ch.targetWords = target;
      markChapterDirty(ch);
      closeModal();
      renderStudio();
      toast(target
        ? `第 ${index + 1} 章目标设为 ${fmtWords(target)} 字`
        : `已清除第 ${index + 1} 章目标`, 'ok');
    };

    input.addEventListener('input', sync);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(input.value); }
    });
    box.querySelectorAll('.tg-preset').forEach((btn) => {
      btn.onclick = () => { input.value = btn.dataset.v; sync(); input.focus(); input.select(); };
    });
    box.querySelector('#tgCancel').onclick = closeModal;
    box.querySelector('#tgClear').onclick = () => commit(0);
    box.querySelector('#tgSave').onclick = () => commit(input.value);
    sync();
    input.focus();
    input.select();
  });
}

/** 卷标题上的 ⋯ 菜单：编辑 / 删除 / 整段并入邻卷 */
function openVolumeGroupMenu(anchor, vid, group) {
  const v = volumeById(vid);
  const eff = effVolumeIds();
  const prev = neighborVolume(eff, group.from, -1);
  const next = neighborVolume(eff, group.to, 1);
  // 整段操作：把这一段逐章写成目标归属（不依赖继承，段外章节分毫不动）
  const intoPrev = () => assignRange(group.from, group.to, prev ? prev.id : '');
  const intoNext = () => assignRange(group.from, group.to, next ? next.id : '');
  const lab = (x) => (x ? volumeTitle(x.id) || '未分卷' : '没有');
  const items = [];
  if (hasOutlineChapters()) items.push({ label: '这一段改回跟着章纲走（清除手动分卷）', run: () => clearRangeVolume(group.from, group.to) });
  if (v) {
    items.push({ label: '编辑卷名与卷纲…', run: () => openVolumeModal(vid) });
    items.push({ label: '去「设定」里编辑章纲', run: () => gotoSettingsVolume(vid) });
    items.push('-');
    items.push({ label: `把这一段并入上一卷（${lab(prev)}）`, disabled: !prev, run: intoPrev });
    items.push({ label: `把这一段并入下一卷（${lab(next)}）`, disabled: !next, run: intoNext });
    items.push('-');
    items.push({ label: '删除这一卷（章节保留）', run: () => deleteVolume(vid) });
  } else {
    items.push({ label: `把这一段并入上一卷（${lab(prev)}）`, disabled: !prev, run: intoPrev });
    items.push({ label: `把这一段并入下一卷（${lab(next)}）`, disabled: !next, run: intoNext });
    items.push('-');
    items.push({ label: '从这一段起新的一卷…', run: () => openVolumeModal(null, group.from, '') });
  }
  showPop(anchor, items);
}

/** 把当前章在光标/段落处拆成两章 */
function openSplitChapterModal(index) {
  const n = S.novel;
  if (!n) return toast('先打开作品', 'err');
  const ch = n.chapters[index];
  if (!ch) return;
  const content = ch.content || '';
  if (!content.trim()) return toast('本章是空的，没法拆', 'err');

  // 预先把编辑器里的光标位置记下来（如果正在编辑这一章）
  let cursorPos = -1;
  if (S.chapterId === ch.id) {
    const ta = $('#chContent');
    if (ta) cursorPos = ta.selectionStart;
  }

  // 按段落切分预览
  const paragraphs = content.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const paraOptions = paragraphs.map((p, i) => {
    const preview = p.length > 60 ? p.slice(0, 60) + '…' : p;
    return `<option value="${i}">段落 ${i + 1}：${esc(preview)}</option>`;
  }).join('');

  // 捕获关键 ID，防止后续异步过程中 S.novel 变化导致引用失效
  const novelId = n.id;
  const chapterId = ch.id;
  const chapterTitle = ch.title;
  const chapterStage = ch.stage;
  const chapterVolId = ch.volumeId || '';
  const chapterTarget = targetOf(ch);

  showModal(`<h3>拆分第 ${index + 1} 章</h3>
    <p class="modal-sub">把正文从某个位置「剪」成两章。前半段留在本章，后半段自动新建下一章。</p>
    <label class="field-label">拆分位置
      <select class="input" id="splitMode">
        <option value="cursor"${cursorPos >= 0 ? ' selected' : ''}>光标所在位置${cursorPos >= 0 ? `（第 ${cursorPos} 字符）` : '（当前章无光标，将在中间拆分）'}</option>
        <option value="middle">正文中间（字符数对半）</option>
        ${paraOptions ? `<option value="paragraph">按段落拆分…</option>` : ''}
      </select>
    </label>
    <div id="paraRow" class="field-label" style="${paraOptions ? '' : 'display:none'}">
      <label>在第几段之后拆分
        <select class="input" id="splitPara">${paraOptions}</select>
      </label>
    </div>
    <label class="field-label">新章标题
      <input class="input" id="newTitle" placeholder="留空自动生成「原标题（下）」" />
    </label>
    <p class="dim small">拆分后：原章保留前半段，新章承接后半段；分卷归属、阶段均继承原章。记忆不会自动拆分，请事后手动补全；修订清单留在原章，落在后半段的引文可到新章重新添加。</p>
    <div class="modal-foot">
      <button class="btn btn-text" id="splitCancel">取消</button>
      <button class="btn btn-primary" id="splitOk">拆分</button>
    </div>`, (box) => {
    const modeEl = box.querySelector('#splitMode');
    const paraRow = box.querySelector('#paraRow');
    const paraEl = box.querySelector('#splitPara');
    const titleEl = box.querySelector('#newTitle');

    modeEl.onchange = () => {
      paraRow.style.display = modeEl.value === 'paragraph' ? '' : 'none';
    };

    box.querySelector('#splitCancel').onclick = closeModal;
    box.querySelector('#splitOk').onclick = async () => {
      const mode = modeEl.value;
      let splitAt = -1;

      if (mode === 'cursor') {
        splitAt = cursorPos >= 0 ? cursorPos : Math.floor(content.length / 2);
      } else if (mode === 'middle') {
        splitAt = Math.floor(content.length / 2);
        // 向最近的段落边界靠拢（避免把一段拦腰斩断）
        const before = content.slice(0, splitAt);
        const lastBreak = before.lastIndexOf('\n\n');
        if (lastBreak > splitAt * 0.3) splitAt = lastBreak + 2;
      } else if (mode === 'paragraph') {
        const pi = Number(paraEl.value);
        // 找到第 pi 段在原文中的结束位置
        let walked = 0;
        for (let i = 0; i <= pi && i < paragraphs.length; i++) {
          const p = paragraphs[i];
          const idx = content.indexOf(p, walked);
          if (idx >= 0) walked = idx + p.length;
        }
        splitAt = walked;
      }

      if (splitAt <= 0 || splitAt >= content.length) {
        return toast('拆分位置不合法', 'err');
      }

      const first = content.slice(0, splitAt).trimEnd();
      const second = content.slice(splitAt).trimStart();
      if (!first && !second) return toast('拆分后两边都是空的', 'err');

      const newTitle = titleEl.value.trim() || `${chapterTitle}（下）`;
      // 目标按拆出的正文比例分给两章，至少保证总和不变
      const firstTarget = chapterTarget ? Math.round((chapterTarget * first.length) / content.length) : 0;
      const secondTarget = chapterTarget ? chapterTarget - firstTarget : 0;

      // 1) 先只保存当前章的前半段（避免 flushSave 连带保存其它待存章节导致竞态）
      const currentCh = S.novel?.chapters.find((c) => c.id === chapterId);
      if (!currentCh) return toast('原章已不存在', 'err');
      currentCh.content = first;
      currentCh.targetWords = firstTarget;
      markChapterDirty(currentCh);
      await saveChapterNow(chapterId);

      // 2) 创建新章（插在原章之后）
      const insertAt = (S.novel?.chapters.findIndex((c) => c.id === chapterId) ?? -1) + 1;
      const res = await api.send(`/api/novels/${novelId}/chapters`, {
        title: newTitle,
        content: second,
        volumeId: chapterVolId,
        stage: chapterStage,
        targetWords: secondTarget,
        at: insertAt,
      }, 'POST');
      if (!res.chapter) return toast('新章创建失败', 'err');

      // 3) 同步 novel 数据并切到新章
      if (res.novel) S.novel = res.novel;
      S.chapterId = res.chapter.id;
      clearFiltersHidingChapter(res.chapter.id);   // 新标题 / 新章号可能不匹配当前搜索
      closeModal();
      renderStudio();
      toast(`已拆分为「${esc(chapterTitle)}」+「${esc(newTitle)}」`, 'ok');
    };
  });
}

/** 合并当前章与下一章 */
function openMergeChapterModal(index) {
  const n = S.novel;
  if (!n) return toast('先打开作品', 'err');
  const ch = n.chapters[index];
  const nextCh = n.chapters[index + 1];
  if (!ch || !nextCh) return toast('无法合并：没有下一章', 'err');

  const novelId = n.id;
  const chapterId = ch.id;
  const nextChapterId = nextCh.id;
  const chapterTitle = ch.title;
  const nextTitle = nextCh.title;
  const chapterVolId = ch.volumeId || '';
  const chapterStage = ch.stage;

  // 预览合并后的标题
  const defaultTitle = `${chapterTitle} + ${nextTitle}`;

  showModal(`<h3>合并第 ${index + 1} 章与第 ${index + 2} 章</h3>
    <p class="modal-sub">把两章合为一章。原标题、正文会拼接；分卷归属、阶段以当前章为准。被合并的章节会被删除（其记忆/章纲不保留，修订清单会合并保留）。</p>
    <label class="field-label">合并后标题
      <input class="input" id="mergeTitle" value="${esc(defaultTitle)}" placeholder="留空自动生成" />
    </label>
    <label class="field-label">正文连接符
      <select class="input" id="mergeSep">
        <option value="blank">空行（\\n\\n）</option>
        <option value="hr">分割线（---）</option>
        <option value="none">直接拼接</option>
      </select>
    </label>
    <p class="dim small">合并后：当前章保留合并后的内容与标题；下一章被删除。记忆与章纲不会自动合并，请事后手动补全；两边的修订清单会合并到当前章。</p>
    <div class="modal-foot">
      <button class="btn btn-text" id="mergeCancel">取消</button>
      <button class="btn btn-primary" id="mergeOk">合并</button>
    </div>`, (box) => {
    const titleEl = box.querySelector('#mergeTitle');
    const sepEl = box.querySelector('#mergeSep');

    box.querySelector('#mergeCancel').onclick = closeModal;
    box.querySelector('#mergeOk').onclick = async () => {
      const newTitle = titleEl.value.trim() || defaultTitle;
      const sepMode = sepEl.value;
      const separator = sepMode === 'blank' ? '\n\n' : (sepMode === 'hr' ? '\n\n---\n\n' : '');

      // 1) 备份一下当前章（防止后悔）
      await snapshotNow('合并前备份');

      // 2) 合并内容
      const mergedContent = (ch.content || '') + separator + (nextCh.content || '');

      // 3) 更新当前章：两边的修订清单都保留，别让被合并章节的待改项跟着蒸发
      const nextRevs = Array.isArray(nextCh.revisions) ? nextCh.revisions : [];
      if (nextRevs.length) {
        // 引文锚点原来相对「下一章」正文，合并后要整体平移到合并稿里的位置
        const offset = (ch.content || '').length + separator.length;
        const shifted = nextRevs.map((rev) => (rev && rev.quote ? { ...rev, at: (Number(rev.at) || 0) + offset } : rev));
        ch.revisions = [...(Array.isArray(ch.revisions) ? ch.revisions : []), ...shifted];
      }
      ch.content = mergedContent;
      ch.title = newTitle;
      ch.targetWords = Math.min(1000000, targetOf(ch) + targetOf(nextCh));
      markChapterDirty(ch);
      await saveChapterNow(chapterId);

      // 4) 删除下一章
      const res = await api.del(`/api/novels/${novelId}/chapters/${nextChapterId}`);
      if (!res.novel) return toast('删除下一章失败', 'err');
      S.novel = res.novel;

      // 5) 刷新
      clearFiltersHidingChapter(chapterId);   // 合并后标题可能不再匹配当前搜索
      closeModal();
      renderStudio();
      toast(`已合并为「${esc(newTitle)}」`, 'ok');
    };
  });
}

/** 设定库渲染是异步的（切页签会先拉一次最新作品），目标元素可能要等几帧才出现 */
function flashBibleTarget(find, attempt = 0) {
  const el = find();
  if (!el) {
    if (attempt < 20) requestAnimationFrame(() => flashBibleTarget(find, attempt + 1));
    return;
  }
  el.scrollIntoView({ block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1400);
}

function gotoSettingsVolume(vid) {
  S.bibleSearch.outline = '';   // 搜索过滤时目标卷可能被藏起来，先恢复完整列表
  setView('bible');
  if (bibleTab !== 'outline') $('#bibleTabs button[data-bible="outline"]')?.click();
  const i = volumesOf().findIndex((v) => v.id === vid);
  flashBibleTarget(() => {
    const block = $$('#volList .vol-block').find((el) => el.dataset.volId === vid) || $$('#volList .vol-block')[i];
    // 卷可能很长，滚到卷标题而不是整卷中心，否则标题会被顶到视口外
    return block?.querySelector('.vol-head') || block;
  });
}

/** 从写作栏跳到设定库里对应的那条章纲，闪一下，便于继续编辑 */
function gotoSettingsOutline(outlineId) {
  const ref = findOutlineRef(S.novel, outlineId);
  if (!ref) return toast('这条章纲已经不在设定库里了', 'err');
  S.bibleSearch.outline = '';   // 搜索过滤时目标章纲可能被藏起来，先恢复完整列表
  setView('bible');
  if (bibleTab !== 'outline') $('#bibleTabs button[data-bible="outline"]')?.click();
  flashBibleTarget(() => $$('#volList .outline-row').find((el) => el.dataset.outlineId === outlineId)
    || $$('#volList .vol-block')[ref.volIndex]?.querySelectorAll('.outline-row')[ref.index]);
}

/** 新建 / 编辑一卷。startIndex >= 0 表示「从这一章起归入新卷」 */
function openVolumeModal(vid, startIndex = -1, inheritFrom = '') {
  const n = S.novel;
  if (!n) return;
  n.outline.volumes ||= [];
  const vols = n.outline.volumes;
  const v = vid ? volumeById(vid) : null;
  const creating = !v;
  const seq = vols.length + 1;
  const hint = creating && startIndex >= 0
    ? `从第 ${startIndex + 1} 章起归入这一卷${inheritFrom ? `（原来是「${volumeTitle(inheritFrom) || '未分卷'}」）` : ''}`
    : '卷名与卷纲会喂给 AI 当上下文；具体章纲在「设定 → 分卷与章纲」里编辑。';
  showModal(`
    <h3>${creating ? '新建分卷' : '编辑分卷'}</h3>
    <p class="modal-sub">${esc(hint)}</p>
    <label class="field-label">卷名
      <input class="input" id="volName" value="${esc(v?.name || `第 ${seq} 卷`)}" placeholder="例：第一卷 少年游" />
    </label>
    <label class="field-label">本卷定位 / 卷纲（可留空）
      <textarea class="input" id="volDesc" rows="4" placeholder="这一卷的主要冲突、人物变化、要在哪里收束">${esc(v?.desc || '')}</textarea>
    </label>
    <div class="modal-foot">
      <button class="btn btn-text" id="volCancel">取消</button>
      <button class="btn btn-primary" id="volOk">${creating ? '创建并归入' : '保存'}</button>
    </div>`, (box) => {
    const nameEl = box.querySelector('#volName');
    nameEl.focus();
    nameEl.select();
    box.querySelector('#volCancel').onclick = closeModal;
    const ok = async () => {
      const name = nameEl.value.trim() || `第 ${seq} 卷`;
      const desc = box.querySelector('#volDesc').value.trim();
      if (creating) {
        const nv = { id: uid('v'), name, desc, chapters: [] };
        vols.push(nv);
        saveNovelPart({ outline: n.outline });
        closeModal();
        // 从这一章起、到这一段结束，整段归入新卷（逐章写死，段外不动）
        if (startIndex >= 0) await assignRunFrom(startIndex, nv.id);
        else renderStudio();
        toast(`已新建「${name}」`, 'ok');
      } else {
        v.name = name;
        v.desc = desc;
        saveNovelPart({ outline: n.outline });
        closeModal();
        renderStudio();
        toast('分卷已更新', 'ok');
      }
    };
    box.querySelector('#volOk').onclick = ok;
    box.querySelector('#volDesc').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ok(); }
    });
  });
}

/** 从当前章开始新建一卷（命令面板用） */
function newVolumeFromCurrent() {
  const n = S.novel;
  if (!n) return toast('先打开作品', 'err');
  const i = n.chapters.findIndex((c) => c.id === S.chapterId);
  if (i < 0) return toast('先在章节列表里选一章', 'err');
  openVolumeModal(null, i, effVolumeIds()[i] || '');
}

/** 把某一卷名下的章节改到 target 卷（target 为空则是未分卷）；内容一个字都不动 */
async function unassignVolume(vid, target = '') {
  const n = S.novel;
  if (!n) return 0;
  const eff = effVolumeIds();
  const sets = [];
  for (let i = 0; i < eff.length; i += 1) {
    if (eff[i] !== vid) continue;
    const ch = n.chapters[i];
    if (!ch || ch.volumeId === target) continue;
    ch.volumeId = target;
    sets.push({ id: ch.id, volumeId: target });
  }
  await saveChapterVolumes(sets);
  return sets.length;
}

async function deleteVolume(vid) {
  const n = S.novel;
  const v = volumeById(vid);
  if (!n || !v) return;
  const eff = effVolumeIds();
  const first = eff.indexOf(vid);
  const count = eff.filter((x) => x === vid).length;
  const outlineCount = (v.chapters || []).length;
  if (!confirm(`删除「${v.name || '未命名'}」这一卷？\n\n该卷 ${count} 章正文会完整保留，归入上一卷（没有上一卷就变成未分卷）。\n${outlineCount ? `卷里的 ${outlineCount} 条章纲会一起删除。` : ''}`)) return;
  // 这一卷的章节整段并进上一卷
  let target = '';
  for (let i = first - 1; i >= 0; i -= 1) { if (eff[i] !== vid) { target = eff[i]; break; } }
  await unassignVolume(vid, target);
  const at = n.outline.volumes.indexOf(v);
  if (at >= 0) n.outline.volumes.splice(at, 1);
  saveNovelPart({ outline: n.outline });
  renderStudio();
  toast('已删除这一卷，章节都还在', 'ok');
}

/* --- 小浮层菜单：卷与章节操作共用 --- */
let popEl = null;
function closePop() {
  if (popEl) { popEl.remove(); popEl = null; }
}
function showPop(anchor, items) {
  closePop();
  const el = document.createElement('div');
  el.className = 'popmenu';
  for (const it of items) {
    if (it === '-') { el.insertAdjacentHTML('beforeend', '<div class="popmenu-sep"></div>'); continue; }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'popmenu-item';
    b.textContent = it.label;
    b.disabled = !!it.disabled;
    b.addEventListener('click', () => { closePop(); it.run(); });
    el.appendChild(b);
  }
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(r.left - 6, window.innerWidth - el.offsetWidth - 10))}px`;
  el.style.top = `${Math.max(8, Math.min(r.bottom + 4, window.innerHeight - el.offsetHeight - 10))}px`;
  popEl = el;
}
document.addEventListener('mousedown', (e) => { if (popEl && !popEl.contains(e.target)) closePop(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });
window.addEventListener('resize', closePop);
window.addEventListener('blur', closePop);

/* ============================================================
 * 5. 工作台
 * ============================================================ */
const currentChapter = () => S.novel?.chapters.find((c) => c.id === S.chapterId) || null;

/** 按 id 找设定库里的章纲，返回卷序号和条目序号，方便定位与滚动 */
function findOutlineRef(novel, outlineId) {
  if (!novel || !outlineId) return null;
  const volumes = novel.outline?.volumes || [];
  for (let volIndex = 0; volIndex < volumes.length; volIndex++) {
    const chapters = volumes[volIndex].chapters || [];
    const index = chapters.findIndex((c) => c?.id === outlineId);
    if (index >= 0) return { volume: volumes[volIndex], entry: chapters[index], volIndex, index };
  }
  return null;
}

const linkedOutlineOf = (ch, novel = S.novel) => (ch?.outlineId ? findOutlineRef(novel, ch.outlineId) : null);

/** 本章生成时实际使用的章纲：设定库最新章纲优先，其次才是建章时的快照 */
function effectiveChapterOutline(ch) {
  const linked = linkedOutlineOf(ch);
  const snap = ch?.outline && typeof ch.outline === 'object' ? ch.outline : {};
  const first = (...values) => {
    for (const value of values) {
      const text = String(value ?? '').trim();
      if (text) return text;
    }
    return '';
  };
  const entry = linked?.entry || {};
  return {
    linked,
    outline: {
      scene: first(entry.scene, snap.scene),
      characters: first(entry.characters, snap.characters),
      summary: first(entry.summary, snap.summary),
      hook: first(entry.hook, snap.hook),
    },
  };
}

/* 章节状态：草稿 → 修改中 → 定稿。
 * 和「章节记忆」的 status 字段无关：那个是给 AI 存档用的，这里追踪的是人的写作进度。 */
const STAGE_LABEL = { draft: '草稿', revising: '修改中', done: '定稿' };
const stageOf = (c) => (c && STAGE_LABEL[c.stage] ? c.stage : 'draft');
const stageMatches = (c, filter) => !filter
  || (filter === 'open' ? stageOf(c) !== 'done' : stageOf(c) === filter);
// 单章目标字数：0 表示没设，只用于进度提示，不限制写作
const targetOf = (c) => {
  const n = Math.floor(Number(c?.targetWords));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1000000) : 0;
};
const progressOf = (c) => {
  const target = targetOf(c);
  return target ? Math.min(100, Math.round((wordsOf(c) / target) * 100)) : 0;
};
function stageCountsOf(novel) {
  const counts = { draft: 0, revising: 0, done: 0 };
  for (const c of novel?.chapters || []) counts[stageOf(c)] += 1;
  return counts;
}

/* 章节看板：把整本书铺成三列，拖动卡片就能改状态。
 * 状态仍然只写章节的 stage 字段，复用现有的自动保存，不新增接口。 */
const BOARD_STAGES = ['draft', 'revising', 'done'];
const BOARD_EMPTY = {
  draft: '还没有草稿章节',
  revising: '还没有修改中的章节',
  done: '还没有定稿章节',
};

function openChapterBoard() {
  const n = S.novel;
  if (!n) return toast('先打开作品', 'err');
  if (!n.chapters.length) return toast('还没有章节', 'err');
  showModal(`
    <div class="kb-head">
      <div class="kb-head-main">
        <h3>章节看板</h3>
        <p class="kb-sub" id="kbSub"></p>
      </div>
      <span class="kb-tip">拖到其他列改状态 · 点卡片跳到章节</span>
    </div>
    <div class="find-bar kb-find-bar">
      <input class="input" id="kbSearch" placeholder="搜索章节名 / 章号 / 卷名" title="支持章节名、章号和卷名；Esc 清空" autocomplete="off" aria-label="搜索章节" />
      <button class="icon-btn sm" id="kbSearchClear" title="清除搜索" aria-label="清除搜索" hidden><svg class="ico"><use href="#i-x" /></svg></button>
      <span class="hist-count" id="kbFindCount" hidden></span>
    </div>
    <div class="kb-overview">
      <div class="kb-bar" id="kbBar" aria-hidden="true"></div>
      <div class="kb-legend" id="kbLegend"></div>
    </div>
    <div class="kb-board" id="kbBoard"></div>
    <div class="modal-foot">
      <span class="dim small kb-foot-note">状态改动会自动保存</span>
      <button class="btn" id="kbClose">关闭</button>
    </div>`, (box) => {
    const board = box.querySelector('#kbBoard');
    const sub = box.querySelector('#kbSub');
    const bar = box.querySelector('#kbBar');
    const legend = box.querySelector('#kbLegend');
    const searchEl = box.querySelector('#kbSearch');
    const searchClear = box.querySelector('#kbSearchClear');
    const findCount = box.querySelector('#kbFindCount');
    const volIds = effVolumeIds();
    let searchText = '';
    let dragging = false;
    let dragEndedAt = 0;

    const openCard = (id) => {
      closeModal();
      setView('studio');
      selectChapter(id);
    };

    /** 构建某一列的卡片数据：先按状态分列，再叠加看板搜索 */
    function buildBoardRows(stage) {
      return n.chapters
        .map((c, i) => ({ c, i, vol: volumeTitle(volIds[i] || '') }))
        .filter(({ c, i, vol }) => stageOf(c) === stage && chapterBoardMatchesSearch(c, i, vol, searchText))
        .map(({ c, i, vol }) => ({
          id: c.id,
          index: i,
          title: c.title || '未命名',
          words: wordsOf(c),
          target: targetOf(c),
          pct: progressOf(c),
          revs: openRevisionCount(c),
          memory: c.memory,
          vol,
          isCurrent: c.id === S.chapterId,
          stage: stageOf(c),
        }));
    }

    /** 计算虚拟滚动偏移量 */
    function computeBoardOffsets(rows, itemHeight) {
      const offsets = [0];
      let acc = 0;
      for (let i = 0; i < rows.length; i++) {
        acc += itemHeight;
        offsets.push(acc);
      }
      return { offsets, totalHeight: acc };
    }

    /** 渲染单列的虚拟滚动 */
    function renderBoardVirtualList(listEl, stage, scrollTop, bindCardEvents) {
      const vl = S.kbVl;
      const colVl = vl.cols[stage];
      if (!colVl) return;
      const { itemHeight, buffer, total, rows, offsets, totalHeight } = colVl;
      const clientH = listEl.clientHeight;
      if (clientH === 0) return;

      const effectiveClientH = clientH;
      const avgH = totalHeight / total || itemHeight;

      // 二分查找 first / last
      let first = 0, last = total - 1;
      const searchTop = Math.max(0, scrollTop - buffer * avgH);
      let lo = 0, hi = total;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (offsets[mid] <= searchTop) lo = mid + 1;
        else hi = mid;
      }
      first = Math.max(0, lo - 1);

      const searchBottom = scrollTop + effectiveClientH + buffer * avgH;
      lo = 0; hi = total;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (offsets[mid] < searchBottom) lo = mid + 1;
        else hi = mid;
      }
      last = Math.min(total - 1, lo);

      if (colVl.measureDone && first === colVl.firstIdx && last === colVl.lastIdx) return;
      colVl.firstIdx = first;
      colVl.lastIdx = last;

      let viewport = listEl.querySelector('.kb-vl-viewport');
      if (!viewport) {
        listEl.innerHTML = `
          <div class="kb-vl-spacer" style="height: ${totalHeight}px"></div>
          <div class="kb-vl-viewport"></div>
        `;
        viewport = listEl.querySelector('.kb-vl-viewport');
      } else {
        listEl.querySelector('.kb-vl-spacer').style.height = `${totalHeight}px`;
      }

      viewport.style.transform = `translateY(${offsets[first]}px)`;
      viewport.innerHTML = '';
      const frag = document.createDocumentFragment();
      for (let idx = first; idx <= last; idx++) {
        const card = makeKbCard(rows[idx]);
        frag.appendChild(card);
        bindCardEvents(card);   // 虚拟滚动每次重画卡片，事件也要重新挂
      }
      viewport.appendChild(frag);

      if (!colVl.measureDone) {
        const firstCard = viewport.querySelector('.kb-card');
        if (firstCard) {
          const h = firstCard.getBoundingClientRect().height;
          if (h > 50 && h < 200) {
            colVl.itemHeight = h;
            const recalc = computeBoardOffsets(rows, h);
            colVl.offsets = recalc.offsets;
            colVl.totalHeight = recalc.totalHeight;
            listEl.querySelector('.kb-vl-spacer').style.height = `${colVl.totalHeight}px`;
            viewport.style.transform = `translateY(${colVl.offsets[first]}px)`;
          }
          colVl.measureDone = true;
        }
      }
    }

    /** 创建单张卡片元素 */
    function makeKbCard(r) {
      const article = document.createElement('article');
      article.className = `kb-card ${r.isCurrent ? 'on' : ''}`;
      article.draggable = true;
      article.dataset.id = r.id;
      article.dataset.index = r.index;
      article.tabIndex = 0;
      article.role = 'button';
      article.setAttribute('aria-label', `第 ${r.index + 1} 章 ${r.title}`);
      article.innerHTML = `
        <div class="kb-card-top">
          <span class="kb-no">${r.index + 1}</span>
          <span class="kb-card-title">${esc(r.title)}</span>
        </div>
        <div class="kb-card-meta">
          <span${r.target && r.pct >= 100 ? ' class="kb-goal-done"' : ''}>${r.target ? `${fmtWords(r.words)} / ${fmtWords(r.target)} 字` : (r.words ? `${fmtWords(r.words)} 字` : '空章')}</span>
          ${r.target ? `<span class="kb-pct">${r.pct}%</span>` : ''}
          ${r.revs ? `<span class="kb-rev">${r.revs} 项待改</span>` : ''}
          ${r.memory ? '<span class="kb-mem">有记忆</span>' : ''}
        </div>
        ${r.target ? `<div class="kb-goal" title="目标 ${fmtWords(r.target)} 字"><span class="${r.pct >= 100 ? 'done' : ''}" style="width:${r.pct}%"></span></div>` : ''}
        <div class="kb-card-foot">
          <span class="kb-vol">${r.vol ? esc(r.vol) : ''}</span>
          <select class="kb-stage" aria-label="修改第 ${r.index + 1} 章状态">
            ${BOARD_STAGES.map((s) => `<option value="${s}"${r.stage === s ? ' selected' : ''}>${STAGE_LABEL[s]}</option>`).join('')}
          </select>
        </div>`;
      return article;
    }

    const VIRTUAL_THRESHOLD = 80;  // 单列超过 80 张卡片启用虚拟滚动

    const render = ({ resetScroll = false } = {}) => {
      const scrolls = {};
      if (!resetScroll) $$('.kb-list', board).forEach((el) => { scrolls[el.dataset.stage] = el.scrollTop; });
      const rowsByStage = {};
      let matched = 0;
      for (const stage of BOARD_STAGES) {
        const rows = buildBoardRows(stage);
        rowsByStage[stage] = rows;
        matched += rows.length;
      }
      const counts = {
        draft: rowsByStage.draft.length,
        revising: rowsByStage.revising.length,
        done: rowsByStage.done.length,
      };
      const matchedRows = BOARD_STAGES.flatMap((stage) => rowsByStage[stage]);
      const totalWords = matchedRows.reduce((sum, r) => sum + r.words, 0);
      const targeted = matchedRows.filter((r) => r.target > 0);
      const achieved = targeted.filter((r) => r.words >= r.target).length;
      const goalNote = targeted.length ? ` · 目标 ${achieved}/${targeted.length} 章达标` : '';
      sub.textContent = searchText
        ? (matched ? `筛选结果 · ${fmtWords(totalWords)} 字 · 定稿 ${counts.done}/${matched}${goalNote}` : '筛选结果 · 没有匹配的章节')
        : `共 ${n.chapters.length} 章 · ${fmtWords(totalWords)} 字 · 定稿 ${counts.done}/${n.chapters.length}${goalNote}`;
      searchClear.hidden = !searchText;
      findCount.hidden = !searchText;
      findCount.textContent = searchText ? `找到 ${matched} / ${n.chapters.length} 章` : '';
      const barTotal = matched || 1;
      bar.innerHTML = BOARD_STAGES.map((stage) => {
        const pct = (counts[stage] / barTotal) * 100;
        return pct ? `<span class="kb-seg ${stage}" style="width:${pct}%"></span>` : '';
      }).join('');
      legend.innerHTML = BOARD_STAGES.map((stage) => `
        <span class="kb-legend-item"><i class="kb-dot ${stage}"></i>${STAGE_LABEL[stage]} <b>${counts[stage]}</b></span>`).join('');

      board.innerHTML = BOARD_STAGES.map((stage) => {
        const rows = rowsByStage[stage];
        const words = rows.reduce((sum, r) => sum + r.words, 0);
        const useVirtual = rows.length >= VIRTUAL_THRESHOLD;
        if (useVirtual) {
          S.kbVl.enabled = true;
          S.kbVl.cols[stage] = {
            firstIdx: 0,
            lastIdx: -1,
            total: rows.length,
            rows,
            itemHeight: S.kbVl.itemHeight,
            buffer: S.kbVl.buffer,
            scrollHandler: null,
            measureDone: false,
            enabled: true,
            ...computeBoardOffsets(rows, S.kbVl.itemHeight),
          };
        } else {
          S.kbVl.enabled = false;
          S.kbVl.cols[stage] = { enabled: false };
        }
        return `<section class="kb-col" data-stage="${stage}">
          <div class="kb-col-head">
            <span class="kb-dot ${stage}"></span>
            <span class="kb-col-title">${STAGE_LABEL[stage]}</span>
            <span class="kb-col-count">${rows.length}</span>
            <span class="kb-col-words">${rows.length ? `${fmtWords(words)} 字` : ''}</span>
          </div>
          <div class="kb-list${useVirtual ? ' virtual' : ''}" data-stage="${stage}"></div>
        </section>`;
      }).join('');

      const applyStage = (index, stage, focusSelect = false) => {
        const ch = n.chapters[index];
        if (!ch || !STAGE_LABEL[stage] || stageOf(ch) === stage) return false;
        setChapterStage(index, stage);
        render();
        if (focusSelect) board.querySelector(`.kb-card[data-index="${index}"] .kb-stage`)?.focus();
        return true;
      };

      // 绑定卡片事件（普通渲染和虚拟渲染共用）
      function bindCardEvents(card) {
        const id = card.dataset.id;
        const index = Number(card.dataset.index);
        const stageSelect = $('.kb-stage', card);
        card.addEventListener('dragstart', (e) => {
          dragging = true;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', id);
          card.classList.add('dragging');
        });
        card.addEventListener('dragend', () => {
          dragging = false;
          dragEndedAt = Date.now();
          card.classList.remove('dragging');
          $$('.kb-col.drop', board).forEach((el) => el.classList.remove('drop'));
        });
        card.addEventListener('click', (e) => {
          if (e.target.closest('select')) return;
          if (dragging || Date.now() - dragEndedAt < 220) return;
          openCard(id);
        });
        card.addEventListener('keydown', (e) => {
          if (e.target.closest('select')) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openCard(id);
          }
        });
        stageSelect?.addEventListener('change', () => applyStage(index, stageSelect.value, true));
      }

      $$('.kb-list', board).forEach((listEl) => {
        const stage = listEl.dataset.stage;
        const vl = S.kbVl.cols[stage];
        if (vl && vl.enabled !== false) {
          // 虚拟滚动模式
          listEl.classList.add('virtual');
          renderBoardVirtualList(listEl, stage, scrolls[stage] || 0, bindCardEvents);
          if (!vl.scrollHandler) {
            vl.scrollHandler = () => renderBoardVirtualList(listEl, stage, listEl.scrollTop, bindCardEvents);
            listEl.addEventListener('scroll', vl.scrollHandler, { passive: true });
          }
        } else {
          // 普通渲染模式
          listEl.classList.remove('virtual');
          const rows = rowsByStage[stage];
          if (!rows.length) {
            const empty = searchText ? '没有匹配的章节' : `${BOARD_EMPTY[stage]}<br>把卡片拖到这里`;
            listEl.innerHTML = `<div class="kb-empty">${empty}</div>`;
          } else {
            const cards = rows.map((r) => makeKbCard(r));
            listEl.innerHTML = '';
            cards.forEach((card) => {
              listEl.appendChild(card);
              bindCardEvents(card);
            });
          }
        }
        if (scrolls[stage]) listEl.scrollTop = scrolls[stage];
      });

      // 拖放目标列（非虚拟滚动时用 listEl，虚拟滚动时用 col）
      $$('.kb-col', board).forEach((col) => {
        const stage = col.dataset.stage;
        col.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          col.classList.add('drop');
        });
        col.addEventListener('dragleave', (e) => {
          if (!col.contains(e.relatedTarget)) col.classList.remove('drop');
        });
        col.addEventListener('drop', (e) => {
          e.preventDefault();
          col.classList.remove('drop');
          dragging = false;
          dragEndedAt = Date.now();
          const id = e.dataTransfer.getData('text/plain');
          const index = n.chapters.findIndex((c) => c.id === id);
          if (index >= 0) applyStage(index, stage);
        });
      });
    };

    const clearSearch = (focus = true) => {
      searchEl.value = '';
      searchText = '';
      render({ resetScroll: true });
      if (focus) searchEl.focus({ preventScroll: true });
    };

    searchEl.addEventListener('input', () => {
      searchText = searchEl.value.trim();
      render({ resetScroll: true });
    });
    searchEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !searchEl.value) return;
      e.preventDefault();
      e.stopPropagation();   // 只清空搜索，别把看板一起关掉
      clearSearch();
    });
    searchClear.addEventListener('click', () => clearSearch());

    render();
    searchEl.focus({ preventScroll: true });
    box.querySelector('#kbClose').onclick = closeModal;
  }, { wide: true });
}

/** 按 id 找章节行：筛选后列表下标和全书下标不再一致，不能再用数组位置取行 */
const chapterRow = (id) => $$('#chapterList .chapter-item').find((el) => el.dataset.id === id) || null;

function renderTopbarActions() {
  const mid = $('#topbarMid');
  if (!S.novel) { mid.textContent = ''; mid.onclick = null; return; }
  const total = S.novel.chapters.reduce((s, c) => s + wordsOf(c), 0);
  const goal = bookGoalOf(S.novel);
  const est = finishEstimate(goal, S.stats);
  const goalTip = goal
    ? `全书目标 ${fmtGoal(goal.target)} 字，已完成 ${goal.pct}%`
      + (goal.done ? ' · 已达成' : ` · 还差 ${fmtWords(goal.left)} 字`)
      + (est?.days ? ` · 按日均 ${fmtWords(est.rate)} 字算${daysPhrase(est.days)}，预计 ${datePhrase(est.date)}完稿` : '')
    : '';
  const goalTag = goal
    ? `<span class="top-goal${goal.done ? ' done' : ''}" title="${esc(goalTip)}">目标 ${fmtGoal(goal.target)} 字 · ${goal.pct}%</span>`
    : '';
  mid.innerHTML = `<span title="点击导出这部作品">${ico('book')}《${esc(S.novel.title)}》<span class="dim-text">${S.novel.chapters.length} 章 · ${fmtWords(total)} 字</span>${goalTag}${ico('download')}</span>`;
  mid.onclick = exportBook;
}

/** 字数胶囊：同时显示单章目标的完成度，点击可改目标 */
function renderWordChip() {
  const el = $('#chWords');
  if (!el) return;
  const ch = currentChapter();
  const words = wordsOf(ch);
  const target = targetOf(ch);
  const pct = progressOf(ch);
  el.textContent = `${fmtWords(words)} 字`;
  el.disabled = !ch;
  el.classList.toggle('has-target', !!target);
  el.classList.toggle('done', !!target && words >= target);
  el.style.setProperty('--pct', `${pct}%`);
  el.title = !ch
    ? '先打开或新建一章'
    : target
      ? `目标 ${fmtWords(target)} 字 · 已完成 ${pct}%（点击修改）`
      : '点击设置本章目标字数';
  el.setAttribute('aria-label', el.title);
  renderFocusBar();
}

/** 专注模式顶部细栏：当前章节、字数与目标进度 */
function renderFocusBar() {
  const title = $('#focusTitle');
  const meta = $('#focusMeta');
  const goal = $('#focusGoal');
  const prevBtn = $('#focusPrev');
  const nextBtn = $('#focusNext');
  if (!title || !meta || !goal) return;
  const ch = currentChapter();
  if (!ch || !S.novel) {
    title.textContent = '未选择章节';
    meta.textContent = '';
    goal.textContent = '';
    goal.classList.remove('done');
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    return;
  }
  const i = S.novel.chapters.indexOf(ch);
  const words = wordsOf(ch);
  const target = targetOf(ch);
  const pct = progressOf(ch);
  title.textContent = ch.title || '未命名';
  meta.textContent = `第 ${i + 1} / ${S.novel.chapters.length} 章 · ${fmtWords(words)} 字`;
  goal.textContent = target ? `目标 ${fmtWords(target)} · ${pct}%` : '未设目标';
  goal.classList.toggle('done', !!target && words >= target);
  goal.title = target
    ? `本章目标 ${fmtWords(target)} 字，已完成 ${pct}%`
    : '退出专注后可在字数胶囊里设置目标';
  if (prevBtn) prevBtn.disabled = i <= 0;
  if (nextBtn) nextBtn.disabled = i >= S.novel.chapters.length - 1;
}

/** 进入专注写作：只留稿纸，Esc 退出 */
function enterFocus() {
  if (!S.novel) return toast('先打开一部作品', 'err');
  if (!currentChapter()) return toast('先打开一章再专注', 'err');
  if (S.view !== 'studio') setView('studio');
  closeStudioPane();
  S.focusMode = true;
  document.querySelector('.app')?.classList.add('focus-mode');
  const bar = $('#focusBar');
  if (bar) bar.hidden = false;
  $('#focusBtn')?.setAttribute('aria-pressed', 'true');
  renderFocusBar();
  const ta = $('#chContent');
  if (ta && !ta.disabled) ta.focus({ preventScroll: true });
}

function exitFocus() {
  if (!S.focusMode) return;
  S.focusMode = false;
  document.querySelector('.app')?.classList.remove('focus-mode');
  const bar = $('#focusBar');
  if (bar) bar.hidden = true;
  $('#focusBtn')?.setAttribute('aria-pressed', 'false');
}

function toggleFocus() {
  if (S.focusMode) exitFocus();
  else enterFocus();
}

/** 在整本书的章节顺序里前后翻一章；专注模式下把光标送回正文，不用退出再进来 */
function stepChapter(delta) {
  const n = S.novel;
  if (!n || !n.chapters.length) return false;
  const i = n.chapters.findIndex((c) => c.id === S.chapterId);
  const target = i < 0 ? (delta > 0 ? 0 : n.chapters.length - 1) : i + delta;
  if (target < 0 || target >= n.chapters.length) return false;
  selectChapter(n.chapters[target].id);
  if (S.focusMode) {
    const ta = $('#chContent');
    if (ta && !ta.disabled) {
      ta.focus({ preventScroll: true });
      // 往后翻接着写，落在正文末尾；往前翻先看开头
      const pos = delta > 0 ? ta.value.length : 0;
      ta.setSelectionRange(pos, pos);
      ta.scrollTop = delta > 0 ? ta.scrollHeight : 0;
    }
  }
  return true;
}

/** 卷标题行（用于虚拟滚动与普通渲染的统一入口） */
function makeVolHead({ vid, group, open }) {
  const v = volumeById(vid);
  const words = group.chapters.reduce((s, c) => s + wordsOf(c), 0);
  const li = document.createElement('li');
  li.className = `vol-row-head${open ? '' : ' closed'}`;
  li.dataset.vid = vid;
  li.innerHTML = `
    <div class="vol-head" title="${open ? '点击收起这一卷' : '点击展开这一卷'}">
      <button class="vol-toggle" type="button">${ico('chev-down')}</button>
      <span class="vol-name">${v ? esc(volumeTitle(vid)) : '未分卷'}</span>
      <span class="vol-stat">${group.chapters.length} 章 · ${fmtWords(words)} 字</span>
      <button class="mini-act" data-a="vmenu" type="button" title="本卷操作" aria-label="本卷操作">${ico('more')}</button>
    </div>`;
  const toggle = () => toggleVol(vid);
  li.querySelector('.vol-toggle').addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  li.querySelector('.vol-head').addEventListener('click', (e) => { if (!e.target.closest('.mini-act')) toggle(); });
  li.querySelector('[data-a="vmenu"]').addEventListener('click', (e) => { e.stopPropagation(); openVolumeGroupMenu(e.currentTarget, vid, group); });
  return li;
}

/** 章节行（含 ⋯ 操作菜单）。分卷模式下按卷塞进不同分组，平铺模式直接进 ul。 */
function makeChapterItem(c, i, { filtered = false, group = null } = {}) {
  const li = document.createElement('li');
  li.className = `chapter-item ${c.id === S.chapterId ? 'on' : ''}${c.id === S.chapterCursor ? ' cursor' : ''}${group ? ' has-vol' : ''}`;
  li.dataset.id = c.id;
  li.dataset.stage = stageOf(c);
  if (group) li.dataset.vol = group.id;
  const openRevs = openRevisionCount(c);
  const target = targetOf(c);
  const pct = progressOf(c);
  li.title = [
    STAGE_LABEL[stageOf(c)],
    c.memory ? '已有章节记忆' : '',
    openRevs ? `${openRevs} 项待改` : '',
    target ? `目标 ${fmtWords(target)} 字 · ${pct}%` : '',
  ].filter(Boolean).join(' · ');
  const w = wordsOf(c);
  const moveButtons = filtered ? '' : `
      <button class="mini-act" data-a="up" title="上移" aria-label="上移">${ico('chev-up')}</button>
      <button class="mini-act" data-a="down" title="下移" aria-label="下移">${ico('chev-down')}</button>`;
  li.innerHTML = `
    <span class="ci-no">${i + 1}</span>
    <span class="ci-title">${esc(c.title || '未命名')}</span>
    <span class="ci-words">${openRevs ? `<span class="ci-rev" title="${openRevs} 项待改">${openRevs}</span>` : ''}${c.memory ? '<button type="button" class="ci-mem" data-a="memory" title="查看本章记忆" aria-label="查看本章记忆"></button>' : ''}${w || ''}</span>
    <span class="ci-act">${moveButtons}
      <button class="mini-act" data-a="menu" title="分卷 / 本章操作" aria-label="分卷 / 本章操作">${ico('more')}</button>
      <button class="mini-act del" data-a="del" title="删除本章" aria-label="删除本章">${ico('x')}</button>
    </span>`;
  li.addEventListener('click', (e) => {
    const act = e.target.closest('.mini-act, .ci-mem')?.dataset.a;
    if (!act) return selectChapter(c.id);
    if (act === 'memory') return openMemoryModal(c);
    if (act === 'up' && !filtered && i > 0) return moveChapter(i, i - 1);
    if (act === 'down' && !filtered && i < S.novel.chapters.length - 1) return moveChapter(i, i + 1);
    if (act === 'menu') return openChapterMenu(e.target.closest('.mini-act'), i);
    if (act === 'del') {
      (async () => {
        if (!confirm(`删除第 ${i + 1} 章「${c.title}」？`)) return;
        const hadVol = typeof c.volumeId === 'string' ? c.volumeId : '';
        const nextCh = S.novel.chapters[i + 1];
        const { novel } = await api.del(`/api/novels/${S.novel.id}/chapters/${c.id}`);
        S.novel = novel;
        S.unsaved.delete(c.id);
        pendingCounted.delete(c.id);
        countedWords.delete(c.id);
        if (hadVol && nextCh && typeof nextCh.volumeId !== 'string' && novel.chapters.some((x) => x.id === nextCh.id)) {
          nextCh.volumeId = hadVol;
          saveChapterVolumes([{ id: nextCh.id, volumeId: hadVol }]);
        }
        S.dirty = S.unsaved.size > 0;
        refreshSavePill();
        if (S.chapterId === c.id) S.chapterId = novel.chapters[Math.min(i, novel.chapters.length - 1)]?.id || null;
        renderStudio();
        loadNovels();
      })();
    }
  });
  return li;
}

/** 把章节列表压平成扁平行数组，含分组信息；供虚拟滚动与普通渲染共用
 *  返回 [{ kind: 'head', vid, group, open }, { kind: 'chapter', c, i, filtered, group }, ...]
 *  在筛选模式下只返回章节行（无分组头）。
 */
function buildChapterRows(n, stageLabels) {
  const filterActive = !!S.stageFilter || !!S.chapterSearch.trim();
  const filteredRows = filterActive
    ? filterChaptersBySearch(n.chapters, S.chapterSearch)
        .filter(({ chapter }) => stageMatches(chapter, S.stageFilter))
        .map(({ chapter, index }) => ({ c: chapter, i: index }))
    : [];
  if (!n.chapters.length) return [];

  const eff = effVolumeIds();
  const groupMode = volumesOf().length > 0;

  const rows = [];
  if (filterActive) {
    filteredRows.forEach(({ c, i }) => rows.push({ kind: 'chapter', c, i, filtered: true }));
  } else if (groupMode) {
    const groups = [];
    n.chapters.forEach((c, i) => {
      const vid = eff[i] || '';
      const last = groups[groups.length - 1];
      if (!last || last.id !== vid) groups.push({ id: vid, from: i, chapters: [c] });
      else last.chapters.push(c);
    });
    groups.forEach((g) => {
      const open = isVolOpen(g.id);
      rows.push({ kind: 'head', vid: g.id, group: g, open });
      if (open) {
        let to = g.from;
        g.chapters.forEach((c) => { rows.push({ kind: 'chapter', c, i: to, group: g }); to += 1; });
      }
    });
  } else {
    n.chapters.forEach((c, i) => rows.push({ kind: 'chapter', c, i }));
  }
  return rows;
}

/** 重建左侧章节列表（分卷 / 筛选 / 平铺三种形态）。切章时不走这里，见 syncChapterSelection */
function renderChapterList(n, stageLabels) {
  const ul = $('#chapterList');
  const keepScroll = ul.scrollTop;
  S.chapterCursor = '';   // 列表重建后，旧的键盘光标不一定还对得上
  updateVolExpandButton();
  ul.innerHTML = '';

  const rows = buildChapterRows(n, stageLabels);
  const searchActive = !!S.chapterSearch.trim();
  const shownChapters = rows.reduce((count, row) => count + (row.kind === 'chapter' ? 1 : 0), 0);
  const countEl = $('#chapterSearchCount');
  if (countEl) {
    countEl.textContent = searchActive ? `${shownChapters} / ${n.chapters.length}` : '';
    countEl.title = searchActive ? `命中 ${shownChapters} / ${n.chapters.length} 章` : '';
  }
  const VIRTUAL_THRESHOLD = 500;

  if (!rows.length) {
    const filtered = !!S.stageFilter || searchActive;
    ul.innerHTML = filtered
      ? `<li class="chapter-empty">没有匹配的章节<br><button type="button" class="btn btn-sm btn-text" id="chapterEmptyClear">清除搜索与筛选</button></li>`
      : `<li class="chapter-empty">还没有章节<br>点上方 ＋ 新建一章</li>`;
    if (filtered) {
      ul.querySelector('#chapterEmptyClear')?.addEventListener('click', () => {
        S.stageFilter = '';
        S.chapterSearch = '';
        renderStudio();
      });
    }
    S.vl.enabled = false;
    S.vl.rows = [];
    ul.classList.remove('virtual');
    if (S.vl.scrollHandler) {
      ul.removeEventListener('scroll', S.vl.scrollHandler, { passive: true });
      S.vl.scrollHandler = null;
    }
    ul.scrollTop = keepScroll;
    return;
  }

  // 决定是否启用虚拟滚动
  const useVirtual = rows.length >= VIRTUAL_THRESHOLD;
  S.vl.enabled = useVirtual;
  S.vl.total = rows.length;
  S.vl.rows = rows;

  if (useVirtual) {
    ul.classList.add('virtual');
    // 初始渲染：先测量一次行高，再按可视区渲染
    S.vl.measureDone = false;
    S.vl.firstIdx = 0;
    S.vl.lastIdx = -1;
    // 预计算 offsets 用于虚拟滚动定位
    computeOffsets(rows);
    renderVirtualList(ul, keepScroll);
    // 挂滚动监听（只挂一次）
    if (!S.vl.scrollHandler) {
      S.vl.scrollHandler = () => renderVirtualList(ul, ul.scrollTop);
      ul.addEventListener('scroll', S.vl.scrollHandler, { passive: true });
    }
  } else {
    ul.classList.remove('virtual');
    // 普通渲染：全量 append
    if (S.vl.scrollHandler) {
      ul.removeEventListener('scroll', S.vl.scrollHandler, { passive: true });
      S.vl.scrollHandler = null;
    }
    rows.forEach((r) => {
      if (r.kind === 'head') ul.appendChild(makeVolHead(r));
      else ul.appendChild(makeChapterItem(r.c, r.i, { filtered: r.filtered, group: r.group }));
    });
    ul.scrollTop = keepScroll;
  }
}

/** 计算每行的顶部偏移（用于虚拟滚动定位），并存入 S.vl.offsets / totalHeight */
function computeOffsets(rows) {
  const { itemHeight, headHeight } = S.vl;
  const offsets = [0];
  let acc = 0;
  for (const r of rows) {
    acc += r.kind === 'head' ? headHeight : itemHeight;
    offsets.push(acc);
  }
  S.vl.offsets = offsets;
  S.vl.totalHeight = acc;
}

/** 虚拟滚动渲染：只画可视区 + buffer 行（支持 vol-head 与 chapter-item 混排，高度不同） */
function renderVirtualList(ul, scrollTop) {
  const { itemHeight, headHeight, buffer, total, rows, offsets, totalHeight } = S.vl;
  const clientH = ul.clientHeight;
  // 容器未显示时用估算高度，避免首次渲染为空
  const effectiveClientH = clientH || 400;

  // 用二分查找在 offsets 中找到 first / last
  let first = 0, last = total - 1;
  // first: 最后一个 offset <= scrollTop + buffer * avgHeight 的索引
  const avgH = totalHeight / total || itemHeight;
  const searchTop = Math.max(0, scrollTop - buffer * avgH);
  let lo = 0, hi = total;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= searchTop) lo = mid + 1;
    else hi = mid;
  }
  first = Math.max(0, lo - 1);

  const searchBottom = scrollTop + effectiveClientH + buffer * avgH;
  lo = 0; hi = total;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] < searchBottom) lo = mid + 1;
    else hi = mid;
  }
  last = Math.min(total - 1, lo);

  // 首次渲染或范围变了才重画
  if (S.vl.measureDone && first === S.vl.firstIdx && last === S.vl.lastIdx) return;
  S.vl.firstIdx = first;
  S.vl.lastIdx = last;

  // 只渲染 viewport 里的行
  let viewport = ul.querySelector('.vl-viewport');
  if (!viewport) {
    ul.innerHTML = `
      <div class="vl-spacer" style="height: ${totalHeight}px"></div>
      <div class="vl-viewport"></div>
    `;
    viewport = ul.querySelector('.vl-viewport');
  } else {
    // 更新 spacer 高度
    ul.querySelector('.vl-spacer').style.height = `${totalHeight}px`;
  }

  viewport.style.transform = `translateY(${offsets[first]}px)`;
  viewport.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (let idx = first; idx <= last; idx++) {
    const r = rows[idx];
    if (r.kind === 'head') frag.appendChild(makeVolHead(r));
    else frag.appendChild(makeChapterItem(r.c, r.i, { filtered: r.filtered, group: r.group }));
  }
  viewport.appendChild(frag);

  // 首帧后实测行高并修正
  if (!S.vl.measureDone) {
    const firstRow = viewport.querySelector('.chapter-item');
    if (firstRow) {
      const h = firstRow.getBoundingClientRect().height;
      if (h > 20 && h < 80) {
        S.vl.itemHeight = h;
        // 重新计算 offsets
        computeOffsets(rows);
        ul.querySelector('.vl-spacer').style.height = `${S.vl.totalHeight}px`;
        viewport.style.transform = `translateY(${S.vl.offsets[first]}px)`;
      }
      S.vl.measureDone = true;
    }
  }
}

/** 切章只挪选中态：几百章的长篇不用把整个列表重新造一遍 */
function syncChapterSelection() {
  const ul = $('#chapterList');
  if (S.vl.enabled) {
    // 虚拟滚动模式：确保当前章在渲染范围内
    const idx = S.vl.rows.findIndex(r => r.kind === 'chapter' && r.c.id === S.chapterId);
    if (idx >= 0 && (idx < S.vl.firstIdx || idx > S.vl.lastIdx)) {
      // 不在可视区，滚过去（用 offsets 定位）
      ul.scrollTop = S.vl.offsets[idx];
    }
    // 更新 on 类
    const prev = ul.querySelector('.chapter-item.on');
    if (prev && prev.dataset.id === S.chapterId) return;
    if (prev) prev.classList.remove('on');
    const next = ul.querySelector(`.chapter-item[data-id="${S.chapterId}"]`);
    if (next) next.classList.add('on');
  } else {
    const prev = ul.querySelector('.chapter-item.on');
    if (prev && prev.dataset.id === S.chapterId) return;
    if (prev) prev.classList.remove('on');
    const next = chapterRow(S.chapterId);
    if (next) next.classList.add('on');
  }
}

/* ============================================================
 * 设定库虚拟滚动（通用）
 * ============================================================ */

/** 初始化设定库虚拟列表容器（多列表支持） */
function initBibleVirtualList(listEl, items, renderItem, listKey, options = {}) {
  const vl = S.bibleVl;
  vl.currentKey = listKey;
  if (!vl.lists[listKey]) {
    vl.lists[listKey] = {
      enabled: false,
      itemHeight: 280,      // 预估条目高度（px），首帧后实测修正
      buffer: 2,            // 可视区上下各多渲染几条
      firstIdx: 0,
      lastIdx: -1,
      total: 0,
      items: [],            // 当前列表的数据项
      renderItem: null,     // 渲染函数 (item, index) => HTMLElement
      listEl: null,         // 当前的 entry-list 元素
      scrollHandler: null,
      measureDone: false,
      measureAll: false,    // 条目高度差异大时，先整体量一遍再虚拟滚动
      heights: [],          // 每条的实际高度（含下间距）
      offsets: [0],         // 每条顶部位置的前缀和
      totalHeight: 0,       // 所有条目的总高度
    };
  }
  const l = vl.lists[listKey];
  const prevList = l.listEl;
  l.enabled = items.length >= 100;  // 100 条以上启用虚拟滚动
  l.items = items;
  l.renderItem = renderItem;
  l.listEl = listEl;
  l.total = items.length;
  l.firstIdx = 0;
  l.lastIdx = -1;
  l.measureDone = false;
  l.measureAll = Boolean(options.measureAll);
  l.itemHeight = 280;

  if (!l.enabled) {
    // 普通渲染
    listEl.classList.remove('virtual');
    if (l.scrollHandler) {
      (prevList || listEl).removeEventListener('scroll', l.scrollHandler);
      l.scrollHandler = null;
    }
    listEl.innerHTML = '';
    items.forEach((item, idx) => listEl.appendChild(renderItem(item, idx)));
    return;
  }

  // 虚拟模式初始化
  listEl.classList.add('virtual');
  l.firstIdx = 0;
  l.lastIdx = -1;
  l.measureDone = false;
  l.heights = new Array(l.total).fill(l.itemHeight);
  if (l.measureAll) {
    // 弧光卡的高度随章数与未决条数变化，先整体量一遍，滚动位置才不会被估高 / 估矮
    const measured = measureBibleItemHeights(listEl, items, renderItem);
    if (measured && measured.length === items.length) {
      l.heights = measured;
      l.measureDone = true;
    }
  }
  computeBibleOffsets(l);
  renderBibleVirtualList(listEl, 0, listKey);

  // 切标签页会重建列表元素：旧元素上的监听要解绑，否则新列表滚不动
  if (l.scrollHandler && prevList !== listEl) {
    prevList?.removeEventListener('scroll', l.scrollHandler);
    l.scrollHandler = null;
  }
  // 挂滚动监听
  if (!l.scrollHandler) {
    l.scrollHandler = () => renderBibleVirtualList(listEl, listEl.scrollTop, listKey);
    listEl.addEventListener('scroll', l.scrollHandler, { passive: true });
  }
}

/** 计算设定库虚拟列表每条顶部位置的前缀和 */
function computeBibleOffsets(l) {
  const offsets = [0];
  let acc = 0;
  for (let i = 0; i < l.total; i++) {
    acc += l.heights[i] || l.itemHeight;
    offsets.push(acc);
  }
  l.offsets = offsets;
  l.totalHeight = acc;
}

/** 把全部条目临时铺开量一次高度（含下间距）。只给高度差异大的列表用，量完立即清空。 */
function measureBibleItemHeights(listEl, items, renderItem) {
  if (!items.length || listEl.clientHeight === 0) return null;
  let spacer = listEl.querySelector('.vl-spacer');
  let viewport = listEl.querySelector('.vl-viewport');
  if (!spacer || !viewport) {
    listEl.innerHTML = '<div class="vl-spacer"></div><div class="vl-viewport"></div>';
    spacer = listEl.querySelector('.vl-spacer');
    viewport = listEl.querySelector('.vl-viewport');
  }
  const prevScrollTop = listEl.scrollTop;
  const prevTransform = viewport.style.transform;
  const prevVisibility = viewport.style.visibility;
  // 先把占位撑高，让滚动条提前出现，量到的可用宽度才和最终一致
  spacer.style.height = `${items.length * 280}px`;
  viewport.style.transform = 'translateY(0)';
  viewport.style.visibility = 'hidden';
  viewport.innerHTML = '';
  const frag = document.createDocumentFragment();
  const nodes = items.map((item, index) => {
    const el = renderItem(item, index);
    frag.appendChild(el);
    return el;
  });
  viewport.appendChild(frag);
  const heights = nodes.map((el) => {
    const margin = parseFloat(getComputedStyle(el).marginBottom) || 0;
    return Math.max(1, el.getBoundingClientRect().height + margin);
  });
  viewport.innerHTML = '';
  viewport.style.visibility = prevVisibility;
  viewport.style.transform = prevTransform;
  listEl.scrollTop = prevScrollTop;
  return heights;
}

/** 设定库虚拟滚动渲染（多列表支持，条目高度可以不同） */
function renderBibleVirtualList(listEl, scrollTop, listKey) {
  const vl = S.bibleVl;
  const l = vl.lists[listKey];
  if (!l || !l.total) return;
  const { buffer, total, items, renderItem, offsets, totalHeight } = l;
  const clientH = listEl.clientHeight;
  if (clientH === 0) return;  // 容器未显示

  // 用前缀和二分查找可视区首尾：不同高度的卡片不会把最后几条顶出列表
  const avgH = totalHeight / total || l.itemHeight;
  const searchTop = Math.max(0, scrollTop - buffer * avgH);
  let lo = 0, hi = total;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= searchTop) lo = mid + 1;
    else hi = mid;
  }
  const first = Math.max(0, lo - 1);

  const searchBottom = scrollTop + clientH + buffer * avgH;
  lo = 0; hi = total;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] < searchBottom) lo = mid + 1;
    else hi = mid;
  }
  const last = Math.min(total - 1, lo);

  if (l.measureDone && first === l.firstIdx && last === l.lastIdx) return;
  l.firstIdx = first;
  l.lastIdx = last;

  let viewport = listEl.querySelector('.vl-viewport');
  if (!viewport) {
    listEl.innerHTML = `
      <div class="vl-spacer" style="height: ${totalHeight}px"></div>
      <div class="vl-viewport"></div>
    `;
    viewport = listEl.querySelector('.vl-viewport');
  } else {
    listEl.querySelector('.vl-spacer').style.height = `${totalHeight}px`;
  }

  viewport.style.transform = `translateY(${offsets[first]}px)`;
  viewport.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (let idx = first; idx <= last; idx++) {
    frag.appendChild(renderItem(items[idx], idx));
  }
  viewport.appendChild(frag);

  // 首帧后实测条目高度并修正（人物卡 / 线索卡的 DOM 类名各不相同，统一取第一个子项）
  if (!l.measureDone) {
    const firstEntry = viewport.firstElementChild;
    if (firstEntry) {
      // 条目之间有 margin，滚动步长要把这段间距算进去，否则最后几条会被裁掉
      const margin = parseFloat(getComputedStyle(firstEntry).marginBottom) || 0;
      const h = firstEntry.getBoundingClientRect().height + margin;
      // 线索行比人物卡矮得多，不能再用 100px 当门槛；只要不是 0 高就按实测值走
      if (h > 20 && h < 800) {
        l.itemHeight = h;
        l.heights = new Array(total).fill(h);
        computeBibleOffsets(l);
        listEl.querySelector('.vl-spacer').style.height = `${l.totalHeight}px`;
        viewport.style.transform = `translateY(${l.offsets[first]}px)`;
        l.measureDone = true;
        // 预估高度往往比真实高度大：按新高度补渲染一屏，避免首屏下方留白
        renderBibleVirtualList(listEl, scrollTop, listKey);
      } else {
        l.measureDone = true;
      }
    }
  }
}

/** 清理设定库虚拟列表状态 */
function cleanupBibleVirtualList(listEl) {
  const vl = S.bibleVl;
  if (vl.scrollHandler) {
    listEl.removeEventListener('scroll', vl.scrollHandler);
    vl.scrollHandler = null;
  }
  vl.enabled = false;
  vl.items = [];
  vl.renderItem = null;
  vl.listEl = null;
}

function renderStudio({ list = true } = {}) {
  if (!S.novel && S.focusMode) exitFocus();
  const wrap = $('.editor-wrap');
  const empty = $('#editorEmpty');
  const setEmpty = (on, title, text, cta) => {
    wrap.classList.toggle('is-empty', on);
    empty.hidden = !on;
    if (on) { $('#editorEmptyTitle').textContent = title; $('#editorEmptyText').textContent = text; $('#editorEmptyBtn').hidden = !cta; }
    $('#chTitle').disabled = on;
    $('#chContent').disabled = on;
    $('#chStage').disabled = on;
    $('#formatBtn').disabled = on;
    $('#previewBtn').disabled = on;
  };

  if (!S.novel) {
    rememberEditorPosition();
    EDITOR_TRACK.novelId = '';
    EDITOR_TRACK.chapterId = '';
    $('#chapterList').innerHTML = '<li class="chapter-empty">还没有打开作品<br>回「书架」选择或新建一部</li>';
    $('#chTitle').value = ''; $('#chContent').value = '';
    renderWordChip();
    $('#chapterMeta').textContent = '';
    $('#chapterMeta').classList.remove('solo');
    $('.chapter-filter').hidden = true;
    $('#stageFilter').disabled = true;
    $('#stageFilter').value = '';
    $('#stageFilter').classList.remove('on');
    $('#stageStat').textContent = '';
    $('.chapter-search').hidden = true;
    $('#chapterSearch').value = '';
    $('#chapterSearchCount').textContent = '';
    $('#chapterSearchClear').hidden = true;
    S.chapterCursor = '';
    updateVolExpandButton();
    $('#chStage').value = 'draft';
    $('#chStage').className = 'stage-select';
    $('#footInfo').textContent = '';
    $('#chapterOutlineCard').hidden = true;
    renderRevisionCard();
    setEmpty(true, '还没有打开作品', '回「书架」选一部旧作，或者新建一部开始写。', false);
    histSync();
    renderTopbarActions();
    return;
  }
  const n = S.novel;
  const total = n.chapters.reduce((s, c) => s + wordsOf(c), 0);
  const curIdx = n.chapters.findIndex((c) => c.id === S.chapterId);
  const curVol = curIdx >= 0 && volumesOf().length ? volumeTitle(effVolumeIds()[curIdx]) : '';
  $('#chapterMeta').innerHTML = `${esc(n.genre || '未分类')} · ${curVol ? `${esc(curVol)} · ` : ''}${n.chapters.length} 章 · ${fmtWords(total)} 字${n.meta.platform ? ` · ${esc(n.meta.platform)}` : ''}`;

  // 状态筛选：数字挂在选项里，收起时也能一眼看到「全部 / 未定稿 / 定稿」的进度
  const stageCounts = stageCountsOf(n);
  const stageLabels = { '': '全部', open: '未定稿', draft: '草稿', revising: '修改中', done: '定稿' };
  const stageNums = { '': n.chapters.length, open: stageCounts.draft + stageCounts.revising, ...stageCounts };
  if (!Object.prototype.hasOwnProperty.call(stageLabels, S.stageFilter)) S.stageFilter = '';
  if (!n.chapters.length) { S.stageFilter = ''; S.chapterSearch = ''; }
  $('#chapterMeta').classList.toggle('solo', !n.chapters.length);
  $('.chapter-filter').hidden = !n.chapters.length;
  const filterEl = $('#stageFilter');
  filterEl.disabled = false;
  filterEl.value = S.stageFilter;
  filterEl.classList.toggle('on', !!S.stageFilter);
  for (const [value, label] of Object.entries(stageLabels)) {
    const opt = filterEl.querySelector(`option[value="${value}"]`);
    if (opt) opt.textContent = `${label} ${stageNums[value]}`;
  }
  $('#stageStat').textContent = n.chapters.length ? `${stageCounts.done}/${n.chapters.length} 定稿` : '';

  $('.chapter-search').hidden = !n.chapters.length;
  const searchEl = $('#chapterSearch');
  if (searchEl.value !== S.chapterSearch) searchEl.value = S.chapterSearch;
  $('#chapterSearchClear').hidden = !S.chapterSearch;

  if (list) renderChapterList(n, stageLabels);
  else syncChapterSelection();

  const ch = currentChapter();
  const nextNovelId = n.id;
  const nextChapterId = ch?.id || '';
  const chapterSwitched = nextNovelId !== EDITOR_TRACK.novelId || nextChapterId !== EDITOR_TRACK.chapterId;
  if (chapterSwitched) rememberEditorPosition();
  setEmpty(!ch, '这部作品还没有章节', '新建第一章，再让右侧助手按章纲生成正文。', true);
  const stage = ch ? stageOf(ch) : 'draft';
  $('#chStage').value = stage;
  $('#chStage').className = `stage-select st-${stage}`;
  $('#chTitle').value = ch?.title || '';
  const taEl = $('#chContent');
  const nextContent = ch?.content || '';
  if (taEl.value !== nextContent) { taEl.value = nextContent; resetCounted(ch); }   // 值没变就别赋值，免得光标被弹到末尾
  if (chapterSwitched && nextChapterId) restoreEditorPosition(nextNovelId, nextChapterId, taEl);
  EDITOR_TRACK.novelId = nextNovelId;
  EDITOR_TRACK.chapterId = nextChapterId;
  renderWordChip();
  histSync();
  $('#genWords').value = n.meta.targetWordsPerChapter || 3000;
  $('#genModel').placeholder = S.config?.model || '默认';
  updateFoot();
  renderChapterOutlineCard();
  renderRevisionCard();
  renderTopbarActions();
}

// 章节落盘的字段集合：自动保存 / 兜底保存 / 立即保存共用
function chapterSavePayload(ch) {
  return {
    title: ch.title, content: ch.content, summary: ch.summary, stage: stageOf(ch),
    targetWords: targetOf(ch),
    memory: ch.memory, status: ch.status, outline: ch.outline, outlineId: ch.outlineId,
    revisions: Array.isArray(ch.revisions) ? ch.revisions : undefined,
    annotations: ch.annotations,
    scenes: Array.isArray(ch.scenes) ? ch.scenes : undefined,   // 场景卡片：不带上就会在刷新后消失
    counted: peekCounted(ch.id),        // 这次该给今日码字量记多少（见「码字量计数」）
  };
}

const saveChapterDebounced = debounce(() => { flushSave(); }, 600);

/* ------------------------------------------------------------
 * 落盘：任何一章的改动都要有归属，失败就自动重试，绝不静默丢掉
 * ------------------------------------------------------------
 * S.unsaved 记录「哪些章还没写进磁盘」。切章时若保存失败，这一章会留在集合里，
 * 之后的自动重试会把它一起补上 —— 只用一个全局 dirty 标记的话，在新章保存成功时
 * 就把旧章的未保存状态一起抹掉了，那份改动直到关页面都没人管。
 */
const SAVE_RETRY_MIN = 3000;
const SAVE_RETRY_MAX = 15000;
let saveRetryTimer = null;
let saveRetryDelay = SAVE_RETRY_MIN;

function scheduleSaveRetry() {
  if (saveRetryTimer || !S.unsaved.size) return;
  saveRetryTimer = setTimeout(async () => {
    saveRetryTimer = null;
    await flushSave().catch(() => {});
    if (S.unsaved.size) {
      saveRetryDelay = Math.min(saveRetryDelay * 2, SAVE_RETRY_MAX);
      scheduleSaveRetry();
    }
  }, saveRetryDelay);
}

/** 立刻把某一章写回服务端；不在待存集合里就直接跳过。调用方可 await。 */
async function saveChapterNow(id = S.chapterId) {
  if (!S.unsaved.has(id)) return false;
  const ch = S.novel?.chapters.find((c) => c.id === id);
  if (!ch) {
    // 这一章已经不在了（被删 / 被整本替换），别让它卡在待存集合里无限重试
    S.unsaved.delete(id);
    S.dirty = S.unsaved.size > 0;
    refreshSavePill();
    return false;
  }
  const isCurrent = id === S.chapterId;
  saveChapterDebounced.cancel();
  if (isCurrent) { S.savingId = id; refreshSavePill(); }
  const payload = chapterSavePayload(ch);
  try {
    await api.put(`/api/novels/${S.novel.id}/chapters/${id}`, payload);
  } catch (err) {
    // 期间可能已经有另一次保存把这一章写成功了（并发/重试重叠），那就别记这次失败
    if (!S.unsaved.has(id)) return false;
    const firstFailure = !S.saveErr;
    S.savingId = null;
    S.saveErr = err.message || '未知错误';
    refreshSavePill();
    scheduleSaveRetry();
    // 只在「第一次失败」时弹提示，免得自动重试把屏幕刷满
    if (firstFailure) toast(`保存失败：${S.saveErr} · 会自动重试，别关页面`, 'err');
    throw err;
  }
  S.saveErr = null;
  saveRetryDelay = SAVE_RETRY_MIN;
  S.unsaved.delete(id);
  commitCounted(id, payload.counted);   // 服务端收下了这次的字数，销账
  S.dirty = S.unsaved.size > 0;
  if (isCurrent) S.savingId = null;
  refreshSavePill();
  renderTopbarActions();
  loadNovels();
  loadStats();          // 节流 5 秒：今日码字量跟着正文涨
  return true;
}

/** 把待存集合里的每一章都写回服务端，返回是否已全部落盘 */
async function saveAllPending() {
  for (const id of [...S.unsaved]) {
    try {
      await saveChapterNow(id);
    } catch {
      // 失败的那一章仍留在 S.unsaved 里，交给重试
    }
  }
  if (S.unsaved.size) scheduleSaveRetry();
  else saveRetryDelay = SAVE_RETRY_MIN;
  return S.unsaved.size === 0;
}

// 兜底保存：失焦、切章、切标签页、关闭页面时立刻落盘。
// beacon=true 只用于页面即将卸载的场景（sendBeacon 是唯一能活过卸载的方式），
// 但它有 64KB 上限且失败时返回 false —— 失败时保留待存状态，让关闭拦截与重试接着管。
function flushSave({ beacon = false } = {}) {
  if (!S.unsaved.size) return Promise.resolve(true);
  if (!beacon) return saveAllPending();
  // 关页面：待存的每一章都投一个 beacon（beacon 是唯一能活过卸载的请求）
  saveChapterDebounced.cancel();
  let allOk = true;
  for (const id of [...S.unsaved]) {
    const ch = S.novel?.chapters.find((c) => c.id === id);
    if (!ch) { S.unsaved.delete(id); continue; }
    const url = `/api/novels/${S.novel.id}/chapters/${id}`;
    const payload = chapterSavePayload(ch);
    let ok = false;
    try {
      ok = navigator.sendBeacon(url, new Blob([JSON.stringify(payload)], { type: 'application/json' }));
    } catch { ok = false; }
    if (ok) { S.unsaved.delete(id); commitCounted(id, payload.counted); }
    else {
      allOk = false;
      // 尽力而为，但不清待存状态（页面可能下一秒就没了）；
      // 若这次 PUT 其实成功了，也要把码字量的账销掉，免得留在页面里重复上报
      api.put(url, payload).then(() => commitCounted(id, payload.counted)).catch(() => {});
    }
  }
  S.dirty = S.unsaved.size > 0;
  refreshSavePill();
  return Promise.resolve(allOk);
}

window.addEventListener('beforeunload', (e) => {
  rememberEditorPosition();
  if (!S.unsaved.size && !S.saveErr) return;
  flushSave({ beacon: true });
  // 还没落盘、或上一次保存本来就失败（服务多半还没起来）→ 拦一下
  if (S.unsaved.size || S.saveErr) {
    e.preventDefault();
    e.returnValue = '';
  }
});
// 切标签页只是「离开视线」，页面还活着 —— 走普通 PUT，失败时仍由重试接着管
document.addEventListener('visibilitychange', () => { if (document.hidden) { rememberEditorPosition(); flushSave().catch(() => {}); } });
window.addEventListener('pagehide', rememberEditorPosition);

/** 任意一章有改动（不只是当前章）都走这里：加入待存集合并排队落盘 */
function markChapterDirty(ch) {
  if (!ch) return;
  S.unsaved.add(ch.id);
  S.dirty = true;
  S.saveErr = null;
  refreshSavePill();
  saveChapterDebounced();
}

function markDirty() {
  const ch = currentChapter();
  if (ch) return markChapterDirty(ch);
  S.dirty = S.unsaved.size > 0;
  refreshSavePill();
}

// 状态胶囊本身也是「保存」按钮：失败时点一下就重试
function manualSave() {
  if (!S.unsaved.size) return toast('没有需要保存的改动');
  flushSave().then((ok) => toast(ok ? '已保存' : '保存失败，会自动重试', ok ? 'ok' : 'err'));
}
$('#savePill').addEventListener('click', manualSave);

$('#chTitle').addEventListener('input', () => {
  const ch = currentChapter();
  if (!ch) return;
  ch.title = $('#chTitle').value;
  const li = chapterRow(ch.id);
  if (li) li.querySelector('.ci-title').textContent = ch.title || '未命名';
  markDirty();
});

/* ============================================================
 * 5.5 撤销 / 重做
 * ------------------------------------------------------------
 * 稿纸是原生 textarea，而「给 .value 赋值」会把浏览器自带的撤销栈清空 ——
 * 也就是说 AI 只要往正文里写过一次，Ctrl+Z 就彻底失灵了。
 * 所以这里自己维护一份：每章一条历史，连续打字合成一步，
 * AI 写入 / 粘贴 / 一键排版各自单独成一步（撤一下就回到操作前）。
 * ============================================================ */
const HIST = {
  map: new Map(),      // 章节 id → { undo: [], redo: [] }
  chapterId: null,     // 当前历史属于哪一章
  cur: null,           // 当前编辑器状态 { v: 内容, s/e: 选区 }
  last: 0,             // 上次记录时间，用于合并连续输入
  composing: false,    // 中文输入法组字中
};

/* ------------------------------------------------------------
 * 码字量计数：只算「真的敲进去 / 插进去」的字
 * ------------------------------------------------------------
 * 服务端只能看到「正文变多了」，分不清那是你写的、还是撤销 / 重做还原回来的。
 * 所以由前端记账：内容一变就比对字数，涨了才计；撤销重做还原的那次不计。
 * 每次保存把账本交给服务端（counted 字段），保存成功了才销账。
 * 这样「写 200 字 → 撤销 → 重做」只记 200 字，而不是 400 字。
 */
const countedWords = new Map();   // 章节 id → 上次记账时的字数
const pendingCounted = new Map(); // 章节 id → 还没报给服务端的字数

/** 内容变化后记账；counted=false 用于撤销 / 重做这类「还原」 */
function countEditorChange(ch, { counted = true } = {}) {
  if (!ch) return;
  const w = countWords($('#chContent').value);
  const prev = countedWords.has(ch.id) ? countedWords.get(ch.id) : w;
  countedWords.set(ch.id, w);
  if (counted && w > prev) pendingCounted.set(ch.id, (pendingCounted.get(ch.id) || 0) + (w - prev));
}

/** 这次保存该报多少字 */
function peekCounted(id) { return pendingCounted.get(id) || 0; }

/** 保存成功后销账：只扣掉确实报出去的那部分，期间新敲的继续留着 */
function commitCounted(id, sent) {
  const left = (pendingCounted.get(id) || 0) - (Number(sent) || 0);
  if (left > 0) pendingCounted.set(id, left);
  else pendingCounted.delete(id);
}

/** 切章 / 外部改动（替换、恢复快照）后重新立基准，别把别人的变化记成你写的 */
function resetCounted(ch) {
  if (ch) countedWords.set(ch.id, countWords($('#chContent').value));
}

const HIST_MAX = 120;         // 每章最多留多少步
const HIST_MERGE_MS = 900;    // 这个间隔内的连续输入算一步
const HIST_JUMP = 50;         // 一次变化超过这么多字，判定为程序写入 / 粘贴，单独成一步
const HIST_CHAR_BUDGET = 4_000_000;  // 每章历史最多占多少字符（约 8MB），防止超长章节吃光内存

function histState(id) {
  let st = HIST.map.get(id);
  if (!st) { st = { undo: [], redo: [] }; HIST.map.set(id, st); }
  return st;
}

/** 历史里所有快照的总字符数 */
function histChars(st) {
  let n = 0;
  for (const s of st.undo) n += s.v.length;
  for (const s of st.redo) n += s.v.length;
  return n;
}

/** 按步数和总字符数双重限流；至少保留一步，保证还能撤销 */
function trimHist(st) {
  while (st.undo.length > HIST_MAX) st.undo.shift();
  while (st.redo.length > HIST_MAX) st.redo.shift();
  let total = histChars(st);
  while (total > HIST_CHAR_BUDGET && st.undo.length > 1) total -= st.undo.shift().v.length;
  while (total > HIST_CHAR_BUDGET && st.redo.length > 1) total -= st.redo.shift().v.length;
}

function editorSnap() {
  const ta = $('#chContent');
  return { v: ta.value, s: ta.selectionStart ?? 0, e: ta.selectionEnd ?? 0 };
}

function updateUndoButtons() {
  const ch = currentChapter();
  const st = ch ? histState(ch.id) : { undo: [], redo: [] };
  const u = $('#undoBtn');
  const r = $('#redoBtn');
  if (u) u.disabled = !st.undo.length;
  if (r) r.disabled = !st.redo.length;
}

/** 编辑器内容被外部改动（切章、查找替换、重新渲染）后同步基准 */
function histSync() {
  const ch = currentChapter();
  if (!ch) { HIST.chapterId = null; HIST.cur = null; updateUndoButtons(); return; }
  const v = $('#chContent').value;
  if (HIST.chapterId === ch.id) {
    if (HIST.cur && HIST.cur.v === v) { updateUndoButtons(); return; }
    // 同一章内容却被外部改了（比如全书替换）：历史已对不上，清掉更安全
    const st = histState(ch.id);
    st.undo.length = 0; st.redo.length = 0;
  }
  HIST.chapterId = ch.id;
  HIST.cur = { v, s: 0, e: 0 };
  HIST.last = 0;
  updateUndoButtons();
}

/** 内容变化时调用：决定要不要留下一个撤销点 */
function histEdit() {
  const ch = currentChapter();
  if (!ch) return;
  const cur = editorSnap();
  if (HIST.chapterId !== ch.id || !HIST.cur) {   // 刚切过来，先立基准
    HIST.chapterId = ch.id;
    HIST.cur = cur;
    HIST.last = Date.now();
    return;
  }
  const base = HIST.cur;
  if (base.v === cur.v) { HIST.cur = cur; return; }   // 只是挪了光标
  const now = Date.now();
  const st = histState(ch.id);
  const jump = Math.abs(cur.v.length - base.v.length) > HIST_JUMP;
  const merge = !jump && st.undo.length && now - HIST.last < HIST_MERGE_MS;
  if (!merge) {
    st.undo.push(base);
    trimHist(st);
  }
  st.redo.length = 0;          // 有了新改动，原来的重做链就断了
  HIST.cur = cur;
  HIST.last = now;
  updateUndoButtons();
}

/** 光标 / 选区变化时记一笔，撤销后能回到原来的位置 */
function histCaret() {
  if (!HIST.cur) return;
  const ta = $('#chContent');
  HIST.cur.s = ta.selectionStart ?? 0;
  HIST.cur.e = ta.selectionEnd ?? 0;
}

function applySnap(snap) {
  const ta = $('#chContent');
  ta.value = snap.v;
  const len = snap.v.length;
  const s = Math.max(0, Math.min(snap.s ?? len, len));
  const e = Math.max(s, Math.min(snap.e ?? s, len));
  HIST.cur = { v: snap.v, s, e };
  HIST.last = 0;
  resetCounted(currentChapter());   // 撤销 / 重做是还原，不记码字量
  ta.focus();
  try { ta.setSelectionRange(s, e); } catch { /* 忽略 */ }
  editorChanged();             // 同步字数、脏标记、自动保存
}

function doUndo() {
  const ch = currentChapter();
  if (!ch) return;
  const st = histState(ch.id);
  if (!st.undo.length) return toast('没有可撤销的操作了');
  st.redo.push(editorSnap());
  trimHist(st);
  applySnap(st.undo.pop());
  const after = histState(ch.id);
  toast(after.undo.length ? `已撤销 · 还能再撤 ${after.undo.length} 步` : '已撤销');
}

function doRedo() {
  const ch = currentChapter();
  if (!ch) return;
  const st = histState(ch.id);
  if (!st.redo.length) return toast('没有可重做的操作了');
  st.undo.push(editorSnap());
  trimHist(st);
  applySnap(st.redo.pop());
  toast('已重做');
}

$('#undoBtn').addEventListener('click', () => { doUndo(); $('#chContent').focus(); });
$('#redoBtn').addEventListener('click', () => { doRedo(); $('#chContent').focus(); });

$('#chContent').addEventListener('input', (e) => {
  // 中文输入法组字过程中不要记点，等 compositionend 一次性记
  if (!HIST.composing && !e.isComposing) histEdit();
  countEditorChange(currentChapter());
  editorChanged();
});
$('#chContent').addEventListener('compositionstart', () => { HIST.composing = true; });
$('#chContent').addEventListener('compositionend', () => {
  HIST.composing = false;
  histEdit();
  countEditorChange(currentChapter());
  editorChanged();
});

function editorChanged() {
  const ch = currentChapter();
  if (!ch) return;
  ch.content = $('#chContent').value;
  const w = wordsOf(ch);
  renderWordChip();
  const li = chapterRow(ch.id);
  if (li) li.querySelector('.ci-words').textContent = w;
  markDirty();
  hideSelToolbar();
  updateUndoButtons();
  updateFoot();
}

$('#chContent').addEventListener('keydown', (e) => {
  const ta = e.target;
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return; }
    if (k === 'y') { e.preventDefault(); doRedo(); return; }
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    ta.setRangeText('　　', ta.selectionStart, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input'));
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    const before = ta.value.slice(0, ta.selectionStart);
    const line = before.slice(before.lastIndexOf('\n') + 1);
    if (line.startsWith('　　')) {
      e.preventDefault();
      ta.setRangeText('\n　　', ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    } else if (line.trim() === '' && line.length > 0) {
      e.preventDefault();
      ta.setRangeText('\n', ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    }
  }
});

/** 写作栏顶部的「本章章纲」卡片：显示当前真正会喂给 AI 的场景/人物/概要/钩子 */
function renderChapterOutlineCard() {
  const card = $('#chapterOutlineCard');
  if (!card) return;
  const ch = currentChapter();
  if (!S.novel || !ch) { card.hidden = true; return; }
  card.hidden = false;
  const { outline, linked } = effectiveChapterOutline(ch);
  const badge = $('#coBadge');
  badge.textContent = linked ? '已关联大纲' : '仅本章';
  badge.classList.toggle('linked', !!linked);
  $('#coLocate').hidden = !linked;
  const rows = [
    ['场景', outline.scene],
    ['人物', outline.characters],
    ['概要', outline.summary],
    ['钩子', outline.hook],
  ].filter(([, value]) => value);
  $('#coEdit').textContent = rows.length ? '编辑' : '添加';
  $('#coBody').innerHTML = rows.length
    ? rows.map(([label, value]) => `<div class="co-row"><span class="co-k">${label}</span><span class="co-v">${esc(value)}</span></div>`).join('')
    : `<div class="co-empty">还没有本章章纲。补上场景、人物和章末钩子，生成本章时会更贴大纲。<button type="button" class="btn btn-sm btn-text" data-co-edit>现在补上</button></div>`;
}

const OUTLINE_FIELDS = ['scene', 'characters', 'summary', 'hook'];

async function openChapterOutlineModal() {
  const ch = currentChapter();
  if (!ch || !S.novel) return;
  const novelId = S.novel.id;
  // 章纲保存只改章纲字段，但如果正文还有没落盘的改动，先把它写下去，别让两个请求互相覆盖
  await flushSave().catch(() => {});
  // 等落盘的这一小会儿里，作者可能已经切了章 / 切了书，别把弹窗开在错的章节上
  if (S.novel?.id !== novelId || S.chapterId !== ch.id) return;
  const { outline, linked } = effectiveChapterOutline(ch);
  const value = (key) => esc(outline[key] || '');
  showModal(`<h3>编辑本章章纲</h3>
    <p class="modal-sub">${linked ? '保存后会同时更新设定库里的对应章纲。' : '这一章没有关联大纲，章纲只用于本章生成。'}</p>
    <div class="co-form">
      <label class="field-label">场景 / 地点<textarea class="textarea" id="coScene" rows="2" placeholder="例：深夜的宗门后山，雨还没停。">${value('scene')}</textarea></label>
      <label class="field-label">出场人物<input class="input" id="coCharacters" value="${value('characters')}" placeholder="例：林昭、沈鹤" /></label>
      <label class="field-label">核心事件<textarea class="textarea" id="coSummary" rows="3" placeholder="例：林昭撞见沈鹤私会外敌，被迫交手，只暴露一半实力。">${value('summary')}</textarea></label>
      <label class="field-label">章末钩子<textarea class="textarea" id="coHook" rows="2" placeholder="例：长老在暗处看清了那一剑，认出了他的师承。">${value('hook')}</textarea></label>
    </div>
    <div class="modal-foot">
      <button class="btn btn-text" id="coCancel">取消</button>
      <button class="btn btn-primary" id="coSave">保存章纲</button>
    </div>`, (box) => {
    const save = async () => {
      const btn = box.querySelector('#coSave');
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = '保存中…';
      const values = {
        scene: box.querySelector('#coScene').value.trim(),
        characters: box.querySelector('#coCharacters').value.trim(),
        summary: box.querySelector('#coSummary').value.trim(),
        hook: box.querySelector('#coHook').value.trim(),
      };
      try {
        const res = await api.put(`/api/novels/${novelId}/chapters/${ch.id}/outline`, { outline: values });
        ch.outline = res.chapter?.outline || null;
        if (S.novel?.id === novelId) {
          const linkedNow = linkedOutlineOf(ch);
          if (linkedNow) {
            for (const key of OUTLINE_FIELDS) {
              if (ch.outline?.[key]) linkedNow.entry[key] = ch.outline[key];
              else delete linkedNow.entry[key];
            }
          }
          renderChapterOutlineCard();
          updateFoot();
        }
        closeModal();
        toast('本章章纲已保存', 'ok');
      } catch (err) {
        btn.disabled = false;
        btn.textContent = '保存章纲';
        toast(err.message, 'err');
      }
    };
    box.querySelector('#coCancel').onclick = () => closeModal();
    box.querySelector('#coSave').onclick = save;
    box.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); save(); }
    });
    box.querySelector('#coScene').focus();
  });
}

function updateFootSuggest() {
  const suggestion = $('#footSuggest');
  if (!suggestion) return;
  const ch = currentChapter();
  const empty = !($('#chContent')?.value || '').trim();
  const hasProseOutput = !!S.out && PROSE_OUT_TASKS.has(S.outTask);
  const canSuggest = !!S.novel && !!ch && empty && !S.controller && !S.batchController && (hasProseOutput || !S.out);
  suggestion.hidden = !canSuggest;
  if (!canSuggest) return;
  $('#footSuggestText').textContent = hasProseOutput ? '初稿已生成，去采用' : '用 AI 写初稿';
  suggestion.title = hasProseOutput ? '滚到输出区，把刚才的初稿写进正文' : '让 AI 按章纲写一段初稿；缺模型会先带你接好';
}

function updateFoot() {
  const ch = currentChapter();
  if (!ch) {
    $('#footInfo').textContent = '';
    updateFootSuggest();
    return;
  }
  const i = S.novel.chapters.indexOf(ch);
  const vol = volumesOf().length ? volumeTitle(effVolumeIds()[i]) : '';
  const hook = effectiveChapterOutline(ch).outline.hook;
  const target = targetOf(ch);
  const pct = progressOf(ch);
  $('#footInfo').textContent = [
    vol,
    `第 ${i + 1} / ${S.novel.chapters.length} 章`,
    target ? `目标 ${fmtWords(target)} · ${pct}%${pct >= 100 ? ' 已达标' : ''}` : '',
    ch.memory ? '已存档记忆' : '未生成记忆',
    hook ? `钩子：${hook}` : '',
  ].filter(Boolean).join('　·　');
  updateFootSuggest();
}

$('#footSuggest')?.addEventListener('click', () => {
  if (S.out && PROSE_OUT_TASKS.has(S.outTask)) return revealOutput({ toActions: true });
  generateChapter();
});

/** 当前搜索 / 筛选会把这一章藏起来时，清掉对应的条件；返回是否清过。
 *  拆分 / 合并 / 新建章节后，新标题或新章号可能不匹配当前搜索，先用它恢复可见性。 */
function clearFiltersHidingChapter(id) {
  const n = S.novel;
  const idx = n ? n.chapters.findIndex((c) => c.id === id) : -1;
  const ch = idx >= 0 ? n.chapters[idx] : null;
  if (!ch) return false;
  let cleared = false;
  if (!stageMatches(ch, S.stageFilter)) { S.stageFilter = ''; cleared = true; }
  if (!chapterMatchesSearch(ch, idx, S.chapterSearch)) { S.chapterSearch = ''; cleared = true; }
  return cleared;
}

function selectChapter(id) {
  // 从看板 / 全局检索 / 命令面板跳过来时，目标章可能被搜索或筛选藏起来，先恢复完整列表
  const hidden = clearFiltersHidingChapter(id);
  // 搜索还在时，光标跟着选中章走，继续按 ↑ / ↓ 就从这里往下翻
  S.chapterCursor = S.chapterSearch.trim() ? id : '';
  paintChapterCursor();
  flushSave();
  S.chapterId = id;
  S.out = ''; S.reasoning = '';
  renderOut();
  // 列表已经在就只挪选中态；首次进入 / 刚切回写作台时才整块重建
  const hasList = !!$('#chapterList').querySelector('.chapter-item');
  renderStudio({ list: !hasList || hidden });
}

$('#chStage').addEventListener('change', () => {
  const ch = currentChapter();
  if (!ch) return;
  const stage = $('#chStage').value;
  if (!STAGE_LABEL[stage] || stageOf(ch) === stage) return;
  ch.stage = stage;
  markChapterDirty(ch);
  renderStudio();
  toast(`已标为「${STAGE_LABEL[stage]}」`, 'ok');
});

$('#stageFilter').addEventListener('change', () => {
  S.stageFilter = $('#stageFilter').value;
  renderStudio();
});
$('#volExpandBtn').addEventListener('click', toggleAllVolumes);
// 搜索只改左侧列表，不必整块重画编辑器；长篇连续输入时更跟手
const refreshChapterList = () => { if (S.novel) renderChapterList(S.novel); };
const visibleChapterRows = () => (S.vl.rows || []).filter((row) => row.kind === 'chapter');

/** 把键盘光标画到当前列表里；虚拟滚动重画时 makeChapterItem 也会带上 cursor 类 */
function paintChapterCursor() {
  const ul = $('#chapterList');
  if (!ul) return;
  ul.querySelectorAll('.chapter-item.cursor').forEach((el) => el.classList.remove('cursor'));
  if (!S.chapterCursor) return;
  ul.querySelector(`.chapter-item[data-id="${S.chapterCursor}"]`)?.classList.add('cursor');
}

/** 把键盘光标滚进可视区；虚拟滚动时先滚再重画，普通列表直接 scrollIntoView */
function revealChapterCursor(rows, index) {
  const ul = $('#chapterList');
  const id = rows[index]?.c.id;
  if (!ul || !id) return;
  if (!S.vl.enabled) {
    ul.querySelector(`.chapter-item[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
    return;
  }
  const rowIndex = (S.vl.rows || []).findIndex((row) => row.kind === 'chapter' && row.c.id === id);
  if (rowIndex < 0) return;
  const top = S.vl.offsets[rowIndex];
  const bottom = S.vl.offsets[rowIndex + 1];
  const clientH = ul.clientHeight || 400;
  if (top < ul.scrollTop || bottom > ul.scrollTop + clientH) {
    ul.scrollTop = Math.max(0, top - Math.floor(clientH / 2) + Math.floor((bottom - top) / 2));
    renderVirtualList(ul, ul.scrollTop);
  }
}

function moveChapterCursor(step) {
  const rows = visibleChapterRows();
  if (!rows.length) return;
  const current = rows.findIndex((row) => row.c.id === S.chapterCursor);
  const next = stepSearchCursor(current, step, rows.length);
  S.chapterCursor = rows[next]?.c.id || '';
  revealChapterCursor(rows, next);
  paintChapterCursor();
}

$('#chapterSearch').addEventListener('input', () => {
  S.chapterSearch = $('#chapterSearch').value;
  S.chapterCursor = '';
  $('#chapterSearchClear').hidden = !S.chapterSearch;
  refreshChapterList();
});
$('#chapterSearchClear').addEventListener('click', () => {
  S.chapterSearch = '';
  S.chapterCursor = '';
  $('#chapterSearch').value = '';
  $('#chapterSearchClear').hidden = true;
  refreshChapterList();
  $('#chapterSearch').focus();
});
$('#chapterSearch').addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;   // 中文输入法回车 / 方向键留给候选词
  if (e.key === 'Escape') {
    if (!$('#chapterSearch').value) return;
    e.preventDefault();
    S.chapterSearch = '';
    S.chapterCursor = '';
    $('#chapterSearch').value = '';
    $('#chapterSearchClear').hidden = true;
    refreshChapterList();
    return;
  }
  if (!S.chapterSearch.trim()) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    moveChapterCursor(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const id = S.chapterCursor || visibleChapterRows()[0]?.c.id;
    if (id) selectChapter(id);
  }
});
$('#boardBtn').addEventListener('click', openChapterBoard);
$('#chWords').addEventListener('click', () => {
  const ch = currentChapter();
  if (!ch) return;
  openChapterTargetModal(S.novel.chapters.indexOf(ch));
});
$('#focusBtn').addEventListener('click', toggleFocus);
$('#focusPrev').addEventListener('click', () => stepChapter(-1));
$('#focusNext').addEventListener('click', () => stepChapter(1));
$('#focusExit').addEventListener('click', exitFocus);

$('#coEdit').addEventListener('click', openChapterOutlineModal);
$('#coLocate').addEventListener('click', () => {
  const ch = currentChapter();
  if (ch?.outlineId) gotoSettingsOutline(ch.outlineId);
});
$('#coBody').addEventListener('click', (e) => {
  if (e.target.closest('[data-co-edit]')) openChapterOutlineModal();
});

async function moveChapter(from, to) {
  const n = S.novel;
  if (!n || from < 0 || from >= n.chapters.length || to < 0 || to >= n.chapters.length || from === to) return false;
  // 分卷归属跟着「位置」走：记住移动前每个位置的卷，移动后把整段重新钉一遍。
  // 只对首尾两个位置处理是不够的 —— 跨多章移动时，中间章节整体位移会让卷边界提前或延后。
  const eff = volumesOf().length ? effVolumeIds() : null;
  const [item] = n.chapters.splice(from, 1);
  n.chapters.splice(to, 0, item);
  let volumeSave = Promise.resolve();
  if (eff) {
    const vols = volumesOf();
    const byOutline = new Map();
    for (const v of vols) for (const o of (v.chapters || [])) if (o?.id) byOutline.set(o.id, v.id || '');
    const known = new Set(vols.map((v) => v.id).filter(Boolean));
    const sets = [];
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    let inherit = lo > 0 ? (eff[lo - 1] || '') : '';
    for (let i = lo; i <= hi; i += 1) {
      const ch = n.chapters[i];
      if (!ch) continue;
      const raw = typeof ch.volumeId === 'string' ? ch.volumeId : null;
      const own = raw === null ? null : raw === '' || raw === '-' ? '' : known.has(raw) ? raw : null;
      const fromOutline = own === null && ch.outlineId ? byOutline.get(ch.outlineId) : '';
      const current = own !== null ? own : (fromOutline || inherit);
      const want = eff[i] || '';
      if (current !== want) {
        if (ch.volumeId !== want) { ch.volumeId = want; sets.push({ id: ch.id, volumeId: want }); }
        inherit = want;
      } else {
        inherit = current;
      }
    }
    volumeSave = saveChapterVolumes(sets);
  }
  renderStudio();
  await volumeSave;
  try {
    const { novel } = await api.put(`/api/novels/${n.id}`, { chapters: n.chapters });
    syncOrder(novel.chapters);
    renderStudio();
    return true;
  } catch (err) {
    toast(`移动失败：${err.message}`, 'err');
    return false;
  }
}

/** 只按服务端返回的顺序校正本地章节次序，不替换本地对象 ——
 *  整份替换会把「请求发出后敲进去的字」从内存里抹掉，稿纸随即被回滚。 */
function syncOrder(serverChapters) {
  const n = S.novel;
  if (!n) return;
  const rank = new Map((serverChapters || []).map((c, i) => [c.id, i]));
  n.chapters.sort((a, b) => (rank.get(a.id) ?? -1) - (rank.get(b.id) ?? -1));
}

/** 下一章如果能在章纲里找到还没建过的一条，就用它：章节名 / 概要 / 章纲 / 归属一起带上 */
function nextUncreatedOutlineChapter(novel) {
  const used = new Set((novel.chapters || []).map((c) => c.outlineId).filter(Boolean));
  for (const volume of novel.outline?.volumes || []) {
    for (const ch of volume.chapters || []) {
      if (ch && !used.has(ch.id)) return { volume, chapter: ch };
    }
  }
  return null;
}

async function addChapter() {
  const n = S.novel;
  if (!n) return toast('先打开一部作品', 'err');
  const at = n.chapters.findIndex((c) => c.id === S.chapterId);
  const eff = volumesOf().length ? effVolumeIds() : null;
  const insertAt = at >= 0 ? at + 1 : n.chapters.length;
  const insertAtArg = at >= 0 ? at + 1 : undefined;
  const linked = nextUncreatedOutlineChapter(n);
  let payload;
  if (linked) {
    // 有章纲就按章纲建，没有就回退空白章
    const outline = { scene: linked.chapter.scene, characters: linked.chapter.characters, summary: linked.chapter.summary, hook: linked.chapter.hook };
    payload = {
      title: linked.chapter.title || `第 ${n.chapters.length + 1} 章`,
      summary: linked.chapter.summary || '',
      outline: Object.values(outline).some(Boolean) ? outline : null,
      outlineId: linked.chapter.id,
      volumeId: linked.volume.id,
      at: insertAtArg,
    };
  } else {
    // 新章节跟着当前章走，落在同一卷里
    payload = {
      title: `第 ${n.chapters.length + 1} 章`,
      at: insertAtArg,
      volumeId: eff && at >= 0 ? (eff[at] || '') : '',
    };
  }
  const { chapter } = await api.send(`/api/novels/${n.id}/chapters`, payload);
  n.chapters.splice(insertAt, 0, chapter);
  // 新章是草稿；如果当前正筛着「定稿」之类，或搜索词不匹配，会把刚建的章藏起来，先回到全部
  clearFiltersHidingChapter(chapter.id);
  // 新章带着明确归属；紧跟其后的那一章若原本只是「跟着上一章」，会被它带跑，
  // 所以顺手把那一章的归属写死。
  if (eff && insertAt < eff.length) {
    const nextCh = n.chapters[insertAt + 1];
    const keep = eff[insertAt] || '';
    if (nextCh && typeof nextCh.volumeId !== 'string') {
      nextCh.volumeId = keep;
      saveChapterVolumes([{ id: nextCh.id, volumeId: keep }]);
    }
  }
  S.chapterId = chapter.id;
  renderStudio();
  $('#chTitle').focus(); $('#chTitle').select();
}
$('#addChapterBtn').addEventListener('click', addChapter);
$('#editorEmptyBtn').addEventListener('click', addChapter);

$('#formatBtn').addEventListener('click', () => {
  const ta = $('#chContent');
  const lines = ta.value.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim());
  const out = [];
  lines.forEach((l) => {
    if (l === '') { if (out.length && out[out.length - 1] !== '') out.push(''); return; }
    out.push(`　　${l.replace(/^[　\s]+/, '')}`);
  });
  while (out.length && out[out.length - 1] === '') out.pop();
  ta.value = out.join('\n');
  ta.dispatchEvent(new Event('input'));
  toast('已统一段落格式 · 按 Ctrl+Z 可撤销', 'ok');
});

/** 阅读模式：整章排版阅读，可左右翻章与调字号，不改动正文 */
function openReader(startId = S.chapterId, { restore = true } = {}) {
  if (!S.novel) return toast('先打开作品', 'err');
  const chapters = S.novel.chapters;
  if (!chapters.length) return toast('还没有章节', 'err');
  if ($('#readerMask')) return;

  // 恢复阅读进度
  let idx = chapters.findIndex((c) => c.id === startId);
  let size = readerFontSize();
  if (restore) {
    const prog = getReaderProgress(S.novel.id);
    if (prog) {
      const found = chapters.findIndex((c) => c.id === prog.chapterId);
      if (found >= 0) idx = found;
    }
  }
  if (idx < 0) idx = 0;
  const volumeLabels = effVolumeIds().map((id) => volumeTitle(id || ''));
  const prevFocus = document.activeElement;

  const mask = document.createElement('div');
  mask.className = 'reader-mask';
  mask.id = 'readerMask';
  mask.setAttribute('role', 'dialog');
  mask.setAttribute('aria-modal', 'true');
  mask.setAttribute('aria-label', '阅读模式');
  mask.innerHTML = `
    <header class="reader-top">
      <div class="reader-brand">${ico('book')}<span>${esc(S.novel.title)}</span></div>
      <div class="reader-progress" id="readerProgress" role="progressbar" aria-label="全书阅读进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" title="全书阅读进度">
        <span class="reader-progress-bar" id="readerProgressBar"></span>
      </div>
      <div class="reader-tools">
        <button type="button" class="btn btn-sm btn-text reader-toc-btn" id="readerTocBtn" title="目录（T）" aria-haspopup="dialog" aria-expanded="false">${ico('book-open')}<span>目录</span></button>
        <span class="reader-pos" id="readerPos" title="当前章节位置"></span>
        <button type="button" class="btn btn-sm btn-text" id="readerPrev" title="上一章（←）">上一章</button>
        <button type="button" class="btn btn-sm btn-text" id="readerNext" title="下一章（→）">下一章</button>
        <span class="reader-divider"></span>
        <button type="button" class="btn btn-sm btn-text" id="readerMinus" title="缩小字号">A−</button>
        <button type="button" class="btn btn-sm btn-text" id="readerPlus" title="放大字号">A＋</button>
        <button type="button" class="btn btn-sm" id="readerClose">关闭</button>
      </div>
    </header>
    <main class="reader-scroll" id="readerScroll">
      <article class="reader-page" id="readerPage" tabindex="-1">
        <div class="reader-kicker" id="readerKicker"></div>
        <h1 id="readerTitle"></h1>
        <div class="reader-meta" id="readerMeta"></div>
        <div class="reader-content" id="readerContent"></div>
        <div class="reader-end" id="readerEnd">本章完</div>
        <div class="reader-nav">
          <button type="button" class="btn" id="readerPrev2">上一章</button>
          <button type="button" class="btn" id="readerNext2">下一章</button>
        </div>
      </article>
    </main>
    <div class="reader-toc-mask" id="readerTocMask" hidden>
      <aside class="reader-toc" role="dialog" aria-modal="true" aria-labelledby="readerTocTitle">
        <div class="reader-toc-head">
          <h2 id="readerTocTitle">目录</h2>
          <span class="reader-toc-count" id="readerTocCount"></span>
          <button type="button" class="reader-toc-filter" id="readerTocHideDone" aria-pressed="false" hidden>隐藏已读</button>
          <button type="button" class="icon-btn sm" id="readerTocExpand" title="展开全部卷" aria-label="展开全部卷" hidden><svg class="ico"><use href="#i-unfold" /></svg></button>
          <button type="button" class="icon-btn sm" id="readerTocClose" title="关闭目录（Esc）" aria-label="关闭目录"><svg class="ico"><use href="#i-x" /></svg></button>
        </div>
        <div class="find-bar reader-toc-find">
          <input class="input" id="readerTocSearch" placeholder="搜索章节名 / 章号 / 卷名" title="支持章节名、章号和卷名；Esc 先清空搜索" autocomplete="off" aria-label="搜索目录" />
          <button type="button" class="icon-btn sm" id="readerTocClear" title="清除搜索" aria-label="清除搜索" hidden><svg class="ico"><use href="#i-x" /></svg></button>
        </div>
        <div class="reader-toc-list" id="readerTocList" role="listbox" aria-label="章节列表"></div>
      </aside>
    </div>`;
  document.body.appendChild(mask);

  const $r = (sel) => mask.querySelector(sel);
  const scroll = $r('#readerScroll');
  const page = $r('#readerPage');
  const tocBtn = $r('#readerTocBtn');
  const tocMask = $r('#readerTocMask');
  const tocSearch = $r('#readerTocSearch');
  const tocClear = $r('#readerTocClear');
  const tocCount = $r('#readerTocCount');
  const tocFilter = $r('#readerTocHideDone');
  const tocExpand = $r('#readerTocExpand');
  const tocList = $r('#readerTocList');
  const prev = $r('#readerPrev');
  const next = $r('#readerNext');
  const prev2 = $r('#readerPrev2');
  const next2 = $r('#readerNext2');
  const minus = $r('#readerMinus');
  const plus = $r('#readerPlus');
  let tocOpen = false;
  let tocQuery = '';
  let tocHideDone = false;
  let tocCursor = '';
  let tocClosed = null;       // 手动收起的卷键；null 表示还没按当前章初始化

  const close = () => {
    document.removeEventListener('keydown', onKey);
    if (restoreTimer) { clearTimeout(restoreTimer); restoreTimer = null; }
    flushProgress();
    // 保存字号偏好
    saveReaderFontSize(size);
    mask.remove();
    const canRestore = prevFocus && prevFocus !== document.body && prevFocus.isConnected
      && !prevFocus.closest('[hidden]') && prevFocus.getClientRects().length > 0;
    if (canRestore) prevFocus.focus({ preventScroll: true });
    else $('#previewBtn')?.focus({ preventScroll: true });
  };

  const setSize = () => {
    page.style.setProperty('--reader-size', `${size}px`);
    minus.disabled = size <= 15;
    plus.disabled = size >= 24;
  };

  const paragraphHtml = (content) => {
    const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean);
    return lines.map((line) => {
      if (/^[-—–*]{3,}$/.test(line)) return '<hr class="reader-hr" />';
      return `<p>${esc(line.replace(/^[　\s]+/, ''))}</p>`;
    }).join('');
  };

  let saveTimer = null;
  let scrollTimer = null;
  let restoreTimer = null;
  let restoring = false;

  const currentRatio = () => {
    const maxScroll = scroll.scrollHeight - scroll.clientHeight;
    return maxScroll > 0 ? Math.min(1, Math.max(0, scroll.scrollTop / maxScroll)) : 0;
  };

  /** 顶部进度条按全书算：章号 + 章内位置，和书架卡片 / 命令面板保持同一口径 */
  const updateProgressBar = () => {
    const progressBar = $r('#readerProgressBar');
    if (!progressBar) return;
    const pct = readerPercentOf(idx + 1, currentRatio(), chapters.length);
    const shown = pct === null ? 0 : pct;
    progressBar.style.width = `${shown}%`;
    const wrap = $r('#readerProgress');
    if (wrap) {
      const label = pct === null ? '全书阅读进度' : `全书阅读进度 ${pct}%`;
      if (wrap.title !== label) wrap.title = label;
      if (wrap.getAttribute('aria-valuenow') !== String(shown)) wrap.setAttribute('aria-valuenow', String(shown));
    }
    const pos = $r('#readerPos');
    if (pos) {
      const text = `${idx + 1} / ${chapters.length}${pct === null ? '' : ` · ${pct}%`}`;
      if (pos.textContent !== text) pos.textContent = text;
      const title = pct === null
        ? `第 ${idx + 1} / ${chapters.length} 章`
        : `第 ${idx + 1} / ${chapters.length} 章 · 全书约 ${pct}%`;
      if (pos.title !== title) pos.title = title;
    }
  };

  const saveProgress = () => {
    if (restoring) return;
    const ch = chapters[idx];
    if (!ch) return;
    saveReaderProgress(S.novel.id, {
      chapterId: ch.id,
      chapterNo: idx + 1,
      chapterTitle: ch.title || '',
      ratio: currentRatio(),
    });
  };

  /** 切章 / 关阅读器前先把当前章位置落盘，别让 200–300ms 的节流吞掉上一章 */
  const flushProgress = () => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (scrollTimer) { clearTimeout(scrollTimer); scrollTimer = null; }
    saveProgress();
  };

  const render = () => {
    const ch = chapters[idx];
    const openRevs = openRevisionCount(ch);
    const stage = STAGE_LABEL[stageOf(ch)];
    $r('#readerKicker').textContent = `第 ${idx + 1} 章`;
    $r('#readerTitle').textContent = ch.title || '未命名';
    $r('#readerMeta').textContent = `${stage} · ${fmtWords(wordsOf(ch))} 字${openRevs ? ` · ${openRevs} 项待改` : ''}`;
    const html = paragraphHtml(ch.content);
    $r('#readerContent').innerHTML = html || '<p class="reader-empty">本章还没有正文。</p>';
    $r('#readerEnd').hidden = !html;
    prev.disabled = prev2.disabled = idx <= 0;
    next.disabled = next2.disabled = idx >= chapters.length - 1;
    // 恢复该章上次的滚动位置（每章独立，不再只记住最后读的一章）
    if (restoreTimer) { clearTimeout(restoreTimer); restoreTimer = null; }
    restoring = false;
    const savedRatio = restore ? readerPositionOf(getReaderProgress(S.novel.id), ch.id) : null;
    if (savedRatio !== null) {
      restoring = true;
      // 用 setTimeout 50ms 确保布局完全完成后再恢复滚动位置
      restoreTimer = setTimeout(() => {
        restoreTimer = null;
        const maxScroll = scroll.scrollHeight - scroll.clientHeight;
        if (maxScroll > 0) {
          const target = maxScroll * savedRatio;
          scroll.scrollTop = Math.max(0, Math.min(target, maxScroll));
        }
        restoring = false;
        updateProgressBar();
      }, 50);
    } else {
      scroll.scrollTop = 0;
    }
    updateProgressBar();
    // 节流保存进度
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveProgress, 300);
  };

  const go = (nextIdx) => {
    if (nextIdx < 0 || nextIdx >= chapters.length) return;
    flushProgress();
    idx = nextIdx;
    render();
  };

  /* ---------- 目录抽屉 ---------- */
  const tocGroups = () => buildReaderToc(chapters, volumeLabels, tocQuery);
  const tocLongBook = () => chapters.length > 40;
  const tocIsClosed = (group) => !tocQuery && !!tocClosed?.has(readerTocGroupKey(group));
  const tocRows = () => tocGroups()
    .filter((group) => !tocIsClosed(group))
    .flatMap((group) => group.chapters);

  /** 长篇打开目录时只展开当前章所在卷；之后换章再打开，也保证当前卷是开的 */
  const ensureTocCurrentOpen = () => {
    const groups = buildReaderToc(chapters, volumeLabels, '');
    if (!tocClosed) {
      tocClosed = defaultReaderTocClosed(groups, chapters[idx]?.id, tocLongBook());
      return;
    }
    if (!tocLongBook()) { tocClosed.clear(); return; }
    const cur = groups.find((group) => group.chapters.some(({ chapter }) => chapter.id === chapters[idx]?.id));
    if (cur) tocClosed.delete(readerTocGroupKey(cur));
  };

  const paintTocCursor = () => {
    $$('.reader-toc-item', tocList).forEach((el) => {
      el.classList.toggle('cursor', el.dataset.id === tocCursor);
    });
  };

  const revealTocCursor = () => {
    const el = $$('.reader-toc-item', tocList).find((item) => item.dataset.id === tocCursor);
    if (el) el.scrollIntoView({ block: 'nearest' });
  };

  const renderToc = ({ revealCurrent = false } = {}) => {
    let groups = tocGroups();
    const progress = getReaderProgress(S.novel.id);
    const currentId = chapters[idx]?.id;
    const readById = new Map(chapters.map((ch) => [ch.id, readerChapterRead(readerPositionOf(progress, ch.id))]));
    const doneCount = chapters.filter((ch) => readById.get(ch.id)?.done).length;
    if (!doneCount) tocHideDone = false;
    if (tocHideDone) {
      // 当前章即使是「已读」也留着，免得打开目录找不到自己读到哪
      groups = groups.map((group) => ({
        ...group,
        chapters: group.chapters.filter(({ chapter }) => chapter.id === currentId || !readById.get(chapter.id)?.done),
      })).filter((group) => group.chapters.length);
    }
    const matched = groups.reduce((sum, group) => sum + group.chapters.length, 0);
    const visibleCount = tocHideDone ? matched : chapters.length;
    tocCount.textContent = tocQuery
      ? `找到 ${matched} / ${chapters.length} 章`
      : tocHideDone ? `显示 ${visibleCount} / ${chapters.length} 章` : `共 ${chapters.length} 章`;
    tocClear.hidden = !tocQuery;
    tocFilter.hidden = doneCount === 0;
    tocFilter.setAttribute('aria-pressed', String(tocHideDone));
    tocFilter.textContent = tocHideDone ? '显示全部' : '隐藏已读';
    tocFilter.title = tocHideDone ? '显示全部章节' : `隐藏 ${doneCount} 章已读`;
    tocFilter.setAttribute('aria-label', tocHideDone ? '显示全部章节' : `隐藏已读章节，共 ${doneCount} 章`);
    const canExpandAll = !tocQuery && groups.length >= 2;
    tocExpand.hidden = !canExpandAll;
    if (canExpandAll) {
      const allOpen = groups.every((group) => !tocIsClosed(group));
      const label = allOpen ? '收起全部卷' : '展开全部卷';
      tocExpand.title = label;
      tocExpand.setAttribute('aria-label', label);
    }
    if (!groups.length) {
      tocList.innerHTML = tocQuery
        ? '<div class="reader-toc-empty">没有匹配的章节<br><span>换个章节名、章号或卷名试试</span></div>'
        : '<div class="reader-toc-empty">没有可显示的章节<br><span>点上方「显示全部」查看已读章节</span></div>';
      return;
    }
    tocList.innerHTML = groups.map((group) => {
      const key = readerTocGroupKey(group);
      const open = !tocIsClosed(group);
      const rows = open ? group.chapters.map(({ chapter, index }) => {
        const cur = chapter.id === currentId;
        const stage = stageOf(chapter);
        const read = readById.get(chapter.id);
        return `<button type="button" class="reader-toc-item${cur ? ' current' : ''}${chapter.id === tocCursor ? ' cursor' : ''}" role="option" aria-selected="${cur}"${cur ? ' aria-current="true"' : ''} tabindex="-1" data-id="${esc(chapter.id)}" data-i="${index}">
          <span class="reader-toc-no">${index + 1}</span>
          <i class="reader-toc-dot ${stage}" title="${STAGE_LABEL[stage]}" aria-hidden="true"></i>
          <span class="reader-toc-name" title="${esc(chapter.title || '未命名')}">${esc(chapter.title || '未命名')}</span>
          <span class="reader-toc-words">${fmtWords(wordsOf(chapter))}</span>
          ${read ? `<span class="reader-toc-read${read.done ? ' done' : ''}" title="${read.done ? '本章已读完' : `本章读到 ${read.pct}%`}">${read.done ? '已读' : `<span class="sr-only">本章读到 </span>${read.label}`}</span>` : ''}
        </button>`;
      }).join('') : '';
      return `<div class="reader-toc-group${open ? '' : ' closed'}">
        <button type="button" class="reader-toc-vol" data-toc-vol="${esc(key)}" aria-expanded="${open}" title="${tocQuery ? '搜索时全部展开' : open ? '收起这一卷' : '展开这一卷'}"${tocQuery ? ' disabled' : ''}>
          <svg class="ico reader-toc-chev"><use href="#i-chev-down" /></svg>
          <span>${esc(group.title)}</span><em>${group.chapters.length}</em>
        </button>
        ${rows}
      </div>`;
    }).join('');
    if (revealCurrent) {
      tocList.querySelector('.reader-toc-item.current')?.scrollIntoView({ block: 'center' });
    } else if (tocQuery) {
      tocList.scrollTop = 0;
    }
  };

  const toggleTocGroup = (key) => {
    if (tocQuery || !tocClosed) return;
    const keep = tocList.scrollTop;
    if (tocClosed.has(key)) tocClosed.delete(key);
    else tocClosed.add(key);
    renderToc();
    tocList.scrollTop = keep;
  };

  const toggleAllTocGroups = () => {
    if (tocQuery || !tocClosed) return;
    const groups = tocGroups();
    if (groups.length < 2) return;
    const keep = tocList.scrollTop;
    if (groups.some((group) => tocClosed.has(readerTocGroupKey(group)))) tocClosed.clear();
    else groups.forEach((group) => tocClosed.add(readerTocGroupKey(group)));
    renderToc();
    tocList.scrollTop = keep;
  };

  const openToc = () => {
    if (tocOpen) return;
    tocOpen = true;
    tocQuery = '';
    tocCursor = chapters[idx]?.id || '';
    tocSearch.value = '';
    ensureTocCurrentOpen();
    tocMask.hidden = false;
    tocBtn.setAttribute('aria-expanded', 'true');
    renderToc({ revealCurrent: true });
    tocSearch.focus({ preventScroll: true });
  };

  const closeToc = ({ focus = true } = {}) => {
    if (!tocOpen) return;
    tocOpen = false;
    tocMask.hidden = true;
    tocBtn.setAttribute('aria-expanded', 'false');
    if (focus) tocBtn.focus({ preventScroll: true });
  };

  const jumpToc = (index) => {
    if (!(index >= 0 && index < chapters.length)) return;
    closeToc({ focus: false });
    page.focus({ preventScroll: true });
    if (index === idx) return;   // 点当前章只关目录，别把阅读位置带回顶部
    flushProgress();
    idx = index;
    render();
  };

  const clearTocSearch = () => {
    tocQuery = '';
    tocCursor = chapters[idx]?.id || '';
    tocSearch.value = '';
    ensureTocCurrentOpen();
    renderToc({ revealCurrent: true });
    tocSearch.focus({ preventScroll: true });
  };

  const moveTocCursor = (step) => {
    const rows = tocRows();
    if (!rows.length) return;
    const current = rows.findIndex((row) => row.chapter.id === tocCursor);
    const next = stepSearchCursor(current, step, rows.length);
    tocCursor = rows[next]?.chapter.id || '';
    paintTocCursor();
    revealTocCursor();
  };

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (tocOpen) {
        if (tocQuery) clearTocSearch();
        else closeToc();
        return;
      }
      close();
      return;
    }
    if (tocOpen) return;
    if (e.target?.closest?.('input, textarea, select')) return;
    if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 't' || e.key === 'T')) {
      e.preventDefault();
      openToc();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (window.getSelection() && !window.getSelection().isCollapsed) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(idx - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(idx + 1); }
    else if (e.key === 'PageUp') { e.preventDefault(); scroll.scrollTop -= scroll.clientHeight * 0.9; }
    else if (e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); scroll.scrollTop += scroll.clientHeight * 0.9; }
    else if (e.key === 'Home') { e.preventDefault(); scroll.scrollTop = 0; }
    else if (e.key === 'End') { e.preventDefault(); scroll.scrollTop = scroll.scrollHeight; }
  };

  tocBtn.addEventListener('click', () => (tocOpen ? closeToc() : openToc()));
  $r('#readerTocClose').addEventListener('click', () => closeToc());
  tocClear.addEventListener('click', clearTocSearch);
  tocExpand.addEventListener('click', toggleAllTocGroups);
  tocFilter.addEventListener('click', () => {
    const keep = tocList.scrollTop;
    tocHideDone = !tocHideDone;
    renderToc();
    tocList.scrollTop = keep;
  });
  tocMask.addEventListener('click', (e) => { if (e.target === tocMask) closeToc(); });
  tocList.addEventListener('click', (e) => {
    const head = e.target.closest('.reader-toc-vol');
    if (head) {
      if (!head.disabled) toggleTocGroup(head.dataset.tocVol);
      return;
    }
    const item = e.target.closest('.reader-toc-item');
    if (item) jumpToc(Number(item.dataset.i));
  });
  tocSearch.addEventListener('input', () => {
    const hadQuery = !!tocQuery;
    tocQuery = tocSearch.value.trim();
    tocCursor = '';
    if (!tocQuery && hadQuery) {
      ensureTocCurrentOpen();
      renderToc({ revealCurrent: true });
    } else {
      renderToc();
    }
  });
  tocSearch.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveTocCursor(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const rows = tocRows();
      const target = rows.find((row) => row.chapter.id === tocCursor) || rows[0];
      if (target) jumpToc(target.index);
    }
  });
  tocMask.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusables = $$('input, button', tocMask)
      .filter((el) => el.tabIndex >= 0 && !el.disabled && !el.hidden && el.getClientRects().length);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  prev.addEventListener('click', () => go(idx - 1));
  next.addEventListener('click', () => go(idx + 1));
  prev2.addEventListener('click', () => go(idx - 1));
  next2.addEventListener('click', () => go(idx + 1));
  minus.addEventListener('click', () => { size = Math.max(15, size - 1); setSize(); });
  plus.addEventListener('click', () => { size = Math.min(24, size + 1); setSize(); });
  $r('#readerClose').addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  setSize();
  render();
  page.focus({ preventScroll: true });

  // 首次渲染完成后再监听滚动，避免初始化时触发保存
  scroll.addEventListener('scroll', () => {
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(saveProgress, 200);
    updateProgressBar();
  });
}

/** 继续阅读：打开作品并进入阅读模式，自动恢复上次位置 */
async function continueReading(novelId) {
  if (S.novel?.id === novelId) {
    openReader(S.chapterId);
    return;
  }
  try {
    const { novel } = await api.get(`/api/novels/${novelId}`);
    S.novel = novel;
    S.chapterId = novel.chapters[0]?.id || null;
    setView('studio');
    renderStudio();
    // 等待渲染完成后打开阅读器
    setTimeout(() => openReader(null, { restore: true }), 0);
  } catch (err) {
    toast(`打开失败：${err.message}`, 'err');
  }
}

$('#previewBtn').addEventListener('click', () => openReader(S.chapterId, { restore: true }));

/* ---------- 选中文本工具栏 ---------- */
const selToolbar = $('#selToolbar');
function hideSelToolbar() { selToolbar.hidden = true; }
$('#chContent').addEventListener('mouseup', () => {
  const ta = $('#chContent');
  histCaret();
  if (ta.selectionEnd - ta.selectionStart >= 2) selToolbar.hidden = false;
});
$('#chContent').addEventListener('blur', () => { flushSave(); setTimeout(hideSelToolbar, 250); });
$('#chContent').addEventListener('keyup', (e) => {
  if (e.key === 'Escape') hideSelToolbar();
  histCaret();
});

$$('#selToolbar button').forEach((b) => b.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const ta = $('#chContent');
  const start = ta.selectionStart, end = ta.selectionEnd;
  const text = ta.value.slice(start, end);
  if (!text.trim()) return;
  const op = b.dataset.op;
  hideSelToolbar();
  if (op === 'custom') {
    showModal(`<h3>按指令处理选中内容</h3>
      <label class="field-label">你想怎么改？</label>
      <input id="cpIns" class="input" placeholder="例：改成激烈争吵，语气更冲；或：删掉全部心理描写" />
      <div class="modal-foot"><button class="btn btn-text" id="cpCancel">取消</button><button class="btn btn-primary" id="cpOk">开始</button></div>`,
      (box) => {
        box.querySelector('#cpCancel').onclick = closeModal;
        const go = () => {
          const ins = box.querySelector('#cpIns').value.trim();
          if (!ins) return;
          closeModal();
          runSegmentOp(op, text, { start, end }, { instruction: ins });
        };
        box.querySelector('#cpOk').onclick = go;
        box.querySelector('#cpIns').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
        setTimeout(() => box.querySelector('#cpIns').focus(), 30);
      });
    return;
  }
  if (op === 'annotate') {
    openAnnotationModal(text, { start, end });
    return;
  }
  runSegmentOp(op, text, { start, end });
}));

/* ---------- 批注/高亮功能 ---------- */
const ANNOTATION_COLORS = [
  { id: 'yellow', name: '黄色', bg: '#fff3bf', border: '#f0c808', text: '#5c4b00' },
  { id: 'green', name: '绿色', bg: '#d4f6d4', border: '#52c41a', text: '#1b4d0a' },
  { id: 'blue', name: '蓝色', bg: '#d6eaff', border: '#1890ff', text: '#00275e' },
  { id: 'red', name: '红色', bg: '#fff1f0', border: '#ff4d4f', text: '#6b1a1a' },
  { id: 'purple', name: '紫色', bg: '#f9f0ff', border: '#722ed1', text: '#391053' },
  { id: 'orange', name: '橙色', bg: '#fff7e6', border: '#fa8c16', text: '#5c3400' },
];

function getChapterAnnotations(ch) {
  if (!ch.annotations) ch.annotations = [];
  return ch.annotations;
}

function openAnnotationModal(selectedText, range) {
  const ch = currentChapter();
  if (!ch) return toast('请先打开一章', 'err');

  showModal(`<h3>添加批注/高亮</h3>
    <p class="modal-sub">选中文本：<code>${esc(selectedText.slice(0, 80))}${selectedText.length > 80 ? '…' : ''}</code></p>
    <div class="field-label">高亮颜色
      <div class="annotation-colors" id="annoColors">
        ${ANNOTATION_COLORS.map(c => `<button type="button" class="anno-color-btn${c.id === 'yellow' ? ' on' : ''}" data-color="${c.id}" style="background:${c.bg};border-color:${c.border};color:${c.text}" title="${c.name}" aria-label="${c.name}"><svg class="ico"><use href="#i-highlight" /></svg></button>`).join('')}
      </div>
    </div>
    <label class="field-label">批注内容
      <textarea class="input" id="annoNote" rows="3" placeholder="可选：写下你的想法、待办、问题……"></textarea>
    </label>
    <div class="modal-foot">
      <button class="btn btn-text" id="annoCancel">取消</button>
      <button class="btn btn-primary" id="annoOk">添加</button>
    </div>`,
  (box) => {
    let selectedColor = 'yellow';
    box.querySelectorAll('.anno-color-btn').forEach(btn => {
      btn.onclick = () => {
        box.querySelectorAll('.anno-color-btn').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        selectedColor = btn.dataset.color;
      };
    });
    box.querySelector('#annoCancel').onclick = closeModal;
    box.querySelector('#annoOk').onclick = () => {
      const note = box.querySelector('#annoNote').value.trim();
      addAnnotation(ch, range.start, range.end, selectedText, selectedColor, note);
      closeModal();
    };
    setTimeout(() => box.querySelector('#annoNote').focus(), 30);
  });
}

function addAnnotation(ch, start, end, text, color, note) {
  const annotations = getChapterAnnotations(ch);
  const annotation = {
    id: uid('an'),
    start,
    end,
    text: text.slice(0, 200), // 存片段用于定位和显示
    color,
    note,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  annotations.push(annotation);
  // 按位置排序
  annotations.sort((a, b) => a.start - b.start);
  markChapterDirty(ch);
  renderAnnotationSidebar();
  toast('已添加批注/高亮', 'ok');
}

function deleteAnnotation(ch, annotationId) {
  const annotations = getChapterAnnotations(ch);
  const idx = annotations.findIndex(a => a.id === annotationId);
  if (idx >= 0) {
    annotations.splice(idx, 1);
    markChapterDirty(ch);
    renderAnnotationSidebar();
    toast('已删除批注', 'ok');
  }
}

function updateAnnotation(ch, annotationId, updates) {
  const annotations = getChapterAnnotations(ch);
  const anno = annotations.find(a => a.id === annotationId);
  if (anno) {
    Object.assign(anno, updates, { updatedAt: Date.now() });
    markChapterDirty(ch);
    renderAnnotationSidebar();
  }
}

/** 估算光标在正文里的纵向位置：按段落 + 折行算，行高取实际值（稿纸可调，不能写死 28px） */
function editorCaretTop(ta, pos) {
  const cs = getComputedStyle(ta);
  const lh = parseFloat(cs.lineHeight) || 28;
  const fs = parseFloat(cs.fontSize) || 16;
  const textW = Math.max(1, ta.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0));
  const perLine = Math.max(1, Math.floor(textW / (fs + 0.2))); // 中文一字大约一个字号宽
  const before = ta.value.slice(0, Math.max(0, pos));
  const lines = before.split('\n').reduce((n, para) => n + Math.max(1, Math.ceil(para.length / perLine)), 0);
  return Math.max(0, (lines - 1) * lh);
}

function jumpToAnnotation(ch, annotationId) {
  const ta = $('#chContent');
  const annotations = getChapterAnnotations(ch);
  const anno = annotations.find(a => a.id === annotationId);
  if (!anno || !ta) return;
  // 优先用存储的 start/end，兜底用文本搜索
  let start = anno.start, end = anno.end;
  if (typeof start !== 'number' || typeof end !== 'number' || start < 0 || end > ta.value.length) {
    const idx = ta.value.indexOf(anno.text);
    if (idx >= 0) { start = idx; end = idx + anno.text.length; }
  }
  if (typeof start === 'number' && typeof end === 'number') {
    ta.setSelectionRange(start, end);
    ta.focus({ preventScroll: true });
    // 滚到视线里，别让批注跳过去却停在半屏之外
    ta.scrollTop = Math.max(0, editorCaretTop(ta, start) - ta.clientHeight * 0.32);
  }
}

function renderAnnotationSidebar() {
  const ch = currentChapter();
  const sidebar = $('#annotationSidebar');
  const countEl = $('#annoCount');
  if (!sidebar) return;
  if (!ch) {
    sidebar.innerHTML = '<p class="dim">请先打开一章</p>';
    if (countEl) countEl.textContent = '';
    return;
  }
  const annotations = getChapterAnnotations(ch);
  if (countEl) countEl.textContent = annotations.length ? `${annotations.length} 条` : '';
  if (!annotations.length) {
    sidebar.innerHTML = '<p class="dim">这章还没有批注。选中文字点高亮图标添加。</p>';
    return;
  }
  sidebar.innerHTML = `
    <div class="annotation-list">
      ${annotations.map(a => {
        const color = ANNOTATION_COLORS.find(c => c.id === a.color) || ANNOTATION_COLORS[0];
        return `<div class="annotation-item" data-id="${a.id}" style="border-left-color:${color.border}">
          <div class="annotation-header">
            <span class="annotation-color-dot" style="background:${color.bg};border-color:${color.border}"></span>
            <span class="annotation-position">第 ${a.start}–${a.end} 字</span>
            <span class="annotation-time">${fmtDate(a.createdAt)}</span>
          </div>
          <div class="annotation-text">${esc(a.text.slice(0, 120))}${a.text.length > 120 ? '…' : ''}</div>
          ${a.note ? `<div class="annotation-note">${esc(a.note)}</div>` : ''}
          <div class="annotation-actions">
            <button class="btn btn-sm btn-text" data-act="jump">${ico('arrow-right')}跳转</button>
            <button class="btn btn-sm btn-text" data-act="edit">${ico('edit')}编辑</button>
            <button class="btn btn-sm btn-text" data-act="delete">${ico('trash')}删除</button>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  sidebar.querySelectorAll('.annotation-item').forEach(item => {
    const id = item.dataset.id;
    item.querySelector('[data-act="jump"]').onclick = () => jumpToAnnotation(ch, id);
    item.querySelector('[data-act="edit"]').onclick = () => editAnnotation(ch, id);
    item.querySelector('[data-act="delete"]').onclick = () => {
      if (confirm('删除这条批注？')) deleteAnnotation(ch, id);
    };
  });
}

function editAnnotation(ch, annotationId) {
  const annotations = getChapterAnnotations(ch);
  const anno = annotations.find(a => a.id === annotationId);
  if (!anno) return;
  const color = ANNOTATION_COLORS.find(c => c.id === anno.color) || ANNOTATION_COLORS[0];
  showModal(`<h3>编辑批注/高亮</h3>
    <p class="modal-sub">原文：<code>${esc(anno.text.slice(0, 80))}${anno.text.length > 80 ? '…' : ''}</code></p>
    <div class="field-label">高亮颜色
      <div class="annotation-colors" id="annoColors">
        ${ANNOTATION_COLORS.map(c => `<button type="button" class="anno-color-btn${c.id === anno.color ? ' on' : ''}" data-color="${c.id}" style="background:${c.bg};border-color:${c.border};color:${c.text}" title="${c.name}" aria-label="${c.name}"><svg class="ico"><use href="#i-highlight" /></svg></button>`).join('')}
      </div>
    </div>
    <label class="field-label">批注内容
      <textarea class="input" id="annoNote" rows="3" placeholder="可选：写下你的想法、待办、问题……">${esc(anno.note || '')}</textarea>
    </label>
    <div class="modal-foot">
      <button class="btn btn-text" id="annoCancel">取消</button>
      <button class="btn btn-primary" id="annoOk">保存</button>
    </div>`,
  (box) => {
    let selectedColor = anno.color;
    box.querySelectorAll('.anno-color-btn').forEach(btn => {
      btn.onclick = () => {
        box.querySelectorAll('.anno-color-btn').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        selectedColor = btn.dataset.color;
      };
    });
    box.querySelector('#annoCancel').onclick = closeModal;
    box.querySelector('#annoOk').onclick = () => {
      const note = box.querySelector('#annoNote').value.trim();
      updateAnnotation(ch, annotationId, { color: selectedColor, note });
      closeModal();
    };
    setTimeout(() => box.querySelector('#annoNote').focus(), 30);
  });
}

/* ============================================================
 * 6. 生成
 * ============================================================ */
// 这几个任务的产出是文档型内容（Markdown），输出区按 Markdown 渲染；正文类任务保持纯文本
const MD_OUT_TASKS = new Set(['titles', 'style', 'outline']);
// 只有这几种产出能直接写进本章。润色 / 扩写等段落操作有自己的差异面板，
// 把「替换正文」摆在输出区会让人误把整章换成一段。
const PROSE_OUT_TASKS = new Set(['chapter', 'continue', 'compare']);

function outNextText() {
  const hasContent = !!($('#chContent')?.value || '').trim();
  if (!hasContent) return '这是 AI 写的初稿，还没写进本章。满意就点「追加到正文」。';
  return '满意就点「追加到正文」接在本章末尾；想放在光标处就点「插入光标处」。原稿不会被覆盖。';
}

/** 输出区的按钮跟着任务类型走：正文类才给「写进正文」，其它任务只留复制 / 清空 */
function renderOutActions() {
  const hasOut = !!S.out;
  $('#outActions').hidden = !hasOut;
  const canApply = hasOut && !S.controller && PROSE_OUT_TASKS.has(S.outTask);
  ['#applyAppend', '#applyReplace', '#applyInsert'].forEach((sel) => {
    const el = $(sel);
    if (el) el.hidden = !canApply;
  });
  const next = $('#outNext');
  if (!next) return;
  next.hidden = !canApply;
  if (canApply) next.textContent = outNextText();
}

function renderOut() {
  const box = $('#outBox');
  box.innerHTML = (S.reasoning ? `<div class="reasoning">${esc(S.reasoning)}</div>` : '')
    + (S.outMd ? mdLite(S.out) : esc(S.out))
    + (S.controller ? '<span class="cursor"></span>' : '');
  box.scrollTop = box.scrollHeight;
  renderOutActions();
  if (S.out) {
    $('#outInfo').textContent = `${S.outModel ? `${S.outModel} · ` : ''}${countWords(S.out)} 字${S.controller ? ' · 生成中…' : ''}`;
  } else if (!S.controller) {
    $('#outInfo').textContent = '';   // 失败或空回复后别停在「生成中…」
  }
}

/** 生成正文时把输出区滚进视野：按钮在助手栏上方，输出区经常在折叠线以下。
 *  toActions：生成结束后再滚一次，让「追加到正文」这排按钮也露出来。
 *  窄窗口里助手栏收成抽屉：直接拉开，否则生成结束后用户只看到稿纸，不知道产出在哪。 */
function revealOutput({ toActions = false } = {}) {
  if (S.view !== 'studio' || S.focusMode) return;
  const outer = $('#assistPane');
  if (outer) {
    const style = getComputedStyle(outer);
    if (style.display === 'none' || style.visibility === 'hidden') openStudioPane('assist');
  }
  const pane = $('.assist-pane[data-pane="write"]');
  if (!pane || !pane.classList.contains('on')) return;
  const body = $('.assist-body');
  let el = $('#outBox');
  if (!body || !el) return;
  if (toActions && $('#outActions') && !$('#outActions').hidden) el = $('#outActions');
  const bodyRect = body.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  if (toActions) {
    if (rect.bottom <= bodyRect.bottom - 8) return;
    body.scrollTop += rect.bottom - bodyRect.bottom + 12;
  } else {
    if (rect.top >= bodyRect.top + 8 && rect.bottom <= bodyRect.bottom - 8) return;
    body.scrollTop = Math.max(0, rect.top - bodyRect.top + body.scrollTop - 12);
  }
}

function setBusy(busy) {
  $('#stopBtn').hidden = !busy;
  $('#stopBtn2').hidden = !busy;
  $('#genChapterBtn').disabled = busy;
  $('#contBtn').disabled = busy;
  $('#cmpBtn').disabled = busy;
  $('#consistencyBtn').disabled = busy;
  $('#reviewBtn').disabled = busy;
  $$('[data-quick]').forEach((b) => { b.disabled = busy; });
  // 生成/批量任务跑起来时收起「用 AI 写初稿」，避免连点
  updateFootSuggest();
  // 流式进行中禁止把半截内容写进正文
  ['#applyAppend', '#applyReplace', '#applyInsert', '#copyOut'].forEach((sl) => { const el = $(sl); if (el) el.disabled = busy; });
}

/** 生成前发现缺少服务商 / Key / 模型：就地打开接入引导，接好后重跑这次生成 */
function openGenerateModelSetup(body, retry) {
  return openModelSetup({
    introTitle: '开始生成前还差一步：接入模型',
    introText: '写正文、想大纲、改稿子都要用 AI 模型。接一次，以后都能用。',
    modelTitle: '选一个模型，继续生成',
    saveLabel: '保存，继续生成',
    isReady: () => aiModelReady(body.task || 'chapter', body.model),
    onReady: retry,
    onCancel: () => toast('还没接入模型，这次没有开始生成'),
  });
}

/** 服务端先一步发现配置问题时，也接到同一套模型引导，而不是只弹一句报错 */
function isModelSetupError(err) {
  return /还没有配置模型服务商|还没有填写 API Key|还没有选择模型/.test(String(err?.message || err || ''));
}

async function runStream(body, { target = 'out', retried = false } = {}) {
  if (S.controller || S.batchController) { toast('已有任务在跑，先停止', 'err'); return ''; }
  if (!retried && !aiModelReady(body.task || 'chapter', body.model)) {
    openGenerateModelSetup(body, () => runStream(body, { target, retried: true }));
    return '';
  }
  const ac = new AbortController();
  S.controller = ac;
  setBusy(true);
  // 产出文档型内容（大纲/起名/文风档案）的任务按 Markdown 渲染，正文类任务保持纯文本
  if (target === 'out') {
    S.out = ''; S.outTask = body.task || ''; S.reasoning = ''; S.outModel = '';
    S.outMd = MD_OUT_TASKS.has(body.task);
    $('#outInfo').textContent = '';
    renderOut();
    if (PROSE_OUT_TASKS.has(S.outTask)) revealOutput();
  } else {
    $('#checkBox').innerHTML = '<span class="dim">生成中…</span>';
  }
  let acc = '';
  let streamFailed = false;
  const openSettings = () => setView('settings');
  try {
    acc = await streamAI(body, {
      signal: ac.signal,
      onMeta: (m) => {
        if (target === 'out') {
          S.outModel = m.model || '';
          $('#outInfo').textContent = `${S.outModel} 生成中…`;
          if (m.lines?.length) $('#outInfo').title = `注入资料：${m.lines.join(' / ')}`;
        }
      },
      onDelta: (d) => {
        acc += d;
        if (target === 'out') { S.out += d; renderOut(); }
        else if (!/^\s*[[{]/.test(acc)) $('#checkBox').innerHTML = mdLite(acc);
      },
      onReasoning: (r) => { if (target === 'out') { S.reasoning += r; renderOut(); } },
    });
  } catch (err) {
    streamFailed = true;
    if (err.name === 'AbortError') toast('已停止');
    else if (!retried && isModelSetupError(err)) {
      openGenerateModelSetup(body, () => runStream(body, { target, retried: true }));
    } else {
      toast(err.message, 'err', { label: '打开设置', onClick: openSettings });
      if (target !== 'out') $('#checkBox').innerHTML = `<span class="status-err">${esc(err.message)}</span>`;
    }
  } finally {
    S.controller = null;
    setBusy(false);
    if (target === 'out') {
      renderOut();
      // 流式输出停在底部，生成结束后把「追加到正文」也带进视野
      if (S.out && PROSE_OUT_TASKS.has(S.outTask)) revealOutput({ toActions: true });
    }
  }
  if (!streamFailed && !acc.trim()) {
    const msg = target === 'out' && S.reasoning
      ? '模型这一回只返回了思考内容，没写出正文。可以在设置把「单次最大输出 tokens」调大，或换个模型。'
      : '模型这一回没写出任何内容。可能是 Key、额度或模型名有问题，可以在设置里检查后再试。';
    if (target === 'out') $('#outInfo').textContent = '没有返回内容';
    else $('#checkBox').innerHTML = `<span class="status-err">${esc(msg)}</span>`;
    toast(msg, 'err', { label: '打开设置', onClick: openSettings });
  }
  return acc;
}

async function generateChapter() {
  const ch = currentChapter();
  if (!ch) return toast('先建一章', 'err');
  await runStream({
    task: 'chapter',
    novelId: S.novel.id,
    chapterId: ch.id,
    model: $('#genModel').value.trim() || undefined,
    payload: {
      instruction: $('#genReq').value.trim() || undefined,
      targetWords: Number($('#genWords').value) || undefined,
      extraQuery: $('#genReq').value.trim() || undefined,
    },
  });
}
$('#genChapterBtn').addEventListener('click', generateChapter);

async function continueWriting() {
  const ch = currentChapter();
  if (!ch) return toast('先建一章', 'err');
  const content = $('#chContent').value;
  if (!content.trim()) return generateChapter();
  await runStream({
    task: 'continue',
    novelId: S.novel.id,
    chapterId: ch.id,
    model: $('#genModel').value.trim() || undefined,
    payload: {
      tail: content,
      targetWords: Math.min(1500, Math.max(300, Number($('#genWords').value) || 800)),
      instruction: $('#genReq').value.trim() || undefined,
      extraQuery: $('#genReq').value.trim() || undefined,
    },
  });
}
$('#contBtn').addEventListener('click', continueWriting);
$('#stopBtn').addEventListener('click', () => S.controller?.abort());
$('#stopBtn2').addEventListener('click', () => S.controller?.abort());
$('#clearOut').addEventListener('click', () => { S.out = ''; S.reasoning = ''; renderOut(); });
$('#copyOut').addEventListener('click', () => { navigator.clipboard.writeText(S.out); toast('已复制', 'ok'); });

function insertIntoContent(text, mode) {
  const ta = $('#chContent');
  if (mode === 'replace') ta.value = text.trim();
  else if (mode === 'append') {
    const cur = ta.value.replace(/\s+$/, '');
    ta.value = (cur ? `${cur}\n\n` : '') + text.trim();
  } else {
    const pos = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, pos);
    const after = ta.value.slice(pos);
    const pad1 = before && !before.endsWith('\n') ? '\n\n' : '';
    const pad2 = after && !after.startsWith('\n') ? '\n\n' : '';
    ta.value = before + pad1 + text.trim() + pad2 + after;
  }
  ta.dispatchEvent(new Event('input'));
  // 正文从空变成有内容后，提示语也该跟着变
  renderOutActions();
}
$('#applyAppend').addEventListener('click', () => { if (S.out) { insertIntoContent(S.out, 'append'); toast('已追加到正文 · 按 Ctrl+Z 可撤销', 'ok'); } });
$('#applyReplace').addEventListener('click', async () => {
  if (!S.out) return;
  if (!confirm('用输出内容替换本章正文？原有内容会被覆盖。')) return;
  await snapshotNow('AI 替换前');   // 覆盖前留一份，替换错了能从版本历史里捞回来
  insertIntoContent(S.out, 'replace');
  toast('已替换 · Ctrl+Z 可撤销，原稿也在「版本历史」里', 'ok');
});
$('#applyInsert').addEventListener('click', () => { if (S.out) { insertIntoContent(S.out, 'insert'); toast('已插入光标处 · 按 Ctrl+Z 可撤销', 'ok'); } });

/* ============================================================
 * 6.5 模型对比：同一段上下文跑两个模型，并排看，选一个采用
 * ============================================================
 * 为什么值得做：换模型之前只能「切过去 → 重新生成 → 凭记忆比」，
 * 两份结果没法摆在一起看。这个功能让「哪个模型写这段更合适」变成一眼的事。
 * 服务端不用改 —— 前端并行发两次 /api/ai/stream，只是 providerId / model 不同。
 */

/** 配置里能用的服务商（没密钥的选了也是白选，先剔掉） */
function cmpCandidates() {
  const cfg = S.config || {};
  const out = [];
  for (const p of cfg.providers || []) {
    if (!p.apiKeySet && !p.apiKey) continue;
    out.push({ providerId: p.id, provider: p.name || p.baseUrl || '未命名', models: p.models || [] });
  }
  return out;
}

/** 挑一个跟 A 不同的候选当 B：先换服务商，同一家里换模型也行 */
function otherCandidate(cand, a) {
  const other = cand.find((c) => c.providerId !== a.providerId);
  if (other) return { providerId: other.providerId, model: (other.models || [])[0] || '' };
  const same = cand.find((c) => c.providerId === a.providerId && (c.models || []).some((m) => m !== a.model));
  if (same) return { providerId: same.providerId, model: (same.models || []).find((m) => m !== a.model) };
  return { providerId: a.providerId, model: '' };
}

/** 对比支持的三个任务：都是出正文的，模型差别最明显 */
function cmpTaskList() {
  const ch = currentChapter();
  if (!ch) return [];
  const out = [{ key: 'chapter', label: '生成本章' }];
  const content = ($('#chContent')?.value || '').trim();
  if (content) out.push({ key: 'continue', label: '续写' });
  const ta = $('#chContent');
  const sel = ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : '';
  if (sel.trim().length > 1) out.push({ key: 'polish', label: '润色选中段落' });
  return out;
}

/** 按任务拼出要发给服务端的请求体（跟各自单独跑时完全一致，两边才公平） */
function cmpTaskBody(task) {
  const ch = currentChapter();
  const req = ($('#genReq')?.value || '').trim();
  const words = Number($('#genWords')?.value) || 0;
  if (task === 'continue') {
    const content = ($('#chContent')?.value || '');
    return {
      task: 'continue',
      novelId: S.novel.id,
      chapterId: ch.id,
      payload: {
        tail: content,
        targetWords: Math.min(1500, Math.max(300, words || 800)),
        instruction: req || undefined,
        extraQuery: req || undefined,
      },
    };
  }
  if (task === 'polish') {
    const ta = $('#chContent');
    const text = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    return { task: 'polish', novelId: S.novel.id, chapterId: ch.id, payload: { text } };
  }
  return {
    task: 'chapter',
    novelId: S.novel.id,
    chapterId: ch.id,
    payload: {
      instruction: req || undefined,
      targetWords: words || undefined,
      extraQuery: req || undefined,
    },
  };
}

/** 打开模型对比的选型弹窗 */
function openModelCompare() {
  if (!S.novel) return toast('先打开作品', 'err');
  const cand = cmpCandidates();
  if (!cand.length) {
    return openModelSetup({
      introTitle: '模型对比前还差一步：接入模型',
      introText: '对比要同时调用两个模型。先接好一个服务商，再回来选两边。',
      modelTitle: '选一个模型，继续设置对比',
      saveLabel: '保存，继续',
      isReady: () => cmpCandidates().length > 0,
      onReady: openModelCompare,
      onCancel: () => toast('还没接入模型，这次没有开始对比'),
    });
  }
  const tasks = cmpTaskList();
  if (!tasks.length) return toast('先建一章', 'err');

  const genModel = ($('#genModel')?.value || '').trim();
  const active = cand.find((c) => c.providerId === S.config?.activeProviderId) || cand[0];
  const defA = { providerId: active.providerId, model: genModel || (active.models || [])[0] || '' };
  const defB = otherCandidate(cand, defA);

  const picker = (side, def) => `
    <div class="cmp-pick">
      <label class="field-label">模型 ${side}</label>
      <select class="select" data-prov="${side}">
        ${cand.map((c) => `<option value="${esc(c.providerId)}"${c.providerId === def.providerId ? ' selected' : ''}>${esc(c.provider)}</option>`).join('')}
      </select>
      <input class="input" data-model="${side}" list="cmpList${side}" value="${esc(def.model)}" placeholder="模型名，留空用服务商默认" />
      <datalist id="cmpList${side}"></datalist>
    </div>`;

  showModal(`
    <h3>模型对比</h3>
    <p class="modal-sub">同一段上下文跑两个模型，结果并排摆出来，选一个采用。用的是左栏那套「本章要求 / 目标字数」。</p>
    <div class="cmp-pickers">
      ${picker('A', defA)}
      ${picker('B', defB)}
    </div>
    <label class="field-label" style="margin-top:12px">对比什么
      <select class="select" id="cmpTask">
        ${tasks.map((t) => `<option value="${t.key}">${esc(t.label)}</option>`).join('')}
      </select>
    </label>
    <div class="dim small cmp-note" id="cmpNote"></div>
    <div class="modal-foot">
      <button class="btn btn-text" id="cmpCancel">取消</button>
      <button class="btn btn-primary" id="cmpRun">开始对比</button>
    </div>`, (box) => {
      const provA = box.querySelector('[data-prov="A"]');
      const provB = box.querySelector('[data-prov="B"]');
      const modelA = box.querySelector('[data-model="A"]');
      const modelB = box.querySelector('[data-model="B"]');
      const note = box.querySelector('#cmpNote');
      const fill = (provEl, listEl, modelEl) => {
        const c = cand.find((x) => x.providerId === provEl.value);
        listEl.innerHTML = (c?.models || []).map((m) => `<option value="${esc(m)}"></option>`).join('');
        if (!modelEl.value && c?.models?.length) modelEl.value = c.models[0];
      };
      fill(provA, box.querySelector('#cmpListA'), modelA);
      fill(provB, box.querySelector('#cmpListB'), modelB);
      const check = () => {
        const same = provA.value === provB.value && modelA.value.trim() === modelB.value.trim();
        note.textContent = same ? '两边选了同一个模型，结果会一模一样 —— 换一个再比。' : '';
        return !same;
      };
      const onProv = () => {
        modelA.value = '';
        modelB.value = '';
        fill(provA, box.querySelector('#cmpListA'), modelA);
        fill(provB, box.querySelector('#cmpListB'), modelB);
        check();
      };
      provA.onchange = onProv;
      provB.onchange = onProv;
      modelA.oninput = check;
      modelB.oninput = check;
      check();
      box.querySelector('#cmpCancel').onclick = closeModal;
      box.querySelector('#cmpRun').onclick = () => {
        if (!check()) return toast('两边得是两个不同的模型', 'err');
        const pick = (provEl, modelEl) => {
          const p = cand.find((c) => c.providerId === provEl.value);
          const m = modelEl.value.trim();
          return { providerId: provEl.value, model: m, label: `${p?.provider || ''}${m ? ' · ' + m : ' · 默认模型'}` };
        };
        const task = box.querySelector('#cmpTask').value;
        closeModal();
        runModelCompare([pick(provA, modelA), pick(provB, modelB)], task);
      };
    }, { wide: true });
}

/** 并排跑两个模型，边流边显示，跑完挑一个采用 */
async function runModelCompare(picks, task) {
  if (S.controller || S.batchController) { toast('已有任务在跑，先停止', 'err'); return; }
  const body = cmpTaskBody(task);
  const md = MD_OUT_TASKS.has(task);
  let ac = new AbortController();
  const state = picks.map((p, i) => ({ ...p, side: i === 0 ? 'A' : 'B', text: '', err: '', ms: 0, done: false }));
  let running = false;

  showModal(`
    <div class="cmp-head">
      <h3>模型对比</h3>
      <div class="cmp-head-actions">
        <div class="cmp-views">
          <button class="btn btn-sm on" id="cmpViewSide" type="button">并排</button>
          <button class="btn btn-sm" id="cmpViewDiff" type="button">差异</button>
        </div>
        <button class="btn btn-sm btn-text" id="cmpAgain" title="用同样的两个模型再跑一遍"><svg class="ico"><use href="#i-refresh" /></svg>再跑一次</button>
        <button class="btn btn-sm btn-text" id="cmpStop"><svg class="ico"><use href="#i-stop" /></svg>停止</button>
      </div>
    </div>
    <div class="cmp-grid" id="cmpGrid">
      ${state.map((s, i) => `
        <section class="cmp-col">
          <header class="cmp-col-head">
            <span class="cmp-name">${esc(s.label)}</span>
            <span class="cmp-stat" id="cmpStat${i}">排队中</span>
          </header>
          <div class="cmp-body" id="cmpBody${i}"></div>
          <footer class="cmp-foot">
            <button class="btn btn-sm btn-primary" data-use="${i}" disabled>采用</button>
            <button class="btn btn-sm" data-copy="${i}" disabled>复制</button>
          </footer>
        </section>`).join('')}
    </div>
    <div class="cmp-diff-wrap" id="cmpDiffWrap" hidden>
      <div class="cmp-diff-bar">
        <div class="cmp-views">
          <button class="btn btn-sm on" data-dmode="chg" type="button">改动</button>
          <button class="btn btn-sm" data-dmode="a" type="button" id="cmpModeA">A 版</button>
          <button class="btn btn-sm" data-dmode="b" type="button" id="cmpModeB">B 版</button>
        </div>
        <span class="cmp-diff-sum" id="cmpDiffSum"></span>
        <label class="diff-toggle"><input type="checkbox" id="cmpOnlyChanges" />只看改动</label>
      </div>
      <div class="cmp-diff" id="cmpDiff"></div>
    </div>`, (box) => {
      box.querySelector('#cmpStop').onclick = () => ac.abort();
      box.querySelectorAll('[data-use]').forEach((btn) => {
        btn.onclick = () => {
          const s = state[Number(btn.dataset.use)];
          if (!s.text) return;
          S.out = s.text;
          S.outTask = 'compare';
          S.reasoning = '';
          S.outMd = md;
          S.outModel = s.label;
          renderOut();
          // 采用之后直接把「写进正文」滚到眼前，不用再找输出区在哪
          showAssistTab('write');
          revealOutput({ toActions: true });
          closeModal();
          toast('已采用这个结果，可以用「追加到正文 / 替换正文」了', 'ok');
        };
      });
      box.querySelectorAll('[data-copy]').forEach((btn) => {
        btn.onclick = () => {
          navigator.clipboard.writeText(state[Number(btn.dataset.copy)].text);
          toast('已复制', 'ok');
        };
      });
      // 并排 / 差异 两个视图
      const gridEl = box.querySelector('#cmpGrid');
      const diffWrap = box.querySelector('#cmpDiffWrap');
      const viewSide = box.querySelector('#cmpViewSide');
      const viewDiff = box.querySelector('#cmpViewDiff');
      const onlyChanges = box.querySelector('#cmpOnlyChanges');
      const diffSum = box.querySelector('#cmpDiffSum');
      const diffBody = box.querySelector('#cmpDiff');
      // 差异视图有三档：改动（红绿混排）、A 版、B 版
      let dMode = 'chg';
      const modeBtns = $$('[data-dmode]', box);
      const refreshDiff = () => {
        const [a, b] = state;
        if (!a.text || !b.text) {
          diffSum.textContent = '';
          diffBody.innerHTML = '<div class="cmp-empty">两边都有内容之后才能比差异</div>';
          return;
        }
        const d = diffProse(a.text, b.text);
        const only = onlyChanges.checked;
        if (dMode === 'a') {
          diffSum.innerHTML = `<span>${esc(a.label)} 的写法</span><span class="d-del">A 独有 ${d.removed} 字</span><span>相似度 ${d.similarity}%</span>`;
          diffBody.innerHTML = diffSideHtml(d.segs, 'old', only);
        } else if (dMode === 'b') {
          diffSum.innerHTML = `<span>${esc(b.label)} 的写法</span><span class="d-add">B 独有 ${d.added} 字</span><span>相似度 ${d.similarity}%</span>`;
          diffBody.innerHTML = diffSideHtml(d.segs, 'new', only);
        } else {
          diffSum.innerHTML = `<span class="d-del">只有 A 有 ${d.removed} 字</span><span class="d-add">只有 B 有 ${d.added} 字</span><span>相似度 ${d.similarity}%</span>`;
          diffBody.innerHTML = diffHtml(d.segs, only);
        }
      };
      modeBtns.forEach((b) => {
        b.onclick = () => {
          dMode = b.dataset.dmode;
          modeBtns.forEach((x) => x.classList.toggle('on', x === b));
          refreshDiff();
        };
      });
      const setView = (mode) => {
        const isDiff = mode === 'diff';
        gridEl.hidden = isDiff;
        diffWrap.hidden = !isDiff;
        viewSide.classList.toggle('on', !isDiff);
        viewDiff.classList.toggle('on', isDiff);
        if (isDiff) refreshDiff();
      };
      viewSide.onclick = () => setView('side');
      viewDiff.onclick = () => setView('diff');
      onlyChanges.onchange = refreshDiff;
      // 边流边算差异：流完自动刷新一次
      state.onSettled = refreshDiff;
      // A 版 / B 版 按钮上写清楚是哪个模型
      box.querySelector('#cmpModeA').textContent = `A 版`;
      box.querySelector('#cmpModeA').title = `${state[0].label} 的写法`;
      box.querySelector('#cmpModeB').textContent = `B 版`;
      box.querySelector('#cmpModeB').title = `${state[1].label} 的写法`;
      // 再跑一次：同样的两个模型重来一遍
      box.querySelector('#cmpAgain').onclick = () => { start(); };
    }, { wide: true, onClose: () => ac.abort() });

  const renderCol = (i) => {
    const s = state[i];
    const bodyEl = document.getElementById(`cmpBody${i}`);
    if (!bodyEl) return;
    const stopped = s.err === '已停止';
    if (s.err && !stopped) {
      bodyEl.innerHTML = `<span class="status-err">${esc(s.err)}</span>`;
    } else if (s.text) {
      // 手动停掉的：已经写出来的那部分要留住，别白生成
      bodyEl.innerHTML = (md ? mdLite(s.text) : esc(s.text)) + (stopped ? '<div class="cmp-stopped">已停止</div>' : '');
    } else {
      bodyEl.innerHTML = '<span class="dim">…</span>';
    }
    const statEl = document.getElementById(`cmpStat${i}`);
    if (statEl) {
      statEl.textContent = s.err
        ? (stopped ? `已停止 · ${countWords(s.text)} 字` : '失败')
        : s.done
          ? `${countWords(s.text)} 字 · ${(s.ms / 1000).toFixed(1)} 秒`
          : `生成中… ${countWords(s.text)} 字`;
    }
    const use = document.querySelector(`[data-use="${i}"]`);
    if (use) use.disabled = !s.text;
    const cp = document.querySelector(`[data-copy="${i}"]`);
    if (cp) cp.disabled = !s.text;
  };

  // 流式时别每个字都重排 DOM，攒一帧刷一次
  let rafId = 0;
  const dirty = new Set();
  const schedule = (i) => {
    dirty.add(i);
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      for (const k of dirty) renderCol(k);
      dirty.clear();
    });
  };

  const runOne = async (s, i) => {
    const t0 = performance.now();
    try {
      await streamAI({ ...body, providerId: s.providerId, model: s.model || undefined }, {
        signal: ac.signal,
        onDelta: (d) => { s.text += d; schedule(i); },
      });
      s.ms = performance.now() - t0;
    } catch (err) {
      s.ms = performance.now() - t0;
      s.err = err?.name === 'AbortError' ? '已停止' : (err.message || '生成失败');
    }
    s.done = true;
    renderCol(i);
  };

  /** 跑一轮：两个模型同时来一遍 */
  const start = async () => {
    if (running) return;
    running = true;
    const again = document.querySelector('#cmpAgain');
    if (again) again.disabled = true;
    ac = new AbortController();
    state.forEach((s) => { s.text = ''; s.err = ''; s.ms = 0; s.done = false; });
    state.forEach((_, i) => renderCol(i));
    // 借用全局的忙状态：这样左下角的「停止」和别处的按钮都跟着一起禁用
    S.controller = ac;
    setBusy(true);
    try {
      await Promise.all(state.map((s, i) => runOne(s, i)));
    } finally {
      running = false;
      if (again) again.disabled = false;
      // 两边都跑完了，差异视图里的数据要跟着更新一次
      try { state[0]?.onSettled?.(); } catch (err) { console.warn('[cmp] 刷新差异失败', err); }
      // 只有还是自己在跑的时候才收尾，别把用户后来新开的任务状态搅乱
      if (S.controller === ac) {
        S.controller = null;
        setBusy(false);
      }
    }
  };

  await start();
}

$('#cmpBtn')?.addEventListener('click', openModelCompare);

/* ============================================================
 * 章节记忆查看 / 线索追踪
 * ============================================================ */
/** 章节记忆里的数组字段可能是字符串数组，也可能被模型写成 {text/title}；统一成可显示的文本 */
function memoryListHtml(title, items) {
  if (!items.length) return '';
  return `<section class="mem-block"><h4>${title}</h4><ul class="mem-list">${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul></section>`;
}

function openMemoryModal(ch) {
  if (!ch?.memory) return toast('本章还没有章节记忆', 'err');
  const mem = ch.memory;
  const no = ch.no || (S.novel?.chapters.indexOf(ch) + 1) || 1;
  const summary = String(mem.summary || '').trim() || String(ch.summary || '').trim();
  const blocks = [
    memoryListHtml('关键事件', memoryItems(mem, 'events')),
    memoryListHtml('出场人物', memoryItems(mem, 'characters')),
    memoryListHtml('状态变化', memoryItems(mem, 'stateChanges')),
    memoryListHtml('伏笔', memoryItems(mem, 'foreshadowing')),
    memoryListHtml('未决', memoryItems(mem, 'unresolved')),
  ].filter(Boolean).join('');
  const empty = !summary && !blocks;
  showModal(`<div class="mem-head"><h3>章节记忆</h3><button class="icon-btn sm mem-x" id="memX" title="关闭" aria-label="关闭">${ico('x')}</button></div>
    <p class="modal-sub">第 ${no} 章《${esc(ch.title || '未命名')}》 · 后续章节会按相关度召回这份记忆。</p>
    ${empty
      ? '<div class="mem-empty">这条记忆里还没有可显示的内容。可以重新生成，或先补全本章正文。</div>'
      : `${summary ? `<section class="mem-block"><h4>概要</h4><p class="mem-summary">${esc(summary)}</p></section>` : ''}${blocks}`}
    <div class="modal-foot mem-foot">
      <button class="btn btn-text" id="memOpen">打开本章</button>
      <button class="btn btn-text" id="memEdit">编辑</button>
      <button class="btn btn-text" id="memRegen">重新生成</button>
      <button class="btn btn-primary" id="memClose">关闭</button>
    </div>`, (box) => {
    box.querySelector('#memOpen').onclick = () => { closeModal(); openChapterFromIndex(ch.id); };
    box.querySelector('#memEdit').onclick = () => openMemoryEditor(ch);
    box.querySelector('#memClose').onclick = () => closeModal();
    box.querySelector('#memX').onclick = () => closeModal();
    box.querySelector('#memRegen').onclick = () => {
      if (!confirm('重新生成会覆盖当前章节记忆，继续？')) return;
      const chapterId = ch.id;
      closeModal();
      if (S.view !== 'studio') setView('studio');
      if (S.chapterId !== chapterId) selectChapter(chapterId);
      setTimeout(() => $('[data-quick="memory"]')?.click(), 30);
    };
  });
}

/** 手动修正章节记忆。数组字段一行一条，留空即删除该条。 */
function openMemoryEditor(ch) {
  if (!ch) return toast('先选一章', 'err');
  const mem = ch.memory || {};
  const no = ch.no || (S.novel?.chapters.indexOf(ch) + 1) || 1;
  // 编辑时只读 memory.summary，不拿章节概要兜底，避免清空记忆后又被章节概要“复活”
  const summary = String(mem.summary || '').trim();
  const listText = (key) => memoryItems(mem, key).join('\n');
  showModal(`<div class="mem-head"><h3>${ch.memory ? '编辑章节记忆' : '新建章节记忆'}</h3><button class="icon-btn sm mem-x" id="memX" title="关闭" aria-label="关闭">${ico('x')}</button></div>
    <p class="modal-sub">第 ${no} 章《${esc(ch.title || '未命名')}》 · 每行一条；留空会从记忆里移除。全部留空会清空本章记忆。</p>
    <form class="mem-edit" id="memForm">
      <label class="field-label">概要<textarea class="textarea" id="memSummary" rows="3" placeholder="用一两句话概括本章；不填则沿用章节概要">${esc(summary)}</textarea></label>
      <label class="field-label">关键事件<textarea class="textarea" id="memEvents" rows="4" placeholder="一行一件">${esc(listText('events'))}</textarea></label>
      <label class="field-label">出场人物<textarea class="textarea" id="memCharacters" rows="3" placeholder="一行一人">${esc(listText('characters'))}</textarea></label>
      <label class="field-label">状态变化<textarea class="textarea" id="memStates" rows="3" placeholder="谁 / 什么发生了变化">${esc(listText('stateChanges'))}</textarea></label>
      <label class="field-label">伏笔<textarea class="textarea" id="memForeshadow" rows="3" placeholder="一行一条">${esc(listText('foreshadowing'))}</textarea></label>
      <label class="field-label">未决<textarea class="textarea" id="memUnresolved" rows="3" placeholder="一行一条">${esc(listText('unresolved'))}</textarea></label>
      <p class="mem-edit-hint">修改后会同步影响后续章节的上下文和「线索」页；线索是否已回收仍以正文为准。</p>
      <div class="modal-foot mem-foot">
        <button type="button" class="btn btn-text" id="memCancel">取消</button>
        <button type="submit" class="btn btn-primary">保存记忆</button>
      </div>
    </form>`, (box) => {
    box.querySelector('#memX').onclick = () => closeModal();
    box.querySelector('#memCancel').onclick = () => { if (ch.memory) openMemoryModal(ch); else closeModal(); };
    box.querySelector('#memForm').onsubmit = (e) => {
      e.preventDefault();
      const readList = (id) => box.querySelector(`#${id}`).value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const next = {
        summary: box.querySelector('#memSummary').value.trim(),
        events: readList('memEvents'),
        characters: readList('memCharacters'),
        stateChanges: readList('memStates'),
        foreshadowing: readList('memForeshadow'),
        unresolved: readList('memUnresolved'),
      };
      const empty = !next.summary && !next.events.length && !next.characters.length && !next.stateChanges.length && !next.foreshadowing.length && !next.unresolved.length;
      const had = !!ch.memory;
      if (empty && !had) return toast('还没有填写内容', 'err');
      if (empty) ch.memory = null;
      else ch.memory = { ...(ch.memory || {}), ...next };
      if (!ch.summary && next.summary) ch.summary = next.summary;
      markChapterDirty(ch);
      updateFoot();
      closeModal();
      if (S.view === 'bible') renderBible(); else renderStudio();
      toast(empty ? '章节记忆已清空' : had ? '章节记忆已保存' : '章节记忆已创建', 'ok');
    };
  });
}

/* ============================================================
 * 批量补章节记忆
 * ============================================================ */
function memoryCandidates(from, to, skipExisting) {
  return (S.novel?.chapters || []).filter((c) =>
    c.no >= from && c.no <= to && (c.content || '').trim() && (!skipExisting || !c.memory));
}

function openBatchMemory() {
  if (!S.novel) return toast('先打开作品', 'err');
  if (S.controller || S.batchController) return toast('已有任务在跑，先停止', 'err');
  const chapters = S.novel.chapters;
  if (!chapters.length) return toast('这部作品还没有章节', 'err');
  if (!aiModelReady('memory')) {
    return openModelSetup({
      introTitle: '批量补记忆前还差一步：接入模型',
      introText: '补章节记忆要逐章调用模型。先把模型接好，再回来选章节范围。',
      modelTitle: '选一个模型，继续补记忆',
      saveLabel: '保存，继续补记忆',
      isReady: () => aiModelReady('memory'),
      onReady: openBatchMemory,
      onCancel: () => toast('还没接入模型，这次没有开始补记忆'),
    });
  }
  const last = chapters[chapters.length - 1].no || chapters.length;
  const firstMissing = chapters.find((c) => (c.content || '').trim() && !c.memory);

  showModal(`<h3>批量补全章节记忆</h3>
    <p class="modal-sub">逐章让 AI 提炼人物、事件、状态变化与伏笔，存进章节记忆。导入旧稿后跑一遍，后续续写和一致性检查就能用上前情。每章调用一次模型，长篇需要一些时间，也会产生费用。</p>
    <div class="grid2">
      <label class="field-label">从第几章<input id="bmpFrom" class="input" type="number" min="1" max="${last}" value="${firstMissing ? firstMissing.no : 1}" /></label>
      <label class="field-label">到第几章<input id="bmpTo" class="input" type="number" min="1" max="${last}" value="${last}" /></label>
    </div>
    <label class="find-check bmp-skip"><input type="checkbox" id="bmpSkip" checked /> 跳过已有记忆的章节</label>
    <div class="dim small" id="bmpCount"></div>
    <div class="batch-progress" id="bmpBox" hidden>
      <div class="batch-bar"><i id="bmpBar"></i></div>
      <div class="batch-line"><span id="bmpNow">准备中…</span><span id="bmpNums">0 / 0</span></div>
      <div class="batch-log" id="bmpLog"></div>
    </div>
    <div class="modal-foot"><button class="btn btn-text" id="bmpCancel">取消</button><button class="btn btn-primary" id="bmpStart">开始补全</button></div>`,
  (box) => {
    const fromEl = box.querySelector('#bmpFrom');
    const toEl = box.querySelector('#bmpTo');
    const skipEl = box.querySelector('#bmpSkip');
    const countEl = box.querySelector('#bmpCount');
    const startBtn = box.querySelector('#bmpStart');
    const cancelBtn = box.querySelector('#bmpCancel');
    const boxEl = box.querySelector('#bmpBox');
    const bar = box.querySelector('#bmpBar');
    const nowEl = box.querySelector('#bmpNow');
    const numsEl = box.querySelector('#bmpNums');
    const logEl = box.querySelector('#bmpLog');
    let ranOnce = false;

    const range = () => {
      const a0 = Math.max(1, Math.min(last, Number(fromEl.value) || 1));
      const b0 = Math.max(1, Math.min(last, Number(toEl.value) || last));
      return a0 <= b0 ? { from: a0, to: b0 } : { from: b0, to: a0 };
    };
    const candidates = () => {
      const { from, to } = range();
      return memoryCandidates(from, to, skipEl.checked);
    };
    const refresh = () => {
      const { from, to } = range();
      const list = memoryCandidates(from, to, skipEl.checked);
      const all = memoryCandidates(from, to, false);
      countEl.textContent = list.length
        ? `将处理 ${list.length} 章${all.length > list.length ? `（范围内 ${all.length} 章有正文，已有记忆的会跳过）` : ''}`
        : '这个范围里没有需要补的章节。';
      startBtn.disabled = !list.length || !!S.batchController;
      startBtn.textContent = S.batchController ? '补全中…' : !list.length && ranOnce ? '已完成' : ranOnce ? '继续补全' : '开始补全';
    };
    fromEl.oninput = toEl.oninput = skipEl.onchange = refresh;

    const setProgress = (done, total, ch) => {
      bar.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
      numsEl.textContent = `${done} / ${total}`;
      nowEl.textContent = ch ? `第 ${ch.no} 章 ${ch.title || ''}` : '准备中…';
    };

    const run = async () => {
      const list = candidates();
      if (!list.length) { refresh(); return toast('这个范围里没有需要补的章节'); }
      const ac = new AbortController();
      ranOnce = true;
      S.batchController = ac;
      refresh();
      fromEl.disabled = toEl.disabled = skipEl.disabled = true;
      cancelBtn.textContent = '停止';
      startBtn.textContent = '补全中…';
      boxEl.hidden = false;
      logEl.textContent = '';
      let done = 0;
      let failed = 0;
      let streak = 0;
      let stopped = false;
      let gaveUp = false;

      for (let i = 0; i < list.length; i++) {
        if (ac.signal.aborted) { stopped = true; break; }
        const ch = list[i];
        setProgress(i, list.length, ch);
        try {
          let acc = '';
          await streamAI({ task: 'memory', novelId: S.novel.id, chapterId: ch.id, payload: { templateKey: 'batchMemory' } }, {
            signal: ac.signal,
            onDelta: (d) => { acc += d; },
          });
          if (ac.signal.aborted) { stopped = true; break; }
          const obj = parseJsonLoose(acc);
          if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('模型没按 JSON 格式输出');
          ch.memory = obj;
          if (!ch.summary && obj.summary) ch.summary = obj.summary;
          ch.status = 'done';
          await api.send(`/api/novels/${S.novel.id}/chapters/${ch.id}`, {
            memory: ch.memory,
            summary: ch.summary,
            status: ch.status,
          }, 'PUT');
          done += 1;
          streak = 0;
        } catch (err) {
          if (ac.signal.aborted || err?.name === 'AbortError') { stopped = true; break; }
          failed += 1;
          streak += 1;
          const line = document.createElement('div');
          line.textContent = `第 ${ch.no} 章：${err.message || '失败'}`;
          logEl.appendChild(line);
          setProgress(i + 1, list.length, ch);
          if (streak >= 3) {
            gaveUp = true;
            const warn = document.createElement('div');
            warn.textContent = '连续失败 3 章，已自动停下。检查模型设置后再继续。';
            logEl.appendChild(warn);
            break;
          }
        }
        setProgress(i + 1, list.length, ch);
      }

      S.batchController = null;
      fromEl.disabled = toEl.disabled = skipEl.disabled = false;
      refresh();
      const left = candidates().length;
      startBtn.disabled = !left;
      startBtn.textContent = !left ? '已完成' : (stopped || gaveUp) ? '继续补全' : '再跑一次';
      cancelBtn.textContent = '关闭';
      if (stopped) toast(`已停止 · 完成 ${done} 章${failed ? `，失败 ${failed} 章` : ''}`);
      else if (gaveUp) toast(`已停止：完成 ${done} 章，失败 ${failed} 章`, 'err');
      else if (failed && !done) toast(`补记忆失败：${failed} 章`, 'err');
      else toast(`补记忆完成：${done} 章${failed ? `，失败 ${failed} 章` : ''}`, failed ? 'err' : 'ok');
      renderStudio();
    };

    startBtn.onclick = run;
    cancelBtn.onclick = () => {
      if (S.batchController) S.batchController.abort();
      else closeModal();
    };
    refresh();
    setTimeout(() => fromEl.focus(), 30);
  });
}

$$('[data-quick]').forEach((btn) => btn.addEventListener('click', async () => {
  const kind = btn.dataset.quick;
  if (kind === 'batchMemory') return openBatchMemory();

  const ch = currentChapter();
  if (!ch) return toast('先选一章', 'err');

  if (kind === 'memory') {
    if (!ch.content.trim()) return toast('本章还没正文', 'err');
    const text = await runStream({ task: 'memory', novelId: S.novel.id, chapterId: ch.id });
    if (!text) return;
    const obj = parseJsonLoose(text);
    if (!obj || typeof obj !== 'object') return toast('解析失败：模型没按 JSON 格式输出', 'err');
    ch.memory = obj;
    if (!ch.summary && obj.summary) ch.summary = obj.summary;
    ch.status = 'done';
    markDirty();
    updateFoot();
    renderStudio();
    toast('章节记忆已存档，后续写作会自动带上', 'ok');
  }

  if (kind === 'summarize') {
    if (!ch.content.trim()) return toast('本章还没正文', 'err');
    // 走 summarize 任务，自定义模板才能生效（直接传 messages 会绕过模板）
    const text = await runStream({
      task: 'summarize',
      novelId: S.novel.id,
      chapterId: ch.id,
      payload: { templateKey: 'summarize' },
    });
    if (!text.trim()) return;
    ch.summary = text.trim().slice(0, 300);
    markDirty();
    toast('已写入本章概要', 'ok');
  }

  if (kind === 'titles') {
    await runStream({
      task: 'titles',
      novelId: S.novel.id,
      chapterId: ch.id,
      payload: { instruction: `给这本书想 8 个书名候选，并给第 ${S.novel.chapters.indexOf(ch) + 1} 章起 5 个章节名候选（当前名：${ch.title}）。` },
    });
  }
}));

/* ---------- 段落级操作 ---------- */
async function runSegmentOp(op, text, range, extra = {}) {
  const ch = currentChapter();
  if (!ch) return;
  S.lastOp = { op, text, range, extra, chapterId: ch.id };
  const out = await runStream({
    task: op,
    novelId: S.novel.id,
    chapterId: ch.id,
    payload: { text, ...extra },
  });
  if (!out.trim()) return;
  showDiff(text, out.trim(), op, range);
}

function showDiff(oldText, newText, op, range) {
  const panel = $('#diffPanel');
  const names = { polish: '润色', expand: '扩写', shorten: '精简', rewrite: '改写', custom: '按指令处理' };
  $('#diffTitle').textContent = `${names[op] || op}结果 · ${countWords(oldText)} 字 → ${countWords(newText)} 字`;
  // 差异高亮：左边标出被改掉的字，右边标出新写的字，一眼看出动在哪
  const d = diffProse(oldText, newText);
  $('#diffOld').innerHTML = diffSideHtml(d.segs, 'old');
  $('#diffNew').innerHTML = diffSideHtml(d.segs, 'new');
  panel.hidden = false;
  $('#diffAccept').onclick = () => {
    const ta = $('#chContent');
    if (currentChapter()?.id === S.lastOp?.chapterId) {
      const base = ta.value;
      ta.value = base.slice(0, range.start) + newText + base.slice(range.end);
      ta.setSelectionRange(range.start, range.start + newText.length);
      ta.dispatchEvent(new Event('input'));
    }
    toast('已替换 · 按 Ctrl+Z 可撤销', 'ok');
    panel.hidden = true;
  };
  $('#diffRetry').onclick = async () => {
    panel.hidden = true;
    if (S.lastOp) await runSegmentOp(S.lastOp.op, S.lastOp.text, S.lastOp.range, S.lastOp.extra);
  };
  $('#diffReject').onclick = () => { panel.hidden = true; };
  $('#diffClose').onclick = () => { panel.hidden = true; };
}

/* ============================================================
 * 7. 检查
 * ============================================================ */
$$('#assistTabs button').forEach((b) => b.addEventListener('click', () => {
  showAssistTab(b.dataset.tab);
}));
function showAssistTab(name) {
  $$('#assistTabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === name));
  $$('.assist-pane').forEach((p) => p.classList.toggle('on', p.dataset.pane === name));
  if (name === 'scenes') renderCorkboard();
  if (name === 'check') renderRevisionCard();
  if (name === 'annotations') renderAnnotationSidebar();
}

/* ------------------------------------------------------------
 * 本章修订清单：作者自己的待改项，存在 chapter.revisions
 * ------------------------------------------------------------
 * 添加时可带一段正文引文作为锚点；引文按「离记录位置最近的一次」
 * 定位，正文改过也能尽量找回来。全部本地，不调用模型。
 * ------------------------------------------------------------ */
function syncRevisionBadge(ch) {
  if (!ch) return;
  const li = chapterRow(ch.id);
  if (!li) return;
  const n = openRevisionCount(ch);
  const words = li.querySelector('.ci-words');
  if (words) {
    let badge = words.querySelector('.ci-rev');
    if (n) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'ci-rev';
        words.prepend(badge);
      }
      badge.textContent = String(n);
      badge.title = `${n} 项待改`;
    } else if (badge) {
      badge.remove();
    }
  }
  li.title = `${STAGE_LABEL[stageOf(ch)]}${ch.memory ? ' · 已有章节记忆' : ''}${n ? ` · ${n} 项待改` : ''}`;
}

function revisionItemHtml(rev) {
  const rawText = String(rev.text || '').trim() || '未填写内容';
  const quote = String(rev.quote || '').replace(/\s+/g, ' ').trim();
  const shortQuote = quote.length > 58 ? `${quote.slice(0, 58)}…` : quote;
  const quoteHtml = quote
    ? `<button type="button" class="rev-quote" data-rev-act="quote" title="${esc(quote)}">${esc(shortQuote)}</button>`
    : '';
  return `<li class="rev-item${rev.done ? ' done' : ''}" data-rev-id="${esc(rev.id || '')}">
    <button type="button" class="rev-check" data-rev-act="toggle" role="checkbox" aria-checked="${rev.done ? 'true' : 'false'}" title="${rev.done ? '标记为未完成' : '标记为已完成'}">${rev.done ? ico('check') : ''}</button>
    <div class="rev-main"><span class="rev-text">${esc(rawText)}</span>${quoteHtml}</div>
    <button type="button" class="rev-del" data-rev-act="del" title="删除这条修订" aria-label="删除这条修订">${ico('x')}</button>
  </li>`;
}

function renderRevisionCard() {
  const card = $('#revisionCard');
  if (!card) return;
  const ch = currentChapter();
  if (!ch) {
    card.hidden = true;
    $('#revList').innerHTML = '';
    $('#revCount').textContent = '';
    S.revisionDraftChapterId = null;
    return;
  }
  card.hidden = false;
  if (S.revisionDraftChapterId !== ch.id) {
    S.revisionDraftChapterId = ch.id;
    const input = $('#revInput');
    if (input) input.value = '';
  }
  const revs = revisionsOf(ch);
  const open = revs.filter((r) => !r.done).length;
  const done = revs.length - open;
  const countEl = $('#revCount');
  countEl.textContent = revs.length ? `${open} 项待改${done ? ` · ${done} 项完成` : ''}` : '暂无';
  countEl.classList.toggle('done', revs.length > 0 && open === 0);
  const ordered = revs.slice().sort((a, b) => Number(!!a.done) - Number(!!b.done) || (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  $('#revList').innerHTML = ordered.length
    ? ordered.map(revisionItemHtml).join('')
    : '<li class="rev-empty">还没有修订项。选中正文里的句子，再在这里记一条，之后能一键跳回原处。</li>';
}

function addRevision() {
  const ch = currentChapter();
  if (!ch) return toast('先打开一章', 'err');
  const input = $('#revInput');
  const text = String(input?.value || '').trim();
  if (!text) { input?.focus(); return; }
  const ta = $('#chContent');
  let quote = '';
  let at = 0;
  if (ta && ta.selectionEnd > ta.selectionStart) {
    const start = ta.selectionStart;
    const raw = ta.value.slice(start, ta.selectionEnd);
    quote = raw.trim().slice(0, 120);
    if (quote) at = start + Math.max(0, raw.indexOf(quote));
  }
  const revs = Array.isArray(ch.revisions) ? ch.revisions : (ch.revisions = []);
  revs.unshift({
    id: uid('rev'),
    text: text.slice(0, 240),
    quote,
    at: quote ? at : 0,
    done: false,
    createdAt: Date.now(),
  });
  ch.revisions = revs;
  if (input) input.value = '';
  if (quote && ta) ta.setSelectionRange(ta.selectionEnd, ta.selectionEnd); // 别让下一条修订误用同一段引文
  markChapterDirty(ch);
  renderRevisionCard();
  syncRevisionBadge(ch);
  input?.focus();
}

function toggleRevision(id, chapterId = S.chapterId) {
  const ch = S.novel?.chapters.find((c) => c.id === chapterId) || null;
  if (!ch) return;
  const rev = revisionsOf(ch).find((r) => String(r.id) === String(id));
  if (!rev) return;
  rev.done = !rev.done;
  markChapterDirty(ch);
  if (ch.id === S.chapterId) renderRevisionCard();
  syncRevisionBadge(ch);
}

function removeRevision(id) {
  const ch = currentChapter();
  if (!ch) return;
  ch.revisions = revisionsOf(ch).filter((r) => String(r.id) !== String(id));
  markChapterDirty(ch);
  renderRevisionCard();
  syncRevisionBadge(ch);
}

function nearestQuoteIndex(content, quote, prefer) {
  if (!quote) return -1;
  let from = 0;
  let best = -1;
  let bestDist = Infinity;
  let guard = 0;
  while (guard < 300) {
    guard += 1;
    const at = content.indexOf(quote, from);
    if (at < 0) break;
    const dist = Math.abs(at - (Number(prefer) || 0));
    if (dist < bestDist) { best = at; bestDist = dist; }
    from = at + Math.max(1, quote.length);
  }
  return best;
}

function locateRevision(id) {
  const ch = currentChapter();
  if (!ch) return;
  const rev = revisionsOf(ch).find((r) => String(r.id) === String(id));
  const quote = String(rev?.quote || '');
  if (!quote) return;
  const ta = $('#chContent');
  if (!ta) return;
  const at = nearestQuoteIndex(ta.value, quote, rev.at);
  if (at < 0) return toast('正文里已经找不到这段引文了', 'err');
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(at, at + quote.length);
  ta.scrollTop = Math.max(0, editorCaretTop(ta, at) - ta.clientHeight * 0.32);
}

function jumpToRevision(chapterId, revId) {
  const ch = S.novel?.chapters.find((c) => c.id === chapterId);
  if (!ch) return toast('这一章已经不存在了', 'err');
  closeModal();
  openChapterFromIndex(ch.id);
  showAssistTab('check');
  if (revId) locateRevision(revId);
}

/** 全书修订清单：按章汇总，支持筛选、搜索、勾选完成和跳回引文 */
function openRevisionInbox() {
  if (!S.novel) return toast('先打开一部作品', 'err');
  const n = S.novel;
  const collect = () => n.chapters.flatMap((ch, index) => revisionsOf(ch).map((rev) => ({ ch, index, rev })));
  const all = collect();
  const withRevs = new Set(all.map((x) => x.ch.id)).size;
  const open = all.filter((x) => !x.rev.done).length;

  if (!all.length) {
    showModal(`
      <h3>全书修订</h3>
      <p class="modal-sub">《${esc(n.title)}》 · 全部本地保存，不调用模型。</p>
      <div class="rev-inbox-empty">还没有任何修订项。<br>在正文里选中要改的句子，再回到「检查 → 本章修订」记一条。</div>
      <div class="modal-foot">
        <button class="btn" id="revInboxGo">打开本章修订</button>
        <button class="btn btn-primary" id="revInboxClose">关闭</button>
      </div>`, (box) => {
      box.querySelector('#revInboxClose').onclick = closeModal;
      box.querySelector('#revInboxGo').onclick = () => {
        closeModal();
        if (!currentChapter()) return toast('先打开一章', 'err');
        setView('studio');
        showAssistTab('check');
        setTimeout(() => $('#revInput')?.focus(), 30);
      };
    });
    return;
  }

  let filter = 'open';
  let query = '';
  showModal(`
    <h3>全书修订</h3>
    <p class="modal-sub" id="revInboxMeta">${withRevs} 章有修订 · ${open} 项待改 · ${all.length - open} 项完成</p>
    <div class="rev-inbox-tools">
      <div class="segmented" id="revInboxFilter">
        <button type="button" class="on" data-ri-filter="open">待改</button>
        <button type="button" data-ri-filter="all">全部</button>
        <button type="button" data-ri-filter="done">已完成</button>
      </div>
      <input class="input" id="revInboxSearch" placeholder="搜索修订内容、引文或章节" autocomplete="off" />
    </div>
    <div id="revInboxBody"></div>
    <div class="modal-foot">
      <span class="health-note">勾选完成 · 点章节或引文跳回正文</span>
      <button class="btn btn-primary" id="revInboxClose">关闭</button>
    </div>`, (box) => {
    const bodyEl = box.querySelector('#revInboxBody');
    const metaEl = box.querySelector('#revInboxMeta');
    const searchEl = box.querySelector('#revInboxSearch');
    const filterEls = [...box.querySelectorAll('[data-ri-filter]')];

    const render = () => {
      const now = collect();
      const openNow = now.filter((x) => !x.rev.done).length;
      const withNow = new Set(now.map((x) => x.ch.id)).size;
      metaEl.textContent = `${withNow} 章有修订 · ${openNow} 项待改 · ${now.length - openNow} 项完成`;

      const q = query.trim().toLowerCase();
      const groups = [];
      n.chapters.forEach((ch, index) => {
        const revs = revisionsOf(ch).filter((rev) => {
          if (filter === 'open' && rev.done) return false;
          if (filter === 'done' && !rev.done) return false;
          if (!q) return true;
          const hay = `${ch.title || ''} 第${index + 1}章 ${rev.text || ''} ${rev.quote || ''}`.toLowerCase();
          return hay.includes(q);
        }).sort((a, b) => Number(!!a.done) - Number(!!b.done) || (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
        if (revs.length) groups.push({ ch, index, revs });
      });

      if (!groups.length) {
        const msg = q
          ? '没有找到匹配的修订项。'
          : filter === 'done'
            ? '还没有已完成的修订项。'
            : filter === 'open'
              ? '没有待改的修订项，暂时清空了。'
              : '没有修订项。';
        bodyEl.innerHTML = `<div class="rev-inbox-empty">${msg}${q ? '<br><span class="dim small">换个关键词，或把筛选切到「全部」。</span>' : ''}</div>`;
        return;
      }

      bodyEl.innerHTML = groups.map(({ ch, index, revs }) => {
        const allRevs = revisionsOf(ch);
        const cOpen = allRevs.filter((r) => !r.done).length;
        const cDone = allRevs.length - cOpen;
        const count = cOpen ? `${cOpen} 待改${cDone ? ` · ${cDone} 完成` : ''}` : `${cDone} 完成`;
        return `<section class="rev-inbox-group">
          <button type="button" class="rev-inbox-chapter" data-ri-chapter="${esc(ch.id)}" title="打开这一章">
            <span class="ri-no">${String(index + 1).padStart(2, '0')}</span>
            <span class="ri-title">${esc(ch.title || '未命名')}</span>
            <span class="ri-count">${count}</span>
            ${ico('arrow-right')}
          </button>
          <ul class="ri-list">
            ${revs.map((rev) => {
              const text = String(rev.text || '').trim() || '未填写内容';
              const quote = String(rev.quote || '').replace(/\s+/g, ' ').trim();
              const shortQuote = quote.length > 64 ? `${quote.slice(0, 64)}…` : quote;
              return `<li class="ri-item${rev.done ? ' done' : ''}">
                <button type="button" class="rev-check" data-ri-toggle data-chapter="${esc(ch.id)}" data-rev="${esc(rev.id || '')}" role="checkbox" aria-checked="${rev.done ? 'true' : 'false'}" title="${rev.done ? '标记为未完成' : '标记为已完成'}">${rev.done ? ico('check') : ''}</button>
                <div class="ri-main">
                  <span class="ri-text">${esc(text)}</span>
                  ${quote ? `<button type="button" class="rev-quote" data-ri-goto data-chapter="${esc(ch.id)}" data-rev="${esc(rev.id || '')}" title="回到原文：${esc(quote)}">${esc(shortQuote)}</button>` : ''}
                </div>
              </li>`;
            }).join('')}
          </ul>
        </section>`;
      }).join('');
    };

    filterEls.forEach((el) => {
      el.onclick = () => {
        filter = el.dataset.riFilter;
        filterEls.forEach((x) => x.classList.toggle('on', x === el));
        render();
      };
    });
    searchEl.addEventListener('input', () => { query = searchEl.value; render(); });
    bodyEl.addEventListener('click', (e) => {
      const toggle = e.target.closest('[data-ri-toggle]');
      if (toggle) {
        toggleRevision(toggle.dataset.rev, toggle.dataset.chapter);
        render();
        return;
      }
      const goto = e.target.closest('[data-ri-goto]');
      if (goto) { jumpToRevision(goto.dataset.chapter, goto.dataset.rev); return; }
      const chapter = e.target.closest('[data-ri-chapter]');
      if (chapter) jumpToRevision(chapter.dataset.riChapter, '');
    });
    box.querySelector('#revInboxClose').onclick = closeModal;
    render();
  });
}

$('#revAll')?.addEventListener('click', openRevisionInbox);
$('#revAdd')?.addEventListener('click', addRevision);
$('#revInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    addRevision();
  }
});
$('#revList')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-rev-act]');
  if (!btn) return;
  const id = btn.closest('.rev-item')?.dataset.revId;
  if (!id) return;
  if (btn.dataset.revAct === 'toggle') toggleRevision(id);
  else if (btn.dataset.revAct === 'del') removeRevision(id);
  else if (btn.dataset.revAct === 'quote') locateRevision(id);
});

function scopeForCheck() {
  const n = S.novel;
  const mode = $('#checkScope').value;
  const idx = n.chapters.findIndex((c) => c.id === S.chapterId);
  if (mode === 'current') return { chapterIds: S.chapterId ? [S.chapterId] : undefined };
  if (mode === 'last3') return { chapterIds: n.chapters.slice(Math.max(0, idx - 2), idx + 1).map((c) => c.id) };
  if (mode === 'last5') return { chapterIds: n.chapters.slice(Math.max(0, idx - 4), idx + 1).map((c) => c.id) };
  if (mode === 'all') return { from: 1, to: 99999, maxChars: 40000 };
  return {
    scopeText: `【人物卡】\n${JSON.stringify(n.bible.characters, null, 1)}\n\n【世界观】\n${JSON.stringify(n.bible.world, null, 1)}\n\n【时间线】\n${JSON.stringify(n.bible.timeline, null, 1)}\n\n【分卷大纲】\n${JSON.stringify(n.outline.volumes, null, 1)}`,
  };
}

function renderIssues(text) {
  const box = $('#checkBox');
  const arr = parseJsonLoose(text);
  if (!Array.isArray(arr)) { box.innerHTML = mdLite(text); return; }
  if (!arr.length) { box.innerHTML = '<div class="status-ok">✓ 没有发现明显冲突。</div>'; return; }
  const lvl = (l) => (/严重/.test(l) ? 'severe' : /中等/.test(l) ? 'mid' : 'light');
  box.innerHTML = arr.map((it) => `
    <div class="issue ${lvl(it.level)}">
      <div class="is-head"><b>${esc(it.level || '提示')}</b><span>${esc(it.type || '')}</span></div>
      ${it.location ? `<div class="is-loc">${esc(it.location)}</div>` : ''}
      <div class="is-problem">${esc(it.problem || '')}</div>
      ${it.suggestion ? `<div class="is-fix">→ ${esc(it.suggestion)}</div>` : ''}
    </div>`).join('');
}

function renderConsistencyReport(report) {
  const box = $('#checkBox');
  const ignoredList = Array.isArray(S.novel?.meta?.consistencyIgnored) ? S.novel.meta.consistencyIgnored : [];
  const ignoredHtml = ignoredList.length ? `
    <div class="proof-ignored" id="consistencyIgnoredBox">
      <div class="proof-ignored-head">
        <span>已忽略 ${ignoredList.length} 条</span>
        <span style="flex:1"></span>
        <button type="button" class="btn btn-sm btn-text" id="consistencyRestoreAll">全部恢复</button>
      </div>
      <div class="proof-ignored-list">
        ${ignoredList.slice().reverse().map((x) => {
          const key = typeof x === 'string' ? x : x?.key || '';
          const label = typeof x === 'string' ? x : x?.label || key;
          return `<div class="proof-ignored-row">
            <span class="proof-main"><span class="proof-msg">${esc(label)}</span></span>
            <button type="button" class="btn btn-sm btn-text" data-consistency-restore="${esc(key)}">恢复</button>
          </div>`;
        }).join('')}
      </div>
    </div>` : '';

  const restoreIgnored = async (keys) => {
    const remove = new Set(keys);
    const list = (S.novel.meta?.consistencyIgnored || []).filter((x) => {
      const key = typeof x === 'string' ? x : x?.key;
      return key && !remove.has(key);
    });
    try {
      await api.put(`/api/novels/${S.novel.id}`, { meta: { consistencyIgnored: list } });
    } catch (err) {
      toast(err.message, 'err');
      return;
    }
    S.novel.meta = { ...(S.novel.meta || {}), consistencyIgnored: list };
    toast(keys.length > 1 ? '已恢复全部忽略项' : '已恢复这一条', 'ok');
    $('#consistencyBtn').click();
  };
  const bindConsistencyIgnored = (host) => {
    host.querySelectorAll('[data-consistency-restore]').forEach((btn) => {
      btn.onclick = () => restoreIgnored([btn.dataset.consistencyRestore]);
    });
    const all = host.querySelector('#consistencyRestoreAll');
    if (all) {
      all.onclick = () => restoreIgnored(
        (S.novel.meta?.consistencyIgnored || [])
          .map((x) => (typeof x === 'string' ? x : x?.key))
          .filter(Boolean),
      );
    }
  };

  if (!report.issues?.length) {
    box.innerHTML = `<div class="status-ok">✓ 一致性检查通过，未发现明显矛盾。</div>${ignoredHtml}`;
    bindConsistencyIgnored(box);
    return;
  }
  const byKind = {};
  for (const it of report.issues) {
    if (!byKind[it.kind]) byKind[it.kind] = [];
    byKind[it.kind].push(it);
  }
  const kindMeta = {
    setting: { icon: '🛡️', label: '设定冲突' },
    timeline: { icon: '🕰️', label: '时间线矛盾' },
    character: { icon: '👤', label: '人物行为异常' },
    name: { icon: '✍️', label: '人物姓名笔误' },
    voice: { icon: '🎙️', label: '口吻/语风差异' },
  };
  const sevClass = (s) => s === 'hint' ? 'hint' : '';
  let html = ignoredHtml + '<div class="consistency-report">';
  for (const [kind, list] of Object.entries(byKind)) {
    const meta = kindMeta[kind] || { icon: '•', label: kind };
    html += `<div class="consistency-kind"><h4>${meta.icon} ${meta.label} (${list.length})</h4>`;
    for (const it of list) {
      const sev = sevClass(it.severity);
      const fingerprint = it.fingerprint || consistencyKey(it.kind, it.id);
      const ignored = (S.novel.meta?.consistencyIgnored || []).some(x => x.key === fingerprint || x === fingerprint);
      html += `
        <div class="issue ${sev}" data-fingerprint="${esc(fingerprint)}">
          <div class="is-head"><b>${esc(it.message)}</b>${ignored ? '<span class="ignored-badge">已忽略</span>' : ''}</div>
          ${it.loc ? `<div class="is-loc">${esc(it.loc)}</div>` : ''}
          ${!ignored ? `
            <div class="is-actions">
              <button class="btn btn-sm btn-text ignore-btn" data-fingerprint="${esc(fingerprint)}" data-kind="${esc(it.kind)}" data-label="${esc(it.message.slice(0, 30))}">忽略此项</button>
            </div>` : ''}
        </div>`;
    }
    html += '</div>';
  }
  html += '</div>';
  box.innerHTML = html;
  bindConsistencyIgnored(box);
  // 绑定忽略按钮
  box.querySelectorAll('.ignore-btn').forEach(btn => {
    btn.onclick = async () => {
      const fp = btn.dataset.fingerprint;
      const kind = btn.dataset.kind;
      const label = btn.dataset.label;
      const ign = (S.novel.meta?.consistencyIgnored || []).slice();
      ign.push({ key: fp, label: `${kind}: ${label}`, ts: Date.now() });
      try {
        await api.put(`/api/novels/${S.novel.id}`, { meta: { consistencyIgnored: ign } });
      } catch (err) {
        toast(err.message, 'err');
        return;
      }
      S.novel.meta = { ...(S.novel.meta || {}), consistencyIgnored: ign };
      toast('已加入忽略清单', 'ok');
      // 重新渲染
      const scope = $('#checkScope').value;
      const currentChapterId = scope === 'current' ? S.chapterId : null;
      const report = scanConsistency(S.novel, scope === 'bible' ? 'book' : scope, currentChapterId);
      const filtered = applyConsistencyIgnored(report, ign);
      renderConsistencyReport(filtered);
    };
  });
}

$('#consistencyBtn').addEventListener('click', async () => {
  if (!S.novel) return toast('先打开作品', 'err');
  const scope = $('#checkScope').value;
  const currentChapterId = scope === 'current' ? S.chapterId : null;
  const report = scanConsistency(S.novel, scope === 'bible' ? 'book' : scope, currentChapterId);
  // 应用忽略清单
  const ignored = S.novel.meta?.consistencyIgnored || [];
  const filtered = applyConsistencyIgnored(report, ignored);
  renderConsistencyReport(filtered);
});

$('#reviewBtn').addEventListener('click', async () => {
  if (!S.novel) return toast('先打开作品', 'err');
  const text = await runStream({ task: 'review', novelId: S.novel.id, chapterId: S.chapterId, payload: scopeForCheck() }, { target: 'check' });
  if (text) $('#checkBox').innerHTML = mdLite(text);
});

/* ============================================================
 * 8. 资料面板（上下文预览 / 改后重发）
 * ============================================================ */
$('#previewCtxBtn').addEventListener('click', async () => {
  if (!S.novel) return toast('先打开作品', 'err');
  try {
    const j = await api.send('/api/context', {
      task: 'chapter',
      novelId: S.novel.id,
      chapterId: S.chapterId,
      payload: { instruction: $('#genReq').value.trim() || undefined, targetWords: Number($('#genWords').value) },
    });
    S.promptPreview = j;
    const chars = j.messages.reduce((s, m) => s + m.content.length, 0);
    $('#ctxStats').innerHTML = `本次注入约 ${j.stats.packChars || 0} 字符资料，含 ${(j.stats.lines || []).length} 个板块：<br>${esc((j.stats.lines || []).join('　/　'))}<br>
      全部消息共 ${chars} 字符，估算输入 tokens ≈ ${Math.round(chars / 1.4)}`;
    $('#ctxPreview').textContent = j.messages.map((m) => `【${m.role === 'system' ? '系统' : '指令'}】\n${m.content}`).join('\n\n————\n\n');
    $('#ctxPreview').contentEditable = 'true';
    $('#sendEditedBtn').hidden = false;
  } catch (err) { toast(err.message, 'err'); }
});

$('#sendEditedBtn').addEventListener('click', async () => {
  if (!S.promptPreview) return;
  const blocks = $('#ctxPreview').textContent.split(/\n\n————\n\n/);
  const messages = blocks
    .map((b) => b.replace(/^【[^】]+】\n?/, '').trim())
    .filter(Boolean)
    .map((content, i, arr) => ({ role: i === 0 && arr.length > 1 ? 'system' : 'user', content }));
  showAssistTab('write');
  await runStream({
    messages,
    task: 'chapter',
    novelId: S.novel?.id,
    chapterId: S.chapterId,
    model: $('#genModel').value.trim() || undefined,
    temperature: S.promptPreview.temperature,
    maxTokens: S.promptPreview.maxTokens,
  });
});

/* ============================================================
 * 场景拆解 / 幕布视图
 * ============================================================ */
function getScenes(ch) {
  ch.scenes = ch.scenes || [];
  return ch.scenes;
}

/** 场景校验：返回 true 表示完整，false 表示有缺失 */
function validateScene(sc) {
  return sc.location && sc.time && sc.characters && sc.summary;
}

function renderCorkboard() {
  const ch = currentChapter();
  const board = $('#corkboard');
  if (!ch) {
    board.innerHTML = '<div class="cork-empty">请先在左侧选择一章</div>';
    $('#scenesInfo').textContent = '';
    return;
  }
  const scenes = getScenes(ch);
  const totalTarget = scenes.reduce((s, sc) => s + (sc.targetWords || 0), 0);
  const totalActual = scenes.reduce((s, sc) => s + countWords(sc.summary || ''), 0);
  $('#scenesInfo').innerHTML = `第 ${ch.no} 章《${ch.title}》 · ${scenes.length} 个场景 · 目标 ${totalTarget || '—'} 字 · 梗概 ${totalActual} 字`;
  if (!scenes.length) {
    board.innerHTML = '<div class="cork-empty">还没有场景卡片。点「从章纲生成场景」或「新增场景」开始。</div>';
    return;
  }
  board.innerHTML = scenes.map((sc, i) => `
    <div class="scene-card${validateScene(sc) ? '' : ' scene-warn'}" data-index="${i}" draggable="true">
      <div class="scene-handle" title="拖拽排序">${ico('grip')}</div>
      <div class="scene-actions">
        <button class="scene-gen" title="生成正文" aria-label="生成正文" data-index="${i}">${ico('spark')}</button>
        <button class="scene-dup" title="复制" aria-label="复制" data-index="${i}">${ico('copy')}</button>
        <button class="scene-del" title="删除">${ico('x')}</button>
      </div>
      <div class="scene-header">
        <span class="scene-num">场次 ${i + 1}</span>
        <span class="scene-pov">${esc(sc.pov || '')}</span>
      </div>
      <div class="scene-field"><span class="scene-label">地点</span><span class="scene-value">${esc(sc.location || '')}</span>${!sc.location ? '<span class="scene-warn-tag">缺</span>' : ''}</div>
      <div class="scene-field"><span class="scene-label">时间</span><span class="scene-value">${esc(sc.time || '')}</span>${!sc.time ? '<span class="scene-warn-tag">缺</span>' : ''}</div>
      <div class="scene-field"><span class="scene-label">人物</span><span class="scene-value">${esc(sc.characters || '')}</span>${!sc.characters ? '<span class="scene-warn-tag">缺</span>' : ''}</div>
      <div class="scene-field"><span class="scene-label">梗概</span><span class="scene-value">${esc(sc.summary || '')}</span>${!sc.summary ? '<span class="scene-warn-tag">缺</span>' : ''}</div>
      <div class="scene-field"><span class="scene-label">钩子</span><span class="scene-value">${esc(sc.hook || '')}</span></div>
      <div class="scene-field"><span class="scene-label">目标字数</span><span class="scene-value">${sc.targetWords || ''}</span>${sc.targetWords ? ` · ${Math.round((countWords(sc.summary || '') / sc.targetWords) * 100)}%` : ''}</div>
    </div>
  `).join('');

  // 插入线
  const insertLine = document.createElement('div');
  insertLine.className = 'cork-insert-line';
  insertLine.hidden = true;
  board.appendChild(insertLine);

  // 双击编辑
  $$('.scene-card', board).forEach((card) => {
    const idx = Number(card.dataset.index);
    card.addEventListener('dblclick', () => openSceneEditor(ch, idx));
    card.querySelector('.scene-del').onclick = (e) => {
      e.stopPropagation();
      deleteScene(ch, idx);
    };
    card.querySelector('.scene-gen').onclick = (e) => {
      e.stopPropagation();
      generateSceneProse(ch, idx);
    };
    card.querySelector('.scene-dup').onclick = (e) => {
      e.stopPropagation();
      duplicateScene(ch, idx);
    };
  });

  // 拖拽排序 - 使用插入线
  let dragSrc = null;
  let insertBefore = null;
  board.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.scene-card');
    if (!card) return;
    dragSrc = card;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  board.addEventListener('dragend', () => {
    if (dragSrc) dragSrc.classList.remove('dragging');
    insertLine.hidden = true;
    dragSrc = null;
  });
  board.addEventListener('dragover', (e) => {
    e.preventDefault();
    const card = e.target.closest('.scene-card');
    if (card && card !== dragSrc) {
      const rect = card.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      insertLine.hidden = false;
      if (e.clientY < midY) {
        insertLine.style.top = `${rect.top - board.getBoundingClientRect().top}px`;
        insertBefore = card;
      } else {
        insertLine.style.top = `${rect.bottom - board.getBoundingClientRect().top}px`;
        insertBefore = null;
      }
    } else {
      insertLine.hidden = true;
      insertBefore = null;
    }
  });
  board.addEventListener('dragleave', (e) => {
    if (!board.contains(e.relatedTarget)) {
      insertLine.hidden = true;
      insertBefore = null;
    }
  });
  board.addEventListener('drop', (e) => {
    e.preventDefault();
    insertLine.hidden = true;
    const target = e.target.closest('.scene-card');
    if (dragSrc && (target || insertBefore !== null) && dragSrc !== target) {
      const from = Number(dragSrc.dataset.index);
      let to;
      if (insertBefore !== null) to = Number(insertBefore.dataset.index);
      else if (target) to = Number(target.dataset.index) + 1;
      else to = 0;
      moveScene(ch, from, to);
    }
    insertBefore = null;
  });
}

function openSceneEditor(ch, index) {
  const scenes = getScenes(ch);
  const sc = scenes[index] || {};
  const isNew = !scenes[index];
  showModal(`<h3>${isNew ? '新增场景' : '编辑场景'}</h3>
    <p class="modal-sub">场次 ${index + 1} / ${scenes.length + (isNew ? 1 : 0)} · 《${esc(ch.title)}》</p>
    <label class="field-label">视角（POV）<input class="input" id="scPov" value="${esc(sc.pov || '')}" placeholder="例：林昭" /></label>
    <label class="field-label">地点<input class="input" id="scLocation" value="${esc(sc.location || '')}" placeholder="例：宗门后山·竹林" /></label>
    <label class="field-label">时间<input class="input" id="scTime" value="${esc(sc.time || '')}" placeholder="例：深夜·雨未停" /></label>
    <label class="field-label">出场人物<input class="input" id="scCharacters" value="${esc(sc.characters || '')}" placeholder="例：林昭、沈鹤" /></label>
    <label class="field-label">梗概<textarea class="textarea" id="scSummary" rows="3" placeholder="这一场要发生什么">${esc(sc.summary || '')}</textarea></label>
    <label class="field-label">场末钩子<textarea class="textarea" id="scHook" rows="2" placeholder="留给下一场的悬念">${esc(sc.hook || '')}</textarea></label>
    <label class="field-label">目标字数<input class="input" id="scTargetWords" type="number" value="${sc.targetWords || ''}" min="0" step="100" placeholder="留空不设目标" /></label>
    <div class="modal-foot">
      <button class="btn btn-text" id="scCancel">取消</button>
      <button class="btn btn-primary" id="scSave">保存</button>
    </div>`, (box) => {
    box.querySelector('#scCancel').onclick = closeModal;
    box.querySelector('#scSave').onclick = () => {
      const updated = {
        pov: box.querySelector('#scPov').value.trim(),
        location: box.querySelector('#scLocation').value.trim(),
        time: box.querySelector('#scTime').value.trim(),
        characters: box.querySelector('#scCharacters').value.trim(),
        summary: box.querySelector('#scSummary').value.trim(),
        hook: box.querySelector('#scHook').value.trim(),
        targetWords: Number(box.querySelector('#scTargetWords').value) || 0,
      };
      scenes[index] = updated;
      markChapterDirty(ch);
      closeModal();
      renderCorkboard();
      toast(isNew ? '场景已新增' : '场景已更新', 'ok');
    };
  });
}

function deleteScene(ch, index) {
  if (!confirm('删除这个场景？')) return;
  const scenes = getScenes(ch);
  scenes.splice(index, 1);
  markChapterDirty(ch);
  renderCorkboard();
  toast('场景已删除', 'ok');
}

function duplicateScene(ch, index) {
  const scenes = getScenes(ch);
  const sc = scenes[index];
  if (!sc) return;
  const copy = { ...sc, pov: sc.pov ? sc.pov + ' (复制)' : '复制', targetWords: 0 };
  scenes.splice(index + 1, 0, copy);
  markChapterDirty(ch);
  renderCorkboard();
  toast('场景已复制', 'ok');
}

function moveScene(ch, from, to) {
  const scenes = getScenes(ch);
  const [moved] = scenes.splice(from, 1);
  scenes.splice(to, 0, moved);
  markChapterDirty(ch);
  renderCorkboard();
}

/** 为单个场景生成正文 */
async function generateSceneProse(ch, sceneIndex) {
  const scenes = getScenes(ch);
  const sc = scenes[sceneIndex];
  if (!sc) return toast('场景不存在', 'err');

  const targetWords = sc.targetWords || 1500;
  const instruction = `请根据以下场景设定，写出这段正文。要求：
- 视角（POV）：${sc.pov || '不限'}
- 地点：${sc.location || '不限'}
- 时间：${sc.time || '不限'}
- 出场人物：${sc.characters || '不限'}
- 梗概：${sc.summary || '按大纲推进'}
- 场末钩子：${sc.hook || '自行设计'}
- 目标字数：约 ${targetWords} 字
- 风格：${S.novel?.meta?.tone || '网文风格，节奏紧凑，心理描写细腻'}
- 只输出正文，不要包含场景标题或标记。`;

  await runStream({
    task: 'chapter',
    novelId: S.novel.id,
    chapterId: ch.id,
    model: $('#genModel').value.trim() || undefined,
    payload: {
      templateKey: 'generateSceneProse',
      instruction,
      targetWords,
      extraQuery: instruction,
      scene: {
        pov: sc.pov || '',
        location: sc.location || '',
        time: sc.time || '',
        characters: sc.characters || '',
        summary: sc.summary || '',
        hook: sc.hook || '',
        tone: S.novel?.meta?.tone || '',
      },
    },
  });

  // 生成完成后，提示用户插入
  if (S.out) {
    // 暂存生成的内容，让用户决定怎么用
    const insertPos = $('#chContent').selectionStart ?? $('#chContent').value.length;
    insertIntoContent(`\n\n=== 场次 ${sceneIndex + 1} ${sc.pov ? `· ${sc.pov}` : ''} ===\n\n${S.out}`, 'insert');
    toast(`场次 ${sceneIndex + 1} 正文已生成并插入光标处`, 'ok');
    S.out = '';
    S.reasoning = '';
    renderOut();
  }
}

function scenesFromOutline(ch) {
  const { outline } = effectiveChapterOutline(ch);
  if (!outline || (!outline.scene && !outline.summary && !outline.hook)) {
    return toast('本章还没有章纲，无法生成场景', 'err');
  }
  const scenes = getScenes(ch);
  // 简单拆解：按章纲字段生成 3-5 个场景卡片
  const newScenes = [];
  if (outline.scene) {
    const parts = outline.scene.split(/[；;]/).map((s) => s.trim()).filter(Boolean);
    parts.forEach((part, i) => {
      newScenes.push({
        pov: '',
        location: part,
        time: '',
        characters: outline.characters || '',
        summary: outline.summary || '',
        hook: i === parts.length - 1 ? outline.hook : '',
        targetWords: 0,
      });
    });
  } else {
    newScenes.push({
      pov: '',
      location: outline.scene || '',
      time: '',
      characters: outline.characters || '',
      summary: outline.summary || '',
      hook: outline.hook || '',
      targetWords: 0,
    });
  }
  // 合并：保留已有，新增追加
  scenes.push(...newScenes);
  markChapterDirty(ch);
  renderCorkboard();
  toast(`已从章纲生成 ${newScenes.length} 个场景卡片`, 'ok');
}

$('#scenesFromOutline').addEventListener('click', () => {
  const ch = currentChapter();
  if (ch) scenesFromOutline(ch);
});
$('#addSceneBtn').addEventListener('click', () => {
  const ch = currentChapter();
  if (ch) openSceneEditor(ch, getScenes(ch).length);
});
$('#scenesClear').addEventListener('click', () => {
  const ch = currentChapter();
  if (!ch) return;
  if (!confirm('清空所有场景卡片？')) return;
  ch.scenes = [];
  markChapterDirty(ch);
  renderCorkboard();
  toast('场景已清空', 'ok');
});

/** 导出场景卡片（JSON） */
$('#scenesExportBtn').addEventListener('click', () => {
  const ch = currentChapter();
  if (!ch) return toast('先选择一章', 'err');
  const scenes = getScenes(ch);
  if (!scenes.length) return toast('没有场景可导出', 'err');
  const blob = new Blob([JSON.stringify({ version: 1, title: ch.title, exportedAt: Date.now(), scenes }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${ch.title || 'chapter'}_scenes_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('场景已导出', 'ok');
});

/** 导入场景卡片（JSON） */
$('#scenesImportBtn').addEventListener('click', () => {
  const ch = currentChapter();
  if (!ch) return toast('先选择一章', 'err');
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data.scenes || !Array.isArray(data.scenes)) throw new Error('不是有效的场景文件');
      const ch = currentChapter();
      if (!ch) return;
      ch.scenes = ch.scenes || [];
      // 合并：避免重复（按 pov+location+summary 去重）
      const existingKeys = new Set((ch.scenes || []).map(s => `${s.pov}|${s.location}|${s.summary}`));
      let added = 0;
      for (const sc of data.scenes) {
        const key = `${sc.pov || ''}|${sc.location || ''}|${sc.summary || ''}`;
        if (!existingKeys.has(key)) {
          ch.scenes.push(sc);
          existingKeys.add(key);
          added++;
        }
      }
      markChapterDirty(ch);
      renderCorkboard();
      toast(`导入完成，新增 ${added} 个场景`, 'ok');
    } catch (err) {
      toast('导入失败：' + err.message, 'err');
    }
  };
  input.click();
});

$('#compileScenesBtn').addEventListener('click', async () => {
  const ch = currentChapter();
  if (!ch) return;
  const scenes = getScenes(ch);
  if (!scenes.length) return toast('没有场景卡片可编译', 'err');
  if (!confirm('将按场景顺序把梗概拼接为章节正文。这会追加到现有正文之后（不会覆盖），继续？')) return;

  // 先备份当前正文
  await snapshotNow('编译场景前备份');

  // 组装内容：每个场景 = 场景标题 + 梗概 + 钩子
  const parts = scenes.map((sc, i) => {
    const title = `=== 场次 ${i + 1} ${sc.pov ? `· ${sc.pov}` : ''} ===`;
    const locTime = [sc.location, sc.time].filter(Boolean).join(' · ');
    const chars = sc.characters ? `【人物】${sc.characters}` : '';
    const summary = sc.summary || '';
    const hook = sc.hook ? `【钩子】${sc.hook}` : '';
    return [title, locTime, chars, summary, hook].filter(Boolean).join('\n');
  });
  const compiled = parts.join('\n\n---\n\n');

  // 追加到正文
  const ta = $('#chContent');
  const cur = ta.value.replace(/\s+$/, '');
  ta.value = (cur ? `${cur}\n\n---\n\n` : '') + compiled;
  ta.dispatchEvent(new Event('input'));
  markChapterDirty(ch);
  toast(`已编译 ${scenes.length} 个场景到正文`, 'ok');
});

/* ============================================================
 * 9. 设定库
 * ============================================================ */
let bibleTab = 'outline';
$$('#bibleTabs button').forEach((b) => b.addEventListener('click', () => {
  bibleTab = b.dataset.bible;
  $$('#bibleTabs button').forEach((x) => x.classList.toggle('on', x === b));
  // 切换设定库标签页时刷新最新数据，避免缓存过期
  if (S.novel) {
    api.get(`/api/novels/${S.novel.id}`).then(({ novel }) => {
      S.novel = novel;
      setView('bible');
      renderBible();
    }).catch(() => { setView('bible'); renderBible(); });  // 网络失败时用本地缓存兜底
  } else {
    setView('bible');
    renderBible();
  }
}));

/* ---- 设定库导出/导入 ---- */
function collectBibleData() {
  const n = S.novel;
  if (!n) return null;
  return {
    meta: n.meta || {},
    bible: n.bible || { characters: [], world: [], timeline: [] },
    outline: n.outline || { volumes: [], notes: '' },
    beats: n.beats || { items: [] },
    version: 1,
    exportedAt: Date.now(),
    sourceTitle: n.title,
    sourceId: n.id,
  };
}

function exportBibleAsJson() {
  const data = collectBibleData();
  if (!data) return toast('先打开一部作品', 'err');
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(S.novel.title || '设定库').replace(/[\\/:*?"<>|]/g, '_')}_设定库_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('设定库已导出为 JSON', 'ok');
}

function exportBibleAsMarkdown() {
  const data = collectBibleData();
  if (!data) return toast('先打开一部作品', 'err');
  let md = `# ${esc(data.sourceTitle || '设定库')} - 设定库导出\n\n`;
  md += `> 导出时间：${new Date(data.exportedAt).toLocaleString()}  \n`;
  md += `> 源作品 ID：${data.sourceId}  \n\n`;

  // 元数据
  if (data.meta && Object.keys(data.meta).length) {
    md += `## 元数据\n\n`;
    for (const [k, v] of Object.entries(data.meta)) {
      if (v !== undefined && v !== '' && v !== null) {
        md += `- **${k}**：${esc(String(v))}\n`;
      }
    }
    md += '\n';
  }

  // 人物
  if (data.bible?.characters?.length) {
    md += `## 人物\n\n`;
    for (const c of data.bible.characters) {
      md += `### ${esc(c.name || '未命名')}\n\n`;
      if (c.role) md += `- **角色**：${esc(c.role)}\n`;
      if (c.brief) md += `- **简介**：${esc(c.brief)}\n`;
      if (c.personality) md += `- **性格**：${esc(c.personality)}\n`;
      if (c.appearance) md += `- **外貌**：${esc(c.appearance)}\n`;
      if (c.speech) md += `- **口吻/话症**：${esc(c.speech)}\n`;
      if (c.relations?.length) md += `- **关系**：${c.relations.map(r => `${esc(r.target || '')}（${esc(r.type || '')}）`).join('；')}\n`;
      if (c.keywords?.length) md += `- **检索词**：${c.keywords.map(esc).join('、')}\n`;
      md += '\n';
    }
  }

  // 世界观
  if (data.bible?.world?.length) {
    md += `## 世界观\n\n`;
    for (const w of data.bible.world) {
      md += `### ${esc(w.name || '未命名')}\n\n`;
      if (w.type) md += `- **类型**：${esc(w.type)}\n`;
      if (w.desc) md += `- **描述**：${esc(w.desc)}\n`;
      md += '\n';
    }
  }

  // 时间线
  if (data.bible?.timeline?.length) {
    md += `## 时间线\n\n`;
    for (const t of data.bible.timeline) {
      const timeStr = t.time ? `${esc(t.time)}：` : '';
      md += `- ${timeStr}${esc(t.title || '')}`;
      if (t.desc) md += ` — ${esc(t.desc)}`;
      md += '\n';
    }
    md += '\n';
  }

  // 大纲
  if (data.outline?.volumes?.length) {
    md += `## 大纲\n\n`;
    if (data.outline.notes) {
      md += `> ${esc(data.outline.notes)}\n\n`;
    }
    for (const vol of data.outline.volumes) {
      md += `### ${esc(vol.name || '未命名卷')}\n\n`;
      if (vol.desc) md += `> ${esc(vol.desc)}\n\n`;
      for (const ch of vol.chapters || []) {
        md += `- **第 ${ch.title || '章'}**：${esc(ch.summary || '')}`;
        if (ch.scene) md += ` *场景：${esc(ch.scene)}*`;
        if (ch.characters) md += ` *人物：${esc(ch.characters)}*`;
        if (ch.hook) md += ` *钩子：${esc(ch.hook)}*`;
        md += '\n';
      }
      md += '\n';
    }
  }

  // 结构/节拍
  if (data.beats?.items?.length) {
    md += `## 结构/节拍 (Save the Cat)\n\n`;
    for (const b of data.beats.items) {
      const chRef = b.chapterId ? `（关联章节：${b.chapterId}）` : '';
      md += `- **${esc(b.name || '节拍')}** ${chRef}`;
      if (b.words) md += ` *目标字数：${b.words}*`;
      if (b.note) md += ` — ${esc(b.note)}`;
      md += '\n';
    }
    md += '\n';
  }

  // 人物弧光
  if (data.arcs?.items?.length) {
    md += `## 人物弧光\n\n`;
    for (const a of data.arcs.items) {
      md += `### ${esc(a.character || '未命名')}\n\n`;
      if (a.start) md += `- **起点**：${esc(a.start)}\n`;
      if (a.end) md += `- **终点**：${esc(a.end)}\n`;
      if (a.turningPoints?.length) {
        md += `- **关键转折**：\n`;
        for (const tp of a.turningPoints) {
          md += `  - ${esc(tp.chapter || '')}：${esc(tp.event || '')}\n`;
        }
      }
      md += '\n';
    }
  }

  // 关系
  if (data.relations?.length) {
    md += `## 关系图谱\n\n`;
    for (const r of data.relations) {
      md += `- ${esc(r.source || '')} → ${esc(r.target || '')}：${esc(r.type || '')}`;
      if (r.chapterId) md += ` *（出自章节 ${r.chapterId}）*`;
      if (r.evidence) md += ` *证据：${esc(r.evidence)}*`;
      md += '\n';
    }
    md += '\n';
  }

  // 线索
  if (data.threads?.items?.length) {
    md += `## 线索/伏笔\n\n`;
    for (const t of data.threads.items) {
      md += `- **${esc(t.title || '未命名')}**`;
      if (t.type) md += ` *${esc(t.type)}*`;
      if (t.chapters?.length) md += ` *（涉及章节：${t.chapters.join('、')})*`;
      if (t.status) md += ` *状态：${esc(t.status)}*`;
      if (t.note) md += ` — ${esc(t.note)}`;
      md += '\n';
    }
    md += '\n';
  }

  // 文风与规则
  if (data.style && (data.style.guide || data.style.banned || data.style.tone)) {
    md += `## 文风与规则\n\n`;
    if (data.style.guide) md += `**文风指南**：\n${esc(data.style.guide)}\n\n`;
    if (data.style.banned) md += `**禁用词/表达**：\n${esc(data.style.banned)}\n\n`;
    if (data.style.tone) md += `**基调**：\n${esc(data.style.tone)}\n\n`;
  }

  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(S.novel.title || '设定库').replace(/[\\/:*?"<>|]/g, '_')}_设定库_${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(url);
  toast('设定库已导出为 Markdown', 'ok');
}

function importBible(jsonText) {
  try {
    const data = JSON.parse(jsonText);
    if (!data || typeof data !== 'object') throw new Error('不是有效的 JSON');
    if (data.version !== 1) throw new Error('不支持的版本格式');
    return data;
  } catch (e) {
    throw new Error('JSON 解析失败：' + e.message);
  }
}

async function applyBibleData(data, opts = {}) {
  const n = S.novel;
  if (!n) return toast('先打开一部作品', 'err');

  const merge = opts.merge !== false; // 默认合并
  const overwrite = opts.overwrite === true;

  // 备份当前设定（用于撤销）
  const backup = {
    meta: { ...n.meta },
    bible: JSON.parse(JSON.stringify(n.bible || { characters: [], world: [], timeline: [] })),
    outline: JSON.parse(JSON.stringify(n.outline || { volumes: [], notes: '' })),
    beats: JSON.parse(JSON.stringify(n.beats || { items: [] })),
    arcs: JSON.parse(JSON.stringify(n.arcs || { items: [] })),
    relations: JSON.parse(JSON.stringify(n.relations || [])),
    threads: JSON.parse(JSON.stringify(n.threads || { items: [] })),
    style: JSON.parse(JSON.stringify(n.style || { guide: '', banned: '', tone: '' })),
  };

  // 应用数据
  if (data.meta) {
    if (overwrite) n.meta = { ...data.meta };
    else n.meta = { ...n.meta, ...data.meta };
  }
  if (data.bible) {
    if (overwrite) n.bible = { ...data.bible };
    else {
      n.bible.characters = merge ? mergeById(n.bible.characters || [], data.bible.characters || []) : (data.bible.characters || []);
      n.bible.world = merge ? mergeById(n.bible.world || [], data.bible.world || []) : (data.bible.world || []);
      n.bible.timeline = merge ? mergeById(n.bible.timeline || [], data.bible.timeline || []) : (data.bible.timeline || []);
    }
  }
  if (data.outline) {
    if (overwrite) n.outline = { ...data.outline };
    else n.outline = { ...n.outline, ...data.outline, volumes: data.outline.volumes || n.outline.volumes || [] };
  }
  if (data.beats) {
    if (overwrite) n.beats = { ...data.beats };
    else n.beats = { ...n.beats, ...data.beats, items: merge ? mergeById(n.beats?.items || [], data.beats.items || []) : (data.beats.items || []) };
  }
  // 保存
  await saveNovelPart({
    meta: n.meta,
    bible: n.bible,
    outline: n.outline,
    beats: n.beats,
  });

  renderBible();
  renderStudio();
  toast('设定库已导入' + (overwrite ? '（覆盖）' : '（合并）'), 'ok');

  return backup;
}

function mergeById(existing, incoming) {
  const map = new Map();
  for (const item of existing) {
    if (item.id) map.set(item.id, { ...item });
  }
  for (const item of incoming) {
    if (item.id && map.has(item.id)) {
      map.set(item.id, { ...map.get(item.id), ...item });
    } else {
      const id = item.id || uid('b');
      map.set(id, { ...item, id });
    }
  }
  return Array.from(map.values());
}

// 事件绑定
$('#bibleExportBtn')?.addEventListener('click', () => {
  showModal(`<h3>导出设定库</h3>
    <p class="modal-sub">选择导出格式。JSON 可完整还原导入；Markdown 适合阅读和人工编辑，但无法完整导入还原。</p>
    <div class="field-row" style="margin-top:12px">
      <button class="btn btn-primary" id="expJson">${ico('download')} 导出为 JSON（推荐）</button>
      <button class="btn btn-sm btn-text" id="expMd">${ico('file-text')} 导出为 Markdown</button>
    </div>
    <div class="modal-foot">
      <button class="btn btn-text" id="expCancel">取消</button>
    </div>`,
  (box) => {
    box.querySelector('#expJson').onclick = () => { closeModal(); exportBibleAsJson(); };
    box.querySelector('#expMd').onclick = () => { closeModal(); exportBibleAsMarkdown(); };
    box.querySelector('#expCancel').onclick = closeModal;
  });
});

$('#bibleImportBtn')?.addEventListener('click', () => {
  showModal(`<h3>导入设定库</h3>
    <p class="modal-sub">选择 JSON 文件导入。导入前会自动备份当前设定，导入后可在版本历史里撤回。</p>
    <div class="field-label">导入模式
      <select class="select" id="impMode" style="margin-top:5px">
        <option value="merge">合并（保留现有，新增/更新同 ID 项）</option>
        <option value="overwrite">覆盖（完全替换对应板块）</option>
      </select>
    </div>
    <div class="field-label" style="margin-top:10px">选择文件
      <input type="file" id="impFile" accept=".json" style="margin-top:5px" />
    </div>
    <div class="modal-foot">
      <button class="btn btn-primary" id="impOk">导入</button>
      <button class="btn btn-text" id="impCancel">取消</button>
    </div>`,
  (box) => {
    const fileInput = box.querySelector('#impFile');
    const modeSelect = box.querySelector('#impMode');
    box.querySelector('#impCancel').onclick = closeModal;
    box.querySelector('#impOk').onclick = async () => {
      const file = fileInput.files?.[0];
      if (!file) return toast('请选择文件', 'err');
      const text = await file.text();
      let data;
      try {
        data = importBible(text);
      } catch (e) {
        return toast(`导入失败：${e.message}`, 'err');
      }
      closeModal();
      await applyBibleData(data, { merge: modeSelect.value === 'merge', overwrite: modeSelect.value === 'overwrite' });
    };
  });
});

$('#bibleTrashBtn')?.addEventListener('click', openBibleTrash);

// ============================================================
// 片段导出/导入（大纲、场景、记忆、人物、世界观等单独导出）
// ============================================================

const FRAGMENT_TYPES = [
  { key: 'outline', label: '大纲与分卷', icon: 'layers', get: (n) => ({ outline: n.outline, meta: n.meta }), single: true },
  { key: 'scenes', label: '场景卡片', icon: 'columns', get: (n) => ({ scenes: n.chapters.flatMap((c, i) => (c.scenes || []).map(s => ({ ...s, chapterIndex: i, chapterId: c.id, chapterTitle: c.title }))) }), single: true },
  { key: 'memories', label: '章节记忆', icon: 'book-open', get: (n) => ({ memories: n.chapters.filter(c => c.memory).map(c => ({ chapterId: c.id, chapterTitle: c.title, chapterNo: c.no, memory: c.memory })) }), single: true },
  { key: 'characters', label: '人物卡', icon: 'user', get: (n) => n.bible?.characters || [], single: false },
  { key: 'world', label: '世界观', icon: 'globe', get: (n) => n.bible?.world || [], single: false },
  { key: 'timeline', label: '时间线', icon: 'clock', get: (n) => n.bible?.timeline || [], single: false },
  { key: 'beats', label: '结构/节拍', icon: 'pulse', get: (n) => n.beats?.items || [], single: false },
  // 人物弧光 / 关系图谱：界面上是「人物卡 + 章节记忆」现算的，真正能编辑、能复用的是人物卡里的字段
  { key: 'arcs', label: '人物弧光', icon: 'arrow-right', get: (n) => (n.bible?.characters || []).filter((c) => c.arc || c.goal || c.flaw).map((c) => ({ id: c.id, name: c.name, arc: c.arc || '', goal: c.goal || '', flaw: c.flaw || '' })), single: false },
  { key: 'relations', label: '关系图谱', icon: 'arrow-right', get: (n) => (n.bible?.characters || []).filter((c) => (c.relations || []).length).map((c) => ({ id: c.id, name: c.name, relations: c.relations || [] })), single: false },
  // 文风与规则：真正生效的是作品 meta 里的文风字段
  { key: 'style', label: '文风与规则', icon: 'pen', get: (n) => ({ styleNotes: n.meta?.styleNotes || '', antiAiNotes: n.meta?.antiAiNotes || '', taboos: n.meta?.taboos || '', extraRules: n.meta?.extraRules || '', styleRefs: n.meta?.styleRefs || [] }), single: true },
  { key: 'annotations', label: '批注/高亮', icon: 'highlighter', get: (n) => ({ annotations: n.chapters.flatMap(c => (c.annotations || []).map(a => ({ ...a, chapterId: c.id, chapterTitle: c.title }))) }), single: true },
];

function collectFragmentData(typeKey) {
  const n = S.novel;
  if (!n) return null;
  const type = FRAGMENT_TYPES.find(t => t.key === typeKey);
  if (!type) return null;
  const data = type.get(n);
  return {
    type: typeKey,
    label: type.label,
    icon: type.icon,
    single: type.single,
    data,
    version: 1,
    exportedAt: Date.now(),
    sourceTitle: n.title,
    sourceId: n.id,
  };
}

function exportFragmentAsJson(typeKey) {
  const pkg = collectFragmentData(typeKey);
  if (!pkg) return toast('先打开一部作品', 'err');
  const json = JSON.stringify(pkg, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const type = FRAGMENT_TYPES.find(t => t.key === typeKey);
  a.href = url;
  a.download = `${(S.novel.title || '片段').replace(/[\\/:*?"<>|]/g, '_')}_${type.label}_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`已导出 ${type.label} 为 JSON`, 'ok');
}

function exportFragmentAsMarkdown(typeKey) {
  const pkg = collectFragmentData(typeKey);
  if (!pkg) return toast('先打开一部作品', 'err');
  const type = FRAGMENT_TYPES.find(t => t.key === typeKey);
  let md = `# ${esc(pkg.sourceTitle)} - ${esc(type.label)}导出\n\n`;
  md += `> 导出时间：${new Date(pkg.exportedAt).toLocaleString()}  \n`;
  md += `> 源作品 ID：${pkg.sourceId}  \n\n`;

  const data = pkg.data;
  if (type.single) {
    md += jsonToMarkdown(data, 2);
  } else {
    if (Array.isArray(data) && data.length) {
      md += `## ${esc(type.label)}（共 ${data.length} 条）\n\n`;
      data.forEach((item, i) => {
        md += `### ${i + 1}. ${esc(item.name || item.title || item.id || `条目 ${i + 1}`)}\n\n`;
        md += jsonToMarkdown(item, 3);
        md += '\n';
      });
    } else {
      md += `> 暂无数据\n\n`;
    }
  }

  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(S.novel.title || '片段').replace(/[\\/:*?"<>|]/g, '_')}_${type.label}_${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`已导出 ${type.label} 为 Markdown`, 'ok');
}

function jsonToMarkdown(obj, level = 1) {
  if (!obj || typeof obj !== 'object') return '';
  const prefix = '#'.repeat(level);
  let md = '';
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => {
      md += `${prefix} ${i + 1}. ${esc(item.name || item.title || item.id || `项 ${i + 1}`)}\n\n`;
      md += jsonToMarkdown(item, level + 1);
      md += '\n';
    });
  } else {
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null || v === '') continue;
      if (typeof v === 'object') {
        md += `${prefix} ${esc(k)}\n\n`;
        md += jsonToMarkdown(v, level + 1);
        md += '\n';
      } else {
        md += `- **${esc(k)}**：${esc(String(v))}\n`;
      }
    }
  }
  return md;
}

function importFragment(jsonText) {
  try {
    const pkg = JSON.parse(jsonText);
    if (!pkg || typeof pkg !== 'object') throw new Error('不是有效的 JSON');
    if (pkg.version !== 1) throw new Error('不支持的版本格式');
    if (!FRAGMENT_TYPES.some(t => t.key === pkg.type)) throw new Error('未知的片段类型：' + pkg.type);
    return pkg;
  } catch (e) {
    throw new Error('JSON 解析失败：' + e.message);
  }
}

async function applyFragmentData(pkg, opts = {}) {
  const n = S.novel;
  if (!n) return toast('先打开一部作品', 'err');
  const type = FRAGMENT_TYPES.find(t => t.key === pkg.type);
  if (!type) return toast('未知的片段类型', 'err');

  const merge = opts.merge !== false;
  const overwrite = opts.overwrite === true;

  // 调用服务端 API 进行导入
  try {
    const response = await api.send(`/api/novels/${n.id}/import-fragment`, {
      ...pkg,
      merge,
      overwrite,
    });
    if (response.ok) {
      // 重新加载小说数据
      const { novel } = await api.get(`/api/novels/${n.id}`);
      S.novel = novel;
      renderBible();
      renderStudio();
      const label = FRAGMENT_TYPES.find(t => t.key === pkg.type).label;
      const mode = overwrite ? '（覆盖）' : '（合并）';
      if (response.skipped) {
        // 有条目没落上：必须说清楚，否则用户以为导入成功了
        toast(`${label} 已导入${mode}，但 ${response.skipped} 条找不到对应章节被跳过`, 'err');
      } else {
        toast(`已导入 ${label}${mode}`, 'ok');
      }
      return { backup: null, type: pkg.type, applied: response.applied, skipped: response.skipped };
    } else {
      throw new Error(response.error || '导入失败');
    }
  } catch (err) {
    toast(`导入失败：${err.message}`, 'err');
    throw err;
  }
}

// 片段导出/导入 UI 绑定
$('#bibleExportBtn')?.addEventListener('click', () => {
  showModal(`<h3>导出设定库 / 片段</h3>
    <p class="modal-sub">完整导出：包含所有板块。片段导出：单独导出某个板块（大纲、人物、场景等），适合跨项目复用或版本控制。</p>
    <div class="field-label" style="margin-top:8px"><strong>完整导出</strong></div>
    <div class="field-row" style="margin-top:8px">
      <button class="btn btn-primary" id="expJson">${ico('download')} 导出完整 JSON</button>
      <button class="btn btn-sm btn-text" id="expMd">${ico('file-text')} 导出完整 Markdown</button>
    </div>
    <div class="field-label" style="margin-top:16px"><strong>片段导出</strong></div>
    <div class="fragment-grid" id="fragExportGrid"></div>
    <div class="modal-foot">
      <button class="btn btn-text" id="expCancel">取消</button>
    </div>`,
  (box) => {
    const grid = box.querySelector('#fragExportGrid');
    grid.innerHTML = FRAGMENT_TYPES.map(t => `
      <div class="frag-card">
        <svg class="ico" style="margin-bottom:4px"><use href="#i-${t.icon}" /></svg>
        <div class="frag-label">${t.label}</div>
        <div class="frag-actions">
          <button class="btn btn-sm btn-text" data-type="${t.key}" data-fmt="json">${ico('download')} JSON</button>
          <button class="btn btn-sm btn-text" data-type="${t.key}" data-fmt="md">${ico('file-text')} MD</button>
        </div>
      </div>`).join('');
    grid.querySelectorAll('button[data-type]').forEach(btn => {
      btn.onclick = () => {
        closeModal();
        const fmt = btn.dataset.fmt;
        const type = btn.dataset.type;
        if (fmt === 'json') exportFragmentAsJson(type);
        else exportFragmentAsMarkdown(type);
      };
    });
    box.querySelector('#expJson').onclick = () => { closeModal(); exportBibleAsJson(); };
    box.querySelector('#expMd').onclick = () => { closeModal(); exportBibleAsMarkdown(); };
    box.querySelector('#expCancel').onclick = closeModal;
  });
});

$('#bibleImportBtn')?.addEventListener('click', () => {
  showModal(`<h3>导入设定库 / 片段</h3>
    <p class="modal-sub">选择 JSON 文件导入。完整导入会按板块合并/覆盖；片段导入仅影响对应板块。导入前会自动备份，可在版本历史里撤回。</p>
    <div class="field-label">导入模式
      <select class="select" id="impMode" style="margin-top:5px">
        <option value="merge">合并（保留现有，新增/更新同 ID 项）</option>
        <option value="overwrite">覆盖（完全替换对应板块）</option>
      </select>
    </div>
    <div class="field-label" style="margin-top:10px">选择文件
      <input type="file" id="impFile" accept=".json" style="margin-top:5px" />
    </div>
    <div class="modal-foot">
      <button class="btn btn-primary" id="impOk">导入</button>
      <button class="btn btn-text" id="impCancel">取消</button>
    </div>`,
  (box) => {
    const fileInput = box.querySelector('#impFile');
    const modeSelect = box.querySelector('#impMode');
    box.querySelector('#impCancel').onclick = closeModal;
    box.querySelector('#impOk').onclick = async () => {
      const file = fileInput.files?.[0];
      if (!file) return toast('请选择文件', 'err');
      const text = await file.text();
      let pkg;
      try {
        pkg = importFragment(text);
      } catch (e) {
        // 兼容旧版完整设定库格式
        try {
          const data = importBible(text);
          await applyBibleData(data, { merge: modeSelect.value === 'merge', overwrite: modeSelect.value === 'overwrite' });
        } catch (e2) {
          return toast(`导入失败：${e.message || e2.message}`, 'err');
        }
        closeModal();
        return;
      }
      closeModal();
      await applyFragmentData(pkg, { merge: modeSelect.value === 'merge', overwrite: modeSelect.value === 'overwrite' });
    };
  });
});

/* 设定库 / 作品字段的保存：防抖 700ms，但请求必须认准「这次是哪个作品」。
 * 以前在回调里才读 S.novel.id，切作品时会把旧作品的设定写进新作品。 */
let novelSaveTimer = 0;
let pendingNovelSave = null;
let novelSaveInFlight = null;

async function putNovelPart(novelId, part, msg) {
  setSave('saving');
  try {
    const { novel } = await api.put(`/api/novels/${novelId}`, part);
    if (S.novel?.id === novelId) {
      S.novel = novel;
      refreshSavePill();
    }
    if (msg) toast(msg, 'ok');
    loadNovels();
    return true;
  } catch (err) {
    if (S.novel?.id === novelId) setSave('dirty', '保存失败');
    toast(err.message, 'err');
    return false;
  }
}

function saveNovelPartNow() {
  clearTimeout(novelSaveTimer);
  novelSaveTimer = 0;
  const pending = pendingNovelSave;
  pendingNovelSave = null;
  if (!pending) return novelSaveInFlight || Promise.resolve(true);
  // 串行落盘：先等上一次 PUT 回来，避免旧请求晚到把新状态盖掉
  const start = () => putNovelPart(pending.id, pending.part, pending.msg);
  const run = novelSaveInFlight ? novelSaveInFlight.then(start, start) : start();
  novelSaveInFlight = run;
  run.finally(() => { if (novelSaveInFlight === run) novelSaveInFlight = null; });
  return run;
}

function saveNovelPart(part, msg) {
  if (!S.novel) return;
  const id = S.novel.id;
  // 防抖窗口里可能先后改了不同字段（标签 → 简介）。按字段合并，别让后一次把前一次覆盖掉；
  // 同一个字段再次修改时仍以最新值为准。
  if (pendingNovelSave?.id === id && part) {
    pendingNovelSave = {
      id,
      part: { ...pendingNovelSave.part, ...part },
      msg: msg || pendingNovelSave.msg,
    };
  } else {
    pendingNovelSave = { id, part, msg };
  }
  clearTimeout(novelSaveTimer);
  novelSaveTimer = setTimeout(saveNovelPartNow, 700);
}
saveNovelPart.flush = saveNovelPartNow;
saveNovelPart.cancel = () => {
  clearTimeout(novelSaveTimer);
  novelSaveTimer = 0;
  pendingNovelSave = null;
};

/* ---- 设定库最近删除（本机浏览器，最多 50 条） ---- */
const BIBLE_TRASH_KEY = 'shu.bibleTrash.v1';
const BIBLE_TRASH_KINDS = {
  characters: { label: '人物', icon: 'pen' },
  world: { label: '世界观', icon: 'layers' },
  timeline: { label: '时间线', icon: 'clock' },
};

function readBibleTrash() {
  try {
    const raw = localStorage.getItem(BIBLE_TRASH_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list)
      ? list.filter((x) => x && x.id && x.novelId && x.section && x.item).slice(0, BIBLE_TRASH_LIMIT)
      : [];
  } catch {
    return [];
  }
}

function writeBibleTrash(list) {
  try {
    if (!Array.isArray(list) || !list.length) localStorage.removeItem(BIBLE_TRASH_KEY);
    else localStorage.setItem(BIBLE_TRASH_KEY, JSON.stringify(list.slice(0, BIBLE_TRASH_LIMIT)));
  } catch {
    // 浏览器禁用存储时，8 秒撤销仍然可用；历史记录静默降级
  }
}

function addBibleTrash(record) {
  writeBibleTrash(addBibleTrashRecord(readBibleTrash(), record));
}

function dropBibleTrash(id) {
  if (!id) return;
  writeBibleTrash(readBibleTrash().filter((x) => x.id !== id));
}

function bibleTrashPreview(rec) {
  const item = rec?.item || {};
  const bits = [];
  if (rec?.section === 'characters') {
    if (item.role) bits.push(item.role);
    if (item.identity) bits.push(item.identity);
    if (item.desc) bits.push(item.desc);
  } else if (rec?.section === 'world') {
    if (item.category) bits.push(item.category);
    if (item.desc) bits.push(item.desc);
  } else {
    if (item.time) bits.push(item.time);
    if (item.desc) bits.push(item.desc);
  }
  return bits.filter(Boolean).join(' · ').slice(0, 90);
}

function openBibleTrash() {
  showModal(`<h3>最近删除</h3>
    <p class="modal-sub">设定库里删除的人物、世界观和时间线条目会留在这里，最多 ${BIBLE_TRASH_LIMIT} 条。记录只保存在本机浏览器；恢复时会打开原作品并放回原来的位置。</p>
    <input class="input" id="bibleTrashSearch" placeholder="搜索条目名、作品名或板块" style="margin-bottom:12px" />
    <div class="trash-list" id="bibleTrashList"></div>
    <div class="modal-foot">
      <button class="btn btn-text trash-clear" id="bibleTrashClear" disabled>清空记录</button>
      <button class="btn btn-text" id="bibleTrashClose">关闭</button>
    </div>`,
  (box) => {
    const listEl = box.querySelector('#bibleTrashList');
    const search = box.querySelector('#bibleTrashSearch');
    const clearBtn = box.querySelector('#bibleTrashClear');

    const render = () => {
      const all = readBibleTrash();
      clearBtn.disabled = !all.length;
      const rows = filterBibleTrash(all, search.value);
      if (!all.length) {
        listEl.innerHTML = `<div class="trash-empty">${ico('undo')}<b>还没有删除记录</b>删除人物、世界观或时间线条目后会留在这里，最多保留 ${BIBLE_TRASH_LIMIT} 条。</div>`;
        return;
      }
      if (!rows.length) {
        listEl.innerHTML = '<div class="find-empty">没有匹配的删除记录</div>';
        return;
      }
      listEl.innerHTML = rows.map((r) => {
        const kind = BIBLE_TRASH_KINDS[r.section] || { label: r.label || '设定', icon: 'layers' };
        const current = S.novel?.id === r.novelId;
        const preview = bibleTrashPreview(r);
        return `<div class="trash-item">
          <div class="trash-cover" style="--cover:${coverOf(r.name)}">${ico(kind.icon)}</div>
          <div class="trash-main">
            <b class="trash-title"><span class="bt-kind">${esc(kind.label)}</span>${esc(r.name || '未命名')}</b>
            <span class="trash-meta">《${esc(r.novelTitle || '未命名')}》${current ? ' · 当前作品' : ''} · 删除于 ${esc(fmtDate(r.deletedAt))}</span>
            ${preview ? `<span class="trash-meta">${esc(preview)}</span>` : ''}
          </div>
          <div class="trash-actions">
            <button class="btn btn-sm" data-restore="${esc(r.id)}">${ico('undo')}${current ? '恢复' : '打开并恢复'}</button>
            <button class="btn btn-sm btn-text" data-forget="${esc(r.id)}">移除记录</button>
          </div>
        </div>`;
      }).join('');
    };

    box.querySelector('#bibleTrashClose').onclick = closeModal;
    search.addEventListener('input', render);
    clearBtn.onclick = () => {
      if (!readBibleTrash().length) return;
      if (!confirm('清空最近删除记录？清空后无法再从历史恢复。')) return;
      writeBibleTrash([]);
      render();
      toast('已清空最近删除记录');
    };
    listEl.addEventListener('click', async (e) => {
      const restoreBtn = e.target.closest('[data-restore]');
      if (restoreBtn) {
        const rec = readBibleTrash().find((x) => x.id === restoreBtn.dataset.restore);
        if (!rec) return render();
        restoreBtn.disabled = true;
        const ok = await restoreBibleTrash(rec);
        if (ok) closeModal();
        else restoreBtn.disabled = false;
        return;
      }
      const forgetBtn = e.target.closest('[data-forget]');
      if (forgetBtn) {
        dropBibleTrash(forgetBtn.dataset.forget);
        render();
        toast('已从最近删除中移除');
      }
    });
    render();
    search.focus();
  });
}

async function restoreBibleTrash(rec) {
  try {
    if (!rec?.novelId || !rec?.item || !rec?.section) return false;
    if (S.novel?.id !== rec.novelId) {
      await openNovel(rec.novelId);
      if (S.novel?.id !== rec.novelId) return false;
    }
    const n = S.novel;
    const arr = n?.bible?.[rec.section];
    if (!Array.isArray(arr)) {
      toast('这个设定板块已经不存在了', 'err');
      return false;
    }
    const item = JSON.parse(JSON.stringify(rec.item));
    if (hasBibleTrashItem(arr, item)) {
      dropBibleTrash(rec.id);
      toast('条目已经存在，已从最近删除中移除');
      return true;
    }
    insertBibleTrashItem(arr, item, rec.nextId, rec.index);
    dropBibleTrash(rec.id);
    bibleTab = BIBLE_TRASH_KINDS[rec.section] ? rec.section : 'outline';
    $$('#bibleTabs button').forEach((x) => x.classList.toggle('on', x.dataset.bible === bibleTab));
    setView('bible');
    saveNovelPart({ bible: n.bible });
    toast(`已恢复${BIBLE_TRASH_KINDS[rec.section]?.label || '条目'}「${rec.name || '未命名'}」`, 'ok');
    return true;
  } catch (err) {
    toast(`恢复失败：${err.message || '未知错误'}`, 'err');
    return false;
  }
}

/* ---- 设定库删除撤销 ---- */
/** 删除人物 / 世界观 / 时间线条目，并在提示条里留一个 8 秒的撤销入口。
 *  撤销时优先按「原来排在它后面的条目」定位，连续删除多条也不会乱序。 */
function removeBibleEntry(section, index, label) {
  const n = S.novel;
  const arr = n?.bible?.[section];
  if (!Array.isArray(arr) || index < 0 || index >= arr.length) return;
  const item = arr[index];
  const nextId = arr[index + 1]?.id || null;
  const novelId = n.id;
  const name = item.name || item.title || '未命名';
  const kind = BIBLE_TRASH_KINDS[section] || { label };
  const trashId = uid('bd');
  addBibleTrash({
    id: trashId,
    novelId,
    novelTitle: n.title || '未命名',
    section,
    label: kind.label,
    name,
    item: JSON.parse(JSON.stringify(item)),
    index,
    nextId,
    deletedAt: Date.now(),
  });
  arr.splice(index, 1);
  renderBible();
  saveNovelPart({ bible: n.bible });
  toast(`已删除${label}「${name}」`, '', {
    label: '撤销',
    onClick: () => {
      if (S.novel?.id !== novelId) return toast('已切换作品，无法撤销这次删除', 'err');
      const cur = S.novel?.bible?.[section];
      if (!Array.isArray(cur)) return;
      if (hasBibleTrashItem(cur, item)) {
        dropBibleTrash(trashId);
        return toast('条目已经恢复过了');
      }
      let at = nextId ? cur.findIndex((x) => x.id === nextId) : -1;
      if (at < 0) at = Math.min(index, cur.length);
      cur.splice(at, 0, item);
      dropBibleTrash(trashId);
      renderBible();
      saveNovelPart({ bible: S.novel.bible });
      toast(`已恢复${label}「${name}」`, 'ok');
    },
  });
}

const SKIP_KEYS = new Set(['kwText', 'relText', 'notes']);

function field(label, key, obj, opts = {}) {
  const val = esc(obj[key] ?? '');
  return `<label class="field-label">${label}${opts.area
    ? `<textarea class="input" data-key="${key}" rows="${opts.rows || 2}">${val}</textarea>`
    : `<input class="input" data-key="${key}" value="${val}" placeholder="${esc(opts.ph || '')}" />`}</label>`;
}

/** 作品本身的字段（书名 / 作者 / 类型）不在 meta 里，用 data-novel 单独绑，别被 bindFields 写进 meta */
function novelField(label, key, obj, opts = {}) {
  const val = esc(obj[key] ?? '');
  return `<label class="field-label">${label}<input class="input" data-novel="${key}" value="${val}" placeholder="${esc(opts.ph || '')}" /></label>`;
}

function bindFields(root, obj, after, numericKeys = []) {
  $$('[data-key]', root).forEach((el) => el.addEventListener('input', () => {
    const k = el.dataset.key;
    if (SKIP_KEYS.has(k)) return;
    obj[k] = numericKeys.includes(k) ? Number(el.value) || 0 : el.value;
    after?.();
  }));
}

/* ---- 设定库搜索 ---- */
function bibleSearchValue(tab) {
  return S.bibleSearch?.[tab] || '';
}

function bibleSearchBar(tab, placeholder) {
  const q = bibleSearchValue(tab);
  return `<div class="bible-search">
    <input class="input" data-bible-search="${tab}" value="${esc(q)}" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" />
    <span class="bible-search-count dim small" data-bible-search-count="${tab}"></span>
    <button type="button" class="btn btn-sm btn-text" data-bible-search-clear="${tab}"${q ? '' : ' hidden'}>清除</button>
  </div>`;
}

function bindBibleSearch(host, tab, onChange) {
  const input = $(`[data-bible-search="${tab}"]`, host);
  if (!input) return;
  const clear = $(`[data-bible-search-clear="${tab}"]`, host);
  const update = () => {
    S.bibleSearch[tab] = input.value;
    if (clear) clear.hidden = !input.value;
    onChange();
  };
  input.addEventListener('input', update);
  clear?.addEventListener('click', () => {
    input.value = '';
    update();
    input.focus();
  });
}

function setBibleSearchCount(host, tab, shown, total) {
  const el = $(`[data-bible-search-count="${tab}"]`, host);
  if (!el) return;
  el.textContent = bibleSearchValue(tab).trim() ? `${shown} / ${total}` : `共 ${total} 条`;
}

function bibleSearchText(values) {
  return values.flat(Infinity).map((v) => String(v ?? '')).join('\n');
}

function searchKeywordList(value) {
  return Array.isArray(value) ? value : (typeof value === 'string' ? value.split(/[,，、\s]+/).filter(Boolean) : []);
}

function characterSearchText(c, opts = {}) {
  return bibleSearchText([
    c?.name, c?.role, c?.identity, c?.desc, c?.age, c?.appearance, c?.personality,
    c?.goal, c?.flaw, c?.secret, c?.speech, c?.arc,
    searchKeywordList(c?.keywords),
    opts.relations === false ? [] : (Array.isArray(c?.relations) ? c.relations.flatMap((r) => [r?.to, r?.type, r?.note]) : []),
  ]);
}

function worldSearchText(w) {
  return bibleSearchText([w?.name, w?.category, w?.desc, searchKeywordList(w?.keywords)]);
}

function timelineSearchText(t) {
  return bibleSearchText([t?.time, t?.title, t?.desc]);
}

function renderBible() {
  const host = $('#bibleBody');
  if (!S.novel) { host.innerHTML = '<p class="dim">先打开一部作品。</p>'; return; }
  const n = S.novel;
  if (bibleTab === 'outline') return renderOutlineTab(host, n);
  if (bibleTab === 'characters') return renderCharactersTab(host, n);
  if (bibleTab === 'world') return renderWorldTab(host, n);
  if (bibleTab === 'timeline') return renderTimelineTab(host, n);
  if (bibleTab === 'timelineViz') return renderTimelineVizTab(host, n);
  if (bibleTab === 'beats') return renderBeatsTab(host, n);
  if (bibleTab === 'arcs') return renderArcsTab(host, n);
  if (bibleTab === 'relations') return renderRelationsTab(host, n);
  if (bibleTab === 'threads') return renderThreadsTab(host, n);
  return renderStyleTab(host, n);
}

/* ---- 大纲 ---- */
function renderOutlineTab(host, n) {
  host.innerHTML = `
    <div class="bible-block outline-basics">
      <h2>全书总纲
        <span style="flex:1"></span>
        <button class="btn btn-sm" id="aiOutline">AI 生成大纲</button>
        <button class="btn btn-sm" id="aiFullOutline">从一句话生成全书大纲</button>
      </h2>
      <div class="grid2">
        ${novelField('书名', 'title', n)}
        ${novelField('作者', 'author', n, { ph: '印在稿件头部' })}
      </div>
      <div class="grid2">
        ${novelField('类型', 'genre', n, { ph: '仙侠 / 都市 / 悬疑' })}
        ${field('目标平台 / 调性', 'platform', n.meta)}
      </div>
      <label class="field-label">标签<span class="field-hint">空格或逗号分隔 · 书架可直接搜 · 最多 ${NOVEL_TAG_LIMIT} 个</span>
        <input class="input" id="novelTags" value="${esc(parseNovelTags(n.tags).join('，'))}" placeholder="无限流 群像 复仇" autocomplete="off" />
      </label>
      ${field('一句话故事', 'logline', n.meta, { ph: '一个少年背着一把不能出鞘的剑，去杀他师傅。' })}
      <div class="grid2">
        ${field('作者联系方式', 'contact', n.meta, { ph: '邮箱 / QQ / 微信' })}
        <div class="dim small" style="align-self:end">投稿时编辑要联系你。导出 TXT / Markdown / EPUB 时，这行会印在稿件头部。</div>
      </div>
      ${field('故事梗概', 'synopsis', n.meta, { area: true, rows: 4 })}
      ${field('投稿附言（创作说明）', 'submissionNote', n.meta, { area: true, rows: 4 })}
      <div class="dim small" style="margin-top:-8px">投稿时给编辑的话：这本书的卖点、目标读者、更新计划。导出时勾上「创作说明」，这段会连篇幅、进度一起放在稿件最前面。不填就不出现。</div>
      ${field('大纲备注（主线、支线、伏笔规划）', 'notes', n.outline, { area: true, rows: 3 })}
      <div class="row gap6">
        <button class="btn btn-sm" id="addVol">${ico('plus')}新增卷</button>
        <button class="btn btn-sm" id="genChapters">按大纲生成章节列表</button>
        <span class="dim small" id="outlineMsg"></span>
      </div>
    </div>
    <div class="bible-block outline-volumes">
      <h2>分卷与章纲</h2>
      ${bibleSearchBar('outline', '搜索章纲：卷名 / 章节名 / 场景 / 事件 / 人物 / 钩子')}
      <div id="volList"></div>
    </div>`;

  bindFields(host, n.meta, () => saveNovelPart({ meta: n.meta }), []);
  // 书名 / 作者 / 类型 / 标签 是作品本身的字段（不在 meta 里）：改完顺手刷新顶栏
  $$('[data-novel]', host).forEach((el) => el.addEventListener('input', () => {
    const key = el.dataset.novel;
    n[key] = el.value;
    if (key === 'title') renderTopbarActions();
    // 这些字段一起发：saveNovelPart 是防抖的，连着改两处时后一次会把前一次吞掉
    saveNovelPart({ title: n.title, author: n.author, genre: n.genre, tags: parseNovelTags(n.tags) });
  }));
  const tagsInput = host.querySelector('#novelTags');
  tagsInput.addEventListener('input', () => {
    n.tags = parseNovelTags(tagsInput.value);
    saveNovelPart({ title: n.title, author: n.author, genre: n.genre, tags: n.tags });
  });
  // 失焦时把输入框整理成统一写法：去掉多余分隔符、重复项，只留前 20 个
  tagsInput.addEventListener('blur', () => {
    n.tags = parseNovelTags(n.tags);
    tagsInput.value = n.tags.join('，');
  });
  host.querySelector('[data-key="notes"]').addEventListener('input', () => saveNovelPart({ outline: n.outline }));

  const vl = $('#volList', host);

  const renderVolumes = () => {
    const query = bibleSearchValue('outline');
    const active = !!query.trim();
    const totalChapters = n.outline.volumes.reduce((sum, v) => sum + (Array.isArray(v.chapters) ? v.chapters.length : 0), 0);
    const visible = filterOutlineVolumes(n.outline.volumes, query);
    const shownChapters = visible.reduce((sum, row) => sum + row.chapters.length, 0);
    const countEl = $('[data-bible-search-count="outline"]', host);
    if (countEl) {
      countEl.textContent = active
        ? `命中 ${shownChapters} / ${totalChapters} 条章纲`
        : `共 ${totalChapters} 条章纲`;
    }
    const addVolBtn = $('#addVol', host);
    if (addVolBtn) {
      addVolBtn.disabled = active;
      addVolBtn.title = active ? '清除搜索后可新增卷' : '';
    }

    vl.innerHTML = '';
    if (!n.outline.volumes.length) {
      vl.innerHTML = '<p class="dim">还没有分卷。可以点「AI 生成大纲」，或手动加一卷。</p>';
      return;
    }
    if (!visible.length) {
      vl.innerHTML = `<p class="dim">没有匹配「${esc(query.trim())}」的章纲。</p>`;
      return;
    }

    visible.forEach(({ volume: v, volumeIndex: vi, chapters: chapterRows }) => {
      const block = document.createElement('div');
      block.className = 'vol-block';
      block.dataset.volId = v.id || '';
      block.dataset.volIndex = String(vi);
      block.innerHTML = `
        <div class="vol-head">
          <span class="dim small">第 ${vi + 1} 卷</span>
          <input class="input" data-vk="name" value="${esc(v.name || '')}" placeholder="卷名" style="max-width:220px" />
          <input class="input" data-vk="desc" value="${esc(v.desc || '')}" placeholder="本卷定位与主要冲突" />
          <button class="btn btn-sm btn-text" data-act="up" title="${active ? '清除搜索后可调整分卷' : '上移这一卷'}" ${active || vi === 0 ? 'disabled' : ''}>${ico('chev-up')}</button>
          <button class="btn btn-sm btn-text" data-act="down" title="${active ? '清除搜索后可调整分卷' : '下移这一卷'}" ${active || vi === n.outline.volumes.length - 1 ? 'disabled' : ''}>${ico('chev-down')}</button>
          <button class="btn btn-sm btn-text" data-act="add" title="${active ? '清除搜索后可新增章纲' : '加一条章纲'}" ${active ? 'disabled' : ''}>${ico('plus')}</button>
          <button class="btn btn-sm btn-text" data-act="del" title="${active ? '清除搜索后可删除本卷' : '删除本卷'}" ${active ? 'disabled' : ''}>${ico('trash')}</button>
        </div>
        <div class="vol-chapters"></div>`;
      block.querySelectorAll('[data-vk]').forEach((el) => el.addEventListener('input', () => {
        v[el.dataset.vk] = el.value;
        saveNovelPart({ outline: n.outline });
      }));
      const swap = (a, b) => {
        const t = n.outline.volumes[a];
        n.outline.volumes[a] = n.outline.volumes[b];
        n.outline.volumes[b] = t;
        renderBible();
        saveNovelPart({ outline: n.outline });
      };
      block.querySelector('[data-act="up"]').onclick = () => { if (vi > 0) swap(vi, vi - 1); };
      block.querySelector('[data-act="down"]').onclick = () => { if (vi < n.outline.volumes.length - 1) swap(vi, vi + 1); };
      block.querySelector('[data-act="del"]').onclick = () => {
        if (!confirm('删除本卷及其全部章纲？')) return;
        const vid = v.id;
        n.outline.volumes.splice(vi, 1);
        renderBible();
        saveNovelPart({ outline: n.outline });
        // 章节列表里原本归这一卷的，改回未分卷（别留下指向已删卷的僵尸标记）
        if (vid) unassignVolume(vid, '').then(renderStudio);
      };
      block.querySelector('[data-act="add"]').onclick = () => {
        v.chapters = v.chapters || [];
        v.chapters.push({ id: uid('o'), title: '', scene: '', characters: '', summary: '', hook: '' });
        renderBible();
        saveNovelPart({ outline: n.outline });
      };

      const cl = block.querySelector('.vol-chapters');
      chapterRows.forEach(({ chapter: c, chapterIndex: ci }) => {
        const row = document.createElement('div');
        row.className = 'outline-row';
        row.dataset.outlineId = c.id || '';
        row.dataset.volIndex = String(vi);
        row.dataset.chapterIndex = String(ci);
        row.innerHTML = `
          <span class="dim small" title="双击左侧标签可删除这条章纲">第 ${ci + 1} 章</span>
          <input class="input" data-ck="title" value="${esc(c.title || '')}" placeholder="章节名" />
          <textarea class="input" data-ck="scene" placeholder="场景 / 地点">${esc(c.scene || '')}</textarea>
          <textarea class="input" data-ck="summary" placeholder="核心事件">${esc(c.summary || '')}</textarea>
          <div class="outline-extra">
            <input class="input" data-ck="characters" value="${esc(c.characters || '')}" placeholder="出场人物" />
            <input class="input" data-ck="hook" value="${esc(c.hook || '')}" placeholder="章末钩子" />
          </div>`;
        row.querySelectorAll('[data-ck]').forEach((el) => el.addEventListener('input', () => {
          c[el.dataset.ck] = el.value;
          saveNovelPart({ outline: n.outline });
        }));
        row.querySelector('span').addEventListener('dblclick', () => {
          if (!confirm('删除这条章纲？')) return;
          v.chapters.splice(ci, 1);
          renderBible();
          saveNovelPart({ outline: n.outline });
        });
        cl.appendChild(row);
      });
      vl.appendChild(block);
    });
  };

  bindBibleSearch(host, 'outline', renderVolumes);
  renderVolumes();

  $('#addVol', host).onclick = () => {
    n.outline.volumes.push({ name: `${n.outline.volumes.length + 1}`, desc: '', chapters: [] });
    renderBible();
    saveNovelPart({ outline: n.outline });
  };

  $('#aiOutline', host).onclick = async () => {
    const text = await runStream({
      task: 'outline',
      novelId: n.id,
      payload: { instruction: `为《${n.title}》设计分卷大纲与接下来 12 章的细纲。` },
    });
    if (!text.trim()) return;
    showModal(`<h3>AI 大纲草案</h3>
      <div class="out" style="max-height:56vh">${mdLite(text)}</div>
      <div class="modal-foot">
        <button class="btn btn-text" id="olClose">关闭</button>
        <button class="btn" id="olCopy">复制</button>
        <button class="btn btn-primary" id="olApply">解析并写入大纲</button>
      </div>`, (box) => {
      box.querySelector('#olClose').onclick = closeModal;
      box.querySelector('#olCopy').onclick = () => { navigator.clipboard.writeText(text); toast('已复制', 'ok'); };
      box.querySelector('#olApply').onclick = () => {
        const parsed = parseOutlineMarkdown(text);
        if (!parsed.length) return toast('没解析出结构，可复制后手动粘贴进章纲', 'err');
        parsed.forEach((v, i) => {
          if (!v.name) v.name = `${n.outline.volumes.length + i + 1}`;
          n.outline.volumes.push(v);
        });
        closeModal();
        renderBible();
        saveNovelPart({ outline: n.outline }, `已写入 ${parsed.length} 卷`);
      };
    });
  };

  $('#aiFullOutline', host).onclick = async () => {
    const logline = (n.meta?.logline || '').trim();
    if (!logline) return toast('请先在「一句话故事」里填入核心设定', 'err');

    const text = await runStream({
      task: 'outline',
      novelId: n.id,
      payload: {
        templateKey: 'outline:aiFullOutline',
        instruction: `你是一位资深网文策划。根据核心设定「${logline}」，为这部小说设计完整的分卷大纲与前 3 卷的章纲。

要求：
1. 输出 3-5 个分卷，每卷有卷名、卷纲（200-400字，包含主要冲突、人物弧光、收束点）
2. 每卷给出 10-12 章的细纲，每章包含：章节名、场景、出场人物、核心事件、章末钩子
3. 结构要有张力：起承转合、伏笔呼应、中点反转、高潮迭起
4. 只输出结构化 Markdown，格式如下：

## 第1卷 卷名
> 卷纲描述…

### 第1章 章节名
场景：…
出场人物：…
核心事件：…
章末钩子：…

### 第2章 章节名
...

## 第2卷 卷名
> 卷纲描述…

### 第1章 章节名
...`,
      },
    });

    if (!text.trim()) return;
    showModal(`<h3>全书大纲草案（基于：「${esc(logline)}」）</h3>
      <div class="out" style="max-height:60vh">${mdLite(text)}</div>
      <div class="modal-foot">
        <button class="btn btn-text" id="folClose">关闭</button>
        <button class="btn" id="folCopy">复制</button>
        <button class="btn btn-primary" id="folApply">解析并写入大纲（覆盖现有）</button>
      </div>`, (box) => {
      box.querySelector('#folClose').onclick = closeModal;
      box.querySelector('#folCopy').onclick = () => { navigator.clipboard.writeText(text); toast('已复制', 'ok'); };
      box.querySelector('#folApply').onclick = () => {
        const parsed = parseOutlineMarkdown(text);
        if (!parsed.length) return toast('没解析出结构，可复制后手动粘贴', 'err');
        n.outline.volumes = parsed;
        closeModal();
        renderBible();
        saveNovelPart({ outline: n.outline }, `已写入 ${parsed.length} 卷，共 ${parsed.reduce((s,v)=>s+(v.chapters?.length||0),0)} 章`);
      };
    });
  };

  $('#genChapters', host).onclick = async () => {
    const flat = [];
    n.outline.volumes.forEach((v) => (v.chapters || []).forEach((c) => flat.push(c)));
    if (!flat.length) return toast('大纲里还没有章纲', 'err');
    const existing = new Set(n.chapters.map((c) => c.outlineId).filter(Boolean));
    const todo = flat.filter((c) => !existing.has(c.id));
    if (!todo.length) return toast('章节列表已经和大纲一致了');
    if (!confirm(`将按大纲新增 ${todo.length} 章（不覆盖已有章节）。继续？`)) return;
    for (const c of todo) {
      const r = await api.send(`/api/novels/${n.id}/chapters`, {
        title: c.title || '未命名',
        summary: c.summary || '',
        outline: { scene: c.scene, characters: c.characters, summary: c.summary, hook: c.hook },
      });
      const target = r.novel.chapters.find((x) => x.id === r.chapter.id);
      if (target) target.outlineId = c.id;
      await api.put(`/api/novels/${n.id}`, { chapters: r.novel.chapters });
    }
    await openNovel(n.id);
    toast(`已新增 ${todo.length} 章`, 'ok');
  };
}

function parseOutlineMarkdown(text) {
  const lines = String(text).split('\n');
  const vols = [];
  let vol = null, chap = null;
  for (const raw of lines) {
    const line = raw.trim().replace(/^[-*]\s*/, '');
    const v = line.match(/^#{0,4}\s*第\s*([0-9一二三四五六七八九十百千两]+)\s*卷[：:、\s]*(.*)$/);
    const c = line.match(/^#{0,4}\s*第\s*([0-9一二三四五六七八九十百千两]+)\s*章[：:、\s]*(.*)$/);
    if (v) {
      if (vol) vols.push(vol);
      vol = { name: v[2] || v[1], desc: '', chapters: [] };
      chap = null;
      continue;
    }
    if (c) {
      if (!vol) vol = { name: '1', desc: '', chapters: [] };
      chap = { id: uid('o'), title: c[2] || `第${c[1]}章`, scene: '', characters: '', summary: '', hook: '' };
      vol.chapters.push(chap);
      continue;
    }
    if (!line) continue;
    if (line.startsWith('>') && vol && !chap) { vol.desc = line.replace(/^>\s*/, ''); continue; }
    const kv = line.match(/^[-*]?\s*(场景|出场人物|出场|人物|核心事件|事件|剧情|章末钩子|钩子|概要|摘要)\s*[：:]\s*(.*)$/);
    if (kv && chap) {
      const k = /场/.test(kv[1]) ? 'scene' : /人/.test(kv[1]) ? 'characters' : /钩/.test(kv[1]) ? 'hook' : 'summary';
      chap[k] = chap[k] ? `${chap[k]}；${kv[2]}` : kv[2];
      continue;
    }
    if (vol && !chap) vol.desc = vol.desc ? `${vol.desc} ${line}` : line;
  }
  if (vol) vols.push(vol);
  return vols.filter((x) => x.chapters.length || x.name);
}

/* ---- 人物出场 / 状态索引 ---- */
/** 章节记忆里的 characters 可能是数组、字符串，也可能被模型写成「张三、李四」。
 *  状态变化按人物姓名与关键词归并，和世界观条目共用同一套匹配。 */
function characterIndexHtml(c, i, charIndex, mentionIndex, stateCache) {
  const appearances = appearancesForCharacter(c, charIndex);
  const keys = worldMentionKeys(c);
  const cacheKey = keys.join('\u0000');
  let states = cacheKey ? stateCache?.get(cacheKey) : [];
  if (cacheKey && !states) {
    states = entryStateChanges(c, mentionIndex);
    stateCache?.set(cacheKey, states);
  }
  states = states || [];
  const latest = states[states.length - 1];
  const stateChip = states.length
    ? `<button type="button" class="ca-chip ca-state" data-state-more="${i}" title="最近：第 ${latest.no} 章 · ${esc(latest.text)}">状态 ${states.length}</button>`
    : '';
  if (!appearances.length) {
    if (!states.length) return '';
    return `<div class="char-appear">
      <span class="ca-label">状态</span>
      <div class="ca-chips">${stateChip}</div>
      <span class="ca-count">最近：第 ${latest.no} 章</span>
    </div>`;
  }
  const shown = appearances.slice(0, 8);
  return `<div class="char-appear">
    <span class="ca-label">出场</span>
    <div class="ca-chips">
      ${shown.map((ch) => `<button type="button" class="ca-chip" data-chapter="${esc(ch.id)}" title="第 ${ch.no} 章 · ${esc(ch.title || '未命名')}">第 ${ch.no} 章</button>`).join('')}
      ${appearances.length > shown.length ? `<button type="button" class="ca-chip ca-more" data-appear-more="${i}" title="查看全部 ${appearances.length} 章">+${appearances.length - shown.length}</button>` : ''}
      ${stateChip}
    </div>
    <span class="ca-count">${appearances.length} 章</span>
  </div>`;
}

function openChapterFromIndex(id) {
  const ch = S.novel?.chapters.find((c) => c.id === id);
  if (!ch) return toast('这一章已经不存在了', 'err');
  S.stageFilter = '';                 // 从索引跳转时先看全貌，别让当前筛选 / 搜索把目标章藏起来
  S.chapterSearch = '';
  setView('studio');
  selectChapter(ch.id);
  requestAnimationFrame(() => {
    const row = chapterRow(ch.id);
    if (row) { row.scrollIntoView({ block: 'nearest' }); row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1200); }
  });
}

function openChapterIndexModal(title, sub, chapters) {
  showModal(`<h3>${esc(title)}</h3>
    <p class="modal-sub">${esc(sub)}</p>
    <div class="appear-list">
      ${chapters.map((ch) => `<button type="button" class="appear-row" data-chapter="${esc(ch.id)}">
        <span class="ar-no">第 ${ch.no} 章</span>
        <span class="ar-title">${esc(ch.title || '未命名')}</span>
        <span class="ar-meta">${STAGE_LABEL[stageOf(ch)] || '草稿'}</span>
      </button>`).join('')}
    </div>
    <div class="modal-foot"><button class="btn btn-text" id="appearClose">关闭</button></div>`,
    (box) => {
      box.querySelector('#appearClose').onclick = closeModal;
      box.querySelectorAll('[data-chapter]').forEach((el) => {
        el.onclick = () => { closeModal(); openChapterFromIndex(el.dataset.chapter); };
      });
    });
}

function openCharacterAppearancesModal(name, chapters) {
  openChapterIndexModal(
    `「${name || '未命名'}」出场索引`,
    `依据章节记忆统计，共 ${chapters.length} 章。点击章节可直接打开。`,
    chapters,
  );
}

function openWorldMentionsModal(entry, chapters) {
  const name = entry?.name || '未命名';
  openChapterIndexModal(
    `「${name}」提及索引`,
    `在正文或章节记忆里提到这个名字 / 关键词的章节，共 ${chapters.length} 章。点击章节可直接打开。`,
    chapters,
  );
}

function openEntryStatesModal(entry, states) {
  const name = entry?.name || '未命名';
  showModal(`<h3>「${esc(name)}」状态变化</h3>
    <p class="modal-sub">章节记忆里记录的状态变化，共 ${states.length} 条。点击可直接打开对应章节。</p>
    <div class="state-list">
      ${states.map((s) => `<button type="button" class="state-row" data-chapter="${esc(s.id)}">
        <span class="sr-no">第 ${s.no} 章</span>
        <span class="sr-main">
          <span class="sr-title">${esc(s.title || '未命名')}</span>
          <span class="sr-text">${esc(s.text)}</span>
        </span>
        <span class="ar-meta">${STAGE_LABEL[s.stage] || '草稿'}</span>
      </button>`).join('')}
    </div>
    <div class="modal-foot"><button class="btn btn-text" id="stateClose">关闭</button></div>`,
    (box) => {
      box.querySelector('#stateClose').onclick = closeModal;
      box.querySelectorAll('[data-chapter]').forEach((el) => {
        el.onclick = () => { closeModal(); openChapterFromIndex(el.dataset.chapter); };
      });
    });
}

/* ---- 人物条目渲染（供虚拟列表复用） ---- */
function renderCharacterEntry(c, i, charIndex, n, mentionIndex, stateCache) {
  const div = document.createElement('div');
  div.className = 'entry';
  if (c.id) div.dataset.entryId = c.id;
  div.innerHTML = `
    <div class="entry-head">
      <input class="input" data-key="name" value="${esc(c.name || '')}" placeholder="姓名" style="max-width:180px;font-weight:600" />
      <input class="input" data-key="role" value="${esc(c.role || '')}" placeholder="主角 / 配角 / 反派" style="max-width:150px" />
      <span style="flex:1"></span>
      <button class="del" title="删除">${ico('trash')}</button>
    </div>
    <div class="fields">
      ${field('身份', 'identity', c)}
      ${field('年龄', 'age', c)}
      ${field('外貌', 'appearance', c)}
      ${field('性格', 'personality', c)}
      ${field('核心目标', 'goal', c)}
      ${field('性格缺陷', 'flaw', c)}
      ${field('隐藏秘密', 'secret', c)}
      ${field('说话风格', 'speech', c)}
      ${field('成长弧线', 'arc', c)}
      ${field('检索关键词（逗号分隔）', 'kwText', { kwText: (c.keywords || []).join('，') })}
    </div>
    ${field('关系（每行一条：对象|关系|备注）', 'relText', { relText: (c.relations || []).map((r) => `${r.to}|${r.type || ''}|${r.note || ''}`).join('\n') }, { area: true, rows: 2 })}
    <div class="char-appear-slot">${characterIndexHtml(c, i, charIndex, mentionIndex, stateCache)}</div>`;
  bindFields(div, c, () => saveNovelPart({ bible: n.bible }));
  const kw = div.querySelector('[data-key="kwText"]');
  kw.addEventListener('input', () => {
    c.keywords = kw.value.split(/[,，、\s]+/).filter(Boolean);
    saveNovelPart({ bible: n.bible });
  });
  const rel = div.querySelector('[data-key="relText"]');
  rel.addEventListener('input', () => {
    c.relations = rel.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [to, type, note] = l.split('|').map((x) => (x || '').trim());
      return { to: to || '', type: type || '', note: note || '' };
    }).filter((r) => r.to);
    saveNovelPart({ bible: n.bible });
  });
  // 改姓名或别名（关键词）后，失焦时只重画这一张卡的出场 / 状态索引，不整页重排
  const paintIndex = () => {
    const slot = div.querySelector('.char-appear-slot');
    if (slot) slot.innerHTML = characterIndexHtml(c, i, charIndex, mentionIndex, stateCache);
  };
  div.querySelector('[data-key="name"]').addEventListener('change', paintIndex);
  kw.addEventListener('change', paintIndex);
  div.querySelector('.del').onclick = () => {
    if (!confirm(`删除人物「${c.name || i + 1}」？`)) return;
    removeBibleEntry('characters', i, '人物');
  };
  return div;
}

/* ---- 人物 ---- */
function renderCharactersTab(host, n) {
  host.innerHTML = `
    <div class="bible-block">
      <h2>人物卡
        <span style="flex:1"></span>
        <button class="btn btn-sm" id="aiChar">AI 生成人物</button>
        <button class="btn btn-sm" id="addChar">${ico('plus')}新增人物</button>
      </h2>
      <p class="dim small">人物卡会自动进入生成上下文。系统用名字与身份做相关度匹配，本章提到谁，就重点带上谁；存过章节记忆后，会按姓名与关键词汇总出场章节（「艾伦·史密斯」这类全名会拆成「艾伦」「史密斯」分别匹配），点章节号即可跳转。章节记忆里的状态变化（如「林昭手臂受伤」）也会归到人物卡下，显示成「状态 N」chip。</p>
      ${bibleSearchBar('characters', '搜索人物：姓名 / 身份 / 说明 / 关键词 / 关系')}
      <div class="entry-list" id="charList"></div>
    </div>`;
  const list = $('#charList', host);
  const charIndex = buildCharacterAppearances(n);
  const mentionIndex = buildMentionIndex(n);
  const stateCache = new Map();

  const renderList = () => {
    const rows = filterEntriesBySearch(n.bible.characters, bibleSearchValue('characters'), characterSearchText);
    setBibleSearchCount(host, 'characters', rows.length, n.bible.characters.length);
    list.scrollTop = 0;
    initBibleVirtualList(list, rows, ({ item, index }) => renderCharacterEntry(item, index, charIndex, n, mentionIndex, stateCache), 'characters');
    if (!rows.length) {
      list.innerHTML = n.bible.characters.length
        ? `<p class="dim">没有匹配「${esc(bibleSearchValue('characters').trim())}」的人物。</p>`
        : '<p class="dim">还没有人物卡。</p>';
    }
  };
  bindBibleSearch(host, 'characters', renderList);
  renderList();

  list.addEventListener('click', (e) => {
    const chapterBtn = e.target.closest('[data-chapter]');
    if (chapterBtn) return openChapterFromIndex(chapterBtn.dataset.chapter);
    const stateBtn = e.target.closest('[data-state-more]');
    if (stateBtn) {
      const c = n.bible.characters[Number(stateBtn.dataset.stateMore)];
      if (c) openEntryStatesModal(c, entryStateChanges(c, mentionIndex));
      return;
    }
    const moreBtn = e.target.closest('[data-appear-more]');
    if (!moreBtn) return;
    const c = n.bible.characters[Number(moreBtn.dataset.appearMore)];
    if (c) openCharacterAppearancesModal(c.name, appearancesForCharacter(c, charIndex));
  });

  $('#addChar', host).onclick = () => {
    S.bibleSearch.characters = '';
    n.bible.characters.push({ id: uid('ch'), name: '新人物', role: '配角', keywords: [], relations: [] });
    renderBible();
    saveNovelPart({ bible: n.bible });
  };
  $('#aiChar', host).onclick = async () => {
    const text = await runStream({
      task: 'characters',
      novelId: n.id,
      payload: { instruction: '根据已有大纲与世界观，设计 6 位主要人物（含主角、对手、关键配角）。' },
    });
    const arr = parseJsonLoose(text);
    if (!Array.isArray(arr)) return toast('解析失败，可到输出区复制后手动填写', 'err');
    S.bibleSearch.characters = '';
    arr.forEach((x) => n.bible.characters.push({ id: uid('ch'), relations: [], ...x, keywords: x.keywords || [] }));
    renderBible();
    saveNovelPart({ bible: n.bible }, `已加入 ${arr.length} 位人物`);
  };
}

/* ---- 世界观条目渲染（供虚拟列表复用） ---- */
/** 条目在正文 / 章节记忆里的提及索引，以及章节记忆里的状态变化条数。
 *  名字与关键词都参与匹配；状态详情点「状态 N」查看。 */
function worldMentionsHtml(w, mentionIndex, entryIndex, mentionCache, stateCache) {
  const keys = worldMentionKeys(w);
  if (!keys.length) {
    return `<div class="entry-appear">
      <span class="ca-label">提及</span>
      <span class="ca-empty">名称至少 2 个字，或补一个检索关键词，才会在正文里查找提及。</span>
    </div>`;
  }
  const cacheKey = keys.join('\u0000');
  let chapters = mentionCache?.get(cacheKey);
  if (!chapters) {
    chapters = worldMentionChapters(w, mentionIndex);
    mentionCache?.set(cacheKey, chapters);
  }
  let states = stateCache?.get(cacheKey);
  if (!states) {
    states = entryStateChanges(w, mentionIndex);
    stateCache?.set(cacheKey, states);
  }
  if (!chapters.length) {
    return `<div class="entry-appear">
      <span class="ca-label">提及</span>
      <span class="ca-empty">正文和章节记忆里还没出现</span>
    </div>`;
  }
  const shown = chapters.slice(0, 8);
  const latestState = states[states.length - 1];
  return `<div class="entry-appear">
    <span class="ca-label">提及</span>
    <div class="ca-chips">
      ${shown.map((ch) => `<button type="button" class="ca-chip" data-chapter="${esc(ch.id)}" title="第 ${ch.no} 章 · ${esc(ch.title || '未命名')}">第 ${ch.no} 章</button>`).join('')}
      ${chapters.length > shown.length ? `<button type="button" class="ca-chip ca-more" data-mention-more="${entryIndex}" title="查看全部 ${chapters.length} 章">+${chapters.length - shown.length}</button>` : ''}
      ${states.length ? `<button type="button" class="ca-chip ca-state" data-state-more="${entryIndex}" title="最近：第 ${latestState.no} 章 · ${esc(latestState.text)}">状态 ${states.length}</button>` : ''}
    </div>
    <span class="ca-count">${chapters.length} 章</span>
  </div>`;
}

function renderWorldEntry(w, i, n, mentionIndex, mentionCache, stateCache) {
  const div = document.createElement('div');
  div.className = 'entry';
  div.innerHTML = `
    <div class="entry-head">
      <input class="input" data-key="name" value="${esc(w.name || '')}" placeholder="名称" style="max-width:200px;font-weight:600" />
      <input class="input" data-key="category" value="${esc(w.category || '')}" placeholder="分类：地理/势力/力量体系/规则/物品" style="max-width:240px" />
      <span style="flex:1"></span>
      <button class="del" title="删除">${ico('trash')}</button>
    </div>
    ${field('说明（写具体细节，模型才能用上）', 'desc', w, { area: true, rows: 3 })}
    ${field('检索关键词（逗号分隔）', 'kwText', { kwText: (w.keywords || []).join('，') })}
    <div class="world-index-slot">${worldMentionsHtml(w, mentionIndex, i, mentionCache, stateCache)}</div>`;
  bindFields(div, w, () => saveNovelPart({ bible: n.bible }));
  const kw = div.querySelector('[data-key="kwText"]');
  kw.addEventListener('input', () => {
    w.keywords = kw.value.split(/[,，、\s]+/).filter(Boolean);
    saveNovelPart({ bible: n.bible });
  });
  // 改名字或关键词后，只重画这一张卡的提及 / 状态索引，不整页重排
  const paintMention = () => {
    const slot = div.querySelector('.world-index-slot');
    if (slot) slot.innerHTML = worldMentionsHtml(w, mentionIndex, i, mentionCache, stateCache);
  };
  div.querySelector('[data-key="name"]').addEventListener('change', paintMention);
  kw.addEventListener('change', paintMention);
  div.querySelector('.del').onclick = () => {
    if (!confirm(`删除设定「${w.name || i + 1}」？`)) return;
    removeBibleEntry('world', i, '设定');
  };
  return div;
}

/* ---- 世界观 ---- */
function renderWorldTab(host, n) {
  host.innerHTML = `
    <div class="bible-block">
      <h2>世界观条目
        <span style="flex:1"></span>
        <button class="btn btn-sm" id="aiWorld">AI 补全世界观</button>
        <button class="btn btn-sm" id="addWorld">${ico('plus')}新增条目</button>
      </h2>
      <p class="dim small">地理、势力、力量体系、规则、物品、风俗都放这里。条目名与关键词参与相关度匹配；章节记忆里的状态变化会自动归到对应条目下。</p>
      ${bibleSearchBar('world', '搜索世界观：名称 / 分类 / 说明 / 关键词')}
      <div class="entry-list" id="worldList"></div>
    </div>`;
  const list = $('#worldList', host);
  const mentionIndex = buildMentionIndex(n);
  const mentionCache = new Map();
  const stateCache = new Map();

  const renderList = () => {
    const rows = filterEntriesBySearch(n.bible.world, bibleSearchValue('world'), worldSearchText);
    setBibleSearchCount(host, 'world', rows.length, n.bible.world.length);
    list.scrollTop = 0;
    initBibleVirtualList(list, rows, ({ item, index }) => renderWorldEntry(item, index, n, mentionIndex, mentionCache, stateCache), 'world');
    if (!rows.length) {
      list.innerHTML = n.bible.world.length
        ? `<p class="dim">没有匹配「${esc(bibleSearchValue('world').trim())}」的世界观条目。</p>`
        : '<p class="dim">还没有世界观条目。</p>';
    }
  };
  bindBibleSearch(host, 'world', renderList);
  renderList();

  list.addEventListener('click', (e) => {
    const chapterBtn = e.target.closest('[data-chapter]');
    if (chapterBtn) return openChapterFromIndex(chapterBtn.dataset.chapter);
    const stateBtn = e.target.closest('[data-state-more]');
    if (stateBtn) {
      const w = n.bible.world[Number(stateBtn.dataset.stateMore)];
      if (w) openEntryStatesModal(w, entryStateChanges(w, mentionIndex));
      return;
    }
    const moreBtn = e.target.closest('[data-mention-more]');
    if (!moreBtn) return;
    const w = n.bible.world[Number(moreBtn.dataset.mentionMore)];
    if (!w) return;
    openWorldMentionsModal(w, worldMentionChapters(w, mentionIndex));
  });

  $('#addWorld', host).onclick = () => {
    S.bibleSearch.world = '';
    n.bible.world.push({ id: uid('w'), name: '新设定', category: '地理', desc: '', keywords: [] });
    renderBible();
    saveNovelPart({ bible: n.bible });
  };
  $('#aiWorld', host).onclick = async () => {
    const text = await runStream({
      task: 'worldview',
      novelId: n.id,
      payload: { instruction: '补全本书世界观：力量体系的规则与代价、主要势力、关键地点、重要物品或禁忌。给出 8-10 条。' },
    });
    const arr = parseJsonLoose(text);
    if (!Array.isArray(arr)) return toast('解析失败，可到输出区复制后手动填写', 'err');
    S.bibleSearch.world = '';
    arr.forEach((x) => n.bible.world.push({ id: uid('w'), keywords: [], ...x, keywords: x.keywords || [] }));
    renderBible();
    saveNovelPart({ bible: n.bible }, `已加入 ${arr.length} 条世界观`);
  };
}

/* ---- 线索追踪 ---- */
function threadMeta(item) {
  const nos = item.nos || [];
  if (nos.length <= 1) return `第 ${nos[0] || '?'} 章`;
  if (nos.length <= 4) return `第 ${nos.join('、')} 章`;
  return `第 ${nos[0]}–${nos[nos.length - 1]} 章 · 跨 ${nos.length} 章`;
}

/** 切到人物页签，清掉搜索，把目标卡滚进视口并闪一下。 */
function focusCharacterCard(characterId, attempt = 0) {
  const n = S.novel;
  const list = $('#charList');
  if (!n || !list) return false;
  const idx = n.bible.characters.findIndex((c) => c.id === characterId);
  if (idx < 0) return false;
  const vl = S.bibleVl.lists.characters;
  const virtual = vl?.enabled && vl.listEl === list;
  if (virtual) {
    const itemH = vl.itemHeight || 280;
    const viewH = list.clientHeight || itemH;
    list.scrollTop = Math.max(0, idx * itemH - Math.max(0, (viewH - itemH) / 2));
    renderBibleVirtualList(list, list.scrollTop, 'characters');
  }
  const card = [...list.querySelectorAll('[data-entry-id]')].find((el) => el.dataset.entryId === characterId);
  if (!card) {
    if (attempt < 3) requestAnimationFrame(() => focusCharacterCard(characterId, attempt + 1));
    return false;
  }
  if (!virtual) card.scrollIntoView({ block: 'center' });
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 1400);
  return true;
}

/** 从关系图节点跳到人物卡；只在记忆里出现的人物给一个明确的新增入口。 */
function jumpToCharacterNode(node) {
  if (!S.novel) return;
  const novelId = S.novel.id;
  if (node.group === 'bible' && S.novel.bible.characters.some((c) => c.id === node.id)) {
    openCharacterCard(node.id);
    return;
  }
  bibleTab = 'characters';
  $$('#bibleTabs button').forEach((x) => x.classList.toggle('on', x.dataset.bible === 'characters'));
  S.bibleSearch.characters = '';
  setView('bible');
  toast(`「${node.label}」只出现在章节记忆里，还没有人物卡`, '', {
    label: '新增人物卡',
    onClick: () => {
      if (S.novel?.id !== novelId) return toast('已切换作品，无法新增', 'err');
      const c = { id: uid('ch'), name: node.label, role: '配角', keywords: [], relations: [] };
      S.novel.bible.characters.push(c);
      S.bibleSearch.characters = '';
      renderBible();
      saveNovelPart({ bible: S.novel.bible });
      focusCharacterCard(c.id);
    },
  });
}

/** 切到人物页签并定位到某张人物卡（供关系图双击使用） */
function openCharacterCard(characterId) {
  if (!S.novel) return false;
  if (!S.novel.bible.characters.some((c) => c.id === characterId)) return false;
  bibleTab = 'characters';
  $$('#bibleTabs button').forEach((x) => x.classList.toggle('on', x.dataset.bible === 'characters'));
  S.bibleSearch.characters = '';
  setView('bible');
  return focusCharacterCard(characterId);
}

/** 人物关系图谱：基于设定库与章节记忆自动生成人物关系网络 */
function renderRelationsTab(host, n) {
  // 收集所有角色（设定库 + 记忆）：记忆名先按别名归到人物卡，归不上的才建独立节点
  const index = buildCharacterAppearances(n);
  const { characters, mentionToId } = collectCharacterNodes(n);
  const charList = characters;
  // 记忆里的各种写法（全名 / 分段 / 关键词）都归到同一个节点，搜索时也要能命中
  const aliasesById = new Map();
  for (const [mention, id] of mentionToId) {
    if (!aliasesById.has(id)) aliasesById.set(id, []);
    aliasesById.get(id).push(mention);
  }

  if (charList.length < 2) {
    host.innerHTML = `
      <div class="bible-block">
        <h2>人物关系图谱</h2>
        <p class="dim">至少需要 2 个角色才能生成关系图。<br>先在「设定 → 人物」添加角色，或在章节记忆中出现更多人物。</p>
      </div>`;
    return;
  }

  const REL_TYPES = ['亲密', '敌对', '师徒', '亲属', '盟友', '竞争', '暗恋', '背叛', '保护', '利用'];
  const relations = new Map(); // key: 排序后的 id 对，value 自带 source / target
  const relationKey = (a, b) => [a, b].sort().join('\u0000');
  const ensureRelation = (source, target, type = '关联') => {
    if (!source || !target || source === target) return null;
    const key = relationKey(source, target);
    let rel = relations.get(key);
    if (!rel) {
      rel = { source, target, type, strength: 0, evidence: [] };
      relations.set(key, rel);
    }
    return rel;
  };

  // 从设定库关系字段提取（新数据是 { to, type, note } 数组；老数据兼容「对象：关系」字符串）
  (n.bible?.characters || []).forEach((c) => {
    let entries = [];
    if (Array.isArray(c.relations)) {
      entries = c.relations
        .map((r) => ({ to: String(r?.to || '').trim(), type: String(r?.type || '').trim() || '关联', note: String(r?.note || '').trim() }))
        .filter((r) => r.to);
    } else if (typeof c.relations === 'string' && c.relations.trim()) {
      entries = c.relations.split(/[、,，;；\n]/).map((s) => s.trim()).filter(Boolean).map((s) => {
        const m = s.match(/^(.+?)[：:]\s*(.+)$/);
        return m ? { to: m[1].trim(), type: m[2].trim() || '关联', note: '' } : null;
      }).filter(Boolean);
    }
    entries.forEach(({ to, type, note }) => {
      const target = findCharacterByMention(charList, to);
      if (!target || target.id === c.id) return;
      const rel = ensureRelation(c.id, target.id, type);
      if (!rel) return;
      // 明确关系比共同出场推断更可信：更新类型，并抬到最高强度
      if (type) rel.type = type;
      rel.strength = Math.max(rel.strength, 5);
      rel.evidence.push(`设定库：${c.name} → ${to} (${type})${note ? ` · ${note}` : ''}`);
    });
  });

  // 从记忆推断关系：共同出场、状态变化提及
  for (const [chapterIndex, ch] of (n.chapters || []).entries()) {
    const mem = ch.memory || {};
    const no = ch.no || chapterIndex + 1;
    const ids = [];
    const names = new Map();
    for (const raw of splitMemoryCharacters(mem.characters)) {
      const id = mentionToId.get(normalizeCharacterName(raw));
      if (!id || ids.includes(id)) continue;
      ids.push(id);
      names.set(id, raw);
    }
    const states = memoryItems(mem, 'stateChanges');
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const rel = ensureRelation(ids[i], ids[j]);
        if (!rel) continue;
        rel.strength += 1;
        rel.evidence.push(`第 ${no} 章共同出场`);
        const nodeA = charList.find((c) => c.id === ids[i]);
        const nodeB = charList.find((c) => c.id === ids[j]);
        const hit = (state, raw, node) => state.includes(raw) || (node?.name && state.includes(node.name));
        if (states.some((s) => hit(s, names.get(ids[i]), nodeA) && hit(s, names.get(ids[j]), nodeB))) {
          rel.strength += 2;
          rel.evidence.push(`第 ${no} 章状态变化关联`);
        }
      }
    }
  }

  // 生成节点和边数据
  const svgWidth = 700;
  const svgHeight = 500;
  const nodes = charList.map((c, i) => {
    const appearances = appearancesForCharacter(c, index).length;
    return {
      id: c.id,
      label: c.name || '未命名',
      group: c.fromBible ? 'bible' : 'memory',
      char: c,
      size: 20 + Math.min(30, appearances * 3),
      x: svgWidth / 2 + Math.cos((i / charList.length) * Math.PI * 2) * 180,
      y: svgHeight / 2 + Math.sin((i / charList.length) * Math.PI * 2) * 150,
    };
  });

  const edges = [...relations.values()].map((rel) => ({
    source: rel.source,
    target: rel.target,
    type: rel.type,
    strength: rel.strength,
    evidence: rel.evidence.slice(-3),
  }));

  host.innerHTML = `
    <div class="bible-block">
      <h2>人物关系图谱
        <span style="flex:1"></span>
        <label class="find-check"><input type="checkbox" id="relShowLabels" checked /> 显示标签</label>
        <label class="find-check"><input type="checkbox" id="relShowEvidence" /> 悬停显示证据</label>
        <select class="input" id="relFilterType" style="width:auto;min-width:120px">
          <option value="">全部关系</option>
          ${REL_TYPES.map((t) => `<option value="${t}">${t}</option>`).join('')}
          <option value="other">其他/推断</option>
        </select>
      </h2>
      <p class="dim small">基于设定库关系字段 + 章节记忆共同出场/状态关联自动生成。人物名会按全名、分段与关键词归并，节点大小=出场频度，边粗细=关联强度。拖拽节点可调整布局，双击节点跳转人物卡。</p>
      ${bibleSearchBar('relations', '搜索人物 / 关系类型 / 证据')}
      <p class="dim small rel-search-empty" id="relSearchEmpty" hidden></p>
      <div class="relation-svg-wrap" style="position:relative;background:var(--surface-1);border:1px solid var(--border);border-radius:var(--r-lg);overflow:hidden;">
        <svg id="relationSvg" viewBox="0 0 ${svgWidth} ${svgHeight}" width="100%" style="display:block;height:auto;"></svg>
      </div>
      <div class="relation-legend" style="margin-top:12px;display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:var(--text-3)">
        ${REL_TYPES.map((t) => `<span><span style="display:inline-block;width:12px;height:3px;background:var(--${t === '亲密' ? 'success' : t === '敌对' ? 'danger' : t === '师徒' ? 'warning' : 'accent'});vertical-align:middle;margin-right:4px;border-radius:2px;"></span>${t}</span>`).join('')}
        <span><span style="display:inline-block;width:12px;height:3px;background:var(--text-4);vertical-align:middle;margin-right:4px;border-radius:2px;"></span>推断关联</span>
      </div>
    </div>`;

  // 渲染 SVG
  const svg = $('#relationSvg', host);
  const showLabelsEl = $('#relShowLabels', host);
  const showEvidenceEl = $('#relShowEvidence', host);
  const filterTypeEl = $('#relFilterType', host);
  let draggedNode = null;

  const nodeAliases = (node) => aliasesById.get(node.id) || [];
  const nodeSearchText = (node) => bibleSearchText([
    node.label,
    nodeAliases(node),
    node.char ? characterSearchText(node.char, { relations: false }) : '',
  ]);
  const edgeSearchText = (edge, source, target) => bibleSearchText([
    edge.type,
    edge.evidence,
    source?.label,
    target?.label,
    source ? nodeAliases(source) : [],
    target ? nodeAliases(target) : [],
    source?.char ? characterSearchText(source.char, { relations: false }) : '',
    target?.char ? characterSearchText(target.char, { relations: false }) : '',
  ]);

  function renderGraph() {
    const filterType = filterTypeEl.value;
    const query = bibleSearchValue('relations');
    // 类型筛选先作用在边上，搜索只在当前可见的关系里找，计数才不会把隐藏的边算进来
    const passesType = (edge) => !filterType || edge.type === filterType || (filterType === 'other' && !REL_TYPES.includes(edge.type));
    const visibleEdgeIndexes = [];
    const visibleEdges = [];
    edges.forEach((edge, index) => {
      if (!passesType(edge)) return;
      visibleEdgeIndexes.push(index);
      visibleEdges.push(edge);
    });
    const found = searchRelationGraph(nodes, visibleEdges, query, nodeSearchText, edgeSearchText);
    const match = found ? {
      ...found,
      edges: new Set([...found.edges].map((index) => visibleEdgeIndexes[index])),
    } : null;
    const countEl = $('[data-bible-search-count="relations"]', host);
    if (countEl) {
      countEl.textContent = match
        ? `命中 ${match.nodeCount} / ${nodes.length} 人 · ${match.edgeCount} / ${visibleEdges.length} 条关系`
        : `共 ${nodes.length} 人 · ${visibleEdges.length} 条关系`;
    }
    const emptyEl = $('#relSearchEmpty', host);
    if (emptyEl) {
      const q = query.trim();
      emptyEl.hidden = !q || !!(match && (match.nodeCount || match.edgeCount));
      emptyEl.textContent = q && match && !match.nodeCount && !match.edgeCount
        ? (filterType ? `当前关系类型下没有匹配「${q}」的人物或关系。` : `没有匹配「${q}」的人物或关系。`)
        : '';
    }
    svg.innerHTML = '';

    // 定义箭头标记
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = `
      <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
        <path d="M0,0 L0,6 L9,3 z" fill="var(--text-3)" />
      </marker>
    `;
    svg.appendChild(defs);

    // 绘制边
    edges.forEach((edge, edgeIndex) => {
      if (!passesType(edge)) return;
      const sourceNode = nodes.find((n) => n.id === edge.source);
      const targetNode = nodes.find((n) => n.id === edge.target);
      if (!sourceNode || !targetNode) return;
      const dim = !!match && !match.edges.has(edgeIndex);

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('class', `relation-edge${match ? (dim ? ' is-dim' : ' is-hit') : ''}`);
      line.setAttribute('x1', sourceNode.x);
      line.setAttribute('y1', sourceNode.y);
      line.setAttribute('x2', targetNode.x);
      line.setAttribute('y2', targetNode.y);
      line.setAttribute('stroke', REL_TYPES.includes(edge.type) ? `var(--${edge.type === '亲密' ? 'success' : edge.type === '敌对' ? 'danger' : edge.type === '师徒' ? 'warning' : 'accent'})` : 'var(--text-4)');
      line.setAttribute('stroke-width', Math.max(1, Math.min(5, edge.strength / 2)));
      line.setAttribute('stroke-dasharray', REL_TYPES.includes(edge.type) ? 'none' : '4,4');
      line.setAttribute('marker-end', 'url(#arrow)');
      line.setAttribute('data-source', edge.source);
      line.setAttribute('data-target', edge.target);
      line.setAttribute('data-evidence', edge.evidence.join('\n'));
      line.setAttribute('data-type', edge.type);
      line.setAttribute('data-strength', edge.strength);
      line.style.cursor = 'pointer';
      if (showEvidenceEl.checked) {
        line.addEventListener('mouseenter', (e) => {
          const tooltip = document.createElementNS('http://www.w3.org/2000/svg', 'title');
          tooltip.textContent = `${edge.type} (强度${edge.strength})\n${edge.evidence.join('\n')}`;
          line.appendChild(tooltip);
        });
      }
      svg.appendChild(line);
    });

    // 绘制节点
    nodes.forEach((node) => {
      const dim = !!match && !match.nodes.has(node.id);
      const showLabel = showLabelsEl.checked || (match && match.nodes.has(node.id));
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', `relation-node${match ? (dim ? ' is-dim' : ' is-hit') : ''}`);
      g.setAttribute('data-node-id', node.id);
      g.setAttribute('data-node-group', node.group);
      g.style.cursor = 'move';
      g.innerHTML = `
        <circle cx="${node.x}" cy="${node.y}" r="${node.size}" style="--size:${node.size}px" fill="${node.group === 'bible' ? 'var(--brand)' : 'var(--accent)'}" stroke="var(--surface-1)" stroke-width="2" opacity="0.9" />
        ${showLabel ? `<text x="${node.x}" y="${node.y + node.size + 14}" text-anchor="middle" font-size="11" fill="var(--text-1)" style="pointer-events:none;">${esc(node.label)}</text>` : ''}
      `;
      g.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        draggedNode = node;
        g.style.cursor = 'grabbing';
      });
      g.addEventListener('dblclick', () => jumpToCharacterNode(node));
      svg.appendChild(g);
    });
  }

  // 拖拽逻辑：CSS 会把 SVG 拉伸到容器宽度，坐标要经过 CTM 换算，否则一拖就偏
  const toSvgPoint = (e) => {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    return ctm ? pt.matrixTransform(ctm.inverse()) : { x: e.clientX - svg.getBoundingClientRect().left, y: e.clientY - svg.getBoundingClientRect().top };
  };
  svg.addEventListener('mousemove', (e) => {
    if (!draggedNode) return;
    const p = toSvgPoint(e);
    const pad = draggedNode.size + 4;
    draggedNode.x = Math.max(pad, Math.min(svgWidth - pad, p.x));
    draggedNode.y = Math.max(pad, Math.min(svgHeight - pad, p.y));
    renderGraph();
  });
  svg.addEventListener('mouseup', () => { draggedNode = null; });
  svg.addEventListener('mouseleave', () => { draggedNode = null; });

  showLabelsEl.onchange = renderGraph;
  showEvidenceEl.onchange = renderGraph;
  filterTypeEl.onchange = renderGraph;
  bindBibleSearch(host, 'relations', renderGraph);

  renderGraph();
}

/* ---- 线索条目渲染（供虚拟列表复用） ---- */
function renderThreadEntry(item) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'thread-row';
  btn.dataset.threadCh = item.latest.id;
  btn.title = `跳到第 ${item.latest.no} 章`;
  btn.innerHTML = `
    <span class="thread-kind ${item.kind}">${THREAD_KINDS[item.kind].label}</span>
    <span class="thread-text">${esc(item.text)}</span>
    <span class="thread-meta">${threadMeta(item)}</span>
  `;
  return btn;
}

/** 线索追踪：基于章节记忆自动生成 */
function renderThreadsTab(host, n) {
  const threads = collectThreads(n);
  const counts = {
    unresolved: threads.filter((t) => t.kind === 'unresolved').length,
    foreshadowing: threads.filter((t) => t.kind === 'foreshadowing').length,
  };
  const total = threads.length;
  const memCount = (n.chapters || []).filter((c) => c.memory).length;
  const filterOf = () => (['all', 'unresolved', 'foreshadowing'].includes(S.threadFilter) ? S.threadFilter : 'all');

  host.innerHTML = `
    <div class="bible-block">
      <h2>线索追踪
        <span style="flex:1"></span>
        <button class="btn btn-sm" id="threadsBatch">${ico('refresh')}批量补记忆</button>
      </h2>
      <p class="dim small">从每章记忆的「未决」「伏笔」自动汇总，重复的线索会合并；点一条可跳到最近提到的章节。它不替代设定库，只是把散在几十万字里的线头集中起来。线索是否已经回收，以正文为准。</p>
      ${bibleSearchBar('threads', '搜索线索：内容 / 类型 / 章节')}
      <div class="thread-stats">
        <span class="thread-stat"><b>${counts.unresolved}</b> 条未决</span>
        <span class="thread-stat"><b>${counts.foreshadowing}</b> 条伏笔</span>
        <span class="thread-stat">已读取 <b>${memCount}</b> / ${n.chapters.length} 章记忆</span>
      </div>
      ${total ? `<div class="segmented thread-filter" id="threadFilter">
        ${[
          ['all', '全部', total],
          ['unresolved', '未决', counts.unresolved],
          ['foreshadowing', '伏笔', counts.foreshadowing],
        ].map(([kind, label, count]) => `<button data-tf="${kind}" class="${filterOf() === kind ? 'on' : ''}">${label} ${count}</button>`).join('')}
      </div>` : ''}
      <div class="thread-list" id="threadList"></div>
      ${memCount > 0 && memCount < n.chapters.length ? `<p class="dim small thread-hint">还有 ${n.chapters.length - memCount} 章没有章节记忆，线索可能不完整。</p>` : ''}
    </div>`;

  const list = $('#threadList', host);
  const renderList = () => {
    const matched = filterEntriesBySearch(threads, bibleSearchValue('threads'), threadSearchText)
      .map((row) => row.item);
    const filter = filterOf();
    const visible = filter === 'all' ? matched : matched.filter((t) => t.kind === filter);
    setBibleSearchCount(host, 'threads', visible.length, total);
    list.scrollTop = 0;
    initBibleVirtualList(list, visible, (t) => renderThreadEntry(t), 'threads');
    if (!visible.length) {
      const q = bibleSearchValue('threads').trim();
      list.innerHTML = q
        ? `<p class="dim">没有匹配「${esc(q)}」的线索。</p>`
        : (total ? '<p class="dim">这个筛选下还没有线索。</p>' : '<p class="thread-empty">还没有线索。给章节存过记忆后，「未决」和「伏笔」会自动汇总到这里。</p>');
    }
  };

  bindBibleSearch(host, 'threads', renderList);
  $$('#threadFilter button', host).forEach((btn) => {
    btn.onclick = () => {
      S.threadFilter = btn.dataset.tf;
      $$('#threadFilter button', host).forEach((x) => x.classList.toggle('on', x === btn));
      renderList();
    };
  });
  $('#threadsBatch', host).onclick = () => {
    setView('studio');
    openBatchMemory();
  };

  renderList();
  // 点击跳转
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.thread-row');
    if (row) openChapterFromIndex(row.dataset.threadCh);
  });
}

/** 人物弧光追踪：基于章节记忆自动生成每个角色的情感/状态曲线 */
function renderArcsTab(host, n) {
  const arcs = buildCharacterArcs(n);
  if (arcs.length === 0) {
    host.innerHTML = `
      <div class="bible-block">
        <h2>人物弧光</h2>
        <p class="dim">还没有足够的章节记忆来生成人物弧光。<br>先在「写作」里给章节「存章节记忆」，或去「设定 → 人物」里添加角色与关键词。</p>
      </div>`;
    return;
  }

  // 弧光数据项（每项是一个角色的完整弧光卡片）；字数用页面级缓存统计
  const arcItems = arcs.map((arc) => ({
    ...arc,
    totalWords: arc.points.reduce((sum, point) => sum + wordsOf(point.chapter), 0),
  }));

  // 单个弧光卡片渲染函数（供虚拟列表复用）
  function renderArcEntry(item, idx) {
    const { char, points, totalWords, latestState, latestStateNo, latestStateIsLatest } = item;
    const stateLabel = !latestState
      ? '最新状态：'
      : (latestStateIsLatest ? '最新状态：' : `最近状态（第 ${latestStateNo} 章）：`);
    const div = document.createElement('div');
    div.className = 'arc-card';
    div.dataset.charId = char.id;
    div.innerHTML = `
      <div class="arc-head">
        <button type="button" class="arc-name" data-char-id="${esc(char.id)}">${esc(char.name)}</button>
        <span class="arc-count">${points.length} 章 · ${totalWords} 字</span>
        <button class="btn btn-sm btn-text arc-goto" data-ch="${points[points.length - 1].chapterId}">跳到最新</button>
      </div>
      <div class="arc-timeline">
        ${points.map((p) => `
          <div class="arc-point" data-ch="${p.chapterId}">
            <span class="arc-ch">第 ${p.chapterNo} 章</span>
            <span class="arc-main">
              <span class="arc-title">${esc(p.title || '未命名')}</span>
              ${p.unresolved ? `<span class="arc-unresolved">未决：${esc(p.unresolved)}</span>` : ''}
            </span>
            ${p.state ? `<span class="arc-state">${esc(p.state)}</span>` : ''}
            ${p.events ? `<span class="arc-events dim">${esc(p.events)}</span>` : ''}
          </div>
        `).join('')}
      </div>
      <div class="arc-summary">
        <span class="arc-label">${stateLabel}</span>
        <span class="arc-state">${esc(latestState || '无记录')}</span>
      </div>
    `;
    return div;
  }

  host.innerHTML = `
    <div class="bible-block">
      <h2>人物弧光</h2>
      <p class="dim small">基于章节记忆自动提取每个角色的出场轨迹、状态变化与未决线索。点人物名可打开人物卡，点章次号可跳转正文。</p>
      ${bibleSearchBar('arcs', '搜索弧光：人物 / 章节 / 状态 / 事件 / 未决')}
      <div class="arcs-list" id="arcList"></div>
    </div>`;

  const list = $('#arcList', host);
  if (!list) return;
  const renderList = () => {
    const rows = filterEntriesBySearch(arcItems, bibleSearchValue('arcs'), arcSearchText)
      .map((row) => row.item);
    setBibleSearchCount(host, 'arcs', rows.length, arcItems.length);
    list.scrollTop = 0;
    initBibleVirtualList(list, rows, renderArcEntry, 'arcs', { measureAll: true });
    if (!rows.length) {
      const q = bibleSearchValue('arcs').trim();
      list.innerHTML = q
        ? `<p class="dim">没有匹配「${esc(q)}」的人物弧光。</p>`
        : '<p class="dim">还没有人物弧光。</p>';
    }
  };
  bindBibleSearch(host, 'arcs', renderList);
  renderList();

  // 点击跳转（事件委托）
  list.addEventListener('click', (e) => {
    const name = e.target.closest('.arc-name');
    if (name) {
      const item = arcItems.find((arc) => arc.char.id === name.dataset.charId);
      if (item) {
        jumpToCharacterNode({
          id: item.char.id,
          label: item.char.name,
          group: item.char.fromBible ? 'bible' : 'memory',
        });
      }
      return;
    }
    const goto = e.target.closest('.arc-goto');
    if (goto) return openChapterFromIndex(goto.dataset.ch);
    const point = e.target.closest('.arc-point');
    if (point) openChapterFromIndex(point.dataset.ch);
  });
}

/** Save the Cat 风格的故事节拍表 */
function renderBeatsTab(host, n) {
  // 标准 15 个节拍（Save the Cat）
  const BEATS = [
    { id: 'opening', name: 'Opening Image', zh: '开篇意象', pct: 1, desc: '故事开始时的世界面貌，主角的常态' },
    { id: 'theme', name: 'Theme Stated', zh: '主题阐述', pct: 5, desc: '故事的核心主题被隐晦或直接地说出' },
    { id: 'setup', name: 'Set-Up', zh: '铺垫', pct: 10, desc: '介绍主角世界、缺陷、利害关系、反派暗示' },
    { id: 'catalyst', name: 'Catalyst', zh: '催化剂/激励事件', pct: 12, desc: '打破现状的事件，故事真正开始' },
    { id: 'debate', name: 'Debate', zh: '犹豫/辩论', pct: 20, desc: '主角怀疑、抗拒、权衡利弊' },
    { id: 'break2', name: 'Break into Two', zh: '跨入第二幕', pct: 25, desc: '主角主动选择踏上旅程，离开舒适区' },
    { id: 'bstory', name: 'B Story', zh: 'B 线/副线', pct: 30, desc: '引入情感线/伙伴关系，映照主题' },
    { id: 'fun', name: 'Fun & Games', zh: '趣味与游戏/承诺的娱乐', pct: 50, desc: '核心概念的兑现，类型片段的高潮堆砌' },
    { id: 'midpoint', name: 'Midpoint', zh: '中点', pct: 50, desc: '假性胜利/失败，赌注升级，镜像结构' },
    { id: 'badguys', name: 'Bad Guys Close In', zh: '反派逼近', pct: 62, desc: '内外压力加大，主角计划失效' },
    { id: 'alllost', name: 'All Is Lost', zh: '万念俱灰/彻底失败', pct: 75, desc: '重大挫折，导师离世/背叛，象征性死亡' },
    { id: 'darknight', name: 'Dark Night of the Soul', zh: '灵魂黑夜', pct: 80, desc: '绝望、反思、领悟主题真谛' },
    { id: 'break3', name: 'Break into Three', zh: '跨入第三幕', pct: 85, desc: '融合 A/B 线，找到新方案，主动出击' },
    { id: 'finale', name: 'Finale', zh: '终局/高潮', pct: 95, desc: '最终对决，主题具象化，世界改变' },
    { id: 'finalimg', name: 'Final Image', zh: '终幕意象', pct: 100, desc: '与开篇呼应，展示主角蜕变后的新常态' },
  ];

  // 从章节/场景推算当前进度
  const totalWords = (n.chapters || []).reduce((s, c) => s + wordsOf(c), 0);
  const targetWords = n.meta?.targetWordsPerChapter ? n.meta.targetWordsPerChapter * n.chapters.length : totalWords || 1;
  const progress = Math.min(100, Math.round((totalWords / targetWords) * 100));

  // 现有节拍数据
  n.beats = n.beats || {};
  BEATS.forEach((b) => { n.beats[b.id] = n.beats[b.id] || { chapterId: '', sceneIdx: -1, words: 0, note: '' }; });

  const beatHtml = BEATS.map((b) => {
    const data = n.beats[b.id];
    const ch = data.chapterId ? n.chapters.find((c) => c.id === data.chapterId) : null;
    const chTitle = ch ? `第 ${ch.no} 章《${ch.title}》` : '未关联';
    const filled = !!data.chapterId;
    return `
      <div class="beat-row ${filled ? 'filled' : ''}" data-beat="${b.id}">
        <div class="beat-header">
          <span class="beat-num">${b.pct}%</span>
          <span class="beat-name">${b.zh}</span>
          <span class="beat-en dim">${b.name}</span>
        </div>
        <div class="beat-desc dim small">${b.desc}</div>
        <div class="beat-link">
          <input class="input" data-key="note" value="${esc(data.note || '')}" placeholder="备注：这一节拍发生了什么……" />
          <select class="input beat-chapter" data-key="chapterId" style="max-width:220px">
            <option value="">关联章节……</option>
            ${(n.chapters || []).map((c) => `<option value="${c.id}" ${data.chapterId === c.id ? 'selected' : ''}>第 ${c.no} 章 ${esc(c.title || '未命名')}</option>`).join('')}
          </select>
          <input class="input" type="number" data-key="words" value="${data.words || ''}" placeholder="字数" min="0" step="100" style="width:80px" />
          <button class="btn btn-sm btn-text beat-goto" data-ch="${data.chapterId}" ${!data.chapterId ? 'hidden' : ''}>跳转</button>
        </div>
        <div class="beat-progress">
          <div class="beat-bar" style="width: ${b.pct}%"></div>
          <div class="beat-marker" style="left: ${progress}%"></div>
        </div>
      </div>
    `;
  }).join('');

  host.innerHTML = `
    <div class="bible-block">
      <h2>结构/节拍表 <span class="dim">（Save the Cat 15 Beats）</span></h2>
      <p class="dim small">对照《拯救大猫》15 个节拍规划故事骨架。每个节拍可关联章节、记录字数与备注；进度条显示全书完成度（${progress}%）。</p>
      <div class="beats-list">${beatHtml}</div>
    </div>
  `;

  // 绑定字段
  $$('.beat-row', host).forEach((row) => {
    const beatId = row.dataset.beat;
    const data = n.beats[beatId];
    bindFields(row, data, () => saveNovelPart({ beats: n.beats }));
    row.querySelector('.beat-goto')?.addEventListener('click', () => {
      if (data.chapterId) openChapterFromIndex(data.chapterId);
    });
    row.querySelector('.beat-chapter')?.addEventListener('change', () => {
      data.chapterId = row.querySelector('.beat-chapter').value || '';
      saveNovelPart({ beats: n.beats });
    });
  });
}
/* ---- 时间线条目渲染（供虚拟列表复用） ---- */
function renderTimelineEntry(t, i, n) {
  const div = document.createElement('div');
  div.className = 'entry';
  if (t.id) div.dataset.entryId = t.id;
  const chapters = Array.isArray(n.chapters) ? n.chapters : [];
  const linked = t.chapterId ? chapters.find((c) => c.id === t.chapterId) : null;
  div.innerHTML = `
    <div class="entry-head">
      <input class="input" data-key="time" value="${esc(t.time || '')}" placeholder="时间：开元三年春 / 主角 12 岁" style="max-width:280px;font-weight:600" />
      <input class="input" data-key="title" value="${esc(t.title || '')}" placeholder="事件标题" />
      <button class="del" title="删除">${ico('trash')}</button>
    </div>
    ${field('说明', 'desc', t, { area: true, rows: 2 })}
    <div class="tl-link">
      <select class="input tl-chapter" data-key="chapterId" aria-label="关联章节">
        <option value="">关联章节……</option>
        ${chapters.map((c) => `<option value="${esc(c.id)}" ${t.chapterId === c.id ? 'selected' : ''}>${esc(dayChapterLabel(c))}</option>`).join('')}
      </select>
      <button type="button" class="btn btn-sm btn-text tl-goto" data-ch="${esc(linked?.id || '')}" ${linked ? '' : 'hidden'}>${ico('arrow-right')}跳转</button>
      ${t.chapterId && !linked ? '<span class="dim small">关联的章节已不存在，可以重新选择</span>' : ''}
    </div>`;
  bindFields(div, t, () => saveNovelPart({ bible: n.bible }));
  const select = div.querySelector('.tl-chapter');
  const goto = div.querySelector('.tl-goto');
  const syncGoto = () => {
    const ch = chapters.find((c) => c.id === select.value);
    goto.hidden = !ch;
    goto.dataset.ch = ch?.id || '';
  };
  select.addEventListener('change', syncGoto);
  goto.onclick = () => {
    if (goto.dataset.ch) openChapterFromIndex(goto.dataset.ch);
  };
  div.querySelector('.del').onclick = () => {
    removeBibleEntry('timeline', i, '时间节点');
  };
  return div;
}

/* ---- 时间线 ---- */
function renderTimelineTab(host, n) {
  host.innerHTML = `
    <div class="bible-block">
      <h2>时间线
        <span style="flex:1"></span>
        <button class="btn btn-sm" id="addTl">${ico('plus')}新增节点</button>
      </h2>
      <p class="dim small">故事世界的关键时间点。写到相关情节时会自动带上，防止前后时间对不上。</p>
      ${bibleSearchBar('timeline', '搜索时间线：时间 / 标题 / 说明')}
      <div class="entry-list" id="tlList"></div>
    </div>`;
  const list = $('#tlList', host);

  const renderList = () => {
    const rows = filterEntriesBySearch(n.bible.timeline, bibleSearchValue('timeline'), timelineSearchText);
    setBibleSearchCount(host, 'timeline', rows.length, n.bible.timeline.length);
    list.scrollTop = 0;
    initBibleVirtualList(list, rows, ({ item, index }) => renderTimelineEntry(item, index, n), 'timeline');
    if (!rows.length) {
      list.innerHTML = n.bible.timeline.length
        ? `<p class="dim">没有匹配「${esc(bibleSearchValue('timeline').trim())}」的时间节点。</p>`
        : '<p class="dim">还没有时间节点。</p>';
    }
  };
  bindBibleSearch(host, 'timeline', renderList);
  renderList();

  $('#addTl', host).onclick = () => {
    S.bibleSearch.timeline = '';
    n.bible.timeline.push({ id: uid('t'), time: '', title: '', desc: '' });
    renderBible();
    saveNovelPart({ bible: n.bible });
  };
}

/** 切到时间线页签，清掉搜索，把目标条目滚进视口并聚焦时间输入框。 */
function focusTimelineEntry(entryId, attempt = 0) {
  const n = S.novel;
  const list = $('#tlList');
  if (!n || !list) return false;
  const idx = (n.bible.timeline || []).findIndex((t) => t.id === entryId);
  if (idx < 0) return false;
  const vl = S.bibleVl.lists.timeline;
  const virtual = vl?.enabled && vl.listEl === list;
  if (virtual) {
    const itemH = vl.itemHeight || 280;
    const viewH = list.clientHeight || itemH;
    list.scrollTop = Math.max(0, idx * itemH - Math.max(0, (viewH - itemH) / 2));
    renderBibleVirtualList(list, list.scrollTop, 'timeline');
  }
  const entry = [...list.querySelectorAll('[data-entry-id]')].find((el) => el.dataset.entryId === entryId);
  if (!entry) {
    if (attempt < 3) requestAnimationFrame(() => focusTimelineEntry(entryId, attempt + 1));
    return false;
  }
  if (!virtual) entry.scrollIntoView({ block: 'center' });
  entry.classList.add('flash');
  setTimeout(() => entry.classList.remove('flash'), 1400);
  entry.querySelector('input[data-key="time"]')?.focus();
  return true;
}

/** 从时间轴节点跳回时间线条目，搜索过滤状态会被清掉。 */
function openTimelineEntry(entryId) {
  if (!S.novel) return false;
  if (!(S.novel.bible.timeline || []).some((t) => t.id === entryId)) return false;
  bibleTab = 'timeline';
  $$('#bibleTabs button').forEach((x) => x.classList.toggle('on', x.dataset.bible === 'timeline'));
  S.bibleSearch.timeline = '';
  setView('bible');
  return focusTimelineEntry(entryId);
}

/** 时间轴可视化：将时间线节点按时间顺序渲染为可交互的时间轴 */
function renderTimelineVizTab(host, n) {
  const timeline = buildTimelineEvents(n);

  if (!timeline.length) {
    host.innerHTML = `
      <div class="bible-block">
        <h2>时间轴</h2>
        <p class="dim">还没有时间线节点。<br>先在「设定 → 时间线」里添加节点，或在「时间线」页签里录入。</p>
        <div class="btn-row" style="margin-top:12px">
          <button class="btn btn-primary" id="goToTimeline">${ico('arrow-right')}去「时间线」页签添加</button>
        </div>
      </div>`;
    $('#goToTimeline', host)?.addEventListener('click', () => {
      $('#bibleTabs button[data-bible="timeline"]')?.click();
    });
    return;
  }

  const knownTimes = timeline.map((e) => e.timeVal).filter((v) => v != null);
  const minTime = knownTimes.length ? Math.min(...knownTimes) : 0;
  const maxTime = knownTimes.length ? Math.max(...knownTimes) : Math.max(1, timeline.length - 1);
  const span = maxTime - minTime || 1;
  const sameTime = knownTimes.length > 0 && maxTime === minTime;

  const svgWidth = 900;

  host.innerHTML = `
    <div class="bible-block">
      <h2>时间轴
        <span style="flex:1"></span>
        <button class="btn btn-sm" id="addTlViz">${ico('plus')}新增节点</button>
      </h2>
      <p class="dim small">故事世界的关键时间点可视化。有关联章节的节点单击直接跳转；双击节点回到时间线编辑。中文数字与阿拉伯数字都会参与排序。</p>
      ${bibleSearchBar('timelineViz', '搜索时间轴：时间 / 标题 / 说明 / 章节')}
      <p class="dim small tl-viz-empty" id="tlVizSearchEmpty" hidden></p>
      <div class="timeline-viz-wrap" style="position:relative;background:var(--surface-1);border:1px solid var(--border);border-radius:var(--r-lg);overflow:hidden;">
        <svg id="timelineSvg" viewBox="0 0 900 400" width="100%" style="display:block;height:auto;"></svg>
      </div>
      <div class="timeline-legend" style="margin-top:12px;display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:var(--text-3)">
        <span>● 主线事件</span>
        <span>● 支线/背景</span>
        <span style="border-bottom:1px dashed var(--text-4);">时间跨度：${knownTimes.length ? (minTime === maxTime ? String(minTime) : `${minTime} ~ ${maxTime}`) : '—'}</span>
      </div>
    </div>`;

  const svg = $('#timelineSvg', host);
  let clickTimer = null;

  function renderViz() {
    const query = bibleSearchValue('timelineViz');
    const active = !!query.trim();
    const rows = filterEntriesBySearch(timeline, query, timelineEventSearchText);
    const matched = new Set(rows.map((row) => row.index));
    const countEl = $('[data-bible-search-count="timelineViz"]', host);
    if (countEl) {
      countEl.textContent = active
        ? `命中 ${rows.length} / ${timeline.length} 个节点`
        : `共 ${timeline.length} 个节点`;
    }
    const emptyEl = $('#tlVizSearchEmpty', host);
    if (emptyEl) {
      emptyEl.hidden = !active || rows.length > 0;
      emptyEl.textContent = active && !rows.length
        ? `没有匹配「${query.trim()}」的时间节点。`
        : '';
    }

    const groups = new Map();
    timeline.forEach((e) => {
      const key = e.timeVal == null ? `none-${e.index}` : `t-${e.timeVal}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    });
    timeline.forEach((e, i) => {
      const key = e.timeVal == null ? `none-${e.index}` : `t-${e.timeVal}`;
      const group = groups.get(key);
      const pos = group.indexOf(e);
      // 同一时间点有多个事件时，围绕刻度左右展开，避免叠成一个点
      const spread = group.length > 1 ? (pos - (group.length - 1) / 2) * 26 : 0;
      const base = e.timeVal == null
        ? 60 + (timeline.length > 1 ? (i / (timeline.length - 1)) * (svgWidth - 120) : (svgWidth - 120) / 2)
        : (sameTime ? svgWidth / 2 : 60 + ((e.timeVal - minTime) / span) * (svgWidth - 120));
      e.x = Math.max(40, Math.min(svgWidth - 40, base + spread));
      e.odd = i % 2 === 0;
      e.y = e.odd ? 120 : 280;
    });

    svg.innerHTML = `
      <defs>
        <marker id="tlArrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
          <path d="M0,0 L0,6 L9,3 z" fill="var(--brand)" />
        </marker>
      </defs>
      <line x1="60" y1="200" x2="840" y2="200" stroke="var(--border-2)" stroke-width="2" marker-end="url(#tlArrow)" />
    `;

    timeline.forEach((e, i) => {
      const entry = e.entry;
      const x = e.x;
      const y = e.y;
      const isOdd = e.odd;
      const searchState = active ? (matched.has(i) ? ' is-hit' : ' is-dim') : '';

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('class', `tl-viz-stem${searchState}`);
      line.setAttribute('x1', x);
      line.setAttribute('y1', y);
      line.setAttribute('x2', x);
      line.setAttribute('y2', 200);
      line.setAttribute('stroke', 'var(--border)');
      line.setAttribute('stroke-width', '1');
      line.setAttribute('stroke-dasharray', '4,4');
      svg.appendChild(line);

      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('class', `tl-viz-node${searchState}`);
      circle.setAttribute('cx', x);
      circle.setAttribute('cy', y);
      circle.setAttribute('r', '10');
      circle.setAttribute('fill', 'var(--brand)');
      circle.setAttribute('stroke', 'var(--surface-1)');
      circle.setAttribute('stroke-width', '3');
      circle.setAttribute('cursor', 'pointer');
      circle.setAttribute('data-idx', e.index);
      circle.setAttribute('data-entry-id', entry.id || '');
      circle.setAttribute('data-chapter-id', e.chapterId || '');
      circle.style.transition = 'r 0.15s, filter 0.15s, opacity 0.15s';
      circle.addEventListener('mouseenter', () => { circle.setAttribute('r', '14'); circle.style.filter = 'brightness(1.2)'; });
      circle.addEventListener('mouseleave', () => { circle.setAttribute('r', '10'); circle.style.filter = 'none'; });
      const tip = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      tip.textContent = [
        entry.time,
        entry.title,
        entry.desc,
        e.chapter ? `关联：${dayChapterLabel(e.chapter)}` : '',
        e.chapterMissing ? '关联的章节已不存在' : '',
      ].filter(Boolean).join('\n');
      circle.appendChild(tip);
      // 单击跳章节，双击回时间线编辑。单击要延迟，否则双击会先触发跳转。
      circle.addEventListener('click', () => {
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => {
          if (e.chapterId) openChapterFromIndex(e.chapterId);
          else toast('这个时间节点还没有关联章节，双击可以编辑并关联', '');
        }, 220);
      });
      circle.addEventListener('dblclick', () => {
        clearTimeout(clickTimer);
        if (entry.id) openTimelineEntry(entry.id);
        else $('#bibleTabs button[data-bible="timeline"]')?.click();
      });
      svg.appendChild(circle);

      if (entry.title) {
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('class', `tl-viz-label${searchState}`);
        text.setAttribute('x', x);
        text.setAttribute('y', isOdd ? y - 18 : y + 28);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('font-size', '11');
        text.setAttribute('fill', 'var(--text-1)');
        text.setAttribute('style', 'pointer-events:none; white-space: nowrap;');
        text.textContent = entry.title.length > 12 ? entry.title.slice(0, 12) + '…' : entry.title;
        svg.appendChild(text);
      }

      if (entry.time) {
        const timeText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        timeText.setAttribute('class', `tl-viz-time${searchState}`);
        timeText.setAttribute('x', x);
        timeText.setAttribute('y', isOdd ? y - 32 : y + 42);
        timeText.setAttribute('text-anchor', 'middle');
        timeText.setAttribute('font-size', '9');
        timeText.setAttribute('fill', 'var(--text-3)');
        timeText.setAttribute('style', 'pointer-events:none;');
        timeText.textContent = entry.time;
        svg.appendChild(timeText);
      }
    });
  }

  bindBibleSearch(host, 'timelineViz', renderViz);
  renderViz();

  $('#addTlViz', host)?.addEventListener('click', () => {
    $('#bibleTabs button[data-bible="timeline"]')?.click();
    setTimeout(() => {
      $('#addTl', $('#bibleBody'))?.click();
    }, 100);
  });
}

/* ---- 文风与规则 ---- */
function renderStyleTab(host, n) {
  const m = n.meta;
  host.innerHTML = `
    <div class="bible-block">
      <h2>文风与写作规则</h2>
      <div class="grid3">
        <label class="field-label">叙事视角
          <select class="input" data-key="pov">
            ${['第一人称', '第三人称限知', '第三人称全知', '多视角轮换'].map((x) => `<option ${m.pov === x ? 'selected' : ''}>${x}</option>`).join('')}
          </select>
        </label>
        <label class="field-label">时态
          <select class="input" data-key="tense">
            ${['过去时', '现在时'].map((x) => `<option ${m.tense === x ? 'selected' : ''}>${x}</option>`).join('')}
          </select>
        </label>
        <label class="field-label">目标平台
          <input class="input" data-key="platform" value="${esc(m.platform || '')}" placeholder="番茄 / 起点 / 出版向" />
        </label>
      </div>
      <div class="grid2">
        ${field('整体基调', 'tone', m, { ph: '冷硬、热血、诙谐、压抑……' })}
        <label class="field-label">每章目标字数
          <input class="input" type="number" data-key="targetWordsPerChapter" value="${m.targetWordsPerChapter || 3000}" />
        </label>
      </div>
      <div class="grid2 goal-set">
        <label class="field-label">全书目标字数<span class="field-hint">留空表示不定</span>
          <input class="input" type="number" data-key="targetWords" value="${m.targetWords || ''}" placeholder="例：300000" min="0" step="10000" list="goalPresets" />
          <datalist id="goalPresets">
            ${[50000, 100000, 200000, 300000, 500000].map((v) => `<option value="${v}"></option>`).join('')}
          </datalist>
        </label>
        <div>
          <span class="field-label">常见长度</span>
          <div class="btn-row wrap">
            ${[50000, 100000, 200000, 300000, 500000].map((v) => `<button type="button" class="btn btn-sm" data-goal="${v}">${fmtGoal(v)}</button>`).join('')}
            <button type="button" class="btn btn-sm btn-text" data-goal="0">不设</button>
          </div>
          <p class="dim small goal-hint" id="goalHint"></p>
        </div>
      </div>
      ${field('文风要求（会逐字进入提示词）', 'styleNotes', m, { area: true, rows: 4, ph: '例：多用短句与白描，对白占比高，不用网络梗，战斗节奏快，心理描写点到即止。' })}
      ${field('去 AI 味补充规则（在默认负面清单之上追加）', 'antiAiNotes', m, { area: true, rows: 3, ph: '例：禁止出现「嘴角勾起一抹弧度」；禁止用「仿佛」开头的比喻句。' })}
      ${field('禁忌：绝对不能出现的内容', 'taboos', m, { area: true, rows: 2, ph: '例：不写露骨暴力；不出现现实政治人物。' })}
      ${field('其他硬性要求', 'extraRules', m, { area: true, rows: 2, ph: '例：每章结尾必须留悬念；重要配角死亡前必须提前两章铺垫。' })}
      <label class="field-label">上下文预算（字符）
        <input class="input" type="number" data-key="contextBudget" value="${m.contextBudget || 26000}" style="max-width:180px" />
      </label>
      <p class="dim small">每次生成注入的资料上限。写长篇时建议 30000～50000。</p>
    </div>
    <div class="bible-block">
      <h2>风格参考
        <span style="flex:1"></span>
        <button class="btn btn-sm" id="addRef">${ico('plus')}添加</button>
      </h2>
      <p class="dim small">写清楚「学谁的什么」，比笼统要求「要有文采」有用得多。</p>
      <div class="entry-list" id="refList"></div>
    </div>`;
  bindFields(host, m, () => saveNovelPart({ meta: n.meta }), ['targetWordsPerChapter', 'contextBudget', 'targetWords']);
  // 全书目标：给几个常见长度，并按每章字数反推大概要写多少章
  {
    const input = host.querySelector('[data-key="targetWords"]');
    const hint = host.querySelector('#goalHint');
    const perCh = Math.max(0, Number(m.targetWordsPerChapter) || 0);
    const updateHint = () => {
      const target = Math.floor(Number(input.value) || 0);
      const words = (n.chapters || []).reduce((s, c) => s + wordsOf(c), 0);
      if (!target) { hint.textContent = '不定目标也可以写；这里只是给你看进度。'; return; }
      const need = perCh ? Math.ceil(target / perCh) : 0;
      const have = (n.chapters || []).length;
      const pct = Math.min(100, Math.round((words / target) * 100));
      const left = Math.max(0, target - words);
      const g = { target, words, pct, left, done: words >= target };
      const est = finishEstimate(g, S.stats);
      hint.textContent = `已写 ${fmtWords(words)} 字（${pct}%）`
        + (need ? `；按每章 ${fmtWords(perCh)} 字算，大约要写 ${need} 章，现在 ${have} 章` : '')
        + (est?.days ? `。${daysPhrase(est.days)}，预计 ${datePhrase(est.date)}完稿` : est && !est.done ? '。最近没动笔，算不出还要多久' : '');
    };
    // 顶栏标签和书架卡片上的进度条要跟着变
    const syncUI = () => {
      const item = S.novels.find((x) => x.id === n.id);
      if (item) item.targetWords = Math.floor(Number(input.value) || 0);
      renderTopbarActions();
      if (S.view === 'shelf') renderShelf();
    };
    updateHint();
    input.addEventListener('input', () => { updateHint(); syncUI(); });
    host.querySelectorAll('[data-goal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        input.value = btn.dataset.goal === '0' ? '' : btn.dataset.goal;
        m.targetWords = Number(input.value) || 0;
        saveNovelPart({ meta: n.meta });
        updateHint();
        syncUI();
      });
    });
  }
  $$('select[data-key]', host).forEach((el) => el.addEventListener('change', () => {
    m[el.dataset.key] = el.value;
    saveNovelPart({ meta: n.meta });
  }));

  const rl = $('#refList', host);
  m.styleRefs = m.styleRefs || [];
  if (!m.styleRefs.length) rl.innerHTML = '<p class="dim">还没有参考。</p>';
  m.styleRefs.forEach((r, i) => {
    const div = document.createElement('div');
    div.className = 'entry';
    div.innerHTML = `<div class="entry-head">
        <input class="input" data-rk="name" value="${esc(r.name || '')}" placeholder="参考作品 / 作者名" style="max-width:240px;font-weight:600" />
        <input class="input" data-rk="notes" value="${esc(r.notes || '')}" placeholder="学它什么：节奏 / 对白 / 意象 / 悬念处理" />
        <button class="del" title="删除">${ico('trash')}</button>
      </div>`;
    div.querySelectorAll('[data-rk]').forEach((el) => el.addEventListener('input', () => {
      r[el.dataset.rk] = el.value;
      saveNovelPart({ meta: n.meta });
    }));
    div.querySelector('.del').onclick = () => {
      m.styleRefs.splice(i, 1);
      renderBible();
      saveNovelPart({ meta: n.meta });
    };
    rl.appendChild(div);
  });
  $('#addRef', host).onclick = () => {
    m.styleRefs.push({ name: '', notes: '' });
    renderBible();
    saveNovelPart({ meta: n.meta });
  };
}

/* ============================================================
 * 10. 设置
 * ============================================================ */
const PRESETS = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'], keyUrl: 'https://platform.deepseek.com/api_keys' },
  { name: '阿里通义', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max', 'qwen-long'] },
  { name: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-32k'], keyUrl: 'https://platform.moonshot.cn/console/api-keys' },
  { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus', 'glm-4-air'], keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
  { name: '火山方舟（豆包）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-pro-32k'] },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini'], keyUrl: 'https://platform.openai.com/api-keys' },
  { name: 'Ollama 本地', baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen2.5:14b'] },
];

/* ---------------- 稿纸排版 ---------------- */
// 只作用于写作页正文（#chContent）；阅读模式有自己的字号，互不影响。
let paperPref = { ...PAPER_DEFAULTS };

/** 把排版挂到 body 的 CSS 变量上，设置页的控件与预览跟着同步 */
function applyPaper(pref = paperPref) {
  paperPref = normalizePaper(pref);
  for (const [k, v] of Object.entries(paperVars(paperPref))) document.body.style.setProperty(k, v);
  syncPaperControls();
  return paperPref;
}

// 改一项就落盘，连续拖动滑块时只发最后一次
const savePaper = debounce(() => {
  S.config = S.config || {};
  S.config.ui = { ...(S.config.ui || {}), editor: { ...paperPref } };
  api.send('/api/config', { ui: { editor: { ...paperPref } } }).catch(() => {});
}, 500);

function setPaper(patch, msg = '') {
  applyPaper({ ...paperPref, ...patch });
  savePaper();
  if (msg) toast(msg, 'ok');
}

function syncPaperControls() {
  const sizeEl = $('#paperSize');
  if (!sizeEl) return;
  sizeEl.value = String(paperPref.size);
  $('#paperSizeVal').textContent = `${paperPref.size} px`;
  $$('#paperLh button').forEach((b) => b.classList.toggle('on', Number(b.dataset.lh) === paperPref.lh));
  $$('#paperFont button').forEach((b) => b.classList.toggle('on', b.dataset.font === paperPref.font));
  $('#paperHint').textContent = paperLabel(paperPref);
  updatePaperSample();
}

/** 更新稿纸样本预览：同步字号、行距、字体 */
function updatePaperSample() {
  const sample = $('#paperSample');
  if (!sample) return;
  const vars = paperVars(paperPref);
  for (const [k, v] of Object.entries(vars)) sample.style.setProperty(k, v);
}

/** 快捷放大 / 缩小；到头给个提示，别让人以为坏了 */
function paperStep(delta) {
  const next = nextPaperSize(paperPref.size, delta);
  if (next === paperPref.size) return toast(`稿纸字号已经${delta > 0 ? '最大' : '最小'}（${next} px）`);
  setPaper({ size: next }, `稿纸字号 ${next} px`);
}

function paperReset() {
  setPaper(PAPER_DEFAULTS, '稿纸已恢复默认');
}

$('#paperSize').addEventListener('input', (e) => setPaper({ size: Number(e.target.value) }));
$$('#paperLh button').forEach((b) => b.addEventListener('click', () => setPaper({ lh: Number(b.dataset.lh) })));
$$('#paperFont button').forEach((b) => b.addEventListener('click', () => setPaper({ font: b.dataset.font })));
$('#paperReset').addEventListener('click', paperReset);

function renderSettings() {
  const cfg = S.config;
  if (!cfg) return;
  const host = $('#providerList');
  if (!cfg.providers) cfg.providers = [];
  host.innerHTML = '';
  if (!cfg.providers.length) host.innerHTML = `<div class="empty-line">${ico('spark')}<span>还没有服务商 —— 点下面的预设一键添加，或「添加服务商」手动填写。密钥只留在本机。</span></div>`;
  cfg.providers.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'provider';
    div.innerHTML = `
      <div class="provider-top">
        <input class="input" data-pk="name" value="${esc(p.name || '')}" placeholder="名称" style="max-width:180px" />
        <label class="radio-pill" title="设为默认使用的服务商">
          <input type="radio" name="activeProvider" ${cfg.activeProviderId === p.id ? 'checked' : ''} data-active="1" /> 默认
        </label>
        <span style="flex:1"></span>
        <button class="btn btn-sm" data-act="test">测试连接</button>
        <button class="icon-btn sm" data-act="del" title="删除该服务商" aria-label="删除该服务商">${ico('trash')}</button>
      </div>
      <div class="grid2">
        <label class="field-label">Base URL<input class="input" data-pk="baseUrl" value="${esc(p.baseUrl || '')}" placeholder="https://api.deepseek.com/v1" /></label>
        <label class="field-label">API Key
          <input class="input" data-pk="apiKey" type="password" placeholder="${p.apiKeySet ? `已保存（${esc(p.apiKeyMasked)}），留空不修改` : 'sk-...'}" />
        </label>
      </div>
      <label class="field-label">已知模型<span class="field-hint">逗号分隔，可留空由接口拉取</span></label>
      <input class="input" data-pk="models" value="${esc((p.models || []).join(', '))}" />
      <div class="dim-text status-msg" data-msg></div>`;
    div.querySelectorAll('[data-pk]').forEach((el) => el.addEventListener('input', () => {
      const k = el.dataset.pk;
      if (k === 'models') p.models = el.value.split(/[,，\n]/).map((x) => x.trim()).filter(Boolean);
      else p[k] = el.value;
    }));
    div.querySelector('[data-active]').addEventListener('change', () => {
      cfg.activeProviderId = p.id;
      saveConfig();
    });
    div.querySelector('[data-act="test"]').onclick = async () => {
      const msg = div.querySelector('[data-msg]');
      msg.className = 'status-err';
      msg.textContent = '正在连接…';
      await saveConfig();
      try {
        const r = await api.send('/api/config/models', {
          providerId: p.id,
          baseUrl: p.baseUrl,
          apiKey: div.querySelector('[data-pk="apiKey"]').value,
        });
        if (r.ok) {
          msg.className = 'status-ok';
          msg.textContent = `连接成功，可用模型 ${r.models.length} 个：${r.models.slice(0, 8).join(', ')}${r.models.length > 8 ? ' …' : ''}`;
          if (r.models.length) {
            p.models = r.models;
            div.querySelector('[data-pk="models"]').value = r.models.join(', ');
            await saveConfig();
          }
          renderModelSelect();
        } else {
          msg.textContent = `连接失败：${r.error}`;
        }
      } catch (err) { msg.textContent = err.message; }
    };
    div.querySelector('[data-act="del"]').onclick = () => {
      if (!confirm(`删除服务商「${p.name || p.baseUrl}」？`)) return;
      cfg.providers.splice(i, 1);
      if (cfg.activeProviderId === p.id) cfg.activeProviderId = cfg.providers[0]?.id || '';
      renderSettings();
    };
    host.appendChild(div);
  });

  $('#presetRow').innerHTML = `快速添加：${PRESETS.map((x, i) => `<button data-preset="${i}">${esc(x.name)}</button>`).join('')}`;
  $$('#presetRow button').forEach((b) => b.addEventListener('click', () => {
    const pre = PRESETS[Number(b.dataset.preset)];
    const id = uid('p');
    cfg.providers.push({ id, name: pre.name, baseUrl: pre.baseUrl, models: pre.models, apiKey: '' });
    if (!cfg.activeProviderId) cfg.activeProviderId = id;
    if (!cfg.model) cfg.model = pre.models[0];
    renderSettings();
  }));

  $('#cfgTemp').value = cfg.temperature ?? 0.85;
  $('#tempVal').textContent = $('#cfgTemp').value;
  $('#cfgMaxTokens').value = cfg.maxTokens || 4096;
  $('#cfgBudget').value = S.novel?.meta?.contextBudget || 26000;
  $('#roleWrite').value = cfg.roleModels?.write || '';
  $('#roleSummary').value = cfg.roleModels?.summary || '';
  $('#roleReview').value = cfg.roleModels?.review || '';
  renderModelSelect();
  renderModelStatus();
  renderPromptTemplatesInSettings();
}

/* ============================================================
 * AI 提示词模板管理
 * ============================================================ */


/* 提示词管理状态 */
let currentPromptTask = 'chapter';
// 服务端下发的可定制任务清单：{ key, task, label, vars }
// 与 server/prompts.js 的 TEMPLATE_SLOTS 是同一份，避免两边对不上
let promptSlots = [];
let promptVarList = [];

async function initPromptTemplates() {
  // 从配置加载自定义模板
  if (!S.config.promptTemplates) {
    S.config.promptTemplates = {};
  }
  // 任务清单从服务端取，保证「下拉框里有的」与「真正能生效的」永远一致
  try {
    const r = await api.get('/api/prompt-slots');
    promptSlots = Array.isArray(r?.slots) ? r.slots : [];
    promptVarList = Array.isArray(r?.vars) ? r.vars : [];
  } catch {
    promptSlots = [];
    promptVarList = [];
  }
}

// 模板里的 ${变量} 说明，给用户一个可点的清单
function varHintText(vars) {
  const names = vars?.length ? vars : promptVarList.map((v) => v.key);
  if (!names.length) return '可用变量：（暂无）';
  const desc = Object.fromEntries(promptVarList.map((v) => [v.key, v.desc]));
  return `可用变量：${names.map((n) => `${n}（${desc[n] || ''}）`).join('、')}`;
}

function renderPromptTemplateUI() {
  const select = $('#promptTaskSelect');
  const systemEl = $('#promptSystem');
  const userEl = $('#promptUser');
  const varsEl = $('#promptVars');

  // 填充下拉框：用服务端的清单，键是模板在 config 里的键
  const keys = promptSlots.map((s) => s.key);
  const current = select.value;
  select.innerHTML = keys.map((key) => {
    const slot = promptSlots.find((s) => s.key === key);
    const label = slot?.label || key;
    return `<option value="${esc(key)}">${esc(label)}</option>`;
  }).join('');
  if (keys.includes(current)) select.value = current;

  const taskKey = select.value || 'chapter';
  currentPromptTask = taskKey;
  const slot = promptSlots.find((s) => s.key === taskKey);
  const custom = S.config.promptTemplates?.[taskKey];
  // 没有自定义模板时留空：留空 = 用内置模板，方便一眼看出「我没改过」
  systemEl.value = custom?.system || '';
  userEl.value = custom?.user || '';
  varsEl.textContent = varHintText(slot?.vars);
}

function savePromptTemplate() {
  const taskKey = $('#promptTaskSelect').value;
  const system = $('#promptSystem').value.trim();
  const user = $('#promptUser').value.trim();

  if (!system && !user) {
    // 如果都为空，删除自定义模板（恢复默认）
    if (S.config.promptTemplates) delete S.config.promptTemplates[taskKey];
  } else {
    if (!S.config.promptTemplates) S.config.promptTemplates = {};
    S.config.promptTemplates[taskKey] = { system, user };
  }
  saveConfig();
  $('#promptMsg').textContent = '已保存';
  setTimeout(() => { $('#promptMsg').textContent = ''; }, 2000);
  toast(`已保存 ${taskKey} 模板`, 'ok');
}

function resetPromptTemplate() {
  const taskKey = $('#promptTaskSelect').value;
  if (S.config.promptTemplates) delete S.config.promptTemplates[taskKey];
  saveConfig();
  renderPromptTemplateUI();
  $('#promptMsg').textContent = '已恢复默认';
  setTimeout(() => { $('#promptMsg').textContent = ''; }, 2000);
  toast(`已恢复 ${taskKey} 默认模板`, 'ok');
}

// 事件绑定
$('#promptTaskSelect')?.addEventListener('change', renderPromptTemplateUI);
$('#savePromptBtn')?.addEventListener('click', savePromptTemplate);
$('#resetPromptBtn')?.addEventListener('click', resetPromptTemplate);

// 在 renderSettings 最后调用渲染（此时 S.config 已加载）
async function renderPromptTemplatesInSettings() {
  await initPromptTemplates();
  renderPromptTemplateUI();
}

/* 预览当前模板渲染后的实际提示词：走服务端的 /api/context，
   用的就是真正发模型的那套组装逻辑，所见即所得。 */
async function previewPromptTemplate() {
  const taskKey = $('#promptTaskSelect').value;
  const slot = promptSlots.find((s) => s.key === taskKey);
  if (!slot) return toast('这个任务不支持自定义提示词', 'err');
  // 未保存的编辑内容也一并预览
  const draft = {
    system: $('#promptSystem').value.trim(),
    user: $('#promptUser').value.trim(),
  };
  const body = {
    task: slot.task,
    templateKey: slot.key,
    customTemplates: draft.system || draft.user ? { [slot.key]: draft } : {},
    novelId: S.novel?.id,
    chapterId: S.chapterId,
    payload: { targetWords: 800, instruction: '（这里填作者给的要求）', text: '（这里是被处理的原文）' },
  };
  try {
    const r = await api.send('/api/context', body, 'POST');
    const msgs = (r?.messages || []).map((m) => `【${m.role === 'system' ? '系统' : '用户'}】\n${m.content}`).join('\n\n');
    showModal(`<h3>提示词预览 · ${esc(slot.label || slot.key)}</h3>
      <p class="modal-sub">这是变量替换后的实际内容，与发给模型的完全一致。</p>
      <pre class="ctx-preview">${esc(msgs)}</pre>
      <div class="modal-foot"><button class="btn btn-primary" id="pvClose">关闭</button></div>`,
      (box) => { box.querySelector('#pvClose').onclick = closeModal; });
  } catch (err) {
    toast(`预览失败：${err.message}`, 'err');
  }
}
$('#previewPromptBtn')?.addEventListener('click', previewPromptTemplate);

/* ============================================================
 * 提示词模板导出/导入
 * ------------------------------------------------------------
 * 模板存在 config.json 里（不是作品里），所以导出的是「模板包」：
 * 可以整套带走，也可以只带某一个任务，方便在不同作品/项目之间复用。
 * ============================================================ */

const TEMPLATE_PKG_VERSION = 1;

// 收集当前所有自定义模板（只导用户改过的，内置模板不重复导出）
function collectCustomTemplates() {
  const all = S.config?.promptTemplates || {};
  const out = {};
  for (const [key, tpl] of Object.entries(all)) {
    const system = typeof tpl?.system === 'string' ? tpl.system : '';
    const user = typeof tpl?.user === 'string' ? tpl.user : '';
    if (system || user) out[key] = { system, user };
  }
  return out;
}

function templateSlotLabel(key) {
  return promptSlots.find((s) => s.key === key)?.label || key;
}

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportTemplatesAsJson(onlyKey) {
  const all = collectCustomTemplates();
  const templates = onlyKey ? (all[onlyKey] ? { [onlyKey]: all[onlyKey] } : {}) : all;
  const keys = Object.keys(templates);
  if (!keys.length) return toast(onlyKey ? '这个任务还没有自定义模板' : '还没有任何自定义模板', 'err');
  const pkg = {
    kind: 'prompt-templates',
    version: TEMPLATE_PKG_VERSION,
    exportedAt: Date.now(),
    templates,
  };
  const name = onlyKey
    ? `提示词模板_${templateSlotLabel(onlyKey)}_${new Date().toISOString().slice(0, 10)}.json`
    : `提示词模板_全部_${new Date().toISOString().slice(0, 10)}.json`;
  downloadText(name, JSON.stringify(pkg, null, 2), 'application/json');
  toast(`已导出 ${keys.length} 个模板为 JSON`, 'ok');
}

function exportTemplatesAsMarkdown(onlyKey) {
  const all = collectCustomTemplates();
  const templates = onlyKey ? (all[onlyKey] ? { [onlyKey]: all[onlyKey] } : {}) : all;
  const keys = Object.keys(templates);
  if (!keys.length) return toast(onlyKey ? '这个任务还没有自定义模板' : '还没有任何自定义模板', 'err');
  let md = '# 提示词模板导出\n\n';
  md += `> 导出时间：${new Date().toLocaleString()}  \n`;
  md += `> 共 ${keys.length} 个任务  \n\n`;
  for (const key of keys) {
    md += `## ${templateSlotLabel(key)}（\`${key}\`）\n\n`;
    const slot = promptSlots.find((s) => s.key === key);
    if (slot?.vars?.length) md += `可用变量：${slot.vars.map((v) => `\`${v}\``).join('、')}\n\n`;
    if (templates[key].system) {
      md += '### 系统提示词\n\n```\n' + templates[key].system + '\n```\n\n';
    }
    if (templates[key].user) {
      md += '### 用户提示词\n\n```\n' + templates[key].user + '\n```\n\n';
    }
  }
  const name = onlyKey
    ? `提示词模板_${templateSlotLabel(onlyKey)}_${new Date().toISOString().slice(0, 10)}.md`
    : `提示词模板_全部_${new Date().toISOString().slice(0, 10)}.md`;
  downloadText(name, md, 'text/markdown');
  toast(`已导出 ${keys.length} 个模板为 Markdown`, 'ok');
}

// 解析模板包：兼容两种形状 —— {kind,version,templates} 或直接 {key:{system,user}}
function parseTemplatePackage(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { throw new Error('JSON 解析失败：' + e.message); }
  if (!obj || typeof obj !== 'object') throw new Error('不是有效的模板文件');
  let templates = obj.templates;
  if (!templates && obj.kind === 'prompt-templates') templates = {};
  if (!templates) {
    // 旧格式：直接把 {key: {system,user}} 当作模板表
    templates = Object.fromEntries(
      Object.entries(obj).filter(([k, v]) => v && typeof v === 'object' && ('system' in v || 'user' in v))
    );
  }
  if (!templates || typeof templates !== 'object') throw new Error('文件里没有找到模板');
  const clean = {};
  for (const [key, tpl] of Object.entries(templates)) {
    if (!tpl || typeof tpl !== 'object') continue;
    const system = typeof tpl.system === 'string' ? tpl.system : '';
    const user = typeof tpl.user === 'string' ? tpl.user : '';
    if (system || user) clean[key] = { system, user };
  }
  if (!Object.keys(clean).length) throw new Error('文件里没有可导入的模板');
  return clean;
}

async function applyTemplatePackage(templates, { merge = true, overwrite = false } = {}) {
  const cur = { ...(S.config.promptTemplates || {}) };
  let added = 0, updated = 0, skipped = 0;
  for (const [key, tpl] of Object.entries(templates)) {
    if (cur[key]) {
      if (overwrite) { cur[key] = tpl; updated++; }
      else if (merge) {
        // 合并：只补齐缺失的字段，不动用户已经写好的部分
        cur[key] = {
          system: cur[key].system || tpl.system,
          user: cur[key].user || tpl.user,
        };
        updated++;
      } else skipped++;
    } else {
      cur[key] = tpl;
      added++;
    }
  }
  S.config.promptTemplates = cur;
  await saveConfig();
  renderPromptTemplateUI();
  return { added, updated, skipped };
}

$('#promptExportBtn')?.addEventListener('click', () => {
  const custom = collectCustomTemplates();
  const customKeys = Object.keys(custom);
  showModal(`<h3>导出提示词模板</h3>
    <p class="modal-sub">导出你自己改写过的提示词，便于在不同作品、不同项目之间复用。内置模板不会被导出。</p>
    <div class="field-label" style="margin-top:8px"><strong>整套导出</strong></div>
    <div class="field-row" style="margin-top:8px">
      <button class="btn btn-primary" id="tplExpJson">${ico('download')} 导出全部 JSON</button>
      <button class="btn btn-sm btn-text" id="tplExpMd">${ico('file-text')} 导出全部 Markdown</button>
    </div>
    <div class="field-label" style="margin-top:16px"><strong>单个导出</strong></div>
    <div class="fragment-grid" id="tplExportGrid"></div>
    <div class="modal-foot"><button class="btn btn-text" id="tplExpCancel">取消</button></div>`,
  (box) => {
    const grid = box.querySelector('#tplExportGrid');
    grid.innerHTML = promptSlots.map((s) => {
      const has = !!custom[s.key];
      return `
      <div class="frag-card">
        <div class="frag-label">${esc(s.label)}</div>
        <div class="dim small" style="margin-bottom:4px">${has ? '已自定义' : '未自定义'}</div>
        <div class="frag-actions">
          <button class="btn btn-sm btn-text" data-key="${s.key}" data-fmt="json" ${has ? '' : 'disabled'}>${ico('download')} JSON</button>
          <button class="btn btn-sm btn-text" data-key="${s.key}" data-fmt="md" ${has ? '' : 'disabled'}>${ico('file-text')} MD</button>
        </div>
      </div>`;
    }).join('');
    grid.querySelectorAll('button[data-key]').forEach((btn) => {
      btn.onclick = () => {
        closeModal();
        if (btn.dataset.fmt === 'json') exportTemplatesAsJson(btn.dataset.key);
        else exportTemplatesAsMarkdown(btn.dataset.key);
      };
    });
    box.querySelector('#tplExpJson').onclick = () => { closeModal(); exportTemplatesAsJson(); };
    box.querySelector('#tplExpMd').onclick = () => { closeModal(); exportTemplatesAsMarkdown(); };
    box.querySelector('#tplExpCancel').onclick = closeModal;
  });
});

$('#promptImportBtn')?.addEventListener('click', () => {
  showModal(`<h3>导入提示词模板</h3>
    <p class="modal-sub">选择 JSON 文件导入。合并模式只补齐缺失内容，不覆盖你已写的模板；覆盖模式会替换同名模板。</p>
    <div class="field-label">导入模式
      <select class="select" id="tplImpMode" style="margin-top:5px">
        <option value="merge">合并（保留现有，只补缺失）</option>
        <option value="overwrite">覆盖（替换同名模板）</option>
      </select>
    </div>
    <div class="field-label" style="margin-top:10px">选择文件
      <input type="file" id="tplImpFile" accept=".json,application/json" style="margin-top:5px" />
    </div>
    <div class="modal-foot">
      <button class="btn btn-primary" id="tplImpOk">导入</button>
      <button class="btn btn-text" id="tplImpCancel">取消</button>
    </div>`,
  (box) => {
    const fileInput = box.querySelector('#tplImpFile');
    const modeSelect = box.querySelector('#tplImpMode');
    box.querySelector('#tplImpCancel').onclick = closeModal;
    box.querySelector('#tplImpOk').onclick = async () => {
      const file = fileInput.files?.[0];
      if (!file) return toast('请选择文件', 'err');
      let templates;
      try {
        templates = parseTemplatePackage(await file.text());
      } catch (e) {
        return toast(`导入失败：${e.message}`, 'err');
      }
      closeModal();
      const overwrite = modeSelect.value === 'overwrite';
      try {
        const r = await applyTemplatePackage(templates, { merge: !overwrite, overwrite });
        const parts = [];
        if (r.added) parts.push(`新增 ${r.added}`);
        if (r.updated) parts.push(`${overwrite ? '覆盖' : '合并'} ${r.updated}`);
        if (r.skipped) parts.push(`跳过 ${r.skipped}`);
        toast(`已导入模板：${parts.join('，') || '无变化'}`, 'ok');
      } catch (e) {
        toast(`导入失败：${e.message}`, 'err');
      }
    };
  });
});

function renderModelSelect() {
  const cfg = S.config;
  const models = new Set();
  (cfg.providers || []).forEach((p) => (p.models || []).forEach((m) => models.add(m)));
  const sel = $('#cfgModel');
  const opts = Array.from(models).map((m) => `<option ${cfg.model === m ? 'selected' : ''}>${esc(m)}</option>`).join('');
  sel.innerHTML = `<option value="">（未设置）</option>${opts}`;
  if (cfg.model && !models.has(cfg.model)) sel.innerHTML += `<option selected>${esc(cfg.model)}</option>`;
}

/** 在模型服务卡里说明当前到底用哪个模型：只看「明确选过」的模型 */
function renderModelStatus() {
  const row = $('#currentModelRow');
  if (!row) return;
  const ready = quickStartModel();
  if (!ready) {
    row.innerHTML = `<div class="current-model-info"><span class="current-model-label">当前写作模型</span><span class="current-model-name">还没接上</span></div><button class="btn btn-sm" id="currentModelConnect">先接一个</button>`;
  } else {
    row.innerHTML = `<div class="current-model-info"><span class="current-model-label">当前写作模型</span><span class="current-model-value"><b>${esc(ready.model)}</b><span class="dim"> · ${esc(ready.providerName)}</span></span></div><button class="btn btn-sm" id="currentModelConnect">换一个</button>`;
  }
  row.querySelector('#currentModelConnect')?.addEventListener('click', () => {
    openModelSetup(ready ? {
      introTitle: '换一个写作模型',
      introText: '换模型会影响接下来生成的质量、速度和费用。选好后保存，这个模型会用于写作和大纲生成。',
      modelTitle: '选一个模型',
      saveLabel: '保存，用这个模型',
      // 换模型时一定要打开选择器，不能因为现在的配置能用就跳过
      isReady: () => false,
      onReady: renderSettings,
      onCancel: () => toast('没有换模型'),
    } : {
      introTitle: '先接入写作模型',
      introText: '接一次，以后写作、续写和大纲生成都能直接用。不用先去设置页摸一圈。',
      modelTitle: '选一个模型',
      saveLabel: '保存，继续',
      // 这里是来接模型的，ready 反而是 false，不能跳过
      isReady: () => false,
      onReady: renderSettings,
      onCancel: () => toast('还没接上，这次没有开始接入'),
    });
  });
}

$('#cfgTemp').addEventListener('input', () => { $('#tempVal').textContent = $('#cfgTemp').value; });
$('#addProviderBtn').addEventListener('click', () => {
  const p = { id: uid('p'), name: '新服务商', baseUrl: '', apiKey: '', models: [] };
  S.config.providers.push(p);
  if (!S.config.activeProviderId) S.config.activeProviderId = p.id;
  renderSettings();
});

/** 保存前去掉只读字段，别把 apiKeyMasked / apiKeySet 写回 config.json */
function configForSave(cfg) {
  return {
    ...cfg,
    providers: (cfg.providers || []).map((p) => {
      const next = { ...p };
      delete next.apiKeyMasked;
      delete next.apiKeySet;
      return next;
    }),
  };
}

async function saveConfig() {
  const cfg = S.config;
  cfg.temperature = Number($('#cfgTemp').value);
  cfg.maxTokens = Number($('#cfgMaxTokens').value) || 4096;
  cfg.model = $('#cfgModel').value || cfg.model;
  cfg.roleModels = {
    write: $('#roleWrite').value.trim(),
    summary: $('#roleSummary').value.trim(),
    review: $('#roleReview').value.trim(),
  };
  // 保存提示词模板
  cfg.promptTemplates = cfg.promptTemplates || {};
  const budget = Number($('#cfgBudget').value) || 26000;
  if (S.novel && S.novel.meta.contextBudget !== budget) {
    S.novel.meta.contextBudget = budget;
    api.put(`/api/novels/${S.novel.id}`, { meta: S.novel.meta }).catch(() => {});
  }
  await api.send('/api/config', configForSave(cfg));
  S.config = await api.get('/api/config');
}
$('#saveCfgBtn').addEventListener('click', async () => {
  await saveConfig();
  $('#cfgMsg').textContent = '已保存';
  setTimeout(() => { $('#cfgMsg').textContent = ''; }, 2000);
  toast('设置已保存', 'ok');
});

$('#analyzeStyleBtn').addEventListener('click', async () => {
  const text = $('#styleSample').value.trim();
  if (!text) return toast('先粘贴一段样本', 'err');
  const out = await runStream({ task: 'style', payload: { text, templateKey: 'analyzeStyle' } });
  if (!out.trim()) return;
  S.styleDraft = `${out}\n\n`;
  $('#styleBox').innerHTML = mdLite(out);
  $('#applyStyleBtn').hidden = !S.novel;
});
$('#applyStyleBtn').addEventListener('click', async () => {
  if (!S.styleDraft || !S.novel) return;
  const cur = S.novel.meta.styleNotes || '';
  S.novel.meta.styleNotes = (cur ? `${cur}\n\n` : '') + S.styleDraft;
  await api.put(`/api/novels/${S.novel.id}`, { meta: S.novel.meta });
  $('#styleBox').innerHTML += '<div class="status-ok">已写入当前作品的文风要求。</div>';
  toast('已写入文风档案', 'ok');
});
$('#openDataBtn').addEventListener('click', () => {
  showModal(`<h3>数据目录</h3>
    <p>所有作品都是纯 JSON 文件，位置：</p>
    <pre class="ctx-preview">data\\novels\\</pre>
    <p class="dim small">在项目根目录下。复制整个 data 目录即可完成备份或迁移；API Key 保存在 data\\config.json。</p>
    <div class="modal-foot"><button class="btn btn-primary" id="odClose">知道了</button></div>`,
    (box) => { box.querySelector('#odClose').onclick = closeModal; });
});

/* ============================================================
 * 11. 导入 / 导出
 * ============================================================ */
const IMPORT_LIMIT = 20 * 1024 * 1024;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const isTextFile = (f) => !!f && (/\.(txt|md|markdown)$/i.test(f.name) || /^text\//i.test(f.type || ''));
const isDocxFile = (f) => !!f && (/\.docx$/i.test(f.name || '') || f.type === DOCX_MIME);
const isImportFile = (f) => isTextFile(f) || isDocxFile(f);
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

/**
 * 读文本文件并判断编码。浏览器没有内置「猜编码」，但可以用 fatal 模式试 UTF-8：
 * 合法就是 UTF-8，抛错就按 GB18030（兼容 GBK）解。带 BOM 的直接按 BOM 来。
 */
async function readTextFile(file) {
  if (file.size > IMPORT_LIMIT) throw new Error(`文件有 ${fmtSize(file.size)}，超过 20 MB，建议先在编辑器里拆成几份`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), enc: 'UTF-8（带 BOM）' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), enc: 'UTF-16 LE' };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), enc: 'UTF-16 BE' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), enc: 'UTF-8' };
  } catch {
    // 不是合法 UTF-8，按中文旧稿最常见的 GBK / GB18030 解
  }
  try {
    return { text: new TextDecoder('gb18030').decode(bytes), enc: 'GB18030 / GBK' };
  } catch {
    return { text: new TextDecoder('utf-8').decode(bytes), enc: 'UTF-8（有无法识别的字符）' };
  }
}

/** Word 只上传到本机服务解析，原文不经过任何第三方 */
async function readDocxFile(file) {
  if (file.size > IMPORT_LIMIT) {
    throw new Error(`Word 文件有 ${fmtSize(file.size)}，超过 20 MB，建议先在 Word 里拆成几份`);
  }
  try {
    return await api.upload('/api/import/docx', file);
  } catch (err) {
    if (err?.name === 'TypeError') throw new Error('连不上本地服务（请确认 启动.bat 的窗口还开着）');
    throw err;
  }
}

function openImportModal(file) {
  if (!S.novel) return toast('先打开作品', 'err');
  const more = S.novel.chapters.length ? '追加到现有章节末尾' : '作为这本书的第一批章节';
  showModal(`<h3>导入已有文稿</h3>
    <p class="modal-sub">导入到《${esc(S.novel.title)}》：支持 .txt / .md / .docx，自动识别文本编码；Word 稿按段落还原。按「第X章」切分，按「第X卷」分组，${more}。</p>
    <div class="import-drop" id="impDrop" title="选择文件，或把文件拖到这里" role="button" tabindex="0">
      ${ico('upload')}
      <div><b>选择文件</b><span class="dim">或拖到这里</span></div>
      <div class="import-file" id="impFileInfo">.txt / .md / .docx · 最大 20 MB</div>
      <input type="file" id="impFile" accept=".txt,.md,.markdown,.docx,text/plain,text/markdown,${DOCX_MIME}" hidden>
    </div>
    <label class="field-label">也可以直接粘贴
      <textarea id="impText" class="input" placeholder="第一章 落霜&#10;&#10;正文……&#10;&#10;第二章 归途&#10;&#10;正文……"></textarea>
    </label>
    <div class="import-note dim small" id="impNote" hidden></div>
    <label class="find-check" id="impFrontWrap" style="margin-top:8px" hidden><input type="checkbox" id="impFront" /> 连开头的前置内容一起导入（书名页 / 创作说明）</label>
    <div class="modal-foot"><button class="btn btn-text" id="impCancel">取消</button><button class="btn btn-primary" id="impOk">导入</button></div>`,
    (box) => {
      const drop = box.querySelector('#impDrop');
      const input = box.querySelector('#impFile');
      const ta = box.querySelector('#impText');
      const info = box.querySelector('#impFileInfo');
      const note = box.querySelector('#impNote');
      const frontWrap = box.querySelector('#impFrontWrap');
      const frontBox = box.querySelector('#impFront');
      let docxState = null;

      const resetDocx = () => {
        docxState = null;
        frontWrap.hidden = true;
        frontBox.checked = false;
      };

      const updateDocxNote = () => {
        if (!docxState) return;
        const { meta: r } = docxState;
        const paraCount = ta.value.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean).length;
        const headings = (r.headings || 0) + (frontBox.checked ? (r.frontMatterHeadings || 0) : 0);
        const bits = ['Word 稿', `${paraCount} 段`, `${fmtWords(countWords(ta.value))} 字`];
        if (headings) bits.push(`${headings} 个标题`);
        if (r.deleted) bits.push(`忽略 ${r.deleted} 处修订删除`);
        if (r.inserted) bits.push(`保留 ${r.inserted} 处修订插入`);
        if (r.frontMatter) bits.push(frontBox.checked ? '含前置内容' : '已跳过前置内容');
        note.hidden = false;
        note.innerHTML = esc(bits.join(' · '));
      };

      const loadFile = async (f) => {
        if (!f) return;
        if (!isImportFile(f)) return toast('只支持 .txt / .md / .docx 文件', 'err');
        info.textContent = `读取 ${f.name}…`;
        note.hidden = true;
        ta.value = '';
        try {
          if (isDocxFile(f)) {
            resetDocx();
            const r = await readDocxFile(f);
            const body = r.text || '';
            const front = r.frontMatter || '';
            docxState = { file: f, meta: r, body, full: [front, body].filter(Boolean).join('\n\n') };
            ta.value = body;
            frontBox.checked = false;
            frontWrap.hidden = !front;
            info.textContent = `${f.name} · ${fmtSize(f.size)}`;
            updateDocxNote();
            return;
          }
          resetDocx();
          const r = await readTextFile(f);
          ta.value = r.text;
          info.textContent = `${f.name} · ${fmtSize(f.size)}`;
          note.hidden = false;
          note.innerHTML = `识别为 <b>${esc(r.enc)}</b> · ${fmtWords(countWords(r.text))} 字 · ${r.text.split('\n').length} 行`;
        } catch (err) {
          resetDocx();
          info.textContent = '.txt / .md / .docx · 最大 20 MB';
          note.hidden = true;
          toast(err.message || '读不了这个文件', 'err');
        }
      };

      frontBox.onchange = () => {
        if (!docxState) return;
        ta.value = frontBox.checked ? docxState.full : docxState.body;
        updateDocxNote();
      };
      ta.addEventListener('input', updateDocxNote);

      drop.onclick = () => input.click();
      drop.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        input.click();
      });
      input.onchange = () => {
        const f = input.files[0];
        input.value = ''; // 允许再次选同一个文件（比如重新导出后又改了一遍）
        loadFile(f);
      };
      drop.addEventListener('dragover', (e) => {
        if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        drop.classList.add('over');
      });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        drop.classList.remove('over');
        dragDepth = 0;
        showDropMask(false);
        loadFile(e.dataTransfer.files?.[0]);
      });

      box.querySelector('#impCancel').onclick = closeModal;
      box.querySelector('#impOk').onclick = async () => {
        const text = ta.value;
        if (!text.trim()) return toast('还没有可导入的正文', 'err');
        const btn = box.querySelector('#impOk');
        btn.disabled = true;
        btn.textContent = '导入中…';
        try {
          const r = await api.send(`/api/novels/${S.novel.id}/import`, { text });
          closeModal();
          await openNovel(S.novel.id, { chapterId: r.firstChapterId });
          toast(`导入 ${r.imported} 章${r.volumes ? ` · ${r.volumes} 卷` : ''}`, 'ok');
        } catch (err) {
          toast(`导入失败：${err.message}`, 'err');
          btn.disabled = false;
          btn.textContent = '导入';
        }
      };

      if (file) loadFile(file);
    });
}

$('#importBtn').addEventListener('click', () => openImportModal());

/* 把 .txt / .md / .docx 拖到窗口任意位置也能导入 */
let dragDepth = 0;
function showDropMask(on) {
  const mask = $('#dropMask');
  if (mask) mask.hidden = !on;
}
const dragHasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  dragDepth += 1;
  if (S.novel) showDropMask(true);
});
window.addEventListener('dragover', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  if (!dragHasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) showDropMask(false);
});
window.addEventListener('dragend', () => { dragDepth = 0; showDropMask(false); });
window.addEventListener('drop', (e) => {
  if (!dragHasFiles(e)) return;
  // 无论能不能导入，都拦下浏览器「直接打开文件」的默认行为
  e.preventDefault();
  dragDepth = 0;
  showDropMask(false);
  const f = e.dataTransfer.files?.[0];
  if (!f) return;
  if (!S.novel) return toast('先打开一部作品，再把文稿拖进来', 'err');
  if (!isImportFile(f)) return toast('只支持 .txt / .md / .docx 文件', 'err');
  openImportModal(f);
});

/** 封面可选的版式与配色：只取一次，之后走缓存 */
let coverOptsCache = null;
async function loadCoverOptions() {
  if (coverOptsCache) return coverOptsCache;
  try {
    coverOptsCache = await api.get('/api/cover-options');
  } catch {
    coverOptsCache = null;
  }
  return coverOptsCache;
}

/* ---------- 交稿检查 ---------- */
// 每一项检查都带「去处理」，点了就跳到能改它的地方
const SUBMIT_FOCUS = {
  author: '[data-novel="author"]',
  logline: '[data-key="logline"]',
  contact: '[data-key="contact"]',
  note: '[data-key="submissionNote"]',
};

function runSubmitAction(kind, id) {
  closeModal();
  if (kind === 'chapter') {
    if (id) openChapterFromIndex(id);
    return;
  }
  setView('bible');
  bibleTab = 'outline';
  $$('#bibleTabs button').forEach((x) => x.classList.toggle('on', x.dataset.bible === 'outline'));
  renderBible();
  const sel = SUBMIT_FOCUS[kind];
  if (sel) setTimeout(() => document.querySelector(sel)?.focus(), 120);
}

function bindSubmitActions(root) {
  root.querySelectorAll('[data-sub-act]').forEach((btn) => {
    btn.onclick = () => runSubmitAction(btn.dataset.subAct, btn.dataset.subId || '');
  });
}

function openSubmitCheck() {
  if (!S.novel) return toast('先打开一部作品', 'err');
  const list = S.novel.chapters;
  const r = buildSubmitCheck(S.novel, list, { scope: `全书 ${list.length} 章` });
  showModal(`<h3>交稿检查</h3>
    <p class="modal-sub">《${esc(S.novel.title)}》 · 只看本地已有的数据，不调用模型。</p>
    <div class="submit-wrap">${submitCheckHtml(r)}</div>
    <div class="modal-foot">
      <span class="submit-note">3 万字门槛 · 结果仅供参考</span>
      <button class="btn btn-primary" id="submitClose">关闭</button>
    </div>`, (box) => {
    box.querySelector('#submitClose').onclick = closeModal;
    bindSubmitActions(box);
  });
}

function exportBook() {
  if (!S.novel) return toast('先打开作品', 'err');
  showModal(`<h3>导出 / 备份《${esc(S.novel.title)}》</h3>
    <div class="grid2">
      <label class="field-label">格式
        <select id="exFmt" class="input"><option value="txt">TXT（纯文本）</option><option value="md">Markdown</option><option value="epub">EPUB（电子书）</option><option value="docx">Word（.docx）</option><option value="pdf">PDF（直接另存）</option><option value="print">打印稿（另存为 PDF）</option><option value="json">作品备份（JSON，可恢复）</option></select>
      </label>
      <label class="field-label">范围
        <select id="exScope" class="input"><option value="all">全书</option><option value="range">章节区间</option><option value="chapter">当前章</option></select>
      </label>
    </div>
    <div class="export-range" id="exRangeRow" hidden>
      <span>从</span>
      <input class="input" id="exFrom" type="number" step="1" inputmode="numeric" aria-label="起始章号" />
      <span>章</span>
      <span>到</span>
      <input class="input" id="exTo" type="number" step="1" inputmode="numeric" aria-label="结束章号" />
      <span>章</span>
      <em id="exRangeInfo"></em>
    </div>
    <label class="export-done" id="exDoneRow">
      <input type="checkbox" id="exDone" />
      <span>只导出定稿章节</span>
      <span class="export-done-count" id="exDoneCount"></span>
    </label>
    <div class="dim small export-done-hint" id="exDoneHint" hidden>章号沿用原书，不会自动重新编号。</div>
    <div class="dim small" id="exHint" hidden>EPUB 自动生成标题页、目录和分卷结构，适合放进手机 / 阅读器。选了区间就只打包这几章。</div>
    <div class="export-extras" id="exLayoutRow" hidden>
      <span class="export-extras-lbl">版式</span>
      <label class="export-extra">纸张
        <select id="exPaper" class="input"><option value="a4">A4</option><option value="a5">A5</option></select>
      </label>
      <label class="export-extra">字号
        <select id="exFont" class="input"><option value="10.5">五号 10.5pt</option><option value="12" selected>小四 12pt</option><option value="14">四号 14pt</option></select>
      </label>
      <label class="export-extra">行距
        <select id="exLeading" class="input"><option value="1.5">紧凑 1.5</option><option value="1.95" selected>标准 1.95</option><option value="2.2">宽松 2.2</option></select>
      </label>
      <label class="export-extra"><input type="checkbox" id="exTitlePage" checked /><span>包含书名页</span></label>
    </div>
    <div class="dim small export-done-hint" id="exContactHint" hidden></div>
    <div class="export-extras" id="exExtras" hidden>
      <span class="export-extras-lbl">随稿附带</span>
      <label class="export-extra"><input type="checkbox" id="exOutline" /><span>全书大纲</span></label>
      <label class="export-extra"><input type="checkbox" id="exCharacters" /><span>人物小传</span></label>
      <div class="dim small" id="exExtrasHint"></div>
    </div>
    <div class="export-extras" id="exNoteRow" hidden>
      <span class="export-extras-lbl">投稿附言</span>
      <label class="export-extra"><input type="checkbox" id="exNote" /><span>创作说明放在最前</span></label>
      <div class="dim small" id="exNoteHint"></div>
    </div>
    <div class="cover-row" id="exCoverRow" hidden>
      <div class="cover-thumb"><img id="exCoverImg" alt="封面预览" /></div>
      <div class="cover-side">
        <div class="cover-title">封面</div>
        <div class="dim small" id="exCoverLabel"></div>
        <div class="cover-choices" id="exCoverChoices">
          <div class="cover-choice-row">
            <span class="cover-choice-lbl">版式</span>
            <div class="cover-choice-btns" id="exCoverStyles"></div>
          </div>
          <div class="cover-choice-row">
            <span class="cover-choice-lbl">配色</span>
            <div class="cover-swatches" id="exCoverPalettes"></div>
          </div>
        </div>
        <div class="cover-actions">
          <button class="btn" id="exCoverPick">上传自己的封面</button>
          <button class="btn btn-text" id="exCoverReset" hidden>改回自动生成</button>
        </div>
        <input type="file" id="exCoverFile" accept="image/png,image/jpeg,image/gif" hidden />
        <div class="dim small">支持 PNG / JPG / GIF，8 MB 以内。不上传就按书名、作者和题材自动画一张。</div>
      </div>
    </div>
    <div class="export-submit" id="exSubmitRow">
      <button type="button" class="proof-link" id="exCheck">交稿前检查一下</button>
      <span class="dim small" id="exCheckHint">看看这份稿子还缺什么</span>
    </div>
    <div class="export-submit-body" id="exCheckBody" hidden></div>
    <div class="modal-foot"><button class="btn btn-text" id="exCancel">取消</button><button class="btn btn-primary" id="exOk">下载</button></div>`,
    (box) => {
      const fmtEl = box.querySelector('#exFmt');
      const scopeEl = box.querySelector('#exScope');
      const hintEl = box.querySelector('#exHint');
      const okBtn = box.querySelector('#exOk');
      const layoutRow = box.querySelector('#exLayoutRow');
      const paperEl = box.querySelector('#exPaper');
      const fontEl = box.querySelector('#exFont');
      const leadingEl = box.querySelector('#exLeading');
      const titlePageEl = box.querySelector('#exTitlePage');
      const doneEl = box.querySelector('#exDone');
      const doneRow = box.querySelector('#exDoneRow');
      const doneCountEl = box.querySelector('#exDoneCount');
      const doneHintEl = box.querySelector('#exDoneHint');
      const contactHintEl = box.querySelector('#exContactHint');
      // 封面：只导出 EPUB 时才有意义
      const coverRow = box.querySelector('#exCoverRow');
      const coverImg = box.querySelector('#exCoverImg');
      const coverLabel = box.querySelector('#exCoverLabel');
      const coverReset = box.querySelector('#exCoverReset');
      const coverFile = box.querySelector('#exCoverFile');
      const coverChoices = box.querySelector('#exCoverChoices');
      const styleBtns = box.querySelector('#exCoverStyles');
      const swatches = box.querySelector('#exCoverPalettes');
      // 选中的版式与配色；'auto' 表示按书名自动挑
      let curStyle = S.novel.meta?.coverStyle || 'classic';
      let curPalette = Number.isInteger(Number(S.novel.meta?.coverPalette)) && S.novel.meta.coverPalette !== ''
        ? Number(S.novel.meta.coverPalette)
        : 'auto';
      const refreshCover = () => {
        const has = !!S.novel.cover;
        // 有自定义图就显示那张；否则按当前选择现画一张预览
        coverImg.src = has
          ? `/api/novels/${S.novel.id}/cover?t=${Date.now()}`
          : `/api/novels/${S.novel.id}/cover?style=${encodeURIComponent(curStyle)}&palette=${encodeURIComponent(curPalette)}&t=${Date.now()}`;
        coverLabel.textContent = has
          ? `自定义封面（${String(S.novel.cover.ext || '').toUpperCase()}）`
          : '自动生成（按书名、作者、题材现画）';
        coverReset.hidden = !has;
        coverChoices.hidden = has;      // 传了自己的图，版式和配色就用不上了
        markChoices();
      };
      const markChoices = () => {
        styleBtns.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.style === curStyle));
        swatches.querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(b.dataset.palette) === String(curPalette)));
      };
      const saveChoice = async (part) => {
        try {
          const res = await api.put(`/api/novels/${S.novel.id}`, { meta: part });
          S.novel.meta = res.novel?.meta || { ...S.novel.meta, ...part };
        } catch (err) {
          toast(`封面设置没存上：${err.message || '未知错误'}`, 'err');
        }
      };
      // 版式与配色清单：只取一次
      loadCoverOptions().then((opts) => {
        if (!opts) return;
        styleBtns.innerHTML = opts.styles.map((s) => `<button type="button" class="btn btn-sm" data-style="${s.id}" title="${esc(s.desc)}">${esc(s.name)}</button>`).join('');
        swatches.innerHTML = opts.palettes.map((p) => `<button type="button" class="cover-swatch" data-palette="${p.index}" title="${esc(p.name)}" style="--sw:${esc(p.accent)};--swbg:${esc(p.bg)}"></button>`).join('')
          + '<button type="button" class="cover-swatch auto" data-palette="auto" title="按书名自动挑">自动</button>';
        styleBtns.querySelectorAll('button').forEach((b) => {
          b.onclick = async () => {
            curStyle = b.dataset.style;
            markChoices();
            refreshCover();
            await saveChoice({ coverStyle: curStyle });
          };
        });
        swatches.querySelectorAll('button').forEach((b) => {
          b.onclick = async () => {
            curPalette = b.dataset.palette === 'auto' ? 'auto' : Number(b.dataset.palette);
            markChoices();
            refreshCover();
            await saveChoice({ coverPalette: curPalette === 'auto' ? '' : curPalette });
          };
        });
        markChoices();
      });
      box.querySelector('#exCoverPick').onclick = () => coverFile.click();
      coverFile.onchange = async () => {
        const file = coverFile.files?.[0];
        coverFile.value = '';
        if (!file) return;
        try {
          const res = await api.upload(`/api/novels/${S.novel.id}/cover`, file);
          S.novel.cover = res.cover;
          refreshCover();
          toast('封面已换好', 'ok');
        } catch (err) {
          toast(`换封面失败：${err.message || '未知错误'}`, 'err');
        }
      };
      coverReset.onclick = async () => {
        try {
          await api.del(`/api/novels/${S.novel.id}/cover`);
          delete S.novel.cover;
          refreshCover();
          toast('已改回自动生成的封面', 'ok');
        } catch (err) {
          toast(`改不回去：${err.message || '未知错误'}`, 'err');
        }
      };
      const total = S.novel.chapters.length;
      const doneCount = S.novel.chapters.filter((c) => stageOf(c) === 'done').length;
      // 随稿附带的材料：只有作品里真写了才有得选
      const extrasRow = box.querySelector('#exExtras');
      const outlineEl = box.querySelector('#exOutline');
      const charactersEl = box.querySelector('#exCharacters');
      const extrasHint = box.querySelector('#exExtrasHint');
      const hasOutline = (S.novel.outline?.volumes || []).some((v) => (v.chapters || []).length);
      const charList = S.novel.bible?.characters || [];
      const hasCharacters = charList.length > 0;
      // 投稿附言：作者自己写的那段话
      const noteRow = box.querySelector('#exNoteRow');
      const noteEl = box.querySelector('#exNote');
      const noteHint = box.querySelector('#exNoteHint');
      const noteText = String(S.novel.meta?.submissionNote || '').trim();
      noteEl.checked = !!noteText;
      noteEl.disabled = !noteText;
      // 章节区间：投稿常常只要「前 30 章」，默认铺满全书，改结束章号就行
      const rangeRow = box.querySelector('#exRangeRow');
      const fromEl = box.querySelector('#exFrom');
      const toEl = box.querySelector('#exTo');
      const rangeInfo = box.querySelector('#exRangeInfo');
      const nos = S.novel.chapters.map((c) => Number(c.no) || 0).filter((x) => x > 0);
      const minNo = nos.length ? Math.min(...nos) : 1;
      const maxNo = nos.length ? Math.max(...nos) : 1;
      fromEl.value = String(minNo);
      toEl.value = String(maxNo);
      fromEl.min = toEl.min = String(minNo);
      fromEl.max = toEl.max = String(maxNo);
      const rangeValues = () => {
        const clamp = (v) => Math.max(minNo, Math.min(maxNo, Math.floor(Number(v) || 0) || minNo));
        let lo = clamp(fromEl.value);
        let hi = clamp(toEl.value);
        if (lo > hi) [lo, hi] = [hi, lo];   // 填反了就换过来，不拦人
        return { lo, hi };
      };
      const rangeChapters = () => {
        const { lo, hi } = rangeValues();
        return S.novel.chapters.filter((c) => {
          const no = Number(c.no) || 0;
          return no >= lo && no <= hi;
        });
      };
      // 导出窗口里这次的章节：跟服务端同一套规则（区间 / 定稿 / 当前章）
      const exportChapters = () => {
        const scopeNow = scopeEl.value;
        const base = scopeNow === 'chapter'
          ? S.novel.chapters.filter((c) => c.id === S.chapterId)
          : scopeNow === 'range' ? rangeChapters() : S.novel.chapters;
        return doneEl.checked && scopeNow !== 'chapter' ? base.filter((c) => stageOf(c) === 'done') : base;
      };
      const scopeLabel = () => {
        const scopeNow = scopeEl.value;
        if (scopeNow === 'chapter') return '当前章';
        if (scopeNow === 'range') {
          const { lo, hi } = rangeValues();
          return `第 ${lo === hi ? lo : `${lo}–${hi}`} 章`;
        }
        return '全书';
      };
      // 交稿检查：就地展开，改范围 / 勾定稿后跟着重算
      const submitRow = box.querySelector('#exSubmitRow');
      const checkBtn = box.querySelector('#exCheck');
      const checkBody = box.querySelector('#exCheckBody');
      const renderCheck = () => {
        const r = buildSubmitCheck(S.novel, exportChapters(), { onlyDone: doneEl.checked, scope: scopeLabel() });
        checkBody.innerHTML = submitCheckHtml(r);
        bindSubmitActions(checkBody);
      };
      // 关系条数：新数据是数组，老数据是「对象：关系」的字符串
      const relCount = charList.reduce((sum, c) => {
        const r = c.relations;
        if (Array.isArray(r)) return sum + r.filter((x) => x?.to).length;
        if (typeof r === 'string' && r.trim()) return sum + r.split(/[、,，;；\n]/).filter((s) => /[：:]/.test(s)).length;
        return sum;
      }, 0);
      outlineEl.checked = hasOutline;
      charactersEl.checked = hasCharacters;
      outlineEl.disabled = !hasOutline;
      charactersEl.disabled = !hasCharacters;
      const sync = () => {
        const backup = fmtEl.value === 'json';
        const epub = fmtEl.value === 'epub';
        const md = fmtEl.value === 'md';
        const docx = fmtEl.value === 'docx';
        const print = fmtEl.value === 'print';
        const pdf = fmtEl.value === 'pdf';
        // 备份总是整本；EPUB 能选区间，但没法只导一章
        scopeEl.disabled = backup;
        if (backup) scopeEl.value = 'all';
        scopeEl.querySelector('option[value="chapter"]').disabled = epub;
        if (epub && scopeEl.value === 'chapter') scopeEl.value = 'all';
        const scope = scopeEl.value;
        // 版式只对打印稿 / PDF 有意义
        layoutRow.hidden = !(print || pdf);
        hintEl.hidden = !(backup || epub || docx || print || pdf);
        hintEl.textContent = backup
          ? '备份是当前作品的完整 JSON：正文、设定、大纲、章节记忆和修订都会保留。恢复时会在书架新建一部作品，不会覆盖现有稿件。'
          : epub
            ? 'EPUB 自动生成标题页、目录和分卷结构，适合放进手机 / 阅读器。选了区间就只打包这几章。'
            : print
              ? 'A4 打印预览会在新标签页打开，每章另起一页。点「打印 / 存为 PDF」，在打印对话框里选「另存为 PDF」即可；分页以打印结果为准。'
              : pdf
                ? 'PDF 会在新标签页打开并自动弹出打印对话框，选「另存为 PDF」即可保存；分页以打印结果为准，适合直接交稿。'
                : 'Word 稿每章另起一页，含书名页、可选创作说明和页脚页码；编辑可以直接改。选了区间就只排这几章。';
        // 单章导出是作者明确指定的，不受「只导出定稿」影响；备份总是整本
        const showRange = !backup && scope === 'range';
        rangeRow.hidden = !showRange;
        const showDone = !backup && scope !== 'chapter';
        doneRow.hidden = !showDone;
        doneEl.disabled = doneCount === 0;
        doneRow.classList.toggle('disabled', doneCount === 0);
        if (doneCount === 0) doneEl.checked = false;
        doneCountEl.textContent = doneCount ? `已定稿 ${doneCount} / ${total} 章` : '还没有定稿章节';
        doneHintEl.hidden = !(showDone && doneEl.checked);
        // 区间的实际内容：跟导出时用的是同一套筛选，数字才对得上
        if (showRange) {
          const inRange = rangeChapters();
          const picked = doneEl.checked ? inRange.filter((c) => stageOf(c) === 'done') : inRange;
          const words = picked.reduce((sum, c) => sum + wordsOf(c), 0);
          const { lo, hi } = rangeValues();
          // 输入框里的章号被夹过 / 换过序时先报出真实范围，免得数字对不上
          const typed = Math.floor(Number(fromEl.value) || 0) === lo && Math.floor(Number(toEl.value) || 0) === hi;
          const span = typed ? '' : `第 ${lo === hi ? lo : `${lo}–${hi}`} 章 · `;
          rangeInfo.textContent = picked.length
            ? `${span}将导出 ${picked.length} 章 · 约 ${fmtWords(words)} 字`
            : '这个区间里没有可导出的章节';
          rangeInfo.classList.toggle('warn', !picked.length);
        }
        // 封面只跟 EPUB 有关
        coverRow.hidden = !epub;
        if (epub) refreshCover();
        // 附带材料：Markdown 与 EPUB 有意义；TXT / Word / 打印稿是拿来读 / 交稿的，不塞这些
        extrasRow.hidden = !(md || epub);
        // 投稿附言：文稿格式都能放；备份本来就有全部内容，单章导出也谈不上附言
        noteRow.hidden = !(!backup && scope !== 'chapter');
        noteEl.disabled = !noteText;
        if (!noteText) noteEl.checked = false;
        if (!noteRow.hidden) {
          noteHint.innerHTML = noteText
            ? `会放在稿件最前面：篇幅、进度，加上你写的 ${noteText.length} 字附言。`
            : `还没写附言。<button type="button" class="proof-link" id="exGoNote">去写</button>`
              + '<span class="dim small">　不写也能导出，只是没有这一页。</span>';
          noteHint.querySelector('#exGoNote')?.addEventListener('click', () => {
            closeModal();
            setView('bible');
            bibleTab = 'outline';
            $$('#bibleTabs button').forEach((x) => x.classList.toggle('on', x.dataset.bible === 'outline'));
            renderBible();
            setTimeout(() => document.querySelector('[data-key="submissionNote"]')?.focus(), 120);
          });
        }
        const picked = [];
        if (outlineEl.checked) picked.push('全书大纲');
        if (charactersEl.checked) picked.push('人物小传');
        extrasHint.textContent = !hasOutline && !hasCharacters
          ? '这部作品还没写章纲和人物卡，填了才有得附带。'
          : picked.length
            ? `会附在正文后面：${picked.join('、')}`
              + (charactersEl.checked ? `（${charList.length} 人${relCount ? ` · ${relCount} 条关系` : ''}）` : '')
              + '。'
            : '勾上的会附在正文后面。';
        // 联系方式：稿子的头部要能联系到人（JSON 备份本来就有联系方式，不用提示）
        const needContact = !backup && !S.novel.meta?.contact;
        contactHintEl.hidden = !needContact;
        if (needContact) {
          contactHintEl.innerHTML = `《${esc(S.novel.title || '这部作品')}》还没填作者联系方式，填了会印在稿件头部。`
            + ' <button type="button" class="proof-link" id="exGoContact">去填</button>';
          contactHintEl.querySelector('#exGoContact').onclick = () => {
            closeModal();
            setView('bible');
            bibleTab = 'outline';
            $$('#bibleTabs button').forEach((x) => x.classList.toggle('on', x.dataset.bible === 'outline'));
            renderBible();
            setTimeout(() => document.querySelector('[data-key="contact"]')?.focus(), 120);
          };
        }
        // 交稿检查只对文稿有意义；备份是整份数据，没什么可检查的
        submitRow.hidden = backup;
        if (backup && !checkBody.hidden) {
          checkBody.hidden = true;
          checkBtn.textContent = '交稿前检查一下';
        }
        // 打印稿 / PDF 不是下载文件，按钮上把动作说清楚
        okBtn.textContent = pdf ? '打开并打印' : print ? '打开打印预览' : '下载';
        if (!checkBody.hidden) renderCheck();
      };
      fmtEl.onchange = sync;
      scopeEl.onchange = sync;
      doneEl.onchange = sync;
      outlineEl.onchange = sync;
      charactersEl.onchange = sync;
      fromEl.oninput = sync;
      toEl.oninput = sync;
      // 离开输入框时把夹过 / 换过序的章号写回输入框，让人看见真实会导出哪几章
      const settleRange = () => {
        const { lo, hi } = rangeValues();
        fromEl.value = String(lo);
        toEl.value = String(hi);
        sync();
      };
      fromEl.onchange = settleRange;
      toEl.onchange = settleRange;
      checkBtn.onclick = () => {
        const open = checkBody.hidden;
        checkBody.hidden = !open;
        checkBtn.textContent = open ? '收起交稿检查' : '交稿前检查一下';
        if (open) renderCheck();
      };
      sync();
      box.querySelector('#exCancel').onclick = closeModal;
      box.querySelector('#exOk').onclick = () => {
        const fmt = fmtEl.value;
        const scope = scopeEl.value;
        const onlyDone = !doneRow.hidden && doneEl.checked;
        // 区间里一章都没有时别让用户吃一个 400 的 JSON 页面
        if (scope === 'range') {
          const inRange = rangeChapters();
          if (!inRange.length) return toast('这个区间里没有章节', 'err');
          if (onlyDone && !inRange.some((c) => stageOf(c) === 'done')) return toast('这个区间里没有已定稿的章节', 'err');
        }
        if (onlyDone && doneCount === 0) return toast('还没有已定稿的章节', 'err');
        if (fmt === 'json') {
          window.location.href = `/api/novels/${S.novel.id}/export?format=json`;
          closeModal();
          return;
        }
        const q = `${fmt !== 'epub' && scope === 'chapter' && S.chapterId ? `&chapterId=${S.chapterId}` : ''}${onlyDone ? '&only=done' : ''}`;
        let rangeQ = '';
        if (scope === 'range') {
          const { lo, hi } = rangeValues();
          rangeQ = `&from=${lo}&to=${hi}`;
        }
        const extras = [];
        if (!extrasRow.hidden && outlineEl.checked) extras.push('outline');
        if (!extrasRow.hidden && charactersEl.checked) extras.push('characters');
        const extraQ = extras.length ? `&extras=${extras.join(',')}` : '';
        const noteQ = !noteRow.hidden && noteEl.checked && noteText ? '&note=1' : '';
        // 版式参数只随打印稿 / PDF 走，其它格式不带
        const layoutQ = (fmt === 'print' || fmt === 'pdf')
          ? `&paper=${paperEl.value}&font=${fontEl.value}&leading=${leadingEl.value}${titlePageEl.checked ? '' : '&notitle=1'}`
          : '';
        const url = `/api/novels/${S.novel.id}/export?format=${fmt}${q}${rangeQ}${extraQ}${noteQ}${layoutQ}`;
        // 打印稿 / PDF 是打开一页给人看 / 打印，不是下载；弹窗被拦时留在原地，别把导出窗口关了
        if (fmt === 'print' || fmt === 'pdf') {
          const w = window.open(url, '_blank');
          if (!w) return toast('浏览器拦住了新标签页，允许弹出窗口后再试', 'err');
          closeModal();
          return;
        }
        window.location.href = url;
        closeModal();
      };
    });
}

/* ============================================================
 * 10.5 版本历史（快照 / 恢复）
 * ============================================================ */

async function snapshotNow(label) {
  if (!S.novel) return null;
  await saveChapterNow().catch(() => {});
  try {
    const j = await api.send(`/api/novels/${S.novel.id}/snapshots`, { label: label || '' });
    return j.snapshot;
  } catch {
    return null; // 快照只是保险，失败不该挡住正在做的事
  }
}

/** 段落级 diff：只比较非空行，够用且不会把长篇正文卡住 */
function diffParagraphs(oldText, newText) {
  const lines = (text) => String(text || '').replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean);
  const a = lines(oldText);
  const b = lines(newText);
  const n = a.length;
  const m = b.length;
  // 先削掉共同开头/结尾：多数版本只改了中间几段，这样 DP 表会小很多
  let head = 0;
  while (head < n && head < m && a[head] === b[head]) head += 1;
  let tailA = n;
  let tailB = m;
  while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) {
    tailA -= 1;
    tailB -= 1;
  }
  const ops = [];
  for (let k = 0; k < head; k += 1) ops.push({ type: 'same', text: a[k] });
  const midA = a.slice(head, tailA);
  const midB = b.slice(head, tailB);

  // 整章重写时不要为了一张几千万格的表把页面卡死；超过阈值就按整段替换展示
  if (midA.length * midB.length <= 1200000) {
    const rows = Array.from({ length: midA.length + 1 }, () => new Uint32Array(midB.length + 1));
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      const next = rows[i + 1];
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        row[j] = midA[i] === midB[j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        ops.push({ type: 'same', text: midA[i] });
        i += 1;
        j += 1;
      } else if (rows[i + 1][j] >= rows[i][j + 1]) {
        ops.push({ type: 'del', text: midA[i] });
        i += 1;
      } else {
        ops.push({ type: 'add', text: midB[j] });
        j += 1;
      }
    }
    while (i < midA.length) ops.push({ type: 'del', text: midA[i++] });
    while (j < midB.length) ops.push({ type: 'add', text: midB[j++] });
  } else {
    for (const text of midA) ops.push({ type: 'del', text });
    for (const text of midB) ops.push({ type: 'add', text });
  }

  for (let k = tailA; k < n; k += 1) ops.push({ type: 'same', text: a[k] });
  return ops;
}

async function openSnapshotDiff(snap, query = '') {
  const ch = currentChapter();
  if (!ch) return toast('先选择一章', 'err');
  if (!S.novel || !snap) return;
  const novelId = S.novel.id;
  const chapterId = ch.id;
  const label = `${fmtDate(snap.ts)} · ${SNAP_KINDS[snap.kind] || '快照'}`;
  const box = showModal(`<h3>版本对比 · ${esc(ch.title || '未命名')}</h3>
    <p class="modal-sub">当前正文 ↔ ${esc(label)}。红色是旧版里被删掉的段落，绿色是现在新增的段落；对比本身不改动正文，需要时可以用下方「恢复本章正文」只恢复这一章。</p>
    <div class="diff-bar">
      <div class="diff-sum" id="diffSum"></div>
      <label class="diff-toggle" id="diffToggleWrap"><input type="checkbox" id="diffShowSame">显示未改动段落</label>
    </div>
    <div class="diff-list only-changes" id="diffList"><div class="diff-empty">读取备份中…</div></div>
    <div class="modal-foot">
      <button class="btn btn-text" id="diffBack">返回版本历史</button>
      <button class="btn btn-primary" id="diffRestoreCh" hidden>${ico('rotate')}恢复本章正文</button>
      <button class="btn" id="diffClose">关闭</button>
    </div>`, (b) => {
    b.querySelector('#diffBack').onclick = () => openHistory(query);
    b.querySelector('#diffClose').onclick = closeModal;
  }, { wide: true });

  const sumEl = box.querySelector('#diffSum');
  const listEl = box.querySelector('#diffList');
  const toggleWrap = box.querySelector('#diffToggleWrap');
  const showSame = box.querySelector('#diffShowSame');
  const restoreBtn = box.querySelector('#diffRestoreCh');
  let snapCh;
  try {
    const j = await api.get(`/api/novels/${novelId}/snapshots/${snap.ts}/chapter/${chapterId}`);
    if (!j.chapter) throw new Error(j.error || '这一版里找不到这一章');
    snapCh = j.chapter;
  } catch (err) {
    sumEl.textContent = '';
    toggleWrap.hidden = true;
    restoreBtn.hidden = true;
    listEl.innerHTML = `<div class="diff-empty">无法读取这个版本的本章：${esc(err.message)}</div>`;
    return;
  }

  const ops = diffParagraphs(snapCh.content, ch.content);
  const added = ops.filter((o) => o.type === 'add').length;
  const removed = ops.filter((o) => o.type === 'del').length;
  const same = ops.filter((o) => o.type === 'same').length;
  const titleChanged = (snapCh.title || '') !== (ch.title || '');
  sumEl.innerHTML = `<span class="d-add">+${added} 段</span><span class="d-del">−${removed} 段</span><span>${same} 段未变</span>`;
  const titleNote = titleChanged ? `<div class="diff-title-note">旧版标题：${esc(snapCh.title || '未命名')}（恢复本章正文不会改标题）</div>` : '';
  restoreBtn.hidden = !(added || removed);
  if (!added && !removed) {
    toggleWrap.hidden = true;
    listEl.classList.remove('only-changes');
    listEl.innerHTML = `${titleNote}<div class="diff-empty">这一章的正文与当前版本一致，没有段落改动。</div>`;
    return;
  }

  restoreBtn.onclick = async () => {
    const when = `${fmtDate(snap.ts)} · ${SNAP_KINDS[snap.kind] || '快照'}`;
    if (!confirm(`恢复本章正文到 ${when} 的版本？\n\n只会替换「${ch.title || '未命名'}」这一章的正文；标题、写作阶段、目标、章纲、记忆、场景和批注都不会变，其他章节也不受影响。\n恢复前会先把当前版本存一份，恢复错了还能再撤回。`)) return;
    restoreBtn.disabled = true;
    try {
      // 先把还没落盘的正文写进去，服务端备份的才是「恢复前」真实的样子
      const ok = await flushSave();
      if (!ok) throw new Error('当前还有章节没保存成功，先别恢复');
      const j = await api.send(`/api/novels/${novelId}/restore-chapter`, { ts: snap.ts, chapterId });
      const target = S.novel?.chapters.find((c) => c.id === chapterId);
      if (target && j.chapter) Object.assign(target, j.chapter);
      S.unsaved.delete(chapterId);
      S.dirty = S.unsaved.size > 0;
      refreshSavePill();
      closeModal();
      selectChapter(chapterId);
      await loadNovels();
      toast(`已恢复本章正文到 ${fmtDate(snap.ts)} 的版本`, 'ok');
    } catch (err) {
      restoreBtn.disabled = false;
      toast(`恢复失败：${err.message || '未知错误'}`, 'err');
    }
  };

  listEl.innerHTML = `${titleNote}${ops.map((o) => `
    <div class="diff-line ${o.type}">
      <span class="diff-sign">${o.type === 'add' ? '+' : o.type === 'del' ? '−' : '·'}</span>
      <p>${esc(o.text)}</p>
    </div>`).join('')}`;
  const apply = () => listEl.classList.toggle('only-changes', !showSame.checked);
  showSame.onchange = apply;
  apply();
}

async function openHistory(presetWord = '') {
  if (!S.novel) return toast('先打开作品', 'err');
  await saveChapterNow().catch(() => {});
  const novelId = S.novel.id;
  showModal(`<h3>版本历史 · 《${esc(S.novel.title)}》</h3>
    <p class="modal-sub">写作时每 10 分钟自动存一份；AI 替换正文、删除章节前也会自动备份。恢复前会先把当前版本存一份，所以恢复本身也能撤回。不确定改了什么时，先点「对比」看当前章与那一版的差异；对比里也可以只恢复本章正文，不会动其他章节。</p>
    <div class="hist-bar">
      <button class="btn btn-primary btn-sm" id="histNow">${ico('clock')}立即备份当前版本</button>
      <span class="hist-count" id="histCount"></span>
    </div>
    <div class="find-bar">
      <input class="input" id="histSearch" placeholder="搜索版本说明 / 类型 / 日期" title="支持说明、类型和日期；Esc 清空" autocomplete="off" />
      <button class="icon-btn sm" id="histSearchClear" title="清除搜索" aria-label="清除搜索" hidden><svg class="ico"><use href="#i-x" /></svg></button>
    </div>
    <div class="hist-list" id="histList"><div class="hist-empty">读取中…</div></div>
    <div class="modal-foot"><button class="btn btn-text" id="histClose">关闭</button></div>`,
  (box) => {
    const listEl = box.querySelector('#histList');
    const countEl = box.querySelector('#histCount');
    const qEl = box.querySelector('#histSearch');
    const clearEl = box.querySelector('#histSearchClear');
    let all = [];
    if (presetWord) qEl.value = presetWord;
    let lastQuery = qEl.value.trim();
    clearEl.hidden = !qEl.value.trim();
    box.querySelector('#histClose').onclick = closeModal;

    const dateText = (s) => `${fmtDate(s.ts)} ${fmtAgo(s.ts)}`;

    const render = () => {
      const q = qEl.value.trim();
      const queryChanged = q !== lastQuery;
      lastQuery = q;
      // 换搜索词要回到第一条命中；同一查询的刷新（比如刚备份）保持原位。
      const paint = (html) => {
        const keep = listEl.scrollTop;
        listEl.innerHTML = html;
        listEl.scrollTop = queryChanged ? 0 : keep;
      };
      const list = filterSnapshotsBySearch(all, q, dateText);
      clearEl.hidden = !q;
      if (!all.length) {
        countEl.textContent = '';
        paint(`<div class="hist-empty">还没有版本记录。<br>继续写作会自动留下快照，也可以点上面的「立即备份」。</div>`);
        return;
      }
      countEl.textContent = q
        ? `找到 ${list.length} / ${all.length} 个版本`
        : `已保存 ${all.length} 个版本`;
      if (!list.length) {
        paint(`<div class="hist-empty">没有找到匹配「${esc(q)}」的版本。<br><button type="button" class="btn btn-sm" id="histNoMatchClear">清空搜索</button></div>`);
        listEl.querySelector('#histNoMatchClear')?.addEventListener('click', () => clearSearch());
        return;
      }
      const byTs = new Map(list.map((s) => [String(s.ts), s]));
      paint(list.map((s) => `
        <div class="hist-row">
          <div class="hist-info">
            <div class="hist-when">
              <b>${esc(fmtAgo(s.ts))}</b>
              <span class="hist-kind k-${esc(s.kind)}">${esc(SNAP_KINDS[s.kind] || '快照')}</span>
            </div>
            <div class="hist-meta">${s.label ? `${esc(s.label)} · ` : ''}${esc(fmtDate(s.ts))} · ${s.chapters} 章 · ${fmtWords(s.words)} 字 · ${Math.max(1, Math.round(s.size / 1024))} KB</div>
          </div>
          <div class="hist-actions">
            <button class="btn btn-sm btn-text hist-diff" data-ts="${s.ts}" title="对比当前章与这一版的正文">${ico('eye')}对比</button>
            <button class="btn btn-sm hist-restore" data-ts="${s.ts}">${ico('rotate')}恢复</button>
          </div>
        </div>`).join(''));
      listEl.querySelectorAll('.hist-diff').forEach((btn) => {
        btn.onclick = () => {
          const snap = byTs.get(btn.dataset.ts);
          if (snap) openSnapshotDiff(snap, qEl.value.trim());
        };
      });
      listEl.querySelectorAll('.hist-restore').forEach((btn) => {
        btn.onclick = async () => {
          const ts = Number(btn.dataset.ts);
          if (!confirm(`恢复到 ${fmtDate(ts)} 的版本？\n当前内容会先自动备份一份，可以再撤回。`)) return;
          btn.disabled = true;
          try {
            await api.send(`/api/novels/${novelId}/restore`, { ts });
            closeModal();
            await loadNovels();
            await openNovel(novelId);
            toast(`已恢复到 ${fmtDate(ts)} 的版本`, 'ok');
          } catch (err) {
            btn.disabled = false;
            toast(`恢复失败：${err.message}`, 'err');
          }
        };
      });
    };

    const clearSearch = (focus = true) => {
      qEl.value = '';
      render();
      if (focus) qEl.focus();
    };

    const load = async () => {
      try {
        const j = await api.get(`/api/novels/${novelId}/snapshots`);
        all = j.snapshots || [];
        render();
      } catch (err) {
        all = [];
        countEl.textContent = '';
        listEl.innerHTML = `<div class="hist-empty">读取失败：${esc(err.message)}</div>`;
      }
    };

    qEl.addEventListener('input', render);
    qEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !qEl.value) return;
      e.preventDefault();
      e.stopPropagation();   // 只清空搜索，别把整个版本历史一起关掉
      clearSearch();
    });
    clearEl.addEventListener('click', () => clearSearch());
    qEl.focus();

    box.querySelector('#histNow').onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const snap = await snapshotNow('手动备份');
        if (snap) { toast('已备份当前版本', 'ok'); await load(); }
        else toast('备份失败', 'err');
      } finally {
        btn.disabled = false;
      }
    };

    load();
  });
}
$('#historyBtn').addEventListener('click', () => openHistory());

/* ============================================================
 * 10.6 全书查找 / 替换
 * ============================================================ */
function jumpToHit(chapterId, start, len) {
  closeModal();
  setView('studio');
  selectChapter(chapterId);
  // 等编辑器把这一章渲染出来，再定位选区（原生选区就是最好的高亮）
  setTimeout(() => {
    const ta = $('#chContent');
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(start, Math.min(start + len, ta.value.length));
    // 切章恢复的是上次写作位置，命中可能不在当前视野里；滚到命中处
    ta.scrollTop = Math.max(0, editorCaretTop(ta, start) - ta.clientHeight * 0.32);
  }, 60);
}

async function jumpToGlobalHit(novelId, chapterId, start, len) {
  if (S.focusMode) exitFocus();
  closeModal();
  try {
    if (!S.novel || S.novel.id !== novelId) {
      await openNovel(novelId, { chapterId });
    } else {
      setView('studio');
      selectChapter(chapterId);
    }
    setTimeout(() => {
      if (S.novel?.id !== novelId || S.chapterId !== chapterId) return;
      const ta = $('#chContent');
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(start, Math.min(start + len, ta.value.length));
      ta.scrollTop = Math.max(0, editorCaretTop(ta, start) - ta.clientHeight * 0.32);
    }, 80);
  } catch (err) {
    toast(`打开失败：${err.message || '未知错误'}`, 'err');
  }
}

async function jumpToGlobalTitle(novelId, chapterId) {
  if (S.focusMode) exitFocus();
  closeModal();
  try {
    if (!S.novel || S.novel.id !== novelId) {
      await openNovel(novelId, { chapterId });
    } else {
      setView('studio');
      selectChapter(chapterId);
    }
    setTimeout(() => {
      if (S.novel?.id !== novelId || S.chapterId !== chapterId) return;
      const title = $('#chTitle');
      if (!title) return;
      title.focus();
      title.select();
    }, 80);
  } catch (err) {
    toast(`打开失败：${err.message || '未知错误'}`, 'err');
  }
}

/** 查找结果列表的键盘光标：↑ / ↓ 在命中项间移动，回车打开当前项。
 *  结果列表每次重建，调用方在渲染后 reset()；查询变化时 setActive(false)，
 *  避免在还没刷新的旧结果上跳转。 */
function bindFindCursor(listEl) {
  let idx = -1;
  let active = false;
  const hits = () => [...listEl.querySelectorAll('.find-hit')];
  const paint = () => {
    const list = hits();
    list.forEach((el, i) => el.classList.toggle('cursor', i === idx));
    if (idx >= 0) list[idx]?.scrollIntoView({ block: 'nearest' });
  };
  return {
    reset() { idx = -1; paint(); },
    setActive(on) { active = !!on; if (!active) idx = -1; paint(); },
    move(step) {
      if (!active) return;
      const list = hits();
      if (!list.length) return;
      idx = stepSearchCursor(idx, step, list.length);
      paint();
    },
    open() {
      if (!active) return false;
      const list = hits();
      if (!list.length) return false;
      (list[idx] || list[0]).click();
      return true;
    },
    get active() { return active; },
  };
}

async function openGlobalSearch(presetWord = '') {
  if (S.novel && S.chapterId) await saveChapterNow().catch(() => {});
  if (!S.novels?.length) await loadNovels().catch(() => {});
  const ta = $('#chContent');
  const picked = String(presetWord || '').trim()
    || (ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd).trim() : '');
  const preset = picked && picked.length <= 80 && !picked.includes('\n') ? picked : '';
  const workCount = S.novels?.length || 0;

  showModal(`<h3>全局检索</h3>
    <p class="modal-sub">在书架里 ${workCount} 部作品的正文和章节标题中查找。结果按作品分组，点命中处直接跳过去。</p>
    <div class="find-bar">
      <input class="input" id="gFindQ" placeholder="输入关键词，回车检索" title="回车检索；↑ / ↓ 选择命中，回车打开" autocomplete="off" />
      <button class="btn btn-primary" id="gFindGo">${ico('search')}检索</button>
    </div>
    <div class="find-sum" id="gFindSum"></div>
    <div class="find-list global-find-list" id="gFindList"><div class="find-empty">输入关键词，检索整个书架。</div></div>
    <div class="modal-foot"><button class="btn btn-text" id="gFindClose">关闭</button></div>`,
  (box) => {
    const qEl = box.querySelector('#gFindQ');
    const listEl = box.querySelector('#gFindList');
    const sumEl = box.querySelector('#gFindSum');
    let seq = 0;
    let timer = null;
    let lastQ = '';
    const cursor = bindFindCursor(listEl);
    box.querySelector('#gFindClose').onclick = () => { clearTimeout(timer); closeModal(); };
    if (preset) qEl.value = preset;
    qEl.focus();
    qEl.select();

    const render = (j) => {
      if (!j.total) {
        sumEl.textContent = '';
        listEl.innerHTML = `<div class="find-empty">所有作品里都没有找到「${esc(j.q)}」。<br>可以试试更短的关键词。</div>`;
        cursor.setActive(false);
        return;
      }
      sumEl.innerHTML = `共 <b>${j.total}</b> 处 · <b>${j.works}</b> 部作品 / <b>${j.chapters}</b> 章${j.truncated ? '（下方只列出部分结果）' : ''}`;
      const groups = [];
      const byId = new Map();
      for (const r of j.results) {
        let g = byId.get(r.novelId);
        if (!g) {
          g = { id: r.novelId, title: r.novelTitle, author: r.author, rows: [] };
          byId.set(r.novelId, g);
          groups.push(g);
        }
        g.rows.push(r);
      }
      listEl.innerHTML = groups.map((g) => `
        <section class="gfind-work">
          <div class="gfind-work-head">
            <b>《${esc(g.title)}》</b>
            <span>${g.author ? `${esc(g.author)} · ` : ''}${g.rows.length} 章</span>
          </div>
          ${g.rows.map((r) => {
            const status = [r.count ? `${r.count} 处` : '', r.titleHit ? '标题命中' : ''].filter(Boolean).join(' · ');
            return `<div class="find-row">
              <div class="find-head"><b>第 ${r.no} 章 · ${esc(r.chapterTitle)}</b><span>${status}</span></div>
              ${r.titleHit ? `<div class="find-hit gfind-hit gfind-title-hit" data-hit="1" data-kind="title" data-novel="${esc(r.novelId)}" data-cid="${esc(r.chapterId)}">标题：${esc(r.titleHit.before)}<mark>${esc(r.titleHit.match)}</mark>${esc(r.titleHit.after)}</div>` : ''}
              ${r.hits.map((h) => `<div class="find-hit gfind-hit" data-hit="1" data-kind="content" data-novel="${esc(r.novelId)}" data-cid="${esc(r.chapterId)}" data-start="${h.start}" data-len="${h.match.length}">${esc(h.before)}<mark>${esc(h.match)}</mark>${esc(h.after)}</div>`).join('')}
            </div>`;
          }).join('')}
        </section>`).join('');
      listEl.querySelectorAll('.gfind-hit').forEach((el) => {
        el.onclick = () => {
          if (el.dataset.kind === 'title') jumpToGlobalTitle(el.dataset.novel, el.dataset.cid);
          else jumpToGlobalHit(el.dataset.novel, el.dataset.cid, Number(el.dataset.start), Number(el.dataset.len));
        };
      });
      cursor.setActive(lastQ === qEl.value.trim());
      cursor.reset();
    };

    const run = async () => {
      clearTimeout(timer);
      const q = qEl.value.trim();
      if (!q) {
        seq += 1;
        lastQ = '';
        cursor.setActive(false);
        sumEl.textContent = '';
        listEl.innerHTML = '<div class="find-empty">输入关键词，检索整个书架。</div>';
        return;
      }
      const mine = ++seq;
      lastQ = '';
      cursor.setActive(false);
      sumEl.textContent = '检索中…';
      try {
        const j = await api.get(`/api/library-search?q=${encodeURIComponent(q)}`);
        if (mine !== seq || !listEl.isConnected) return;
        lastQ = q;
        render(j);
      } catch (err) {
        if (mine !== seq || !listEl.isConnected) return;
        cursor.setActive(false);
        sumEl.textContent = '';
        listEl.innerHTML = `<div class="find-empty">检索失败：${esc(err.message || '未知错误')}</div>`;
      }
    };

    box.querySelector('#gFindGo').onclick = run;
    qEl.addEventListener('input', () => {
      clearTimeout(timer);
      seq += 1;   // 输入一变，在途的旧结果就作废
      lastQ = '';
      cursor.setActive(false);
      if (!qEl.value.trim()) {
        sumEl.textContent = '';
        listEl.innerHTML = '<div class="find-empty">输入关键词，检索整个书架。</div>';
        return;
      }
      timer = setTimeout(() => {
        if (qEl.value.trim()) run();
      }, 320);
    });
    qEl.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;   // 中文输入法回车 / 方向键留给候选词
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!cursor.active) return;
        e.preventDefault();
        cursor.move(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        // 结果已经是这次关键词的，就直接打开当前命中；否则先检索
        if (qEl.value.trim() === lastQ && cursor.open()) return;
        run();
      }
    });
    if (preset) run();
  }, { wide: true });
}

async function openFind(presetWord = '') {
  if (!S.novel) return toast('先打开作品', 'err');
  await saveChapterNow().catch(() => {});
  const novelId = S.novel.id;
  const ta = $('#chContent');
  const passed = String(presetWord || '').trim();
  const picked = passed || (ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd).trim() : '');
  const preset = picked && picked.length <= 40 && !picked.includes('\n') ? picked : '';
  showModal(`<h3>全书查找 · 《${esc(S.novel.title)}》</h3>
    <div class="find-bar">
      <input class="input" id="findQ" placeholder="查找任意文字，回车开始" title="回车查找；↑ / ↓ 选择命中，回车打开" autocomplete="off" />
      <button class="btn btn-primary" id="findGo">${ico('search')}查找</button>
    </div>
    <div class="find-bar">
      <input class="input" id="findR" placeholder="替换为…（留空表示删掉）" autocomplete="off" />
      <label class="find-check" title="章节标题也一起替换"><input type="checkbox" id="findTitle" />含标题</label>
      <button class="btn btn-danger-ghost" id="findAll">全部替换</button>
    </div>
    <div class="find-sum" id="findSum"></div>
    <div class="find-list" id="findList"><div class="find-empty">输入关键词回车查找；命中处可直接点进去定位。</div></div>
    <div class="modal-foot"><button class="btn btn-text" id="findClose">关闭</button></div>`,
  (box) => {
    const qEl = box.querySelector('#findQ');
    const rEl = box.querySelector('#findR');
    const listEl = box.querySelector('#findList');
    const sumEl = box.querySelector('#findSum');
    let seq = 0;
    let lastQ = '';
    const cursor = bindFindCursor(listEl);
    box.querySelector('#findClose').onclick = closeModal;
    if (preset) qEl.value = preset;
    qEl.focus();
    qEl.select();

    const render = (j) => {
      if (!j.total) {
        sumEl.textContent = '';
        listEl.innerHTML = `<div class="find-empty">全书没有找到「${esc(j.q)}」。</div>`;
        cursor.setActive(false);
        return;
      }
      sumEl.innerHTML = `全书共 <b>${j.total}</b> 处，分布在 <b>${j.chapters}</b> 章${j.truncated ? '（下方只列出前几章）' : ''}`;
      listEl.innerHTML = j.results.map((r) => `
        <div class="find-row">
          <div class="find-head"><b>第 ${r.no} 章 · ${esc(r.title)}</b><span>${r.count} 处</span></div>
          ${r.hits.map((h) => `<div class="find-hit" data-cid="${esc(r.chapterId)}" data-start="${h.start}" data-len="${h.match.length}">${esc(h.before)}<mark>${esc(h.match)}</mark>${esc(h.after)}</div>`).join('')}
        </div>`).join('');
      listEl.querySelectorAll('.find-hit').forEach((el) => {
        el.onclick = () => jumpToHit(el.dataset.cid, Number(el.dataset.start), Number(el.dataset.len));
      });
      cursor.setActive(lastQ === qEl.value.trim());
      cursor.reset();
    };

    const run = async () => {
      const q = qEl.value.trim();
      if (!q) {
        lastQ = '';
        cursor.setActive(false);
        return;
      }
      const mine = ++seq;
      lastQ = '';
      cursor.setActive(false);
      sumEl.textContent = '查找中…';
      try {
        const j = await api.get(`/api/novels/${novelId}/search?q=${encodeURIComponent(q)}`);
        if (mine !== seq || !listEl.isConnected) return;
        lastQ = q;
        render(j);
      } catch (err) {
        if (mine !== seq || !listEl.isConnected) return;
        cursor.setActive(false);
        sumEl.textContent = '';
        listEl.innerHTML = `<div class="find-empty">查找失败：${esc(err.message)}</div>`;
      }
    };

    box.querySelector('#findGo').onclick = run;
    qEl.addEventListener('input', () => {
      seq += 1;
      lastQ = '';
      cursor.setActive(false);
    });
    qEl.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;   // 中文输入法回车 / 方向键留给候选词
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!cursor.active) return;
        e.preventDefault();
        cursor.move(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        // 结果已经是这次关键词的，就直接打开当前命中；否则先查找
        if (qEl.value.trim() === lastQ && cursor.open()) return;
        run();
      }
    });
    rEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); box.querySelector('#findAll').click(); } });

    box.querySelector('#findAll').onclick = async () => {
      const q = qEl.value.trim();
      if (!q) return toast('先填写要替换的文字', 'err');
      const inTitle = box.querySelector('#findTitle').checked;
      const to = rEl.value;
      if (!confirm(`把全书中的「${q}」全部替换为「${to || '（空）'}」？\n${inTitle ? '章节标题也会一起替换。\n' : ''}替换前会自动备份，可在版本历史里撤回。`)) return;
      const btn = box.querySelector('#findAll');
      btn.disabled = true;
      try {
        const r = await api.send(`/api/novels/${novelId}/replace`, { find: q, replace: to, inTitle });
        closeModal();
        await loadNovels();
        await openNovel(novelId);
        toast(r.count ? `已替换 ${r.count} 处，涉及 ${r.chapters} 章（旧稿在版本历史里）` : '没有需要替换的内容', r.count ? 'ok' : '');
      } catch (err) {
        btn.disabled = false;
        toast(`替换失败：${err.message}`, 'err');
      }
    };

    if (preset) run();
  });
}
$('#findBtn').addEventListener('click', () => openFind());

/* ---------------- 快捷键 ---------------- */
document.addEventListener('keydown', (e) => {
  if ($('#readerMask')) return;
  // Alt+↑ / ↓：在当前作品里翻章；下拉框的原生 Alt+↓ 不抢
  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey
    && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.isComposing) {
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'select') return;
    if ($('#cmdkMask')?.hidden === false || $('#modalMask')?.hidden === false) return;
    if (S.view !== 'studio' || !S.novel || !S.chapterId) return;
    e.preventDefault();
    stepChapter(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.altKey && String(e.key).toLowerCase() === 's') {
    e.preventDefault();
    sprintToggle();
    return;
  }
  if (e.altKey && String(e.key).toLowerCase() === 'p') {
    e.preventDefault();
    openProof();
    return;
  }
  if (e.altKey && String(e.key).toLowerCase() === 'b') {
    e.preventDefault();
    openChapterBoard();
    return;
  }
  if (e.altKey && String(e.key).toLowerCase() === 'f') {
    e.preventDefault();
    toggleFocus();
    return;
  }
  if (e.altKey && (e.key === '=' || e.key === '+')) {
    e.preventDefault();
    paperStep(1);
    return;
  }
  if (e.altKey && (e.key === '-' || e.key === '_')) {
    e.preventDefault();
    paperStep(-1);
    return;
  }
  if (e.altKey && e.key === '0') {
    e.preventDefault();
    paperReset();
    return;
  }
  if (e.key === 's') {
    e.preventDefault();
    manualSave();
  } else if ((e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y') && $('#modalMask')?.hidden) {
    // Ctrl+Z 在别处（比如右侧助手区）也能撤销正文，只要没在输入框里、也没开着弹窗
    const tag = (e.target?.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || e.target?.isContentEditable;
    if (!typing && S.view === 'studio' && S.novel && S.chapterId) {
      e.preventDefault();
      if (e.key.toLowerCase() === 'y' || e.shiftKey) doRedo(); else doUndo();
    }
  } else if ($('#modalMask').hidden && S.view === 'studio' && S.novel && e.key === 'Enter' && e.shiftKey) {
    e.preventDefault(); generateChapter();
  } else if ($('#modalMask').hidden && S.view === 'studio' && S.novel && e.key === 'Enter') {
    e.preventDefault(); continueWriting();
  } else if (e.key === 'E' && e.shiftKey) {
    e.preventDefault(); exportBook();
  } else if (String(e.key).toLowerCase() === 'f' && e.shiftKey && $('#modalMask').hidden) {
    e.preventDefault(); openGlobalSearch();
  } else if (e.key === 'f' && !e.shiftKey && S.novel) {
    e.preventDefault(); openFind();
  }
});

/* ============================================================
 * 11.5 命令面板（Ctrl/⌘ + K）
 * ============================================================ */
const cmdk = { items: [], list: [], idx: 0 };
let cmdkPrevFocus = null;
let cmdkStatusText = '';

function setCmdkStatus(text) {
  if (cmdkStatusText === text) return;
  cmdkStatusText = text;
  const el = $('#cmdkStatus');
  if (el) el.textContent = text;
}

function cmdkSource() {
  const out = [];
  buildContinueReadingEntries(S.novels, readerProgressMap()).forEach((entry) => {
    const hint = `第 ${entry.chapterNo} 章${entry.pct === null ? '' : ` · ${entry.pct}%`} · ${fmtAgo(entry.readAt)}`;
    out.push({
      g: '继续阅读', label: entry.title, icon: 'book-open', hint,
      keywords: `${entry.title} ${entry.chapterTitle || ''}`,
      run: () => continueReading(entry.id),
    });
  });
  const op = (label, icon, run, hint) => out.push({ g: '操作', label, icon, run, hint });
  op('一键开书', 'spark', () => { setView('shelf'); openQuickStartModal(); }, '一句话生成全书');
  op('新建作品', 'plus', () => openNewNovelModal(), 'N');
  op('回收站', 'trash', () => openTrash());
  op('全局检索', 'search', () => openGlobalSearch(), 'Ctrl+Shift+F');
  if (S.novel) {
    op('生成本章', 'spark', () => { setView('studio'); showAssistTab('write'); generateChapter(); }, 'Ctrl+Shift+↵');
    op('阅读模式', 'book-open', () => { setView('studio'); openReader(S.chapterId, { restore: true }); });
    op('继续阅读', 'book-open', () => continueReading(S.novel.id));
    op('上一章', 'chev-up', () => { setView('studio'); stepChapter(-1); }, 'Alt+↑');
    op('下一章', 'chev-down', () => { setView('studio'); stepChapter(1); }, 'Alt+↓');
    op(S.focusMode ? '退出专注写作' : '进入专注写作', 'focus', toggleFocus, 'Ctrl+Alt+F');
    op('续写当前章', 'pen', () => { setView('studio'); showAssistTab('write'); continueWriting(); }, 'Ctrl+↵');
    op('对比两个模型', 'columns', () => { setView('studio'); showAssistTab('write'); openModelCompare(); });
    op('一致性检查', 'shield', () => { setView('studio'); showAssistTab('check'); $('#consistencyBtn').click(); });
    op('责编评审', 'stamp', () => { setView('studio'); showAssistTab('check'); $('#reviewBtn').click(); });
    op('导入文稿', 'upload', () => { setView('studio'); openImportModal(); });
    op('批量补全章节记忆', 'refresh', () => { setView('studio'); openBatchMemory(); });
    op('导出作品', 'download', () => exportBook(), 'Ctrl+Shift+E');
    op('版本历史', 'clock', () => { setView('studio'); openHistory(); });
    op('设置本章目标字数', 'pulse', () => {
      setView('studio');
      const ch = currentChapter();
      if (ch) openChapterTargetModal(S.novel.chapters.indexOf(ch));
    });
    op('撤销', 'undo', () => { setView('studio'); doUndo(); }, 'Ctrl+Z');
    op('重做', 'redo', () => { setView('studio'); doRedo(); }, 'Ctrl+Shift+Z');
    op('全书查找 / 替换', 'search', () => { setView('studio'); openFind(); }, 'Ctrl+F');
    op('全书体检', 'pulse', () => { setView('studio'); openHealthReport(); });
    op('交稿检查', 'stamp', () => openSubmitCheck());
    op('章节看板', 'columns', () => { setView('studio'); openChapterBoard(); }, 'Ctrl+Alt+B');
    op('文字校对', 'proof', () => { setView('studio'); openProof(); }, 'Ctrl+Alt+P');
    op('本章修订清单', 'check', () => {
      if (!currentChapter()) return toast('先打开一章', 'err');
      setView('studio');
      showAssistTab('check');
      setTimeout(() => $('#revInput')?.focus(), 80);
    });
    op('全书修订清单', 'layers', () => openRevisionInbox());
    op('场景拆解 / 幕布视图', 'columns', () => { setView('studio'); showAssistTab('scenes'); });
    op('结构/节拍表', 'pulse', () => { setView('studio'); setView('bible'); document.querySelector('#bibleTabs button[data-bible="beats"]')?.click(); });
    op('人物关系图谱', 'users', () => { setView('studio'); setView('bible'); document.querySelector('#bibleTabs button[data-bible="relations"]')?.click(); });
    op('时间轴可视化', 'calendar', () => { setView('studio'); setView('bible'); document.querySelector('#bibleTabs button[data-bible="timelineViz"]')?.click(); });
    op('线索追踪', 'git-branch', () => { setView('studio'); setView('bible'); document.querySelector('#bibleTabs button[data-bible="threads"]')?.click(); });
    op('人物弧光', 'activity', () => { setView('studio'); setView('bible'); document.querySelector('#bibleTabs button[data-bible="arcs"]')?.click(); });
    if (S.novel) {
      op('从一句话生成全书大纲', 'spark', () => { setView('studio'); setView('bible'); document.querySelector('#bibleTabs button[data-bible="outline"]')?.click(); $('#genOutlineFromLogline')?.click(); });
    }
  }
  op('立即保存', 'check', manualSave, 'Ctrl+S');
  op('切换明暗主题', 'moon', () => $('#themeBtn').click());
  op('放大稿纸字号', 'plus', () => paperStep(1), 'Ctrl+Alt+=');
  op('缩小稿纸字号', 'minus', () => paperStep(-1), 'Ctrl+Alt+-');
  op('稿纸恢复默认', 'refresh', () => paperReset());
  op('写作统计 / 日更目标', 'stamp', () => openStatsModal());
  op('写作冲刺计时器', 'clock', () => sprintToggle(true), 'Ctrl+Alt+S');
  op('新建一卷（从当前章起）', 'layers', newVolumeFromCurrent);
  op('导出设定库', 'download', () => { if (!S.novel) return toast('先打开一部作品', 'err'); setView('studio'); setView('bible'); document.querySelector('#bibleExportBtn')?.click(); });
  op('导入设定库', 'upload', () => { if (!S.novel) return toast('先打开一部作品', 'err'); setView('studio'); setView('bible'); document.querySelector('#bibleImportBtn')?.click(); });
  op('导出提示词模板', 'download', () => { setView('settings'); document.querySelector('#promptExportBtn')?.click(); });
  op('导入提示词模板', 'upload', () => { setView('settings'); document.querySelector('#promptImportBtn')?.click(); });

  const go = (label, icon, v) => out.push({ g: '前往', label, icon, run: () => setView(v) });
  go('书架', 'book', 'shelf');
  go('工作台', 'pen', 'studio');
  go('设定库', 'layers', 'bible');
  go('设置', 'settings', 'settings');

  (S.novels || []).forEach((n) => {
    const tags = parseNovelTags(n.tags);
    const hint = [
      `${n.chapterCount} 章`,
      n.genre || '',
      tags.length ? tags.slice(0, 2).join(' / ') + (tags.length > 2 ? ` +${tags.length - 2}` : '') : '',
    ].filter(Boolean).join(' · ');
    out.push({
      g: '作品', label: n.title, icon: 'book', hint,
      keywords: novelSearchText(n),
      run: () => openNovel(n.id),
    });
  });
  if (S.novel) {
    const volumeLabels = effVolumeIds().map((id) => volumeTitle(id));
    buildChapterPaletteEntries(S.novel.chapters, volumeLabels).forEach((entry) => {
      const chapter = S.novel.chapters[entry.index];
      out.push({
        g: '章节', label: entry.label, icon: 'pen', hint: entry.hint, keywords: entry.keywords,
        run: () => { setView('studio'); selectChapter(chapter.id); },
      });
    });
  }
  return out.filter((x) => typeof x.run === 'function');
}

function cmdkQuery(q) {
  const raw = String(q || '').trim();
  if (!raw) return cmdk.items.slice(0, 40);
  const needle = raw.toLowerCase();
  const terms = raw.split(/\s+/).map(normalizeMentionText).filter(Boolean);
  const hit = [];
  cmdk.items.forEach((it) => {
    const l = it.label.toLowerCase();
    let s = -1;
    if (l.startsWith(needle)) s = 0;
    else if (l.includes(needle)) s = 1;
    else if (`${it.g} ${it.hint || ''}`.toLowerCase().includes(needle)) s = 2;
    else if (terms.length && terms.every((term) => normalizeMentionText(it.keywords || '').includes(term))) s = 3;
    if (s >= 0) hit.push({ it, s });
  });
  return hit.sort((a, b) => a.s - b.s).slice(0, 40).map((x) => x.it);
}

function cmdkRender() {
  const ul = $('#cmdkList');
  const input = $('#cmdkInput');
  if (!cmdk.list.length) {
    ul.innerHTML = '<li class="cmdk-none" role="presentation">没有匹配的命令</li>';
    input.removeAttribute('aria-activedescendant');
    setCmdkStatus('没有匹配的命令');
    return;
  }
  let lastG = '';
  ul.innerHTML = cmdk.list.map((it, i) => {
    const on = i === cmdk.idx;
    const head = it.g !== lastG ? `<li class="cmdk-group" role="presentation">${esc(it.g)}</li>` : '';
    lastG = it.g;
    const label = `${it.g}，${it.label}${it.hint ? `，${it.hint}` : ''}`;
    return `${head}<li class="cmdk-item${on ? ' on' : ''}" id="cmdkOpt-${i}" role="option" aria-selected="${on}" aria-label="${esc(label)}" data-i="${i}">
      ${ico(it.icon)}<span class="cmdk-label">${esc(it.label)}</span>
      ${it.hint ? `<span class="cmdk-hint">${esc(it.hint)}</span>` : ''}</li>`;
  }).join('');
  const on = ul.querySelector('.cmdk-item.on');
  if (on) {
    on.scrollIntoView({ block: 'nearest' });
    input.setAttribute('aria-activedescendant', on.id);
  } else {
    input.removeAttribute('aria-activedescendant');
  }
  setCmdkStatus(`${cmdk.list.length} 个结果`);
}

function cmdkMove(step) {
  if (!cmdk.list.length) return;
  cmdk.idx = (cmdk.idx + step + cmdk.list.length) % cmdk.list.length;
  cmdkRender();
}

function cmdkRun(i) {
  const it = cmdk.list[i ?? cmdk.idx];
  closeCmdk();
  if (it) setTimeout(() => it.run(), 30);
}

function openCmdk() {
  const mask = $('#cmdkMask');
  if (!mask.hidden) { $('#cmdkInput').focus(); return; }
  cmdkPrevFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement
    : null;
  cmdk.items = cmdkSource();
  cmdk.idx = 0;
  cmdk.list = cmdkQuery('');
  mask.hidden = false;
  const input = $('#cmdkInput');
  input.value = '';
  input.setAttribute('aria-expanded', 'true');
  cmdkStatusText = '';
  cmdkRender();
  input.focus();
}
function closeCmdk({ restoreFocus = true } = {}) {
  const mask = $('#cmdkMask');
  if (mask.hidden) return;
  mask.hidden = true;
  const input = $('#cmdkInput');
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
  $('#cmdkList').innerHTML = '';
  $('#cmdkStatus').textContent = '';
  cmdkStatusText = '';
  const prev = cmdkPrevFocus;
  cmdkPrevFocus = null;
  if (restoreFocus && prev && prev.isConnected && !prev.closest('[hidden]') && prev.getClientRects().length) {
    prev.focus({ preventScroll: true });
  }
}

$('#cmdkInput').addEventListener('input', (e) => { cmdk.idx = 0; cmdk.list = cmdkQuery(e.target.value); cmdkRender(); });
$('#cmdkInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); cmdkMove(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); cmdkMove(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); cmdkRun(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeCmdk(); }
});
// 焦点留在面板里：目前只有搜索框可聚焦，Tab 也不该跑到背后的编辑器
$('#cmdkMask').addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const focusables = $$('a[href], button, input, select, textarea, [tabindex]', $('#cmdkMask'))
    .filter((el) => el.tabIndex >= 0 && !el.disabled && !el.hidden && el.getClientRects().length);
  if (!focusables.length) return;
  // 只有一个输入框时，Tab / Shift+Tab 都留在原地；也别让可滚动的结果列表截走焦点
  if (focusables.length === 1) { e.preventDefault(); focusables[0].focus(); return; }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
$('#cmdkList').addEventListener('mousemove', (e) => {
  const li = e.target.closest('.cmdk-item');
  if (!li || Number(li.dataset.i) === cmdk.idx) return;
  cmdk.idx = Number(li.dataset.i);
  cmdkRender();
});
$('#cmdkList').addEventListener('click', (e) => {
  const li = e.target.closest('.cmdk-item');
  if (li) cmdkRun(Number(li.dataset.i));
});
$('#cmdkMask').addEventListener('mousedown', (e) => { if (e.target.id === 'cmdkMask') closeCmdk(); });
$('#cmdkBtn').addEventListener('click', openCmdk);
document.addEventListener('keydown', (e) => {
  if ($('#readerMask')) return;
  if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'k') { e.preventDefault(); openCmdk(); }
  else if (e.key === 'Escape' && !$('#cmdkMask').hidden) closeCmdk();
});

/* ============================================================
 * 11.6 写作冲刺计时器（番茄钟）
 * ============================================================ */
const sprint = {
  phase: 'work',          // work | break
  running: false,
  remain: 25 * 60,
  endAt: 0,
  timer: null,
  workMin: 25,
  breakMin: 5,
  auto: true,
  sound: true,
  sessions: 0,
  focusSec: 0,
  words: 0,
  wordsAtStart: 0,
  novelId: '',
  baselineSet: false,
};
let sprintSaveT = null;

function sprintDuration(phase = sprint.phase) {
  const min = phase === 'work' ? sprint.workMin : sprint.breakMin;
  return Math.max(1, Math.round(min * 60));
}
function sprintBookWords() {
  return (S.novel?.chapters || []).reduce((sum, ch) => sum + wordsOf(ch), 0);
}
function sprintFmt(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function sprintRender() {
  const panel = $('#sprintPanel');
  if (!panel) return;
  panel.classList.toggle('break', sprint.phase === 'break');
  $('#sprintTimer').textContent = sprintFmt(sprint.remain);
  $('#sprintPhase').textContent = sprint.phase === 'work'
    ? (sprint.running ? '专注中 · 先别碰手机' : '专注时间')
    : (sprint.running ? '休息中 · 站起来走走' : '休息时间');
  $('#sprintStartText').textContent = sprint.running
    ? '暂停'
    : (sprint.remain < sprintDuration() ? '继续' : '开始');
  $('#sprintStartIcon')?.setAttribute('href', sprint.running ? '#i-pause' : '#i-play');
  const pct = Math.max(0, Math.min(100, (sprint.remain / sprintDuration()) * 100));
  const bar = $('#sprintBar > i');
  if (bar) bar.style.width = `${pct}%`;
  $('#sprintTotalSessions').textContent = String(sprint.sessions);
  $('#sprintTotalWords').textContent = fmtWords(sprint.words);
  $('#sprintTotalTime').textContent = String(Math.round(sprint.focusSec / 60));
}
function sprintSave() {
  clearTimeout(sprintSaveT);
  sprintSaveT = setTimeout(() => {
    api.send('/api/config', {
      ui: {
        sprint: {
          workMin: Math.max(1, Math.round(sprint.workMin)),
          breakMin: Math.max(1, Math.round(sprint.breakMin)),
          auto: sprint.auto,
          sound: sprint.sound,
          sessions: sprint.sessions,
          focusSec: sprint.focusSec,
          words: sprint.words,
        },
      },
    }).catch(() => {});
  }, 500);
}
function sprintBeep() {
  if (!sprint.sound) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const play = (freq, at, dur) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, ctx.currentTime + at);
      gain.gain.linearRampToValueAtTime(0.16, ctx.currentTime + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + dur + 0.02);
    };
    play(660, 0, 0.18);
    play(880, 0.22, 0.26);
    setTimeout(() => { try { ctx.close(); } catch {} }, 900);
  } catch {}
}
function sprintStopTimer() {
  if (sprint.timer) clearInterval(sprint.timer);
  sprint.timer = null;
}
function sprintStart() {
  if (sprint.running) return;
  if (sprint.remain <= 0) sprint.remain = sprintDuration();
  sprint.running = true;
  if (sprint.phase === 'work' && !sprint.baselineSet) {
    sprint.wordsAtStart = sprintBookWords();
    sprint.novelId = S.novel?.id || '';
    sprint.baselineSet = true;
  }
  sprint.endAt = Date.now() + sprint.remain * 1000;
  sprintStopTimer();
  sprint.timer = setInterval(sprintTick, 250);
  sprintRender();
}
function sprintPause() {
  if (!sprint.running) return;
  sprint.remain = Math.max(0, (sprint.endAt - Date.now()) / 1000);
  sprint.running = false;
  sprintStopTimer();
  sprintRender();
}
function sprintTick() {
  sprint.remain = Math.max(0, (sprint.endAt - Date.now()) / 1000);
  if (sprint.remain <= 0) {
    sprint.remain = 0;
    sprintComplete();
    return;
  }
  sprintRender();
}
function sprintSetPhase(phase, autoStart) {
  sprintStopTimer();
  sprint.running = false;
  sprint.phase = phase;
  sprint.remain = sprintDuration(phase);
  if (autoStart) sprintStart();
  else sprintRender();
}
function sprintComplete() {
  sprintStopTimer();
  sprint.running = false;
  if (sprint.phase === 'work') {
    sprint.sessions += 1;
    sprint.focusSec += sprintDuration('work');
    if (sprint.baselineSet && sprint.novelId && sprint.novelId === (S.novel?.id || '')) {
      sprint.words += Math.max(0, sprintBookWords() - sprint.wordsAtStart);
    }
    sprint.baselineSet = false;
    sprint.wordsAtStart = 0;
    sprint.novelId = '';
    sprintBeep();
    toast(`专注结束：本场 ${Math.max(1, Math.round(sprint.workMin))} 分钟。${sprint.auto ? '休息一下。' : ''}`, 'ok');
    sprintSave();
    sprintSetPhase('break', sprint.auto);
  } else {
    sprintBeep();
    toast('休息结束，回来继续写。', 'ok');
    sprintSetPhase('work', sprint.auto);
  }
  sprintRender();
}
function sprintSkip() {
  const next = sprint.phase === 'work' ? 'break' : 'work';
  sprintSetPhase(next, false);
  toast(next === 'break' ? '已跳到休息。' : '已跳到下一场专注。');
}
function sprintReset() {
  sprintStopTimer();
  sprint.running = false;
  sprint.phase = 'work';
  sprint.remain = sprintDuration('work');
  sprint.baselineSet = false;
  sprint.wordsAtStart = 0;
  sprint.novelId = '';
  sprintRender();
}
function sprintToggle(force) {
  const panel = $('#sprintPanel');
  if (!panel) return;
  const show = typeof force === 'boolean' ? force : panel.hidden;
  panel.hidden = !show;
  document.body.classList.toggle('sprint-open', show);
  $('#sprintBtn')?.setAttribute('aria-pressed', String(show));
  if (show) sprintRender();
}
function sprintInit() {
  const st = S.config?.ui?.sprint;
  if (st && typeof st === 'object') {
    if (Number.isFinite(Number(st.workMin))) sprint.workMin = Math.min(180, Math.max(1, Math.round(Number(st.workMin))));
    if (Number.isFinite(Number(st.breakMin))) sprint.breakMin = Math.min(60, Math.max(1, Math.round(Number(st.breakMin))));
    sprint.auto = st.auto !== false;
    sprint.sound = st.sound !== false;
    sprint.sessions = Math.max(0, Number(st.sessions) || 0);
    sprint.focusSec = Math.max(0, Number(st.focusSec) || 0);
    sprint.words = Math.max(0, Number(st.words) || 0);
  }
  $('#sprintWorkMin').value = String(sprint.workMin);
  $('#sprintBreakMin').value = String(sprint.breakMin);
  $('#sprintAutoSwitch').checked = sprint.auto;
  $('#sprintSound').checked = sprint.sound;
  if (!sprint.running) {
    sprint.phase = 'work';
    sprint.remain = sprintDuration('work');
  }
  sprintRender();
}

$('#sprintBtn')?.addEventListener('click', () => sprintToggle());
$('#sprintClose')?.addEventListener('click', () => sprintToggle(false));
$('#sprintStart')?.addEventListener('click', () => (sprint.running ? sprintPause() : sprintStart()));
$('#sprintReset')?.addEventListener('click', sprintReset);
$('#sprintSkip')?.addEventListener('click', sprintSkip);
$('#sprintWorkMin')?.addEventListener('change', (e) => {
  const v = Math.min(180, Math.max(1, Math.round(Number(e.target.value) || 25)));
  e.target.value = String(v);
  sprint.workMin = v;
  if (!sprint.running && sprint.phase === 'work') sprint.remain = sprintDuration('work');
  sprintRender();
  sprintSave();
});
$('#sprintBreakMin')?.addEventListener('change', (e) => {
  const v = Math.min(60, Math.max(1, Math.round(Number(e.target.value) || 5)));
  e.target.value = String(v);
  sprint.breakMin = v;
  if (!sprint.running && sprint.phase === 'break') sprint.remain = sprintDuration('break');
  sprintRender();
  sprintSave();
});
$('#sprintAutoSwitch')?.addEventListener('change', (e) => {
  sprint.auto = !!e.target.checked;
  sprintSave();
});
$('#sprintSound')?.addEventListener('change', (e) => {
  sprint.sound = !!e.target.checked;
  sprintSave();
});
sprintRender();

/* ============================================================
 * 12. 启动
 * ============================================================ */
async function boot() {
  try {
    S.config = await api.get('/api/config');
    document.body.dataset.theme = S.config.ui?.theme || 'dark';
  } catch (err) {
    toast(`无法读取配置：${err.message}`, 'err');
  }
  applyPaper(S.config?.ui?.editor);
  sprintInit();
  renderThemeIcon();
  try { await loadNovels(); } catch { S.novels = []; }
  refreshTrashCount();
  setView('shelf');
  loadStats();
  if (!S.config?.providers?.length) {
    setTimeout(() => toast('第一次使用：点「一键开书」，会先带你接好模型'), 500);
  }
}

window.__shu = { S, openNovel, exportBook, setView, openCmdk, closeCmdk, cmdk, sprint, sprintToggle, openHealthReport, openProof, openChapterBoard, openChapterTargetModal, toggleFocus, openGlobalSearch, openTrash, restoreNovelBackup, applyFragmentData, openStatsModal, openRevisionInbox, openModelCompare, openSubmitCheck };
boot();
