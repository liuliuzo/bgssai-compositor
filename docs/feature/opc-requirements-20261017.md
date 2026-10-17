# bgssai-compositor：OPC规划功能需求与验收补充

版本：2026-10-17。来源：用户本轮完整规划；存量需求基线：`06cd48221314f05c10b5c8516d5ac9b79353183a`。

本次交付是用户要求的需求与测试设计，未实现、部署或执行这些功能。下列条目将规划细化为可验证目标；不表示现有产品已经具备。既有详细需求继续有效，明确冲突按本轮用户规划修正，未涉及字段和接口不在本文件重新定义。原型、详设、代码、数据库由相应功能实施任务按仓库流程推进，本次不将规划状态改为已实现。

## 产品职责

PS式图像编辑软件，当前Windows PC为起点，最终覆盖五端；规范产品名Compositor。

参考：robbietilton/Compositor。参考用于产品方向，不表示复制实现或已经具备参考产品全部功能。

区域/身份范围：境内；模型仅Tokenhub CN；微信/抖音/百度/支付宝。Website公开官网沿用无用户登录；Bot嵌入Chat；Build Add API key使用Developer凭证，公开客户端授权与API Key路径分别验收。

## 功能与验收条件

| 需求ID | 能力 | 功能要求 | 通过/失败判定 | 用例 |
| --- | --- | --- | --- | --- |
| REQ-COMPOSITOR-PRODUCT-001 | 图层画布编辑 | 支持创建画布、导入图像、图层排序显隐和已声明的变换编辑，结果可撤销重做。 | 画布与图层状态一致；变换可回溯；未编辑层不被破坏。 异常：明确校验不崩溃；保留已完成编辑，不修改其他图层。 | [TC-COMPOSITOR-PRODUCT-001-P / TC-COMPOSITOR-PRODUCT-001-N](../test/TC-opc-product-20261017.md) |
| REQ-COMPOSITOR-PRODUCT-002 | 工程保存恢复 | 编辑工程可保存并重新打开，保留图层、尺寸、透明度和可编辑信息。 | 图层和画布还原，副本可独立编辑；原文件不被无提示覆盖。 异常：提示未保存或恢复限制；不破坏最后有效文件。 | [TC-COMPOSITOR-PRODUCT-002-P / TC-COMPOSITOR-PRODUCT-002-N](../test/TC-opc-product-20261017.md) |
| REQ-COMPOSITOR-PRODUCT-003 | 图像导出 | 支持按已声明格式、尺寸和透明度导出，结果可由外部查看器打开。 | 文件可读，内容与画布一致；不支持透明的格式有明确处理。 异常：明确失败，不输出伪成功空文件，不覆盖无权文件。 | [TC-COMPOSITOR-PRODUCT-003-P / TC-COMPOSITOR-PRODUCT-003-N](../test/TC-opc-product-20261017.md) |
| REQ-COMPOSITOR-PRODUCT-004 | AI编辑与回执 | 已支持AI能力以当前图层或选区为输入，结果预览确认后应用，保留模型价格与任务回执。 | 输入范围与结果一致；用户能撤销；回执关联真实任务与用量。 异常：不覆盖错误文档、不应用未确认结果；失败不冒充成功。 | [TC-COMPOSITOR-PRODUCT-004-P / TC-COMPOSITOR-PRODUCT-004-N](../test/TC-opc-product-20261017.md) |
| REQ-COMPOSITOR-COMMON-001 | 自助注册与本地账号 | OPC 用户可自行注册使用产品；本地账号与 Chat 第三方账号按显式绑定关系关联，不静默合并同名用户。 | 注册无需平台管理员代办；登录身份正确；业务记录归属该用户，重开可读取。 异常：错误密码不签发会话；重复注册有明确提示；不同主体不会自动获取已有用户的数据。 | [TC-COMPOSITOR-COMMON-001-P / TC-COMPOSITOR-COMMON-001-N](../test/TC-opc-common-20261017.md) |
| REQ-COMPOSITOR-COMMON-002 | 邮箱与手机验证码 | 邮箱验证码和手机验证码均可登录；验证码真实投递、限时、单次使用并绑定接收人及用途。 | 两种方式均能建立正确用户会话；投递与消费有可追踪记录，客户端不直接返回验证码。 异常：所有无效验证码均拒绝且不建立会话；达到限额后提示稍后重试；真实短信或邮件未就绪记阻塞。 | [TC-COMPOSITOR-COMMON-002-P / TC-COMPOSITOR-COMMON-002-N](../test/TC-opc-common-20261017.md) |
| REQ-COMPOSITOR-COMMON-003 | 平台管理权限隔离 | 平台 admin 是内部后台账户，不开放注册、不接受用户侧第三方登录；业务组织成员仍属于 user 域。 | 管理员只凭内部管理身份访问管理功能；用户只访问授权的业务数据。 异常：不创建平台管理员；拒绝用户令牌越权；不得仅靠隐藏页面控制权限。 | [TC-COMPOSITOR-COMMON-003-P / TC-COMPOSITOR-COMMON-003-N](../test/TC-opc-common-20261017.md) |
| REQ-COMPOSITOR-COMMON-004 | 第三方授权独立会话 | 应用接受所在区域 Chat 作为第三方身份提供方，授权后签发应用自己的用户会话；不以共享全线会话替代授权。 | 每个应用均有自己的授权记录和会话；本应用获得的用户身份与授权一致，不获得平台管理权限。 异常：取消或无效回调不建立会话；授权码不重复消费；已撤销授权不可继续调用，未授权应用不可借用会话。 | [TC-COMPOSITOR-COMMON-004-P / TC-COMPOSITOR-COMMON-004-N](../test/TC-opc-common-20261017.md) |
| REQ-COMPOSITOR-COMMON-005 | 数据归属与失效会话 | 用户数据按所有者或业务组织权限隔离，注销或失效会话不可继续操作。 | 持久化数据与授权范围一致；重新登录可以恢复自己的记录。 异常：所有越权读写被拒绝，不泄露记录内容；失效会话要求重新登录；无权修改不产生业务变更。 | [TC-COMPOSITOR-COMMON-005-P / TC-COMPOSITOR-COMMON-005-N](../test/TC-opc-common-20261017.md) |
| REQ-COMPOSITOR-COMMON-006 | 微信区域登录 | 本产品用户端支持微信第三方登录；回调校验、取消、绑定及账号隔离遵循现有授权契约。 | 登录到相同的已绑定业务用户；应用会话独立，授权不产生平台admin身份。 异常：取消与无效回调不建立会话；不同身份不误合并；缺真实渠道配置则记阻塞。 | [TC-COMPOSITOR-COMMON-006-P / TC-COMPOSITOR-COMMON-006-N](../test/TC-opc-common-20261017.md) |
| REQ-COMPOSITOR-COMMON-007 | 抖音区域登录 | 本产品用户端支持抖音第三方登录；回调校验、取消、绑定及账号隔离遵循现有授权契约。 | 登录到相同的已绑定业务用户；应用会话独立，授权不产生平台admin身份。 异常：取消与无效回调不建立会话；不同身份不误合并；缺真实渠道配置则记阻塞。 | [TC-COMPOSITOR-COMMON-007-P / TC-COMPOSITOR-COMMON-007-N](../test/TC-opc-common-20261017.md) |
| REQ-COMPOSITOR-COMMON-008 | 百度区域登录 | 本产品用户端支持百度第三方登录；回调校验、取消、绑定及账号隔离遵循现有授权契约。 | 登录到相同的已绑定业务用户；应用会话独立，授权不产生平台admin身份。 异常：取消与无效回调不建立会话；不同身份不误合并；缺真实渠道配置则记阻塞。 | [TC-COMPOSITOR-COMMON-008-P / TC-COMPOSITOR-COMMON-008-N](../test/TC-opc-common-20261017.md) |
| REQ-COMPOSITOR-COMMON-009 | 支付宝区域登录 | 本产品用户端支持支付宝第三方登录；回调校验、取消、绑定及账号隔离遵循现有授权契约。 | 登录到相同的已绑定业务用户；应用会话独立，授权不产生平台admin身份。 异常：取消与无效回调不建立会话；不同身份不误合并；缺真实渠道配置则记阻塞。 | [TC-COMPOSITOR-COMMON-009-P / TC-COMPOSITOR-COMMON-009-N](../test/TC-opc-common-20261017.md) |
| REQ-COMPOSITOR-COMMON-010 | 同区模型原生能力 | 境内应用仅通过 Tokenhub CN、境外仅通过 Tokenhub Global 调用模型；Short/Long 固定 CN，不因故障跨区回退。 | 结果与实际模型响应一致；请求只经过当前区域中枢，记录真实用量和任务标识。 异常：明确返回不可用或失败；不静默跨区、不返回演示内容冒充真实生成、不重复执行同一任务。 | [TC-COMPOSITOR-COMMON-010-P / TC-COMPOSITOR-COMMON-010-N](../test/TC-opc-common-20261017.md) |
| REQ-COMPOSITOR-COMMON-011 | 无感选模与倍率 | 普通应用只向用户展示模型名称、能力、可用性和0.5倍/1倍/1.5倍额度倍率，不要求用户理解或另行配置 Tokenhub。 | 三种倍率在提交前可见并与目录一致；普通业务流程无需单独开通中枢或填写厂商 Key。 异常：提交前重新校验或明确提示变化；不按隐藏新倍率扣费，不展示可选但无法识别的模型。 | [TC-COMPOSITOR-COMMON-011-P / TC-COMPOSITOR-COMMON-011-N](../test/TC-opc-common-20261017.md) |
| REQ-COMPOSITOR-COMMON-012 | 额度与用量可追溯 | BGSSAI额度套餐须展示余额和消耗规则；厂商账户余额与用户额度分开；具体计量、舍入、失败退款和跨应用钱包规则沿用已确认规则，未定义项不能默认补造。 | 在该测试规则下额度消耗分别为50、100、150；流水包含任务、模型、倍率和规则版本；实际生产计量必须有已确认口径。 异常：不重复扣减、不出现无来源流水；余额不足有清晰拒绝；按明确规则结算失败任务；缺失规则的场景记阻塞，不自行认定免费或扣费。 | [TC-COMPOSITOR-COMMON-012-P / TC-COMPOSITOR-COMMON-012-N](../test/TC-opc-common-20261017.md) |
| REQ-COMPOSITOR-COMMON-013 | 语言与真实状态 | 用户端支持中英文，境内默认中文、境外默认英文；切换后主要业务、错误和法律入口保持一致，规划能力与已可用能力分开显示。 | 默认语言符合区域；切换后持久化；核心流程和错误可理解；法律文本可打开，未上线能力不显示已完成。 异常：显示失败、空状态或未发布说明，不用样例掩盖；公共法律入口不要求登录。 | [TC-COMPOSITOR-COMMON-013-P / TC-COMPOSITOR-COMMON-013-N](../test/TC-opc-common-20261017.md) |
| REQ-COMPOSITOR-COMMON-014 | Bot下载与安装信息 | 所有应用提供 Bot 下载入口，平台、架构、版本和安装包状态真实可见；Bot制品不能冒充本应用制品。 | 下载得到对应系统真实安装包且能启动；未发布版本明确标注；应用安装包和 Bot 安装包分别标识。 异常：不返回伪成功或错误平台包；显示不可用及实际限制；下载入口不泄露内部存储凭据。 | [TC-COMPOSITOR-COMMON-014-P / TC-COMPOSITOR-COMMON-014-N](../test/TC-opc-common-20261017.md) |
| REQ-COMPOSITOR-COMMON-015 | Bot最小授权托管 | 产品开放可被 Bot 调用的业务能力；用户明确授权后执行自己的业务任务，并可撤销。Support采用独立内部权限。 | 实际业务变化与指令一致，结果属于甲；记录授权范围、调用任务和结果；不凭文本回答认定已操作。 异常：越权与已撤销调用被拒绝；相同任务不重复产生业务副作用；内部权限不由用户授权提升。 | [TC-COMPOSITOR-COMMON-015-P / TC-COMPOSITOR-COMMON-015-N](../test/TC-opc-common-20261017.md) |
| REQ-COMPOSITOR-PLATFORM-001 | Windows核心交付 | 本产品在Windows提供独立可安装用户端；核心流程与服务端权限一致，移动端沿用原生界面要求。 | 制品可安装启动，名称与平台正确；不能用Bot安装包或仅有打包工程替代；业务结果持久化且与其他已授权端一致；保留实际设备和制品证据。 异常：网络和会话错误可恢复，无重复业务副作用；升级不丢已保存数据；缺真实设备/制品时记阻塞，不能标通过。 | [TC-COMPOSITOR-PLATFORM-001-P / TC-COMPOSITOR-PLATFORM-001-N](../test/TC-opc-platform-20261017.md) |
| REQ-COMPOSITOR-PLATFORM-002 | macOS核心交付 | 本产品在macOS提供独立可安装用户端；核心流程与服务端权限一致，移动端沿用原生界面要求。 | 制品可安装启动，名称与平台正确；不能用Bot安装包或仅有打包工程替代；业务结果持久化且与其他已授权端一致；保留实际设备和制品证据。 异常：网络和会话错误可恢复，无重复业务副作用；升级不丢已保存数据；缺真实设备/制品时记阻塞，不能标通过。 | [TC-COMPOSITOR-PLATFORM-002-P / TC-COMPOSITOR-PLATFORM-002-N](../test/TC-opc-platform-20261017.md) |
| REQ-COMPOSITOR-PLATFORM-003 | Linux核心交付 | 本产品在Linux提供独立可安装用户端；核心流程与服务端权限一致，移动端沿用原生界面要求。 | 制品可安装启动，名称与平台正确；不能用Bot安装包或仅有打包工程替代；业务结果持久化且与其他已授权端一致；保留实际设备和制品证据。 异常：网络和会话错误可恢复，无重复业务副作用；升级不丢已保存数据；缺真实设备/制品时记阻塞，不能标通过。 | [TC-COMPOSITOR-PLATFORM-003-P / TC-COMPOSITOR-PLATFORM-003-N](../test/TC-opc-platform-20261017.md) |
| REQ-COMPOSITOR-PLATFORM-004 | iOS核心交付 | 本产品在iOS提供独立可安装用户端；核心流程与服务端权限一致，移动端沿用原生界面要求。 | 制品可安装启动，名称与平台正确；不能用Bot安装包或仅有打包工程替代；业务结果持久化且与其他已授权端一致；保留实际设备和制品证据。 异常：网络和会话错误可恢复，无重复业务副作用；升级不丢已保存数据；缺真实设备/制品时记阻塞，不能标通过。 | [TC-COMPOSITOR-PLATFORM-004-P / TC-COMPOSITOR-PLATFORM-004-N](../test/TC-opc-platform-20261017.md) |
| REQ-COMPOSITOR-PLATFORM-005 | Android核心交付 | 本产品在Android提供独立可安装用户端；核心流程与服务端权限一致，移动端沿用原生界面要求。 | 制品可安装启动，名称与平台正确；不能用Bot安装包或仅有打包工程替代；业务结果持久化且与其他已授权端一致；保留实际设备和制品证据。 异常：网络和会话错误可恢复，无重复业务副作用；升级不丢已保存数据；缺真实设备/制品时记阻塞，不能标通过。 | [TC-COMPOSITOR-PLATFORM-005-P / TC-COMPOSITOR-PLATFORM-005-N](../test/TC-opc-platform-20261017.md) |
| REQ-COMPOSITOR-REGRESSION-001 | 用量回执持久化 | 模型目录展示当前价格与倍率，任务回执持久记录所用规则版本、实际用量和状态；刷新或重连后可对账。 | 回执仍存在，模型、用量与扣减可对应；空缓存不丢历史任务。 异常：不重复执行或扣减；错误不生成虚假成功回执；历史仍按执行时价格版本解释。 | [TC-COMPOSITOR-REGRESSION-001-P / TC-COMPOSITOR-REGRESSION-001-N](../test/TC-feature-gaps-20261017.md) |
| REQ-COMPOSITOR-REGRESSION-002 | 恢复快照与资源边界 | 完整编辑后约1.5秒写两代恢复，连续编辑约10秒检查；启动恢复判定前禁用新建；保留8192单边、1677万画布像素、40层、4800万图层像素、128MB限制。 | 恢复为无旧路径的未保存文档；上一代可恢复；正式保存成功清理恢复；不写半笔划。 异常：入口禁用或明确校验；旧恢复保留；拒绝超限前不破坏当前项目，内存预算不冒充RSS保证。 | [TC-COMPOSITOR-REGRESSION-002-P / TC-COMPOSITOR-REGRESSION-002-N](../test/TC-feature-gaps-20261017.md) |
| REQ-COMPOSITOR-REGRESSION-003 | 签名更新与回滚 | 更新清单绑定版本平台架构散列及源码，拒绝未知签名/过期/降级；失败保留现有应用与可信回滚包。 | 校验后显式升级；失败能回滚并重开原项目；portable及其他平台按各自手动/系统更新流程。 异常：拒绝不可信更新，保留旧版本；回滚失败单独报告，未签构建不当正式发布。 | [TC-COMPOSITOR-REGRESSION-003-P / TC-COMPOSITOR-REGRESSION-003-N](../test/TC-feature-gaps-20261017.md) |
| REQ-COMPOSITOR-REGRESSION-004 | 离线与未实现登录真实性 | 离线本地编辑无需登录；现阶段未实现验证码/国内OAuth须503且禁用入口，规划五种登录不代表适配器已实现。 | 离线编辑可用，现有可用身份独立；sync/ai/bot初始关闭。 异常：返回不可用且无code/challenge/token/session，不建立虚假身份；后续实现前此处为现状回归。 | [TC-COMPOSITOR-REGRESSION-004-P / TC-COMPOSITOR-REGRESSION-004-N](../test/TC-feature-gaps-20261017.md) |
| REQ-COMPOSITOR-REGRESSION-005 | 独立授权与破坏性编辑 | sync/ai/bot各自授权，Bot需sync和bot同时开启；破坏性修改先预览，确认校验用户和基准etag，可撤销。 | 预览不改正式项目；确认保存快照；undo恢复；撤权后令牌失效。 异常：拒绝越权/冲突/任意URL；关sync按契约删除云项目并使Bot失效；不跨区模型回退。 | [TC-COMPOSITOR-REGRESSION-005-P / TC-COMPOSITOR-REGRESSION-005-N](../test/TC-feature-gaps-20261017.md) |

