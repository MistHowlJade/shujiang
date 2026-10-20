// 本地文件存储层：纯 JSON，全部落在项目目录下的 data/ 里，不联网、不上云。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const NOVELS_DIR = path.join(DATA_DIR, 'novels');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const CONFIG_DEFAULT = {
  providers: [],
  activeProviderId: '',
  model: '',
  temperature: 0.85,
  topP: 0.95,
  maxTokens: 4096,
  // 分角色模型（留空则用上面的默认模型）
  roleModels: { write: '', summary: '', review: '' },
  ui: { theme: 'dark' },
};

export function ensureDirs() {
  fs.mkdirSync(NOVELS_DIR, { recursive: true });
}

export function readJson(file, fallback) {
  try {
    let raw = fs.readFileSync(file, 'utf8');
    // 记事本等编辑器存 UTF-8 会带 BOM，JSON.parse 会直接报错 —— 手改过的文件也得能读
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    if (!raw.trim()) return structuredClone(fallback);
    return JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[store] 读取失败', file, err.message);
    return structuredClone(fallback);
  }
}

// 原子写：先写 .tmp 再 rename，避免断电/崩溃写坏文件
export function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/* ---------------- 配置 ---------------- */

export function loadConfig() {
  const cfg = readJson(CONFIG_FILE, CONFIG_DEFAULT);
  return { ...structuredClone(CONFIG_DEFAULT), ...cfg };
}

export function saveConfig(cfg) {
  writeJson(CONFIG_FILE, cfg);
  return cfg;
}

export function maskKey(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 10) return '****';
  return `${s.slice(0, 5)}...${s.slice(-4)}`;
}

/* ---------------- 小说 ---------------- */

function novelFile(id) {
  return path.join(NOVELS_DIR, `${id}.json`);
}

export function newId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function blankNovel({ title = '未命名作品', genre = '', author = '' } = {}) {
  const now = Date.now();
  return {
    id: newId('n'),
    title,
    author,
    genre,
    tags: [],
    createdAt: now,
    updatedAt: now,
    meta: {
      logline: '',
      synopsis: '',
      pov: '第三人称限知',
      tense: '过去时',
      tone: '',
      platform: '',
      targetWordsPerChapter: 3000,
      styleNotes: '',
      styleRefs: [],
      antiAiNotes: '',
      taboos: '',
      extraRules: '',
    },
    bible: {
      characters: [],
      world: [],
      timeline: [],
    },
    outline: {
      volumes: [],
      notes: '',
    },
    chapters: [],
  };
}

