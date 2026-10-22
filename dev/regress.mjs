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

async function main() {
  console.log('书匠 · 回归自检');

  // 连不上就早点说清楚，别打一屏无意义的 FAIL
  try {
    await fetch(`${BASE}/api/novels`);
  } catch {
    console.error('\n连不上本地服务，请先启动：tools\\node\\node.exe server\\server.js');
    process.exit(2);
  }

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

  // ---------------------------------------------------------------
  group('自定义封面');
  {
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
  const trash2 = await get(`${BASE}/api/trash`);
  check('回收站已空', (trash2.items || trash2.trash || []).length === 0);

  const search = await get(`${BASE}/api/library-search?q=${encodeURIComponent('正文')}`);
  check('全局搜索能搜到', (search.hits?.length || search.results?.length || 0) >= 1);

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
    // 改目标后能读回来
    const set = await post(`${BASE}/api/stats`, { goal: 2500 });
    check('日更目标可设置', set?.goal === 2500, set?.goal);
    await post(`${BASE}/api/stats`, { goal: 3000 });
  }

  // ---------------------------------------------------------------
  group('导入已有文稿');
  await checkManuscript(id);

  // ---------------------------------------------------------------
  group('清理');
  for (const n of (await get(`${BASE}/api/novels`)).novels || []) {
    await req('DELETE', `${BASE}/api/novels/${n.id}?permanent=1`);
  }
  await req('DELETE', `${BASE}/api/trash`);
  const left = (await get(`${BASE}/api/novels`)).novels || [];
  check('测试作品已清理', left.length === 0, `剩 ${left.length} 部`);

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
