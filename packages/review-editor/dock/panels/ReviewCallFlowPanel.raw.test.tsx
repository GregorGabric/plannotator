/** DOM-gated behavior tests for raw CallDiff search and toolbar chrome. */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReviewState } from '../ReviewStateContext';
import { ReviewStateProvider } from '../ReviewStateContext';
import { ReviewCallFlowPanel } from './ReviewCallFlowPanel';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

function readyState(): ReviewState {
  return {
    callFlowAdvert: {
      enabled: true,
      available: true,
      state: 'available',
      provider: 'calldiff',
      installable: true,
    },
    callFlowAvailable: true,
    callFlowAnalysis: {
      status: 'ready',
      data: {
        status: 'ok',
        snapshotId: 'snapshot',
        provider: 'calldiff',
        version: '0.4.1',
        from: 'before',
        to: 'after',
        raw: '+ CallFlowTreeView({})\n- callflowtreeview()\n  unrelated()',
        trees: [],
        fileImpacts: {},
        summary: { entries: 0, changedNodes: 2, added: 1, removed: 1, impactedFiles: 1, warnings: 0 },
        diagnostics: [],
        skippedLanguages: [],
      },
    },
    retryCallFlowAnalysis: () => {},
    isCallFlowNodeInPatch: () => false,
    isCallFlowActive: true,
    openCallFlowPanel: () => {},
    callFlowInstall: { status: { state: 'idle' }, start: () => {} },
    openDiffFile: () => {},
    onLineSelection: () => {},
    onRequestLineAnnotation: () => {},
    onAddCallFlowAnnotation: () => true,
  } as unknown as ReviewState;
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe('ReviewCallFlowPanel raw search', () => {
  test.skipIf(!hasDom)('uses a utility-only toolbar and navigates raw matches', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <ReviewStateProvider value={readyState()}>
          <ReviewCallFlowPanel />
        </ReviewStateProvider>,
      );
    });

    const rawTab = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Raw');
    await act(async () => rawTab?.click());
    expect(host.textContent).not.toContain('Canonical CallDiff output');

    const searchButton = host.querySelector<HTMLButtonElement>('[aria-label="Search raw call diff"]');
    expect(searchButton).not.toBeNull();
    await act(async () => searchButton?.click());
    const input = host.querySelector<HTMLInputElement>('input[type="search"]');
    expect(input).not.toBeNull();

    await act(async () => {
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
      setter?.call(input, 'CallFlowTreeView');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelectorAll('.call-flow-raw mark')).toHaveLength(2);
    expect(host.querySelector('[data-raw-match="0"]')?.classList.contains('call-flow-raw-match-current')).toBe(true);
    expect(host.textContent).toContain('1/2');

    const next = host.querySelector<HTMLButtonElement>('[aria-label="Next match"]');
    await act(async () => next?.click());
    expect(host.querySelector('[data-raw-match="1"]')?.classList.contains('call-flow-raw-match-current')).toBe(true);
    expect(host.textContent).toContain('2/2');

    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    });
    expect(host.querySelector('input[type="search"]')).toBeNull();

    let shortcutEscapedRawView = false;
    const otherSearchShortcut = () => { shortcutEscapedRawView = true; };
    window.addEventListener('keydown', otherSearchShortcut);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true }));
      await Promise.resolve();
    });
    window.removeEventListener('keydown', otherSearchShortcut);
    expect(host.querySelector('input[type="search"]')).not.toBeNull();
    expect(shortcutEscapedRawView).toBe(false);
  });
});
