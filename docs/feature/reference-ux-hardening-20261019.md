# bgssai-compositor：参考工程（Compositor）架构对标、状态恢复守卫与 UX 强化规范（2026-10-19）

## 1. 背景与目标

`bgssai-compositor`（规范产品名：**Compositor**）是面向 OPC（One-Person Company）创作者的 PS 式图层与画布图像编辑软件，以 Windows PC 为起点，逐步覆盖 Windows、macOS、Linux、iOS、Android 五端。本规范基于对参考工程 `robbietilton/Compositor`（`reference-github/Compositor`）的深入源码剖析，提炼非破坏性图层合成、崩溃快照恢复、防御性边界钳制、GPU/CPU 渲染回退及境内 `bgssai-tokenhub-cn` 计量透明度的工程实现标准。

---

## 2. 参考工程 `robbietilton/Compositor` 架构深度对比

| 架构维度 | 参考工程 `robbietilton/Compositor` (macOS Swift/Metal) | 本仓 `bgssai-compositor` (TypeScript/Canvas/Electron/Capacitor) | 2026-10-19 硬化与对齐设计 |
| --- | --- | --- | --- |
| **工程持久化格式** | `.comp` 目录包：`manifest.json`（v1-v14）+ `images/<UUID>.png` / `<UUID>.mask.png`，通过临时文件与原子 `rename` 更新 | `.bgcomp` v1 单文件 JSON：内联 PNG Data URL 图层与蒙版，桌面端通过 `atomicWrite`（`wx` 临时文件 + `fsync` + `rename`）保存 | 增加快照信封校验和（`computeSnapshotChecksum` / SHA-256）与 `recoverProjectState` 局部损坏图层隔离机制 |
| **尺寸与像素预算** | `DocumentLimits.swift`：区分单表面上限 `maxSide = 30,000`、`maxSurfacePixels = 200M` 与整档累计上限 `documentPixelBudget` | `project.ts` / `memory.ts`：单边 `MAX_DIMENSION = 8192`、画布像素 `16,777,216`、图层累计像素 `48,000,000`、工程体积 `128 MB` | 新增防御性画布钳制 `clampCanvasDimension`（支持 `1..16384` 安全钳制与等比像素预算收敛）及解码前文件头校验 |
| **图层外观与混合** | `LayerAppearance.swift`：`opacity` 钳制于 `[0, 1]`（`min(1, max(0, opacity))`），枚举标准混合模式并支持文件夹透传 | `project.ts`：支持 16 种标准 Canvas 2D 混合模式（`source-over` 至 `luminosity`）与 `0..1` 不透明度 | 新增 `clampOpacity` 与 `normalizeBlendMode`，兼容大小写及 Photoshop/Compositor 标准名称（如 `Normal` 映射至 `source-over`） |
| **非破坏几何变换** | `LayerTransform.swift`：保留原始位图，维护 `origin`、`size`、`rotation`、`flipX/Y` 与正逆仿射矩阵 `unitToDocument` | `project.ts`：`localToWorld` 与 `worldToLocal` 实现画笔/选区/控制点在旋转、缩放、翻转图层上的双向逆变换 | 新增 `clampLayerTransform` 防御性钳制（`scaleX/Y` 钳制于 `0.01..100` 防止奇异矩阵除零，`x/y` 钳制于 `-100000..100000`） |
| **撤销/重做历史** | `DocumentHistory.swift`：维护 `past` / `future` 栈，受 `entryLimit` 与 `retainedByteLimit` 约束；空编辑不清空 `future` | `engine.ts`：维护 `history` 快照栈，上限 30 步与 `min(96 MB, memoryBudget / 8)` | 抽象 `HistoryRingBuffer` 环形缓冲守卫，强制校验游标边界、单调序列号、字节预算裁剪及空提交零副作用 |
| **GPU/CPU 渲染管线** | `MetalCameraRawLookup.swift` / `RasterSnapshot.swift`：Metal 不可用或分配失败时无损回退至双精度 C/CPU 渲染器 | `engine.ts` / `filters.ts`：优先使用 Canvas 2D `context.filter`，缺失时切换至预乘 Alpha 软件高斯模糊与色彩调整核函数 | 明确 GPU/CPU 双路径内存预估（含模糊边缘 `padding` 扩展缓冲区检查），保证透明边缘零色晕且不触发 OOM |

---

