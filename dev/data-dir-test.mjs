// electron/data-dir.mjs 的单元测试（纯 Node，不需 Electron）
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from '../electron/data-dir.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};

const tmp = () => fs.mkdtempSync(path.join(path.resolve('.cache'), 'data-dir-test-'));
const mkNovels = (dir) => { fs.mkdirSync(path.join(dir, 'novels'), { recursive: true }); };

// 1) SHU_DATA_DIR 显式指定 → 直接用
{
  const d = path.join(tmp(), 'explicit');
  ok('SHU_DATA_DIR 优先', resolveDataDir({ env: { SHU_DATA_DIR: d }, isPackaged: true, execPath: 'D:\\app\\书匠.exe', userDataPath: tmp() }) === path.resolve(d));
}

// 2) 源码模式 → 项目内 data/
{
  const src = tmp();
  ok('源码模式用项目内 data/', resolveDataDir({ env: {}, isPackaged: false, sourceRoot: src, userDataPath: tmp() }) === path.join(src, 'data'));
}

// 3) 打包新装 → exe 同目录 data/
{
  const exeDir = tmp();
  const ud = tmp();
  const got = resolveDataDir({ env: {}, isPackaged: true, execPath: path.join(exeDir, '书匠.exe'), userDataPath: ud });
  ok('新装跟本体', got === path.join(exeDir, 'data'));
}

// 4) 老用户数据在 APPDATA → 不迁移
{
  const exeDir = tmp();
  const ud = tmp();
  mkNovels(path.join(ud, 'data'));
  const got = resolveDataDir({ env: {}, isPackaged: true, execPath: path.join(exeDir, '书匠.exe'), userDataPath: ud });
  ok('老用户留在 APPDATA', got === path.join(ud, 'data'));
}

// 5) 本体旁已有数据 → 继续用本体旁
{
  const exeDir = tmp();
  const ud = tmp();
  mkNovels(path.join(exeDir, 'data'));
  const got = resolveDataDir({ env: {}, isPackaged: true, execPath: path.join(exeDir, '书匠.exe'), userDataPath: ud });
  ok('跟随本体模式延续', got === path.join(exeDir, 'data'));
}

// 6) 本体旁目录只读（data 是个文件）→ 回退 APPDATA
{
  const exeDir = tmp();
  const ud = tmp();
  fs.writeFileSync(path.join(exeDir, 'data'), 'occupied');
  const got = resolveDataDir({ env: {}, isPackaged: true, execPath: path.join(exeDir, '书匠.exe'), userDataPath: ud });
  ok('本体只读回退 APPDATA', got === path.join(ud, 'data'));
}

// 7) 便携版自解压：PORTABLE_EXECUTABLE_DIR 优先于 execPath
{
  const realDir = tmp();
  const tempDir = tmp();
  const ud = tmp();
  const got = resolveDataDir({ env: { PORTABLE_EXECUTABLE_DIR: realDir }, isPackaged: true, execPath: path.join(tempDir, '书匠.exe'), userDataPath: ud });
  ok('便携版用真实 exe 目录', got === path.join(realDir, 'data'));
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
