/* 书匠 · 前端逻辑（原生 ES 模块，无构建步骤） */

/* ============================================================
 * 0. 小工具
 * ============================================================ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ico = (name, cls = '') => `<svg class="ico ${cls}"><use href="#i-${name}" /></svg>`;

function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => { clearTimeout(t); t = null; };
  return d;
}
function toast(msg, kind = '') {
  const box = document.createElement('div');
  box.className = `toast ${kind}`;
  box.textContent = msg;
  $('#toastWrap').appendChild(box);
  setTimeout(() => { box.style.opacity = '0'; box.style.transition = '.3s'; }, 2600);
  setTimeout(() => box.remove(), 3000);
}
const countWords = (t) => String(t || '').replace(/\s+/g, '').length;
const fmtWords = (n) => (n >= 10000 ? `${(n / 10000).toFixed(2)} 万` : String(n));
function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtAgo(ts) {
  const d = Math.max(0, Date.now() - ts);
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return `${Math.floor(d / 60e3)} 分钟前`;
  if (d < 864e5) return `${Math.floor(d / 3600e3)} 小时前`;
  const days = Math.floor(d / 864e5);
  return days < 30 ? `${days} 天前` : `${Math.floor(days / 30)} 个月前`;
}
const uid = (p = 'x') => `${p}_${Math.random().toString(36).slice(2, 10)}`;

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

function showModal(html, onMount) {
  const mask = $('#modalMask');
  const box = $('#modal');
  box.innerHTML = html;
  mask.hidden = false;
  onMount?.(box);
  return box;
}
function closeModal() { $('#modalMask').hidden = true; $('#modal').innerHTML = ''; }
$('#modalMask').addEventListener('mousedown', (e) => { if (e.target.id === 'modalMask') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modalMask').hidden) closeModal(); });

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
};

/** 流式生成：逐块回调，返回完整文本 */
async function streamAI(body, { onDelta, onReasoning, onMeta, signal } = {}) {
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
  unsaved: new Set(),   // 还没写进磁盘的章节 id —— 按章追踪，切章后也不会忘
  savingId: null,
  saveErr: null,
  controller: null,
  out: '',
  reasoning: '',
  lastOp: null,
  styleDraft: '',
  promptPreview: null,
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
function setView(v) {
  S.view = v;
  $$('.view').forEach((el) => el.classList.toggle('on', el.id === `view-${v}`));
  $$('#topnav .tab').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  if (v === 'studio') renderStudio();
  if (v === 'bible') renderBible();
  if (v === 'shelf') renderShelf();
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

function renderShelf() {
  const q = ($('#shelfSearch').value || '').trim().toLowerCase();
  const list = S.novels.filter((n) => !q
    || n.title.toLowerCase().includes(q)
    || (n.genre || '').toLowerCase().includes(q)
    || (n.tags || []).join(',').toLowerCase().includes(q));
  const grid = $('#shelfGrid');
  grid.innerHTML = '';
  const totalWords = S.novels.reduce((s, n) => s + (n.words || 0), 0);
  $('#shelfSub').textContent = S.novels.length
    ? `共 ${S.novels.length} 部作品 · ${fmtWords(totalWords)} 字 · 全部保存在本机`
    : '所有作品都保存在本机，不上传云端';
  $('#shelfEmpty').hidden = S.novels.length > 0;

  for (const n of list) {
    const div = document.createElement('div');
    div.className = 'book';
    div.style.setProperty('--cover', coverOf(n.title));
    div.innerHTML = `
      <button class="bk-del" title="删除作品">${ico('trash')}</button>
      <h3>${esc(n.title)}</h3>
      <div class="bk-genre">${esc(n.genre || '未分类')}${(n.tags || []).length ? ' · ' + esc(n.tags.join(' ')) : ''}</div>
      <div class="bk-desc">${esc(n.logline || '还没有写简介')}</div>
      <div class="bk-line">
        <span>${n.chapterCount} 章 · ${fmtWords(n.words)} 字</span>
        <span>${esc(fmtDate(n.updatedAt).slice(5, 10))}</span>
      </div>`;
    div.addEventListener('click', (e) => {
      if (e.target.closest('.bk-del')) return;
      openNovel(n.id);
    });
    div.querySelector('.bk-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`删除《${n.title}》？该作品的正文与设定会一并从磁盘删除，无法恢复。`)) return;
      await api.del(`/api/novels/${n.id}`);
      if (S.novel?.id === n.id) {
        S.novel = null; S.chapterId = null;
        S.unsaved.clear(); S.dirty = false; refreshSavePill();   // 作品都删了，别再去补存
      }
      await loadNovels(); renderShelf(); toast('已删除');
    });
    grid.appendChild(div);
  }
}
$('#shelfSearch').addEventListener('input', debounce(renderShelf, 150));

function openNewNovelModal() {
  showModal(`
    <h3>新建作品</h3>
    <label class="field-label">书名</label><input id="nvTitle" class="input" placeholder="例如：剑来山海" />
    <div class="field-row">
      <label class="field-label">类型<input id="nvGenre" class="input" placeholder="玄幻 / 都市 / 悬疑…" /></label>
      <label class="field-label">作者名<input id="nvAuthor" class="input" /></label>
    </div>
    <label class="field-label">一句话故事<span class="field-hint">可后补</span></label>
    <input id="nvLogline" class="input" placeholder="一个少年背着一把不能出鞘的剑，去杀他师傅。" />
    <label class="field-label">目标平台</label>
    <select id="nvPlatform" class="select">
      <option value="">不限</option><option>番茄小说</option><option>起点中文网</option>
      <option>七猫</option><option>晋江</option><option>出版向</option>
    </select>
    <div class="modal-foot">
      <button class="btn btn-text" id="nvCancel">取消</button>
      <button class="btn btn-primary" id="nvOk">创建</button>
    </div>`, (box) => {
    box.querySelector('#nvCancel').onclick = closeModal;
    box.querySelector('#nvTitle').focus();
    box.querySelector('#nvOk').onclick = async () => {
      const { novel } = await api.send('/api/novels', {
        title: box.querySelector('#nvTitle').value.trim() || '未命名作品',
        genre: box.querySelector('#nvGenre').value.trim(),
        author: box.querySelector('#nvAuthor').value.trim(),
      });
      novel.meta.logline = box.querySelector('#nvLogline').value.trim();
      novel.meta.platform = box.querySelector('#nvPlatform').value;
      await api.put(`/api/novels/${novel.id}`, { meta: novel.meta });
      closeModal();
      await loadNovels();
      await openNovel(novel.id);
      toast('已创建。建议先到「设定库」写总纲，再让 AI 生成大纲', 'ok');
    };
  });
}
$('#newNovelBtn').addEventListener('click', openNewNovelModal);
$('#emptyNewBtn').addEventListener('click', openNewNovelModal);

async function openNovel(id) {
  // 换作品前先把当前作品的改动落盘 —— 一旦换过去，旧作品的内存内容就被替换了，
  // 没落盘的部分谁也救不回来。落不下去时明确问一句，别默默丢。
  if (S.novel && S.novel.id !== id && S.unsaved.size) {
    const ok = await flushSave();
    if (!ok) {
      const go = confirm(`《${S.novel.title}》还有 ${S.unsaved.size} 章没能保存（${S.saveErr || '未知原因'}）。\n继续打开别的作品会丢掉这些改动。仍要继续吗？`);
      if (!go) return;
      S.unsaved.clear();
      S.dirty = false;
      refreshSavePill();
    }
  }
  const { novel } = await api.get(`/api/novels/${id}`);
  S.novel = novel;
  S.chapterId = novel.chapters[0]?.id || null;
  S.out = ''; S.reasoning = '';
  setView('studio');
  renderStudio();
}

/* ============================================================
 * 5. 工作台
 * ============================================================ */
const currentChapter = () => S.novel?.chapters.find((c) => c.id === S.chapterId) || null;

function renderTopbarActions() {
  const mid = $('#topbarMid');
  if (!S.novel) { mid.textContent = ''; mid.onclick = null; return; }
  const total = S.novel.chapters.reduce((s, c) => s + countWords(c.content), 0);
  mid.innerHTML = `<span title="点击导出这部作品">${ico('book')}《${esc(S.novel.title)}》<span class="dim-text">${S.novel.chapters.length} 章 · ${fmtWords(total)} 字</span>${ico('download')}</span>`;
  mid.onclick = exportBook;
}

function renderStudio() {
  const wrap = $('.editor-wrap');
  const empty = $('#editorEmpty');
  const setEmpty = (on, title, text, cta) => {
    wrap.classList.toggle('is-empty', on);
    empty.hidden = !on;
    if (on) { $('#editorEmptyTitle').textContent = title; $('#editorEmptyText').textContent = text; $('#editorEmptyBtn').hidden = !cta; }
    $('#chTitle').disabled = on;
    $('#chContent').disabled = on;
    $('#formatBtn').disabled = on;
    $('#previewBtn').disabled = on;
  };

  if (!S.novel) {
    $('#chapterList').innerHTML = '<li class="chapter-empty">还没有打开作品<br>回「书架」选择或新建一部</li>';
    $('#chTitle').value = ''; $('#chContent').value = '';
    $('#chWords').textContent = '0 字';
    $('#chapterMeta').textContent = '';
    $('#footInfo').textContent = '';
    setEmpty(true, '还没有打开作品', '回「书架」选一部旧作，或者新建一部开始写。', false);
    histSync();
    renderTopbarActions();
    return;
  }
  const n = S.novel;
  const total = n.chapters.reduce((s, c) => s + countWords(c.content), 0);
  $('#chapterMeta').innerHTML = `${esc(n.genre || '未分类')} · ${n.chapters.length} 章 · ${fmtWords(total)} 字${n.meta.platform ? ` · ${esc(n.meta.platform)}` : ''}`;

  const ul = $('#chapterList');
  ul.innerHTML = '';
  if (!n.chapters.length) {
    ul.innerHTML = `<li class="chapter-empty">还没有章节<br>点上方 ＋ 新建一章</li>`;
  }
  n.chapters.forEach((c, i) => {
    const li = document.createElement('li');
    li.className = `chapter-item ${c.id === S.chapterId ? 'on' : ''}`;
    const w = countWords(c.content);
    li.innerHTML = `
      <span class="ci-no">${i + 1}</span>
      <span class="ci-title">${esc(c.title || '未命名')}</span>
      <span class="ci-words">${w || ''}</span>
      <span class="ci-act">
        <button class="mini-act" data-a="up" title="上移">${ico('chev-up')}</button>
        <button class="mini-act" data-a="down" title="下移">${ico('chev-down')}</button>
        <button class="mini-act del" data-a="del" title="删除本章">${ico('x')}</button>
      </span>`;
    li.addEventListener('click', (e) => {
      const act = e.target.closest('.mini-act')?.dataset.a;
      if (!act) return selectChapter(c.id);
      if (act === 'up' && i > 0) return moveChapter(i, i - 1);
      if (act === 'down' && i < n.chapters.length - 1) return moveChapter(i, i + 1);
      if (act === 'del') {
        (async () => {
          if (!confirm(`删除第 ${i + 1} 章「${c.title}」？`)) return;
          const { novel } = await api.del(`/api/novels/${n.id}/chapters/${c.id}`);
          S.novel = novel;
          S.unsaved.delete(c.id);            // 这一章都不要了，别再补存
          S.dirty = S.unsaved.size > 0;
          refreshSavePill();
          if (S.chapterId === c.id) S.chapterId = novel.chapters[Math.min(i, novel.chapters.length - 1)]?.id || null;
          renderStudio();
          loadNovels();
        })();
      }
    });
    ul.appendChild(li);
  });

  const ch = currentChapter();
  setEmpty(!ch, '这部作品还没有章节', '新建第一章，再让右侧助手按章纲生成正文。', true);
  $('#chTitle').value = ch?.title || '';
  const taEl = $('#chContent');
  const nextContent = ch?.content || '';
  if (taEl.value !== nextContent) taEl.value = nextContent;   // 值没变就别赋值，免得光标被弹到末尾
  $('#chWords').textContent = `${countWords(nextContent)} 字`;
  histSync();
  $('#genWords').value = n.meta.targetWordsPerChapter || 3000;
  $('#genModel').placeholder = S.config?.model || '默认';
  updateFoot();
  renderTopbarActions();
}

// 章节落盘的字段集合：自动保存 / 兜底保存 / 立即保存共用
function chapterSavePayload(ch) {
  return {
    title: ch.title, content: ch.content, summary: ch.summary,
    memory: ch.memory, status: ch.status, outline: ch.outline, outlineId: ch.outlineId,
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
  try {
    await api.put(`/api/novels/${S.novel.id}/chapters/${id}`, chapterSavePayload(ch));
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
  S.dirty = S.unsaved.size > 0;
  if (isCurrent) S.savingId = null;
  refreshSavePill();
  renderTopbarActions();
  loadNovels();
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
    if (ok) S.unsaved.delete(id);
    else {
      allOk = false;
      api.put(url, payload).catch(() => {});   // 尽力而为，但不清待存状态
    }
  }
  S.dirty = S.unsaved.size > 0;
  refreshSavePill();
  return Promise.resolve(allOk);
}

window.addEventListener('beforeunload', (e) => {
  if (!S.unsaved.size && !S.saveErr) return;
  flushSave({ beacon: true });
  // 还没落盘、或上一次保存本来就失败（服务多半还没起来）→ 拦一下
  if (S.unsaved.size || S.saveErr) {
    e.preventDefault();
    e.returnValue = '';
  }
});
// 切标签页只是「离开视线」，页面还活着 —— 走普通 PUT，失败时仍由重试接着管
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave().catch(() => {}); });

