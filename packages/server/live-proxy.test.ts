/**
 * Live app proxy contract (phase 1).
 *
 * Boots the real proxy against an in-test fake dev server on 127.0.0.1:0 and
 * asserts the load-bearing behaviors: bridge injection (placement, exactly
 * one, cross-chunk), header hygiene (Host rewrite, Accept-Encoding on
 * document intent only, CSP replacement, frame-ancestors), passthrough
 * fidelity (assets, encoded HTML, SSE, WebSocket), and the security posture
 * (loopback bind, Host validation, reserved namespace).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LIVE_PROXY_BRIDGE_PATH,
  createHtmlInjector,
  isAllowedProxyHost,
  isDocumentIntentRequest,
  startLiveAppProxy,
  type LiveAppProxy,
} from "./live-proxy";

const INJECT_TAG = `<script src="${LIVE_PROXY_BRIDGE_PATH}"></script>`;
const BRIDGE_BODY = "window.__plannotatorLiveConfig = {\"token\":\"tok-abc123\",\"editorOrigins\":[\"http://localhost:4100\",\"http://127.0.0.1:4100\"]}; /* bridge */";
const EDITOR_ORIGINS = ["http://localhost:4100", "http://127.0.0.1:4100"];

const HTML_PAGE = "<!doctype html><html><head><title>Fake App</title><link rel=\"stylesheet\" href=\"/style.css\"></head><body><div id=\"root\">hi</div><script src=\"/asset.js\"></script></body></html>";
const NO_HEAD_PAGE = "<html><body><p>bare</p></body></html>";
const BINARY_BYTES = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);

let upstreamHits: string[] = [];
let recordedHeaders: Record<string, string | null> = {};
let upstream: ReturnType<typeof Bun.serve<{ hits: number }>>;
let proxy: LiveAppProxy;

function proxyUrl(path: string): string {
  return proxy.origin + path;
}

beforeAll(() => {
  upstream = Bun.serve<{ hits: number }>({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      upstreamHits.push(url.pathname);

      if (url.pathname === "/ws-echo") {
        if (srv.upgrade(req, { data: { hits: 0 } })) return;
        return new Response("not ws", { status: 400 });
      }

      switch (url.pathname) {
        case "/":
          return new Response(HTML_PAGE, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        case "/no-head":
          return new Response(NO_HEAD_PAGE, {
            headers: { "Content-Type": "text/html" },
          });
        case "/chunked-head-open": {
          // Splits the stream inside the <head ...> open tag.
          const parts = ["<html><hea", "d data-x=\"1\"><title>c</title></head><body>ok</body></html>"];
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              for (const part of parts) {
                controller.enqueue(new TextEncoder().encode(part));
                await Bun.sleep(10);
              }
              controller.close();
            },
          });
          return new Response(stream, { headers: { "Content-Type": "text/html" } });
        }
        case "/chunked-head-close": {
          // No head open tag; splits the stream inside the </head> marker.
          const parts = ["<html>prefix</he", "ad><body>ok</body></html>"];
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              for (const part of parts) {
                controller.enqueue(new TextEncoder().encode(part));
                await Bun.sleep(10);
              }
              controller.close();
            },
          });
          return new Response(stream, { headers: { "Content-Type": "text/html" } });
        }
        case "/asset.js":
          recordedHeaders["asset-accept-encoding"] = req.headers.get("accept-encoding");
          return new Response("console.log('asset');", {
            headers: { "Content-Type": "text/javascript", "X-Asset-Header": "kept" },
          });
        case "/binary":
          return new Response(BINARY_BYTES, {
            headers: { "Content-Type": "application/octet-stream" },
          });
        case "/csp":
          return new Response(HTML_PAGE, {
            headers: {
              "Content-Type": "text/html",
              "Content-Security-Policy": "default-src 'self'",
              "Content-Security-Policy-Report-Only": "default-src 'none'",
              "X-Frame-Options": "DENY",
            },
          });
        case "/gzip": {
          const gzipped = Bun.gzipSync(new TextEncoder().encode(HTML_PAGE));
          return new Response(gzipped, {
            headers: {
              "Content-Type": "text/html",
              "Content-Encoding": "gzip",
              "Content-Length": String(gzipped.byteLength),
            },
          });
        }
        case "/sse": {
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode("data: first\n\n"));
              await Bun.sleep(150);
              controller.enqueue(new TextEncoder().encode("data: second\n\n"));
              controller.close();
            },
          });
          return new Response(stream, {
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
          });
        }
        case "/headers":
          recordedHeaders["doc-host"] = req.headers.get("host");
          recordedHeaders["doc-accept-encoding"] = req.headers.get("accept-encoding");
          recordedHeaders["doc-x-forwarded-host"] = req.headers.get("x-forwarded-host");
          recordedHeaders["doc-x-forwarded-proto"] = req.headers.get("x-forwarded-proto");
          return new Response("<html><head></head><body>h</body></html>", {
            headers: { "Content-Type": "text/html" },
          });
        case "/redirect":
          return new Response(null, {
            status: 302,
            headers: { Location: `http://127.0.0.1:${srv.port}/after-redirect` },
          });
        case "/relative-redirect":
          return new Response(null, {
            status: 302,
            headers: { Location: "/after-redirect" },
          });
        default:
          return new Response("upstream 404", { status: 404 });
      }
    },
    websocket: {
      message(ws, raw) {
        // Echo both text and binary frames.
        ws.send(typeof raw === "string" ? raw : raw);
      },
    },
  });

  proxy = startLiveAppProxy({
    targetUrl: `http://127.0.0.1:${upstream.port}`,
    editorOrigins: EDITOR_ORIGINS,
    bridgeJs: BRIDGE_BODY,
  });
});

