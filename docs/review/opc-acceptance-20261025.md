# Compositor 2026-10-19 需求与审计项执行记录

## PR #29 合入 develop 后的复核（2026-10-25）

本轮只处理既有 PR #29 与 develop 的冲突。合并前分支为 `b60b1c284b48531465d7c9edec57c48dd01c1326`，合入的 develop 为 `784a294211bd685a614a59b269896184d9dbc9c5`，包含 Muse 的 `1abe8ee69dfab2f3a2af82848d522ee63e379399`（TODO-20261024-16，经 PR #30 合入）。本轮复跑的产品实现与原 PR #29 相同，只合入 develop 的工作流测试修正与验收证据；合并提交 SHA 见 PR。

开始时仅 `.task-tmp/` 未跟踪，没有未提交的受跟踪文件。原有两次提交和有效实现全部保留，没有丢弃上轮工作；临时脚本、日志和 PR 说明文件不提交。依赖继续复用现有 node_modules 目录联接。

### 冲突取舍

| 文件/范围 | 最终处理 |
| --- | --- |
| `src/psd-subset.ts` | 无需人工选边；双方的 `RawLayer.right` 修复相同。保留本分支更完整的图层顺序、蒙版实际像素、ZIP 文字边界、工程历史与字体保护实现。 |
| `tests/release-workflow.test.ts` | 完整保留 develop 对 `page-contract.yml` 的断言修正，文件与 develop 相同。该修正消除首次验收的工作流列表失败。 |
| PSD 与 Electron 用例 | develop 的 9 个 PSD 用例全部保留；原 16 位测试扩展为 16/32 位，并保留 ZIP 文字/图层组测试及完整 Electron 编辑、回读、导出、恢复测试。本轮未改产品源码、界面文案或其它测试断言。 |
| `docs/test/TC-opc-product-20261019.md` | 以覆盖实际编辑闭环的 Electron 证据为主，合并 Muse 的单元证据、签名包与五端真机限制及原始执行记录。双方均为 101 正反向通过、102 正反向阻塞。Muse 的历史执行数量和回环监听限制单独标明，不套用到本轮环境。 |
| `docs/test/PROGRESS.md` | 保留一致的统计：目录 82 条，65 待测、2 通过、15 阻塞；保留详细执行记录入口，补充签名包和真机阻塞条件。 |
| `docs/test/REQUIREMENT-COVERAGE.md`、`docs/test/TRACEABILITY-20261019.md` | 合并单元与 Electron 证据，保留声明子集范围和五端签名包、设备阻塞条件。 |
| `docs/test/functional-manifest-20261019.json` | 保留本分支与用例一致的 `progress` 和 `suite_counts`：0 待测、2 通过、2 阻塞；develop 的两处汇总仍残留 4 条待测，需同步纠正。保留 `design_only: false`，因为双方均已有实际执行记录。 |

101 与 AUD-01 在声明子集内通过；102 与 AUD-02 仍缺签名包、五端制品/设备和原生移动界面的验收证据。TODO-20261021-07 保持已完成复核，TODO-20261024-16 的有效修复和证据已并入，不重复实现。

### 合并后验证

测试仍使用工作目录内 `.task-tmp/` 作为 TEMP / TMP，服务测试只用回环 HTTP 与 stub。`npm test` 的 48 项全部通过，包括 Muse 环境曾因回环监听受限未执行的服务测试；`npm run build` 的共享校验器、TypeScript 与 Vite 构建通过。

| 命令 | 本轮合并后结果 |
| --- | --- |
| `npm test` | 48/48 通过；PSD 10 项（含 develop 原有 9 项覆盖）、工作流 2 项全部通过。 |
| `npm run build` | 通过。 |
| `npm run test:e2e` | 16/17 通过，耗时 5.8 分钟；唯一失败为原有帮助文案断言，见下文。 |
| 指定原型检查器：`--sync`、无 `--sync`、`--staged` | 均 PASS；通过仓内范围包装器执行，完整形式见下方“原型闸门与范围”。 |
| TC/manifest/PROGRESS 一致性、文档本地链接、LF、冲突标记、`git diff --check` | 通过。 |

唯一保留失败：`tests/desktop/editor.spec.ts:347`，`Windows desktop bridge is isolated and demo renders as editable layers` 仍断言旧文字“PSD 导入为尽力而为”，实际界面为已有的“PSD 可编辑子集仅为 8 位 RGB……”说明。该失败在首次验收已记录；本轮没有修改对应界面或断言。完整回归中的 PSD 正反向、选区/撤销/重做、缺字体保护、损坏解码/历史保护及崩溃恢复六项均通过，不需要再次重复运行同一组测试。

