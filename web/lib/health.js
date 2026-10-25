// 书匠 · 全书体检（纯本地统计）
// 章节长度、重复段落、高频表达、人物断档、悬空线索……全部在本机算，不调用模型。
import { esc, countWords, toast } from './util.js';
import { buildCharacterAppearances, appearancesForCharacter, collectThreads, openRevisionCount } from './data.js';

/* ============================================================
 * 4.7 全书体检（纯本地统计）
 * ------------------------------------------------------------
 * 不调用模型，只扫一遍现有正文与章节记忆，把长篇最容易失控的
 * 几件事摆出来：章节长度、重复段落、口头禅、超长段落、对话密度、
 * 人物断档、未回收线索。所有条目都能直接跳到对应章节。
 * ============================================================ */

// Levenshtein 编辑距离（用于模糊重复检测）
function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = Array.from({ length: a.length + 1 }, (_, i) => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[a.length][b.length];
}

// 相似度判定：编辑距离 / max(len) < 0.25 视为相似（段落较长时更严格）
function isSimilarParagraph(a, b, threshold = 0.25) {
  if (a === b) return true;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen < 40) return false;
  // 段落较长时降低阈值
  const adjustedThreshold = maxLen > 200 ? threshold * 0.8 : threshold;
  const dist = levenshteinDistance(a, b);
  return dist / maxLen < adjustedThreshold;
}

