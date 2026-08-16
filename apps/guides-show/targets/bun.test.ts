import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compress, decompress } from '@plannotator/core/compress';
import { decrypt, encrypt } from '@plannotator/core/crypto';
import { GUIDE_HOSTED_META_NAME, GUIDE_PAYLOAD_META_NAME, parseGuideSnapshot } from '@plannotator/core/guide-format';
import { FIXTURE_V1_PR } from '@plannotator/core/guide-format-fixtures';
import { GUIDE_VIEWER_MANIFEST } from '@plannotator/core/guide-viewer-manifest';
import { FsGuideStore } from '../share/stores/fs';
import { MemoryGuideStore } from '../share/stores/memory';
import { S3GuideStore } from '../share/stores/s3';
import {
  DEFAULT_PORT,
  DEFAULT_STORE_SPEC,
  DEFAULT_UPLOAD_LIMIT,
  DEFAULT_VIEWER_DIR,
  MemoryUploadLimiter,
  UsageError,
  createGuideStore,
  parseDuration,
  parsePublicOrigin,
  parseServeOptions,
  startGuidesShowServer,
  type GuidesShowServer,
} from './bun';

interface Created {
  id: string;
  url: string;
  deleteToken: string;
  expiresAt?: string;
}

describe('guides.show bun target: server', () => {
  let tmp: string;
  let started: GuidesShowServer;
  let origin: string;

  beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'guides-show-bun-'));
    // A stand-in viewer build: one entry file plus a nested grammar chunk.
    mkdirSync(path.join(tmp, 'viewer', 'chunks'), { recursive: true });
    writeFileSync(path.join(tmp, 'viewer', 'viewer.test.js'), 'export const viewer = 1;\n');
    writeFileSync(path.join(tmp, 'viewer', 'chunks', 'lang.test.js'), 'export const lang = 1;\n');
    writeFileSync(path.join(tmp, 'secret.txt'), 'outside the viewer dir\n');
    started = startGuidesShowServer({
      port: 0,
      host: '127.0.0.1',
      store: new FsGuideStore(path.join(tmp, 'guides')),
      viewerDir: path.join(tmp, 'viewer'),
    });
    origin = `http://127.0.0.1:${started.port}`;
  });

  afterAll(() => {
    started.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  const call = (p: string, init?: RequestInit) => fetch(`${origin}${p}`, init);
  const post = (body: unknown) => call('/api/g', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });

  test('encrypted guide over the fs store: create → shell page with the payload meta → ciphertext body → delete → 404', async () => {
    const { ciphertext, key } = await encrypt(await compress(FIXTURE_V1_PR));
    const created = await post({ mode: 'encrypted', data: ciphertext, viewer: GUIDE_VIEWER_MANIFEST });
    expect(created.status).toBe(201);
    const { id, url, deleteToken } = (await created.json()) as Created;
    // The hosted URL is built from the origin the request arrived on, not a configured hostname.
    expect(url).toBe(`${origin}/g/${id}`);

    const page = await call(`/g/${id}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    const html = await page.text();
    expect(html).toContain(`<meta name="${GUIDE_PAYLOAD_META_NAME}" content="/api/g/${id}">`);
    expect(html).toContain(`<meta name="${GUIDE_HOSTED_META_NAME}" content="${url}">`);
    // The shell pins this host's own /v1/ as the viewer base.
    expect(html).toContain(`src="${origin}/v1/${GUIDE_VIEWER_MANIFEST.js}"`);
    expect(html).not.toContain(FIXTURE_V1_PR.guide.title);

    const body = await call(`/api/g/${id}`);
    expect(body.status).toBe(200);
    expect(body.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(body.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const text = await body.text();
    expect(text).toBe(ciphertext);
    const snapshot = parseGuideSnapshot(await decompress(await decrypt(text, key)));
    expect(snapshot.ok && snapshot.value.guide.title).toBe(FIXTURE_V1_PR.guide.title);

    expect((await call(`/api/g/${id}`, { method: 'DELETE' })).status).toBe(401);
    expect((await call(`/api/g/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${deleteToken}` } })).status).toBe(204);
    expect((await call(`/api/g/${id}`)).status).toBe(404);
    const gone = await call(`/g/${id}`);
    expect(gone.status).toBe(404);
    expect(await gone.text()).toContain('class="pgr-fallback"');
  });

  test('plain guide from FIXTURE_V1_PR renders the full page with og:title and no payload meta', async () => {
    const created = await post({ mode: 'plain', data: JSON.stringify(FIXTURE_V1_PR) });
    expect(created.status).toBe(201);
    const { id, url } = (await created.json()) as Created;
    const page = await call(`/g/${id}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('Cache-Control')).toBe('public, max-age=300');
    const html = await page.text();
    expect(html).toContain(`<meta property="og:title" content="${FIXTURE_V1_PR.guide.title}">`);
    expect(html).toContain(`<meta name="${GUIDE_HOSTED_META_NAME}" content="${url}">`);
    expect(html).not.toContain(GUIDE_PAYLOAD_META_NAME);
    const body = await call(`/api/g/${id}`);
    expect(body.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(((await body.json()) as { guide: { title: string } }).guide.title).toBe(FIXTURE_V1_PR.guide.title);
  });

  test('CORS preflight on /api/g and the JSON 404 for other /api paths', async () => {
    const preflight = await call('/api/g', { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toBe('POST, GET, DELETE, OPTIONS');
    const other = await call('/api/nope');
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ error: 'not found' });
  });

  test('/v1/* serves the viewer dir with the Worker headers; HEAD carries the length; traversal and escapes are refused', async () => {
    const asset = await call('/v1/viewer.test.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    expect(asset.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(asset.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(asset.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
    expect(await asset.text()).toBe('export const viewer = 1;\n');

    const chunk = await call('/v1/chunks/lang.test.js');
    expect(chunk.status).toBe(200);
    expect(await chunk.text()).toBe('export const lang = 1;\n');

    const head = await call('/v1/viewer.test.js', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Length')).toBe(String('export const viewer = 1;\n'.length));

    const preflight = await call('/v1/viewer.test.js', { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('*');

    expect((await call('/v1/missing.js')).status).toBe(404);
    // fetch() collapses `..` segments client-side, so send the raw path over a socket: the server must never hand out the file outside the viewer dir.
    const traversal = await rawGet(started.port, '/v1/../secret.txt');
    expect([400, 404]).toContain(traversal.status);
    expect(traversal.body).not.toContain('outside the viewer dir');
    const encoded = await call('/v1/%2e%2e/secret.txt');
    expect([400, 404]).toContain(encoded.status);
    expect(await encoded.text()).not.toContain('outside the viewer dir');
  });

  test('/healthz and the landing page from site/', async () => {
    const health = await call('/healthz');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const landing = await call('/');
    expect(landing.status).toBe(200);
    expect(landing.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(landing.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await landing.text()).toContain('<title>guides.show</title>');
    // Never leak the Cloudflare headers file or anything outside site/.
    expect((await call('/_headers')).status).toBe(404);
    expect((await call('/nope.html')).status).toBe(404);
  });
});

describe('guides.show bun target: --trust-proxy', () => {
  test('pages behind a TLS proxy pin the forwarded https origin; without the flag the forwarded headers are ignored', async () => {
    const plain = startGuidesShowServer({ port: 0, host: '127.0.0.1', store: new MemoryGuideStore() });
    const proxied = startGuidesShowServer({ port: 0, host: '127.0.0.1', store: new MemoryGuideStore(), trustProxy: true });
    try {
      const headers = { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'guides.example.com' };
      const body = JSON.stringify({ mode: 'plain', data: JSON.stringify(FIXTURE_V1_PR) });

      const ignored = await fetch(`http://127.0.0.1:${plain.port}/api/g`, { method: 'POST', body, headers });
      const ignoredBody = (await ignored.json()) as Created;
      expect(ignoredBody.url).toBe(`http://127.0.0.1:${plain.port}/g/${ignoredBody.id}`);

      const created = await fetch(`http://127.0.0.1:${proxied.port}/api/g`, { method: 'POST', body, headers });
      expect(created.status).toBe(201);
      const { id, url } = (await created.json()) as Created;
      expect(url).toBe(`https://guides.example.com/g/${id}`);
      const page = await fetch(`http://127.0.0.1:${proxied.port}/g/${id}`, { headers });
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain(`<meta name="${GUIDE_HOSTED_META_NAME}" content="https://guides.example.com/g/${id}">`);
      expect(html).toContain(`src="https://guides.example.com/v1/${GUIDE_VIEWER_MANIFEST.js}"`);
    } finally {
      plain.stop();
      proxied.stop();
    }
  });
});

describe('guides.show bun target: --public-origin', () => {
  test('a fixed public origin wins over the request host and any forwarded headers, so nothing client-sent reaches the page', async () => {
    const fixed = startGuidesShowServer({ port: 0, host: '127.0.0.1', store: new MemoryGuideStore(), publicOrigin: 'https://guides.example.com', trustProxy: true });
    try {
      const headers = { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'evil.example' };
      const body = JSON.stringify({ mode: 'plain', data: JSON.stringify(FIXTURE_V1_PR) });
      const created = await fetch(`http://127.0.0.1:${fixed.port}/api/g`, { method: 'POST', body, headers });
      expect(created.status).toBe(201);
      const { id, url } = (await created.json()) as Created;
      expect(url).toBe(`https://guides.example.com/g/${id}`);
      const page = await fetch(`http://127.0.0.1:${fixed.port}/g/${id}`, { headers });
      const html = await page.text();
      expect(html).toContain(`src="https://guides.example.com/v1/${GUIDE_VIEWER_MANIFEST.js}"`);
      expect(html).not.toContain('evil.example');
      // The failure page names the public host too.
      expect(await (await fetch(`http://127.0.0.1:${fixed.port}/g/doesnotexist0000000000`)).text()).toContain('<a href="/">guides.example.com</a>');
    } finally {
      fixed.stop();
    }
  });
});

describe('guides.show bun target: upload limiter', () => {
  test('uploads past the per-address limit are 429; reads are never limited; 0 disables the limiter', async () => {
    const limited = startGuidesShowServer({ port: 0, host: '127.0.0.1', store: new MemoryGuideStore(), uploadLimit: 2 });
    const open = startGuidesShowServer({ port: 0, host: '127.0.0.1', store: new MemoryGuideStore(), uploadLimit: 0 });
    try {
      const post = (port: number) => fetch(`http://127.0.0.1:${port}/api/g`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'encrypted', data: 'abc' }) });
      const first = (await post(limited.port).then((r) => r.json())) as Created;
      expect((await post(limited.port)).status).toBe(201);
      const third = await post(limited.port);
      expect(third.status).toBe(429);
      expect(third.headers.get('Retry-After')).toBe('60');
      expect((await fetch(`http://127.0.0.1:${limited.port}/api/g/${first.id}`)).status).toBe(200);
      for (let i = 0; i < 4; i++) expect((await post(open.port)).status).toBe(201);
    } finally {
      limited.stop();
      open.stop();
    }
  });

  test('behind a trusted proxy the client is the LAST X-Forwarded-For hop (the one the proxy appended), not the first (client-controlled)', async () => {
    const proxied = startGuidesShowServer({ port: 0, host: '127.0.0.1', store: new MemoryGuideStore(), trustProxy: true, rateLimit: new MemoryUploadLimiter(1) });
    try {
      const post = (xff: string) => fetch(`http://127.0.0.1:${proxied.port}/api/g`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff }, body: JSON.stringify({ mode: 'encrypted', data: 'abc' }) });
      expect((await post('1.1.1.1, 203.0.113.9')).status).toBe(201);
      // Same real client, spoofed first hop: still the same key, so limited.
      expect((await post('2.2.2.2, 203.0.113.9')).status).toBe(429);
      // A different real client is a different key.
      expect((await post('2.2.2.2, 203.0.113.10')).status).toBe(201);
    } finally {
      proxied.stop();
    }
  });

  test('MemoryUploadLimiter: fixed window per key, resets after the window', async () => {
    let now = 0;
    const limiter = new MemoryUploadLimiter(2, 60_000, () => now);
    expect((await limiter.limit({ key: 'a' })).success).toBe(true);
    expect((await limiter.limit({ key: 'a' })).success).toBe(true);
    expect((await limiter.limit({ key: 'a' })).success).toBe(false);
    expect((await limiter.limit({ key: 'b' })).success).toBe(true);
    now = 60_000;
    expect((await limiter.limit({ key: 'a' })).success).toBe(true);
  });
});