function markDirty() {
  const ch = currentChapter();
  if (ch) S.unsaved.add(ch.id);
  S.dirty = S.unsaved.size > 0;
  S.saveErr = null;
  refreshSavePill();
  saveChapterDebounced();
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
  const li = $$('#chapterList .chapter-item')[S.novel.chapters.indexOf(ch)];
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
const HIST_MAX = 120;         // 每章最多留多少步
const HIST_MERGE_MS = 900;    // 这个间隔内的连续输入算一步
const HIST_JUMP = 50;         // 一次变化超过这么多字，判定为程序写入 / 粘贴，单独成一步

function histState(id) {
  let st = HIST.map.get(id);
  if (!st) { st = { undo: [], redo: [] }; HIST.map.set(id, st); }
  return st;
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
    if (st.undo.length > HIST_MAX) st.undo.shift();
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
  if (st.redo.length > HIST_MAX) st.redo.shift();
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
  if (st.undo.length > HIST_MAX) st.undo.shift();
  applySnap(st.redo.pop());
  toast('已重做');
}

$('#undoBtn').addEventListener('click', () => { doUndo(); $('#chContent').focus(); });
$('#redoBtn').addEventListener('click', () => { doRedo(); $('#chContent').focus(); });

$('#chContent').addEventListener('input', (e) => {
  // 中文输入法组字过程中不要记点，等 compositionend 一次性记
  if (!HIST.composing && !e.isComposing) histEdit();
  editorChanged();
});
$('#chContent').addEventListener('compositionstart', () => { HIST.composing = true; });
$('#chContent').addEventListener('compositionend', () => {
  HIST.composing = false;
  histEdit();
  editorChanged();
});

function editorChanged() {
  const ch = currentChapter();
  if (!ch) return;
  ch.content = $('#chContent').value;
  const w = countWords(ch.content);
  $('#chWords').textContent = `${w} 字`;
  const li = $$('#chapterList .chapter-item')[S.novel.chapters.indexOf(ch)];
  if (li) li.querySelector('.ci-words').textContent = w;
  markDirty();
  hideSelToolbar();
  updateUndoButtons();
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

function updateFoot() {
  const ch = currentChapter();
  if (!ch) { $('#footInfo').textContent = ''; return; }
  const i = S.novel.chapters.indexOf(ch);
  $('#footInfo').textContent = [
    `第 ${i + 1} / ${S.novel.chapters.length} 章`,
    ch.memory ? '已存档记忆' : '未生成记忆',
    ch.outline?.hook ? `钩子：${ch.outline.hook}` : '',
  ].filter(Boolean).join('　·　');
}

function selectChapter(id) {
  flushSave();
  S.chapterId = id;
  S.out = ''; S.reasoning = '';
  renderOut();
  renderStudio();
}

async function moveChapter(from, to) {
  const n = S.novel;
  if (!n || to < 0 || to >= n.chapters.length) return;
  const [item] = n.chapters.splice(from, 1);
  n.chapters.splice(to, 0, item);
  renderStudio();
  try {
    const { novel } = await api.put(`/api/novels/${n.id}`, { chapters: n.chapters });
    n.chapters = novel.chapters;
    renderStudio();
  } catch (err) { toast(`移动失败：${err.message}`, 'err'); }
}

async function addChapter() {
  if (!S.novel) return toast('先打开一部作品', 'err');
  const at = S.novel.chapters.findIndex((c) => c.id === S.chapterId);
  const { novel, chapter } = await api.send(`/api/novels/${S.novel.id}/chapters`, {
    title: `第 ${S.novel.chapters.length + 1} 章`,
    at: at >= 0 ? at + 1 : undefined,
  });
  S.novel = novel;
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

$('#previewBtn').addEventListener('click', () => {
  const ch = currentChapter();
  if (!ch) return;
  showModal(`<h3>${esc(ch.title || '未命名')}</h3>
    <div style="font-family:var(--font-write);font-size:15.5px;line-height:2;white-space:pre-wrap;max-height:64vh;overflow:auto">${esc(ch.content || '（空）')}</div>
    <div class="modal-foot"><span class="dim small">${countWords(ch.content)} 字</span><button class="btn" id="pvClose">关闭</button></div>`,
    (box) => { box.querySelector('#pvClose').onclick = closeModal; });
});

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
  runSegmentOp(op, text, { start, end });
}));

