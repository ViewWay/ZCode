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

## 其他内置（MIT）

- **skill-creator**：技能创作指南（模型自举扩展 ZCode 技能面的元能力）；MIT。
- **arxiv**：arXiv 论文检索/读取（走 arxiv.org 与 SemanticScholar 公开 API）；MIT。

## 收录规则（对照 mimocode 全 24 技能）

- 有对应能力且集成更深的不替换：浏览器域保留 `browser-use-plugin` 的
  control-browser / web-gui-tester（桥接集成，优于 playwright-cli 指引型技能）；
  工作流域保留 `dynamic-workflows`（必需路径完整性门控）。
- 无许可证声明的 13 个技能（deep-research/data-analytics/super-research 等）不收录
  （默认版权保留，无法进 Apache 开源仓）；claude-code/codex 为其它工具的使用手册、
  mimocode-docs 为上游产品文档，均不收录。