afterAll(() => {
  proxy.stop();
  upstream.stop(true);
});

describe("live proxy: HTML injection", () => {
  test("injects exactly one bridge script tag immediately after the head open tag", async () => {
    const html = await (await fetch(proxyUrl("/"))).text();
    expect(html).toContain(INJECT_TAG);
    expect(html.split(INJECT_TAG).length - 1).toBe(1);
    expect(html.indexOf(`<head>${INJECT_TAG}`)).toBeGreaterThanOrEqual(0);
    // Original content is intact around the injection.
    expect(html.replace(INJECT_TAG, "")).toBe(HTML_PAGE);
  });

  test("no head open tag: appends the tag at end of stream", async () => {
    const html = await (await fetch(proxyUrl("/no-head"))).text();
    expect(html.split(INJECT_TAG).length - 1).toBe(1);
    // No <head> and no </head> in the document: tag lands at the end.
    expect(html).toBe(NO_HEAD_PAGE + INJECT_TAG);
  });

  test("head open tag split across chunks still injects once, after the tag", async () => {
    const html = await (await fetch(proxyUrl("/chunked-head-open"))).text();
    expect(html.split(INJECT_TAG).length - 1).toBe(1);
    expect(html).toContain(`<head data-x="1">${INJECT_TAG}`);
  });

  test("</head> marker split across chunks injects before it (no head open tag)", async () => {
    const html = await (await fetch(proxyUrl("/chunked-head-close"))).text();
    expect(html.split(INJECT_TAG).length - 1).toBe(1);
    expect(html).toContain(`${INJECT_TAG}</head>`);
  });

  test("content-length is not present (or correct) on injected responses", async () => {
    const res = await fetch(proxyUrl("/"));
    const body = await res.text();
    const contentLength = res.headers.get("content-length");
    if (contentLength !== null) {
      expect(Number(contentLength)).toBe(new TextEncoder().encode(body).byteLength);
    }
    expect(body).toContain(INJECT_TAG);
  });
});

describe("live proxy: header hygiene", () => {
  test("upstream sees its own Host, forwarded headers, and no Accept-Encoding on documents", async () => {
    recordedHeaders = {};
    await (await fetch(proxyUrl("/headers"), {
      headers: { Accept: "text/html", "Accept-Encoding": "gzip, br" },
    })).text();
    expect(recordedHeaders["doc-host"]).toBe(`127.0.0.1:${upstream.port}`);
    expect(recordedHeaders["doc-accept-encoding"]).toBe("identity");
    expect(recordedHeaders["doc-x-forwarded-host"]).toBe(`127.0.0.1:${proxy.port}`);
    expect(recordedHeaders["doc-x-forwarded-proto"]).toBe("http");
  });

  test("asset requests keep their Accept-Encoding", async () => {
    recordedHeaders = {};
    await (await fetch(proxyUrl("/asset.js"), {
      headers: { Accept: "*/*", "Accept-Encoding": "gzip" },
    })).text();
    expect(recordedHeaders["asset-accept-encoding"]).toBe("gzip");
  });

  test("HTML responses lose app CSP and X-Frame-Options and gain our frame-ancestors", async () => {
    const res = await fetch(proxyUrl("/csp"), { headers: { Accept: "text/html" } });
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("content-security-policy-report-only")).toBeNull();
    expect(res.headers.get("content-security-policy")).toBe(
      `frame-ancestors ${EDITOR_ORIGINS.join(" ")}`,
    );
    expect(await res.text()).toContain(INJECT_TAG);
  });

  test("non-HTML responses keep their headers", async () => {
    const res = await fetch(proxyUrl("/asset.js"));
    expect(res.headers.get("x-asset-header")).toBe("kept");
    expect(res.headers.get("content-security-policy")).toBeNull();
  });
});

