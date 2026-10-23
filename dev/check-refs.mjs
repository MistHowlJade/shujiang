// 书匠 · 模块引用自检
// ---------------------------------------------------------------------------
// 拆成多模块之后，最容易出的错是：
//   1. 从别的模块 import 了不存在的名字
//   2. 别处用了某个函数，却忘了 import（名字在 lib 里存在，所以普通语法检查抓不到）
//   3. lib 里的模块还在摸 app.js 的全局状态 S
//   4. 同一个名字被定义了两遍
//
// 用法：node dev/check-refs.mjs
// 全通过时退出码为 0。
// ===========================================================================

import fs from 'node:fs';
import path from 'node:path';

const FILES = [
  'web/app.js',
  'web/lib/util.js',
  'web/lib/data.js',
  'web/lib/proof.js',
  'web/lib/health.js',
  'web/lib/diff.js',
  'web/lib/goal.js',
  'web/lib/submit.js',
  'web/lib/paper.js',
];

const all = FILES.map((f) => [f.replace(/\\/g, '/'), fs.readFileSync(f, 'utf8')]);

/** 顶层定义（能被别的模块 import 的） */
const topLevelDefs = (code) => {
  const s = new Set();
  for (const m of code.matchAll(/^(?:export )?(?:async )?function ([a-zA-Z0-9_$]+)\s*\(/gm)) s.add(m[1]);
  for (const m of code.matchAll(/^(?:export )?(?:const|let|var) ([a-zA-Z0-9_$]+)\s*=/gm)) s.add(m[1]);
  return s;
};

/** 全部定义（含函数内的局部变量与参数），用来判断「这个名字找得到」 */
const anyDefs = (code) => {
  const s = new Set();
  for (const m of code.matchAll(/(?:async )?function ([a-zA-Z0-9_$]+)\s*\(/g)) s.add(m[1]);
  for (const m of code.matchAll(/(?:^|[^\w$])(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=/gm)) s.add(m[1]);
  // 对象字面量的方法简写：{ async get(url) { … } }
  for (const m of code.matchAll(/^\s{2,}(?:async )?([a-zA-Z0-9_$]+)\s*\([^)]*\)\s*\{/gm)) s.add(m[1]);
  // 函数参数
  for (const m of code.matchAll(/function\s*[a-zA-Z0-9_$]*\s*\(([^)]*)\)/g)) {
    for (const raw of m[1].split(',')) {
      const n = raw.trim().split(/[\s=]/)[0].replace(/^\.\.\./, '').trim();
      if (n) s.add(n);
    }
  }
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const raw of m[1].split(',')) {
      const n = raw.trim().split(/[\s=]/)[0].replace(/^\.\.\./, '').trim();
      if (n) s.add(n);
    }
  }
  return s;
};

