// 书匠 · 一致性检查（纯本地，不调模型）
// 检查：设定冲突、时间线矛盾、人物行为一致性、口吻/语风
import { esc, countWords, toast } from './util.js';
import { buildCharacterAppearances, collectThreads } from './data.js';

/* ============================================================
 * 一致性检查种类
 * ============================================================ */
export const CONSISTENCY_KINDS = {
  setting: '设定冲突',      // 功法/境界/地理/物品/设定冲突
  timeline: '时间线',       // 事件顺序/时间跨度矛盾
  character: '人物行为',    // 人物行为/性格/能力不符设定
  name: '人物姓名',         // 姓名笔误 / 设定库近似重名
  voice: '口吻/语风',       // 语感/叙述口吻差异
};

/* ============================================================
 * 指纹：种类 + 标识（跟校对/体检一致，只认类型+内容，不认位置）
 * ============================================================ */
export function consistencyKey(kind, id) {
  return `consistency|${kind}|${String(id ?? '')}`;
}

/* ============================================================
 * 设定冲突检测
 * 扫描 bible.world / characters / timeline 中的自相矛盾
 * ============================================================ */
function checkSettingConflicts(novel) {
  const issues = [];
  const bible = novel?.bible || {};
  const seen = new Map(); // key -> first occurrence

  // 1. 世界观设定：同一实体的不同属性冲突
  if (bible.world?.length) {
    for (const w of bible.world) {
      const name = String(w.name || '').trim();
      if (!name) continue;
      const key = `world|${name}`;
      if (seen.has(key)) {
        const first = seen.get(key);
        // 比较关键字段
        const fields = ['type', 'level', 'description', 'location', 'affiliation'];
        for (const f of fields) {
          const v1 = String(first[f] || '').trim();
          const v2 = String(w[f] || '').trim();
          if (v1 && v2 && v1 !== v2) {
            issues.push({
              kind: 'setting',
              type: 'world_conflict',
              message: `世界观「${name}」的 ${f} 不一致："${v1}" vs "${v2}"`,
              entities: [first, w],
              loc: `世界观设定·${name}`,
              fingerprint: `consistency|setting|world_conflict|${name}|${f}|${v1}|${v2}`,
            });
          }
        }
      } else {
        seen.set(key, w);
      }
    }
  }

  // 2. 人物设定：同一人物的不同属性冲突
  if (bible.characters?.length) {
    const charSeen = new Map();
    for (const c of bible.characters) {
      const name = String(c.name || '').trim();
      if (!name) continue;
      const key = `char|${name}`;
      if (charSeen.has(key)) {
        const first = charSeen.get(key);
        const fields = ['gender', 'age', 'role', 'cultivation', 'affiliation', 'personality', 'weapon', 'skill'];
        for (const f of fields) {
          const v1 = String(first[f] || '').trim();
          const v2 = String(c[f] || '').trim();
          if (v1 && v2 && v1 !== v2) {
            issues.push({
              kind: 'setting',
              type: 'char_conflict',
              message: `人物「${name}」的 ${f} 不一致："${v1}" vs "${v2}"`,
              entities: [first, c],
              loc: `人物设定·${name}`,
              fingerprint: `consistency|setting|char_conflict|${name}|${f}|${v1}|${v2}`,
            });
          }
        }
      } else {
        charSeen.set(key, c);
      }
    }
  }

  // 3. 功法/境界/物品设定冲突
  const skillItems = [...(bible.skills || []), ...(bible.items || []), ...(bible.organizations || [])];
  const skillSeen = new Map();
  for (const s of skillItems) {
    const name = String(s.name || '').trim();
    if (!name) continue;
    const key = `skill|${name}`;
    if (skillSeen.has(key)) {
      const first = skillSeen.get(key);
      const fields = ['type', 'level', 'effect', 'requirement', 'category'];
      for (const f of fields) {
        const v1 = String(first[f] || '').trim();
        const v2 = String(s[f] || '').trim();
        if (v1 && v2 && v1 !== v2) {
          issues.push({
            kind: 'setting',
            type: 'skill_conflict',
            message: `设定「${name}」的 ${f} 不一致："${v1}" vs "${v2}"`,
            entities: [first, s],
            loc: `设定·${name}`,
            fingerprint: `consistency|setting|skill_conflict|${name}|${f}|${v1}|${v2}`,
          });
        }
      }
    } else {
      skillSeen.set(key, s);
    }
  }

  // 4. 地理/地点设定冲突
  if (bible.locations?.length) {
    const locSeen = new Map();
    for (const l of bible.locations) {
      const name = String(l.name || '').trim();
      if (!name) continue;
      const key = `loc|${name}`;
      if (locSeen.has(key)) {
        const first = locSeen.get(key);
        const fields = ['parent', 'type', 'description', 'climate', 'specialty'];
        for (const f of fields) {
          const v1 = String(first[f] || '').trim();
          const v2 = String(l[f] || '').trim();
          if (v1 && v2 && v1 !== v2) {
            issues.push({
              kind: 'setting',
              type: 'location_conflict',
              message: `地点「${name}」的 ${f} 不一致："${v1}" vs "${v2}"`,
              entities: [first, l],
              loc: `地点设定·${name}`,
              fingerprint: `consistency|setting|location_conflict|${name}|${f}|${v1}|${v2}`,
            });
          }
        }
      } else {
        locSeen.set(key, l);
      }
    }
  }

  return issues;
}

/* ============================================================
 * 时间线一致性检测
 * 从大纲/章节记忆/章纲中提取时间事件，检查顺序/跨度矛盾
 * ============================================================ */
