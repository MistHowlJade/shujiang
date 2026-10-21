// 书匠 · AI 长篇小说创作台 —— 零依赖本地服务器
// 只监听 127.0.0.1，不对外暴露；所有数据落在项目内 data/ 目录。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import {
  ROOT, DATA_DIR, ensureDirs, loadConfig, saveConfig, maskKey,
  listNovels, createNovel, getNovel, saveNovel, deleteNovel, newId, countWords,
  listSnapshots, createSnapshot, readSnapshot, chapterVolumeIds, volumeLabel,
  findOutlineEntry, CHAPTER_STAGES, cleanTargetWords,
} from './store.js';
import { buildTask, TASKS } from './prompts.js';
import { buildEpub } from './epub.js';
import { buildContext, collectScopeText, packSummaryLines } from './context.js';
import { addWords, setGoal, statsSummary } from './stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(ROOT, 'web');
const PORT = Number(process.env.SHU_PORT || 8848);
const HOST = '127.0.0.1';

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, code, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(text);
}

function readBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* 模型服务商                                                          */
/* ------------------------------------------------------------------ */

function normalizeBaseUrl(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

function completionsUrl(baseUrl) {
  const u = normalizeBaseUrl(baseUrl);
  if (/\/chat\/completions$/.test(u)) return u;
  return `${u}/chat/completions`;
}

function resolveProvider(cfg, providerId) {
  const list = cfg.providers || [];
  const p = list.find((x) => x.id === providerId) || list.find((x) => x.id === cfg.activeProviderId) || list[0];
  if (!p) throw new Error('还没有配置模型服务商，请先到「设置」里填写 Base URL 与 API Key。');
  if (!p.apiKey) throw new Error(`服务商「${p.name || p.baseUrl}」还没有填写 API Key。`);
  return p;
}

const ROLE_OF_TASK = {
  outline: 'write', characters: 'write', worldview: 'write', chapter: 'write',
  continue: 'write', polish: 'write', expand: 'write', shorten: 'write',
  rewrite: 'write', custom: 'write', titles: 'write', style: 'write',
  memory: 'summary', consistency: 'summary', review: 'review',
};

function resolveModel(cfg, provider, task) {
  const role = ROLE_OF_TASK[task] || 'write';
  return (cfg.roleModels && cfg.roleModels[role]) || cfg.model || (provider.models || [])[0] || '';
}

/* ------------------------------------------------------------------ */
/* 任务上下文准备                                                      */
/* ------------------------------------------------------------------ */

function prepareTask(cfg, body) {
  const { task, novelId, chapterId, payload = {} } = body;
  if (!task) throw new Error('缺少 task');
  if (!TASKS[task]) throw new Error(`未知任务：${task}`);

  let novel = null;
  let pack = [];
  let stats = {};
  let prevTail = '';

  if (novelId) {
    novel = getNovel(novelId);
    if (!novel) throw new Error('找不到这部作品');
    if (task !== 'style' && task !== 'custom') {
      const built = buildContext(novel, { chapterId, extraQuery: payload.extraQuery, budget: novel.meta?.contextBudget });
      pack = built.pack;
      stats = built.stats;
      prevTail = built.prevTail;
    }
  }

  const chapter = novel && chapterId ? (novel.chapters || []).find((c) => c.id === chapterId) : null;

  // 需要正文范围的任务（一致性检查 / 责编评审）
  let scopeText = payload.scopeText || '';
  if ((task === 'consistency' || task === 'review') && novel && !scopeText) {
    scopeText = collectScopeText(novel, {
      chapterIds: payload.chapterIds,
      from: payload.from,
      to: payload.to,
      maxChars: payload.maxChars || 35000,
    });
  }

  const ctx = {
    novel,
    chapter,
    pack,
    prevTail,
    payload: { ...payload, scopeText, prevTail },
  };
  const built = buildTask(task, ctx);
  return { built, novel, stats, pack, chapter };
}

/* ------------------------------------------------------------------ */
/* 调用上游大模型                                                      */
/* ------------------------------------------------------------------ */

async function callUpstream({ cfg, provider, model, messages, temperature, maxTokens, stream, signal }) {
  const url = completionsUrl(provider.baseUrl);
  const modelName = model || provider.models?.[0] || '';
  if (!modelName) throw new Error('还没有选择模型');
  const body = {
    model: modelName,
    messages,
    temperature: Number.isFinite(temperature) ? temperature : 0.85,
    max_tokens: Number.isFinite(maxTokens) ? maxTokens : 4096,
    stream: !!stream,
  };
  if (provider.extraBody && typeof provider.extraBody === 'object') Object.assign(body, provider.extraBody);

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
      ...(provider.headers || {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  return { resp, modelName, url };
}

async function upstreamErrorText(resp) {
  try {
    const txt = (await resp.text()).trim();
    const j = tryJson(txt);
    if (j) return j.error?.message || j.message || txt.slice(0, 600);
    // 网关给的多半是 HTML 错误页，抽个标题出来就够，别把整页 HTML 糊到界面上
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(txt);
    const plain = (title ? title[1] : txt.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (plain) return plain.slice(0, 300);
    return /^</.test(txt) ? '网关返回了一个网页（不是模型响应）' : txt.slice(0, 300);
  } catch {
    return `HTTP ${resp.status}`;
  }
}

/** 上游一个字正文都没给时，尽量说清楚到底发生了什么 */
function describeEmptyBody(sniff) {
  const t = (sniff || '').trim();
  const fallback = '模型这次没有返回任何内容。可能是模型名不对、额度用尽，或该模型的接口格式不兼容。';
  if (!t) return fallback;
  const j = tryJson(t);
  if (j) {
    if (j.error) return `上游返回错误：${j.error.message || j.error.code || JSON.stringify(j.error).slice(0, 160)}`;
    if (j.message) return `上游返回：${String(j.message).slice(0, 160)}`;
    return fallback;
  }
  if (/^</.test(t)) {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(t);
    const plain = (title ? title[1] : t.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 120);
    return `上游返回的是网页而不是模型的回复（通常是网关、代理或反向代理配置有问题）：${plain || '无标题'}`;
  }
  return fallback;
}

/* ------------------------------------------------------------------ */
/* 上游响应 → 统一 SSE 事件                                            */
/* ------------------------------------------------------------------ */
// 各家「OpenAI 兼容」的偏差都收在这里：
//   1. 无视 stream:true，直接回一个完整 JSON
//   2. delta.content 不是字符串，而是 [{type:'text',text:'…'}] 这样的数组
//   3. 思考过程字段叫 reasoning / reasoning_text，而不是 reasoning_content
//   4. SSE 用 CRLF、发 `: ping` 注释行、事件被切在 TCP 包中间
//   5. 流里夹着 {"error":{…}} 或 choices: []
//   6. 服务商卡住不回（靠空闲超时兜底）

const IDLE_MS = Number(process.env.SHU_UPSTREAM_IDLE || 180000);

function sseWrite(res, obj) {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/** content 可能是字符串、数组或对象，统一成字符串 */
function collectText(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v.map((p) => (typeof p === 'string' ? p : (p && (p.text || p.content)) || '')).join('');
  }
  if (v && typeof v === 'object' && typeof v.text === 'string') return v.text;
  return '';
}

/** 从任意一个上游 JSON 里抠出增量（兼容 delta / message / text 三种形状） */
function deltaFromChunk(j) {
  const choice = (j && j.choices && j.choices[0]) || {};
  const d = choice.delta || choice.message || {};
  const out = {};
  const content = collectText(d.content) || collectText(choice.text);
  if (content) out.content = content;
  const think = collectText(d.reasoning_content) || collectText(d.reasoning) || collectText(d.reasoning_text);
  if (think) out.reasoning_content = think;
  return out;
}

async function relayCompletion({ res, upstream, abort }) {
  const ct = (upstream.resp.headers.get('content-type') || '').toLowerCase();
  let emitted = 0;
  let idle = null;
  let timedOut = false;
  let fatal = null;
  let sniffed = '';

  const arm = () => {
    clearTimeout(idle);
    if (IDLE_MS > 0) idle = setTimeout(() => { timedOut = true; abort(); }, IDLE_MS);
  };
  const emit = (delta) => {
    if (!delta || (!delta.content && !delta.reasoning_content)) return;
    emitted += 1;
    sseWrite(res, { choices: [{ index: 0, delta }] });
  };
  const handleLine = (raw) => {
    const line = raw.replace(/\r$/, '');
    const t = line.trim();
    if (!t || t.startsWith(':')) return true;          // 空行 / keep-alive 注释
    if (!t.startsWith('data:')) return true;           // event: / id: 之类，忽略
    const payload = t.slice(5).trim();
    if (!payload) return true;
    if (payload === '[DONE]') return false;
    let j;
    try {
      j = JSON.parse(payload);
    } catch {
      emit({ content: payload });                      // 上游吐的是纯文本，直接当正文
      return true;
    }
    if (j.error) {
      fatal = j.error.message || j.error.code || '模型返回错误';
      return false;
    }
    if (j.message && !j.choices) { fatal = String(j.message); return false; }
    emit(deltaFromChunk(j));
    return true;
  };

  try {
    if (ct.includes('application/json')) {
      // 供应商无视 stream:true，直接返回完整回复
      const txt = await upstream.resp.text();
      const j = tryJson(txt);
      if (j) emit(deltaFromChunk(j));
      if (!emitted) sniffed = txt.slice(0, 2048);
    } else {
      const dec = new TextDecoder('utf-8');
      let buf = '';
      let sniff = '';          // 只在「一个字都没解析出来」时用来判断上游到底回了什么
      let running = true;
      arm();
      const consume = (text) => {
        let i;
        while (running && (i = text.indexOf('\n')) >= 0) {
          running = handleLine(text.slice(0, i));
          text = text.slice(i + 1);
        }
        return text;
      };
      for await (const chunk of upstream.resp.body) {
        arm();
        const s = dec.decode(chunk, { stream: true });
        if (!emitted && sniff.length < 2048) sniff += s;
        buf = consume(buf + s);
        if (!running) break;
      }
      if (running) {
        // 收尾：最后一行可能没有换行；也可能整段就是一个不带 SSE 包装的 JSON
        const rest = buf.trim();
        if (rest) {
          if (!emitted && sniff.length < 2048) sniff += rest;
          handleLine(rest);
          if (!emitted) {
            const j = tryJson(rest);
            if (j) emit(deltaFromChunk(j));
          }
        }
      }
      sniffed = sniff;
    }
  } catch (err) {
    if (timedOut) {
      sseWrite(res, { shu_error: `模型超过 ${Math.round(IDLE_MS / 1000)} 秒没有返回任何数据，已断开。请检查服务商地址、模型名与网络。` });
    } else if (!res.writableEnded) {
      sseWrite(res, { shu_error: `生成中断：${err.message}` });
    }
    clearTimeout(idle);
    return;
  }
  clearTimeout(idle);

  if (fatal) sseWrite(res, { shu_error: fatal });
  else if (!emitted) sseWrite(res, { shu_error: describeEmptyBody(sniffed) });
}

function tryJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

// 章节写盘：合并字段并顺手记录「今天写了多少字」。
// 导入旧稿、恢复快照、全书替换都不经过这里，所以它们不会污染日更统计。
// body.counted 是前端交上来的账本（"这次真的敲进去多少字"）——只看正文长度的话，
// 撤销后重做会把同一段字记两遍，所以由前端记账、这里照单收下；
// 没带账本（旧客户端 / 别的调用方）时退回「内容变多了就记」的老口径。
const COUNTED_MAX = 200000;   // 单次保存的记账上限，挡住异常调用把统计冲爆
function writeChapter(n, index, cid, body) {
  const { counted, ...fields } = body || {};   // counted 只用于统计，不能混进章节数据
  if (fields.stage !== undefined && !CHAPTER_STAGES.has(fields.stage)) delete fields.stage;
  const before = countWords(n.chapters[index].content);
  n.chapters[index] = { ...n.chapters[index], ...fields, id: cid, createdAt: n.chapters[index].createdAt };
  const grown = countWords(n.chapters[index].content) - before;
  const hint = Math.floor(Number(counted));
  const delta = Number.isFinite(hint) && hint >= 0 ? Math.min(hint, COUNTED_MAX) : Math.max(0, grown);
  if (delta > 0) addWords(n.id, delta);
}

const OUTLINE_KEYS = ['scene', 'characters', 'summary', 'hook'];
const OUTLINE_FIELD_MAX = 4000;

// 章纲只收这四个文本字段，去掉首尾空白；空字段不落盘，免得 JSON 里堆一串空串
function cleanOutline(raw) {
  const out = {};
  for (const key of OUTLINE_KEYS) {
    const value = typeof raw?.[key] === 'string' ? raw[key].trim() : '';
    if (value) out[key] = value.slice(0, OUTLINE_FIELD_MAX);
  }
  return out;
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method.toUpperCase();
  // DELETE 的处理逻辑不需要请求体。若不主动排空，Node 在响应后会丢弃未读数据，
  // 浏览器侧会表现为「200 + 空响应」或 Failed to fetch（前端拿不到 novel 就会把界面清空）。
  if (method === 'DELETE') req.resume();
  const seg = pathname.split('/').filter(Boolean); // ['api', 'novels', ':id', ...]

  /* --- 配置 --- */
  if (seg[1] === 'config' && seg.length === 2) {
    if (method === 'GET') {
      const cfg = loadConfig();
      return sendJson(res, 200, {
        ...cfg,
        providers: (cfg.providers || []).map((p) => ({ ...p, apiKey: '', apiKeyMasked: maskKey(p.apiKey), apiKeySet: !!p.apiKey })),
      });
    }
    if (method === 'POST') {
      const incoming = await readBody(req);
      const cfg = loadConfig();
      const oldById = new Map((cfg.providers || []).map((p) => [p.id, p]));
      // 只有显式传了 providers 才动服务商列表。
      // 否则局部更新（例如切主题只发 { ui: { theme } }）会把 Base URL 与 API Key 一起清空。
      const providers = Array.isArray(incoming.providers)
        ? incoming.providers.map((p) => {
            const prev = oldById.get(p.id);
            let apiKey = p.apiKey;
            if (apiKey === undefined || apiKey === null || apiKey === '') apiKey = prev?.apiKey || '';
            if (apiKey === '__CLEAR__') apiKey = '';
            return { ...prev, ...p, id: p.id || newId('p'), apiKey };
          })
        : (cfg.providers || []);
      const next = {
        ...cfg,
        ...incoming,
        providers,
        roleModels: { ...(cfg.roleModels || {}), ...(incoming.roleModels || {}) },
        ui: { ...(cfg.ui || {}), ...(incoming.ui || {}) },
      };
      delete next.apiKeyMasked;
      delete next.apiKeySet;
      saveConfig(next);
      return sendJson(res, 200, { ok: true });
    }
  }

  /* --- 今日码字量 / 日更目标 --- */
  if (seg[1] === 'stats' && seg.length === 2) {
    if (method === 'GET') {
      return sendJson(res, 200, statsSummary({ days: url.searchParams.get('days') || 14 }));
    }
    if (method === 'POST') {
      const body = await readBody(req);
      if (body.goal !== undefined) setGoal(body.goal);
      return sendJson(res, 200, statsSummary({ days: body.days || 14 }));
    }
  }

  // 测试连通性 / 拉取模型列表
  if (seg[1] === 'config' && seg[2] === 'models' && method === 'POST') {
    const body = await readBody(req);
    const cfg = loadConfig();
    let provider = { ...(cfg.providers || []).find((p) => p.id === body.providerId) };
    if (body.baseUrl) provider.baseUrl = body.baseUrl;
    if (body.apiKey) provider.apiKey = body.apiKey;
    if (!provider.apiKey) {
      const prev = (cfg.providers || []).find((p) => p.id === body.providerId);
      provider.apiKey = prev?.apiKey || '';
    }
    if (!provider.baseUrl) return sendJson(res, 400, { ok: false, error: '请先填写 Base URL' });
    if (!provider.apiKey) return sendJson(res, 400, { ok: false, error: '请先填写 API Key' });
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 20000);
      const r = await fetch(`${normalizeBaseUrl(provider.baseUrl)}/models`, {
        headers: { Authorization: `Bearer ${provider.apiKey}` },
        signal: ac.signal,
      });
      clearTimeout(t);
      if (!r.ok) return sendJson(res, 200, { ok: false, error: await upstreamErrorText(r) });
      const j = await r.json();
      const ids = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
      return sendJson(res, 200, { ok: true, models: ids });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: `连接失败：${err.message}` });
    }
  }

  /* --- 作品列表 --- */
  if (seg[1] === 'novels' && seg.length === 2) {
    if (method === 'GET') return sendJson(res, 200, { novels: listNovels() });
    if (method === 'POST') {
      const body = await readBody(req);
      const n = createNovel(body);
      return sendJson(res, 200, { novel: n });
    }
  }

  /* --- 全局检索：在所有作品正文与章节标题中查找 --- */
  if (seg[1] === 'library-search' && seg.length === 2 && method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
    if (!q) return sendJson(res, 200, { q: '', total: 0, works: 0, chapters: 0, truncated: false, results: [] });
    const limit = Math.min(120, Math.max(10, Number(url.searchParams.get('limit')) || 60));
    return sendJson(res, 200, searchLibrary(q, limit));
  }

  /* --- 单部作品 --- */
  if (seg[1] === 'novels' && seg[2]) {
    const id = seg[2];

    if (method === 'GET' && seg.length === 3) {
      const n = getNovel(id);
      if (!n) return sendJson(res, 404, { error: '作品不存在' });
      return sendJson(res, 200, { novel: n });
    }
    if (method === 'DELETE' && seg.length === 3) {
      deleteNovel(id);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'PUT' && seg.length === 3) {
      const body = await readBody(req);
      const n = getNovel(id);
      if (!n) return sendJson(res, 404, { error: '作品不存在' });
      const merged = {
        ...n,
        ...body,
        id: n.id,
        createdAt: n.createdAt,
        meta: { ...n.meta, ...(body.meta || {}) },
        bible: { ...n.bible, ...(body.bible || {}) },
        outline: { ...n.outline, ...(body.outline || {}) },
        chapters: body.chapters || n.chapters,
      };
      return sendJson(res, 200, { novel: saveNovel(merged) });
    }

    // 版本历史：列表 / 立即备份 / 恢复
    if (seg[3] === 'snapshots' && seg.length === 4) {
      const n = getNovel(id);
      if (!n) return sendJson(res, 404, { error: '作品不存在' });
      if (method === 'GET') return sendJson(res, 200, { snapshots: listSnapshots(id) });
      if (method === 'POST') {
        const body = await readBody(req);
        const snapshot = createSnapshot(n, {
          kind: 'manual',
          label: typeof body.label === 'string' ? body.label.slice(0, 40) : '',
          force: true,
        });
        return sendJson(res, 200, { snapshot, snapshots: listSnapshots(id) });
      }
    }
    // 只取快照里的某一章，供前端做版本对比；不把整本旧稿发到浏览器
    if (seg[3] === 'snapshots' && seg.length === 7 && seg[5] === 'chapter' && method === 'GET') {
      const ts = Number(seg[4]);
      if (!Number.isInteger(ts) || ts <= 0) return sendJson(res, 400, { error: '快照时间无效' });
      const snap = readSnapshot(id, ts);
      if (!snap) return sendJson(res, 404, { error: '快照不存在或已被清理' });
      const ch = (snap.chapters || []).find((c) => c?.id === seg[6]);
      // 章节在旧版里不存在是正常情况（后来新增 / 合并 / 删改），用 200 返回，避免正常交互在控制台留下 404
      if (!ch) return sendJson(res, 200, { chapter: null, error: '这一版里还没有这一章（可能是后来新增、合并或删改过）' });
      return sendJson(res, 200, {
        chapter: {
          id: ch.id,
          title: ch.title || '',
          content: ch.content || '',
        },
      });
    }
    if (seg[3] === 'restore' && seg.length === 4 && method === 'POST') {
      const body = await readBody(req);
      const n = getNovel(id);
      if (!n) return sendJson(res, 404, { error: '作品不存在' });
      const snap = readSnapshot(id, Number(body.ts));
      if (!snap) return sendJson(res, 404, { error: '快照不存在或已被清理' });
      // 恢复前先把当前状态存一份，恢复本身也能撤回
      createSnapshot(n, { kind: 'before-restore', label: '恢复前', force: true });
      snap.id = n.id;
      snap.updatedAt = Date.now();
      saveNovel(snap);
      return sendJson(res, 200, { novel: snap });
    }

    // 章节集合
    if (seg[3] === 'chapters') {
      const n = getNovel(id);
      if (!n) return sendJson(res, 404, { error: '作品不存在' });

      if (method === 'POST' && seg.length === 4) {
        const body = await readBody(req);
        const ch = {
          id: newId('c'),
          title: body.title || `第 ${n.chapters.length + 1} 章`,
          summary: body.summary || '',
          content: body.content || '',
          status: 'draft',
          stage: 'draft',
          targetWords: cleanTargetWords(body.targetWords),
          outline: body.outline || null,
          memory: null,
          // 归入哪一卷由前端决定（新章节默认跟着前一章走，见 web/app.js 的 addChapter）
          volumeId: typeof body.volumeId === 'string' ? body.volumeId : '',
          createdAt: Date.now(),
        };
        if (typeof body.at === 'number' && body.at >= 0 && body.at <= n.chapters.length) n.chapters.splice(body.at, 0, ch);
        else n.chapters.push(ch);
        saveNovel(n);
        return sendJson(res, 200, { chapter: ch, novel: n });
      }

      // 章纲编辑：一次写回「本章快照 + 设定库里的对应章纲」，避免两处各改一半。
      // 只动章纲字段，不碰正文、标题和写作状态。
      if (method === 'PUT' && seg.length === 6 && seg[5] === 'outline') {
        const cid = seg[4];
        const body = await readBody(req);
        if (!body || typeof body.outline !== 'object' || body.outline === null) {
          return sendJson(res, 400, { error: 'outline 必须是一个对象' });
        }
        const i = n.chapters.findIndex((c) => c.id === cid);
        if (i < 0) return sendJson(res, 404, { error: '章节不存在' });
        const outline = cleanOutline(body.outline);
        const ch = n.chapters[i];
        ch.outline = Object.keys(outline).length ? outline : null;
        const linked = findOutlineEntry(n, ch.outlineId)?.entry || null;
        if (linked) {
          for (const key of OUTLINE_KEYS) {
            if (Object.prototype.hasOwnProperty.call(outline, key)) linked[key] = outline[key];
            else delete linked[key];
          }
        }
        saveNovel(n);
        return sendJson(res, 200, { chapter: n.chapters[i], linkedOutlineId: linked?.id || '' });
      }

      if (method === 'PUT' && seg.length === 5) {
        const cid = seg[4];
        const body = await readBody(req);
        const i = n.chapters.findIndex((c) => c.id === cid);
        if (i < 0) return sendJson(res, 404, { error: '章节不存在' });
        writeChapter(n, i, cid, body);
        saveNovel(n);
        return sendJson(res, 200, { chapter: n.chapters[i] });
      }

      // 与 PUT 等价：供 navigator.sendBeacon（只支持 POST）在页面关闭前兜底保存
      if (method === 'POST' && seg.length === 5) {
        const cid = seg[4];
        const body = await readBody(req);
        const i = n.chapters.findIndex((c) => c.id === cid);
        if (i < 0) return sendJson(res, 404, { error: '章节不存在' });
        writeChapter(n, i, cid, body);
        saveNovel(n);
        return sendJson(res, 200, { ok: true });
      }

      if (method === 'DELETE' && seg.length === 5) {
        const cid = seg[4];
        const ch = n.chapters.find((c) => c.id === cid);
        if (!ch) return sendJson(res, 404, { error: '章节不存在' });
        // 删章是不可逆操作，不依赖 10 分钟节流，强制留一份
        createSnapshot(n, { kind: 'before-delete', label: `删除章节前：${ch.title || '未命名'}`, force: true });
        n.chapters = n.chapters.filter((c) => c.id !== cid);
        saveNovel(n);
        return sendJson(res, 200, { novel: n });
      }
    }

    // 分卷归属：只改 volumeId，不动正文。
    // 章节列表里的「并入上一卷 / 从此章起新的一卷」都走这里 —— 整本回传
    // （PUT /api/novels/:id）会把请求期间新敲进去的字一并覆盖，这里只补一个字段。
    // volumeId 传 null 表示「删掉明确值」，让这一章回到按章纲 / 跟着上一章。
    if (seg[3] === 'chapter-volume' && seg.length === 4 && method === 'POST') {
      const n = getNovel(id);
      if (!n) return sendJson(res, 404, { error: '作品不存在' });
      const body = await readBody(req);
      const sets = Array.isArray(body.set) ? body.set.slice(0, 3000) : [];
      let changed = 0;
      for (const s of sets) {
        const c = n.chapters.find((x) => x.id === s?.id);
        if (!c) continue;
        if (s.volumeId === null || s.volumeId === undefined) {
          if (c.volumeId === undefined) continue;
          delete c.volumeId;
          changed += 1;
          continue;
        }
        const v = typeof s.volumeId === 'string' ? s.volumeId.slice(0, 40) : '';
        if ((c.volumeId || '') === v) continue;
        c.volumeId = v;
        changed += 1;
      }
      if (changed) saveNovel(n);
      return sendJson(res, 200, { ok: true, changed });
    }

    // 导出
    if (seg[3] === 'export' && method === 'GET') {
      const n = getNovel(id);
      if (!n) return sendJson(res, 404, { error: '作品不存在' });
      const raw = url.searchParams.get('format');
      const format = raw === 'md' ? 'md' : raw === 'epub' ? 'epub' : raw === 'json' ? 'json' : 'txt';
      // 整本作品备份：原样导出作品 JSON，保留正文、设定、大纲、记忆和修订；
      // 恢复时由前端新建一部作品，不覆盖现有稿件。
      if (format === 'json') {
        const body = JSON.stringify(n, null, 2);
        const name = `${safeName(n.title)}_备份.json`;
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-store',
        });
        return res.end(body);
      }
      const cid = url.searchParams.get('chapterId');
      // 只导出定稿只作用于「全书」；当前章导出是作者明确指定的，不受状态限制
      const onlyDone = !cid && url.searchParams.get('only') === 'done';
      const doneList = onlyDone ? n.chapters.filter((c) => c.stage === 'done') : n.chapters;
      const list = format === 'epub'
        ? (onlyDone ? doneList : n.chapters)     // EPUB 始终全书，忽略 chapterId
        : (cid ? n.chapters.filter((c) => c.id === cid) : doneList);
      // 空书仍可导出（至少保留书名页 / 封面信息）；只有「只导出定稿」没内容时才报错
      if (!list.length && onlyDone) return sendJson(res, 400, { error: '还没有已定稿的章节' });
      const suffix = onlyDone ? '_定稿版' : '';

      if (format === 'epub') {
        // EPUB 始终导出全书：单章电子书没有阅读价值，目录也按全书分卷生成
        const buf = buildEpub(n, list);
        const name = `${safeName(n.title)}${suffix}.epub`;
        res.writeHead(200, {
          'Content-Type': 'application/epub+zip',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          'Content-Length': buf.length,
          'Cache-Control': 'no-store',
        });
        return res.end(buf);
      }

      const text = format === 'md' ? exportMarkdown(n, list) : exportTxt(n, list);
      const name = `${safeName(n.title)}${suffix}${cid && list[0] ? `_第${list[0].no}章` : ''}.${format}`;
      res.writeHead(200, {
        'Content-Type': format === 'md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': 'no-store',
      });
      return res.end('\uFEFF' + text);
    }

    // 全书查找：命中章节 + 上下文片段
    if (seg[3] === 'search' && seg.length === 4 && method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return sendJson(res, 200, { q: '', total: 0, chapters: 0, truncated: false, results: [] });
      const n = getNovel(id);
      if (!n) return sendJson(res, 404, { error: '作品不存在' });
      const limit = Math.min(200, Math.max(10, Number(url.searchParams.get('limit')) || 80));
      return sendJson(res, 200, searchNovel(n, q, limit));
    }

    // 全书替换：先留一份快照，再逐章替换（支持标题）
    if (seg[3] === 'replace' && seg.length === 4 && method === 'POST') {
      const body = await readBody(req);
      const find = String(body.find || '');
      if (!find) return sendJson(res, 400, { error: '要替换的文字不能为空' });
      const to = String(body.replace ?? '');
      const n = getNovel(id);
      if (!n) return sendJson(res, 404, { error: '作品不存在' });
      const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), body.caseSensitive ? 'g' : 'gi');
      let count = 0;
      let chaptersTouched = 0;
      const swap = () => { count += 1; return to; };
      createSnapshot(n, { kind: 'before-replace', label: `替换「${find.slice(0, 12)}」前`, force: true });
      for (const ch of n.chapters || []) {
        const before = `${ch.content || ''}\u0000${ch.title || ''}`;
        ch.content = String(ch.content || '').replace(re, swap);
        if (body.inTitle) ch.title = String(ch.title || '').replace(re, swap);
        if (`${ch.content}\u0000${ch.title}` !== before) chaptersTouched += 1;
      }
      if (count) saveNovel(n);
      return sendJson(res, 200, { count, chapters: chaptersTouched });
    }

    // 导入已有文稿：按「第X章」切分，按「第X卷」分组。
    // 文件读取与编码识别在前端完成（浏览器才有 GBK 解码器），这里只认文本。
    if (seg[3] === 'import' && method === 'POST') {
      const body = await readBody(req);
      const n = getNovel(id);
      if (!n) return sendJson(res, 404, { error: '作品不存在' });
      const parsed = parseManuscript(body.text || '');
      if (!parsed.chapters.length) return sendJson(res, 400, { error: '没有识别到正文，检查一下文件是不是空的' });
      const volumes = parsed.volumes.map((v) => ({
        id: newId('v'),
        name: v.name,
        desc: '',
        chapters: [],
      }));
      const created = parsed.chapters.map((p) => {
        const ch = {
          id: newId('c'),
          title: p.title,
          summary: '',
          content: p.content,
          status: 'draft',
          stage: 'draft',
          memory: null,
          createdAt: Date.now(),
        };
        // 卷标题下面的章节写死归属；文件有分卷时，卷前的序言明确标成「未分卷」，
        // 免得追加到一本已有分卷的书里时，前言被上一卷吸走。
        if (p.volume != null && volumes[p.volume]) ch.volumeId = volumes[p.volume].id;
        else if (parsed.volumes.length) ch.volumeId = '';
        return ch;
      });
      if (volumes.length) n.outline.volumes.push(...volumes);
      n.chapters.push(...created);
      saveNovel(n);
      return sendJson(res, 200, {
        imported: created.length,
        volumes: volumes.length,
        volumeNames: volumes.map((v) => v.name),
        firstChapterId: created[0].id,
        novel: n,
      });
    }
  }

  /* --- 上下文预览 --- */
  if (seg[1] === 'context' && method === 'POST') {
    const body = await readBody(req);
    const { built, stats, pack } = prepareTask(loadConfig(), body);
    return sendJson(res, 200, {
      messages: built.messages,
      expect: built.expect,
      temperature: built.temperature,
      maxTokens: built.maxTokens,
      stats: { ...stats, lines: packSummaryLines(pack), packChars: (pack || []).join('').length },
    });
  }

  /* --- 流式生成 --- */
  if (seg[1] === 'ai' && seg[2] === 'stream' && method === 'POST') {
    const body = await readBody(req);
    const cfg = loadConfig();
    let messages = body.messages;
    let temperature = body.temperature;
    let maxTokens = body.maxTokens;
    let meta = {};

    if (!messages) {
      const prepared = prepareTask(cfg, body);
      messages = prepared.built.messages;
      temperature = prepared.built.temperature;
      maxTokens = prepared.built.maxTokens;
      meta = { stats: prepared.stats, lines: packSummaryLines(prepared.pack) };
    }

    const provider = resolveProvider(cfg, body.providerId);
    const model = body.model || resolveModel(cfg, provider, body.task || 'chapter');
    temperature = body.temperature ?? cfg.temperature ?? temperature;
    maxTokens = body.maxTokens ?? cfg.maxTokens ?? maxTokens;

    const ac = new AbortController();
    // 等响应头阶段也要有兜底：有些服务商/网关接了连接却什么都不回
    let timedOut = false;
    let idle = null;
    const arm = () => {
      clearTimeout(idle);
      if (IDLE_MS > 0) idle = setTimeout(() => { timedOut = true; ac.abort(); }, IDLE_MS);
    };
    req.on('close', () => { clearTimeout(idle); ac.abort(); });
    let upstream;
    try {
      arm();
      upstream = await callUpstream({ cfg, provider, model, messages, temperature, maxTokens, stream: true, signal: ac.signal });
      clearTimeout(idle);
    } catch (err) {
      clearTimeout(idle);
      if (timedOut) {
        return sendJson(res, 504, {
          error: `模型服务超过 ${Math.round(IDLE_MS / 1000)} 秒没有响应。请检查服务商地址是否正确、网络是否通畅，或换一个模型再试。`,
        });
      }
      return sendJson(res, 502, { error: `无法连接模型服务：${err.message}` });
    }
    if (!upstream.resp.ok) {
      const detail = await upstreamErrorText(upstream.resp);
      return sendJson(res, upstream.resp.status, { error: `模型返回错误（HTTP ${upstream.resp.status}）：${detail}` });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ shu_meta: { model, provider: provider.name || provider.baseUrl, ...meta } })}\n\n`);

    await relayCompletion({ res, upstream, abort: () => ac.abort() });
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
    return;
  }

  return sendJson(res, 404, { error: '接口不存在' });
}

/* ------------------------------------------------------------------ */
/* 导出 / 导入助手                                                     */
/* ------------------------------------------------------------------ */

function safeName(s) {
  return String(s || 'novel').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 60);
}

function exportTxt(n, chapters) {
  const head = [`《${n.title}》`, n.author ? `作者：${n.author}` : '', n.genre ? `类型：${n.genre}` : '', n.meta?.logline ? `简介：${n.meta.logline}` : '']
    .filter(Boolean)
    .join('\n');
  const plan = volumePlan(n);
  let lastVol = '';
  const body = chapters.map((c) => {
    const v = plan.of(c);
    // 每卷只在它的第一章前面写一次卷名
    const vor = v && v.id !== lastVol ? `\n\n${'-'.repeat(30)}\n${volumeLabel(v, v.no)}` : '';
    lastVol = v ? v.id : '';
    return `${vor}\n\n第${c.no}章 ${c.title}\n\n${(c.content || '').trim()}`;
  }).join('\n');
  return `${head}\n${'-'.repeat(30)}${body}\n`;
}

function exportMarkdown(n, chapters) {
  const lines = [`# ${n.title}`];
  if (n.author) lines.push(`作者：${n.author}`);
  if (n.genre) lines.push(`类型：${n.genre}`);
  if (n.meta?.logline) lines.push(`\n> ${n.meta.logline}`);
  if (n.meta?.synopsis) lines.push(`\n## 作品简介\n\n${n.meta.synopsis}`);
  lines.push('\n---\n');
  const plan = volumePlan(n);
  let lastVol = '';
  chapters.forEach((c) => {
    const v = plan.of(c);
    if (v && v.id !== lastVol) lines.push(`**${volumeLabel(v, v.no)}**\n`);
    lastVol = v ? v.id : '';
    lines.push(`## 第${c.no}章 ${c.title}\n`);
    lines.push((c.content || '').trim().split(/\n+/).map((p) => `　　${p}`).join('\n\n'));
    lines.push('');
  });
  return lines.join('\n');
}

