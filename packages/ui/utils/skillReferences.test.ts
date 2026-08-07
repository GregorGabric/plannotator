import { afterEach, describe, expect, test } from 'bun:test';
import {
  extractSkillReferences,
  filterSkillCatalog,
  findSkillTrigger,
  insertSkillReference,
  MAX_SKILL_QUERY_LEN,
  resetSkillCatalogForExport,
  setSkillCatalogForExport,
  skillReferenceExportBlock,
  type SkillCatalogEntry,
} from './skillReferences';

const catalog: SkillCatalogEntry[] = [
  { name: 'write-better', root: 'claude', description: 'Improve prose', humanOnly: false },
  { name: 'code-review', root: 'codex', humanOnly: false },
  { name: 'plannotator-review', root: 'claude', humanOnly: true },
  { name: 'humanizer', root: 'universal', humanOnly: false },
];

afterEach(() => {
  resetSkillCatalogForExport();
});

describe('findSkillTrigger', () => {
  test('triggers at the start of the input, for both characters', () => {
    expect(findSkillTrigger('/wri', 4)).toEqual({ start: 0, trigger: '/', query: 'wri' });
    expect(findSkillTrigger('$wri', 4)).toEqual({ start: 0, trigger: '$', query: 'wri' });
  });

  test('triggers after whitespace and after an opening paren', () => {
    expect(findSkillTrigger('use /wr', 7)).toMatchObject({ trigger: '/', query: 'wr' });
    expect(findSkillTrigger('line\n$x', 7)).toMatchObject({ trigger: '$', query: 'x' });
    expect(findSkillTrigger('see (/re', 8)).toMatchObject({ trigger: '/', query: 're' });
  });

  test('a bare trigger (empty query) is NOT a trigger — Enter/Tab must stay newline/blur', () => {
    // The whole-catalog-on-bare-slash behavior hijacked Enter and Tab in a
    // multi-line composer: "This costs $" + Enter, "cd /" + Tab, a "- " bullet.
    expect(findSkillTrigger('/', 1)).toBeNull();
    expect(findSkillTrigger('$', 1)).toBeNull();
    expect(findSkillTrigger('This costs $', 12)).toBeNull();
    expect(findSkillTrigger('cd /', 4)).toBeNull();
    expect(findSkillTrigger('- /', 3)).toBeNull();
    expect(findSkillTrigger('line\n/', 6)).toBeNull();
    expect(findSkillTrigger('see (/', 6)).toBeNull();
  });

  test('the menu opens at the first query character', () => {
    expect(findSkillTrigger('This costs $h', 13)).toMatchObject({ trigger: '$', query: 'h' });
    expect(findSkillTrigger('/w', 2)).toMatchObject({ trigger: '/', query: 'w' });
  });

  test('never triggers mid-word: paths, and/or, currency stay plain typing', () => {
    expect(findSkillTrigger('packages/ui', 11)).toBeNull();
    expect(findSkillTrigger('and/or', 6)).toBeNull();
    expect(findSkillTrigger('a$b', 3)).toBeNull();
  });

  test('whitespace inside the query ends the lookup', () => {
    expect(findSkillTrigger('/foo bar', 8)).toBeNull();
  });

  test('caret before or at the trigger is not a lookup', () => {
    expect(findSkillTrigger('/abc', 0)).toBeNull();
  });

  test('overlong queries stop triggering', () => {
    const text = `/${'a'.repeat(MAX_SKILL_QUERY_LEN + 1)}`;
    expect(findSkillTrigger(text, text.length)).toBeNull();
  });
});

describe('filterSkillCatalog', () => {
  test('empty query returns the full catalog (capped)', () => {
    expect(filterSkillCatalog(catalog, '')).toHaveLength(catalog.length);
    expect(filterSkillCatalog(catalog, '', 2)).toHaveLength(2);
  });

  test('prefix matches rank before substring matches, case-insensitively', () => {
    const names = filterSkillCatalog(catalog, 'RE').map((s) => s.name);
    // No prefix matches; the substring tier keeps catalog order.
    expect(names).toEqual(['code-review', 'plannotator-review']);
  });

  test('description matches rank last', () => {
    const names = filterSkillCatalog(catalog, 'prose').map((s) => s.name);
    expect(names).toEqual(['write-better']);
  });

  test('no matches → empty list', () => {
    expect(filterSkillCatalog(catalog, 'zzz')).toEqual([]);
  });
});

