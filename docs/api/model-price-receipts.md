# 模型与回执契约

- `GET /api/ai/models`：登录且 AI 授权；`data` 仅含服务固定 `hub.model`，透传实际 `/v1/models` 目录白名单字段，未知字段 null。
- `POST /api/ai/text`：`prompt` 与可选 UUID `request_id`；返回 `text`、`billing`。响应 `X-Request-Id` 与 Hub 请求相同。复用 ID 返回 409，生成不会重放。
- `GET /api/ai/usage`：登录用户自己的最近 100 条 `{data:[billing]}`，撤销 AI 后仍可查看既有计费记录。
- `billing`：hub/request_id/model/raw_tokens/billed_tokens/billing_multiplier/billing_unit/price_version/currency/billing_status/debit_fen/reconciled。字段未知 null；只有 cash 状态 settled/unpaid/unpriced/reversed 且 billed_tokens 非负整数才 reconciled=true。

服务文件目录 `usage/<issuer+sub hash>/`；请求记录排他创建并 fsync 后才 POST。只保存请求内容指纹，不保存提示词、密钥或回答。最终完整回执以排他不可变文件发布，读取优先于 pending 快照；多进程晚到 pending 不能覆盖最终结果。恢复启动即执行并每分钟扫描，原 endpoint 和 key 指纹匹配才 GET，pending 一分钟/失败五分钟退避，无生成重放。该机制不改变现有单进程登录会话限制，需持久共享服务数据目录。

跨账户共享 claims 排他标识阻止同 Hub key 下的 request_id 碰撞，未完成写入的 claim 保持拒绝重放。
