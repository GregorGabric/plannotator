import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useCallback, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useDocumentScrollBridge } from './useDocumentScrollBridge';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

function Harness({ active, onRange }: { active: boolean; onRange: (range: number) => void }) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const getRange = useCallback(() => 600, []);
  useDocumentScrollBridge({
    active,
    scroller,
    getScrollRange: getRange,
    onScrollRangeChange: onRange,
  });
  return (
    <div
      data-pn-review-scroll-stage="true"
      ref={(node) => {
        if (node) Object.defineProperty(node, 'offsetTop', { configurable: true, value: 52 });
      }}
    >
      <div ref={setScroller}><div /></div>
    </div>
  );
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe('useDocumentScrollBridge', () => {
  test.skipIf(!hasDom)('maps page travel to the renderer and does not let inactive panels clear the active range', async () => {
    let pageY = 0;
    const originalScrollY = Object.getOwnPropertyDescriptor(window, 'scrollY');
    const originalScrollTo = window.scrollTo;
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => pageY });
    window.scrollTo = ((_x: number, y: number) => { pageY = y; }) as typeof window.scrollTo;
    const activeRange = mock(() => {});
    const inactiveRange = mock(() => {});

    try {
      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => {
        root?.render(
          <>
            <Harness active onRange={activeRange} />
            <Harness active={false} onRange={inactiveRange} />
          </>,
        );
        await new Promise((resolve) => setTimeout(resolve, 25));
      });

      expect(activeRange).toHaveBeenCalledWith(600);
      expect(inactiveRange).not.toHaveBeenCalled();
      const scroller = host.querySelector<HTMLElement>('[data-pn-review-scroll-stage="true"] > div');
      expect(scroller).not.toBeNull();

      pageY = 152;
      window.dispatchEvent(new Event('scroll'));
      expect(scroller?.scrollTop).toBe(100);

      scroller!.scrollTop = 300;
      scroller!.dispatchEvent(new Event('scroll'));
      expect(pageY).toBe(352);
    } finally {
      window.scrollTo = originalScrollTo;
      if (originalScrollY) Object.defineProperty(window, 'scrollY', originalScrollY);
    }
  });
});
