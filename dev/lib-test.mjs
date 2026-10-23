// 书匠 · 纯计算模块自测
// ---------------------------------------------------------------------------
// web/lib/ 下的模块是纯计算，不碰 DOM、不依赖全局状态，所以能在 Node 里直接跑。
// 这里验的是最容易「看着能用其实算错」的那类逻辑：文本差异算法。
//
// 用法：
//   tools\node\node.exe dev\lib-test.mjs
// 全通过时退出码为 0。
// ===========================================================================

import fs from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { diffProse, diffHtml, diffSideHtml, splitSentences, lcsOps } from '../web/lib/diff.js';
import { bookGoalOf, fmtGoal, finishEstimate, daysPhrase, datePhrase, goalPanelHtml } from '../web/lib/goal.js';
import { scanProofChapter, buildProofReport } from '../web/lib/proof.js';
import { buildHealthReport, applyHealthIgnored, healthKey } from '../web/lib/health.js';
import { submissionFacts, submissionNote } from '../server/manuscript.js';
import { buildSubmitCheck, submitCheckHtml, wan, pickNos, SUBMIT_MIN_WORDS } from '../web/lib/submit.js';
import { PAPER_DEFAULTS, PAPER_SIZE_MIN, PAPER_SIZE_MAX, PAPER_LH_STEPS, PAPER_FONTS, PAPER_FONT_KEYS, normalizePaper, nextPaperSize, paperVars, paperLabel } from '../web/lib/paper.js';
import { buildPrintHtml } from '../server/print.js';
import { buildDocx } from '../server/docx.js';
import { zip, unzipEntry } from '../server/zip.js';
import { extractDocxText } from '../server/docx-import.js';

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};

/** 自测用：解开 ZIP 的本地文件头，够验 DOCX 内部 XML 了 */
function unzipDocx(buf) {
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
    files[name] = method === 0 ? raw : inflateRawSync(raw);
    i = start + compSize;
  }
  return files;
}

// 句子切分
check('按句号切分', splitSentences('他来了。她走了。').length === 2, JSON.stringify(splitSentences('他来了。她走了。')));
check('引号跟着上一句', splitSentences('他说：“走吧。”然后就走了。')[0] === '他说：“走吧。”', JSON.stringify(splitSentences('他说：“走吧。”然后就走了。')));
check('换行也算断句', splitSentences('第一行\n第二行').length === 2);
check('空文本不炸', splitSentences('').length === 0);

// 完全一样
{
  const t = '夜色压下来。他握紧了剑。';
  const d = diffProse(t, t);
  check('相同文本没有增删', d.added === 0 && d.removed === 0, JSON.stringify(d));
  check('相同文本相似度 100%', d.similarity === 100, String(d.similarity));
}

// 改一个字
{
  const d = diffProse('夜色压下来。', '夜色涌下来。');
  check('改一个字：增 1 字', d.added === 1, `added=${d.added} removed=${d.removed}`);
  check('改一个字：删 1 字', d.removed === 1, `added=${d.added} removed=${d.removed}`);
  check('改一个字：其余相同', d.same === 5, `same=${d.same}`);
}

// 整段替换（句子结构一样，只换了词）
{
  const d = diffProse('他来了。', '她走了。');
  check('整段替换算成改动', d.added > 0 && d.removed > 0, `added=${d.added} removed=${d.removed}`);
  check('整段替换仍认出共同的尾巴', d.same === 2, `same=${d.same}`);
}

// 一头一尾相同、中间改
{
  const d = diffProse('开头一样。中间改了。结尾一样。', '开头一样。中间换了。结尾一样。');
  check('首尾相同被识别出来', d.same >= 8, `same=${d.same}`);
  check('中间一字之差被定位', d.added === 1 && d.removed === 1, `added=${d.added} removed=${d.removed}`);
}

// 顺序颠倒
{
  const d = diffProse('甲。乙。丙。', '丙。乙。甲。');
  check('顺序颠倒能看出改动', d.added > 0 && d.removed > 0);
}

// 渲染
{
  const d = diffProse('夜色压下来。', '夜色涌下来。');
  const html = diffHtml(d.segs, false);
  check('渲染出删除标记', html.includes('class="d-del"'));
  check('渲染出新增标记', html.includes('class="d-add"'));
  check('渲染保留相同部分', html.includes('夜色'));
  const only = diffHtml(d.segs, true);
  check('只看改动时不含相同部分', !only.includes('d-same'));
}

// 左右两栏的渲染
{
  const d = diffProse('夜色压下来。', '夜色涌下来。');
  const oldHtml = diffSideHtml(d.segs, 'old');
  const newHtml = diffSideHtml(d.segs, 'new');
  check('旧栏只标删除', oldHtml.includes('d-del') && !oldHtml.includes('d-add'), oldHtml);
  check('新栏只标新增', newHtml.includes('d-add') && !newHtml.includes('d-del'), newHtml);
  check('旧栏保留没变的部分', oldHtml.includes('夜色'));
  check('新栏保留没变的部分', newHtml.includes('夜色'));
}

// 只看某一边时的「只看改动」
{
  const d = diffProse('夜色压下来。他握紧了剑。', '夜色涌下来。他握紧了刀。');
  const oldOnly = diffSideHtml(d.segs, 'old', true);
  const newOnly = diffSideHtml(d.segs, 'new', true);
  check('只看改动时旧栏只剩改动部分', !oldOnly.includes('夜色') && oldOnly.includes('d-del'), oldOnly);
  check('只看改动时新栏只剩改动部分', !newOnly.includes('夜色') && newOnly.includes('d-add'), newOnly);
  check('只看改动时旧栏不含新增', !oldOnly.includes('d-add'), oldOnly);
  check('只看改动时新栏不含删除', !newOnly.includes('d-del'), newOnly);
}

// 转义：正文里带尖括号不能破坏 HTML
{
  const d = diffProse('他说 <script>alert(1)</script>。', '他说 <b>x</b>。');
  const html = diffHtml(d.segs, false);
  check('HTML 特殊字符被转义', !html.includes('<script>') && !html.includes('<b>x</b>'), html.slice(0, 120));
}

