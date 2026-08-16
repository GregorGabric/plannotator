/**
 * S3-compatible GuideStore for the Bun self-host target (`--store s3:<bucket>`),
 * on Bun's built-in `Bun.S3Client` (zero dependencies). Credentials and the
 * endpoint come from Bun's standard `S3_*` / `AWS_*` environment variables
 * unless passed explicitly. Same two-object layout and ordering as r2.ts:
 * `g/<id>` body, `g/<id>.meta` metadata; meta written first, deleted last.
 */
import { isStoredGuideExpired, type GuideStore, type StoredGuideMeta } from '../core/storage';

/** The `Bun.S3Client` surface this store uses, kept structural so it can be faked in tests without touching the network. */
export interface S3GuideClient {
  file(path: string): { text(): Promise<string>; exists(): Promise<boolean> };
  write(path: string, data: string, options?: { type?: string }): Promise<number>;
  delete(path: string): Promise<void>;
}

export interface S3GuideStoreOptions {
  bucket: string;
  /** Preconfigured client (tests, custom endpoints). Defaults to `new Bun.S3Client({ bucket })`. */
  client?: S3GuideClient;
  now?: () => number;
}

export class S3GuideStore implements GuideStore {
  private readonly client: S3GuideClient;
  private readonly now: () => number;

  constructor(options: S3GuideStoreOptions) {
    this.client = options.client ?? (new Bun.S3Client({ bucket: options.bucket }) as unknown as S3GuideClient);
    this.now = options.now ?? (() => Date.now());
  }

  async put(id: string, body: string, meta: StoredGuideMeta): Promise<void> {
    await this.client.write(`g/${id}.meta`, JSON.stringify(meta), { type: 'application/json' });
    await this.client.write(`g/${id}`, body, { type: meta.mode === 'plain' ? 'application/json' : 'text/plain' });
  }

  async get(id: string): Promise<{ body: string; meta: StoredGuideMeta } | null> {
    const metaFile = this.client.file(`g/${id}.meta`);
    if (!(await metaFile.exists())) return null;
    let meta: StoredGuideMeta;
    try {
      meta = JSON.parse(await metaFile.text()) as StoredGuideMeta;
    } catch {
      return null;
    }
    if (isStoredGuideExpired(meta, this.now())) {
      await this.delete(id);
      return null;
    }
    const bodyFile = this.client.file(`g/${id}`);
    if (!(await bodyFile.exists())) return null;
    return { body: await bodyFile.text(), meta };
  }

  async delete(id: string): Promise<void> {
    await this.client.delete(`g/${id}`);
    await this.client.delete(`g/${id}.meta`);
  }
}
