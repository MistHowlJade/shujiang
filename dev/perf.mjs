// 书匠 · 长篇性能压测
// ---------------------------------------------------------------------------
// 造一部长篇后，量一遍关键路径的耗时：打开作品、组装上下文、全书检索、
// 体检统计、章节保存、导出。哪一步明显变慢，就知道该优化哪儿。
//
// 用法：
//   tools\node\node.exe dev\gen-large-novel.js 120 3000
//   tools\node\node.exe dev\perf.mjs [作品ID]
// ===========================================================================

import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.SHU_BASE || 'http://127.0.0.1:8848';
const NOVELS_DIR = 'data/novels';

// 找压测作品
let id = process.argv[2];
if (!id) {
  const files = fs.readdirSync(NOVELS_DIR).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    try {
      const n = JSON.parse(fs.readFileSync(path.join(NOVELS_DIR, f), 'utf8'));
      if ((n.tags || []).includes('压测')) { id = n.id; break; }
    } catch { /* 跳过坏文件 */ }
  }
}
if (!id) { console.error('找不到压测作品，先跑 dev/gen-large-novel.js'); process.exit(2); }

const t = async (label, fn) => {
  const s = performance.now();
  const r = await fn();
  const ms = performance.now() - s;
  const flag = ms > 1000 ? '  ← 偏慢' : ms > 300 ? '  ← 偏慢' : '';
  console.log(`  ${String(Math.round(ms)).padStart(6)} ms  ${label}${flag}`);
  return { ms, r };
};

const get = async (u) => {
  const res = await fetch(u);
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return { raw: txt.slice(0, 200), status: res.status }; }
};
const post = async (u, b) => {
  const res = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return { raw: txt.slice(0, 200), status: res.status }; }
};

console.log('书匠 · 长篇性能压测');
console.log('作品：', id);
const meta = await get(`${BASE}/api/novels/${id}`);
if (meta.novel) {
  const n = meta.novel;
  console.log(`规模：${n.chapters.length} 章 · ${n.chapters.reduce((s, c) => s + (c.words || 0), 0).toLocaleString()} 字`);
}
console.log('');

console.log('【读取路径】');
await t('GET /api/novels（书架列表）', () => get(`${BASE}/api/novels`));
await t(`GET /api/novels/${id}（打开整本）`, () => get(`${BASE}/api/novels/${id}`));

console.log('\n【服务端计算】');
await t('POST /api/context（组装上下文）', () => post(`${BASE}/api/context`, {
  task: 'chapter', novelId: id, chapterId: meta.novel?.chapters?.[0]?.id,
  payload: { targetWords: 3000 },
}));
await t('GET /api/library-search（全书检索）', () => get(`${BASE}/api/library-search?q=剑鞘`));
await t('GET /api/stats（码字统计）', () => get(`${BASE}/api/stats?days=30`));

console.log('\n【导出】');
for (const fmt of ['md', 'txt', 'json', 'epub']) {
  await t(`GET /api/novels/${id}/export?format=${fmt}`, () => fetch(`${BASE}/api/novels/${id}/export?format=${fmt}`).then((r) => r.arrayBuffer()));
}

console.log('\n【保存】');
{
  const ch = meta.novel?.chapters?.[0];
  if (ch) {
    await t('PUT 单章保存', () => fetch(`${BASE}/api/novels/${id}/chapters/${ch.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: ch.title, content: ch.content, stage: 'done', targetWords: 0 }),
    }).then((r) => r.json()));
  }
}
