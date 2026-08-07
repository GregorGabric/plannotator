import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  fetchSkillCatalog,
  getCachedSkillCatalog,
  resetSkillCatalogCache,
  resetSkillCatalogTransport,
  setSkillCatalogTransport,
} from './skillCatalog';
import { skillReferenceExportBlock, type SkillCatalogEntry } from './skillReferences';

const realFetch = globalThis.fetch;

function stubFetch(impl: () => Promise<Response> | Response) {
  let calls = 0;
  globalThis.fetch = ((..._args: unknown[]) => {
    calls++;
    return Promise.resolve(impl());
  }) as typeof fetch;
  return () => calls;
}

// Reset BEFORE each test as well as after: other suites in the same process
// (e.g. packages/editor mounting App, which primes the catalog) may leave a
// cached value or an outstanding request behind. The reset invalidates both,
// so these tests hold in any file order.
beforeEach(() => {
  resetSkillCatalogCache();
  resetSkillCatalogTransport();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetSkillCatalogCache();
  resetSkillCatalogTransport();
});

describe('fetchSkillCatalog', () => {
  test('normalizes the payload and registers the export catalog', async () => {
    stubFetch(() =>
      Response.json({
        skills: [
          { name: 'write-better', root: 'claude', description: 'Improve prose', humanOnly: false },
          { name: 'plannotator-review', root: 'claude', humanOnly: true },
          { name: '', root: 'claude', humanOnly: false }, // dropped: no name
          { name: 'weird-root', root: 'somewhere', humanOnly: false }, // root falls back
        ],
      }),
    );

    const skills = await fetchSkillCatalog();
    expect(skills.map((s) => s.name)).toEqual(['write-better', 'plannotator-review', 'weird-root']);
    expect(skills[2].root).toBe('universal');

    // The export seam sees the same catalog.
    expect(skillReferenceExportBlock('use $write-better')).toContain('`write-better`');
  });

  test('caches within the TTL — one request for many calls', async () => {
    const calls = stubFetch(() => Response.json({ skills: [{ name: 'a', root: 'claude' }] }));
    await fetchSkillCatalog();
    await fetchSkillCatalog();
    await fetchSkillCatalog();
    expect(calls()).toBe(1);
    expect(getCachedSkillCatalog().map((s) => s.name)).toEqual(['a']);
  });

  test('endpoint missing (404) → empty catalog, no throw', async () => {
    stubFetch(() => new Response('not found', { status: 404 }));
    expect(await fetchSkillCatalog()).toEqual([]);
  });

  test('network failure → empty catalog, no throw', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('boom'))) as unknown as typeof fetch;
    expect(await fetchSkillCatalog()).toEqual([]);
  });

  test('malformed payload → empty catalog', async () => {
    stubFetch(() => Response.json({ nope: true }));
    expect(await fetchSkillCatalog()).toEqual([]);
  });
});

describe('resetSkillCatalogCache', () => {
  test('invalidates an outstanding request: the next fetch consults the new backend', async () => {
    // A request is left inflight (as App.tsx's primeSkillCatalog does)…
    let resolveOld!: (r: Response) => void;
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        resolveOld = resolve;
      })) as unknown as typeof fetch;
    const oldPromise = fetchSkillCatalog();

    // …then the cache is reset and a different backend is stubbed.
    resetSkillCatalogCache();
    stubFetch(() => Response.json({ skills: [{ name: 'fresh', root: 'claude' }] }));

    const skills = await fetchSkillCatalog();
    expect(skills.map((s) => s.name)).toEqual(['fresh']);

    // The old request finally lands: it must not overwrite the newer value
    // or the export registry.
    resolveOld(Response.json({ skills: [{ name: 'stale', root: 'claude' }] }));
    await oldPromise;
    expect(getCachedSkillCatalog().map((s) => s.name)).toEqual(['fresh']);
    expect(skillReferenceExportBlock('use $fresh')).toContain('`fresh`');
    expect(skillReferenceExportBlock('use $stale')).toBe('');
  });

  test('a request outstanding at reset resolves without reviving dead cache state', async () => {
    let resolveOld!: (r: Response) => void;
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        resolveOld = resolve;
      })) as unknown as typeof fetch;
    const oldPromise = fetchSkillCatalog();

    resetSkillCatalogCache();
    resolveOld(Response.json({ skills: [{ name: 'ghost', root: 'claude' }] }));
    await oldPromise;

    expect(getCachedSkillCatalog()).toEqual([]);
    expect(skillReferenceExportBlock('use $ghost')).toBe('');
  });
});

describe('skillCatalogTransport seam', () => {
  test('a host transport replaces the default fetch, with the same normalization', async () => {
    const calls = stubFetch(() => Response.json({ skills: [{ name: 'via-fetch', root: 'claude' }] }));
    setSkillCatalogTransport(async () => [
      { name: 'host-skill', root: 'claude', humanOnly: false },
      { name: '', root: 'claude', humanOnly: false } as SkillCatalogEntry, // dropped
    ]);

    const skills = await fetchSkillCatalog();
    expect(skills.map((s) => s.name)).toEqual(['host-skill']);
    expect(calls()).toBe(0); // fetch never consulted

    resetSkillCatalogTransport();
    resetSkillCatalogCache();
    expect((await fetchSkillCatalog()).map((s) => s.name)).toEqual(['via-fetch']);
  });

  test('a throwing host transport degrades to an empty catalog', async () => {
    setSkillCatalogTransport(() => Promise.reject(new Error('host boom')));
    expect(await fetchSkillCatalog()).toEqual([]);
  });
});
