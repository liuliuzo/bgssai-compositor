# liuliuzo/bgssai-compositor 存量需求覆盖索引

基线：`06cd48221314f05c10b5c8516d5ac9b79353183a`；日期：2026-10-17。列出4个存量需求/索引文件。功能清单中的有效条款按专项用例保留；索引、模板、旧方案与审计材料标注用途，不当作独立产品能力。

历史套件匹配依据为需求路径/文件名或同名套件；这是按文件的测试设计导航，不等于每个旧条款已经运行通过。执行前须同时核对源文中的字段与所有参数组合。本轮逐条验收见[追溯矩阵](TRACEABILITY-20261017.md)。

| 来源 | 关联方式/范围 | 历史用例（结果未改写） | 本轮用例 |
| --- | --- | --- | --- |
| [COMP-02 / COMP-04 / COMP-05 实现与验收](../../docs/feature/COMP-02-04-05.md) | 专项或共同契约用例 | — | [REQ-COMPOSITOR-REGRESSION-002](TC-feature-gaps-20261017.md)：TC-COMPOSITOR-REGRESSION-002-P, TC-COMPOSITOR-REGRESSION-002-N<br>[REQ-COMPOSITOR-REGRESSION-003](TC-feature-gaps-20261017.md)：TC-COMPOSITOR-REGRESSION-003-P, TC-COMPOSITOR-REGRESSION-003-N |
| [AI 模型价格与回执](../../docs/feature/model-price-receipts.md) | 专项或共同契约用例 | — | [REQ-COMPOSITOR-REGRESSION-001](TC-feature-gaps-20261017.md)：TC-COMPOSITOR-REGRESSION-001-P, TC-COMPOSITOR-REGRESSION-001-N |
| [OPS-COMP-01 与 OPS-COMP-02 特性规格说明](../../docs/feature/OPS-COMP-01-02.md) | 专项或共同契约用例 | — | [REQ-COMPOSITOR-REGRESSION-004](TC-feature-gaps-20261017.md)：TC-COMPOSITOR-REGRESSION-004-P, TC-COMPOSITOR-REGRESSION-004-N<br>[REQ-COMPOSITOR-REGRESSION-005](TC-feature-gaps-20261017.md)：TC-COMPOSITOR-REGRESSION-005-P, TC-COMPOSITOR-REGRESSION-005-N |
| [功能需求](../../docs/feature/README.md) | 索引或模板，不作为独立业务功能 | — | — |

## 2026-10-19 功能目录增量

本轮不删除、不改写上表 2026-10-17 各行，也不改写 20261017 用例结果。[2026-10-19 OPC 静态差距审计](../feature/opc-gap-audit-20261019.md) 的 AUD 编号对应下列新增需求。正反例见 [TC-opc-product-20261019.md](TC-opc-product-20261019.md)，结果均为待测。逐条矩阵见 [TRACEABILITY-20261019.md](TRACEABILITY-20261019.md)。

| 来源 | 关联方式/范围 | 既有需求（原文未改） | 本轮需求与用例 |
| --- | --- | --- | --- |
| [OPC 静态差距审计](../feature/opc-gap-audit-20261019.md) | AUD-COMPOSITOR-20261019-01，细化多格式导入与 PSD 兼容 | [REQ-COMPOSITOR-PRODUCT-010](../feature/opc-requirements-20261017.md) | [REQ-COMPOSITOR-PRODUCT-101](../feature/opc-requirements-20261019.md)：[TC-COMPOSITOR-PRODUCT-101-P, TC-COMPOSITOR-PRODUCT-101-N](TC-opc-product-20261019.md) |
| [OPC 静态差距审计](../feature/opc-gap-audit-20261019.md) | AUD-COMPOSITOR-20261019-02，细化图层编辑、保存恢复、导出与五端交付 | [REQ-COMPOSITOR-PRODUCT-001～003 与 PLATFORM-001～005](../feature/opc-requirements-20261017.md) | [REQ-COMPOSITOR-PRODUCT-102](../feature/opc-requirements-20261019.md)：[TC-COMPOSITOR-PRODUCT-102-P, TC-COMPOSITOR-PRODUCT-102-N](TC-opc-product-20261019.md) |