describe("live proxy: passthrough fidelity", () => {
  test("content-encoded HTML passes through unmodified (no injection, body intact)", async () => {
    // A raw socket keeps Bun's fetch from transparently decompressing, so we
    // can assert the exact bytes the proxy relayed.
    const raw = await rawHttpRequest(proxy.port, [
      "GET /gzip HTTP/1.1",
      `Host: 127.0.0.1:${proxy.port}`,
      "Accept: text/html",
      "Connection: close",
    ]);
    expect(raw.head).toContain("content-encoding: gzip");
    const expected = Bun.gzipSync(new TextEncoder().encode(HTML_PAGE));
    expect(raw.body.byteLength).toBe(expected.byteLength);
    expect(Buffer.from(raw.body).equals(Buffer.from(expected))).toBe(true);
    // Decoded, it is the original page with no injected tag.
    const decoded = new TextDecoder().decode(Bun.gunzipSync(raw.body));
    expect(decoded).toBe(HTML_PAGE);
    expect(decoded).not.toContain(INJECT_TAG);
  });

  test("binary assets are byte-identical", async () => {
    const res = await fetch(proxyUrl("/binary"));
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(bytes).equals(Buffer.from(BINARY_BYTES))).toBe(true);
  });

  test("SSE: the first event is readable before the stream completes", async () => {
    const res = await fetch(proxyUrl("/sse"));
    const reader = res.body!.getReader();
    const started = Date.now();
    const first = await reader.read();
    const firstLatency = Date.now() - started;
    expect(new TextDecoder().decode(first.value)).toContain("data: first");
    // The upstream holds the second event for 150ms; getting the first one
    // well under that proves streaming (no full-body buffering).
    expect(firstLatency).toBeLessThan(140);
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain("data: second");
  });

  test("redirect Location on the target origin is rewritten to the proxy origin", async () => {
    const res = await fetch(proxyUrl("/redirect"), { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${proxy.origin}/after-redirect`);
  });

  test("relative redirect Locations pass through untouched", async () => {
    const res = await fetch(proxyUrl("/relative-redirect"), { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/after-redirect");
  });
});

describe("live proxy: WebSocket passthrough", () => {
  test("text and binary frames echo through; early messages are queued", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/ws-echo`);
    const received: (string | Uint8Array)[] = [];
    const gotBoth = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws echo timed out")), 5000);
      ws.addEventListener("message", async (event) => {
        if (typeof event.data === "string") {
          received.push(event.data);
        } else if (event.data instanceof Blob) {
          received.push(new Uint8Array(await event.data.arrayBuffer()));
        } else {
          received.push(new Uint8Array(event.data as ArrayBuffer));
        }
        if (received.length === 2) {
          clearTimeout(timer);
          resolve();
        }
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("ws error"));
      });
    });
    ws.addEventListener("open", () => {
      // Sent immediately on client open: the upstream socket may not be
      // connected yet, exercising the pending queue.
      ws.send("hello-through-proxy");
      ws.send(new Uint8Array([9, 8, 7]));
    });
    await gotBoth;
    expect(received[0]).toBe("hello-through-proxy");
    expect(Buffer.from(received[1] as Uint8Array).equals(Buffer.from([9, 8, 7]))).toBe(true);
    const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve()));
    ws.close();
    await closed;
  });
});

describe("live proxy: security posture", () => {
  test("a non-localhost Host header gets 403 and never touches upstream", async () => {
    upstreamHits = [];
    const raw = await rawHttpRequest(proxy.port, [
      "GET /headers HTTP/1.1",
      "Host: evil.example",
      "Connection: close",
    ]);
    expect(raw.head.startsWith("http/1.1 403")).toBe(true);
    expect(upstreamHits).toEqual([]);
  });

  test("the proxy origin and bind are loopback, independent of PLANNOTATOR_REMOTE", () => {
    expect(proxy.origin).toBe(`http://127.0.0.1:${proxy.port}`);
    // The bind is a source-level contract: the literal loopback constant,
    // never getServerHostname() or any env-dependent interface.
    const source = readFileSync(join(import.meta.dir, "live-proxy.ts"), "utf-8");
    expect(source).toContain('const LOOPBACK_HOST = "127.0.0.1";');
    expect(source).toContain("hostname: LOOPBACK_HOST");
    expect(source).not.toContain("getServerHostname");
  });

  test("host validation accepts only this proxy's loopback names", () => {
    expect(isAllowedProxyHost(`127.0.0.1:${proxy.port}`, proxy.port)).toBe(true);
    expect(isAllowedProxyHost(`localhost:${proxy.port}`, proxy.port)).toBe(true);
    expect(isAllowedProxyHost(`[::1]:${proxy.port}`, proxy.port)).toBe(true);
    expect(isAllowedProxyHost(`127.0.0.1:${proxy.port + 1}`, proxy.port)).toBe(false);
    expect(isAllowedProxyHost("evil.example", proxy.port)).toBe(false);
    expect(isAllowedProxyHost(null, proxy.port)).toBe(false);
  });

  test("the bridge body is served from the reserved path with no-store", async () => {
    const res = await fetch(proxyUrl(LIVE_PROXY_BRIDGE_PATH));
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).toBe(BRIDGE_BODY);
    expect(body).toContain("tok-abc123");
    expect(body).toContain("http://localhost:4100");
  });

  test("other reserved paths are 404 and never forwarded upstream", async () => {
    upstreamHits = [];
    const res = await fetch(proxyUrl("/__plannotator__/other"));
    expect(res.status).toBe(404);
    expect(upstreamHits).toEqual([]);
  });
});

