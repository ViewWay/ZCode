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

**收录（10）**：
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

**不收录（6）及理由**：
- loop：ZCode 原生 cron / 闲时任务 / 定时回放已覆盖同一需求。
- mate：桌面宠物精灵图，窄域玩具级。
- memory-search：查询的是 MiMo 的 trajectory SQLite 结构，对 ZCode 的存储不适用。
- compose-next：与 ZCode 原生 dynamic-workflows / plan-mode 流程重叠。
- sales：544K 垂直销售域，超出通用编码 agent 的产品面。
- playwright（Apache）：浏览器域保留 browser-use 插件的 control-browser / web-gui-tester
  （与桌面桥集成更深；playwright-cli 指引型如有需要可自装）。
- mimocode-docs：上游产品文档。

