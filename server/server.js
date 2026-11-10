// 书匠 · AI 长篇小说创作台 —— 零依赖本地服务器
// 只监听 127.0.0.1，不对外暴露；所有数据落在项目内 data/ 目录。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import {
  ROOT, DATA_DIR, ensureDirs, loadConfig, saveConfig, maskKey,
  listNovels, createNovel, createSampleNovel, getNovel, saveNovel, deleteNovel, trashNovel, listTrash, restoreNovel, purgeTrash, purgeAllTrash, newId, countWords,
  listSnapshots, createSnapshot, readSnapshot, chapterVolumeIds, volumeLabel, chapterTitleText,
  findOutlineEntry, CHAPTER_STAGES, cleanTargetWords, cleanPalette,
  applyFragmentData,
} from './store.js';
import { nextChapterTitle } from '../web/lib/data.js';
import { buildTask, TASKS, TEMPLATE_SLOTS, TEMPLATE_VARS } from './prompts.js';
import { buildEpub } from './epub.js';
import { buildPrintHtml } from './print.js';
import { buildDocx } from './docx.js';
import { extractDocxText } from './docx-import.js';
import { outlineRows, characterRows, hasExtras, submissionFacts, submissionNote } from './manuscript.js';
import { coverSvg, readCoverImage, saveCoverImage, deleteCoverImage, coverOptions, coverKind } from './cover.js';
import { buildContext, collectScopeText, packSummaryLines } from './context.js';
import { addWords, setGoal, statsSummary, statsDay } from './stats.js';

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
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { tooBig = true; return; } // 继续排空，让 413 还能送到客户端
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) {
        const err = new Error('请求体过大');
        err.status = 413;
        reject(err);
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        const err = new Error('JSON 解析失败');
        err.status = 400;
        reject(err);
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
  if (!p) throw new Error('还没有配置模型服务商。请到「设置」里接入，或在书架点「一键开书」按提示完成。');
  if (!p.apiKey) throw new Error(`服务商「${p.name || p.baseUrl}」还没有填写 API Key。请到「设置」里补齐，或在书架点「一键开书」按提示完成。`);
  return p;
}

const ROLE_OF_TASK = {
  outline: 'write', characters: 'write', worldview: 'write', chapter: 'write',
  continue: 'write', polish: 'write', expand: 'write', shorten: 'write',
  rewrite: 'write', custom: 'write', titles: 'write', style: 'write', anno_fix: 'write',
  poison: 'write', hook: 'write', sensitivity: 'write', scene: 'write',
  memory: 'summary', consistency: 'summary', review: 'review',
};

const FRAGMENT_TYPES = [
  { key: 'outline', label: '大纲与分卷', icon: 'layers' },
  { key: 'scenes', label: '场景卡片', icon: 'columns' },
  { key: 'memories', label: '章节记忆', icon: 'book-open' },
  { key: 'characters', label: '人物卡', icon: 'user' },
  { key: 'world', label: '世界观', icon: 'globe' },
  { key: 'timeline', label: '时间线', icon: 'clock' },
  { key: 'beats', label: '结构/节拍', icon: 'pulse' },
  { key: 'arcs', label: '人物弧光', icon: 'arrow-right' },
  { key: 'relations', label: '关系图谱', icon: 'arrow-right' },
  { key: 'threads', label: '线索/伏笔', icon: 'search' },
  { key: 'style', label: '文风与规则', icon: 'pen' },
  { key: 'annotations', label: '批注/高亮', icon: 'highlighter' },
];

function resolveModel(cfg, provider, task) {
  const role = ROLE_OF_TASK[task] || 'write';
  const roles = cfg.roleModels || {};
  // 没单独配角色模型时：先按老规则用全局模型；再退回写作模型；
  // 最后才用模型列表第一个（可能是向量模型，只作兼容兜底）。
  return roles[role] || cfg.model || roles.write || (provider.models || [])[0] || '';
}

/* ------------------------------------------------------------------ */
/* 任务上下文准备                                                      */
/* ------------------------------------------------------------------ */

