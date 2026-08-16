/// <reference types="bun-types" />
/**
 * guides.show — Bun self-host target (contract: adr/implementation/guide-share-hosting.md §8).
 *
 * One process that serves what the Cloudflare Worker serves, without Cloudflare:
 *
 *   /v1/*        the portable-guide viewer build from a directory (default dist/viewer),
 *                with the Worker's exact headers (immutable, CORS `*`, nosniff)
 *   /g/<id>      shared-guide pages
 *   /api/g*      create / fetch / delete shared guides
 *   /healthz     `{ ok: true }`
 *   /            the landing page from site/
 *
 * The share routes are the same pure handler the Worker runs
 * (../share/core/handler.ts) over a filesystem, S3-compatible or in-memory
 * store. Pages pin `<origin>/v1/` as their viewer base and `<origin>/g/<id>`
 * as their canonical URL, where the origin comes from the request URL, so
 * whatever hostname a browser reaches this process on is what a shared page
 * refers back to. Exported guides only accept an https viewer base (or http on
 * localhost), so a self-host reached over plain http from another machine
 * answers 500 on /g/<id>; put TLS in front and pass --public-origin (fixed,
 * preferred) or --trust-proxy (the proxy must SET X-Forwarded-Host/Proto, not
 * pass a client's through: the origin ends up in the page's script src and CSP).
 *
 * Uploads are unauthenticated, so this target brings its own brakes: a per-IP
 * upload limiter (default 30/min, --upload-limit 0 disables) and an optional
 * ceiling on how long any guide is kept (--max-ttl; default: kept until
 * unshared, as the contract says).
 *
 *   bun run apps/guides-show/targets/bun.ts [--port 8788] [--store fs:<dir> | s3:<bucket> | memory]
 *                                           [--viewer-dir dist/viewer] [--host 0.0.0.0]
 *                                           [--public-origin https://guides.example.com | --trust-proxy]
 *                                           [--upload-limit 30] [--max-ttl 30d]
 *
 * Env fallbacks: PORT, GUIDES_SHOW_STORE, GUIDES_SHOW_VIEWER_DIR, GUIDES_SHOW_HOST, GUIDES_SHOW_PUBLIC_ORIGIN,
 * GUIDES_SHOW_TRUST_PROXY, GUIDES_SHOW_UPLOAD_LIMIT, GUIDES_SHOW_MAX_TTL.
 */
import path from 'node:path';
import { GUIDE_VIEWER_MANIFEST } from '@plannotator/core/guide-viewer-manifest';
import { handleGuideShareRequest, isGuideShareRoute, type GuideShareRateLimiter } from '../share/core/handler';
import type { GuideStore } from '../share/core/storage';
import { FsGuideStore } from '../share/stores/fs';
import { MemoryGuideStore } from '../share/stores/memory';
import { S3GuideStore } from '../share/stores/s3';
import { viewerAssetHeaders, viewerKeyFromPath } from '../worker/index';

const APP_DIR = path.resolve(import.meta.dirname, '..');

export const DEFAULT_PORT = 8788;
export const DEFAULT_HOST = '0.0.0.0';
/** Relative specs resolve against the working directory, like any CLI path. */
export const DEFAULT_STORE_SPEC = 'fs:./guides-data';
export const DEFAULT_VIEWER_DIR = path.join(APP_DIR, 'dist', 'viewer');
export const DEFAULT_SITE_DIR = path.join(APP_DIR, 'site');
/** Uploads per client address per minute; the Worker's `[[ratelimits]]` binding uses the same figure. */
export const DEFAULT_UPLOAD_LIMIT = 30;

