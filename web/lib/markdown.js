// 书匠 · Markdown 解析工具
// ------------------------------------------------------------
// 导出的 Markdown 格式解析，用于导入还原
// 格式对应 exportMarkdown 的输出
// ============================================================

import { uid } from './util.js';

/** 解析导出的 Markdown，还原为小说数据结构 */
export function importBibleMarkdown(mdText) {
  const lines = String(mdText).split('\n');

  // 解析基本信息
  let title = '', author = '', contact = '', genre = '';
  let logline = '', synopsis = '', submissionNote = '';
  let inSynopsis = false, inNote = false;

  // 扩展字段
  let beats = { items: [] };
  let arcs = { items: [] };
  let relations = [];
  let threads = { items: [] };
  let style = { guide: '', banned: '', tone: '' };
  let annotations = [];

  for (let i = 0; i < Math.min(50, lines.length); i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('# ')) {
      title = line.slice(2).trim();
    } else if (line.startsWith('作者：')) {
      author = line.slice(3).trim();
    } else if (line.startsWith('联系方式：')) {
      contact = line.slice(5).trim();
    } else if (line.startsWith('类型：')) {
      genre = line.slice(3).trim();
    } else if (line.startsWith('节选：')) {
      // 忽略
    } else if (line.startsWith('> ')) {
      logline = line.slice(2).trim();
    } else if (line === '## 作品简介') {
      inSynopsis = true;
    } else if (line === '## 创作说明') {
      inNote = true;
    } else if (line.startsWith('## ') && inSynopsis) {
      inSynopsis = false;
    } else if (line.startsWith('## ') && inNote) {
      inNote = false;
    } else if (inSynopsis) {
      synopsis += (synopsis ? '\n' : '') + lines[i].trim();
    } else if (inNote) {
      if (line.startsWith('给编辑的话：')) continue;
      if (line.startsWith('- **') && line.includes('**：')) continue;
      submissionNote += (submissionNote ? '\n' : '') + lines[i].trim();
    }
  }

  // 解析章节
  const chapters = [];
  let currentChapter = null;
  let chapterContent = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const chapterMatch = line.match(/^## 第(\d+)章(?:\s+(.+))?$/);
    const volMatch = line.match(/^\*\*第(\d+)卷\s+(.+)\*\*$/);

    if (volMatch) {
      // 分卷标记，忽略（章节信息里会有 volumeId）
      continue;
    }

    if (chapterMatch) {
      // 保存上一章
      if (currentChapter) {
        currentChapter.content = chapterContent.join('\n');
        chapters.push(currentChapter);
      }
      currentChapter = {
        id: uid('c'),
        // 没有单独标题（「## 第1章」）时就用编号当标题，保证回导后还能看出是第几章
        title: (chapterMatch[2] || `第${chapterMatch[1]}章`).trim(),
        content: '',
        stage: 'draft',
      };
      chapterContent = [];
    } else if (currentChapter) {
      // 章节内容：处理首行缩进
      const trimmed = line.replace(/^　　/, '').replace(/^  /, '');
      if (trimmed || line === '') {
        chapterContent.push(trimmed);
      }
    }
  }

  // 保存最后一章
  if (currentChapter) {
    currentChapter.content = chapterContent.join('\n');
    chapters.push(currentChapter);
  }

  // 解析全书大纲（可选）
  let outline = { volumes: [], notes: '' };
  let inOutline = false;
  let currentVol = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '## 全书大纲') {
      inOutline = true;
      continue;
    }
    if (inOutline && line.startsWith('### ') && line.includes('卷')) {
      // 卷标题可能是「第1卷 风起」，也可能本身就写成「第一卷 · 雪岭」
      const match = line.match(/^###\s+(?:第(?:\d+)卷\s+)?(.+)$/);
      if (match) {
        currentVol = {
          id: uid('v'),
          name: match[2].trim(),
          desc: '',
          chapters: [],
        };
        outline.volumes.push(currentVol);
      }
      continue;
    }
    if (inOutline && line.startsWith('> ') && currentVol) {
      currentVol.desc = line.slice(2).trim();
      continue;
    }
    if (inOutline && line.startsWith('**第') && line.endsWith('**') && currentVol) {
      // 章纲行
      const match = line.match(/^\*\*(?:第(\d+)章\s+)?(.+?)\*\*$/);
      if (match) {
        currentVol.chapters.push({
          id: uid('o'),
          title: match[2].trim(),
          summary: '',
          scene: '',
          characters: '',
          hook: '',
        });
      }
      continue;
    }
    if (inOutline && line.startsWith('- ') && currentVol) {
      // 章纲字段
      const fields = currentVol.chapters[currentVol.chapters.length - 1];
      if (fields) {
        const match = line.match(/-\s*(.+?)：(.+)$/);
        if (match) {
          const key = match[1].trim();
          const val = match[2].trim();
          const fieldMap = { '场景': 'scene', '出场人物': 'characters', '核心事件': 'summary', '章末钩子': 'hook' };
          if (fieldMap[key]) fields[fieldMap[key]] = val;
        }
      }
      continue;
    }
    if (inOutline && line.startsWith('## ') && !line.startsWith('### ')) {
      inOutline = false;
    }
  }

  // 解析人物小传（可选）
  let bible = { characters: [], world: [], timeline: [] };
  let inCharacters = false;
  let currentChar = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '## 人物小传') {
      inCharacters = true;
      continue;
    }
    if (inCharacters && line.startsWith('### ')) {
      if (currentChar) bible.characters.push(currentChar);
      currentChar = {
        id: uid('chr'),
        name: line.slice(4).trim(),
        identity: '', category: '主角',
        brief: '', keywords: [], relations: [],
      };
      continue;
    }
    if (inCharacters && line.startsWith('- ') && currentChar) {
      const match = line.match(/-\s*(.+?)：(.+)$/);
      if (match) {
        const key = match[1].trim();
        const val = match[2].trim();
        const fieldMap = {
          '身份': 'identity', '分类': 'category',
          '简介': 'brief', '关键词': 'keywords',
        };
        if (fieldMap[key]) currentChar[fieldMap[key]] = val;
        else if (key === '关系') {
          currentChar.relations = val.split('；').map(r => r.trim()).filter(Boolean);
        }
      }
      continue;
    }
    if (inCharacters && line.startsWith('## ') && !line.startsWith('### ')) {
      if (currentChar) bible.characters.push(currentChar);
      inCharacters = false;
    }
  }
  if (currentChar) bible.characters.push(currentChar);

  // 解析结构/节拍表
  let inBeats = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '## 结构/节拍表') {
      inBeats = true;
      continue;
    }
    if (inBeats && line.startsWith('### ')) {
      const match = line.match(/^### (.+)$/);
      if (match) {
        const name = match[1].trim();
        const existing = beats.items.find(b => b.name === name);
        if (!existing) {
          beats.items.push({ id: uid('b'), name, chapterId: '', sceneIdx: -1, words: 0, note: '' });
        }
      }
      continue;
    }
    if (inBeats && line.startsWith('- ') && beats.items.length > 0) {
      const match = line.match(/-\s*(.+?)：(.+)$/);
      if (match) {
        const key = match[1].trim();
        const val = match[2].trim();
        const lastBeat = beats.items[beats.items.length - 1];
        const fieldMap = { '关联章节': 'chapterId', '场景索引': 'sceneIdx', '字数': 'words', '备注': 'note' };
        if (fieldMap[key]) lastBeat[fieldMap[key]] = val;
      }
      continue;
    }
    if (inBeats && line.startsWith('## ') && !line.startsWith('### ')) {
      inBeats = false;
    }
  }

  // 解析人物弧光
  let inArcs = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '## 人物弧光') {
      inArcs = true;
      continue;
    }
    if (inArcs && line.startsWith('### ')) {
      const name = line.slice(4).trim();
      arcs.items.push({
        id: uid('a'),
        name,
        points: [],
        totalWords: 0,
        latestState: ''
      });
      continue;
    }
    if (inArcs && line.startsWith('- ') && arcs.items.length > 0) {
      const arc = arcs.items[arcs.items.length - 1];
      arc.points.push({ chapter: 0, title: line.slice(2).trim(), chapterId: '', state: '', events: '', unresolved: '', words: 0 });
      continue;
    }
    if (inArcs && line.startsWith('## ') && !line.startsWith('### ')) {
      inArcs = false;
    }
  }

  // 解析关系图谱
  let inRelations = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '## 关系图谱') {
      inRelations = true;
      continue;
    }
    if (inRelations && line.startsWith('- ') && line.includes('：')) {
      const match = line.match(/-\s*(.+?)：(.+)$/);
      if (match) {
        const fromTo = match[1].trim();
        const type = match[2].trim();
        const ftMatch = fromTo.match(/^(.+?)\s*[→→]\s*(.+)$/);
        if (ftMatch) {
          relations.push({
            from: ftMatch[1].trim(),
            to: ftMatch[2].trim(),
            type,
            strength: 5,
            evidence: []
          });
        }
      }
      continue;
    }
    if (inRelations && line.startsWith('## ') && !line.startsWith('### ')) {
      inRelations = false;
    }
  }

  // 解析线索追踪
  let inThreads = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '## 线索追踪') {
      inThreads = true;
      continue;
    }
    if (inThreads && line.startsWith('### ')) {
      const text = line.slice(4).trim();
      threads.items.push({
        id: uid('t'),
        kind: 'unresolved',
        text,
        nos: [],
        latest: { no: 0, id: '', title: '' },
        evidence: []
      });
      continue;
    }
    if (inThreads && line.startsWith('## ') && !line.startsWith('### ')) {
      inThreads = false;
    }
  }

  // 解析文风与规则
  let inStyle = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '## 文风与规则') {
      inStyle = true;
      continue;
    }
    if (inStyle && line.startsWith('### ')) {
      const key = line.slice(4).trim();
      if (key === '文风档案') style.guide = '';
      else if (key === '禁用词汇') style.banned = '';
      else if (key === '基调') style.tone = '';
      continue;
    }
    if (inStyle && line.startsWith('- ')) {
      const match = line.match(/-\s*(.+)$/);
      if (match) {
        const val = match[1].trim();
        if (style.guide === '') style.guide = val;
        else if (style.banned === '') style.banned = val;
        else if (style.tone === '') style.tone = val;
      }
      continue;
    }
    if (inStyle && line.startsWith('## ') && !line.startsWith('### ')) {
      inStyle = false;
    }
  }

  // 解析批注/高亮
  let inAnnotations = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '## 批注/高亮') {
      inAnnotations = true;
      continue;
    }
    if (inAnnotations && line.startsWith('### ')) {
      const chapterTitle = line.slice(4).trim();
      annotations.push({
        id: uid('an'),
        chapterId: '',
        start: 0,
        end: 0,
        text: '',
        note: chapterTitle,
        color: 'yellow',
        createdAt: Date.now()
      });
      continue;
    }
    if (inAnnotations && line.startsWith('## ') && !line.startsWith('### ')) {
      inAnnotations = false;
    }
  }

  // 解析世界观
  let inWorld = false;
  let currentWorld = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '## 世界观') {
      inWorld = true;
      continue;
    }
    if (inWorld && line.startsWith('### ')) {
      if (currentWorld) bible.world.push(currentWorld);
      currentWorld = {
        id: uid('w'),
        name: line.slice(4).trim(),
        category: '地理',
        desc: '',
        keywords: []
      };
      continue;
    }
    if (inWorld && line.startsWith('- ') && currentWorld) {
      const match = line.match(/-\s*(.+?)：(.+)$/);
      if (match) {
        const key = match[1].trim();
        const val = match[2].trim();
        const fieldMap = { '分类': 'category', '说明': 'desc', '关键词': 'keywords' };
        if (fieldMap[key]) currentWorld[fieldMap[key]] = val;
        else if (key === '关键词') currentWorld.keywords = val.split('、').map(k => k.trim()).filter(Boolean);
      }
      continue;
    }
    if (inWorld && line.startsWith('## ') && !line.startsWith('### ')) {
      if (currentWorld) bible.world.push(currentWorld);
      inWorld = false;
    }
  }
  if (currentWorld) bible.world.push(currentWorld);

  // 解析时间线
  let inTimeline = false;
  let currentTime = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '## 时间线') {
      inTimeline = true;
      continue;
    }
    if (inTimeline && line.startsWith('### ')) {
      if (currentTime) bible.timeline.push(currentTime);
      currentTime = {
        id: uid('t'),
        time: '',
        title: line.slice(4).trim(),
        desc: ''
      };
      continue;
    }
    if (inTimeline && line.startsWith('- ') && currentTime) {
      const match = line.match(/-\s*(.+?)：(.+)$/);
      if (match) {
        const key = match[1].trim();
        const val = match[2].trim();
        const fieldMap = { '说明': 'desc' };
        if (fieldMap[key]) currentTime[fieldMap[key]] = val;
      }
      continue;
    }
    if (inTimeline && line.startsWith('## ') && !line.startsWith('### ')) {
      if (currentTime) bible.timeline.push(currentTime);
      inTimeline = false;
    }
  }
  if (currentTime) bible.timeline.push(currentTime);

  // 解析场景卡片
  let inScenes = false;
  let currentSceneChapterId = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '## 场景卡片') {
      inScenes = true;
      continue;
    }
    if (inScenes && trimmed.startsWith('### 第') && trimmed.includes('章')) {
      const match = trimmed.match(/### 第(\d+)章\s+(.+)$/);
      if (match) {
        currentSceneChapterId = match[1];
        continue;
      }
    }
    if (inScenes && trimmed.startsWith('- 场次') && currentSceneChapterId) {
      const ch = chapters.find(c => c.no === parseInt(currentSceneChapterId));
      if (ch) {
        ch.scenes = ch.scenes || [];
        const sceneMatch = trimmed.match(/-\s*场次\s*(\d+)\s*[·\.]?\s*(.*)/);
        if (sceneMatch) {
          ch.scenes.push({
            id: uid('s'),
            pov: '',
            location: '',
            time: '',
            characters: '',
            summary: sceneMatch[2].trim(),
            hook: '',
            targetWords: 0
          });
        }
      }
      continue;
    }
    if (inScenes && trimmed.startsWith('## ') && !trimmed.startsWith('### ')) {
      inScenes = false;
    }
  }

  // 解析批注/高亮
  let inAnnotations2 = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '## 批注/高亮') {
      inAnnotations2 = true;
      continue;
    }
    if (inAnnotations2 && line.startsWith('### ')) {
      const chapterTitle = line.slice(4).trim();
      annotations.push({
        id: uid('an'),
        chapterId: '',
        start: 0,
        end: 0,
        text: '',
        note: chapterTitle,
        color: 'yellow',
        createdAt: Date.now()
      });
      continue;
    }
    if (inAnnotations2 && line.startsWith('## ') && !line.startsWith('### ')) {
      inAnnotations2 = false;
    }
  }

  return {
    title: title || '导入的作品',
    author: author || '',
    genre: genre || '',
    meta: { contact, logline, synopsis, submissionNote },
    bible,
    outline,
    chapters,
    beats,
    arcs,
    relations,
    threads: { items: threads.items },
    style,
    annotations,
  };
}