指定原型检查器经本仓范围包装器先 `--sync`、再无 `--sync` 检查均 PASS（4 个 HTML、3 个代码契约文件、3 个接口）；合并未改变页面契约，清单无额外内容差异。TC、manifest、PROGRESS、文档本地链接、LF 和未解决冲突检查通过；2026-10-17 文档与用例结果未改动。范围包装器只排除嵌套 worktree、security 和临时目录，未修改共享检查器。

## 首次验收记录（保留历史结果）

执行日期：2026-10-25（UTC）。环境：Windows 10.0.26100 x64、Node.js 24.19.0、Electron 44.7.0。执行者：codex。应用版本：0.2.0（源码运行，非安装验收）。最终定向回归结束：2026-10-25 06:39:46 UTC。

同步基线：`c47c42b1aeed8d9ec45b69048d172484ac624cd4`（origin/develop）。被测实现提交：`100ad39601b692854ef2bcf85884dca3914f46a4`。后续提交只更新本记录及验收入口；PR 最终 SHA 见 GitHub。

工作目录为指定的独立 worktree，分支 `codex/opc-remaining-20261021`。开始时没有未提交改动和额外提交，没有丢弃上轮工作。根目录及本仓跟踪文件中没有 AGENTS.md / CLAUDE.md，按派工单执行。主检出的 node_modules 已通过目录联接复用，没有 npm ci。

## 逐项结论

| 编号 | 源码与测试证据 | 结论 |
| --- | --- | --- |
| REQ-COMPOSITOR-PRODUCT-101 | `src/psd-subset.ts`、`src/io.ts`、`src/engine.ts`、`electron/main.cjs`；PSD 单元测试及真实 Electron PSD 正反向用例 | 已实现并测试。修复图层记录到编辑器的堆叠顺序、蒙版透明度反相/羽化、图层类型缺少 right 导致构建失败，以及 ZIP 文字图层误标可编辑。 |
| AUD-COMPOSITOR-20261019-01 | 同上，转换报告逐项列出保留与损失；两像素层、文字、蒙版修改后保存回读，并比较 PNG 导出像素 | 声明子集的正常、异常验收通过。输入为本仓生成的合法子集夹具，不是完整 Photoshop 兼容或五端验收证明。 |
| REQ-COMPOSITOR-PRODUCT-102 | `src/project.ts`、`src/engine.ts`、`src/App.tsx`、`src/platform.ts`、`src/recovery.ts`、`electron/storage.cjs`；工程格式、磁盘/内存替身、桌面往返及恢复测试 | 共享编辑与存储已补齐并测试；五端验收阻塞。 |
| AUD-COMPOSITOR-20261019-02 | 当前选区及非嵌套、受预算限制的历史随工程/恢复副本保存；打开和撤销时重新检查字体；损坏历史和解码错误保留当前工程/保存位置 | Windows Electron 源码运行通过；缺 Windows 安装版以及其他端实际制品和设备。Android MainActivity 仍继承 Capacitor BridgeActivity，iOS 使用 Capacitor 共享界面，不认定原生移动编辑界面目标已完成。 |
| TODO-20261021-07 | 动手前执行 `git log origin/develop --since=2026-10-20 --grep=TODO-20261021-07`，找到 `d51311d` 与合并提交 `495d963`（PR #24） | 已有实现复核通过，不重复实施。原生文件过滤器接受 PSD；`service/server.mjs` 目录仅境内模型，拒绝非 cn 路由；默认配置键、下载路径拼写已复核。现有 `tests/ecosystem.test.ts` 使用 stub 验证模型目录和路由，新增 Electron 测试验证 PSD 打开、编辑和导出。 |

全线待办按“仓库”列筛选，本仓只有 TODO-20261021-07。其它行在事项描述中提及 Compositor，不属于本仓任务；没有进入或改动其它仓库、主检出或嵌套 worktree。

## 四条用例

| 用例 | 结果 | 实际执行 |
| --- | --- | --- |
| TC-COMPOSITOR-PRODUCT-101-P | 通过 | `PSD desktop import edits two pixel layers, text and mask, then round trips and exports`：原生对话框过滤器、转换报告、堆叠像素、两个像素层位置、文字内容、蒙版反相/羽化、工程回读与导出像素全部断言通过。 |
| TC-COMPOSITOR-PRODUCT-101-N | 通过 | `PSD unsupported, damaged and oversized imports preserve the open project and save path`；PSD 单元套件覆盖目录、CMYK、16/32 位、PSB、ZIP、图层组、调整层、智能对象、图层效果/矢量蒙版的损失报告。 |
| TC-COMPOSITOR-PRODUCT-102-P | 阻塞 | `saved project retains selection and both undo and redo branches`、`force exit recovers editable project and saving clears recovery` 通过；实际五端制品/设备及原生移动界面验收尚缺。 |
| TC-COMPOSITOR-PRODUCT-102-N | 阻塞 | 缺字体模拟、不可解码图层、损坏历史、磁盘满、内存预算在本地通过；五端真实异常条件未执行。没有把 Capacitor 目录或 mock 结果记成安装通过。 |

