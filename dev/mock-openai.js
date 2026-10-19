// 书匠 · 假模型调试服务
// ---------------------------------------------------------------------------
// 一个假的 OpenAI 兼容接口。用来在完全离线、不花钱的情况下跑通整条链路：
//   设置模型 → 生成本章 → 追加到正文 → 续写 → 润色/改写 → 一致性检查 → 记忆存档
//
// 启动：
//   tools\node\node.exe dev\mock-openai.js
//   默认监听 http://127.0.0.1:8890
//
// 在书匠「设置 → 模型服务」里这样填：
//   Base URL : http://127.0.0.1:8890/v1
//   API Key  : 随便填几个字符（不能为空）
//   已知模型 : mock-writer, mock-reasoner, mock-error
//
// 两个彩蛋，用来验证错误提示与思考过程：
//   模型名带 reasoner → 先流式吐思考过程，再吐正文（测「思考中」折叠区）
//   模型名带 error    → 上游直接返回 401（测错误提示是否人话）
//
// 可用环境变量：MOCK_PORT / MOCK_DELAY（每片间隔毫秒）/ MOCK_CHUNK（每片字数）
// ===========================================================================

import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8890);
const HOST = '127.0.0.1';
const DELAY = Number(process.env.MOCK_DELAY ?? 24);
const CHUNK = Number(process.env.MOCK_CHUNK || 14);

/* ---------------------------------------------------------------- 素材 */

const CHAPTER = `夜色压下来的时候，青石巷里只剩他一个人的脚步声。

谢迟把包袱往肩上提了提，指腹蹭到那块硬物——剑鞘。三年来他第一次把它从柴房里取出来，木头被虫蛀出细孔，摸上去像老人手背上的纹路。

巷口挂着两盏灯，一盏亮着，一盏灭了。亮的那盏底下站着个人，背对着他，穿一件洗得发白的青衫，腰间别着酒葫芦。

"你走错了。"那人没回头，"这条路往前是死路。"

谢迟停下脚步。他能闻见对方身上的酒气，混着很淡的铁锈味。

"我知道。"他说，"我要找的人就住在死路里。"

青衫人这才转过身。月光落在他脸上，从颧骨那道疤一直斜到下颌，像是被人用刀把半边脸劈开又草草缝上。

他盯着谢迟看了很久，忽然笑了："你背上那把剑，出得了鞘吗？"

巷子里的风停了。谢迟没有回答，他只是把手按在剑柄上，那里缠着早已发黑的布条，一层压着一层，缠了整整十七圈。

第十七圈是他师傅亲手系的。

"出不了。"谢迟听见自己的声音很稳，"但够用了。"

青衫人脸上的笑慢慢收了回去。他侧身让开半个身位，抬手往巷子深处指了指，袖口滑落，露出一截细白的手腕，上面锁着一圈铜环——那是内门弟子的标记。

"进去吧。"他说，"长老等你很久了。"`;

const CONTINUE = `谢迟迈过门槛时，听见身后传来门轴转动的声音。

青衫人把门关上了，动作很轻，像是怕惊动什么。

院子比他想的要小。正中一口枯井，井沿上坐着个女人，正在借着月光补一件衣裳。针脚很密，一下一下，扎得极慢。她没有抬头，却开口说了话："你师傅临走前，也是坐在这个位置。"

谢迟的手指顿了一下。

"他留了句话给你。"女人咬断线头，把衣裳抖开，"他说，等你哪天想通了为什么剑拔不出来，就回来把这个院子烧了。"`;

const ISSUES = [
  {
    level: '严重',
    type: '设定冲突',
    location: '剑鞘缠着整整十七圈',
    problem: '第四章写过剑鞘是"用麻绳草草捆了三道"，本章却写成"缠了整整十七圈"，且第十七圈是师傅亲手所系，与前文矛盾。',
    suggestion: '把本章改为"缠了整整十七圈，最外面那道是师傅亲手系的"之前，先统一第四章的描写，或改写第四章为十七圈。',
  },
  {
    level: '中等',
    type: '时间线',
    location: '三年来他第一次把它从柴房里取出来',
    problem: '第二章交代谢迟离开师门才一年半，此处"三年"与时间线不符。',
    suggestion: '"三年"改为"一年半"，或在第二章补一段交代时间跳跃。',
  },
  {
    level: '轻微',
    type: '重复',
    location: '剑鞘纹丝不动',
    problem: '上一章结尾已用过"纹丝不动"这一表述，重复使用会削弱印象。',
    suggestion: '换一种写法，例如"剑柄被掌心焐得发潮，鞘口却一丝缝隙也没开"。',
  },
];

