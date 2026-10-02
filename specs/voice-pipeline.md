# Spec：语音链路（ASR 转写 + TTS 合成）

对齐 MiMo Desktop 的 `asr_transcribe` / `tts_speech` 桌面工具面，为 ZCode 补齐语音能力。

## 目标

1. 新增两个 agent 工具：`asr_transcribe`（音频→文本）与 `tts_speech`（文本→音频）。
2. 语音能力作为 **provider 能力项**接入，端点/模型走 provider 配置，不硬编码到工具内。
3. 桌面端提供麦克风采集入口；采集结果落盘为音频文件后走同一工具链路。
4. 生成/转写产物以附件形式进入会话（复用现有附件与 media-preview 通道）。

## 现状与增量

| 项 | 现状 | 增量 |
| --- | --- | --- |
| contracts | `apps/zcode-cli/packages/contracts/src/tools/` 有现成工具契约模式（参照 SessionTalk 契约） | 新增 `asr-transcribe` / `tts-speech` 的 Input/Output Schema |
| provider | `packages/provider` 无语音能力接口 | 新增 asr/tts 能力定义；`packages/provider-node` 实现端点调用 |
| 内置配置 | `provider-node/src/zcode-builtin-provider-config-source.ts` 维护内置 provider | 默认 ASR/TTS 端点与模型名写入内置配置（**待定项①**：端点与模型名需产品确认） |
| core | `apps/zcode-cli/packages/core/src/tool/handlers/` 有只读工具模式（参照 `read-image.ts` handlers） | 新增 `asr-transcribe.ts` / `tts-speech.ts`，在 `tool/index.ts` 注册 |
| desktop | `packages/desktop/src/host` 无音频采集 | host 层新增麦克风采集入口，产出音频文件路径 |

## 工具契约（草案）

```text
asr_transcribe:
  input : { file: 绝对路径, language?: string }
  output: { text: string, duration_ms?: number }
  约束  : file 必须位于工作区内或用户显式授权路径；只读原音频，不修改

tts_speech:
  input : { text: string, voice?: string, output_path?: 工作区内相对路径 }
  output: { file: 绝对路径, duration_ms?: number }
  约束  : 输出落盘到会话工作区 artifacts 目录；回复指引要求模型把路径告知用户
```

## 状态所有者与数据流

```text
桌面麦克风采集（desktop host）
  → 音频文件（会话工作区 artifacts/）
  → asr_transcribe handler（core）→ provider asr 能力（provider-node）→ 文本
tts_speech handler（core）→ provider tts 能力（provider-node）
  → 音频文件（artifacts/）→ 附件通道 → media-preview 播放
```

- 音频文件唯一的落盘点是会话工作区 artifacts 目录；handler 不自行选择其他位置。
- provider 能力是语音端点的唯一所有者；工具描述不包含端点细节。

## 权限与边界

- 麦克风访问属于系统级能力：走桌面权限代理（对齐 `cua-permission-broker` 的模式），
  未授权时 fail-closed 并返回可读提示。
- ASR 为只读工具（不改文件）；TTS 只写 artifacts 目录。
- `NOTICE.md` 第二节补一行：音频内容将发送至语音服务端点。

## 非目标（v1 边界）

- 不做实时流式语音输入（边说边转写的对讲体验放 v2）。
- 不做本地推理（onnxruntime 离线 ASR/TTS 另立 spec）。
- 不做多音色克隆/音色管理，voice 参数仅支持内置配置枚举。

## 验收场景

1. 用户给一个 mp3/wav 路径，模型调用 `asr_transcribe` 返回文本，原文件未被修改。
2. 用户要求"把这段总结读出来"，模型调用 `tts_speech`，聊天里出现可播放的音频附件。
3. 未授权麦克风时，桌面采集入口被拒并给出提示；工具面无麦克风依赖时不受影响。

## 验证

- `pnpm typecheck`；`pnpm architecture:check --changed`。
- handler 测试用固定音频样本断言调用链与落盘契约（不 mock 文件系统；模型端点用固定响应）。
- 桌面采集改动补 E2E 场景（授权/拒绝两分支）。

## 待定项

1. 默认 ASR/TTS 端点与模型名（写入内置 provider 配置）。
2. 语音输入是否同时覆盖 TUI（当前 v1 仅桌面）。
