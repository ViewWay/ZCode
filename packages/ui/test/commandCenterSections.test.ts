import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMAND_CENTER_DEFAULT_SECTION_ORDER,
  COMMAND_CENTER_RECENT_TASK_PREVIEW_LIMIT,
} from "../src/command-center/commandCenterSections.js";

test("default view puts recent tasks first, matching the ChatGPT-style recent list layout", () => {
  assert.deepEqual([...COMMAND_CENTER_DEFAULT_SECTION_ORDER], [
    "recentTasks",
    "recentChanges",
    "commands",
  ]);
});

test("recent tasks preview shows six rows by default", () => {
  assert.equal(COMMAND_CENTER_RECENT_TASK_PREVIEW_LIMIT, 6);
});