export const HEALTH_PHRASES = [
  '不由得', '仿佛', '似乎', '一丝', '一抹', '眼中闪过', '嘴角勾起', '深吸一口气',
  '缓缓', '微微', '淡淡', '沉默片刻', '空气仿佛凝固', '心中一震', '瞳孔骤缩',
  '不易察觉', '意味深长', '若有所思', '与此同时', '顿时', '瞬间', '下意识',
  '忍不住', '轻轻地', '不知为何', '眼神复杂', '目光一凝', '神色一僵', '嘴角泛起',
  '倏然', '蓦地', '刹那间', '心中一凛', '头皮发麻', '脊背发凉',
];
export const HEALTH_NORM_RE = /[\s，。！？；：、…—·“”‘’"'（）()《》【】\[\]{}<>]/g;

export function healthChip(ch, text) {
  if (!ch?.id) return '';
  return `<button type="button" class="health-chip" data-health-chapter="${esc(ch.id)}" title="打开第 ${ch.no} 章">${text || `第 ${ch.no} 章`}</button>`;
}

export function healthOk(text) {
  return `<p class="health-ok">${text}</p>`;
}

export function buildHealthReport(novel) {
  const chapters = (novel?.chapters || []).map((ch, i) => {
    const content = String(ch.content || '');
    return {
      id: ch.id,
      ch,
      no: Number(ch.no) || i + 1,
      title: ch.title || '未命名',
      content,
      words: countWords(content),
      chars: content.length,
      stage: ch.stage || 'draft',
    };
  });
  const written = chapters.filter((c) => c.words > 0);
  const totalWords = chapters.reduce((s, c) => s + c.words, 0);
  const avg = written.length ? Math.round(totalWords / written.length) : 0;
  const longest = written.slice().sort((a, b) => b.words - a.words)[0] || null;
  const shortest = written.slice().sort((a, b) => a.words - b.words)[0] || null;
  const doneCount = chapters.filter((c) => c.stage === 'done').length;
  const memCount = chapters.filter((c) => c.ch.memory).length;

  // 章节长度：偏离平均线 45% 以下或 2.2 倍以上才提示，避免正常起伏被当成问题
  const outliers = [];
  if (written.length >= 4 && avg >= 300) {
    for (const c of written) {
      const ratio = c.words / avg;
      if (ratio < 0.45 || ratio > 2.2) outliers.push({ ...c, ratio });
    }
    outliers.sort((a, b) => Math.abs(b.ratio - 1) - Math.abs(a.ratio - 1));
  }
  const outlierTotal = outliers.length;

  // 重复段落：去空白和标点后比对，长段落才有意义
  // 先做精确匹配（归一化后完全相同）
  const paraMap = new Map();
  for (const c of written) {
    for (const raw of c.content.split(/\n+/)) {
      const text = raw.trim();
      const norm = text.replace(HEALTH_NORM_RE, '');
      if (norm.length < 40) continue;
      let item = paraMap.get(norm);
      if (!item) {
        item = {
          count: 0,
          chapters: new Map(),
          sample: text.length > 96 ? `${text.slice(0, 96)}…` : text,
          norm,
        };
        paraMap.set(norm, item);
      }
      item.count += 1;
      item.chapters.set(c.id, { id: c.id, no: c.no, title: c.title });
    }
  }

  // 再做模糊匹配（编辑距离相似）
  const norms = [...paraMap.keys()];
  for (let i = 0; i < norms.length; i++) {
    for (let j = i + 1; j < norms.length; j++) {
      if (isSimilarParagraph(norms[i], norms[j])) {
        // 合并到第一个
        const item1 = paraMap.get(norms[i]);
        const item2 = paraMap.get(norms[j]);
        item1.count += item2.count;
        for (const [chId, chInfo] of item2.chapters) {
          item1.chapters.set(chId, chInfo);
        }
        paraMap.delete(norms[j]);
      }
    }
  }

  const duplicateGroups = [...paraMap.values()]
    .filter((x) => x.count >= 2)
    .sort((a, b) => b.count - a.count || b.sample.length - a.sample.length);
  const duplicateTotal = duplicateGroups.length;
  const duplicates = duplicateGroups.slice(0, 6)
    .map((x) => ({ ...x, chapters: [...x.chapters.values()].sort((a, b) => a.no - b.no) }));

  // 口头禅 / AI 高频词：给的是线索，不是判决
  const phrases = HEALTH_PHRASES.map((text) => {
    const hits = [];
    let count = 0;
    for (const c of written) {
      let n = 0, at = 0;
      while ((at = c.content.indexOf(text, at)) !== -1) {
        n += 1;
        at += text.length;
      }
      if (n) {
        count += n;
        hits.push({ id: c.id, no: c.no, title: c.title, count: n });
      }
    }
    return { text, count, chapters: hits };
  }).filter((x) => x.count >= 3).sort((a, b) => b.count - a.count).slice(0, 10);

  // 超长段落
  const longParagraphs = [];
  let longParagraphTotal = 0;
  for (const c of written) {
    const lens = c.content.split(/\n+/)
      .map((p) => p.trim())
      .filter((p) => p.length >= 320)
      .map((p) => p.length);
    if (lens.length) {
      longParagraphTotal += lens.length;
      longParagraphs.push({ id: c.id, no: c.no, title: c.title, count: lens.length, max: Math.max(...lens) });
    }
  }
  longParagraphs.sort((a, b) => b.count - a.count || b.max - a.max);

  // 对话密度：只统计成对引号里的文字（“”、「」、""）
  let quotedTotal = 0, charTotal = 0;
  for (const c of written) {
    let quoted = 0;
    c.content.replace(/“[^”]*”|「[^」]*」|"[^"]*"/g, (m) => {
      quoted += m.length;
      return m;
    });
    c.dialogue = c.chars ? quoted / c.chars : 0;
    quotedTotal += quoted;
    charTotal += c.chars;
  }
  const dialogueAvg = charTotal ? quotedTotal / charTotal : 0;
  const lowDialogue = written
    .filter((c) => c.chars >= 500 && c.dialogue < 0.08)
    .sort((a, b) => a.dialogue - b.dialogue)
    .slice(0, 4);
  const highDialogue = written
    .filter((c) => c.chars >= 500 && c.dialogue > 0.75)
    .sort((a, b) => b.dialogue - a.dialogue)
    .slice(0, 4);

  // 人物断档：依据章节记忆，设定库里的人最近一次出场距今 ≥ 5 章就提示
  const charIndex = buildCharacterAppearances(novel);
  const lastNo = written.length ? Math.max(...written.map((c) => c.no)) : 0;
  const gaps = [];
  for (const c of (novel?.bible?.characters || [])) {
    const name = String(c.name || '').trim();
    if (!name) continue;
    const appear = appearancesForCharacter(c, charIndex);
    if (!appear.length) {
      if (lastNo >= 5) gaps.push({ name, role: c.role || '', lastNo: 0, gap: lastNo, id: '' });
      continue;
    }
    const last = appear[appear.length - 1];
    const lastN = Number(last.no) || 0;
    const gap = lastNo - lastN;
    if (gap >= 5 && lastN > 0) gaps.push({ name, role: c.role || '', lastNo: lastN, gap, id: last.id });
  }
  gaps.sort((a, b) => b.gap - a.gap);
  const gapTotal = gaps.length;

  // 未回收线索：从章节记忆汇总，是否真的回收仍以正文为准
  const threads = collectThreads(novel);
  const unresolved = threads.filter((t) => t.kind === 'unresolved');
  const foreshadowing = threads.filter((t) => t.kind === 'foreshadowing');
  const staleThreads = unresolved.slice()
    .sort((a, b) => (a.latest?.no || 0) - (b.latest?.no || 0))
    .slice(0, 5);

  const issueKinds = [
    outliers.length,
    duplicates.length,
    longParagraphs.length,
    lowDialogue.length + highDialogue.length,
    gaps.length,
    staleThreads.length,
  ].filter((n) => n > 0).length;

  return {
    title: novel?.title || '',
    chapters, written, totalWords, avg, longest, shortest,
    doneCount, memCount, outliers: outliers.slice(0, 6), outlierTotal,
    duplicates, duplicateTotal, phrases,
    longParagraphs: longParagraphs.slice(0, 6), longParagraphTotal,
    dialogueAvg, lowDialogue, highDialogue,
    gaps: gaps.slice(0, 6), gapTotal,
    unresolved, foreshadowing, staleThreads,
    lastNo, issueKinds,
  };
}

/**
 * 体检项的忽略指纹：种类 + 标识。
 * 跟校对的忽略机制一样，认的是「哪一类 + 哪一条」，不认位置。
 */
export function healthKey(kind, id) {
  return `health|${kind}|${String(id ?? '')}`;
}

