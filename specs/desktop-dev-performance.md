# Spec：Desktop Dev 性能（构建增量、启动预热、渲染热点）

## 背景

2026-09-26 现场实测（ps/CDP 采样/分配采样）确认 dev 版体验问题：

1. **启动慢**：`pnpm dev:desktop` 链路中 `scripts/build-desktop-agent-cli.mjs` 每次启动
   **无条件重建** 11 个 workspace（tsc × 11 + CLI esbuild bundle + 暂存），实测 30.8s，
   是启动耗时的大头。
2. **内存高**：dev 渲染进程 ~1.5GB RSS、JS 堆 GC 后 145MB（非泄漏，dev 页面结构性开销）；
   dev 工具链（vite/tsup/esbuild）约 500MB；MCP 服务器在 runtime 构造时急切连接。
3. **CPU 高**：React dev runtime（jsxDEV/validate）+ GC 税是 dev 框架成本；
   应用侧可改热点为文件树行渲染未 memo 化。

## 改动一：agent CLI 构建输入指纹门（启动提速）

### 行为

- `build-desktop-agent-cli.mjs` 的默认 pnpm 构建路径（非 turbo、非 bootstrap 复用路径）
  顶部增加**输入指纹**判断：
  - 指纹输入：`ZCODE_ENV`、`ZCODE_DESKTOP_AGENT_BUILD_MODE`、`ZCODE_BOOTSTRAP_WITH_REMOTE`
    （构建产物随这些环境变量变化）、`pnpm-lock.yaml` 摘要、11 个纳管 workspace 的
    `src/**` 与 `tsconfig.json` 的 stat 指纹（相对路径 + size + mtimeMs）。
  - 指纹与上次成功构建一致且 dist 入口存在 → **跳过重建**，仅执行暂存
    （`stageDevAgentBundle`，幂等且便宜），打印 skip 日志。
  - 环境变量 `ZCODE_DESKTOP_AGENT_FORCE_BUILD=1` 强制重建（逃生通道）。
  - 构建成功后写指纹到 `node_modules/.cache/zcode-dev-agent-build/stamp.json`。
- turbo 路径与 bootstrap 复用路径已有各自缓存/复用逻辑，不改。

### 状态所有者

- 构建脚本是指纹的唯一写入者；stamp 文件是唯一持久事实；无第二写入路径。

### 验收

- **AC-P1** 输入未变时连续两次运行：第二次打印 skip 日志且总耗时 < 3s（基线 30.8s），
  暂存仍执行。
- **AC-P2** 修改任一纳管包的 src 后运行：走全量构建并更新 stamp。
- **AC-P3** `ZCODE_ENV` 变化后运行：不命中 skip（test/production 产物不同）。
- **AC-P4** `ZCODE_DESKTOP_AGENT_FORCE_BUILD=1` 无条件全量构建。

## 改动二：vite dev server 预热（首屏提速）

- `packages/desktop/vite.config.ts` 增加 `server.warmup.clientFiles`：预热渲染进程入口
  模块图的高频模块，server 就绪后立即后台 transform，窗口首帧等待的转换提前完成。
- 仅影响 dev 模式加载时序，不改变产物与运行时行为。

### 验收

- **AC-P5** 配置后 vite dev 启动无报错，首屏加载不劣化（预热为并行优化）。

## 改动三（测量后降级为观察项）：文件树行渲染

- 实测（CDP 分配/CPU 采样）：`WorkspaceFileTreeRowView` 行重渲染 + 目录聚合
  `getWorkspaceDirectoryGitStatuses` 合计仅 ~0.4% 采样，DOM 变更 5 秒仅 18 批——
  **不是热点**。且其 props（gitStatusByPath/rows/labels 对象）每轮轮询都换引用，
  有效 memo 需要重构数据 hook 的引用稳定性，侵入性与收益不成比例。
- **决策：不做**。保持观察：若后续 Profile 显示行渲染占比上升（如大仓库/长会话），
  再按「数据 hook 返回引用稳定化 + 行组件 React.memo」的组合方案实施。

## 改动四：MCP 服务器懒连接（空闲内存）

### 行为

- 删除 `AgentRuntime` 构造器中的 `runtime.startMcpStartup(...)` 急切调用（唯一改动点）。
- 连接改由「首次真实使用」触发，既有触发点全部保留且幂等：
  - `ensureContextInitialized`（context.ts，首个 turn 的上下文初始化）
  - `initializeMcp`（turn-loop.ts:106，**首个 provider 请求前必等**；compact-active、
    plugin-reference 同样幂等触发）
  - 子代理 MCP 借用 await `mcpStartupPromise`（先经 initializeMcp 保证已启动）
- 消费方兼容性（已逐一核对）：`plugin-reference.ts` 对 `mcpStartupPromise === undefined`
  已有分支；subagent 借用路径经 `shouldBorrowParentMcp` + startup promise，均在首次
  turn 后调用，promise 必已在场。
- `mcpInitialized`/`mcpToolsRegistered` 幂等门保持不变。