export interface GuidesShowServeOptions {
  port: number;
  host: string;
  /** `fs:<dir>`, `s3:<bucket>` or `memory`. */
  store: string;
  viewerDir: string;
  siteDir: string;
  /**
   * Fixed public origin (`https://guides.example.com`) that pages pin and
   * hosted URLs use, whatever host or headers a request arrives with. The
   * safe way to run behind TLS termination: nothing client-controlled reaches
   * the page's script src or CSP.
   */
  publicOrigin?: string;
  /** Honor `X-Forwarded-Proto` / `X-Forwarded-Host` (first hop) for the request origin when no `publicOrigin` is set, and the last `X-Forwarded-For` hop as the client address. Only behind a proxy you control that SETS these headers. */
  trustProxy: boolean;
  /** Uploads per client address per minute; 0 disables the limiter. */
  uploadLimit: number;
  /** Operator ceiling on how long any guide is kept, in seconds; undefined = kept until unshared. */
  maxTtlSeconds?: number;
}

export class UsageError extends Error {}

const USAGE = `Usage: bun run apps/guides-show/targets/bun.ts [options]

  --port <n>             Port to listen on (env PORT; default ${DEFAULT_PORT})
  --host <addr>          Address to bind (env GUIDES_SHOW_HOST; default ${DEFAULT_HOST})
  --store <spec>         fs:<dir> | s3:<bucket> | memory (env GUIDES_SHOW_STORE; default ${DEFAULT_STORE_SPEC})
  --viewer-dir <dir>     Viewer build served under /v1/ (env GUIDES_SHOW_VIEWER_DIR; default dist/viewer)
  --public-origin <url>  Fixed https origin pages pin and links use, e.g. https://guides.example.com
                         (env GUIDES_SHOW_PUBLIC_ORIGIN). Preferred behind a TLS proxy.
  --trust-proxy          Take the request origin from X-Forwarded-Proto / X-Forwarded-Host and the client
                         address from X-Forwarded-For (env GUIDES_SHOW_TRUST_PROXY=1). The proxy must set
                         those headers itself, never pass a client's through.
  --upload-limit <n>     Uploads per client address per minute; 0 disables (env GUIDES_SHOW_UPLOAD_LIMIT; default ${DEFAULT_UPLOAD_LIMIT})
  --max-ttl <duration>   Keep no guide longer than this: seconds, or 30m / 24h / 7d. Uploads without a ttl
                         get this lifetime, longer requests are clamped (env GUIDES_SHOW_MAX_TTL; default: kept until unshared)
  --help                 Show this help

s3: stores read credentials and the endpoint from Bun's S3_* / AWS_* environment variables.`;

const VALUE_FLAGS = new Set(['--port', '--host', '--store', '--viewer-dir', '--public-origin', '--upload-limit', '--max-ttl']);

/** Parse flags with env fallbacks. Throws `UsageError` for an unknown flag, a missing value or a non-numeric port. */
export function parseServeOptions(argv: readonly string[], env: Record<string, string | undefined> = process.env): GuidesShowServeOptions | 'help' {
  const values: Record<string, string> = {};
  let trustProxy = isTruthy(env.GUIDES_SHOW_TRUST_PROXY);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg === '--trust-proxy') {
      trustProxy = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    if (!VALUE_FLAGS.has(flag)) throw new UsageError(`Unknown option: ${arg}`);
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined || value === '') throw new UsageError(`${flag} needs a value`);
    values[flag] = value;
  }
  const portText = values['--port'] ?? env.PORT;
  const port = portText === undefined || portText === '' ? DEFAULT_PORT : Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`Invalid port: ${portText}`);
  const publicOriginText = values['--public-origin'] ?? nonEmpty(env.GUIDES_SHOW_PUBLIC_ORIGIN);
  const publicOrigin = publicOriginText === undefined ? undefined : parsePublicOrigin(publicOriginText);
  const uploadLimitText = values['--upload-limit'] ?? nonEmpty(env.GUIDES_SHOW_UPLOAD_LIMIT);
  const uploadLimit = uploadLimitText === undefined ? DEFAULT_UPLOAD_LIMIT : Number(uploadLimitText);
  if (!Number.isInteger(uploadLimit) || uploadLimit < 0) throw new UsageError(`Invalid --upload-limit: ${uploadLimitText}`);
  const maxTtlText = values['--max-ttl'] ?? nonEmpty(env.GUIDES_SHOW_MAX_TTL);
  const maxTtlSeconds = maxTtlText === undefined ? undefined : parseDuration(maxTtlText);
  if (maxTtlText !== undefined && maxTtlSeconds === null) throw new UsageError(`Invalid --max-ttl: ${maxTtlText} (seconds, or 30m / 24h / 7d)`);
  return {
    port,
    host: values['--host'] ?? nonEmpty(env.GUIDES_SHOW_HOST) ?? DEFAULT_HOST,
    store: values['--store'] ?? nonEmpty(env.GUIDES_SHOW_STORE) ?? DEFAULT_STORE_SPEC,
    viewerDir: path.resolve(values['--viewer-dir'] ?? nonEmpty(env.GUIDES_SHOW_VIEWER_DIR) ?? DEFAULT_VIEWER_DIR),
    siteDir: DEFAULT_SITE_DIR,
    ...(publicOrigin !== undefined && { publicOrigin }),
    trustProxy,
    uploadLimit,
    ...(maxTtlSeconds !== undefined && maxTtlSeconds !== null && { maxTtlSeconds }),
  };
}

