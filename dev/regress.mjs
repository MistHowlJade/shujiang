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
//
// 全部通过时退出码为 0，可直接挂进 CI 或提交前的手动检查。
// ===========================================================================

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

async function main() {
  console.log('书匠 · 回归自检');
  console.log('目标：', BASE);

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
  const jsonExp = await req('GET', `${BASE}/api/novels/${id}/export?format=json`);
  check('备份 JSON 可解析', (() => { try { return !!JSON.parse(jsonExp.buf.toString('utf8')); } catch { return false; } })());

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