describe("live proxy: unit helpers", () => {
  test("isDocumentIntentRequest keys on Sec-Fetch-Dest or an HTML Accept", () => {
    expect(isDocumentIntentRequest(new Headers({ "sec-fetch-dest": "document" }))).toBe(true);
    expect(isDocumentIntentRequest(new Headers({ "sec-fetch-dest": "iframe" }))).toBe(true);
    expect(isDocumentIntentRequest(new Headers({ "sec-fetch-dest": "frame" }))).toBe(true);
    expect(isDocumentIntentRequest(new Headers({ accept: "text/html,*/*" }))).toBe(true);
    expect(isDocumentIntentRequest(new Headers({ "sec-fetch-dest": "script", accept: "*/*" }))).toBe(false);
    expect(isDocumentIntentRequest(new Headers())).toBe(false);
  });

  test("createHtmlInjector never double-injects when both markers appear", () => {
    const injector = createHtmlInjector("<INJ>");
    const out: string[] = [];
    const decoder = new TextDecoder();
    for (const chunk of ["<html><head>", "<title>t</title></head><body></body></html>"]) {
      for (const part of injector.push(new TextEncoder().encode(chunk))) {
        out.push(decoder.decode(part));
      }
    }
    for (const part of injector.flush()) out.push(decoder.decode(part));
    const html = out.join("");
    expect(html.split("<INJ>").length - 1).toBe(1);
    expect(html).toContain("<head><INJ>");
  });

  test("createHtmlInjector does not treat <header> as a head open tag", () => {
    const injector = createHtmlInjector("<INJ>");
    const out: string[] = [];
    const decoder = new TextDecoder();
    for (const part of injector.push(new TextEncoder().encode("<html><body><header>x</header></body></html>"))) {
      out.push(decoder.decode(part));
    }
    for (const part of injector.flush()) out.push(decoder.decode(part));
    const html = out.join("");
    expect(html).toBe("<html><body><header>x</header></body></html><INJ>");
  });
});

/** Minimal raw HTTP/1.1 client: needed to send a forged Host header and to
 * observe exact relayed bytes without fetch's transparent decompression. */
function rawHttpRequest(
  port: number,
  requestLines: string[],
): Promise<{ head: string; body: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(requestLines.join("\r\n") + "\r\n\r\n");
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      // Proactively close once a content-length body is complete: Bun keeps
      // the connection alive even when the client sent Connection: close.
      const all = Buffer.concat(chunks);
      const split = all.indexOf("\r\n\r\n");
      if (split === -1) return;
      const head = all.subarray(0, split).toString("utf-8").toLowerCase();
      const match = head.match(/content-length: (\d+)/);
      if (match && all.length >= split + 4 + Number(match[1])) socket.destroy();
      if (head.includes("transfer-encoding: chunked") && all.includes("\r\n0\r\n")) socket.destroy();
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const all = Buffer.concat(chunks);
      const split = all.indexOf("\r\n\r\n");
      if (split === -1) {
        reject(new Error("malformed HTTP response"));
        return;
      }
      const head = all.subarray(0, split).toString("utf-8").toLowerCase();
      let body = new Uint8Array(all.subarray(split + 4));
      // Undo chunked transfer encoding when present so byte assertions see
      // the payload itself.
      if (head.includes("transfer-encoding: chunked")) {
        body = decodeChunked(body);
      }
      resolve({ head, body });
    });
    setTimeout(() => {
      socket.destroy();
    }, 2000);
  });
}

function decodeChunked(body: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let offset = 0;
  const buffer = Buffer.from(body);
  for (;;) {
    const lineEnd = buffer.indexOf("\r\n", offset);
    if (lineEnd === -1) break;
    const size = parseInt(buffer.subarray(offset, lineEnd).toString("ascii"), 16);
    if (!Number.isFinite(size) || size === 0) break;
    const start = lineEnd + 2;
    parts.push(new Uint8Array(buffer.subarray(start, start + size)));
    offset = start + size + 2;
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}
