/** DOM-gated behavior tests for Call Flow pinpoint-style annotation. */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CallFlowAnnotationTarget } from '@plannotator/ui/types';
import type { CallFlowTree } from '@plannotator/shared/call-flow-types';
import { CallFlowTreeView } from './CallFlowTreeView';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

const trees: CallFlowTree[] = [{
  entry: 'checkout()',
  tree: {
    key: 'checkout',
    label: 'checkout()',
    status: 'added',
    file: 'src/checkout.ts',
    line: 10,
    children: [{
      key: 'authorize',
      label: 'authorize()',
      status: 'removed',
      file: 'src/auth.ts',
      line: 21,
      children: [],
    }],
  },
}];

const contextTrees: CallFlowTree[] = [{
  entry: 'checkout()',
  tree: {
    key: 'checkout',
    label: 'checkout()',
    status: 'same',
    children: [
      {
        key: 'unchanged',
        label: 'unchangedContext()',
        status: 'same',
        children: [],
      },
      {
        key: 'changed',
        label: 'changedCall()',
        status: 'added',
        file: 'src/checkout.ts',
        line: 10,
        children: [],
      },
    ],
  },
}];

const multipleEntryTrees: CallFlowTree[] = [
  trees[0]!,
  {
    entry: 'refund()',
    tree: {
      key: 'refund',
      label: 'refund()',
      status: 'added',
      file: 'src/refund.ts',
      line: 8,
      children: [],
    },
  },
];

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe('CallFlowTreeView annotation interaction', () => {
  test.skipIf(!hasDom)('mounts one entry path at a time until another entry is opened', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(<CallFlowTreeView trees={multipleEntryTrees} onOpenNode={() => {}} />);
    });

    expect(host.querySelectorAll('.call-flow-entry')).toHaveLength(2);
    expect(host.querySelectorAll('.call-flow-tree')).toHaveLength(1);
    const refundEntry = [...host.querySelectorAll<HTMLButtonElement>('.call-flow-entry-header')]
      .find((button) => button.textContent?.includes('refund()'));
    expect(refundEntry?.getAttribute('aria-expanded')).toBe('false');

    await act(async () => refundEntry?.click());
    expect(refundEntry?.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelectorAll('.call-flow-tree')).toHaveLength(2);
  });

  test.skipIf(!hasDom)('reveals the complete inferred context only when requested', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        <CallFlowTreeView
          trees={contextTrees}
          onOpenNode={() => {}}
          onAnnotateTargets={() => true}
          canInteractWithNode={() => false}
        />,
      );
    });

    expect(host.textContent).toContain('changedCall()');
    expect(host.textContent).not.toContain('unchangedContext()');
    const toggle = [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Show all context');
    expect(toggle).toBeDefined();

    await act(async () => toggle?.click());
    expect(host.textContent).toContain('unchangedContext()');
    expect(host.textContent).toContain('Show changed paths');

    const unchanged = [...host.querySelectorAll<HTMLButtonElement>('.call-flow-node-target')]
      .find((button) => button.textContent?.includes('unchangedContext()'));
    expect(unchanged?.disabled).toBe(false);
    await act(async () => unchanged?.click());
    expect(document.querySelector('[data-comment-popover="true"]')).not.toBeNull();
  });

  test.skipIf(!hasDom)('creates one native annotation from click plus Shift-click targets', async () => {
    const submissions: Array<{ targets: readonly CallFlowAnnotationTarget[]; text: string }> = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        <CallFlowTreeView
          trees={trees}
          onOpenNode={() => {}}
          onAnnotateTargets={(targets, text) => {
            submissions.push({ targets: [...targets], text });
            return true;
          }}
          canInteractWithNode={() => true}
        />,
      );
    });

    const rowTargets = host.querySelectorAll<HTMLButtonElement>('.call-flow-node-target');
    expect(rowTargets).toHaveLength(2);

    await act(async () => {
      rowTargets[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.querySelector('[data-comment-popover="true"]')).not.toBeNull();
    expect(rowTargets[0]?.getAttribute('aria-pressed')).toBe('true');

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
      window.dispatchEvent(new MouseEvent('mousemove', {
        clientX: 0,
        clientY: 0,
        shiftKey: true,
      }));
    });
    expect(document.querySelector('[data-comment-popover="true"]')?.className)
      .toContain('pn-composer-yield-over');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' }));
    });
    expect(document.querySelector('[data-comment-popover="true"]')?.className)
      .not.toContain('pn-composer-yield-over');

    await act(async () => {
      rowTargets[1]?.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        shiftKey: true,
      }));
    });
    expect(document.querySelector('[data-comment-popover="true"]')).not.toBeNull();

    await act(async () => {
      rowTargets[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    });
    expect(document.querySelectorAll('[data-target-chip]')).toHaveLength(2);
    expect(rowTargets[1]?.getAttribute('aria-pressed')).toBe('true');

    const textarea = document.querySelector<HTMLTextAreaElement>('[data-comment-popover="true"] textarea');
    expect(textarea).not.toBeNull();
    await act(async () => {
      if (!textarea) return;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), 'value')?.set;
      setter?.call(textarea, 'Keep these calls atomic.');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      if (!textarea) return;
      textarea.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        key: 'Enter',
        metaKey: true,
      }));
    });

    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.text).toBe('Keep these calls atomic.');
    expect(submissions[0]?.targets.map((target) => target.filePath)).toEqual([
      'src/checkout.ts',
      'src/auth.ts',
    ]);
    expect(document.querySelector('[data-comment-popover="true"]')).toBeNull();
  });
});
