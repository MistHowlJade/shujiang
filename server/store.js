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
    const raw = fs.readFileSync(file, 'utf8');
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
  n.chapters ||= [];
  n.meta = { ...blankNovel().meta, ...(n.meta || {}) };
  return n;
}

export function saveNovel(novel) {
  novel.updatedAt = Date.now();
  novel.chapters = (novel.chapters || []).map((c, i) => ({
    ...c,
    no: i + 1,
    words: countWords(c.content || ''),
  }));
  writeJson(novelFile(novel.id), novel);
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
  if (fs.existsSync(f)) {
    fs.rmSync(f);
    return true;
  }
  return false;
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
