/**
 * Skill-reference keyboard state machine, against the REAL CommentPopover.
 *
 * This is where the trigger/keyboard defects hid: a bare `/` or `$` opening
 * the whole catalog and capturing Enter ("This costs $" + Enter must be a
 * newline, "cd /" + Tab must leave the field), and a missing isComposing
 * guard (IME candidate commits must never insert a skill). Covers: empty vs
 * non-empty query for Enter/Tab/Escape, composition, highlight bounding, and
 * the skillReferences={false} inertness of the human-only notice.
 *
 * DOM-gated (DOM_TESTS=1), same harness as Viewer.consumer.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import {
  fetchSkillCatalog,
  resetSkillCatalogCache,
  resetSkillCatalogTransport,
  setSkillCatalogTransport,
} from '../utils/skillCatalog';
import type { SkillCatalogEntry } from '../utils/skillReferences';

const hasDom = typeof document !== 'undefined';

// CommentPopover imports DOM-reading modules; load lazily so this file stays
// inert in the DOM-less default `bun test` run.
const popoverMod = hasDom ? await import('./CommentPopover') : null;
const CommentPopover =
  popoverMod?.CommentPopover as typeof import('./CommentPopover')['CommentPopover'];

const catalog: SkillCatalogEntry[] = [
  { name: 'animate', root: 'claude', description: 'Motion design', humanOnly: false },
  { name: 'annotate-helper', root: 'codex', humanOnly: false },
  { name: 'humanizer', root: 'universal', humanOnly: false },
  { name: 'plannotator-review', root: 'claude', humanOnly: true },
];

let root: Root | null = null;
let host: HTMLElement | null = null;
let closed = 0;

async function mountPopover(props: Partial<React.ComponentProps<typeof CommentPopover>> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  closed = 0;
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <CommentPopover
        anchorRect={new DOMRect(100, 100, 60, 20)}
        contextText="selected text"
        isGlobal={false}
        onSubmit={() => {}}
        onClose={() => {
          closed++;
        }}
        skillReferences
        {...props}
      />,
    );
  });
  // Flush the catalog fetch effect.
  await act(async () => {});
}

beforeEach(() => {
  if (!hasDom) return;
  resetSkillCatalogCache();
  setSkillCatalogTransport(async () => catalog);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  host?.remove();
  host = null;
  if (hasDom) document.body.innerHTML = '';
  resetSkillCatalogCache();
  resetSkillCatalogTransport();
});

function textarea(): HTMLTextAreaElement {
  const el = document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea');
  if (!el) throw new Error('CommentPopover textarea did not render');
  return el;
}

async function type(el: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(el),
    'value',
  )?.set;
  await act(async () => {
    if (setter) setter.call(el, value);
    else el.value = value;
    el.selectionStart = el.selectionEnd = value.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    // Real typing ends with a keyup; React's select plugin records the caret
    // from it (and fires onSelect). Without this, the NEXT keydown sees a
    // "changed" selection and re-fires onSelect with the stale DOM caret,
    // which no real keyboard sequence produces.
    el.dispatchEvent(
      new KeyboardEvent('keyup', { key: value.slice(-1) || 'a', bubbles: true }),
    );
  });
}

async function press(
  el: HTMLTextAreaElement,
  key: string,
  init: KeyboardEventInit = {},
): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    el.dispatchEvent(event);
  });
  return event;
}

function menu(): Element | null {
  return document.querySelector('[data-skill-menu]');
}

describe('CommentPopover skill references — keyboard state machine', () => {
  test.skipIf(!hasDom)('a bare $ never opens the menu; Enter stays a newline', async () => {
    await mountPopover();
    const el = textarea();
    await type(el, 'This costs $');
    expect(menu()).toBeNull();
    const enter = await press(el, 'Enter');
    expect(enter.defaultPrevented).toBe(false); // the newline goes through
    expect(el.value).toBe('This costs $'); // nothing inserted
  });

  test.skipIf(!hasDom)('a bare / never opens the menu; Tab stays a focus move', async () => {
    await mountPopover();
    const el = textarea();
    await type(el, 'cd /');
    expect(menu()).toBeNull();
    const tab = await press(el, 'Tab');
    expect(tab.defaultPrevented).toBe(false);
    expect(el.value).toBe('cd /');
  });

  test.skipIf(!hasDom)('a one-character query opens the menu and Enter inserts', async () => {
    await mountPopover();
    const el = textarea();
    await type(el, 'use /an');
    expect(menu()).not.toBeNull();
    const enter = await press(el, 'Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(el.value).toBe('use /animate ');
    expect(menu()).toBeNull();
  });

  test.skipIf(!hasDom)('Tab inserts too when the menu is open', async () => {
    await mountPopover();
    const el = textarea();
    await type(el, '$hum');
    expect(menu()).not.toBeNull();
    await press(el, 'Tab');
    expect(el.value).toBe('$humanizer ');
  });

  test.skipIf(!hasDom)('Enter during IME composition never inserts (candidate commit)', async () => {
    await mountPopover();
    const el = textarea();
    await type(el, 'use /an');
    expect(menu()).not.toBeNull();
    const enter = await press(el, 'Enter', { isComposing: true });
    expect(enter.defaultPrevented).toBe(false);
    expect(el.value).toBe('use /an'); // no skill inserted
    expect(menu()).not.toBeNull(); // menu untouched

    // Arrows mid-composition drive the IME candidate list, not the menu.
    const down = await press(el, 'ArrowDown', { isComposing: true });
    expect(down.defaultPrevented).toBe(false);
  });

  test.skipIf(!hasDom)('Escape dismisses the open menu without closing the composer', async () => {
    await mountPopover();
    const el = textarea();
    await type(el, '/an');
    expect(menu()).not.toBeNull();
    await press(el, 'Escape');
    expect(menu()).toBeNull();
    expect(closed).toBe(0);
    expect(document.querySelector('[data-comment-popover]')).not.toBeNull();

    // With the menu closed, Escape closes the composer as before.
    await press(el, 'Escape');
    expect(closed).toBe(1);
  });

  test.skipIf(!hasDom)('highlight stays on a real row as filtering shrinks the list', async () => {
    await mountPopover();
    const el = textarea();
    await type(el, '/ann'); // annotate-helper (prefix) + plannotator-review (substring)
    expect(document.querySelectorAll('[data-skill-item]').length).toBe(2);
    await press(el, 'ArrowDown'); // highlight row 1 (plannotator-review)
    await type(el, '/annotate'); // filters down to annotate-helper only
    expect(document.querySelectorAll('[data-skill-item]').length).toBe(1);
    await press(el, 'Enter'); // bounded back to row 0 — must not insert out of range
    expect(el.value).toBe('/annotate-helper ');
  });

  test.skipIf(!hasDom)('ArrowDown moves the highlight and Enter inserts that row', async () => {
    await mountPopover();
    const el = textarea();
    await type(el, '/ann');
    await press(el, 'ArrowDown'); // → plannotator-review
    await press(el, 'Enter');
    expect(el.value).toBe('/plannotator-review ');
  });

  test.skipIf(!hasDom)(
    'skillReferences={false} stays inert even with a warm catalog (no human-only notice)',
    async () => {
      await fetchSkillCatalog(); // warm the shared memory cache
      await mountPopover({
        skillReferences: false,
        initialText: 'use $plannotator-review please',
      });
      const el = textarea();
      expect(document.querySelector('[data-skill-human-only-notice]')).toBeNull();
      await type(el, 'use $plannotator-rev');
      expect(menu()).toBeNull();
    },
  );

  test.skipIf(!hasDom)('the human-only notice appears for opted-in surfaces', async () => {
    await mountPopover({ initialText: 'use $plannotator-review please' });
    expect(document.querySelector('[data-skill-human-only-notice]')).not.toBeNull();
  });
});
