import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GuideStore, StoredGuideMeta } from '../core/storage';
import { FsGuideStore } from './fs';
import { MemoryGuideStore } from './memory';
import { R2GuideStore, type R2GuideBucket } from './r2';
import { S3GuideStore, type S3GuideClient } from './s3';

/** Minimal R2 stand-in: string objects keyed by name. */
class FakeBucket implements R2GuideBucket {
  readonly objects = new Map<string, string>();
  async put(key: string, value: string) {
    this.objects.set(key, value);
    return {};
  }
  async get(key: string) {
    const body = this.objects.get(key);
    return body === undefined ? null : { text: async () => body };
  }
  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
}

/** Minimal Bun.S3Client stand-in over the same map. */
function fakeS3(objects: Map<string, string>): S3GuideClient {
  return {
    file: (path) => ({ text: async () => objects.get(path) ?? '', exists: async () => objects.has(path) }),
    write: async (path, data) => (objects.set(path, data), data.length),
    delete: async (path) => void objects.delete(path),
  };
}

const META: StoredGuideMeta = {
  mode: 'plain',
  createdAt: '2026-08-15T12:00:00.000Z',
  deleteTokenHash: 'ab'.repeat(32),
  viewer: { js: 'v.js', css: 'v.css', langs: { typescript: 'chunks/ts.js' } },
  bytes: 5,
  title: 'Hello',
};

interface Harness {
  name: string;
  make(now: () => number): { store: GuideStore; objects?: Map<string, string>; cleanup?: () => void };
}

const tmpDirs: string[] = [];
const harnesses: Harness[] = [
  { name: 'memory', make: (now) => ({ store: new MemoryGuideStore(now) }) },
  {
    name: 'r2',
    make: (now) => {
      const bucket = new FakeBucket();
      return { store: new R2GuideStore(bucket, now), objects: bucket.objects };
    },
  },
  {
    name: 's3',
    make: (now) => {
      const objects = new Map<string, string>();
      return { store: new S3GuideStore({ bucket: 'unused', client: fakeS3(objects), now }), objects };
    },
  },
  {
    name: 'fs',
    make: (now) => {
      const dir = mkdtempSync(join(tmpdir(), 'guides-show-fs-'));
      tmpDirs.push(dir);
      return { store: new FsGuideStore(dir, now), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    },
  },
];

describe.each(harnesses)('$name GuideStore', ({ make }) => {
  test('put/get round-trips body and every meta field; delete and unknown ids read as null', async () => {
    const { store, cleanup } = make(() => Date.now());
    try {
      await store.put('id-1', 'hello', META);
      expect(await store.get('id-1')).toEqual({ body: 'hello', meta: META });
      expect(await store.get('id-2')).toBeNull();
      await store.delete('id-1');
      expect(await store.get('id-1')).toBeNull();
      // Deleting twice is not an error (the handler already answered 204 once).
      await store.delete('id-1');
    } finally {
      cleanup?.();
    }
  });

  test('an expired guide reads as null and is removed on that read', async () => {
    let now = Date.parse('2026-08-15T12:00:00.000Z');
    const { store, objects, cleanup } = make(() => now);
    try {
      await store.put('id-1', 'hello', { ...META, expiresAt: '2026-08-15T13:00:00.000Z' });
      expect(await store.get('id-1')).not.toBeNull();
      now = Date.parse('2026-08-15T13:00:00.001Z');
      expect(await store.get('id-1')).toBeNull();
      if (objects) expect(objects.size).toBe(0);
      now = Date.parse('2026-08-15T12:30:00.000Z');
      // Gone for good, not merely hidden while expired.
      expect(await store.get('id-1')).toBeNull();
    } finally {
      cleanup?.();
    }
  });
});

test('r2 and s3 layouts keep body and meta as separate objects under g/', async () => {
  const bucket = new FakeBucket();
  await new R2GuideStore(bucket).put('abc', 'body', META);
  expect([...bucket.objects.keys()].sort()).toEqual(['g/abc', 'g/abc.meta']);
  expect(bucket.objects.get('g/abc')).toBe('body');
  const s3 = new Map<string, string>();
  await new S3GuideStore({ bucket: 'b', client: fakeS3(s3) }).put('abc', 'body', META);
  expect([...s3.keys()].sort()).toEqual(['g/abc', 'g/abc.meta']);
});

test('fs store refuses ids that could escape its directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guides-show-fs-'));
  try {
    const store = new FsGuideStore(dir);
    await expect(store.put('../escape', 'x', META)).rejects.toThrow();
    expect(await store.get('../escape')).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
