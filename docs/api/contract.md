# Compositor 在线服务与 MCP 契约 (OPS-COMP-01 / OPS-COMP-02)

统一 JSON，字段 `snake_case`。所有异常响应携带可读中文 `error` 与 `request_id`，脱敏内部中枢地址与密钥。离线本地画布编辑无需登录即可完整使用。用户界面不出现 TokenHub 字样。

## 1. 认证与会话

| 方法 / 路径 | 说明 |
| --- | --- |
| `GET /api/auth/channels` | 返回 `channels`（始终含 `local`、`chat`，按配置动态包含 `verification_code` 与已启用国内 OAuth）、`unavailable`（未启用渠道与原因）及 `otp_capabilities`（`email`、`phone_domestic`、`phone_international`） |
| `POST /api/auth/register` | 本地账号注册（`username`/`email`/`phone` + `password`），手机号按 `+86` / 非 `+86` E.164 归一化；重复账号返回 409 |
| `POST /api/auth/login` / `POST /api/auth/login/password` | 本地账号密码登录；已注销账号返回 403；密码错误返回 401 |
| `POST /api/auth/code/send` | 发送 6 位（`randomInt(100000, 1000000)`）验证码。支持 SMTP 邮件与腾讯云 SMS（国内 `+86` 与国际非 `+86` E.164 严格独立路由、互不回退，可传 `dial_code` + `national_number` 或 `target`）。60s 发送冷却（`429`）；未配置通道返回 503；响应永不回显验证码或 `seq` |
| `POST /api/auth/code/login` / `POST /api/auth/code/verify` | 校验验证码：单次使用、最多 5 次尝试、绑定 challenge/接收人/用途。`purpose=login` 签发本应用会话；`purpose=reauth`/`step_up` 需已登录并返回 `reauth_token` |
| `GET/POST /api/auth/oauth/:provider/*` | `wechat` / `alipay` / `douyin` / `baidu` / `chat`（`bgssai`）真实 OAuth 授权与回调；未配置渠道返回 503；海外或禁用渠道（`google`/`github`/`gitlab`/`weibo` 等）返回 400 |
| `POST /api/auth/begin` / `GET /oauth/callback` / `POST /api/auth/poll` | Chat OIDC + S256 PKCE（`https://chat.bgssai.cn`）；回调后签发**本应用独立会话**，并持久化授权记录；不以 Chat 令牌替代本应用会话 |
| `GET/PUT /api/admin/config/{channels,sms,smtp,oauth}` | 管理配置读取与保存（`X-Bgssai-Admin-Secret` 鉴权，密钥未配返回 503）；GET 将密钥脱敏为 `******`，PUT 传入空值或 `******` 时保留原密钥；`sms.tencentcloudapi.com` 拒绝 `ap-singapore` |
| `DELETE /api/session` / `POST /api/auth/logout` / `POST /api/auth/revoke` | 撤销当前会话及其关联的 Bot/PAT 令牌 |

成功登录后的 `sync`、`ai`、`bot` 默认均为 `false`。响应会话可含 `account_id`。

## 1b. 账号绑定、注销与额度

| 方法 / 路径 | 说明 |
| --- | --- |
| `GET /api/account/bindings` | 列出当前账号已绑定登录方式 |
| `POST /api/account/bindings` | 绑定；需有效 `reauth_token`；冲突 `(provider, provider_uid)` 返回 409 |
| `DELETE /api/account/bindings` | 解绑；需 `reauth_token`；最后一种方式返回 400 |
| `GET /api/account/deletion-notice` | 注销后果说明 |
| `POST /api/account/delete` | 自助注销：须确认后果并完成身份验证；未结订单/剩余额度按规则提示；注销后匿名化并吊销全部会话 |
| `GET /api/billing/packages` | 套餐目录；额度单位为真实 token |
| `GET /api/billing/balance` | 当前套餐、`remaining_tokens`（精确整数）、`expires_at` |
| `GET /api/billing/ledger` | 额度流水（精确整数） |
| `POST /api/billing/orders` | 创建订单；**前端跳转不算入账** |
| `POST /api/billing/payment/callback` | 支付成功回调入账；以 `out_trade_no` 幂等，重复回调只入账一次 |

界面展示额度时使用 K/M/B 紧凑写法（最多一位小数，如 `418.9M`），悬停显示精确值；接口与导出保持精确整数，不再使用“点”。

## 2. 受控 AI 模型目录与生成

| 方法 / 路径 | 说明 |
| --- | --- |
| `GET /api/ai/models` | 返回 `product_code=compositor`、`default_model` 与受控模型列表；同区路由（CN / Global） |
| `POST /api/ai/text` | 文字建议；校验模型白名单与受控路由 |
| `POST /api/ai/image-edit` | 图层/选区图像编辑：返回 `status=preview` 与 `preview_image`，**不自动应用**；客户端确认并校验 `document_revision` 后本地应用；附带用量回执 |
| `GET /api/ai/usage` | 用量回执列表 |

## 3. 统一客服桥接 (`product_code=compositor`)

| 方法 / 路径 | 说明 |
| --- | --- |
| `GET /api/support/sessions` / `POST /api/support/sessions` | 查询或创建当前用户专属客服会话 |
| `GET /api/support/messages` / `POST /api/support/messages` | 查询或追加客服消息 |
| `GET /api/support/tickets` / `POST /api/support/tickets` | 查询或创建客服工单 |
| `POST /api/support-bridge/inbox` | 客服中枢回调：HMAC 校验，按 `event_id` 幂等 |

## 4. Bot 与 MCP 工具

- `GET /api/mcp/tools`：列出项目与破坏性编辑工具。
- `POST /api/mcp/call` / `POST /api/bot/operate`：破坏性编辑强制预览确认。

## 5. 配置分层

- 中间件连接参数（服务端口、数据目录、中枢 URL 等）写在 `config/application-*.properties` / 环境变量，不进 Admin 库表。
- 业务第三方凭证（支付回调密钥、腾讯云国内/国际 SMS、SMTP、国内四渠道 OAuth 等）支持环境变量注入或经管理配置持久化保存；GET 读取返回 `******` 脱敏，PUT 提交空白或 `******` 保留原值；缺省时对应通道 fail-closed 返回 503。
