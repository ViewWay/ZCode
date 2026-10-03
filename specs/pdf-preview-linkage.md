# Spec：PDF 预览联动（pdf_locate 等价物）

对齐 MiMo 的 `pdf_locate`：模型回答引用 PDF 原文时，桌面预览面板滚动到对应页并高亮
片段。

## 目标

1. 桌面新增常驻 PDF 预览面板（pdf.js 渲染，复用 read-pdf 的解析基础）。
2. 新增 `pdf_locate` 工具：`{file, snippet, page}` → 预览滚动定位 + 高亮；匹配失败
   降级为翻页。
3. 工具仅在桌面形态注册（TUI/Web 无预览面板不注册，而非报错）。
4. 文件未在预览中打开时自动打开。

## 现状与增量

| 项     | 现状                                                             | 增量                                                                                                                                                                                                                |
| ------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 预览   | 附件预览为对话框式（`ChatMediaAttachmentPreviewDialog.tsx`）     | v1 务实范围：定位消费面复用常驻 `PreviewPane`（present_files 自动打开同一条 `onOpenCodeViewer` 链路）；对话框渲染切换到定位可用查看器                                                                               |
| 解析   | `read-pdf.ts` handler 已解析 PDF 内容                            | 复用其文本提取做片段匹配，新增「页码↔内容」映射（已交付：core 匹配器 + `pdf_locate` 工具面）                                                                                                                        |
| UI     | 无定位消费                                                       | `pdf_locate` 工具卡按名认领（present_files 同款），完成后一次性发布定位请求到 UI 内 `pdfLocateStore`                                                                                                                |
| 查看器 | `components/ui/pdf-viewer.tsx`（三方目录，无定位 API，不可修改） | `packages/ui/src/pdf/` 新增 react-pdf 直接封装组件：命令式翻页/滚动到页 + 文本层高亮；预览面板与对话框切换到该组件                                                                                                  |
| 注册门 | 工具面已实现但休眠（`includePdfLocate` 缺省 false）              | Host 桌面形态（services `serviceAuthorityMode === "desktop-local"`）经 v4 createSession / legacy session/create 下发 `pdfLocateToolEnabled`，runtime-tools 以 `Boolean(flag) && taskType !== "subagent_child"` 接门 |

## 定位事件链（UI 链路增量）

不新建协议事件：`pdf_locate` 的工具调用记录本身就是定位指令的载体
（工具入参含 `file`/`snippet`，模型回显文本含权威 `status`+`page`，二者均已随既有
session 事件流下发到 renderer）：

```text
core handler（工具执行后返回 {status,page}，formatModelContent 产出回显文本）
  → 既有工具调用事件流（不改协议）
  → renderer pdf_locate 工具卡（按名认领，一次性消费 per toolCallId）
      → 发布 {filePath, page, snippet, status} 到 pdfLocateStore（UI 内 zustand，瞬态）
      → 经 onOpenCodeViewer（既有附件/媒体预览打开路径）打开/切换预览面板到该 PDF
  → PreviewPane：打开的 PDF 路径与请求匹配时消费 pending
  → 定位可用查看器：滚动到 page 顶部（必须）→ 文本层逐项匹配 snippet 高亮（尽力而为）
      → 文本层无匹配（提取误差/跨文本块）：保持仅翻页，UI 提示已翻到第 N 页
      → 文本层高亮（v1.1 已升级）：项内命中只包裹局部区间（归一化偏移映射回原文偏移，
        不吞原空白）；跨文本项=项为命中片段前缀/后缀且达长度门槛（≥4 字符）→ 整项
        标记；snippet 恒经 HTML 转义（模型输入不可信）。
```

- 状态所有者：pending 定位请求归 `pdfLocateStore`（renderer，瞬态，不持久化）；
  当前打开文件归 PreviewPane；页内高亮归查看器组件。
- 桌面形态门（renderer 侧）：platform 实现 `createLocalMediaPreviewUrl`
  （present_files 的 `isDesktopLikePlatform` 同款信号）；只读时间线等
  `onOpenCodeViewer` 缺席场景静默跳过自动打开。

## 注册门（桌面形态信号）

```text
desktop main（serviceAuthorityMode: "desktop-local"）
  → services zcodeAgentService（v4 createSession 信封 / legacy session/create 参数注入
    pdfLocateToolEnabled，远程 workspace 不注入）
  → CLI 协议 server materializeSessionRecord → runtimeConfig.pdfLocateToolEnabled
  → core runtime-tools：includePdfLocate = Boolean(flag) && taskType !== "subagent_child"
```

- TUI/headless/Web/远程形态不注入 → 缺省 false（fail-closed，fail-open 是接线故障）。
- subagent_child 不注册（与 automation/off-peak/image/voice 同款子会话禁令）。

## 工具契约（草案）

```text
pdf_locate:
  input : { file: 绝对路径, snippet: string, page?: number }
  output: { status: located | page_only | file_opened, page: number }
  语义  : 回答引用原文后调用一次；snippet 取自 PDF 原文、逐字匹配最佳，不要意译；
          非 PDF 文件不调用
```

## 面板与定位协议

```text
core handler → 契约事件 → renderer 定位服务
  → pdf.js 面板：滚动到 page → 全文检索 snippet → 高亮区间
  → 匹配失败 → 降级为仅翻页（page_only）
  → 文件未打开 → 先打开再定位（file_opened）
```

- 高亮层不修改 PDF 文件本身（对齐 MiMo "no effect on the file" 语义）。
- 面板生命周期归 renderer 路由管理；工具事件只是输入，面板是定位请求的唯一消费者。

## 非目标（v1 边界）

- 不做 Office 常驻预览面板（归 doc-env-bootstrap 后续评估）。
- 不做 PDF 批注/编辑。
- 不做跨会话的定位状态持久化。

## 验收场景

1. 模型回答引用 PDF 原文 → 预览自动滚动到对应页并高亮。
2. 片段因提取误差匹配失败 → 降级翻页，UI 提示"已翻到第 N 页"。
3. TUI/Web 形态工具不注册，无残留错误。

## 验证

- 匹配算法单测（精确匹配/归一化匹配/降级翻页三类用例）。
- E2E：打开-定位-高亮链路（本地 PDF 样本）。
- `pnpm typecheck`；`pnpm architecture:check --changed`。
