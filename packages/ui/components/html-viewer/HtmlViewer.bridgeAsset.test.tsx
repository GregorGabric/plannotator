/**
 * HtmlViewer on the `bridgeScriptUrl` path (DOM-gated).
 *
 * Guards: the srcdoc carries a `<script src>` instead of the inline literal
 * only when the prop is set; a ready without the protocol stamp (a cached
 * asset from an older package) produces one console warning naming both
 * versions plus the surface's error banner and host callback; a missing
 * ready within `bridgeReadyTimeoutMs` produces the timeout banner and a
 * late ready clears it; and the inline path runs no timer and shows no
 * banner, so Plannotator's surface is unchanged.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { BRIDGE_PROTOCOL_VERSION, BRIDGE_SCRIPT } from './bridge-script';
import type { BridgeUnavailableInfo } from './HtmlViewer';

const hasDom = typeof document !== 'undefined';
const htmlViewerModule = hasDom ? await import('./HtmlViewer') : null;

const mountedRoots: Array<{ unmount: () => void }> = [];
const originalWarn = console.warn;
const originalError = console.error;

afterEach(async () => {
  console.warn = originalWarn;
  console.error = originalError;
  if (!hasDom) return;
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

const ASSET_URL = 'https://host.example/assets/bridge-script.deadbeef.js';

async function mount(props: {
  bridgeScriptUrl?: string;
  bridgeReadyTimeoutMs?: number;
  onBridgeUnavailable?: (info: BridgeUnavailableInfo) => void;
}) {
  if (!htmlViewerModule) throw new Error('DOM test environment is not registered');
  const HtmlViewer = htmlViewerModule.HtmlViewer;
  // happy-dom parses the srcdoc and, with script file loading disabled,
  // reports the <script src> as a NotSupportedError through console.error.
  // That is the environment, not the viewer (a browser fetches the asset):
  // keep it out of the test output. Restored in afterEach.
  if (props.bridgeScriptUrl) console.error = () => {};
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      <HtmlViewer
        rawHtml="<html><head><title>t</title></head><body><p>Target</p></body></html>"
        annotations={[]}
        onAddAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="selection"
        inputMethod="pinpoint"
        {...props}
      />,
    );
  });
  const iframe = host.querySelector<HTMLIFrameElement>('iframe');
  if (!iframe?.contentWindow) throw new Error('HTML iframe missing');
  const postedToIframe: Array<Record<string, unknown>> = [];
  const realPost = iframe.contentWindow.postMessage.bind(iframe.contentWindow);
  (iframe.contentWindow as unknown as { postMessage: (data: unknown) => void }).postMessage =
    ((data: unknown, ...rest: unknown[]) => {
      if (data && typeof data === 'object') postedToIframe.push(data as Record<string, unknown>);
      return (realPost as (...args: unknown[]) => unknown)(data, ...rest);
    }) as typeof iframe.contentWindow.postMessage;
  const postReady = async (data: Record<string, unknown>) => {
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data }));
    });
  };
  const banner = () => host.querySelector<HTMLElement>('[data-bridge-error]');
  return { host, iframe, postReady, postedToIframe, banner };
}

function captureWarnings(): string[] {
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  return warnings;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe.if(hasDom)('HtmlViewer bridgeScriptUrl', () => {
  test('the srcdoc loads the bridge by URL instead of inlining it', async () => {
    const { iframe } = await mount({ bridgeScriptUrl: ASSET_URL });
    const srcdoc = iframe.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain(`<script src="${ASSET_URL}"></script>`);
    expect(srcdoc).not.toContain(BRIDGE_SCRIPT);
    // The sandbox is unchanged by the delivery path.
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
  });

  test('without the prop the srcdoc inlines the bridge, as before', async () => {
    const { iframe, banner } = await mount({});
    const srcdoc = iframe.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain(`<script>${BRIDGE_SCRIPT}</script>`);
    expect(srcdoc).not.toContain('<script src=');
    expect(banner()).toBeNull();
  });

  test('a stale asset (ready without the stamp) warns once naming both versions, shows the banner, and still honors the ready', async () => {
    const warnings = captureWarnings();
    const unavailable: BridgeUnavailableInfo[] = [];
    const { postReady, postedToIframe, banner } = await mount({
      bridgeScriptUrl: ASSET_URL,
      onBridgeUnavailable: (info) => unavailable.push(info),
    });
    await postReady({ type: 'plannotator-bridge-ready' });

    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(`expects ${BRIDGE_PROTOCOL_VERSION}`);
    expect(warnings[0]).toContain('reported none');
    expect(warnings[0]).toContain(ASSET_URL);

    const el = banner();
    expect(el?.getAttribute('data-bridge-error')).toBe('version-mismatch');
    expect(el?.getAttribute('role')).toBe('alert');
    expect(el?.textContent).toContain(ASSET_URL);
    expect(unavailable).toEqual([
      { kind: 'version-mismatch', url: ASSET_URL, expectedVersion: BRIDGE_PROTOCOL_VERSION, reportedVersion: undefined },
    ]);
    // Not a refusal: the parent still configures the older bridge.
    expect(postedToIframe.some((m) => m.type === 'plannotator-bridge-sync-annotations')).toBe(true);
  });

  test('a matching ready shows no banner and cancels the ready timer', async () => {
    const warnings = captureWarnings();
    const unavailable: BridgeUnavailableInfo[] = [];
    const { postReady, banner } = await mount({
      bridgeScriptUrl: ASSET_URL,
      bridgeReadyTimeoutMs: 40,
      onBridgeUnavailable: (info) => unavailable.push(info),
    });
    await postReady({ type: 'plannotator-bridge-ready', protocolVersion: BRIDGE_PROTOCOL_VERSION });
    await act(async () => { await wait(80); });
    expect(warnings).toEqual([]);
    expect(banner()).toBeNull();
    expect(unavailable).toEqual([]);
  });

  test('no ready within bridgeReadyTimeoutMs shows the timeout banner; a late ready clears it', async () => {
    const unavailable: BridgeUnavailableInfo[] = [];
    const { postReady, banner } = await mount({
      bridgeScriptUrl: ASSET_URL,
      bridgeReadyTimeoutMs: 30,
      onBridgeUnavailable: (info) => unavailable.push(info),
    });
    expect(banner()).toBeNull();
    await act(async () => { await wait(70); });
    const el = banner();
    expect(el?.getAttribute('data-bridge-error')).toBe('timeout');
    expect(el?.textContent).toContain('30 ms');
    expect(el?.textContent).toContain(ASSET_URL);
    expect(unavailable).toEqual([{ kind: 'timeout', url: ASSET_URL, timeoutMs: 30 }]);

    await postReady({ type: 'plannotator-bridge-ready', protocolVersion: BRIDGE_PROTOCOL_VERSION });
    expect(banner()).toBeNull();
  });

  test('inline path: no timer, no banner, no callback; a stamp-less ready only warns', async () => {
    const warnings = captureWarnings();
    const unavailable: BridgeUnavailableInfo[] = [];
    const { postReady, banner, postedToIframe } = await mount({
      // A tiny timeout that would fire if the inline path ever armed a timer.
      bridgeReadyTimeoutMs: 10,
      onBridgeUnavailable: (info) => unavailable.push(info),
    });
    await act(async () => { await wait(50); });
    expect(banner()).toBeNull();
    expect(unavailable).toEqual([]);

    await postReady({ type: 'plannotator-bridge-ready' });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).not.toContain(ASSET_URL);
    expect(banner()).toBeNull();
    expect(unavailable).toEqual([]);
    expect(postedToIframe.some((m) => m.type === 'plannotator-bridge-sync-annotations')).toBe(true);
  });
});
