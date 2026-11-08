// 书匠 · 文字校对规则引擎
// 只查「排版上明显不对劲」的地方：连续标点、标点前后空格、
// 中文里的半角标点、段首标点、常见叠字、英文直引号、
// 引号/括号数量、段落收尾。全部在浏览器里跑，不调模型。
import { esc, countWords } from './util.js';

/* ============================================================
 * 4.8 文字校对（本地规则）
 * ------------------------------------------------------------
 * 只查“排版上明显不对劲”的地方：连续标点、标点前后空格、
 * 中文里的半角标点、段首标点、常见叠字、英文直引号、
 * 引号/括号数量、段落收尾。全部在浏览器里跑，不调模型。
 * ============================================================ */
export const PROOF_KINDS = {
  punct: '标点',
  quote: '引号/括号',
  typo: '叠字',
  ending: '收尾',
  ai_taste: 'AI 模板',
};
export const PROOF_MAX_CHAPTER_ISSUES = 60;
export const PROOF_PAGE = 120;

export function proofText(text) {
  return String(text || '').replace(/\r\n?/g, '\n');
}

export function proofParagraphs(content) {
  const out = [];
  let at = 0;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const text = line.trim();
    if (text) {
      const start = at + line.indexOf(text);
      out.push({ text, start, end: start + text.length });
    }
    at += line.length + 1;
  }
  return out;
}

export function proofSnippet(content, start, end) {
  const left = Math.max(0, start - 22);
  const right = Math.min(content.length, end + 22);
  const prefix = left > 0 ? '…' : '';
  const suffix = right < content.length ? '…' : '';
  const raw = content.slice(left, right).replace(/\n/g, ' ');
  return {
    snippet: `${prefix}${raw}${suffix}`,
    markStart: prefix.length + Math.max(0, start - left),
    markEnd: prefix.length + Math.max(0, Math.min(end, right) - left),
  };
}

export function proofIssue(info, content, paras, type, message, start, end, opt = {}) {
  const s = Math.max(0, Math.min(content.length, Number(start) || 0));
  const rawEnd = Number.isFinite(Number(end)) ? Number(end) : s;
  const e = Math.max(s, Math.min(content.length, rawEnd));
  let snippet = opt.snippet;
  let markStart = 0;
  let markEnd = 0;
  if (snippet !== undefined) {
    snippet = String(snippet).replace(/\n/g, ' ');
  } else {
    const part = proofSnippet(content, s, e);
    snippet = part.snippet;
    markStart = part.markStart;
    markEnd = part.markEnd;
  }
  let loc = opt.loc;
  if (!loc) {
    const i = paras.findIndex((p) => s >= p.start && s <= p.end);
    loc = i >= 0 ? `第 ${i + 1} 段` : '全章';
  }
  return {
    chId: info.id,
    no: info.no,
    title: info.title,
    type,
    message,
    snippet,
    markStart,
    markEnd,
    start: s,
    end: e,
    loc,
    // 指纹：用来记住「这一处我看过，是误报」。只跟规则类型、章节和命中文字有关，
    // 不跟位置有关 —— 作者在段落里挪动一下字，不该让忽略失效。
    key: `${type}|${info.id}|${content.slice(s, e).replace(/\s+/g, '').slice(0, 40)}`,
  };
}

