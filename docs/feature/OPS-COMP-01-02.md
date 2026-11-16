# OPS-COMP-01 与 OPS-COMP-02 特性规格说明

## 1. 全矩阵用户认证、模型目录选择与受控区域路由 (OPS-COMP-01)

### 1.1 离线优先与认证通道可用状态
- **离线本地编辑**：不强制登录，未配置在线服务或未登录状态下，画布新建、图层编辑、滤镜调整、自动恢复与项目导入导出保持完整可用。
- **本地账号密码注册与登录**：
  - `POST /api/auth/register`：支持用户名/邮箱/手机号与密码注册，服务端使用随机盐与密码哈希持久化凭证，不存储明文密码。重复账号返回 409；服务重启后注册唯一性与原密码验证仍有效。
  - `POST /api/auth/login` / `POST /api/auth/login/password`：校验账号密码并签发独立会话令牌；错误密码返回 401。
  - 新会话的 `sync`、`ai`、`bot` 默认均关闭，在线能力必须经用户逐项授权，项目和计费回执按账号隔离。
- **手机 / 邮箱验证码登录（真实 SMTP + 腾讯云 SMS 国内/国际分通道）**：
  - 6 位数字验证码使用 `crypto.randomInt(100000, 1000000)`，同一通道与目标地址发送冷却 60 秒（`429` `OTP_RESEND_TOO_SOON`），失败投递回滚挑战且不锁冷却；单挑战最多 5 次校验。
  - `POST /api/auth/code/send` 响应仅返回 `challenge_id`、`channel`、`route`、`target_masked`、`cooldown_seconds`、`expires_at`，**永不返回 `code`、`verification_code` 或 `seq`**。
  - 手机号归一化严格区分国内（`+861[3-9]\d{9}`）与国际非 `+86` E.164（`+[1-9]\d{4,14}`，禁止剥离国际国家码）；前端手机号输入默认 `+86` 并提供可搜索国际区号选择器。
  - 腾讯云 SMS `SendSms` (`2021-01-11`, `TC3-HMAC-SHA256`) 按 `+86` 与非 `+86` 自动路由至独立国内/国际配置，**国内与国际通道互不回退**；任一通道未启用或缺少 `AppId`/`TemplateId`/`SecretId`/`SecretKey` 时对对应路由 fail-closed 返回 `503`。
  - 国内通道必须填写 `sign_name`，国际通道 `intl_sign_name` 可选；默认 `endpoint='sms.tencentcloudapi.com'`、`region='ap-guangzhou'`，`sms.tencentcloudapi.com` 拒绝 `ap-singapore`（需 `sms.intl.tencentcloudapi.com`）。
  - `TemplateParamSet` 严格按 `template_param_count` / `intl_template_param_count` in `{2, 3, 4}` 构造：`2` 为 `[code, minStr]`，`3` 为 `[productLabel, code, minStr]`，`4` 为 `[productLabel, seq, code, minStr]`（`seq` 为 `crypto.randomInt(1000, 10000)` 4 位数字）。
  - SMTP 邮件投递使用 `nodemailer` 真实发信；未配置或凭据失效时返回 `503`/`502`，响应与日志脱敏，不泄露密码或密钥。
- **Chat PKCE 与国内四渠道 OAuth（`wechat` / `douyin` / `baidu` / `alipay`）**：
  - 支持 BGSSAI Chat OIDC + S256 PKCE（默认 `https://chat.bgssai.cn`，`POST /api/auth/begin`、`GET /oauth/callback`、`POST /api/auth/poll`、`POST /api/auth/cancel`）。
  - 接入国内四渠道真实 OAuth（`wechat`、`douyin`、`baidu`、`alipay` 含 RSA2 签名与 `auth_code` 交换），禁止海外登录通道（`google`、`github`、`gitlab` 等）及 `weibo`。
  - 渠道配置缺失时对应 `authorize` / `callback` 入口 fail-closed 返回 `503`；伪造 `openid`/`sub`/`user_id`/`code`/`state` 或重放 `state` 均拒绝。
  - `GET /api/auth/channels` 动态返回可用通道、`unavailable` 列表及 `otp_capabilities`（`email`、`phone_domestic`、`phone_international`）；界面仅展示可用 OAuth 快捷图标按钮，禁用未配置通道并提示暂未启用。
  - 管理端配置接口（`/api/admin/config/{channels,sms,smtp,oauth}`）读取时将密钥脱敏为 `******`，保存时传入空值或 `******` 保留原密钥。
  - 有效登录建立 Compositor 独立会话；`DELETE /api/session` 撤销当前会话、下属 Bot/PAT 令牌及关联的 Chat 授权。

