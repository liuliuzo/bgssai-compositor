# bgssai-compositor：2026-11-02 功能测试补充

本轮仅把当前需求细则中的边界和故障路径补入测试设计，不改变产品功能契约。基线 `c3746b93bb0cb14836e69caf79294aa4be03d10e`；原案例与运行状态保留。旧目录已覆盖的主要功能见 [扫描清单](../test/SCAN-20261102.json)。

| 需求ID | 验收主题 | 既有需求来源 |
| --- | --- | --- |
| REQ-COMPOSITOR-SCAN-20261102-001 | 双槽快照恢复与损坏图层隔离 | [docs/feature/reference-ux-hardening-20261019.md](../../docs/feature/reference-ux-hardening-20261019.md) |
| REQ-COMPOSITOR-SCAN-20261102-002 | AI 图层确认与修订冲突 | [docs/feature/reference-ux-hardening-20261019.md](../../docs/feature/reference-ux-hardening-20261019.md) |
| REQ-COMPOSITOR-SCAN-20261102-003 | 凭证轮换后恢复待结算回执 | [docs/feature/model-price-receipts.md](../../docs/feature/model-price-receipts.md) |

所有新增案例均为待测；源码存在、目录校验通过或 PR 创建不等于产品运行通过。
