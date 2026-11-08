# bgssai-compositor：2026-10-19 功能目录增量

版本：2026-10-19（Asia/Shanghai）。权威愿景：用户 2026-10-17 规划。现行范围对照：[2026-10-19 OPC 静态差距审计](opc-gap-audit-20261019.md)。2026-10-17 需求见 [opc-requirements-20261017.md](opc-requirements-20261017.md)，其表格、编号与用例结果保持原样。

本文件只增加 Compositor 对功能目录的验收项。声明的 PSD 可编辑子集已在源码中实现；这不等于完整 Photoshop 兼容，也不等于五端运行验收通过。文件存在和结构校验都不等于产品验收通过。

## 产品职责

PS 式图像编辑。PSD 导入的已实现子集是：PSD 版本 1、8 位、RGB、原始或 PackBits 像素图层（通道 0/1/2 与可选 -1）、20 字节简单用户蒙版（通道 -2），以及 TySh 描述符中带 Txt 的简单文字。CMYK、调整图层、智能对象、图层效果、图层组、矢量蒙版、ZIP 压缩、PSB、16 位和 32 位仍不支持，不会标成可编辑。只读结构目录的保真度不是 editable。同一工程在各实际制品上的选区、蒙版、混合模式、文字和撤销重做仍按五端运行验收，移动端按原生界面另行验收。

## 与既有编号的关系

develop 上 PRODUCT 已用到 001–010，本轮从 101 起使用空号，不复用已有 ID。纳入需求数：2。

| 需求ID | 优先级 | 来源 | 细化的既有需求（原文不改） |
| --- | --- | --- | --- |
| REQ-COMPOSITOR-PRODUCT-101 | P0 | [AUD-COMPOSITOR-20261019-01](opc-gap-audit-20261019.md) | [REQ-COMPOSITOR-PRODUCT-010](opc-requirements-20261017.md) |
| REQ-COMPOSITOR-PRODUCT-102 | P1 | [AUD-COMPOSITOR-20261019-02](opc-gap-audit-20261019.md) | [REQ-COMPOSITOR-PRODUCT-001～003 与 PLATFORM-001～005](opc-requirements-20261017.md) |

## 功能与验收条件

| 需求ID | 能力 | 功能要求 | 通过/失败判定 | 用例 |
| --- | --- | --- | --- | --- |
| REQ-COMPOSITOR-PRODUCT-101 | PSD 可编辑与转换损失 | 导入声明子集：8 位 RGB 的两层像素、简单用户蒙版和带 Txt 的简单文字保持可编辑并回读；转换报告分列保留项与损失项。结构目录、CMYK、调整图层、智能对象、图层效果、PSB 和 16 位不得标成可编辑。 | 正向判定：在已声明可编辑范围内，两图层、文字和蒙版导入后可修改并回读；转换报告逐项说明保留情况。 异常判定：只列出图层名却标成可编辑导入，或损坏/超限文件覆盖原工程，不能通过。 | [TC-COMPOSITOR-PRODUCT-101-P / TC-COMPOSITOR-PRODUCT-101-N](../test/TC-opc-product-20261019.md) |
| REQ-COMPOSITOR-PRODUCT-102 | 五端编辑与导出一致性 | 同一工程在各实际制品上保留选区、蒙版、混合模式、文字和撤销重做；移动端按原生界面另行验收。 | 正向判定：Windows 安装包完成编辑、恢复和导出；其他端在已声明范围内回读一致。 异常判定：缺字体或解码失败时静默栅格化可编辑层，或用 Capacitor 目录代替安装验收，不能通过。 | [TC-COMPOSITOR-PRODUCT-102-P / TC-COMPOSITOR-PRODUCT-102-N](../test/TC-opc-product-20261019.md) |

## 规则边界与依赖

### 2026-10-25 补齐范围

- 101 / AUD-COMPOSITOR-20261019-01：用本地生成的 PSD 在真实 Electron 中验证文件选择、转换报告、图层顺序、两个像素层、文字、蒙版的修改，以及工程回读和 PNG 导出。图层蒙版反相和羽化必须改变实际遮罩透明度。声明子集仍不代表完整 Photoshop 兼容。
- 102 / AUD-COMPOSITOR-20261019-02：工程和恢复副本保留选区及受预算限制的撤销、重做历史；旧版 v1 工程仍可读取。读入文字层时重新检查本机字体，缺失时提供系统字体供用户主动替换；缺字体、图像解码失败或历史损坏不能覆盖当前工程。五端实际制品验收独立记录，缺设备或制品时记阻塞。移动端现为 Capacitor 共享界面，不据此宣称原生编辑界面目标完成。
- TODO-20261021-07 已由 `d51311d` 经 PR #24 合入 develop；本轮复核桌面 PSD 过滤器、仅境内模型路由及默认配置，并补充 PSD 桌面闭环证据，不重复实施已合入修改。

- 2026-10-17 的 REQ-COMPOSITOR-PRODUCT-001～010、COMMON、PLATFORM 与 REGRESSION 继续有效，编号不顺延改写，用例结果不改。
- REQ-COMPOSITOR-PRODUCT-101 只细化 REQ-COMPOSITOR-PRODUCT-010 的 PSD 可编辑边界与转换报告，不另起一套 010 编号。
- REQ-COMPOSITOR-PRODUCT-102 只细化 REQ-COMPOSITOR-PRODUCT-001～003 与 REQ-COMPOSITOR-PLATFORM-001～005 的跨端编辑、恢复和导出证据，不改 2026-10-17 平台分阶段决策原文。
- 新增 PSD 正反向用例已在 Electron 实际执行通过；五端正反向用例仍阻塞。合成夹具上的子集测试不等于五端安装验收；缺真实五端制品时记阻塞，不能把脚本、Capacitor 目录或只列图层名写成通过。没有新增数据库表。
- 覆盖索引见 [REQUIREMENT-COVERAGE.md](../test/REQUIREMENT-COVERAGE.md)，逐条矩阵见 [TRACEABILITY-20261019.md](../test/TRACEABILITY-20261019.md)。
