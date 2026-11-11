// 书匠 · 模型参考价（元 / 百万 token）
// 只是内置默认值——各家服务商的实际定价经常变，设置→用量与费用 里可以按需修改。
// 纯函数：没有 DOM、没有本地存储，浏览器和 Node（server）都能直接用。

/* 内置参考价：按模型名「包含」匹配（小写比较）。
   输入/输出单价越小越离不开真实价——这里给的是 2026 年公开价量级的保守值，
   对不上时在设置里改。 */
export const DEFAULT_MODEL_PRICES = {
  'deepseek-reasoner': { input: 4, output: 16 },
  'deepseek-r1': { input: 4, output: 16 },
  'deepseek-chat': { input: 2, output: 8 },
  'deepseek-v3': { input: 2, output: 8 },
  'deepseek-lite': { input: 0.5, output: 1 },
  'gpt-4o-mini': { input: 1.1, output: 4.4 },
  'gpt-4o': { input: 18, output: 72 },
  'gpt-4.1-mini': { input: 1.5, output: 6 },
  'gpt-4.1': { input: 14, output: 56 },
  'gpt-5-mini': { input: 2.5, output: 10 },
  'gpt-5': { input: 10, output: 50 },
  'o4-mini': { input: 8, output: 32 },
  'claude-haiku': { input: 1.5, output: 7.5 },
  'claude-sonnet': { input: 15, output: 75 },
  'qwen-turbo': { input: 0.5, output: 2 },
  'qwen-plus': { input: 4, output: 12 },
  'qwen-max': { input: 20, output: 60 },
  'qwen-coder': { input: 4, output: 12 },
  'glm-4-flash': { input: 0.1, output: 0.1 },
  'glm-4-plus': { input: 50, output: 50 },
  'moonshot': { input: 12, output: 12 },
  'kimi': { input: 12, output: 12 },
  'doubao-1.5-pro-256k': { input: 4, output: 16 },
  'doubao-1.5-pro': { input: 4, output: 16 },
  'doubao-1.5-lite': { input: 0.3, output: 0.6 },
  'doubao-seed': { input: 4, output: 12 },
  'doubao': { input: 2, output: 8 },
  'hunyuan': { input: 2, output: 8 },
  'ernie-speed': { input: 1, output: 2 },
  'siliconflow/qwen2.5-7b': { input: 0.5, output: 0.5 },
  'llama-3': { input: 2, output: 2 },
  'mock': { input: 0, output: 0 },
};

/** 单价解析：用户在设置里显式填的优先，其次内置子串匹配，最后 null（未知则费用显示「未估价」） */
export function resolveModelPrice(model, custom) {
  const name = String(model || '').trim().toLowerCase();
  if (!name) return null;
  const customMap = custom && typeof custom === 'object' ? custom : {};
  if (customMap[name] && Number.isFinite(Number(customMap[name].input)) && Number.isFinite(Number(customMap[name].output))) {
    return { input: Number(customMap[name].input), output: Number(customMap[name].output), source: 'custom' };
  }
  // 自定义项也按子串匹配（用户可以写「deepseek」覆盖整个家族）
  for (const key of Object.keys(customMap)) {
    const k = String(key).trim().toLowerCase();
    const v = customMap[key];
    if (k && name.includes(k) && Number.isFinite(Number(v?.input)) && Number.isFinite(Number(v?.output))) {
      return { input: Number(v.input), output: Number(v.output), source: 'custom' };
    }
  }
  for (const key of Object.keys(DEFAULT_MODEL_PRICES)) {
    if (name.includes(key)) return { ...DEFAULT_MODEL_PRICES[key], source: 'default' };
  }
  return null;
}

/** 按输入/输出 tokens 估算费用（元）。无单价返回 null。 */
export function estimateCost({ inputTokens = 0, outputTokens = 0, model = '', customPrices = null } = {}) {
  const price = resolveModelPrice(model, customPrices);
  if (!price) return null;
  const input = Number(inputTokens) || 0;
  const output = Number(outputTokens) || 0;
  return (input * price.input + output * price.output) / 1_000_000;
}

/* 中文网文场景的粗略换算：1 个汉字 ≈ 1.5 token（上下文打包后通常更低）。
   没用量的时候按字数估算，全部标注「估算」。 */
export function estimateTokensFromChars(chars) {
  const n = Number(chars) || 0;
  return Math.max(0, Math.round(n * 1.5));
}

/** 生成记录条目 → { tokensIn, tokensOut, cost, estimated }；没有 usage 的旧记录按输出字数估算 */
export function costOfLogEntry(entry, customPrices) {
  const model = String(entry?.model || '');
  const hasReal = Number.isFinite(Number(entry?.tkIn)) || Number.isFinite(Number(entry?.tkOut));
  if (hasReal) {
    const input = Number(entry.tkIn) || 0;
    const output = Number(entry.tkOut) || 0;
    return {
      tokensIn: input,
      tokensOut: output,
      cost: estimateCost({ inputTokens: input, outputTokens: output, model, customPrices }),
      estimated: !!entry.est,
    };
  }
  const estOut = estimateTokensFromChars(Number(entry?.outChars) || 0);
  return {
    tokensIn: 0,
    tokensOut: estOut,
    cost: estimateCost({ inputTokens: 0, outputTokens: estOut, model, customPrices }),
    estimated: true,
  };
}

/** 格式化费用：小数太少显得精确，太大显得没有——档位化 */
export function fmtCost(yuan) {
  const n = Number(yuan);
  if (!Number.isFinite(n)) return '未估价';
  if (n === 0) return '¥0';
  if (n < 0.01) return '≈ ¥0.01 以下';
  if (n < 1) return `¥${n.toFixed(2)}`;
  return `¥${n.toFixed(2)}`;
}
