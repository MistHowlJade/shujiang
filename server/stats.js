// 今日码字量 / 日更目标
//
// 只统计「正文变多」的部分：章节写盘时比较字数差，正增长才记账。
// 导入旧稿、恢复快照、全书替换都不走这条路径，所以别人的字不会被算到你今天的产出里。
// 存成 data/stats.json，一天一条，超过 400 天自动清掉最旧的。
import path from 'node:path';
import { DATA_DIR, readJson, writeJson, getNovel } from './store.js';

const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const KEEP_DAYS = 400;
const MAX_GOAL = 500000;
const DEFAULT = { goal: 3000, days: {} };

const pad2 = (n) => String(n).padStart(2, '0');

/** 本机日期，按用户所在时区算（不用 UTC，免得半夜写的字算到第二天） */
export function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function loadStats() {
  const s = readJson(STATS_FILE, DEFAULT);
  const goal = Number(s.goal);
  return {
    goal: Number.isFinite(goal) ? Math.max(0, Math.min(MAX_GOAL, Math.floor(goal))) : DEFAULT.goal,
    days: s.days && typeof s.days === 'object' ? s.days : {},
  };
}

// 日期是 YYYY-MM-DD，字典序就是时间序，直接比字符串即可
function prune(days, now) {
  const keys = Object.keys(days);
  if (keys.length <= KEEP_DAYS) return;
  // 保留 cutoff 当天在内的 400 天（含今天）
  const cutoff = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (KEEP_DAYS - 1)));
  for (const k of keys) if (k < cutoff) delete days[k];
}

/**
 * 记一笔「今天写了多少字」。delta <= 0（只删改、字数没涨）不计入。
 * chapterId 给了就顺手记到章上 —— 这样点开日历某一天，能知道那天动的是哪几章。
 */
export function addWords(novelId, delta, now = new Date(), chapterId = '') {
  const d = Math.floor(Number(delta) || 0);
  if (d <= 0) return null;
  const s = loadStats();
  const key = dayKey(now);
  const day = s.days[key] || (s.days[key] = { words: 0, novels: {} });
  day.words = (Number(day.words) || 0) + d;
  if (!day.novels || typeof day.novels !== 'object') day.novels = {};
  day.novels[novelId] = (Number(day.novels[novelId]) || 0) + d;
  if (chapterId) {
    if (!day.chapters || typeof day.chapters !== 'object') day.chapters = {};
    const byNovel = day.chapters[novelId] || (day.chapters[novelId] = {});
    byNovel[chapterId] = (Number(byNovel[chapterId]) || 0) + d;
  }
  prune(s.days, now);
  writeJson(STATS_FILE, s);
  return day;
}

export function setGoal(goal) {
  const s = loadStats();
  const g = Math.floor(Number(goal) || 0);
  s.goal = Math.max(0, Math.min(MAX_GOAL, g));
  writeJson(STATS_FILE, s);
  return s.goal;
}

/** 连续写了多少天：从今天往回数；今天还没动笔就从昨天起算，免得一睁眼就显示断更 */
function streakOf(days, now) {
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!(Number(days[dayKey(cursor)]?.words) > 0)) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (streak < KEEP_DAYS && Number(days[dayKey(cursor)]?.words) > 0) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/**
 * 历史最长连续写了多少天。
 * days 里只存了「写过」的日子，所以不能只看键挨得近不近 —— 得按真实日期一天天走。
 */
function bestStreakOf(days, now) {
  const keys = Object.keys(days).sort();
  if (!keys.length) return { days: 0, to: '' };
  const start = new Date(`${keys[0]}T00:00:00`);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let best = 0;
  let bestTo = '';
  let cur = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (Number(days[dayKey(d)]?.words) > 0) {
      cur += 1;
      if (cur > best) {
        best = cur;
        bestTo = dayKey(d);
      }
    } else {
      cur = 0;
    }
  }
  return { days: best, to: bestTo };
}

/** 写得最多的那一天 */
function bestDayOf(days) {
  let date = '';
  let words = 0;
  for (const k of Object.keys(days)) {
    const w = Number(days[k]?.words) || 0;
    if (w > words) {
      words = w;
      date = k;
    }
  }
  return { date, words };
}

/** 面向前端的汇总：最近 N 天（含今天）+ 目标 + 周合计 + 连续天数 + 累计 */
export function statsSummary({ days = 14, now = new Date() } = {}) {
  const s = loadStats();
  // 上限放到 KEEP_DAYS：写作日历热力图要看一整年，14 天不够用
  const n = Math.max(7, Math.min(KEEP_DAYS, Math.floor(Number(days) || 14)));
  const list = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = dayKey(d);
    list.push({ date: key, words: Number(s.days[key]?.words) || 0 });
  }
  const today = list[list.length - 1];
  let week = 0;
  for (let i = 0; i < 7; i++) week += list[list.length - 1 - i].words;
  let total = 0;
  for (const k of Object.keys(s.days)) total += Number(s.days[k]?.words) || 0;
  const todayRecord = s.days[today.date];
  // 最近 14 天的日均产出（含没写的日子）——用来估「这本书还要写多久」
  const recent = list.slice(-14);
  const dailyRate = Math.round(recent.reduce((sum, d) => sum + d.words, 0) / Math.max(1, recent.length));
  // 最近 30 天 vs 前 30 天：跟自己的上一个周期比，看的是势头
  const sumRange = (offset, count) => {
    let sum = 0;
    for (let i = offset; i < offset + count; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      sum += Number(s.days[dayKey(d)]?.words) || 0;
    }
    return sum;
  };
  const last30 = sumRange(0, 30);
  const prev30 = sumRange(30, 30);
  return {
    today: today.date,
    todayWords: today.words,
    goal: s.goal,
    days: list,
    week,
    streak: streakOf(s.days, now),
    bestStreak: bestStreakOf(s.days, now),
    bestDay: bestDayOf(s.days),
    last30,
    prev30,
    total,
    dailyRate,
    byNovelToday: (todayRecord && todayRecord.novels) || {},
  };
}

/**
 * 某一天的明细：那天总共写了多少、分到哪几部作品、每部作品动的是哪几章。
 * 作品或章节后来被删了，这里显示成「已删除」而不是整条丢掉 —— 账本要留着。
 */
export function statsDay(date) {
  const s = loadStats();
  const raw = String(date || '').trim();
  const key = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : dayKey();
  const rec = s.days[key] || null;
  const words = Number(rec?.words) || 0;
  const rows = Object.entries(rec?.novels || {})
    .map(([novelId, w]) => ({ novelId, words: Number(w) || 0 }))
    .filter((r) => r.words > 0)
    .sort((a, b) => b.words - a.words);

  const novels = rows.map((row) => {
    let novel = null;
    try { novel = getNovel(row.novelId); } catch { novel = null; }
    const chapterRows = Object.entries(rec?.chapters?.[row.novelId] || {})
      .map(([chapterId, w]) => ({ chapterId, words: Number(w) || 0 }))
      .filter((r) => r.words > 0)
      .sort((a, b) => b.words - a.words);
    return {
      novelId: row.novelId,
      title: novel?.title || '（已删除的作品）',
      words: row.words,
      chapters: chapterRows.map((c) => {
        const ch = novel?.chapters?.find((x) => x.id === c.chapterId);
        return {
          chapterId: c.chapterId,
          title: ch?.title || '（已删除的章节）',
          no: ch?.no || 0,
          words: c.words,
        };
      }),
    };
  });

  return { date: key, words, goal: s.goal, novels };
}
