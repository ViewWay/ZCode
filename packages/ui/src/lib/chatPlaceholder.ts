export type ChatHomeMode = "chat" | "tasks";

type ChatPlaceholderMessageKey =
  | "chat.placeholder.newTask"
  | "chat.placeholder.newTaskMobile"
  | "chat.placeholder.tasksHome"
  | "chat.placeholder.followUpAsk"
  | "chat.placeholder.followUpQueue";

export function resolveChatPlaceholderKey(options: {
  hasHistoryMessages: boolean;
  isTaskProcessing: boolean;
  compactNewTask?: boolean;
  /** 草稿首页当前处于任务模式（见 specs/chatgpt-mode-tabs.md）。 */
  tasksHomeMode?: boolean;
}): ChatPlaceholderMessageKey {
  const {
    compactNewTask = false,
    hasHistoryMessages,
    isTaskProcessing,
    tasksHomeMode = false,
  } = options;

  // 按语义分流：
  // 1) 无历史 -> newTask / tasksHome（任务模式首页，见 specs/chatgpt-mode-tabs.md）
  // 2) 有历史且空闲 -> followUpAsk
  // 3) 有历史处理中 -> followUpQueue
  if (!hasHistoryMessages) {
    if (tasksHomeMode && !compactNewTask) {
      return "chat.placeholder.tasksHome";
    }
    return compactNewTask ? "chat.placeholder.newTaskMobile" : "chat.placeholder.newTask";
  }

  return isTaskProcessing ? "chat.placeholder.followUpQueue" : "chat.placeholder.followUpAsk";
}
