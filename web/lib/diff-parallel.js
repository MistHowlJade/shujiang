// 书匠 · Diff 并行 Worker 管理器
// 自动启动多个 Worker，将大文本按句子分片并行计算 LCS，再合并结果

const PARALLEL_THRESHOLD = 50000;  // 字符数超过此值启用并行
const MAX_WORKERS = navigator.hardwareConcurrency || 4;

let workers = [];
let nextWorkerId = 0;
let pendingTasks = new Map();
let taskId = 0;

/** 初始化 Worker 池 */
function initWorkerPool(count = MAX_WORKERS) {
  if (workers.length > 0) return;
  
  for (let i = 0; i < count; i++) {
    const worker = new Worker(new URL('./diff.worker.js', import.meta.url), { type: 'module' });
    worker.id = i;
    worker.busy = false;
    worker.onmessage = handleWorkerMessage;
    worker.onerror = (err) => {
      console.error(`[DiffWorker ${i}] Error:`, err);
      worker.busy = false;
    };
    workers.push(worker);
  }
}

/** 处理 Worker 返回消息 */
function handleWorkerMessage(e) {
  const { id, result, error } = e.data;
  const task = pendingTasks.get(id);
  if (task) {
    pendingTasks.delete(id);
    if (error) task.reject(new Error(error));
    else task.resolve(result);
  }
}

/** 将句子数组按大小均匀分片 */
function splitSentencesIntoChunks(sentences, chunkCount) {
  if (sentences.length <= chunkCount) return sentences.map(s => [s]);
  
  const chunkSize = Math.ceil(sentences.length / chunkCount);
  const chunks = [];
  for (let i = 0; i < sentences.length; i += chunkSize) {
    chunks.push(sentences.slice(i, i + chunkSize));
  }
  return chunks;
}

/** 合并多个 Worker 的 LCS 结果 */
function mergeLcsResults(results) {
  if (results.length === 1) return results[0];
  
  const merged = [];
  let currentType = null;
  let currentText = '';
  
  for (const result of results) {
    for (const op of result) {
      if (merged.length > 0 && merged[merged.length - 1].type === op.type) {
        merged[merged.length - 1].text += op.text;
      } else {
        merged.push({ ...op });
      }
    }
  }
  
  return merged;
}

/** 并行计算 LCS */
export async function parallelLcsOps(a, b, workerCount = MAX_WORKERS) {
  const sentencesA = splitSentences(a);
  const sentencesB = splitSentences(b);
  
  // 如果文本不大，直接单线程
  if (a.length + b.length < PARALLEL_THRESHOLD) {
    return lcsOps(splitSentences(a), splitSentences(b));
  }
  
  // 确保 Worker 池已初始化
  initWorkerPool(workerCount);
  
  // 分片策略：按句子数均匀分片
  const chunksA = splitSentencesIntoChunks(sentencesA, workerCount);
  const chunksB = splitSentencesIntoChunks(sentencesB, workerCount);
  
  // 为每个分片创建任务
  const tasks = chunksA.map((chunkA, i) => ({
    id: ++taskId,
    type: 'lcsOps',
    payload: {
      a: chunkA,
      b: chunksB[i] || []
    }
  }));
  
  // 提交所有任务到 Worker 池
  const promises = tasks.map(task => runInWorker(task));
  
  try {
    const results = await Promise.all(promises);
    return mergeLcsResults(results);
  } catch (err) {
    console.warn('[ParallelDiff] Parallel computation failed, falling back to single thread:', err);
    return lcsOps(splitSentences(a), splitSentences(b));
  }
}

/** 在 Worker 池中运行任务 */
function runInWorker(task) {
  return new Promise((resolve, reject) => {
    // 找到空闲 Worker
    const worker = workers.find(w => !w.busy);
    if (!worker) {
      // 所有 Worker 忙，排队等待
      setTimeout(() => runInWorker(task).then(resolve).catch(reject), 50);
      return;
    }
    
    worker.busy = true;
    const id = task.id;
    
    const timeout = setTimeout(() => {
      if (pendingTasks.has(id)) {
        pendingTasks.delete(id);
        worker.busy = false;
        reject(new Error('Worker timeout'));
      }
    }, 30000);
    
    pendingTasks.set(task.id, { resolve, reject, timeout });
    worker.postMessage({ id, type: task.type, payload: task.payload });
  });
}

