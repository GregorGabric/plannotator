import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const htmlViewerModule = hasDom ? await import('./HtmlViewer') : null;

afterEach(() => {
  if (hasDom) document.body.replaceChildren();
});

describe.if(hasDom)('HtmlViewer Vim HUD bridge', () => {
  test('renders validated iframe command messages through the shared parent HUD', async () => {
    if (!htmlViewerModule) {
      throw new Error('DOM test environment is not registered');
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <htmlViewerModule.HtmlViewer
          rawHtml="<html><body><p>First</p><p>Second</p></body></html>"
          annotations={[]}
          onAddAnnotation={() => {}}
          onSelectAnnotation={() => {}}
          selectedAnnotationId={null}
          mode="selection"
          inputMethod="pinpoint"
          vimModeEnabled
          vimHudEnabled
        />,
      );
    });

    const iframe = host.querySelector<HTMLIFrameElement>('iframe');
    if (!iframe?.contentWindow) throw new Error('HTML iframe missing');
    act(() => iframe.focus());
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: iframe.contentWindow,
        data: {
          type: 'plannotator-bridge-vim-state',
          phase: 'block',
        },
      }));
      window.dispatchEvent(new MessageEvent('message', {
        source: iframe.contentWindow,
        data: {
          type: 'plannotator-bridge-vim-command',
          actionId: 'moveDown',
          key: 'j',
          context: 'block',
        },
      }));
    });

    expect(document.querySelector('[data-vim-key-hud]')).not.toBeNull();
    expect(document.querySelector('[data-vim-hud-active-key="j"]')).not.toBeNull();
    expect(document.querySelector('[data-vim-hud-phase]')?.textContent)
      .toBe('BLOCK / PINPOINT');
    expect(document.querySelector('[data-vim-hud-command]')?.textContent)
      .toBe('Next block');

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: iframe.contentWindow,
        data: {
          type: 'plannotator-bridge-vim-command',
          actionId: 'not-a-real-action',
          key: 'x',
          context: 'block',
        },
      }));
    });
    expect(document.querySelector('[data-vim-hud-active-key="j"]')).not.toBeNull();

    await act(async () => {
      root.render(
        <htmlViewerModule.HtmlViewer
          rawHtml="<html><body><p>First</p><p>Second</p></body></html>"
          annotations={[]}
          onAddAnnotation={() => {}}
          onSelectAnnotation={() => {}}
          selectedAnnotationId={null}
          mode="selection"
          inputMethod="pinpoint"
          vimModeEnabled
          vimHudEnabled={false}
        />,
      );
    });
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: iframe.contentWindow,
        data: {
          type: 'plannotator-bridge-vim-command',
          actionId: 'moveUp',
          key: 'k',
          context: 'block',
        },
      }));
    });
    expect(document.querySelector('[data-vim-key-hud]')).toBeNull();

    act(() => root.unmount());
  });
});
