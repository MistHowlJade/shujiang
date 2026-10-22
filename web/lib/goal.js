// 书匠 · 全书目标与完稿预测
//
// 「这本书要写多少」定了之后，光显示一个百分比不够 —— 作者真正想知道的是
// 「按我现在这个速度，还要写多久」。这里把这个估算做出来。
//
// 纯计算，不碰 DOM、不依赖全局状态。

import { countWords } from './util.js';

/**
 * 全书目标：设了就报进度，没设返回 null。
 * 书架卡片拿的是列表数据（words + targetWords），工作台拿的是完整作品（meta + chapters），两种都认。
 */
export function bookGoalOf(n) {
  if (!n) return null;
  const target = Math.floor(Number(n.meta?.targetWords ?? n.targetWords) || 0);
  if (!target) return null;
  const words = Array.isArray(n.chapters)
    ? n.chapters.reduce((s, c) => s + countWords(c.content || ''), 0)
    : (Number(n.words) || 0);
  return {
    target,
    words,
    pct: Math.min(100, Math.round((words / target) * 100)),
    left: Math.max(0, target - words),
    done: words >= target,
  };
}

/** 目标字数用「万」更顺眼：300000 → 30 万 */
export function fmtGoal(n) {
  const v = Math.floor(Number(n) || 0);
  return v >= 10000 ? `${Math.round(v / 10000)} 万` : String(v);
}

/**
 * 还要多久写完：按最近若干天的日均产出算。
 * @param {object} goal bookGoalOf 的结果
 * @param {object} stats 服务端的统计（要带 dailyRate）
 * @param {Date} now 今天
 */
export function finishEstimate(goal, stats, now = new Date()) {
  if (!goal) return null;
  if (goal.done) return { done: true, days: 0, rate: Number(stats?.dailyRate) || 0, date: null };
  const rate = Math.floor(Number(stats?.dailyRate) || 0);
  if (rate <= 0) return { done: false, days: null, rate: 0, date: null };
  const days = Math.ceil(goal.left / rate);
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return { done: false, days, rate, date };
}

/** 把「还要 55 天」说成人话 */
export function daysPhrase(days) {
  if (days === null || days === undefined) return '还不知道要多久';
  if (days <= 0) return '今天就写完了';
  if (days < 14) return `还要 ${days} 天`;
  if (days < 60) return `还要 ${Math.round(days / 7)} 周（约 ${days} 天）`;
  if (days < 365) return `还要 ${Math.round(days / 30)} 个月（约 ${days} 天）`;
  return `还要 ${(days / 365).toFixed(1)} 年（约 ${days} 天）`;
}

/** 预计完稿日期：9 月 5 日 */
export function datePhrase(date) {
  if (!date) return '';
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}
