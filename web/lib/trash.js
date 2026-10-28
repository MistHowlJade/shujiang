// 书匠 · 设定库「最近删除」纯逻辑
// 存储交给调用方（localStorage），这里只处理搜索过滤、容量与恢复位置。

export const BIBLE_TRASH_LIMIT = 50;

/** 搜索最近删除：匹配条目名、作品名、板块标签或板块 key */
export function filterBibleTrash(list, query) {
  const rows = Array.isArray(list) ? list.filter(Boolean) : [];
  const q = String(query || '').trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => [r.name, r.novelTitle, r.label, r.section]
    .some((x) => String(x || '').toLowerCase().includes(q)));
}

/** 新记录放最前面，超过上限时丢掉最旧的 */
export function addBibleTrashRecord(list, record, limit = BIBLE_TRASH_LIMIT) {
  const rows = Array.isArray(list) ? list.filter(Boolean) : [];
  const max = Math.max(1, Number(limit) || BIBLE_TRASH_LIMIT);
  if (!record) return rows.slice(0, max);
  return [record, ...rows].slice(0, max);
}

/** 恢复时优先插回「原来排在它后面的条目」之前；找不到就退回原下标，并夹在数组范围内 */
export function insertBibleTrashItem(arr, item, nextId, index) {
  const rows = Array.isArray(arr) ? arr : [];
  let at = nextId ? rows.findIndex((x) => x?.id === nextId) : -1;
  if (at < 0) at = Math.min(Math.max(0, Number(index) || 0), rows.length);
  rows.splice(at, 0, item);
  return rows;
}

/** 同一个 id 的条目已经回到设定库时，不要再插一遍 */
export function hasBibleTrashItem(arr, item) {
  if (!item?.id || !Array.isArray(arr)) return false;
  return arr.some((x) => x?.id === item.id);
}
