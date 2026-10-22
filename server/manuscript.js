// 书匠 · 随稿附带的材料
//
// 导出的稿子只有正文时，编辑/出版看不到结构、也不知道人物是谁。
// 这里把设定库里已经写好的东西整理成能贴进稿件的两种材料：
//   - 全书大纲（按卷分组，每章的场景 / 出场人物 / 梗概 / 章末钩子）
//   - 人物小传（姓名 / 定位 / 身份 / 性格 / 目标 / 缺陷 / 口吻 …）
//
// 只取「作者自己写过并且非空」的字段，不会替作者编内容。

/** 章纲里每章会带的几项 */
const OUTLINE_FIELDS = [
  { key: 'scene', label: '场景' },
  { key: 'characters', label: '出场' },
  { key: 'summary', label: '梗概' },
  { key: 'hook', label: '章末钩子' },
];

/** 人物卡里值得贴进稿子的几项 */
const CHARACTER_FIELDS = [
  { key: 'role', label: '定位' },
  { key: 'identity', label: '身份' },
  { key: 'age', label: '年龄' },
  { key: 'appearance', label: '外貌' },
  { key: 'personality', label: '性格' },
  { key: 'goal', label: '核心目标' },
  { key: 'flaw', label: '性格缺陷' },
  { key: 'speech', label: '说话风格' },
];

const str = (v) => String(v ?? '').trim();

/**
 * 全书大纲：按卷分组。
 * @param {object} novel 作品
 * @param {object[]} chapters 要导出的章节（只列这些章的章纲）
 * @returns {{volumes: {no:number, name:string, desc:string, entries:object[]}[], missing:number}}
 */
export function outlineRows(novel, chapters = []) {
  const vols = novel?.outline?.volumes || [];
  if (!vols.length) return { volumes: [], missing: 0 };
  // 章纲 id → 条目
  const byOutlineId = new Map();
  vols.forEach((v, vi) => {
    for (const o of v.chapters || []) {
      if (o?.id) byOutlineId.set(o.id, { o, vi, v });
    }
  });
  const wanted = new Set((chapters || []).map((c) => c.id));
  const out = [];
  let missing = 0;
  vols.forEach((v, vi) => {
    const entries = [];
    for (const o of v.chapters || []) {
      // 只导出本次要导出的章节的章纲；没被任何章节引用的章纲也保留（大纲可能走在正文前面）
      const used = (novel.chapters || []).find((c) => c.outlineId === o.id);
      if (wanted.size && used && !wanted.has(used.id)) continue;
      const ch = used;
      entries.push({
        title: str(o.title) || (ch ? `第${ch.no}章` : '（未命名）'),
        no: ch ? ch.no : 0,
        words: ch ? Number(ch.words) || 0 : 0,
        fields: OUTLINE_FIELDS
          .map((f) => ({ label: f.label, value: str(o[f.key]) }))
          .filter((f) => f.value),
      });
    }
    if (entries.length) out.push({ no: vi + 1, name: str(v.name) || `第 ${vi + 1} 卷`, desc: str(v.desc), entries });
  });
  // 没有任何章纲的章节，单独记个数（让作者知道漏了）
  for (const c of chapters || []) {
    if (!c.outlineId || !byOutlineId.has(c.outlineId)) missing += 1;
  }
  return { volumes: out, missing };
}

/**
 * 某个人物在设定库里写下的关系。
 * 新数据是 { to, type, note } 数组；老数据是「对象：关系」用顿号分开的字符串。
 */
function relationsOf(c) {
  const out = [];
  if (Array.isArray(c?.relations)) {
    for (const r of c.relations) {
      const to = String(r?.to || '').trim();
      if (!to) continue;
      out.push({ to, type: String(r?.type || '').trim() || '关联', note: String(r?.note || '').trim() });
    }
  } else if (typeof c?.relations === 'string' && c.relations.trim()) {
    for (const s of c.relations.split(/[、,，;；\n]/)) {
      const m = s.trim().match(/^(.+?)[：:]\s*(.+)$/);
      if (m) out.push({ to: m[1].trim(), type: m[2].trim() || '关联', note: '' });
    }
  }
  return out;
}

/**
 * 人物小传：只留写过内容的字段。
 * 关系两个方向都收：A 写了「与 B 是师徒」，B 的小传里也该有这一条。
 */
export function characterRows(novel) {
  const list = novel?.bible?.characters || [];
  const own = new Map(list.map((c) => [String(c?.name || '').trim(), relationsOf(c)]));
  return list
    .map((c) => {
      const name = str(c.name) || '（未命名）';
      const merged = new Map();
      // 自己写下的关系优先
      for (const r of own.get(name) || []) merged.set(r.to, { ...r });
      // 别人写向自己的关系补上（对方没自己写才补，避免重复）
      for (const other of list) {
        const on = String(other?.name || '').trim();
        if (!on || on === name) continue;
        for (const r of own.get(on) || []) {
          if (r.to === name && !merged.has(on)) merged.set(on, { ...r });
        }
      }
      return {
        name,
        fields: CHARACTER_FIELDS
          .map((f) => ({ label: f.label, value: str(c[f.key]) }))
          .filter((f) => f.value),
        relations: [...merged.entries()].map(([to, r]) => ({ to, type: r.type, note: r.note })),
      };
    })
    .filter((c) => c.name || c.fields.length || c.relations.length);
}

/** 整本有没有可附带的材料（没有就别在界面上显示这个选项） */
export function hasExtras(novel) {
  const o = outlineRows(novel, novel?.chapters || []);
  const c = characterRows(novel);
  return {
    outline: o.volumes.length > 0,
    characters: c.length > 0,
  };
}
