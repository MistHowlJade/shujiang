// 本地文件存储层：纯 JSON，全部落在项目目录下的 data/ 里，不联网、不上云。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
// 数据目录默认在项目里（data/），可以用 SHU_DATA_DIR 换到别的地方。
// 桌面安装版会把它指到用户的 AppData 目录，避免往安装目录写文件。
export const DATA_DIR = process.env.SHU_DATA_DIR ? path.resolve(process.env.SHU_DATA_DIR) : path.join(ROOT, 'data');
export const NOVELS_DIR = path.join(DATA_DIR, 'novels');
export const TRASH_DIR = path.join(DATA_DIR, 'trash');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// 章节的写作状态：草稿 → 修改中 → 定稿（和 AI 用的 chapter.status 无关）
export const CHAPTER_STAGES = new Set(['draft', 'revising', 'done']);

// 单章目标字数只用于进度提示，不限制写作；0 表示没设目标
export function cleanTargetWords(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1000000) : 0;
}

// 封面配色下标；空字符串表示「按书名自动挑」——注意 Number('') 是 0，不能当成「选第 0 套」
export function cleanPalette(value) {
  if (value === '' || value === null || value === undefined) return '';
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n < 8 ? n : '';
}

const CONFIG_DEFAULT = {
  providers: [],
  activeProviderId: '',
  model: '',
  temperature: 0.85,
  topP: 0.95,
  maxTokens: 8192,
  // 分角色模型（留空则用上面的默认模型）
  roleModels: { write: '', summary: '', review: '' },
  // 主题：dark（默认）/ light / soft（柔光玻璃，实验）；glassLevel 只对 soft 生效
  ui: { theme: 'dark', glassLevel: 'mid' },
};

export function ensureDirs() {
  fs.mkdirSync(NOVELS_DIR, { recursive: true });
  fs.mkdirSync(TRASH_DIR, { recursive: true });
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

export const FRAGMENT_TYPES = [
  { key: 'outline', label: '大纲与分卷' },
  { key: 'scenes', label: '场景卡片' },
  { key: 'memories', label: '章节记忆' },
  { key: 'characters', label: '人物卡' },
  { key: 'world', label: '世界观' },
  { key: 'timeline', label: '时间线' },
  { key: 'beats', label: '结构/节拍' },
  { key: 'arcs', label: '人物弧光' },
  { key: 'relations', label: '关系图谱' },
  { key: 'style', label: '文风与规则' },
  { key: 'annotations', label: '批注/高亮' },
];

export function mergeById(existing, incoming) {
  const map = new Map();
  for (const item of existing) {
    if (item.id) map.set(item.id, { ...item });
  }
  for (const item of incoming) {
    if (item.id && map.has(item.id)) {
      map.set(item.id, { ...map.get(item.id), ...item });
    } else {
      const id = item.id || newId('b');
      map.set(id, { ...item, id });
    }
  }
  return Array.from(map.values());
}

/** 把若干字段写回人物卡里对应的角色（按 id 匹配；没有 id 的按名字匹配）。
 *  返回实际写上的条数。 */
function applyToCharacters(novel, data, fields, overwrite) {
  const chars = novel?.bible?.characters;
  if (!Array.isArray(chars) || !Array.isArray(data)) return 0;
  let applied = 0;
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const target = item.id
      ? chars.find((c) => c.id === item.id)
      : chars.find((c) => c.name && c.name === item.name);
    if (!target) continue;
    for (const f of fields) {
      if (item[f] === undefined) continue;
      const cur = target[f];
      // 空串/空数组也算「还没填」：新人物这些字段本来就是空的，
      // 不这么判的话导入永远写不进去。
      const empty = cur === undefined || cur === null || cur === '' || (Array.isArray(cur) && !cur.length);
      if (overwrite || empty) target[f] = item[f];
    }
    applied++;
  }
  return applied;
}

/**
 * 从片段包里取出「这一板块真正的数据」。
 * 列表型板块（人物卡、世界观、时间线、节拍、弧光、关系）导出时就是数组；
 * 单板块型（大纲、场景、记忆、批注）导出时包了一层对象，
 * 比如 {outline:{volumes,notes}}、{scenes:[…]}、{memories:[…]}。
 * 「文风与规则」则是平铺的作品文风字段，没有包装层。
 * 两种形状都认，兼容手写的导入文件。
 */
