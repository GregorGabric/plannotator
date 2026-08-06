/**
 * The single-file diff tab must actually REPAINT when the full-content diff
 * arrives.
 *
 * DiffViewer renders twice for every file it shows: first the PARTIAL diff
 * parsed from the raw patch (`getSingularPatch`), then, once
 * `/api/file-content` resolves, an AUGMENTED full-content diff
 * (`processFile`) swapped onto the SAME surviving FileDiff instance
 * (`key={filePath}`). Only the augmented diff can be expanded, so the
 * gutter's expansion chevrons appear only after the swap lands.
 *
 * @pierre/diffs 1.3.2 defaults `fileDiff.cacheKey` to the file NAME when the
 * caller leaves it unset, and `areDiffTargetsEqual` compares nothing but that
 * key. Two diffs of the same file therefore look identical to the render
 * cache, so the augmented diff is served the stale partial render forever:
 * gap bars with no chevrons, dead clicks, at every file size. The fix mints
 * content-derived cache keys for BOTH diffs.
 *
 * Real @pierre/diffs (no diff mocks) — the defect lives entirely inside its
 * DiffHunksRenderer cache, so a mocked renderer would prove nothing. Only
 * DiffViewer's Vite-only worker-pool module and the theme/toolbar chrome are
 * stubbed.
 *
 * DOM-gated (DOM_TESTS=1) and registered in .github/workflows/test.yml's
 * "Run UI seam-contract + DOM tests" step.
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  DEFAULT_THEMES,
  disposeHighlighter,
  getFiletypeFromFileName,
  getHighlighterOptions,
  preloadHighlighter,
} from '@pierre/diffs';

mock.module('../workerPool', () => ({
  useIsWorkerPoolReadyOrDisabled: () => true,
  useWorkerPoolThemeSync: () => {},
}));

mock.module('../hooks/usePierreTheme', () => ({
  usePierreTheme: () => ({ type: 'light', css: '' }),
}));

mock.module('./ToolbarHost', () => ({
  ToolbarHost: React.forwardRef(function MockToolbarHost() {
    return null;
  }),
}));

const { DiffViewer } = await import('./DiffViewer');

const hasDom = typeof document !== 'undefined';

// A realistically sized file so there is genuine collapsed context above and
// below the hunk — the gaps whose chevrons are the user-visible symptom.
const filler = (n: number, name: string) =>
  Array.from({ length: n }, (_, i) => `const ${name}${i} = ${i};`).join('\n');
const HEAD = filler(60, 'head');
const TAIL = filler(50, 'tail');
const NEW_CONTENTS = `${HEAD}\nexport function add(a: number, b: number) {\n  return a + b;\n}\n${TAIL}\n`;
const OLD_CONTENTS = `${HEAD}\nexport function add(a: number, b: number) {\n  return a + b; // old\n}\n${TAIL}\n`;

const PATCH = [
  'diff --git a/calc.ts b/calc.ts',
  'index 0000000..1111111 100644',
  '--- a/calc.ts',
  '+++ b/calc.ts',
  '@@ -61,7 +61,7 @@',
  ' const head58 = 58;',
  ' const head59 = 59;',
  ' export function add(a: number, b: number) {',
  '-  return a + b; // old',
  '+  return a + b;',
  ' }',
  ' const tail0 = 0;',
  ' const tail1 = 1;',
  '',
].join('\n');

/** All markup including shadow roots (Pierre renders into shadow DOM). */
function shadowHTML(host: HTMLElement): string {
  let out = host.innerHTML ?? '';
  const visit = (root: ParentNode) => {
    for (const el of root.querySelectorAll('*')) {
      const shadow = (el as { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (shadow) {
        out += shadow.innerHTML ?? '';
        visit(shadow);
      }
    }
  };
  visit(host);
  return out;
}

function countExpandButtons(host: HTMLElement): number {
  return (shadowHTML(host).match(/data-expand-button/g) ?? []).length;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for a rendered state, budgeted in SCHEDULER TURNS rather than
 * milliseconds.
 *
 * A wall-clock budget makes the test a stopwatch race against the runner: a
 * cold, contended CI box blows a deadline that a warm laptop clears, which is
 * exactly how the first version of this test flaked. Turns are machine
 * independent — a slower box simply spends longer inside each turn — so this
 * budget never has to be retuned for CI hardware. Every turn is an `act`
 * flushed macrotask boundary, so it also drains microtasks; the states waited
 * on here are at most a two step async chain past a synchronous render, which
 * makes 400 turns a ~100x margin rather than a guess.
 *
 * What is waited on is the completion signal itself, not a proxy for one:
 * Pierre renders expansion chevrons only from a NON-PARTIAL diff, so their
 * presence IS the augmented diff having reached paint.
 */
const WAIT_TURNS = 400;

async function waitUntil(predicate: () => boolean, turns = WAIT_TURNS): Promise<boolean> {
  for (let i = 0; i < turns; i += 1) {
    if (predicate()) return true;
    await act(async () => {
      await sleep(25);
    });
  }
  return predicate();
}

function view(overrides: Partial<React.ComponentProps<typeof DiffViewer>> = {}) {
  return (
    <DiffViewer
      patch={PATCH}
      filePath="calc.ts"
      diffStyle="unified"
      annotations={[]}
      selectedAnnotationId={null}
      scrollTargetAnnotation={null}
      pendingSelection={null}
      onLineSelection={() => {}}
      onAddAnnotation={() => {}}
      onAddFileComment={() => {}}
      onEditAnnotation={() => {}}
      onSelectAnnotation={() => {}}
      onDeleteAnnotation={() => {}}
      {...overrides}
    />
  );
}

describe.if(hasDom)('DiffViewer full-content swap (DOM)', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  const originalFetch = globalThis.fetch;

  // The highlighter warmed below is a MODULE SINGLETON shared by every test
  // file in this bun process, and packages/ui/utils/codeHighlight.test.ts
  // asserts the pre-attachment behaviour of exactly that singleton. Put it back
  // the way we found it so warming it here cannot decide another file's result.
  afterAll(async () => {
    await disposeHighlighter();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root!.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    globalThis.fetch = originalFetch;
  });

  test(
    'expansion affordances appear once /api/file-content lands',
    async () => {
      // The full-content response is held until the partial baseline has been
      // asserted — with the fix the swap lands within a frame, so an
      // unthrottled response would race the baseline check.
      let markRequested: (() => void) | null = null;
      const fileContentRequested = new Promise<void>((resolve) => {
        markRequested = resolve;
      });
      let releaseFileContent: (() => void) | null = null;
      const fileContentGate = new Promise<void>((resolve) => {
        releaseFileContent = resolve;
      });

      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/file-content')) {
          markRequested?.();
          await fileContentGate;
          return new Response(
            JSON.stringify({ oldContent: OLD_CONTENTS, newContent: NEW_CONTENTS }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      // Warm Pierre's SHARED (module-singleton) Shiki highlighter before
      // mounting. Otherwise the first render has to build it, and every paint
      // this test observes queues behind a multi-second Shiki/grammar
      // initialization whose cost is entirely the runner's CPU. Warming it here
      // moves that cost outside the observed window on fast and slow machines
      // alike, so the swap is measured, not the highlighter's startup.
      await preloadHighlighter(
        getHighlighterOptions(getFiletypeFromFileName('calc.ts'), { theme: DEFAULT_THEMES }),
      );

      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => {
        root!.render(view());
      });

      // The partial diff paints first, and a partial diff is NOT expandable —
      // Pierre renders the gap bars without chevrons. This is the baseline the
      // stale render cache would freeze forever. The gate is still closed here,
      // so the augmented diff cannot exist yet no matter how slow the box is.
      await fileContentRequested;
      expect(await waitUntil(() => shadowHTML(host!).includes('data-separator'))).toBe(true);
      expect(countExpandButtons(host!)).toBe(0);

      await act(async () => {
        releaseFileContent!();
        await sleep(0);
      });

      // The augmented full-content diff must reach the PIXELS, not just the
      // React tree: expansion chevrons in the gap bars. With the fix these
      // arrive in the first turn or two (the highlighter is warm, so the swap
      // render is synchronous); without it they never arrive at all.
      const swapped = await waitUntil(() => countExpandButtons(host!) > 0);
      expect(swapped).toBe(true);

      // And the separator now advertises a real expand target, which is what
      // makes the click live rather than dead.
      expect(shadowHTML(host!)).toContain('data-expand-index');
    },
    // The only bound in this test. Generous because it has to cover the
    // highlighter warm-up on a cold, contended CI runner; the assertions
    // themselves carry no wall-clock budget.
    180_000,
  );
});