function checkTimelineConflicts(novel) {
  const issues = [];
  const events = [];

  // 1. 从大纲提取时间事件
  if (novel?.outline?.volumes?.length) {
    for (const vol of novel.outline.volumes) {
      if (vol.chapters?.length) {
        for (const ch of vol.chapters) {
          if (ch.time || ch.date || ch.season) {
            events.push({
              source: 'outline',
              volume: vol.name,
              chapter: ch.title,
              time: ch.time || ch.date || ch.season,
              order: ch.order,
              description: ch.summary || ch.desc || '',
            });
          }
        }
      }
    }
  }

  // 2. 从章节记忆提取时间事件
  if (novel?.chapters?.length) {
    for (const ch of novel.chapters) {
      if (ch.memory?.timeline?.length) {
        for (const t of ch.memory.timeline) {
          events.push({
            source: 'memory',
            chapter: ch.title,
            chapterNo: ch.no,
            time: t.time || t.date || t.season,
            description: t.event || t.description || '',
          });
        }
      }
    }
  }

  // 3. 从时间线板块提取
  if (novel?.bible?.timeline?.length) {
    for (const t of novel.bible.timeline) {
      events.push({
        source: 'timeline',
        time: t.time || t.date || t.season,
        event: t.event || t.description || '',
        chapter: t.chapter || '',
      });
    }
  }

  // 将时间字符串解析为可比较的数值
  function parseTimeValue(timeStr) {
    if (!timeStr) return null;
    const s = String(timeStr).trim();
    if (!s) return null;

    // 1. 直接数字（年、日、章节号等）
    const directNum = s.match(/^(\d+)(?:\s*[年月日章])?$/);
    if (directNum) return parseInt(directNum[1]);

    // 2. 中文数字（一、二、三... 十、百、千、万）
    const chineseNumMap = { '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10, '百': 100, '千': 1000, '万': 10000 };
    const chineseMatch = s.match(/^([一二三四五六七八九十百千万零两]+)(?:\s*[年月日章])?$/);
    if (chineseMatch) {
      let result = 0, temp = 0;
      for (const ch of chineseMatch[1]) {
        const val = chineseNumMap[ch];
        if (val >= 10) {
          if (temp === 0) temp = 1;
          result += temp * val;
          temp = 0;
        } else {
          temp = temp * 10 + val;
        }
      }
      return result + temp;
    }

    // 3. 相对时间表达（如"三天后"、"两年前"等）
    const relativeMatch = s.match(/^(\d+|[一二三四五六七八九十百千万零两]+)\s*(天|日|月|年|周|时|刻)\s*(前|后|内)?$/);
    if (relativeMatch) {
      const numStr = relativeMatch[1];
      const unit = relativeMatch[2];
      const dir = relativeMatch[3] || '后';
      let num = parseInt(numStr);
      if (isNaN(num)) {
        // 中文数字
        let result = 0, temp = 0;
        for (const ch of numStr) {
          const val = chineseNumMap[ch];
          if (val >= 10) { if (temp === 0) temp = 1; result += temp * val; temp = 0; }
          else { temp = temp * 10 + val; }
        }
        num = result + temp;
      }
      const multipliers = { '天': 1, '日': 1, '月': 30, '年': 365, '周': 7, '时': 1/24, '刻': 1/96 };
      const mult = multipliers[unit] || 1;
      return dir === '前' ? -num * mult : num * mult;
    }

    // 4. 季节/时辰关键词映射到相对顺序值
    const seasonOrder = { '春': 1, '夏': 2, '秋': 3, '冬': 4 };
    for (const [k, v] of Object.entries(seasonOrder)) {
      if (s.includes(k)) return v * 100; // 季节粒度较粗
    }
    // 按关键词长度降序排列，优先匹配更具体的词（如"午夜"先于"夜"）
    const periodOrder = [
      ['午夜', 7], ['子时', 7], ['丑时', 7.5], ['寅时', 8], ['卯时', 9], ['辰时', 10],
      ['巳时', 11], ['午时', 12], ['未时', 13], ['申时', 14], ['酉时', 15], ['戌时', 16],
      ['亥时', 17], ['凌晨', 1], ['清晨', 1], ['拂晓', 1], ['破晓', 1], ['黎明', 1],
      ['上午', 2], ['中午', 3], ['正午', 3], ['日中', 3], ['下午', 4], ['傍晚', 5],
      ['黄昏', 5], ['日暮', 5], ['深夜', 7], ['子夜', 7], ['半夜', 7], ['深更', 7],
      ['漏尽', 7], ['晚', 5], ['夜', 6], ['晨', 1], ['午', 3]
    ];
    for (const [k, v] of periodOrder) {
      if (s.includes(k)) return v;
    }

    // 5. 关键词推断（如"清晨"、"傍晚"等）
    const morningKeys = ['早', '晨', '黎明', '破晓', '拂晓', '朝阳', '初升'];
    const noonKeys = ['午', '中午', '正午', '日中'];
    const eveningKeys = ['晚', '傍晚', '黄昏', '日暮', '落日'];
    const nightKeys = ['夜', '深夜', '午夜', '子夜', '半夜', '深更', '漏尽'];
    if (morningKeys.some(k => s.includes(k))) return 1;
    if (noonKeys.some(k => s.includes(k))) return 3;
    if (eveningKeys.some(k => s.includes(k))) return 5;
    if (nightKeys.some(k => s.includes(k))) return 7;

    return null; // 无法解析
  }

  // 为每个事件添加解析后的时间值
  const eventsWithTime = events.map(e => ({
    ...e,
    timeVal: parseTimeValue(e.time),
    timeRaw: e.time,
  }));

  // --- 检查 1：同一章内时间跨度过大（早/晚混在一起）---
  const byChapter = new Map();
  for (const e of eventsWithTime) {
    const key = e.chapter || e.volume + '·' + e.chapter;
    if (!byChapter.has(key)) byChapter.set(key, []);
    byChapter.get(key).push(e);
  }

  for (const [chap, evs] of byChapter) {
    if (evs.length < 2) continue;
    const timeVals = evs.map(e => e.timeVal).filter(v => v != null);
    if (timeVals.length < 2) continue;
    const minT = Math.min(...timeVals);
    const maxT = Math.max(...timeVals);
    // 如果在"精细"时间粒度（<100，即时辰/小时级）且跨度超过 6 个时辰（约半天），提示
    if (maxT < 100 && maxT - minT >= 6) {
      issues.push({
        kind: 'timeline',
        type: 'time_jump',
        message: `章节「${chap}」内时间跨度较大（${minT}~${maxT}），建议检查是否缺少过渡描写`,
        loc: `第${evs[0]?.chapterNo || ''}章 ${chap}`,
        fingerprint: `consistency|timeline|time_jump|${chap}`,
        severity: 'hint',
      });
    }
    // 如果在"粗略"时间粒度（年/月/日级）且跨度异常大，也提示
    if (minT >= 100 && maxT - minT > 365) {
      issues.push({
        kind: 'timeline',
        type: 'time_jump',
        message: `章节「${chap}」内日期跨度超过一年（${minT}~${maxT}），建议检查时间设定`,
        loc: `第${evs[0]?.chapterNo || ''}章 ${chap}`,
        fingerprint: `consistency|timeline|time_jump|${chap}`,
        severity: 'hint',
      });
    }
  }

  // --- 检查 2：跨章时间倒置/跳跃（基于章节顺序）---
  // 按章节顺序排序（优先用 outline 的 order，其次章节号）
  const chapterEvents = new Map(); // chapter -> { no, events[] }
  for (const e of eventsWithTime) {
    const chKey = e.chapter || e.volume + '·' + e.chapter;
    if (!chapterEvents.has(chKey)) {
      chapterEvents.set(chKey, { no: e.chapterNo || e.order || 0, events: [] });
    }
    chapterEvents.get(chKey).events.push(e);
  }

  // 取每章最早/最晚的时间值
  const chapterTimeRange = [];
  for (const [chap, data] of chapterEvents) {
    const vals = data.events.map(e => e.timeVal).filter(v => v != null);
    if (vals.length > 0) {
      chapterTimeRange.push({
        chapter: chap,
        no: data.no,
        minTime: Math.min(...vals),
        maxTime: Math.max(...vals),
        events: data.events,
      });
    }
  }

  // 按章节序号排序
  chapterTimeRange.sort((a, b) => (a.no || 0) - (b.no || 0));

  // 检测时间倒置：后一章的最早时间 < 前一章的最晚时间（且不在同一日期/年份粒度）
  for (let i = 1; i < chapterTimeRange.length; i++) {
    const prev = chapterTimeRange[i - 1];
    const curr = chapterTimeRange[i];
    // 只有当双方都在"精细"时间粒度（< 100，即时辰/小时级）时才判断倒置
    if (prev.maxTime < 100 && curr.minTime < 100 && curr.minTime < prev.maxTime) {
      issues.push({
        kind: 'timeline',
        type: 'time_reversal',
        message: `时间倒置：第 ${prev.no} 章最晚 ${prev.maxTime} 时，第 ${curr.no} 章最早 ${curr.minTime} 时`,
        loc: `第 ${prev.no} 章 → 第 ${curr.no} 章`,
        fingerprint: `consistency|timeline|time_reversal|${prev.no}|${curr.no}`,
        severity: 'warn',
      });
    }
    // 检测时间大跳跃：后一章最早时间 - 前一章最晚时间 > 合理阈值（如 30 个时辰）
    if (prev.maxTime < 100 && curr.minTime < 100 && curr.minTime - prev.maxTime > 30) {
      issues.push({
        kind: 'timeline',
        type: 'time_gap',
        message: `时间跳跃：第 ${prev.no} 章(${prev.maxTime}) 到第 ${curr.no} 章(${curr.minTime}) 间隔 ${curr.minTime - prev.maxTime} 个时辰，建议确认是否有过渡`,
        loc: `第 ${prev.no} 章 → 第 ${curr.no} 章`,
        fingerprint: `consistency|timeline|time_gap|${prev.no}|${curr.no}`,
        severity: 'hint',
      });
    }
  }

  // --- 检查 3：同一章内具体事件时间冲突（如同时发生两件互斥的事）---
  for (const [chap, evs] of byChapter) {
    if (evs.length < 2) continue;
    // 检查是否有完全相同的时间点但描述互斥的事件
    const byTime = new Map();
    for (const e of evs) {
      const key = e.timeRaw || '';
      if (!byTime.has(key)) byTime.set(key, []);
      byTime.get(key).push(e);
    }
    // 互斥动作对：无法同时发生
    const mutexPairs = [
      [/死|逝世|殒命|牺牲|阵亡|去逝/, /活|生存|复活|苏醒|醒来/],
      [/在.*?睡|入睡|睡着|熟睡|沉睡/, /醒|醒来|苏醒|睁眼|起身/],
      [/离开|出发|动身|启程|远去|走远/, /到达|抵达|归来|回到|返回/],
      [/开始|起始|开启|发端/, /结束|终结|完结|落幕|收尾/],
      [/获得|得到|拥有|拾获|捡到/, /失去|丢失|遗失|不见了/],
      [/结婚|成亲|完婚|拜堂/, /离婚|和离|分手|决裂/],
      [/突破|晋升|进阶|晋入/, /跌落|境界跌|修为废|丹田碎/],
    ];
    for (const [timeKey, timeEvs] of byTime) {
      if (timeEvs.length > 1) {
        const descs = timeEvs.map(e => e.description || e.event || '');
        // 两两比较描述，检查互斥
        for (let i = 0; i < descs.length; i++) {
          for (let j = i + 1; j < descs.length; j++) {
            const d1 = descs[i];
            const d2 = descs[j];
            for (const [pos, neg] of mutexPairs) {
              const hasPos = pos.test(d1) && neg.test(d2) || pos.test(d2) && neg.test(d1);
              if (hasPos) {
                issues.push({
                  kind: 'timeline',
                  type: 'simultaneous_conflict',
                  message: `同一时间「${timeKey}」出现互斥事件：「${d1}」与「${d2}」无法同时发生`,
                  loc: `第${timeEvs[0]?.chapterNo || ''}章 ${chap}`,
                  fingerprint: `consistency|timeline|simultaneous_conflict|${chap}|${timeKey}`,
                  severity: 'warn',
                });
              }
            }
          }
        }
      }
    }
  }

  return issues;
}

/* ============================================================
 * 人物行为一致性检测
 * 基于设定库中的性格/能力/境界，检查正文中是否有明显违背
 * ============================================================ */
function checkCharacterConsistency(novel) {
  const issues = [];
  const bible = novel?.bible || {};

  if (!novel?.chapters?.length || !bible.characters?.length) return issues;

  // 建立人物设定索引
  const charDefs = new Map();
  for (const c of bible.characters) {
    const name = String(c.name || '').trim();
    if (name) charDefs.set(name.toLowerCase(), c);
    // 别名支持
    if (c.alias?.length) {
      for (const alias of c.alias) {
        charDefs.set(alias.toLowerCase(), c);
      }
    }
  }

  // 建立关键词模式库
  const inabilityPatterns = [
    { pattern: /(?:不会|不会|做不到|使不出|用不出|施展不了|使不来)/, field: 'skill', msg: '设定拥有但正文表现为不会' },
    { pattern: /(?:从未|从来没|从不曾|未曾|从未见过|没见过|未曾见过|从未听闻|未曾听闻|不知|不晓|不了解|不清楚|不认识)/, field: 'knowledge', msg: '设定知晓但正文表现为不知' },
    { pattern: /(?:做不到|办不到|力不从心|能力不足|修为不够|境界不够|修为尚浅)/, field: 'cultivation', msg: '设定境界足够但正文表现为修为不足' },
    { pattern: /(?:性格|脾气|脾性|个性|秉性).*?(?:改变|大变|突变|判若两人|完全不同|截然不同)/, field: 'personality', msg: '性格设定与正文表现不符' },
  ];

  // 正面能力/知识表达模式
  const abilityPatterns = [
    { pattern: /(?:运用|施展|使出|施展出|催动|激发|使用|动用).*?([^\s，。！？]+?)(?:功|法|术|诀|招|式|技|能|力)/, field: 'skill', msg: '使用了未在设定中的技能' },
    { pattern: /(?:知晓|知悉|清楚|了解|熟知|精通|精研|深谙|洞悉|了然于胸).*?([^\s，。！？]+)/, field: 'knowledge', msg: '表现知晓未在设定中的知识' },
    { pattern: /(?:修为|境界|修为已至|已至|晋入|突破至|达到了?).*?([^\s，。！？]+?)(?:期|境|重|层|阶|级)/, field: 'cultivation', msg: '表现的修为境界与设定不符' },
  ];

  // 性格特质反义词对（用于检测性格表现矛盾）
  const personalityAntonyms = [
    [/胆小|怕事|畏缩|懦弱|不敢|害怕|恐惧|惊恐/, /勇敢|大胆|无畏|豪迈|果断|冲锋|迎难而上/],
    [/暴躁|易怒|脾气差|火爆|冲动|急躁/, /冷静|沉稳|克制|忍耐|温和|平静/],
    [/贪婪|贪财|爱财|吝啬|小气|自私/, /大方|慷慨|豁达|不计较|舍得/],
    [/傲慢|自大|狂妄|目中无人|看不起/, /谦逊|低调|恭敬|谦虚|不骄不躁/],
    [/懒惰|偷懒|拖延|不思进取|安逸/, /勤奋|努力|上进|刻苦|拼命/],
    [/多疑|猜忌|不信任|防备|心思重/, /信任|坦荡|直爽|豁达/],
    [/冷漠|无情|薄情|寡情|绝情/, /深情|重情|多情|温情/],
    [/老实|木讷|笨拙|不会变通|死板/, /机灵|灵活|圆滑|善变/],
    [/悲观|消极|颓废|绝望|灰心/, /乐观|积极|向上|坚韧/],
    [/冲动|鲁莽|莽撞|不计后果/, /深思熟虑|三思而行|谨慎/],
  ];

  // 从性格描述中提取关键特质词
  function extractPersonalityTraits(text) {
    if (!text) return [];
    const traits = [];
    const traitKeywords = [
      '胆小', '勇敢', '暴躁', '冷静', '贪婪', '大方', '傲慢', '谦逊',
      '懒惰', '勤奋', '多疑', '信任', '冷漠', '深情', '老实', '机灵',
      '悲观', '乐观', '冲动', '谨慎', '内向', '外向', '敏感', '迟钝',
      '固执', '柔和', '自卑', '自信', '嫉妒', '宽容', '记仇', '不记仇',
      '完美主义', '随性', '强迫症', '洁癖', '拖延症', '选择困难症',
    ];
    for (const kw of traitKeywords) {
      if (text.includes(kw)) traits.push(kw);
    }
    return traits;
  }

  // 检查文本中是否表现出与特质相反的行为
  function checkPersonalityContradiction(text, definedTraits) {
    const contradictions = [];
    for (const trait of definedTraits) {
      for (const [neg, pos] of personalityAntonyms) {
        // 如果设定有负面特质，但正文表现正面行为
        if (neg.test(trait) && pos.test(text)) {
          contradictions.push(`设定「${trait}」但表现「${text.match(pos)[0]}」`);
        }
        // 如果设定有正面特质，但正文表现负面行为
        if (pos.test(trait) && neg.test(text)) {
          contradictions.push(`设定「${trait}」但表现「${text.match(neg)[0]}」`);
        }
      }
    }
    return contradictions;
  }

  for (const ch of novel?.chapters || []) {
    if (!ch.content?.trim()) continue;
    const text = ch.content;
    const chapterNo = ch.no || 0;

    for (const [charName, def] of charDefs) {
      // 检查人物是否在本章出现
      const nameRegex = new RegExp(escapeRegExp(charName), 'g');
      if (!nameRegex.test(text)) continue;

      // 检查负面表达（不应该有的）
      for (const { pattern, field, msg } of inabilityPatterns) {
        if (pattern.test(text)) {
          issues.push({
            kind: 'character',
            type: `${field}_inconsistency`,
            message: `第 ${ch.no} 章《${ch.title}》中「${charName}」${msg}`,
            location: `第 ${ch.no} 章 ${ch.title}`,
            fingerprint: `consistency|character|${field}_inconsistency|${charName}|${ch.id}`,
          });
        }
      }

      // 检查正面表达（不应该有的能力/知识）
      const definedSkills = new Set([
        ...(def.skills || []).map(s => String(s.name || s).trim()),
        ...(def.specialAbilities || []).map(s => String(s.name || s).trim()),
        ...(def.techniques || []).map(s => String(s.name || s).trim()),
      ].filter(Boolean));

      const definedKnowledge = new Set([
        ...(def.knowledge || []).map(k => String(k.name || k).trim()),
        ...(def.expertise || []).map(k => String(k.name || k).trim()),
      ].filter(Boolean));

      const definedCultivation = String(def.cultivation || def.realm || def.level || '').trim();

      for (const { pattern, field, msg } of abilityPatterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
          const matched = match[1]?.trim() || '';
          if (!matched) continue;

          let conflict = false;
          if (field === 'skill' && !hasSimilar(definedSkills, matched)) conflict = true;
          if (field === 'knowledge' && !hasSimilar(definedKnowledge, matched)) conflict = true;
          if (field === 'cultivation' && definedCultivation && !cultivationMatches(definedCultivation, matched)) conflict = true;

          if (conflict) {
            issues.push({
              kind: 'character',
              type: `${field}_unexpected`,
              message: `第 ${ch.no} 章《${ch.title}》中「${charName}」${msg}：「${matched}」`,
              location: `第 ${ch.no} 章 ${ch.title}`,
              fingerprint: `consistency|character|${field}_unexpected|${charName}|${ch.id}|${matched}`,
            });
          }
        }
      }

      // --- 性格特质一致性检查 ---
      const personalityText = String(def.personality || def.flaw || def.speech || '').trim();
      if (personalityText) {
        const definedTraits = extractPersonalityTraits(personalityText);
        if (definedTraits.length > 0) {
          // 提取人物相关的上下文片段（以人物名为中心前后各 200 字）
          const nameRegex = new RegExp(escapeRegExp(charName), 'g');
          let match;
          const contexts = [];
          while ((match = nameRegex.exec(text)) !== null) {
            const start = Math.max(0, match.index - 200);
            const end = Math.min(text.length, match.index + match[0].length + 200);
            contexts.push(text.slice(start, end));
          }
          // 如果没有找到人物名（可能用代词），取全文
          const searchText = contexts.length > 0 ? contexts.join(' ') : text;
          const contradictions = checkPersonalityContradiction(searchText, definedTraits);
          for (const msg of contradictions) {
            issues.push({
              kind: 'character',
              type: 'personality_contradiction',
              message: `第 ${ch.no} 章《${ch.title}》中「${charName}」性格矛盾：${msg}`,
              location: `第 ${ch.no} 章 ${ch.title}`,
              fingerprint: `consistency|character|personality_contradiction|${charName}|${ch.id}|${msg}`,
              severity: 'warn',
            });
          }
        }
      }
    }
  }

  return issues;
}

