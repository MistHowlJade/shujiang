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

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => { clearTimeout(t); t = null; };
  return d;
}
export function toast(msg, kind = '') {
  const box = document.createElement('div');
  box.className = `toast ${kind}`;
  box.textContent = msg;
  $('#toastWrap').appendChild(box);
  setTimeout(() => { box.style.opacity = '0'; box.style.transition = '.3s'; }, 2600);
  setTimeout(() => box.remove(), 3000);
}
export const countWords = (t) => String(t || '').replace(/\s+/g, '').length;
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

