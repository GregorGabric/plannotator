import { useEffect } from 'react';

interface DocumentScrollBridgeOptions {
  active: boolean;
  scroller: HTMLElement | null;
  getScrollRange?: () => number;
  onScrollRangeChange?: (range: number) => void;
}

function getDocumentTop(element: HTMLElement | null): number {
  let top = 0;
  let current = element;
  while (current) {
    top += current.offsetTop;
    current = current.offsetParent as HTMLElement | null;
  }
  return top;
}

/**
 * Makes a nested review scroller follow document scrolling on compact touch.
 *
 * Mobile Safari collapses its browser chrome only for page scrolling. The
 * review renderers still need their own bounded viewport (Pierre CodeView for
 * virtualization; DiffViewer for its shadow-DOM selection model), so the page
 * supplies equivalent travel while this hook mirrors positions both ways.
 */
export function useDocumentScrollBridge({
  active,
  scroller,
  getScrollRange,
  onScrollRangeChange,
}: DocumentScrollBridgeOptions): void {
  useEffect(() => {
    if (!active || !scroller) {
      return;
    }

    let frame: number | null = null;
    let pageStart = 0;
    let scrollRange = 0;
    const stage = scroller.closest<HTMLElement>('[data-pn-review-scroll-stage="true"]');
    const app = stage?.closest<HTMLElement>('.pn-app-viewport');
    const readScrollRange = () => Math.max(
      0,
      getScrollRange?.() ?? (scroller.scrollHeight - scroller.clientHeight),
    );
    const measure = () => {
      frame = null;
      pageStart = getDocumentTop(stage);
      scrollRange = Math.ceil(readScrollRange());
      onScrollRangeChange?.(scrollRange);
    };
    const queueMeasure = () => {
      if (frame == null) frame = requestAnimationFrame(measure);
    };
    const syncScrollerFromDocument = () => {
      const next = Math.min(Math.max(window.scrollY - pageStart, 0), scrollRange);
      if (Math.abs(scroller.scrollTop - next) > 0.5) scroller.scrollTop = next;
    };
    const syncDocumentFromScroller = () => {
      const next = pageStart + scroller.scrollTop;
      if (Math.abs(window.scrollY - next) > 0.5) window.scrollTo(0, next);
    };

    const resizeObserver = new ResizeObserver(queueMeasure);
    resizeObserver.observe(scroller);
    if (stage) resizeObserver.observe(stage);
    if (app) resizeObserver.observe(app);
    const content = scroller.firstElementChild;
    if (content) resizeObserver.observe(content);
    const mutationObserver = new MutationObserver(() => {
      const nextContent = scroller.firstElementChild;
      if (nextContent) resizeObserver.observe(nextContent);
      queueMeasure();
    });
    mutationObserver.observe(scroller, { childList: true });
    window.addEventListener('scroll', syncScrollerFromDocument, { passive: true });
    scroller.addEventListener('scroll', syncDocumentFromScroller, { passive: true });

    measure();
    syncScrollerFromDocument();
    return () => {
      if (frame != null) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener('scroll', syncScrollerFromDocument);
      scroller.removeEventListener('scroll', syncDocumentFromScroller);
      onScrollRangeChange?.(0);
    };
  }, [active, getScrollRange, onScrollRangeChange, scroller]);
}