const MEMORY = {
  summary: '谢迟夜里携剑前往青石巷，遇到脸上带疤的青衫人拦路试探。对方认出他背上的剑鞘，谢迟以"出不了但够用"回应，青衫人放行并称长老已等候多时，谢迟随即入院，见到井边补衣的女人。',
  events: [
    '谢迟夜里从柴房取出旧剑，走向青石巷',
    '巷口遇青衫人拦路，被问剑能否出鞘',
    '谢迟答"出不了，但够用"，对方放行',
    '谢迟入院，见女子在枯井边补衣',
    '女子转述师傅留下的口信',
  ],
  characters: ['谢迟', '青衫人', '井边女子'],
  stateChanges: ['谢迟首次携剑外出', '确认青衫人是内门弟子', '得知师傅留有口信'],
  foreshadowing: ['剑为何拔不出来', '师傅留下的口信', '被虫蛀的剑鞘'],
  unresolved: ['长老是谁，为何等候谢迟', '青衫人的身份与立场'],
};

const CHARACTERS = [
  {
    name: '谢迟',
    role: '主角',
    identity: '破落门派的外门弟子',
    age: '十九',
    appearance: '清瘦，右手虎口有旧茧，常年穿一件洗得发白的灰布衣。',
    personality: '沉默、执拗、认死理；嘴上不饶人，心里却记着每一个对他好过的人。',
    goal: '查明师傅之死的真相，并弄明白背上这把剑为何拔不出鞘。',
    flaw: '把承诺看得比命重，容易被人拿捏。',
    secret: '他其实已经拔出来过一次，只是那晚的事他不敢想。',
    speech: '短句为主，不爱解释，被逼急了才说重话。',
    arc: '从只想报仇，到愿意为一个与自己无关的人停下来。',
    keywords: ['剑鞘', '师傅', '外门'],
  },
  {
    name: '青衫人',
    role: '配角',
    identity: '内门弟子，长老的传话人',
    age: '三十上下',
    appearance: '左脸从颧骨到下颌有一道疤，腰间常年挂一只酒葫芦。',
    personality: '玩世不恭，习惯用玩笑遮住真实立场，关键时刻极稳。',
    goal: '替长老筛选值得带进门的人。',
    flaw: '酗酒，酒后口无遮拦。',
    secret: '脸上的疤是替长老挡刀留下的，他从不提。',
    speech: '爱用反问句，句尾常带"吧""呢"。',
    arc: '从旁观者变成谢迟在门内唯一的退路。',
    keywords: ['刀疤', '酒葫芦', '内门'],
  },
];

const WORLDVIEW = [
  { category: '地理', name: '青石巷', desc: '城南一条只有七户人家的死巷，巷口两盏灯常年一明一灭。巷底是一处不挂匾的院子，外人只当是废宅。', keywords: ['青石巷', '死巷', '两盏灯'] },
  { category: '势力', name: '无鞘门', desc: '山门不大，却以剑法闻名。内门弟子手腕锁铜环，外门只有一块木牌。门规第一条：剑不出鞘者，不得入内门。', keywords: ['无鞘门', '铜环', '门规'] },
  { category: '规则', name: '出鞘之约', desc: '门中弟子若剑出鞘超过三息而不能收回，需自断一指。因此门人多以鞘法取胜，宁可挨打也不拔剑。', keywords: ['出鞘', '三息', '三指'] },
];

const OUTLINE = `## 第一卷 巷中人
> 谢迟带着一把拔不出鞘的剑回到无鞘门，卷末被卷入内门之争。

### 第1章 死路
- 场景：青石巷巷口，夜晚
- 出场人物：谢迟、青衫人
- 核心事件：谢迟被拦路试探，以"出不了，但够用"过关
- 章末钩子：青衫人指出长老已等候多时

### 第2章 井边
- 场景：无鞘门废院，深夜
- 出场人物：谢迟、井边女子
- 核心事件：女子转述师傅遗言，要谢迟烧掉院子
- 章末钩子：谢迟发现井里没有水，只有回声

### 第3章 铜环
- 场景：内门演武场，清晨
- 出场人物：谢迟、内门弟子上官棠
- 核心事件：入门试炼，谢迟全程不拔剑连胜三场
- 章末钩子：长老在观礼台上叫出了他师傅的名字

## 第二卷 鞘法
> 谢迟被迫参加门内大比，在胜负与真相之间做选择。

### 第1章 十七圈
- 场景：藏剑阁
- 出场人物：谢迟、青衫人
- 核心事件：拆开剑鞘外层，发现师傅夹带的密信
- 章末钩子：密信上只有半句话`;