// 空的一边
{
  const d = diffProse('', '全是新内容。');
  check('空 → 有内容：全是新增', d.added > 0 && d.removed === 0, `added=${d.added} removed=${d.removed}`);
  const d2 = diffProse('全是旧内容。', '');
  check('有内容 → 空：全是删除', d2.added === 0 && d2.removed > 0);
}

// lcsOps 基本正确性
{
  const ops = lcsOps(['a', 'b', 'c'], ['a', 'x', 'c']);
  const same = ops.filter((o) => o.type === 'same').map((o) => o.text).join('');
  check('LCS 保住共同部分', same === 'ac', same);
}

// 长文本不卡死
{
  const a = '句子。'.repeat(4000);
  const b = '句子。'.repeat(2000) + '别的话。' + '句子。'.repeat(2000);
  const t0 = Date.now();
  const d = diffProse(a, b);
  const ms = Date.now() - t0;
  check('长文本也能在 1 秒内算完', ms < 1000, `${ms}ms, added=${d.added}`);
  check('长文本找出了多出来的那一句', d.added === 4 && d.removed === 0, `added=${d.added} removed=${d.removed}`);
  check('长文本的其余部分全判为相同', d.same === 12000, `same=${d.same}`);
}

// ---------------- 全书目标与完稿预测 ----------------

// 目标字数格式
check('30 万显示成「30 万」', fmtGoal(300000) === '30 万', fmtGoal(300000));
check('小于一万不换算', fmtGoal(8000) === '8000', fmtGoal(8000));

// 没设目标
check('没设目标返回 null', bookGoalOf({ chapters: [{ content: 'abc' }] }) === null);
check('空对象返回 null', bookGoalOf(null) === null);

// 完整作品（有 chapters）
{
  const n = { meta: { targetWords: 100000 }, chapters: [{ content: '字'.repeat(25000) }, { content: '字'.repeat(25000) }] };
  const g = bookGoalOf(n);
  check('进度按正文算', g.words === 50000, String(g.words));
  check('百分比对得上', g.pct === 50, String(g.pct));
  check('还差多少对得上', g.left === 50000, String(g.left));
  check('没写完就是没完成', g.done === false);
}

// 书架列表数据（只有 words / targetWords）
{
  const g = bookGoalOf({ words: 20000, targetWords: 100000 });
  check('列表数据也能算', g && g.pct === 20 && g.left === 80000, JSON.stringify(g));
}

// 写超了
{
  const g = bookGoalOf({ words: 150000, targetWords: 100000 });
  check('写超了封顶 100%', g.pct === 100, String(g.pct));
  check('写超了还差 0', g.left === 0, String(g.left));
  check('写超了算已完成', g.done === true);
}

// 完稿预测
{
  const g = { target: 100000, words: 20000, pct: 20, left: 80000, done: false };
  const est = finishEstimate(g, { dailyRate: 2000 }, new Date(2026, 0, 1));
  check('按日均算出还要多少天', est.days === 40, String(est.days));
  check('预计完稿日期对得上', datePhrase(est.date) === '2 月 10 日', datePhrase(est.date));
  check('天数说法像人话', daysPhrase(40) === '还要 6 周（约 40 天）', daysPhrase(40));
}

// 没动笔就估不出来
{
  const g = { target: 100000, words: 0, pct: 0, left: 100000, done: false };
  const est = finishEstimate(g, { dailyRate: 0 });
  check('日均为 0 就算不出', est.days === null && est.rate === 0, JSON.stringify(est));
  check('算不出时也有话说', daysPhrase(null) === '还不知道要多久', daysPhrase(null));
}

// 写完了
{
  const g = { target: 100000, words: 100000, pct: 100, left: 0, done: true };
  const est = finishEstimate(g, { dailyRate: 2000 });
  check('写完了就完稿了', est.done === true && est.days === 0, JSON.stringify(est));
}

// 天数说法
check('不到两周按天说', daysPhrase(9) === '还要 9 天', daysPhrase(9));
check('几个月按月说', daysPhrase(90) === '还要 3 个月（约 90 天）', daysPhrase(90));
check('超过一年按年说', daysPhrase(500) === '还要 1.4 年（约 500 天）', daysPhrase(500));

// 统计面板里的目标区块
{
  const none = goalPanelHtml(null, { dailyRate: 1000 });
  check('没打开作品时给出提示', none.includes('goal-panel empty') && none.includes('打开一部作品'));
  check('没打开作品时不给按钮', !none.includes('stSetGoal'));

  const noGoal = goalPanelHtml({ title: '甲书', meta: {}, chapters: [] }, { dailyRate: 1000 });
  check('没定目标时给出提示', noGoal.includes('还没定全书目标字数'));
  check('没定目标时给去设定按钮', noGoal.includes('stSetGoal'));

  const n = { title: '乙书', meta: { targetWords: 100000 }, chapters: [{ content: '字'.repeat(25000) }] };
  const g = goalPanelHtml(n, { dailyRate: 2000 });
  check('有目标时显示书名', g.includes('《乙书》'));
  check('有目标时显示目标字数', g.includes('目标 10 万 字'));
  check('有目标时显示进度', g.includes('25%') && g.includes('width:25%'));
  check('有目标时显示还差多少', g.includes('还差 7.50 万 字'), g.slice(0, 200));
  check('有目标时显示完稿预测', g.includes('日均 2000 字算') && g.includes('完稿'));

  const done = goalPanelHtml({ title: '丙书', meta: { targetWords: 1000 }, chapters: [{ content: '字'.repeat(2000) }] }, { dailyRate: 100 });
  check('写完了显示已达成', done.includes('已达成目标') && done.includes('goal-panel done'));

  const idle = goalPanelHtml(n, { dailyRate: 0 });
  check('最近没动笔就说算不出', idle.includes('算不出还要多久'), idle.slice(0, 260));

  const escaped = goalPanelHtml({ title: '<b>x</b>', meta: { targetWords: 1000 }, chapters: [] }, { dailyRate: 1 });
  check('书名里的尖括号被转义', !escaped.includes('<b>x</b>'), escaped.slice(0, 120));
}

