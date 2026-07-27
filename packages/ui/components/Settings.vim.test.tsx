import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { configStore } from '../config';
import { Settings } from './Settings';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

function buttonWithExactText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find(candidate => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`Button labelled "${text}" did not render`);
  return button;
}

async function mountSettings(mode: 'plan' | 'annotate' | 'review'): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <Settings
        taterMode={false}
        onTaterModeChange={() => {}}
        mode={mode}
        externalOpen
      />,
    );
  });
}

describe('Settings Vim panel', () => {
  afterEach(async () => {
    const mountedRoot = root;
    if (mountedRoot) await act(async () => mountedRoot.unmount());
    root = null;
    host?.remove();
    host = null;
    configStore.set('vimModeEnabled', false);
    configStore.set('vimHudEnabled', false);
    if (hasDom) document.body.replaceChildren();
  });

  test.skipIf(!hasDom)('keeps Vim configuration in a dedicated plan settings panel', async () => {
    configStore.set('vimModeEnabled', false);
    configStore.set('vimHudEnabled', false);
    await mountSettings('plan');

    await act(async () => buttonWithExactText('Vim').click());

    const vimToggle = document.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Vim controls"]',
    );
    const hudToggle = document.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Vim HUD"]',
    );
    expect(vimToggle).not.toBeNull();
    expect(hudToggle?.disabled).toBe(true);
    expect(document.body.textContent).toContain('Learn while you navigate');

    await act(async () => vimToggle?.click());
    expect(hudToggle?.disabled).toBe(false);

    await act(async () => buttonWithExactText('Shortcuts').click());
    expect(document.querySelector('button[role="switch"][aria-label="Vim controls"]')).toBeNull();
    expect(document.querySelector('button[role="switch"][aria-label="Vim HUD"]')).toBeNull();
  });

  test.skipIf(!hasDom)('does not offer document Vim settings in code review', async () => {
    await mountSettings('review');

    expect(
      Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .some(candidate => candidate.textContent?.trim() === 'Vim'),
    ).toBe(false);
  });

  test.skipIf(!hasDom)('offers the dedicated Vim panel in annotate mode', async () => {
    await mountSettings('annotate');

    await act(async () => buttonWithExactText('Vim').click());

    expect(
      document.querySelector('button[role="switch"][aria-label="Vim controls"]'),
    ).not.toBeNull();
  });
});
