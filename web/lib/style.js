// 书匠 · 作者体测：把你前 3 章当「基准体检」，之后的每一章和它对比。
// 漂移是小说的慢性毒——比一次性失误更隐蔽，所以要有数字地盯着。
// 只读本地指标，不调模型。

const average = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const MIN_WORDS = 180;
const SENT_DRIFT = 0.4;      // 平均句长偏离基准 40% 以上才记一笔
const DIALOG_DRIFT = 0.16;   // 对话占比偏离基准 16 个百分点才记一笔

// 与 consistency.js 中同名函数保持一致：把人称归成 first / third / mixed
function detectPerson(text) {
  const firstPersonPatterns = [
    /我[的们]/g, /我的/g, /我[^的们]/g,
    /俺[的们]?/g, /鄙人/g, /在下/g,
    /本[人座主]/g, /吾/g, /吾等/g,
  ];
  const thirdPersonPatterns = [
    /(?:他|她|它|其)[的们]?/g,
    /(?:他|她|它)(?:说|想|看|走|跑|笑|哭|怒|喜)/g,
    /(?:此人|该|其人|彼|旁人|别人|众人|他人)/g,
    /主角|男主|女主|配角|反派|路人/g,
  ];
  const secondPersonPatterns = [
    /你[的们]?/g, /您[的们]?/g, /汝[的们]?/g, /尔[的们]?/g,
  ];
  let first = 0, third = 0, second = 0;
  for (const p of firstPersonPatterns) first += (text.match(p) || []).length;
  for (const p of thirdPersonPatterns) third += (text.match(p) || []).length;
  for (const p of secondPersonPatterns) second += (text.match(p) || []).length;
  const total = first + third + second;
  if (total === 0) return 'mixed';
  const firstRatio = first / total;
  const thirdRatio = third / total;
  if (firstRatio > 0.5 && first > third * 2) return 'first';
  if (thirdRatio > 0.5 && third > first * 2) return 'third';
  return 'mixed';
}

/** 单章体测指标 */
function metricsOf(text) {
  const sentences = String(text || '').split(/[。！？.!?]+/).filter((s) => s.trim().length > 0);
  const chars = String(text || '').length;
  const avgSentLen = sentences.length ? chars / sentences.length : 0;
  // 对话占比：配对引号里的字数占比（与一致性检查口吻检测同一算法）
  const dialogChars = (String(text || '').match(/“[^”]*”|「[^」]*」|"[^"]*"/g) || []).join('').length;
  const dialogRatio = chars ? dialogChars / chars : 0;
  const person = detectPerson(text);
  return { chars, sentences: sentences.length, avgSentLen, dialogRatio, person };
}

export function buildAuthorDrift(novel) {
  const chapters = (novel?.chapters || [])
    .map((ch, i) => ({ ch, no: ch?.no || i + 1, content: String(ch?.content || '') }))
    .filter((c) => c.content.trim().length >= MIN_WORDS);
  if (chapters.length < 4) return [];

  // 基准：最早 3 章（logline 不一定靠谱，章节顺序是作品的真相）
  const baseline = chapters.slice(0, 3).map((c) => metricsOf(c.content));
  const baseSentLen = average(baseline.map((m) => m.avgSentLen)) || 1;
  const baseDialogRatio = average(baseline.map((m) => m.dialogRatio));
  const personCount = new Map();
  for (const m of baseline) personCount.set(m.person, (personCount.get(m.person) || 0) + 1);
  const basePerson = [...personCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'mixed';

  const issues = [];
  for (let i = 3; i < chapters.length; i++) {
    const { ch, no, content } = chapters[i];
    const m = metricsOf(content);
    const sentDev = Math.abs(m.avgSentLen - baseSentLen) / baseSentLen;
    if (sentDev > SENT_DRIFT) {
      issues.push({
        kind: 'voice',
        type: 'styleDrift',
        severity: 'hint',
        message: `第 ${no} 章平均句长 ${Math.round(m.avgSentLen)} 字（作者基准 ${Math.round(baseSentLen)}，偏离 ${Math.round(sentDev * 100)}%）——读感会和前三章明显不一样`,
        fingerprint: `consistency|voice|styleDrift_avgSentLen|${ch.id}`,
      });
    }
    const dialogDev = Math.abs(m.dialogRatio - baseDialogRatio);
    if (dialogDev > DIALOG_DRIFT) {
      issues.push({
        kind: 'voice',
        type: 'styleDrift',
        severity: 'hint',
        message: `第 ${no} 章对话占比 ${(m.dialogRatio * 100).toFixed(0)}%（作者基准 ${(baseDialogRatio * 100).toFixed(0)}%，偏离 ${Math.round(dialogDev * 100)} 个点）`,
        fingerprint: `consistency|voice|styleDrift_dialogRatio|${ch.id}`,
      });
    }
    if (basePerson !== 'mixed' && m.person !== 'mixed' && m.person !== basePerson) {
      issues.push({
        kind: 'voice',
        type: 'styleDrift',
        severity: 'hint',
        message: `第 ${no} 章叙述人称变成了「${m.person}」，作者基准是「${basePerson}」——多半是改过稿或换了手`,
        fingerprint: `consistency|voice|styleDrift_person|${ch.id}`,
      });
    }
  }
  return issues;
}

/** 作者基准：前 3 章的指标均值，供 UI 同场展示 */
export function buildAuthorBaseline(novel) {
  const chapters = (novel?.chapters || [])
    .map((ch, i) => ({ ch, no: ch?.no || i + 1, content: String(ch?.content || '') }))
    .filter((c) => c.content.trim().length >= MIN_WORDS)
    .slice(0, 3);
  if (!chapters.length) return null;
  const ms = chapters.map((c) => metricsOf(c.content));
  return {
    chapters: chapters.map((c) => ({ id: c.ch.id, no: c.no, title: c.ch?.title || '未命名' })),
    avgSentLen: Math.round(average(ms.map((m) => m.avgSentLen))),
    dialogRatio: average(ms.map((m) => m.dialogRatio)),
    person: detectPerson(chapters.map((c) => c.content).join('\n')),
  };
}
