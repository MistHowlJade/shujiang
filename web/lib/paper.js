// 书匠 · 稿纸排版
// ------------------------------------------------------------
// 写作页正文的字号 / 行距 / 字体。纯计算：不碰 DOM、不读全局状态，
// 输出的是一组 CSS 变量，交给页面去挂，因此在 Node 里可以直接测。
// ============================================================

/** 默认：18px / 2.0 倍行距 / 黑体（Windows 上最清晰的一档 CJK 正文显示） */
export const PAPER_DEFAULTS = Object.freeze({ size: 18, lh: 2, font: 'sans' });

export const PAPER_SIZE_MIN = 14;
export const PAPER_SIZE_MAX = 22;

/** 行距只给五档，避免设置页出现「没有一档是选中的」 */
export const PAPER_LH_STEPS = Object.freeze([1.6, 1.8, 2.0, 2.2, 2.4]);

/**
 * 字体：值是一整条 font-family，落到 CSS 变量上直接用。
 * 黑体类最适合屏幕 CJK 正文；宋体/楷体/仿宋保留给习惯繁体/古籍风格的作者。
 */
export const PAPER_FONTS = Object.freeze({
  sans: {
    label: '黑体',
    family: '"PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC", "DengXian", system-ui, sans-serif',
  },
  serif: {
    label: '宋体',
    family: '"Source Han Serif SC", "Noto Serif SC", "Songti SC", "SimSun", Georgia, serif',
  },
  kai: {
    label: '楷体',
    family: '"Kaiti SC", "KaiTi", "STKaiti", "楷体", "AR PL UKai CN", serif',
  },
  fangsong: {
    label: '仿宋',
    family: '"FangSong", "FangSong_GB2312", "SimSun", Georgia, serif',
  },
});

export const PAPER_FONT_KEYS = Object.freeze(Object.keys(PAPER_FONTS));

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 配置里的空值当没填：null / '' / 布尔值都不该被 Number() 变成 0 */
const toNum = (v) => (v === null || v === undefined || v === '' || typeof v === 'boolean' ? NaN : Number(v));

/** 把配置里的值收成合法三件套：字号夹到 14–22、行距吸到最近的档、字体不认识就退回宋体 */
export function normalizePaper(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};

  const sizeNum = toNum(src.size);
  const size = Number.isFinite(sizeNum)
    ? Math.round(clamp(sizeNum, PAPER_SIZE_MIN, PAPER_SIZE_MAX))
    : PAPER_DEFAULTS.size;

  const lhNum = toNum(src.lh);
  const lh = Number.isFinite(lhNum)
    ? PAPER_LH_STEPS.reduce((best, step) => (Math.abs(step - lhNum) < Math.abs(best - lhNum) ? step : best), PAPER_LH_STEPS[0])
    : PAPER_DEFAULTS.lh;

  const font = Object.prototype.hasOwnProperty.call(PAPER_FONTS, src.font) ? src.font : PAPER_DEFAULTS.font;
  return { size, lh, font };
}

/** 字号加减一格，到头就停住 */
export function nextPaperSize(size, delta) {
  const base = toNum(size);
  const step = toNum(delta);
  return Math.round(clamp((Number.isFinite(base) ? base : PAPER_DEFAULTS.size) + (Number.isFinite(step) ? step : 0), PAPER_SIZE_MIN, PAPER_SIZE_MAX));
}

/** 换成 CSS 变量：body 上挂一次，编辑器就跟着变 */
export function paperVars(pref) {
  const p = normalizePaper(pref);
  return {
    '--ed-size': `${p.size}px`,
    '--ed-lh': String(p.lh),
    '--ed-font': PAPER_FONTS[p.font].family,
  };
}

/** 一句话说清现在是什么样，设置页和提示条共用 */
export function paperLabel(pref) {
  const p = normalizePaper(pref);
  return `${p.size} px · ${p.lh.toFixed(1)} 倍行距 · ${PAPER_FONTS[p.font].label}`;
}
