/**
 * Collapse affordance for the full-viewport floating controls (DOM-gated).
 *
 * Contract under test: when the host wires onToggleControlsCollapsed, the
 * floating comment/attachments cluster carries a collapse chevron; collapsed,
 * the whole cluster is replaced by a small expand pill in the same corner (a
 * user can always get the controls back). Hosts that do NOT wire the callback
 * (readOnly viewers, review-editor panels) get neither affordance, and
 * hideControls still removes everything including the pill.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const htmlViewerModule = hasDom ? await import('./HtmlViewer') : null;

const mountedRoots: Array<{ unmount: () => void }> = [];

afterEach(async () => {
  if (!hasDom) return;
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

async function mountViewer(props: Record<string, unknown>) {
  const { HtmlViewer } = htmlViewerModule!;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      React.createElement(HtmlViewer, {
        rawHtml: '<p>hello</p>',
        annotations: [],
        onAddAnnotation: () => {},
        onSelectAnnotation: () => {},
        selectedAnnotationId: null,
        mode: 'selection',
        inputMethod: 'pinpoint',
        fullViewport: true,
        ...props,
      }),
    );
  });
  return host;
}

describe.if(hasDom)('HtmlViewer floating-controls collapse', () => {
  test('wired host: cluster shows a collapse chevron; collapsed shows only the expand pill', async () => {
    let toggles = 0;
    const host = await mountViewer({
      controlsCollapsed: false,
      onToggleControlsCollapsed: () => { toggles += 1; },
    });
    const collapseBtn = host.querySelector('[data-html-controls-collapse]');
    expect(collapseBtn).not.toBeNull();
    expect(host.querySelector('[data-html-controls-expand]')).toBeNull();

    await act(async () => {
      (collapseBtn as HTMLButtonElement).click();
    });
    expect(toggles).toBe(1);
  });

  test('collapsed: cluster gone, expand pill present and clickable', async () => {
    let toggles = 0;
    const host = await mountViewer({
      controlsCollapsed: true,
      onToggleControlsCollapsed: () => { toggles += 1; },
    });
    expect(host.querySelector('[data-html-controls-cluster]')).toBeNull();
    const pill = host.querySelector('[data-html-controls-expand]');
    expect(pill).not.toBeNull();
    await act(async () => {
      (pill as HTMLButtonElement).click();
    });
    expect(toggles).toBe(1);
  });

  test('unwired host keeps the cluster with no collapse affordance', async () => {
    const host = await mountViewer({});
    expect(host.querySelector('[data-html-controls-cluster]')).not.toBeNull();
    expect(host.querySelector('[data-html-controls-collapse]')).toBeNull();
    expect(host.querySelector('[data-html-controls-expand]')).toBeNull();
  });

  test('hideControls removes cluster AND pill even when wired + collapsed', async () => {
    const host = await mountViewer({
      hideControls: true,
      controlsCollapsed: true,
      onToggleControlsCollapsed: () => {},
    });
    expect(host.querySelector('[data-html-controls-cluster]')).toBeNull();
    expect(host.querySelector('[data-html-controls-expand]')).toBeNull();
  });
});
