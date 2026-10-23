// 书匠 · 回归自检
// ---------------------------------------------------------------------------
// 用法（先启动服务，再跑这个）：
//   tools\node\node.exe dev\mock-openai.js        （另开一个窗口，可选）
//   tools\node\node.exe server\server.js
//   tools\node\node.exe dev\regress.mjs
//
// 覆盖的都是「接口返回成功但实际没生效」这类隐蔽问题：
//   - 提示词模板的变量插值 / 任务键区分 / 空模板回落
//   - 章节落盘字段（含场景卡片这个曾经刷新就丢的）
//   - 片段导入 11 个板块按真实导出格式落盘
//   - 版本历史、章节移动、导出三种格式、回收站往返、全局检索
//   - EPUB 的 zip 结构（mimetype 不压缩、正文与目录齐全）与封面（自动生成 / 自定义替换）
//   - 导入已有文稿的章节切分（第X章 / 第X回 / 序章 / 分卷 / 行文不误切）
//
// 全部通过时退出码为 0，可直接挂进 CI 或提交前的手动检查。
// ===========================================================================

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.SHU_BASE || 'http://127.0.0.1:8848';

let pass = 0;
let fail = 0;
const fails = [];

function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS', name); }
  else { fail++; fails.push(name); console.log('  FAIL', name, extra === undefined ? '' : `→ ${extra}`); }
}
function group(title) { console.log(`\n【${title}】`); }

async function req(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  if ((r.headers.get('content-type') || '').includes('json')) {
    try { json = JSON.parse(buf.toString('utf8')); } catch { /* 非 JSON 正文 */ }
  }
  return { status: r.status, buf, json };
}
const get = async (u) => (await req('GET', u)).json;
const post = async (u, b) => (await req('POST', u, b)).json;
const put = async (u, b) => (await req('PUT', u, b)).json;

/** 发原始二进制（Word 导入接口不走 JSON） */
async function postRaw(url, buf, type = 'application/octet-stream') {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': type },
    body: buf,
  });
  const out = Buffer.from(await r.arrayBuffer());
  let json = null;
  if ((r.headers.get('content-type') || '').includes('json')) {
    try { json = JSON.parse(out.toString('utf8')); } catch { /* 非 JSON 正文 */ }
  }
  return { status: r.status, buf: out, json };
}