/* ============================================================
 * 人物姓名笔误检测
 * ------------------------------------------------------------
 * 设定库里的姓名是权威写法。正文里如果出现「只差一个字」的写法，
 * 而且正好落在「说道 / 点了点头 / 的 + 身体部位」这类只有人名才会
 * 出现的位置，就提示可能是笔误。只做字符串比较，不调用模型。
 * ============================================================ */

// 姓名后面跟着这些内容，基本可以确定是在指人，而不是「林中」「江上」
// 这类普通词语。单字「道 / 说 / 问」必须紧跟标点，避免把「林中道路」
// 误当成「林中道」。
const NAME_CONTEXT_AFTER = [
  /^(?:说道|问道|答道|喊道|叫道|骂道|喝道|笑道|叹道|低声道|沉声道|冷笑道|苦笑道|冷哼道|开口道)/,
  /^[说道问答喊叫骂喝笑叹](?=[：:，,。！？!?、“”「」"'…\s]|$)/,
  /^(?:说|问|答|喊|叫|笑|叹)(?:了|着)/,
  /^(?:点了点头|摇了摇头|皱了皱眉|抬了抬头|低了低头|转过身(?:来)?|回过头(?:来)?|站起身来|坐了下来|伸出手|沉默(?:片刻|了一会)?|愣了(?:一下)?|怔了(?:一下)?|冷笑|苦笑|冷哼|点头|摇头|皱眉|抬头|低头|转身|回头|看向|望向|看着|看了|盯着|打量|站起|坐下|伸手)(?:道|了|着)?/,
  /^的(?:手|眼|眼睛|脸|脸上|声音|目光|心|心里|背影|肩膀|嘴角|眉头|名字|身份|语气|神色|眼中|手里|剑|刀)/,
  /^(?:一眼|一下|一声|一番)/,
  /^[：:]/,
];

function isNameContext(text, start, end) {
  const after = text.slice(end, end + 10);
  if (!after) return false;
  return NAME_CONTEXT_AFTER.some((re) => re.test(after));
}

function isHanName(name) {
  return /^[\u4e00-\u9fa5]{2,4}$/.test(name);
}

// 章节标题本身可能已经带「第 1 章」，定位文字里就不再重复一遍
function nameChapterLoc(ch) {
  const no = Number(ch.no) || 0;
  const title = String(ch.title || '').trim();
  if (!title) return `第 ${no} 章`;
  if (/^第\s*[0-9一二三四五六七八九十百千零两]+\s*章/.test(title)) return title;
  return `第 ${no} 章 ${title}`;
}

// 两个等长名字是否只差一个字
function oneCharDiff(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      diff += 1;
      if (diff > 1) return false;
    }
  }
  return diff === 1;
}