// ---------------- 校对：忽略用的指纹 ----------------
{
  const ch = { id: 'c_x', no: 1, title: '测试章', content: '他站在巷口，心里想的的确的事。' };
  const scan = scanProofChapter(ch, 0);
  check('扫得出叠字问题', scan.issues.some((i) => i.type === 'typo'), JSON.stringify(scan.issues.map((i) => i.message)));
  check('每条问题都有指纹', scan.issues.every((i) => typeof i.key === 'string' && i.key.includes('c_x')), JSON.stringify(scan.issues.map((i) => i.key)));

  // 同样的内容再扫一次，指纹不变
  const again = scanProofChapter({ ...ch }, 0);
  const keysA = scan.issues.map((i) => i.key).sort().join('|');
  const keysB = again.issues.map((i) => i.key).sort().join('|');
  check('重复扫描指纹不变', keysA === keysB, `${keysA} vs ${keysB}`);

  // 位置变了（前面加一段话），指纹仍然不变 —— 作者挪动文字不该让忽略失效
  const moved = scanProofChapter({ ...ch, content: `前面多了一段话。\n\n${ch.content}` }, 0);
  check('挪动位置后指纹不变', moved.issues.map((i) => i.key).sort().join('|') === keysA,
    `${moved.issues.map((i) => i.key).sort().join('|')} vs ${keysA}`);

  // 改掉问题本身，指纹要变（否则改好了还一直不报）
  const fixed = scanProofChapter({ ...ch, content: '他站在巷口，心里想的确的事。' }, 0);
  const typoKeys = (s) => s.issues.filter((i) => i.type === 'typo').map((i) => i.key);
  check('问题改掉后指纹会变', typoKeys(fixed).join('|') !== typoKeys(scan).join('|'),
    `${typoKeys(fixed).join('|')} vs ${typoKeys(scan).join('|')}`);

  // 不同的章节，指纹要不同（不然忽略一章会误伤另一章）
  const other = scanProofChapter({ ...ch, id: 'c_y' }, 0);
  check('不同章节指纹不同', other.issues.some((i) => i.key.includes('c_y')));

  // 全书报告里也一样带着指纹
  const report = buildProofReport({ id: 'n_x', title: '书', chapters: [ch] }, 'book', null);
  check('全书报告里的问题也有指纹', (report.issues || []).every((i) => !!i.key));
}

// ---------------- 体检：忽略用的指纹 ----------------
{
  // 造一本能触发体检项的作品
  const novel = {
    id: 'n_h', title: '体检测试',
    bible: { characters: [{ name: '甲', role: '主角' }, { name: '乙', role: '配角' }], world: [], timeline: [] },
    chapters: [],
  };
  for (let i = 1; i <= 6; i++) {
    novel.chapters.push({
      id: `c_h${i}`, no: i, title: `第${i}章`,
      content: i === 1 ? '甲站在巷口。'.repeat(60) : `乙走过长街。${'风很大。'.repeat(80)}`,
      memory: i === 1 ? { summary: '甲在巷口。', characters: ['甲'], events: ['甲出现'], unresolved: ['巷口的剑'] } : null,
    });
  }
  const r = buildHealthReport(novel);
  check('体检能扫出重复段落', r.duplicates.length >= 1, JSON.stringify(r.duplicates.map((d) => d.sample.slice(0, 12))));
  check('体检能扫出人物断档', r.gaps.length >= 1, JSON.stringify(r.gaps.map((g) => g.name)));
  check('体检能扫出未回收线索', r.staleThreads.length >= 1, JSON.stringify(r.staleThreads.map((t) => t.text)));

  // 指纹格式
  check('体检指纹带种类和标识', healthKey('gap', '甲') === 'health|gap|甲', healthKey('gap', '甲'));

  // 忽略一条人物断档
  const key = healthKey('gap', r.gaps[0].name);
  const filtered = applyHealthIgnored(r, [{ key }]);
  check('忽略后那条不见了', filtered.gaps.length === r.gaps.length - 1, `${filtered.gaps.length} vs ${r.gaps.length}`);
  check('忽略后计数也改了', filtered.gapTotal === r.gapTotal - 1, `${filtered.gapTotal} vs ${r.gapTotal}`);
  check('忽略别的类不影响这条', filtered.duplicates.length === r.duplicates.length);
  check('忽略后「有几类问题」重算了', filtered.issueKinds <= r.issueKinds, `${filtered.issueKinds} vs ${r.issueKinds}`);

  // 全都忽略了 → issueKinds 应该变小
  const allKeys = [
    ...r.gaps.map((g) => healthKey('gap', g.name)),
    ...r.duplicates.map((d) => healthKey('dup', String(d.sample || '').slice(0, 40))),
    ...r.staleThreads.map((t) => healthKey('thread', t.text)),
    ...r.outliers.map((o) => healthKey('outlier', o.id)),
  ].map((k) => ({ key: k }));
  const cleared = applyHealthIgnored(r, allKeys);
  check('全忽略后问题类数减少', cleared.issueKinds < r.issueKinds, `${cleared.issueKinds} vs ${r.issueKinds}`);
  check('全忽略后各列表都空了', cleared.gaps.length === 0 && cleared.duplicates.length === 0 && cleared.staleThreads.length === 0);

  // 忽略清单写成字符串也能认
  const asStrings = applyHealthIgnored(r, [key]);
  check('忽略清单用字符串也能认', asStrings.gaps.length === r.gaps.length - 1);
}

