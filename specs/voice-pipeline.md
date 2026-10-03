# Spec：语音链路（ASR 转写 + TTS 合成）

对齐 MiMo Desktop 的 `asr_transcribe` / `tts_speech` 桌面工具面，为 ZCode 补齐语音能力。

## 目标

1. 新增两个 agent 工具：`asr_transcribe`（音频→文本）与 `tts_speech`（文本→音频）。
2. 语音能力作为 **provider 能力项**接入，端点/模型走 provider 配置，不硬编码到工具内。
3. 桌面端提供麦克风采集入口；采集结果落盘为音频文件后走同一工具链路。
4. 生成/转写产物以附件形式进入会话（复用现有附件与 media-preview 通道）。

## 现状与增量

| 项        | 现状                                                                                              | 增量                                                                                                                                                                                                                                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| contracts | `apps/zcode-cli/packages/contracts/src/tools/` 有现成工具契约模式（参照 SessionTalk 契约）        | 新增 `asr-transcribe` / `tts-speech` 的 Input/Output Schema                                                                                                                                                                                                                                                                                                         |
| provider  | `packages/provider` 无语音能力接口                                                                | 新增 `properties.capabilities.transcription` / `capabilities.speech` 能力声明（转写与合成通常是不同模型，如 whisper-1 与 tts-1，故分两个叶子）                                                                                                                                                                                                                      |
| adapters  | 无语音端点调用                                                                                    | `@zcode/adapters/generation` 新增 OpenAI 兼容 `/audio/transcriptions`（multipart）与 `/audio/speech`（JSON）调用                                                                                                                                                                                                                                                    |
| 内置配置  | `provider-node/src/zcode-builtin-provider-config-source.ts` 维护内置 provider                     | 端点与模型名通过能力声明配置驱动（见「端点能力声明与适配器」）；默认写哪个模型条目仍待产品确认（**待定项①**收敛为「给哪个内置/个人模型条目加字段」）                                                                                                                                                                                                                |
| core      | `apps/zcode-cli/packages/core/src/tool/handlers/` 有只读工具模式（参照 `read-image.ts` handlers） | 新增 `asr-transcribe.ts` / `tts-speech.ts`，在 `tool/index.ts` 注册                                                                                                                                                                                                                                                                                                 |
| desktop   | 无麦克风采集入口                                                                                  | renderer composer 录音入口（getUserMedia + MediaRecorder；**定位：发送键左侧紧邻**——产品确认，从 leadingActions 移入 submitControlNode 控制簇）→ 经 `IPlatformService.createTempVoiceAttachment` 平台通道落盘宿主 `~/.zcode/tmp/voice-recordings/`（复用粘贴附件的落盘模式，而非 host 进程），产物作为 localPath 附件进入会话，模型用同一 `asr_transcribe` 工具转写 |

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
桌面麦克风采集（renderer composer：getUserMedia + MediaRecorder）
  → 音频 Blob → base64 → IPlatformService.createTempVoiceAttachment（Electron IPC）
  → 音频文件（宿主 ~/.zcode/tmp/voice-recordings/<date>/，与粘贴文本附件同一落盘家族）
  → composer localPath 附件 → agent 收到文件路径引用
  → asr_transcribe handler（core）→ provider 能力扫描（bootstrap）→ adapters /audio/transcriptions → 文本
tts_speech handler（core）→ provider 能力扫描（bootstrap）→ adapters /audio/speech
  → 音频文件（artifacts/）→ 附件通道 → media-preview 播放
```

- 录音产物的唯一落盘通道是 `createTempVoiceAttachment` 平台通道；录音不在 renderer 持久化，也不绕过平台通道直写文件。tts_speech 产物的唯一落盘点仍是会话工作区 artifacts 目录。
- 采集入口的能力门控：`getUserMedia` 与 `MediaRecorder` 均可用且平台通道存在才显示入口；Web/无宿主环境隐藏入口（能力检测，不报错）。
- provider 能力是语音端点的唯一所有者；工具描述不包含端点细节。

## 麦克风权限（桌面）

- `session.defaultSession.setPermissionRequestHandler`：`media` 请求仅放行纯音频（`mediaTypes ⊆ ["audio"]`），含视频一律拒绝（应用无摄像头场景）；其余权限类别维持 Electron 默认放行，不改变既有行为。
- 内置浏览器 partition（`persist:zcode-embedded-browser`）不受该策略影响，由 desktopNetworkPolicy 既有边界管理。
- renderer `getUserMedia` 被拒（NotAllowedError 等）时 fail-closed：入口显示可读提示，不静默重试。
- macOS 打包产物在 Info.plist 声明 `NSMicrophoneUsageDescription`；系统级授权由 OS TCC 管理，Electron handler 只做方向收口。

## 端点能力声明与适配器（A2）

与图像能力（specs/image-tools.md）同一套机制，启用条件完全配置驱动：

1. **能力声明**：模型条目 `properties.capabilities.transcription: true` 声明
   ASR（转写），`capabilities.speech: true` 声明 TTS（合成）。两者独立声明、
   独立扫描——同一条目可同时声明，但 OpenAI 兼容生态中通常是不同模型
   （whisper-1 / tts-1）。字段同样位于
   `packages/shared/src/model-config.ts`，sparse 与 complete 均可选。
2. **能力扫描（bootstrap seam）**：`VoicePipelinePort` 的 `transcribe` 扫
   `transcription`、`synthesize` 扫 `speech`；每次调用现读 Registry 视图，
   首个命中且凭据可用的条目即用；凭据从该 provider 条目解析。未命中保持
   既有可读未配置错误，不发起网络请求。
3. **端点适配器（`@zcode/adapters/generation`）**：转写
   `POST {baseUrl}/audio/transcriptions`（multipart：file + model +
   language?），合成 `POST {baseUrl}/audio/speech`（JSON：model + input +
   voice?）。网络统一走 adapters 代理感知 fetch；错误归一化同图像端点，
   超时取 `VOICE_TOOL_TIMEOUT_MS`（core handler 常量）。合成响应按
   Content-Type 判定 MIME（缺省 `audio/mpeg`）。

## 权限与边界

- 麦克风访问属于系统级能力：系统授权由 OS 隐私设置（macOS TCC / Windows 隐私）裁决，
  Electron 侧在 defaultSession 权限处理器上做「纯音频放行、含视频拒绝」收口（详见
  「麦克风权限（桌面）」节）；renderer `getUserMedia` 被拒时 fail-closed 并返回可读提示。
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
4. 无任何条目声明 `capabilities.transcription` / `capabilities.speech` 时，对应工具返回可读未配置错误，不发起任何网络请求。
5. 端点 4xx/5xx/网络失败/超时映射为可读工具失败（recoverable）。

## 验证

- `pnpm typecheck`；`pnpm architecture:check --changed`。
- handler 测试用固定音频样本断言调用链与落盘契约（不 mock 文件系统；模型端点用固定响应）。
- 适配器单测（fake http 入口，不真实联网）：multipart/JSON 请求构造与错误归一化。
- seam 单测（fake 配置源）：transcription/speech 独立扫描与未配置错误。
- 桌面采集改动补 E2E 场景（授权/拒绝两分支）。

## 待定项

1. 默认端点与模型名：机制已定为能力声明（哪个 provider 模型条目加 `capabilities.*` 字段由产品确认）；默认不内置任何声明。
2. 语音输入是否同时覆盖 TUI（当前 v1 仅桌面）。
