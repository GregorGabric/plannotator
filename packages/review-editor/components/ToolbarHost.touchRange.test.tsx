import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ToolbarHost, type ToolbarHostHandle } from './ToolbarHost';
import type { SelectedLineRange } from '@plannotator/ui/types';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;
const originalMatchMedia = hasDom ? window.matchMedia : undefined;

const patch = [
  '@@ -1,1 +1,5 @@',
  '-old line',
  '+first line',
  '+second line',
  '+third line',
  '+fourth line',
  '+fifth line',
].join('\n');

function installCompactTouch(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: query.includes('pointer: coarse'),
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => true,
    }),
  });
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) {
    document.body.replaceChildren();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: originalMatchMedia,
    });
  }
});

describe.if(hasDom)('ToolbarHost compact touch range adjustment', () => {
  test('keeps a live draft while the composer yields and returns on the extended range', async () => {
    installCompactTouch();
    const handle = createRef<ToolbarHostHandle>();
    const selections: Array<SelectedLineRange | null> = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        <ToolbarHost
          ref={handle}
          patch={patch}
          filePath="src/example.ts"
          isFocused
          onLineSelection={(range) => selections.push(range)}
          onAddAnnotation={() => {}}
          onEditAnnotation={() => {}}
        />,
      );
    });

    await act(async () => {
      handle.current?.handleLineSelectionEnd({ start: 2, end: 2, side: 'additions' });
    });
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="Leave feedback..."]');
    if (!textarea) throw new Error('Comment composer did not open');
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setValue?.call(textarea, 'Keep this draft');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const adjust = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Adjust lines');
    if (!adjust) throw new Error('Adjust lines action did not render');
    await act(async () => adjust.click());

    expect(handle.current?.isAdjustingRange()).toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[data-pn-touch-range-instruction="review"]')).not.toBeNull();
    expect(document.activeElement?.tagName).not.toBe('TEXTAREA');

    await act(async () => {
      handle.current?.handleLineSelectionEnd({ start: 4, end: 4, side: 'additions' });
    });

    expect(handle.current?.isAdjustingRange()).toBe(false);
    expect(document.querySelector('[data-pn-touch-range-instruction="review"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Lines 2-4');
    expect(document.querySelector<HTMLTextAreaElement>('textarea[placeholder="Leave feedback..."]')?.value)
      .toBe('Keep this draft');
    expect(selections.at(-1)).toEqual({ start: 2, end: 4, side: 'additions' });
  });
});
