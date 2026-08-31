import '../../test-setup/happy-dom';
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ImageAnnotator } from './index';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;

afterEach(async () => {
  if (!hasDom) return;
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe.if(hasDom)('ImageAnnotator shortcut ownership', () => {
  test('number keys in the image name input do not switch drawing tools', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <ImageAnnotator
          imageSrc="data:image/png;base64,"
          isOpen
          initialName="figure"
          onAccept={async () => {}}
          onClose={() => {}}
        />,
      );
    });

    const pen = host.querySelector<HTMLButtonElement>('button[title="Pen (1)"]');
    const arrow = host.querySelector<HTMLButtonElement>('button[title="Arrow (2)"]');
    const input = host.querySelector<HTMLInputElement>('input[placeholder="Image name..."]');
    if (!pen || !arrow || !input) throw new Error('Image annotator controls missing');
    expect(pen.className).toContain('bg-primary');

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true }));
    });
    expect(pen.className).toContain('bg-primary');
    expect(arrow.className).not.toContain('bg-primary');

    await act(async () => {
      host.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true }));
    });
    expect(arrow.className).toContain('bg-primary');
  });
});
