// 上下文组装器：把"设定库 + 大纲 + 章节记忆 + 前文"按相关度筛选后拼成给模型看的资料包。
// 纯词法匹配（无向量库、无外部依赖），对中文小说这种专有名词密集的文本效果足够好。
import { chapterVolumeIds, findOutlineEntry } from './store.js';

const DEFAULT_BUDGET = 26000; // 资料包字符预算（约合 1.5~2 万字正文所需的参考量）

function norm(s) {
  return String(s || '').toLowerCase();
}

// 把任意文本切成用于匹配的中文词块（2-4 字）与英文/数字词
function terms(text) {
  const t = norm(text);
  const out = new Set();
  const cjk = t.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const run of cjk) {
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= run.length; i++) out.add(run.slice(i, i + n));
    }
  }
  const latin = t.match(/[a-z0-9]{2,}/g) || [];
  latin.forEach((w) => out.add(w));
  return out;
}

function score(queryTerms, item, fields) {
  let s = 0;
  for (const f of fields) {
    const value = norm(f(item));
    if (!value) continue;
    if (value.length >= 2 && queryTerms.has(value)) s += 6; // 全名直接命中
    let hits = 0;
    for (const t of queryTerms) {
      if (t.length >= 2 && value.includes(t)) hits++;
      if (hits > 12) break;
    }
    s += Math.min(hits, 12) * 0.5;
  }
  for (const k of item?.keywords || []) {
    const kk = norm(k);
    if (kk && queryTerms.has(kk)) s += 4;
  }
  return s;
}

function fmtCharacter(c, brief = false) {
  if (brief) return `· ${c.name}（${c.role || '人物'}${c.identity ? `·${c.identity}` : ''}）：${(c.personality || '').slice(0, 60)}${c.goal ? `｜目标：${c.goal.slice(0, 50)}` : ''}`;
  const bits = [
    `姓名：${c.name}`,
    c.role && `定位：${c.role}`,
    c.identity && `身份：${c.identity}`,
    c.age && `年龄：${c.age}`,
    c.appearance && `外貌：${c.appearance}`,
    c.personality && `性格：${c.personality}`,
    c.goal && `目标：${c.goal}`,
    c.flaw && `缺陷：${c.flaw}`,
    c.secret && `秘密（读者未知/未揭晓）：${c.secret}`,
    c.speech && `说话风格：${c.speech}`,
    c.arc && `成长弧线：${c.arc}`,
  ].filter(Boolean);
  if (c.relations?.length) {
    bits.push(`关系：${c.relations.map((r) => `${r.to}（${r.type || '关系'}${r.note ? `，${r.note}` : ''}）`).join('；')}`);
  }
  return bits.join('\n');
}

function fmtWorld(w) {
  return `【${w.category || '设定'}】${w.name}：${w.desc || ''}`;
}

function fmtTimeline(t) {
  return `${t.time || '?'}｜${t.title || ''}${t.desc ? `：${t.desc}` : ''}`;
}

function fmtMemory(ch) {
  const m = ch.memory || {};
  const bits = [`第${ch.no}章《${ch.title}》：${m.summary || ch.summary || '（无概要）'}`];
  if (m.events?.length) bits.push(`  事件：${m.events.join('；')}`);
  if (m.stateChanges?.length) bits.push(`  状态变化：${m.stateChanges.join('；')}`);
  if (m.unresolved?.length) bits.push(`  未决：${m.unresolved.join('；')}`);
  if (m.foreshadowing?.length) bits.push(`  伏笔：${m.foreshadowing.join('；')}`);
  return bits.join('\n');
}

export function chapterTail(chapters, index, maxChars = 900) {
  for (let i = index - 1; i >= 0; i--) {
    const text = (chapters[i]?.content || '').trim();
    if (text) return text.slice(-maxChars);
  }
  return '';
}

export function recentMemories(chapters, index, count = 6) {
  const out = [];
  for (let i = index - 1; i >= 0 && out.length < count; i--) {
    const ch = chapters[i];
    if (!ch) continue;
    if (ch.memory?.summary || ch.summary) out.push(ch);
  }
  return out.reverse();
}

/**
 * 组装当前写作任务的资料包
 * @param {object} novel 小说对象
 * @param {object} opts { chapterId, extraQuery, budget, briefCharacters }
 */