describe('guides.show bun target: options', () => {
  test('flags win over env, env over defaults; --viewer-dir resolves to an absolute path', () => {
    const fromEnv = parseServeOptions([], { PORT: '9001', GUIDES_SHOW_STORE: 'memory', GUIDES_SHOW_VIEWER_DIR: 'rel/viewer', GUIDES_SHOW_TRUST_PROXY: '1', GUIDES_SHOW_PUBLIC_ORIGIN: 'https://g.example.com/', GUIDES_SHOW_UPLOAD_LIMIT: '5', GUIDES_SHOW_MAX_TTL: '30d' });
    expect(fromEnv).toMatchObject({ port: 9001, store: 'memory', viewerDir: path.resolve('rel/viewer'), trustProxy: true, publicOrigin: 'https://g.example.com', uploadLimit: 5, maxTtlSeconds: 30 * 86_400 });

    const fromFlags = parseServeOptions(['--port', '9002', '--store=fs:/tmp/g', '--viewer-dir', '/srv/viewer', '--upload-limit', '0', '--max-ttl=3600'], { PORT: '9001', GUIDES_SHOW_STORE: 'memory', GUIDES_SHOW_MAX_TTL: '7d' });
    expect(fromFlags).toMatchObject({ port: 9002, store: 'fs:/tmp/g', viewerDir: '/srv/viewer', trustProxy: false, uploadLimit: 0, maxTtlSeconds: 3600 });

    const defaults = parseServeOptions([], {});
    expect(defaults).toMatchObject({ port: DEFAULT_PORT, store: DEFAULT_STORE_SPEC, viewerDir: DEFAULT_VIEWER_DIR, uploadLimit: DEFAULT_UPLOAD_LIMIT });
    expect(defaults).not.toHaveProperty('maxTtlSeconds');
    expect(defaults).not.toHaveProperty('publicOrigin');
    expect(parseServeOptions(['--help'], {})).toBe('help');
  });

  test('bad invocations are usage errors, not crashes', () => {
    expect(() => parseServeOptions(['--prot', '1'], {})).toThrow(UsageError);
    expect(() => parseServeOptions(['--port'], {})).toThrow(UsageError);
    expect(() => parseServeOptions(['--port', 'eighty'], {})).toThrow(UsageError);
    expect(() => parseServeOptions([], { PORT: '70000' })).toThrow(UsageError);
    expect(() => parseServeOptions(['--upload-limit', '-1'], {})).toThrow(UsageError);
    expect(() => parseServeOptions(['--max-ttl', 'soon'], {})).toThrow(UsageError);
    expect(() => parseServeOptions(['--public-origin', 'http://guides.example.com'], {})).toThrow(UsageError);
    expect(() => parseServeOptions(['--public-origin', 'https://guides.example.com/sub'], {})).toThrow(UsageError);
    expect(() => createGuideStore('redis:x')).toThrow(UsageError);
    expect(() => createGuideStore('fs:')).toThrow(UsageError);
  });

  test('parsePublicOrigin and parseDuration', () => {
    expect(parsePublicOrigin('https://guides.example.com:8443/')).toBe('https://guides.example.com:8443');
    expect(parsePublicOrigin('http://localhost:8788')).toBe('http://localhost:8788');
    expect(() => parsePublicOrigin('guides.example.com')).toThrow(UsageError);
    expect(parseDuration('90')).toBe(90);
    expect(parseDuration('30m')).toBe(1800);
    expect(parseDuration('24h')).toBe(86_400);
    expect(parseDuration('7d')).toBe(604_800);
    for (const bad of ['0', '-1', '1.5h', '1w', '', 'abc']) expect(parseDuration(bad)).toBeNull();
  });

  test('store specs map to the store classes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'guides-show-store-'));
    try {
      expect(createGuideStore('memory')).toBeInstanceOf(MemoryGuideStore);
      expect(createGuideStore(`fs:${dir}`)).toBeInstanceOf(FsGuideStore);
      expect(createGuideStore('s3:my-bucket')).toBeInstanceOf(S3GuideStore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A raw HTTP/1.1 GET so the path reaches the server byte-for-byte (fetch would collapse `..`). */
async function rawGet(port: number, rawPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let data = '';
    Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        open(socket) {
          socket.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
        },
        data(_socket, chunk) {
          data += Buffer.from(chunk).toString('utf8');
        },
        close() {
          const match = data.match(/^HTTP\/1\.[01] (\d{3})/);
          if (!match) reject(new Error(`no status line in: ${data.slice(0, 80)}`));
          else resolve({ status: Number(match[1]), body: data });
        },
        error(_socket, error) {
          reject(error);
        },
      },
    }).catch(reject);
  });
}
