import '../test-setup/happy-dom';
import { describe, expect, it } from 'bun:test';
import { dispatchShortcutEvent, historyShortcuts, imageAnnotatorShortcuts } from '../shortcuts';
import { hasActiveHistoryOverlay, isNativeHistoryOwner } from './undoHistory';

const hasDom = typeof document !== 'undefined';

function keyboardEvent(target: Element, options: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  return event;
}

function nativeOwner(target: Element): boolean {
  let ownsHistory = false;
  target.addEventListener('keydown', (event) => {
    if (event instanceof KeyboardEvent) ownsHistory = isNativeHistoryOwner(event);
  }, { once: true });
  keyboardEvent(target, { key: 'z', ctrlKey: true });
  return ownsHistory;
}

describe('undo shortcut ownership', () => {
  it.skipIf(!hasDom)('leaves native and shadow-DOM text history alone', () => {
    const input = document.createElement('input');
    document.body.append(input);
    expect(nativeOwner(input)).toBe(true);

    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    document.body.append(editable);
    expect(nativeOwner(editable)).toBe(true);

    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const codeMirror = document.createElement('div');
    codeMirror.className = 'cm-editor';
    const textarea = document.createElement('textarea');
    codeMirror.append(textarea);
    shadow.append(codeMirror);
    document.body.append(host);
    expect(nativeOwner(textarea)).toBe(true);
  });

  it.skipIf(!hasDom)('dispatches redo before undo and only prevents handled shortcuts', () => {
    const button = document.createElement('button');
    document.body.append(button);
    const calls: string[] = [];
    const redoEvent = keyboardEvent(button, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(dispatchShortcutEvent(historyShortcuts, {
      undo: { when: () => false, handle: () => calls.push('undo') },
      redo: () => calls.push('redo'),
    }, redoEvent)).toBe(true);
    expect(calls).toEqual(['redo']);
    expect(redoEvent.defaultPrevented).toBe(true);

    const nativeEvent = keyboardEvent(button, { key: 'z', ctrlKey: true });
    expect(dispatchShortcutEvent(historyShortcuts, {
      undo: { when: () => false, handle: () => calls.push('undo') },
    }, nativeEvent)).toBe(false);
    expect(nativeEvent.defaultPrevented).toBe(false);
  });

  it.skipIf(!hasDom)('lets the active image tool win the intentionally shared binding', () => {
    const button = document.createElement('button');
    const event = keyboardEvent(button, { key: 'z', ctrlKey: true });
    const calls: string[] = [];
    expect(dispatchShortcutEvent(historyShortcuts, {
      undo: { when: () => false, handle: () => calls.push('document') },
    }, event)).toBe(false);
    expect(dispatchShortcutEvent(imageAnnotatorShortcuts, {
      undo: () => calls.push('image'),
    }, event)).toBe(true);
    expect(calls).toEqual(['image']);
  });

  it.skipIf(!hasDom)('detects dialogs, composers, and focused source editors', () => {
    const root = document.createElement('div');
    document.body.append(root);
    expect(hasActiveHistoryOverlay(root)).toBe(false);
    for (const markup of [
      '<div role="dialog"></div>',
      '<div data-comment-popover="true"></div>',
      '<div class="cm-editor cm-focused"></div>',
    ]) {
      root.innerHTML = markup;
      expect(hasActiveHistoryOverlay(root)).toBe(true);
    }
  });
});