/** 导出时用的分卷视图：按「章节 → 卷」的归属规则算出卷序号与卷名（见 store.js） */
function volumePlan(n) {
  const vols = n.outline?.volumes || [];
  const ids = chapterVolumeIds(n);
  const index = new Map((n.chapters || []).map((c, i) => [c.id, i]));
  return {
    of(chapter) {
      const i = index.get(chapter.id);
      const v = i === undefined ? null : vols.find((x) => x.id === ids[i]);
      return v ? { id: v.id, no: vols.indexOf(v) + 1, name: v.name || '未命名' } : null;
    },
  };
}

/* ------------------------------------------------------------------ */
/* 全书查找                                                            */
/* ------------------------------------------------------------------ */

const HITS_PER_CHAPTER = 20;
const LIBRARY_HITS_PER_CHAPTER = 5;

function hitSnippet(text, start, end, pad = 26) {
  const from = Math.max(0, start - pad);
  const to = Math.min(text.length, end + pad);
  return {
    start,
    before: (from > 0 ? '…' : '') + text.slice(from, start),
    match: text.slice(start, end),
    after: text.slice(end, to) + (to < text.length ? '…' : ''),
  };
}

function searchNovel(novel, q, limit) {
  const needle = q.toLowerCase();
  const results = [];
  let total = 0;
  let matchedChapters = 0;
  for (const ch of novel.chapters || []) {
    const text = String(ch.content || '');
    const hay = text.toLowerCase();
    if (!hay.includes(needle)) continue;
    matchedChapters += 1;
    let from = 0;
    const found = [];
    while (found.length < HITS_PER_CHAPTER) {
      const at = hay.indexOf(needle, from);
      if (at < 0) break;
      found.push({ start: at, end: at + needle.length });
      from = at + needle.length; // 不重复计入重叠命中
    }
    // 先把命中总数统计完整（只受每章上限约束），再决定要不要裁掉展示
    let all = found.length;
    let scan = from;
    while (all < 999) {
      const at = hay.indexOf(needle, scan);
      if (at < 0) break;
      all += 1;
      scan = at + needle.length;
    }
    total += all;
    if (results.length >= limit) continue;
    results.push({
      chapterId: ch.id,
      no: ch.no,
      title: ch.title || '未命名',
      count: all,
      hits: found.map((h) => hitSnippet(text, h.start, h.end)),
    });
  }
  return { q, total, chapters: matchedChapters, truncated: results.length < matchedChapters, results };
}

