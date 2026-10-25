# BGSSAI Compositor

一款离线、以图层为核心的图像编辑软件。`0.2.0` 使用共享 React / Canvas 引擎、三端 Electron 和 iOS / Android Capacitor 原生工程。首版参考 [robbietilton/Compositor](https://github.com/robbietilton/Compositor) 的合成工作流，独立实现。

产品仓与 GitHub 仓库名均为 **bgssai-compositor**。

## 使用 Windows 版

面向 Windows 10 / Windows 11 **x64**；建议 8 GB 或以上内存。本地构建未进行商业代码签名；正式签名、发布及更新通过受控流程配置，详见 [分发说明](docs/feature/COMP-02-04-05.md)。

- 免安装版：`BGSSAI-Compositor-0.2.0-win-x64-portable.exe`，双击即可启动。
- 安装版：`BGSSAI-Compositor-0.2.0-win-x64-setup.exe`，可选择安装目录，并创建桌面快捷方式。
- PR / `develop` 分支的 GitHub Actions 在 Windows 上验证并生成上述文件；构建成功后在对应运行页面下载 `BGSSAI-Compositor-Windows-x64` artifact。
- 本地编辑和文件读写不需要账号、服务器或联网；账户同步、Bot 和 TokenHub AI 建议分别授权。

打开应用后可以创建画布、打开图片，或点击“打开示例”探索由多个可编辑图层组成的示例作品。

![Windows 桌面版实际运行截图](docs/review/windows-preview.png)

## 首版功能

| 工作流     | 已支持                                                                         |
| ---------- | ------------------------------------------------------------------------------ |
| 文件       | 新建自定义画布；打开 PNG / JPEG / WebP / BMP 和声明子集内的 PSD；导入图片为图层；拖放和粘贴图片 |
| 图层       | 新增、复制、删除、重命名、显隐、锁定；按钮或拖动排序；正常混合模式图层向下合并 |
| 合成       | 图层不透明度；正常、正片叠底、滤色、叠加、柔光等 16 种混合模式                 |
| 变换       | 拖动移动、四角等比缩放、数值位置和尺寸、旋转、水平/垂直翻转；保留原始像素      |
| 绘画       | 画笔、橡皮擦；大小和不透明度；笔输入压力；前景色和吸管                         |
| 选区       | 矩形选区限制绘画/擦除范围；删除选区内像素；裁切画布；Shift 等比选择            |
| 文字与形状 | 可编辑多行文字、字体、字号、颜色、粗体及文字栅格化；矩形、椭圆                 |
| 调整       | 每图层非破坏性亮度、对比度、饱和度和模糊                                       |
| 历史       | 撤销、重做、历史面板；项目与恢复副本保留选区和受预算限制的历史；更改后关闭或打开新文档前提醒保存 |
| 画布       | 5%–400% 缩放、适合窗口、实际像素、抓手、Ctrl+滚轮缩放                          |
| 输出       | `.bgcomp` 可编辑项目；PNG 透明无损导出；JPEG 质量和透明区域填充色              |

### 当前边界

- **不是完整 Photoshop 兼容**：PSD 只导入声明子集内的 8 位 RGB 像素图层、简单用户蒙版和简单文字，并逐项报告转换损失；PSB、RAW、CMYK、调整图层、智能对象、图层效果、图层组和矢量蒙版不在可编辑子集。五端安装验收见 [2026-10-19 用例](docs/test/TC-opc-product-20261019.md)。
- 编辑器采用 RGB / 8 位 Canvas 工作流，无 ICC 色彩管理、印刷软打样或 EXIF 保留承诺。
- 矩形、椭圆创建为像素图层；文字保持可编辑，栅格化后不能恢复文字内容，除非撤销。
- 非正常混合模式的图层须先改为正常，才能向下合并，以免破坏依赖背景的合成效果。
- 每个文档最多 1677 万像素，单边最多 8192 px；最多 40 个图层，总图层像素不超过 4800 万；文件和项目上限 128 MB。
- 历史记录最多 30 步，并受最多 96 MB 的快照预算限制；桌面预计工作集上限 768 MB，移动端 320 MB。工程文件和自动恢复副本保留当前选区、撤销位置与重做分支，旧 v1 工程仍可读取。大项目解码和新图层分配前检查预算，拒绝超限操作。
- 编辑提交后约 1.5 秒自动保存恢复副本，连续编辑每 10 秒尝试保存最近完整提交。启动时可恢复或丢弃；保留两代有效快照，不覆盖正式项目。仍用 `Ctrl+S` 将项目保存到正式文件。
- 移动端通过“打开”选择 `.bgcomp` 或图片；保存和导出创建 Documents 中独立副本并提供系统分享。iOS 无 Canvas filter 时使用软件颜色调整和近似高斯模糊，模糊边缘可能有小幅差异。

## 常用快捷键

| 操作                        | Windows 快捷键                             |
| --------------------------- | ------------------------------------------ |
| 新建 / 打开 / 导入为图层    | Ctrl+N / Ctrl+O / Ctrl+Shift+O             |
| 保存 / 另存为 / 导出        | Ctrl+S / Ctrl+Shift+S / Ctrl+Shift+E       |
| 撤销 / 重做                 | Ctrl+Z / Ctrl+Shift+Z（或 Ctrl+Y）         |
| 复制图层 / 取消选区         | Ctrl+J / Ctrl+D                            |
| 移动 / 选区 / 画笔 / 橡皮擦 | V / M / B / E                              |
| 矩形 / 椭圆 / 文字 / 吸管   | U / O / T / I                              |
| 抓手 / 临时抓手             | H / 按住空格                               |
| 适合窗口 / 实际像素         | Ctrl+0 / Ctrl+1                            |
| 画笔大小                    | [ / ]                                      |
| 移动图层微调                | 方向键，Shift+方向键移动 10 px             |
| 删除                        | 有选区时清除选区像素，无选区时删除当前图层 |

## 本地开发与构建

需要 Node.js **24** 和 npm。桌面在对应操作系统构建；Android 需要 Java 21、SDK 36；iOS 需要 macOS / Xcode。首次安装和原生依赖解析需要联网，运行编辑器可以离线。

```powershell
npm ci
npm run dev
```

验证和生成可执行文件：

```powershell
npm run check
npm run dist:win -- --publish never
npm run test:package
npm run test:portable
npm run release:manifest
```

生成的安装版、免安装版和未打包目录位于 `release/`。`release/`、`dist/` 和 `node_modules/` 不提交到 Git。

macOS 使用 `npm run dist:mac -- --publish never`；Linux 使用 `npm run dist:linux -- --publish never`。本地无签名 macOS 构建另传 `--config.mac.identity=- --config.mac.notarize=false --config.mac.hardenedRuntime=false`。手机执行 `npm run mobile:sync`，然后在 `clients/android` / `clients/ios` 构建原生安装包。CI 上传构建 artifact；源码和工程不等于五端安装验收已完成。

可选在线服务执行 `npm run build:shared` 后通过 `npm run service` 启动。先在相应 properties 填服务根地址、Chat 登记和 Hub 配置，并在服务环境提供密钥。默认空配置不发起网络请求。接口、权限、部署和签名凭据说明见 [COMP-02/04/05 实现及验收](docs/feature/COMP-02-04-05.md)。

`npm run build` 执行 TypeScript 类型检查和渲染器构建；`npm start` 启动已经构建好的桌面程序。`npm run test` 检查项目格式和变换坐标；`npm run test:e2e` 在真实 Electron 中验证像素编辑、图层操作、文件往返和导出。测试使用应用自带的 Electron，无需下载 Playwright 浏览器。

安装脚本使用 Electron 官方下载接口及官方校验和，并用 Windows 内置 ZIP 解压器安装运行时，避免部分 Windows 系统无法加载 Electron 44 原生 ZIP 解压模块的问题。

### 分支与环境

- 所有源码修改通过工作分支的 draft PR 交付到 `develop`，默认由用户在 GitHub 上合并。
- `dev` 与 `prod` 都使用 `develop` 分支；只通过 `config/application-dev.properties` / `config/application-prod.properties` 区分配置。
- `npm run dev` 读取开发配置；打包应用使用生产配置。服务用 `APP_ENV=dev` / `prod` 选择同一 `develop` 源码的不同 properties；密钥只从服务环境读入。
- PR / `develop` CI 构建五端；手工签名工作流只接受已在 `develop` 的版本 tag，五端签名构建成功后创建 draft Release，不自动发布或合并 PR。

## 项目结构

```text
electron/      三端主进程、隔离的 preload、恢复存储和更新回滚
clients/       Android / iOS 原生工程
service/       可选 Chat 授权、同步、Bot 与 TokenHub 接入服务
distribution/  官网 / Bot / 其它应用的统一下载登记
integration/   Bot 操作契约
fixtures/      五端共同 bgcomp 样例
src/           中文工作台、Canvas 图像引擎、项目格式校验
config/        dev / prod properties
build/         原创应用图标
scripts/       开发启动、运行时安装及图标生成
tests/         文件格式单元测试与真实桌面端到端测试
docs/          项目文件格式与架构说明
```

## 参考与许可

参考项目 [Compositor](https://github.com/robbietilton/Compositor) 是 Robbie Tilton 创建的 macOS 图像编辑应用，采用 MIT 许可。本项目参考其编辑工作流，没有复制或编译其 Swift 源码；Windows 代码、示例图形和图标为独立实现。本仓库代码采用 [MIT License](LICENSE)。React、Electron 等依赖遵循其各自的许可；Windows 包含 Electron 的第三方许可文件。