/** 把字符串与模板字面量挖掉，免得把 CSS 里的 var(--x) 当成代码 */
const stripStrings = (code) => code
  .replace(/`(?:[^`\\]|\\.)*`/g, '``')
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

const BUILTIN = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'new', 'await', 'async',
  'of', 'in', 'do', 'else', 'try', 'void', 'delete', 'instanceof', 'this', 'super', 'yield',
  'import', 'export', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame',
  'fetch', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'isInteger',
  'Number', 'String', 'Boolean', 'Array', 'Object', 'JSON', 'Math', 'Date', 'Promise', 'Map', 'Set',
  'RegExp', 'Error', 'Symbol', 'BigInt', 'encodeURIComponent', 'decodeURIComponent', 'structuredClone',
  'TextDecoder', 'TextEncoder', 'File', 'Blob', 'URL', 'AbortController', 'FormData', 'Intl',
  'console', 'alert', 'confirm', 'prompt', 'location', 'history', 'document', 'window', 'navigator',
  'localStorage', 'sessionStorage', 'globalThis', 'crypto', 'atob', 'btoa', 'performance',
  'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'queueMicrotask',
  'ArrayBuffer', 'Uint8Array', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array', 'Int32Array',
  'Float32Array', 'Float64Array', 'DataView', 'FileReader', 'Event', 'CustomEvent', 'MouseEvent',
  'KeyboardEvent', 'Image', 'Audio', 'AudioContext', 'OfflineAudioContext', 'DOMParser',
  'XMLSerializer', 'Node', 'Element', 'HTMLElement', 'Storage', 'getComputedStyle',
]);

let bad = 0;
const fail = (msg) => { console.log('  FAIL ' + msg); bad++; };

console.log('书匠 · 模块引用自检');

// ---- 1. import 的名字必须在目标模块里真的存在 ----
console.log('\n【import 有效性】');
for (const [f, c] of all) {
  for (const m of c.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
    const names = m[1].split(',').map((x) => x.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[2]));
    const hit = all.find(([ff]) => ff === target);
    if (!hit) { fail(`${f}: 找不到模块 ${m[2]}`); continue; }
    const defs = topLevelDefs(hit[1]);
    for (const n of names) if (!defs.has(n)) fail(`${f}: 从 ${m[2]} import 了不存在的 ${n}`);
  }
}

// ---- 2. lib 里的模块不能摸 app.js 的全局状态 S ----
console.log('\n【lib 不依赖全局状态】');
for (const [f, c] of all) {
  if (f === 'web/app.js') continue;
  const hit = c.split('\n').filter((l) => /(^|[^.\w$])S\.[a-zA-Z]/.test(l));
  if (hit.length) fail(`${f} 还在引用全局状态 S：${hit[0].trim().slice(0, 70)}`);
}

// ---- 3. 同名定义不能重复 ----
console.log('\n【无重复定义】');
for (const [f, c] of all) {
  const seen = new Set();
  for (const m of c.matchAll(/^(?:export )?(?:async )?function ([a-zA-Z0-9_$]+)\s*\(/gm)) {
    if (seen.has(m[1])) fail(`${f}: ${m[1]} 重复定义`);
    seen.add(m[1]);
  }
  for (const m of c.matchAll(/^(?:export )?(?:const|let|var) ([a-zA-Z0-9_$]+)\s*=/gm)) {
    if (seen.has(m[1])) fail(`${f}: ${m[1]} 重复定义`);
    seen.add(m[1]);
  }
}

// ---- 4. app.js 用到 lib 导出的名字，就必须真的 import ----
console.log('\n【app.js 的 import 是否齐全】');
{
  const app = all.find(([f]) => f === 'web/app.js')[1];
  const imported = new Set();
  for (const m of app.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
    for (const raw of m[1].split(',')) {
      const n = raw.trim().split(/\s+as\s+/)[0].trim();
      if (n) imported.add(n);
    }
  }
  const called = new Set();
  const code = stripStrings(app);
  for (const m of code.matchAll(/(?<![.\w$])([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g)) called.add(m[1]);
  for (const [f, c] of all) {
    if (f === 'web/app.js') continue;
    for (const n of topLevelDefs(c)) {
      if (!called.has(n)) continue;
      if (!imported.has(n)) fail(`app.js 用了 ${n}（来自 ${f}）但没有 import`);
    }
  }
}

// ---- 5. app.js 里调用的裸函数必须找得到定义 ----
console.log('\n【app.js 里的调用都有定义】');
{
  const app = all.find(([f]) => f === 'web/app.js')[1];
  const local = anyDefs(app);
  const imported = new Set();
  for (const m of app.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
    for (const raw of m[1].split(',')) {
      const n = raw.trim().split(/\s+as\s+/)[0].trim();
      if (n) imported.add(n);
    }
  }
  const libDefs = new Set();
  for (const [f, c] of all) {
    if (f === 'web/app.js') continue;
    for (const n of anyDefs(c)) libDefs.add(n);
  }
  const called = new Set();
  const code = stripStrings(app);
  // 用负向后顾，别「吃掉」前一个字符：否则 parseFloat(getComputedStyle(…)) 里的内层调用会被漏掉
  for (const m of code.matchAll(/(?<![.\w$])([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g)) called.add(m[1]);
  const missing = [...called].filter((n) => !local.has(n) && !imported.has(n) && !libDefs.has(n) && !BUILTIN.has(n));
  if (missing.length) fail('app.js 里用到但找不到定义：' + missing.join(', '));
}

console.log(bad ? `\n发现 ${bad} 处问题` : '\n全部通过');
process.exit(bad ? 1 : 0);
