# bgssai-compossitor 功能测试

本目录存放本项目的功能测试案例和测试进度。

| 文件 | 职责 |
| --- | --- |
| [PROGRESS.md](./PROGRESS.md) | 测试进度。按功能汇总待测、通过、失败、阻塞、不适用 |
| `TC-*.md` | 功能测试案例。一条功能一份，按验收标准展开 |
| [功能测试模板](https://github.com/liuliuzo/bgssai-skeleton/blob/develop/docs/test/TEMPLATE.md) | 新案例模板 |

## 记录方式

1. 复制 [功能测试模板](https://github.com/liuliuzo/bgssai-skeleton/blob/develop/docs/test/TEMPLATE.md)，保存为 `TC-<功能>.md`。
2. 执行后把每条用例的「结果」写成待测、通过、失败、阻塞或不适用。
3. 同一天把汇总写回 [PROGRESS.md](./PROGRESS.md)。
4. 案例里不写口令、Token、密钥或客户隐私。

`docs/review` 继续放评审和检查结论。功能测试案例和测试进度放在本目录。

<!-- OPC-20261017 START -->
## 2026-10-17 规划补充与功能用例

[需求](../feature/opc-requirements-20261017.md) · [逐需求矩阵](TRACEABILITY-20261017.md) · [存量覆盖索引](REQUIREMENT-COVERAGE.md)

本轮新增39条可验收需求、78条用例；均为待测。历史测试不因本次补充改变结果。

- [TC-opc-product-20261017.md](TC-opc-product-20261017.md)
- [TC-opc-common-20261017.md](TC-opc-common-20261017.md)
- [TC-opc-platform-20261017.md](TC-opc-platform-20261017.md)
- [TC-feature-gaps-20261017.md](TC-feature-gaps-20261017.md)
<!-- OPC-20261017 END -->

<!-- OPC-20261019 START -->
## 2026-10-19 功能目录增量

[需求](../feature/opc-requirements-20261019.md) · [逐需求矩阵](TRACEABILITY-20261019.md) · [存量覆盖索引](REQUIREMENT-COVERAGE.md)

本轮新增 2 条需求、4 条用例，结果均为待测。不改写 20261017 需求表与已有用例结果。

- [TC-opc-product-20261019.md](TC-opc-product-20261019.md)
<!-- OPC-20261019 END -->

<!-- OPC-VALIDATION-20261017 START -->
## 覆盖与统计校验

机器可读清单：[functional-manifest-20261017.json](functional-manifest-20261017.json)、[functional-manifest-20261019.json](functional-manifest-20261019.json)。管理仓 `scripts/validate-functional-docs.py --repo <本仓路径>` 检查需求/用例ID、正反例、状态、链接、覆盖及历史套件指纹；20261019 套件不计入 20261017 清单的 progress 与 suite_counts。实际运行测试证据另行填写。
<!-- OPC-VALIDATION-20261017 END -->

## 2026-11-02 扫描补充

新增 6 条具体正反向案例，均待测。[本轮需求](../feature/functional-test-supplement-20261102.md) · [逐需求矩阵](TRACEABILITY-20261102.md) · [完整文件扫描](SCAN-20261102.json) · [现行进度](PROGRESS.md)。

### 校验与运行边界

新增套件、编号、正反例、引用、SCAN 文件清单与统计校验通过；原测试文件未修改。完整现行门禁与固定 develop 基线对比见 [VALIDATION-20261102.json](VALIDATION-20261102.json)：本轮未增加门禁失败。 原型门禁曾被既有索引元数据阻塞，已逐文件核对固定基线后修复失效路径/聚合摘要；[审计记录](PROTOTYPE-METADATA-REVIEW-20261102.json)保存原摘要、差异与Git来源，原型HTML和业务源码未改，原型检查PASS。
