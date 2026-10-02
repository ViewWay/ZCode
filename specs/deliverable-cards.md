# Spec：交付物卡片与交互组件（present_files / zwidget）

对齐 MiMo 的 `present_files` + `sci-widget` 机制：模型产出的交付物以卡片进入聊天流、
首个文件自动打开预览；回复中可内嵌自包含 HTML 交互组件。

## 目标

1. 新增 `present_files` 工具：模型声明交付物文件，UI 渲染为可点击卡片，第一个文件
   自动在预览面板打开。
2. 支持回复中的 ` ```zwidget` 围栏块：渲染为沙箱化交互组件（演示/模拟器/可调参数
   图表），交互不经过模型往返。
3. 安全模型：widget 运行在沙箱 iframe，无主进程访问、无同源权限、受 CSP 约束。

## 现状与增量

| 项 | 现状 | 增量 |
| --- | --- | --- |
| contracts | 工具契约与消息事件分属 `contracts/src/tools/`、`contracts/src/events/` | 新增 PresentFiles 契约；消息流新增 widget 块类型 |
| core | handlers 注册于 `tool/index.ts` | 新增 `present-files.ts`（仅声明交付物，不做文件操作） |
| UI | 附件预览为静态对话框（`ChatMediaAttachmentPreviewDialog.tsx`）；无卡片流、无 widget | 新增交付物卡片组件与 widget 容器；预览联动复用 media-preview 打开路径 |

## 工具契约（草案）

```text
present_files:
  input : { files: [绝对路径], note?: string }
  output: { accepted: [路径] }
  语义  : 只对"交付物/用户想保留或查看的文件"调用；中间产物、仅读过的依赖文件不调用；
          交互演示类需求改用 zwidget 而非生成临时文件
```

## zwidget 安全模型

```text
模型回复（```zwidget 围栏，内含自包含 HTML/CSS/JS）
  → 渲染层提取围栏 → sandbox iframe（无同源、无 node/electron 桥、无自动网络）
  → 组件内部交互自闭环；需数据时由渲染层在加载前静态注入，不做运行时桥接
```

- CSP 白名单：仅允许内联脚本（自包含场景），禁止外部 fetch；后续若放开网络须走显式
  审批。
- 安全用例（必须全绿才可发布）：iframe 内访问 `require`/`electron`/父窗口 DOM 必须
  失败。

## 状态所有者与数据流

```text
core：present_files handler → 契约事件 → ui 会话 store（卡片列表，随消息存储）
渲染层：消息中的 zwidget 块 → sandbox iframe 容器（生命周期随消息）
预览联动：卡片点击 → media-preview 打开；首卡自动打开仅在有预览面板的桌面形态生效
```

- 卡片与 widget 都是消息的派生渲染，不新建持久化状态；消息删除/会话清理时随消息消失。

## 开关策略

- zwidget 渲染默认开启（桌面 + Web），设置页提供开关（**待定项**：是否首版仅实验
  开关灰度）。
- `present_files` 在 TUI 无预览面板的形态下降级为纯文本清单输出。

## 非目标（v1 边界）

- 不做全功能 PDF/Office 预览面板（归 `specs/pdf-preview-linkage.md` 与文档环境 spec）。
- 不做 widget 市场、不做 widget 与模型的双向数据交互（运行时桥接禁用）。
- 不改写附件预览的现有交互。

## 验收场景

1. 模型产出 html 报告后调用 `present_files`，聊天出现卡片且首个文件自动打开预览。
2. 用户要求"做个可拖滑杆的图表演示"，模型用 zwidget 回复，滑杆交互即时生效、零模型
   往返。
3. widget 内尝试访问主进程 API 失败并被记录。

## 验证

- widget 沙箱安全用例（必测）；卡片渲染快照测试。
- 交互改动按仓库约定补 E2E 场景。
- `pnpm typecheck`；`pnpm architecture:check --changed`。
