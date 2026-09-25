# Spec：Repo Wiki 与文件浏览编辑

## 目标

1. **Repo Wiki**：为当前 workspace 提供由 Agent 生成、UI 可浏览的仓库 wiki（`~/.zcode/v2/repo-wiki/<workspace-hash>/wiki.json`）。
2. **文件浏览编辑**：侧边面板新增「文件」面板 tab，从中选择文件以标签页打开浏览；文本文件可编辑并保存写回磁盘。

## 非目标（v1 边界）

- 不做编辑冲突检测/乐观锁（保存即覆盖磁盘内容，见「失败语义」）。
- 不做 wiki 的自动定时再生；再生由用户显式触发。
- 不新增文件创建/删除/重命名；文件树仅浏览，编辑仅在已打开的文件预览内进行。

## 一、文件浏览面板（file-explorer）

### 行为

- 侧边面板新增 workspace 级单例 tab：`FileExplorerSidePaneTab { id: "file-explorer", type: "file-explorer" }`。
- tab 内容复用现有 `WorkspaceFileTree` 组件（与左侧栏滑出层同源），展示当前 workspace 文件树。
- 点击文件 → 走既有 `onOpenPreview` → `openCodeViewerSidePane` 链路，在侧边面板以 code-viewer 标签页打开。
- 入口：侧边面板 tab 条 + Quick Pick 命令 `openFileExplorerTab`。

### 状态所有者

- tab 列表与激活态：side pane store（既有唯一所有者，不新增并行状态）。
- 文件树展开态：`WorkspaceFileTree` 组件内部（既有）。

## 二、文件编辑（live editor + save）

### 行为

- **预览即编辑器（live editor，v2 修订）**：code-viewer 的 `file` source 满足以下全部条件时，
  预览直接就是可编辑表面，不再设显式「编辑」按钮：
  有 `tabId`、文本（`!isBinary`）、未截断（读取返回 `truncated` 时按文件过大处理，
  与现有 readTextFile 语义一致）、字节数 ≤ `FILE_VIEWER_MAX_TEXT_BYTES`。
- 编辑表面 = Shiki token 高亮层 + 透明 textarea 覆盖层（文字透明、光标可见），
  两层共享同一字体度量，输入时语法色彩实时保留，无模式切换。
- 编辑会话（fileEditorStore，key=tabId）在**首次输入时懒创建**，以当时磁盘内容为基线；
  脏时头部出现「未保存 / 放弃 / 保存」，保存（按钮或 `Mod+S`）写回磁盘，放弃回到基线。
- markdown 默认预览态；切到「源码」模式进入同一编辑表面。
- IDE 编辑行为：行号槽（受 `codePreviewSettings.showLineNumbers` 控制；
  wrap 模式下视觉行与逻辑行不对齐，隐藏行号）；`Tab`/`Shift+Tab` 行缩进与反缩进；
  `Enter` 继承当前行缩进（行尾为 `{`/`[`/`(` 时追加一级）；IME 组合期间的 Tab/Enter 不拦截。
- 关闭带脏草稿的 tab 时弹出确认（复用 confirmDialog），确认后丢弃草稿并关闭；
  tab 切换不丢草稿，tab 关闭时 `discardDraft` 清理。
- 保存调用新增的 `IFileService.writeTextFile({ path, content })`；远程 workspace 经同一 service channel 由远程 Host 执行，与读路径对称。

### 状态所有者与事件顺序

```text
磁盘文件（事实源）
   ↑ writeTextFile（原子写）
编辑草稿 store（fileEditorStore，key=tabId）：draft / baseline / saving / error
   ↑ 读（readTextFile）
PreviewPane（视图）：live editor 渲染、懒建会话、Mod+S
```

保存事件顺序：`saving=true → writeTextFile → 成功：baseline=draft、saving=false`；失败：`saving=false、error 展示、草稿保留`。重复保存幂等（同内容覆写无害）。

### 失败语义

- 写失败（权限/只读/网络断开）：错误以行内提示展示，草稿不丢，可重试。
- v1 不做基线过期检测；保存即覆盖。spec 明示该取舍，后续如需冲突检测在此扩展。
- 不活动 tab（`renderHeavyContent=false`）不渲染编辑表面（Shiki 对大文件开销高），
  渲染既有延迟占位；草稿保留在 store，切回时恢复。

### 服务契约（shared/services）

- `IFileService.writeTextFile(params: { path: string; content: string }): Promise<{ bytesWritten: number }>`
- Host 实现：utf-8 写入；复用 `atomicWriteText` 保证原子性（tmp + rename）。
- UI 不得绕过 IFileService 直接访问 `window.zcode` 或 Node fs。

## 三、Repo Wiki

### 存储约定（对齐官方 zcode wiki 格式）