/** 跨作品检索：正文和章节标题都查，结果按作品分组展示 */
function searchLibrary(q, limit) {
  const needle = q.toLowerCase();
  if (!needle) return { q, total: 0, works: 0, chapters: 0, truncated: false, results: [] };
  const results = [];
  const workIds = new Set();
  let total = 0;
  let chapterCount = 0;
  let truncated = false;
  const allNovels = listNovels();
  if (allNovels.length > 300) truncated = true;

  for (const meta of allNovels.slice(0, 300)) {
    const n = getNovel(meta.id);
    if (!n) continue;
    let workMatched = false;

    (n.chapters || []).forEach((ch, i) => {
      const title = String(ch.title || '');
      const titleAt = title.toLowerCase().indexOf(needle);
      const text = String(ch.content || '');
      const hay = text.toLowerCase();
      let contentCount = 0;
      let from = 0;
      const hitStarts = [];

      while (contentCount < 999) {
        const at = hay.indexOf(needle, from);
        if (at < 0) break;
        contentCount += 1;
        if (hitStarts.length < LIBRARY_HITS_PER_CHAPTER) hitStarts.push(at);
        from = at + needle.length; // 不重复计入重叠命中
      }

      if (titleAt < 0 && !contentCount) return;
      chapterCount += 1;
      workMatched = true;
      total += contentCount + (titleAt >= 0 ? 1 : 0);
      if (results.length >= limit) { truncated = true; return; }

      results.push({
        novelId: n.id,
        novelTitle: n.title || '未命名作品',
        author: n.author || '',
        chapterId: ch.id,
        no: ch.no || i + 1,
        chapterTitle: title || '未命名',
        count: contentCount,
        titleHit: titleAt >= 0
          ? {
              start: titleAt,
              before: title.slice(0, titleAt),
              match: title.slice(titleAt, titleAt + needle.length),
              after: title.slice(titleAt + needle.length),
            }
          : null,
        hits: hitStarts.map((at) => hitSnippet(text, at, at + needle.length)),
      });
    });

    if (workMatched) workIds.add(n.id);
  }

  return {
    q,
    total,
    works: workIds.size,
    chapters: chapterCount,
    truncated: truncated || results.length < chapterCount,
    results,
  };
}