// ---------------- 投稿附言：事实与去重 ----------------
{
  const novel = {
    title: '剑与长街', author: '张三', genre: '玄幻',
    meta: { platform: '起点', targetWords: 0, logline: '一句话。', contact: 'me@x.com', submissionNote: '  给编辑的话  \n\n第二段  ' },
    chapters: [
      { id: 'c1', content: '一二三四五', stage: 'done' },
      { id: 'c2', content: '一二三四五六七', stage: 'draft' },
      { id: 'c3', content: '', stage: 'draft' },
    ],
  };
  const f = submissionFacts(novel, 12);
  const labels = f.map((x) => x.label);
  check('附言的篇幅按章数与定稿数算', f[0].value === '共 3 章 · 已定稿 1 章 · 全书约 12 字', f[0].value);
  check('字数带千分位', submissionFacts(novel, 1234567)[0].value.includes('1,234,567'), submissionFacts(novel, 1234567)[0].value);
  check('没设目标就不写进度行', !labels.includes('进度'), labels.join(','));
  check('设了目标才算进度', submissionFacts({ ...novel, meta: { ...novel.meta, targetWords: 100 } }, 25)
    .find((x) => x.label === '进度')?.value === '全书目标 100 字，目前约 25%');
  check('写完不超过 100%', submissionFacts({ ...novel, meta: { ...novel.meta, targetWords: 10 } }, 999)
    .find((x) => x.label === '进度')?.value.endsWith('100%'));
  check('刚动笔不写「约 0%」', submissionFacts({ ...novel, meta: { ...novel.meta, targetWords: 1000 } }, 3)
    .find((x) => x.label === '进度')?.value.endsWith('目前不到 1%'));
  check('平台写了才有', labels.includes('目标平台'));
  check('没写平台就不出现', !submissionFacts({ ...novel, meta: { ...novel.meta, platform: '' } }, 12).some((x) => x.label === '目标平台'));
  // 稿件头部已经印过的东西不该再抄一遍
  for (const k of ['作品', '作者', '类型', '联系方式', '一句话故事']) {
    check(`附言里不重复「${k}」`, !labels.includes(k), labels.join(','));
  }
  check('附言会去掉首尾空白', submissionNote(novel) === '给编辑的话  \n\n第二段', JSON.stringify(submissionNote(novel)));
  check('没写附言时返回空串', submissionNote({ meta: {} }) === '' && submissionNote(null) === '');
}

// ---------------------------------------------------------------
// 交稿检查
{
  const mk = (over = {}) => ({
    title: '测试稿',
    author: '林一',
    genre: '仙侠',
    outline: { volumes: [] },
    bible: { characters: [] },
    ...over,
    meta: { logline: '一句话故事', contact: 'me@example.com', submissionNote: '给编辑的话', ...(over.meta || {}) },
    chapters: over.chapters || [],
  });
  const ch = (no, words, stage = 'done') => ({
    id: `c${no}`, no, title: `标题${no}`, stage, content: '字'.repeat(words),
  });
  const item = (r, key) => r.items.find((i) => i.key === key);

  const six = mk({ chapters: [ch(1, 12000), ch(2, 12000), ch(3, 6000)] });
  const ok = buildSubmitCheck(six, six.chapters, { scope: '全书' });
  check('全都齐了就是 ok', ok.level === 'ok', `${ok.level} / ${ok.errors} / ${ok.warns}`);
  check('字数与章数算对', ok.words === 30000 && ok.chapters === 3, `${ok.words} / ${ok.chapters}`);
  check('整本检查范围原样带回', ok.scope === '全书');
  check('齐了也有话说', ok.verdict === '没发现拦住投稿的问题，可以发了。', ok.verdict);

  // 空章节：直接拦住
  const withEmpty = mk({ chapters: [ch(1, 12000), ch(2, 0), ch(3, 12000), ch(4, 0)] });
  const r1 = buildSubmitCheck(withEmpty, withEmpty.chapters);
  check('空章节算 error', item(r1, 'empty').level === 'error', item(r1, 'empty').level);
  check('空章节点名到章', item(r1, 'empty').detail.includes('第 2 章、第 4 章'), item(r1, 'empty').detail);
  check('空章节能跳过去补', item(r1, 'empty').action?.kind === 'chapter' && item(r1, 'empty').action.id === 'c2');
  check('有 error 时结论也是 error', r1.level === 'error', r1.level);

  // 没定稿只说一句
  const drafts = mk({ chapters: [ch(1, 12000, 'done'), ch(2, 12000, 'draft'), ch(3, 12000, 'revising')] });
  const r2 = buildSubmitCheck(drafts, drafts.chapters);
  check('未定稿算 warn', item(r2, 'draft').level === 'warn', item(r2, 'draft').level);
  check('未定稿点名到章', item(r2, 'draft').detail.includes('第 2 章、第 3 章'), item(r2, 'draft').detail);
  check('未定稿不拦人', r2.level === 'warn' && r2.errors === 0, `${r2.level}/${r2.errors}`);

  // 只导定稿时，草稿不进列表
  const doneOnly = buildSubmitCheck(drafts, drafts.chapters.filter((c) => c.stage === 'done'), { onlyDone: true });
  check('只发定稿时不再报草稿', item(doneOnly, 'draft').level === 'ok', item(doneOnly, 'draft').level);
  check('只发定稿时说清漏了哪几章', item(doneOnly, 'draft').detail.includes('还有 2 章没定稿'), item(doneOnly, 'draft').detail);
  check('只发定稿的标题带章数', item(doneOnly, 'draft').title === '只发定稿的 1 章', item(doneOnly, 'draft').title);

  // 字数门槛
  const short = mk({ chapters: [ch(1, 8000), ch(2, 8000)] });
  const r3 = buildSubmitCheck(short, short.chapters);
  check('不到 3 万字算 warn', item(r3, 'words').level === 'warn', item(r3, 'words').level);
  check('差多少字说清楚', item(r3, 'words').title === '1.6 万字，离 3 万字还差 1.4 万字', item(r3, 'words').title);
  check('够了就说过了门槛', item(ok, 'words').title === '3 万字，过了 3 万字的常见门槛', item(ok, 'words').title);

  // 材料
  check('有作者就 ok', item(ok, 'author').level === 'ok', item(ok, 'author').level);
  const noAuthor = buildSubmitCheck({ ...six, author: '  ' }, six.chapters);
  check('没作者算 warn', item(noAuthor, 'author').level === 'warn');
  check('没作者能跳去填', item(noAuthor, 'author').action?.kind === 'author');
  const noInfo = buildSubmitCheck({ ...six, meta: { ...six.meta, logline: '', synopsis: '' } }, six.chapters);
  check('没简介算 warn', item(noInfo, 'logline').level === 'warn');
  check('只有梗概也算写了', item(buildSubmitCheck({ ...six, meta: { ...six.meta, logline: '', synopsis: '梗概' } }, six.chapters), 'logline').level === 'ok');
  check('没联系方式算 warn', item(buildSubmitCheck({ ...six, meta: { ...six.meta, contact: '' } }, six.chapters), 'contact').level === 'warn');
  check('没附言只算提示（不拦人）', item(buildSubmitCheck({ ...six, meta: { ...six.meta, submissionNote: '' } }, six.chapters), 'note').level === 'info');
  check('附言写出字数', item(ok, 'note').title === '投稿附言 5 字', item(ok, 'note').title);
  check('没有附带材料时给个入口', item(ok, 'extras').action?.kind === 'outline');
  const withOutline = buildSubmitCheck({ ...six, outline: { volumes: [{ chapters: [{ title: '甲' }, { title: '乙' }] }] }, bible: { characters: [{ name: '甲' }, { name: '乙' }, { name: '丙' }] } }, six.chapters);
  check('有材料就不催了', item(withOutline, 'extras').action === null && item(withOutline, 'extras').title.includes('大纲 2 章 · 人物 3 张'),
    item(withOutline, 'extras').title);
  const blankOutline = buildSubmitCheck({ ...six, outline: { volumes: [{ chapters: [{}, { summary: '  ' }] }] }, bible: { characters: [{ name: '' }] } }, six.chapters);
  check('空的大纲行 / 无名人物不算材料', blankOutline.items.find((i) => i.key === 'extras').title === '还没有可随稿附带的材料',
    blankOutline.items.find((i) => i.key === 'extras').title);

  // 区间：按章号排好，只算选中的那几章
  const ten = mk({ chapters: Array.from({ length: 10 }, (_, i) => ch(i + 1, 4000)) });
  const picked = [ten.chapters[4], ten.chapters[2], ten.chapters[3]];
  const r4 = buildSubmitCheck(ten, picked);
  check('区间只算选中的章数', r4.chapters === 3 && r4.words === 12000, `${r4.chapters}/${r4.words}`);
  check('区间也认全书总章数', r4.total === 10, String(r4.total));

  // 空列表
  const none = buildSubmitCheck(ten, []);
  check('一章都没有算 error', none.level === 'error' && item(none, 'empty').title === '这次一章都没有', item(none, 'empty').title);

  // 格式化与渲染
  check('wan：一万以下按字', wan(8600) === '8600 字', wan(8600));
  check('wan：整万不带小数', wan(30000) === '3 万字', wan(30000));
  check('wan：带小数', wan(96000) === '9.6 万字', wan(96000));
  check('pickNos：多了就收成等 N 章', pickNos(Array.from({ length: 9 }, (_, i) => ({ no: i + 1 }))) === '第 1 章、第 2 章、第 3 章、第 4 章、第 5 章、第 6 章 等 9 章',
    pickNos(Array.from({ length: 9 }, (_, i) => ({ no: i + 1 }))));

  const html = submitCheckHtml(ok);
  check('渲染出正文 / 材料两组', html.includes('>正文<') && html.includes('>材料<'));
  check('渲染带结论色', html.includes('submit-verdict ok'), html.slice(0, 80));
  const evil = buildSubmitCheck({ ...six, author: '<b>某人</b>' }, six.chapters);
  check('作者名里的尖括号被转义', submitCheckHtml(evil).includes('&lt;b&gt;') && !submitCheckHtml(evil).includes('<b>'));
  check('有动作才渲染按钮', submitCheckHtml(noAuthor).includes('data-sub-act="author"'));
  check('没动作就不渲染按钮', !submitCheckHtml(withOutline).includes('data-sub-act='));
  check('三万字门槛常量没被改', SUBMIT_MIN_WORDS === 30000);
}