## 3. 图层树与画布状态恢复不变量（State Recovery Invariants）

### 3.1 自动保存双槽日志与校验和门禁
1. **双槽交替写入（Two-Generation Journal）**：
   - 桌面端（`electron/storage.cjs`）在 `userData/recovery` 下维护 `snapshot-0.json` 与 `snapshot-1.json` 两个槽位；每次写入选取非最新槽位，先写 `.tmp` 排他文件并执行 `file.sync()`，再原子重命名覆盖目标槽位。
   - 浏览器与移动端（`src/recovery.ts`）在 IndexedDB `recovery` 存储中维护 `latest` 与 `previous` 两代记录；事务中止或配额耗尽时自动保留既有记录。
2. **结构与摘要双重校验（Schema & Checksum Verification）**：
   - 快照信封包含 `content`、`sha256` / `checksum`、`sequence`（安全正整数）与 `writtenAt`（有限时间戳）。
   - 读取时按 `sequence`（或 `writtenAt`）降序遍历槽位：若最新槽位因断电、进程强杀或磁盘坏块导致 JSON 截断、校验和不匹配或项目结构非法，自动回退读取上一代完好快照。
3. **启动恢复阻塞门禁（Startup Recovery Gate）**：
   - 应用启动完成恢复快照探测前，顶栏与欢迎页的“新建”、“打开”、“打开示例”等入口保持禁用并标记 `aria-busy="true"`，防止用户在异步读取完成前误触新建导致恢复快照被覆盖。

### 3.2 损坏图层隔离与降级抢救（`recoverProjectState`）
在严格的 `parseProject` 校验之外，系统提供非破坏性项目状态抢救函数 `recoverProjectState(json, options)`，满足以下不变量：
1. **单层故障隔离（Layer Quarantine）**：
   - 当项目中某个图层的内联 PNG 数据损坏、缺少 IHDR 头、单层尺寸超限或使累计图层像素超过 `48,000,000` 时，将该图层记入 `quarantinedLayers`（`action: "quarantined"`）并跳过，完整保留其余合法图层。
2. **损坏蒙版剥离（Mask Fallback）**：
   - 若图层主图像完好但附属 `mask` 的 PNG 数据损坏或尺寸非法，仅剥离该图层的 `mask`（记录 `action: "mask_dropped"`），保留图层主像素与变换参数。
3. **重复 ID 自动消歧（ID Deduplication）**：
   - 若多个图层存在重复或空白 `id`，自动分配确定性恢复 ID（如 `<id>-recovered-<index>`）并记录恢复日志，避免整份工程因 ID 冲突无法打开。

---

## 4. 防御性边界钳制规范（Defensive Bounds Clamping）

| 作用域 | 字段 / 参数 | 严格规范范围（`parseProject`） | 防御性钳制规则（`recoverProjectState` / Helper） | 异常与回退行为 |
| --- | --- | --- | --- | --- |
| **画布尺寸** | `width`, `height` | 整数 `1..8192`，且 `width * height <= 16,777,216` | `clampCanvasDimension` 钳制至整数 `1..16384`；恢复项目时若乘积超过 `16,777,216` 则按比例缩减至合规整数 | 非有限数或 `<=0` 时回退至默认值（宽 `1600`、高 `1000`） |
| **图层不透明度** | `layer.opacity` | 有限浮点数 `0..1` | `clampOpacity(value, 1)`：小于 `0` 钳制为 `0`，大于 `1` 钳制为 `1` | `NaN` / `Infinity` / 非数字回退为 `1` |
| **图层混合模式** | `layer.blend` | `BLENDS` 定义的 16 种标准模式 | `normalizeBlendMode(value)`：识别标准模式及英文别名（如 `Normal`、`Multiply`、`Soft Light`） | 未知或非法字符串回退为 `"source-over"` |
| **几何变换矩阵** | `x`, `y`, `scaleX`, `scaleY`, `rotation`, `flipX`, `flipY` | `x/y`: `-100000..100000`；`scaleX/Y`: `0.01..100`；`rotation`: `-36000..36000` | `clampLayerTransform`：将 `scaleX/Y` 钳制在 `[0.01, 100]` 杜绝零缩放导致逆矩阵奇异；坐标与角度钳制至合法区间 | 非有限数回退为单位变换（`x=0, y=0, scale=1, rotation=0`） |
| **色彩与滤镜参数** | `brightness`, `contrast`, `saturation`, `blur` | 亮度/对比度 `-100..100`；饱和度 `-100..200`；模糊 `0..50` | 逐项钳制至对应闭区间，非有限数回退为 `0` | 保证软件滤镜核函数不会因极端半径分配超大临时数组 |
| **撤销历史环形栈** | `HistoryRingBuffer` | 最多 `30` 步，字节上限 `min(96 MB, memoryBudget / 8)` | 新提交截断游标之后的重做分支；超限时从队首淘汰最旧快照并同步递减 `historyIndex` | 空提交（JSON 未变）直接幂等返回，保留重做栈与当前游标 |

