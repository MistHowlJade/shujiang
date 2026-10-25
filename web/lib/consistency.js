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

  // 简单的时间顺序检查（基于章节号/顺序字段）
  // 如果有明确的时间字符串，可以做更细致的解析
  // 这里做简单的：如果同一章内有多个时间事件，检查是否有明显矛盾
  const byChapter = new Map();
  for (const e of events) {
    const key = e.chapter || e.volume + '·' + e.chapter;
    if (!byChapter.has(key)) byChapter.set(key, []);
    byChapter.get(key).push(e);
  }

  // 检查：同一章内出现 "早晨" 又出现 "深夜" 且没有过渡
  // 这里只是简单示例，实际可扩展 NLP 解析
  for (const [chap, evs] of byChapter) {
    if (evs.length < 2) continue;
    const times = evs.map(e => String(e.time || '').toLowerCase());
    const hasMorning = times.some(t => /早|上午|晨|黎明|破晓/.test(t));
    const hasNight = times.some(t => /晚|夜|午夜|子时|深更/.test(t));
    if (hasMorning && hasNight) {
      // 不直接报错，只是提示可能需要过渡
      issues.push({
        kind: 'timeline',
        type: 'time_jump',
        message: `章节「${chap}」内出现早/晚时间跨度大，建议检查是否缺少过渡描写`,
        loc: `第${evs[0]?.chapterNo || ''}章 ${chap}`,
        fingerprint: `consistency|timeline|time_jump|${chap}`,
        severity: 'hint',
      });
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
    }
  }

  return issues;
}

// 辅助函数：转义正则特殊字符
function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 辅助函数：模糊匹配技能/知识
function hasSimilar(set, target) {
  if (!target) return false;
  const targetLower = target.toLowerCase();
  for (const item of set) {
    const itemLower = item.toLowerCase();
    if (itemLower === targetLower) return true;
    if (itemLower.includes(targetLower) || targetLower.includes(itemLower)) return true;
    // 简单的编辑距离检查（前缀/后缀匹配）
    if (itemLower.startsWith(targetLower) || targetLower.startsWith(itemLower)) return true;
    if (itemLower.endsWith(targetLower) || targetLower.endsWith(itemLower)) return true;
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
  const first = (text.match(/我[的们]|我的|我[^的们]/g) || []).length;
  const third = (text.match(/(?:他|她|它|其)[的们]?/g) || []).length;
  // 简单启发式：第一人称词汇 > 第三人称 * 2 判定为第一人称
  if (first > third * 2) return 'first';
  if (third > first * 2) return 'third';
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
  // 口吻/语风（仅全书范围有意义）
  const voiceIssues = scope === 'book' ? checkVoiceConsistency(novel) : [];

  const allIssues = [...settingIssues, ...timelineIssues, ...charIssues, ...voiceIssues];
  allIssues.sort((a, b) => (a.chapterNo || 0) - (b.chapterNo || 0) || a.start - b.start);

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

  const kindLabels = { setting: '设定冲突', timeline: '时间线', character: '人物行为', voice: '口吻/语风' };

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