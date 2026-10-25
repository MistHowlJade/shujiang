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
    const chapterMatch = line.match(/^## 第(\d+)章\s+(.+)$/);
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
        title: chapterMatch[2].trim(),
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
    if (inOutline && line.startsWith('### 第') && line.includes('卷')) {
      const match = line.match(/^### 第(\d+)卷\s+(.+)$/);
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

  return {
    title: title || '导入的作品',
    author: author || '',
    genre: genre || '',
    meta: { contact, logline, synopsis, submissionNote },
    bible,
    outline,
    chapters,
  };
}