### 1.2 受控 AI 模型目录与区域路由
- **模型目录接口 (`GET /api/ai/models`)**：
  - 返回当前用户可用的受控模型列表（含 `model_id`、`display_name`、`provider`、`region`、`capabilities`、`max_tokens`、`is_default`）及 `default_model`。
- **用户模型选择与区域受控路由 (`POST /api/ai/text`)**：
  - 接收用户选择的 `model`（或 `model_id`）及 `prompt`。
  - 严格校验所选模型是否存在于受控模型目录中，并按产品标识（`product_code=compositor`）与模型所属区域（`cn` / `global`）匹配服务端白名单路由节点。
  - 严禁客户端传入未授权的任意第三方或外部 URL（`hub_origin` / `target_hub_origin` 不在受控白名单时立即拒绝并返回 403）。
- **错误脱敏与可观测追踪**：
  - 移除所有原始内部网关名称（如 `TokenHub`）及密钥细节，所有网关未配置、超时或上游异常均转化为清晰的中文用户提示，并附带唯一可追踪的 `request_id`。

## 2. 统一客服桥接与扩展 Bot / MCP 全量编辑工具 (OPS-COMP-02)

### 2.1 统一客服桥接 (`product_code=compositor`)
- **工单创建与会话列表 (`GET /api/support/tickets`、`POST /api/support/tickets`)**：
  - 用户在 Compositor 内直接发起客服咨询，固定携带 `product_code=compositor`。
  - 服务端按用户身份（`auth_channel + sub`）严格隔离工单列表与详情，任何跨用户访问均返回 404/403。
- **消息追加与外发桥接投递 (`POST /api/support/tickets/:ticketId/messages`)**：
  - 用户在既有工单下发送消息，服务端同步向已配置的统一客服桥接网关投递结构化事件（`ticket_created` / `user_message`，含 `product_code=compositor`）。
- **入站客服回调与幂等去重 (`POST /api/support/webhook`)**：
  - 接收客服坐席回复与工单状态变更（`open` / `in_progress` / `resolved` / `closed`）。
  - 强制校验 `product_code=compositor` 与回调密钥（如配置），并基于 `event_id` 执行严格幂等重放去重：相同 `event_id` 重复投递时返回 `deduplicated: true`，不产生重复客服消息或重复状态变更。

### 2.2 扩展 Bot / MCP 全量项目与图层编辑能力
- **令牌与权限隔离**：
  - 支持一小时临时 Bot 令牌（`POST /api/bot/token`）与个人访问令牌 PAT（`POST /api/pat`、`DELETE /api/pat/:patId`）。
  - 所有操作强制要求用户同时开启 `sync` 与 `bot` 授权，且仅能操作当前授权用户归属的云端项目。
- **工具清单与调用入口 (`GET /api/mcp/tools`、`POST /api/mcp/call`、`POST /api/bot/operate`)**：
  - **新建项目 (`create_project`)**：按指定名称、宽高与背景创建合规 `.bgcomp` v1 项目。
  - **资产导入与导出 (`import_asset`、`export_asset`)**：支持 `.bgcomp`、`png`、`jpeg` 格式的导入与导出。
  - **图层增改 (`add_text_layer`、`add_shape_layer`、`add_image_layer`、`update_layer`)**：支持新增或修改文字图层、矩形/椭圆形状图层、PNG 图像图层。
  - **画布、变换与滤镜调整 (`adjust_canvas`、`transform_layer`、`adjust_filter`)**：支持画布尺寸调整、图层位移/缩放/旋转/翻转，以及亮度/对比度/饱和度/模糊参数修改。
  - **破坏性操作预览、确认应用与撤销回滚 (`preview_destructive_edit`、`confirm_destructive_edit`、`undo` / `rollback`)**：
    - 对裁切画布、合并图层、删除图层、栅格化文字等破坏性编辑先生成 `preview_id` 与差异摘要，不直接覆盖正式项目。
    - 确认应用时校验 `preview_id` 归属与基准 `etag`，将变更前快照压入用户专属历史栈后原子写入。
    - 支持随时调用 `undo` / `rollback` 恢复到历史快照版本。

安全边界：客服回调未配置签名密钥时返回 503，无默认密钥；破坏性编辑必须对应当前用户的有效预览，旧版本预览与重复确认均拒绝，rename/layer 保留 If-Match 校验。
