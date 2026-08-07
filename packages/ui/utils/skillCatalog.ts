/**
 * Skill catalog transport: fetches `/api/skills` and caches it in memory for a
 * short window so the composer never hits the filesystem per keystroke, while
 * staying ephemeral — nothing is persisted to cookies, config, or storage, and
 * every page session re-reads the catalog from disk via the server.
 *
 * Never throws and never rejects: any failure (endpoint missing on a host,
 * network error, malformed payload) yields an empty catalog, which renders the
 * composer's `/` and `$` as plain typing.
 */

import type { SkillCatalogEntry, SkillRootId } from './skillReferences';
import { setSkillCatalogForExport } from './skillReferences';

const CATALOG_TTL_MS = 30_000;

let cached: { at: number; skills: SkillCatalogEntry[] } | null = null;
let inflight: Promise<SkillCatalogEntry[]> | null = null;

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

async function requestCatalog(): Promise<SkillCatalogEntry[]> {
  try {
    const res = await fetch('/api/skills');
    if (!res.ok) return [];
    const data = (await res.json()) as { skills?: unknown };
    if (!Array.isArray(data.skills)) return [];
    return data.skills
      .map(normalizeEntry)
      .filter((s): s is SkillCatalogEntry => s !== null);
  } catch {
    return [];
  }
}

/** Fetch the catalog (deduped in-flight, cached for CATALOG_TTL_MS). */
export function fetchSkillCatalog(): Promise<SkillCatalogEntry[]> {
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) {
    return Promise.resolve(cached.skills);
  }
  if (inflight) return inflight;
  inflight = requestCatalog().then((skills) => {
    inflight = null;
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
  return inflight;
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

/** Test-only: drop the cache and the export registry. */
export function resetSkillCatalogCache(): void {
  cached = null;
  inflight = null;
  setSkillCatalogForExport([]);
}