function unwrapFragmentData(raw, typeKey) {
  // 文风与规则：导出的是平铺字段，直接当对象用
  if (typeKey === 'style') {
    if (raw && !Array.isArray(raw) && typeof raw === 'object') return raw;
    return {};
  }
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  // 单板块的键名与 FRAGMENT_TYPES 的 key 一致
  const keys = ['outline', 'scenes', 'memories', 'annotations'];
  for (const k of keys) {
    if (raw[k] === undefined) continue;
    const v = raw[k];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') return v;
  }
  return [];
}

export async function applyFragmentData(novel, pkg, opts = {}) {
  // 合并策略
  const merge = (opts?.merge !== false);
  const overwrite = opts.overwrite === true;

  // 获取类型信息
  const type = FRAGMENT_TYPES.find(t => t.key === pkg.type);
  if (!type) throw new Error('未知的片段类型：' + pkg.type);

  // 各板块的实际导出形状（见 web/app.js 的 FRAGMENT_TYPES.get）：
  //   单板块类型包一层对象（{outline:{…}} / {scenes:[…]} / {style:{…}} …）
  //   列表类型直接是数组（人物卡、世界观、时间线、节拍、弧光、关系、线索）
  // 这里统一取出「这一板块真正的数据」，后面的合并逻辑就不用再关心包不包。
  const data = unwrapFragmentData(pkg.data, type.key);

  // 记录「落上了多少 / 因为对不上而跳过多少」，导入完要告诉用户，
  // 否则「导入成功」但什么都没变，是最让人困惑的失败方式。
  let applied = 0;
  let skipped = 0;

  if (type.key === 'outline') {
    if (overwrite) {
      novel.outline = { volumes: data.volumes || [], notes: data.notes || '' };
    } else {
      novel.outline ||= { volumes: [], notes: '' };
      novel.outline.volumes = mergeById(novel.outline.volumes || [], data.volumes || []);
      novel.outline.notes = data.notes || novel.outline.notes || '';
    }
    applied = (data.volumes || []).length;
  } else if (type.key === 'scenes') {
    // 场景卡片挂在各章的 scenes 上：按 chapterId 归位
    const byChapter = new Map();
    for (const s of data) {
      if (!s?.chapterId) continue;
      if (!byChapter.has(s.chapterId)) byChapter.set(s.chapterId, []);
      byChapter.get(s.chapterId).push(s);
    }
    for (const ch of novel.chapters || []) {
      const incoming = byChapter.get(ch.id);
      if (!incoming) continue;
      // 场景卡片没有稳定 id，合并时按「同位置覆盖、其余追加」处理
      if (overwrite) ch.scenes = incoming;
      else {
        const base = Array.isArray(ch.scenes) ? ch.scenes.slice() : [];
        incoming.forEach((s, i) => {
          if (i < base.length) base[i] = { ...base[i], ...s };
          else base.push(s);
        });
        ch.scenes = base;
      }
      applied += incoming.length;
    }
    skipped = data.length - applied;
  } else if (type.key === 'memories') {
    for (const m of data) {
      const ch = (novel.chapters || []).find(c => c.id === m?.chapterId);
      if (!ch) continue;
      ch.memory = m.memory;
      applied++;
    }
    skipped = data.length - applied;
  } else if (type.key === 'characters') {
    if (overwrite) novel.bible.characters = data;
    else novel.bible.characters = mergeById(novel.bible.characters || [], data);
    applied = data.length;
  } else if (type.key === 'world') {
    if (overwrite) novel.bible.world = data;
    else novel.bible.world = mergeById(novel.bible.world || [], data);
    applied = data.length;
  } else if (type.key === 'timeline') {
    if (overwrite) novel.bible.timeline = data;
    else novel.bible.timeline = mergeById(novel.bible.timeline || [], data);
    applied = data.length;
  } else if (type.key === 'beats') {
    if (overwrite) novel.beats = { items: data };
    else novel.beats = { items: mergeById(novel.beats?.items || [], data) };
    applied = data.length;
  } else if (type.key === 'arcs') {
    // 人物弧光：写回人物卡的 arc / goal / flaw（界面上「人物弧光」页签就是读这两个）
    applied = applyToCharacters(novel, data, ['arc', 'goal', 'flaw'], overwrite);
  } else if (type.key === 'relations') {
    // 关系图谱：写回人物卡的 relations（界面上「关系图谱」页签就是读这个）
    applied = applyToCharacters(novel, data, ['relations'], overwrite);
  } else if (type.key === 'style') {
    // 文风与规则：真正生效的是作品 meta 里的文风字段
    novel.meta ||= {};
    for (const [k, v] of Object.entries(data)) {
      // 新作品这些字段默认是空串/空数组，也算「还没填」，否则永远导不进去
      const cur = novel.meta[k];
      const empty = cur === undefined || cur === null || cur === '' || (Array.isArray(cur) && !cur.length);
      if (overwrite || empty) novel.meta[k] = v;
    }
    applied = 1;
  } else if (type.key === 'annotations') {
    // 批注挂在各章的 annotations 上：按 chapterId 归位
    const byChapter = new Map();
    for (const a of data) {
      if (!a?.chapterId) continue;
      if (!byChapter.has(a.chapterId)) byChapter.set(a.chapterId, []);
      byChapter.get(a.chapterId).push(a);
    }
    for (const ch of novel.chapters || []) {
      const incoming = byChapter.get(ch.id);
      if (!incoming) continue;
      if (overwrite) ch.annotations = incoming;
      else ch.annotations = mergeById(ch.annotations || [], incoming);
      applied += incoming.length;
    }
    skipped = data.length - applied;
  }
  return { ok: true, applied, skipped };
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
      contact: '',
      submissionNote: '',
      pov: '第三人称限知',
      tense: '过去时',
      tone: '',
      platform: '',
      targetWords: 0,
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
      targetWords: cleanTargetWords(n.meta?.targetWords),
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
  // 老作品没有 stage 字段：读出来统一按草稿处理，下一次保存就会写回磁盘
  // 章节序号也从数组顺序补一遍，避免旧文件里缺 no 时界面显示「第 undefined 章」
  n.chapters.forEach((c, i) => {
    c.no = i + 1;
    if (!CHAPTER_STAGES.has(c.stage)) c.stage = 'draft';
    c.targetWords = cleanTargetWords(c.targetWords);
  });
  n.meta = { ...blankNovel().meta, ...(n.meta || {}) };
  // 全书目标字数：0 表示没定；只用于算进度，不限制写作
  n.meta.targetWords = cleanTargetWords(n.meta.targetWords);
  // 封面版式与配色：不认识的当成默认
  if (!['classic', 'minimal', 'band'].includes(n.meta.coverStyle)) n.meta.coverStyle = '';
  n.meta.coverPalette = cleanPalette(n.meta.coverPalette);
  // 记下磁盘上的字数，saveNovel 用它判断这次落盘是不是「骤降」
  lastWrittenWords.set(n.id, (n.chapters || []).reduce((s, c) => s + (c.words || countWords(c.content || '')), 0));
  return n;
}

