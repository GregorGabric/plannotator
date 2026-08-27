/**
 * Eager math registration: fills the renderer slot in `./math` with KaTeX at
 * module evaluation, before any component renders.
 *
 * Every Plannotator entry (`packages/editor/App.tsx`, `packages/review-editor/App.tsx`;
 * the hook, review, portal, OpenCode and Pi builds all flow from those two)
 * imports this module for its side effect, which is what keeps math typeset
 * on the first commit exactly as it was with a static `katex` import. A host
 * that wants the same synchronous behavior imports it too:
 *
 *   import '@plannotator/ui/utils/math-eager';
 *
 * A host that does not import it gets lazy math: the TeX source in the same
 * wrapper for one frame, then the typeset markup once the chunk lands.
 */
import katex from 'katex';
import { setMathRenderer } from './math';

setMathRenderer(katex);
