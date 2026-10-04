# Spec：文档技能环境自动就绪（doc-env-bootstrap）

消除 documents/pdf/presentations/spreadsheets 技能"首次使用要手动跑 setup.sh"的摩擦，
对齐 MiMo 打包 LibreOffice 25.8.7 的开箱体验（打包内置 vs 自动探测安装的取舍见待定项）。

## 目标

1. 首次调用文档技能工具时自动完成环境检测→（带确认的）安装→校验，无需用户手动执行
   `setup.sh` / `env_check.sh`。
2. 优先探测系统已装的 LibreOffice（soffice），复用而不重装。
3. 全流程可取消、可跳过，失败给出可读指引。

## 环境现状

发行包 `glm/packages/documents-plugin`（生产 bundle 内置；开源仓 `apps/zcode-cli/packages/`
下无此 workspace 包——落地时以 bundled-skills 新增技能或独立插件承载，位置**待定项①**）。
技能内现有 `setup.sh` / `env_check.sh` / `font_list.txt` 需手动执行。

| 平台 | 探测路径 |
| --- | --- |
| macOS | `/Applications/LibreOffice.app/Contents/MacOS/soffice`、PATH |
| Windows | `Program Files\LibreOffice\program\soffice.exe` |
| Linux | PATH（含常见发行版包名 libreoffice 的安装指引） |

## 领域词汇

- **就绪（ready）**：soffice 可执行且版本满足最低要求。
- **降级**：soffice 缺失时技能降级为"库产物路线（python-docx 等）+ 指引安装"，不阻塞
  会话。

## 状态所有者与数据状态

```text
环境状态缓存: ~/.zcode/doc-env.json（唯一写入点）
  { soffice_path: string | null, version: string | null,
    fonts_ok: boolean, checked_at: ISO 8601 }   // 示例: "2026-10-02T12:00:00Z"
```

- 检测结果缓存于 `doc-env.json`；`checked_at` 超过 7 天或 soffice 路径失效时重测。
- 安装动作的唯一入口是"用户确认后的指引命令"，插件不静默安装系统级软件。

## 流程设计

```text
技能工具被调用 → 读 doc-env.json 缓存
  ├─ ready 且未过期 → 直接执行
  ├─ 未检测 / 过期 → 探测（上表路径）→ 写缓存
  └─ 缺失 → 经权限确认后给出安装指引命令（brew/apt/winget 或官网安装包），
            用户执行并重试后更新缓存 → 就绪
```

- 安装属系统级副作用：走 permission 确认。
- 字体校验（font_list.txt）作为可选项，缺失时警告不阻塞。

## 非目标（v1 边界）

- 不随桌面包分发 LibreOffice 运行时（MiMo 为打包内置；涉及 MPL 合规与 +~700MB 包体，
  **待定项②**：放 v2 评估）。
- 不做在线字体下载安装。
- 不改 Office 文档的解析/生成算法本身。

## 验收场景

1. 全新机器（无 LibreOffice）：调用 docx 技能 → 探测失败 → 展示带确认的安装指引 →
   用户安装后重试，一次成功产出文档。
2. 已装 LibreOffice 的机器：直接复用，零安装动作。
3. 用户拒绝安装指引：技能降级产出（库路线），会话不中断。

## 验证

- 探测逻辑按平台条件测试（探测函数可注入假路径）。
- 缓存文件读写与过期重测测试（合成日期值）。
- `pnpm typecheck`；`pnpm architecture:check --changed`。

## 承载落定（待定项① 已解决，v1.2）

四个文档技能（docx/pdf/pptx/xlsx-official，Apache-2.0，源自 mimocode 内置包，各目录
自带 LICENSE 与第三方声明）已内置到 `apps/zcode-cli/packages/bundled-skills/skills/`
——待定项① 的「bundled-skills 承载」就此落定：技能目录自带 soffice 使用指引，本
spec 的 doc-env 探测/缓存/指引模块（`packages/core/src/doc-env/`）是其缺省状态的前置
兜底（首次调用时探测 + 带确认安装指引）。技能文本中的 `MIMO_PYTHON`/`MIMO_SOFFICE`
为上游 bundle 可选覆盖约定，ZCode 运行时不设置（走公开路径）。
