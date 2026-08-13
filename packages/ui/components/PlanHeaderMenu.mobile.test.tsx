import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';

const hasDom = typeof document !== 'undefined' && typeof window !== 'undefined';
const domClient = hasDom ? await import('react-dom/client') : null;
const act = hasDom ? (await import('react')).act : null;
const menuModule = await import('./PlanHeaderMenu');
const themeModule = await import('./ThemeProvider');
const PlanHeaderMenu = menuModule.PlanHeaderMenu;
const ThemeProvider = themeModule.ThemeProvider;

afterEach(() => {
  if (hasDom) document.body.innerHTML = '';
});

const baseProps = {
  appVersion: '0.0.0',
  onOpenSettings: () => {},
  onOpenExport: () => {},
  onCopyAgentInstructions: () => {},
  onDownloadAnnotations: () => {},
  onPrint: () => {},
  onCopyShareLink: () => {},
  onOpenImport: () => {},
  onSaveToObsidian: () => {},
  onSaveToBear: () => {},
  onSaveToOctarine: () => {},
  sharingEnabled: false,
  isApiMode: true,
  agentInstructionsEnabled: false,
  obsidianConfigured: false,
  bearConfigured: false,
  octarineConfigured: false,
};

describe.if(hasDom)('PlanHeaderMenu compact actions', () => {
  test('moves session and edit decisions into the compact Options menu', async () => {
    const selected: string[] = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = domClient!.createRoot(host);

    await act!(async () => {
      root.render(
        <ThemeProvider defaultTheme="dark">
          <PlanHeaderMenu
            {...baseProps}
            compactTouchLayout
            compactSessionActions={[
              { id: 'feedback', label: 'Send feedback', onSelect: () => selected.push('feedback') },
              { id: 'approve', label: 'Approve', onSelect: () => selected.push('approve') },
            ]}
            compactDocumentActions={[
              { id: 'edit', label: 'Edit document', onSelect: () => selected.push('edit') },
            ]}
          />
        </ThemeProvider>,
      );
    });

    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Options"]')!;
    expect(trigger.getAttribute('data-pn-touch-target')).not.toBeNull();
    await act!(async () => trigger.click());

    expect(host.textContent).toContain('Review');
    expect(host.textContent).toContain('Send feedback');
    expect(host.textContent).toContain('Approve');
    expect(host.textContent).toContain('Document');
    expect(host.textContent).toContain('Edit document');

    const edit = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Edit document'))!;
    await act!(async () => edit.click());
    expect(selected).toEqual(['edit']);
    expect(host.textContent).not.toContain('Edit document');
    await act!(async () => root.unmount());
  });

  test('keeps compact-only decisions out of the desktop menu', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = domClient!.createRoot(host);

    await act!(async () => {
      root.render(
        <ThemeProvider defaultTheme="dark">
          <PlanHeaderMenu
            {...baseProps}
            compactSessionActions={[
              { id: 'approve', label: 'Approve', onSelect: () => {} },
            ]}
          />
        </ThemeProvider>,
      );
    });
    await act!(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Options"]')!.click());

    expect(host.textContent).not.toContain('Approve');
    expect(host.textContent).toContain('Settings');
    await act!(async () => root.unmount());
  });
});