export function listNovels() {
  ensureDirs();
  const out = [];
  for (const f of fs.readdirSync(NOVELS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const n = readJson(path.join(NOVELS_DIR, f), null);
    if (!n || !n.id) continue;
    const words = (n.chapters || []).reduce((s, c) => s + (c.words || 0), 0);
    out.push({
      id: n.id,
      title: n.title,
      author: n.author || '',
      genre: n.genre || '',
      tags: n.tags || [],
      chapterCount: (n.chapters || []).length,
      words,
      updatedAt: n.updatedAt || n.createdAt || 0,
      createdAt: n.createdAt || 0,
      logline: n.meta?.logline || '',
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export function getNovel(id) {
  if (!/^n_[a-z0-9]{6,}$/.test(String(id || ''))) return null;
  const n = readJson(novelFile(id), null);
  if (!n || !n.id) return null;
  // 兼容旧数据
  n.bible ||= { characters: [], world: [], timeline: [] };
  n.bible.characters ||= [];
  n.bible.world ||= [];
  n.bible.timeline ||= [];
  n.outline ||= { volumes: [], notes: '' };
  n.outline.volumes ||= [];
  // 分卷要有稳定 id：章节用 chapter.volumeId 指向它。老数据没有 id，读进来时补上。
  n.outline.volumes.forEach((v) => {
    v.id ||= newId('v');
    v.chapters ||= [];
    v.chapters.forEach((c) => { c.id ||= newId('o'); });
  });
  n.chapters ||= [];
  n.meta = { ...blankNovel().meta, ...(n.meta || {}) };
  // 记下磁盘上的字数，saveNovel 用它判断这次落盘是不是「骤降」
  lastWrittenWords.set(n.id, (n.chapters || []).reduce((s, c) => s + (c.words || countWords(c.content || '')), 0));
  return n;
}

export function saveNovel(novel) {
  novel.updatedAt = Date.now();
  novel.chapters = (novel.chapters || []).map((c, i) => ({
    ...c,
    no: i + 1,
    words: countWords(c.content || ''),
  }));
  // 覆盖前把旧版本留一份。
  // 常规快照有 10 分钟节流；字数骤降（手滑删掉大段正文）时不等节流，立刻补一份。
  const words = novel.chapters.reduce((s, c) => s + c.words, 0);
  const prev = lastWrittenWords.get(novel.id);
  const shrunk = typeof prev === 'number' && prev - words >= SHRINK_CHARS;
  try {
    createSnapshot(novel, shrunk
      ? { kind: 'before-shrink', label: '大幅删减前', force: true }
      : { kind: 'auto' });
  } catch (err) { console.warn('[store] 快照失败', err.message); }
  writeJson(novelFile(novel.id), novel);
  lastWrittenWords.set(novel.id, words);
  return novel;
}

export function createNovel(payload) {
  const n = blankNovel(payload || {});
  if (payload && Array.isArray(payload.tags)) n.tags = payload.tags;
  ensureDirs();
  saveNovel(n);
  return n;
}

export function deleteNovel(id) {
  const f = novelFile(id);
  if (!fs.existsSync(f)) return false;
  // 删除前留一份，误删可手工从 data/backups/<id>/ 里找回
  try {
    const n = readJson(f, null);
    if (n && n.id) createSnapshot(n, { kind: 'before-delete', label: '删除前', force: true });
  } catch (err) { console.warn('[store] 删除前备份失败', err.message); }
  fs.rmSync(f);
  return true;
}

/* ---------------- 版本历史（快照） ---------------- */

export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');

const SNAP_INTERVAL = 10 * 60 * 1000; // 自动快照最短间隔：10 分钟
const SNAP_KEEP_RECENT = 20;          // 无条件保留最近 20 条
const SNAP_KEEP_MAX = 60;             // 上限 60 条，更早的按天抽样保留
const SHRINK_CHARS = 800;             // 单次落盘字数骤降超过这个数，判定为「删了大段」

// 各作品最近一次落盘的总字数，用于识别骤降（随进程生命周期，重启后第一次保存会自动重建）
const lastWrittenWords = new Map();

function snapDir(id) {
  return path.join(BACKUPS_DIR, id);
}
function snapFile(id, ts) {
  return path.join(snapDir(id), `${ts}.json`);
}
function snapIndexFile(id) {
  return path.join(snapDir(id), 'index.json');
}

export function listSnapshots(id) {
  const idx = readJson(snapIndexFile(id), []);
  if (!Array.isArray(idx)) return [];
  return idx
    .filter((s) => s && typeof s.ts === 'number' && fs.existsSync(snapFile(id, s.ts)))
    .sort((a, b) => b.ts - a.ts);
}

/** 把磁盘上的当前作品存成一份快照。kind: auto / manual / before-delete / before-restore / before-shrink */
export function createSnapshot(novel, { kind = 'auto', label = '', force = false } = {}) {
  if (!novel || !novel.id) return null;
  const file = novelFile(novel.id);
  if (!fs.existsSync(file)) return null; // 还没落过盘，没有可备份的内容
  const idx = listSnapshots(novel.id);
  const last = idx[0];
  if (!force && last && Date.now() - last.ts < SNAP_INTERVAL) return null; // 常规快照的十分钟节流

  // 元数据必须来自即将复制的文件本身：saveNovel 是在写入之前调用它的，
  // 此刻磁盘上是上一个版本，用内存里的 novel 会记成新状态，列表就会张冠李戴。
  const data = readJson(file, null);
  if (!data || !data.id) return null;
  const size = fs.statSync(file).size;
  const chapters = (data.chapters || []).length;
  const words = (data.chapters || []).reduce((s, c) => s + (c.words || countWords(c.content || '')), 0);

  // 同一份内容短期内不重复备份：反复「写一段又删掉」时不会把历史刷爆
  if (last && last.size === size && last.words === words && last.chapters === chapters
      && Date.now() - last.ts < 5 * 60 * 1000) return null;

  let ts = Date.now();
  while (fs.existsSync(snapFile(novel.id, ts))) ts += 1;
  fs.mkdirSync(snapDir(novel.id), { recursive: true });
  fs.copyFileSync(file, snapFile(novel.id, ts));

  const entry = { ts, kind, label, title: data.title || '', chapters, words, size };
  pruneSnapshots(novel.id, [entry, ...idx]);
  return entry;
}

/** 最近 20 条全留，更早的每天留一条，总数不超上限 */
function pruneSnapshots(id, newestFirst) {
  const DAY = 24 * 60 * 60 * 1000;
  const keep = [];
  let prev = Infinity;
  for (const s of newestFirst) {
    if (keep.length < SNAP_KEEP_RECENT) { keep.push(s); prev = s.ts; continue; }
    if (keep.length >= SNAP_KEEP_MAX) break;
    if (prev - s.ts >= DAY) { keep.push(s); prev = s.ts; }
  }
  const keepSet = new Set(keep.map((s) => s.ts));
  for (const s of newestFirst) {
    if (keepSet.has(s.ts)) continue;
    try { fs.rmSync(snapFile(id, s.ts)); } catch { /* 文件已不在，忽略 */ }
  }
  fs.mkdirSync(snapDir(id), { recursive: true });
  writeJson(snapIndexFile(id), keep);
  return keep;
}

export function readSnapshot(id, ts) {
  if (!ts) return null;
  const n = readJson(snapFile(id, ts), null);
  return n && n.id ? n : null;
}

/* ---------------- 分卷归属 ---------------- */

/**
 * 每一章归在哪一卷：返回与 chapters 等长的卷 id 数组（'' = 未分卷）。
 * 规则（按优先级）：
 *   1. 本章写死的 volumeId（'' 表示明确不算任何卷）—— 只作用于这一章；
 *   2. 章纲归属：本章的 outlineId 指向哪一卷的章纲（大纲驱动的书靠这条）；
 *   3. 都没有 → 跟着上一章（手写章节夹在中间时不至于掉队）。
 * 注意第 1 条不是「从这里往后都算这一卷」：那样一卷的开头被挪走后，
 * 后面几十章会跟着黏过去。要整段改归属就逐章写下来（见 web/app.js 的 assignRange）。
 * 客户端 web/app.js 的 effVolumeIds() 是同一套规则，两边要一起改。
 */
export function chapterVolumeIds(novel) {
  const vols = novel?.outline?.volumes || [];
  const byOutline = new Map();
  for (const v of vols) {
    for (const o of (v.chapters || [])) if (o?.id) byOutline.set(o.id, v.id || '');
  }
  const known = new Set(vols.map((v) => v.id).filter(Boolean));
  let inherit = '';
  return (novel?.chapters || []).map((c) => {
    const raw = typeof c.volumeId === 'string' ? c.volumeId : null;
    // 明确值只认「已存在的卷」：卷被删掉后留下的僵尸 id 当没写过，别让它拦着后面的归属
    const own = raw === null ? null : raw === '' || raw === '-' ? '' : known.has(raw) ? raw : null;
    if (own !== null) { inherit = own; return own; }
    const o = c.outlineId ? byOutline.get(c.outlineId) : '';
    if (o) { inherit = o; return o; }
    return inherit;
  });
}

/* ---------------- 工具 ---------------- */

// 中文小说常用口径：去掉空白后的字符数（含标点）
export function countWords(text) {
  if (!text) return 0;
  return String(text).replace(/\s+/g, '').length;
}

export function nowId(prefix) {
  return newId(prefix);
}
