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
 *
 * A bare `/` or `$` (empty query) IS a trigger: it opens the full catalog,
 * matching how slash/skill menus behave in the host agents. The safety story
 * for a multi-line composer where Enter means newline and Tab means leave the
 * field lives in the MENU, not here: while the menu is open with NO row
 * explicitly activated (arrow keys), every key behaves exactly as if the menu
 * were closed — "This costs $" + Enter is a newline, "cd /" + Tab leaves the
 * field. See useSkillReferenceAutocomplete.
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
 * Well-known single-segment absolute paths (Filesystem Hierarchy Standard
 * roots). `/run`, `/tmp`, `/etc`… read as filesystem paths in prose, so a
 * `/`-triggered token with one of these names is never extracted as a skill
 * reference, even when a skill shares the name. `$name` remains fully
 * available for such skills, and menu insertion switches a `/` trigger to `$`
 * for them so an inserted reference always survives extraction.
 */
const RESERVED_PATH_SEGMENTS = new Set([
  'bin', 'boot', 'dev', 'etc', 'home', 'lib', 'lib64', 'media', 'mnt', 'opt',
  'proc', 'root', 'run', 'sbin', 'srv', 'sys', 'tmp', 'usr', 'var',
]);

/**
 * Replace the in-progress trigger token with the chosen skill (keeping the
 * trigger character the user typed) plus a trailing space, so the inserted
 * reference is always cleanly word-bounded. The one exception to "keep the
 * typed trigger": a `/` trigger on a skill whose name is a well-known absolute
 * path segment (`run`, `tmp`…) inserts `$` instead, because extraction reads
 * `/run` as a path and would drop the reference.
 */
export function insertSkillReference(
  text: string,
  caret: number,
  trigger: SkillTriggerContext,
  skill: SkillCatalogEntry,
): { text: string; caret: number } {
  const triggerChar =
    trigger.trigger === '/' && RESERVED_PATH_SEGMENTS.has(skill.name.toLowerCase())
      ? '$'
      : trigger.trigger;
  const inserted = `${triggerChar}${skill.name} `;
  return {
    text: text.slice(0, trigger.start) + inserted + text.slice(caret),
    caret: trigger.start + inserted.length,
  };
}

/** One skill-reference occurrence in a text, with its exact span. */
export interface SkillReferenceToken {
  /** Index of the trigger character. */
  start: number;
  /** Index just past the last name character (excludes trailing punctuation). */
  end: number;
  entry: SkillCatalogEntry;
}

/**
 * Every skill-reference occurrence in the text, in order, WITH positions and
 * without dedupe — this is what the composer's highlight overlay paints, so a
 * name referenced twice highlights twice.
 *
 * A reference is a word-starting `/name` or `$name` whose name matches a
 * catalog entry case-insensitively, excluding path and link forms:
 * - followed by `/` or `\` — a path continuation (`/docs/foo`, `$HOME/bin`);
 * - preceded by `](` — a markdown link destination (`[x](/write-better)`);
 * - a `/` token naming a well-known absolute path segment (`/run`, `/tmp`) —
 *   see RESERVED_PATH_SEGMENTS; `$run` still counts.
 *
 * There is deliberately NO shell-redirect exclusion (`cat /run > out`): the
 * motivating case is already covered by the reserved-path rule, and excluding
 * on a following `<`/`>` produced false negatives on ordinary prose
 * ("use /animate <- this one", "quality: /write-better > everything else").
 */
export function findSkillReferenceTokens(
  text: string,
  catalog: SkillCatalogEntry[],
): SkillReferenceToken[] {
  if (!text || catalog.length === 0) return [];
  const byName = new Map(catalog.map((s) => [s.name.toLowerCase(), s]));

  const tokens: SkillReferenceToken[] = [];
  const re = /(^|[\s(])([$/])([A-Za-z0-9][A-Za-z0-9._-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const after = text[m.index + m[0].length];
    if (after === '/' || after === '\\') continue;
    // Markdown link destination: `[label](/name)` is a URL, not a reference.
    if (m[1] === '(' && text[m.index - 1] === ']') continue;
    // Sentence-final dots are punctuation, not part of the name ("use $humanizer.").
    const name = m[3].toLowerCase();
    const trimmed = m[3].replace(/\.+$/, '');
    const trimmedName = trimmed.toLowerCase();
    // `/run`-style well-known absolute paths never count (only for `/`).
    if (m[2] === '/' && (RESERVED_PATH_SEGMENTS.has(name) || RESERVED_PATH_SEGMENTS.has(trimmedName)))
      continue;
    const exact = byName.get(name);
    const entry = exact ?? byName.get(trimmedName);
    if (!entry) continue;
    const start = m.index + m[1].length;
    const nameLen = exact ? m[3].length : trimmed.length;
    tokens.push({ start, end: start + 1 + nameLen, entry });
  }
  return tokens;
}

/**
 * Every skill the text references, in first-appearance order, deduped by name.
 * Same matching rules as findSkillReferenceTokens above.
 */
export function extractSkillReferences(
  text: string,
  catalog: SkillCatalogEntry[],
): SkillCatalogEntry[] {
  const found: SkillCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const token of findSkillReferenceTokens(text, catalog)) {
    if (seen.has(token.entry.name)) continue;
    seen.add(token.entry.name);
    found.push(token.entry);
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
