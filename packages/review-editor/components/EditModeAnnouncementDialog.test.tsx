import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditModeAnnouncementDialog } from './EditModeAnnouncementDialog';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

interface HarnessProps {
  readonly onEnable?: () => void;
  readonly onDismiss?: () => void;
  readonly demoVideoSrc?: string | null;
}

function Harness({ onEnable, onDismiss, demoVideoSrc }: HarnessProps) {
  const [isOpen, setIsOpen] = useState(true);

  return (
    <EditModeAnnouncementDialog
      isOpen={isOpen}
      demoVideoSrc={demoVideoSrc}
      onEnable={() => {
        onEnable?.();
        setIsOpen(false);
      }}
      onDismiss={() => {
        onDismiss?.();
        setIsOpen(false);
      }}
    />
  );
}

async function mountDialog(props: HarnessProps = {}): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<Harness {...props} />);
  });
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find(candidate => candidate.textContent?.includes(text));
  if (!button) throw new Error(`Button containing "${text}" did not render`);
  return button;
}

describe('EditModeAnnouncementDialog', () => {
  afterEach(async () => {
    const mountedRoot = root;
    if (mountedRoot) await act(async () => mountedRoot.unmount());
    root = null;
    host?.remove();
    host = null;
    if (hasDom) document.body.replaceChildren();
  });

  test.skipIf(!hasDom)('renders as a labelled modal with both actions and accurate copy', async () => {
    await mountDialog();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.textContent).toContain('Edit code to suggest');
    expect(dialog?.textContent).toContain('off by default');
    expect(dialog?.textContent).toContain('never writes to your files on disk');
    expect(dialog?.textContent).toContain('One file at a time');
    expect(dialog?.textContent).toContain('Settings → Editor → Edit Code to Suggest');
    expect(buttonWithText('Turn it on')).toBeTruthy();
    expect(buttonWithText('Keep it off')).toBeTruthy();
  });

  test.skipIf(!hasDom)('shows the static placeholder while no demo recording is bundled', async () => {
    await mountDialog();

    expect(document.querySelector('[data-edit-mode-demo-placeholder]')).not.toBeNull();
    expect(document.querySelector('video')).toBeNull();
  });

  test.skipIf(!hasDom)('renders the demo video slot once a recording src is provided', async () => {
    await mountDialog({ demoVideoSrc: 'data:video/webm;base64,AAAA' });

    const video = document.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.getAttribute('src')).toBe('data:video/webm;base64,AAAA');
    expect(video?.hasAttribute('autoplay')).toBe(true);
    expect(video?.hasAttribute('loop')).toBe(true);
    expect(video?.hasAttribute('playsinline')).toBe(true);
    // React reflects muted via the property, not always the attribute.
    expect((video as HTMLVideoElement).muted).toBe(true);
    expect(document.querySelector('[data-edit-mode-demo-placeholder]')).toBeNull();
  });

  test.skipIf(!hasDom)('"Turn it on" fires onEnable and never onDismiss', async () => {
    const onEnable = mock(() => {});
    const onDismiss = mock(() => {});
    await mountDialog({ onEnable, onDismiss });

    expect(document.activeElement?.textContent).toContain('Turn it on');

    await act(async () => buttonWithText('Turn it on').click());

    expect(onEnable).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(document.querySelector('[data-edit-mode-announcement-dialog]')).toBeNull();
  });

  test.skipIf(!hasDom)('"Keep it off" dismisses without enabling', async () => {
    const onEnable = mock(() => {});
    const onDismiss = mock(() => {});
    await mountDialog({ onEnable, onDismiss });

    await act(async () => buttonWithText('Keep it off').click());

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onEnable).not.toHaveBeenCalled();
    expect(document.querySelector('[data-edit-mode-announcement-dialog]')).toBeNull();
  });

  test.skipIf(!hasDom)('Escape dismisses the dialog and restores prior focus', async () => {
    const priorButton = document.createElement('button');
    priorButton.textContent = 'Prior focus';
    document.body.appendChild(priorButton);
    priorButton.focus();
    const onEnable = mock(() => {});
    const onDismiss = mock(() => {});
    await mountDialog({ onEnable, onDismiss });

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onEnable).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(priorButton);
  });
});
