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
