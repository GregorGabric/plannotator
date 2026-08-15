/// <reference types="bun-types" />
/**
 * Local stand-in for guide.show: serves dist/viewer under /v1/ with the same
 * headers the Worker sends (immutable cache, CORS for file:// documents).
 *   bun build/serve-local.ts [--port 8787]
 */
import path from 'node:path';
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1] || 8787);
const root = path.resolve(import.meta.dirname, '../dist/viewer');
const types: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.html': 'text/html; charset=utf-8', '.map': 'application/json' };
Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/v1/')) return new Response('guide.show local', { status: 404 });
    const rel = url.pathname.slice('/v1/'.length);
    const file = Bun.file(path.join(root, rel));
    if (!(await file.exists())) return new Response('not found', { status: 404 });
    return new Response(file, {
      headers: {
        'Content-Type': types[path.extname(rel)] ?? 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      },
    });
  },
});
console.log(`serving ${root} at http://localhost:${port}/v1/`);
