// 提示词库：所有任务的系统提示与指令模板集中在这里，方便你按自己的口味改。
// 每个任务返回 { messages, temperature, maxTokens, expect }，expect 为 'text' 或 'json'。

// 内建的「去 AI 味」负面清单，可在作品设定里用 antiAiNotes 覆盖/追加
const DEFAULT_ANTI_AI = `避免以下 AI 腔调：
- 滥用排比与对偶式长句、每段都以比喻收尾；
- "宛如/仿佛/不禁/不由自主/心中一凛/嘴角勾起一抹弧度/深邃的眼眸/眸光微闪/空气中弥漫着/与此同时/总而言之"这类套话；
- 用抽象总结句代替具体动作（如"他心中百感交集"）；
- 对话后面都缀一句解释性旁白；
- 无意义的景物堆砌和抒情。
要求：多用具体动作、细节、器物、口语化对白推进；长短句交错；少用形容词与副词；情绪通过行为和环境折射，不要直接告诉读者。`;

function antiAi(novel) {
  const extra = (novel?.meta?.antiAiNotes || '').trim();
  return extra ? `${DEFAULT_ANTI_AI}\n\n本书额外的文风禁忌：\n${extra}` : DEFAULT_ANTI_AI;
}

function styleBlock(novel) {
  const m = novel?.meta || {};
  const lines = [];
  if (m.pov) lines.push(`叙事视角：${m.pov}`);
  if (m.tense) lines.push(`时态：${m.tense}`);
  if (m.tone) lines.push(`整体基调：${m.tone}`);
  if (m.platform) lines.push(`目标平台：${m.platform}（请贴合该平台的读者口味与节奏）`);
  if (m.styleNotes) lines.push(`文风要求：${m.styleNotes}`);
  if (m.styleRefs?.length) {
    lines.push(`风格参考：${m.styleRefs.map((s) => `${s.name}${s.notes ? `（${s.notes}）` : ''}`).join('；')}（只学笔法节奏，不得复用其专有名词、人物、桥段）`);
  }
  return lines.join('\n');
}

function tabooBlock(novel) {
  const t = (novel?.meta?.taboos || '').trim();
  const e = (novel?.meta?.extraRules || '').trim();
  const parts = [];
  if (t) parts.push(`严禁出现的内容：${t}`);
  if (e) parts.push(`其他硬性要求：${e}`);
  return parts.join('\n');
}

function packBlock(pack) {
  if (!pack || !pack.length) return '';
  return pack.filter(Boolean).join('\n\n');
}

const BASE_SYSTEM = `你是一位经验丰富的中文小说作者，擅长长篇连载创作。你写作时严格遵守作者给出的世界观、人物设定与既定剧情，绝不擅自改动设定，也绝不重复已写过的事件。`;

