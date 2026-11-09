// 书匠 · 桌面主进程（Electron）
// 单进程方案：直接在主进程里跑原有的零依赖本地服务端，再用窗口打开它。
// 不往安装目录写文件：数据默认跟本体走（可用 SHU_DATA_DIR 覆盖）。


import { app, BrowserWindow } from 'electron';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveDataDir } from './data-dir.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

process.env.SHU_NO_OPEN = '1';   // 浏览器别再弹了，窗口就是入口

// ---------------------------------------------------------------- 端口
// 找一个空闲端口交给服务端；它会以此端口监听并自动往后顺延（防冲突）。
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------- 单例
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(start).catch((err) => {
    console.error('[书匠] 启动失败：', err);
    app.quit();
  });
}

async function start() {
  try {
    // 数据目录：默认跟本体走（zip 解压目录 / 便携版 exe 旁边的 data/）；老用户不迁移
    const dataDir = resolveDataDir({ isPackaged: app.isPackaged, execPath: process.execPath, userDataPath: app.getPath('userData'), sourceRoot: ROOT });
    process.env.SHU_DATA_DIR = dataDir;
    const port = await getFreePort();
    process.env.SHU_PORT = String(port);
    process.env.SHU_BOUND_PORT = '';

    // 服务端从这一行起监听（import 即启动），WEB_DIR 指向随应用带走的 web/
    await import(pathToFileURL(path.join(ROOT, 'server', 'server.js')).href);

    // 端口被占时服务端会自动顺延；等它真正就绪，别用探测时的端口开窗口
    let boundPort = 0;
    for (let i = 0; i < 100; i += 1) {
      const v = Number(process.env.SHU_BOUND_PORT);
      if (Number.isInteger(v) && v > 0) { boundPort = v; break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!boundPort) throw new Error('本地服务没有就绪：端口被占用或启动失败');

    const url = `http://127.0.0.1:${boundPort}`;
    const isLocal = (target) => typeof target === 'string' && (target.startsWith(`${url}/`) || target === url || target.startsWith(`http://localhost:${boundPort}`));

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: '书匠 · AI 长篇小说创作台',
    // 稳定性优先：窗口背板不透明（v1.0.17/18 亚克力透明材质在部分机型上糊白/合成失败）
    backgroundColor: '#15110d',
    autoHideMenuBar: true,
    icon: path.join(ROOT, 'build', 'icon.png'),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // 只允许本应用域名内的导航（例如导出、打印稿这类整窗跳转）；外部链接一律不放行
  win.webContents.on('will-navigate', (event, target) => {
    if (!isLocal(target)) event.preventDefault();
  });
  // 只有本应用域名的新窗口（打印稿 / PDF 预览页「在新标签打开」）才放行，且去掉菜单栏
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!isLocal(target)) return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: '#15110d' },
    };
  });

    await win.loadURL(url);
  } catch (err) {
    // 交给外层的 whenReady().catch 统一报错并退出
    throw err;
  }
}

app.on('window-all-closed', () => {
  // 桌面应用的常规行为：关掉所有窗口就退出，不残留在托盘/后台
  app.quit();
});

