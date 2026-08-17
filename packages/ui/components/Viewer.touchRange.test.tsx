import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Block } from '../types';

const hasDom = typeof document !== 'undefined';
const viewerModule = hasDom ? await import('./Viewer') : null;
const Viewer = viewerModule?.Viewer as typeof import('./Viewer')['Viewer'];

const blocks: Block[] = [
  { id: 'first', type: 'paragraph', content: 'First block', order: 0, startLine: 1 },
  { id: 'second', type: 'paragraph', content: 'Middle block', order: 1, startLine: 2 },
  { id: 'third', type: 'paragraph', content: 'Last block', order: 2, startLine: 3 },
];

let root: Root | null = null;
let host: HTMLElement | null = null;
const originalMatchMedia = hasDom ? window.matchMedia : undefined;

function installMatchMedia(compactTouch: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: compactTouch && query.includes('pointer: coarse'),
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

async function mount(compactTouch: boolean): Promise<void> {
  installMatchMedia(compactTouch);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <Viewer
        blocks={blocks}
        markdown={'First block\n\nMiddle block\n\nLast block'}
        annotations={[]}
        onAddAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="selection"
        inputMethod="pinpoint"
        taterMode={false}
        disableCodePathValidation
      />,
    );
  });
}

async function clickBlock(id: string): Promise<void> {
  const block = document.querySelector<HTMLElement>(`[data-block-id="${id}"]`);
  if (!block) throw new Error(`Missing block ${id}`);
  await act(async () => {
    block.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }));
  });
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) {
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: originalMatchMedia,
    });
  }
});

describe.if(hasDom)('Viewer compact touch range selection', () => {
  test('extends one Pinpoint block to another without leaving a native selection', async () => {
    await mount(true);
    await clickBlock('first');

    const extend = document.querySelector<HTMLButtonElement>('button[title="Extend selection"]');
    expect(extend).not.toBeNull();
    expect(document.querySelector('button[title="Copy"]')).toBeNull();
    await act(async () => extend?.click());
    expect(document.querySelector('[data-pn-touch-range-instruction="plan"]')).not.toBeNull();

    await clickBlock('third');

    expect(document.querySelector('[data-pn-touch-range-instruction="plan"]')).toBeNull();
    expect(document.querySelector('.annotation-toolbar')).not.toBeNull();
    const selectedText = Array.from(
      document.querySelectorAll<HTMLElement>('.annotation-highlight'),
    ).map((mark) => mark.textContent).join(' ');
    expect(selectedText).toContain('First block');
    expect(selectedText).toContain('Middle block');
    expect(selectedText).toContain('Last block');
    expect(window.getSelection()?.isCollapsed ?? true).toBe(true);
  });

  test('keeps the Extend action out of a narrow fine-pointer composition', async () => {
    await mount(false);
    await clickBlock('first');
    expect(document.querySelector('button[title="Extend selection"]')).toBeNull();
  });
});
