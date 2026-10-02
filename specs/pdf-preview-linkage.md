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

| 项 | 现状 | 增量 |
| --- | --- | --- |
| 预览 | 附件预览为对话框式（`ChatMediaAttachmentPreviewDialog.tsx`） | 新增常驻预览面板 |
| 解析 | `read-pdf.ts` handler 已解析 PDF 内容 | 复用其文本提取做片段匹配，新增「页码↔内容」映射 |
| UI | 无常驻面板 | pdf.js 常驻面板 + 高亮层 |

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
