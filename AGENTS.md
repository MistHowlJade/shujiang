# 书匠 · AI 协作指南

> 给所有进入这个项目的 AI（OpenCode、Codex、Claude Code、Cursor 等）看的
> 如果你在这里新加入一个 session，先把这份文档读到头。

## 项目一句话

**书匠** = 完全跑在用户电脑上的中文长篇小说创作台，AI 跟你结对写 10 万字篇幅。所有作品/设定/密钥存在本机 JSON 文件，不上传云端、不调用任何未授权的第三方服务。Electron 内嵌零依赖 Node 服务端，浏览器打开 `http://127.0.0.1:8848` 使用；也可以双击便携版 exe（安装版不了了之、直接扔 `.exe` 就行）。

## 硬约束（违反这些约等于作废工作）

1. **零依赖写作**：运行时不许引入任何 npm 包；`devDependencies` 只用于打包签名，且只有 `electron` + `electron-builder`。`server/*.js`、`web/**/*.js`、`dev/*.mjs` 只能 `require` / `import` 内置模块（`node:http` / `node:fs` / …）或项目自己的文件。
2. **不动用户数据**：`data/` 目录、`tools/portable-node/`、任何 `.gitignore` 里的文件不准往里面写任何东西。开发用 `dev/regress.mjs`，或者用 `SHU_DATA_DIR=.tmp-regress-data` 显式隔离。
3. **不动 `dist/`、`.cache/`、`node_modules/`**：构建产物、缓存、依赖——否。
4. **不动全局开发环境**：不能 `npm install -g`、不能改系统 PATH、注册表、全局 npm config、全局 git 配置。
5. **中文为主**：所有 commit、注释、用户可见字符用中文。不要随便英文夹杂。

## 关键事实（先看一眼有数）

| 项 | 值 |
| --- | --- |
| 版本 | v1.0.6 |
| 语言 | JavaScript（ES modules，`"type": "module"`）|
| 运行时 Node | 18+，但当前用 `tools/node/node.exe` (22.0.0) |
| 平台 | Windows 为主（`win-unpacked`、`ShuJiang-Portable-1.0.6.exe`、`win-x64.zip`）|
| 测试 | `npm run regress`（接近 300 项检查）、`npm test` (`lib-test.mjs` 585 项) |
| 代码量 | ~19000 行 |
| 前端 | 原生 JS + 自研设计系统，无 React/Vue/Svelte |
| HTML/CSS | 630 行 HTML、3129 行 CSS |
| Lighthouse | Accessibility / Best Practices / SEO = 100 / 100 / 100 |
| 许可证 | MIT（`LICENSE`）|
| 发布渠道 | GitHub Releases（未签名便携版；签名已放弃——太贵）|

## 目录速查

```
server/       Node 服务端：路由、SSE 流式转发、导入导出、提示词模板
web/          前端（纯静态，无构建步骤；任何静态刷新可见效果）
web/lib/      模块级纯计算 helper（可以在 Node 里直接测）
electron/     桌面版主进程（单进程内嵌 server）
dev/          假模型 mock、回归测试、基准、epub 检查
data/         用户作品（**.gitignore，不动**）
dist/         打包产物（gitignored）
build/        icon.png / icon.ico（重画图标源）
```

### 服务端关键入口

- `server/server.js`：HTTP 路由、SSE 推送、文件 I/O、导出
- `server/store.js`：JSON 存储层（`getNovel / saveNovel / listNovels / …`）
- `server/context.js`：把作品组装成喂给模型的上下文（相关度检索 + 预算修剪）
- `server/prompts.js`：**全部任务的系统提示词**——加新 AI 能力就在这里加
- `server/zip.js`、`epub.js`、`docx.js`、`print.js`：各格式导出

### 前端结构

- `web/app.js`：主逻辑（~13184 行，**不拆**——重构它没什么好处、代价高、还容易伤到现有行为）
- `web/index.html`：应用骨架 + 内联 SVG 图标
- `web/style.css`：设计系统
- `web/lib/consistency.js`：本地一致性检查引擎（设定冲突/时间线/人物行为/口吻差异）
- `web/lib/proof.js`：本地校对规则引擎
- `web/lib/markdown.js`：Markdown 解析 → HTML（仅用作导入还原 + 导出）

> app.js 大到 linter 默认配置不认，但项目策略是：**不折腾构建工具链，大文件能跑就行**。问用户要动它之前，先想想是不是别处解决得了。

## 常用命令