- 目录：`<home>/.zcode/v2/repo-wiki/<workspace-hash>/wiki.json`。
- `workspace-hash` = sha256(绝对 workspacePath) 前 **12** 位十六进制——与官方版一致
  （6 个历史样本逐一验证）。前缀宽度与官方对齐后，官方版已生成的 wiki 本地可直接阅读。
- `wiki.json` 信封（宽松归一，缺字段容忍）：`{ wikiId?, repoId?, workspaceKey?,
  workspacePath?, language, generationModel?, manifestHash?, context?, catalogTree?,
  pages, createdAt?, updatedAt }`。
- 页面：`{ id, parentId?, title, order?, description?, filePaths?: string[],
  markdown, sources?: [{path, startLine?, endLine?}], createdAt?, updatedAt? }`。
- 目录树：优先读信封 `catalogTree`（`{id,title,order,children,pageId?}` 递归节点，
  允许纯分组节点）；缺失时按 `parentId` 派生；再缺失则按 `order` 平铺。
- 磁盘为唯一事实源；UI 不缓存页面内容，激活期间 2.5s 轮询重读。
- 页面 sources / markdown 内 `path#L行号` 引用 → code-viewer 打开；
  mermaid 代码块 → 既有 streamdown mermaid 插件渲染。

### 视图与行为（对齐官方「仓库 Wiki」，docs: zcode.z.ai/cn/docs/repo-wiki）

- 主区视图 `WorkspaceMainView = "repo-wiki"`（workspace 级）。布局自上而下：
  ①顶栏 ②项目名 + 元数据 ③（生成中）状态条与进度条 ④左右两栏。
- 顶栏按生成状态门控：
  - 生成中：仅「停止」（stop 生成会话，已完成页面保留）。
  - 空态：主区居中展示**可选配置表单**（语言 / 模型 / 重试次数 / 生成图表逐行可选，
    与顶栏共用同一份受控状态）+ 存储路径 + 「生成 Wiki」按钮；顶栏无控件。
  - 已生成/空闲：删除 Wiki · 重新生成 · 语言（中文简体/English，初值跟随界面语言）·
    模型（初值=模型视图 `preferredSelection`，"默认"不覆盖）· 重试次数（0/1/2/3，
    默认 0）· 生成图表开关（默认开）。生成选项为视图态（不持久化）。
- 元数据默认折叠为「元数据」badge，点击展开：分支（`gitService` summary
  `branchName`，非 git 隐藏）· 语言 · 更新时间（wiki.json `updatedAt`）·
  提交 ID（`getCommitGraph maxCount=1` 短哈希）· 文件数（`listWorkspaceFilesLength`）。
- 生成状态机（磁盘推导，无独立服务状态）：
  - wiki.json 不存在 → 阶段「正在分析代码库」（进度条不显示 N/M）。
  - 存在且含未完成页（markdown ==「生成中」/「生成失败」精确标记）→
    「正在生成页面 done/total」+ 进度条 + 当前页名（目录序第一个未完成页）。
  - 全部完成 → 空闲（完整控件回归）。停止/失败不影响已完成页面的阅读。
- 页面状态进目录树：进行中页（目录序第一个未完成）标「正在生成」，其余未完成标
  「等待生成」，失败标记页标「生成失败」（目录区显示失败计数）；已完成正常，
  未完成页条目置灰不可选。
- 两栏：React ResizablePanelGroup 横向，目录面板可拖宽、可整体收起（「项目」头 +
  收起/展开柄）；窄面板自动上下堆叠记为后续。
- 目录：分组节点 = 小节标题（不可选中）；页面节点 = 标题 + `description` 副标题
  （+ 生成中状态行）。
- 入口：文件树面板头项目名右侧「仓库 Wiki」图标（已接 `onOpenRepoWiki`）；
  远程只读/断连时隐藏入口（记录为约束）。
- 「返回对话」切回 `chat`；默认选中页 = 目录树深度优先第一个已完成页面节点。

### 删除 Wiki

- 顶栏「删除 Wiki」（仅空闲态显示）→ `useConfirmDialog` 确认 →
  `IFileService.deleteFile({ path })` → `{ deleted: boolean }`（不存在返回 false）。
- 只删 `wiki.json` 文件本身，不递归删目录；删除成功后回到空态卡片。
- 失败（权限等）：toast 报错，视图保持现状。远程 workspace 走同一 service channel。

### 生成（与对话 composer 解耦；跨重挂载可停止）

- 「生成/重新生成」由 workbench 直接经任务运行时发起后台生成任务：
  `acquireWorkspaceConnection(scope, zcodeAgentService)` 取连接租约 → 发**单条**
  `createSession { workspaceId = workspaceIdentity?.trim() || workspacePath,
  firstInput: { text: <i18n 生成提示词> }, config?{ modelSelection } }`
  （建会话即启动首条输入，协议既有语义）。
