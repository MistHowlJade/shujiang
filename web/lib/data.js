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

/** 关系图谱搜索：人物按姓名 / 身份 / 关键词匹配，关系按类型与证据匹配。
 *  命中人物时连带它的全部关系，命中关系时连带两端人物，这样高亮出来的
 *  每条边都有完整的两端。空查询返回 null，表示不做高亮。
 *  edges 用数组下标作为身份，调用方每次渲染都从同一份 edges 取值。 */
export function searchRelationGraph(nodes, edges, query, nodeText, edgeText) {
  const terms = String(query || '')
    .trim()
    .split(/\s+/)
    .map(normalizeMentionText)
    .filter(Boolean);
  if (!terms.length) return null;

  const hit = (text) => {
    const normalized = normalizeMentionText(text);
    return terms.every((term) => normalized.includes(term));
  };
  const nodeList = Array.isArray(nodes) ? nodes : [];
  const edgeList = Array.isArray(edges) ? edges : [];
  const nodeById = new Map(nodeList.map((node) => [node.id, node]));

  const directNodes = new Set(nodeList.filter((node) => hit(nodeText(node))).map((node) => node.id));
  const directEdges = new Set();
  edgeList.forEach((edge, index) => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (hit(edgeText(edge, source, target))) directEdges.add(index);
  });

  const matchedEdges = new Set(directEdges);
  edgeList.forEach((edge, index) => {
    if (directNodes.has(edge.source) || directNodes.has(edge.target)) matchedEdges.add(index);
  });

  const matchedNodes = new Set(directNodes);
  matchedEdges.forEach((index) => {
    const edge = edgeList[index];
    if (!edge) return;
    matchedNodes.add(edge.source);
    matchedNodes.add(edge.target);
  });

  return {
    nodes: matchedNodes,
    edges: matchedEdges,
    nodeCount: matchedNodes.size,
    edgeCount: matchedEdges.size,
  };
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

/** 时间轴可视化搜索文本：时间 / 标题 / 说明 / 关联章节号与标题 / 失效关联。
 *  timeVal 也放进去，搜「42」能命中「开元四十二年」这种中文写法。 */
export function timelineEventSearchText(event) {
  const entry = event?.entry || {};
  return [
    entry.time,
    entry.title,
    entry.desc,
    event?.timeVal != null ? String(event.timeVal) : '',
    event?.chapterNo ? `第 ${event.chapterNo} 章` : '',
    event?.chapterTitle,
    event?.chapterMissing ? '关联章节已不存在' : '',
  ].flat(Infinity).map((value) => String(value ?? '')).join('\n');
}

/** 大纲章纲搜索文本：卷号 / 卷名 / 卷说明 / 章号 / 章节名 / 场景 / 事件 / 人物 / 钩子。
 *  卷字段也放进来，搜卷名时整卷章纲都会命中。 */
export function outlineSearchText(volume, chapter, volumeIndex = -1, chapterIndex = -1) {
  return [
    volumeIndex >= 0 ? `第 ${volumeIndex + 1} 卷` : '',
    volume?.name,
    volume?.desc,
    chapterIndex >= 0 ? `第 ${chapterIndex + 1} 章` : '',
    chapter?.title,
    chapter?.scene,
    chapter?.summary,
    chapter?.characters,
    chapter?.hook,
  ].flat(Infinity).map((value) => String(value ?? '')).join('\n');
}

/** 大纲搜索：按卷与章纲过滤，保留原卷下标与章纲下标，删除 / 移动仍按原数组来。
 *  空查询返回全部卷（包括还没写章纲的空卷）；有查询时只留下有命中章纲的卷。 */