```bash
# 开发
npm start                        # 浏览器版，http://127.0.0.1:8848
npm run desktop                  # Electron 桌面版
npm run dist                     # 便携版打包（只出 EXE + 绿色 zip）
npm run mock                     # 假模型（默认 8890，覆盖 OpenAI 接口）
npm run regress                  # 回归
npm test                         # lib-test（lib 层单元测试）
npm run perf                     # 性能压测
npm run check-refs               # 模块引用自检（import 缺谁、哪里缺了）
# 往隔离目录播种虚构示例作品《雪岭问剑》，用于重新生成 README 截图：
SHU_DATA_DIR=.tmp-demo-data tools\node\node.exe dev\seed-demo.mjs
tools\node\node.exe dev\regress.mjs   # Windows 下直接跑 regress
```

## 设计哲学

1. **本地优先**：作品永发不出去。任何新增的"联网"行为都要用户明确知道（且唯一的网络请求是用户自己配的模型服务商）。
2. **信息不外泄**：所有作品正文/设定/密钥直接在 JSON 文件里，明文存放可被本地文件系统读取——这是用户明确选择的本地模式，不要再给它加同步/云端功能。
3. **极简 UI**：Linear-neutral 调性——暖米色背景 + 低饱和度强调色 + 信息密度高一些。不要 Ai-slop 配色，不要花哨图标、不要微机动效、除非用户要。
4. **不流出 AI 痕迹**：AI 助手产物是草稿，只有用户把关留下来的才算数（和传统软件界面同理）——构建时刻意不覆盖 `Ctrl+Z` 撤销栈（每段落是一个操作）、绝不自动覆盖原文。
5. **失败不能糊弄**：模型报错要逐字说到人话——网络问题说"地址/证书/DNS"、4 百/4 百零一/配额说成"key 不对 / 额度用完 / 换个模型"、不许只扔 `fetch failed`。
6. **尽量 AI 友好**：错误信息、提示、表单都给足上下文（不要让用户猜测为什么）、失败时也别把损失"藏起来"——明面上显示。

## AI 提示词系统（重要）

`server/prompts.js` 里只有一个入口 `buildTask(task, ctx)`；它路由到 `TASKS` 对象。`TEMPLATE_SLOTS` 列出了用户可在设置页里自定义模板的任务（见代码）。

**角色提示词结构**（全部走 `sys()`）：

```js
sys(BASE_SYSTEM, antiAi(novel), head(novel, pack))
```

- `BASE_SYSTEM`：硬核人格（经验丰富的中文小说作者，守住设定不敷衍写）
- `antiAi()`：**「口语粗粝」反AI味指令**——短句、动作折射情绪、话说半句也行、不总结、不升华、情绪靠身体折射。加载到章节正文/续写/段落操作/自定义处理/章节生成提示词中。如果用户以后问AI味问题，先看这里。
- `head(novel, pack)`：把作品设定、出场人物、世界观、大纲捏合进 prompt 头（≈800 字量级）
- `TEMPLATE_SLOTS`：20 个可定制任务的 key 列表（chapter / outline / worldview / …）
- 变量插值：`${novel.title}`、`${chapter.title}`、`${text}`、`${req}`、`${head}`；缺了一项会抛错并给你所有可用变量提示

**AI 输出插入 vs 模板预览**：`/api/ai/stream` 流式推送，`/api/ai/preview` 一次性预览（不调模型不花钱）。所有模型请求是后端代理的，前端不直接碰模型 API。

## 测试与质量保证

- 每次改完跑 `npm run regress`——mock 起来 288 项、mock 没起 281 项，区别在模型对比/人话错误提示两组会自动跳过
- 每次改完跑 `npm test`（lib 单元测试 585 项）
- 改完 lib/ 先跑 `npm run check-refs`
- 改完回到浏览器确认控制台 0 error（见 `tools/node`: Chrome DevTools Console）
- 做完记得 `git status --short` 确认没有污染的 `.tmp-*` / `dist/` / `data/`

> 数据污染自检过用 `SHU_DATA_DIR=.tmp-regress-data` 隔离。永远不要往 `data/` 里写测试数据——那是用户的真作品。

## 发布流程（v1.0.6 的经验）

1. 本地 `npm run regress` + `npm test` 必须全绿
2. `npm run dist`（生成 `dist\ShuJiang-Portable-1.0.6.exe` 和 `win-x64.zip`）

   这台机器直接跑 npm 会挂——AppData\Local 写不进、TLS 证书链也不通（v1.0.2 实测踩过两次 EPERM 和 unable to verify the first certificate）。用这个包一层环境变量（不改全局 PATH/系统环境）：

   ```powershell
   $env:TEMP=(Resolve-Path '.cache\electron-builder-temp').Path   # 给 electron-builder 一个能写的临时目录
   $env:TMP=$env:TEMP
   $env:PATH=(Resolve-Path 'tools\node').Path + ';' + $env:PATH   # npm 不在系统 PATH，tools\node 自带完整 Node+npm
   $env:ELECTRON_BUILDER_CACHE=(Join-Path (Resolve-Path '.cache').Path 'electron-builder-cache')
   $env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'  # 7zip/nsis 从 npmmirror 下，TLS 能过
   tools\node\node.exe node_modules\electron-builder\cli.js --win --x64
   ```

   zip 用 win-unpacked 打（内容在 zip 根目录，不是整个文件夹）：`Compress-Archive -Path 'dist\win-unpacked\*' -DestinationPath 'dist\ShuJiang-x.y.z-win-x64.zip' -CompressionLevel Optimal -Force`
