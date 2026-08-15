import { describe, expect, test } from 'bun:test';
import worker, { viewerAssetHeaders, viewerKeyFromPath } from './index';

class FakeBucket {
  constructor(private objects: Record<string, string>) {}
  async head(key: string) {
    const body = this.objects[key];
    return body === undefined ? null : { key, size: body.length, httpEtag: `"${key}"` };
  }
  async get(key: string) {
    const body = this.objects[key];
    return body === undefined ? null : { key, size: body.length, httpEtag: `"${key}"`, body };
  }
}

const env = {
  VIEWER: new FakeBucket({ 'v1/viewer.abc.js': 'console.log(1)', 'v1/fonts/inter.woff2': 'F' }) as unknown as R2Bucket,
  ASSETS: { fetch: async () => new Response('landing', { status: 200 }) } as unknown as Fetcher,
};
const call = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://guides.show${path}`, init), env);

describe('guides.show worker', () => {
  test('serves /v1 assets from R2 as immutable, cross-origin-readable, typed', async () => {
    const res = await call('/v1/viewer.abc.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log(1)');
    expect(res.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    // file:// documents send Origin: null — only a wildcard lets them load fonts/grammars/the worker.
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
    const font = await call('/v1/fonts/inter.woff2');
    expect(font.headers.get('Content-Type')).toBe('font/woff2');
  });

  test('HEAD and OPTIONS work; other methods are refused', async () => {
    expect((await call('/v1/viewer.abc.js', { method: 'HEAD' })).status).toBe(200);
    expect((await call('/v1/viewer.abc.js', { method: 'OPTIONS' })).status).toBe(204);
    expect((await call('/v1/viewer.abc.js', { method: 'POST' })).status).toBe(405);
  });

  test('missing assets are 404 with a short cache, never falling through to the landing page', async () => {
    const res = await call('/v1/viewer.nope.js');
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
  });

  test('rejects traversal and malformed keys', async () => {
    expect(viewerKeyFromPath('/v1/../secret')).toBeNull();
    expect(viewerKeyFromPath('/v1//x.js')).toBeNull();
    expect(viewerKeyFromPath('/v1/dir/')).toBeNull();
    expect(viewerKeyFromPath('/v1/ok/name-1.2_3.js')).toBe('v1/ok/name-1.2_3.js');
    // Dot segments are resolved by the URL parser before we see them (so they
    // simply leave /v1); anything percent-encoded or otherwise odd is refused.
    expect((await call('/v1/a%5cb.js')).status).toBe(400);
    expect((await call('/v1/a%20b.js')).status).toBe(400);
  });

  test('reserved routes answer 404 JSON without touching assets or R2', async () => {
    const g = await call('/g/abc123');
    expect(g.status).toBe(404);
    expect((await g.json()) as { reserved: boolean }).toEqual({ reserved: true, message: 'Shared guides are not available yet.' });
    expect((await call('/api/anything')).status).toBe(404);
  });

  test('everything else is the static site', async () => {
    const res = await call('/');
    expect(await res.text()).toBe('landing');
  });

  test('viewerAssetHeaders types unknown extensions as octet-stream', () => {
    expect(viewerAssetHeaders('v1/x.bin').get('Content-Type')).toBe('application/octet-stream');
  });
});
