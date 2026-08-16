import { describe, expect, test } from 'bun:test';
import { GUIDE_VIEWER_MANIFEST } from '@plannotator/core/guide-viewer-manifest';
import { FIXTURE_V1_LOCAL } from '@plannotator/core/guide-format-fixtures';
import { GUIDE_HOSTED_META_NAME, GUIDE_PAYLOAD_META_NAME } from '@plannotator/core/guide-format';
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

  test('everything else is the static site', async () => {
    const res = await call('/');
    expect(await res.text()).toBe('landing');
  });

  test('viewerAssetHeaders types unknown extensions as octet-stream', () => {
    expect(viewerAssetHeaders('v1/x.bin').get('Content-Type')).toBe('application/octet-stream');
  });
});

describe('guides.show worker: shared guides', () => {
  const postGuide = (body: unknown, e: Env = env, headers: Record<string, string> = {}) =>
    call('/api/g', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } }, e);

  test('plain guide: create → page (og:title, hosted meta, this origin\'s /v1/) → JSON body → delete → 404 page; R2 holds body + meta objects', async () => {
    const e = makeEnv();
    const created = await postGuide({ mode: 'plain', data: JSON.stringify(FIXTURE_V1_LOCAL) }, e);
    expect(created.status).toBe(201);
    expect(created.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const { id, url, deleteToken } = (await created.json()) as { id: string; url: string; deleteToken: string };
    expect(url).toBe(`https://guides.show/g/${id}`);
    expect(e.GUIDES.keys().sort()).toEqual([`g/${id}`, `g/${id}.meta`]);

    const page = await call(`/g/${id}`, undefined, e);
    expect(page.status).toBe(200);
    expect(page.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('Cache-Control')).toBe('public, max-age=300');
    const html = await page.text();
    expect(html).toContain(`<meta property="og:title" content="${FIXTURE_V1_LOCAL.guide.title}">`);
    expect(html).toContain(`<meta name="${GUIDE_HOSTED_META_NAME}" content="${url}">`);
    expect(html).toContain(`src="https://guides.show/v1/${GUIDE_VIEWER_MANIFEST.js}"`);
    expect(html).not.toContain(GUIDE_PAYLOAD_META_NAME);

    const body = await call(`/api/g/${id}`, undefined, e);
    expect(body.status).toBe(200);
    expect(body.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(body.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(((await body.json()) as { guide: { title: string } }).guide.title).toBe(FIXTURE_V1_LOCAL.guide.title);

    expect((await call(`/api/g/${id}`, { method: 'DELETE' }, e)).status).toBe(401);
    expect((await call(`/api/g/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${deleteToken}` } }, e)).status).toBe(204);
    expect(e.GUIDES.keys()).toEqual([]);
    const gone = await call(`/g/${id}`, undefined, e);
    expect(gone.status).toBe(404);
    expect(await gone.text()).toContain('class="pgr-fallback"');
    expect((await call(`/api/g/${id}`, undefined, e)).status).toBe(404);
  });

  test('encrypted guide: the page is the shell pointing at /api/g/<id>, which serves the ciphertext as text', async () => {
    const e = makeEnv();
    const created = await postGuide({ mode: 'encrypted', data: 'c2VjcmV0LWNpcGhlcnRleHQ', viewer: GUIDE_VIEWER_MANIFEST, ttlSeconds: 86400 }, e);
    expect(created.status).toBe(201);
    const { id, expiresAt } = (await created.json()) as { id: string; expiresAt?: string };
    expect(typeof expiresAt).toBe('string');
    const html = await (await call(`/g/${id}`, undefined, e)).text();
    expect(html).toContain(`<meta name="${GUIDE_PAYLOAD_META_NAME}" content="/api/g/${id}">`);
    expect(html).not.toContain('secret');
    const body = await call(`/api/g/${id}`, undefined, e);
    expect(body.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(await body.text()).toBe('c2VjcmV0LWNpcGhlcnRleHQ');
  });

  test('bad uploads: invalid plain snapshot 400 with path, over-cap 413, rate limited 429 when the binding says so', async () => {
    const invalid = await postGuide({ mode: 'plain', data: '{"kind":"nope"}' });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { path: string }).path).toBe('$.kind');
    const huge = await postGuide({ mode: 'encrypted', data: 'a'.repeat(25 * 1024 * 1024 + 1) });
    expect(huge.status).toBe(413);
    const limited = makeEnv({ RATE_LIMITER: { limit: async () => ({ success: false }) } });
    expect((await postGuide({ mode: 'encrypted', data: 'abc' }, limited)).status).toBe(429);
    const open = makeEnv({ RATE_LIMITER: { limit: async () => ({ success: true }) } });
    expect((await postGuide({ mode: 'encrypted', data: 'abc' }, open)).status).toBe(201);
  });

  test('MAX_TTL_SECONDS caps every upload; unset or unusable keeps the no-expiry default', async () => {
    const capped = makeEnv({ MAX_TTL_SECONDS: '3600' });
    const created = (await (await postGuide({ mode: 'encrypted', data: 'abc' }, capped)).json()) as { expiresAt?: string };
    expect(typeof created.expiresAt).toBe('string');
    expect(Date.parse(created.expiresAt!) - Date.now()).toBeLessThanOrEqual(3600 * 1000);
    const longer = (await (await postGuide({ mode: 'encrypted', data: 'abc', ttlSeconds: 86_400 }, capped)).json()) as { expiresAt?: string };
    expect(Date.parse(longer.expiresAt!) - Date.now()).toBeLessThanOrEqual(3600 * 1000);
    for (const e of [env, makeEnv({ MAX_TTL_SECONDS: '' }), makeEnv({ MAX_TTL_SECONDS: 'forever' })]) {
      const open = (await (await postGuide({ mode: 'encrypted', data: 'abc' }, e)).json()) as { expiresAt?: string };
      expect(open.expiresAt).toBeUndefined();
    }
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
      expect(await res.text()).toContain('Guide not found');
    }
    // The landing page and /v1 are untouched by the share routes.
    expect(await (await call('/')).text()).toBe('landing');
    expect((await call('/v1/viewer.abc.js')).status).toBe(200);
  });
});
