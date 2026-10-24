// 书匠 · Diff Web Worker
// 离屏计算 LCS/字级差异，不阻塞主线程

// 句末标点（中英文）；分号不断句，它只是句内停顿
const END_MARKS = '。！？!?…';
// 收尾的引号括号跟着上一句走
const CLOSERS = '”’」』"\')）】》〉';

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
      flush();
    } else if (c === '\n') {
      flush();
    }
  }
  flush();
  return out;
}

/** 两个字符串数组的最长公共子序列对齐 */
function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  // 先削掉共同开头/结尾：多数改动只发生在中间，DP 表会小很多
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

  // 整篇重写时不要为了一张几千万格的表把页面卡死；超过阈值就按整块替换展示
  if (midA.length * midB.length <= 400000) {
    const rows = Array.from({ length: midA.length + 1 }, () => new Uint32Array(midB.length + 1));
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      const next = rows[i + 1];
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        row[j] = midA[i] === midB[j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        ops.push({ type: 'same', text: midA[i] });
        i += 1;
        j += 1;
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

/** 两个短文本逐字比：返回 same/del/add 片段 */
function charOps(a, b) {
  const A = Array.from(a);
  const B = Array.from(b);
  const n = A.length;
  const m = B.length;
  if (!n && !m) return [];
  if (n * m > 250000) return [{ type: 'del', text: a }, { type: 'add', text: b }];
  const rows = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const next = rows[i + 1];
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] = A[i] === B[j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1]);
    }
  }
  const out = [];
  const push = (type, ch) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += ch;
    else out.push({ type, text: ch });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      push('same', A[i]);
      i += 1;
      j += 1;
    } else if (rows[i + 1][j] >= rows[i][j + 1]) {
      push('del', A[i]);
      i += 1;
    } else {
      push('add', B[j]);
      j += 1;
    }
  }
  while (i < n) push('del', A[i++]);
  while (j < m) push('add', B[j++]);
  return out;
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
      flush();
    } else if (c === '\n') {
      flush();
    }
  }
  flush();
  return out;
}

// 消息处理
self.onmessage = (e) => {
  const { id, type, payload } = e.data;
  try {
    let result;
    switch (type) {
      case 'diffProse': {
        const { oldText, newText } = payload;
        const ops = lcsOps(splitSentences(oldText), splitSentences(newText));
        const segs = [];
        let i = 0;
        while (i < ops.length) {
          const o = ops[i];
          if (o.type === 'same') {
            segs.push({ type: 'same', text: o.text });
            i += 1;
            continue;
          }
          const dels = [];
          const adds = [];
          while (i < ops.length && ops[i].type !== 'same') {
            if (ops[i].type === 'del') dels.push(ops[i].text);
            else adds.push(ops[i].text);
            i += 1;
          }
          const pairs = Math.min(dels.length, adds.length);
          for (let k = 0; k < pairs; k += 1) {
            const inner = charOps(dels[k], adds[k]);
            const hasSame = inner.some((x) => x.type === 'same');
            if (!hasSame) {
              segs.push({ type: 'chg', text: dels[k], alt: adds[k] });
            } else {
              for (const x of inner) {
                if (x.type === 'same') segs.push({ type: 'same', text: x.text });
                else if (x.type === 'del') segs.push({ type: 'del', text: x.text });
                else segs.push({ type: 'add', text: x.text });
              }
            }
          }
          for (let k = pairs; k < dels.length; k += 1) segs.push({ type: 'del', text: dels[k] });
          for (let k = pairs; k < adds.length; k += 1) segs.push({ type: 'add', text: adds[k] });
        }
        // 合并相邻同类型片段
        const merged = [];
        for (const s of segs) {
          const last = merged[merged.length - 1];
          if (last && last.type === s.type && (s.type !== 'chg' || last.alt === s.alt)) {
            last.text += s.text;
          } else {
            merged.push({ ...s });
          }
        }
        result = { ...diffStats(merged), segs: merged };
        break;
      }
      case 'lcsOps': {
        const { a, b } = payload;
        result = lcsOps(a, b);
        break;
      }
      case 'charOps': {
        const { a, b } = payload;
        result = charOps(a, b);
        break;
      }
      case 'splitSentences': {
        const { text } = payload;
        result = splitSentences(text);
        break;
      }
      default:
        throw new Error(`Unknown task type: ${type}`);
    }
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
});

function diffStats(segs) {
  let added = 0;
  let removed = 0;
  let same = 0;
  for (const s of segs) {
    if (s.type === 'same') same += s.text.length;
    else if (s.type === 'del') removed += s.text.length;
    else if (s.type === 'add') added += s.text.length;
    else {
      removed += s.text.length;
      added += (s.alt || '').length;
    }
  }
  const total = Math.max(1, same + Math.max(added, removed));
  return { added, removed, same, similarity: Math.round((same / total) * 100) };
}