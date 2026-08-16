/**
 * guides.show — Cloudflare Worker.
 *
 * Serves the immutable portable-guide viewer from R2 under /v1/, a static
 * landing page, and shared guides: /g/<id> pages plus the /api/g* create,
 * fetch and delete routes (contract: adr/implementation/guide-share-hosting.md).
 * The share routes are the pure handler in ../share/core/handler.ts over an R2
 * store; the Bun self-host target runs the same handler over fs or S3.
 *
 * Why R2 for /v1 and not Workers Static Assets: assets are a per-deploy
 * snapshot, so a file missing from the next deploy disappears — but every HTML
 * ever exported pins a specific viewer build by URL + integrity, and must keep
 * opening forever (D8). R2 objects are only ever added.
 */
import { GUIDE_VIEWER_MANIFEST } from '@plannotator/core/guide-viewer-manifest';
import { handleGuideShareRequest, isGuideShareRoute } from '../share/core/handler';
import { R2GuideStore } from '../share/stores/r2';

export interface Env {
  VIEWER: R2Bucket;
  /** Shared guides: `g/<id>` bodies + `g/<id>.meta` records (see share/stores/r2.ts). */
  GUIDES: R2Bucket;
  /** Optional Cloudflare rate-limiting binding; uploads only. Absent = no limiting. */
  RATE_LIMITER?: RateLimit;
  /**
   * Optional operator ceiling on how long any shared guide is kept, in
   * seconds (`[vars]` in wrangler.toml). Uploads without a ttl get this
   * lifetime and longer requests are clamped; absent or unparsable = the
   * contract default, kept until unshared. The kill switch for storage growth.
   */
  MAX_TTL_SECONDS?: string;
  ASSETS: Fetcher;
}

/** `MAX_TTL_SECONDS` as a positive integer, or undefined when unset/unusable. */
export function maxTtlSecondsFrom(env: Pick<Env, 'MAX_TTL_SECONDS'>): number | undefined {
  const n = Number(env.MAX_TTL_SECONDS);
  return env.MAX_TTL_SECONDS !== undefined && env.MAX_TTL_SECONDS !== '' && Number.isSafeInteger(n) && n >= 1 ? n : undefined;
}

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

function contentTypeFor(key: string): string {
  const dot = key.lastIndexOf('.');
  return (dot >= 0 && CONTENT_TYPES[key.slice(dot)]) || 'application/octet-stream';
}

/** Headers every /v1 asset carries: immutable (content-hashed names) and readable from any origin, including file:// documents (Origin: null). */
export function viewerAssetHeaders(key: string, extra?: Record<string, string>): Headers {
  const h = new Headers({
    'Content-Type': contentTypeFor(key),
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, ETag',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Timing-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
  });
  for (const [k, v] of Object.entries(extra ?? {})) h.set(k, v);
  return h;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

/** Keys are `v1/<file>`; reject anything that is not a plain nested filename. */
export function viewerKeyFromPath(pathname: string): string | null {
  if (!pathname.startsWith('/v1/')) return null;
  const key = pathname.slice(1);
  if (key.length > 512) return null;
  if (key.includes('..') || key.includes('//') || key.endsWith('/') || key.includes('\\')) return null;
  if (!/^v1\/[A-Za-z0-9._\-\/]+$/.test(key)) return null;
  return key;
}

async function serveViewerAsset(req: Request, key: string, bucket: R2Bucket): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: viewerAssetHeaders(key) });
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('method not allowed', { status: 405, headers: { Allow: 'GET, HEAD, OPTIONS' } });
  const object = req.method === 'HEAD' ? await bucket.head(key) : await bucket.get(key);
  if (!object) return new Response('not found', { status: 404, headers: { 'Cache-Control': 'public, max-age=60' } });
  const headers = viewerAssetHeaders(key, {
    ETag: object.httpEtag,
    'Content-Length': String(object.size),
  });
  if (req.method === 'HEAD' || !('body' in object)) return new Response(null, { status: 200, headers });
  return new Response(object.body, { status: 200, headers });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path.startsWith('/v1/')) {
      const key = viewerKeyFromPath(path);
      if (!key) return new Response('bad request', { status: 400 });
      return serveViewerAsset(req, key, env.VIEWER);
    }
    if (isGuideShareRoute(path)) {
      // Shared guides. The handler pins this Worker's own /v1/ as the viewer
      // base and this origin as the canonical page URL, both taken from req.url.
      const maxTtlSeconds = maxTtlSecondsFrom(env);
      return handleGuideShareRequest(req, {
        store: new R2GuideStore(env.GUIDES),
        viewerManifest: GUIDE_VIEWER_MANIFEST,
        rateLimit: env.RATE_LIMITER,
        ...(maxTtlSeconds !== undefined && { maxTtlSeconds }),
      });
    }
    if (path.startsWith('/api/')) return json({ error: 'not found' }, 404);
    if (path === '/healthz') return json({ ok: true });

    // Landing and any other static page.
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
