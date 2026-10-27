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

/* ============================================================
 * 设定条目的「提及索引」
 * 世界观条目（地理 / 势力 / 物品 / 规则）除了进上下文，还应该能查到
 * 它在正文里到底出现在哪几章。这里只做本地字符串匹配，不调用模型。
 * ============================================================ */

/** 提及检索用的归一化：去掉空白与间隔符，统一小写。
 *  「艾伦·史密斯」和「艾伦 史密斯」应当能互相命中。 */
export function normalizeMentionText(value) {
  return String(value || '').toLowerCase().replace(/[\s\u00a0\u3000·•・]+/g, '');
}

/** 条目名可能带括号注释（「青锋剑（上品）」），检索时把括号里的说明去掉 */
export function normalizeMentionKey(value) {
  return normalizeMentionText(String(value || '').replace(/[（(【\[][^）)】\]]*[）)】\]]/g, ''));
}

/** 一个条目可以用来检索的名字与关键词。单字太容易误命中，直接跳过 */
export function worldMentionKeys(entry) {
  const rawKeywords = Array.isArray(entry?.keywords)
    ? entry.keywords
    : (typeof entry?.keywords === 'string' ? entry.keywords.split(/[,，、\s]+/) : []);
  const keys = [entry?.name, ...rawKeywords]
    .map(normalizeMentionKey)
    .filter((key) => key.length >= 2);
  return [...new Set(keys)];
}

/** 一章里所有可检索的文字：标题、正文、章节记忆（概要 / 事件 / 状态变化 / 伏笔 / 未决） */
export function chapterMentionText(ch) {
  return normalizeMentionText([
    ch?.title || '',
    ch?.content || '',
    ...memoryItems(ch?.memory, 'summary'),
    ...memoryItems(ch?.memory, 'events'),
    ...memoryItems(ch?.memory, 'characters'),
    ...memoryItems(ch?.memory, 'stateChanges'),
    ...memoryItems(ch?.memory, 'foreshadowing'),
    ...memoryItems(ch?.memory, 'unresolved'),
  ].join('\n'));
}

/** 预先把每章压成可检索文本，供多个设定条目反复查询 */
export function buildMentionIndex(novel) {
  return (novel?.chapters || []).map((ch, i) => ({
    ch,
    no: ch?.no || i + 1,
    text: chapterMentionText(ch),
  }));
}

/** 世界观条目在哪些章被提到。返回按章节号排序的 { id, no, title } */
export function worldMentionChapters(entry, index) {
  const keys = worldMentionKeys(entry);
  if (!keys.length) return [];
  const out = [];
  for (const row of Array.isArray(index) ? index : []) {
    if (!row?.text) continue;
    if (keys.some((key) => row.text.includes(key))) out.push(row);
  }
  return out
    .sort((a, b) => (a.no || 0) - (b.no || 0))
    .map((row) => ({ id: row.ch?.id, no: row.no, title: row.ch?.title || '', stage: row.ch?.stage }));
}

