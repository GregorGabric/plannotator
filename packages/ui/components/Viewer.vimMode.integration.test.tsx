import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Annotation } from '../types';

const hasDom = typeof document !== 'undefined';
const viewerModule = hasDom ? await import('./Viewer') : null;
const parserModule = hasDom ? await import('../utils/parser') : null;

const FIXTURES = [
  '05-real-world-plan.md',
  '10-inline-gaps-and-bullets.md',
  '12-gfm-and-inline-extras.md',
] as const;

function keydown(target: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

describe.if(hasDom)('Viewer Vim mode with repository fixtures', () => {
  for (const fixture of FIXTURES) {
    test(`selects and redlines rendered content in ${fixture}`, async () => {
      if (!viewerModule || !parserModule) {
        throw new Error('DOM test environment is not registered');
      }
      const markdown = readFileSync(
        resolve(import.meta.dir, '../../../tests/test-fixtures', fixture),
        'utf8',
      );
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      const annotations: Annotation[] = [];

      await act(async () => {
        root.render(
          <viewerModule.Viewer
            blocks={parserModule.parseMarkdownToBlocks(markdown)}
            markdown={markdown}
            annotations={[]}
            onAddAnnotation={(annotation) => annotations.push(annotation)}
            onSelectAnnotation={() => {}}
            selectedAnnotationId={null}
            mode="selection"
            inputMethod="drag"
            taterMode={false}
            stickyActions={false}
            disableCodePathValidation
            vimModeEnabled
          />,
        );
      });

      const article = host.querySelector<HTMLElement>('[data-vim-mode="enabled"]');
      if (!article) throw new Error(`Vim article missing for ${fixture}`);
      act(() => article.focus());
      act(() => { keydown(article, 'v'); });
      act(() => { keydown(article, 'w'); });
      let action: KeyboardEvent | null = null;
      act(() => { action = keydown(article, 'd'); });

      expect(action?.defaultPrevented).toBe(true);
      expect(annotations).toHaveLength(1);
      expect(annotations[0]?.originalText.trim().length).toBeGreaterThan(0);
      expect(host.querySelectorAll('mark.annotation-highlight.deletion').length)
        .toBeGreaterThan(0);

      act(() => root.unmount());
      host.remove();
      window.getSelection()?.removeAllRanges();
    });
  }

  test('does not install a keyboard focus surface when Vim mode is disabled', async () => {
    if (!viewerModule || !parserModule) {
      throw new Error('DOM test environment is not registered');
    }
    const markdown = '# Compatibility\n\nExisting interaction remains unchanged.';
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <viewerModule.Viewer
          blocks={parserModule.parseMarkdownToBlocks(markdown)}
          markdown={markdown}
          annotations={[]}
          onAddAnnotation={() => {}}
          onSelectAnnotation={() => {}}
          selectedAnnotationId={null}
          mode="selection"
          inputMethod="drag"
          taterMode={false}
          stickyActions={false}
          disableCodePathValidation
          vimModeEnabled={false}
        />,
      );
    });

    const article = host.querySelector<HTMLElement>('[data-print-region="article"]');
    if (!article) throw new Error('Viewer article missing');
    const event = keydown(article, 'v');
    expect(event.defaultPrevented).toBe(false);
    expect(article.hasAttribute('tabindex')).toBe(false);
    expect(article.hasAttribute('data-vim-mode')).toBe(false);

    act(() => root.unmount());
    host.remove();
  });

  test('paints the active block instead of outlining the document container', async () => {
    if (!viewerModule || !parserModule) {
      throw new Error('DOM test environment is not registered');
    }
    const markdown = [
      '# Block cursor',
      '',
      'First paragraph.',
      '',
      'Second paragraph.',
    ].join('\n');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <viewerModule.Viewer
          blocks={parserModule.parseMarkdownToBlocks(markdown)}
          markdown={markdown}
          annotations={[]}
          onAddAnnotation={() => {}}
          onSelectAnnotation={() => {}}
          selectedAnnotationId={null}
          mode="selection"
          inputMethod="drag"
          taterMode={false}
          stickyActions={false}
          disableCodePathValidation
          vimModeEnabled
        />,
      );
    });

    const article = host.querySelector<HTMLElement>('[data-vim-mode="enabled"]');
    if (!article) throw new Error('Vim article missing');
    act(() => article.focus());

    expect(article.style.outline).toContain('none');
    expect(article.className).not.toContain('focus-visible:ring');
    expect(article.dataset.vimPhase).toBe('block');
    expect(host.querySelector('[data-pinpoint-overlay]')).not.toBeNull();
    expect(host.querySelector<HTMLElement>('[data-pinpoint-label]')?.dataset.pinpointLabel)
      .toContain('heading');

    act(() => { keydown(article, 'j'); });
    expect(host.querySelector<HTMLElement>('[data-pinpoint-label]')?.dataset.pinpointLabel)
      .toContain('First paragraph');

    act(() => root.unmount());
    host.remove();
  });

  test('pointer Pinpoint and keyboard refinement paint the same inline target', async () => {
    if (!viewerModule || !parserModule) {
      throw new Error('DOM test environment is not registered');
    }
    const markdown = 'Alpha **bravo** charlie.';
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <viewerModule.Viewer
          blocks={parserModule.parseMarkdownToBlocks(markdown)}
          markdown={markdown}
          annotations={[]}
          onAddAnnotation={() => {}}
          onSelectAnnotation={() => {}}
          selectedAnnotationId={null}
          mode="selection"
          inputMethod="pinpoint"
          taterMode={false}
          stickyActions={false}
          disableCodePathValidation
          vimModeEnabled
        />,
      );
    });

    const article = host.querySelector<HTMLElement>('[data-vim-mode="enabled"]');
    const strong = host.querySelector<HTMLElement>('strong');
    if (!article || !strong) throw new Error('Missing inline Pinpoint fixture');

    act(() => {
      strong.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        clientX: 10,
        clientY: 10,
      }));
    });
    const pointerLabel = host
      .querySelector<HTMLElement>('[data-pinpoint-label]')
      ?.dataset.pinpointLabel;
    expect(pointerLabel).toContain('bold');

    act(() => article.focus());
    act(() => { keydown(article, 'l'); });
    expect(article.dataset.vimTargetKey).toContain(':inline:0');
    expect(
      host.querySelector<HTMLElement>('[data-pinpoint-label]')?.dataset.pinpointLabel,
    ).toBe(pointerLabel);

    act(() => root.unmount());
    host.remove();
  });

  test('renders the video-style HUD from real handled commands instead of the compact badge', async () => {
    if (!viewerModule || !parserModule) {
      throw new Error('DOM test environment is not registered');
    }
    const markdown = '# Keyboard HUD\n\nFirst paragraph.\n\nSecond paragraph.';
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <viewerModule.Viewer
          blocks={parserModule.parseMarkdownToBlocks(markdown)}
          markdown={markdown}
          annotations={[]}
          onAddAnnotation={() => {}}
          onSelectAnnotation={() => {}}
          selectedAnnotationId={null}
          mode="selection"
          inputMethod="pinpoint"
          taterMode={false}
          stickyActions={false}
          disableCodePathValidation
          vimModeEnabled
          vimHudEnabled
        />,
      );
    });

    const article = host.querySelector<HTMLElement>('[data-vim-mode="enabled"]');
    if (!article) throw new Error('Vim article missing');
    act(() => article.focus());
    act(() => { keydown(article, 'j'); });

    const hud = document.querySelector<HTMLElement>('[data-vim-key-hud]');
    expect(hud).not.toBeNull();
    expect(document.querySelector('[data-vim-mode-badge]')).toBeNull();
    expect(hud?.style.height).toBe('88px');
    expect(hud?.style.bottom).toBe('150px');
    expect(hud?.style.borderRadius).toBe('20px');
    expect(hud?.style.background).toContain('rgba(43,35,59,0.46)');
    expect(hud?.style.backdropFilter).toBe('blur(10px)');
    expect(document.querySelector('[data-vim-hud-active-key="j"]')).not.toBeNull();
    expect(document.querySelector('[data-vim-hud-phase]')?.textContent)
      .toBe('BLOCK / PINPOINT');
    expect(document.querySelector('[data-vim-hud-command]')?.textContent)
      .toBe('Next block');

    act(() => { keydown(article, 'k'); });
    act(() => { keydown(article, 'j'); });
    act(() => { keydown(article, 'k'); });
    expect(
      Array.from(document.querySelectorAll<HTMLElement>('[data-vim-hud-previous-key]'))
        .map((element) => element.dataset.vimHudPreviousKey),
    ).toEqual(['j', 'k', 'j']);
    expect(document.querySelector('[data-vim-hud-active-key="k"]')).not.toBeNull();

    act(() => root.unmount());
    host.remove();
  });
});
