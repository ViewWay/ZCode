# bundled-skills

ZCode 内置技能包（随分发物携带；`bootstrap/src/app/bundled-skills.ts` 把 `skills/`
根注入技能发现，`SKILL.md` 目录即技能）。

## 文档技能（docx/pdf/pptx/xlsx-official）

- 来源：mimocode 内置技能包（`builtin_skills/desktop-1579e7d`），**Apache-2.0**，
  各技能目录自带 `LICENSE` 与第三方声明（python-docx MIT、lxml BSD-3-Clause；
  可选外部依赖 pandoc、LibreOffice/soffice）。
- 运行前提：`uv`（PEP 723 内联依赖）或任一含依赖的 Python；PDF 预览/转换需
  LibreOffice——缺省状态由 `specs/doc-env-bootstrap.md` 的 doc-env 探测/指引模块兜底
  （三平台探测 + 安装指引）。
- 技能文本中的 `MIMO_PYTHON` / `MIMO_SOFFICE` 环境变量为上游 bundle 约定，属于
  可选覆盖（设置了就走内置解释器）；ZCode 运行时不设置它们，走公开路径。
- 与闭源 `documents-plugin`（LibreOffice 25.8.7 打包版）的关系：开源形态的能力对齐
  （specs/doc-env-bootstrap.md 待定项① 就此落定——承载位置 = bundled-skills）。

## 其他内置（MiMo-Code，MIT 全仓已核实）

来源仓库 [XiaomiMiMo/MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code)（GitHub API 核实 MIT）。按「比 ZCode 现有能力更优才收录」逐域裁定：

**收录（13）**：
- **evolve**（ZCode 层映射版）：自进化常驻指令——触发信号表（重复序列/重复纠错/项目知识/
  工具冲突/流水线复用/约定缺失）→ 五层落地要领（skill / workspace hooks 七事件 /
  saved workflows / project memory / AGENTS.md）。源自 MiMo evolve 技能，映射到
  ZCode 真实扩展层（不引入 .mimocode/ 格式）。
- **memory-search**（ZCode 重写版，非原样收录）：model-io 轨迹结构化分析——按模型/
  工具/会话聚合调用、错误与 token（jq 配方 + 宿主聚合服务 getTrajectoryUsageStats）。
- **deep-research**：并行子代理深调研（纯用 ZCode 原生 WebSearch/WebFetch + 免费 API，完美契合）。
- **super-research**：长时自主调研（minutes-to-overnight，可审计证据）——与 deep-research 轻重互补。
- **data-analytics**：定量业务分析全流程（数据质量/指标诊断/KPI/看板/语义层，含资产与工作流）。
- **product-design**：产品设计探索 / UX 研究与审计 / 产品面克隆。
- **research-paper-writing**：ML/CV/NLP 学术论文写作与打磨。
- **learn-everything**：PDF/论文/URL/主题 → 结构化互动学习课程。
- **modern-python-toolchain**：uv/ruff/pyright 现代项目初始化。
- **claude-code / codex / grok-build**（产品确认收录）：其它智能体 CLI 的操作手册
  （tmux 会话/headless/CI 等）——ZCode 作为主编排者可代用户驱动这些 CLI，
  多智能体协作面（用户指令：让 agent 更好地使用其他智能体）。
- **compose-next**（产品确认收录）：多步功能开发的**交付纪律契约**（澄清问答→worktree
  所有权→feature 文档生命周期→测试先行实现→新证据验证→独立评审子代理→收尾）。
  与原生 plan-mode（只覆盖前端准入）和 dynamic-workflows（只覆盖执行引擎）**正交
  互补**，填补交付纪律空档；其 Implement 阶段可在内部驱动 dwf。

**不收录（5）及理由**：
- loop：已收录适配版（见上，CronCreate/CronList/CronDelete 映射）。
- mate：桌面宠物精灵图，依赖 MiMo Desktop 的 Mate 宿主系统（ZCode 无此宿主，独立立项才做）。
- memory-search：查询的是 MiMo 的 trajectory SQLite 结构，对 ZCode 的存储不适用；
  其「轨迹结构化查询」理念并入 B3 数据面增量。
- sales：544K 垂直销售域，超出通用编码 agent 的产品面。
- playwright（Apache）：浏览器域保留 browser-use 插件的 control-browser / web-gui-tester
  （与桌面桥集成更深；playwright-cli 指引型如有需要可自装）。
- mimocode-docs：上游产品文档（「自我文档技能」理念可后续以 ZCode 素材重写为
  zcode-docs）。