// ---------------------------------------------------------------
// 稿纸排版
{
  check('没设置过时用默认 16 / 2.0 / 宋体',
    JSON.stringify(normalizePaper()) === JSON.stringify({ size: 16, lh: 2, font: 'serif' }), JSON.stringify(normalizePaper()));
  check('默认值就是老版本写死的样子', PAPER_DEFAULTS.size === 16 && PAPER_DEFAULTS.lh === 2 && PAPER_DEFAULTS.font === 'serif');
  check('字号边界是 14–22', PAPER_SIZE_MIN === 14 && PAPER_SIZE_MAX === 22);
  check('行距五档且含 2.0', PAPER_LH_STEPS.length === 5 && PAPER_LH_STEPS.includes(2), PAPER_LH_STEPS.join(','));

  // 字号：夹取 + 取整 + 字符串也认
  check('字号太小夹到 14', normalizePaper({ size: 9 }).size === 14, String(normalizePaper({ size: 9 }).size));
  check('字号太大夹到 22', normalizePaper({ size: 40 }).size === 22, String(normalizePaper({ size: 40 }).size));
  check('字号小数四舍五入', normalizePaper({ size: 17.6 }).size === 18, String(normalizePaper({ size: 17.6 }).size));
  check('字号字符串也认', normalizePaper({ size: '18' }).size === 18);
  check('字号乱写退回 16', normalizePaper({ size: 'big' }).size === 16);
  check('字号是 null 按没填算', normalizePaper({ size: null }).size === 16);
  check('整个配置不是对象也不炸', JSON.stringify(normalizePaper('x')) === JSON.stringify({ size: 16, lh: 2, font: 'serif' }));
  check('行距是空串按没填算', normalizePaper({ lh: '' }).lh === 2);

  // 行距：吸到最近的档，不让设置页出现「没一档选中」
  check('行距吸到最近的档（2.1 → 2.0）', normalizePaper({ lh: 2.1 }).lh === 2, String(normalizePaper({ lh: 2.1 }).lh));
  check('行距吸到最近的档（2.15 → 2.2）', normalizePaper({ lh: 2.15 }).lh === 2.2, String(normalizePaper({ lh: 2.15 }).lh));
  check('行距太小吸到 1.6', normalizePaper({ lh: 0.9 }).lh === 1.6, String(normalizePaper({ lh: 0.9 }).lh));
  check('行距太大吸到 2.4', normalizePaper({ lh: 9 }).lh === 2.4, String(normalizePaper({ lh: 9 }).lh));
  check('行距乱写退回 2.0', normalizePaper({ lh: 'wide' }).lh === 2);

  // 字体
  check('楷体原样保留', normalizePaper({ font: 'kai' }).font === 'kai');
  check('不认识的字体退回宋体', normalizePaper({ font: 'comic-sans' }).font === 'serif');
  check('原型上的键不算字体', normalizePaper({ font: 'toString' }).font === 'serif');
  check('三款字体都有中文名和 font-family',
    ['serif', 'sans', 'kai'].every((k) => PAPER_FONTS[k].label && /serif|sans-serif/.test(PAPER_FONTS[k].family)));

  // 加减字号
  check('放大一格', nextPaperSize(16, 1) === 17);
  check('缩小一格', nextPaperSize(16, -1) === 15);
  check('最大就停在 22', nextPaperSize(22, 1) === 22 && nextPaperSize(21, 5) === 22);
  check('最小就停在 14', nextPaperSize(14, -1) === 14 && nextPaperSize(15, -5) === 14);
  check('乱给一个当前字号按默认走', nextPaperSize('x', 1) === 17);
  check('当前字号是 null 也按默认走', nextPaperSize(null, 1) === 17);

  // 落成 CSS 变量
  const vars = paperVars({ size: 18, lh: 2.2, font: 'kai' });
  check('CSS 变量正好三个', Object.keys(vars).length === 3 && '--ed-size' in vars && '--ed-lh' in vars && '--ed-font' in vars,
    Object.keys(vars).join(','));
  check('字号带 px', vars['--ed-size'] === '18px', vars['--ed-size']);
  check('行距是数字', vars['--ed-lh'] === '2.2', vars['--ed-lh']);
  check('楷体的 font-family 落到变量上', vars['--ed-font'].includes('KaiTi'), vars['--ed-font']);

  // 给人看的一句话
  check('标签写清三项', paperLabel({ size: 16, lh: 2, font: 'serif' }) === '16 px · 2.0 倍行距 · 宋体', paperLabel({ size: 16, lh: 2, font: 'serif' }));
  check('标签用中文行距与字体', paperLabel({ size: 18, lh: 2.2, font: 'kai' }) === '18 px · 2.2 倍行距 · 楷体', paperLabel({ size: 18, lh: 2.2, font: 'kai' }));

  // 设置页的档位是手写在 index.html 里的，靠这几条守住两处不跑偏
  const indexHtml = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const sizeInput = indexHtml.match(/id="paperSize"[^>]*min="(\d+)"[^>]*max="(\d+)"/);
  check('字号滑块的上下限与模块一致',
    !!sizeInput && Number(sizeInput[1]) === PAPER_SIZE_MIN && Number(sizeInput[2]) === PAPER_SIZE_MAX,
    sizeInput ? `${sizeInput[1]}–${sizeInput[2]}` : '没找到 #paperSize');
  check('设置页的行距档与模块一致',
    PAPER_LH_STEPS.every((v) => indexHtml.includes(`data-lh="${v}"`)),
    PAPER_LH_STEPS.map((v) => `${v}:${indexHtml.includes(`data-lh="${v}"`)}`).join(' '));
  check('设置页的字体档与模块一致',
    PAPER_FONT_KEYS.every((k) => indexHtml.includes(`data-font="${k}"`) && indexHtml.includes(`>${PAPER_FONTS[k].label}<`)),
    PAPER_FONT_KEYS.join(','));
}