const REVIEW = `### 一句话结论
具备签约潜力，但开篇前 300 字还没把"钩子"递到读者手里。

### 开篇是否抓人
"夜色压下来的时候，青石巷里只剩他一个人的脚步声"这句合格，但紧接着用两段写包袱和剑鞘的触感，节奏偏慢。建议把"剑出不了鞘"这个核心悬念提到第 2 段之前。

### 节奏与爽点密度
本章属铺垫章，全章只有一次小的言语交锋（"出不了，但够用"）。这个点很好，但位置太靠后。可以考虑把青衫人的试探提前，让交锋在 500 字内发生。

### 人物与对话
青衫人台词有味道，"你背上那把剑，出得了鞘吗"是本章最好的一句。谢迟的回应可以再短，去掉"谢迟听见自己的声音很稳"这类旁白，让对白自己立住。

### 语言层面
AI 腔不明显。问题是比喻略密——"像老人手背上的纹路""像是被人用刀把半边脸劈开又草草缝上"连着出现，建议删掉一个。

### 三条优先修改建议
1. 把"剑拔不出鞘"的设定在开篇 200 字内点明；
2. 删掉解释性旁白，尤其"他听见自己的声音很稳"；
3. 枯井那处留白不错，但需要给读者一个更具体的疑问句收尾。`;

const STYLE = `## 叙事视角与人称
第三人称限知，全程贴着主角的感官走，很少跳视角。

## 句式与节奏
短句为主，平均每句 12-18 字。动作段落用连续短句推进，情绪段落用一长句收束。很少使用排比。

## 用词倾向（含高频标志性表达）
偏好器物与身体细节：指腹、虎口、针脚、袖口。极少使用形容词堆叠，动词承担主要描写任务。标志性表达："像……"—每千字约 3 次。

## 描写手法
动作 5 : 对白 3 : 环境 2，几乎不做心理直述，情绪通过停顿与动作折射（"她咬断线头""他停下脚步"）。

## 情绪与悬念处理
悬念靠信息差而非解释：人物知道但不说，读者靠细节猜。每章结尾用一个具体物件收口（剑鞘、针线、铜环）。

## 可复用的写作规则
1. 每句话尽量落在一个具体动作或器物上。
2. 情绪不要直说，用停顿、呼吸、手部动作替代。
3. 对白后不加解释性旁白，让对话自己完成叙事。
4. 环境描写每次不超过两句，且必须参与情节。
5. 章末留一个具体的、可视的物件或疑问。
6. 避免"仿佛/宛如/不禁"这类套话。`;

const SUMMARY = '谢迟夜里携剑前往青石巷，被脸上带疤的青衫人拦路试探。对方以「剑出得了鞘吗」相问，谢迟答「出不了，但够用」，得以放行。他进入巷底小院，见一女子在枯井边补衣，女子转述了师傅留下的口信，要他想通之后回来烧掉这个院子。';

const TITLES = `### 书名候选
1. **《剑不出鞘》** —— 直接把核心悬念做成书名，搜索辨识度高。
2. **《十七圈》** —— 有神秘感，适合悬疑向读者。
3. **《死路》** —— 短促有力，适合短视频平台推流。
4. **《无鞘门》** —— 门派感强，便于做系列。
5. **《我师傅留下半个字》** —— 网文口语化标题，点击率通常更高。

### 章节名候选
- 第 1 组：死路 / 井边 / 铜环
- 第 2 组：十七圈 / 三息 / 断指之约
- 第 3 组：剑不出鞘 / 长老的名字 / 半句话`;

/* ---------------------------------------------------------------- 逻辑 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const split = (s, n = CHUNK) => {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
};

// 用来模拟真实世界里「OpenAI 兼容」的各种偏差：模型名里带关键词即可切换
const VARIANTS = ['normal', 'json', 'array', 'reason', 'crlf', 'split', 'keepalive', 'text', 'empty', 'html', 'page', 'quota', 'stall', 'dead'];
function variantOf(model) {
  const m = String(model || '').toLowerCase();
  for (const v of VARIANTS) {
    if (v !== 'normal' && m.includes(`mock-${v}`)) return v;
  }
  return 'normal';
}

function conversation(req) {
  return (req.messages || []).map((m) => m.content || '').join('\n');
}

/** 从最后一对 """ 里把原文抠出来（章节/上下文也可能用 """ 包裹，所以要取最后一个） */
function quoted(text) {
  const all = [...text.matchAll(/"""\n([\s\S]*?)\n"""/g)];
  return all.length ? all[all.length - 1][1] : '';
}

