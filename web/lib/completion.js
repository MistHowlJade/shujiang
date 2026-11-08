// 书匠 · 读者完读率档案（纯计算）
// 作者从平台后台手抄每章的「本章完读率」，这里汇总成一条 0-100% 的曲线。
// 不碰 DOM、不联网——只算
// 不读任何模型，可以单独抽出来复用与测试

const toPct = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
};

/**
 * 从作品章节汇总完读率档案。
 * @param {object} novel 作品（含 chapters；每章 completionRate 为 0-100 的数字或缺失）
 */
export function buildCompletionProfile(novel) {
  const chapters = (novel?.chapters || []).map((ch, i) => ({
    id: ch?.id || '',
    no: Number(ch?.no) || i + 1,
    title: ch?.title || '未命名',
    stage: ch?.stage || 'draft',
    rate: toPct(ch?.completionRate),
  }));
  const scored = chapters.filter((c) => c.rate !== null).slice().sort((a, b) => a.no - b.no);
  const avg = scored.length ? scored.reduce((s, c) => s + c.rate, 0) / scored.length : 0;
  const maxDrop = scored.length > 1
    ? scored.reduce((worst, c, i, arr) => {
        const prev = arr[i - 1];
        return prev ? Math.min(worst, c.rate - prev.rate) : worst;
      }, 0)
    : 0;
  // 首章 / 前三章的均值（新人开书最要命的两个数，写到分数后 avg 才成型）
  const first = scored.find((c) => c.no === 1) || null;
  const first3 = scored.filter((c) => c.no <= 3);
  const first3Avg = first3.length ? first3.reduce((s, c) => s + c.rate, 0) / first3.length : 0;

  return {
    chapters,
    scored: scored.length,
    total: chapters.length,
    avg: Math.round(avg),
    maxDrop: Math.round(maxDrop),
    first,
    first3Avg: Math.round(first3Avg),
  };
}

/** 完读率徽章颜色：green ≥ 50，yellow 25-49，red < 25 */
export function completionTier(rate) {
  if (typeof rate !== 'number') return 'none';
  if (rate >= 50) return 'good';
  if (rate >= 25) return 'mid';
  return 'bad';
}