export function filterOutlineVolumes(volumes, query) {
  const terms = String(query || '')
    .trim()
    .split(/\s+/)
    .map(normalizeMentionText)
    .filter(Boolean);
  return (Array.isArray(volumes) ? volumes : [])
    .map((volume, volumeIndex) => {
      const chapters = (Array.isArray(volume?.chapters) ? volume.chapters : [])
        .map((chapter, chapterIndex) => ({
          chapter,
          chapterIndex,
          text: normalizeMentionText(outlineSearchText(volume, chapter, volumeIndex, chapterIndex)),
        }))
        .filter((row) => !terms.length || terms.every((term) => row.text.includes(term)))
        .map(({ chapter, chapterIndex }) => ({ chapter, chapterIndex }));
      return { volume, volumeIndex, chapters };
    })
    .filter((row) => !terms.length || row.chapters.length > 0);
}

/** 章节列表搜索文本：章号 + 章节标题。正文检索走「全书查找」，这里不扫正文。 */
export function chapterSearchText(chapter, index = -1) {
  return [
    index >= 0 ? `第 ${index + 1} 章` : '',
    chapter?.title,
  ].flat(Infinity).map((value) => String(value ?? '')).join('\n');
}

/** 单章是否命中章节搜索：空格分隔多词按「都包含」，忽略大小写、空白与间隔符。
 *  空查询视为命中，方便筛选条件与搜索条件叠加。 */
export function chapterMatchesSearch(chapter, index, query) {
  const terms = String(query || '')
    .trim()
    .split(/\s+/)
    .map(normalizeMentionText)
    .filter(Boolean);
  if (!terms.length) return true;
  const text = normalizeMentionText(chapterSearchText(chapter, index));
  return terms.every((term) => text.includes(term));
}

/** 章节列表搜索：返回 { chapter, index }，保留原下标，删除 / 移动仍按原数组来。 */
export function filterChaptersBySearch(chapters, query) {
  return (Array.isArray(chapters) ? chapters : [])
    .map((chapter, index) => ({ chapter, index }))
    .filter(({ chapter, index }) => chapterMatchesSearch(chapter, index, query));
}

/** 命令面板的章节条目：全书所有章节都进索引，不截断。
 *  label 用于显示和标题匹配，hint 显示章号与卷名，keywords 供搜索使用。 */
export function buildChapterPaletteEntries(chapters, volumeLabels = []) {
  return (Array.isArray(chapters) ? chapters : []).map((chapter, index) => {
    const volume = String(volumeLabels?.[index] || '').trim();
    return {
      index,
      label: String(chapter?.title || '').trim() || '未命名章节',
      hint: [`第 ${index + 1} 章`, volume].filter(Boolean).join(' · '),
      keywords: [chapterSearchText(chapter, index), volume].filter(Boolean).join('\n'),
    };
  });
}

/** 章节看板搜索文本：章号 + 章节标题 + 卷名。看板按状态分列，这里只负责文本命中。 */
export function chapterBoardSearchText(chapter, index = -1, volume = '') {
  return [chapterSearchText(chapter, index), volume]
    .flat(Infinity)
    .map((value) => String(value ?? ''))
    .join('\n');
}

/** 单章是否命中看板搜索：标题 / 章号 / 卷名，空格分隔多词按「都包含」。
 *  空查询视为命中，方便与状态列叠加。 */
export function chapterBoardMatchesSearch(chapter, index, volume, query) {
  const terms = String(query || '')
    .trim()
    .split(/\s+/)
    .map(normalizeMentionText)
    .filter(Boolean);
  if (!terms.length) return true;
  const text = normalizeMentionText(chapterBoardSearchText(chapter, index, volume));
  return terms.every((term) => text.includes(term));
}

/** 阅读模式目录：按章节在书里的顺序分卷，并按章节名 / 章号 / 卷名过滤。
 *  volumeTitles 与 chapters 等长，空串表示未分卷（显示为「未分卷」）。
 *  返回 [{ title, chapters: [{ chapter, index }] }]，空卷不会留下。 */