/** 初始化 Worker 池（延迟初始化） */
function initWorkerPool(count = MAX_WORKERS) {
  if (workers.length > 0) return;
  
  for (let i = 0; i < count; i++) {
    try {
      const worker = new Worker(new URL('./diff.worker.js', import.meta.url), { type: 'module' });
      worker.id = i;
      worker.busy = false;
      worker.onmessage = (e) => {
        const { id, result, error } = e.data;
        const task = pendingTasks.get(id);
        if (task) {
          pendingTasks.delete(id);
          workers[worker.id].busy = false;
          if (error) task.reject(new Error(error));
          else task.resolve(result);
        }
      };
      worker.onerror = (err) => {
        console.error(`[DiffWorker ${i}] Error:`, err);
        workers[i].busy = false;
      };
      workers.push(worker);
    } catch (err) {
      console.warn('[ParallelDiff] Failed to create worker, falling back to main thread:', err);
      break;
    }
  }
}

/** 句子切分 */
function splitSentences(text) {
  const s = String(text || '').replace(/\r\n?/g, '\n');
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf.trim()) out.push(buf);
    buf = '';
  };
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    buf += c;
    if (END_MARKS.includes(c)) {
      while (i + 1 < s.length && CLOSERS.includes(s[i + 1])) {
        i += 1;
        buf += s[i];
      }
      if (buf.trim()) out.push(buf);
      buf = '';
    } else if (c === '\n') {
      if (buf.trim()) out.push(buf);
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf);
  return out;
}

/** LCS 核心 */
function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  let head = 0;
  while (head < n && head < m && a[head] === b[head]) head += 1;
  let tailA = n;
  let tailB = m;
  while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) {
    tailA -= 1;
    tailB -= 1;
  }
  const ops = [];
  for (let k = 0; k < head; k += 1) ops.push({ type: 'same', text: a[k] });
  const midA = a.slice(head, tailA);
  const midB = b.slice(head, tailB);
  
  if (midA.length * midB.length <= 400000) {
    const rows = Array.from({ length: midA.length + 1 }, () => new Uint32Array(midB.length + 1));
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      const next = rows[i + 1];
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        row[j] = midA[i] === midB[j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        ops.push({ type: 'same', text: midA[i] });
        i += 1; j += 1;
      } else if (rows[i + 1][j] >= rows[i][j + 1]) {
        ops.push({ type: 'del', text: midA[i] });
        i += 1;
      } else {
        ops.push({ type: 'add', text: midB[j] });
        j += 1;
      }
    }
    while (i < midA.length) ops.push({ type: 'del', text: midA[i++] });
    while (j < midB.length) ops.push({ type: 'add', text: midB[j++] });
  } else {
    for (const text of midA) ops.push({ type: 'del', text });
    for (const text of midB) ops.push({ type: 'add', text });
  }
  for (let k = tailA; k < n; k += 1) ops.push({ type: 'same', text: a[k] });
  return ops;
}

const END_MARKS = '。！？!?…';
const CLOSERS = '”’」』"\')）】》〉';

const pendingTasks = new Map();
let taskId = 0;

// 导出
export { parallelLcsOps, splitSentences, lcsOps };

// 消息处理（作为 Worker 时使用）
if (typeof self !== 'undefined' && self.onmessage !== undefined) {
  self.onmessage = (e) => {
    const { id, type, payload } = e.data;
    try {
      let result;
      switch (type) {
        case 'lcsOps':
          result = lcsOps(payload.a, payload.b);
          break;
        case 'splitSentences':
          result = splitSentences(payload.text);
          break;
        default:
          throw new Error(`Unknown task type: ${type}`);
      }
      self.postMessage({ id, result });
    } catch (err) {
      self.postMessage({ id, error: err.message });
    }
  };