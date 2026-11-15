# 本地 PSD 导入契约

PSD 文件在本地解析，不调用在线服务或商业转换引擎。`decodePsdSubset(bytes, fileName?)` 返回转换结果；`importWithReport(fileName, dataUrl)` 将其包装为 UI 使用的 `ConversionReport`。该路径不新增数据库表。

## 支持边界

- 可编辑子集：PSD v1、8 位 RGB、原始或 PackBits 通道 0/1/2、可选透明通道 -1、具有 20 字节简单用户蒙版信息的通道 -2，以及简单 TySh/Txt 文字。
- 未映射的附加通道（含专色附加通道与 -3 真实用户蒙版）不写入工程，也不按图层尺寸尝试解码；按图层与通道 ID 逐项加入 `lost` 与图层 `note`。支持的像素、简单蒙版与文字仍可保留。
- 含未映射通道的可编辑子集导入返回 `support=partial`。没有可编辑子集时不生成 `project`，保持 `unsupported`；调用方若能解码合成图，仅按整图栅格化回退。
- 同一图层重复通道 ID、任一通道长度不足 2 字节的压缩头或通道数据超出声明范围，是损坏输入；解析抛出 `PSD 图层数据损坏。`，调用方不得替换当前工程。不同图层可以使用相同通道 ID。
- `editable` 只表示声明子集，不表示完整 Photoshop 兼容；目录项保持 `catalog` 且不可编辑。

## 报告字段

`ConversionReport` 包含 `support`（`editable`、`partial` 或 `unsupported`）、`layers`（逐项的 `editable` / `fidelity` / `note`）、`retained`、`lost`、`issues` 与导入结果 `projectJson` 或 `imageDataUrl`。出现未映射图层通道时不得返回 `support=editable`；用户界面须在导入前展示保留项和损失项。`ok=true` 表示已有可导入的结果，不表示没有转换损失。

回归用例：`tests/psd-import.test.ts`。真实 Photoshop 样本、外部应用互操作和各端运行验收仍按 `docs/test/TC-opc-product-20261019.md` 执行，不以合成夹具测试替代。