function prepareTask(cfg, body) {
  const { task, novelId, chapterId, payload = {}, customTemplates } = body;
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
    payload: { ...payload, scopeText, prevTail, taskName: task, templateKey: payload.templateKey || '' },
    // 请求体没带模板时回落配置里的：API 直调也能用上用户设定的模板
    customTemplates: customTemplates && Object.keys(customTemplates).length
      ? customTemplates
      : (cfg?.promptTemplates || {}),
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
  if (!modelName) throw new Error('还没有选择模型。请到「设置」里选一个，或在书架点「一键开书」按提示完成。');
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

/** 把服务商回来的报错翻成人话；保留一点关键信息，别只扔英文报错 */
function friendlyProviderError(message, status = 0) {
  const raw = String(message || '').trim();
  const text = `${status || ''} ${raw}`.toLowerCase();
  const has = (re) => re.test(text);
  if (has(/invalid.*api.*key|api.*key.*(invalid|incorrect|expired|missing)|invalid_request_error|unauthorized|authentication/i) || status === 401) {
    return 'API Key 不对或已失效。请到设置里重新填写 Key，再试一次。';
  }
  if (has(/quota|insufficient|rate.?limit|too many requests|余额|额度|频率/i) || status === 429) {
    return '额度不够，或请求太频繁。请检查服务商账户额度，稍后再试。';
  }
  if (has(/model.*(not found|does not exist|unknown|invalid|unsupported)|unsupported.*model|unknown model|not found.*model/i)
    || (status === 404 && has(/model/))) {
    return '服务商不认可这个模型。请到设置里换一个模型，或确认模型名。';
  }
  if (has(/forbidden|permission|no access|access denied/i) || status === 403) {
    return 'API Key 没有使用这个模型的权限。请检查 Key 是否开通了该模型，或换个模型。';
  }
  if (status === 404 || has(/not found|404/i)) {
    return '找不到这个地址或接口。请检查 Base URL 是否写对（比如有没有多一层 /v1）。';
  }
  if (status >= 500 || has(/bad gateway|service unavailable|gateway time-out|server error|internal error/i)) {
    return '服务商暂时出错了。可以稍后再试，或换一个模型 / 服务商。';
  }
  if (has(/certificate|cert|ssl|tls|self.signed|unable to verify/i)) {
    return 'HTTPS 证书校验失败。请确认 Base URL 是 https，且证书有效。';
  }
  if (has(/enotfound|eai_again|getaddrinfo|econnrefused|network|connect/i)) {
    return '连不上服务商。请检查 Base URL、网络和代理设置。';
  }
  return raw;
}

async function upstreamErrorText(resp) {
  const status = resp?.status || 0;
  try {
    const txt = (await resp.text()).trim();
    const j = tryJson(txt);
    let detail;
    if (j) {
      detail = j.error?.message || j.message || txt.slice(0, 600);
    } else {
      // 网关给的多半是 HTML 错误页，抽个标题出来就够，别把整页 HTML 糊到界面上
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(txt);
      const plain = (title ? title[1] : txt.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      detail = plain || (/^</.test(txt) ? '网关返回了一个网页（不是模型响应）' : txt.slice(0, 300));
    }
    return friendlyProviderError(detail, status);
  } catch {
    return friendlyProviderError(`HTTP ${status}`, status);
  }
}

/** 把 fetch 的底层网络错误翻成用户能照着查的一两句，别只甩 fetch failed */
function networkErrorText(err) {
  const raw = `${err?.code || ''} ${err?.cause?.code || ''} ${err?.message || ''}`;
  if (err?.name === 'AbortError' || /timeout|timed out|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(raw)) {
    return '连接服务商超时。请检查网络，或确认 Base URL 能打开。';
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) {
    return '找不到这个服务商地址。请检查 Base URL 是否写对。';
  }
  if (/ECONNREFUSED/i.test(raw)) {
    return '服务商拒绝了连接。请检查 Base URL 的地址和端口。';
  }
  if (/CERT|SSL|TLS|self.signed|UNABLE_TO_VERIFY/i.test(raw)) {
    return 'HTTPS 证书校验失败。请确认 Base URL 是 https，且证书有效。';
  }
  return '连不上服务商。请检查 Base URL、网络和代理设置。';
}

/** 上游一个字正文都没给时，尽量说清楚到底发生了什么 */
function describeEmptyBody(sniff, status = 0) {
  const t = (sniff || '').trim();
  const fallback = '模型这次没有返回任何内容。可能是模型名不对、额度用尽，或该模型的接口格式不兼容。';
  if (!t) return fallback;
  const j = tryJson(t);
  if (j) {
    if (j.error) {
      return friendlyProviderError(j.error.message || j.error.code || JSON.stringify(j.error).slice(0, 160), status);
    }
    if (j.message) return friendlyProviderError(String(j.message).slice(0, 160), status);
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
      fatal = friendlyProviderError(j.error.message || j.error.code || '模型返回错误', upstream.resp.status);
      return false;
    }
    if (j.message && !j.choices) {
      fatal = friendlyProviderError(String(j.message), upstream.resp.status);
      return false;
    }
    if (j.choices && (j.choices[0]?.finish_reason === 'length')) {
      // 达到 max_tokens 被截断：上游不回报错，但正文会半截停住——告诉前端，免得把半成品当成品
      sseWrite(res, { shu_notice: { kind: 'truncated', message: '模型输出被截断（达到 max_tokens），可能没写完。可以到 设置→模型 把最大长度调大，或点「续写」接着写。' } });
    }
    emit(deltaFromChunk(j));
    return true;
  };

  try {
    if (ct.includes('application/json')) {
      // 供应商无视 stream:true，直接返回完整回复
      const txt = await upstream.resp.text();
      const j = tryJson(txt);
      if (j) {
        if (j.choices && j.choices[0]?.finish_reason === 'length') {
          sseWrite(res, { shu_notice: { kind: 'truncated', message: '模型输出被截断（达到 max_tokens），可能没写完。可以到 设置→模型 把最大长度调大，或点「续写」接着写。' } });
        }
        emit(deltaFromChunk(j));
      }
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
  else if (!emitted) sseWrite(res, { shu_error: describeEmptyBody(sniffed, upstream.resp.status) });
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
  if (delta > 0) addWords(n.id, delta, new Date(), cid);
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

/* PUT 整书保存时的章节校验：拒绝 null / 非对象，重建缺失或过长的 id */
function sanitizeChapters(value, fallback) {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) return fallback;
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const ch = { ...item };
    let id = typeof ch.id === 'string' ? ch.id.trim() : '';
    if (!id || id.length > 64) id = newId('c');
    ch.id = id;
    ch.title = String(ch.title || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    ch.content = typeof ch.content === 'string' ? ch.content : String(ch.content ?? '');
    out.push(ch);
  }
  return out;
}

/** 设定库数组按「整份快照」保存：传了哪个数组就替换哪个，没传的数组保持原样 */
function replaceBibleArray(arr) {
  const map = new Map();
  for (const item of Array.isArray(arr) ? arr : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = item.id || newId('b');
    map.set(id, { ...item, id });
  }
  return [...map.values()];
}

/** PUT / POST 整本作品保存共用的合并逻辑（POST 用于 sendBeacon / keepalive） */
function mergeNovelUpdate(n, body) {
  const meta = { ...n.meta, ...(body.meta || {}) };
  meta.targetWords = cleanTargetWords(meta.targetWords);
  if (!['classic', 'minimal', 'band'].includes(meta.coverStyle)) meta.coverStyle = n.meta.coverStyle || '';
  meta.coverPalette = cleanPalette(meta.coverPalette);

  // 先保留旧设定库（只改 meta / 大纲时不会误清），再按本次带来的板块替换。
  const incomingBible = body.bible && typeof body.bible === 'object' && !Array.isArray(body.bible)
    ? body.bible
    : {};
  const bible = { ...(n.bible || {}), ...incomingBible };
  for (const key of ['characters', 'world', 'timeline']) {
    if (incomingBible[key] === undefined) continue;
    // 非数组一律保留旧值，别把设定库写成半个对象
    bible[key] = Array.isArray(incomingBible[key]) ? replaceBibleArray(incomingBible[key]) : (n.bible?.[key] || []);
  }

  // 封面信息也要过白名单：PUT 不能把 cover.ext 改成 `..\..\config.json`
  let cover = n.cover;
  if (body.cover === null) {
    try { deleteCoverImage(n.id, n.cover); } catch { /* 清完没关系 */ }
    cover = null;
  } else if (body.cover !== undefined) {
    const kind = coverKind(body.cover?.ext, body.cover?.mime);
    cover = kind
      ? {
          ext: kind.ext,
          mime: kind.media,
          size: Math.max(0, Number(body.cover.size) || 0),
          ts: Number(body.cover.ts) || Date.now(),
        }
      : n.cover;
  }

  const outline = body.outline && typeof body.outline === 'object' && !Array.isArray(body.outline)
    ? { ...(n.outline || { volumes: [], notes: '' }), ...body.outline }
    : (n.outline || { volumes: [], notes: '' });
  const chapters = sanitizeChapters(body.chapters, n.chapters);
  return {
    ...n,
    ...body,
    id: n.id,
    createdAt: n.createdAt,
    cover,
    meta,
    bible,
    outline,
    chapters,
  };
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
            // GET 专有字段（apiKeyMasked / apiKeySet）不能落盘
            const { apiKeyMasked, apiKeySet, ...clean } = p;
            return { ...prev, ...clean, id: clean.id || newId('p'), apiKey };
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

  // 某一天的明细：点开写作日历上的某一天
  if (seg[1] === 'stats' && seg[2] === 'day' && seg.length === 3 && method === 'GET') {
    return sendJson(res, 200, statsDay(url.searchParams.get('date')));
  }

  /* --- Word 导入：只解析，不写盘；预览确认后再走作品导入接口 --- */
  if (seg[1] === 'import' && seg[2] === 'docx' && seg.length === 3 && method === 'POST') {
    let buf;
    try {
      buf = await readBinary(req, 20 * 1024 * 1024, 'Word 文件');
    } catch (err) {
      return sendJson(res, 400, { error: err.message || '读取 Word 文件失败' });
    }
    try {
      return sendJson(res, 200, extractDocxText(buf));
    } catch (err) {
      return sendJson(res, 400, { error: `读不了这个 Word 文件：${err.message}` });
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
      return sendJson(res, 200, { ok: false, error: networkErrorText(err) });
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

  /* --- 内置示例作品：复制成一部新书，不联网 --- */
  if (seg[1] === 'novels' && seg[2] === 'sample' && seg.length === 3 && method === 'POST') {
    req.resume(); // 这个接口不用请求体；排空，避免连接在响应后被重置
    try {
      return sendJson(res, 200, { novel: createSampleNovel() });
    } catch (err) {
      return sendJson(res, 500, { error: err.message || '示例作品创建失败' });
    }
  }

  /* --- 全局检索：在所有作品正文与章节标题中查找 --- */
  if (seg[1] === 'library-search' && seg.length === 2 && method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
    if (!q) return sendJson(res, 200, { q: '', total: 0, works: 0, chapters: 0, truncated: false, results: [] });
    const limit = Math.min(120, Math.max(10, Number(url.searchParams.get('limit')) || 60));
    return sendJson(res, 200, searchLibrary(q, limit));
  }

  /* --- 回收站 --- */
  if (seg[1] === 'trash' && seg.length === 2) {
    if (method === 'GET') return sendJson(res, 200, { items: listTrash() });
    if (method === 'DELETE') return sendJson(res, 200, { ok: true, removed: purgeAllTrash() });
  }

  if (seg[1] === 'trash' && seg[2] && seg.length === 3 && method === 'DELETE') {
    if (!purgeTrash(seg[2])) return sendJson(res, 404, { error: '回收站条目不存在' });
    return sendJson(res, 200, { ok: true });
  }

  if (seg[1] === 'trash' && seg[2] && seg[3] === 'restore' && seg.length === 4 && method === 'POST') {
    req.resume(); // 这个接口不用请求体
    const result = restoreNovel(seg[2]);
    if (result.error) return sendJson(res, result.status || 400, { error: result.error });
    return sendJson(res, 200, { ok: true, novel: result.novel });
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
      if (url.searchParams.get('permanent') === '1') {
        if (!deleteNovel(id, { keepBackup: false })) return sendJson(res, 404, { error: '作品不存在' });
        return sendJson(res, 200, { ok: true, permanent: true });
      }
      const moved = trashNovel(id);
      if (!moved) return sendJson(res, 404, { error: '作品不存在' });
      return sendJson(res, 200, { ok: true, trash: moved });
    }
    /* ------------------------------------------------------------------ */
    /* 导入旧稿 / 导出备份                                                    */
    /* ------------------------------------------------------------------ */
    if ((method === 'PUT' || method === 'POST') && seg.length === 3) {
      const body = await readBody(req);
      const n = getNovel(id);
      if (!n) return sendJson(res, 404, { error: '作品不存在' });
      return sendJson(res, 200, { novel: saveNovel(mergeNovelUpdate(n, body)) });
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
      // 恢复本身不是“手滑删大段”：别再额外留一份 before-shrink
      saveNovel(snap, { skipShrink: true });
      return sendJson(res, 200, { novel: snap });
    }

    // 只恢复某一章的正文：标题、阶段、目标、章纲、记忆、场景、批注都保留，
    // 其他章节也不动。恢复前同样强制留一份快照，错了可以再撤回。
    if (seg[3] === 'restore-chapter' && seg.length === 4 && method === 'POST') {
      const body = await readBody(req);
      const ts = Number(body.ts);
      if (!Number.isInteger(ts) || ts <= 0) return sendJson(res, 400, { error: '快照时间无效' });
      const chapterId = typeof body.chapterId === 'string' ? body.chapterId : '';
      if (!chapterId) return sendJson(res, 400, { error: '缺少章节 id' });
      const n = getNovel(id);
      if (!n) return sendJson(res, 404, { error: '作品不存在' });
      const snap = readSnapshot(id, ts);
      if (!snap) return sendJson(res, 404, { error: '快照不存在或已被清理' });
      const snapCh = (snap.chapters || []).find((c) => c?.id === chapterId);
      if (!snapCh) return sendJson(res, 404, { error: '这一版里没有这一章，无法恢复' });
      const i = n.chapters.findIndex((c) => c.id === chapterId);
      if (i < 0) return sendJson(res, 404, { error: '章节不存在或已被删除' });
      const title = n.chapters[i].title || '未命名';
      createSnapshot(n, { kind: 'before-restore', label: `恢复本章前：${title}`, force: true });
      // 直接改内存里的章节再 saveNovel，不走 writeChapter：恢复旧文不该算进今日码字量
      n.chapters[i].content = snapCh.content || '';
      saveNovel(n, { skipShrink: true });
      return sendJson(res, 200, { chapter: n.chapters[i] });
    }

    // 章节集合
    if (seg[3] === 'chapters') {
      const n = getNovel(id);
      if (!n) return sendJson(res, 404, { error: '作品不存在' });

      if (method === 'POST' && seg.length === 4) {
        const body = await readBody(req);
        const ch = {
          id: newId('c'),
          title: body.title || nextChapterTitle(n.chapters),
          summary: body.summary || '',
          content: body.content || '',
          status: 'draft',
          // 写作阶段：拆分本章时新章要继承原章的阶段（见 web/app.js 的 openSplitChapterModal），
          // 传了合法值就照用，没传才算草稿。
          stage: CHAPTER_STAGES.has(body.stage) ? body.stage : 'draft',
          targetWords: cleanTargetWords(body.targetWords),
          outline: body.outline || null,
          // 章纲可以一开始就挂上（大纲驱动的建章流程用得上）；只认真的存在的章纲 id
          outlineId: (() => {
            const oid = typeof body.outlineId === 'string' ? body.outlineId : '';
            if (!oid) return '';
            const exists = (n.outline?.volumes || []).some((v) => (v.chapters || []).some((o) => o?.id === oid));
            return exists ? oid : '';
          })(),
          memory: null,
          // 拆分 / 合并章节时要把批注一起迁过去，新章可以直接带上来
          annotations: Array.isArray(body.annotations) ? body.annotations : [],
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

    // 封面：上传 / 查看 / 移除
    if (seg[3] === 'cover' && seg.length === 4) {
      const n = getNovel(id);
      if (!n) return sendJson(res, 404, { error: '作品不存在' });
      if (method === 'GET') {
        // 看自定义封面；没有就回自动生成的那张。
        // 带 style / palette 参数时按参数现画一张，用来在界面上预览还没保存的选择。
        const style = url.searchParams.get('style');
        const palette = url.searchParams.get('palette');
        if (style || palette) {
          const svg = coverSvg(n, {
            words: (n.chapters || []).reduce((s, c) => s + countWords(c.content), 0),
            chapters: (n.chapters || []).length,
          }, { style: style || undefined, palette: palette === null || palette === '' ? undefined : palette });
          res.writeHead(200, {
            'Content-Type': 'image/svg+xml; charset=utf-8',
            'Content-Length': Buffer.byteLength(svg),
            'Cache-Control': 'no-store',
          });
          return res.end(svg);
        }
        const custom = readCoverImage(n);
        if (custom) {
          res.writeHead(200, {
            'Content-Type': custom.mime,
            'Content-Length': custom.data.length,
            'Cache-Control': 'no-store',
          });
          return res.end(custom.data);
        }
        const svg = coverSvg(n, {
          words: (n.chapters || []).reduce((s, c) => s + countWords(c.content), 0),
          chapters: (n.chapters || []).length,
        });
        res.writeHead(200, {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Content-Length': Buffer.byteLength(svg),
          'Cache-Control': 'no-store',
        });
        return res.end(svg);
      }
      if (method === 'POST') {
        let buf;
        try {
          buf = await readBinary(req, 9 * 1024 * 1024);
        } catch (err) {
          return sendJson(res, 400, { error: err.message || '读取图片失败' });
        }
        let meta;
        try {
          meta = saveCoverImage(id, buf, req.headers['content-type']);
        } catch (err) {
          return sendJson(res, 400, { error: err.message || '保存封面失败' });
        }
        n.cover = meta;
        saveNovel(n);
        return sendJson(res, 200, { ok: true, cover: meta });
      }
      if (method === 'DELETE') {
        deleteCoverImage(id, n.cover);
        delete n.cover;
        saveNovel(n);
        return sendJson(res, 200, { ok: true });
      }
    }

    // 导出
    if (seg[3] === 'export' && method === 'GET') {
      const n = getNovel(id);
      if (!n) return sendJson(res, 404, { error: '作品不存在' });
      const raw = url.searchParams.get('format');
      const format = ['md', 'epub', 'docx', 'json', 'print', 'pdf'].includes(raw) ? raw : 'txt';
      // 整本作品备份：原样导出作品 JSON，保留正文、设定、大纲、记忆和修订；
      // 恢复时由前端新建一部作品，不覆盖现有稿件。
      if (format === 'json') {
        // 自定义封面是单独的文件（data/covers/<id>.<ext>），不进作品 JSON；
        // 备份要能换机恢复，所以把图片 base64 内嵌进来（上限 8 MB，体积可控）。
        const coverImg = readCoverImage(n);
        const backup = coverImg
          ? { ...n, cover: { ...n.cover, data: coverImg.data.toString('base64') } }
          : n;
        const body = JSON.stringify(backup, null, 2);
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
      // 章节区间：投稿常常只要「前 30 章」这样的样章，不用为此删章节
      const range = chapterRange(n, url.searchParams.get('from'), url.searchParams.get('to'));
      if (range?.empty) return sendJson(res, 400, { error: '这个章节区间里没有章节' });
      const base = range ? range.chapters : n.chapters;
      // 只导出定稿只作用于「全书 / 区间」；当前章导出是作者明确指定的，不受状态限制
      const onlyDone = !cid && url.searchParams.get('only') === 'done';
      const doneList = onlyDone ? base.filter((c) => c.stage === 'done') : base;
      const list = format === 'epub'
        ? doneList                              // EPUB 忽略 chapterId，只认全书 / 区间
        : (cid ? n.chapters.filter((c) => c.id === cid) : doneList);
      // 空书仍可导出（至少保留书名页 / 封面信息）；只有「只导出定稿」没内容时才报错
      if (!list.length && onlyDone) return sendJson(res, 400, { error: '还没有已定稿的章节' });
      const suffix = `${range ? (range.lo === range.hi ? `_第${range.lo}章` : `_第${range.lo}-${range.hi}章`) : ''}${onlyDone ? '_定稿版' : ''}`;
      // 随稿附带的材料：extras=outline,characters；note=1 是投稿附言（放在最前面）
      const extras = {
        outline: (url.searchParams.get('extras') || '').split(',').includes('outline'),
        characters: (url.searchParams.get('extras') || '').split(',').includes('characters'),
        note: url.searchParams.get('note') === '1',
        // 区间导出时在稿件头部 / 书名页标成「节选」
        range: range ? { lo: range.lo, hi: range.hi } : null,
        // 打印稿的书名页要写清是单章还是定稿版
        single: !!cid,
        onlyDone,
        // PDF 导出：页面加载后自动弹打印对话框
        autoprint: format === 'pdf',
        // 打印版式：纸张 / 字号 / 行距 / 是否含书名页；非法值由 normalizePrintLayout 兜底
        layout: {
          paper: url.searchParams.get('paper'),
          font: url.searchParams.get('font'),
          leading: url.searchParams.get('leading'),
          title: url.searchParams.get('notitle') !== '1',
        },
      };

      // 打印稿 / PDF：返回一份可以直接打印的 HTML，浏览器打印对话框里可另存为 PDF
      if (format === 'print' || format === 'pdf') {
        const html = buildPrintHtml(n, list, extras);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(html),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end(html);
      }

      // Word（.docx）：给编辑一份可以直接改的稿子，每章另起一页
      if (format === 'docx') {
        const buf = buildDocx(n, list, extras);
        const name = `${safeName(n.title)}${suffix}${cid && list[0] ? `_第${list[0].no}章` : ''}.docx`;
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          'Content-Length': buf.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end(buf);
      }

      if (format === 'epub') {
        // EPUB 忽略 chapterId（单章电子书没有阅读价值），但认「全书 / 区间」
        const buf = buildEpub(n, list, extras);
        const name = `${safeName(n.title)}${suffix}.epub`;
        res.writeHead(200, {
          'Content-Type': 'application/epub+zip',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          'Content-Length': buf.length,
          'Cache-Control': 'no-store',
        });
        return res.end(buf);
      }

      const text = format === 'md' ? exportMarkdown(n, list, extras) : exportTxt(n, list, extras);
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

    /* --- 片段导入 --- */
    if (seg[3] === 'import-fragment' && method === 'POST') {
      const body = await readBody(req);
      const n = getNovel(id);
      if (!n) return sendJson(res, 404, { error: '作品不存在' });
      
      const pkg = body;
      if (!pkg || !pkg.type || !FRAGMENT_TYPES.some(t => t.key === pkg.type)) {
        return sendJson(res, 400, { error: '无效的片段类型' });
      }
      
      try {
        const n = getNovel(id);
        const result = await applyFragmentData(n, pkg, { merge: body.merge !== false, overwrite: body.overwrite === true });
        saveNovel(n);
        const label = FRAGMENT_TYPES.find(t => t.key === pkg.type).label;
        // 有条目因为「找不到对应章节」被跳过时要说明，否则用户会以为导入成功了
        const skipped = result?.skipped || 0;
        return sendJson(res, 200, {
          ok: true,
          type: pkg.type,
          applied: result?.applied || 0,
          skipped,
          message: skipped
            ? `已导入 ${label}，但有 ${skipped} 条找不到对应章节被跳过（章节 id 对不上时会这样）`
            : `已导入 ${label}`,
        });
      } catch (err) {
        return sendJson(res, 400, { error: `导入失败：${err.message}` });
      }
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

  /* --- 可自定义提示词的任务清单（设置界面的下拉框读这个） --- */
  if (seg[1] === 'prompt-slots' && method === 'GET') {
    return sendJson(res, 200, { slots: TEMPLATE_SLOTS, vars: TEMPLATE_VARS });
  }

  /* --- 封面可选的版式与配色 --- */
  if (seg[1] === 'cover-options' && method === 'GET') {
    return sendJson(res, 200, coverOptions());
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
    // 4096 是历史默认，实际会截断中文长文；遇到历史默认时让任务自带的预算（chapter 6000）生效
    maxTokens = body.maxTokens ?? (cfg.maxTokens && cfg.maxTokens !== 4096 ? cfg.maxTokens : maxTokens);

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
      return sendJson(res, 502, { error: `无法连接模型服务：${networkErrorText(err)}` });
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

  // 兜底 404 也不能把请求体留在连接里：对端带 body 时会表现成“200 + 空响应”或连接重置
  if (method !== 'GET' && method !== 'HEAD') req.resume();
  return sendJson(res, 404, { error: '接口不存在' });
}

/* ------------------------------------------------------------------ */
/* 导出 / 导入助手                                                     */
/* ------------------------------------------------------------------ */

function safeName(s) {
  return String(s || 'novel').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 60);
}

/** 全书正文字数：投稿附言里的「全书约 N 字」说的永远是整本，不是本次导出的那几章 */
function bookWords(novel) {
  return (novel.chapters || []).reduce((sum, c) => sum + countWords(c.content), 0);
}

/**
 * 导出用的章节区间（按章号，含两端）。
 * 返回 null 表示没要求区间（导全书）；{ empty: true } 表示这区间里一章都没有。
 * 填反了自动换过来、超出书本范围的夹回去——导出窗口上不该因为填错就报错。
 */
function chapterRange(novel, fromRaw, toRaw) {
  let lo = Math.floor(Number(fromRaw) || 0);
  let hi = Math.floor(Number(toRaw) || 0);
  if (!lo && !hi) return null;
  const nos = (novel.chapters || []).map((c) => Number(c.no) || 0).filter((x) => x > 0);
  if (!nos.length) return { empty: true, lo: 0, hi: 0, chapters: [] };
  const min = Math.min(...nos);
  const max = Math.max(...nos);
  if (!lo) lo = min;
  if (!hi) hi = max;
  if (lo > hi) [lo, hi] = [hi, lo];
  // 整段都落在书外就当没这回事，别默默导出最后一章
  if (hi < min || lo > max) return { empty: true, lo, hi, chapters: [] };
  lo = Math.max(min, lo);
  hi = Math.min(max, hi);
  if (lo > hi) return { empty: true, lo, hi, chapters: [] };
  return {
    lo,
    hi,
    chapters: (novel.chapters || []).filter((c) => {
      const no = Number(c.no) || 0;
      return no >= lo && no <= hi;
    }),
  };
}

/** 投稿附言（TXT）：编辑拆开文件先看到信，再看到稿子 */
function txtNote(novel, words) {
  const lines = ['创作说明', ''];
  for (const f of submissionFacts(novel, words)) lines.push(`${f.label}：${f.value}`);
  const note = submissionNote(novel);
  if (note) lines.push('', '给编辑的话：', '', note);
  return lines.join('\n');
}

function exportTxt(n, chapters, extras = {}) {
  const head = [
    `《${n.title}》`,
    n.author ? `作者：${n.author}` : '',
    n.meta?.contact ? `联系方式：${n.meta.contact}` : '',
    n.genre ? `类型：${n.genre}` : '',
    // 只导出一段时标成节选，免得被当成全书
    extras.range ? `节选：第${extras.range.lo === extras.range.hi ? extras.range.lo : `${extras.range.lo}-${extras.range.hi}`}章` : '',
    n.meta?.logline ? `简介：${n.meta.logline}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const plan = volumePlan(n);
  let lastVol = '';
  const body = chapters.map((c) => {
    const v = plan.of(c);
    // 每卷只在它的第一章前面写一次卷名
    const vor = v && v.id !== lastVol ? `\n\n${'-'.repeat(30)}\n${volumeLabel(v, v.no)}` : '';
    lastVol = v ? v.id : '';
    return `${vor}\n\n第${c.no}章${chapterTitleText(c.title) ? ` ${chapterTitleText(c.title)}` : ''}\n\n${(c.content || '').trim()}`;
  }).join('\n');
  const front = extras.note ? `${txtNote(n, bookWords(n))}\n\n${'='.repeat(32)}\n\n` : '';
  return `${front}${head}\n${'-'.repeat(30)}${body}\n`;
}

function exportMarkdown(n, chapters, extras = {}) {
  // 前置页用机器可读标记包住：书匠自己回导时整块跳过，不会凭空多一章「前言」
  const lines = ['<!-- shujiang:frontmatter -->', `# ${n.title}`];
  if (n.author) lines.push(`作者：${n.author}`);
  if (n.meta?.contact) lines.push(`联系方式：${n.meta.contact}`);
  if (n.genre) lines.push(`类型：${n.genre}`);
  if (extras.range) lines.push(`节选：第${extras.range.lo === extras.range.hi ? extras.range.lo : `${extras.range.lo}-${extras.range.hi}`}章`);
  if (n.meta?.logline) lines.push(`\n> ${n.meta.logline}`);
  if (n.meta?.synopsis) lines.push(`\n## 作品简介\n\n${n.meta.synopsis}`);
  // 投稿附言：放在正文之前，跟简介同属前置页
  if (extras.note) {
    const block = ['## 创作说明', ''];
    for (const f of submissionFacts(n, bookWords(n))) block.push(`- **${f.label}**：${f.value}`);
    const note = submissionNote(n);
    if (note) {
      // 作者自己就是「一行一段」的写法，跟正文的处理保持一致
      const paras = note.replace(/\r\n?/g, '\n').split('\n').map((s) => s.trim()).filter(Boolean);
      block.push('', '给编辑的话：', '', paras.join('\n\n'));
    }
    lines.push(`\n${block.join('\n')}`);
  }
  lines.push('\n---\n', '<!-- /shujiang:frontmatter -->');
  const plan = volumePlan(n);
  let lastVol = '';
  chapters.forEach((c) => {
    const v = plan.of(c);
    if (v && v.id !== lastVol) lines.push(`**${volumeLabel(v, v.no)}**\n`);
    lastVol = v ? v.id : '';
    const title = chapterTitleText(c.title);
    lines.push(`## 第${c.no}章${title ? ` ${title}` : ''}\n`);
    lines.push((c.content || '').trim().split(/\n+/).map((p) => `　　${p}`).join('\n\n'));
    lines.push('');
  });
  // 附带材料：放在正文后面，方便编辑连着看；同样用标记包住，回导时整段跳过
  if (extras.outline) {
    const o = outlineRows(n, chapters);
    if (o.volumes.length) {
      // 分隔线也包进标记里：回导时整块丢掉，不会在末章正文留下一条 ---
      lines.push('\n<!-- shujiang:outline -->\n---\n');
      lines.push('## 全书大纲\n');
      for (const v of o.volumes) {
        lines.push(`### ${volumeLabel(v, v.no)}\n`);
        if (v.desc) lines.push(`> ${v.desc}\n`);
        for (const e of v.entries) {
          lines.push(`**${e.no ? `第${e.no}章 ` : ''}${e.title}**${e.words ? `　（${e.words} 字）` : ''}\n`);
          for (const f of e.fields) lines.push(`- ${f.label}：${f.value}`);
          lines.push('');
        }
      }
      if (o.missing) lines.push(`\n> 另有 ${o.missing} 章还没写章纲。\n`);
      lines.push('<!-- /shujiang:outline -->');
    }
  }
  if (extras.characters) {
    const rows = characterRows(n);
    if (rows.length) {
      lines.push('\n<!-- shujiang:characters -->\n---\n');
      lines.push('## 人物小传\n');
      for (const c of rows) {
        lines.push(`### ${c.name}\n`);
        for (const f of c.fields) lines.push(`- ${f.label}：${f.value}`);
        if (c.relations.length) {
          lines.push(`- 关系：${c.relations.map((r) => `与 ${r.to}（${r.type}${r.note ? ` · ${r.note}` : ''}）`).join('；')}`);
        }
        lines.push('');
      }
      lines.push('<!-- /shujiang:characters -->');
    }
  }
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

/**
 * 紧凑写法很容易把行文误判成标题：「第1章的内容」「第2卷的结局」这类句子
 * 长得和标题一模一样。中文标题极少以这些虚词开头，所以标题若以它们开头，
 * 基本可以断定这是行文，不该切章。
 */
const PROSE_LEAD_RE = /^[的了地得着之是在这那我你他她它们把被从向对给让说就也都还又很不要会能可以个已将更最只]/;

/** 判断一行是不是卷 / 章标题；是就返回结构化信息，不是返回 null */
function headingInfo(line) {
  const t = cleanHeading(line);
  if (!t) return null;
  // 全书大纲里的大纲条目行：「第1章 雪落长安村**　（382 字）」是给人看的统计，不是章标题
  if (/[（(]\s*[\d,，]+\s*字\s*[）)]\s*$/.test(t)) return null;
  let m = t.match(VOLUME_RE) || t.match(VOLUME_SHORT_RE);
  if (m) {
    const name = (m[1] || '').trim();
    return { kind: 'volume', name, raw: t };
  }
  m = t.match(VOLUME_TIGHT_RE) || t.match(VOLUME_SHORT_TIGHT_RE);
  if (m) {
    const name = (m[2] || '').trim();
    if (name && PROSE_LEAD_RE.test(name)) return null;   // 「第1卷的结局」是行文
    return { kind: 'volume', name, raw: t };
  }
  m = t.match(CHAPTER_RE);
  if (m) {
    // 带空格的章标题基本不会是行文：「第2章 她又笑了」要照常切章（虚词判断只留给紧凑写法）
    const title = (m[1] || '').trim();
    return { kind: 'chapter', title: title || t, raw: t };
  }
  m = t.match(CHAPTER_TIGHT_RE);
  if (m) {
    const title = (m[2] || '').trim();
    if (title && PROSE_LEAD_RE.test(title)) return null;  // 「第1章的内容」是行文
    return { kind: 'chapter', title: title || t, raw: t };
  }
  if (CHAPTER_ALT_RE.test(t)) return { kind: 'chapter', title: t, raw: t };
  return null;
}

/** 去掉导出时加的机器可读标记块（前置页 / 全书大纲 / 人物小传） */
function stripMarkedBlocks(text) {
  return String(text || '').replace(
    /<!--\s*shujiang:(?:frontmatter|outline|characters)\s*-->[\s\S]*?<!--\s*\/shujiang:(?:frontmatter|outline|characters)\s*-->/g,
    '\n',
  );
}

/** 旧版导出的 Markdown / TXT 没有标记：靠结构认出前置页，别把它当成「前言」 */
function looksLikeFrontMatter(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  const first = lines[0] || '';
  const startsLikeTitle = /^#\s+\S/.test(first) || /^《.+》$/.test(first) || first === '创作说明';
  if (!startsLikeTitle) return false;
  // 只有一行标题（外加分隔线）也算前置页：没有作者 / 类型时，导出就只剩这一行
  const bodyLines = lines.filter((l) => !/^-{3,}$/.test(l) && !/^={3,}$/.test(l));
  if (bodyLines.length <= 1) return true;
  // 旧版导出在正文前一定有一条 --- / === 分隔线；序言里随口提到「作者：」不会长这样
  if (!/^([-*_=])\1{2,}$/.test(lines[lines.length - 1] || '')) return false;
  return /(^|\n)\s*(作者|类型|联系方式|节选|简介)[:：]/.test(t)
    || /(^|\n)\s*##\s*(作品简介|创作说明)/.test(t);
}

/** 旧版导出的附录（全书大纲 / 人物小传）没有标记：见到这些标题就停止收集正文 */
const LEGACY_APPENDIX_HEADS = new Set(['全书大纲', '人物小传', '创作说明']);

/**
 * 正文里也可能独立成行地出现「全书大纲」「创作说明」这些词（作者在行文里提到它们）。
 * 只有长得像旧版导出的附录标题时才截断：Markdown 标题行，或紧跟在 --- 分隔线后面；
 * 否则会把后面的章节整段吞掉，而且导入时没有任何提示。
 */
function isLegacyAppendixHead(line, prevLine) {
  const raw = String(line || '').trim();
  if (!LEGACY_APPENDIX_HEADS.has(cleanHeading(raw))) return false;
  if (/^#{1,6}[ \t　]+\S/.test(raw)) return true;
  return /^([-*_])\1{2,}$/.test(String(prevLine || '').trim());
}

/**
 * 把整份文稿拆成章节；卷标题之间的章节归入该卷。
 * 返回 { chapters: [{ title, content, volume }], volumes: [{ name }] }
 * volume 是 volumes 的下标，null 表示卷前的序言。
 * 没有章标题但只有卷标题时（比如按卷写的旧稿），每卷正文会变成一章。
 */
function parseManuscript(text) {
  const src = stripMarkedBlocks(text).replace(/\r\n?/g, '\n').trim();
  if (!src) return { chapters: [], volumes: [] };
  let lines = src.split('\n');

  // 旧版导出（没有标记）：附录标题之后的内容不是正文，整段丢掉
  let seenHeading = false;
  let appendixAt = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const t = cleanHeading(lines[i]);
    if (!t) continue;
    if (seenHeading && isLegacyAppendixHead(lines[i], lines[i - 1])) { appendixAt = i; break; }
    if (headingInfo(lines[i])) seenHeading = true;
  }
  if (appendixAt >= 0) {
    lines = lines.slice(0, appendixAt);
    // 附录前那条 --- 分隔线也一并去掉
    while (lines.length && /^-{3,}\s*$/.test((lines[lines.length - 1] || '').trim())) lines.pop();
  }

  const marks = [];
  lines.forEach((line, i) => {
    const h = headingInfo(line);
    if (h) marks.push({ i, ...h });
  });
  if (!marks.length) return { chapters: [{ title: '导入内容', content: lines.join('\n').trim(), volume: null }], volumes: [] };

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
  // 书匠自己导出的前置页（书名 / 作者 / 简介 / 创作说明）是元数据，不是正文
  if (head && !looksLikeFrontMatter(head)) chapters.push({ title: '前言', content: head, volume: null });

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
/* 二进制请求体（上传封面图 / Word 文件），不走 JSON 解析              */
/* ------------------------------------------------------------------ */

function readBinary(req, limit = 8 * 1024 * 1024, label = '图片') {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { tooBig = true; return; } // 继续排空，错误响应才送得出去
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) {
        const err = new Error(`${label}太大了（上限 ${Math.round(limit / 1024 / 1024)} MB）`);
        err.status = 413;
        reject(err);
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* 静态文件                                                            */
/* ------------------------------------------------------------------ */

function serveStatic(req, res, url) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return sendText(res, 400, 'Bad Request');
  }
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

// 跨源防护：书匠只服务本机浏览器 / Electron。凡是带 Origin 的请求，
// 来源必须是本机 http(s) 地址，否则一律 403。
// 浏览器对跨源 POST（含 text/plain 的 simple request）一定会带 Origin，
// 配合只监听 127.0.0.1，可挡住网页“隔空”驱动本机 API（烧模型额度、乱建作品等）。
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl / 直接调用：不代替浏览器做判断
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${HOST}:${PORT}`);
  } catch {
    // 非法 request-target（如 `GET http://[::1`）不能让整个进程崩掉
    return sendJson(res, 400, { error: '请求地址不合法' });
  }
  try {
    if (!originAllowed(req)) return sendJson(res, 403, { error: '只接受本机来源的请求' });
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    console.error('[error]', err);
    const status = Number(err?.status) || 500;
    if (!res.headersSent) return sendJson(res, status, { error: err.message || '服务器内部错误' });
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
    // 让桌面主进程知道服务端实际绑定的端口（端口被占会自动往后顺延）
    process.env.SHU_BOUND_PORT = String(port);
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
