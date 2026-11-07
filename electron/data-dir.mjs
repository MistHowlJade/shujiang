// 数据目录解析：决定书匠把「用户作品」存哪里。
// 规则：
//   1. SHU_DATA_DIR 显式指定 → 用它（开发 / 测试隔离用）
//   2. 便携版（自解压）：PORTABLE_EXECUTABLE_DIR 指向真正的 exe 目录 → 跟本体走
//   3. 打包后（zip 解压目录 / win-unpacked）：exe 所在目录下的 data/ → 跟本体走
//   4. 老用户（%APPDATA%\书匠\data 已有数据）：继续用老位置，避免两份数据分家
//   5. 本体目录只读（权限受限）：回退到老位置
//   6. 源码运行（npm run desktop）：项目内 data/，和浏览器模式一致
import fs from 'node:fs';
import path from 'node:path';

const hasNovels = (dir, fsLike) => {
  try { return fsLike.existsSync(path.join(dir, 'novels')); } catch { return false; }
};

const isWritable = (dir, fsLike) => {
  try {
    fsLike.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}-${Date.now()}`);
    fsLike.writeFileSync(probe, 'ok');
    fsLike.rmSync(probe, { force: true });
    return true;
  } catch { return false; }
};

export function resolveDataDir({ env = process.env, isPackaged = false, execPath = '', userDataPath = '', sourceRoot = '', fsLike = fs } = {}) {
  if (env.SHU_DATA_DIR) return path.resolve(env.SHU_DATA_DIR);
  const legacy = userDataPath ? path.join(userDataPath, 'data') : '';

  // 源码模式：跟浏览器模式一致，用项目内 data/
  if (!isPackaged && !env.PORTABLE_EXECUTABLE_DIR) {
    if (sourceRoot) return path.join(sourceRoot, 'data');
    return legacy || path.join(process.cwd(), 'data');
  }

  // 本体所在目录：便携版优先取自解压提供的真实路径
  const exeDir = env.PORTABLE_EXECUTABLE_DIR || (execPath ? path.dirname(execPath) : '');
  const beside = exeDir ? path.join(exeDir, 'data') : '';

  if (beside && hasNovels(beside, fsLike)) return beside;   // 已经在跟随本体模式
  if (legacy && hasNovels(legacy, fsLike)) return legacy;   // 老用户：不动它
  if (beside) {
    if (isWritable(beside, fsLike)) return beside;          // 新装默认：跟本体
    return legacy || beside;                                  // 只读：回退
  }
  return legacy;
}
