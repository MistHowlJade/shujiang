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

// 带提前退出的编辑距离：只要当前行的最小值已经超过 limit，
// 后面的行只会更大，可以立刻判定「超出上限」，不必算完整个矩阵。
function editDistanceWithin(a, b, limit) {
  if (a === b) return true;
  // 相同的前后缀不影响编辑距离，先剥掉能让矩阵小很多
  let start = 0;
  const minLen = Math.min(a.length, b.length);
  while (start < minLen && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const sa = a.slice(start, endA);
  const sb = b.slice(start, endB);
  const la = sa.length;
  const lb = sb.length;
  if (Math.abs(la - lb) > limit) return false;
  if (!la || !lb) return Math.max(la, lb) <= limit;

  let prev = new Array(lb + 1);
  let curr = new Array(lb + 1);
  for (let j = 0; j <= lb; j += 1) prev[j] = j;
  for (let i = 1; i <= la; i += 1) {
    curr[0] = i;
    let rowMin = i;
    const ai = sa[i - 1];
    for (let j = 1; j <= lb; j += 1) {
      const cost = ai === sb[j - 1] ? 0 : 1;
      let v = prev[j] + 1;
      if (curr[j - 1] + 1 < v) v = curr[j - 1] + 1;
      if (prev[j - 1] + cost < v) v = prev[j - 1] + cost;
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > limit) return false;
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[lb] <= limit;
}

// 相似段落：编辑距离占较长段落的比例低于阈值。
// 段落越长阈值越严（200 字以上从 25% 收到 20%），
// 免得长段落里正常的措辞差异被当成重复。
function isSimilarParagraph(a, b, threshold = 0.25) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen < 40) return false;
  if (a === b) return true;
  const adjusted = maxLen > 200 ? threshold * 0.8 : threshold;
  const limit = Math.ceil(maxLen * adjusted) - 1;
  if (limit < 1) return false;
  return editDistanceWithin(a, b, limit);
}

/**
 * 把归一化后的段落归成「重复组」。
 * 先精确归组，再把改了几个字的近似段落并进来；相似会连锁传递
 * （A≈B、B≈C 视为同一组），统计总出现次数与涉及章节。
 */
function groupSimilarParagraphs(items) {
  const n = items.length;
  if (!n) return [];
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  if (n <= 40) {
    // 段落很少时直接两两比，结果最稳，也不会慢
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        if (isSimilarParagraph(items[i].norm, items[j].norm)) union(i, j);
      }
    }
  } else {
    // 长篇里段落成千上万，两两全比会卡死。先用「二元组倒排」找出
    // 共享片段足够多的候选，再算编辑距离；太常见的二元组不进索引，
    // 否则「的是」「了他」这类片段会把候选集炸开。
    const grams = new Array(n);
    const df = new Map();
    for (let i = 0; i < n; i += 1) {
      const s = items[i].norm;
      const set = new Set();
      for (let k = 0; k + 1 < s.length; k += 1) set.add(s.slice(k, k + 2));
      grams[i] = set;
      for (const g of set) df.set(g, (df.get(g) || 0) + 1);
    }
    const dfCap = Math.max(16, Math.floor(n * 0.02));
    const index = new Map();
    const indexed = new Int32Array(n);
    for (let i = 0; i < n; i += 1) {
      for (const g of grams[i]) {
        if (df.get(g) > dfCap) continue;
        let bucket = index.get(g);
        if (!bucket) {
          bucket = [];
          index.set(g, bucket);
        }
        bucket.push(i);
        indexed[i] += 1;
      }
    }
    for (let i = 0; i < n; i += 1) {
      if (!indexed[i]) continue;
      const counts = new Map();
      for (const g of grams[i]) {
        const bucket = index.get(g);
        if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i) continue;
          counts.set(j, (counts.get(j) || 0) + 1);
        }
      }
      for (const [j, shared] of counts) {
        if (!indexed[j]) continue;
        if (shared < Math.min(indexed[i], indexed[j]) * 0.3) continue;
        if (isSimilarParagraph(items[i].norm, items[j].norm)) union(i, j);
      }
    }
  }

  const grouped = new Map();
  for (let i = 0; i < n; i += 1) {
    const root = find(i);
    const item = items[i];
    let g = grouped.get(root);
    if (!g) {
      g = { count: 0, chapters: new Map(), sample: item.sample, textLen: item.textLen };
      grouped.set(root, g);
    }
    g.count += item.count;
    if (item.textLen > g.textLen) {
      g.sample = item.sample;
      g.textLen = item.textLen;
    }
    for (const [chId, info] of item.chapters) g.chapters.set(chId, info);
  }
  return [...grouped.values()]
    .filter((x) => x.count >= 2)
    .sort((a, b) => b.count - a.count || b.textLen - a.textLen);
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

/** 低爽点连档：run 是一串连续 ≤1 分的章节（都有 payoff 档） */
function makeSlump(run) {
  const start = run[0];
  const end = run[run.length - 1];
  return {
    id: `${start.no}-${end.no}`,
    startNo: start.no,
    endNo: end.no,
    count: run.length,
    chapters: run.map((c) => ({ id: c.id, no: c.no, title: c.title || '未命名' })),
    label: `连续 ${run.length} 章爽点偏低（第 ${start.no}–${end.no} 章）`,
  };
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
      payoff: ch.payoff && typeof ch.payoff.score === 'number' ? ch.payoff : null,
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

  // 重复段落：去空白和标点后比对，长段落才有意义。
  // 先精确归组，再把「改了几个字」的近似段落并进来。
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
          textLen: text.length,
          norm,
        };
        paraMap.set(norm, item);
      }
      item.count += 1;
      item.chapters.set(c.id, { id: c.id, no: c.no, title: c.title });
    }
  }
  const duplicateGroups = groupSimilarParagraphs([...paraMap.values()]);
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

  // 爽点分布：连续两章及以上「打了档但 ≤ 1 分」，提醒读者可能开始打瞌睡。
  // 没打过档的章节一律不参与判断——不能因为没测就判它没戏。
  const slumps = [];
  let run = [];
  for (const c of written) {
    const s = c.payoff?.score;
    if (typeof s !== 'number') {
      if (run.length >= 2) slumps.push(makeSlump(run));
      run = [];
      continue;
    }
    if (s <= 1) run.push(c);
    else {
      if (run.length >= 2) slumps.push(makeSlump(run));
      run = [];
    }
  }
  if (run.length >= 2) slumps.push(makeSlump(run));
  const payoffCount = written.filter((c) => typeof c.payoff?.score === 'number').length;

  const issueKinds = [
    outliers.length,
    duplicates.length,
    longParagraphs.length,
    lowDialogue.length + highDialogue.length,
    gaps.length,
    staleThreads.length,
    slumps.length,
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
    payoffSlumps: slumps.slice(0, 3), payoffCount,
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
  cut('payoffSlumps', 'payoff', (x) => x.id);
  out.hidden = hidden;
  // 「有几类可以处理」要按过滤后的重新算，不然忽略了还照样说有 3 类
  out.issueKinds = [
    out.outliers.length,
    out.duplicates.length,
    out.longParagraphs.length,
    (out.lowDialogue?.length || 0) + (out.highDialogue?.length || 0),
    out.gaps.length,
    out.staleThreads.length,
    out.payoffSlumps?.length || 0,
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
  if (r.payoffSlumps?.length) {
    push('', '## 爽点分布');
    push(`- 打了档的 ${r.payoffCount || 0} 章`);
    r.payoffSlumps.forEach((s) => push(`- ${s.label}`));
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

