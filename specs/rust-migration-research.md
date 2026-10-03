# Spec：ZCode Rust 迁移与原生 macOS 27 UI 技术方案（研究报告）

> 状态：研究稿（本轮只做研究，不改任何业务代码）。
> 结论均来自对当前检出（main，2026-09-26 基线）的实测：逐包统计、`package.json`、`architecture-policy.yaml`、`AGENTS.md`、`DESIGN.md`、`packages/shared/src/zcode-protocol-v4/*`、`packages/desktop/src/main/desktopHostProcess.ts` 等；外部事实（macOS 27、Electron/Tauri 兼容现状）引用公开报道与厂商文档，见文末来源。

## 0. 结论速览（TL;DR）

1. 仓库规模：**15 个 workspace 根成员**（`packages/*` 14 个 + `apps/zcode-cli`），后者再含 **17 个子包**；合计 **约 94.8 万行 TS/TSX**（排除 node_modules/dist/bundled-resources，实测统计）。
2. 三路线对比结论：**不建议把"全量 Rust + 原生 UI 一步到位"作为主路线**。推荐**渐进混合**：
   - 近期走**路线 C**（保留 Electron，性能热点 Rust 化为 napi 模块）；
   - macOS 侧按**路线 B** 演进出 **SwiftUI 原生壳 + Rust core**，承接 macOS 27 的 Liquid Glass 控制层；Windows/Linux 暂留 Electron 壳，形成**"一核双壳"**；
   - **路线 A（Tauri 整体替换壳）不作为主路线**，仅作远端轻客户端备选。
3. macOS 27（"Golden Gate"，2026-09 正式发布）的 Liquid Glass 细化（统一圆角、侧栏重设计、系统级透明度滑块、SwiftUI 强制 Liquid Glass）**只有原生 AppKit/SwiftUI 控件能完整吃到**；WebView（WKWebView/Electron Chromium）内容层无法直接获得，只能靠 `vibrancy`/`NSVisualEffectView` 近似。这是引入 SwiftUI 壳的核心动因。
4. 第一阶段最小切片建议：**`packages/shared/src/zcode-protocol-v4` 的 wire 编解码层（`wire-binary.ts` / `wire-codec.ts` / crc32 / base64 分片）Rust 化为 napi 模块**，用差分测试对拍 TS 实现——纯函数、边界清晰、直接服务双链路性能、可灰度可回滚。
5. 最大风险不在壳，而在 **Agent runtime（apps/zcode-cli，约 37.9 万行）与协议契约（旧协议 index 3720 行 + V4 约 1.09 万行 schema）**：协议双实现漂移、`desktop-continuous` / `web-remote-replayable` 双 deliveryProfile 语义、以及约 95 万行双语言代码库的长期维护成本。

---

## 1. 迁移范围盘点（实测）

### 1.1 规模总览

统计口径：`find <pkg>/src -name "*.ts" -o -name "*.tsx"`，排除 node_modules / dist / bundled-resources；`apps/zcode-cli/packages/*` 同口径。

| 包 | 职责（实测） | 行数 | 文件数 |
| --- | --- | ---: | ---: |
| packages/client | Agent 客户端 SDK（RPC 客户端封装） | 738 | 6 |
| packages/desktop | Electron main / host / renderer / preload / scheduler | 61,217 | 264 |
| packages/formal-proof | 形式化证明辅助（单包低依赖） | 1,823 | 2 |
| packages/model-option-map | 模型选项映射（零依赖） | 867 | 8 |
| packages/provider | 模型供应商注册/解析/配置服务（跨端纯逻辑） | 4,827 | 23 |
| packages/provider-node | provider 的 Node 侧适配 | 1,895 | 17 |
| packages/rpc | RPC 框架（零 npm 依赖） | 3,295 | 16 |
| packages/server | Web 端服务（Hono + ws + node-pty，entry-http / entry-stdio / remote） | 10,821 | 48 |
| packages/services | 业务服务全集（session、storage、terminal、git、mcp、oauth、broadcast、subagents、teams 等 40+ 模块） | 101,670 | 329 |
| packages/shared | 共享协议与类型：旧 zcode-protocol（index 3,720 行）+ zcode-protocol-v4（约 10,868 行）+ 大量领域 schema（zod） | 41,055 | 227 |
| packages/ui | 共享 React 组件 + Zustand store（44 个 store 文件） | 332,540 | 1,519 |
| packages/web | Web 客户端（React，含 share 页） | 2,876 | 16 |
| packages/zcode-cua | Computer Use 占位包（发布形态为编译产物 broker/pip-session/helper 契约，运行面 fail-closed） | —（发布 .js+.d.ts） | — |
| packages/zcode-server-cli | 远程服务器 CLI（runtime manifest、supervisor、CrashBudget） | 5,718 | 42 |
| apps/zcode-cli | Agent CLI 与运行时（见下） | 378,643 | 3,062 |
| **合计** |  | **≈ 948,000** | ≈ 5,900 |

