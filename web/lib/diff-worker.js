// 书匠 · Diff Web Worker 封装
// 自动使用 Web Worker 离屏计算，失败时回退到主线程
// 支持大文本并行差分（多 Worker 并行）

import { diffProse, lcsOps, charOps, splitSentences, diffHtml, diffSideHtml, diffStats, makeCompactDiff, applyCompactDiff } from './diff.js';
import { parallelLcsOps } from './diff-parallel.js';

let workers = [];
let workerReady = false;
let pendingTasks = new Map();
let taskId = 0;
const MAX_WORKERS = navigator.hardwareConcurrency || 4;
const PARALLEL_THRESHOLD = 50000;

/** 初始化 Worker 池 */
function initWorkerPool() {
  if (workers.length > 0) return;
  
  const count = navigator.hardwareConcurrency || 4;
  for (let i = 0; i < count; i++) {
    try {
      const worker = new Worker(new URL('../worker/diff.worker.js', import.meta.url), { type: 'module' });
      worker.id = i;
      worker.busy = false;
      worker.onmessage = handleWorkerMessage;
      worker.onerror = (err) => {
        console.warn(`[DiffWorker ${i}] Worker error, falling back to main thread:`, err);
        workers[i].busy = false;
        // 处理该 worker 上的待处理任务
        for (const [id, task] of pendingTasks) {
          if (task.workerId === i) {
            pendingTasks.delete(id);
            task.reject(new Error('Worker error'));
          }
        }
      };
      workers.push({ worker, id: i, busy: false });
      workerReady = true;
    } catch (err) {
      console.warn(`[DiffWorker] Failed to create worker ${i}, using main thread:`, err);
    }
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

/** 获取空闲 Worker */
function getFreeWorker() {
  return workers.find(w => !w.busy);
}

/** 在 Worker 池中运行任务，失败回退到主线程 */
function runInWorker(type, payload) {
  return new Promise((resolve, reject) => {
    if (!workerReady) {
      initWorkerPool();
      if (!workerReady) {
        reject(new Error('Worker not available'));
        return;
      }
    }

    const id = ++taskId;
    
    // 大文本并行处理
    if (type === 'diffProse' && payload.oldText.length + payload.newText.length > 50000) {
      runParallelDiff(payload.oldText, payload.newText).then(resolve).catch(reject);
      return;
    }

    // 单任务模式
    const worker = getFreeWorker();
    if (!worker) {
      // 所有 Worker 忙，排队等待
      setTimeout(() => runInWorker(type, payload).then(resolve).catch(reject), 50);
      return;
    }

    worker.busy = true;
    pendingTasks.set(id, { resolve, reject, workerId: worker.id });

    worker.worker.postMessage({ id, type, payload });

    // 5秒超时保护
    setTimeout(() => {
      if (pendingTasks.has(id)) {
        pendingTasks.delete(id);
        workers[worker.id].busy = false;
        console.warn('[DiffWorker] Task timeout, falling back to main thread');
        reject(new Error('Worker timeout'));
      }
    }, 30000);
  }).catch(() => {
    // 回退到主线程
    return runInMainThread(type, payload);
  });
}

/** 并行 Diff 计算 */
async function runParallelDiff(oldText, newText) {
  try {
    const ops = await parallelLcsOps(
      splitSentences(oldText),
      splitSentences(newText),
      navigator.hardwareConcurrency || 4
    );
    // 重建 diffProse 兼容格式
    const segs = [];
    for (const op of ops) {
      if (op.type === 'same') {
        segs.push({ type: 'same', text: op.text });
      } else if (op.type === 'del') {
        segs.push({ type: 'del', text: op.text });
      } else if (op.type === 'add') {
        segs.push({ type: 'add', text: op.text });
      }
    }
    // 计算统计
    let added = 0, removed = 0, same = 0;
    for (const s of segs) {
      if (s.type === 'same') same += s.text.length;
      else if (s.type === 'del') removed += s.text.length;
      else if (s.type === 'add') added += s.text.length;
    }
    const total = Math.max(1, same + Math.max(added, removed));
    return { segs, added, removed, same, similarity: Math.round((same / total) * 100) };
  } catch (err) {
    console.warn('[DiffWorker] Parallel diff failed, falling back:', err);
    // 回退到单线程
    return runInWorker('diffProse', { oldText, newText });
  }
}

/** 主线程执行（回退方案） */
function runInMainThread(type, payload) {
  switch (type) {
    case 'diffProse':
      return diffProse(payload.oldText, payload.newText);
    case 'lcsOps':
      return lcsOps(payload.a, payload.b);
    case 'charOps':
      return charOps(payload.a, payload.b);
    case 'splitSentences':
      return splitSentences(payload.text);
    default:
      throw new Error(`Unknown task type: ${type}`);
  }
}

/** 差异对比主入口：优先用 Worker，大文本时自动离屏计算 */
export async function diffProseAsync(oldText, newText, threshold = 5000) {
  // 小文本直接主线程跑，省 Worker 通信开销
  if ((oldText.length + newText.length) < threshold) {
    return diffProse(oldText, newText);
  }
  return runInWorker('diffProse', { oldText, newText });
}

/** 同步版本（保持兼容） */
export function diffProseSync(oldText, newText) {
  return diffProse(oldText, newText);
}

/** 其它导出（保持原有 API 兼容） */
export { diffHtml, diffSideHtml, diffStats, lcsOps, charOps, splitSentences, makeCompactDiff, applyCompactDiff };