export function scanProofChapter(ch, index) {
  const content = proofText(ch.content);
  const info = {
    id: ch.id,
    no: Number(ch.no) || (index >= 0 ? index + 1 : 1),
    title: ch.title || '未命名',
  };
  const paras = proofParagraphs(content);
  const issues = [];
  const seen = new Set();
  const add = (type, message, start, end, opt = {}) => {
    if (issues.length >= 1000) return; // 病理级重复文本的保险丝
    const item = proofIssue(info, content, paras, type, message, start, end, opt);
    const key = `${type}|${item.start}|${item.end}|${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push(item);
  };

  // 常见叠字误写。只列高频虚词，避免把“看看”“慢慢”这类正常叠词误报。
  for (const m of content.matchAll(/(的的|了了|地地|得得|着着|是是|在在|我我|你你|他他|她她|它它|们们|和和|与与|就就|都都|也也|又又|很很|不不|这这|那那|么么)/g)) {
    add('typo', `疑似叠字「${m[0]}」`, m.index, m.index + m[0].length);
  }

  // 连续标点（省略号、破折号不在此列）
  for (const m of content.matchAll(/([，。；：、])\1+/g)) {
    add('punct', `连续标点「${m[0]}」`, m.index, m.index + m[0].length);
  }

  // 标点前后的空格 / 全角空格
  for (const m of content.matchAll(/[ \t\u3000]+([，。！？；：、])/g)) {
    add('punct', `标点「${m[1]}」前多了空格`, m.index, m.index + m[0].length);
  }
  for (const m of content.matchAll(/([，。！？；：、])([ \t\u3000]+)/g)) {
    add('punct', `标点「${m[1]}」后多了空格`, m.index + 1, m.index + m[0].length);
  }

  // 中文正文里的半角标点
  const asciiNames = { ',': '逗号', ';': '分号', ':': '冒号', '.': '句号', '!': '感叹号', '?': '问号' };
  for (const m of content.matchAll(/([\u4e00-\u9fff])([,.;:!?])/g)) {
    add('punct', `中文里用了半角${asciiNames[m[2]] || '标点'}「${m[2]}」`, m.index + 1, m.index + 2);
  }

  // 英文直引号：中文稿里常见，统一成中文引号通常更好
  const straightQuotes = [...content.matchAll(/"/g)];
  if (straightQuotes.length && /[\u4e00-\u9fff]/.test(content)) {
    add('quote', `本章有 ${straightQuotes.length} 个英文直引号（"）`, straightQuotes[0].index, straightQuotes[0].index + 1, { loc: '全章' });
  }

  // 引号 / 括号数量：不配对时至少值得回头确认
  const pairs = [
    ['“', '”', '中文双引号'],
    ['‘', '’', '中文单引号'],
    ['（', '）', '圆括号'],
    ['【', '】', '方括号'],
    ['《', '》', '书名号'],
    ['「', '」', '直角引号'],
    ['『', '』', '直角单引号'],
  ];
  for (const [open, close, label] of pairs) {
    const a = content.split(open).length - 1;
    const b = content.split(close).length - 1;
    if (a === b) continue;
    const at = [content.indexOf(open), content.indexOf(close)].filter((n) => n >= 0).sort((x, y) => x - y)[0] ?? 0;
    add('quote', `${label}数量不配对：${open} ${a} / ${close} ${b}`, at, at + 1, {
      loc: '全章',
      snippet: `${open} ${a} 个 · ${close} ${b} 个`,
    });
  }

  // AI 模板味：三段式（首先/第一/其次/第二/最后/第三）
  for (const p of paras) {
    const t = p?.text || '';
    if (!t) continue;
    if (/(首先|第一|其一)/.test(t) && /(其次|第二|其二)/.test(t) && /(最后|第三|其三|末了|最终)/.test(t)) {
      add('ai_taste', '段落像 AI 三段式（首先 … 其次 … 最后），多半是注水', p.start, p.start + 2);
    } else if (/(首先|第一|其一)/.test(t) && /(最后|第三|其三)/.test(t) && t.length < 120) {
      add('ai_taste', '段落疑似 AI 模板（首先 … 最后）', p.start, p.start + 2);
    }
  }
  // AI 模板味：不是 X，而是 Y / 不仅 X，还 Y
  for (const m of content.matchAll(/不是[^。\n]{1,50}，而是/g)) {
    add('ai_taste', '「不是…而是…」判断句（AI 偏好结构，改成动作/场景说）', m.index, m.index + m[0].length);
  }
  for (const m of content.matchAll(/不仅[^，。！？；\n]{2,40}，还/g)) {
    add('ai_taste', '「不仅…还…」递进句（AI 模板腔）', m.index, m.index + m[0].length);
  }
  // AI 模板味：四字组连发 ≥ 2 次（排比味）
  for (const p of paras) {
    const t = p?.text || '';
    const hits = [...t.matchAll(/[一-龥]{4}[，、][一-龥]{4}[，、][一-龥]{4}(?=[，。；；\n]|$)/g)];
    if (hits.length >= 2) add('ai_taste', `本段 ${hits.length} 组四字排比，节奏偏「韵」`, p.start, p.start + 4);
  }
  // AI 模板味：固定副词句首，提示结构“是 X 的 ……”
  for (const m of content.matchAll(/^(随后|随后|毕竟|毕竟|事实上|客观来说|实际上|总而言之|总之|综上所述|简单来说)/gm)) {
    add('ai_taste', `段落以「${m[1]}」开头，AI 抽象总结句首`, m.index, m.index + m[1].length);
  }

  for (const p of paras) {
    // 段首标点
    if (/^[，。！？；：、]/.test(p.text)) {
      add('punct', `段落以标点「${p.text[0]}」开头`, p.start, p.start + 1);
    }

    // 段落收尾：太短的段落可能是有意为之，不报
    if (p.text.length >= 24) {
      const last = p.text[p.text.length - 1];
      if (/[，,、；;]$/.test(p.text)) {
        add('ending', `段落以「${last}」结尾，可能没写完`, p.end - 1, p.end);
      } else if (!/[。！？…—!?.”’」』）】》："]$/.test(p.text)) {
        add('ending', '段落末尾缺少句号或收束标点', p.end - 1, p.end);
      }
    }
  }

  issues.sort((a, b) => a.start - b.start || a.type.localeCompare(b.type));
  return {
    ...info,
    words: countWords(content),
    chars: content.length,
    issues: issues.slice(0, PROOF_MAX_CHAPTER_ISSUES),
    capped: issues.length > PROOF_MAX_CHAPTER_ISSUES,
  };
}

export function buildProofReport(novel, scope, currentChapterId) {
  const all = novel?.chapters || [];
  const targets = scope === 'book' ? all : all.filter((ch) => ch.id === currentChapterId);
  const chapters = targets.map((ch) => scanProofChapter(ch, all.indexOf(ch)));
  const issues = chapters.flatMap((ch) => ch.issues);
  return {
    scope,
    chapters,
    issues,
    words: chapters.reduce((sum, ch) => sum + ch.words, 0),
  };
}

export function proofSnippetHtml(issue) {
  const text = issue.snippet || '';
  if (!(issue.markEnd > issue.markStart)) return esc(text);
  return `${esc(text.slice(0, issue.markStart))}<mark>${esc(text.slice(issue.markStart, issue.markEnd))}</mark>${esc(text.slice(issue.markEnd))}`;
}