/** `https://host[:port]` (or `http://localhost[:port]`, the one http origin exported guides accept); anything else is a usage error. */
export function parsePublicOrigin(text: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new UsageError(`Invalid --public-origin: ${text} (expected https://host)`);
  }
  const localhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localhost)) {
    throw new UsageError(`Invalid --public-origin: ${text} (must be https, or http on localhost)`);
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username || url.password) {
    throw new UsageError(`Invalid --public-origin: ${text} (origin only, no path)`);
  }
  return url.origin;
}

/** Seconds, or `<n>s` / `<n>m` / `<n>h` / `<n>d`; null when unparsable or not positive. */
export function parseDuration(text: string): number | null {
  const m = text.trim().match(/^(\d+)([smhd])?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  const unit = m[2] ?? 's';
  return n * (unit === 'd' ? 86_400 : unit === 'h' ? 3_600 : unit === 'm' ? 60 : 1);
}

/**
 * In-memory fixed-window limiter, one process. `limit` uploads per key per
 * minute; keys not seen for a full window are dropped so the map cannot grow
 * without bound.
 */
export class MemoryUploadLimiter implements GuideShareRateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(private readonly perWindow: number, private readonly windowMs = 60_000, private readonly now: () => number = Date.now) {}
  async limit({ key }: { key: string }): Promise<{ success: boolean }> {
    const t = this.now();
    if (this.windows.size > 10_000) {
      for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
    }
    const w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      this.windows.set(key, { start: t, count: 1 });
      return { success: this.perWindow >= 1 };
    }
    w.count += 1;
    return { success: w.count <= this.perWindow };
  }
}

