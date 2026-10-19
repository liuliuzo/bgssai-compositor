# bgssai-compositor：2026-10-19 功能目录增量

版本：2026-10-19（Asia/Shanghai）。权威愿景：用户 2026-10-17 规划。现行范围对照：[2026-10-19 OPC 静态差距审计](opc-gap-audit-20261019.md)。2026-10-17 需求见 [opc-requirements-20261017.md](opc-requirements-20261017.md)，其表格、编号与用例结果保持原样。

本文件只增加 Compositor 对功能目录的验收项。本次没有实现产品功能、没有执行用例，也没有改业务代码。文件存在和结构校验都不等于产品验收通过。

## 产品职责

PS 式图像编辑。本轮把 PSD 导入拆成已支持的结构读取/栅格合成，以及尚未支持的可编辑图层、蒙版和文字；并把同一工程在各实际制品上的选区、蒙版、混合模式、文字和撤销重做收口为可验收项。移动端按原生界面另行验收。

## 与既有编号的关系

develop 上 PRODUCT 已用到 001–010，本轮从 101 起使用空号，不复用已有 ID。纳入需求数：0。

| 需求ID | 优先级 | 来源 | 细化的既有需求（原文不改） |
| --- | --- | --- | --- |
| REQ-COMPOSITOR-PRODUCT-101 | P0 | [AUD-COMPOSITOR-20261019-01](opc-gap-audit-20261019.md) | [REQ-COMPOSITOR-PRODUCT-010](opc-requirements-20261017.md) |
| REQ-COMPOSITOR-PRODUCT-102 | P1 | [AUD-COMPOSITOR-20261019-02](opc-gap-audit-20261019.md) | [REQ-COMPOSITOR-PRODUCT-001～003 与 PLATFORM-001～005](opc-requirements-20261017.md) |

## 功能与验收条件

| 需求ID | 能力 | 功能要求 | 通过/失败判定 | 用例 |
| --- | --- | --- | --- | --- |
| REQ-COMPOSITOR-PRODUCT-101 | PSD 可编辑与转换损失 | 把 PSD 导入拆成已支持的结构读取/栅格合成，以及尚未支持的可编辑图层、蒙版和文字。 | 正向判定：在已声明可编辑范围内，两图层、文字和蒙版导入后可修改并回读；转换报告逐项说明保留情况。 异常判定：只列出图层名却标成可编辑导入，或损坏文件覆盖原工程，不能通过。 | [TC-COMPOSITOR-PRODUCT-101-P / TC-COMPOSITOR-PRODUCT-101-N](../test/TC-opc-product-20261019.md) |
| REQ-COMPOSITOR-PRODUCT-102 | 五端编辑与导出一致性 | 同一工程在各实际制品上保留选区、蒙版、混合模式、文字和撤销重做；移动端按原生界面另行验收。 | 正向判定：Windows 安装包完成编辑、恢复和导出；其他端在已声明范围内回读一致。 异常判定：缺字体或解码失败时静默栅格化可编辑层，或用 Capacitor 目录代替安装验收，不能通过。 | [TC-COMPOSITOR-PRODUCT-102-P / TC-COMPOSITOR-PRODUCT-102-N](../test/TC-opc-product-20261019.md) |

## 规则边界与依赖

- 2026-10-17 的 REQ-COMPOSITOR-PRODUCT-001～010、COMMON、PLATFORM 与 REGRESSION 继续有效，编号不顺延改写，用例结果不改。
- REQ-COMPOSITOR-PRODUCT-101 只细化 REQ-COMPOSITOR-PRODUCT-010 的 PSD 可编辑边界与转换报告，不另起一套 010 编号。
- REQ-COMPOSITOR-PRODUCT-102 只细化 REQ-COMPOSITOR-PRODUCT-001～003 与 REQ-COMPOSITOR-PLATFORM-001～005 的跨端编辑、恢复和导出证据，不改 2026-10-17 平台分阶段决策原文。
- 新增用例统一待测。缺真实五端制品、字体、PSD 样本或解码能力时记阻塞，不能把脚本、Capacitor 目录或只列图层名写成通过。
- 覆盖索引见 [REQUIREMENT-COVERAGE.md](../test/REQUIREMENT-COVERAGE.md)，逐条矩阵见 [TRACEABILITY-20261019.md](../test/TRACEABILITY-20261019.md)。