function checkNameTypos(novel) {
  const issues = [];
  const bible = novel?.bible || {};
  const characters = Array.isArray(bible.characters) ? bible.characters : [];
  if (!characters.length) return issues;

  // 设定库里的正式姓名（同一姓名重复出现只算一次，交给设定冲突去报）
  const names = [];
  const seen = new Set();
  for (const c of characters) {
    const name = String(c?.name || '').trim();
    if (!isHanName(name) || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  if (!names.length) return issues;

  // 1. 设定库里只差一个字的两个人物：先确认是不是同一张卡写了两遍
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      if (!oneCharDiff(names[i], names[j])) continue;
      issues.push({
        kind: 'name',
        type: 'name_duplicate',
        message: `人物卡里「${names[i]}」与「${names[j]}」只差一个字，确认不是同一个人或姓名笔误`,
        loc: '设定库 · 人物',
        fingerprint: `consistency|name|name_duplicate|${names[i]}|${names[j]}`,
        severity: 'hint',
      });
    }
  }

  // 2. 正文里的近似写法。按姓名长度建「通配签名」索引：
  //    「林昭」会生成「林□」「□昭」，正文里的「林招」命中「林□」。
  //    二字名只查名不查姓（□昭 不建），因为「林中」「江上」这类
  //    普通词太多，改姓的笔误交给更长的名字去兜。
  const byLength = new Map();
  for (const name of names) {
    let bySig = byLength.get(name.length);
    if (!bySig) {
      bySig = new Map();
      byLength.set(name.length, bySig);
    }
    for (let p = 0; p < name.length; p += 1) {
      if (name.length === 2 && p === 0) continue;
      const sig = `${name.slice(0, p)}\u0000${name.slice(p + 1)}`;
      let arr = bySig.get(sig);
      if (!arr) {
        arr = [];
        bySig.set(sig, arr);
      }
      arr.push(name);
    }
  }

  // 设定库里其它实体的名字不能当成笔误：门派、地点、功法、物品都可能
  // 和人物名只差一个字（比如人物「林昭」、宗门「林照宗」）。
  const knownNames = new Set(seen);
  const addKnown = (value) => {
    const n = String(value || '').trim();
    if (n) knownNames.add(n);
  };
  for (const c of characters) {
    const aliases = [
      ...(Array.isArray(c.alias) ? c.alias : c.alias ? [c.alias] : []),
      ...(Array.isArray(c.aliases) ? c.aliases : c.aliases ? [c.aliases] : []),
      ...(Array.isArray(c.keywords) ? c.keywords : c.keywords ? [c.keywords] : []),
    ];
    for (const alias of aliases) addKnown(alias);
  }
  for (const key of ['world', 'skills', 'items', 'organizations', 'locations']) {
    for (const item of bible[key] || []) addKnown(item?.name);
  }

  const hits = new Map(); // canonical + 候选 -> 统计
  for (const ch of novel?.chapters || []) {
    const text = String(ch.content || '');
    if (!text) continue;
    for (const [len, bySig] of byLength) {
      if (text.length < len) continue;
      for (let i = 0; i + len <= text.length; i += 1) {
        const window = text.slice(i, i + len);
        if (!isHanName(window)) continue;
        if (knownNames.has(window)) continue;

        let matched = null;
        for (let p = 0; p < len; p += 1) {
          if (len === 2 && p === 0) continue;
          const sig = `${window.slice(0, p)}\u0000${window.slice(p + 1)}`;
          const arr = bySig.get(sig);
          if (arr) {
            matched = arr;
            break;
          }
        }
        if (!matched) continue;
        if (!isNameContext(text, i, i + len)) continue;

        for (const canonical of matched) {
          const key = `${canonical}\u0000${window}`;
          let hit = hits.get(key);
          if (!hit) {
            hit = { canonical, candidate: window, count: 0, chapters: new Map(), sample: '' };
            hits.set(key, hit);
          }
          hit.count += 1;
          if (!hit.chapters.has(ch.id)) {
            hit.chapters.set(ch.id, { id: ch.id, no: Number(ch.no) || 0, title: ch.title || '' });
          }
          if (!hit.sample) {
            const from = Math.max(0, i - 12);
            const to = Math.min(text.length, i + len + 12);
            hit.sample = text.slice(from, to).replace(/\s+/g, ' ').trim();
          }
        }
      }
    }
  }

  for (const hit of hits.values()) {
    const chapters = [...hit.chapters.values()].sort((a, b) => a.no - b.no);
    const first = chapters[0];
    const nos = chapters.map((c) => c.no).filter(Boolean);
    const noText = nos.slice(0, 4).join('、') + (nos.length > 4 ? ' 等' : '');
    issues.push({
      kind: 'name',
      type: 'name_typo',
      message: `疑似姓名笔误：「${hit.candidate}」应为「${hit.canonical}」（${hit.count} 次，第 ${noText} 章）`,
      loc: `首次出现：${nameChapterLoc(first)} · 上下文：…${hit.sample}…`,
      chapterNo: first.no,
      fingerprint: `consistency|name|name_typo|${hit.canonical}|${hit.candidate}`,
      severity: 'hint',
    });
  }

  return issues;
}