/** `fs:<dir>` → FsGuideStore, `s3:<bucket>` → S3GuideStore, `memory` → MemoryGuideStore (lost on restart; local trials only). */
export function createGuideStore(spec: string): GuideStore {
  if (spec === 'memory') return new MemoryGuideStore();
  const sep = spec.indexOf(':');
  const kind = sep >= 0 ? spec.slice(0, sep) : spec;
  const target = sep >= 0 ? spec.slice(sep + 1) : '';
  if (kind === 'fs' && target) return new FsGuideStore(path.resolve(target));
  if (kind === 's3' && target) return new S3GuideStore({ bucket: target });
  throw new UsageError(`Invalid --store "${spec}": expected fs:<dir>, s3:<bucket> or memory`);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

function isTruthy(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

export interface GuidesShowServer {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  hostname: string;
  stop(): void;
}

export interface StartOptions extends Partial<Omit<GuidesShowServeOptions, 'store'>> {
  /** A store instance wins over the `store` spec. */
  store?: GuideStore | string;
  /** A limiter instance wins over `uploadLimit` (tests). */
  rateLimit?: GuideShareRateLimiter;
}

/** Start the server. `port: 0` picks an ephemeral port (tests). */
export function startGuidesShowServer(options: StartOptions = {}): GuidesShowServer {
  const store = typeof options.store === 'object' ? options.store : createGuideStore(options.store ?? DEFAULT_STORE_SPEC);
  const viewerDir = path.resolve(options.viewerDir ?? DEFAULT_VIEWER_DIR);
  const siteDir = path.resolve(options.siteDir ?? DEFAULT_SITE_DIR);
  const trustProxy = options.trustProxy ?? false;
  const publicOrigin = options.publicOrigin;
  const uploadLimit = options.uploadLimit ?? DEFAULT_UPLOAD_LIMIT;
  const rateLimit = options.rateLimit ?? (uploadLimit > 0 ? new MemoryUploadLimiter(uploadLimit) : undefined);
  const maxTtlSeconds = options.maxTtlSeconds;
  const server = Bun.serve({
    port: options.port ?? DEFAULT_PORT,
    hostname: options.host ?? DEFAULT_HOST,
    // Uploads carry the whole guide body inside a JSON envelope; the handler
    // enforces its own 25 MiB cap on the stored body and refuses anything that
    // cannot fit before buffering, so give the envelope room above that.
    maxRequestBodySize: 64 * 1024 * 1024,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      if (pathname.startsWith('/v1/')) {
        const key = viewerKeyFromPath(pathname);
        if (!key) return new Response('bad request', { status: 400 });
        return serveViewerFile(req, key, viewerDir);
      }
      if (isGuideShareRoute(pathname)) {
        // Origin precedence: a fixed public origin (nothing client-controlled),
        // else the proxy's forwarded headers when trusted, else the socket.
        const rewritten = publicOrigin ? withOrigin(req, url, publicOrigin) : trustProxy ? forwardedRequest(req, url) : null;
        // Behind a trusted proxy the socket peer is the proxy, and the hop the
        // proxy appended to X-Forwarded-For (the last one) is the client; the
        // first hop is whatever the client sent.
        const socketIp = srv.requestIP(req)?.address;
        const clientIp = (trustProxy ? lastHop(req.headers.get('X-Forwarded-For')) : null) ?? socketIp ?? 'unknown';
        return handleGuideShareRequest(rewritten ?? req, {
          store,
          viewerManifest: GUIDE_VIEWER_MANIFEST,
          ...(rateLimit && { rateLimit }),
          clientIp,
          ...(maxTtlSeconds !== undefined && { maxTtlSeconds }),
        });
      }
      if (pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
      if (pathname === '/healthz') return json({ ok: true });
      return serveSiteFile(req, pathname, siteDir);
    },
  });
  return {
    server,
    port: server.port ?? 0,
    hostname: server.hostname ?? DEFAULT_HOST,
    stop: () => server.stop(true),
  };
}

/** Rebuild the request URL from the first `X-Forwarded-Proto` / `X-Forwarded-Host` hop so pages behind a TLS proxy pin the public https origin. Returns null when neither header is present. */
function forwardedRequest(req: Request, url: URL): Request | null {
  const proto = firstHop(req.headers.get('X-Forwarded-Proto'));
  const host = firstHop(req.headers.get('X-Forwarded-Host'));
  if (!proto && !host) return null;
  const scheme = proto === 'http' || proto === 'https' ? proto : url.protocol.slice(0, -1);
  // A forwarded host replaces host AND port: the proxy's public port is part of the value when it is not the default.
  const authority = host && /^[A-Za-z0-9.\-\[\]:]+$/.test(host) ? host : url.host;
  const rewritten = `${scheme}://${authority}${url.pathname}${url.search}`;
  if (rewritten === url.href) return null;
  return new Request(rewritten, req);
}

function firstHop(header: string | null): string | null {
  if (!header) return null;
  const first = header.split(',')[0].trim();
  return first || null;
}

function lastHop(header: string | null): string | null {
  if (!header) return null;
  const hops = header.split(',');
  const last = hops[hops.length - 1].trim();
  return last || null;
}

/** The request re-addressed to the fixed public origin (path and query kept). Null when nothing changes. */
function withOrigin(req: Request, url: URL, origin: string): Request | null {
  const rewritten = `${origin}${url.pathname}${url.search}`;
  if (rewritten === url.href) return null;
  return new Request(rewritten, req);
}

async function serveViewerFile(req: Request, key: string, viewerDir: string): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: viewerAssetHeaders(key) });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405, headers: { Allow: 'GET, HEAD, OPTIONS' } });
  }
  // `key` is `v1/<file>`; viewerKeyFromPath already refused traversal, and the
  // prefix check keeps a symlinked or odd path from escaping the directory.
  const filePath = path.resolve(viewerDir, key.slice('v1/'.length));
  if (!filePath.startsWith(viewerDir + path.sep)) return new Response('bad request', { status: 400 });
  const file = Bun.file(filePath);
  if (!(await file.exists())) return new Response('not found', { status: 404, headers: { 'Cache-Control': 'public, max-age=60' } });
  const headers = viewerAssetHeaders(key, {
    ETag: `W/"${file.size.toString(16)}-${file.lastModified.toString(16)}"`,
    'Content-Length': String(file.size),
  });
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(file, { status: 200, headers });
}