export function buildReaderToc(chapters, volumeTitles = [], query = '') {
  const list = Array.isArray(chapters) ? chapters : [];
  const labels = Array.isArray(volumeTitles) ? volumeTitles : [];
  const groups = [];
  list.forEach((chapter, index) => {
    const label = String(labels[index] ?? '').trim();
    if (!chapterBoardMatchesSearch(chapter, index, label, query)) return;
    const title = label || '未分卷';
    let group = groups[groups.length - 1];
    if (!group || group.title !== title) {
      group = { title, chapters: [] };
      groups.push(group);
    }
    group.chapters.push({ chapter, index });
  });
  return groups;
}

/** 阅读目录里一卷的稳定键：首章下标 + 卷名，同名卷分在两处也不会串。 */
export function readerTocGroupKey(group) {
  const first = group?.chapters?.[0]?.index;
  return `${Number.isInteger(first) ? first : 0}|${String(group?.title || '')}`;
}

/** 长篇的阅读目录默认只展开当前章所在的卷，短篇全部展开。
 *  返回需要收起的卷键集合；当前章找不到时全部收起。 */
export function defaultReaderTocClosed(groups, currentChapterId, longBook) {
  const list = Array.isArray(groups) ? groups : [];
  if (!longBook) return new Set();
  const current = list.find((group) => group.chapters?.some(({ chapter }) => chapter.id === currentChapterId));
  return new Set(list.filter((group) => group !== current).map(readerTocGroupKey));
}

/* ---------- 阅读进度：最后阅读章 + 每章滚动位置 ---------- */

/** 每部作品最多记住多少章的阅读位置，防止 localStorage 无限膨胀。
 *  长篇通常也就几百章，600 足够覆盖，超出时先丢最久没读的章节。 */
export const READER_POSITION_LIMIT = 600;

/** 滚动比例只接受 0–1 的有限数字；坏数据一律当 0，避免阅读器跳到奇怪的位置。 */
export function clampReaderRatio(value) {
  const ratio = Number(value);
  return Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
}

/** 把本浏览器里存的旧版 / 新版阅读进度整理成统一结构。
 *  旧版只有最外层一章 `{ chapterId, ratio, ... }`，读的时候补成 positions，
 *  写回时仍保留最外层字段，书架「继续阅读」和旧数据都不用改。
 *  结构不合法（没有 chapterId）时返回 null。 */
export function normalizeReaderProgress(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !entry.chapterId) return null;
  const chapterId = String(entry.chapterId);
  const ratio = clampReaderRatio(entry.ratio);
  const updatedAt = Number(entry.updatedAt) || 0;
  const positions = {};
  const raw = entry.positions && typeof entry.positions === 'object' && !Array.isArray(entry.positions)
    ? entry.positions
    : {};
  for (const [id, pos] of Object.entries(raw)) {
    if (!id || !pos || typeof pos !== 'object' || Array.isArray(pos)) continue;
    positions[String(id)] = {
      ratio: clampReaderRatio(pos.ratio),
      updatedAt: Number(pos.updatedAt) || 0,
    };
  }
  // 最外层永远代表「最后读的那一章」，以它为准，避免两处数据不一致
  positions[chapterId] = { ratio, updatedAt };
  return {
    chapterId,
    chapterNo: Math.max(1, Math.floor(Number(entry.chapterNo) || 1)),
    chapterTitle: String(entry.chapterTitle || ''),
    ratio,
    updatedAt,
    positions,
  };
}

/** 取某一章上次读到的比例；没读过返回 null（「在开头」和「没读过」要分开）。 */
export function readerPositionOf(progress, chapterId) {
  if (!progress || !chapterId) return null;
  const pos = progress.positions?.[String(chapterId)];
  if (!pos || typeof pos !== 'object') return null;
  const ratio = Number(pos.ratio);
  return Number.isFinite(ratio) ? clampReaderRatio(ratio) : null;
}

