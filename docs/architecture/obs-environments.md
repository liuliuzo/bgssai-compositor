# Compositor 离线编辑器 OBS 环境分配

本次为基础设施配置登记（2026-10-26），不改变产品文件存储行为。dev 和 prod 的交付源码均为 `develop`；分环境资源和密钥独立，使用本产品专用 IAM 身份；该身份当前同时有本产品两套桶权限，因此密钥分发不等于 IAM 层面的 dev/prod 隔离。

| 环境 | OBS 桶 | 地域 | Endpoint |
| --- | --- | --- | --- |
| dev | `dev-bgssai-compositor` | `cn-east-3` | `https://obs.cn-east-3.myhuaweicloud.com` |
| prod | `prod-bgssai-compositor` | `cn-east-3` | `https://obs.cn-east-3.myhuaweicloud.com` |

## 当前边界

编辑工程、恢复文件与导出仍保留在用户本地；当前没有云端上传后端。

这些桶预留给受控服务端安装包发布或备份任务。config/application-*.properties 会进入客户端分发包，禁止写入 AK/SK；也不能直接把私有 OBS 桶当公开下载站。发布下载须由服务端授权签名或既有下载服务提供。

桶已分配不代表业务上传、备份或下载已启用。本次没有迁移历史文件、没有发布客户端，也没有执行线上应用的 OBS 读写验收。

## 服务端配置交接

受控服务端任务按环境取得本产品专用身份的一把独立密钥；该身份权限覆盖本产品 dev/prod 两桶，不能据此声称两环境 IAM 隔离。凭据仅保存在受控运行环境中。配置交接字段为 `OBS_ENDPOINT`、`OBS_REGION`、`OBS_BUCKET`、`OBS_KEY_PREFIX`（`compositor/`）、`OBS_ACCESS_KEY_ID`、`OBS_SECRET_ACCESS_KEY`，后两项不进入 Git。这组名称是发布/备份任务的交接字段，当前客户端或发布脚本尚未消费，不能仅凭环境变量存在宣称已接入。

IAM 身份权限只覆盖本产品的 dev/prod 两个桶，不授予账户管理或其他产品资源权限。环境选择通过对应 profile 固定桶名，防止误配。保持私有桶，发布任务按实际用途获取对象操作权限；禁止为了下载方便把整个桶改成公共读写。

后续接入真实消费者时，须通过 Jenkins 使用对应环境配置，验证本产品桶读写、跨产品访问拒绝、环境配置不混用、凭据不进入分发包，并分别记录“配置已登记”“部署已完成”“业务验收通过”。

## 运维消费者配置

`deploy/obs/application-dev.properties` 与 `deploy/obs/application-prod.properties` 是服务器运维配置，供中央 `bgssai-workflows/deploy/obs/verify.py` 读取并用私有凭据验证桶读写。配置中只包含产品、环境、桶、地域、Endpoint 与业务接入状态；验证器用这些字段核对所选环境，不把“桶读写成功”写成“业务已迁移”。

这两份运维文件不进入客户端打包清单。已检查根 package.json 的 Electron files：只收集 dist、electron、config 和 package.json，不收集 deploy/obs。它们不包含凭据，也不让客户端直接连接 OBS。后续修改打包规则时继续保留这一边界。
