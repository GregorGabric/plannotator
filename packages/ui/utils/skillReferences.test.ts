import { afterEach, describe, expect, test } from 'bun:test';
import {
  extractSkillReferences,
  filterSkillCatalog,
  findSkillReferenceTokens,
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

  test('a bare trigger (empty query) IS a trigger — the full catalog opens', () => {
    // Enter/Tab safety no longer lives here: with nothing preselected in the
    // menu, an open menu consumes NO keys until the user activates a row
    // (see useSkillReferenceAutocomplete + the CommentPopover DOM tests).
    expect(findSkillTrigger('/', 1)).toEqual({ start: 0, trigger: '/', query: '' });
    expect(findSkillTrigger('$', 1)).toEqual({ start: 0, trigger: '$', query: '' });
    expect(findSkillTrigger('This costs $', 12)).toEqual({ start: 11, trigger: '$', query: '' });
    expect(findSkillTrigger('cd /', 4)).toEqual({ start: 3, trigger: '/', query: '' });
    expect(findSkillTrigger('- /', 3)).toMatchObject({ trigger: '/', query: '' });
    expect(findSkillTrigger('line\n/', 6)).toMatchObject({ trigger: '/', query: '' });
    expect(findSkillTrigger('see (/', 6)).toMatchObject({ trigger: '/', query: '' });
  });

  test('typing a query character narrows the same trigger', () => {
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

  test('informal arrows and comparisons around a token do NOT drop it (redirect rule removed)', () => {
    // The old shell-redirect exclusion produced false negatives on ordinary
    // prose; its motivating case (`cat /run > out`) is already covered by the
    // reserved-path rule, so it was dropped.
    expect(
      extractSkillReferences('use /humanizer <- this one', catalog).map((s) => s.name),
    ).toEqual(['humanizer']);
    expect(
      extractSkillReferences('quality: /write-better > everything else', catalog).map(
        (s) => s.name,
      ),
    ).toEqual(['write-better']);
    expect(
      extractSkillReferences('ranked /write-better < /humanizer', catalog).map((s) => s.name),
    ).toEqual(['write-better', 'humanizer']);
    expect(extractSkillReferences('run /code-review > out.txt', catalog).map((s) => s.name)).toEqual(
      ['code-review'],
    );
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

describe('findSkillReferenceTokens', () => {
  test('reports exact spans for the composer highlight overlay', () => {
    const text = 'Apply /write-better here.';
    const tokens = findSkillReferenceTokens(text, catalog);
    expect(tokens).toHaveLength(1);
    expect(text.slice(tokens[0].start, tokens[0].end)).toBe('/write-better');
    expect(tokens[0].entry.name).toBe('write-better');
  });

  test('repeated references produce one token each (no dedupe)', () => {
    const text = '/humanizer then $humanizer again';
    const tokens = findSkillReferenceTokens(text, catalog);
    expect(tokens.map((t) => text.slice(t.start, t.end))).toEqual([
      '/humanizer',
      '$humanizer',
    ]);
  });

  test('a sentence-final period stays outside the span', () => {
    const text = 'use $humanizer.';
    const tokens = findSkillReferenceTokens(text, catalog);
    expect(text.slice(tokens[0].start, tokens[0].end)).toBe('$humanizer');
  });

  test('non-references produce no tokens', () => {
    expect(findSkillReferenceTokens('packages/code-review and [x](/write-better)', catalog)).toEqual([]);
    expect(findSkillReferenceTokens('', catalog)).toEqual([]);
    expect(findSkillReferenceTokens('/write-better', [])).toEqual([]);
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