export function saveNovel(novel) {
  novel.updatedAt = Date.now();
  novel.chapters = (novel.chapters || []).map((c, i) => ({
    ...c,
    stage: CHAPTER_STAGES.has(c.stage) ? c.stage : 'draft',
    targetWords: cleanTargetWords(c.targetWords),
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

export function deleteNovel(id, { keepBackup = true } = {}) {
  if (!/^n_[a-z0-9]{6,}$/.test(String(id || ''))) return false;
  const f = novelFile(id);
  if (!fs.existsSync(f)) return false;
  if (keepBackup) {
    // 删除前留一份，误删可手工从 data/backups/<id>/ 里找回
    try {
      const n = readJson(f, null);
      if (n && n.id) createSnapshot(n, { kind: 'before-delete', label: '删除前', force: true });
    } catch (err) { console.warn('[store] 删除前备份失败', err.message); }
  }
  fs.rmSync(f);
  if (!keepBackup) {
    try { fs.rmSync(path.join(DATA_DIR, 'backups', id), { recursive: true, force: true }); } catch {}
  }
  return true;
}

/* ---------------- 回收站 ---------------- */

const TRASH_ID_RE = /^t_[a-z0-9]{6,}$/;

function trashEntryDir(trashId) {
  if (!TRASH_ID_RE.test(String(trashId || ''))) return '';
  return path.join(TRASH_DIR, trashId);
}

export function trashNovel(id) {
  if (!/^n_[a-z0-9]{6,}$/.test(String(id || ''))) return null;
  const src = novelFile(id);
  if (!fs.existsSync(src)) return null;
  const n = readJson(src, null);
  if (!n || !n.id) return null;
  ensureDirs();

  const trashId = newId('t');
  const dir = path.join(TRASH_DIR, trashId);
  const novelPath = path.join(dir, 'novel.json');
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'meta.json'), {
    trashId,
    originalId: n.id,
    title: n.title || '',
    deletedAt: Date.now(),
  });
  try {
    fs.renameSync(src, novelPath);
  } catch (err) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    throw err;
  }
  return { trashId, id: n.id, title: n.title || '' };
}

export function listTrash() {
  ensureDirs();
  const out = [];
  for (const ent of fs.readdirSync(TRASH_DIR, { withFileTypes: true })) {
    if (!ent.isDirectory() || !TRASH_ID_RE.test(ent.name)) continue;
    const dir = path.join(TRASH_DIR, ent.name);
    const meta = readJson(path.join(dir, 'meta.json'), {});
    const n = readJson(path.join(dir, 'novel.json'), null);
    if (!n || !n.id) continue;
    let deletedAt = Number(meta.deletedAt) || 0;
    if (!deletedAt) {
      try { deletedAt = fs.statSync(dir).mtimeMs; } catch {}
    }
    out.push({
      trashId: ent.name,
      id: n.id,
      title: n.title || '未命名作品',
      author: n.author || '',
      genre: n.genre || '',
      chapterCount: (n.chapters || []).length,
      words: (n.chapters || []).reduce((s, c) => s + (c.words || countWords(c.content || '')), 0),
      deletedAt,
    });
  }
  out.sort((a, b) => b.deletedAt - a.deletedAt);
  return out;
}

export function restoreNovel(trashId) {
  const dir = trashEntryDir(trashId);
  if (!dir) return { error: '回收站条目不存在', status: 404 };
  const novelPath = path.join(dir, 'novel.json');
  const n = readJson(novelPath, null);
  if (!n || !n.id || !/^n_[a-z0-9]{6,}$/.test(String(n.id))) {
    return { error: '回收站条目已损坏', status: 404 };
  }
  const target = novelFile(n.id);
  if (fs.existsSync(target)) {
    return { error: '书架里已经有同一部作品，不能直接覆盖', status: 409 };
  }
  ensureDirs();
  fs.renameSync(novelPath, target);
  fs.rmSync(dir, { recursive: true, force: true });
  return { novel: getNovel(n.id) || n };
}

export function purgeTrash(trashId) {
  const dir = trashEntryDir(trashId);
  if (!dir || !fs.existsSync(dir)) return false;
  const n = readJson(path.join(dir, 'novel.json'), null);
  fs.rmSync(dir, { recursive: true, force: true });
  // 彻底删除才一起清掉版本备份；书架里仍有同 id 作品时绝不动备份
  const id = String(n?.id || '');
  if (/^n_[a-z0-9]{6,}$/.test(id) && !fs.existsSync(novelFile(id))) {
    try { fs.rmSync(path.join(DATA_DIR, 'backups', id), { recursive: true, force: true }); } catch {}
    // 封面图也是这部作品的一部分，一并清掉（扩展名与 server/cover.js 里收的那几种一致）
    for (const ext of ['png', 'jpg', 'gif']) {
      try { fs.rmSync(path.join(DATA_DIR, 'covers', `${id}.${ext}`), { force: true }); } catch {}
    }
  }
  return true;
}

export function purgeAllTrash() {
  ensureDirs();
  let count = 0;
  for (const ent of fs.readdirSync(TRASH_DIR, { withFileTypes: true })) {
    if (ent.isDirectory() && purgeTrash(ent.name)) count += 1;
  }
  return count;
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

/** 导出时显示的卷名：卷名本身已经带「第 N 卷」就不再重复加前缀 */
export function volumeLabel(volume, no) {
  const name = String(volume?.name || '').trim();
  const seq = Number(no) || 0;
  if (!name) return `第${seq}卷`;
  if (name === `第 ${seq} 卷` || name === `第${seq}卷` || name === String(seq)) return `第${seq}卷`;
  if (/^第\s*[0-9０-９一二三四五六七八九十百千两]+\s*[卷部]/.test(name)) return name;
  return `第${seq}卷 ${name}`;
}

/** 按 id 找大纲里的章纲条目，返回 { volume, entry }；找不到返回 null */
export function findOutlineEntry(novel, outlineId) {
  if (!outlineId) return null;
  for (const volume of novel?.outline?.volumes || []) {
    const entry = (volume.chapters || []).find((c) => c?.id === outlineId);
    if (entry) return { volume, entry };
  }
  return null;
}

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