apps/zcode-cli 子包（关键几个）：core 113,111 / bootstrap 82,164 / contracts 59,128 / adapters 57,183 / dynamic-workflow 26,914 / tui 15,565 / cli 10,651 / debug 4,779 / telemetry 4,205 / node-repl-host 1,519 / dynamic-workflow-runtime 1,819 / i18n 1,490 / 其余为占位或极小包（browser-use-plugin 20 行、shared-types 95 行、**swift-bridge 20 行——Swift 互操作占位包**，说明团队已预留 Swift 桥接位）。

### 1.2 对 Node/Electron 生态的依赖点（实测）

- **Electron 41.0.3**（`electron-builder` 打包、`electron-updater` 自动更新、`@electron/asar` / `@electron/rebuild`）。main 进程 65 个文件直接 `import "electron"`；高频 API 引用：`BrowserWindow`×257、`ipcMain`×113、`Notification`×53、`Tray`×45、`shell`×26、`nativeTheme`×8；另有 `utilityProcess` + `MessageChannelMain`（`desktopHostProcess.ts`——Agent 以 Electron UtilityProcess 形态驻留，经 MessagePort 与 main 通信）、`BrowserView`/`WebContentsView`（browserView/ 目录 7 个文件，内嵌浏览器/凭证管理）、`desktopTray`、`desktopApplicationMenu`、`desktopWindowChrome` 等 39 个含 darwin/macos 关键字的 main 模块。
- **Node 原生/系统依赖**：`node-pty`（终端，含 @lydell 分平台预编译四平台）、`ssh2`（远程 workspace）、`koffi`（FFI，pnpm-workspace allowBuilds 中已声明）、`playwright-core`（浏览器控制）、`ws`、`undici`、`node-forge`、yauzl/yazl（zip）。
- **React 渲染层**：React 19.2（pnpm overrides 钉住）、zustand 5、Tailwind 4（`@tailwindcss/vite`）、Vite 8；ui 包 62 个运行时依赖，重度绑定 React 生态：Lexical（编辑器）、@xyflow/react（流程图）、Radix、dnd-kit、react-pdf、@extend-ai/react-xlsx|docx、rive（动画）、Stripe Elements、embla 等。
- **Agent 运行时**：AI SDK（`@ai-sdk/anthropic`、`@ai-sdk/openai-compatible` 带仓库补丁）、turbo、esbuild；CLI 发布走 **Node SEA**（`apps/zcode-cli/packages/cli/scripts/build-sea.mjs`，postject 注入）单可执行文件。
- **已有原生先例**：`apps/zcode-cli/dependencies/native-search` 预打包 **ripgrep / ugrep / bfs**（Rust/C 工具）二进制分发链（`scripts/build-native-search-tools.mjs`），并已内置 Agent 侧 `core/embedded-search`——"Rust 产物按平台分发并接入 TS 宿主"的管线在仓库里已存在。
- **治理约束**：`architecture-policy.yaml`（maxFileLines 400 / maxContractLines 300 / forbidCycles / forbidDeepImports / managedOnly）、根与 CLI 两套 `AGENTS.md`、`specs/`、`DESIGN.md`（`text-ui-*` 字号体系为最高优先级 UI 约束）、mise 钉 Node 24 + pnpm 10。Rust 化后需要**平行的治理规则**（clippy/deny、crate 边界、FFI 契约 max 行数等）。

### 1.3 Rust 化适配度判定

