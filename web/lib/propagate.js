// 书匠 · 跨章节传播分析
// 纯本地字符串匹配：给定一段文字（或当前章全文），找出其中命中的
// 设定库人物 / 世界观词条，再扫出这些词条在其他章节里写过哪儿。
// 不调用模型、不碰网络——正文离开了这台机器就再也拿不回来。

import { normalizeMentionText, worldMentionKeys, characterAliases } from './data.js';

const MAX_OCCURRENCES = 9;
const SNIPPET_BEFORE = 16;
const SNIPPET_AFTER = 20;

/**
 * 传播分析主入口。
 * @param {object} novel  作品（含 chapters / bible）
 * @param {string} sourceText  待分析的文字（当前章全文或选中的片段）
 * @param {object} [options]
 * @param {string} [options.currentChapterId]  当前章的 id，它不会被列为「受影响章节」（它就是被改的章）
 * @returns {{
 *   entities: Array<object>,
 *   totalEntities: number,
 *   totalAfter: number,
 *   totalBefore: number,
 *   sourceLength: number,
 *   currentChapterId: string,
 *   hasCurrent: boolean,
 * }}
 */
export function buildPropagationReport(novel, sourceText, options = {}) {
  const source = String(sourceText || '');
  const currentChapterId = options.currentChapterId || '';
  const chapters = (novel?.chapters || []).map((ch, i) => ({
    ch,
    no: ch?.no || i + 1,
    content: String(ch?.content || ''),
  }));
  const current = chapters.find((x) => x.ch?.id === currentChapterId);
  const currentNo = current ? current.no : Number.POSITIVE_INFINITY;
  const sourceNorm = normalizeMentionText(source);

  // 章节正文先归一化一次，所有实体共用
  const index = chapters.map(({ ch, no, content }) => ({ ch, no, norm: normalizeMentionText(content) }));

  const candidates = [];
  for (const c of novel?.bible?.characters || []) {
    candidates.push({
      kind: 'character',
      sourceId: c?.id || '',
      name: c?.name || '',
      desc: c?.role || '人物',
      keys: characterAliases(c),
    });
  }
  for (const w of novel?.bible?.world || []) {
    candidates.push({
      kind: 'world',
      sourceId: w?.id || '',
      name: w?.name || '',
      desc: w?.category || '设定',
      keys: worldMentionKeys(w),
    });
  }

  // 命中源文本 + 命中别的章节，才值得报
  const entities = [];
  for (const cand of candidates) {
    const keys = [...new Set(cand.keys)].filter((k) => k.length >= 2 && sourceNorm.includes(k));
    if (!keys.length) continue;
    const hits = [];
    for (const { ch, no, norm } of index) {
      if (!norm || ch?.id === currentChapterId) continue;
      const firstKey = keys.find((k) => norm.includes(k));
      if (!firstKey) continue;
      let occurrences = 0;
      for (const k of keys) {
        let from = 0;
        while (occurrences < MAX_OCCURRENCES) {
          const at = norm.indexOf(k, from);
          if (at < 0) break;
          occurrences += 1;
          from = at + k.length;
        }
        if (occurrences >= MAX_OCCURRENCES) break;
      }
      const at = norm.indexOf(firstKey);
      const start = Math.max(0, at - SNIPPET_BEFORE);
      const end = Math.min(norm.length, at + firstKey.length + SNIPPET_AFTER);
      const snippet = (start > 0 ? '…' : '') + norm.slice(start, end) + (end < norm.length ? '…' : '');
      hits.push({
        id: ch?.id || '',
        no,
        title: ch?.title || '',
        snippet,
        count: Math.min(occurrences, MAX_OCCURRENCES),
        fromCap: occurrences >= MAX_OCCURRENCES,
        side: no < currentNo ? 'before' : 'after',
      });
    }
    if (!hits.length) continue;
    hits.sort((a, b) => a.no - b.no);
    const before = hits.filter((h) => h.side === 'before').length;
    const after = hits.filter((h) => h.side === 'after').length;
    entities.push({
      ...cand,
      keys,
      chapters: hits,
      totalChapters: hits.length,
      occurrences: hits.reduce((n, h) => n + h.count, 0),
      before,
      after,
    });
  }

  entities.sort((a, b) => b.after - a.after || b.totalChapters - a.totalChapters || String(a.name).localeCompare(String(b.name), 'zh'));

  return {
    entities,
    totalEntities: entities.length,
    totalAfter: entities.reduce((n, e) => n + e.after, 0),
    totalBefore: entities.reduce((n, e) => n + e.before, 0),
    sourceLength: source.length,
    currentChapterId,
    hasCurrent: Boolean(current),
  };
}