function decide(text) {
  const has = (s) => text.includes(s);
  if (has('"stateChanges"') || has('记忆档案')) return 'memory';
  if (has('自相矛盾') || has('"level"')) return 'consistency';
  if (has('"appearance"')) return 'characters';
  if (has('"category"')) return 'worldview';
  if (has('分卷大纲')) return 'outline';
  if (has('审稿意见')) return 'review';
  if (has('文风档案')) return 'style';
  if (has('8 个书名')) return 'titles';
  if (has('概括这一章')) return 'summary';
  // 润色/扩写/精简/改写/自定义：五种任务的提示词都以「只输出…后的文字，不要任何解释」收尾
  if (/只输出(处理|扩写|精简|改写)后的文字/.test(text)) return 'paragraph';
  if (has('请直接接着往下写')) return 'continue';
  return 'chapter';
}

function buildReply(text) {
  const kind = decide(text);
  switch (kind) {
    case 'memory':
      return { kind, content: JSON.stringify(MEMORY) };
    case 'consistency':
      return { kind, content: JSON.stringify(ISSUES) };
    case 'characters':
      return { kind, content: JSON.stringify(CHARACTERS) };
    case 'worldview':
      return { kind, content: JSON.stringify(WORLDVIEW) };
    case 'outline':
      return { kind, content: OUTLINE };
    case 'review':
      return { kind, content: REVIEW };
    case 'style':
      return { kind, content: STYLE };
    case 'titles':
      return { kind, content: TITLES };
    case 'summary':
      return { kind, content: SUMMARY };
    case 'paragraph': {
      const src = quoted(text).trim();
      const body = src || '（没有拿到原文）';
      return { kind, content: `${body.replace(/。/g, '。').replace(/，/g, '，')}\n\n他停了一下，指腹在剑柄上摩挲了一圈，那里缠着的布条硌得掌心生疼。` };
    }
    case 'continue':
      return { kind, content: CONTINUE };
    default:
      return { kind, content: CHAPTER };
  }
}

