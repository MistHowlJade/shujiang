// 书匠 · 纯计算模块自测
// ---------------------------------------------------------------------------
// web/lib/ 下的模块是纯计算，不碰 DOM、不依赖全局状态，所以能在 Node 里直接跑。
// 这里验的是最容易「看着能用其实算错」的那类逻辑：文本差异算法。
//
// 用法：
//   tools\node\node.exe dev\lib-test.mjs
// 全通过时退出码为 0。
// ===========================================================================

import { diffProse, diffHtml, diffSideHtml, splitSentences, lcsOps } from '../web/lib/diff.js';

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};

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

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
