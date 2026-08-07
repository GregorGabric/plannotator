/**
 * Skill catalog transport: fetches the catalog (default: `GET /api/skills`)
 * and caches it in memory for a short window so the composer never hits the
 * filesystem per keystroke, while staying ephemeral — nothing is persisted to
 * cookies, config, or storage, and every page session re-reads the catalog
 * from disk via the server.
 *
 * The transport is a host seam (see packages/ui/CLAUDE.md): hosts embedding
 * `@plannotator/ui` with their own backend install a replacement via
 * `setSkillCatalogTransport` / `configurePlannotatorUI({ skillCatalogTransport })`.
 * The default reproduces today's behavior byte-for-byte.
 *
 * Never throws and never rejects: any failure (endpoint missing on a host,
 * network error, malformed payload, a throwing host transport) yields an empty
 * catalog, which renders the composer's `/` and `$` as plain typing.
 */

import type { SkillCatalogEntry, SkillRootId } from './skillReferences';
import { setSkillCatalogForExport } from './skillReferences';

const CATALOG_TTL_MS = 30_000;

/**
 * Host-override seam for the catalog request. Must resolve to the raw entry
 * list; failures may reject or throw — the cache layer degrades them to [].
 */
export type SkillCatalogTransport = () => Promise<SkillCatalogEntry[]>;

function normalizeEntry(raw: unknown): SkillCatalogEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const { name, root, description, humanOnly } = raw as Record<string, unknown>;
  if (typeof name !== 'string' || !name) return null;
  const rootId: SkillRootId =
    root === 'claude' || root === 'codex' || root === 'universal' ? root : 'universal';
  return {
    name,
    root: rootId,
    ...(typeof description === 'string' && description ? { description } : {}),
    humanOnly: humanOnly === true,
  };
}

const defaultTransport: SkillCatalogTransport = async () => {
  const res = await fetch('/api/skills');
  if (!res.ok) return [];
  const data = (await res.json()) as { skills?: unknown };
  if (!Array.isArray(data.skills)) return [];
  return data.skills.map(normalizeEntry).filter((s): s is SkillCatalogEntry => s !== null);
};

let transport: SkillCatalogTransport = defaultTransport;

export function setSkillCatalogTransport(next: SkillCatalogTransport): void {
  transport = next;
}

export function resetSkillCatalogTransport(): void {
  transport = defaultTransport;
}

async function requestCatalog(): Promise<SkillCatalogEntry[]> {
  try {
    const skills = await transport();
    return Array.isArray(skills)
      ? skills.map(normalizeEntry).filter((s): s is SkillCatalogEntry => s !== null)
      : [];
  } catch {
    return [];
  }
}

let cached: { at: number; skills: SkillCatalogEntry[] } | null = null;
let inflight: Promise<SkillCatalogEntry[]> | null = null;
// Bumped by resetSkillCatalogCache. A request that resolves after a reset (or
// after being superseded) must neither populate the cache nor register the
// export catalog — otherwise a late-resolving stale request overwrites a newer
// value, and a reset leaves an outstanding request that "revives" dead state.
let generation = 0;

/** Fetch the catalog (deduped in-flight, cached for CATALOG_TTL_MS). */
export function fetchSkillCatalog(): Promise<SkillCatalogEntry[]> {
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) {
    return Promise.resolve(cached.skills);
  }
  if (inflight) return inflight;

  const startedIn = generation;
  const promise = requestCatalog().then((skills) => {
    if (startedIn !== generation) {
      // Cache was reset while this request was outstanding: report what we
      // got, but do not let a dead request write shared state.
      return skills;
    }
    if (inflight === promise) inflight = null;
    // An empty result is not cached as authoritative when a previous fetch
    // succeeded — a transient failure must not blank an established catalog.
    if (skills.length > 0 || !cached || cached.skills.length === 0) {
      cached = { at: Date.now(), skills };
    } else {
      cached = { at: Date.now(), skills: cached.skills };
    }
    setSkillCatalogForExport(cached.skills);
    return cached.skills;
  });
  inflight = promise;
  return promise;
}

/** The last fetched catalog, without triggering a request. */
export function getCachedSkillCatalog(): SkillCatalogEntry[] {
  return cached?.skills ?? [];
}

/**
 * Fire-and-forget warm-up so export enrichment works even when a comment with
 * references arrives without the composer opening this session (draft restore,
 * annotation-panel edits).
 */
export function primeSkillCatalog(): void {
  void fetchSkillCatalog();
}

/**
 * Test-only: drop the cache and the export registry, and invalidate any
 * outstanding request so it can no longer write shared state when it lands.
 */
export function resetSkillCatalogCache(): void {
  generation++;
  cached = null;
  inflight = null;
  setSkillCatalogForExport([]);
}
