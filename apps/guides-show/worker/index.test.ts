import { describe, expect, test } from 'bun:test';
import { GUIDE_VIEWER_MANIFEST } from '@plannotator/core/guide-viewer-manifest';
import { FIXTURE_V1_LOCAL } from '@plannotator/core/guide-format-fixtures';
import { GUIDE_PAYLOAD_META_NAME } from '@plannotator/core/guide-format';
import worker, { viewerAssetHeaders, viewerKeyFromPath, type Env } from './index';

/** Enough of R2Bucket for both bindings: /v1 reads (head/get with body) and the guide store (put/get text/delete). */
class FakeBucket {
  constructor(private objects: Record<string, string> = {}) {}
  async head(key: string) {
    const body = this.objects[key];
    return body === undefined ? null : { key, size: body.length, httpEtag: `"${key}"` };
  }
  async get(key: string) {
    const body = this.objects[key];
    return body === undefined ? null : { key, size: body.length, httpEtag: `"${key}"`, body, text: async () => body };
  }
  async put(key: string, value: string) {
    this.objects[key] = value;
    return { key };
  }
  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete this.objects[key];
  }
  keys(): string[] {
    return Object.keys(this.objects);
  }
}

function makeEnv(overrides: Partial<Env> = {}): Env & { GUIDES: R2Bucket & FakeBucket } {
  return {
    VIEWER: new FakeBucket({ 'v1/viewer.abc.js': 'console.log(1)', 'v1/fonts/inter.woff2': 'F' }) as unknown as R2Bucket,
    GUIDES: new FakeBucket() as unknown as R2Bucket & FakeBucket,
    ASSETS: { fetch: async () => new Response('landing', { status: 200 }) } as unknown as Fetcher,
    ...overrides,
  };
}

const env = makeEnv();
const call = (path: string, init?: RequestInit, e: Env = env) => worker.fetch(new Request(`https://guides.show${path}`, init), e);

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
    expect(viewerAssetHeaders('v1/x.bin').get('Content-Type')).toBe('application/octet-stream');
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

  test('unknown /api paths outside the share API answer 404 JSON without touching assets', async () => {
    const res = await call('/api/anything');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });
});

describe('guides.show worker: shared guides', () => {
  const postGuide = (body: unknown, e: Env = env) =>
    call('/api/g', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }, e);

  // Only the wiring is asserted here: the R2 store is bound, the bundled
  // GUIDE_VIEWER_MANIFEST is the fallback pin, and the share routes are
  // dispatched on this origin. Route semantics live in share/core/handler.test.ts.
  test('share routes run over the GUIDES bucket with the bundled manifest as the fallback pin', async () => {
    const e = makeEnv();
    const created = await postGuide({ mode: 'plain', data: JSON.stringify(FIXTURE_V1_LOCAL) }, e);
    expect(created.status).toBe(201);
    const { id, url, deleteToken } = (await created.json()) as { id: string; url: string; deleteToken: string };
    expect(url).toBe(`https://guides.show/g/${id}`);
    const html = await (await call(`/g/${id}`, undefined, e)).text();
    expect(html).toContain(`src="https://guides.show/v1/${GUIDE_VIEWER_MANIFEST.js}"`);
    expect((await call(`/api/g/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${deleteToken}` } }, e)).status).toBe(204);
    expect(e.GUIDES.keys()).toEqual([]);
    expect((await call(`/g/${id}`, undefined, e)).status).toBe(404);

    // An uploaded pin (the real manifest shape) is accepted and ciphertext survives R2 as text.
    const enc = await postGuide({ mode: 'encrypted', data: 'c2VjcmV0LWNpcGhlcnRleHQ', viewer: GUIDE_VIEWER_MANIFEST }, e);
    expect(enc.status).toBe(201);
    const encId = ((await enc.json()) as { id: string }).id;
    expect(await (await call(`/g/${encId}`, undefined, e)).text()).toContain(`<meta name="${GUIDE_PAYLOAD_META_NAME}" content="/api/g/${encId}">`);
    const body = await call(`/api/g/${encId}`, undefined, e);
    expect(body.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(await body.text()).toBe('c2VjcmV0LWNpcGhlcnRleHQ');
  });

  test('CORS preflight on /api/g* and 404 pages for unknown or reserved guide paths', async () => {
    const preflight = await call('/api/g', { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toBe('POST, GET, DELETE, OPTIONS');
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Authorization');
    expect((await call('/api/g/whatever', { method: 'OPTIONS' })).status).toBe(204);
    for (const path of ['/g', '/g/', '/g/nope']) {
      const res = await call(path);
      expect(res.status).toBe(404);
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
      expect(await res.text()).toContain('class="pgr-fallback"');
    }
    // The landing page and /v1 are untouched by the share routes.
    expect(await (await call('/')).text()).toBe('landing');
    expect((await call('/v1/viewer.abc.js')).status).toBe(200);
  });
});
