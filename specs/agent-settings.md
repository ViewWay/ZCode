# Spec：agent 可调桌面设置（get_desktop_setting / set_desktop_setting）

对齐 MiMo 的 `get_desktop_setting` / `set_desktop_setting`：让模型在白名单范围内读写桌面设置；白名单外一律拒绝，写入路径唯一。

## 目标

1. 新增两个 agent 工具：`get_desktop_setting` / `set_desktop_setting`，设置项为**枚举白名单**（非开放 KV）。
2. 写入路径唯一：白名单项分两组映射到既有设置状态的所有者，不建第二状态源。
3. `set` 默认走 permission 确认（ask）；`get` 只读不确认。
4. 敏感项（凭据、网络出口、证书、权限相关、一次性迁移标记）永不进入白名单。

## 现状与增量

| 项        | 现状                                                                                                                                                                                                                                                                           | 增量                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| contracts | `contracts/src/tools/` 工具契约模式                                                                                                                                                                                                                                            | 新增两工具契约 + 白名单枚举与按 key value Schema         |
| 现有代码  | `AppSettings`（`packages/shared/src/protocol.ts:237`）由 `packages/services/src/setting/settingService.ts` 唯一持有（`~/.zcode/v2/setting.json`，appSettingsSchema 校验 + 写队列）；主题/外观为 renderer 侧独立 store（`packages/ui/src/store/appearancePreferencesState.ts`） | 经宿主端口桥接，复用各自既有 setter，不改所有者          |
| 端口      | SessionChatPort / SmartRoutingPort 同族模式（宿主提供实现、缺席 fail-closed）                                                                                                                                                                                                  | 新增 DesktopSettingsPort（宿主提供实现，缺席不注册工具） |

## 白名单（v1 草案）

```text
scope = app（AppSettings 直映，写经 settingService 唯一路径）:
  locale                      # 界面语言
  messageStreamShowReasoning  # 消息流是否展示思考过程
  messageStreamShowTodos      # 消息流是否展示 todo 渲染
  taskAutoArchiveEnabled      # 自动归档总开关

scope = appearance（renderer 主题 store，写经既有主题 setter 链路）:
  theme                       # light / dark / system
```

明确排除（写入时结构化拒绝）：`httpProxy` / `httpProxyNoProxy` / `httpProxyCaCertPath`（网络出口）、`embeddedBrowserAllowInsecureCertificates`（证书校验）、快捷键绑定、`*MigrationInitialized` 迁移标记类字段、外观深层自定义（appearance-settings.md 的颜色/字体/对比度——工具面只暴露 theme 整体切换）。

## 工具契约（草案）

```text
get_desktop_setting:
  input : { key: 白名单枚举 }
  output: { key, value, scope }

set_desktop_setting:
  input : { key: 白名单枚举, value: 按 key 的 Schema }
  output: { key, value, applied: true }
  约束  : 白名单外 key 或 value 不合 Schema → 可读结构化错误，不落部分写入
```

## 状态所有者与数据流

```text
core handler（get/set-desktop-setting.ts）
  → DesktopSettingsPort（契约端口，宿主提供实现，缺席不注册工具）
      ├─ scope=app        → settingService.update（唯一写入路径，zod schema 池校验）
      │                     → settings-sync 广播 → UI 即时生效
      └─ scope=appearance → renderer 既有主题 setter（与设置页同一写路径）
                            → 广播接收端复用同一 setter（applyingBroadcast 防回环）
```

- 白名单与按 key value Schema 定义在 contracts，handler 与宿主共守同一把尺。
- 审计：两工具调用本身进入会话工具调用记录（现有机制），不另建审计存储。

## 权限与边界

- `set` 默认 ask；`get` 只读不确认。
- 仅作用于当前 app 实例；远程 workspace 场景不跨实例写设置。
- 端口缺席（CLI 直跑）时工具不注册，维持 fail-closed。

## 非目标（v1 边界）

- 不做白名单外的任意 KV 读写。
- 凭据、网络、权限类设置永不入白名单。
- 外观深层自定义（配色/字体/对比度）不进工具面，仅 theme 整体切换。

## 验收场景

1. 模型调用 `set_desktop_setting` 把 theme 切为 dark，UI 即时生效，第二个窗口经广播同步。
2. 模型尝试写 `httpProxy` → 结构化拒绝 + 可读错误，无任何状态变化。
3. CLI 直跑（无宿主端口）时两工具不注册，无残留错误。

## 验证

- 白名单与 value Schema 校验测试（合法 key / 非法 key / 非法 value 三类）。
- handler → settingService 写入一致性测试（真实临时目录，不 mock 文件系统）。
- theme 写入链路 E2E：切换即时生效 + 广播同步；`pnpm typecheck`；`pnpm architecture:check --changed`。

## 待定项

1. v1 白名单最终清单（上表为推荐集）。
2. "默认模型"是否入白名单：模型选择状态所有者是 per-workspace 的 modelSelectionService，与全局设置不同层；若纳入需先定义映射语义，v1 倾向不纳入。
