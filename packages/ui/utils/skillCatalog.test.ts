import { afterEach, describe, expect, test } from 'bun:test';
import {
  fetchSkillCatalog,
  getCachedSkillCatalog,
  resetSkillCatalogCache,
} from './skillCatalog';
import { skillReferenceExportBlock } from './skillReferences';

const realFetch = globalThis.fetch;

function stubFetch(impl: () => Promise<Response> | Response) {
  let calls = 0;
  globalThis.fetch = ((..._args: unknown[]) => {
    calls++;
    return Promise.resolve(impl());
  }) as typeof fetch;
  return () => calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  resetSkillCatalogCache();
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
