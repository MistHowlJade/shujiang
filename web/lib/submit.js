// 书匠 · 交稿检查
// ------------------------------------------------------------
// 投稿前最后一步：这份要发出去的稿子，缺不缺东西。
// 只看本地已有数据（正文、章节状态、设定库），不调用模型，不改稿子。
// 纯计算 + 纯字符串渲染，不碰 DOM、不依赖全局状态，能在 Node 里直接跑。
// ============================================================

import { esc, ico, countWords } from './util.js';

/** 多数平台的签约门槛：正文 3 万字 */
export const SUBMIT_MIN_WORDS = 30000;

/** 把字数说成人话：8600 / 3 万 / 9.6 万 */
export function wan(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 10000) return `${v} 字`;
  const w = v / 10000;
  return `${Number.isInteger(w) ? w : w.toFixed(1)} 万字`;
}

/** 第 3、7、19 章；超过 max 条就收成「等 N 章」 */
export function pickNos(chapters, max = 6) {
  const nums = (chapters || []).map((c) => Number(c.no) || 0).filter((x) => x > 0);
  if (!nums.length) return '';
  const head = nums.slice(0, max).map((n) => `第 ${n} 章`).join('、');
  return nums.length > max ? `${head} 等 ${nums.length} 章` : head;
}

/**
 * 交稿检查。
 * novel：整部作品（要拿作者、简介、联系方式、大纲、人物卡）；
 * chapters：这次真要导出的章节（调用方已经按区间 / 定稿筛过）。
 * opts.scope：给标题用的一句范围说明（「全书」「第 3–5 章」…），只做展示。
 * opts.onlyDone：这次是不是勾了「只导出定稿」。
 */