| 层 | 包 | 判定 | 理由 |
| --- | --- | --- | --- |
| 协议编解码/分片/CRC | shared/zcode-protocol-v4 的 wire-* | **优先 Rust 化** | 纯函数、跨 Node/browser 无宿主依赖、双链路热点；zod schema 可机械转译为 serde+校验，差分测试可行 |
| 文件索引/搜索 | core/embedded-search、native-search | **Rust 化**（部分已是原生二进制） | 扩展现有 ripgrep/bfs 管线为常驻索引服务 |
| 进程/终端/文件 IO 边界 | services/process、fileWatcher、fs、terminal；server 的 pty | **中期 Rust 化** | tokio + portable-pty 替代 node-pty 收益明确，但要保跨平台矩阵（darwin/linux/win32 × x64/arm64） |
| Agent 核心 loop、tool 调度、subagent/team、dynamic-workflow | apps/zcode-cli/core、bootstrap、contracts、adapters | **长期、分步**；LLM provider SDK 生态留在 TS 最久 | 与 AI SDK 补丁、MCP 生态、plugins/skills 体系耦合最深；契约（contracts 5.9 万行）需先冻结 schema 才能双实现 |
| RPC 框架 | packages/rpc | 可保持 TS（零依赖、稳定） | 收益低、迁移面广 |
| UI 组件/store | packages/ui、web | **保留 TS/React** | 33.2 万行 + 重度 React 生态绑定；SwiftUI 重写成本不可接受 |
| 桌面壳 | packages/desktop main/host | **macOS 逐步 SwiftUI 化（路线 B 终态）**；Win/Linux 留 Electron | 承接 macOS 27 原生能力；跨平台壳先不替换 |
| Web 服务 | packages/server、zcode-server-cli | 保留 TS，中期可选 Rust（axum） | 远端链路稳定优先 |

---

## 2. 技术选型对比

### 2.1 路线定义

- **路线 A：Tauri（Rust 壳 + WebView 前端）**——用 Tauri 2 整体替换 Electron，前端 React 资产保留，跑在系统 WebView（mac 上为 WKWebView）。
- **路线 B：纯 Rust 原生（SwiftUI 壳 + Rust core via FFI）**——macOS 上用 SwiftUI 编写应用壳与控制层，Rust 编译为静态库经 FFI（swift-rs / UniFFI / cbindgen）承载 core；内容区仍以 WKWebView 承载现有 React UI。
- **路线 C：保留 Electron，热点 Rust 化（napi/FFI 模块）**——Electron 壳不动，把协议编解码、文件索引、压缩、进程调度等热点写成 napi-rs 原生模块，渐进替换。

### 2.2 逐维度对比

| 维度 | A. Tauri | B. SwiftUI 壳 + Rust core | C. Electron + Rust 热点 |
| --- | --- | --- | --- |
| UI 资产复用 | React 全保留，但渲染基线从 Chromium 换成 WKWebView，33 万行 UI 需在 Safari/WebKit 上重新验证（CSS/Tailwind 4、Lexical、pdf、rive 均有 WebKit 兼容风险） | React 保留（内容区 WebView），但窗口/侧栏/菜单等 chrome 逻辑要双写（Swift + Electron） | 零改动 |
| macOS 27 Liquid Glass | 内容层拿不到真 Liquid Glass；仅窗口 `vibrancy` 近似；WebKit 渲染差异随系统升级波动 | **唯一能完整吃到** macOS 27 原生控件、系统透明度滑块、侧栏新范式的路线 | 同 A，`vibrancy` 近似；Chromium 壳在 macOS 26/27 已有兼容摩擦的公开先例（Electron 应用在 Tahoe 上的问题追踪） |
| 性能/内存 | 启动与内存显著优于 Electron；Rust 侧命令可用，但 IPC 边界仍在 | 壳最轻；core 直接 FFI，协议/搜索零拷贝潜力最大 | 壳不变（内存基线不变）；热点模块收益立竿见影 |
| 协议兼容（zcode-protocol V4） | 不动协议，风险最低 | 不动协议；core 双实现需差分测试 | 不动协议；napi 模块双实现需差分测试 |
| 双链路（desktop-continuous / web-remote-replayable） | 传输层（Electron main 的 relay/proxy/host）需整体重写为 Tauri Rust 命令，风险集中爆发 | 分阶段：先在 host 内替换传输实现，协议不变 | 传输层不动，最稳 |
| 工程量 | 壳全量重写（desktop 6.1 万行中 main/host 的大半）+ WebKit 适配 + 更新器（electron-updater→tauri updater）重做 | 壳只写一次 macOS 版；FFI 契约维护；需同时维持 Electron 壳（Win/Linux） | 每个热点模块单独立项，粒度可控 |
| 团队成本 | 需 Rust + Tauri + WebKit 三项新技能；CI/签名/公证链重建 | 需 Rust + Swift 两项新技能；双壳并存期维护两套窗口管理 | 只需 Rust（napi 生态成熟），增量最小 |
| 回滚能力 | 壳整体替换，回滚 = 整条分支回退，粒度粗 | 按 UI 面逐块切换（顶部栏→侧栏→…），capability 协商可降级 | 模块级 feature flag，回滚最细 |
| 体积/分发 | 安装包显著变小（去 Chromium） | mac 包变小（去 Chromium） | 不变 |
| 跨平台承诺（AGENTS.md：Win/mac/Linux 同等） | 好（Tauri 三平台） | macOS 专属，需与其余平台壳并存（双壳） | 不受影响 |

