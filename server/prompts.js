// 提示词库：所有任务的系统提示与指令模板集中在这里，方便你按自己的口味改。
// 每个任务返回 { messages, temperature, maxTokens, expect }，expect 为 'text' 或 'json'。

// 内建的「去 AI 味」负面清单＋语体要求，可在作品设定里用 antiAiNotes 覆盖/追加
// 主要面向中文网络连载的英文式/工具式腔：排比长句、排比对偶、总结句多、动作词模糊。
const DEFAULT_ANTI_AI = `请按「口语粗粝」的笔法写：像深夜手机敲出来的网络连载，随口白话，话都说半句也没关系，不追求文雅整齐，真正是给人读的、不是给模型打分看的。

写作要求：
- 多写具体动作、器物、细节，一句一句往下推，节奏时紧时松，句式长短交错；
- 对话就是对话：直白、口语、句子残缺、省略主语、带语气词和骂声，不写工整完整的书面对白；
- 情绪全靠身体反应和环境折射：手在抖、烟灰落袖口、茶凉了没喝——不要直接写「他心中百感交集」「他很害怕」「他很激动」；
- 形容词少用、破折号和引号少用，破折号别用来解释情绪，引号不要写引经据典的腔；
- 不要排比对偶，不要每段总分总，不要「首先/其次/最后/此外/总而言之/值得一提的是/总而言之」这类框架词，不要「仿佛/宛如/恰似/不由自主/心中一凛/眸光闪了闪/嘴角勾起一抹弧度/深邃/微微颤抖」这种腔词；
- 不要在结尾感叹升华，不要总结剧情，不要点名主题、立意、成长、蜕变、回眸；
- 对话之后不要接解释人物心理的旁白，动作和神态已经替它说话；
- 用「说/道/问/喊/嗤/哼/笑」代替「娓娓道来/微微一笑/不动声色道/淡淡道/轻声细语道」；
- 宁可句子别扭一点，也别端端正正——端正的句子像是机器敲出来的，不是人深夜写出来的。

口语粗粝的参考样本风格（只学节奏，别模仿其具体词句）：
「那人往前一步，帽檐遮得看不清脸，手上烟叼着。门卫抬眼看了他两秒，没问。烟灰掉在肩上，他也没弹。"谁找他？""传个话——别喝。"门卫点点头，没说话，替他开了侧门。"字呢？""没拿。"门卫怔了怔，这才让他进去了。」`;

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