function head(novel, pack) {
  return [
    `【作品】《${novel.title}》${novel.genre ? ` · ${novel.genre}` : ''}`,
    styleBlock(novel),
    tabooBlock(novel),
    pack ? `\n===== 作品资料（写作依据） =====\n${packBlock(pack)}\n===== 资料结束 =====` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function sys(...parts) {
  return { role: 'system', content: parts.filter(Boolean).join('\n\n') };
}
function user(content) {
  return { role: 'user', content };
}
function assistant(content) {
  return { role: 'assistant', content };
}

export const TASKS = {
  /* ---------- 大纲 ---------- */
  outline: {
    expect: 'text',
    temperature: 0.9,
    maxTokens: 4096,
    build({ novel, pack, payload }) {
      const ask = payload?.instruction || `请为《${novel.title}》设计分卷大纲与章节细纲。`;
      const volumes = novel.outline?.volumes || [];
      const existing = volumes.length
        ? `\n\n已有大纲（请在此基础上延续，不要重写已定稿部分）：\n${volumes
            .map((v) => `第${v.name}：${v.desc || ''}\n` + (v.chapters || []).map((c) => `  - ${c.title}：${c.summary || ''}`).join('\n'))
            .join('\n')}`
        : '';
      return {
        messages: [
          sys(BASE_SYSTEM, head(novel, pack)),
          user(
            `${ask}${existing}\n\n输出格式（严格照此 Markdown）：\n## 第X卷 卷名\n> 本卷定位与主要冲突（1-2 句）\n### 第1章 章节名\n- 场景：\n- 出场人物：\n- 核心事件：\n- 章末钩子：\n\n要求：剧情必须有推进和反转，避免流水账；每章都要有明确的目标、阻碍与钩子。`,
          ),
        ],
      };
    },
  },

  /* ---------- 人物卡 ---------- */
  characters: {
    expect: 'json',
    temperature: 0.9,
    maxTokens: 3000,
    build({ novel, pack, payload }) {
      return {
        messages: [
          sys(BASE_SYSTEM, head(novel, pack)),
          user(
            `${payload?.instruction || '根据已有大纲与世界观，设计本书的主要人物。'}\n\n只输出 JSON 数组，不要任何解释、不要 markdown 代码块。数组元素结构：\n{"name":"姓名","role":"主角/配角/反派","identity":"身份职业","age":"年龄","appearance":"外貌特征（1句）","personality":"性格（2-3个关键词+1句说明）","goal":"核心目标","flaw":"性格缺陷","secret":"隐藏秘密（可空）","speech":"说话风格（1句）","arc":"成长弧线（1句）","keywords":["可用1-3个关键词"]}`,
          ),
        ],
      };
    },
  },

  /* ---------- 世界观 ---------- */
  worldview: {
    expect: 'json',
    temperature: 0.9,
    maxTokens: 3000,
    build({ novel, pack, payload }) {
      return {
        messages: [
          sys(BASE_SYSTEM, head(novel, pack)),
          user(
            `${payload?.instruction || '根据本书题材与大纲，补全世界观设定条目。'}\n\n只输出 JSON 数组，不要解释、不要代码块。元素结构：\n{"category":"地理/势力/力量体系/规则/物品/风俗/历史","name":"名称","desc":"说明（2-3句，要有可用于写作的具体细节）","keywords":["检索关键词"]}`,
          ),
        ],
      };
    },
  },

  /* ---------- 写正文 ---------- */
  chapter: {
    expect: 'text',
    temperature: 0.88,
    maxTokens: 6000,
    build({ novel, chapter, pack, payload }) {
      const target = payload?.targetWords || novel.meta?.targetWordsPerChapter || 3000;
      const req = payload?.instruction || chapter?.outline?.summary || chapter?.summary || '按大纲推进本章剧情。';
      const tail = (payload?.prevTail || '').trim();
      return {
        messages: [
          sys(BASE_SYSTEM, antiAi(novel), head(novel, pack)),
          user(
            [
              `现在写《${novel.title}》第 ${chapter?.no || '?'} 章：${chapter?.title || payload?.chapterTitle || ''}`,
              `本章要求：${req}`,
              tail ? `\n上一章结尾原文（直接接着写，不要重述）：\n"""\n${tail}\n"""` : '',
              `\n写作要求：`,
              `1. 直接输出正文，不要任何解释、标题、序号或"以下是正文"之类的话；`,
              `2. 篇幅约 ${target} 字（可上下浮动 15%）；`,
              `3. 只写本章内容，不要抢下一章的剧情；`,
              `4. 严格遵守资料中的设定，不得凭空新增与设定冲突的能力、人物或地名；`,
              `5. 开头要接续前文，结尾留钩子。`,
            ]
              .filter(Boolean)
              .join('\n'),
          ),
        ],
      };
    },
  },

  /* ---------- 续写 ---------- */
  continue: {
    expect: 'text',
    temperature: 0.88,
    maxTokens: 4000,
    build({ novel, chapter, pack, payload }) {
      const target = payload?.targetWords || 800;
      const tail = (payload?.tail || '').trim().slice(-2000);
      const req = payload?.instruction || '顺着上文自然推进。';
      return {
        messages: [
          sys(BASE_SYSTEM, antiAi(novel), head(novel, pack)),
          user(
            `以下是《${novel.title}》第 ${chapter?.no || '?'} 章「${chapter?.title || ''}」已写好的部分：\n"""\n${tail}\n"""\n\n请直接接着往下写约 ${target} 字。要求：${req}\n直接输出续写内容，不要重复上文、不要任何说明文字。`,
          ),
        ],
      };
    },
  },

  /* ---------- 段落级操作 ---------- */
  polish: {
    expect: 'text',
    temperature: 0.7,
    maxTokens: 3000,
    build: textTask(
      (p) => p.instruction || '润色这段文字：保持原意与情节不变，去除 AI 腔，让语言更自然、更有画面感和节奏感。',
      (p) => `待处理文字：\n"""\n${p.text}\n"""\n\n只输出处理后的文字，不要任何解释。`,
    ),
  },
  expand: {
    expect: 'text',
    temperature: 0.85,
    maxTokens: 3000,
    build: textTask(
      (p) => p.instruction || '扩写这段文字：补充细节、动作、感官与心理描写，使篇幅明显增加，情节走向和人物言行不得改变。',
      (p) => `待扩写文字：\n"""\n${p.text}\n"""\n\n只输出扩写后的文字，不要任何解释。`,
    ),
  },
  shorten: {
    expect: 'text',
    temperature: 0.6,
    maxTokens: 3000,
    build: textTask(
      (p) => p.instruction || '精简这段文字：删去冗余修饰与重复表述，保留全部关键信息与情节，句子更干脆。',
      (p) => `待精简文字：\n"""\n${p.text}\n"""\n\n只输出精简后的文字，不要任何解释。`,
    ),
  },
  rewrite: {
    expect: 'text',
    temperature: 0.95,
    maxTokens: 3000,
    build: textTask(
      (p) => p.instruction || '改写这段文字：事件结果与人物立场保持不变，但换一种写法与语感。',
      (p) => `待改写文字：\n"""\n${p.text}\n"""\n\n只输出改写后的文字，不要任何解释。`,
    ),
  },
  custom: {
    expect: 'text',
    temperature: 0.8,
    maxTokens: 3000,
    build: textTask(
      (p) => p.instruction || '按作者要求处理这段文字。',
      (p) => `处理要求：${p.instruction}\n\n原文字：\n"""\n${p.text}\n"""\n\n只输出处理后的文字，不要任何解释。`,
    ),
  },

  /* ---------- 章节记忆 ---------- */
  memory: {
    expect: 'json',
    temperature: 0.3,
    maxTokens: 1500,
    build({ novel, chapter, pack }) {
      return {
        messages: [
          sys('你是小说编辑助手，负责把章节压缩成可供后续写作检索的记忆档案。只做客观提取，不做评价。'),
          user(
            `以下是《${novel.title}》第 ${chapter.no} 章「${chapter.title}」的正文：\n"""\n${(chapter.content || '').slice(0, 24000)}\n"""\n\n` +
              `请提取本章记忆，只输出 JSON 对象，不要解释、不要代码块。结构：\n` +
              `{"summary":"本章剧情概要（120字以内，写清谁做了什么、结果如何）","events":["按时间顺序的关键事件，每条20字以内"],"characters":["本章出场人物名"],"stateChanges":["人物/势力/物品的状态变化，如'张三左臂受伤'"],"foreshadowing":["本章埋下或呼应的伏笔"],"unresolved":["本章结束时悬而未决的问题"]}`,
          ),
        ],
      };
    },
  },

  /* ---------- 一致性检查 ---------- */
  consistency: {
    expect: 'json',
    temperature: 0.2,
    maxTokens: 4000,
    build({ novel, pack, payload }) {
      const scope = payload?.scopeText || '';
      return {
        messages: [
          sys(
            '你是一位极其严格的小说审校编辑，专门找出长篇连载中的自相矛盾。你只依据给出的设定与正文判断，不臆测，不客气。',
          ),
          user(
            `${head(novel, pack)}\n\n===== 待检查正文 =====\n${scope}\n===== 正文结束 =====\n\n` +
              `请检查上述正文与设定资料、以及正文内部是否存在矛盾。重点：人物设定/性格/能力前后冲突、时间线错乱、已死亡或已离场人物不合理的再次出场、道具与称谓前后不一致、与既有剧情重复、伏笔丢失或与旧章冲突。\n\n` +
              `只输出 JSON 数组，不要解释、不要代码块。若无问题输出 []。元素结构：\n` +
              `{"level":"严重/中等/轻微","type":"设定冲突/时间线/人物/道具/重复/伏笔","location":"问题所在章节或原文片段（引用不超过30字）","problem":"问题说明","suggestion":"修改建议"}`,
          ),
        ],
      };
    },
  },

  /* ---------- AI 责编 ---------- */
  review: {
    expect: 'text',
    temperature: 0.5,
    maxTokens: 3000,
    build({ novel, pack, payload }) {
      const scope = payload?.scopeText || '';
      const platform = novel.meta?.platform || payload?.platform || '头部网文平台';
      return {
        messages: [
          sys(
            `你是${platform}的资深责编，看惯了大神的稿子，对节奏、爽点密度、代入感与商业潜力非常敏感。你的点评要具体、可执行，直接指出问题段落，不讲空话好话。`,
          ),
          user(
            `${head(novel, pack)}\n\n===== 待评审正文 =====\n${scope}\n===== 正文结束 =====\n\n` +
              `请从编辑视角给出一份审稿意见，包含：\n1. 一句话结论（是否具备签约潜力）；\n2. 开篇/本段是否抓人（具体指出问题位置）；\n3. 节奏与爽点密度评估（指出拖沓或高潮不足处）；\n4. 人物与对话问题；\n5. 语言层面（AI 腔、重复用词、画面感）；\n6. 三条最优先的修改建议，按优先级排序。\n用 Markdown 小标题组织，控制在 800 字内。`,
          ),
        ],
      };
    },
  },

  /* ---------- 拆书 / 文风提取 ---------- */
  style: {
    expect: 'text',
    temperature: 0.4,
    maxTokens: 2000,
    build({ payload }) {
      return {
        messages: [
          sys('你是文本风格分析专家，能从样本中提炼出可以直接指导写作的技法规则。'),
          user(
            `以下是小说样本文本：\n"""\n${(payload?.text || '').slice(0, 12000)}\n"""\n\n` +
              `请提炼其文风，输出可直接写进 AI 写作提示词的文风档案（Markdown）：\n## 叙事视角与人称\n## 句式与节奏\n## 用词倾向（含高频标志性表达）\n## 描写手法（景物/动作/心理/对白比例与偏好）\n## 情绪与悬念处理\n## 可复用的写作规则（5-8 条祈使句）\n只做技法分析，不要评价好坏，不要引用超过 15 字的原文。`,
          ),
        ],
      };
    },
  },

  /* ---------- 起名 ---------- */
  titles: {
    expect: 'text',
    temperature: 1.0,
    maxTokens: 1200,
    build({ novel, pack, payload }) {
      return {
        messages: [
          sys(BASE_SYSTEM, head(novel, pack)),
          user(
            `${payload?.instruction || '给这本书想书名，并给最近三章起章节名。'}\n\n要求：给出 8 个书名候选（每个附一句理由，贴合平台调性与搜索习惯），再给出 3 组章节名候选（每组 3 章，标注章号）。直接输出 Markdown 列表，不要客套话。`,
          ),
        ],
      };
    },
  },
};

// 段落级任务的公共构造：把「选中文本」当作用户消息主体
function textTask(instructionFn, bodyFn) {
  return ({ novel, pack, payload }) => {
    const p = payload || {};
    return {
      messages: [
        sys(BASE_SYSTEM, antiAi(novel), head(novel, pack)),
        user(`${instructionFn(p)}\n\n${bodyFn(p)}`),
      ],
    };
  };
}

export function buildTask(taskName, ctx) {
  // 检查是否有自定义模板
  const custom = ctx?.customTemplates?.[ctx?.payload?.taskName || ''];
  // 如果没有直接传 taskName，尝试从 ctx 中获取
  const taskKey = ctx?.payload?.taskName || '';
  const customTpl = ctx?.customTemplates?.[taskKey];

  // 如果有自定义模板且包含 system 和 user，直接使用
  if (customTpl && customTpl.system && customTpl.user) {
    // 支持字符串模板和函数模板
    const renderSystem = typeof customTpl.system === 'function' ? customTpl.system(ctx) : customTpl.system;
    const renderUser = typeof customTpl.user === 'function' ? customTpl.user(ctx) : customTpl.user;
    return {
      messages: [
        { role: 'system', content: renderSystem },
        { role: 'user', content: renderUser }
      ],
      temperature: 0.85,
      maxTokens: 4096,
      expect: 'text',
    };
  }

  const task = TASKS[taskName];
  if (!task) throw new Error(`未知任务：${taskName}`);
  const built = task.build(ctx) || {};
  return {
    messages: built.messages,
    temperature: built.temperature ?? ctx?.novel?.meta?.temperature ?? 0.85,
    maxTokens: built.maxTokens ?? 4096,
    expect: built.expect || 'text',
  };
}

export { DEFAULT_ANTI_AI };
export const ASSISTANT_PREFIX_GUARD = '不要输出解释、前言、总结或 markdown 代码块包裹。';