/* ------------------------------------------------------------------ */
/* 导入解析：卷标题 + 章标题                                            */
/* ------------------------------------------------------------------ */

const NUM_CN = '[0-9零一二三四五六七八九十百千两]+';
// 章标题：第1章 / 第一章 / 第 1 回 / 第1章：落霜；标题最多 40 字
const CHAPTER_RE = new RegExp(`^第\\s*${NUM_CN}\\s*[章节回](?:[ \\t　]+([^\\n\\r]{0,40}))?$`);
// 紧凑写法「第1章落霜」：标题里不能有句末标点，免得把「第一章正文。」当成标题
const CHAPTER_TIGHT_RE = new RegExp(`^第\\s*${NUM_CN}\\s*[章节回]([:：、.，,·\\-—]+)?([^\\n\\r。！？；…]{0,40})$`);
// 楔子、序章、番外这类没有编号的章节
const CHAPTER_ALT_RE = /^(序章|楔子|引子|序言|尾声|后记|番外(?:[0-9零一二三四五六七八九十百千两]+)?)(?:[ \t　:：、.，,·\-—]+([^\n\r]{0,40}))?$/;
// 卷标题：第一卷 少年游 / 第 1 部 / 卷一
const VOLUME_RE = new RegExp(`^第\\s*${NUM_CN}\\s*[卷部篇](?:[ \\t　]+([^\\n\\r]{0,50}))?$`);
const VOLUME_TIGHT_RE = new RegExp(`^第\\s*${NUM_CN}\\s*[卷部篇]([:：、.，,·\\-—]+)?([^\\n\\r。！？；…]{0,50})$`);
const VOLUME_SHORT_RE = new RegExp(`^卷\\s*${NUM_CN}(?:[ \\t　]+([^\\n\\r]{0,50}))?$`);
const VOLUME_SHORT_TIGHT_RE = new RegExp(`^卷\\s*${NUM_CN}([:：、.，,·\\-—]+)?([^\\n\\r。！？；…]{0,50})$`);

