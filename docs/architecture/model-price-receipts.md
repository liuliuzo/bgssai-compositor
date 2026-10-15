# AI 回执持久化

`service/hub-receipts.mjs` 管理不可变请求记录及终态文件，pending 快照原子替换。`server.mjs` 在真实 POST 前记录、finally 补查，启动和定时任务只 GET。请求 ID 的排他文件创建同时作为幂等门，不能凭失败自动重新生成。配置更改保留未确认记录，恢复原凭据后可继续查询；绝不换密钥探测。

平台和 Electron IPC 仅增加 models/usage 两条允许路由。Connections 显示实际固定模型信息和个人回执；服务凭据始终不进入 UI。