/** 写入一章的阅读位置：同时更新「继续阅读」指向的最后章节和该章自己的位置。
 *  超过 limit 时按最后阅读时间从旧到新淘汰，刚写入的章节永远保留。 */
export function mergeReaderProgress(entry, data, { now = Date.now(), limit = READER_POSITION_LIMIT } = {}) {
  const base = normalizeReaderProgress(entry);
  if (!data?.chapterId) return base;
  const chapterId = String(data.chapterId);
  const ratio = clampReaderRatio(data.ratio);
  const updatedAt = Number(now) || Date.now();
  const positions = { ...(base?.positions || {}), [chapterId]: { ratio, updatedAt } };
  const max = Math.max(1, Math.floor(Number(limit) || READER_POSITION_LIMIT));
  const ids = Object.keys(positions);
  if (ids.length > max) {
    ids
      .filter((id) => id !== chapterId)
      .sort((a, b) => (positions[a].updatedAt || 0) - (positions[b].updatedAt || 0))
      .slice(0, ids.length - max)
      .forEach((id) => { delete positions[id]; });
  }
  return {
    chapterId,
    chapterNo: Math.max(1, Math.floor(Number(data.chapterNo) || Number(base?.chapterNo) || 1)),
    chapterTitle: String(data.chapterTitle || ''),
    ratio,
    updatedAt,
    positions,
  };
}

/* ---------- 写作位置：每章的光标 / 选区与滚动比例 ---------- */

/** 每部作品最多记住多少章的写作位置，避免 localStorage 无限膨胀。
 *  和阅读进度一样留 600 章，超出时先丢最久没切回去的章节。 */
export const EDITOR_POSITION_LIMIT = 600;

/** 把一章的写作位置整理成统一结构；坏数据返回 null。
 *  光标位置向下取整并夹到非负，选区终点不早于起点，滚动比例夹在 0–1。 */
export function normalizeEditorPosition(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const num = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
  };
  const s = num(entry.s);
  const e = Math.max(s, num(entry.e, s));
  const ratio = Number(entry.ratio);
  return {
    s,
    e,
    ratio: Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0,
    updatedAt: Number(entry.updatedAt) || 0,
  };
}

/** 从写作位置表里取某部作品某一章的位置；没记过返回 null（和「停在开头」分开）。 */
export function editorPositionOf(map, novelId, chapterId) {
  if (!map || typeof map !== 'object' || Array.isArray(map) || !novelId || !chapterId) return null;
  const own = map[String(novelId)];
  if (!own || typeof own !== 'object' || Array.isArray(own)) return null;
  return normalizeEditorPosition(own[String(chapterId)]);
}

/** 写入一章的写作位置，返回新的位置表（不改原对象）。
 *  每部作品超过 limit 时按最后写入时间从旧到新淘汰，刚写入的章节永远保留。 */
export function mergeEditorPosition(map, novelId, chapterId, data, { now = Date.now(), limit = EDITOR_POSITION_LIMIT } = {}) {
  const base = map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  const out = { ...base };
  if (!novelId || !chapterId) return out;
  const novelKey = String(novelId);
  const chapterKey = String(chapterId);
  const rawOwn = base[novelKey];
  const own = rawOwn && typeof rawOwn === 'object' && !Array.isArray(rawOwn) ? { ...rawOwn } : {};
  own[chapterKey] = normalizeEditorPosition({
    ...(data && typeof data === 'object' ? data : {}),
    updatedAt: Number(now) || Date.now(),
  });
  const max = Math.max(1, Math.floor(Number(limit) || EDITOR_POSITION_LIMIT));
  const ids = Object.keys(own);
  if (ids.length > max) {
    ids
      .filter((id) => id !== chapterKey)
      .sort((a, b) => (own[a]?.updatedAt || 0) - (own[b]?.updatedAt || 0))
      .slice(0, ids.length - max)
      .forEach((id) => { delete own[id]; });
  }
  out[novelKey] = own;
  return out;
}

/* ---------- 作品标签：输入整理与书架搜索 ---------- */

