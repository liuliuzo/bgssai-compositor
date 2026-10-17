# Compositor 架构

## 桌面边界

Electron 主进程只打开随应用打包的 `compositor://app/index.html`。开发模式的 Vite 地址固定为 `http://127.0.0.1:5173`，打包后不接受开发地址。导航、弹窗和权限请求被关闭。

渲染器启用 sandbox 和 context isolation，禁用 Node integration。Preload 暴露具体的文件打开、项目保存、图像导出、剪贴板图像和菜单命令方法；不会暴露通用 IPC、文件系统或 shell。主进程核验每次 IPC 的窗口、主 frame 和来源。

文件路径由 Windows 文件对话框决定。新文档重置项目保存路径。项目打开先读取、验证并解码所有图层，再使用主进程签发的临时 token 采用新保存路径。打开失败不会替换当前文档或其保存位置。写文件先写同目录临时文件，再重命名替换，减少中断写入留下半个项目的风险。

## 编辑和历史

每个像素图层有独立 Canvas，保存未变换的原始像素及变换参数；文本图层额外保留内容和样式。显示和导出使用同一合成逻辑，从数组底部向顶部应用图层显隐、透明度、混合模式、滤镜和矩阵。

画笔和选区使用逆矩阵从文档坐标转换到图层坐标，因此旋转、缩放或翻转图层后仍能绘画。每次手势结束后记录一个快照，拖动中的连续帧不会生成独立的撤销步骤。历史保留 30 步和约 96 MB 的序列化字符串预算；新编辑截断重做分支。

异步文件操作和历史解码期间阻止新编辑。快照全部解码成功后才替换当前状态。未保存状态通过当前快照与上次成功保存的快照比较；取消文件对话框不会标记已保存。关闭、创建文档或打开另一文档时可以选择保存、不保存或取消。

## `.bgcomp` v1

UTF-8 JSON，顶层为：

```json
{
  "format": "bgssai-compositor",
  "version": 1,
  "name": "文档名称",
  "width": 1600,
  "height": 1000,
  "layers": []
}
```

`layers` 必须包含 1–40 个图层，从底层到顶层排序。每层保存独立 ID、名称、`visible`、`locked`、`opacity`、`blend`、位置、缩放、旋转、翻转、亮度/对比度/饱和度/模糊，以及 `data:image/png;base64,...` 图像。文字图层还保存 `text`（value、font、size、color、bold）。

格式解析器只保留已知字段，拒绝未知版本、重复 ID、无效数值、不支持的混合模式和非 PNG 图像。PNG 的 IHDR 在解码前检查尺寸并累计像素预算。格式版本必须匹配；不能把 Photoshop PSD 直接改后缀当作项目文件。

## 构建和后续扩展

Windows 构建生成 NSIS 和 portable，macOS 生成 DMG / ZIP，Linux 生成 AppImage / DEB。手机共享同一渲染器和 bgcomp v1，通过 Capacitor 的离线资源、Filesystem / Share 输出。移动端使用响应式画布与可滚动属性面板。没有 Canvas filter 的环境通过软件颜色调整及三次盒式近似高斯模糊保持调整可编辑；模糊像素不承诺与 Chromium 完全相等。

自动恢复在桌面使用带 SHA256 的两代原子快照，手机使用 IndexedDB 事务。自动保存只读取完整历史提交，不为选区、缩放或未结束笔划重复序列化。预算包含当前和待采用项目、Canvas 工作面、历史和字符串副本，在图像解码和主要 Canvas 分配前检查。

恢复初始化与首屏渲染异步进行。文档入口的 disabled 状态必须跟随 recoveryReady / recoveryOffer，和 action 的执行条件一致；读取中用 aria-busy 暴露等待状态。测试通过阻塞真实 Electron recovery:read IPC 并手动释放验证这段窗口，不依赖固定 sleep 或增加重试掩盖竞态。

可选服务由 Chat 授权码 + S256 PKCE 验证 sub 后建立独立 Compositor 会话。会话和 Bot 令牌只在服务内存中保留，客户端会话也不持久化；同步项目用 issuer/sub 哈希隔离，If-Match 阻止并发覆盖。同步、Bot、AI 默认关闭；撤销同步清除云端项目，AI 仅使用服务端配置的 TokenHub。服务重启需要重新授权，暂不支持多节点会话共享。

可选在线服务在保持离线免登录编辑完整可用的前提下，支持持久化带盐密码哈希的本地账号注册/登录及 Chat 授权码 + S256 PKCE 登录；手机/邮箱验证码与国内四渠道 OAuth 尚未接入真实发送/身份校验适配器，所有发送、核验、授权与回调入口均返回 503，不生成验证码、授权地址或会话。有效通道建立按 `auth_channel + sub` 隔离的可撤销独立会话。AI 服务暴露受控模型目录（`GET /api/ai/models`），按用户所选模型与产品分区（`X-Bgssai-Product: bgssai-compositor`、`X-Bgssai-Model`、`X-Bgssai-Region`）路由至服务端受控白名单节点，并对用户侧错误统一脱敏。客服桥接（`product_code=compositor`）支持会话、消息、工单及 `/api/support-bridge/inbox` HMAC 验签与 `event_id` 幂等回调。Bot / MCP 扩展提供项目列表、新建、读取、导入导出、破坏性编辑预览与确认执行及撤销回滚。

PR / develop 构建只上传 artifact。手工签名发布只接受 develop 上的 tag，使用受控环境凭据创建 draft Release。Ed25519 清单绑定源码 SHA、包版本、平台、大小和 SHA256；更新拒绝降级、过期清单、错误平台和缺失回滚包。Windows NSIS 安装由独立 helper 执行并等待渲染器启动回执，失败安装上一版，再次检查启动。其它平台保留校验后的上一版用于手工回滚；移动端由系统分发更新。完整流程和验收边界见 [COMP-02/04/05](../feature/COMP-02-04-05.md) 与 [OPS-COMP-01/02](../feature/OPS-COMP-01-02.md)。

开发和生产统一从 `develop` 部署，仅 properties 区分地址和功能配置。Chat client secret、受控中枢密钥、客服桥接签名密钥、代码签名及发布私钥通过环境变量注入，不进入客户端、项目文件或仓库。


整合约束：模型选择与区域路由沿用服务端登记节点，价格未知保持 null。每次生成先持久化原始 UUID，再携同一 X-Request-Id 发送；失败仍查询同一节点、同一密钥指纹的回执，重启仅 GET 对账，不重放生成。账号哈希持久化并以排他写入保证注册唯一性；已有账号读取失败时拒绝登录与重注册，避免重启后同名接管持久项目。各在线授权默认关闭。

客服回调没有内置默认签名密钥：未配置时返回 503，已配置时继续校验 HMAC 和事件幂等。
