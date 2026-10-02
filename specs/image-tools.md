# Spec：图像生成/编辑工具（image_gen / image_edit）

对齐 MiMo Desktop 的 `image_gen` / `image_edit` 工具：模型可生成与编辑图片，产物落盘
并进入现有附件预览。

## 目标

1. 新增 `image_gen`（文生图）与 `image_edit`（图生图/局部编辑）两个 agent 工具。
2. 图像端点作为 provider 能力实现，复用依赖中已有的 `@ai-sdk/provider` image-model 接口（v2/v3）。
3. 产物落盘到会话工作区，路径由模型在回复中告知用户（对齐 MiMo 的行为语义）。
4. 预览复用现有附件预览，不新做图像预览组件。

## 现状与增量

| 项 | 现状 | 增量 |
| --- | --- | --- |
| 依赖 | `@ai-sdk/provider` 的 image-model 接口已在依赖树（当前仅类型被引用） | provider-node 落地 imageModel 实现 |
| contracts | `contracts/src/tools/` 现成契约模式 | 新增 `image-gen` / `image-edit` 契约 |
| core | handlers 注册于 `tool/index.ts` | 新增 `image-gen.ts` / `image-edit.ts` |
| UI | `packages/ui/src/ChatMediaAttachmentPreviewDialog.tsx` 已有媒体预览 | 生成结果走该通道，UI 零新增组件 |
| 声明 | `NOTICE.md` 第二节「上传接口、对外请求」 | 补图像工具一行（提示词与参考图发送至图像端点） |

## 工具契约（草案）

```text
image_gen:
  input : { prompt: string, output_path?: 工作区内相对路径, size?: string }
  output: { file: 绝对路径, width, height }

image_edit:
  input : { file: 绝对路径(工作区内), prompt: string, output_path?: 同上 }
  output: { file: 绝对路径, width, height }
  约束  : 原图只读；编辑结果写为新文件，不覆盖原图
```

- 两个工具都要求在成功回复中把生成路径告知用户。
- 失败（端点错误/内容策略拒绝）返回可读错误，不落半成品文件。

## 状态所有者与数据流

```text
image_gen / image_edit handler（core）
  → provider imageModel 能力（provider-node，端点来自 provider 配置）
  → 会话工作区 artifacts/ 落盘（唯一写入点）
  → 附件通道 → ChatMediaAttachmentPreviewDialog 预览
```

## 权限与边界

- 按普通工具走现有权限判断（`apps/zcode-cli/packages/core/src/permission/service.ts`）。
- `image_edit` 的输入文件必须在工作区内或已授权的外部路径。
- 工具描述注明：提示词与参考图会发送至图像服务端点。

## 非目标（v1 边界）

- 不做本地扩散模型推理。
- 不做批量生成与画板式多图编辑。
- 不做素材库集成（image-search-plugin 保持独立，不合并）。

## 验收场景

1. 用户描述一张图，模型调用 `image_gen`，聊天出现图片附件卡片，文件在工作区。
2. 用户对已有截图说"把背景换成深色"，模型调用 `image_edit`，新文件生成且原图未变。
3. 端点未配置时，工具返回明确错误指引（去设置里配置图像模型）。

## 验证

- `pnpm typecheck`；`pnpm architecture:check --changed`。
- handler 测试：固定端点响应断言落盘路径、尺寸输出与"原图不被覆盖"约束。
- 权限用例：工作区外输入路径触发既有 external path 规则。