/** 一部作品最多保留多少个标签，防止输入框和书架卡片被撑爆。 */
export const NOVEL_TAG_LIMIT = 20;

/** 把标签输入整理成去重数组。
 *  字符串支持空格、中英文逗号、顿号、分号与换行分隔；数组只做去空和去重。
 *  重复判断忽略大小写，保留第一次出现的写法。 */
export function parseNovelTags(value) {
  const list = Array.isArray(value)
    ? value
    : String(value ?? '').split(/[\s,，、;；]+/);
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= NOVEL_TAG_LIMIT) break;
  }
  return out;
}

/** 书架搜索文本：书名 + 类型 + 标签。 */
export function novelSearchText(novel) {
  return [novel?.title, novel?.genre, ...parseNovelTags(novel?.tags)]
    .map((value) => String(value ?? ''))
    .join('\n');
}

/** 单部作品是否命中书架搜索：空格分隔多词按「都包含」，忽略大小写、空白与间隔符。
 *  空查询视为命中。 */
export function novelMatchesSearch(novel, query) {
  const terms = String(query || '')
    .trim()
    .split(/\s+/)
    .map(normalizeMentionText)
    .filter(Boolean);
  if (!terms.length) return true;
  const text = normalizeMentionText(novelSearchText(novel));
  return terms.every((term) => text.includes(term));
}

/** 书架卡片的标签展示：默认只摆前 limit 个，展开后全部放出。
 *  返回要渲染的 shown、被收起的 hidden、收起数量 more，以及能不能展开。 */
export function shelfTagView(tags, expanded = false, limit = 3) {
  const list = Array.isArray(tags) ? tags : [];
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
  const canToggle = list.length > cap;
  const open = Boolean(expanded && canToggle);
  const shown = open || !canToggle ? list : list.slice(0, cap);
  const hidden = open || !canToggle ? [] : list.slice(cap);
  return { shown, hidden, more: hidden.length, canToggle, expanded: open };
}

/** 书架搜索：返回原顺序的命中作品。 */
export function filterNovelsBySearch(novels, query) {
  return (Array.isArray(novels) ? novels : []).filter((novel) => novelMatchesSearch(novel, query));
}

/** 点击书架标签时切换搜索词：查询里没有就追加，已有就移除（重复项一次清掉）。
 *  比较时沿用搜索的归一化规则，大小写和空白不同也视为同一个词。 */
export function toggleSearchTerm(query, term) {
  const clean = String(term ?? '').trim();
  const terms = String(query ?? '').trim().split(/\s+/).filter(Boolean);
  const key = normalizeMentionText(clean);
  if (!clean || !key) return terms.join(' ');
  const kept = terms.filter((value) => normalizeMentionText(value) !== key);
  if (kept.length === terms.length) kept.push(clean);
  return kept.join(' ');
}

/** 书架排序：键名会存进 localStorage，保持稳定，别随手改。 */
export const SHELF_SORT_OPTIONS = [
  { key: 'updated', label: '最近更新' },
  { key: 'created', label: '最近创建' },
  { key: 'title', label: '书名' },
  { key: 'words-desc', label: '字数从多到少' },
  { key: 'words-asc', label: '字数从少到多' },
];

const shelfTitleCollator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
const shelfTitleCmp = (a, b) => shelfTitleCollator.compare(String(a?.title || ''), String(b?.title || ''));
const shelfTimeCmp = (field) => (a, b) => (Number(b?.[field]) || 0) - (Number(a?.[field]) || 0) || shelfTitleCmp(a, b);
const shelfWords = (n) => Number(n?.words) || 0;

