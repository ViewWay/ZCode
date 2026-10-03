/**
 * 生成会话登记表（module 级，进程内单例）：workspaceId → sessionId。
 * 跨 workbench 重挂载存活——用户切走再切回时「停止」仍能找到生成会话。
 * 同仓库只保留最近一次生成的会话（文档：同仓库同时只能跑一个生成任务）。
 *
 * 所有权显式独立成模块：import 本文件即取得同一 Map 实例；
 * track/has/clear 均幂等。磁盘 wiki.json 仍是生成进度的唯一事实源，
 * 登记表只是 UI 对「生成会话在跑」的近似（分析阶段 wiki.json 尚未落盘时依赖它）。
 */
const generationSessionIds = new Map<string, string>();

export interface RepoWikiGenerationScope {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** 生成会话的模型覆盖；缺省用 runtime 缺省模型（顶栏"默认"）。 */
  modelSelection?: { providerId: string; modelId: string };
}

export function generationWorkspaceKey(scope: RepoWikiGenerationScope): string {
  // workspace 身份 key 沿用 AGENTS.md 规则：identity 优先，否则路径。
  return scope.workspaceIdentity?.trim() || scope.workspacePath;
}

/** 是否存在登记的生成会话（近似"生成中"：分析阶段 wiki.json 尚未落盘时 UI 依赖它）。 */
export function hasTrackedGeneration(scope: RepoWikiGenerationScope): boolean {
  return generationSessionIds.has(generationWorkspaceKey(scope));
}

/** 登记生成会话（幂等：同仓库重复登记覆盖为最近一次）。 */
export function trackGeneration(scope: RepoWikiGenerationScope, sessionId: string): void {
  generationSessionIds.set(generationWorkspaceKey(scope), sessionId);
}

/** 取登记的会话 id（无登记为 undefined，例如重挂载后生成已自然结束）。 */
export function getTrackedGenerationSessionId(scope: RepoWikiGenerationScope): string | undefined {
  return generationSessionIds.get(generationWorkspaceKey(scope));
}

/**
 * 清除登记条目（幂等）：磁盘推导出「无页面正在生成」（全部完成，或仅剩失败标记页）
 * 时调用。若完成后不清理，残留登记会把「删除 Wiki 后的空态」（doc=null && tracked）
 * 误判成「正在分析代码库」，用户只能靠手动点停止逃离。
 */
export function clearTrackedGeneration(scope: RepoWikiGenerationScope): void {
  generationSessionIds.delete(generationWorkspaceKey(scope));
}
