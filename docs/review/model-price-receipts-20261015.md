# 模型价格与实际回执验证

实现覆盖实际 service/server.mjs 的 /api/ai/text、固定 hub.model 的模型目录透传，以及共享 Connections UI 的桌面/浏览器/移动调用路由。

- npm test：18/18 通过。
- npm run build：TypeScript 与 Vite 通过。
- 最后全局 request_id claim 加固后，usage + ecosystem 5/5 通过：并发排他、跨账户同 ID、真实 HTTP 登录用户隔离、固定模型目录/单价、POST 前落盘、同凭据重启 GET、换密钥/换端点不查询、404/错误 ID 保持 pending、额度现金两阶段、迟到 pending 不覆盖终态。
- git diff --check 通过。无 SQL：该产品服务原本使用文件持久存储，新增同目录 usage 文件，不涉及数据库 schema。

需部署时保留 COMPOSITOR_DATA_DIRECTORY 并使用支持原子硬链接的文件系统；不支持时在发起计费请求前失败。服务现有会话仍在进程内，重启重新登录；账本恢复不依赖登录，且不重放生成。真实线上 Hub/付费调用、桌面及移动真机未执行，未部署、未合并。