### 2.3 推荐与理由

**推荐：路线 C 先行 → 路线 B 为 macOS 终态（"一核双壳"）；路线 A 不作为主路线。**

1. **收益错位**：本仓库的性能瓶颈与长期演化重心在 Agent runtime 与协议层（TS），而非壳本身。Tauri 只换壳、换不掉 37.9 万行 runtime，却要一次性承担 WebKit 适配与更新链重建——投入产出最差，故 A 不作主路线。
2. **macOS 27 的硬约束**：Liquid Glass 细化（系统透明度滑块、侧栏重设计、SwiftUI 强制启用）只有原生控件能实现；Chromium/WKWebView 内容层拿不到。要在 mac 上"原生支持 macOS 27 UI"，**唯一干净解是原生壳**——因此 B 是 macOS 侧的必然终态。
3. **风险曲线**：C 的模块级粒度让每一步都可差分验证、可单独回滚，同时为 B 积累 Rust core（napi crate 与 cdylib 可同源）；等 core Rust 化到临界点（协议、索引、进程/IO 边界就位），B 的 SwiftUI 壳只是替换"壳 + 桥"，而不是再来一次大迁移。
4. **现实先例**：仓库已有 `swift-bridge` 占位包、`zcode-cua` 的 Helper/broker fail-closed 契约、native-search 二进制分发链、SEA 单文件发布——B/C 所需的桥接与分发基建都已有雏形。

---

## 3. macOS 27 原生 UI 支持方案

### 3.1 目标系统事实

macOS 27 "Golden Gate"（2026-09 发布）：Liquid Glass 视觉细化（全系统一致圆角、侧栏重设计、新增**系统级透明度调节滑块**，SwiftUI 控件的 Liquid Glass 会自动响应滑块）；WWDC26 起 SwiftUI 中 Liquid Glass 为强制默认，并新增 minimal menu icons 等。要点：**透明度滑块是用户级系统设置，第三方 WebView 内容无法响应；只有原生控件（`.glassEffect()` 等 API）自动适配**。

### 3.2 分层架构（目标态，macOS）

```text
┌────────────────────────────────────────────────────────┐
│ SwiftUI 壳（窗口/标题栏/侧栏控制层/菜单/Tray/通知/权限）      │  ← 吃满 macOS 27 Liquid Glass
│   ZCodeShellApp (App) · GlassSidebar · WindowRouter      │
└───────────────┬────────────────────────────────────────┘
                │ ① 壳 ↔ Rust core：FFI（swift-bridge 包承接）
┌───────────────▼────────────────────────────────────────┐
│ Rust core（cdylib/staticlib）：session/protocol/搜索/IO 边界 │
└───────────────┬────────────────────────────────────────┘
                │ ② core ↔ 内容区：沿用 ZCode Protocol V4
┌───────────────▼────────────────────────────────────────┐
│ WKWebView 内容区：现有 React UI（packages/ui 不动）          │
│   对话流/编辑器/工作流画布/终端面板（内容层保持不透明，         │
│   遵循 Apple 指南：Liquid Glass 用于控制层而非内容层）        │
└────────────────────────────────────────────────────────┘
```

