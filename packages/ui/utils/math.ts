/**
 * Math renderer slot.
 *
 * `MathBlock` and inline math read their renderer from this module instead of
 * importing `katex` statically, so a host that bundles by route does not carry
 * KaTeX in every document read. The slot is SYNCHRONOUS: when it is filled
 * before the first render (which is what `./math-eager` does, and what every
 * Plannotator entry imports) the typeset HTML is in the DOM on the first
 * commit, exactly as it was when the import was static. When it is empty the
 * components render the same wrapper element with the TeX source as text,
 * call `loadMathRenderer()`, and re-render typeset once it resolves.
 *
 * This module deliberately has NO runtime import of `katex`: the only place
 * the dependency is named is the default loader's `import('katex')`, which a
 * chunking bundler turns into a lazy chunk and Plannotator's single-file
 * builds inline (the eager entry keeps it in the entry either way).
 */

import type { KatexOptions } from 'katex';

/** The subset of KaTeX's API the renderer needs. `katex` itself satisfies it. */
export interface MathRenderer {
  renderToString(tex: string, options?: KatexOptions): string;
}

export type MathRendererLoader = () => Promise<MathRenderer>;

/**
 * Default loader: KaTeX's JS only. The stylesheet is deliberately NOT imported
 * here; CSS loading stays the host's job (see HANDOFF.md "Math rendering"),
 * and a host that already serves `katex.min.css` would otherwise load it twice.
 */
const defaultMathRendererLoader: MathRendererLoader = () => import('katex').then((m) => m.default);

/**
 * Who filled the slot: the eager entry (`./math-eager`), the lazy loader, or a
 * host calling `setMathRenderer` directly. Diagnostic for a host chasing a TeX
 * flash, and the eager value is a build marker: it only reaches a bundle when
 * `./math-eager` is evaluated, which is what `tests/entry-assets.test.ts`
 * asserts on the built single-file HTML.
 */
export type MathRendererSource = 'plannotator-math-eager' | 'loader' | 'host';

let renderer: MathRenderer | null = null;
let rendererSource: MathRendererSource | null = null;
let loader: MathRendererLoader = defaultMathRendererLoader;
let pending: Promise<MathRenderer> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Current renderer, or `null` while none is registered. Safe to call during render. */
export function getMathRenderer(): MathRenderer | null {
  return renderer;
}

/** How the current renderer was registered, or `null` while the slot is empty. */
export function getMathRendererSource(): MathRendererSource | null {
  return rendererSource;
}

/** Register a renderer synchronously (what `./math-eager` does with `katex`). */
export function setMathRenderer(next: MathRenderer, source: MathRendererSource = 'host'): void {
  if (renderer === next) return;
  renderer = next;
  rendererSource = source;
  notify();
}

/** Subscribe to slot changes. Shaped for `useSyncExternalStore`. */
export function subscribeMathRenderer(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Swap the loader `loadMathRenderer()` uses. Host seam
 * (`configurePlannotatorUI({ mathRendererLoader })`): a host may return a
 * module that imports katex AND its stylesheet in one chunk. A load already in
 * flight keeps going; the new loader is used from the next `loadMathRenderer()`
 * call that finds the slot empty.
 */
export function setMathRendererLoader(next: MathRendererLoader): void {
  loader = next;
  pending = null;
}

/**
 * Load and register the renderer. Idempotent: a filled slot resolves at once,
 * a load in flight is shared, and a rejected load is dropped so the next call
 * retries instead of failing forever on a transient chunk error.
 */
export function loadMathRenderer(): Promise<MathRenderer> {
  if (renderer) return Promise.resolve(renderer);
  if (!pending) {
    const attempt = loader().then(
      (loaded) => {
        setMathRenderer(loaded, 'loader');
        return loaded;
      },
      (err: unknown) => {
        if (pending === attempt) pending = null;
        throw err;
      },
    );
    pending = attempt;
  }
  return pending;
}

/** Test hook: clear the slot, the loader override and any pending load. */
export function resetMathRenderer(): void {
  renderer = null;
  rendererSource = null;
  loader = defaultMathRendererLoader;
  pending = null;
  notify();
}

export const normalizeMathTex = (tex: string): string => tex.trim();

/**
 * Render TeX with the pinned option set. `throwOnError: false` and
 * `trust: false` are a deliberate security pin applied to EVERY renderer,
 * including one a host registered: a registered module never widens what
 * document-supplied TeX may do. Returns `null` while no renderer is
 * registered so callers can fall back to the text placeholder.
 */
export function renderMathToHtml(
  tex: string,
  displayMode: boolean,
  activeRenderer: MathRenderer | null = renderer,
): string | null {
  if (!activeRenderer) return null;
  return activeRenderer.renderToString(tex, {
    displayMode,
    throwOnError: false,
    strict: 'warn',
    trust: false,
    output: 'html',
  });
}
