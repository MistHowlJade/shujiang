// 书匠 · 投稿前本地自检（纯计算）
// 开书诊断的两部分：这份「投稿资格清单」完全确定、不调模型；
// 另一份「AI 视角五角度评分」调模型。两份放在同一个弹窗里。
// 不碰 DOM、不调模型——可以单独抽出来复用与测试。

const avgOf = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const counterOf = (s) => String(s || '').replace(/\s+/g, '').length;

/**
 * 投稿资格清单：每一项 ✓/✗，每一项都有「为什么」和「怎么改」。
 * 全部确定性——不读模型、不猜作者心意。
 */
export function buildLocalBookCheck(novel) {
  const chapters = Array.isArray(novel?.chapters) ? novel.chapters : [];
  const written = chapters.filter((c) => counterOf(c?.content) > 0);
  const first3 = chapters.slice(0, 3);
  const first3Ready = first3.length === 3 && first3.every((c) => counterOf(c?.content) > 0);
  const firstWords = counterOf(first3[0]?.content);
  const avgLen = written.length ? Math.round(avgOf(written.map((c) => counterOf(c.content)))) : 0;
  const firstContent = String(first3[0]?.content || '');
  const quoteMarks = (firstContent.match(/[“”"']/g) || []).length;
  const title = String(novel?.title || '').trim();
  const author = String(novel?.author || '').trim();
  const logline = String(novel?.meta?.logline || '').trim();
  const genre = String(novel?.genre || '').trim();
  const hasVolumes = (novel?.outline?.volumes || []).length > 0;
  const characters = (novel?.bible?.characters || []).length;

  const checks = [
    {
      id: 'first3',
      label: '前 3 章都有正文',
      ok: first3Ready,
      hint: '三章全空的话读者没有入口；平台算法也读不到内容',
    },
    {
      id: 'firstWords',
      label: '首章 ≥ 1500 字',
      ok: firstWords >= 1500,
      hint: '起点 / 番茄的首章基本盘都在 1500 字以上（行业经验值，不是官方要求）',
    },
    {
      id: 'avgLen',
      label: `平均章长 ≥ 1500 字${written.length ? `（现在 ${avgLen} 字）` : ''}`,
      ok: avgLen >= 1500,
      hint: '太短留不住，太长手机上翻半天——番茄用户更敏感',
    },
    {
      id: 'dialog',
      label: '首章里有对话',
      ok: quoteMarks >= 2,
      hint: '纯叙述开头没人说话，读者很难代入；至少一句台词拉进去',
    },
    {
      id: 'title',
      label: '书名已填写',
      ok: !!title,
      hint: '书名是别人点进来的第一个理由',
    },
    {
      id: 'logline',
      label: '「一句话故事」已填写',
      ok: !!logline,
      hint: '这一句决定简介怎么写、推荐位标签怎么投',
    },
    {
      id: 'author',
      label: '作者名已填写',
      ok: !!author,
      hint: '签名档要用，番茄/七猫的推荐位会看',
    },
    {
      id: 'genre',
      label: '类型已填写',
      ok: !!genre,
      hint: '算法靠它把你推给同好——留空等于自送一半流量',
    },
    {
      id: 'volumes',
      label: '分卷大纲至少一卷',
      ok: hasVolumes,
      hint: '投推荐位看的第一个东西就是分卷大纲',
    },
    {
      id: 'cast',
      label: '至少一张主角人物卡',
      ok: characters >= 1,
      hint: '人物卡是投稿时让角色被记住的唯一办法',
    },
  ];

  const passed = checks.filter((c) => c.ok).length;
  return { checks, passed, total: checks.length, firstWords, avgLen, writtenCount: written.length };
}