const SITE_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

/** The landing page and any other static file under site/, with the headers site/_headers declares for the Worker's asset binding. */
async function serveSiteFile(req: Request, pathname: string, siteDir: string): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (rel === '_headers' || rel.length > 512 || rel.includes('..') || rel.includes('//') || rel.endsWith('/') || !/^[A-Za-z0-9._\-\/]+$/.test(rel)) {
    return new Response('not found', { status: 404 });
  }
  const filePath = path.resolve(siteDir, rel);
  if (!filePath.startsWith(siteDir + path.sep)) return new Response('not found', { status: 404 });
  const file = Bun.file(filePath);
  if (!(await file.exists())) return new Response('not found', { status: 404 });
  const headers = {
    'Content-Type': SITE_CONTENT_TYPES[path.extname(rel)] ?? 'application/octet-stream',
    'Cache-Control': 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Length': String(file.size),
  };
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(file, { status: 200, headers });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  let parsed: GuidesShowServeOptions | 'help';
  try {
    parsed = parseServeOptions(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof UsageError ? error.message : String(error));
    console.error(USAGE);
    process.exit(2);
  }
  if (parsed === 'help') {
    console.log(USAGE);
    process.exit(0);
  }
  const options = parsed;
  let store: GuideStore;
  try {
    store = createGuideStore(options.store);
  } catch (error) {
    console.error(error instanceof UsageError ? error.message : String(error));
    process.exit(2);
  }
  const started = startGuidesShowServer({ ...options, store });
  const shown = started.hostname === '0.0.0.0' || started.hostname === '::' ? 'localhost' : started.hostname;
  console.log(`guides.show self-host listening on http://${shown}:${started.port}`);
  console.log(`  store:   ${options.store}`);
  console.log(`  viewer:  ${options.viewerDir} served at /v1/ (${GUIDE_VIEWER_MANIFEST.js})`);
  if (options.publicOrigin) console.log(`  origin:  ${options.publicOrigin} (fixed)`);
  else if (options.trustProxy) console.log('  origin:  from X-Forwarded-Proto / X-Forwarded-Host');
  console.log(`  uploads: ${options.uploadLimit > 0 ? `${options.uploadLimit}/min per client address` : 'unlimited'}${options.maxTtlSeconds !== undefined ? `, kept at most ${options.maxTtlSeconds}s` : ''}`);
  const shutdown = () => {
    started.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
