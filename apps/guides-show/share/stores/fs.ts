/**
 * Filesystem GuideStore for the Bun self-host target (`--store fs:<dir>`).
 * Layout: `<dir>/<id>` holds the body, `<dir>/<id>.meta.json` the metadata.
 * The meta file is written first and removed last (see r2.ts for why).
 * Expired guides are removed lazily on read.
 */
import { mkdirSync, promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { isStoredGuideExpired, type GuideStore, type StoredGuideMeta } from '../core/storage';

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class FsGuideStore implements GuideStore {
  private readonly dir: string;

  constructor(dir: string, private readonly now: () => number = () => Date.now()) {
    this.dir = resolve(dir);
    mkdirSync(this.dir, { recursive: true });
  }

  /** Ids are validated by the handler, but a store must not trust its caller with a path. */
  private pathFor(id: string, suffix = ''): string {
    if (!SAFE_ID.test(id)) throw new Error(`Invalid guide id: ${id}`);
    return join(this.dir, `${id}${suffix}`);
  }

  async put(id: string, body: string, meta: StoredGuideMeta): Promise<void> {
    await fs.writeFile(this.pathFor(id, '.meta.json'), JSON.stringify(meta), 'utf8');
    await fs.writeFile(this.pathFor(id), body, 'utf8');
  }

  async get(id: string): Promise<{ body: string; meta: StoredGuideMeta } | null> {
    let meta: StoredGuideMeta;
    try {
      meta = JSON.parse(await fs.readFile(this.pathFor(id, '.meta.json'), 'utf8')) as StoredGuideMeta;
    } catch {
      return null;
    }
    if (isStoredGuideExpired(meta, this.now())) {
      await this.delete(id);
      return null;
    }
    try {
      return { body: await fs.readFile(this.pathFor(id), 'utf8'), meta };
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<void> {
    await fs.rm(this.pathFor(id), { force: true });
    await fs.rm(this.pathFor(id, '.meta.json'), { force: true });
  }
}