// 辅助函数：转义正则特殊字符
function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Levenshtein 编辑距离（用于模糊匹配）
function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = Array.from({ length: a.length + 1 }, (_, i) => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // 删除
        matrix[i][j - 1] + 1,      // 插入
        matrix[i - 1][j - 1] + cost // 替换
      );
    }
  }
  return matrix[a.length][b.length];
}

// 相似度阈值：编辑距离 / max(len) < 0.3 视为相似
function isSimilar(a, b, threshold = 0.3) {
  if (a === b) return true;
  const dist = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen > 0 && dist / maxLen < threshold;
}

// 辅助函数：模糊匹配技能/知识
function hasSimilar(set, target) {
  if (!target) return false;
  const targetLower = target.toLowerCase();
  for (const item of set) {
    const itemLower = item.toLowerCase();
    if (itemLower === targetLower) return true;
    if (itemLower.includes(targetLower) || targetLower.includes(itemLower)) return true;
    if (itemLower.startsWith(targetLower) || targetLower.startsWith(itemLower)) return true;
    if (itemLower.endsWith(targetLower) || targetLower.endsWith(itemLower)) return true;
    // 编辑距离模糊匹配
    if (isSimilar(itemLower, targetLower)) return true;
  }
  return false;
}

// 辅助函数：境界匹配检查
function cultivationMatches(defined, text) {
  if (!defined || !text) return false;
  const definedNorm = normalizeCultivation(defined);
  const textNorm = normalizeCultivation(text);
  return definedNorm === textNorm;
}