### 3.3 系统能力映射（现状 Electron API → macOS 27 原生）

| 现状（packages/desktop/src/main，实测） | macOS 27 原生对应 | 备注 |
| --- | --- | --- |
| `BrowserWindow`（×257 引用）、`desktopWindowLifecycle`、`desktopWindowChrome*`、`primaryWindowCoordinator` | `WindowGroup` / `NSWindow`（`.glassEffect()`、toolbar/`NSToolbar` 新侧栏范式） | 窗口路由状态机需在壳内重写；状态经 FFI 存 core，不进 SwiftUI 局部状态（对齐 AGENTS.md「UI 不保存业务状态」） |
| `desktopApplicationMenu`、`Tray`（×45）、`DesktopTopOverlay*` | `Commands`/`Menu`（SwiftUI）、`MenuBarExtra` | 菜单 action 转发到 core 的命令总线 |
| `Notification`（×53）、`desktopNotifications` | `UserNotifications`（UNUserNotificationCenter） | 通知点击路由回壳的 deep link |
| 权限：`cuaAccessibilitySettings`、`cuaPermissionPanel*`、`cuaSystemSettingsWindowWatcher`、zcode-cua Helper fail-closed 契约 | `NSWorkspace`/TCC 提示、系统设置深链（macOS 27 的 App 权限面板 API） | 保留 fail-closed 语义；Helper install/launch/verify 迁入 Rust core |
| `nativeTheme`（×8）、主题广播 | `NSApp.appearance` + `ColorScheme` 观察 | 主题事实源仍在 core/settings-sync，壳只是视图 |
| 对话框/文件选择（`dialog`） | `NSOpenPanel`/fileImporter | 对应 `hostCapabilities.nativeDialogs` 能力位 |
| `utilityProcess` + `MessageChannelMain`（Agent 驻留） | Rust core 以进程内库或独立 XPC/子进程驻留 | 生命周期与 hostShutdownPhases 对齐 |
| 自动更新 `electron-updater` | Sparkle / 自研 + 公证链 | 分发与签名需重建 |

### 3.4 需要的桥接层

1. **Swift ↔ Rust（FFI）**：激活现有 `apps/zcode-cli/packages/swift-bridge` 占位包：Rust 侧 `cdylib` + cbindgen/UniFFI 生成头文件；契约行数受 `architecture-policy` 同等约束（建议 contract ≤300 行、文件 ≤400 行平移适用）。跨 FFI 只传**值与事件**（与 V4 wire 相同的 serde 模型），不传对象引用。
2. **壳 ↔ 内容区 WebView**：`WKScriptMessageHandler` 承载与现有 renderer 相同的通道语义；**协议不变**（V4 hello/capability 握手原样），新增能力位（如 `nativeGlassChrome: boolean`）走既有 `hostCapabilities` 可选字段向后兼容模式（=== true 判断，旧 Host 缺失即 false）。
3. **能力协商降级**：`hello.capabilities` 增加原生壳能力位；React UI 据此决定是否隐藏自绘顶栏/侧栏（`DesktopTopOverlay`、Side Pane chrome），未协商到则维持现状——保证 Win/Linux（Electron 壳）与旧版本行为不变。

---

## 4. 分阶段迁移计划

总原则：**协议与状态所有者不动；每阶段独立可验收、可回滚；先建护栏再动刀**。

### 阶段 0：护栏（约 2–3 周，纯增量）

- 范围：为 V4 wire 层建立**跨实现 golden test**（TS 实现产出向量集：帧编码/crc32/base64 分片/重组/故障帧）；为 `desktop-continuous` 与 `web-remote-replayable` 各固化一条 E2E 回放用例；仓库新增 `crates/`（或 `native/`）工作区与 `mise` 任务、CI 矩阵（darwin/linux/win32 × x64/arm64）。
- 验收：`pnpm typecheck`、`pnpm lint`、`pnpm verify:pre-push` 全绿；golden 向量集覆盖 wire-codec 全部分支；E2E 双链路各 1 条在 CI 稳定通过。
- 回滚：纯新增，删除目录即回滚。