## 规则边界与依赖

- 正常、失败、边界、权限和重复执行分别验证；历史用例和历史执行结果保留。新增用例统一待测。
- 所有应用最终覆盖Windows、macOS、Linux、iOS、Android，Support除外；共享/管理仓不计为应用。Media由PC承担桌面三端、Android/iOS各自承担移动端，Web提供浏览器平台，不重复要求每个Media仓另造五端。Web/桌面/CLI是Build的产品形态，不能替代操作系统交付矩阵。
- 主流模型、Office版本、招聘平台API等开放集合，须维护逐项能力、限制、样例和实测证据；缺凭据、设备、接口或样本记阻塞，不能以有限样例宣称全部支持。
- 模型实际路由严格同区，故障不跨区回退。普通应用不要求用户配置中枢；Tokenhub本身和Developer门户可展示API管理概念。
- 倍率目标为0.5/1/1.5。已确认的本仓计量与价格规则继续有效；未确认的基础单位、舍入、退款和跨应用钱包不得由测试推定。100基础用量仅为可复现测试夹具，不是生产定价。
- 用户授权只作用于user；admin不注册、不接用户第三方授权。Support内部自动化不能借用user授权。
- dev/prod均部署develop，分别使用application-dev.properties/application-prod.properties。本次不触发部署、真实支付、真实邮件或外部投稿。

## 存量需求与追溯

[需求文件覆盖索引](../test/REQUIREMENT-COVERAGE.md)列出原有需求、历史套件及本轮补充入口；[本轮逐需求矩阵](../test/TRACEABILITY-20261017.md)列出本文件所有验收项与正/负用例。覆盖索引属于测试设计导航，不是运行通过证明。
