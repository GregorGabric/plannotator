/**
 * Math renderer slot (utils/math.ts).
 *
 * What regresses if these fail:
 * - the empty slot no longer renders an addressable placeholder (annotation
 *   restore and block targeting key on the wrapper attributes), or leaks the
 *   TeX as markup instead of text;
 * - a filled slot no longer renders KaTeX SYNCHRONOUSLY in the same render
 *   (this is the whole basis of Plannotator's byte-identical first paint);
 * - the loader stops being idempotent or stops retrying after a rejection;
 * - the host loader seam is ignored;
 * - the security pin (`trust: false`, `throwOnError: false`) stops being applied
 *   to a host-registered renderer.
 *
 * No DOM required: everything renders through `renderToStaticMarkup`, which
 * is a single synchronous render pass (no effects), so "in the same render"
 * is exactly what it measures.
 *
 * Bun runs every test file in one process, so the slot is saved on entry and
 * restored after each test: other files (InlineMarkdown.test.ts, the DOM
 * first-paint test) rely on the registration they set up themselves.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import katex from 'katex';
import {
  getMathRenderer,
  loadMathRenderer,
  renderMathToHtml,
  resetMathRenderer,
  setMathRenderer,
  setMathRendererLoader,
  subscribeMathRenderer,
  type MathRenderer,
} from './math';
import { MathBlock } from '../components/blocks/MathBlock';
import { InlineMarkdown } from '../components/InlineMarkdown';
import type { Block } from '../types';

const savedRenderer = getMathRenderer();

const displayBlock: Block = {
  id: 'math-1',
  type: 'math',
  content: '  E = mc^2  ',
  order: 0,
  startLine: 1,
};

beforeEach(() => {
  resetMathRenderer();
});

afterEach(() => {
  resetMathRenderer();
  if (savedRenderer) setMathRenderer(savedRenderer);
});

describe('empty slot', () => {
  test('MathBlock renders the wrapper with the TeX as text and the full anchor attribute set', () => {
    const html = renderToStaticMarkup(createElement(MathBlock, { block: displayBlock }));
    expect(html).not.toContain('katex');
    expect(html).toContain('class="math-block math-annotatable');
    expect(html).toContain('data-block-id="math-1"');
    expect(html).toContain('data-block-type="math"');
    expect(html).toContain('data-math-tex="E = mc^2"');
    expect(html).toContain('data-math-display="true"');
    expect(html).toContain('aria-label="E = mc^2"');
    expect(html).toContain('>E = mc^2</div>');
  });

  test('inline math renders the wrapper with the TeX as text and the same attributes', () => {
    const html = renderToStaticMarkup(createElement(InlineMarkdown, { text: 'Area is $A=\\pi r^2$.' }));
    expect(html).not.toContain('katex');
    expect(html).toContain('class="math-inline math-annotatable');
    expect(html).toContain('data-math-tex="A=\\pi r^2"');
    expect(html).toContain('data-math-display="false"');
    expect(html).toContain('>A=\\pi r^2</span>');
  });

  test('placeholder TeX is a text child, never markup', () => {
    const hostile: Block = { ...displayBlock, content: '<img src=x onerror=alert(1)>' };
    const html = renderToStaticMarkup(createElement(MathBlock, { block: hostile }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('filled slot', () => {
  test('renders KaTeX markup in the same synchronous render, no effect needed', () => {
    setMathRenderer(katex);
    const html = renderToStaticMarkup(createElement(MathBlock, { block: displayBlock }));
    expect(html).toContain('katex-display');
    expect(html).toContain('data-math-tex="E = mc^2"');
    expect(html).not.toContain('>E = mc^2</div>');
  });

  test('registering notifies subscribers exactly once per change', () => {
    let calls = 0;
    const unsubscribe = subscribeMathRenderer(() => {
      calls += 1;
    });
    setMathRenderer(katex);
    setMathRenderer(katex); // same renderer: no notification
    expect(calls).toBe(1);
    unsubscribe();
    resetMathRenderer();
    expect(calls).toBe(1);
  });
});

describe('loadMathRenderer', () => {
  test('resolves at once from a filled slot without calling the loader', async () => {
    let loads = 0;
    setMathRendererLoader(async () => {
      loads += 1;
      return katex;
    });
    setMathRenderer(katex);
    expect(await loadMathRenderer()).toBe(katex);
    expect(loads).toBe(0);
  });

  test('is idempotent: concurrent calls share one load, later calls reuse the result', async () => {
    let loads = 0;
    setMathRendererLoader(async () => {
      loads += 1;
      return katex;
    });
    const [a, b] = await Promise.all([loadMathRenderer(), loadMathRenderer()]);
    expect(a).toBe(katex);
    expect(b).toBe(katex);
    expect(getMathRenderer()).toBe(katex);
    await loadMathRenderer();
    expect(loads).toBe(1);
  });

  test('a rejected load is dropped so the next call retries', async () => {
    let attempts = 0;
    setMathRendererLoader(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('chunk failed');
      return katex;
    });
    await expect(loadMathRenderer()).rejects.toThrow('chunk failed');
    expect(getMathRenderer()).toBeNull();
    expect(await loadMathRenderer()).toBe(katex);
    expect(attempts).toBe(2);
  });

  test('honors the host loader seam and registers what it returns', async () => {
    const hostRenderer: MathRenderer = {
      renderToString: (tex) => `<span class="host-math">${tex}</span>`,
    };
    setMathRendererLoader(async () => hostRenderer);
    await loadMathRenderer();
    expect(getMathRenderer()).toBe(hostRenderer);
    const html = renderToStaticMarkup(createElement(MathBlock, { block: displayBlock }));
    expect(html).toContain('<span class="host-math">E = mc^2</span>');
  });
});

describe('renderMathToHtml', () => {
  test('returns null while no renderer is registered', () => {
    expect(renderMathToHtml('x', false)).toBeNull();
  });

  // Deliberate security pin: `trust: false` and `throwOnError: false` are
  // applied to EVERY renderer, including one a host registered, so document
  // TeX can never widen what the renderer may emit.
  test('pins trust:false and throwOnError:false regardless of the registered renderer', () => {
    const seen: unknown[] = [];
    const spy: MathRenderer = {
      renderToString: (_tex, options) => {
        seen.push(options);
        return '';
      },
    };
    setMathRenderer(spy);
    renderMathToHtml('x', true);
    renderMathToHtml('y', false, spy);
    expect(seen).toHaveLength(2);
    for (const options of seen) {
      expect(options).toMatchObject({ trust: false, throwOnError: false, output: 'html' });
    }
    expect(seen[0]).toMatchObject({ displayMode: true });
    expect(seen[1]).toMatchObject({ displayMode: false });
  });
});
