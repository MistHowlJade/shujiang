// 书匠 · 大稿生成器（仅用于性能测试）
// ---------------------------------------------------------------------------
// 直接往 data/novels/ 写一部「长篇」作品，用来测打开速度、保存延迟、上下文组装耗时。
// 不会经过 HTTP，所以几秒就能生成几十万字。
//
// 用法：
//   tools\node\node.exe dev\gen-large-novel.js            # 默认 120 章 × 3000 字
//   tools\node\node.exe dev\gen-large-novel.js 200 4000   # 200 章 × 4000 字
//
// 生成的标题带「压测」字样，方便识别与删除。
// ===========================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const NOVELS_DIR = path.join(ROOT, 'data', 'novels');

const CHAPTERS = Number(process.argv[2] || 120);
const CHARS = Number(process.argv[3] || 3000);

const NAMES = ['谢迟', '青衫人', '井边女子', '上官棠', '长老', '卖炭翁', '刀疤汉子'];
const PLACES = ['青石巷', '枯井', '演武场', '藏剑阁', '城南渡口', '破庙', '后山竹林'];
const OBJECTS = ['剑鞘', '铜环', '酒葫芦', '密信', '断指', '木牌', '旧账本'];
const VERBS = ['握紧', '按住', '抬起', '别过', '递出', '收进', '摩挲'];
const FEEL = ['指节发白', '掌心生疼', '呼吸一顿', '喉咙发干', '后颈发凉'];

const pick = (arr, i) => arr[i % arr.length];

function sentence(ci, si) {
  const a = pick(NAMES, ci + si * 3);
  const b = pick(NAMES, ci * 5 + si + 2);
  const p = pick(PLACES, ci * 2 + si);
  const o = pick(OBJECTS, ci + si * 2);
  const v = pick(VERBS, ci + si);
  const f = pick(FEEL, si + ci);
  const forms = [
    `${a}在${p}停下脚步，${v}了${o}，${f}。`,
    `「${o}的事，你打算怎么办？」${b}问。${a}没有回答，只是把${o}往怀里又塞了塞。`,
    `${p}的风比昨日更冷。${a}数着脚下的石板，一直数到第七十三块才抬头。`,
    `${b}忽然笑了：「你以为${o}能保你到几时？」${a}看着他，慢慢松开手。`,
    `${a}想起三年前那个雨夜。那时${b}还站在他这一边，${o}也还没有裂。`,
    `夜色压下来，${p}只剩下两盏灯。一盏亮着，一盏灭了，${a}站在中间，${f}。`,
  ];
  return forms[si % forms.length];
}

function chapterBody(ci, targetChars) {
  const parts = [];
  let n = 0;
  let si = 0;
  while (n < targetChars) {
    const s = sentence(ci, si++);
    parts.push(s);
    n += s.length;
    if (parts.length % 5 === 0) parts.push('\n');
  }
  return parts.join('');
}

function main() {
  fs.mkdirSync(NOVELS_DIR, { recursive: true });
  const id = `n_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const now = Date.now();
  const chapters = [];
  for (let i = 0; i < CHAPTERS; i++) {
    const content = chapterBody(i, CHARS);
    chapters.push({
      id: `c_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      title: `第 ${i + 1} 章 压测章节${i + 1}`,
      summary: `${pick(NAMES, i)}在${pick(PLACES, i)}遇到了${pick(NAMES, i + 3)}，${pick(OBJECTS, i)}出现了变化。`,
      content,
      words: content.replace(/\s+/g, '').length,
      status: 'done',
      no: i + 1,
      createdAt: now,
      memory: {
        summary: `${pick(NAMES, i)}在${pick(PLACES, i)}与${pick(NAMES, i + 3)}发生冲突。`,
        events: [`${pick(NAMES, i)}前往${pick(PLACES, i)}`, `${pick(OBJECTS, i)}出现异常`],
        characters: [pick(NAMES, i), pick(NAMES, i + 3)],
        stateChanges: [`${pick(OBJECTS, i)}受损`],
        foreshadowing: [`${pick(OBJECTS, i + 1)}的来历`],
        unresolved: [`${pick(NAMES, i)}的伤`],
      },
    });
  }

  const novel = {
    id,
    title: `压测大稿 ${CHAPTERS}章`,
    author: 'perf',
    genre: '武侠',
    tags: ['压测'],
    createdAt: now,
    updatedAt: now,
    meta: {
      logline: '用来测性能的长篇。',
      synopsis: '虚构内容。',
      pov: '第三人称限知',
      tense: '过去时',
      tone: '冷峻',
      platform: '起点中文网',
      targetWordsPerChapter: CHARS,
      styleNotes: '短句。',
      styleRefs: [],
      antiAiNotes: '',
      taboos: '',
      extraRules: '',
    },
    bible: {
      characters: NAMES.map((name, i) => ({ id: `ch_${i}`, name, role: i === 0 ? '主角' : '配角', keywords: [pick(OBJECTS, i)] })),
      world: PLACES.map((name, i) => ({ id: `w_${i}`, name, category: '地点', desc: `${name}的设定。`, keywords: [name] })),
      timeline: [{ id: 't_1', time: '三年前', event: '谢迟离开师门' }],
    },
    outline: {
      volumes: [{ name: '第一卷', desc: '压测', chapters: [{ id: 'o_1', title: '压测', summary: '压测' }] }],
      notes: '',
    },
    chapters,
  };

  const file = path.join(NOVELS_DIR, `${id}.json`);
  const json = JSON.stringify(novel, null, 2);
  fs.writeFileSync(file, json, 'utf8');
  const totalChars = chapters.reduce((s, c) => s + c.words, 0);
  console.log('');
  console.log(`  已生成：${file}`);
  console.log(`  作品 ID：${id}`);
  console.log(`  ${CHAPTERS} 章 · ${totalChars.toLocaleString()} 字 · 文件 ${(json.length / 1024 / 1024).toFixed(2)} MB`);
  console.log('');
}

main();