/* ============================================================
 * 6. 生成
 * ============================================================ */
// 这几个任务的产出是文档型内容（Markdown），输出区按 Markdown 渲染；正文类任务保持纯文本
const MD_OUT_TASKS = new Set(['titles', 'style', 'outline']);

function renderOut() {
  const box = $('#outBox');
  box.innerHTML = (S.reasoning ? `<div class="reasoning">${esc(S.reasoning)}</div>` : '')
    + (S.outMd ? mdLite(S.out) : esc(S.out))
    + (S.controller ? '<span class="cursor"></span>' : '');
  box.scrollTop = box.scrollHeight;
  $('#outActions').hidden = !S.out;
  if (S.out) {
    $('#outInfo').textContent = `${S.outModel ? `${S.outModel} · ` : ''}${countWords(S.out)} 字${S.controller ? ' · 生成中…' : ''}`;
  } else if (!S.controller) {
    $('#outInfo').textContent = '';   // 失败或空回复后别停在「生成中…」
  }
}

function setBusy(busy) {
  $('#stopBtn').hidden = !busy;
  $('#stopBtn2').hidden = !busy;
  $('#genChapterBtn').disabled = busy;
  $('#contBtn').disabled = busy;
  $('#consistencyBtn').disabled = busy;
  $('#reviewBtn').disabled = busy;
  $$('[data-quick]').forEach((b) => { b.disabled = busy; });
  // 流式进行中禁止把半截内容写进正文
  ['#applyAppend', '#applyReplace', '#applyInsert', '#copyOut'].forEach((sl) => { const el = $(sl); if (el) el.disabled = busy; });
}

