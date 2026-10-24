// 书匠 · Diff Web Worker 封装
// 自动使用 Web Worker 离屏计算，失败时回退到主线程

import { diffProse, lcsOps, charOps, splitSentences, diffHtml, diffSideHtml, diffStats, makeCompactDiff, applyCompactDiff } from './diff.js';

let worker = null;
let workerReady = false;
let pendingTasks = new Map();
let taskId = 0;

/** 初始化 Worker */
function initWorker() {
  if (worker) return;
  try {
    worker = new Worker(new URL('../worker/diff.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { id, result, error } = e.data;
      const task = pendingTasks.get(id);
      if (task) {
        pendingTasks.delete(id);
        if (error) task.reject(new Error(error));
        else task.resolve(result);
      }
    };
    worker.onerror = (err) => {
      console.warn('[DiffWorker] Worker error, falling back to main thread:', err);
      workerReady = false;
      worker = null;
      // 重试队列中的任务用主线程
      for (const [, task] of pendingTasks) {
        task.reject(new Error('Worker error'));
      }
      pendingTasks.clear();
    };
    workerReady = true;
  } catch (err) {
    console.warn('[DiffWorker] Failed to create worker, using main thread:', err);
    workerReady = false;
  }
}

/** 在 Worker 中运行任务，失败回退到主线程 */
function runInWorker(type, payload) {
  return new Promise((resolve, reject) => {
    if (!workerReady) {
      initWorker();
      // 如果初始化失败，直接用主线程
      if (!workerReady) {
        reject(new Error('Worker not available'));
        return;
      }
    }

    const id = ++taskId;
    pendingTasks.set(id, { resolve, reject });

    worker.postMessage({ id, type, payload });

    // 5秒超时保护
    setTimeout(() => {
      if (pendingTasks.has(id)) {
        pendingTasks.delete(id);
        console.warn('[DiffWorker] Task timeout, falling back to main thread');
        reject(new Error('Worker timeout'));
      }
    }, 5000);
  }).catch(() => {
    // 回退到主线程
    return runInMainThread(type, payload);
  });
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