/** 书架排序：返回新数组，不改原数组；时间类都是新到旧，书名按拼音与数字自然序。 */
export function sortNovels(novels, sort = 'updated') {
  const list = [...(Array.isArray(novels) ? novels : [])];
  switch (sort) {
    case 'created':
      return list.sort(shelfTimeCmp('createdAt'));
    case 'title':
      return list.sort((a, b) => shelfTitleCmp(a, b) || shelfTimeCmp('updatedAt')(a, b));
    case 'words-asc':
      return list.sort((a, b) => shelfWords(a) - shelfWords(b) || shelfTitleCmp(a, b));
    case 'words-desc':
      return list.sort((a, b) => shelfWords(b) - shelfWords(a) || shelfTitleCmp(a, b));
    default:
      return list.sort(shelfTimeCmp('updatedAt'));
  }
}

/** 版本快照类型：列表徽标与搜索共用。 */
export const SNAP_KINDS = {
  auto: '自动',
  manual: '手动',
  'before-delete': '删除前',
  'before-restore': '恢复前',
  'before-replace': '替换前',
  'before-shrink': '大幅删减前',
};

/** 版本搜索文本：说明 + 类型（补上「快照」后缀） + 日期。
 *  日期由调用方格式化后传入，避免这个模块依赖时间格式。 */
export function snapshotSearchText(snapshot, dateText = '') {
  const kind = SNAP_KINDS[snapshot?.kind] || '';
  return [
    snapshot?.label,
    kind ? `${kind}快照` : '快照',
    dateText,
  ].map((value) => String(value ?? '')).join('\n');
}

/** 单个版本是否命中搜索：空格分隔多词按「都包含」，忽略大小写、空白与间隔符。 */
export function snapshotMatchesSearch(snapshot, query, dateText = '') {
  const terms = String(query || '')
    .trim()
    .split(/\s+/)
    .map(normalizeMentionText)
    .filter(Boolean);
  if (!terms.length) return true;
  const text = normalizeMentionText(snapshotSearchText(snapshot, dateText));
  return terms.every((term) => text.includes(term));
}

/** 版本历史搜索：保留原顺序；dateOf 补充格式化后的日期文本。 */
export function filterSnapshotsBySearch(snapshots, query, dateOf = () => '') {
  return (Array.isArray(snapshots) ? snapshots : [])
    .filter((snapshot) => snapshotMatchesSearch(snapshot, query, dateOf(snapshot)));
}

/** 回收站搜索文本：书名 + 作者 + 类型 + 删除日期。
 *  日期同样由调用方格式化，未知时间也按界面显示的文字参与搜索。 */
export function trashSearchText(item, dateText = '') {
  return [item?.title, item?.author, item?.genre, dateText]
    .map((value) => String(value ?? '')).join('\n');
}

/** 单条回收站记录是否命中搜索：空格分隔多词按「都包含」，忽略大小写、空白与间隔符。 */
export function trashMatchesSearch(item, query, dateText = '') {
  const terms = String(query || '')
    .trim()
    .split(/\s+/)
    .map(normalizeMentionText)
    .filter(Boolean);
  if (!terms.length) return true;
  const text = normalizeMentionText(trashSearchText(item, dateText));
  return terms.every((term) => text.includes(term));
}

/** 回收站搜索：保留原顺序；dateOf 补充格式化后的删除时间。 */
export function filterTrashBySearch(items, query, dateOf = () => '') {
  return (Array.isArray(items) ? items : [])
    .filter((item) => trashMatchesSearch(item, query, dateOf(item)));
}

/** 章节搜索的键盘光标：在结果里走一步，越界时绕回另一端。
 *  current 为 -1 表示还没选过：向下从第一条开始，向上从最后一条开始。
 *  空结果返回 -1，调用方据此不响应方向键。 */
export function stepSearchCursor(current, step, total) {
  const count = Math.floor(Number(total));
  if (!Number.isFinite(count) || count <= 0) return -1;
  const dir = step < 0 ? -1 : 1;
  if (!Number.isInteger(current) || current < 0 || current >= count) {
    return dir > 0 ? 0 : count - 1;
  }
  return (current + dir + count) % count;
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

