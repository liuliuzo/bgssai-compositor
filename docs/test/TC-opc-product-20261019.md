# bgssai-compositor：2026-10-19 功能目录用例

需求：[2026-10-19 功能需求](../feature/opc-requirements-20261019.md)。编写日期：2026-10-19。对照：[2026-10-19 OPC 静态差距审计](../feature/opc-gap-audit-20261019.md)。

执行更新：2026-10-25，Windows / Node 24.19.0 / Electron 44.7.0；使用本仓合成 PSD、隔离临时目录和本地测试替身，未调用真实外部服务。101 正反向通过，102 正反向因缺签名包、五端制品和真机而阻塞。结果只用待测、通过、失败、阻塞、不适用。功能未实现不能写不适用。不填写口令、Token、密钥或个人资料。2026-10-17 用例结果不在本文件改写。

| 用例ID | 关联需求 | 优先级 | 端 | 前置条件与数据 | 测试步骤 | 期望结果 | 结果 | 证据与限制 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-COMPOSITOR-PRODUCT-101-P | REQ-COMPOSITOR-PRODUCT-101 | P0 | user | 隔离测试环境；已记录被测版本；一份声明子集内的 8 位 RGB PSD，内含两个像素图层、一段 Txt 文字和一个简单用户蒙版；原工程副本已备份。 | 1. 导入该 PSD，查看转换报告的保留项与损失项；2. 在已声明可编辑范围内分别修改两个图层、文字和蒙版；3. 保存工程后重新打开并回读。 | 正向判定：在已声明可编辑范围内，两图层、文字和蒙版导入后可修改并回读；转换报告逐项说明保留情况。 | 通过 | `npm run test:e2e`：`PSD desktop import edits two pixel layers, text and mask, then round trips and exports`；真实 Electron 原生文件桥接、修改、回读和 PNG 像素校验均通过。保留 develop 的单元证据：`tests/psd-import.test.ts` 中 `declared 8-bit rgb subset keeps two pixel layers, a mask and text` 验证两像素层、Txt 文字、简单蒙版、`parseProject` 回读及 `retained` 保留项。输入为本仓生成的声明子集 PSD，不代表完整 Photoshop 兼容。 |
| TC-COMPOSITOR-PRODUCT-101-N | REQ-COMPOSITOR-PRODUCT-101 | P0 | user | 隔离测试环境；一份只含图层名的 PSD；CMYK、16 位或 PSB 样本；一份损坏 PSD；一份未改动的原工程。 | 1. 导入只列出图层名的样本，检查是否被标成可编辑导入；2. 导入损坏或超限文件；3. 核对原工程是否被覆盖。 | 异常判定：只列出图层名却标成可编辑导入，或损坏文件覆盖原工程，不能通过。 | 通过 | `npm run test:e2e`：`PSD unsupported, damaged and oversized imports preserve the open project and save path`；`npm test` 中 `tests/psd-import.test.ts` 的目录、CMYK、16/32 位、PSB、ZIP、调整层/智能对象及损失报告用例通过。原工程与保存路径未被覆盖；结构目录不标 editable，图层效果、矢量蒙版、调整层、智能对象和 ZIP 均逐项报告损失。 |
| TC-COMPOSITOR-PRODUCT-102-P | REQ-COMPOSITOR-PRODUCT-102 | P1 | 五端制品 | 同一工程含选区、蒙版、混合模式、文字和可撤销操作；Windows 安装包以及 macOS、Linux、iOS、Android 已声明范围内的实际制品；移动端按原生界面准备。 | 1. 在 Windows 安装包中完成编辑、恢复和导出；2. 在其他已声明端打开同一工程，回读选区、蒙版、混合模式、文字和撤销重做；3. 移动端按原生界面另行核对。 | 正向判定：Windows 安装包完成编辑、恢复和导出；其他端在已声明范围内回读一致。 | 阻塞 | 共享引擎的选区、蒙版、混合模式、文字及历史已实现；`saved project retains selection and both undo and redo branches`、`force exit recovers editable project and saving clears recovery` 已通过。缺签名安装包、Windows 安装版验证，以及 macOS/Linux/iOS/Android 实际制品和设备；`platformSlots()` 五端均保持 blocked；移动端仍为 Capacitor 共享界面，没有原生编辑界面的完成证据，不能关闭五端验收。 |
| TC-COMPOSITOR-PRODUCT-102-N | REQ-COMPOSITOR-PRODUCT-102 | P1 | 五端制品 | 缺字体样本、无法解码的可编辑层，以及一份只有 Capacitor 工程目录、没有安装制品的移动端材料。 | 1. 在缺字体或解码失败时继续编辑并保存；2. 仅用 Capacitor 目录核对移动端安装验收。 | 异常判定：缺字体或解码失败时静默栅格化可编辑层，或用 Capacitor 目录代替安装验收，不能通过。 | 阻塞 | `font availability is rechecked on open and blocks save without rasterizing text`、`decode failures and invalid history preserve the current project and its destination`、磁盘满与内存预算测试已通过；保留 develop 的 `tests/psd-import.test.ts` 负向证据：缺字体保持文字层、`assertCanSave` 拒绝保存，磁盘满/损坏不记成功。缺签名包、五端真机及制品上的真实字体/解码/磁盘与内存边界、崩溃恢复证据；未将 Capacitor 目录或 mock 标作安装通过。 |

执行后记录被测 commit、环境、时间、执行人、实际结果与证据。同步 [进度](PROGRESS.md)。

详细环境、源码版本、命令结果、原有失败及审计项结论见 [本轮执行记录](../review/opc-acceptance-20261025.md)。

## develop 合入记录（2026-10-25）

已合入 `1abe8ee`（TODO-20261024-16，PR #30）。双方结果一致：101 两条通过，102 两条阻塞。本表以覆盖实际编辑、回读和导出的 Electron 证据为主，合并 develop 的单元证据和签名包/真机限制；没有以自动化结果关闭五端验收。

以下为 Muse 随该提交保存的历史记录，数量和环境限制只适用于该次执行；本分支合并后的复跑结果见[执行记录](../review/opc-acceptance-20261025.md)。

> 执行记录（2026-10-25）：被测基线 `fb5391e6602d4f94aec10365c42c22006e931678`（origin/develop，worktree `muse/remaining-20261024`）；环境 Windows + Node v24.19.0；执行 `node node_modules/tsx/dist/cli.mjs --test tests/psd-import.test.ts tests/release-workflow.test.ts`（11/11 通过）、非服务类全量 36/36 通过、`tsc --noEmit` 通过。auth-safety/ecosystem/opc-account 三个服务类测试在本沙箱因禁止监听 127.0.0.1 而无法运行（主仓基线同样失败），非本文件范围，另记阻塞。同步 [进度](PROGRESS.md)。