/** 去掉 Markdown 标题标记与整行加粗，留下可判断的纯标题文本 */
function cleanHeading(line) {
  return String(line || '')
    .trim()
    .replace(/^#{1,6}\s*/, '')
    .replace(/^>\s*/, '')
    .replace(/^(\*\*|\*|__|_|~~|`)\s*/, '')
    .replace(/\s*(\*\*|\*|__|_|~~|`)$/, '')
    .trim();
}

/** 判断一行是不是卷 / 章标题；是就返回结构化信息，不是返回 null */
function headingInfo(line) {
  const t = cleanHeading(line);
  if (!t) return null;
  let m = t.match(VOLUME_RE) || t.match(VOLUME_SHORT_RE);
  if (m) return { kind: 'volume', name: (m[1] || '').trim(), raw: t };
  m = t.match(VOLUME_TIGHT_RE) || t.match(VOLUME_SHORT_TIGHT_RE);
  if (m) return { kind: 'volume', name: (m[2] || '').trim(), raw: t };
  m = t.match(CHAPTER_RE);
  if (m) return { kind: 'chapter', title: (m[1] || '').trim() || t, raw: t };
  m = t.match(CHAPTER_TIGHT_RE);
  if (m) return { kind: 'chapter', title: (m[2] || '').trim() || t, raw: t };
  if (CHAPTER_ALT_RE.test(t)) return { kind: 'chapter', title: t, raw: t };
  return null;
}

/**
 * 把整份文稿拆成章节；卷标题之间的章节归入该卷。
 * 返回 { chapters: [{ title, content, volume }], volumes: [{ name }] }
 * volume 是 volumes 的下标，null 表示卷前的序言。
 * 没有章标题但只有卷标题时（比如按卷写的旧稿），每卷正文会变成一章。
 */
function parseManuscript(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!src) return { chapters: [], volumes: [] };
  const lines = src.split('\n');
  const marks = [];
  lines.forEach((line, i) => {
    const h = headingInfo(line);
    if (h) marks.push({ i, ...h });
  });
  if (!marks.length) return { chapters: [{ title: '导入内容', content: src, volume: null }], volumes: [] };

  const volumes = [];
  const chapters = [];
  let current = null;

  // 卷标题和下一个标题之间的文字：后面紧跟章标题就并进那一章，否则单独成章
  const flushIntro = () => {
    if (!current || !current.intro) return;
    chapters.push({
      title: current.name || current.raw || '导入内容',
      content: current.intro,
      volume: current.index,
    });
    current.intro = '';
  };

  const head = lines.slice(0, marks[0].i).join('\n').trim();
  if (head) chapters.push({ title: '前言', content: head, volume: null });

  marks.forEach((mk, k) => {
    const end = k + 1 < marks.length ? marks[k + 1].i : lines.length;
    const body = lines.slice(mk.i + 1, end).join('\n').trim();
    if (mk.kind === 'volume') {
      flushIntro();
      volumes.push({ name: mk.name });
      current = { index: volumes.length - 1, intro: body, name: mk.name, raw: mk.raw };
      return;
    }
    let content = body;
    if (current && current.intro) {
      content = `${current.intro}\n\n${content}`.trim();
      current.intro = '';
    }
    chapters.push({ title: mk.title, content, volume: current ? current.index : null });
  });
  flushIntro();

  // 丢掉一个字都没装的空卷，并把章节上的卷下标重新排好
  const used = new Set(chapters.map((c) => c.volume).filter((v) => v != null));
  const kept = [];
  const remap = new Map();
  volumes.forEach((v, i) => {
    if (!used.has(i)) return;
    remap.set(i, kept.length);
    kept.push(v);
  });
  for (const c of chapters) {
    if (c.volume != null) c.volume = remap.get(c.volume) ?? null;
  }
  return { chapters, volumes: kept };
}

