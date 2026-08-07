/**
 * Skill references in comments — pure logic.
 *
 * A comment may reference agent skills by name with a `/` or `$` trigger
 * (interchangeable). References live in the comment TEXT itself (`$write-better`),
 * never as separate annotation state, so they survive draft restore, panel
 * edits, and share round-trips, and deleting the token deletes the reference.
 *
 * The catalog comes from `/api/skills` (see utils/skillCatalog.ts). This module
 * is browser-safe and dependency-free: trigger detection for the composer,
 * token extraction against a known catalog, and the export rendering hook the
 * feedback exporters call through a module-level registry seam
 * (`setSkillCatalogForExport`) whose default — an empty catalog — reproduces
 * pre-feature behavior byte-for-byte.
 */

export type SkillRootId = 'claude' | 'codex' | 'universal';

export interface SkillCatalogEntry {
  name: string;
  root: SkillRootId;
  description?: string;
  /** Skill frontmatter carries `disable-model-invocation: true`: only a human can invoke it. */
  humanOnly: boolean;
}

export const SKILL_TRIGGER_CHARS = ['/', '$'] as const;
export type SkillTriggerChar = (typeof SKILL_TRIGGER_CHARS)[number];

/** Longest query the composer keeps treating as a skill lookup. */
export const MAX_SKILL_QUERY_LEN = 48;

/** Characters a skill name (and thus an in-progress query) may contain. */
const TOKEN_CHARS = /^[A-Za-z0-9._-]*$/;

export interface SkillTriggerContext {
  /** Index of the trigger character in the text. */
  start: number;
  trigger: SkillTriggerChar;
  /** Text between the trigger character and the caret. */
  query: string;
}

/**
 * The active skill trigger at `caret`, or null.
 *
 * A trigger is a `/` or `$` that starts a word: at position 0 or preceded by
 * whitespace or `(`. This is what keeps ordinary typing inert — `packages/ui`,
 * `and/or`, and `a/b` never trigger because their `/` follows a word character.
 * The query runs from the trigger to the caret and must stay within skill-name
 * characters, so typing a space (or any other breaking character) ends the
 * lookup naturally.
 */
export function findSkillTrigger(text: string, caret: number): SkillTriggerContext | null {
  if (caret < 1 || caret > text.length) return null;

  // Walk back over query characters to the nearest candidate trigger.
  let start = caret - 1;
  while (start >= 0 && !SKILL_TRIGGER_CHARS.includes(text[start] as SkillTriggerChar)) {
    if (caret - start > MAX_SKILL_QUERY_LEN) return null;
    start--;
  }
  if (start < 0) return null;

  const trigger = text[start] as SkillTriggerChar;
  const before = start === 0 ? '' : text[start - 1];
  if (before !== '' && !/[\s(]/.test(before)) return null;

  const query = text.slice(start + 1, caret);
  if (query.length > MAX_SKILL_QUERY_LEN) return null;
  if (!TOKEN_CHARS.test(query)) return null;

  return { start, trigger, query };
}

/**
 * Filter the catalog for the picker: case-insensitive, name prefix matches
 * first, then name substring, then description substring. Stable within each
 * tier (catalog order is alphabetical from the server).
 */
export function filterSkillCatalog(
  catalog: SkillCatalogEntry[],
  query: string,
  limit = 50,
): SkillCatalogEntry[] {
  const q = query.toLowerCase();
  if (!q) return catalog.slice(0, limit);

  const prefix: SkillCatalogEntry[] = [];
  const substring: SkillCatalogEntry[] = [];
  const description: SkillCatalogEntry[] = [];
  for (const entry of catalog) {
    const name = entry.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(entry);
    else if (name.includes(q)) substring.push(entry);
    else if (entry.description?.toLowerCase().includes(q)) description.push(entry);
  }
  return [...prefix, ...substring, ...description].slice(0, limit);
}

/**
 * Replace the in-progress trigger token with the chosen skill (keeping the
 * trigger character the user typed) plus a trailing space, so the inserted
 * reference is always cleanly word-bounded.
 */
export function insertSkillReference(
  text: string,
  caret: number,
  trigger: SkillTriggerContext,
  skill: SkillCatalogEntry,
): { text: string; caret: number } {
  const inserted = `${trigger.trigger}${skill.name} `;
  return {
    text: text.slice(0, trigger.start) + inserted + text.slice(caret),
    caret: trigger.start + inserted.length,
  };
}

/**
 * Every skill the text references, in first-appearance order, deduped by name.
 *
 * A reference is a word-starting `/name` or `$name` whose name matches a
 * catalog entry case-insensitively AND is not followed by `/` or `\` — that
 * trailing separator marks a path (`/docs/foo`, `$HOME/bin`), never a skill
 * reference.
 */
export function extractSkillReferences(
  text: string,
  catalog: SkillCatalogEntry[],
): SkillCatalogEntry[] {
  if (!text || catalog.length === 0) return [];
  const byName = new Map(catalog.map((s) => [s.name.toLowerCase(), s]));

  const found: SkillCatalogEntry[] = [];
  const seen = new Set<string>();
  const re = /(^|[\s(])[$/]([A-Za-z0-9][A-Za-z0-9._-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const after = text[m.index + m[0].length];
    if (after === '/' || after === '\\') continue;
    // Sentence-final dots are punctuation, not part of the name ("use $humanizer.").
    const entry =
      byName.get(m[2].toLowerCase()) ?? byName.get(m[2].replace(/\.+$/, '').toLowerCase());
    if (!entry || seen.has(entry.name)) continue;
    seen.add(entry.name);
    found.push(entry);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Export seam
// ---------------------------------------------------------------------------

// Module-level registry seam (see packages/ui/CLAUDE.md): the exporters in
// utils/parser.ts are pure and cannot fetch, so the app registers the fetched
// catalog here once per session. Default (empty) means the exporters emit
// nothing extra — hosts without the endpoint are byte-for-byte unchanged.
let exportCatalog: SkillCatalogEntry[] = [];

export function setSkillCatalogForExport(catalog: SkillCatalogEntry[]): void {
  exportCatalog = catalog;
}

export function resetSkillCatalogForExport(): void {
  exportCatalog = [];
}

const HUMAN_ONLY_EXPORT_NOTE =
  'human-invocation-only: you cannot invoke this skill; the reviewer included it as context';

/**
 * The export block for a comment's skill references, or '' when the comment
 * references none (or no catalog was registered). Appended to the comment in
 * the exported feedback so the acting agent knows which skills to apply.
 * Human-only skills are marked so the agent is not asked to invoke something
 * it cannot.
 */
export function skillReferenceExportBlock(text: string | undefined): string {
  if (!text) return '';
  const refs = extractSkillReferences(text, exportCatalog);
  if (refs.length === 0) return '';

  let out = `**Skills referenced** (use each of these skills when acting on this feedback):\n`;
  for (const ref of refs) {
    out += ref.humanOnly
      ? `- \`${ref.name}\` (${HUMAN_ONLY_EXPORT_NOTE})\n`
      : `- \`${ref.name}\`\n`;
  }
  return out;
}