function normalizeCultivation(str) {
  const map = {
    '炼气': 1, '筑基': 2, '金丹': 3, '元婴': 4, '化神': 5, '合体': 6, '大乘': 7, '渡劫': 8,
    '练气': 1, '聚气': 1, '引气': 1,
    '一重': 1, '二重': 2, '三重': 3, '四重': 4, '五重': 5, '六重': 6, '七重': 7, '八重': 8, '九重': 9,
    '初期': 1, '中期': 2, '后期': 3, '巅峰': 4, '大圆满': 5,
  };
  let result = 0;
  for (const [key, val] of Object.entries(map)) {
    if (str.includes(key)) result = Math.max(result, val);
  }
  return result;
}

/* ============================================================
 * 口吻/语风一致性（可选，较重，仅在用户开启时跑）
 * 对比不同章节的：平均句长、常用词频、标点风格、人称视角、词汇丰富度、功能词分布、句式多样性
 * ============================================================ */
function checkVoiceConsistency(novel) {
  const issues = [];
  const written = (novel?.chapters || []).filter(c => (c.content || '').trim().length > 100);
  if (written.length < 3) return issues;

  // 统计每章的风格指标
  const stats = written.map(ch => {
    const text = ch.content || '';
    const sentences = text.split(/[。！？.!?]+/).filter(s => s.trim().length > 0);
    const avgSentLen = sentences.length ? text.length / sentences.length : 0;
    const dialogRatio = (text.match(/“[^”]*”|「[^」]*」|"[^"]*"/g) || []).join('').length / text.length;
    const punctCounts = {
      comma: (text.match(/，/g) || []).length,
      period: (text.match(/。/g) || []).length,
      exclaim: (text.match(/！/g) || []).length,
      question: (text.match(/？/g) || []).length,
      ellipse: (text.match(/…/g) || []).length,
    };
    // 词汇丰富度指标
    const words = text.match(/[\u4e00-\u9fff\w]+/g) || [];
    const uniqueWords = new Set(words.map(w => w.toLowerCase()));
    const typeTokenRatio = words.length ? uniqueWords.size / words.length : 0;
    const hapaxLegomena = [...uniqueWords].filter(w => words.filter(x => x.toLowerCase() === w).length === 1).length;
    const hapaxRatio = words.length ? hapaxLegomena / words.length : 0;

    // 功能词频率（更稳健的文体指纹）
    const functionWords = ['的','了','在','是','我','有','和','就','不','人','都','一','一个','上','也','很','到','说','要','去','你','会','着','没有','看','好','自己','这','那','里','就是','还是','觉得','觉得','时候','因为','所以','但是','然后','如果','虽然','只有','什么','怎么','为什么','哪里','谁','怎么','多少','可以','应该','可能','必须','需要','想要','喜欢','讨厌','害怕','担心','开心','难过','生气','惊讶','恐惧','愤怒','平静','激动','紧张','放松'];
    const functionWordCounts = {};
    for (const fw of functionWords) {
      const count = (text.match(new RegExp(fw, 'g')) || []).length;
      if (count > 0) functionWordCounts[fw] = count;
    }

    // 句式结构多样性
    const simpleSentences = text.match(/[^，。！？,!.?]+[，。！？]/g) || [];
    const compoundSentences = text.match(/[^，。！？,!.?]+(?:[,，][^，。！？,!.?]+)*[。！？]/g) || [];
    const complexRatio = compoundSentences.length ? compoundSentences.length / (simpleSentences.length + compoundSentences.length) : 0;

    const person = detectPerson(text);
    return {
      chapter: ch,
      avgSentLen: Math.round(avgSentLen),
      dialogRatio: Math.round(dialogRatio * 1000) / 1000,
      punctCounts: {
        comma: (text.match(/，/g) || []).length,
        period: (text.match(/。/g) || []).length,
        exclaim: (text.match(/！/g) || []).length,
        question: (text.match(/？/g) || []).length,
        ellipse: (text.match(/…/g) || []).length,
      },
      person,
      // 新增指标
      typeTokenRatio: Math.round(typeTokenRatio * 10000) / 10000,
      hapaxRatio: Math.round(hapaxRatio * 10000) / 10000,
      functionWordProfile: functionWordCounts,
      complexRatio: Math.round(complexRatio * 1000) / 1000,
    };
  });

  // 检测人称视角突变
  const persons = stats.map(s => s.person);
  for (let i = 1; i < stats.length; i++) {
    if (stats[i].person !== stats[i-1].person) {
      issues.push({
        kind: 'voice',
        type: 'person_shift',
        message: `第 ${stats[i-1].chapter.no} 章（${stats[i-1].person}）→ 第 ${stats[i].chapter.no} 章（${stats[i].person}）：叙述人称发生切换`,
        loc: `第 ${stats[i-1].chapter.no} 章 ↔ 第 ${stats[i].chapter.no} 章`,
        fingerprint: `consistency|voice|person_shift|${stats[i-1].chapter.id}|${stats[i].chapter.id}`,
      });
    }
  }

  // 平均句长突变（> 2 倍或 < 0.5 倍）
  const avgLens = stats.map(s => s.avgSentLen).filter(v => v > 0);
  const globalAvg = avgLens.reduce((a, b) => a + b, 0) / avgLens.length;
  for (const s of stats) {
    if (s.avgSentLen > globalAvg * 2.5 || s.avgSentLen < globalAvg * 0.4) {
      issues.push({
        kind: 'voice',
        type: 'sentence_len_anomaly',
        message: `第 ${s.chapter.no} 章《${s.chapter.title}》平均句长 ${s.avgSentLen} 字，显著偏离全书均值 ${Math.round(globalAvg)} 字`,
        loc: `第 ${s.chapter.no} 章 ${s.chapter.title}`,
        fingerprint: `consistency|voice|sentence_len|${s.chapter.id}`,
        severity: 'hint',
      });
    }
  }

  // 对话比例突变
  const dialogRatios = stats.map(s => s.dialogRatio);
  const globalDialog = dialogRatios.reduce((a, b) => a + b, 0) / dialogRatios.length;
  for (const s of stats) {
    if (globalDialog > 0 && (s.dialogRatio > globalDialog * 3 || s.dialogRatio < globalDialog * 0.3)) {
      issues.push({
        kind: 'voice',
        type: 'dialog_ratio_anomaly',
        message: `第 ${s.chapter.no} 章《${s.chapter.title}》对话占比 ${Math.round(s.dialogRatio * 100)}%，显著偏离全书均值 ${Math.round(globalDialog * 100)}%`,
        loc: `第 ${s.chapter.no} 章 ${s.chapter.title}`,
        fingerprint: `consistency|voice|dialog_ratio|${s.chapter.id}`,
        severity: 'hint',
      });
    }
  }

  // 词汇丰富度突变（TTR 突变）
  const ttrs = stats.map(s => s.typeTokenRatio).filter(v => v > 0);
  const globalTTR = ttrs.reduce((a, b) => a + b, 0) / ttrs.length;
  for (const s of stats) {
    if (s.typeTokenRatio > 0 && (s.typeTokenRatio > globalTTR * 1.5 || s.typeTokenRatio < globalTTR * 0.6)) {
      issues.push({
        kind: 'voice',
        type: 'ttr_anomaly',
        message: `第 ${s.chapter.no} 章《${s.chapter.title}》词汇丰富度 ${(s.typeTokenRatio * 100).toFixed(1)}%，显著偏离全书均值 ${(globalTTR * 100).toFixed(1)}%`,
        loc: `第 ${s.chapter.no} 章 ${s.chapter.title}`,
        fingerprint: `consistency|voice|ttr|${s.chapter.id}`,
        severity: 'hint',
      });
    }
  }

  // 功能词分布异常（余弦相似度）
  const fwNames = Object.keys(stats[0]?.functionWordProfile || {});
  if (fwNames.length > 0) {
    const globalFW = {};
    for (const fw of Object.keys(stats[0]?.functionWordProfile || {})) {
      const counts = stats.map(s => s.functionWordProfile?.[fw] || 0);
      const total = counts.reduce((a, b) => a + b, 0);
      globalFW[fw] = total / counts.reduce((a, b) => a + b, 1);
    }
    for (const s of stats) {
      const profile = s.functionWordProfile || {};
      // 计算余弦相似度
      let dot = 0, normA = 0, normB = 0;
      for (const fw of Object.keys(globalFW)) {
        const a = profile[fw] || 0;
        const b = globalFW[fw] || 0;
        dot += a * b;
        normA += a * a;
        normB += b * b;
      }
      const similarity = (normA && normB) ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 1;
      if (similarity < 0.7) {
        issues.push({
          kind: 'voice',
          type: 'function_word_anomaly',
          message: `第 ${s.chapter.no} 章《${s.chapter.title}》功能词分布与全书风格差异较大（相似度 ${Math.round(similarity * 100)}%）`,
          loc: `第 ${s.chapter.no} 章 ${s.chapter.title}`,
          fingerprint: `consistency|voice|function_word|${s.chapter.id}`,
          severity: 'hint',
        });
      }
    }
  }

  // 句式复杂度突变
  const complexRatios = stats.map(s => s.complexRatio).filter(v => v > 0);
  const globalComplex = complexRatios.reduce((a, b) => a + b, 0) / complexRatios.length;
  for (const s of stats) {
    if (s.complexRatio > 0 && (s.complexRatio > globalComplex * 2 || s.complexRatio < globalComplex * 0.5)) {
      issues.push({
        kind: 'voice',
        type: 'complexity_anomaly',
        message: `第 ${s.chapter.no} 章《${s.chapter.title}》句式复杂度 ${(s.complexRatio * 100).toFixed(1)}%，显著偏离全书均值 ${(globalComplex * 100).toFixed(1)}%`,
        loc: `第 ${s.chapter.no} 章 ${s.chapter.title}`,
        fingerprint: `consistency|voice|complexity|${s.chapter.id}`,
        severity: 'hint',
      });
    }
  }

  return issues;
}

export function detectPerson(text) {
  // 第一人称指标词
  const firstPersonPatterns = [
    /我[的们]/g, /我的/g, /我[^的们]/g,        // 我、我们、我的
    /俺[的们]?/g, /鄙人/g, /在下/g,            // 方言/谦称
    /本[人座主]/g, /吾/g, /吾等/g,            // 文言/自称
  ];
  // 第三人称指标词
  const thirdPersonPatterns = [
    /(?:他|她|它|其)[的们]?/g,                // 他/她/它/其 + 的/们
    /(?:他|她|它)(?:说|想|看|走|跑|笑|哭|怒|喜)/g, // 他/她/它 + 动词
    /(?:此人|该|其人|彼|旁人|别人|众人|他人)/g, // 指代词
    /主角|男主|女主|配角|反派|路人/g,         // 角色称呼
  ];
  // 第二人称指标词（对话中常见）
  const secondPersonPatterns = [
    /你[的们]?/g, /您[的们]?/g, /汝[的们]?/g, /尔[的们]?/g,
  ];

  let first = 0, third = 0, second = 0;
  for (const p of firstPersonPatterns) first += (text.match(p) || []).length;
  for (const p of thirdPersonPatterns) third += (text.match(p) || []).length;
  for (const p of secondPersonPatterns) second += (text.match(p) || []).length;

  // 计算比例而非绝对数量，避免文本长度影响
  const total = first + third + second;
  if (total === 0) return 'mixed';

  const firstRatio = first / total;
  const thirdRatio = third / total;

  // 判定阈值：占比 > 50% 且领先第二名 2 倍以上
  if (firstRatio > 0.5 && first > third * 2) return 'first';
  if (thirdRatio > 0.5 && third > first * 2) return 'third';
  // 对话密集时可能出现大量第二人称，不作为叙述人称判定依据
  return 'mixed';
}

/* ============================================================
 * 主入口：扫描全书一致性
 * ============================================================ */
export function scanConsistency(novel, scope = 'book', currentChapterId = null) {
  const chapters = scope === 'book'
    ? novel?.chapters || []
    : (novel?.chapters || []).filter(c => c.id === currentChapterId);

  if (!chapters.length) return { scope, issues: [], issueKinds: 0 };

  // 设定冲突（全书范围）
  const settingIssues = checkSettingConflicts(novel);
  // 时间线（全书范围）
  const timelineIssues = checkTimelineConflicts(novel);
  // 人物行为（全书范围）
  const charIssues = checkCharacterConsistency(novel);
  // 人物姓名笔误（全书范围）
  const nameIssues = checkNameTypos(novel);
  // 口吻/语风（仅全书范围有意义）
  const voiceIssues = scope === 'book' ? checkVoiceConsistency(novel) : [];

  const allIssues = [...settingIssues, ...timelineIssues, ...charIssues, ...nameIssues, ...voiceIssues];
  allIssues.sort((a, b) => (a.chapterNo || 0) - (b.chapterNo || 0) || (a.start || 0) - (b.start || 0));

  const issueKinds = new Set(allIssues.map(i => i.kind)).size;

  return {
    scope,
    totalChapters: chapters.length,
    issues: allIssues,
    issueKinds,
    byKind: {
      setting: settingIssues.length,
      timeline: timelineIssues.length,
      character: charIssues.length,
      name: nameIssues.length,
      voice: voiceIssues.length,
    },
  };
}

/* ============================================================
 * 按忽略清单过滤
 * ============================================================ */
export function applyConsistencyIgnored(report, ignored = []) {
  const set = new Set(ignored.map(x => (typeof x === 'string' ? x : x?.key)).filter(Boolean));
  const out = { ...report };
  const before = report.issues || [];
  const after = before.filter(i => !set.has(i.fingerprint || consistencyKey(i.kind, i.id)));
  out.issues = after;
  out.hidden = before.length - after.length;
  out.byKind = {
    setting: after.filter(i => i.kind === 'setting').length,
    timeline: after.filter(i => i.kind === 'timeline').length,
    character: after.filter(i => i.kind === 'character').length,
    name: after.filter(i => i.kind === 'name').length,
    voice: after.filter(i => i.kind === 'voice').length,
  };
  out.issueKinds = new Set(after.map(i => i.kind)).size;
  return out;
}

/* ============================================================
 * 生成 Markdown 报告
 * ============================================================ */
export function consistencyMarkdown(r) {
  const out = [];
  const push = (s = '') => out.push(s);

  push(`# 一致性检查报告`);
  push(`> ${new Date().toLocaleString('zh-CN')} · 本地统计，不调用模型`);
  push('');

  if (!r.issues?.length) {
    push('✅ 未发现明显一致性问题。');
    return out.join('\n');
  }

  const byKind = {};
  for (const i of r.issues) {
    if (!byKind[i.kind]) byKind[i.kind] = [];
    byKind[i.kind].push(i);
  }

  const kindLabels = { setting: '设定冲突', timeline: '时间线', character: '人物行为', name: '人物姓名', voice: '口吻/语风' };

  for (const [kind, list] of Object.entries(byKind)) {
    push(`## ${kindLabels[kind] || kind} (${list.length})`);
    for (const item of list) {
      const sev = item.severity === 'hint' ? '💡 ' : '';
      push(`- ${sev}${item.message}（${item.loc || '全书'}）`);
    }
    push('');
  }

  return out.join('\n');
}