// ---------------------------------------------------------------
// 打印稿 / PDF
{
  const pn = {
    title: '雾城 <记>',
    author: '林三',
    genre: '悬疑',
    meta: {
      contact: 'me@example.com',
      logline: '一座会遗忘人的城。',
      submissionNote: '这是第一段。\n这是第二段。',
    },
    chapters: [
      { id: 'c1', no: 1, title: '夜车', content: '第一段。\n第二段「引号」。\n\n第三段。', stage: 'done', outlineId: 'o1' },
      { id: 'c2', no: 2, title: '', content: '', stage: 'draft', volumeId: 'v2' },
    ],
    outline: {
      volumes: [
        { id: 'v1', name: '风起', desc: '第一卷的说明', chapters: [{ id: 'o1', title: '夜车' }] },
        { id: 'v2', name: '第2卷 云涌', chapters: [] },
      ],
    },
  };
  const all = buildPrintHtml(pn, pn.chapters, { note: true });
  check('打印稿是完整 HTML', all.startsWith('<!doctype html>') && all.includes('<html lang="zh-CN">'));
  check('打印稿标题里带书名并转义', all.includes('<title>《雾城 &lt;记&gt;》· 打印稿</title>') && !all.includes('雾城 <记>'));
  check('工具栏有打印按钮', all.includes('打印 / 存为 PDF') && all.includes('id="printBtn"'));
  check('A4 页面与打印样式在', all.includes('@page { size: A4; margin: 22mm 20mm; }') && all.includes('@media print'));
  check('每章另起一页', all.includes('break-before: page'));
  check('书名页三项都在', all.includes('class="titlepage"') && all.includes('悬疑') && all.includes('林三') && all.includes('me@example.com'));
  check('书名页有简介与篇幅', all.includes('一座会遗忘人的城。') && all.includes('全书 2 章') && all.includes('约 16 字'));
  check('创作说明页在', all.includes('class="note-page"') && all.includes('创作说明') && all.includes('篇幅'));
  check('附言一行一段', all.includes('<p>这是第一段。</p>') && all.includes('<p>这是第二段。</p>'));
  check('两个分卷页都在', (all.match(/class="volume"/g) || []).length === 2 && all.includes('第1卷 风起') && all.includes('第2卷 云涌'));
  check('卷说明进卷页', all.includes('第一卷的说明'));
  check('章节标题与空章提示', all.includes('第1章 夜车') && all.includes('第2章') && all.includes('（本章还没有正文）'));
  check('正文一行一段', all.includes('<p>第一段。</p>') && all.includes('<p>第二段「引号」。</p>') && all.includes('<p>第三段。</p>'));
  check('空行不产生空段', !all.includes('<p></p>'));
  check('没有 undefined / NaN', !all.includes('undefined') && !all.includes('NaN'));

  const noNote = buildPrintHtml(pn, pn.chapters, {});
  check('不勾附言就没有创作说明页', !noNote.includes('class="note-page"'));

  const range = buildPrintHtml(pn, [pn.chapters[0]], { range: { lo: 1, hi: 3 } });
  check('区间打印标成节选', range.includes('节选 · 第 1–3 章') && range.includes('共 1 章'));

  const done = buildPrintHtml(pn, [pn.chapters[0]], { onlyDone: true });
  check('只打印定稿时写清定稿', done.includes('定稿 1 章'));

  const single = buildPrintHtml(pn, [pn.chapters[1]], { single: true });
  check('单章打印写清章号', single.includes('第 2 章 · 约 0 字'));

  const evilCh = { id: 'c3', no: 3, title: '<b>x</b>', content: '<script>alert(1)</script>' };
  const evil = buildPrintHtml({ ...pn, chapters: [evilCh] }, [evilCh]);
  check('章节标题与正文里的尖括号被转义',
    evil.includes('&lt;b&gt;x&lt;/b&gt;') && evil.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !evil.includes('<script>alert(1)</script>'));
}