/**
 * 按忽略清单过滤体检结果，并把各类计数一起修正。
 * @param {object} report buildHealthReport 的结果
 * @param {{key:string}[]} ignored 忽略清单
 */
export function applyHealthIgnored(report, ignored = []) {
  const set = new Set(ignored.map((x) => (typeof x === 'string' ? x : x?.key)).filter(Boolean));
  const out = { ...report };
  const hidden = {};
  const cut = (name, kind, idOf, totalName) => {
    const before = report[name] || [];
    const after = before.filter((x) => !set.has(healthKey(kind, idOf(x))));
    out[name] = after;
    hidden[kind] = before.length - after.length;
    if (totalName) out[totalName] = Math.max(0, (report[totalName] || 0) - hidden[kind]);
  };
  cut('outliers', 'outlier', (x) => x.id, 'outlierTotal');
  cut('duplicates', 'dup', (x) => String(x.sample || '').slice(0, 40), 'duplicateTotal');
  cut('longParagraphs', 'longpara', (x) => x.id, 'longParagraphTotal');
  cut('gaps', 'gap', (x) => x.name, 'gapTotal');
  cut('staleThreads', 'thread', (x) => x.text);
  cut('phrases', 'phrase', (x) => x.text);
  out.hidden = hidden;
  // 「有几类可以处理」要按过滤后的重新算，不然忽略了还照样说有 3 类
  out.issueKinds = [
    out.outliers.length,
    out.duplicates.length,
    out.longParagraphs.length,
    (out.lowDialogue?.length || 0) + (out.highDialogue?.length || 0),
    out.gaps.length,
    out.staleThreads.length,
  ].filter((n) => n > 0).length;
  return out;
}

export function healthMarkdown(r) {  const out = [];
  const push = (s = '') => out.push(s);
  push(`# 《${r.title}》全书体检`);
  push('');
  push(`> ${new Date().toLocaleString('zh-CN')} · 本地统计，不调用模型`);
  push('');
  push(`- 总字数：${r.totalWords} 字`);
  push(`- 章节：${r.chapters.length} 章（${r.written.length} 章有正文）`);
  push(`- 平均章长：${r.avg} 字`);
  push(`- 完稿：${r.doneCount}/${r.chapters.length}`);
  push(`- 章节记忆：${r.memCount}/${r.chapters.length}`);
  if (r.outliers.length) {
    push('', '## 章节长度');
    r.outliers.forEach((c) => {
      const delta = c.ratio >= 1 ? `偏长 ${Math.round((c.ratio - 1) * 100)}%` : `偏短 ${Math.round((1 - c.ratio) * 100)}%`;
      push(`- 第 ${c.no} 章《${c.title}》：${c.words} 字（${delta}）`);
    });
  }
  if (r.duplicates.length) {
    push('', '## 重复段落');
    r.duplicates.forEach((d, i) => {
      push(`${i + 1}. ${d.sample.replace(/\s+/g, ' ')}（出现 ${d.count} 次，第 ${d.chapters.map((c) => c.no).join('、')} 章）`);
    });
  }
  if (r.phrases.length) {
    push('', '## 高频表达');
    r.phrases.forEach((p) => push(`- ${p.text}：${p.count} 次（${p.chapters.length} 章）`));
  }
  if (r.longParagraphs.length) {
    push('', '## 超长段落');
    r.longParagraphs.forEach((c) => push(`- 第 ${c.no} 章《${c.title}》：${c.count} 段，最长 ${c.max} 字`));
  }
  push('', '## 对话密度');
  push(`全书约 ${(r.dialogueAvg * 100).toFixed(1)}%（成对引号内文字占比）。`);
  if (r.lowDialogue.length) push(`- 低于 8%：第 ${r.lowDialogue.map((c) => c.no).join('、')} 章`);
  if (r.highDialogue.length) push(`- 高于 75%：第 ${r.highDialogue.map((c) => c.no).join('、')} 章`);
  if (r.gaps.length) {
    push('', '## 人物断档');
    r.gaps.forEach((g) => {
      push(`- ${g.name}${g.role ? `（${g.role}）` : ''}：${g.lastNo ? `第 ${g.lastNo} 章后未再出现，已隔 ${g.gap} 章` : '尚未在章节记忆中出现'}`);
    });
  }
  if (r.unresolved.length || r.foreshadowing.length) {
    push('', '## 线索');
    push(`- 未决 ${r.unresolved.length} 条，伏笔 ${r.foreshadowing.length} 条`);
    r.staleThreads.forEach((t) => push(`- ${t.text}（最近提到：第 ${t.latest?.no || '?'} 章）`));
  }
  return out.join('\n');
}

export async function copyHealthReport(r) {
  const text = healthMarkdown(r);
  try {
    await navigator.clipboard.writeText(text);
    toast('体检报告已复制为 Markdown', 'ok');
    return;
  } catch {}
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    toast('体检报告已复制为 Markdown', 'ok');
  } catch {
    toast('复制失败，可以手动选中报告文字', 'err');
  }
  ta.remove();
}