---

## 5. 境内 `bgssai-tokenhub-cn` 倍率可见性与紧凑 Token 显示规范

### 5.1 同区受控路由与三档倍率（`0.5x / 1.0x / 1.5x`）
- **区域固定**：境内（`region: "cn"`）AI 能力（文案/排版建议 `POST /api/ai/text`、选区/图层重绘 `POST /api/ai/image-edit`）固定通过 `bgssai-tokenhub-cn` 路由，携带 `X-Bgssai-Product: bgssai-compositor`、`X-Bgssai-Model`、`X-Bgssai-Region: cn` 与幂等 `X-Request-Id`；上游异常时直接返回脱敏错误，不跨区回退至境外节点。
- **三档倍率可见性**：
  - 标准倍率档位定义为 `0.5x`（经济/轻量档）、`1.0x`（标准档）、`1.5x`（增强/高阶档）。
  - 在模型选择器与价格摘要中，通过 `formatMultiplier` 与 `priceLabel` 在任务提交前清晰展示模型倍率、计费单位（`token`）与价格版本（`price_version`）。
  - 当中枢尚未配置某模型的倍率时，界面如实展示“倍率待配置”，不伪造默认倍率。

### 5.2 紧凑 Token 格式（`K/M/B`）与接口精确整数对账
- **UI 紧凑展示（`formatCompactTokens`）**：
  - `0..999`：原样输出整数字符串（如 `"0"`、`"999"`）。
  - `1,000..999,949`：以 `K` 为单位，最多保留一位小数（如 `1000 -> "1K"`、`1540 -> "1.5K"`）。
  - `999,950..999,949,999`：自动进位或以 `M` 为单位，最多保留一位小数（如 `418,912,345 -> "418.9M"`）。
  - `>= 1,000,000,000`：以 `B` 为单位，最多保留一位小数（如 `1,500,000,000 -> "1.5B"`）。
  - 中英文界面统一使用 `K / M / B`，严禁折算为“万 / 亿”或使用“点”。
- **悬停精确数与 API 精确整数（`formatExactTokens` / `formatTokenQuotaPair`）**：
  - 所有紧凑 Token 节点均附带 `title={formatExactTokens(tokens)}`（如 `"418,912,345"`），支持悬停查看精确到个位的 Token 数量。
  - 服务端 API（`/api/billing/balance`、`/api/billing/ledger`、`/api/billing/packages`、`/api/ai/usage`）及持久回执文件（`settled.json` / `pending.json`）中的 `remaining_tokens`、`tokens`、`raw_tokens`、`billed_tokens` 必须保留精确非负安全整数。

---

## 6. UX 优化与非破坏性交互闭环

1. **AI 图层重绘先预览后确认**：
   - 用户对当前选区或活动图层发起 AI 编辑时，首先记录当前文档基准修订号 `aiBaselineRevision` 与持久化 `request_id`。
   - 生成结果在独立预览弹窗（`ai-preview`）中展示，同时呈现本次任务的模型倍率与 Token 用量回执摘要；仅当用户点击“应用为新图层”且文档修订号未被并发修改时，才将结果作为可一键撤销（`Ctrl+Z`）的新图层写入画布。
2. **多格式导入转换报告前置**：
   - 导入 PSD、SVG、TIFF、HEIC 等格式前生成结构化 `ConversionReport`，如实列出可编辑项与降级栅格化项，由用户确认后再创建文档或图层。
3. **可访问性与键盘流**：
   - 保持全量 Photoshop 风格快捷键（`V/M/C/B/E/S/J/G/U/O/T/I/H`、`Ctrl+Z/Y`、`[/]` 调节画笔大小），所有数值输入框支持越界自动钳制与失焦回退，杜绝非法输入破坏画布状态。