### 阶段 1：最小切片——V4 wire 编解码 Rust 化（路线 C 第一切）

- 范围：`packages/shared/src/zcode-protocol-v4/wire-binary.ts` + `wire-codec.ts` + crc32/base64/分片重组 → `crates/zcode-wire`（napi-rs 模块 + 同源 core crate）；TS 侧保留同一接口作 fallback。
- 为什么是它：纯函数、无 Node 专属 API、有现成 zod→serde 转译路径、是双链路与未来所有路线的公共底座；单个模块可在 1–2 个迭代内完成并差分验证。
- 验收：差分测试对拍 TS/Rust 实现 ≥ 10^5 随机帧零差异；napi 版在 desktop host 与 server 两条链路 feature flag 下灰度，性能基线（编解码吞吐）提升有据可查；`zcode-protocol` 既有测试全绿。
- 回滚：feature flag 切回 TS 实现（保留到阶段 2 结束后 1 个版本再删）。

### 阶段 2：文件索引/搜索 Rust 化

- 范围：`core/embedded-search` 与 native-search 管线升级为常驻 Rust 索引服务（复用 ripgrep/bfs 二进制链），对 UI 只换 IPC 端点。
- 验收：搜索延迟/内存对比基线达标；索引服务崩溃可自动重启（对齐 zcode-server-cli 的 CrashBudget 语义）；Win/mac/Linux 三平台 E2E。
- 回滚：回退到进程外 ripgrep 方案（现状）。

### 阶段 3：进程/IO 边界与传输层 Rust 化（路线 C 深水区）

- 范围：node-pty → portable-pty、文件 watcher、压缩（permessage-deflate）、relay 传输的 Rust 实现；desktopHostProcess 的 Agent 驻留逐步从 UtilityProcess 迁往 Rust 托管进程（协议不变）。
- 验收：双链路 E2E 全绿 + 断网/重连/时钟校准（serverTime）用例；终端 24h 长跑无泄漏；分平台产物全矩阵出包。
- 回滚：每子模块独立 flag；终端回退 node-pty。

### 阶段 4：macOS SwiftUI 壳（路线 B 落地，与阶段 1–3 并行启动 UI 部分）

- 范围：SwiftUI 壳承接窗口/侧栏/菜单/通知/权限（3.3 映射表）；React 内容区进 WKWebView；激活 swift-bridge FFI；`hostCapabilities` 新增原生壳能力位。
- 验收：macOS 27 上 Liquid Glass 控制层（顶栏/侧栏/菜单）随系统透明度滑块实时变化；权限/通知/Tray 全量对齐 Electron 版功能清单（以 `packages/desktop/src/main` 模块清单为 checklist）；macOS E2E 双链路 + 更新器安装/升级演练；React UI 在 WKWebView 下视觉回归（DESIGN.md 令牌全过）。
- 回滚：能力位未开启时 React 自绘 chrome 兜底；App 包内保留 Electron 壳发布通道至少 2 个版本（双通道灰度），验证通过后 mac 停发 Electron 版。
- 里程碑判定点：此后才评估把 runtime 核心（agent loop、tool 调度）进一步 Rust 化的投入产出；不设时间表，避免为迁移而迁移。

---

