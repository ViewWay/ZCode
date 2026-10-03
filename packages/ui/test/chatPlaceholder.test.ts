import assert from "node:assert/strict";
import test from "node:test";
import { resolveChatPlaceholderKey } from "../src/lib/chatPlaceholder.js";

// specs/chatgpt-mode-tabs.md 验收场景的可执行部分：占位文案按模式分流。
// composer 焦点/草稿不丢的交互场景需要 DOM，由实机走查覆盖（仓库无 e2e 基建）。

test("任务模式首页使用 tasksHome 占位", () => {
  assert.equal(
    resolveChatPlaceholderKey({
      hasHistoryMessages: false,
      isTaskProcessing: false,
      tasksHomeMode: true,
    }),
    "chat.placeholder.tasksHome",
  );
});

test("对话模式首页保持 newTask 占位", () => {
  assert.equal(
    resolveChatPlaceholderKey({ hasHistoryMessages: false, isTaskProcessing: false }),
    "chat.placeholder.newTask",
  );
});

test("手机紧凑档优先于任务模式", () => {
  assert.equal(
    resolveChatPlaceholderKey({
      hasHistoryMessages: false,
      isTaskProcessing: false,
      compactNewTask: true,
      tasksHomeMode: true,
    }),
    "chat.placeholder.newTaskMobile",
  );
});

test("有历史时模式不影响 followUp 分流", () => {
  assert.equal(
    resolveChatPlaceholderKey({
      hasHistoryMessages: true,
      isTaskProcessing: false,
      tasksHomeMode: true,
    }),
    "chat.placeholder.followUpAsk",
  );
  assert.equal(
    resolveChatPlaceholderKey({
      hasHistoryMessages: true,
      isTaskProcessing: true,
      tasksHomeMode: true,
    }),
    "chat.placeholder.followUpQueue",
  );
});