- 明确不走 composer：不做 window 事件投递、不填草稿、不要求已打开对话。
- 提示词语言跟随界面语言（`useZCodeIntl` 的 `locale`，`buildRepoWikiGeneratePrompt` 纯函数，含单测）。
- 生成深度对齐官方版（用户可对照的历史基准：11–58 页）：
  - 规划 10–30 个主题深潜页（小仓库 5–10 页），4–8 个分组节点组织目录树；
  - 每页 description + filePaths + sources（行级）+ markdown 目标 3000–8000 字；
  - mermaid 图按文档措辞：只在确有帮助且有源码依据处生成（架构/流程/时序/状态），
    开关关闭时全部用文字表达（等价官方 `generateDiagrams`）；
  - 未完成页 markdown 一律精确写「生成中」、失败页写「生成失败」；单页失败自动重试
    最多 retryPerPage 次（默认 0，顶栏可调）；
  - 先落目录骨架、再逐页补全并即时落盘（阅读端目录先现、页面渐进补齐）。
- 进程内会话登记表（module 级 Map：workspaceId → sessionId）跨 workbench 重挂载存活；
  「停止」= 向登记 sessionId 发 `stop {}`（v4 协议命令，payload 可为空），
  已落盘页面保留、视图转空闲。
- pending 为 hook 本地防双击态；生成进度只从 wiki.json 轮询推导（`summarizeWikiGeneration`）。
- 成功后停留在 repo-wiki 视图；新会话经既有 sessions-index 刷新出现在任务列表。
- 失败语义：`createSession` 被拒/抛错 → 无会话残留、wiki.json 不变、toast 报错；
  生成中途失败/停止 → wiki.json 保持最后成功状态，已完成页面照常阅读。
- 后续（记录不实现）：每轮对话结束自动检查代码变化增量刷新；单页重生成；历史版本；
  中英文并存（换语言重生成覆盖，与官方一致）；窄面板上下堆叠。

### 状态所有者与事件顺序

```text
wiki.json（磁盘，内容事实源）
   ↑ Agent turn 渐进写入（先目录骨架，后逐页）
useRepoWikiWorkspace（读层：2.5s 轮询 + generation 计数防 stale）
   ↑ phase: resolving → missing|ready；目录树派生
RepoWikiWorkbench（视图）：选中页 = 本地视图态，不持久化
   ↓ 点击「生成」
useRepoWikiGeneration：pendingRef 防双击 → createSession{firstInput} → ACK
   （rejected/异常 → toast，无会话；accepted → release 租约，toast 已开始）
```

- 已移除契约：`zcode:composer-prompt-request` window 事件及 composer 侧监听
  （旧设计把生成动作路由到 UI 元素，而 repo-wiki 视图本身会卸载 composer，主路径必然失败）。
- 旧 v1 的 `*.md` 多文件布局废弃，读取端只认 wiki.json。

## 四、跨切面

- 新 UI 遵守 `DESIGN.md`：`text-ui-*` 字号、语义色 token、按钮/圆角既有体系；复用 `packages/ui/src/components/ui/` 原语。
- i18n：zh-CN / en-US 同步补 key，不得硬编码文案。
- 纯逻辑（wiki 路径/链接解析）抽为 `packages/ui/src/lib/repoWiki.ts` 纯函数并配单测。
- 架构边界：ui → services 仅经公开入口与 service descriptor（`useWorkspaceServices`）；shared 仅类型/描述符；services 不反向依赖 ui。

## 五、验收场景

1. Quick Pick / 面板入口打开「文件」面板 → 显示当前 workspace 文件树。
2. 面板中点击文本文件 → 侧边面板新增 code-viewer 标签页并显示内容。
3. 打开文本文件预览 → 直接可编辑（输入保留语法高亮）→ `Mod+S` 或「保存」→ 磁盘内容更新，
   关闭重开显示新内容；保存成功后脏标记消失且停留在编辑态。
4. 二进制、截断、超大文件保持只读预览，不渲染编辑表面。
5. 脏草稿状态下关闭 tab → 弹确认；取消则保留。Tab 缩进、Shift+Tab 反缩进、
   Enter 继承缩进行为正确；`showLineNumbers` 开关控制行号槽，wrap 模式下无行号；
   IME 组合期间 Enter/Tab 正常上屏。
6. 打开「Wiki」主视图：无 wiki 显示空态；点「生成 Wiki」→ 直接发起后台生成任务
   （不依赖已打开对话、不弹「未找到输入框」）；被拒时 toast 报错且无会话残留。
7. Agent 生成过程中 repo-wiki 视图目录先出现、页面逐页补齐（轮询 wiki.json）；生成会话出现在任务列表。
8. `pnpm architecture:check --changed`、`pnpm typecheck`、`pnpm lint` 全部通过（如实报告）。
