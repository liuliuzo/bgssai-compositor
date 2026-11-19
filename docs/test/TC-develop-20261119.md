# bgssai-compositor 当前版本功能案例

功能基线为 develop 的 `183f197a80d5be2f385ed4250a90b183bb587bfc`。执行时记录实际 SHA、环境、执行时间、观察结果和证据。

用应用界面、接口或注明的隔离测试夹具执行下表。自动回归命令在表后，运行组件测试与部署环境验收分别记录。

| 用例ID | 关联需求 | 优先级 | 端 | 前置条件与数据 | 测试步骤 | 期望结果 | 结果 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-COMPOSITOR-20261119-01-P | REQ-COMPOSITOR-20261119-01 | P1 | 桌面端 | 使用测试套件生成的 8 位 RGB PSD、带额外通道的 PSD 和不受支持的 CMYK 文件。 | 导入 RGB 样本，检查两个像素层、遮罩和文字层；再导入带额外通道的样本。 | 可支持的像素和遮罩保留，额外通道出现在转换报告中。 | 待测 | PSD 图层导入与转换报告 |
| TC-COMPOSITOR-20261119-01-N | REQ-COMPOSITOR-20261119-01 | P1 | 桌面端 | 使用测试套件生成的 8 位 RGB PSD、带额外通道的 PSD 和不受支持的 CMYK 文件。 | 打开 CMYK 样本，查看转换结果及编辑状态。 | 报告明确标记格式不受支持，不将该文件呈现为可保真编辑项目。 | 待测 | PSD 图层导入与转换报告 |
| TC-COMPOSITOR-20261119-02-P | REQ-COMPOSITOR-20261119-02 | P1 | 桌面端 | 新建含文字和像素层的项目，选中图层并完成一次可撤销操作。 | 保存并重新打开项目，逐一检查选择状态和撤销、重做。 | 重新加载后选择和有效的历史快照都可恢复。 | 待测 | 项目保存与图层历史 |
| TC-COMPOSITOR-20261119-02-N | REQ-COMPOSITOR-20261119-02 | P1 | 桌面端 | 新建含文字和像素层的项目，选中图层并完成一次可撤销操作。 | 在测试副本中使用不受支持的项目版本或无效选择，再打开该副本。 | 无效项目状态被拒绝，不能成为当前可编辑项目。 | 待测 | 项目保存与图层历史 |

## 本地自动回归

从仓库根目录运行，使用仓库支持的 Node.js、JDK/Maven 或 Python 环境。每条命令须实际发现并执行测试。

- REQ-COMPOSITOR-20261119-01 · [psd-import.test.ts](../../tests/psd-import.test.ts) · `npx --no-install tsx --test tests/psd-import.test.ts`
- REQ-COMPOSITOR-20261119-02 · [project.test.ts](../../tests/project.test.ts) · `npx --no-install tsx --test tests/project.test.ts`
