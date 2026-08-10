/**
 * Live app probe contract for annotate URL resolution (phase 1).
 *
 * Loopback http URLs default to live mode when the probe returns HTML;
 * --static forces the classic conversion pipeline; --app forces live and
 * fails loudly when it cannot apply; non-loopback URLs keep the conversion
 * pipeline untouched. Probes run against a throwaway Bun.serve.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { isLoopbackHostname, resolveAnnotateTarget } from "./annotate-resolution";

let fakeApp: ReturnType<typeof Bun.serve>;
let htmlUrl: string;
let jsonUrl: string;
let unreachableUrl: string;

beforeAll(() => {
  fakeApp = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api") {
        return Response.json({ ok: true });
      }
      return new Response(
        "<html><head><title>dev app</title></head><body><h1>App</h1></body></html>",
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  htmlUrl = `http://127.0.0.1:${fakeApp.port}/`;
  jsonUrl = `http://127.0.0.1:${fakeApp.port}/api`;
  // A port nothing listens on: connection refused, fast.
  unreachableUrl = "http://127.0.0.1:1/";
});

afterAll(() => {
  fakeApp.stop(true);
});

function resolve(rawFilePath: string, overrides: { forceApp?: boolean; forceStatic?: boolean } = {}) {
  return resolveAnnotateTarget({
    rawFilePath,
    projectRoot: process.cwd(),
    noJina: true,
    renderMarkdown: false,
    forceApp: overrides.forceApp ?? false,
    forceStatic: overrides.forceStatic ?? false,
    log: () => {},
  });
}

describe("isLoopbackHostname", () => {
  test("accepts localhost, 127.x, and IPv6 loopback in both URL forms", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("LOCALHOST")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("127.1.2.3")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  test("rejects everything else", () => {
    expect(isLoopbackHostname("example.com")).toBe(false);
    expect(isLoopbackHostname("192.168.1.10")).toBe(false);
    expect(isLoopbackHostname("localhost.evil.example")).toBe(false);
    expect(isLoopbackHostname("128.0.0.1")).toBe(false);
  });
});

describe("annotate URL resolution: live app probe", () => {
  test("a loopback URL returning HTML defaults to live mode", async () => {
    const result = await resolve(htmlUrl);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.liveApp).toBe(true);
      expect(result.markdown).toBe("");
      expect(result.absolutePath).toBe(htmlUrl);
      expect(result.sourceInfo).toBe(htmlUrl);
      expect(result.sourceConverted).toBe(false);
      expect(result.isUrl).toBe(true);
      expect(result.annotateMode).toBe("annotate");
    }
  });

  test("a loopback JSON endpoint stays on the static pipeline (its legacy error verbatim)", async () => {
    // The conversion pipeline has always rejected non-HTML content types;
    // the probe must not turn that into a live session or a new error shape.
    const result = await resolve(jsonUrl);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.notFound).toBe(false);
      expect(result.message).toContain("Not an HTML page");
    }
  });

  test("--static forces conversion even on a loopback HTML page", async () => {
    const result = await resolve(htmlUrl, { forceStatic: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.liveApp).toBeUndefined();
      expect(result.markdown).toContain("App");
    }
  });

  test("--app on a non-loopback URL is a startup failure", async () => {
    const result = await resolve("http://example.com/", { forceApp: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.notFound).toBe(false);
      expect(result.message).toContain("--app requires a localhost/loopback URL");
    }
  });

  test("--app on an https loopback URL is a clear startup failure", async () => {
    const result = await resolve("https://localhost:8443/", { forceApp: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("https");
    }
  });

  test("--app on an unreachable loopback URL fails naming the URL", async () => {
    const result = await resolve(unreachableUrl, { forceApp: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("--app");
      expect(result.message).toContain(unreachableUrl);
    }
  });

  test("--app on a loopback non-HTML endpoint fails loudly instead of converting", async () => {
    const result = await resolve(jsonUrl, { forceApp: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("did not return an HTML page");
    }
  });

  test("a failed probe without --app falls back to the static pipeline verbatim", async () => {
    // The static pipeline then fails its own way (dead URL), proving the
    // probe failure did not invent a new terminal state.
    const result = await resolve(unreachableUrl);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.notFound).toBe(false);
      expect(result.message).toContain("Failed to fetch URL");
    }
  });
});