// ---------------------------------------------------------------
// Word（.docx）
{
  const pn = {
    title: '雾城 <记>',
    author: '林三',
    genre: '悬疑',
    meta: {
      contact: 'me@example.com',
      logline: '一座会遗忘人的城。',
      submissionNote: '这是第一段。\n这是第二段。',
    },
    chapters: [
      { id: 'c1', no: 1, title: '夜车', content: '第一段。\n第二段「引号」。\n\n第三段。', stage: 'done', outlineId: 'o1' },
      { id: 'c2', no: 2, title: '', content: '', stage: 'draft', volumeId: 'v2' },
    ],
    outline: {
      volumes: [
        { id: 'v1', name: '风起', desc: '第一卷的说明', chapters: [{ id: 'o1', title: '夜车' }] },
        { id: 'v2', name: '第2卷 云涌', chapters: [] },
      ],
    },
  };
  const buf = buildDocx(pn, pn.chapters, { note: true });
  const files = unzipDocx(buf);
  const doc = files['word/document.xml'].toString('utf8');
  const styles = files['word/styles.xml'].toString('utf8');
  const footer = files['word/footer1.xml'].toString('utf8');
  const firstFooter = files['word/footer2.xml'].toString('utf8');
  const types = files['[Content_Types].xml'].toString('utf8');
  const rels = files['word/_rels/document.xml.rels'].toString('utf8');
  check('Word 是 zip 包', buf.length > 1000 && buf.readUInt32LE(0) === 0x04034b50);
  check('Word 必需部件都在',
    ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/footer1.xml', 'word/footer2.xml']
      .every((n) => files[n]));
  check('Word 的 content types 收了正文与页脚', types.includes('/word/document.xml') && types.includes('/word/footer1.xml'));
  check('Word 的页脚关系都在', rels.includes('footer1.xml') && rels.includes('footer2.xml'));
  check('Word 书名页与章节', doc.includes('雾城 &lt;记&gt;') && doc.includes('第1章 夜车'));
  check('Word 书名页有联系方式与篇幅', doc.includes('me@example.com') && doc.includes('全书 2 章') && doc.includes('约 16 字'));
  check('Word 有创作说明与附言', doc.includes('创作说明') && doc.includes('这是第一段。') && doc.includes('这是第二段。'));
  check('Word 有分卷与空章提示', doc.includes('第1卷 风起') && doc.includes('第2卷 云涌') && doc.includes('（本章还没有正文）'));
  check('Word 每节另起一页', (doc.match(/<w:pageBreakBefore\/>/g) || []).length === 5);
  check('Word 页脚有页码，首页页脚为空', footer.includes('w:instr=" PAGE "') && !firstFooter.includes(' PAGE '));
  check('Word 用 A4 与宋体', doc.includes('w:w="11906"') && doc.includes('w:h="16838"') && styles.includes('w:eastAsia="宋体"'));
  check('Word 正文缩进两字与 1.95 行距', styles.includes('w:line="468"') && doc.includes('w:firstLineChars="200"'));
  check('Word 正文一行一段', doc.includes('第一段。') && doc.includes('第二段「引号」。') && doc.includes('第三段。'));
  check('Word 没有 undefined / NaN', !doc.includes('undefined') && !doc.includes('NaN'));

  const noNote = unzipDocx(buildDocx(pn, pn.chapters, {}))['word/document.xml'].toString('utf8');
  check('Word 不勾附言就没有创作说明', !noNote.includes('创作说明'));

  const range = unzipDocx(buildDocx(pn, [pn.chapters[0]], { range: { lo: 1, hi: 3 } }))['word/document.xml'].toString('utf8');
  check('Word 区间标成节选', range.includes('节选 · 第 1–3 章') && range.includes('共 1 章'));

  const done = unzipDocx(buildDocx(pn, [pn.chapters[0]], { onlyDone: true }))['word/document.xml'].toString('utf8');
  check('Word 只导出定稿时写清定稿', done.includes('定稿 1 章'));

  const single = unzipDocx(buildDocx(pn, [pn.chapters[1]], { single: true }))['word/document.xml'].toString('utf8');
  check('Word 单章写清章号', single.includes('第 2 章 · 约 0 字'));

  const evilCh = { id: 'c3', no: 3, title: '<b>x</b>', content: '<script>alert(1)</script>' };
  const evil = unzipDocx(buildDocx({ ...pn, chapters: [evilCh] }, [evilCh]))['word/document.xml'].toString('utf8');
  check('Word 标题与正文里的尖括号被转义',
    evil.includes('&lt;b&gt;x&lt;/b&gt;') && evil.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !evil.includes('<script>alert(1)</script>'));
}

