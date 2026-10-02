# Spec：agent 可调桌面设置（get/set_desktop_setting）

对齐 MiMo 的 `get_desktop_settings` / `set_desktop_setting`：模型能在**白名单**范围内
读写桌面设置，UI 即时生效；白名单外一律拒绝。

## 目标

1. 新增 `get_desktop_setting` / `set_desktop_setting` 两个工具，设置项以**枚举白名单**
   Schema 约束（非开放 KV）。
2. 写路径唯一：复用现有设置服务（`packages/services/src/setting`），不建第二状态源。
3. set 默认走 permission 确认（ask）；白名单外直接拒绝。
4. 设置变更进会话记录（审计），敏感项永不入白名单。

## 现状与增量

| 项 | 现状 | 增量 |
| --- | --- | --- |
| 设置服务 | `packages/services/src/setting` + `settings-sync`（跨窗口同步） | handlers 经宿主桥接读写，写路径唯一 |
| 工具面 | core 无 agent 可调设置 | 新增两个 handler；contracts 增加白名单枚举 Schema |
| UI | 设置页各分区组件各自绑定设置服务 | 只读展示"模型修改过某设置"的审计提示（可选） |

## 工具契约（草案）

```text
get_desktop_setting:
  input : { keys: [枚举] }
  output: { values: { key: value } }

set_desktop_setting:
  input : { key: 枚举, value: 按项类型校验 }
  output: { ok: true, key, value }
  约束  : 白名单 v1：theme、language、notifications.enabled、default_model、
          auto_check_update 等 UI 偏好类；凭据/网络/权限/更新源等敏感项永不入白名单
```

## 状态所有者与数据流

```text
core handler → 宿主桥 → packages/services/src/setting（唯一所有者）
  → settings-sync 广播（跨窗口一致）→ UI stores 应用
```

- 服务是设置的唯一所有者；工具不缓存值；UI stores 只是订阅方（对齐
  appearancePreferences 的"写路径唯一 + 广播复用 setter"模式）。

## 权限与审计

- set 默认 ask；deny 规则照常生效。
- 每次成功写入在会话记录中留审计条目（key、old/new 值、时间戳 ISO 8601）。
- 敏感项清单与白名单一起维护在 contracts 枚举里，写测试断言两集合不相交。

## 非目标（v1 边界）

- 不做模型自助解锁白名单（白名单只能人改）。
- 设置页面各分区 UI 不重构，仅加审计提示。
- 不覆盖工程设置（`.zcode` 配置文件仍只能人改）。

## 验收场景

1. 模型把主题切为 dark，UI 即时生效；会话记录出现审计条目。
2. 尝试写白名单外设置：拒绝并给出可读错误，列出可写项。
3. 双窗口场景：单侧写入后另一侧经 settings-sync 保持一致。

## 验证

- 白名单校验测试；白名单与敏感项不相交测试。
- 双窗口一致性测试（settings-sync 广播）。
- `pnpm typecheck`；`pnpm architecture:check --changed`。
