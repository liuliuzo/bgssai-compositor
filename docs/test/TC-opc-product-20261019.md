# bgssai-compositor：2026-10-19 功能目录用例

需求：[2026-10-19 功能需求](../feature/opc-requirements-20261019.md)。编写日期：2026-10-19。对照：[2026-10-19 OPC 静态差距审计](../feature/opc-gap-audit-20261019.md)。

2026-10-25 已回填真实结果：101 两条自动化通过，102 两条因无签名包/真机阻塞。结果只用待测、通过、失败、阻塞、不适用。功能未实现不能写不适用。不填写口令、Token、密钥或个人资料。2026-10-17 用例结果不在本文件改写。

| 用例ID | 关联需求 | 优先级 | 端 | 前置条件与数据 | 测试步骤 | 期望结果 | 结果 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TC-COMPOSITOR-PRODUCT-101-P | REQ-COMPOSITOR-PRODUCT-101 | P0 | user | 隔离测试环境；已记录被测版本；一份声明子集内的 8 位 RGB PSD，内含两个像素图层、一段 Txt 文字和一个简单用户蒙版；原工程副本已备份。 | 1. 导入该 PSD，查看转换报告的保留项与损失项；2. 在已声明可编辑范围内分别修改两个图层、文字和蒙版；3. 保存工程后重新打开并回读。 | 正向判定：在已声明可编辑范围内，两图层、文字和蒙版导入后可修改并回读；转换报告逐项说明保留情况。 | 通过 | 2026-10-25 自动化实测（合成夹具）：tests/psd-import.test.ts「declared 8-bit rgb subset keeps two pixel layers, a mask and text」通过；两像素图层、Txt 文字与简单用户蒙版导入后可修改并经 parseProject 回读一致，retained 逐项列明。范围限声明子集，不等于完整 Photoshop 兼容。 |
| TC-COMPOSITOR-PRODUCT-101-N | REQ-COMPOSITOR-PRODUCT-101 | P0 | user | 隔离测试环境；一份只含图层名的 PSD；CMYK、16 位或 PSB 样本；一份损坏 PSD；一份未改动的原工程。 | 1. 导入只列出图层名的样本，检查是否被标成可编辑导入；2. 导入损坏或超限文件；3. 核对原工程是否被覆盖。 | 异常判定：只列出图层名却标成可编辑导入，或损坏文件覆盖原工程，不能通过。 | 通过 | 2026-10-25 自动化实测：structure-only catalog 永不标 editable、CMYK/16 位/PSB 显式 blocked、损坏/超限拒绝且不替换原工程、图层效果/矢量蒙版/调整/智能对象/ZIP 逐项进 lost 且不标可编辑（tests/psd-import.test.ts 共 9 条全过）。五端 102 不在此关闭。 |
| TC-COMPOSITOR-PRODUCT-102-P | REQ-COMPOSITOR-PRODUCT-102 | P1 | 五端制品 | 同一工程含选区、蒙版、混合模式、文字和可撤销操作；Windows 安装包以及 macOS、Linux、iOS、Android 已声明范围内的实际制品；移动端按原生界面准备。 | 1. 在 Windows 安装包中完成编辑、恢复和导出；2. 在其他已声明端打开同一工程，回读选区、蒙版、混合模式、文字和撤销重做；3. 移动端按原生界面另行核对。 | 正向判定：Windows 安装包完成编辑、恢复和导出；其他端在已声明范围内回读一致。 | 阻塞 | 无签名安装包与五端真机/制品，不能实测。代码侧仅有工程/历史/恢复的自动化覆盖（tests/project.test.ts、reliability.test.ts），platformSlots() 五端均为 blocked（无签名证书与真机）。禁止以 Capacitor 目录或未签名壳代替安装验收。 |
| TC-COMPOSITOR-PRODUCT-102-N | REQ-COMPOSITOR-PRODUCT-102 | P1 | 五端制品 | 缺字体样本、无法解码的可编辑层，以及一份只有 Capacitor 工程目录、没有安装制品的移动端材料。 | 1. 在缺字体或解码失败时继续编辑并保存；2. 仅用 Capacitor 目录核对移动端安装验收。 | 异常判定：缺字体或解码失败时静默栅格化可编辑层，或用 Capacitor 目录代替安装验收，不能通过。 | 阻塞 | 代码侧负向守卫已自动化验证：缺字体保持文字层且 assertCanSave 拒绝保存、磁盘满/损坏不记成功（tests/psd-import.test.ts）；但五端制品上的安装验收无签名包与真机，整体仍阻塞，不得标通过。 |

执行记录（2026-10-25）：被测基线 `fb5391e6602d4f94aec10365c42c22006e931678`（origin/develop，worktree `muse/remaining-20261024`）；环境 Windows + Node v24.19.0；执行 `node node_modules/tsx/dist/cli.mjs --test tests/psd-import.test.ts tests/release-workflow.test.ts`（11/11 通过）、非服务类全量 36/36 通过、`tsc --noEmit` 通过。auth-safety/ecosystem/opc-account 三个服务类测试在本沙箱因禁止监听 127.0.0.1 而无法运行（主仓基线同样失败），非本文件范围，另记阻塞。同步 [进度](PROGRESS.md)。
