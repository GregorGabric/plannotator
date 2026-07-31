import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const hasDom = typeof document !== "undefined";

if (hasDom) {
  document.cookie = "plannotator-look-feel-announcement-seen=2; path=/";
  document.cookie = "plannotator-vim-mode-announcement-seen=2; path=/";
  document.cookie = "plannotator-plan-ai-announcement-seen=1; path=/";
}

const appModule = hasDom ? await import("./App") : null;
const App = appModule?.default as typeof import("./App")["default"];
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

interface PlanResponse {
  readonly plan: string;
  readonly origin: "codex";
  readonly mode: "archive" | "annotate";
  readonly filePath?: string;
  readonly archivePlans?: readonly [{
    readonly filename: string;
    readonly status: "approved";
    readonly timestamp: string;
    readonly title: string;
  }];
  readonly sharingEnabled: false;
  readonly serverConfig: Record<string, never>;
}

class SilentEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly readyState = SilentEventSource.OPEN;
  readonly url: string;
  readonly withCredentials = false;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
  }

  addEventListener(): void {}
  close(): void {}
  dispatchEvent(): boolean { return true; }
  removeEventListener(): void {}
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let requestedRoutes: string[] = [];

function responseFor(planResponse: PlanResponse): typeof fetch {
  return async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const method = input instanceof Request ? input.method : init?.method ?? "GET";
    if (rawUrl.startsWith("https://api.github.com/")) {
      return new Response(null, { status: 404 });
    }

    const url = new URL(rawUrl, "http://localhost");
    requestedRoutes.push(`${method} ${url.pathname}`);
    if (url.pathname === "/api/plan") return Response.json(planResponse);
    if (url.pathname === "/api/archive/plans") {
      return Response.json({ plans: planResponse.archivePlans ?? [] });
    }
    if (url.pathname === "/api/archive/plan") {
      return Response.json({ markdown: planResponse.plan, filepath: "saved.md" });
    }
    if (url.pathname === "/api/ai/capabilities") {
      return Response.json({ available: false, providers: [] });
    }
    if (url.pathname === "/api/open-in/apps") {
      return Response.json({
        available: true,
        apps: [{ id: "reveal", label: "Finder", kind: "file-manager", icon: "finder" }],
      });
    }
    if (url.pathname === "/api/draft") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    return Response.json({});
  };
}

async function mountApp(planResponse: PlanResponse): Promise<void> {
  requestedRoutes = [];
  globalThis.fetch = responseFor(planResponse);
  // SAFETY: the App only uses EventSource's constructor, handlers, and close;
  // this test double implements those browser-facing members without I/O.
  globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<App />);
  });

  for (let attempt = 0; attempt < 20 && !document.body.textContent?.includes(planResponse.plan.slice(2)); attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  if (hasDom) document.body.replaceChildren();
});

describe.if(hasDom)("App document permissions", () => {
  test("standalone archive renders Markdown without mutation entry points", async () => {
    await mountApp({
      plan: "# Archived document",
      origin: "codex",
      mode: "archive",
      archivePlans: [{
        filename: "saved.md",
        status: "approved",
        timestamp: "2026-07-31T00:00:00.000Z",
        title: "Archived document",
      }],
      sharingEnabled: false,
      serverConfig: {},
    });

    expect(document.body.textContent).toContain("Archived document");
    expect(document.querySelector('button[title="Add global comment"]')).toBeNull();
    expect(document.querySelector('button[title="Attachments"]')).toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: true,
      }));
    });
    expect(requestedRoutes).not.toContain("POST /api/approve");
    expect(requestedRoutes).not.toContain("POST /api/deny");
  });

  test("normal annotate remains writable", async () => {
    await mountApp({
      plan: "# Writable document",
      origin: "codex",
      mode: "annotate",
      filePath: "/tmp/writable.md",
      sharingEnabled: false,
      serverConfig: {},
    });

    expect(document.body.textContent).toContain("Writable document");
    expect(document.querySelector('button[title="Add global comment"]')).not.toBeNull();
    expect(document.querySelector('button[title="Attachments"]')).not.toBeNull();
  });
});