/** 发一次流式请求，把正文攒出来（用来验证模型对比时两个模型各自跑各自的） */
async function streamOnce(providerId, model, novelId, chapterId) {
  const r = await fetch(`${BASE}/api/ai/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: 'chapter', novelId, chapterId, providerId, model, payload: { targetWords: 300 } }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    return { ok: false, error: j.error || `HTTP ${r.status}`, text: '', model: '' };
  }
  const raw = await r.text();
  let text = '';
  let meta = null;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const p = t.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    let j;
    try { j = JSON.parse(p); } catch { continue; }
    if (j.shu_meta) { meta = j.shu_meta; continue; }
    if (j.error || j.shu_error) return { ok: false, error: j.shu_error || JSON.stringify(j.error), text, model: meta?.model || '' };
    const d = j.choices?.[0]?.delta || {};
    if (typeof d.content === 'string') text += d.content;
  }
  return { ok: true, text, model: meta?.model || '' };
}

/** 手搓一张 4x5 的 PNG，当假封面用（不引第三方库） */
function tinyPng(w = 4, h = 5) {
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  const crc = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const raw = [];
  for (let y = 0; y < h; y++) {
    raw.push(0);
    for (let x = 0; x < w; x++) raw.push(200, 40, 40);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.from(raw))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 极简 zip 解析：把 EPUB 里的文件解出来（只处理 store 方式与 deflate） */
function unzip(buf) {
  const files = {};
  let i = 0;
  while (i < buf.length - 4) {
    if (buf.readUInt32LE(i) !== 0x04034b50) { i += 1; continue; }
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString('utf8');
    const start = i + 30 + nameLen + extraLen;
    const raw = buf.slice(start, start + compSize);
    try { files[name] = method === 0 ? raw : zlib.inflateRawSync(raw); } catch { files[name] = Buffer.alloc(0); }
    i = start + compSize;
  }
  return files;
}

function checkEpub(buf, chapters, novel = {}) {
  const names = Object.keys(unzip(buf));
  const has = (s) => names.some((n) => n.includes(s));
  check('EPUB 有 mimetype', has('mimetype'));
  check('EPUB 有 container.xml', has('META-INF/container.xml'));
  check('EPUB 有 content.opf', has('.opf'));
  check('EPUB 有目录 nav/toc', has('nav') || has('toc'));
  check('EPUB 有正文 xhtml', has('.xhtml'));
  // EPUB 规范：mimetype 必须是第一个文件，且不压缩
  const mtName = buf.indexOf(Buffer.from('mimetype'));
  const mtHdr = mtName - 30;
  check('EPUB mimetype 在文件开头', mtHdr >= 0 && mtHdr < 60, `offset=${mtHdr}`);
  check('EPUB mimetype 未压缩', mtHdr >= 0 && buf.readUInt16LE(mtHdr + 8) === 0);
  // 正文与目录是否齐全
  const files = unzip(buf);
  const xhtml = names.filter((n) => n.endsWith('.xhtml')).map((n) => files[n].toString('utf8')).join('\n');
  const nav = names.filter((n) => n.includes('nav') || n.includes('toc')).map((n) => files[n].toString('utf8')).join('\n');
  const titles = chapters.map((c) => c.title).filter(Boolean);
  const missingBody = titles.filter((t) => !xhtml.includes(t));
  const missingNav = titles.filter((t) => !nav.includes(t));
  check('EPUB 正文含全部章节', missingBody.length === 0, missingBody.join(','));
  check('EPUB 目录含全部章节', missingNav.length === 0, missingNav.join(','));

  // 封面（自动生成的 SVG，或用户自己传的 PNG / JPG / GIF）
  const coverName = names.find((n) => /cover\.(svg|png|jpg|gif)$/.test(n));
  check('EPUB 内含封面图', !!coverName, coverName || '');
  const isSvg = !!coverName && coverName.endsWith('.svg');
  const cover = coverName ? files[coverName].toString('utf8') : '';
  if (isSvg) {
    check('封面是合法 SVG', cover.startsWith('<?xml') && cover.includes('<svg') && cover.trim().endsWith('</svg>'));
    check('封面写进了书名', !!novel.title && cover.includes(novel.title), novel.title);
    check('封面写进了作者', !novel.author || cover.includes(novel.author), novel.author);
    check('封面有题材', !novel.genre || cover.includes(novel.genre), novel.genre);
    // 标题里的 XML 特殊字符不能把 SVG 写坏
    check('封面 XML 里没有裸的 & 或 <', !/&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(cover) && !cover.replace(/<[^>]*>/g, '').includes('<'));
  }
  const opf = (names.filter((n) => n.endsWith('.opf')).map((n) => files[n].toString('utf8')).join('\n'));
  check('opf 标注 cover-image', opf.includes('properties="cover-image"'));
  check('opf 有 EPUB2 兼容的 cover meta', /<meta\s+name="cover"\s+content="[^"]+"/.test(opf));
  check('封面 id 与 meta 指向同一个条目', (() => {
    const prop = opf.match(/id="([^"]+)"[^>]*href="cover\.[a-z]+"[^>]*properties="cover-image"/);
    const meta = opf.match(/<meta\s+name="cover"\s+content="([^"]+)"/);
    return !!(prop && meta && prop[1] === meta[1]);
  })());
  check('opf 收了封面页 cover.xhtml', opf.includes('cover.xhtml'));
  check('封面页引用了封面图', xhtml.includes(coverName ? coverName.split('/').pop() : '??'));
  check('封面页带 epub:type="cover"', xhtml.includes('epub:type="cover"'));
  check('目录里有封面条目', nav.includes('cover.xhtml'));
  check('书脊第一项是封面', /<itemref\s+idref="cover"\s*\/>/.test(opf));
  check('opf 里封面的 media-type 与文件对得上', (() => {
    const m = opf.match(/href="cover\.([a-z]+)"[^>]*media-type="([^"]+)"/);
    if (!m) return false;
    const [, ext, media] = m;
    const want = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif' }[ext];
    return want === media;
  })());
}

/** 导入已有文稿的章节切分 */
async function checkManuscript(novelId) {
  const NL = '\n';
  const parse = async (text) => {
    // 导入是「追加到现有章节末尾」，所以先清空再导
    await put(`${BASE}/api/novels/${novelId}`, { chapters: [], outline: { volumes: [], notes: '' } });
    await post(`${BASE}/api/novels/${novelId}/import`, { text });
    const n = (await get(`${BASE}/api/novels/${novelId}`)).novel;
    return {
      chapters: n.chapters.map((c) => ({ title: c.title, content: c.content || '' })),
      volumes: (n.outline?.volumes || []).map((v) => v.name),
    };
  };

  let t = await parse(['第一章 落霜', '正文一', '第二章 归途', '正文二'].join(NL));
  check('文稿切成 2 章', t.chapters.length === 2, JSON.stringify(t.chapters.map((c) => c.title)));
  check('章节内容对得上', t.chapters[0]?.content === '正文一');

  t = await parse(['第一回', '甲', '第二回', '乙'].join(NL));
  check('「第X回」也算章节', t.chapters.length === 2);

  t = await parse(['序章', '甲', '第一章', '乙', '番外', '丙'].join(NL));
  check('序章 / 番外算章节', t.chapters.length === 3, JSON.stringify(t.chapters.map((c) => c.title)));

  t = await parse(['第一卷 少年游', '第一章', '甲', '第二卷 江湖路', '第二章', '乙'].join(NL));
  check('文稿分出 2 卷', t.volumes.length === 2, JSON.stringify(t.volumes));

  t = await parse(['就是一段普通文字', '第二行'].join(NL));
  check('没有章节标记时整篇当一章', t.chapters.length === 1);

  t = await parse('');
  check('空文稿不报错', t.chapters.length === 0);

  // 正文里以「第N章 / 第N卷」开头的行不是标题，不能误切
  const many = [];
  for (let i = 1; i <= 12; i++) many.push(`第${i}章 第${i}节`, `第${i}章的内容`);
  t = await parse(many.join(NL));
  check('正文里的「第N章」不误切', t.chapters.length === 12, `切出 ${t.chapters.length} 章`);

  t = await parse(['第一卷 少年游', '第一章', '第1卷的结局让人意外', '第2章', '乙'].join(NL));
  check('正文里的「第N卷」不误切', t.chapters.length === 2 && t.volumes.length === 1, `章=${t.chapters.length} 卷=${t.volumes.length}`);
}

/** Word 导入：导出一份带书名页 / 创作说明的 docx，解析后再按章节导入 */
async function checkDocxImport() {
  const made = await post(`${BASE}/api/novels`, { title: 'Word 导入测试', author: '测试作者', genre: '悬疑' });
  const nid = made.novel?.id;
  check('Word 导入：建测试作品', !!nid);
  if (!nid) return;

  await put(`${BASE}/api/novels/${nid}`, { meta: { submissionNote: '给编辑的附言。' } });
  await post(`${BASE}/api/novels/${nid}/chapters`, { title: '开始', content: '第一段。' });
  await post(`${BASE}/api/novels/${nid}/chapters`, { title: '继续', content: '第二段。' });

  const exp = await req('GET', `${BASE}/api/novels/${nid}/export?format=docx&note=1`);
  check('Word 导入：导出测试稿', exp.status === 200 && exp.buf.length > 1000 && exp.buf.readUInt32LE(0) === 0x04034b50,
    `status=${exp.status} size=${exp.buf.length}`);

  const parsed = await postRaw(`${BASE}/api/import/docx`, exp.buf, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const t = parsed.json || {};
  check('Word 导入：解析接口返回正文', parsed.status === 200 && !!t.text, `status=${parsed.status} ${JSON.stringify(t).slice(0, 120)}`);
  check('Word 导入：跳过书名页与创作说明',
    t.text?.includes('第1章 开始') && !t.text?.includes('Word 导入测试') && !t.text?.includes('创作说明') &&
    t.frontMatter?.includes('Word 导入测试') && t.frontMatter?.includes('创作说明'),
    JSON.stringify({ text: (t.text || '').slice(0, 60), front: (t.frontMatter || '').slice(0, 60) }));
  check('Word 导入：正文与统计都在',
    t.text?.includes('第一段。') && t.text?.includes('第二段。') && t.paragraphs > 0 && t.headings === 2 && t.frontMatterHeadings === 1,
    `paragraphs=${t.paragraphs} headings=${t.headings} frontHeadings=${t.frontMatterHeadings}`);

  await put(`${BASE}/api/novels/${nid}`, { chapters: [], outline: { volumes: [], notes: '' } });
  const imported = await post(`${BASE}/api/novels/${nid}/import`, { text: t.text });
  const n = (await get(`${BASE}/api/novels/${nid}`)).novel;
  check('Word 导入：解析结果按章节导入',
    imported.imported === 2 && n.chapters.length === 2 && n.chapters[0].title === '开始' && n.chapters[1].content === '第二段。',
    `imported=${imported.imported} chapters=${n.chapters.length}`);

  const bad = await postRaw(`${BASE}/api/import/docx`, Buffer.from('这不是 docx'), 'application/octet-stream');
  check('Word 导入：拒绝非 docx', bad.status === 400 && /Word/.test(bad.json?.error || ''), `status=${bad.status} ${bad.json?.error || ''}`);

  await req('DELETE', `${BASE}/api/novels/${nid}?permanent=1`);
}

async function main() {
  console.log('书匠 · 回归自检');

  // 自检会往章节里写字，那些字会记进码字统计 —— 跑之前存一份，跑完原样还回去，
  // 免得自检把作者真实的日更记录搅乱。
  const statsFile = path.join('data', 'stats.json');
  const statsBackup = fs.existsSync(statsFile) ? fs.readFileSync(statsFile) : null;

  // 连不上就早点说清楚，别打一屏无意义的 FAIL
  try {
    await fetch(`${BASE}/api/novels`);
  } catch {
    console.error('\n连不上本地服务，请先启动：tools\\node\\node.exe server\\server.js');
    process.exit(2);
  }

  // 自检会建一批测试作品再删掉。只删自己建的：库里原有的作品一个都不能碰，
  // 万一删错了，作者几年的稿子就没了。回收站里的也算「原有的」。
  const beforeIds = new Set(((await get(`${BASE}/api/novels`)).novels || []).map((n) => n.id));
  const beforeTrashIds = new Set((((await get(`${BASE}/api/trash`)).items) || []).map((t) => t.id));
  const isOurs = (id) => !beforeIds.has(id) && !beforeTrashIds.has(id);

  // ---------------------------------------------------------------
  group('提示词模板');
  const slots = await get(`${BASE}/api/prompt-slots`);
  check('任务清单可取', Array.isArray(slots?.slots) && slots.slots.length >= 15);
  check('每个槽位都有 task 与 label', (slots?.slots || []).every((s) => s.task && s.label));

  const novel = await post(`${BASE}/api/novels`, { title: '回归测试', genre: '奇幻', author: '测试' });
  const id = novel.novel?.id;
  check('建作品成功', !!id);
  if (!id) { report(); return; }
  const ch = await post(`${BASE}/api/novels/${id}/chapters`, { title: '第一章', content: '正文' });
  const cid = ch.chapter?.id;
  check('建章节成功', !!cid);

  const ctx = await post(`${BASE}/api/context`, {
    task: 'chapter', novelId: id, chapterId: cid,
    payload: { targetWords: 888, instruction: '要求' },
    customTemplates: { chapter: { system: 'S${novel.genre}', user: 'U${novel.title}|${chapter.no}|${chapter.title}|${target}|${req}' } },
  });
  const u = (ctx.messages || []).find((m) => m.role === 'user')?.content ?? '';
  check('变量插值正确', u === 'U回归测试|1|第一章|888|要求', u);
  check('系统提示词也插值', (ctx.messages || []).find((m) => m.role === 'system')?.content === 'S奇幻');

  const ctxEmpty = await post(`${BASE}/api/context`, {
    task: 'chapter', novelId: id, chapterId: cid,
    customTemplates: { chapter: { system: '', user: '${不存在的变量}' } },
  });
  const uEmpty = (ctxEmpty.messages || []).find((m) => m.role === 'user')?.content ?? '';
  check('模板替换为空时退回内置提示词', !uEmpty.includes('${') && uEmpty.length > 0, uEmpty.slice(0, 60));

  const ctxKey = await post(`${BASE}/api/context`, {
    task: 'outline', novelId: id, payload: { templateKey: 'outline:aiFullOutline', instruction: 'X' },
    customTemplates: { outline: { system: '', user: '普通' }, 'outline:aiFullOutline': { system: '', user: '全书' } },
  });
  check('templateKey 命中专属模板', (ctxKey.messages || []).find((m) => m.role === 'user')?.content === '全书');

  // ---------------------------------------------------------------
  group('章节落盘');
  await put(`${BASE}/api/novels/${id}/chapters/${cid}`, {
    title: '改名后的章', content: '新正文', summary: '概要', stage: 'revising', targetWords: 1500,
    memory: { summary: '记忆' }, status: 'done',
    outline: { scene: 's', characters: 'c', summary: 'm', hook: 'h' },
    annotations: [{ id: 'an1', start: 0, end: 2, text: '批注', color: 'yellow', note: 'n' }],
    scenes: [{ pov: '主角', location: '巷口', time: '夜', characters: '张三', summary: '相遇', hook: '钩子', targetWords: 800 }],
  });
  const afterCh = (await get(`${BASE}/api/novels/${id}`)).novel.chapters[0];
  check('标题/正文/概要落盘', afterCh.title === '改名后的章' && afterCh.content === '新正文' && afterCh.summary === '概要');
  check('阶段/目标字数落盘', afterCh.stage === 'revising' && afterCh.targetWords === 1500);
  check('章节记忆落盘', afterCh.memory?.summary === '记忆');
  check('章纲落盘', afterCh.outline?.scene === 's');
  check('批注落盘', (afterCh.annotations || []).length === 1);
  check('场景卡片落盘（曾经刷新就丢）', (afterCh.scenes || []).length === 1);

  // 新建章节时 stage 要被尊重（拆分本章继承原章阶段靠这个）
  const st = await post(`${BASE}/api/novels/${id}/chapters`, { title: 'stage', content: 'x', stage: 'done' });
  check('新建章节尊重传入的 stage', st.chapter?.stage === 'done', st.chapter?.stage);
  const stBad = await post(`${BASE}/api/novels/${id}/chapters`, { title: 'stage2', content: 'x', stage: '乱填' });
  check('非法 stage 退回草稿', stBad.chapter?.stage === 'draft', stBad.chapter?.stage);

  // ---------------------------------------------------------------
  group('片段导入（11 个板块）');
  // 目标作品里第一章的 id 就是 cid，章节类板块直接按这个 id 归位
  const remap = (arr) => (arr || []).map((x) => x);
  const FRAG = [
    ['outline', { outline: { volumes: [{ id: 'v1', name: '第一卷' }], notes: 'N' } }, (n) => n.outline.volumes.length === 1],
    ['scenes', { scenes: remap([{ chapterId: cid, pov: 'p', location: 'L' }]) }, (n) => (n.chapters[0].scenes || []).some((s) => s.location === 'L')],
    ['memories', { memories: remap([{ chapterId: cid, memory: { summary: 'M' } }]) }, (n) => n.chapters[0].memory?.summary === 'M'],
    ['characters', [{ id: 'c1', name: '角色一' }], (n) => n.bible.characters.some((c) => c.name === '角色一')],
    ['world', [{ id: 'w1', name: '世界一' }], (n) => n.bible.world.some((w) => w.name === '世界一')],
    ['timeline', [{ id: 't1', event: '事件' }], (n) => n.bible.timeline.some((t) => t.event === '事件')],
    ['beats', [{ id: 'b1', name: '节拍' }], (n) => n.beats?.items?.some((b) => b.name === '节拍')],
    ['arcs', [{ id: 'c1', name: '角色一', arc: '弧线' }], (n) => n.bible.characters.some((c) => c.arc === '弧线')],
    ['relations', [{ id: 'c1', name: '角色一', relations: [{ to: '角色二', type: '师徒' }] }], (n) => n.bible.characters.some((c) => (c.relations || []).length === 1)],
    ['style', { styleNotes: '短句', taboos: '禁' }, (n) => n.meta?.styleNotes === '短句' && n.meta?.taboos === '禁'],
    ['annotations', { annotations: remap([{ id: 'an2', chapterId: cid, start: 0, end: 1, text: 't' }]) }, (n) => (n.chapters[0].annotations || []).length >= 1],
  ];
  for (const [key, data, verify] of FRAG) {
    const r = await post(`${BASE}/api/novels/${id}/import-fragment`, { type: key, version: 1, data });
    const n = (await get(`${BASE}/api/novels/${id}`)).novel;
    check(`片段导入 ${key}`, r.ok === true && verify(n), r.error || '数据没落上');
  }

  // ---------------------------------------------------------------
  group('版本历史 / 导出 / 回收站 / 检索');
  const snapRes = await post(`${BASE}/api/novels/${id}/snapshots`, { kind: 'manual', label: '自检备份', force: true });
  check('手动备份成功', snapRes.snapshot?.ts > 0);
  const snaps = (await get(`${BASE}/api/novels/${id}/snapshots`)).snapshots || [];
  check('版本列表非空', snaps.length >= 1);
  const restoreRes = await post(`${BASE}/api/novels/${id}/restore`, { ts: snaps[0].ts });
  check('恢复版本成功', !!restoreRes.novel);

  const md = await req('GET', `${BASE}/api/novels/${id}/export?format=md`);
  check('Markdown 导出 200', md.status === 200 && md.buf.length > 50);
  const txt = await req('GET', `${BASE}/api/novels/${id}/export?format=txt`);
  check('TXT 导出 200', txt.status === 200 && txt.buf.length > 50);
  const epub = await req('GET', `${BASE}/api/novels/${id}/export?format=epub`);
  check('EPUB 导出 200 且是合法 zip', epub.status === 200 && epub.buf.slice(0, 2).toString() === 'PK');
  checkEpub(epub.buf, (await get(`${BASE}/api/novels/${id}`)).novel.chapters || [], (await get(`${BASE}/api/novels/${id}`)).novel || {});
  const jsonExp = await req('GET', `${BASE}/api/novels/${id}/export?format=json`);
  check('备份 JSON 可解析', (() => { try { return !!JSON.parse(jsonExp.buf.toString('utf8')); } catch { return false; } })());

  const printExp = await req('GET', `${BASE}/api/novels/${id}/export?format=print`);
  const printHtml = printExp.buf.toString('utf8');
  check('打印稿导出 200 且是完整 HTML',
    printExp.status === 200 && printHtml.startsWith('<!doctype html>') && printHtml.includes('打印 / 存为 PDF'),
    printHtml.slice(0, 40));
  check('打印稿有书名页与章节', printHtml.includes('class="titlepage"') && printHtml.includes('class="chapter"'));
  const printRange = await req('GET', `${BASE}/api/novels/${id}/export?format=print&from=1&to=1`);
  const printRangeHtml = printRange.buf.toString('utf8');
  check('打印稿认章节区间',
    printRange.status === 200 && printRangeHtml.includes('节选 · 第 1 章')
      && (printRangeHtml.match(/class="chapter"/g) || []).length === 1);
  const printDone = await req('GET', `${BASE}/api/novels/${id}/export?format=print&only=done`);
  const printDoneHtml = printDone.buf.toString('utf8');
  check('打印稿认只导出定稿',
    printDone.status === 200 && printDoneHtml.includes('定稿 1 章')
      && (printDoneHtml.match(/class="chapter"/g) || []).length === 1);

  const docxRes = await fetch(`${BASE}/api/novels/${id}/export?format=docx`);
  const docxBuf = Buffer.from(await docxRes.arrayBuffer());
  const docxName = decodeURIComponent(docxRes.headers.get('content-disposition') || '');
  check('Word 导出 200 且是 zip',
    docxRes.status === 200 && /wordprocessingml/.test(docxRes.headers.get('content-type') || '')
      && docxBuf.length > 4 && docxBuf.readUInt32LE(0) === 0x04034b50,
    `${docxRes.status} ${docxRes.headers.get('content-type')}`);
  check('Word 文件名是 .docx', docxName.includes('.docx'), docxName);
  const docxRange = await req('GET', `${BASE}/api/novels/${id}/export?format=docx&from=1&to=999&only=done&note=1`);
  check('Word 认区间与定稿',
    docxRange.status === 200 && docxRange.buf.length > 4 && docxRange.buf.readUInt32LE(0) === 0x04034b50);

  // ---------------------------------------------------------------
  group('自定义封面');
  {
    // 版式与配色的清单
    const opts = await get(`${BASE}/api/cover-options`);
    check('封面版式清单可取', Array.isArray(opts?.styles) && opts.styles.length >= 3, JSON.stringify(opts?.styles));
    check('封面配色清单可取', Array.isArray(opts?.palettes) && opts.palettes.length >= 6, opts?.palettes?.length);

    // 配色下标：空表示「按书名自动挑」，不能被当成第 0 套（Number('') 是 0，这个坑踩过）
    await put(`${BASE}/api/novels/${id}`, { meta: { coverPalette: '', coverStyle: '' } });
    const auto = (await get(`${BASE}/api/novels/${id}`)).novel;
    check('空配色仍然是「自动」而不是第 0 套', auto.meta?.coverPalette === '' || auto.meta?.coverPalette === undefined,
      JSON.stringify(auto.meta?.coverPalette));
    await put(`${BASE}/api/novels/${id}`, { meta: { coverPalette: 3, coverStyle: 'band' } });
    const picked = (await get(`${BASE}/api/novels/${id}`)).novel;
    check('选中的配色能存住', picked.meta?.coverPalette === 3, JSON.stringify(picked.meta?.coverPalette));
    check('选中的版式能存住', picked.meta?.coverStyle === 'band', JSON.stringify(picked.meta?.coverStyle));
    await put(`${BASE}/api/novels/${id}`, { meta: { coverPalette: 99, coverStyle: '不存在的版式' } });
    const bad2 = (await get(`${BASE}/api/novels/${id}`)).novel;
    check('越界的配色被夹回「自动」', bad2.meta?.coverPalette === '' || bad2.meta?.coverPalette === undefined,
      JSON.stringify(bad2.meta?.coverPalette));
    check('不认识的版式不会写进作品里', ['classic', 'minimal', 'band'].includes(bad2.meta?.coverStyle),
      JSON.stringify(bad2.meta?.coverStyle));

    // 导出的 EPUB 要用上选中的版式与配色
    await put(`${BASE}/api/novels/${id}`, { meta: { coverPalette: 3, coverStyle: 'band' } });
    const epubS = await req('GET', `${BASE}/api/novels/${id}/export?format=epub`);
    const svgS = unzip(epubS.buf)['OEBPS/cover.svg']?.toString('utf8') || '';
    check('EPUB 的封面用上了色带版式', svgS.includes('height="1500"'), svgS.slice(0, 80));
    check('EPUB 的封面用上了选中的配色', svgS.includes('#c5869a'), '酒红');

    // 预览接口：带参数现画一张，但不落盘
    const prev = await req('GET', `${BASE}/api/novels/${id}/cover?style=minimal&palette=2`);
    const prevSvg = prev.buf.toString('utf8');
    check('预览能按参数现画', prev.status === 200 && prevSvg.includes('<svg') && prevSvg.includes('<text'));
    check('预览的配色跟参数一致', prevSvg.includes('#7fb39c'), '松绿');
    const stillPicked = (await get(`${BASE}/api/novels/${id}`)).novel;
    check('预览不会把选择改掉', stillPicked.meta?.coverStyle === 'band' && stillPicked.meta?.coverPalette === 3,
      `${stillPicked.meta?.coverStyle}/${stillPicked.meta?.coverPalette}`);

    // 腰封：作品简介印在封面上
    await put(`${BASE}/api/novels/${id}`, { meta: { logline: '一句话故事测试' } });
    const tagSvg = (await req('GET', `${BASE}/api/novels/${id}/cover`)).buf.toString('utf8');
    check('封面带上了作品简介', tagSvg.includes('一句话故事测试'), tagSvg.slice(0, 120));
    const tagEpub = unzip((await req('GET', `${BASE}/api/novels/${id}/export?format=epub`)).buf);
    check('导出的 EPUB 封面也带简介', tagEpub['OEBPS/cover.svg']?.toString('utf8').includes('一句话故事测试'));
    await put(`${BASE}/api/novels/${id}`, { meta: { logline: '' } });
    const noTagSvg = (await req('GET', `${BASE}/api/novels/${id}/cover`)).buf.toString('utf8');
    const countText = (s) => (s.match(/<text/g) || []).length;
    check('没有简介时封面少一段字', countText(noTagSvg) === countText(tagSvg) - 1,
      `${countText(noTagSvg)} vs ${countText(tagSvg)}`);

    await put(`${BASE}/api/novels/${id}`, { meta: { coverPalette: '', coverStyle: '' } });

    const png = tinyPng();
    const up = await fetch(`${BASE}/api/novels/${id}/cover`, {
      method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png,
    });
    const upJson = await up.json();
    check('上传自定义封面成功', up.status === 200 && upJson.cover?.ext === 'png', upJson.error || '');
    check('封面文件落到 data/covers', fs.existsSync(path.join('data', 'covers', `${id}.png`)));
    const rec = (await get(`${BASE}/api/novels/${id}`)).novel;
    check('作品记录里记下了封面', rec.cover?.ext === 'png' && rec.cover?.size === png.length, JSON.stringify(rec.cover));
    const back = await req('GET', `${BASE}/api/novels/${id}/cover`);
    check('取回的封面就是传上去那张', back.buf.equals(png), `${back.buf.length} vs ${png.length}`);
    const epub2 = await req('GET', `${BASE}/api/novels/${id}/export?format=epub`);
    const files2 = unzip(epub2.buf);
    check('EPUB 用上了自定义封面', !!files2['OEBPS/cover.png'] && files2['OEBPS/cover.png'].equals(png));
    check('EPUB 里不再有自动生成的 SVG', !files2['OEBPS/cover.svg']);
    const opf2 = files2['OEBPS/content.opf'].toString('utf8');
    check('opf 的封面 media-type 是 image/png', opf2.includes('media-type="image/png"') && opf2.includes('href="cover.png"'));
    checkEpub(epub2.buf, [], (await get(`${BASE}/api/novels/${id}`)).novel || {});
    // 装成图片的别的东西不能混进来
    const fake = await fetch(`${BASE}/api/novels/${id}/cover`, {
      method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('<html>hi</html>'),
    });
    check('伪装的图片被拒', fake.status === 400, `status=${fake.status}`);
    const webp = await fetch(`${BASE}/api/novels/${id}/cover`, {
      method: 'POST', headers: { 'Content-Type': 'image/webp' }, body: Buffer.from('RIFF0000WEBPVP8 '),
    });
    check('不支持的格式被拒', webp.status === 400, `status=${webp.status}`);
    const rm = await req('DELETE', `${BASE}/api/novels/${id}/cover`);
    check('移除自定义封面', rm.status === 200 && rm.json?.ok === true);
    check('封面文件已删', !fs.existsSync(path.join('data', 'covers', `${id}.png`)));
    check('作品记录里封面也没了', !(await get(`${BASE}/api/novels/${id}`)).novel?.cover);
    const epub3 = await req('GET', `${BASE}/api/novels/${id}/export?format=epub`);
    const files3 = unzip(epub3.buf);
    check('移除后又回到自动生成的封面', !!files3['OEBPS/cover.svg'] && !files3['OEBPS/cover.png']);
  }

  // ---------------------------------------------------------------
  group('模型对比（同一段上下文跑两个模型）');
  {
    // 这一项要假模型服务在跑；没起就跳过，别让自检红一片
    const mockBase = 'http://127.0.0.1:8890/v1';
    const mockUp = await fetch(`${mockBase}/models`).then((r) => r.ok).catch(() => false);
    if (!mockUp) {
      console.log('  SKIP 假模型服务没起（tools\\node\\node.exe dev\\mock-openai.js），跳过模型对比检查');
    } else {
      const before = (await get(`${BASE}/api/config`)) || {};
      const origProviders = before.providers || [];
      const testProv = { id: 'p_regress_mock', name: '自检假模型', baseUrl: mockBase, apiKey: 'sk-regress', models: ['mock-writer', 'mock-alt'] };
      try {
        // 只加一个服务商；原来的按 id 合并，密钥不会被清掉，测完原样还回去
        await post(`${BASE}/api/config`, { providers: [...origProviders, testProv] });
        const [a, b] = await Promise.all([
          streamOnce(testProv.id, 'mock-writer', id, cid),
          streamOnce(testProv.id, 'mock-alt', id, cid),
        ]);
        check('两个模型都能跑出内容', a.ok && b.ok, `${a.error || ''} | ${b.error || ''}`);
        check('两边跑的是各自的模型', a.model === 'mock-writer' && b.model === 'mock-alt', `${a.model} / ${b.model}`);
        check('两个模型给的是不同的正文', !!a.text && !!b.text && a.text !== b.text);
        check('正文不是空的', (a.text || '').length > 20 && (b.text || '').length > 20, `${(a.text || '').length} / ${(b.text || '').length}`);
      } finally {
        await post(`${BASE}/api/config`, { providers: origProviders });
      }
      const after = (await get(`${BASE}/api/config`)) || {};
      check('自检完服务商列表还原了', (after.providers || []).length === origProviders.length,
        `${(after.providers || []).length} vs ${origProviders.length}`);
    }
  }

  const beforeTrash = (await get(`${BASE}/api/novels/${id}`)).novel?.chapters?.length || 0;
  const del = await req('DELETE', `${BASE}/api/novels/${id}`);
  check('删除进回收站', del.status === 200);
  const trash = await get(`${BASE}/api/trash`);
  const items = trash.items || trash.trash || trash || [];
  check('回收站列出该作品', items.some((i) => i.id === id));
  const trashId = items.find((i) => i.id === id)?.trashId;
  const back = await post(`${BASE}/api/trash/${trashId}/restore`, {});
  check('从回收站恢复', back.novel?.id === id);
  const backNovel = (await get(`${BASE}/api/novels/${id}`)).novel;
  const expectChapters = beforeTrash;
  check('恢复后章节完整', backNovel.chapters.length === expectChapters, `chapters=${backNovel.chapters.length} 期望 ${expectChapters}`);
  const trash2 = (await get(`${BASE}/api/trash`)).items || [];
  check('恢复后就不在回收站里了', !trash2.some((i) => i.id === id));

  const search = await get(`${BASE}/api/library-search?q=${encodeURIComponent('正文')}`);
  check('全局搜索能搜到', (search.hits?.length || search.results?.length || 0) >= 1);

  // ---------------------------------------------------------------
  group('稿件头部的作者联系方式');
  {
    await put(`${BASE}/api/novels/${id}`, { meta: { contact: 'me@example.com / 微信 myid' } });
    const rec = (await get(`${BASE}/api/novels/${id}`)).novel;
    check('联系方式能存住', rec.meta?.contact === 'me@example.com / 微信 myid', rec.meta?.contact);

    const txt = (await req('GET', `${BASE}/api/novels/${id}/export?format=txt`)).buf.toString('utf8');
    check('TXT 头部有联系方式', txt.includes('联系方式：me@example.com / 微信 myid'), txt.split('\n')[0]);
    const md = (await req('GET', `${BASE}/api/novels/${id}/export?format=md`)).buf.toString('utf8');
    check('Markdown 头部有联系方式', md.includes('联系方式：me@example.com / 微信 myid'));
    const epub = unzip((await req('GET', `${BASE}/api/novels/${id}/export?format=epub`)).buf);
    check('EPUB 书名页有联系方式', epub['OEBPS/title.xhtml'].toString('utf8').includes('me@example.com / 微信 myid'));
    const json = (await req('GET', `${BASE}/api/novels/${id}/export?format=json`)).buf.toString('utf8');
    check('备份 JSON 里有联系方式', json.includes('me@example.com / 微信 myid'));

    await put(`${BASE}/api/novels/${id}`, { meta: { contact: '' } });
    const txt2 = (await req('GET', `${BASE}/api/novels/${id}/export?format=txt`)).buf.toString('utf8');
    check('没填时稿件里不出现联系方式', !txt2.includes('联系方式：'));
  }

  // ---------------------------------------------------------------
  group('导出的章节区间');
  {
    // 自己造一本六章的书：奇数章定稿，区间跟「只导出定稿」叠加时好对数字
    const made = await post(`${BASE}/api/novels`, { title: '区间自检稿', author: '自检' });
    const tid = made.novel.id;
    for (let i = 1; i <= 6; i++) {
      await post(`${BASE}/api/novels/${tid}/chapters`, {
        title: `标题${i}`, content: `这是第${i}章的正文。`, stage: i % 2 === 1 ? 'done' : 'draft',
      });
    }
    const exp = async (q) => {
      const r = await fetch(`${BASE}/api/novels/${tid}/export?format=txt${q}`);
      return {
        status: r.status,
        text: (await r.text()).replace(/^\uFEFF/, ''),
        name: decodeURIComponent(r.headers.get('content-disposition') || ''),
      };
    };
    const heads = (t) => [...t.matchAll(/^第(\d+)章 /gm)].map((m) => Number(m[1])).join(',');

    const r1 = await exp('&from=3&to=5');
    check('区间导出只含这几章', r1.status === 200 && heads(r1.text) === '3,4,5', `${r1.status} ${heads(r1.text)}`);
    check('区间导出在稿件头部标了节选', r1.text.includes('节选：第3-5章'), r1.text.split('\n')[0]);
    check('区间导出的文件名带章号', r1.name.includes('_第3-5章'), r1.name);

    const r2 = await exp('&from=5&to=3');
    check('起始章号填反了自动换过来', heads(r2.text) === '3,4,5', heads(r2.text));
    const r3 = await exp('&from=3&to=99');
    check('超出书本范围的章号夹回去', heads(r3.text) === '3,4,5,6', heads(r3.text));
    check('夹过的文件名用真实章号', r3.name.includes('_第3-6章'), r3.name);
    check('整段落在书外就报错', (await exp('&from=99&to=99')).status === 400);
    const r4 = await exp('&from=2&to=2');
    check('单章区间的文件名不带横杠', heads(r4.text) === '2' && r4.name.includes('_第2章'), r4.name);
    const r5 = await exp('&from=5');
    check('只填起始章就到最后一章', heads(r5.text) === '5,6', heads(r5.text));
    const r6 = await exp('&to=2');
    check('只填结束章就从第一章起', heads(r6.text) === '1,2', heads(r6.text));

    const whole = await exp('');
    check('不传区间还是整本', heads(whole.text) === '1,2,3,4,5,6', heads(whole.text));
    check('整本导出不写节选', !whole.text.includes('节选'), whole.text.split('\n')[0]);

    const done = await exp('&from=3&to=6&only=done');
    check('区间与只导出定稿叠加', heads(done.text) === '3,5', heads(done.text));
    check('区间与定稿两个后缀都在', done.name.includes('_第3-6章_定稿版'), done.name);

    const md = (await req('GET', `${BASE}/api/novels/${tid}/export?format=md&from=4&to=5`)).buf.toString('utf8');
    check('Markdown 也认区间', md.includes('## 第4章') && md.includes('## 第5章') && !md.includes('## 第3章'),
      (md.match(/^## 第\d+章/gm) || []).join(','));

    const epub = unzip((await req('GET', `${BASE}/api/novels/${tid}/export?format=epub&from=4&to=5`)).buf);
    const chFiles = Object.keys(epub).filter((n) => /chapter-\d+\.xhtml$/.test(n));
    const epubText = chFiles.map((n) => epub[n].toString('utf8')).join('\n');
    check('EPUB 也认区间', chFiles.length === 2 && epubText.includes('第4章') && epubText.includes('第5章') && !epubText.includes('第3章'),
      chFiles.join(','));
    const titleXml = epub['OEBPS/title.xhtml']?.toString('utf8') || '';
    check('EPUB 书名页标成节选', titleXml.includes('节选 · 第 4–5 章') && !titleXml.includes('共 2 章'), titleXml.slice(-120));

    await req('DELETE', `${BASE}/api/novels/${tid}?permanent=1`);
    check('区间自检稿已清掉', !((await get(`${BASE}/api/novels`)).novels || []).some((n) => n.id === tid));
  }

  // ---------------------------------------------------------------
  group('写作节奏（30 天对比 / 最长连续 / 最多的一天）');
  {
    // 这几项要拿确定的记录来算：临时造一份，跑完还原
    const orig = fs.readFileSync(statsFile, 'utf8');
    try {
      const days = {};
      const pad = (x) => String(x).padStart(2, '0');
      const now = new Date();
      const k = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      // 最近 10 天各 1000 字，其中第 3 天写 4000
      for (let i = 0; i < 10; i++) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        days[k(d)] = { words: i === 3 ? 4000 : 1000, novels: {}, chapters: {} };
      }
      fs.writeFileSync(statsFile, JSON.stringify({ goal: 3000, days }));
      const s2 = await get(`${BASE}/api/stats?days=30`);
      check('最近 30 天的总和算得对', s2.last30 === 13000, String(s2.last30));
      check('前 30 天没记录时是 0', s2.prev30 === 0, String(s2.prev30));
      check('最长连续算得对', s2.bestStreak?.days === 10, JSON.stringify(s2.bestStreak));
      check('最长连续的结束日期对得上', s2.bestStreak?.to === k(now), `${s2.bestStreak?.to} vs ${k(now)}`);
      check('写得最多的一天算得对', s2.bestDay?.words === 4000 && !!s2.bestDay?.date, JSON.stringify(s2.bestDay));
    } finally {
      fs.writeFileSync(statsFile, orig);
    }
  }

  // ---------------------------------------------------------------
  group('校对的忽略清单');
  {
    const ign = [{ key: 'typo|c_x|的的', type: 'typo', message: '疑似叠字「的的」', no: 1, title: '第一章', ts: 1 }];
    await put(`${BASE}/api/novels/${id}`, { meta: { proofIgnored: ign } });
    const n2 = (await get(`${BASE}/api/novels/${id}`)).novel;
    check('忽略清单能存住', Array.isArray(n2.meta?.proofIgnored) && n2.meta.proofIgnored.length === 1,
      JSON.stringify(n2.meta?.proofIgnored));
    check('忽略项带着说明信息', n2.meta?.proofIgnored?.[0]?.message === '疑似叠字「的的」');
    await put(`${BASE}/api/novels/${id}`, { meta: { proofIgnored: [] } });
    const n3 = (await get(`${BASE}/api/novels/${id}`)).novel;
    check('忽略清单能清空', (n3.meta?.proofIgnored || []).length === 0);
  }

  // ---------------------------------------------------------------
  group('体检的忽略清单');
  {
    const ign = [{ key: 'health|gap|甲', label: '人物断档：甲', ts: 1 }];
    await put(`${BASE}/api/novels/${id}`, { meta: { healthIgnored: ign } });
    const n2 = (await get(`${BASE}/api/novels/${id}`)).novel;
    check('体检忽略清单能存住', Array.isArray(n2.meta?.healthIgnored) && n2.meta.healthIgnored.length === 1,
      JSON.stringify(n2.meta?.healthIgnored));
    check('忽略项带着说明', n2.meta?.healthIgnored?.[0]?.label === '人物断档：甲');
    // 两份清单互不干扰
    check('跟校对的忽略清单互不干扰', (n2.meta?.proofIgnored || []).length === 0);
    await put(`${BASE}/api/novels/${id}`, { meta: { healthIgnored: [] } });
    const n3 = (await get(`${BASE}/api/novels/${id}`)).novel;
    check('体检忽略清单能清空', (n3.meta?.healthIgnored || []).length === 0);
  }

  // ---------------------------------------------------------------
  group('导出附带材料（大纲 / 人物小传）');
  {
    const n2 = await post(`${BASE}/api/novels`, { title: '附带材料测试' });
    const nid = n2.novel?.id;
    // 一卷一章纲 + 三个人物（关系覆盖新格式 / 老字符串 / 反向补全）
    await put(`${BASE}/api/novels/${nid}`, {
      outline: { notes: '', volumes: [{ id: 'v_r1', name: '第一卷', desc: '本卷定位', chapters: [{ id: 'o_r1', title: '起手', scene: '城南雨夜', characters: '甲、乙', summary: '主角动身', hook: '门开了' }] }] },
      bible: {
        characters: [
          { name: '甲', role: '主角', identity: '剑客', goal: '找到师父', relations: [{ to: '乙', type: '师徒', note: '同门师兄' }] },
          { name: '乙', role: '配角', relations: [{ to: '甲', type: '同门' }] },
          { name: '丙', role: '反派', relations: '甲：对手、丁：旧识' },
          { name: '丁', role: '路人' },
          { name: '戊', role: '路人' },
        ],
        world: [], timeline: [],
      },
    });
    const ch = await post(`${BASE}/api/novels/${nid}/chapters`, { title: '第一章 起手', content: '正文内容。', outlineId: 'o_r1' });
    check('建章时可以挂上章纲', ch.chapter?.outlineId === 'o_r1', ch.chapter?.outlineId);
    const bogus = await post(`${BASE}/api/novels/${nid}/chapters`, { title: '第二章', content: 'x', outlineId: 'o_不存在' });
    check('挂不存在的章纲会被忽略', !bogus.chapter?.outlineId, bogus.chapter?.outlineId);

    const mdPlain = (await req('GET', `${BASE}/api/novels/${nid}/export?format=md`)).buf.toString('utf8');
    check('默认导出没有附带材料', !mdPlain.includes('## 全书大纲') && !mdPlain.includes('## 人物小传'));
    const mdExtra = (await req('GET', `${BASE}/api/novels/${nid}/export?format=md&extras=outline,characters`)).buf.toString('utf8');
    check('Markdown 能带上全书大纲', mdExtra.includes('## 全书大纲') && mdExtra.includes('第一卷'));
    check('大纲里有章纲内容', mdExtra.includes('场景：城南雨夜') && mdExtra.includes('章末钩子：门开了'));
    check('Markdown 能带上人物小传', mdExtra.includes('## 人物小传') && mdExtra.includes('核心目标：找到师父'));
    check('附带材料时正文还在', mdExtra.includes('正文内容。'));
    // 关系：新格式、老字符串格式、反向补全
    check('人物小传里有关系', mdExtra.includes('与 乙（师徒 · 同门师兄）'), mdExtra.slice(mdExtra.indexOf('### 甲'), mdExtra.indexOf('### 甲') + 200));
    check('老格式的关系也解析了', mdExtra.includes('与 甲（对手）'));
    check('反向关系会补到对方身上', mdExtra.includes('与 丙（对手）'));
    check('自己写过的关系不被覆盖', mdExtra.includes('与 甲（同门）'));
    {
      // 戊：谁都没提过他，所以不该有关系行
      const secE = mdExtra.match(/### 戊\n([\s\S]*?)(?=\n### |\n---|$)/)?.[1] || '';
      check('没人提过的人不写关系行', !secE.includes('- 关系'), secE.slice(0, 120));
      // 丁：丙提过他，所以反向补一条
      const secD = mdExtra.match(/### 丁\n([\s\S]*?)(?=\n### |\n---|$)/)?.[1] || '';
      check('别人提过他就有关系行', secD.includes('- 关系') && secD.includes('与 丙（旧识）'), secD.slice(0, 160));
    }

    const epubPlain = unzip((await req('GET', `${BASE}/api/novels/${nid}/export?format=epub`)).buf);
    check('EPUB 默认没有大纲页', !epubPlain['OEBPS/outline.xhtml'] && !epubPlain['OEBPS/characters.xhtml']);
    const epubExtra = unzip((await req('GET', `${BASE}/api/novels/${nid}/export?format=epub&extras=outline,characters`)).buf);
    check('EPUB 带上了大纲页', !!epubExtra['OEBPS/outline.xhtml']);
    check('EPUB 带上了人物页', !!epubExtra['OEBPS/characters.xhtml']);
    const opfE = epubExtra['OEBPS/content.opf'].toString('utf8');
    check('opf 收了这两页', opfE.includes('outline.xhtml') && opfE.includes('characters.xhtml'));
    check('书脊里有这两页', opfE.includes('<itemref idref="outline" />') && opfE.includes('<itemref idref="characters" />'));
    check('目录里有入口', epubExtra['OEBPS/nav.xhtml'].toString('utf8').includes('全书大纲'));
    const olXml = epubExtra['OEBPS/outline.xhtml'].toString('utf8');
    check('大纲页内容正确', olXml.includes('城南雨夜') && olXml.includes('第一卷'));
    const chXml = epubExtra['OEBPS/characters.xhtml'].toString('utf8');
    check('人物页里有关系', chXml.includes('<b>关系</b>') && chXml.includes('与 乙（师徒 · 同门师兄）'));
    // 上面故意造了一章挂不上章纲的，缺章纲的章数应该是 1 而不是 2
    check('缺章纲的章数算得对', olXml.includes('另有 1 章还没写章纲'), olXml.slice(-140));

    await req('DELETE', `${BASE}/api/novels/${nid}?permanent=1`);
  }

  // ---------------------------------------------------------------
  group('投稿附言（创作说明）');
  {
    const n2 = await post(`${BASE}/api/novels`, { title: '附言测试', author: '张三', genre: '玄幻' });
    const nid = n2.novel?.id;
    const NOTE = '这本书写了两年，前十万字推翻重来过一次。\n目标读者是慢热群像的老读者。';
    await put(`${BASE}/api/novels/${nid}`, {
      meta: { logline: '一句话故事。', contact: 'me@example.com', platform: '起点', targetWords: 1000, submissionNote: NOTE },
    });
    const sc1 = await post(`${BASE}/api/novels/${nid}/chapters`, { title: '第一章', content: '正文内容。', stage: 'done' });
    await post(`${BASE}/api/novels/${nid}/chapters`, { title: '第二章', content: '第二章的正文。' });
    check('建章时就带定稿状态（给附言数数用）', sc1.chapter?.stage === 'done');

    const saved = (await get(`${BASE}/api/novels/${nid}`)).novel;
    check('附言存进了作品', saved.meta?.submissionNote === NOTE, JSON.stringify(saved.meta?.submissionNote));

    const txtNote = (await req('GET', `${BASE}/api/novels/${nid}/export?format=txt&note=1`)).buf.toString('utf8').replace(/^\uFEFF/, '');
    check('TXT 以创作说明开头', txtNote.startsWith('创作说明'), JSON.stringify(txtNote.slice(0, 12)));
    check('TXT 篇幅是现算的', txtNote.includes('共 2 章 · 已定稿 1 章 · 全书约 12 字'),
      txtNote.split('\n').find((l) => l.startsWith('篇幅')));
    check('TXT 算出了进度', txtNote.includes('全书目标 1,000 字，目前约 1%'),
      txtNote.split('\n').find((l) => l.startsWith('进度')));
    check('TXT 带上了目标平台', txtNote.includes('目标平台：起点'));
    check('TXT 有给编辑的话', txtNote.includes('给编辑的话：') && txtNote.includes('前十万字推翻重来过一次'));
    check('TXT 的信在书名前面', txtNote.indexOf('创作说明') < txtNote.indexOf('《附言测试》'));
    // 头像里已经印过的东西，信里不该再抄一遍
    const txtHead = txtNote.slice(0, txtNote.indexOf('='.repeat(20)));
    check('信里不重复书名', !txtHead.includes('作品：《'), txtHead);
    check('信里不重复联系方式', !txtHead.includes('联系方式'));
    const txtPlain = (await req('GET', `${BASE}/api/novels/${nid}/export?format=txt`)).buf.toString('utf8');
    check('TXT 不勾就没有信', !txtPlain.includes('创作说明'));

    const mdNote = (await req('GET', `${BASE}/api/novels/${nid}/export?format=md&note=1`)).buf.toString('utf8');
    check('Markdown 有创作说明小节', mdNote.includes('## 创作说明'));
    check('Markdown 附言原样保留', mdNote.includes('目标读者是慢热群像的老读者'));
    check('Markdown 的信在正文前', mdNote.indexOf('## 创作说明') < mdNote.indexOf('## 第1章'));
    check('Markdown 只有一个一级标题', (mdNote.replace(/^\uFEFF/, '').match(/^# /gm) || []).length === 1);
    const mdPlain2 = (await req('GET', `${BASE}/api/novels/${nid}/export?format=md`)).buf.toString('utf8');
    check('Markdown 不勾就没有信', !mdPlain2.includes('创作说明'));

    const epubNote = unzip((await req('GET', `${BASE}/api/novels/${nid}/export?format=epub&note=1`)).buf);
    check('EPUB 里有说明页', !!epubNote['OEBPS/note.xhtml'], Object.keys(epubNote).join(','));
    const opfN = epubNote['OEBPS/content.opf'].toString('utf8');
    check('EPUB 的 opf 收了说明页', opfN.includes('href="note.xhtml"') && opfN.includes('<itemref idref="note" />'));
    check('EPUB 目录里有入口', epubNote['OEBPS/nav.xhtml'].toString('utf8').includes('note.xhtml'));
    const noteXml = epubNote['OEBPS/note.xhtml'].toString('utf8');
    check('EPUB 说明页有附言', noteXml.includes('前十万字推翻重来过一次'));
    check('EPUB 说明页标成前言', noteXml.includes('epub:type="preface"'));
    const epubPlain2 = unzip((await req('GET', `${BASE}/api/novels/${nid}/export?format=epub`)).buf);
    check('EPUB 不勾就没有说明页', !epubPlain2['OEBPS/note.xhtml']);

    // 附言清空 → 信没了，事实那几行还在
    await put(`${BASE}/api/novels/${nid}`, { meta: { submissionNote: '' } });
    const txtBare = (await req('GET', `${BASE}/api/novels/${nid}/export?format=txt&note=1`)).buf.toString('utf8');
    check('附言清空只剩事实', txtBare.includes('创作说明') && !txtBare.includes('给编辑的话'));

    await req('DELETE', `${BASE}/api/novels/${nid}?permanent=1`);
  }

  // ---------------------------------------------------------------
  group('章节状态');
  {
    // 新建章节时 stage 会被尊重（拆分本章继承原章阶段靠这个）
    const c1 = await post(`${BASE}/api/novels/${id}/chapters`, { title: '阶段测试', content: 'x', stage: 'done' });
    check('新建章节尊重传入的 stage', c1.chapter?.stage === 'done', c1.chapter?.stage);
    const c2 = await post(`${BASE}/api/novels/${id}/chapters`, { title: '阶段测试2', content: 'x', stage: '乱填' });
    check('非法 stage 退回草稿', c2.chapter?.stage === 'draft', c2.chapter?.stage);
    // 改内容时不能顺手把状态改了
    const c3 = await put(`${BASE}/api/novels/${id}/chapters/${c1.chapter.id}`, {
      title: '阶段测试', content: '改过的正文', stage: 'done', targetWords: 0,
    });
    check('保存时 stage 保持不变', c3.chapter?.stage === 'done', c3.chapter?.stage);
    // 老作品只有 status 没有 stage：读出来按草稿，别把 status 当成定稿
    const legacy = await post(`${BASE}/api/novels`, { title: '老数据' });
    const legacyId = legacy.novel.id;
    const legacyCh = await post(`${BASE}/api/novels/${legacyId}/chapters`, { title: '老章节', content: '正文' });
    // 模拟老数据：只有 status，没有 stage
    await put(`${BASE}/api/novels/${legacyId}/chapters/${legacyCh.chapter.id}`, {
      title: '老章节', content: '正文', stage: undefined, status: 'done',
    });
    const legacyNovel = await get(`${BASE}/api/novels/${legacyId}`);
    check('无 stage 的老章节按草稿处理', legacyNovel.novel.chapters[0]?.stage === 'draft', legacyNovel.novel.chapters[0]?.stage);
    await req('DELETE', `${BASE}/api/novels/${legacyId}?permanent=1`);
  }

  // ---------------------------------------------------------------
  group('写作统计');
  {
    const s = await get(`${BASE}/api/stats?days=364`);
    check('统计能取一年区间', Array.isArray(s?.days) && s.days.length === 364, `days=${s?.days?.length}`);
    check('统计带目标与连续天数', typeof s?.goal === 'number' && typeof s?.streak === 'number');
    check('统计带日均产出', typeof s?.dailyRate === 'number' && s.dailyRate >= 0, s?.dailyRate);
    // 日均 = 最近 14 天的总和 ÷ 14（没写的日子也算进分母）
    {
      const last14 = (s.days || []).slice(-14);
      const expect = Math.round(last14.reduce((sum, d) => sum + (d.words || 0), 0) / Math.max(1, last14.length));
      check('日均产出的算法对得上', s.dailyRate === expect, `${s.dailyRate} vs ${expect}`);
    }
    // 改目标后能读回来
    const set = await post(`${BASE}/api/stats`, { goal: 2500 });
    check('日更目标可设置', set?.goal === 2500, set?.goal);
    await post(`${BASE}/api/stats`, { goal: 3000 });

    // 写作日历点某一天：当天分作品、分章节的明细
    const day = await get(`${BASE}/api/stats/day?date=2020-01-02`);
    check('某天明细能取', day && day.date === '2020-01-02' && typeof day.words === 'number', JSON.stringify(day).slice(0, 80));
    check('没有记录的那天返回 0 字', day.words === 0 && Array.isArray(day.novels) && day.novels.length === 0);
    const today = await get(`${BASE}/api/stats/day`);
    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    check('不传日期默认就是今天', today?.date === todayKey, `${today?.date} vs ${todayKey}`);

    // 往章节里写字，看统计里能不能追到「哪一章」
    const novel2 = await post(`${BASE}/api/novels`, { title: '统计明细测试', genre: '古风' });
    const nid2 = novel2.novel?.id;
    const ch2 = await post(`${BASE}/api/novels/${nid2}/chapters`, { title: '第一章 起', content: '短' });
    const cid2 = ch2.chapter?.id;
    const body = '他在灯下坐了很久，没有写字。'.repeat(20);
    await req('PUT', `${BASE}/api/novels/${nid2}/chapters/${cid2}`, { title: '第一章 起', content: body });
    const dayNow = await get(`${BASE}/api/stats/day?date=${todayKey}`);
    const row = (dayNow.novels || []).find((n) => n.novelId === nid2);
    check('写字记到了当天', !!row && row.words > 0, JSON.stringify(row));
    check('当天明细带出了书名', row?.title === '统计明细测试', row?.title);
    check('当天明细带出了章节', (row?.chapters || []).some((c) => c.chapterId === cid2 && c.words > 0), JSON.stringify(row?.chapters));
    check('章节字数加起来等于当天字数', row && (row.chapters || []).reduce((sum, c) => sum + c.words, 0) === row.words,
      `${row?.chapters?.reduce((sum, c) => sum + c.words, 0)} vs ${row?.words}`);
    await req('DELETE', `${BASE}/api/novels/${nid2}`);
    const trash2 = (await get(`${BASE}/api/trash`)).items || [];
    const t2 = trash2.find((t) => t.id === nid2);
    if (t2?.trashId) await req('DELETE', `${BASE}/api/trash/${t2.trashId}`);
  }

  // ---------------------------------------------------------------
  group('全书目标字数');
  {
    const before = (await get(`${BASE}/api/novels/${id}`)).novel;
    const list0 = (await get(`${BASE}/api/novels`)).novels || [];
    const item0 = list0.find((n) => n.id === id);
    check('没设目标时是 0', !item0?.targetWords, item0?.targetWords);

    const set = await put(`${BASE}/api/novels/${id}`, { meta: { targetWords: 300000 } });
    check('全书目标能保存', set.novel?.meta?.targetWords === 300000, set.novel?.meta?.targetWords);
    const list = (await get(`${BASE}/api/novels`)).novels || [];
    const item = list.find((n) => n.id === id);
    check('书架列表带得出目标', item?.targetWords === 300000, item?.targetWords);
    check('列表里也有当前字数', typeof item?.words === 'number' && item.words >= 0, item?.words);

    // 非法值要夹住
    const bad = await put(`${BASE}/api/novels/${id}`, { meta: { targetWords: 'abc' } });
    check('非法目标被夹成 0', bad.novel?.meta?.targetWords === 0, bad.novel?.meta?.targetWords);
    const big = await put(`${BASE}/api/novels/${id}`, { meta: { targetWords: 99999999 } });
    check('超上限的目标被夹住', big.novel?.meta?.targetWords === 1000000, big.novel?.meta?.targetWords);
    const neg = await put(`${BASE}/api/novels/${id}`, { meta: { targetWords: -1 } });
    check('负数目标被夹成 0', neg.novel?.meta?.targetWords === 0, neg.novel?.meta?.targetWords);
    // 存一次目标不能把别的 meta 字段弄丢
    check('其它 meta 字段没丢',
      neg.novel?.meta?.targetWordsPerChapter === before.meta?.targetWordsPerChapter
      && neg.novel?.meta?.logline === before.meta?.logline,
      `${neg.novel?.meta?.targetWordsPerChapter} / ${neg.novel?.meta?.logline}`);
    await put(`${BASE}/api/novels/${id}`, { meta: { targetWords: 0 } });
  }

  // ---------------------------------------------------------------
  group('导入已有文稿');
  await checkManuscript(id);

  // ---------------------------------------------------------------
  group('Word 导入');
  await checkDocxImport();

  // ---------------------------------------------------------------
  group('清理');
  for (const n of (await get(`${BASE}/api/novels`)).novels || []) {
    if (!isOurs(n.id)) continue;            // 作者原有的作品，不碰
    await req('DELETE', `${BASE}/api/novels/${n.id}?permanent=1`);
  }
  // 回收站里也只清本次建的，别把作者自己删掉的作品清空
  for (const t of (await get(`${BASE}/api/trash`)).items || []) {
    if (!isOurs(t.id)) continue;
    if (t.trashId) await req('DELETE', `${BASE}/api/trash/${t.trashId}`);
  }
  const left = ((await get(`${BASE}/api/novels`)).novels || []).filter((n) => isOurs(n.id));
  check('测试作品已清理', left.length === 0, `剩 ${left.length} 部`);
  const stillThere = new Set(((await get(`${BASE}/api/novels`)).novels || []).map((n) => n.id));
  const lost = [...beforeIds].filter((x) => !stillThere.has(x));
  check('原有的作品一部都没少', lost.length === 0, lost.join(','));
  const trashAfter = new Set((((await get(`${BASE}/api/trash`)).items) || []).map((t) => t.id));
  const lostTrash = [...beforeTrashIds].filter((x) => !trashAfter.has(x));
  check('回收站里原有的也还在', lostTrash.length === 0, lostTrash.join(','));
  // 码字统计还原成跑之前的样子
  try {
    if (statsBackup !== null) fs.writeFileSync(statsFile, statsBackup);
    else if (fs.existsSync(statsFile)) fs.rmSync(statsFile);
  } catch (err) {
    console.log('  FAIL 码字统计没还原：' + err.message);
    fail += 1;
    fails.push('码字统计没还原');
  }

  report();
}

function report() {
  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  if (fail) {
    console.log('失败项：');
    for (const f of fails) console.log('  -', f);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\n自检中断：', e.message);
  process.exit(2);
});
