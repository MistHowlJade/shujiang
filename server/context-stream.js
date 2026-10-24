// 书匠 · 上下文组装（流式/分片版）
// 将原本一次性加载的 buildContext 拆成可迭代、可中断、可优先级排序的分片
// 适配 Web Worker 或主线程异步迭代，避免大小说一次性塞内存

import { terms, score, fmtCharacter, fmtWorld, fmtTimeline, fmtMemory, recentMemories, chapterTail } from './context.js';
import { chapterVolumeIds, findOutlineEntry } from './store.js';

const DEFAULT_BUDGET = 26000;

/**
 * 流式上下文组装器
 * 返回 AsyncGenerator，每次 yield 一个 { type, data, priority } 分片
 * 调用方可按需消费，或设置 maxChunks 限制
 */
export async function* buildContextStream(novel, opts = {}) {
  const chapters = novel.chapters || [];
  const idx = opts.chapterId ? novel.chapters.findIndex((c) => c.id === opts.chapterId) : novel.chapters.length;
  const chapter = idx >= 0 ? novel.chapters[idx] : null;
  const prevIndex = idx >= 0 ? idx : novel.chapters.length;
  
  const budget = opts.budget || novel.meta?.contextBudget || DEFAULT_BUDGET;
  let used = 0;
  
  // 优先级队列：高优先级先 yield
  const queue = [];
  
  const enqueue = (priority, type, data, meta = {}) => {
    queue.push({ priority, type, data, meta });
    queue.sort((a, b) => b.priority - a.priority);
  };
  
  // 基础分片生成器
  function makeChunk(title, body, force = false) {
    if (!body) return null;
    const block = title ? `### ${title}\n${body}` : body;
    return { title, body, length: block.length };
  }
  
  const push = (chunk, force = false) => {
    if (!chunk) return false;
    if (!force && used + chunk.length > budget) return false;
    used += chunk.length;
    return true;
  };

  // ===== 1. 总纲（最高优先级） =====
  const m = novel.meta || {};
  const topBits = [
    m.logline && `一句话故事：${m.logline}`,
    m.synopsis && `故事梗概：${m.synopsis}`,
  ].filter(Boolean).join('\n');
  if (topBits) enqueue(100, 'outline', makeChunk('全书总纲', topBits, true));
  
  const volumes = novel.outline?.volumes || [];
  if (volumes.length) {
    const volOverview = volumes
      .map((v, i) => `第${i + 1}卷 ${v.name}：${(v.desc || '').slice(0, 90)}`)
      .join('\n');
    enqueue(90, 'volumes', makeChunk('分卷结构', volOverview, true));
  }
  if (novel.outline?.notes) enqueue(80, 'outline_notes', makeChunk('大纲备注', String(novel.outline.notes).slice(0, 1200), true));

  // ===== 2. 当前卷 / 当前章大纲 =====
  const linkedOutline = findOutlineEntry(novel, chapter?.outlineId)?.entry || null;
  const chapterOutline = {
    scene: linkedOutline?.scene || chapter?.outline?.scene || '',
    characters: linkedOutline?.characters || chapter?.outline?.characters || '',
    summary: linkedOutline?.summary || chapter?.outline?.summary || '',
    hook: linkedOutline?.hook || chapter?.outline?.hook || '',
  };
  
  let currentVolume = null;
  if (chapter && idx >= 0) {
    const volId = chapterVolumeIds(novel)[idx];
    if (volId) currentVolume = volumes.find((v) => v.id === volId) || null;
  }
  
  if (currentVolume) {
    const noOf = new Map();
    for (const c of (novel.chapters || [])) if (c.outlineId && c.no) noOf.set(c.outlineId, c.no);
    const detail = (currentVolume.chapters || [])
      .map((c, i) => {
        const mark = chapter && c.id && c.id === chapter.outlineId ? ' ←本章' : '';
        const bits = [
          c.scene && `场景：${c.scene}`,
          c.characters && `出场：${c.characters}`,
          c.summary && `事件：${c.summary}`,
          c.hook && `钩子：${c.hook}`,
        ].filter(Boolean);
        return `第${noOf.get(c.id) || i + 1}章 ${c.title || ''}${mark}\n  ${bits.join('｜')}`;
      })
      .join('\n');
    enqueue(95, 'volume_outline', makeChunk(`第${volumes.indexOf(currentVolume) + 1}卷《${currentVolume.name}》章纲`, detail.slice(0, 4000), true));
  }
  
  if (chapter && (chapterOutline.scene || chapterOutline.characters || chapterOutline.summary || chapterOutline.hook || chapter.summary)) {
    const o = chapterOutline;
    const body = [o.scene && `场景：${o.scene}`, o.characters && `出场：${o.characters}`, o.summary || chapter.summary, o.hook && `章末钩子：${o.hook}`].filter(Boolean).join('\n');
    enqueue(98, 'chapter_outline', makeChunk('本章要点', body, true));
  }

  // ===== 3. 关键字提取（用于后续相关度排序） =====
  const query = [
    chapter?.title,
    chapter?.summary,
    chapterOutline.summary,
    chapterOutline.scene,
    chapterOutline.characters,
    opts.extraQuery,
    novel.chapters.slice(Math.max(0, prevIndex - 3), prevIndex).map((c) => `${c.title} ${c.summary || c.memory?.summary || ''}`).join(' '),
  ].filter(Boolean).join(' ');
  const qt = terms(query);

  // ===== 3. 人物卡（按相关度分批） =====
  const chars = (novel.bible?.characters || []).map((c) => ({ c, s: score(qt, c, [(x) => x.name, (x) => x.identity, (x) => x.role]) }));
  const hitChars = chars.filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  const restChars = chars.filter((x) => x.s <= 0);
  
  if (hitChars.length) {
    // 高相关度人物：逐个 yield
    for (const { c, s } of hitChars.slice(0, 10)) {
      enqueue(90 - Math.min(9, s), 'character', makeChunk('人物卡', fmtCharacter(c)));
    }
  }
  if (restChars.length) {
    enqueue(30, 'characters_overview', makeChunk('其他人物速览', restChars.slice(0, 30).map((x) => fmtCharacter(x.c, true)).join('\n')));
  }

  // ===== 4. 世界观条目 =====
  const worlds = (novel.bible?.world || []).map((w) => ({ w, s: score(qt, w, [(x) => x.name, (x) => x.category]) }));
  worlds.sort((a, b) => b.s - a.s);
  const hitWorlds = worlds.filter((x) => x.s > 0).slice(0, 18);
  const otherWorlds = worlds.filter((x) => x.s <= 0).slice(0, 12);
  
  for (const { w } of hitWorlds) {
    enqueue(70, 'world', makeChunk('世界观设定', fmtWorld(w)));
  }
  if (otherWorlds.length) {
    enqueue(20, 'worlds_overview', makeChunk('其他世界观速览', otherWorlds.map((x) => fmtWorld(x.w)).join('\n')));
  }

  // ===== 5. 时间线 =====
  const tl = (novel.bible?.timeline || [])
    .map((t) => ({ t, s: score(qt, t, [(x) => x.title, (x) => x.desc || x.detail]) }))
    .sort((a, b) => b.s - a.s);
  const hitTl = tl.filter((x) => x.s > 0).slice(0, 12);
  for (const { t } of hitTl) {
    enqueue(60, 'timeline', makeChunk('时间线', fmtTimeline(t)));
  }

  // ===== 6. 前情记忆：最近 6 章固定带 =====
  const recent = recentMemories(novel.chapters, prevIndex, 6);
  for (const mem of recent) {
    enqueue(80, 'memory', makeChunk('记忆', fmtMemory(mem)));
  }

  // 更早的按需检索
  const earlier = novel.chapters
    .slice(0, Math.max(0, prevIndex - 6))
    .filter((c) => c.memory?.summary || c.summary)
    .map((c) => ({ c, s: score(qt, c, [(x) => x.title]) + (c.memory?.events || []).reduce((a, e) => a + (qt.has(e.slice(0, 4)) ? 1 : 0), 0) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 5);
  for (const { c } of earlier) {
    enqueue(50, 'memory', makeChunk('记忆', fmtMemory(c)));
  }

  // ===== 7. 未回收的伏笔 =====
  const foreshadows = [];
  novel.chapters.slice(0, prevIndex).forEach((c) => {
    (c.memory?.foreshadowing || []).forEach((f) => foreshadows.push(`第${c.no}章：${f}`));
  });
  for (const f of foreshadows.slice(-12)) {
    enqueue(40, 'foreshadow', makeChunk('伏笔', f));
  }

  // ===== 按优先级 yield 分片 =====
  for (const item of queue) {
    yield { 
      type: item.type, 
      data: item.data, 
      priority: item.priority,
      meta: { used, budget, progress: used / budget }
    };
    // 允许主线程插入微任务
    await Promise.resolve();
  }

  // 返回统计信息
  return {
    pack: queue.map((q) => q.data).filter(Boolean),
    used,
    budget,
    stats: {
      packChars: used,
      chars: hitChars.length,
      worlds: hitWorlds.length,
      timeline: hitTl.length,
      memories: recent.length + earlier.length,
    },
  };
}

/**
 * 同步版本（兼容旧 API）
 */
export function buildContextSync(novel, opts = {}) {
  // 复用原有同步逻辑（从 context.js 复制）
  return buildContext(novel, opts);
}

/**
 * 分片收集器：将流式分片收集为完整上下文
 */
export async function collectContextStream(generator, opts = {}) {
  const chunks = [];
  let used = 0;
  for await (const chunk of generator) {
    if (opts.maxChunks && chunks.length >= opts.maxChunks) break;
    if (chunk.data) chunks.push(chunk.data);
  }
  return chunks;
}

export { terms, score, fmtCharacter, fmtWorld, fmtTimeline, fmtMemory, recentMemories, chapterTail } from './context.js';
export { chapterVolumeIds, findOutlineEntry } from './store.js';