export function buildContext(novel, opts = {}) {
  const chapters = novel.chapters || [];
  const idx = opts.chapterId ? chapters.findIndex((c) => c.id === opts.chapterId) : chapters.length;
  const chapter = idx >= 0 ? chapters[idx] : null;
  const prevIndex = idx >= 0 ? idx : chapters.length;

  // 章节上的 outline 是「建章时的快照」，设定库里的章纲才是作者后来改过的最新版。
  // 两边都有时以设定库为准，否则会出现「大纲里改了，生成时还在按老快照写」。
  const linkedOutline = findOutlineEntry(novel, chapter?.outlineId)?.entry || null;
  const chapterOutline = {
    scene: linkedOutline?.scene || chapter?.outline?.scene || '',
    characters: linkedOutline?.characters || chapter?.outline?.characters || '',
    summary: linkedOutline?.summary || chapter?.outline?.summary || '',
    hook: linkedOutline?.hook || chapter?.outline?.hook || '',
  };

  // 查询串 = 本章标题 + 本章要求 + 最近概要 + 用户补充搜索词
  // 查询词 = 当前章 + 上一章摘要 + 章节卡片 + 用户额外要求 + 本章正文片段（锚点检索：用正文提到的名字找出相关设定）
  const currentChapterText = idx >= 0 ? String(chapters[idx]?.content || '').slice(-1500) : '';
  const query = [
    chapter?.title,
    chapter?.summary,
    chapterOutline.summary,
    chapterOutline.scene,
    chapterOutline.characters,
    opts.extraQuery,
    currentChapterText,
    chapters.slice(Math.max(0, prevIndex - 3), prevIndex).map((c) => `${c.title} ${c.summary || c.memory?.summary || ''}`).join(' '),
  ]
    .filter(Boolean)
    .join(' ');
  const qt = terms(query);

  const budget = opts.budget || novel.meta?.contextBudget || DEFAULT_BUDGET;
  const pack = [];
  let used = 0;
  const push = (title, body, force = false) => {
    if (!body) return false;
    const block = title ? `### ${title}\n${body}` : body;
    if (!force && used + block.length > budget) return false;
    used += block.length;
    pack.push(block);
    return true;
  };

  /* 1. 总纲（永远带） */
  const m = novel.meta || {};
  const topBits = [
    m.logline && `一句话故事：${m.logline}`,
    m.synopsis && `故事梗概：${m.synopsis}`,
  ].filter(Boolean).join('\n');
  push('全书总纲', topBits, true);

  // 锁定设定：必须始终带上，不受 budget 影响
  const lockedBits = [
    ...(novel.bible?.characters || []).filter((c) => c.locked).map((c) => `人物·${c.name}（${c.role || ''}）：${c.personality || ''}${c.goal ? `；目标：${c.goal}` : ''}${c.flaw ? `；缺陷：${c.flaw}` : ''}${c.speech ? `；说话：${c.speech}` : ''}`),
    ...(novel.bible?.world || []).filter((w) => w.locked).map((w) => `世界观·${w.name}（${w.category || ''}）：${w.desc || ''}`),
    ...(novel.bible?.timeline || []).filter((t) => t.locked).map((t) => `时间线·${t.when || t.time || ''}：${t.event || t.text || ''}`),
  ];
  if (lockedBits.length) push('🔒 锁定设定（生成时必须遵守）', lockedBits.join('\n'), true);

  const volumes = novel.outline?.volumes || [];
  if (volumes.length) {
    const volOverview = volumes
      .map((v, i) => `第${i + 1}卷 ${v.name}：${(v.desc || '').slice(0, 90)}`)
      .join('\n');
    push('分卷结构', volOverview, true);
  }
  if (novel.outline?.notes) push('大纲备注', String(novel.outline.notes).slice(0, 1200));

  /* 2. 当前卷 / 当前章大纲 */
  // 当前卷优先按「章节列表里的分卷归属」判定（显式标记 / 章纲归属，见 store.js），
  // 这样作者在章节列表里把某一章并入别的卷时，喂给模型的卷纲也跟着变。
  let currentVolume = null;
  if (chapter && idx >= 0) {
    const volId = chapterVolumeIds(novel)[idx];
    if (volId) currentVolume = volumes.find((v) => v.id === volId) || null;
  }
  // 老数据既没有分卷标记、章节也没挂章纲时，才按大纲章数顺推。
  // 只要书里已经有任何归属信号（显式 volumeId 或 outlineId），就尊重它：
  // 明确标成「未分卷」的章节不该被硬塞进某一卷。
  const hasVolumeSignal = (novel.chapters || []).some((c) => typeof c.volumeId === 'string' || c.outlineId);
  if (!currentVolume && idx >= 0 && !hasVolumeSignal) {
    let cursor = 0;
    for (const v of volumes) {
      const n = (v.chapters || []).length;
      if (idx < cursor + n) { currentVolume = v; break; }
      cursor += n;
    }
  }
  if (currentVolume) {
    // 章纲的编号优先用真实章节号：卷二的第一条章纲是「第 21 章」而不是「第 1 章」，
    // 模型据此才知道故事进行到哪一段。
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
    push(`第${volumes.indexOf(currentVolume) + 1}卷《${currentVolume.name}》章纲`, detail.slice(0, 4000), true);
  }
  if (chapter && (chapterOutline.scene || chapterOutline.characters || chapterOutline.summary || chapterOutline.hook || chapter.summary)) {
    const o = chapterOutline;
    push(
      '本章要点',
      [o.scene && `场景：${o.scene}`, o.characters && `出场：${o.characters}`, o.summary || chapter.summary, o.hook && `章末钩子：${o.hook}`]
        .filter(Boolean)
        .join('\n'),
      true,
    );
  }

  /* 3. 人物卡（按相关度） */
  const chars = (novel.bible?.characters || []).map((c) => ({ c, s: score(qt, c, [(x) => x.name, (x) => x.identity, (x) => x.role]) }));
  const hitChars = chars.filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  const restChars = chars.filter((x) => x.s <= 0);
  if (hitChars.length) {
    push(`本章相关人物（共 ${hitChars.length} 人）`, hitChars.slice(0, 10).map((x) => fmtCharacter(x.c)).join('\n---\n'), true);
  }
  if (restChars.length) {
    push(`其他人物速览（共 ${restChars.length} 人）`, restChars.slice(0, 30).map((x) => fmtCharacter(x.c, true)).join('\n'));
  }

  /* 4. 世界观条目 */
  const worlds = (novel.bible?.world || []).map((w) => ({ w, s: score(qt, w, [(x) => x.name, (x) => x.category]) }));
  worlds.sort((a, b) => b.s - a.s);
  const hitWorlds = worlds.filter((x) => x.s > 0).slice(0, 18);
  const otherWorlds = worlds.filter((x) => x.s <= 0).slice(0, 12);
  if (hitWorlds.length) push('相关世界观设定', hitWorlds.map((x) => fmtWorld(x.w)).join('\n'), true);
  if (otherWorlds.length) push('其他世界观速览', otherWorlds.map((x) => fmtWorld(x.w)).join('\n'));

  /* 5. 时间线 */
  const tl = (novel.bible?.timeline || [])
    .map((t) => ({ t, s: score(qt, t, [(x) => x.title, (x) => x.desc || x.detail]) }))
    .sort((a, b) => b.s - a.s);
  const hitTl = tl.filter((x) => x.s > 0).slice(0, 12);
  if (hitTl.length) push('相关时间线', hitTl.map((x) => fmtTimeline(x.t)).join('\n'), true);

  /* 6. 前情记忆：最近 6 章固定带，更早的按需检索 */
  const recent = recentMemories(chapters, prevIndex, 6);
  if (recent.length) push('前情提要（最近章节）', recent.map(fmtMemory).join('\n'), true);

  const earlier = chapters
    .slice(0, Math.max(0, prevIndex - 6))
    .filter((c) => c.memory?.summary || c.summary)
    .map((c) => ({ c, s: score(qt, c, [(x) => x.title]) + (c.memory?.events || []).reduce((a, e) => a + (qt.has(e.slice(0, 4)) ? 1 : 0), 0) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 5);
  if (earlier.length) push('相关旧章节记忆（按关键词检索）', earlier.map((x) => fmtMemory(x.c)).join('\n'));

  /* 7. 未回收的伏笔 */
  const foreshadows = [];
  chapters.slice(0, prevIndex).forEach((c) => {
    (c.memory?.foreshadowing || []).forEach((f) => foreshadows.push(`第${c.no}章：${f}`));
  });
  if (foreshadows.length) push('已埋下的伏笔（注意呼应，不要写丢）', foreshadows.slice(-12).join('\n'));

  return {
    pack,
    used,
    budget,
    chapter,
    chapterIndex: idx,
    prevTail: prevIndex > 0 ? chapterTail(chapters, prevIndex, opts.tailChars || 900) : '',
    stats: {
      packChars: used,
      chars: hitChars.length,
      worlds: hitWorlds.length,
      timeline: hitTl.length,
      memories: recent.length + earlier.length,
    },
  };
}

// 取指定章节范围的正文，供一致性检查 / 责编评审使用
export function collectScopeText(novel, { chapterIds, from, to, maxChars = 40000, withMemory = true }) {
  const chapters = novel.chapters || [];
  let list = chapters;
  if (Array.isArray(chapterIds) && chapterIds.length) {
    const set = new Set(chapterIds);
    list = chapters.filter((c) => set.has(c.id));
  } else if (from != null || to != null) {
    list = chapters.filter((c) => c.no >= (from || 1) && c.no <= (to || 99999));
  }
  const out = [];
  let used = 0;
  for (const c of list) {
    let body = (c.content || '').trim();
    if (!body && withMemory) body = c.memory?.summary || c.summary || '';
    if (!body) continue;
    const block = `第${c.no}章《${c.title}》\n${body}`;
    if (used + block.length > maxChars) {
      out.push(block.slice(0, Math.max(0, maxChars - used)) + '\n……（后续内容已截断）');
      break;
    }
    out.push(block);
    used += block.length;
  }
  return out.join('\n\n');
}

// 给人看/给模型看的资料包摘要（前端展示用了哪些资料）
export function packSummaryLines(pack) {
  return pack
    .map((block) => {
      const first = block.split('\n')[0];
      return first.startsWith('### ') ? first.slice(4) : first.slice(0, 40);
    })
    .filter(Boolean);
}
