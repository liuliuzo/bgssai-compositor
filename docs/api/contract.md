# Compositor 在线服务与 MCP 契约 (OPS-COMP-01 / OPS-COMP-02)

统一 JSON，字段 `snake_case`。所有异常响应携带可读中文 `error` 与 `request_id`，脱敏内部中枢地址与密钥。离线本地画布编辑无需登录即可完整使用。

## 1. 认证与会话

| 方法 / 路径 | 说明 |
| --- | --- |
| `GET /api/auth/channels` | `channels` 仅列出 `local`、`chat`；`unavailable` 中的 `{channel, reason}` 条目列出 `verification_code`、`wechat`、`alipay`、`douyin`、`baidu` 及不可用原因 |
| `POST /api/auth/register` | 本地账号注册（`username`/`email`/`phone` + `password`），凭证以随机盐和密码哈希持久化；重复账号返回 409，包括服务重启后 |
| `POST /api/auth/login` / `POST /api/auth/login/password` | 本地账号密码登录；密码错误返回 401，不签发会话 |
| `POST /api/auth/code/send` | SMS/email 真实发送适配器尚未实现，固定返回 503，不生成或返回验证码与 challenge |
| `POST /api/auth/code/login` / `POST /api/auth/code/verify` | SMS/email 真实校验适配器尚未实现，固定返回 503，不接受自填验证码建立会话 |
| `GET/POST /api/auth/oauth/:provider/authorize` / `POST /api/auth/oauth/begin` | `wechat` / `alipay` / `douyin` / `baidu` 真实 OAuth 适配器尚未实现，固定返回 503，不生成授权地址或状态 |
| `GET/POST /api/auth/oauth/:provider/callback` / `POST /api/auth/oauth/callback` | 上述四渠道固定返回 503；客户端提交的 `openid`、`sub`、`code`、`state` 均不能作为身份依据 |
| `POST /api/auth/begin` / `GET /oauth/callback` / `POST /api/auth/poll` | Chat OIDC + S256 PKCE 授权登录 |
| `DELETE /api/session` / `POST /api/auth/logout` / `POST /api/auth/revoke` | 撤销当前会话及其关联的 Bot/PAT 令牌 |

未实现的认证入口及其别名都不返回 `code`、`verification_code`、`token` 或 `session`，界面中对应通道禁用。密码和真实 Chat PKCE 登录保持可用；`GET /oauth/callback` 仅用于真实 Chat 流程，不是国内第三方 OAuth 的替代入口。成功登录后的 `sync`、`ai`、`bot` 默认均为 `false`，用户须通过 `PUT /api/grants` 分别授权。账号凭证不得存储明文密码，项目与计费回执按用户隔离，重启不允许通过重新注册同名账号接管既有数据。

## 2. 受控 AI 模型目录与生成

| 方法 / 路径 | 说明 |
| --- | --- |
| `GET /api/ai/models` | 返回 `product_code=compositor`、`default_model` 与受控模型列表 |
| `POST /api/ai/text` | 接收 `prompt` 与可选 `model`；校验模型白名单与受控路由节点，附加 `X-Bgssai-Product: bgssai-compositor`、`X-Bgssai-Model`、`X-Bgssai-Region` |

## 3. 统一客服桥接 (`product_code=compositor`)

| 方法 / 路径 | 说明 |
| --- | --- |
| `GET /api/support/sessions` / `POST /api/support/sessions` | 查询或创建当前用户专属客服会话，入队外发桥接事件 |
| `GET /api/support/messages` / `POST /api/support/messages` | 查询或追加当前用户专属客服消息 |
| `GET /api/support/tickets` / `POST /api/support/tickets` | 查询或创建当前用户专属客服工单 |
| `POST /api/support-bridge/inbox` | 客服中枢回调：校验 HMAC-SHA256 签名、`product_code=compositor`，按 `event_id` 幂等去重 |

## 4. Bot 与 MCP 工具

- `GET /api/mcp/tools`：列出 `list_projects`、`create_project`、`get_project`、`import_asset`、`export_project`、`preview_destructive_edit`、`apply_destructive_edit`、`undo_last_edit`、`rename`、`layer`。
- `POST /api/mcp/call` / `POST /api/bot/operate`：按当前会话或 Bot/PAT 归属执行项目操作；破坏性编辑强制先生成 `preview_id` / `confirmation_token`，确认执行后写入可撤销历史栈。

安全边界：客服回调未配置签名密钥时返回 503，无默认密钥；破坏性编辑必须对应当前用户的有效预览，旧版本预览与重复确认均拒绝，rename/layer 保留 If-Match 校验。