## 自动化结果

测试使用工作目录内 `.task-tmp` 作为 TEMP / TMP；桌面测试使用隔离的 COMPOSITOR_TEST_DATA，不读写实际用户工程。在线服务测试仅启动回环 HTTP 并注入 stub transport。

| 命令 | 结果 |
| --- | --- |
| `npm run build` | TypeScript、共享校验器和 Vite 构建通过。 |
| `npm test` | 48 项：47 通过、1 条原有工作流断言失败。PSD ZIP/图层组边界与系统字体回读的新测试均通过。 |
| `npm run test:e2e` | 17 项：16 通过、1 条原有帮助文案断言失败。最后的 ZIP 与系统字体增量另执行下行定向回归。 |
| 最终定向回归 | 6/6 通过：PSD 正反向、选区/撤销/重做、缺字体后主动替换为系统字体、解码/历史损坏保护、崩溃恢复。 |
| 原型清单 `--sync`，随后不带 `--sync` | 两次 PASS：4 个 HTML、3 个本仓代码契约文件、3 个接口。 |
| TC / manifest / PROGRESS 一致性检查 | 4 条新增用例：2 通过、2 阻塞；目录合计：65 待测、2 通过、15 阻塞，82 条。2026-10-17 文件和结果不变。 |
| 文档链接、LF、`git diff --check` | 全部通过；未改写任何 2026-10-17 用例或清单。 |

最终定向回归命令：

```powershell
$env:TEMP = Join-Path (Get-Location).Path '.task-tmp'
$env:TMP = $env:TEMP
npm run test:e2e -- --grep 'PSD desktop|PSD unsupported|saved project retains|font availability|decode failures|force exit'
```

保留的原有失败，没有修改其断言：

1. `tests/release-workflow.test.ts`：`checked-in workflows keep runner off job env and keep signed release fail-closed`。期望工作流文件列表未包含 develop 已新增的 `page-contract.yml`；初始基线 43 项单元测试就有此失败。
2. `tests/desktop/editor.spec.ts`：`Windows desktop bridge is isolated and demo renders as editable layers`。仍期待旧文案“PSD 导入为尽力而为”，develop 的帮助页已改成明确的 PSD 子集说明；本轮没有改动该帮助段或原断言。

中间一次桌面完整回归的恢复用例在结束时删除 Chromium 的 DIPS-wal 文件遇到 EBUSY。已对隔离测试目录的删除加入 Node 原生、有上限的文件占用重试，业务断言不变；最终回归结果见上表。初次 PSD 羽化夹具只有 2×2 像素，半径 4 羽化后透明，已换成 16×16 样本，在内部像素上验证混色；没有删减蒙版像素断言。

## 原型闸门与范围

共享检查器默认未排除 `.codex-worktrees`，原清单因而绑定了两个嵌套 worktree 的文件。直接执行原命令会读取超出本轮范围的 worktree。使用本仓 `scripts/check-prototype-scoped.py` 加载指定检查器，仅在运行时扩展目录排除集合；共享脚本文件、实际校验逻辑和本仓代码扫描均未修改。清单现仅绑定本仓 `electron/main.cjs`、`service/server.mjs`、`src/App.tsx`。

执行形式（Python 使用派工单指定完整路径，checker 为派工单指定的 check-prototype-drift.py）：

```powershell
& 'C:\Users\lzhao3730\AppData\Local\Python\pythoncore-3.14-64\python.exe' -I -X utf8 scripts/check-prototype-scoped.py $checkerPath --repo (Get-Location).Path --sync
& 'C:\Users\lzhao3730\AppData\Local\Python\pythoncore-3.14-64\python.exe' -I -X utf8 scripts/check-prototype-scoped.py $checkerPath --repo (Get-Location).Path
```

需求、原型、设计、代码和用例入口已同步。没有数据库/SQL 变更，没有部署、Jenkins、真实外部账号/API、付费模型、共享开发库或生产库操作，没有读取 security 目录。五端签名、发行、安装及原生移动界面仍需后续完成；本 PR 不宣称五端交付完成。
