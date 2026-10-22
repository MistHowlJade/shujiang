// 书匠 · 全书目标与完稿预测
//
// 「这本书要写多少」定了之后，光显示一个百分比不够 —— 作者真正想知道的是
// 「按我现在这个速度，还要写多久」。这里把这个估算做出来。
//
// 纯计算，不碰 DOM、不依赖全局状态。

import { countWords, esc, fmtWords } from './util.js';

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

/**
 * 统计面板里的「全书目标与完稿预测」区块。
 * 没打开作品就提示一句；打开了但没定目标就留一个去设定的入口。
 * @param {object} novel 当前打开的作品（没有就传 null）
 * @param {object} stats 服务端的统计（要带 dailyRate）
 */
export function goalPanelHtml(novel, stats) {
  if (!novel) {
    return '<div class="goal-panel empty"><span class="dim small">打开一部作品，这里会显示它的完稿进度和预计完稿时间。</span></div>';
  }
  const goal = bookGoalOf(novel);
  if (!goal) {
    return `<div class="goal-panel empty">
      <span class="dim small">《${esc(novel.title || '')}》还没定全书目标字数。</span>
      <button class="btn btn-sm" id="stSetGoal">去设定</button>
    </div>`;
  }
  const est = finishEstimate(goal, stats);
  const rate = Number(stats?.dailyRate) || 0;
  const pace = est?.done
    ? '全书目标已达成'
    : est?.days
      ? `按最近 14 天日均 ${fmtWords(est.rate)} 字算，${daysPhrase(est.days)}，预计 ${datePhrase(est.date)}完稿`
      : '最近没动笔，算不出还要多久';
  return `<div class="goal-panel${goal.done ? ' done' : ''}">
    <div class="goal-panel-head">
      <span class="goal-panel-title">《${esc(novel.title || '')}》</span>
      <span class="goal-panel-target">目标 ${fmtGoal(goal.target)} 字</span>
      <span class="goal-panel-pct">${goal.pct}%</span>
    </div>
    <div class="goal-panel-bar"><i style="width:${goal.pct}%"></i></div>
    <div class="goal-panel-line">已写 ${fmtWords(goal.words)} 字　·　${goal.done ? '已达成目标' : `还差 ${fmtWords(goal.left)} 字`}</div>
    <div class="goal-panel-line dim small">${pace}${rate ? '' : '（日均为 0）'}</div>
  </div>`;
}
