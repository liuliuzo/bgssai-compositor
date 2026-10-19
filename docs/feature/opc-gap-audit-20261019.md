# bgssai-compositor：OPC 规划静态差距审计（2026-10-19）

源码基线：`origin/develop`，`b20527293e224cbf8af35a5e95bf31209564a1f6`。本次已 fetch；原工作副本未用于修改。审计时开放 PR 数：0。

本文件是用户要求的需求完善与验收补充，关联现有 [2026-10-17 需求](opc-requirements-20261017.md)，不替代既有 PRD，不宣称新增功能已经实现。本次不改原型、接口、代码、数据库或部署；后续实施须按需求、原型、详设、实现顺序完成一致性验证。

结论：已有需求覆盖及部分真实实现，但不能判为全部满足。下表将明确的实现差异与尚未运行验证分开；没有运行证据不等同于功能不存在。源码方法、适配器、测试文件或安装脚本存在均不作为端到端通过证明。

## 现有需求与核心能力

| 现有需求 ID | 能力 | 本次核查结果 |
|---|---|---|
| REQ-COMPOSITOR-PRODUCT-001 | 图层画布编辑 | 已抽查相关实现，见 E1；边界与差异见下文，运行待验收 |
| REQ-COMPOSITOR-PRODUCT-002 | 工程保存恢复 | 已抽查相关实现，见 E1；边界与差异见下文，运行待验收 |
| REQ-COMPOSITOR-PRODUCT-003 | 图像导出 | 已抽查相关实现，见 E2；边界与差异见下文，运行待验收 |
| REQ-COMPOSITOR-PRODUCT-004 | AI编辑与回执 | 需求已覆盖；本次未逐条追通实现，保持未证实 |
| REQ-COMPOSITOR-PRODUCT-005 | 选区与内容识别填充 | 已抽查相关实现，见 E1；边界与差异见下文，运行待验收 |
| REQ-COMPOSITOR-PRODUCT-006 | 蒙版与混合模式 | 已抽查相关实现，见 E1；边界与差异见下文，运行待验收 |
| REQ-COMPOSITOR-PRODUCT-007 | 绘画修饰与文字形状 | 已抽查相关实现，见 E1；边界与差异见下文，运行待验收 |
| REQ-COMPOSITOR-PRODUCT-008 | 调整图层与滤镜 | 已抽查相关实现，见 E1；边界与差异见下文，运行待验收 |
| REQ-COMPOSITOR-PRODUCT-009 | 裁剪变换与尺寸 | 已抽查相关实现，见 E1；边界与差异见下文，运行待验收 |
| REQ-COMPOSITOR-PRODUCT-010 | 多格式导入与PSD兼容 | 已抽查相关实现，见 E2；边界与差异见下文，运行待验收 |

## 源码证据

| 编号 | 路径与符号 | 静态发现及限制 |
|---|---|---|
| E1 | [src/project.ts](../../src/project.ts)：`ProjectData`（基线第 107 行附近） | 工程记录图层、蒙版、文字、调整参数并限制画布/资源大小，验证项目结构；不等于与外部 PSD 数据模型完整互通。 |
| E2 | [src/io.ts](../../src/io.ts)：`importPsd`；[src/psd-subset.ts](../../src/psd-subset.ts)：`decodePsdSubset` | 已实现声明子集：8 位 RGB PSD 的原始/PackBits 像素图层、20 字节用户蒙版和 TySh/Txt 简单文字可变成工程图层并回读。结构目录保真度不是 editable。CMYK、调整图层、智能对象、图层效果、PSB、16/32 位仍明确不支持。不是完整 Photoshop 兼容，五端运行验收未通过。 |
| E3 | [package.json](../../package.json)：`dist:mac`（基线第 23 行附近） | 存在桌面三端打包脚本与 Capacitor 同步；脚本不是五端实际发行及原生移动界面验收证据。 |

## 增量需求与验收任务

以下 AUD 编号是现有需求的差距/验收补充任务编号，不是另建一套同名功能。P0 在宣称对应能力可用前关闭；P1 随完整产品体验交付关闭。所有条目目前均待实施或待验证，本文不将其标为通过。

### AUD-COMPOSITOR-20261019-01 · P0 · PSD 可编辑能力与转换损失边界

- 关联需求：REQ-COMPOSITOR-PRODUCT-010。
- 当前状态：声明子集已在源码实现；运行与五端验收未通过。不是完整 Photoshop 兼容。
- 需求补充：可编辑范围限于 PSD 版本 1、8 位 RGB、原始或 PackBits 像素、简单用户蒙版和带 Txt 的简单文字。不得把只列图层名当作可编辑导入。
- 正常验收：在已声明可编辑范围内导入包含两图层、文字与蒙版的 PSD，逐层修改并保存工程后回读一致；转换报告逐项说明保留情况。
- 异常验收：CMYK、调整图层、智能对象、图层效果、图层组、矢量蒙版、ZIP、PSB、16/32 位保持不支持，不标可编辑；拒绝损坏/超限文件且不覆盖原工程。
- 依赖：现有工程格式与转换报告。不新增数据库表。外部 Photoshop 样本和五端制品仍未作为运行验收证据。

### AUD-COMPOSITOR-20261019-02 · P1 · 五端编辑工程和导出一致性

