// 书匠 · 爽点档案（纯计算）
// 从章节对象里读出 chapter.payoff（AI 打分、作者确认存入的），
// 汇总成一条从第 1 章到第 N 章的爽点曲线（每章一个满分 5 分），
// 并找出连续打档且 ≤1 分的「连档」区间。
// 不碰 DOM、不调模型——所以可以单独抽出来复用与测试。

/** 打过档的连续低分区间：startNo – endNo，至少 2 章 */
function makeFlatRun(run) {
  const start = run[0];
  const end = run[run.length - 1];
  return {
    id: `${start.no}-${end.no}`,
    startNo: start.no,
    endNo: end.no,
    count: run.length,
    chapters: run.map((c) => ({ id: c.id, no: c.no, title: c.title || '未命名' })),
    label: `第 ${start.no}–${end.no} 章连续 ${run.length} 章爽点偏低`,
  };
}

/**
 * 从作品章节汇总爽点档案。
 * @param {object} novel 作品（含 chapters；每章 payoff 为 { score, type, note, at } 或缺失）
 */
export function buildPayoffProfile(novel) {
  const chapters = (novel?.chapters || []).map((ch, i) => {
    const p = ch?.payoff;
    const score = p && typeof p.score === 'number' ? Math.max(0, Math.min(5, p.score)) : null;
    return {
      id: ch?.id || '',
      no: Number(ch?.no) || i + 1,
      title: ch?.title || '未命名',
      stage: ch?.stage || 'draft',
      score,
      type: p?.type ? String(p.type) : '',
      note: p?.note ? String(p.note) : '',
      at: Number(p?.at) || 0,
    };
  });
  const scored = chapters.filter((c) => c.score !== null).slice().sort((a, b) => a.no - b.no);
  const avg = scored.length ? scored.reduce((sum, c) => sum + c.score, 0) / scored.length : 0;
  const maxScore = scored.length ? Math.max(...scored.map((c) => c.score)) : 0;
  const best = scored.reduce((pick, c) => (c.score > (pick?.score ?? -1) ? c : pick), null);

  // 连档：只按「打过档」的章节算；没打过档的章节一律打断连档
  const flatRuns = [];
  let run = [];
  for (const c of chapters) {
    if (c.score === null) {
      if (run.length >= 2) flatRuns.push(makeFlatRun(run));
      run = [];
      continue;
    }
    if (c.score <= 1) run.push(c);
    else {
      if (run.length >= 2) flatRuns.push(makeFlatRun(run));
      run = [];
    }
  }
  if (run.length >= 2) flatRuns.push(makeFlatRun(run));

  return {
    chapters,
    scored: scored.length,
    total: chapters.length,
    avg: Math.round(avg * 10) / 10,
    maxScore,
    best,
    flatRuns,
    scoredChapters: scored,
  };
}

/** 爽点徽章的颜色分档：hi ≥ 4，mid ≥ 2，lo ≤ 1 */
export function payoffTier(score) {
  if (typeof score !== 'number') return 'none';
  if (score >= 4) return 'hi';
  if (score >= 2) return 'mid';
  return 'lo';
}
