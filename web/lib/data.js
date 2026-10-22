// 书匠 · 纯数据helpers
// 从作品数据里算出来的只读结果：人物出场索引、线索汇总、修订计数。
// 不碰 DOM、不依赖全局状态，所以可以单独抽出来复用与测试。

export function collectThreads(n) {
  const map = new Map();
  for (const [index, ch] of (n.chapters || []).entries()) {
    if (!ch.memory) continue;
    const no = ch.no || index + 1;
    for (const kind of Object.keys(THREAD_KINDS)) {
      for (const text of memoryItems(ch.memory, kind)) {
        const key = `${kind}\u0000${text}`;
        let item = map.get(key);
        if (!item) {
          item = { kind, text, chapters: [] };
          map.set(key, item);
        }
        if (!item.chapters.some((x) => x.id === ch.id)) {
          item.chapters.push({ id: ch.id, no, title: ch.title || '' });
        }
      }
    }
  }
  return [...map.values()].map((item) => {
    const nos = [...new Set(item.chapters.map((c) => c.no))].sort((a, b) => a - b);
    const latest = item.chapters.reduce((a, b) => (b.no >= a.no ? b : a), item.chapters[0]);
    return { ...item, nos, latest };
  }).sort((a, b) => {
    const lastA = a.nos[a.nos.length - 1] || 0;
    const lastB = b.nos[b.nos.length - 1] || 0;
    return lastB - lastA
      || THREAD_KINDS[a.kind].order - THREAD_KINDS[b.kind].order
      || a.text.localeCompare(b.text, 'zh');
  });
}


export const THREAD_KINDS = {
  unresolved: { label: '未决', order: 0 },
  foreshadowing: { label: '伏笔', order: 1 },
};


export function appearancesForCharacter(character, index) {
  const keys = [character?.name, ...(character?.keywords || [])]
    .map(normalizeCharacterName)
    .filter(Boolean);
  if (!keys.length) return [];
  const byId = new Map();
  for (const key of keys) {
    for (const ch of index.get(key)?.values() || []) byId.set(ch.id, ch);
  }
  return [...byId.values()].sort((a, b) => (a.no || 0) - (b.no || 0));
}


export function buildCharacterAppearances(novel) {
  const index = new Map();
  for (const ch of novel?.chapters || []) {
    const seen = new Set();
    for (const raw of splitMemoryCharacters(ch.memory?.characters)) {
      const key = normalizeCharacterName(raw);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      let chapters = index.get(key);
      if (!chapters) { chapters = new Map(); index.set(key, chapters); }
      chapters.set(ch.id, ch);
    }
  }
  return index;
}

/** 人物卡按「姓名 + 检索关键词」找记忆里的名字，别名也能命中 */

export function normalizeCharacterName(value) {
  return String(value || '')
    .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '')
    .replace(/[\s·•.。]+/g, '')
    .toLowerCase();
}

/** 一次扫完全书记忆：归一化人名 → 出场章节。相同人名的重复记录只算一次 */

export function splitMemoryCharacters(value) {
  const out = [];
  const push = (v) => {
    if (typeof v === 'string') {
      out.push(...v.split(/[、,，/／;；|]+/).map((x) => x.trim()).filter(Boolean));
    } else if (v && typeof v === 'object' && typeof v.name === 'string') {
      out.push(...v.name.split(/[、,，/／;；|]+/).map((x) => x.trim()).filter(Boolean));
    }
  };
  if (Array.isArray(value)) value.forEach(push);
  else push(value);
  return out;
}

/** 去掉括号备注、空格和连接符后再比对，兼容「张三（少年）」「艾伦·史密斯」这类写法 */

export function openRevisionCount(ch) {
  return revisionsOf(ch).filter((r) => !r.done).length;
}


export function revisionsOf(ch) {
  const list = ch?.revisions;
  return Array.isArray(list) ? list.filter((r) => r && typeof r === 'object') : [];
}


export function memoryItems(mem, key) {
  const raw = mem?.[key];
  const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : []);
  return list.map((item) => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') return item.text || item.title || item.name || item.character || item.event || item.state || item.summary || '';
    return '';
  }).map((text) => String(text).replace(/\s+/g, ' ').trim()).filter(Boolean);
}

