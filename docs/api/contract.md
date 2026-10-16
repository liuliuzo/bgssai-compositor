# Compositor 在线服务与 MCP 契约 (OPS-COMP-01 / OPS-COMP-02)

统一 JSON，字段 `snake_case`。所有异常响应携带可读中文 `error` 与 `request_id`，脱敏内部中枢地址与密钥。离线本地画布编辑无需登录即可完整使用。

## 1. 认证与会话

| 方法 / 路径 | 说明 |
| --- | --- |
| `POST /api/auth/register` | 本地账号注册（`username`/`email`/`phone` + `password`），签发独立会话 |
| `POST /api/auth/login` | 本地账号密码登录 |
| `POST /api/auth/code/send` | 发送手机/邮箱一次性验证码，返回 `challenge_id` |
| `POST /api/auth/code/login` | 核验 `challenge_id` 与 `code`，单次消费并签发独立会话 |
| `GET/POST /api/auth/oauth/:provider/authorize` | 发起 `wechat` / `alipay` / `douyin` / `baidu` 第三方 OAuth 授权 |
| `GET/POST /api/auth/oauth/:provider/callback` | 消费第三方 OAuth 回调并建立按 `provider:sub` 隔离的会话 |
| `POST /api/auth/begin` / `GET /oauth/callback` / `POST /api/auth/poll` | Chat OIDC + S256 PKCE 授权登录 |
| `DELETE /api/session` / `POST /api/auth/logout` / `POST /api/auth/revoke` | 撤销当前会话及其关联的 Bot/PAT 令牌 |

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