/* ---------------------------------------------------------------- HTTP */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

  // 模型列表
  if (url.pathname.endsWith('/models')) {
    const body = JSON.stringify({
      object: 'list',
      data: [
        { id: 'mock-writer' }, { id: 'mock-reasoner' }, { id: 'mock-error' },
        ...VARIANTS.filter((v) => v !== 'normal').map((v) => ({ id: `mock-${v}` })),
      ],
    });
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(body);
  }

  if (!url.pathname.endsWith('/chat/completions')) {
    res.writeHead(404, { ...cors, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: `未知路径 ${url.pathname}` } }));
  }

  let raw = '';
  for await (const c of req) raw += c;
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch { /* ignore */ }

  const model = payload.model || 'mock-writer';

  // 彩蛋一：模型名带 error → 上游报错，用来验证错误提示
  if (/error/i.test(model)) {
    res.writeHead(401, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      error: { message: 'Invalid API key provided: sk-mock***error. 请检查密钥是否正确。', type: 'invalid_request_error' },
    }));
  }

  const conv = conversation(payload);
  const { content } = buildReply(conv);
  const kind = variantOf(model);
  const reasoning = /reasoner|reason/i.test(model) && kind !== 'reason'
    ? '用户在写网文，需要一段有悬念的开场。\n先确定视角：第三人称限知，贴主角。\n开头用一个动作切入，别写景。\n钩子放在对白里——"剑出得了鞘吗"。\n'
    : '';
  const thinkText = kind === 'reason'
    ? '用户在写网文，需要一段有悬念的开场。\n先确定视角：第三人称限知，贴主角。\n钩子放在对白里。\n'
    : '';

  // 变体：网关返回 HTML 错误页（不是 JSON，也不是 SSE）
  if (kind === 'html') {
    res.writeHead(502, { ...cors, 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx/1.24.0</center></body></html>');
  }

  // 变体：网关很「礼貌」地回了 200，但内容是网页 —— 最难发现的一种坑
  if (kind === 'page') {
    res.writeHead(200, { ...cors, 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<!DOCTYPE html><html><head><title>网站正在维护中</title></head><body><h1>503</h1><p>服务暂时不可用，请稍后再试。</p></body></html>');
  }

  // 变体：200 + JSON 错误体（额度用尽之类）
  if (kind === 'quota') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: { message: '您当前的账户额度已用尽，请充值后再试。', type: 'insufficient_quota' } }));
  }

  // 变体：连响应头都不发，纯粹的连接黑洞（用 SHU_UPSTREAM_IDLE 缩短超时来验证兜底）
  if (kind === 'dead') {
    res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream; charset=utf-8' });
    return; // 不 flush、不写、不结束
  }

  // 变体：响应头正常发回，但之后一直不吐数据
  if (kind === 'stall') {
    res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.flushHeaders();
    return;
  }

  // 变体：无视 stream:true，直接回一个完整 JSON
  if (payload.stream === false || kind === 'json') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      id: 'chatcmpl-mock', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: 'assistant', content, reasoning_content: reasoning || undefined }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1200, completion_tokens: content.length, total_tokens: 1200 + content.length },
    }));
  }

  res.writeHead(200, {
    ...cors,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model };

  // 按变体决定每一帧怎么发
  const nl = kind === 'crlf' ? '\r\n' : '\n';
  const frameStr = (delta, finish) => `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] })}${nl}${nl}`;
  const rawStr = (text) => `data: ${text}${nl}${nl}`;
  const asDelta = (field, text) => {
    if (kind === 'array') return { [field]: [{ type: 'text', text }] };
    if (kind === 'reason' && field === 'reasoning_content') return { reasoning: text };
    return { [field]: text };
  };
  // split：把整帧切成 3 个字符一段发出去，逼出「事件被 TCP 包切开」的情况
  const send = async (str) => {
    if (kind === 'split') {
      for (const c of split(str, 3)) { res.write(c); await sleep(3); }
      return;
    }
    res.write(str);
  };

  try {
    if (kind === 'keepalive') { res.write(': ping\n\n'); await sleep(DELAY); res.write('event: chunk\n'); }
    if (kind === 'empty') {
      await send(rawStr(JSON.stringify({ ...base, choices: [] })));  // 只有 usage / 空 choices
      await sleep(DELAY);
      res.write(`data: [DONE]${nl}${nl}`);
      return res.end();
    }
    const thinkAll = reasoning || thinkText;
    if (thinkAll) {
      for (const p of split(thinkAll)) {
        await send(kind === 'text' ? rawStr(p) : frameStr(asDelta('reasoning_content', p)));
        await sleep(DELAY);
      }
    }
    for (const p of split(content)) {
      await send(kind === 'text' ? rawStr(p) : frameStr(asDelta('content', p)));
      await sleep(DELAY);
    }
    if (kind !== 'empty') await send(frameStr({}, 'stop'));
    res.write(`data: [DONE]${nl}${nl}`);
  } catch { /* 客户端断开 */ }
  res.end();
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  假模型服务已启动（仅供离线调试，不会真的调用任何模型）');
  console.log(`  地址： http://${HOST}:${PORT}/v1`);
  console.log('  可用模型： mock-writer / mock-reasoner（带思考过程）/ mock-error（模拟报错）');
  console.log('  兼容性模拟（模型名里带关键词即可切换）：');
  console.log('    mock-json       无视 stream:true，直接回完整 JSON');
  console.log('    mock-array      delta.content 是 [{type,text}] 数组');
  console.log('    mock-reason     思考过程字段叫 reasoning 而不是 reasoning_content');
  console.log('    mock-crlf       SSE 用 CRLF 换行');
  console.log('    mock-split      每帧切成 3 字符发，模拟 TCP 分包');
  console.log('    mock-keepalive  事件前先发 : ping 注释与 event: 行');
  console.log('    mock-text       data: 后面是纯文本，不是 JSON');
  console.log('    mock-empty      只回空 choices，无正文');
  console.log('    mock-html       网关返回 HTTP 502 + HTML');
  console.log('    mock-page       网关返回 HTTP 200 + 网页正文');
  console.log('    mock-quota      HTTP 200 + JSON 错误体（如额度用尽）');
  console.log('    mock-stall      响应头正常，但一直不吐数据（测空闲超时）');
  console.log('    mock-dead       连响应头都不发（测连接超时）');
  console.log(`  速度： 每 ${DELAY}ms 吐 ${CHUNK} 字（调 MOCK_DELAY / MOCK_CHUNK 可改）`);
  console.log('');
});