### 时序变化（唯一取舍）

```text
旧行为：CLI 进程启动 → 构造器 → 立即拉起全部 MCP server（即使会话从不发消息）
新行为：CLI 进程启动 → 空闲会话不启动 MCP
        首条消息 → turn-loop initializeMcp → 连接+注册工具 → 再发 provider 请求
```

代价：首条消息额外承担 MCP 连接时长（OAuth 场景上限 15s，已有
`MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS` 封顶）；收益：空闲会话省
3 个子进程 ≈ 300-500MB。UI 设置页在会话未发过消息时如实显示「未连接」。

### 验收

- **AC-M1** 打开会话但不发消息：无 MCP server 子进程（`ps` 无 mimosa/flowpilot 等）。
- **AC-M2** 发首条消息后：MCP 连接完成、工具注册日志（mcp.tools.registered）出现，
  模型工具面与旧行为一致。
- **AC-M3** 子代理派生借用父 MCP：行为不变（既有 core 测试覆盖借用路径）。

## 改动五：dev 渲染进程产物模式（渲染进程内存大头的解法）

### 行为

- 新增 `pnpm dev:desktop:built`：渲染进程从 vite dev server 切到 `vite build --watch`
  产物模式，Electron 走既有 `loadFile(out/renderer/<page>.html)` 路径加载
  （`desktopHostProcess.ts` 的 `ELECTRON_RENDERER_URL` 分支已内建该形态，不新增加载逻辑）。
- `scripts/dev.mjs` 增加 `--renderer=built`：等待条件从「vite server 可达」改为
  「`out/renderer/index.html` 存在」；启动 Electron 时**不注入** `ELECTRON_RENDERER_URL`
  （并剥离 shell 继承值，防劫持）。
- 构建用 vite 默认 production mode：`NODE_ENV=production` → 生产 React（无 jsxDEV 校验）、
  压缩产物 → V8 code space 大幅缩小。`__ZCODE_LOCAL_DEVELOPMENT_RUNTIME__` 变为 false，
  唯一下游是遥测 deploymentEnvironment 标注（userActionTraceBootstrap.ts），影响可忽略。

### 取舍（明确告知）

- **失去 HMR**：改代码后 vite 重建产物，窗口需手动刷新（Cmd+R / Ctrl+R）才加载新代码。
- 首次启动需等完整产物构建（~1500 模块，数十秒量级），之后 watch 增量重建为秒级。
- 主进程/host 仍走 tsup watch，不受影响。

### 验收

- **AC-R1** `vite build` 一次成功产出 `out/renderer/` 三入口（index/resource-manager/
  cua-permission-panel）。
- **AC-R2** `dev:desktop:built` 启动后 Electron 加载 `file://` 产物（无 :5174 网络连接）。
- **AC-R3** 渲染进程 RSS 显著低于 dev server 形态（预期 1.5GB → 数百 MB 量级），
  jsxDEV/GC 税消失。

## 改动六：dev 静态挂机模式（零 watch 进程）

### 背景

实测发现改动五（built+watch）的净收益≈0：`vite build --watch` 进程自身持有完整
构建图缓存 ~1.38GB，渲染进程省下的 1.17GB 被构建进程等量吃回。内存只是搬家。

### 行为

- 新增 `pnpm dev:desktop:static`：`tsup`（一次性，无 watch）→ `vite build`（一次性）
  → `dev.mjs --renderer=built` 启动 Electron。构建完成后 tsup/vite 进程全部退出，
  **运行期零 watch 进程**（无 vite/tsup/esbuild 常驻）。
- 构建标记（onSuccess ready markers）一次性构建同样写入，Electron 等待逻辑不变。
- 每次启动都重建（tsup 1s + vite 7s，实测）：保证产物与源码一致，不做产物新鲜度缓存
  （agent CLI 构建已有指纹门，不在本链路重复）。

### 取舍

- 源码变更不生效（无任何 watch）：改 UI 后重跑 `pnpm dev:desktop:static`（约 +8s）。
- 适合长时间挂机/演示场景；活跃 UI 开发用 `dev:desktop`（HMR）或 `dev:desktop:built`。

### 验收

- **AC-S1** 静态模式运行期 `ps` 无 vite/tsup/esbuild/concurrently 进程。
- **AC-S2** 总内存（zcode 全家桶 RSS）显著低于 built+watch 形态（预期 −1.3GB 以上）。
- **AC-S3** 启动链路：tsup+vite 一次性构建退出码 0，Electron 正常加载 file:// 产物。

## 非目标（本 spec 边界）

- 不重启用 Electron 上游默认禁用的 `MacWebContentsOcclusion`（对抗上游默认，风险大）。
- 不做 MCP 空闲自动关停（连接后常驻；懒化已覆盖空闲会话的大头）。
- 不做产物重建后的窗口自动刷新（保持改动面最小；手动刷新即可）。

## 日志

- 构建脚本 skip/force 走 stdout（构建工具链路）；不落凭据与用户数据。