/* ------------------------------------------------------------------ */
/* 静态文件                                                            */
/* ------------------------------------------------------------------ */

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(WEB_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(WEB_DIR)) return sendText(res, 403, 'Forbidden');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    // SPA 兜底
    const idx = path.join(WEB_DIR, 'index.html');
    if (fs.existsSync(idx)) return sendText(res, 200, fs.readFileSync(idx, 'utf8'), MIME['.html']);
    return sendText(res, 404, 'Not Found');
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(fs.readFileSync(file));
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    console.error('[error]', err);
    if (!res.headersSent) return sendJson(res, 500, { error: err.message || '服务器内部错误' });
    try { res.end(); } catch {}
  }
});

function listen(port, attempt = 0) {
  server.once('error', (err) => {
    // EADDRINUSE：端口被别的程序占着；EACCES：Windows 上对方独占绑定时报这个
    // （本机就可能被下载器之类的后台程序占住 8848），两种都往后顺延重试。
    if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && attempt < 20) {
      console.log(`端口 ${port} 被别的程序占着（${err.code}），改用 ${port + 1} …`);
      listen(port + 1, attempt + 1);
    } else {
      console.error('启动失败：', err.message);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    ensureDirs();
    const addr = `http://${HOST}:${port}`;
    console.log('');
    console.log('  ╭──────────────────────────────────────────────╮');
    console.log('  │   书匠 · AI 长篇小说创作台  已启动           │');
    console.log('  ╰──────────────────────────────────────────────╯');
    console.log(`   访问地址： ${addr}`);
    console.log(`   数据目录： ${DATA_DIR}`);
    console.log('   关闭窗口或按 Ctrl+C 即可停止');
    console.log('');
    if (process.env.SHU_NO_OPEN !== '1') {
      exec(`start "" "${addr}"`, { shell: 'cmd.exe' }, () => {});
    }
  });
}

ensureDirs();
listen(PORT);
