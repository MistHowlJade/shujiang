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

/** 线索页搜索文本：内容、类型（未决 / 伏笔）、出现过的章节号与标题。
 *  和设定库搜索共用 filterEntriesBySearch，空格分词、忽略大小写与间隔符。 */
export function threadSearchText(thread) {
  const chapters = Array.isArray(thread?.chapters) ? thread.chapters : [];
  return [
    thread?.text,
    THREAD_KINDS[thread?.kind]?.label || '',
    ...chapters.flatMap((ch) => [ch?.no, ch?.title, ch?.no ? `第 ${ch.no} 章` : '']),
  ].join('\n');
}


/** 人物卡的检索关键词（兼容字符串写法） */
export function characterKeywords(character) {
  const raw = character?.keywords;
  return Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' ? raw.split(/[,，、\s]+/).filter(Boolean) : []);
}

/** 人物卡的检索别名：姓名 + 关键词，都按全名与分段展开。 */
export function characterAliases(character) {
  const aliases = new Set();
  for (const value of [character?.name, ...characterKeywords(character)]) {
    for (const alias of characterNameAliases(value)) aliases.add(alias);
  }
  return [...aliases];
}

export function appearancesForCharacter(character, index) {
  const keys = characterAliases(character);
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
      for (const key of characterNameAliases(raw)) {
        if (!key || seen.has(key)) continue;
        seen.add(key);
        let chapters = index.get(key);
        if (!chapters) { chapters = new Map(); index.set(key, chapters); }
        chapters.set(ch.id, ch);
      }
    }
  }
  return index;
}

/** 人物卡按「姓名 + 检索关键词」找记忆里的名字；全名会拆段，别名也能命中 */

export function normalizeCharacterName(value) {
  return String(value || '')
    .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '')
    .replace(/[\s·•.。]+/g, '')
    .toLowerCase();
}

/** 人物名拆成可检索的别名：全名 + 中间点 / 空格分开的片段。
 *  「艾伦·史密斯」会同时登记「艾伦史密斯」「艾伦」「史密斯」，
 *  这样卡片名「艾伦」、关键词「史密斯」都能找到同一段出场记录。 */
