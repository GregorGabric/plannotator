import { afterEach, describe, expect, test } from "bun:test";
import {
  actionsLabelModeForWidth,
  observeActionsLabelMode,
} from "./actionsLabelMode";

const originalResizeObserver = globalThis.ResizeObserver;

class ControllableResizeObserver implements ResizeObserver {
  static latest: ControllableResizeObserver | null = null;

  readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ControllableResizeObserver.latest = this;
  }

  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
}

afterEach(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  ControllableResizeObserver.latest = null;
});

describe("action-label responsive measurement", () => {
  test("maps exact thresholds without overlap", () => {
    expect(actionsLabelModeForWidth(800)).toBe("full");
    expect(actionsLabelModeForWidth(799.99)).toBe("short");
    expect(actionsLabelModeForWidth(680)).toBe("short");
    expect(actionsLabelModeForWidth(679.99)).toBe("icon");
  });

  test("uses the border box for both initial and observer-triggered measurements", () => {
    globalThis.ResizeObserver = ControllableResizeObserver;
    let borderBoxWidth = 800;
    const element = {
      getBoundingClientRect: () => ({ width: borderBoxWidth }),
    };
    const modes: string[] = [];

    // SAFETY: observeActionsLabelMode only reads getBoundingClientRect and passes
    // the same object to this test's no-op ResizeObserver implementation.
    const disconnect = observeActionsLabelMode(
      element as HTMLElement,
      (mode) => modes.push(mode),
    );
    expect(modes).toEqual(["full"]);

    borderBoxWidth = 679;
    const observer = ControllableResizeObserver.latest;
    if (!observer) throw new Error("ResizeObserver was not installed");
    const contentBoxEntry: ResizeObserverEntry = {
      target: element as HTMLElement,
      contentRect: {
        width: 900,
        height: 0,
        x: 0,
        y: 0,
        top: 0,
        right: 900,
        bottom: 0,
        left: 0,
        toJSON: () => ({}),
      },
      borderBoxSize: [],
      contentBoxSize: [],
      devicePixelContentBoxSize: [],
    };
    observer.callback([contentBoxEntry], observer);

    expect(modes).toEqual(["full", "icon"]);
    disconnect();
  });
});