3. 更新 `README.md` / `RELEASE_NOTES.md` 资产名和 tag 到 v1.0.6
4. `git push` + `git tag v1.0.6` + `git push origin v1.0.6`
5. 用 Windows Credential Manager 存的 token 上传，替换/新建 GitHub Releases 资产（POST /repos/{owner}/{repo}/releases → uploads.github.com 传两个资产；token 只从 `git credential fill` 读到、仅在内存使用）。**冒烟必须用 GitHub 下载版**（本机新打包 exe 很可能被本机拦截，包括 Portable 和 zip 里的书匠.exe）
6. 若说 setup="……"，不要自己去买新的证书；发布页上是未签名的，用户自行「更多信息→仍要运行」
7. 便携版是唯一发布形态；绿色版 zip 备用；Setup 包已删除

## 常见坑

| 坑 | 怎么办 |
| --- | --- |
| 模型 API 返回 429 配额 | 翻译成人话：额度用完／切个免费插件／Dashboard 付款 |
| 模型没给助手内容（或只给了思考）| 提示用户到设置调大 `max_new_tokens` 或换模型；不让空输出直接当空气 |
| SSE 中断且没收尾标记 | 拿到 HTTP 状态码看是 401/404/429/500/证书/DNS；分别给出"Key 不对 / 地址错 / 额度用完 / 切个免费插件 / 服务端崩了" |
| 模块自检挂了 | 先看哪条 `import` 缺了或撞了名；最大的 `web/lib/data.js` (964 行) 最容易有这种事 |
| 字体糊/太细 | 默认字体栈已经切到黑体（`PingFang SC` / `Microsoft YaHei UI` / `SimSun` 兜底）。不要改回 16 宋体——用户测试说字体不方便 |
| NSIS 安装报「无法关闭书匠」 | 用户机器上不是 App 在跑，是 NSIS 自己的 process detection 判错了。`安装书匠.cmd`（dist 下）通过把 TEMP 重定向到 `.cache/nsis-temp` 绕过了它。现在根本不发 NSIS 安装器了——便携版 + 绿色 zip 是唯一发布形态 |
| 本机新打包的 exe（含便携版）启动报 `NSIS Error / Error writing temporary file` 或 CreateProcess「文件已被用户占用」，但 GitHub 下载同一文件正常 | 这台机器对新生成的未签名 exe 有额外拦截（HIPS/沙箱），与 Temp、AV 无关（AV 全关、Temp 实测可写 150 MB）。**冒烟/验证必须从 GitHub Releases 下载版做**，本机 dist 产物只用于比对 hash，别指望它能起 |

## 给 AI 的模糊地带

| 事情 | 怎么处理 |
| --- | --- |
| 口号："去掉 X 功能" / "加 X 模板" | 先看 `TASKS` 是否已覆盖；不覆盖就加 `TEMPLATE_SLOTS` |
| 改 UI 框架 | 先问用户是否接受临时性 |
| 重构整体架构 | 不重构；这里性能够用 |
| 提议增大依赖／引入构建链 | 不 |
| 提议装 .exe 公式版 | 不；绿色版在 `dist/` 里 |

## 关于便携版

唯一形态就是 **ShuJiang-Portable-1.0.6.exe**（单进程嵌在 Electron 里）+ **win-x64.zip**（免安装）。`dist/` 不进 git；`tools/node/` 也不进 git（源码模式自带便携 Node）。`.gitignore` 已经处理。

构建命令：`npm run dist`。产出 `dist/ShuJiang-Portable-1.0.6.exe` + zip，约 110 MB 与 150 MB 大小，发布时上传到 GitHub Releases 并同步 tag。

## 维护者

- 作者：MistHowlJade（书匠，github.com/MistHowlJade/shujiang）
- 协议：MIT — 用户自行分叉，自己的版本自己分发
- 商业用／印刷：随便自己来，MIT 的事

> 如你有任何疑问——README.md、RELEASE_NOTES.md、本文档、以及 web/ 里的 inline 注释是唯一权威。其它地方说的话都只是垃圾。
