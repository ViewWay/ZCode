// @vitest-environment jsdom

// feedback#1027：思考计时此前只存在组件内存 ref，会话切换触发 cold hydration
// 重挂后从 1 秒重新计时。startedAt 种子让流式中重挂的计时从真实起点续算。
import { render } from "@testing-library/react";
import { createElement } from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { Reasoning, ReasoningTrigger } from "../src/components/ai-elements/reasoning.js";

const START_MS = 1_700_000_000_000;

function renderTriggered(startedAt: number | undefined, duration?: number) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        Reasoning,
        {
          isStreaming: true,
          defaultOpen: true,
          // 重挂场景由测试显式构造：每个 render 都是一次全新挂载（内存 ref 归零）。
          ...(startedAt !== undefined ? { startedAt } : {}),
          ...(duration !== undefined ? { duration } : {}),
          // 用自定义文案绕开默认文案，断言只关心秒数本身。
        },
        createElement(ReasoningTrigger, {
          getThinkingMessage: (_isStreaming, d) =>
            d === undefined ? "no-duration" : `elapsed=${d}s`,
        }),
      ),
    ),
  );
}

describe("Reasoning timer startedAt seed", () => {
  beforeEach(() => {
    // RTL 的 act 需要 React 18+ 的 act 环境标志；保持可写，RTL 在 render 内部会自行切换。
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ now: START_MS });
  });

  afterEach(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
    vi.useRealTimers();
  });

  it("seeded remount continues elapsed seconds from the real start instead of 1", () => {
    // 重挂前：live 流式已计时 5 秒。
    vi.setSystemTime(START_MS + 5_000);
    const first = renderTriggered(START_MS);
    expect(first.getByText("elapsed=5s")).toBeTruthy();
    first.unmount();

    // cold hydration 重挂发生在 6 秒处：内存 ref 已随卸载归零，
    // startedAt 种子必须让计时从真实起点续算到 6 秒，而不是重新从 1 秒开始。
    vi.setSystemTime(START_MS + 6_000);
    const second = renderTriggered(START_MS);
    expect(second.getByText("elapsed=6s")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(second.getByText("elapsed=7s")).toBeTruthy();
    second.unmount();
  });

  it("unseeded remount restarts from 1 second (documents the pre-fix behavior)", () => {
    vi.setSystemTime(START_MS + 6_000);
    const view = renderTriggered(undefined);
    expect(view.getByText("elapsed=1s")).toBeTruthy();
    view.unmount();
  });

  it("duration prop stays authoritative once projected durationMs arrives", () => {
    // 收口后投影写入 durationMs 并作为受控 duration 传入；
    // 种子（恒传的 startedAt）不得改写收口展示。
    vi.setSystemTime(START_MS + 30_000);
    const view = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          Reasoning,
          { isStreaming: false, defaultOpen: true, duration: 12, startedAt: START_MS },
          createElement(ReasoningTrigger, {
            getThinkingMessage: (_isStreaming, d) =>
              d === undefined ? "no-duration" : `elapsed=${d}s`,
          }),
        ),
      ),
    );
    expect(view.getByText("elapsed=12s")).toBeTruthy();
    view.unmount();
  });
});