// 已有大纲的续写提示：让模型在大纲上继续，而不是推倒重来
function outlineExisting(novel) {
  const volumes = novel?.outline?.volumes || [];
  if (!volumes.length) return '';
  return `\n\n已有大纲（请在此基础上延续，不要重写已定稿部分）：\n${volumes
    .map((v) => `第${v.name}：${v.desc || ''}\n` + (v.chapters || []).map((c) => `  - ${c.title}：${c.summary || ''}`).join('\n'))
    .join('\n')}`;
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
      const existing = outlineExisting(novel);
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

  /* ---------- 章节概要 ---------- */
  summarize: {
    expect: 'text',
    temperature: 0.4,
    maxTokens: 400,
    build({ novel, chapter }) {
      return {
        messages: [
          sys('你是小说编辑。只输出结果，不要任何解释。'),
          user(
            `用 120 字以内概括这一章的剧情（写清谁做了什么、结果如何）：\n"""\n${(chapter?.content || '').slice(0, 12000)}\n"""\n\n只输出概要正文本身，不要标题、不要解释。`,
          ),
        ],
      };
    },
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

/* ============================================================
 * 自定义模板引擎
 * ------------------------------------------------------------
 * 用户在「设置 → AI 提示词模板」里写的模板是纯文本，里面可以用
 * ${变量名} 引用当前上下文。这里负责把变量替换成实际值。
 *
 * 变量表由 buildTemplateVars 生成，是模板作者唯一需要知道的东西。
 * 未定义的变量一律替换成空字符串，不会把 ${...} 原样发给模型。
 * ============================================================ */

// 模板里可用的变量说明（设置界面同步展示这份清单）
export const TEMPLATE_VARS = [
  { key: 'novel.title', desc: '书名' },
  { key: 'novel.genre', desc: '题材' },
  { key: 'chapter.no', desc: '章节序号' },
  { key: 'chapter.title', desc: '章节标题' },
  { key: 'req', desc: '本章要求 / 指令' },
  { key: 'target', desc: '目标字数' },
  { key: 'tail', desc: '上一章结尾或本章已写部分' },
  { key: 'text', desc: '选中的原文' },
  { key: 'content', desc: '本章正文' },
  { key: 'scope', desc: '待检查的正文范围' },
  { key: 'head', desc: '作品资料包（设定 + 大纲 + 记忆）' },
  { key: 'instruction', desc: '作者给的指令' },
  { key: 'existing', desc: '已有大纲摘要' },
  { key: 'pov', desc: '场景视角' },
  { key: 'location', desc: '场景地点' },
  { key: 'time', desc: '场景时间' },
  { key: 'characters', desc: '场景出场人物' },
  { key: 'summary', desc: '场景梗概' },
  { key: 'hook', desc: '场景钩子' },
  { key: 'tone', desc: '整体基调' },
];

// 从上下文收集模板变量
function buildTemplateVars(ctx) {
  const novel = ctx?.novel || {};
  const chapter = ctx?.chapter || null;
  const payload = ctx?.payload || {};
  const pack = ctx?.pack || [];
  const scopeText = payload.scopeText || '';
  const tail = payload.tail || ctx?.prevTail || '';
  // 场景类任务的字段：客户端把当前场景塞进 payload.scene
  const scene = payload.scene || {};
  return {
    'novel.title': novel.title || '',
    'novel.genre': novel.genre || '',
    'chapter.no': chapter?.no ?? '',
    'chapter.title': chapter?.title || payload.chapterTitle || '',
    req: payload.instruction || '',
    target: payload.targetWords || novel.meta?.targetWordsPerChapter || 3000,
    tail,
    text: payload.text || '',
    content: chapter?.content || '',
    scope: scopeText,
    head: novel.id ? head(novel, pack) : '',
    instruction: payload.instruction || '',
    existing: outlineExisting(novel),
    pov: scene.pov || '',
    location: scene.location || '',
    time: scene.time || '',
    characters: scene.characters || '',
    summary: scene.summary || '',
    hook: scene.hook || '',
    tone: scene.tone || novel.meta?.tone || '',
  };
}

// 替换 ${变量名}。未定义的变量换成空串，避免把占位符原样发给模型。
// 变量名允许中文：用户随手写成 ${书名} 也不该原样发给模型。
function renderTemplate(text, vars) {
  if (typeof text !== 'string' || !text) return '';
  return text.replace(/\$\{([a-zA-Z0-9_.\u4e00-\u9fa5]+)\}/g, (m, name) => {
    const v = vars[name];
    return v === undefined || v === null ? '' : String(v);
  });
}

/**
 * 可自定义提示词的任务清单：设置界面的下拉框直接读这份。
 * task      —— 发给服务端的真实任务名
 * templateKey —— 模板在 config.promptTemplates 里的键。同一任务被多处复用时用它区分
 *               （例如 outline 既用于「生成大纲」也用于「从一句话生成全书大纲」）。
 * vars      —— 这个任务可用的变量名，写在提示词里用 ${变量名} 引用。
 */
export const TEMPLATE_SLOTS = [
  { key: 'chapter', task: 'chapter', label: '写正文', vars: ['novel.title', 'chapter.no', 'chapter.title', 'req', 'target', 'tail', 'head'] },
  { key: 'continue', task: 'continue', label: '续写', vars: ['novel.title', 'chapter.no', 'chapter.title', 'req', 'target', 'tail'] },
  { key: 'polish', task: 'polish', label: '润色', vars: ['text', 'instruction'] },
  { key: 'expand', task: 'expand', label: '扩写', vars: ['text', 'instruction'] },
  { key: 'shorten', task: 'shorten', label: '精简', vars: ['text', 'instruction'] },
  { key: 'rewrite', task: 'rewrite', label: '改写', vars: ['text', 'instruction'] },
  { key: 'custom', task: 'custom', label: '按指令处理', vars: ['text', 'instruction'] },
  { key: 'outline', task: 'outline', label: '生成大纲', vars: ['novel.title', 'req', 'existing', 'head'] },
  { key: 'outline:aiFullOutline', task: 'outline', label: '从一句话生成全书大纲', vars: ['novel.title', 'req', 'existing', 'head'] },
  { key: 'characters', task: 'characters', label: '生成人物', vars: ['req', 'head'] },
  { key: 'worldview', task: 'worldview', label: '生成世界观', vars: ['req', 'head'] },
  { key: 'consistency', task: 'consistency', label: '一致性检查', vars: ['head', 'scope'] },
  { key: 'review', task: 'review', label: '责编评审', vars: ['head', 'scope', 'novel.genre'] },
  { key: 'summarize', task: 'summarize', label: '生成概要', vars: ['novel.title', 'chapter.no', 'chapter.title', 'content'] },
  { key: 'titles', task: 'titles', label: '起名', vars: ['novel.title', 'req'] },
  { key: 'memory', task: 'memory', label: '存章节记忆', vars: ['novel.title', 'chapter.no', 'chapter.title', 'content'] },
  { key: 'batchMemory', task: 'memory', label: '批量补记忆', vars: ['novel.title', 'chapter.no', 'chapter.title', 'content'] },
  { key: 'analyzeStyle', task: 'style', label: '提取文风', vars: ['text'] },
  { key: 'generateSceneProse', task: 'chapter', label: '生成场景正文', vars: ['pov', 'location', 'time', 'characters', 'summary', 'hook', 'target', 'tone', 'req'] },
];

export function buildTask(taskName, ctx) {
  const task = TASKS[taskName];
  if (!task) throw new Error(`未知任务：${taskName}`);

  // 自定义模板优先：键就是任务名（chapter / continue / polish …）。
  // 同一任务可能对应多个用途（outline 与 outline:aiFullOutline），所以也认 payload.templateKey。
  const templates = ctx?.customTemplates || {};
  const key = ctx?.payload?.templateKey || taskName;
  const custom = templates[key] || templates[taskName];

  if (custom && (custom.system || custom.user)) {
    const vars = buildTemplateVars(ctx);
    const render = (tpl) => (typeof tpl === 'function' ? tpl(ctx) : renderTemplate(tpl, vars));
    const system = custom.system ? render(custom.system) : '';
    const user = custom.user ? render(custom.user) : '';
    // 模板替换后是空的（比如只写了 ${某个不存在的变量}），就退回内置提示词：
    // 给模型发一条空提示词比用内置的更糟。
    if (user) {
      return {
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
        // 用任务本身的温度与长度上限，只在模板显式指定时覆盖
        temperature: custom.temperature ?? task.temperature ?? 0.85,
        maxTokens: custom.maxTokens ?? task.maxTokens ?? 4096,
        expect: custom.expect || task.expect || 'text',
      };
    }
  }

  const built = task.build(ctx) || {};
  return {
    messages: built.messages,
    temperature: built.temperature ?? task.temperature ?? 0.85,
    maxTokens: built.maxTokens ?? task.maxTokens ?? 4096,
    expect: built.expect || task.expect || 'text',
  };
}