export function buildSubmitCheck(novel, chapters, opts = {}) {
  const all = novel?.chapters || [];
  const list = (chapters || [])
    .slice()
    .sort((a, b) => (Number(a.no) || 0) - (Number(b.no) || 0));
  const minWords = Number(opts.minWords) > 0 ? Number(opts.minWords) : SUBMIT_MIN_WORDS;
  const words = list.reduce((sum, c) => sum + countWords(c.content), 0);
  const empty = list.filter((c) => !String(c.content || '').trim());
  const drafts = list.filter((c) => (c.stage || 'draft') !== 'done');

  const items = [];
  const add = (it) => items.push({ detail: '', action: null, ...it });

  /* ---------- 正文 ---------- */
  if (!list.length) {
    add({ key: 'empty', group: '正文', level: 'error', title: '这次一章都没有', detail: '换个导出范围再看看。' });
  } else if (empty.length) {
    add({
      key: 'empty', group: '正文', level: 'error',
      title: `有 ${empty.length} 章还没有正文`,
      detail: `${pickNos(empty)}会以空章节出现在稿子里。`,
      action: { kind: 'chapter', id: empty[0].id, label: '去补' },
    });
  } else {
    add({ key: 'empty', group: '正文', level: 'ok', title: list.length === 1 ? '这一章有正文' : `${list.length} 章都有正文` });
  }

  if (drafts.length) {
    add({
      key: 'draft', group: '正文', level: 'warn',
      title: `其中 ${drafts.length} 章还没定稿`,
      detail: `${pickNos(drafts)}还是草稿或修改中。要发就发，这里只提醒一句。`,
      action: { kind: 'chapter', id: drafts[0].id, label: '看看' },
    });
  } else if (list.length) {
    // 勾了「只导出定稿」时，说清楚全书还有多少章这次带不上
    const leftDrafts = all.filter((c) => (c.stage || 'draft') !== 'done').length;
    add({
      key: 'draft', group: '正文', level: 'ok',
      title: opts.onlyDone ? `只发定稿的 ${list.length} 章` : '这次要发的章节都定稿了',
      detail: opts.onlyDone && leftDrafts > 0 ? `全书还有 ${leftDrafts} 章没定稿，这次不会带上。` : '',
    });
  }

  if (list.length) {
    if (words < minWords) {
      add({
        key: 'words', group: '正文', level: 'warn',
        title: `${wan(words)}，离 ${wan(minWords)}还差 ${wan(minWords - words)}`,
        detail: '多数平台的签约门槛是正文 3 万字。',
      });
    } else {
      add({ key: 'words', group: '正文', level: 'ok', title: `${wan(words)}，过了 ${wan(minWords)}的常见门槛` });
    }
  }

  /* ---------- 材料 ---------- */
  const author = String(novel?.author || '').trim();
  add(author
    ? { key: 'author', group: '材料', level: 'ok', title: `作者：${author}` }
    : {
      key: 'author', group: '材料', level: 'warn',
      title: '还没填作者名',
      detail: '稿件头部和 EPUB 书名页会少一行「作者：」。',
      action: { kind: 'author', label: '去填' },
    });

  const logline = String(novel?.meta?.logline || '').trim();
  const synopsis = String(novel?.meta?.synopsis || '').trim();
  add(logline || synopsis
    ? { key: 'logline', group: '材料', level: 'ok', title: logline ? '一句话故事已写' : '故事梗概已写' }
    : {
      key: 'logline', group: '材料', level: 'warn',
      title: '还没写一句话故事',
      detail: '它会印在导出的封面上，也是编辑第一眼看的东西。',
      action: { kind: 'logline', label: '去写' },
    });

  const contact = String(novel?.meta?.contact || '').trim();
  add(contact
    ? { key: 'contact', group: '材料', level: 'ok', title: `联系方式：${contact}` }
    : {
      key: 'contact', group: '材料', level: 'warn',
      title: '还没填作者联系方式',
      detail: '稿子的头部得让编辑联系得上你。',
      action: { kind: 'contact', label: '去填' },
    });

  const note = String(novel?.meta?.submissionNote || '').trim();
  add(note
    ? { key: 'note', group: '材料', level: 'ok', title: `投稿附言 ${note.length} 字`, detail: '导出时勾「创作说明放在最前」才会带上。' }
    : {
      key: 'note', group: '材料', level: 'info',
      title: '还没写投稿附言',
      detail: '不写也能导出，只是稿子前面少一段给编辑的话。',
      action: { kind: 'note', label: '去写' },
    });

  const outlineChs = (novel?.outline?.volumes || [])
    .reduce((sum, v) => sum + (Array.isArray(v.chapters)
      ? v.chapters.filter((o) => String(o?.title || '').trim() || String(o?.summary || '').trim()).length
      : 0), 0);
  const chars = (novel?.bible?.characters || []).filter((c) => String(c?.name || '').trim()).length;
  const hasExtras = outlineChs > 0 || chars > 0;
  add({
    key: 'extras', group: '材料', level: 'info',
    title: hasExtras ? `随稿附带：大纲 ${outlineChs} 章 · 人物 ${chars} 张` : '还没有可随稿附带的材料',
    detail: hasExtras ? '导出窗口里勾上，才会附在正文后面。' : '写点章纲和人物卡，投稿时会更有底气。',
    action: hasExtras ? null : { kind: 'outline', label: '去写' },
  });

  const errors = items.filter((i) => i.level === 'error').length;
  const warns = items.filter((i) => i.level === 'warn').length;
  const level = errors ? 'error' : warns ? 'warn' : 'ok';
  const verdict = errors
    ? `还有 ${errors} 处会让这份稿子出问题，先处理再发。`
    : warns
      ? `可以发。有 ${warns} 处建议看一眼。`
      : '没发现拦住投稿的问题，可以发了。';

  return {
    chapters: list.length,
    total: all.length,
    words,
    scope: String(opts.scope || ''),
    level,
    verdict,
    errors,
    warns,
    items,
  };
}

const LEVEL_ICON = { error: 'x', warn: 'warn', info: 'info', ok: 'check' };

function submitItemHtml(it) {
  const act = it.action
    ? `<button type="button" class="btn btn-sm btn-text submit-go" data-sub-act="${esc(it.action.kind)}"`
      + `${it.action.id ? ` data-sub-id="${esc(it.action.id)}"` : ''}>${esc(it.action.label || '去处理')}</button>`
    : '';
  return `<div class="submit-item ${it.level}">
    ${ico(LEVEL_ICON[it.level] || 'info')}
    <div class="submit-body">
      <p class="submit-title">${esc(it.title)}</p>
      ${it.detail ? `<p class="submit-detail">${esc(it.detail)}</p>` : ''}
    </div>
    ${act}
  </div>`;
}

/** 把检查结果画成一段 HTML；按钮带 data-sub-act，事件由调用方绑 */
export function submitCheckHtml(report) {
  const groups = ['正文', '材料']
    .map((name) => {
      const rows = report.items.filter((i) => i.group === name);
      return rows.length ? `<div class="submit-group">${name}</div>${rows.map(submitItemHtml).join('')}` : '';
    })
    .filter(Boolean)
    .join('');
  const tone = report.level === 'error' ? 'x' : report.level === 'warn' ? 'warn' : 'check';
  const head = report.scope
    ? `<span class="submit-scope">${esc(report.scope)}</span>`
    : '';
  return `<div class="submit-verdict ${report.level}">
      ${ico(tone)}
      <span class="submit-verdict-text">${esc(report.verdict)}</span>${head}
    </div>
    ${groups}`;
}
