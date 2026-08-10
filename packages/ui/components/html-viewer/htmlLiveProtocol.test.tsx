/**
 * Live-session protocol contract (DOM-gated).
 *
 * Parent side: with a live session configured, messages from a wrong origin
 * or without the session token never reach parseBridgeMessage effects, and
 * every outbound post carries the token with the live targetOrigin.
 *
 * Bridge side: executes the composed live body (JSON config prelude +
 * LIVE_BRIDGE_BOOTSTRAP + BRIDGE_SCRIPT) in the test window with a stubbed
 * parent/top pair so the frame gate passes, then asserts the live gate:
 * pinpoint-only clamp, vim ignored, ready pageUrl, coalesced page-change,
 * inbound token checks, and the bootstrap-installed CSS. The srcdoc suites
 * run the SAME script with no config and pass unmodified; that is the
 * regression proof that live behavior is inert without it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Annotation } from '../../types';

const hasDom = typeof document !== 'undefined';
const hookModule = hasDom ? await import('./useHtmlAnnotation') : null;
const htmlViewerModule = hasDom ? await import('./HtmlViewer') : null;
const bridgeModule = hasDom ? await import('./bridge-script') : null;

const LIVE_ORIGIN = 'http://127.0.0.1:4567';
const LIVE_TOKEN = 'live-token-1234';

const mountedRoots: Array<{ unmount: () => void }> = [];

afterEach(async () => {
  if (!hasDom) return;
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

describe.if(hasDom)('page-change message validation (trust boundary)', () => {
  test('accepts a bounded pageUrl string', () => {
    expect(hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-page-change',
      pageUrl: '/settings?tab=git',
    })).toEqual({ type: 'plannotator-bridge-page-change', pageUrl: '/settings?tab=git' });
    expect(hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-page-change',
      pageUrl: 'x'.repeat(hookModule!.MAX_PAGE_URL_LENGTH),
    })).not.toBeNull();
  });

  test('rejects oversize, empty, and non-string pageUrls', () => {
    expect(hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-page-change',
      pageUrl: 'x'.repeat(hookModule!.MAX_PAGE_URL_LENGTH + 1),
    })).toBeNull();
    expect(hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-page-change',
      pageUrl: '',
    })).toBeNull();
    expect(hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-page-change',
      pageUrl: 42,
    })).toBeNull();
    expect(hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-page-change',
    })).toBeNull();
  });

  test('rejectsLiveMessage keys on exact origin and token', () => {
    const live = { origin: LIVE_ORIGIN, token: LIVE_TOKEN };
    expect(hookModule!.rejectsLiveMessage(live, LIVE_ORIGIN, { token: LIVE_TOKEN })).toBe(false);
    expect(hookModule!.rejectsLiveMessage(live, 'http://evil.example', { token: LIVE_TOKEN })).toBe(true);
    expect(hookModule!.rejectsLiveMessage(live, LIVE_ORIGIN, { token: 'wrong' })).toBe(true);
    expect(hookModule!.rejectsLiveMessage(live, LIVE_ORIGIN, {})).toBe(true);
    expect(hookModule!.rejectsLiveMessage(live, LIVE_ORIGIN, null)).toBe(true);
  });
});

describe.if(hasDom)('live parent side (HtmlViewer with src + liveSession)', () => {
  async function mountLiveViewer(options: {
    onAdd?: (ann: Annotation) => void;
    onPageChange?: (pageUrl: string) => void;
    annotations?: Annotation[];
    currentPageUrl?: string;
  } = {}) {
    if (!htmlViewerModule) throw new Error('DOM test environment is not registered');
    const HtmlViewer = htmlViewerModule.HtmlViewer;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    mountedRoots.push(root);
    await act(async () => {
      root.render(
        <HtmlViewer
          rawHtml=""
          src="about:blank"
          liveSession={{ origin: LIVE_ORIGIN, token: LIVE_TOKEN }}
          currentPageUrl={options.currentPageUrl ?? '/'}
          onPageChange={options.onPageChange}
          annotations={options.annotations ?? []}
          onAddAnnotation={options.onAdd ?? (() => {})}
          onSelectAnnotation={() => {}}
          selectedAnnotationId={null}
          mode="selection"
          inputMethod="pinpoint"
          fullViewport
        />,
      );
    });
    const iframe = host.querySelector<HTMLIFrameElement>('iframe');
    if (!iframe?.contentWindow) throw new Error('live iframe missing');
    const postedToIframe: Array<{ data: Record<string, unknown>; targetOrigin: unknown }> = [];
    const realPost = iframe.contentWindow.postMessage.bind(iframe.contentWindow);
    (iframe.contentWindow as unknown as { postMessage: (data: unknown, origin?: unknown) => void }).postMessage =
      ((data: unknown, targetOrigin?: unknown, ...rest: unknown[]) => {
        if (data && typeof data === 'object') {
          postedToIframe.push({ data: data as Record<string, unknown>, targetOrigin });
        }
        return (realPost as (...args: unknown[]) => unknown)(data, targetOrigin, ...rest);
      }) as typeof iframe.contentWindow.postMessage;
    const post = async (data: Record<string, unknown>, origin: string = LIVE_ORIGIN) => {
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', {
          source: iframe.contentWindow,
          origin,
          data,
        }));
      });
    };
    return { iframe, post, postedToIframe };
  }

  const selectionMessage = {
    type: 'plannotator-bridge-selection',
    text: 'Live target',
    rect: { top: 10, left: 10, width: 120, height: 24 },
    anchor: { selector: 'p:nth-of-type(1)', tagName: 'p', text: 'Live target' },
    pinpoint: true,
  };

  test('renders a src iframe with no sandbox and no srcdoc', async () => {
    const { iframe } = await mountLiveViewer();
    expect(iframe.getAttribute('src')).toBe('about:blank');
    expect(iframe.hasAttribute('sandbox')).toBe(false);
    expect(iframe.hasAttribute('srcdoc')).toBe(false);
  });

  test('a message from the wrong origin never reaches the selection flow', async () => {
    const { post } = await mountLiveViewer();
    await post({ ...selectionMessage, token: LIVE_TOKEN }, 'http://evil.example');
    expect(document.querySelector('[data-comment-popover]')).toBeNull();
  });

  test('a message without (or with a wrong) token is ignored', async () => {
    const { post } = await mountLiveViewer();
    await post(selectionMessage);
    expect(document.querySelector('[data-comment-popover]')).toBeNull();
    await post({ ...selectionMessage, token: 'forged' });
    expect(document.querySelector('[data-comment-popover]')).toBeNull();
  });

  test('a correctly authenticated pinpoint selection opens the composer', async () => {
    const { post } = await mountLiveViewer();
    await post({ ...selectionMessage, token: LIVE_TOKEN });
    expect(document.querySelector('[data-comment-popover]')).not.toBeNull();
  });

  test('outbound posts carry the token and the live targetOrigin', async () => {
    const { post, postedToIframe } = await mountLiveViewer({
      annotations: [],
    });
    await post({ type: 'plannotator-bridge-ready', pageUrl: '/', token: LIVE_TOKEN });
    expect(postedToIframe.length).toBeGreaterThan(0);
    for (const posted of postedToIframe) {
      expect(posted.data.token).toBe(LIVE_TOKEN);
      expect(posted.targetOrigin).toBe(LIVE_ORIGIN);
    }
    // The bridge-config posts a ready surface always sends.
    const types = postedToIframe.map((p) => p.data.type);
    expect(types).toContain('plannotator-bridge-set-input-method');
  });

  test('an unauthenticated ready is ignored; an authenticated one forwards its pageUrl', async () => {
    const pages: string[] = [];
    const { post, postedToIframe } = await mountLiveViewer({ onPageChange: (p) => pages.push(p) });
    await post({ type: 'plannotator-bridge-ready', pageUrl: '/spoofed' }, LIVE_ORIGIN);
    expect(pages).toEqual([]);
    expect(postedToIframe.length).toBe(0);
    await post({ type: 'plannotator-bridge-ready', pageUrl: '/dashboard?x=1', token: LIVE_TOKEN });
    expect(pages).toEqual(['/dashboard?x=1']);
  });

  test('page-change messages update the parent through onPageChange', async () => {
    const pages: string[] = [];
    const { post } = await mountLiveViewer({ onPageChange: (p) => pages.push(p) });
    await post({ type: 'plannotator-bridge-page-change', pageUrl: '/about', token: LIVE_TOKEN });
    expect(pages).toEqual(['/about']);
    // Oversize pageUrl is rejected at the parse boundary.
    await post({
      type: 'plannotator-bridge-page-change',
      pageUrl: 'x'.repeat(3000),
      token: LIVE_TOKEN,
    });
    expect(pages).toEqual(['/about']);
  });

  test('restore filters to the current page; other pages annotations are held back', async () => {
    const pageAnn = (id: string, pageUrl: string): Annotation => ({
      id,
      blockId: '',
      startOffset: 0,
      endOffset: 0,
      type: 'COMMENT' as Annotation['type'],
      text: 'c',
      originalText: 'o',
      createdA: 1,
      pageUrl,
    } as Annotation);
    const { post, postedToIframe } = await mountLiveViewer({
      annotations: [pageAnn('on-home', '/'), pageAnn('on-about', '/about')],
      currentPageUrl: '/',
    });
    await post({ type: 'plannotator-bridge-ready', pageUrl: '/', token: LIVE_TOKEN });
    const restores = postedToIframe.filter((p) => p.data.type === 'plannotator-bridge-find-and-mark');
    expect(restores.map((p) => p.data.id)).toEqual(['on-home']);
    // Numbering still ships the FULL list (global numbers across pages).
    const syncs = postedToIframe.filter((p) => p.data.type === 'plannotator-bridge-sync-annotations');
    expect(syncs.length).toBeGreaterThan(0);
    expect((syncs.at(-1)!.data.annotations as Array<{ id: string }>).map((a) => a.id)).toEqual([
      'on-home',
      'on-about',
    ]);
  });
});

describe.if(hasDom)('live bridge gate (composed body in the eval harness)', () => {
  type ParentPost = { data: Record<string, unknown>; targetOrigin: unknown };
  const parentPosts: ParentPost[] = [];
  const fakeParent = {
    postMessage(data: unknown, targetOrigin?: unknown) {
      if (data && typeof data === 'object') {
        parentPosts.push({ data: data as Record<string, unknown>, targetOrigin });
      }
    },
  };
  const editorOrigin = 'http://localhost:4100';
  const bridgeToken = 'bridge-live-token';

  // The live bridge is evaluated against a DEDICATED iframe window so its DOM
  // side effects (overlay hosts, hover boxes, pinpoint listeners, the page
  // MutationObserver) stay contained: the srcdoc suites run the same script
  // against the shared global document later in this process and must not see
  // a second live instance there. Same-realm Function parameters rebind the
  // globals the bridge touches, including the parent/top pair the frame gate
  // reads.
  let bridgeFrame: HTMLIFrameElement;
  let bridgeWindow: Window & { __plannotatorLiveConfig?: unknown };
  let bridgeDocument: Document;

  function postToBridge(data: Record<string, unknown>, origin: string = editorOrigin) {
    bridgeWindow.dispatchEvent(new MessageEvent('message', {
      data,
      origin,
      // The bridge accepts messages whose source is its parent window.
      source: fakeParent as unknown as Window,
    }));
  }

  beforeAll(() => {
    bridgeFrame = document.createElement('iframe');
    // documentElement, not body: the file-level afterEach clears body
    // children between tests and must not tear the harness frame down.
    document.documentElement.appendChild(bridgeFrame);
    if (!bridgeFrame.contentWindow || !bridgeFrame.contentDocument) {
      throw new Error('bridge harness iframe missing contentWindow');
    }
    bridgeWindow = bridgeFrame.contentWindow as typeof bridgeWindow;
    bridgeDocument = bridgeFrame.contentDocument;
    const config = {
      live: true,
      token: bridgeToken,
      editorOrigins: [editorOrigin, 'http://127.0.0.1:4100'],
      css: '.pn-live-probe { color: red; }',
    };
    bridgeWindow.__plannotatorLiveConfig = config;
    const body = bridgeModule!.LIVE_BRIDGE_BOOTSTRAP + '\n' + bridgeModule!.BRIDGE_SCRIPT;
    // Rebind the globals the bridge reads: its window/document/location/
    // history are the iframe's, and parent/top are the fake editor pair so
    // the frame gate passes (window !== parent, parent === top).
    const run = new Function(
      'window',
      'document',
      'location',
      'history',
      'parent',
      'top',
      body,
    );
    run(
      bridgeWindow,
      bridgeDocument,
      bridgeWindow.location,
      bridgeWindow.history,
      fakeParent,
      fakeParent,
    );
    if (parentPosts.length === 0) {
      // Environments that report a loading readyState defer onReady.
      bridgeDocument.dispatchEvent(new Event('DOMContentLoaded'));
    }
  });

  afterAll(() => {
    bridgeFrame.remove();
  });

  test('the bootstrap installs the annotation CSS from the config', () => {
    const style = bridgeDocument.querySelector('style[data-plannotator-live-css]');
    expect(style).not.toBeNull();
    expect(style!.textContent).toContain('.pn-live-probe');
  });

  test('ready carries the current pageUrl, the token, and the pinned editor origin', () => {
    const ready = parentPosts.find((p) => p.data.type === 'plannotator-bridge-ready');
    expect(ready).toBeDefined();
    expect(ready!.data.token).toBe(bridgeToken);
    expect(ready!.data.pageUrl).toBe(
      (bridgeWindow.location.pathname + bridgeWindow.location.search).slice(0, 2048),
    );
    expect(ready!.targetOrigin).toBe(editorOrigin);
  });

  test('inbound messages without the token (or from a foreign origin) are ignored', () => {
    bridgeDocument.body.removeAttribute('data-plannotator-pinpoint-cursor');
    postToBridge({ type: 'plannotator-bridge-set-input-method', method: 'pinpoint' });
    expect(bridgeDocument.body.hasAttribute('data-plannotator-pinpoint-cursor')).toBe(false);
    postToBridge(
      { type: 'plannotator-bridge-set-input-method', method: 'pinpoint', token: bridgeToken },
      'http://evil.example',
    );
    expect(bridgeDocument.body.hasAttribute('data-plannotator-pinpoint-cursor')).toBe(false);
  });

  test('the live gate clamps the input method to pinpoint', () => {
    bridgeDocument.body.removeAttribute('data-plannotator-pinpoint-cursor');
    // An authenticated request for drag still lands on pinpoint.
    postToBridge({ type: 'plannotator-bridge-set-input-method', method: 'drag', token: bridgeToken });
    expect(bridgeDocument.body.hasAttribute('data-plannotator-pinpoint-cursor')).toBe(true);
  });

  test('set-vim-mode is ignored in live mode', () => {
    postToBridge({
      type: 'plannotator-bridge-set-vim-mode',
      enabled: true,
      hudEnabled: true,
      mode: 'selection',
      token: bridgeToken,
    });
    expect(bridgeDocument.body.hasAttribute('data-plannotator-vim-focus-owner')).toBe(false);
    expect(bridgeDocument.querySelector('[data-plannotator-vim-ui]')).toBeNull();
  });

  test('a pushState burst posts exactly one coalesced page-change', async () => {
    const before = parentPosts.filter((p) => p.data.type === 'plannotator-bridge-page-change').length;
    bridgeWindow.history.pushState({}, '', '/first');
    bridgeWindow.history.pushState({}, '', '/second?tab=2');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const changes = parentPosts.filter((p) => p.data.type === 'plannotator-bridge-page-change');
    expect(changes.length).toBe(before + 1);
    const last = changes.at(-1)!;
    // The reported page is whatever location the environment resolved the
    // pushState to (happy-dom keeps about:blank-relative paths); the CONTRACT
    // is that it always mirrors the live location, capped at 2048.
    expect(last.data.pageUrl).toBe(
      (bridgeWindow.location.pathname + bridgeWindow.location.search).slice(0, 2048),
    );
    expect(last.data.token).toBe(bridgeToken);
    expect(last.targetOrigin).toBe(editorOrigin);
  });
});