- 关联需求：REQ-COMPOSITOR-PRODUCT-001、REQ-COMPOSITOR-PRODUCT-002、REQ-COMPOSITOR-PRODUCT-003、REQ-COMPOSITOR-PLATFORM-001、REQ-COMPOSITOR-PLATFORM-002、REQ-COMPOSITOR-PLATFORM-003、REQ-COMPOSITOR-PLATFORM-004、REQ-COMPOSITOR-PLATFORM-005。
- 当前状态：运行与发行未证实。
- 需求补充：以同一工程验证选区、蒙版、混合模式、文字与撤销重做在各实际制品上的保留；移动端原生界面目标单独验收，不能用 Capacitor 工程目录当已达成。
- 正常验收：Windows 安装包完成编辑、恢复、导出；相同工程在 macOS/Linux/iOS/Android 明确支持范围内回读、交互和导出一致。
- 异常验收：缺字体/解码能力、磁盘满/内存边界和崩溃恢复明确提示，不悄悄栅格化可编辑层或把损坏工程写为成功。
- 依赖：真实五端设备/制品、字体与图像解码能力、恢复快照及发行签名。

## 全线共同要求的关闭证据

共同要求沿用原需求，不新增重复 ID。下列范围本次没有真实环境/制品运行证据，因此保持未证实；不能从页面入口或文案检索推定已实现。

| 范围 | 原需求索引 | 关闭条件 |
|---|---|---|
| B2C、密码/验证码/区域授权与 admin 隔离 | REQ-COMPOSITOR-COMMON-001、REQ-COMPOSITOR-COMMON-002、REQ-COMPOSITOR-COMMON-003、REQ-COMPOSITOR-COMMON-004、REQ-COMPOSITOR-COMMON-006、REQ-COMPOSITOR-COMMON-007、REQ-COMPOSITOR-COMMON-008、REQ-COMPOSITOR-COMMON-009 | 真实正向回调/投递、取消重放、跨账号拒绝；应用独立 user 会话，admin 不开放注册。 |
| 模型与额度 | REQ-COMPOSITOR-COMMON-010、REQ-COMPOSITOR-COMMON-011、REQ-COMPOSITOR-COMMON-012、REQ-COMPOSITOR-COMMON-018、REQ-COMPOSITOR-COMMON-019 | 有该能力的业务真实路由固定 CN；提交前展示已有倍率规则；请求、用量与账本可对账。Blog 保留既有不提供站内 AI 写文章及相关已确认边界。 |
| Bot 下载与授权 | REQ-COMPOSITOR-COMMON-014、REQ-COMPOSITOR-COMMON-015 | 实际包版本/平台与安装启动；真实业务调用、撤销与越权拒绝，用户授权不能提升为平台 admin。 |
| 五端交付 | REQ-COMPOSITOR-PLATFORM-001、REQ-COMPOSITOR-PLATFORM-002、REQ-COMPOSITOR-PLATFORM-003、REQ-COMPOSITOR-PLATFORM-004、REQ-COMPOSITOR-PLATFORM-005 | Windows/macOS/Linux/iOS/Android 分别有真实可安装制品、设备和核心流程证据。Tube 按系列分工：PC 桌面三端，Android/iOS 各自原生端，Web 浏览器端；不要求四仓重复造五端。 |

部署验收沿用用户规则：dev 与 prod 均部署 develop，分别加载 application-dev.properties 与 application-prod.properties。需记录同一源码版本与配置差异；本次没有触发部署。

每项关闭记录至少包含源码 SHA、构建/制品版本、设备/系统、环境、脱敏输入输出、预期与实际、时间、失败原因。缺渠道配置、模型额度、设备、样本或外部回执时标记阻塞/未验证，不能用模拟结果替代真实运行。

## 参考版本与 PR 去重

参考仓已按远端默认分支同步并固定下列快照；参考版本仅作对照，未复制第三方实现，也不表示本产品获得参考项目全部功能。

| 参考仓 | 同步后 SHA | 同步状态 |
|---|---|---|
| [robbietilton/Compositor](https://github.com/robbietilton/Compositor) | `365b5745eda537f984f3d5bed1e53c361dbc9c91` | current |

审计前未发现开放 PR；以下是查询到的最近已合并 PR，仅用于识别当前来源，不能据此推定部署完成：

- [#14：docs: rename Media to Tube in shared requirements](https://github.com/liuliuzo/bgssai-compositor/pull/14)（合并时间 2026-10-18T11:39:17Z）。
- [#13：docs: sync functional test manifest and progress counters with develop](https://github.com/liuliuzo/bgssai-compositor/pull/13)（合并时间 2026-10-17T14:35:26Z）。
- [#12：docs: remove redundant document copies](https://github.com/liuliuzo/bgssai-compositor/pull/12)（合并时间 2026-10-17T14:31:45Z）。

验证范围：本次只验证新增文档的本地链接、已有需求 ID、证据路径及 git diff --check；未执行产品测试、模型调用、真实投递、投稿、支付或部署。

## 2026-10-19 实现口径

PSD 声明子集已实现：8 位 RGB 的原始或 PackBits 像素图层、简单用户蒙版和带 Txt 的简单文字可编辑并回读。转换报告分列保留项与损失项。只读结构目录不会标成 editable。CMYK、调整图层、智能对象、图层效果、PSB 和 16 位仍不支持。缺少字体、磁盘已满或工程损坏时保存失败，不记成功。五端签名包和运行验收仍未通过。没有新增库表。
