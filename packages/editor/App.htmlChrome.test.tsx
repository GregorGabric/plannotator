/**
 * HTML-surface chrome contract after the Interact/Annotate simplification
 * (DOM-gated).
 *
 * The "Hide tools"/"Show tools" header toggle is REMOVED: annotation chrome
 * is always visible on HTML surfaces, an old cookie recording
 * `toolsHidden: true` must not strand a user with hidden chrome, and the
 * sidebar/panel half of the persisted state still round-trips. The header
 * pen toggle reports the armed-by-default Interact/Annotate state.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  resetStorageBackend,
  setStorageBackend,
  type StorageBackend,
} from "@plannotator/ui/utils/storage";

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

const RAW_HTML = "<h1>Rendered page</h1><p>Body copy.</p>";

// In-memory storage backend (the codebase-standard persistence-test pattern):
// keeps values across mounts within a test, so a remount simulates the next
// session with the same cookies.
const memory = new Map<string, string>();
const memoryBackend: StorageBackend = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
};

function seedAnnouncementsSeen(): void {
  memory.set("plannotator-look-feel-announcement-seen", "2");
  memory.set("plannotator-vim-mode-announcement-seen", "2");
  memory.set("plannotator-plan-ai-announcement-seen", "1");
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

const htmlAnnotatePlan = {
  plan: "",
  origin: "codex",
  mode: "annotate",
  filePath: "/tmp/page.html",
  renderAs: "html",
  rawHtml: RAW_HTML,
  sharingEnabled: false,
  serverConfig: {},
};

const annotateFetch: typeof fetch = async (input) => {
  const rawUrl = input instanceof Request ? input.url : String(input);
  if (rawUrl.startsWith("https://api.github.com/")) return new Response(null, { status: 404 });

  const url = new URL(rawUrl, "http://localhost");
  if (url.pathname === "/api/plan") return Response.json(htmlAnnotatePlan);
  if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
  if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({});
};

function findButtonByText(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button"))
    .find((button) => button.textContent?.trim() === label);
}

function penToggle(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>("[data-html-annotate-toggle]");
}

function sidebarTabs(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-sidebar-tabs="true"]');
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mountHtmlAnnotate(): Promise<void> {
  globalThis.fetch = annotateFetch;
  // SAFETY: the App only uses EventSource's constructor, handlers, and close;
  // this test double implements those browser-facing members without I/O.
  globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<App />);
  });
  for (let attempt = 0; attempt < 20 && !penToggle(); attempt += 1) {
    await settle();
  }
  if (!penToggle()) throw new Error("HTML surface did not finish mounting (pen toggle missing)");
}

async function unmountHtmlAnnotate(): Promise<void> {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
}

afterEach(async () => {
  await unmountHtmlAnnotate();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  memory.clear();
  resetStorageBackend();
  if (hasDom) document.body.replaceChildren();
});

afterAll(() => {
  resetStorageBackend();
});

describe.if(hasDom)("HTML annotate chrome (always-visible + pen toggle)", () => {
  test("no Show/Hide tools button exists and the collapsed sidebar tab flags render", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    await mountHtmlAnnotate();

    expect(findButtonByText("Show tools")).toBeUndefined();
    expect(findButtonByText("Hide tools")).toBeUndefined();
    expect(sidebarTabs()).not.toBeNull();
  });

  test("an old cookie recording toolsHidden:true cannot strand a user with hidden chrome", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    // Pre-simplification cookie: the removed toggle persisted hidden chrome.
    memory.set(
      "plannotator-html-chrome",
      JSON.stringify({ toolsHidden: true, sidebarOpen: false, panelOpen: false, savedAt: Date.now() }),
    );
    await mountHtmlAnnotate();

    expect(sidebarTabs()).not.toBeNull();
    expect(findButtonByText("Show tools")).toBeUndefined();
  });

  test("the sidebar-open half of the persisted chrome still restores", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    memory.set(
      "plannotator-html-chrome",
      JSON.stringify({ sidebarOpen: true, panelOpen: false, savedAt: Date.now() }),
    );
    await mountHtmlAnnotate();
    await settle();

    // Open sidebar renders the full tab strip (Contents label), and the
    // collapsed flags are gone.
    expect(findButtonByText("Contents")).not.toBeUndefined();
  });

  test("the pen toggle starts ARMED (aria-pressed) on a static HTML session and click flips it to Interact", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    await mountHtmlAnnotate();

    const pen = penToggle();
    if (!pen) throw new Error("pen toggle missing");
    expect(pen.getAttribute("aria-pressed")).toBe("true");

    await act(async () => pen.click());
    expect(penToggle()!.getAttribute("aria-pressed")).toBe("false");

    await act(async () => penToggle()!.click());
    expect(penToggle()!.getAttribute("aria-pressed")).toBe("true");
  });
});