// ---------------------------------------------------------------
// Word 导入（.docx → 纯文本）
{
  const makeDocx = (xml) => zip([{ name: 'word/document.xml', data: xml }]);
  const wrap = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;

  const pn = {
    title: '雾城 <记>',
    author: '林三',
    meta: { submissionNote: '这是第一段。\n这是第二段。' },
    chapters: [
      { id: 'c1', no: 1, title: '夜车', content: '第一段。\n第二段「引号」。', stage: 'done', outlineId: 'o1' },
      { id: 'c2', no: 2, title: '', content: '', stage: 'draft', volumeId: 'v2' },
    ],
    outline: {
      volumes: [
        { id: 'v1', name: '风起', chapters: [{ id: 'o1', title: '夜车' }] },
        { id: 'v2', name: '第2卷 云涌', chapters: [] },
      ],
    },
  };
  const exported = extractDocxText(buildDocx(pn, pn.chapters, { note: true }));
  check('Word 导入：能读回章节正文', exported.text.includes('第1章 夜车') && exported.text.includes('第一段。'));
  check('Word 导入：默认跳过书名页与创作说明',
    !exported.text.includes('雾城 <记>') && !exported.text.includes('创作说明') &&
    exported.frontMatter.includes('雾城 <记>') && exported.frontMatter.includes('创作说明'),
    JSON.stringify({ text: exported.text.slice(0, 80), front: exported.frontMatter.slice(0, 80) }));
  check('Word 导入：分卷标题还在', exported.text.includes('第1卷 风起') && exported.text.includes('第2卷 云涌'));
  check('Word 导入：统计段数与标题', exported.paragraphs > 0 && exported.headings === 4 && exported.frontMatterHeadings === 1,
    `paragraphs=${exported.paragraphs} headings=${exported.headings} frontHeadings=${exported.frontMatterHeadings}`);

  const customXml = wrap(`
    <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>书名页</w:t></w:r></w:p>
    <w:p><w:r><w:t>作者</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>创作说明</w:t></w:r></w:p>
    <w:p><w:r><w:t>说明文字</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>篇幅</w:t></w:r></w:p>
    <w:p><w:r><w:t>两章</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第1章 开始</w:t></w:r></w:p>
    <w:p>
      <w:r><w:t>保留 &amp; &lt;标签&gt;</w:t></w:r>
      <w:del><w:r><w:delText>删掉</w:delText></w:r></w:del>
      <w:ins><w:r><w:t>插入</w:t></w:r></w:ins>
      <w:r><w:tab/><w:t>制表</w:t></w:r>
      <w:r><w:br/><w:t>换行</w:t></w:r>
    </w:p>`);
  const custom = extractDocxText(makeDocx(customXml));
  check('Word 导入：修订删除不进来、插入保留',
    custom.text.includes('保留') && !custom.text.includes('删掉') && custom.text.includes('插入'));
  check('Word 导入：实体、制表、换行都还原',
    custom.text.includes('保留 & <标签>') && custom.text.includes('\t制表') && custom.text.includes('\n换行'));
  check('Word 导入：跳过创作说明段落',
    custom.frontMatter.includes('书名页') && custom.frontMatter.includes('创作说明') &&
    custom.frontMatter.includes('篇幅') && !custom.text.includes('说明文字') && !custom.text.includes('篇幅') &&
    custom.text.startsWith('第1章 开始') && custom.headings === 1 && custom.frontMatterHeadings === 2);
  check('Word 导入：统计修订数量', custom.deleted === 1 && custom.inserted === 1, `deleted=${custom.deleted} inserted=${custom.inserted}`);

  const noHead = extractDocxText(makeDocx(wrap('<w:p><w:r><w:t>只有正文</w:t></w:r></w:p>')));
  check('Word 导入：没有标题时不跳内容', noHead.text === '只有正文' && noHead.frontMatter === '');

  let missing = '';
  try { extractDocxText(zip([{ name: 'word/styles.xml', data: 'x' }])); } catch (err) { missing = err.message; }
  check('Word 导入：缺少正文有提示', /word\/document\.xml/.test(missing), missing);

  let bad = '';
  try { extractDocxText(Buffer.from('不是 zip')); } catch (err) { bad = err.message; }
  check('Word 导入：非 zip 有提示', /Word|ZIP/.test(bad), bad);

  let tooBig = '';
  try { unzipEntry(makeDocx(customXml), 'word/document.xml', { maxBytes: 10 }); } catch (err) { tooBig = err.message; }
  check('Word 导入：解压上限生效', /太大/.test(tooBig), tooBig);

  const packed = makeDocx(customXml);
  const central = packed.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const eocd = packed.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));

  const badCrc = Buffer.from(packed);
  badCrc.writeUInt32LE((badCrc.readUInt32LE(central + 16) ^ 0xffffffff) >>> 0, central + 16);
  let crcErr = '';
  try { unzipEntry(badCrc, 'word/document.xml'); } catch (err) { crcErr = err.message; }
  check('Word 导入：CRC 对不上会被拒', /校验失败/.test(crcErr), crcErr);

  const encrypted = Buffer.from(packed);
  encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8);
  let encErr = '';
  try { unzipEntry(encrypted, 'word/document.xml'); } catch (err) { encErr = err.message; }
  check('Word 导入：加密文件会被拒', /加密/.test(encErr), encErr);

  const zip64 = Buffer.from(packed);
  zip64.writeUInt16LE(0xffff, eocd + 10);
  let zip64Err = '';
  try { unzipEntry(zip64, 'word/document.xml'); } catch (err) { zip64Err = err.message; }
  check('Word 导入：ZIP64 会被拒', /ZIP64/.test(zip64Err), zip64Err);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