async function runStream(body, { target = 'out' } = {}) {
  if (S.controller) { toast('已有任务在跑，先停止', 'err'); return ''; }
  const ac = new AbortController();
  S.controller = ac;
  setBusy(true);
  // 产出文档型内容（大纲/起名/文风档案）的任务按 Markdown 渲染，正文类任务保持纯文本
  if (target === 'out') { S.out = ''; S.reasoning = ''; S.outModel = ''; S.outMd = MD_OUT_TASKS.has(body.task); $('#outInfo').textContent = ''; renderOut(); }
  else { $('#checkBox').innerHTML = '<span class="dim">生成中…</span>'; }
  let acc = '';
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
    if (err.name === 'AbortError') toast('已停止');
    else {
      toast(err.message, 'err');
      if (target !== 'out') $('#checkBox').innerHTML = `<span class="status-err">${esc(err.message)}</span>`;
    }
  } finally {
    S.controller = null;
    setBusy(false);
    if (target === 'out') renderOut();
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

$$('[data-quick]').forEach((btn) => btn.addEventListener('click', async () => {
  const ch = currentChapter();
  if (!ch) return toast('先选一章', 'err');
  const kind = btn.dataset.quick;

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
    toast('章节记忆已存档，后续写作会自动带上', 'ok');
  }

  if (kind === 'summarize') {
    if (!ch.content.trim()) return toast('本章还没正文', 'err');
    const text = await runStream({
      messages: [
        { role: 'system', content: '你是小说编辑。只输出结果，不要任何解释。' },
        { role: 'user', content: `用 120 字以内概括这一章的剧情（写清谁做了什么、结果如何）：\n"""\n${ch.content.slice(0, 12000)}\n"""` },
      ],
      task: 'memory',
      novelId: S.novel.id,
      chapterId: ch.id,
      temperature: 0.4,
      maxTokens: 400,
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
  $('#diffOld').textContent = oldText;
  $('#diffNew').textContent = newText;
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
  $$('#assistTabs button').forEach((x) => x.classList.toggle('on', x === b));
  $$('.assist-pane').forEach((p) => p.classList.toggle('on', p.dataset.pane === b.dataset.tab));
}));
function showAssistTab(name) {
  $$('#assistTabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === name));
  $$('.assist-pane').forEach((p) => p.classList.toggle('on', p.dataset.pane === name));
}

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

$('#consistencyBtn').addEventListener('click', async () => {
  if (!S.novel) return toast('先打开作品', 'err');
  const text = await runStream({ task: 'consistency', novelId: S.novel.id, chapterId: S.chapterId, payload: scopeForCheck() }, { target: 'check' });
  if (text) renderIssues(text);
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
 * 9. 设定库
 * ============================================================ */
let bibleTab = 'outline';
$$('#bibleTabs button').forEach((b) => b.addEventListener('click', () => {
  bibleTab = b.dataset.bible;
  $$('#bibleTabs button').forEach((x) => x.classList.toggle('on', x === b));
  renderBible();
}));

const saveNovelPart = debounce(async (part, msg) => {
  if (!S.novel) return;
  setSave('saving');
  try {
    await api.put(`/api/novels/${S.novel.id}`, part);
    refreshSavePill();          // 别把「还有章节没落盘」误报成已保存
    if (msg) toast(msg, 'ok');
    loadNovels();
  } catch (err) { setSave('dirty', '保存失败'); toast(err.message, 'err'); }
}, 700);
const SKIP_KEYS = new Set(['kwText', 'relText', 'notes']);

function field(label, key, obj, opts = {}) {
  const val = esc(obj[key] ?? '');
  return `<label class="field-label">${label}${opts.area
    ? `<textarea class="input" data-key="${key}" rows="${opts.rows || 2}">${val}</textarea>`
    : `<input class="input" data-key="${key}" value="${val}" placeholder="${esc(opts.ph || '')}" />`}</label>`;
}

function bindFields(root, obj, after, numericKeys = []) {
  $$('[data-key]', root).forEach((el) => el.addEventListener('input', () => {
    const k = el.dataset.key;
    if (SKIP_KEYS.has(k)) return;
    obj[k] = numericKeys.includes(k) ? Number(el.value) || 0 : el.value;
    after?.();
  }));
}

function renderBible() {
  const host = $('#bibleBody');
  if (!S.novel) { host.innerHTML = '<p class="dim">先打开一部作品。</p>'; return; }
  const n = S.novel;
  if (bibleTab === 'outline') return renderOutlineTab(host, n);
  if (bibleTab === 'characters') return renderCharactersTab(host, n);
  if (bibleTab === 'world') return renderWorldTab(host, n);
  if (bibleTab === 'timeline') return renderTimelineTab(host, n);
  return renderStyleTab(host, n);
}

/* ---- 大纲 ---- */
function renderOutlineTab(host, n) {
  host.innerHTML = `
    <div class="bible-block">
      <h2>全书总纲
        <span style="flex:1"></span>
        <button class="btn btn-sm" id="aiOutline">AI 生成大纲</button>
      </h2>
      <div class="grid2">
        ${field('一句话故事', 'logline', n.meta, { ph: '一个少年背着一把不能出鞘的剑，去杀他师傅。' })}
        ${field('目标平台 / 调性', 'platform', n.meta)}
      </div>
      ${field('故事梗概', 'synopsis', n.meta, { area: true, rows: 4 })}
      ${field('大纲备注（主线、支线、伏笔规划）', 'notes', n.outline, { area: true, rows: 3 })}
      <div class="row gap6">
        <button class="btn btn-sm" id="addVol">${ico('plus')}新增卷</button>
        <button class="btn btn-sm" id="genChapters">按大纲生成章节列表</button>
        <span class="dim small" id="outlineMsg"></span>
      </div>
    </div>
    <div class="bible-block">
      <h2>分卷与章纲</h2>
      <div id="volList"></div>
    </div>`;

  bindFields(host, n.meta, () => saveNovelPart({ meta: n.meta }), []);
  host.querySelector('[data-key="notes"]').addEventListener('input', () => saveNovelPart({ outline: n.outline }));

  const vl = $('#volList', host);
  if (!n.outline.volumes.length) vl.innerHTML = '<p class="dim">还没有分卷。可以点「AI 生成大纲」，或手动加一卷。</p>';
  n.outline.volumes.forEach((v, vi) => {
    const block = document.createElement('div');
    block.className = 'vol-block';
    block.innerHTML = `
      <div class="vol-head">
        <span class="dim small">第 ${vi + 1} 卷</span>
        <input class="input" data-vk="name" value="${esc(v.name || '')}" placeholder="卷名" style="max-width:220px" />
        <input class="input" data-vk="desc" value="${esc(v.desc || '')}" placeholder="本卷定位与主要冲突" />
        <button class="btn btn-sm btn-text" data-act="up" title="上移这一卷">${ico('chev-up')}</button>
        <button class="btn btn-sm btn-text" data-act="down" title="下移这一卷">${ico('chev-down')}</button>
        <button class="btn btn-sm btn-text" data-act="add" title="加一条章纲">${ico('plus')}</button>
        <button class="btn btn-sm btn-text" data-act="del" title="删除本卷">${ico('trash')}</button>
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
      n.outline.volumes.splice(vi, 1);
      renderBible();
      saveNovelPart({ outline: n.outline });
    };
    block.querySelector('[data-act="add"]').onclick = () => {
      v.chapters = v.chapters || [];
      v.chapters.push({ id: uid('o'), title: '', scene: '', characters: '', summary: '', hook: '' });
      renderBible();
      saveNovelPart({ outline: n.outline });
    };

    const cl = block.querySelector('.vol-chapters');
    (v.chapters || []).forEach((c, ci) => {
      const row = document.createElement('div');
      row.className = 'outline-row';
      row.innerHTML = `
        <span class="dim small" title="双击左侧标签可删除这条章纲">第 ${ci + 1} 章</span>
        <input class="input" data-ck="title" value="${esc(c.title || '')}" placeholder="章节名" />
        <textarea class="input" data-ck="scene" placeholder="场景 / 出场人物">${esc(c.scene || '')}</textarea>
        <textarea class="input" data-ck="summary" placeholder="核心事件 / 章末钩子">${esc(c.summary || '')}</textarea>`;
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

/* ---- 人物 ---- */
function renderCharactersTab(host, n) {
  host.innerHTML = `
    <div class="bible-block">
      <h2>人物卡
        <span style="flex:1"></span>
        <button class="btn btn-sm" id="aiChar">AI 生成人物</button>
        <button class="btn btn-sm" id="addChar">${ico('plus')}新增人物</button>
      </h2>
      <p class="dim small">人物卡会自动进入生成上下文。系统用名字与身份做相关度匹配，本章提到谁，就重点带上谁。</p>
      <div class="entry-list" id="charList"></div>
    </div>`;
  const list = $('#charList', host);
  if (!n.bible.characters.length) list.innerHTML = '<p class="dim">还没有人物卡。</p>';
  n.bible.characters.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = 'entry';
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
      ${field('关系（每行一条：对象|关系|备注）', 'relText', { relText: (c.relations || []).map((r) => `${r.to}|${r.type || ''}|${r.note || ''}`).join('\n') }, { area: true, rows: 2 })}`;
    bindFields(div, c, () => saveNovelPart({ bible: n.bible }));
    const kw = div.querySelector('[data-key="kwText"]');
    kw.addEventListener('input', () => { c.keywords = kw.value.split(/[,，、\s]+/).filter(Boolean); });
    const rel = div.querySelector('[data-key="relText"]');
    rel.addEventListener('input', () => {
      c.relations = rel.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const [to, type, note] = l.split('|').map((x) => (x || '').trim());
        return { to: to || '', type: type || '', note: note || '' };
      }).filter((r) => r.to);
    });
    div.querySelector('.del').onclick = () => {
      if (!confirm(`删除人物「${c.name || i + 1}」？`)) return;
      n.bible.characters.splice(i, 1);
      renderBible();
      saveNovelPart({ bible: n.bible });
    };
    list.appendChild(div);
  });

  $('#addChar', host).onclick = () => {
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
    arr.forEach((x) => n.bible.characters.push({ id: uid('ch'), relations: [], ...x, keywords: x.keywords || [] }));
    renderBible();
    saveNovelPart({ bible: n.bible }, `已加入 ${arr.length} 位人物`);
  };
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
      <p class="dim small">地理、势力、力量体系、规则、物品、风俗都放这里。条目名与关键词参与相关度匹配。</p>
      <div class="entry-list" id="worldList"></div>
    </div>`;
  const list = $('#worldList', host);
  if (!n.bible.world.length) list.innerHTML = '<p class="dim">还没有世界观条目。</p>';
  n.bible.world.forEach((w, i) => {
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
      ${field('检索关键词（逗号分隔）', 'kwText', { kwText: (w.keywords || []).join('，') })}`;
    bindFields(div, w, () => saveNovelPart({ bible: n.bible }));
    const kw = div.querySelector('[data-key="kwText"]');
    kw.addEventListener('input', () => { w.keywords = kw.value.split(/[,，、\s]+/).filter(Boolean); });
    div.querySelector('.del').onclick = () => {
      if (!confirm(`删除设定「${w.name || i + 1}」？`)) return;
      n.bible.world.splice(i, 1);
      renderBible();
      saveNovelPart({ bible: n.bible });
    };
    list.appendChild(div);
  });
  $('#addWorld', host).onclick = () => {
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
    arr.forEach((x) => n.bible.world.push({ id: uid('w'), keywords: [], ...x, keywords: x.keywords || [] }));
    renderBible();
    saveNovelPart({ bible: n.bible }, `已加入 ${arr.length} 条世界观`);
  };
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
      <div class="entry-list" id="tlList"></div>
    </div>`;
  const list = $('#tlList', host);
  if (!n.bible.timeline.length) list.innerHTML = '<p class="dim">还没有时间节点。</p>';
  n.bible.timeline.forEach((t, i) => {
    const div = document.createElement('div');
    div.className = 'entry';
    div.innerHTML = `
      <div class="entry-head">
        <input class="input" data-key="time" value="${esc(t.time || '')}" placeholder="时间：开元三年春 / 主角 12 岁" style="max-width:280px;font-weight:600" />
        <input class="input" data-key="title" value="${esc(t.title || '')}" placeholder="事件标题" />
        <button class="del" title="删除">${ico('trash')}</button>
      </div>
      ${field('说明', 'desc', t, { area: true, rows: 2 })}`;
    bindFields(div, t, () => saveNovelPart({ bible: n.bible }));
    div.querySelector('.del').onclick = () => {
      n.bible.timeline.splice(i, 1);
      renderBible();
      saveNovelPart({ bible: n.bible });
    };
    list.appendChild(div);
  });
  $('#addTl', host).onclick = () => {
    n.bible.timeline.push({ id: uid('t'), time: '', title: '', desc: '' });
    renderBible();
    saveNovelPart({ bible: n.bible });
  };
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
  bindFields(host, m, () => saveNovelPart({ meta: n.meta }), ['targetWordsPerChapter', 'contextBudget']);
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
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { name: '阿里通义', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max', 'qwen-long'] },
  { name: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-32k'] },
  { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus', 'glm-4-air'] },
  { name: '火山方舟（豆包）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-pro-32k'] },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini'] },
  { name: 'Ollama 本地', baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen2.5:14b'] },
];

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
        <button class="icon-btn sm" data-act="del" title="删除该服务商">${ico('trash')}</button>
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
}

function renderModelSelect() {
  const cfg = S.config;
  const models = new Set();
  (cfg.providers || []).forEach((p) => (p.models || []).forEach((m) => models.add(m)));
  const sel = $('#cfgModel');
  const opts = Array.from(models).map((m) => `<option ${cfg.model === m ? 'selected' : ''}>${esc(m)}</option>`).join('');
  sel.innerHTML = `<option value="">（未设置）</option>${opts}`;
  if (cfg.model && !models.has(cfg.model)) sel.innerHTML += `<option selected>${esc(cfg.model)}</option>`;
}

$('#cfgTemp').addEventListener('input', () => { $('#tempVal').textContent = $('#cfgTemp').value; });
$('#addProviderBtn').addEventListener('click', () => {
  const p = { id: uid('p'), name: '新服务商', baseUrl: '', apiKey: '', models: [] };
  S.config.providers.push(p);
  if (!S.config.activeProviderId) S.config.activeProviderId = p.id;
  renderSettings();
});

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
  const budget = Number($('#cfgBudget').value) || 26000;
  if (S.novel && S.novel.meta.contextBudget !== budget) {
    S.novel.meta.contextBudget = budget;
    api.put(`/api/novels/${S.novel.id}`, { meta: S.novel.meta }).catch(() => {});
  }
  await api.send('/api/config', cfg);
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
  const out = await runStream({ task: 'style', payload: { text } });
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
$('#importBtn').addEventListener('click', () => {
  if (!S.novel) return toast('先打开作品', 'err');
  showModal(`<h3>导入已有文稿</h3>
    <p class="dim small">粘贴正文，系统会按「第X章」自动切分成章节追加到末尾。适合接手旧稿后让 AI 续写。</p>
    <textarea id="impText" class="input" placeholder="第一章 落霜&#10;&#10;正文……&#10;&#10;第二章 归途&#10;&#10;正文……"></textarea>
    <div class="modal-foot"><button class="btn btn-text" id="impCancel">取消</button><button class="btn btn-primary" id="impOk">导入</button></div>`,
    (box) => {
      box.querySelector('#impCancel').onclick = closeModal;
      box.querySelector('#impOk').onclick = async () => {
        const text = box.querySelector('#impText').value;
        if (!text.trim()) return;
        const r = await api.send(`/api/novels/${S.novel.id}/import`, { text });
        closeModal();
        await openNovel(S.novel.id);
        toast(`导入 ${r.imported} 个章节`, 'ok');
      };
    });
});

function exportBook() {
  if (!S.novel) return toast('先打开作品', 'err');
  showModal(`<h3>导出《${esc(S.novel.title)}》</h3>
    <div class="grid2">
      <label class="field-label">格式
        <select id="exFmt" class="input"><option value="txt">TXT（纯文本）</option><option value="md">Markdown</option></select>
      </label>
      <label class="field-label">范围
        <select id="exScope" class="input"><option value="all">全书</option><option value="chapter">当前章</option></select>
      </label>
    </div>
    <div class="modal-foot"><button class="btn btn-text" id="exCancel">取消</button><button class="btn btn-primary" id="exOk">下载</button></div>`,
    (box) => {
      box.querySelector('#exCancel').onclick = closeModal;
      box.querySelector('#exOk').onclick = () => {
        const fmt = box.querySelector('#exFmt').value;
        const scope = box.querySelector('#exScope').value;
        const q = scope === 'chapter' && S.chapterId ? `&chapterId=${S.chapterId}` : '';
        window.location.href = `/api/novels/${S.novel.id}/export?format=${fmt}${q}`;
        closeModal();
      };
    });
}

/* ============================================================
 * 10.5 版本历史（快照 / 恢复）
 * ============================================================ */
const SNAP_KIND = {
  auto: '自动',
  manual: '手动',
  'before-delete': '删除前',
  'before-restore': '恢复前',
  'before-replace': '替换前',
  'before-shrink': '大幅删减前',
};

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

async function openHistory() {
  if (!S.novel) return toast('先打开作品', 'err');
  await saveChapterNow().catch(() => {});
  const novelId = S.novel.id;
  showModal(`<h3>版本历史 · 《${esc(S.novel.title)}》</h3>
    <p class="modal-sub">写作时每 10 分钟自动存一份；AI 替换正文、删除章节前也会自动备份。恢复前会先把当前版本存一份，所以恢复本身也能撤回。</p>
    <div class="hist-bar">
      <button class="btn btn-primary btn-sm" id="histNow">${ico('clock')}立即备份当前版本</button>
      <span class="hist-count" id="histCount"></span>
    </div>
    <div class="hist-list" id="histList"><div class="hist-empty">读取中…</div></div>
    <div class="modal-foot"><button class="btn btn-text" id="histClose">关闭</button></div>`,
  (box) => {
    const listEl = box.querySelector('#histList');
    const countEl = box.querySelector('#histCount');
    box.querySelector('#histClose').onclick = closeModal;

    const render = (list) => {
      countEl.textContent = list.length ? `已保存 ${list.length} 个版本` : '';
      if (!list.length) {
        listEl.innerHTML = `<div class="hist-empty">还没有版本记录。<br>继续写作会自动留下快照，也可以点上面的「立即备份」。</div>`;
        return;
      }
      listEl.innerHTML = list.map((s) => `
        <div class="hist-row">
          <div class="hist-info">
            <div class="hist-when">
              <b>${esc(fmtAgo(s.ts))}</b>
              <span class="hist-kind k-${esc(s.kind)}">${esc(SNAP_KIND[s.kind] || '快照')}</span>
            </div>
            <div class="hist-meta">${s.label ? `${esc(s.label)} · ` : ''}${esc(fmtDate(s.ts))} · ${s.chapters} 章 · ${fmtWords(s.words)} 字 · ${Math.max(1, Math.round(s.size / 1024))} KB</div>
          </div>
          <button class="btn btn-sm hist-restore" data-ts="${s.ts}">${ico('rotate')}恢复</button>
        </div>`).join('');
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

    const load = async () => {
      try {
        const j = await api.get(`/api/novels/${novelId}/snapshots`);
        render(j.snapshots || []);
      } catch (err) {
        listEl.innerHTML = `<div class="hist-empty">读取失败：${esc(err.message)}</div>`;
      }
    };

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
  }, 60);
}

async function openFind() {
  if (!S.novel) return toast('先打开作品', 'err');
  await saveChapterNow().catch(() => {});
  const novelId = S.novel.id;
  const ta = $('#chContent');
  const picked = ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd).trim() : '';
  const preset = picked && picked.length <= 40 && !picked.includes('\n') ? picked : '';
  showModal(`<h3>全书查找 · 《${esc(S.novel.title)}》</h3>
    <div class="find-bar">
      <input class="input" id="findQ" placeholder="查找任意文字，回车开始" autocomplete="off" />
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
    box.querySelector('#findClose').onclick = closeModal;
    if (preset) qEl.value = preset;
    qEl.focus();
    qEl.select();

    const render = (j) => {
      if (!j.total) {
        sumEl.textContent = '';
        listEl.innerHTML = `<div class="find-empty">全书没有找到「${esc(j.q)}」。</div>`;
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
    };

    const run = async () => {
      const q = qEl.value.trim();
      if (!q) return;
      sumEl.textContent = '查找中…';
      try {
        render(await api.get(`/api/novels/${novelId}/search?q=${encodeURIComponent(q)}`));
      } catch (err) {
        sumEl.textContent = '';
        listEl.innerHTML = `<div class="find-empty">查找失败：${esc(err.message)}</div>`;
      }
    };

    box.querySelector('#findGo').onclick = run;
    qEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
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
  if (!(e.ctrlKey || e.metaKey)) return;
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
  } else if (S.view === 'studio' && S.novel && e.key === 'Enter' && e.shiftKey) {
    e.preventDefault(); generateChapter();
  } else if (S.view === 'studio' && S.novel && e.key === 'Enter') {
    e.preventDefault(); continueWriting();
  } else if (e.key === 'E' && e.shiftKey) {
    e.preventDefault(); exportBook();
  } else if (e.key === 'f' && !e.shiftKey && S.novel) {
    e.preventDefault(); openFind();
  }
});

/* ============================================================
 * 11.5 命令面板（Ctrl/⌘ + K）
 * ============================================================ */
const cmdk = { items: [], list: [], idx: 0 };

function cmdkSource() {
  const out = [];
  const op = (label, icon, run, hint) => out.push({ g: '操作', label, icon, run, hint });
  op('新建作品', 'plus', () => openNewNovelModal(), 'N');
  if (S.novel) {
    op('生成本章', 'spark', () => { setView('studio'); showAssistTab('write'); generateChapter(); }, 'Ctrl+Shift+↵');
    op('续写当前章', 'pen', () => { setView('studio'); showAssistTab('write'); continueWriting(); }, 'Ctrl+↵');
    op('一致性检查', 'shield', () => { setView('studio'); showAssistTab('check'); $('#consistencyBtn').click(); });
    op('责编评审', 'stamp', () => { setView('studio'); showAssistTab('check'); $('#reviewBtn').click(); });
    op('导出作品', 'download', () => exportBook(), 'Ctrl+Shift+E');
    op('版本历史', 'clock', () => { setView('studio'); openHistory(); });
    op('撤销', 'undo', () => { setView('studio'); doUndo(); }, 'Ctrl+Z');
    op('重做', 'redo', () => { setView('studio'); doRedo(); }, 'Ctrl+Shift+Z');
    op('全书查找 / 替换', 'search', () => { setView('studio'); openFind(); }, 'Ctrl+F');
  }
  op('立即保存', 'check', manualSave, 'Ctrl+S');
  op('切换明暗主题', 'moon', () => $('#themeBtn').click());

  const go = (label, icon, v) => out.push({ g: '前往', label, icon, run: () => setView(v) });
  go('书架', 'book', 'shelf');
  go('工作台', 'pen', 'studio');
  go('设定库', 'layers', 'bible');
  go('设置', 'settings', 'settings');

  (S.novels || []).forEach((n) => out.push({
    g: '作品', label: n.title, icon: 'book', hint: `${n.chapterCount} 章`,
    run: () => openNovel(n.id),
  }));
  (S.novel?.chapters || []).slice(0, 120).forEach((c, i) => out.push({
    g: '章节', label: c.title || '未命名章节', icon: 'pen', hint: `第 ${i + 1} 章`,
    run: () => { setView('studio'); selectChapter(c.id); },
  }));
  return out.filter((x) => typeof x.run === 'function');
}

function cmdkQuery(q) {
  q = String(q || '').trim().toLowerCase();
  if (!q) return cmdk.items.slice(0, 40);
  const hit = [];
  cmdk.items.forEach((it) => {
    const l = it.label.toLowerCase();
    let s = -1;
    if (l.startsWith(q)) s = 0;
    else if (l.includes(q)) s = 1;
    else if (`${it.g} ${it.hint || ''}`.toLowerCase().includes(q)) s = 2;
    if (s >= 0) hit.push({ it, s });
  });
  return hit.sort((a, b) => a.s - b.s).slice(0, 40).map((x) => x.it);
}

function cmdkRender() {
  const ul = $('#cmdkList');
  if (!cmdk.list.length) {
    ul.innerHTML = '<li class="cmdk-none">没有匹配的命令</li>';
    return;
  }
  let lastG = '';
  ul.innerHTML = cmdk.list.map((it, i) => {
    const head = it.g !== lastG ? `<li class="cmdk-group">${esc(it.g)}</li>` : '';
    lastG = it.g;
    return `${head}<li class="cmdk-item${i === cmdk.idx ? ' on' : ''}" data-i="${i}">
      ${ico(it.icon)}<span class="cmdk-label">${esc(it.label)}</span>
      ${it.hint ? `<span class="cmdk-hint">${esc(it.hint)}</span>` : ''}</li>`;
  }).join('');
  const on = ul.querySelector('.cmdk-item.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
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
  cmdk.items = cmdkSource();
  cmdk.idx = 0;
  cmdk.list = cmdkQuery('');
  $('#cmdkMask').hidden = false;
  $('#cmdkInput').value = '';
  cmdkRender();
  $('#cmdkInput').focus();
}
function closeCmdk() {
  $('#cmdkMask').hidden = true;
  $('#cmdkList').innerHTML = '';
}

$('#cmdkInput').addEventListener('input', (e) => { cmdk.idx = 0; cmdk.list = cmdkQuery(e.target.value); cmdkRender(); });
$('#cmdkInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); cmdkMove(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); cmdkMove(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); cmdkRun(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeCmdk(); }
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
  if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'k') { e.preventDefault(); openCmdk(); }
  else if (e.key === 'Escape' && !$('#cmdkMask').hidden) closeCmdk();
});

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
  renderThemeIcon();
  try { await loadNovels(); } catch { S.novels = []; }
  setView('shelf');
  if (!S.config?.providers?.length) {
    setTimeout(() => toast('第一次使用：请到「设置」填好 Base URL 与 API Key'), 500);
  }
}

window.__shu = { S, openNovel, exportBook, setView, openCmdk, closeCmdk, cmdk };
boot();
