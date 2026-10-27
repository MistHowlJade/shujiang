// 书匠 · 通用小工具
// 纯浏览器环境的小函数：DOM 选择、文本转义、数字格式化、提示条。
// 拆出来是为了让其它模块（体检、校对等）能直接用，不必依赖 app.js。

/* ============================================================
 * 0. 小工具
 * ============================================================ */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const ico = (name, cls = '') => `<svg class="ico ${cls}"><use href="#i-${name}" /></svg>`;

/** 生成简短唯一 ID：前缀 + 随机字符串 */
export const uid = (p = 'x') => `${p}_${Math.random().toString(36).slice(2, 10)}`;

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => { clearTimeout(t); t = null; };
  return d;
}
/**
 * 提示条。action 可选：{ label, onClick }，带动作的提示条会多留几秒。
 * 返回移除函数，调用方可以提前收起。
 */
export function toast(msg, kind = '', action = null) {
  const box = document.createElement('div');
  box.className = `toast ${kind}`;
  const text = document.createElement('span');
  text.className = 'toast-msg';
  text.textContent = msg;
  box.appendChild(text);
  let hideTimer = 0;
  let removeTimer = 0;
  const remove = () => {
    clearTimeout(hideTimer);
    clearTimeout(removeTimer);
    box.remove();
  };
  const hasAction = action && action.label && typeof action.onClick === 'function';
  if (hasAction) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.onclick = () => {
      remove();
      try { action.onClick(); } catch (err) { console.error(err); }
    };
    box.appendChild(btn);
  }
  $('#toastWrap').appendChild(box);
  const life = hasAction ? 8000 : 2600;
  hideTimer = setTimeout(() => { box.style.opacity = '0'; box.style.transition = '.3s'; }, life);
  removeTimer = setTimeout(() => box.remove(), life + 400);
  return remove;
}
export const countWords = (t) => String(t || '').replace(/\s+/g, '').length;

/**
 * 章节字数缓存：正文没换（同一个字符串）就直接复用上次的结果。
 * 长篇渲染一次要反复汇总全书字数，缓存后切章、改状态、更新进度都不再重扫全文。
 * 用章节对象做键：换书 / 重新加载后旧对象会被自动回收，不会把字数串到别的书上。
 */
export function createWordCounter() {
  const cache = new WeakMap();
  return (chapter) => {
    if (!chapter || typeof chapter !== 'object') return countWords(chapter);
    const hit = cache.get(chapter);
    if (hit && hit.content === chapter.content) return hit.words;
    const words = countWords(chapter.content);
    cache.set(chapter, { content: chapter.content, words });
    return words;
  };
}

export const fmtWords = (n) => (n >= 10000 ? `${(n / 10000).toFixed(2)} 万` : String(n));
export function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fmtAgo(ts) {
  const d = Math.max(0, Date.now() - ts);
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return `${Math.floor(d / 60e3)} 分钟前`;
  if (d < 864e5) return `${Math.floor(d / 3600e3)} 小时前`;
  const days = Math.floor(d / 864e5);
  return days < 30 ? `${days} 天前` : `${Math.floor(days / 30)} 个月前`;
}