function characterNameAliases(value) {
  const raw = String(value || '');
  const aliases = new Set();
  const full = normalizeCharacterName(raw);
  if (full) aliases.add(full);
  for (const part of raw.split(/[·•.。\s]+/)) {
    const key = normalizeCharacterName(part);
    if (key.length >= 2) aliases.add(key);
  }
  return [...aliases];
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

/** 在人物卡里找记忆 / 关系字段提到的名字。
 *  优先级：姓名全名 > 关键词全名 > 姓名 / 关键词的别名分段。
 *  这样「艾伦·史密斯」会落到同名卡，而不是先撞上「艾伦」这张卡。 */
export function findCharacterByMention(characters, value) {
  const list = Array.isArray(characters) ? characters : [];
  const full = normalizeCharacterName(value);
  if (!full) return null;
  const wanted = new Set(characterNameAliases(value));
  let best = null;
  let bestScore = 0;
  for (const c of list) {
    if (!c) continue;
    const name = normalizeCharacterName(c.name);
    const keywords = characterKeywords(c).map(normalizeCharacterName).filter(Boolean);
    let score = 0;
    if (name && name === full) score = 4;
    else if (keywords.includes(full)) score = 3;
    else if (characterAliases(c).some((alias) => wanted.has(alias))) score = 2;
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return best;
}

/** 汇总设定库人物与章节记忆里的人物：
 *  记忆名先按别名归到人物卡；归不上的同名只留一个「记忆人物」节点。
 *  mentionToId 用归一化全名作键，供关系图按章提取人物时复用。 */
export function collectCharacterNodes(novel) {
  const bible = Array.isArray(novel?.bible?.characters) ? novel.bible.characters : [];
  const characters = bible.map((c) => ({ ...c, fromBible: true }));
  const mentionToId = new Map();
  const memoryNodes = new Map();
  for (const ch of novel?.chapters || []) {
    for (const raw of splitMemoryCharacters(ch.memory?.characters)) {
      const full = normalizeCharacterName(raw);
      if (!full || mentionToId.has(full)) continue;
      const matched = findCharacterByMention(bible, raw);
      if (matched) {
        mentionToId.set(full, matched.id);
        continue;
      }
      let node = memoryNodes.get(full);
      if (!node) {
        node = { id: `mem_${full}`, name: raw, fromMemory: true };
        memoryNodes.set(full, node);
        characters.push(node);
      }
      mentionToId.set(full, node.id);
    }
  }
  return { characters, mentionToId };
}

/** 人物弧光：把每个有出场记录的人物整理成按章节顺序的状态曲线。
 *  章号取章节真实的 no（缺失时按全书顺序补），不是出场序号；
 *  最近状态取最后一个「写了状态变化」的出场章，最后一次出场没写状态时
 *  不会把前面记录的状态吞掉。没有出场的设定人物不会占一张弧光卡。 */
export function buildCharacterArcs(novel) {
  const chapters = Array.isArray(novel?.chapters) ? novel.chapters : [];
  const index = buildCharacterAppearances(novel);
  if (!chapters.length || index.size === 0) return [];

  const order = new Map();
  chapters.forEach((ch, i) => {
    if (ch?.id) order.set(ch.id, i);
  });

  const { characters } = collectCharacterNodes(novel);
  const aliases = new Map();
  const appearancesByChar = new Map();
  const chapterChars = new Map();
  for (const char of characters) {
    aliases.set(char.id, characterAliases(char).filter((alias) => alias.length >= 2));
    const appearances = appearancesForCharacter(char, index)
      .map((ch) => ({ ch, order: order.get(ch.id) ?? chapters.indexOf(ch) }))
      .sort((a, b) => a.order - b.order);
    appearancesByChar.set(char.id, appearances);
    for (const { ch } of appearances) {
      if (!chapterChars.has(ch.id)) chapterChars.set(ch.id, new Set());
      chapterChars.get(ch.id).add(char.id);
    }
  }

  // 一章里的状态可能分别属于不同人物。只要有一条状态点到了本章某个人物，
  // 就只把点到自己的状态算进本人弧光；没点名的状态仍然保留给同章所有人物。
  const stateInfo = new Map();
  const infoOf = (ch) => {
    let info = stateInfo.get(ch.id);
    if (info) return info;
    const ids = chapterChars.get(ch.id) || new Set();
    const states = memoryItems(ch.memory, 'stateChanges').map((text) => {
      const norm = normalizeCharacterName(text);
      const named = [...ids].some((id) =>
        (aliases.get(id) || []).some((alias) => norm.includes(alias)));
      return { text, norm, named };
    });
    info = { states, hasNamed: states.some((state) => state.named) };
    stateInfo.set(ch.id, info);
    return info;
  };

  const arcs = [];
  for (const char of characters) {
    const appearances = appearancesByChar.get(char.id) || [];
    if (!appearances.length) continue;
    const ownAliases = aliases.get(char.id) || [];

    const points = appearances.map(({ ch, order: chapterIndex }) => {
      const info = infoOf(ch);
      const states = info.hasNamed
        ? info.states
          .filter((state) => !state.named || ownAliases.some((alias) => state.norm.includes(alias)))
          .map((state) => state.text)
        : info.states.map((state) => state.text);
      return {
        chapter: ch,
        chapterId: ch.id,
        chapterNo: ch.no || chapterIndex + 1,
        title: ch.title || '',
        state: states.join('；'),
        events: memoryItems(ch.memory, 'events').join('；'),
        unresolved: memoryItems(ch.memory, 'unresolved').join('；'),
      };
    });

    let latestIndex = -1;
    points.forEach((point, i) => {
      if (point.state) latestIndex = i;
    });
    const latest = latestIndex >= 0 ? points[latestIndex] : null;

    arcs.push({
      char,
      points,
      latestState: latest?.state || '',
      latestStateNo: latest ? latest.chapterNo : null,
      latestStateIsLatest: latestIndex === points.length - 1,
    });
  }
  return arcs;
}

/** 人物弧光搜索文本：人物名 / 身份 / 关键词、每章的章号标题、状态、事件与未决。
 *  有未决的卡会带上「未决」二字，搜这个词就能筛出所有还有线头的人物。 */
export function arcSearchText(arc) {
  const char = arc?.char || {};
  const points = Array.isArray(arc?.points) ? arc.points : [];
  const values = [
    char.name, char.role, char.identity, char.desc, char.age, char.appearance,
    char.personality, char.goal, char.flaw, char.secret, char.speech, char.arc,
    char.keywords, arc?.latestState,
  ];
  for (const point of points) {
    values.push(
      point?.chapterNo ? `第 ${point.chapterNo} 章` : '',
      point?.title,
      point?.state,
      point?.events,
      point?.unresolved,
      point?.state ? '状态' : '',
      point?.events ? '事件' : '',
      point?.unresolved ? '未决' : '',
    );
  }
  return values.flat(Infinity).map((value) => String(value ?? '')).join('\n');
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

/** 设定库条目搜索：空格分隔多个词时按「都包含」匹配；忽略大小写与间隔符。
 *  返回 { item, index }，index 是原数组下标，过滤后删除 / 跳章仍要按它来。 */
export function filterEntriesBySearch(items, query, textOf) {
  const terms = String(query || '')
    .trim()
    .split(/\s+/)
    .map(normalizeMentionText)
    .filter(Boolean);
  return (Array.isArray(items) ? items : [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => {
      if (!terms.length) return true;
      const text = normalizeMentionText(textOf(item));
      return terms.every((term) => text.includes(term));
    });
}

/* ============================================================
 * 时间轴：把时间线节点按解析出的时间排序，并带上关联章节
 * ============================================================ */

const CN_DIGITS = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const CN_UNITS = { 十: 10, 百: 100, 千: 1000 };

function chineseNumberToInt(text) {
  let total = 0;
  let section = 0;
  let number = 0;
  let seen = false;
  for (const ch of String(text || '')) {
    if (CN_DIGITS[ch] !== undefined) {
      number = CN_DIGITS[ch];
      seen = true;
      continue;
    }
    const unit = CN_UNITS[ch];
    if (unit) {
      section += (number || 1) * unit;
      number = 0;
      seen = true;
      continue;
    }
    if (ch === '万' || ch === '亿') {
      section += number;
      number = 0;
      if (ch === '万') total += section * 10000;
      else total = (total + section) * 100000000;
      section = 0;
      seen = true;
    }
  }
  return seen ? total + section + number : null;
}

/** 从「开元三年春」「第 12 章」「主角 12 岁」里取出用于排序的时间数字。
 *  阿拉伯数字优先；没有阿拉伯数字时按中文数字解析；都没有返回 null。 */
export function parseTimelineTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const arabic = text.match(/\d+/);
  if (arabic) return Number(arabic[0]);
  // 「元年」是常见写法，按「一年」处理；不能把「元」当普通数字，否则「开元三年」会被读成 13
  const normalized = text.replace(/元年/g, '一年');
  const cn = normalized.match(/[零〇一二三四五六七八九十百千万亿两]+/);
  if (!cn) return null;
  return chineseNumberToInt(cn[0]);
}

/** 时间轴事件：按时间排序，同一时间保持录入顺序，解析不出时间的排在最后。
 *  同时把 chapterId 解析成章节对象与章号，供点击跳转、提示与双击定位使用。 */
export function buildTimelineEvents(novel) {
  const chapters = Array.isArray(novel?.chapters) ? novel.chapters : [];
  const byId = new Map();
  chapters.forEach((ch, index) => {
    if (ch?.id) byId.set(ch.id, { ch, index });
  });
  const timeline = Array.isArray(novel?.bible?.timeline) ? novel.bible.timeline : [];
  return timeline.map((raw, index) => {
    const entry = raw && typeof raw === 'object' ? raw : {};
    const linked = entry.chapterId ? byId.get(entry.chapterId) : null;
    const ch = linked?.ch || null;
    return {
      entry,
      index,
      timeVal: parseTimelineTime(entry.time),
      chapter: ch,
      chapterId: ch?.id || '',
      chapterNo: ch ? (ch.no || linked.index + 1) : null,
      chapterTitle: ch?.title || '',
      chapterMissing: Boolean(entry.chapterId && !ch),
    };
  }).sort((a, b) => {
    if (a.timeVal == null && b.timeVal == null) return a.index - b.index;
    if (a.timeVal == null) return 1;
    if (b.timeVal == null) return -1;
    return a.timeVal - b.timeVal || a.index - b.index;
  });
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

/** 预先把每章压成可检索文本与状态变化，供多个设定条目反复查询 */
export function buildMentionIndex(novel) {
  return (novel?.chapters || []).map((ch, i) => ({
    ch,
    no: ch?.no || i + 1,
    text: chapterMentionText(ch),
    states: memoryItems(ch?.memory, 'stateChanges').map((text) => ({
      text,
      norm: normalizeMentionText(text),
    })),
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

/** 设定条目（人物 / 世界观）在章节记忆里的状态变化，按章节顺序返回。
 *  例如「青锋剑断裂」「青云宗被灭」「林昭手臂受伤」都会归到对应条目下。 */
export function entryStateChanges(entry, index) {
  const keys = worldMentionKeys(entry);
  if (!keys.length) return [];
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(index) ? index : []) {
    for (const state of row?.states || []) {
      if (!state?.text || !state.norm) continue;
      if (!keys.some((key) => state.norm.includes(key))) continue;
      const dedupe = `${row.no}\u0000${state.text}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({
        id: row.ch?.id,
        no: row.no,
        title: row.ch?.title || '',
        stage: row.ch?.stage,
        text: state.text,
      });
    }
  }
  return out.sort((a, b) => (a.no || 0) - (b.no || 0));
}