describe('insertSkillReference', () => {
  test('replaces the token keeping the typed trigger, adds a trailing space', () => {
    const trigger = findSkillTrigger('use /wr', 7)!;
    const result = insertSkillReference('use /wr', 7, trigger, catalog[0]);
    expect(result.text).toBe('use /write-better ');
    expect(result.caret).toBe(result.text.length);
  });

  test('preserves text after the caret', () => {
    const text = 'use $wr and more';
    const trigger = findSkillTrigger(text, 7)!;
    const result = insertSkillReference(text, 7, trigger, catalog[0]);
    expect(result.text).toBe('use $write-better  and more');
    expect(result.caret).toBe('use $write-better '.length);
  });

  test('a / trigger on a reserved path-segment name inserts $ so extraction keeps it', () => {
    const runSkill: SkillCatalogEntry = { name: 'run', root: 'claude', humanOnly: false };
    const text = 'use /ru';
    const trigger = findSkillTrigger(text, 7)!;
    const result = insertSkillReference(text, 7, trigger, runSkill);
    expect(result.text).toBe('use $run ');
    expect(extractSkillReferences(result.text, [runSkill]).map((s) => s.name)).toEqual(['run']);
  });
});

describe('extractSkillReferences', () => {
  test('finds multiple references with either trigger, in order', () => {
    const refs = extractSkillReferences(
      'Apply /write-better here and $humanizer there.',
      catalog,
    );
    expect(refs.map((s) => s.name)).toEqual(['write-better', 'humanizer']);
  });

  test('dedupes repeated references', () => {
    const refs = extractSkillReferences('/write-better and $write-better', catalog);
    expect(refs).toHaveLength(1);
  });

  test('matches case-insensitively but reports the canonical name', () => {
    const refs = extractSkillReferences('$Write-Better please', catalog);
    expect(refs.map((s) => s.name)).toEqual(['write-better']);
  });

  test('ignores non-catalog tokens and mid-word slashes', () => {
    expect(extractSkillReferences('/unknown and packages/code-review', catalog)).toEqual([]);
  });

  test('a trailing path separator marks a path, not a reference', () => {
    expect(extractSkillReferences('see /code-review/notes.md', catalog)).toEqual([]);
    expect(extractSkillReferences('see $code-review\\notes', catalog)).toEqual([]);
  });

  test('a well-known single-segment absolute path is a path even when a skill shares the name', () => {
    const withRun: SkillCatalogEntry[] = [
      ...catalog,
      { name: 'run', root: 'claude', humanOnly: false },
    ];
    expect(extractSkillReferences('the daemon writes to /run', withRun)).toEqual([]);
    expect(extractSkillReferences('cat /run > out', withRun)).toEqual([]);
    // The $ form stays available for such skills.
    expect(extractSkillReferences('use $run here', withRun).map((s) => s.name)).toEqual(['run']);
  });

  test('a markdown link destination is a URL, not a reference', () => {
    expect(extractSkillReferences('[x](/write-better)', catalog)).toEqual([]);
    expect(extractSkillReferences('![img](/write-better)', catalog)).toEqual([]);
  });

  test('a shell redirect right after the token marks a command line', () => {
    expect(extractSkillReferences('run /code-review > out.txt', catalog)).toEqual([]);
    expect(extractSkillReferences('feed /code-review < in.txt', catalog)).toEqual([]);
  });

  test('already-clean forms stay clean', () => {
    const withRun: SkillCatalogEntry[] = [
      ...catalog,
      { name: 'run', root: 'claude', humanOnly: false },
    ];
    for (const text of [
      'packages/write-better/foo',
      '~/run/foo',
      './run',
      'https://x.com/run',
      '"$write-better"',
      'and/or',
      '**/*.ts',
      '1/2/2026',
      '$PATH',
      '$(pwd)',
    ]) {
      expect(extractSkillReferences(text, withRun)).toEqual([]);
    }
  });

  test('empty catalog or empty text → no references', () => {
    expect(extractSkillReferences('/write-better', [])).toEqual([]);
    expect(extractSkillReferences('', catalog)).toEqual([]);
  });
});

describe('skillReferenceExportBlock', () => {
  test('default (no registered catalog) emits nothing — pre-feature output is unchanged', () => {
    expect(skillReferenceExportBlock('/write-better')).toBe('');
  });

  test('lists referenced skills once a catalog is registered', () => {
    setSkillCatalogForExport(catalog);
    const block = skillReferenceExportBlock('Use /write-better and $humanizer.');
    expect(block).toBe(
      '**Skills referenced** (use each of these skills when acting on this feedback):\n' +
        '- `write-better`\n' +
        '- `humanizer`\n',
    );
  });

  test('marks human-invocation-only skills so the agent is not asked to invoke them', () => {
    setSkillCatalogForExport(catalog);
    const block = skillReferenceExportBlock('Run $plannotator-review on this.');
    expect(block).toContain('- `plannotator-review` (human-invocation-only:');
  });

  test('no references in the text → empty block', () => {
    setSkillCatalogForExport(catalog);
    expect(skillReferenceExportBlock('plain comment')).toBe('');
    expect(skillReferenceExportBlock(undefined)).toBe('');
  });
});
