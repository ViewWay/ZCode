// 自动沉淀（specs/auto-distill.md）领域类型：候选与提取输入。
// 候选是"从会话提取、尚未确认的知识条目"；确认后数据所有权移交 memory 子系统，
// 候选文件不再持有该记录（candidates.json 只是候选的唯一事实源，见 node/auto-distill/candidateStore.ts）。
// 类型放在 shared 根（浏览器安全）：CLI 触发链路、services 审阅服务面与 renderer UI 共用；
// 候选的文件读写实现是 Node-only，单独放在 src/node/auto-distill/。

export type DistillCandidateKind = "repeated-command" | "adopted-fix";

export interface DistillCandidateWorkspace {
  /** 远程/命名工作区身份；本地工作区缺省按 path 定位（AGENTS.md Workspace Identity）。 */
  identity?: string;
  /** 工作区本地路径；与 identity 一起复现项目记忆目录。 */
  path: string;
}

export interface DistillCandidate {
  /**
   * 确定性 id（信号内容哈希，见 core extract 实现）：对同一批会话重跑提取得到相同 id，
   * store.add 据此 upsert，不产生重复候选。
   */
  id: string;
  kind: DistillCandidateKind;
  /** 自包含摘要，直接用于设置页审阅列表展示。 */
  summary: string;
  /** 来源会话 id，spec 要求每候选必带。 */
  sourceSessionId: string;
  /** 规则置信度 0~1；v1 规则式上限 0.9，保留"必须人工审阅"的语义。 */
  confidence: number;
  /** ISO 8601 创建时间。 */
  createdAt: string;
  /**
   * 来源工作区：由会话结束触发器在写入候选时补齐；设置页"确认"按它复现
   * 项目记忆目录（跨 CLI / Desktop host 两进程的同源公式，见 node 侧实现）。
   * v1 早期候选可能缺失，缺失时确认动作给出可读错误而非写错目录。
   */
  workspace?: DistillCandidateWorkspace;
}

export type DistillFragmentRole = "user" | "assistant";

/** 会话文本片段：宿主把会话消息（含工具调用里的命令）映射为片段后注入提取器。 */
export interface DistillSessionFragment {
  role: DistillFragmentRole;
  text: string;
}

export interface DistillSessionInput {
  sessionId: string;
  /** 按时间排序的片段序列。 */
  fragments: readonly DistillSessionFragment[];
}

/** 候选存储目录下的候选文件名（~/.zcode/distill/candidates.json）。 */
export const DISTILL_CANDIDATES_FILE_NAME = "candidates.json";

/** candidates.json 顶层 schema 版本；解析时版本不匹配按损坏处理。 */
export const DISTILL_STORE_SCHEMA_VERSION = 1;