## 5. 风险清单

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| 1 | **协议双实现漂移**：旧 `zcode-protocol/index.ts` 3,720 行 + V4 约 1.09 万行 zod schema，Rust 侧 serde 转译一旦滞后，Host/Agent/远程三方出现分叉 | 高（破坏三端互通） | 阶段 0 golden 向量 + 差分测试进 CI；schema 变更必须先改 shared（唯一事实源）再同步两实现；能力位向后兼容沿用 `=== true` 约定 |
| 2 | **双链路语义破坏**：`desktop-continuous`（实时）与 `web-remote-replayable`（可回放）的 deliveryProfile、relay 探测（binaryFrames/compression）、时钟校准、重连/回放语义在传输层重写时丢语义 | 高（手机远控与桌面实时性回退） | 两条链路各自固化 E2E 回放用例；AGENTS.md 要求的"修改 stream/snapshot/queue/重连时同时验证两种语义"写入每阶段验收；传输层重写放在阶段 3 而非更早 |
| 3 | **双语言维护成本**：~95 万行 TS + 新增 Rust/Swift；CI 从 pnpm/turbo/mise 单链变三链；architecture-policy 需平行治理 | 中高（长期） | Rust 化范围收敛在"纯函数与 IO 边界"；`managedOnly`、400 行上限、契约行数上限平移到 crate/FFI 契约；knip 对应 cargo-udeps/deny |
| 4 | **React UI 的 WebKit 兼容**：Tailwind 4、Lexical、react-pdf、rive、@xyflow 在 WKWebView 下的渲染与性能差异 | 中 | 阶段 4 前置一轮 WKWebView 视觉/性能回归；差异组件降级方案预留 |
| 5 | **平台矩阵翻倍**：darwin/linux/win32 × x64/arm64 的原生产物（napi/cdylib/Swift 仅 mac）构建、签名、公证 | 中 | 复用 native-search 的分平台打包脚本模式；Swift 相关只进 mac 产物 |
| 6 | **Electron 专有能力缺口**：BrowserView/WebContentsView 内嵌浏览器、chrome 凭证管理（chromeCookieManager 等）、http-mitm-proxy | 中 | 内嵌浏览器与凭证管理**不迁移**，保留在 Electron 壳直至单独评估；capability 位标记不可用面 |
| 7 | **macOS 27 演进风险**：Apple 每年 UI 断代（Tahoe 已有 Electron 兼容先例），Liquid Glass 后续变化不可控 | 中 | 原生壳把系统适配压缩在壳层；壳与 core/内容区解耦使年度适配成本有界 |
| 8 | **AI SDK 生态锁定**：provider 依赖 @ai-sdk/anthropic|openai-compatible（含仓库补丁），Rust 侧无等价生态 | 中（决定阶段 5 边界） | provider 层无限期留 TS；Rust core 通过 HTTP/SSE adapter 调用，不重写 SDK |
| 9 | **sea/分发链变更**：Node SEA → Rust 单二进制 + 双壳打包，影响现有发布/升级 | 中 | SEA 与 Rust 二进制并行发布一版对比体积/启动；升级回滚沿用 electron-updater/Sparkle 双通道 |

---

## 6. 明确不做（非目标）

- 不在本轮改任何业务代码；本报告不引入 `Cargo.toml`。
- 不重写 packages/ui 为 SwiftUI（33 万行 + React 生态锁定，收益不成立）。
- 不一次性替换 Electron 为 Tauri。
- 不动 `zcode-protocol`（旧协议 + V4）的任何 schema 语义。

## 7. 来源

- 仓库实测：逐包 `wc -l` 统计、`package.json`/`pnpm-workspace.yaml`/`architecture-policy.yaml`/`mise.toml`、`packages/shared/src/zcode-protocol-v4/*`（transport/wire-binary/wire-codec）、`packages/desktop/src/main/desktopHostProcess.ts`、`apps/zcode-cli/AGENTS.md`、`scripts/build-native-search-tools.mjs`、`specs/agent-teams.md`。
- macOS 27 "Golden Gate"（2026-09 发布，Liquid Glass 细化与透明度滑块）：[Ars Technica](https://arstechnica.com/apple/2026/09/apple-releases-ios-27-macos-golden-gate-27-with-siri-ai-and-liquid-glass-refinements)、[Cult of Mac](https://www.cultofmac.com/news/liquid-glass-changes-ios-27-macos-27)、[WWDC26 "What's new in SwiftUI"](https://developer.apple.com/videos/play/wwdc2026/269)、[Use Your Loaf 观看指南](https://useyourloaf.com/blog/wwdc-2026-viewing-guide)。
- Electron/WebView 在新版 macOS 的兼容摩擦与 Liquid Glass 对 WebView 内容层不可用：[mjtsai 对 Tahoe 上 Electron 应用问题的追踪（2025-09）](https://mjtsai.com)及 Apple 官方指南（Liquid Glass 用于控制/导航层而非内容层，WKWebView 内容不自动获得玻璃效果，仅 `vibrancy`/`NSVisualEffectView` 近似）。
