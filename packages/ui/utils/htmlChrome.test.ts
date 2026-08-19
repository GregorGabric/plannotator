/**
 * Sidebar/panel persistence for raw-HTML annotate sessions (DOM-gated).
 *
 * Contract under test: the default HTML session opens with both side surfaces
 * closed; an explicit change the user makes persists across a fresh mount,
 * but only while the record stays fresh: state older than the staleness TTL
 * (or a legacy record with no timestamp) expires back to the defaults. An
 * old cookie's `toolsHidden` field (the removed "Hide tools" toggle) is
 * ignored — a stale record must never resurrect hidden chrome.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend, type StorageBackend } from './storage';
import { STALE_PREFERENCE_TTL_MS } from './preferenceTtl';

const hasDom = typeof document !== 'undefined';
const htmlChromeModule = hasDom ? await import('./htmlChrome') : null;

// In-memory storage so tests don't depend on happy-dom cookie semantics
// (the codebase-standard pattern for persistence tests).
const memory = new Map<string, string>();
const memoryBackend: StorageBackend = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
};

beforeEach(() => {
  if (!hasDom) return;
  memory.clear();
  setStorageBackend(memoryBackend);
});

afterAll(() => {
  resetStorageBackend();
});

const DEFAULTS = { sidebarOpen: false, panelOpen: false };
const NOW = 1_800_000_000_000;
const stamp = (state: object, age = 0) => JSON.stringify({ ...state, savedAt: NOW - age });

describe.if(hasDom)('resolveHtmlChromeState (pure)', () => {
  test('first run (nothing saved): both side surfaces closed', () => {
    expect(htmlChromeModule!.resolveHtmlChromeState(null, NOW)).toEqual(DEFAULTS);
  });

  test('malformed cookie values fall back to the defaults', () => {
    expect(htmlChromeModule!.resolveHtmlChromeState('not-json', NOW)).toEqual(DEFAULTS);
    expect(htmlChromeModule!.resolveHtmlChromeState('"just-a-string"', NOW)).toEqual(DEFAULTS);
    expect(htmlChromeModule!.resolveHtmlChromeState(stamp({ sidebarOpen: 'yes' }), NOW)).toEqual(DEFAULTS);
  });

  test('a fresh record wins; partial state merges over the defaults', () => {
    expect(htmlChromeModule!.resolveHtmlChromeState(stamp({ sidebarOpen: true }), NOW)).toEqual({
      sidebarOpen: true,
      panelOpen: false,
    });
    expect(
      htmlChromeModule!.resolveHtmlChromeState(stamp({ panelOpen: true }), NOW),
    ).toEqual({ sidebarOpen: false, panelOpen: true });
  });

  test('an old record carrying the removed toolsHidden flag is read tolerantly: the flag is ignored, the rest applies', () => {
    // Pre-simplification cookies persisted `toolsHidden: true` ("Hide tools").
    // The toggle is gone, so the flag must not leak into the resolved state
    // or reject the record — the user's sidebar/panel memory still applies.
    expect(
      htmlChromeModule!.resolveHtmlChromeState(
        stamp({ toolsHidden: true, sidebarOpen: true, panelOpen: true }),
        NOW,
      ),
    ).toEqual({ sidebarOpen: true, panelOpen: true });
  });

  test('a record older than the TTL expires back to the defaults', () => {
    const stale = stamp({ sidebarOpen: true, panelOpen: true }, STALE_PREFERENCE_TTL_MS + 1);
    expect(htmlChromeModule!.resolveHtmlChromeState(stale, NOW)).toEqual(DEFAULTS);
    const inside = stamp({ sidebarOpen: true, panelOpen: true }, STALE_PREFERENCE_TTL_MS - 1);
    expect(htmlChromeModule!.resolveHtmlChromeState(inside, NOW)).toEqual({
      sidebarOpen: true,
      panelOpen: true,
    });
  });

  test('a legacy record without a timestamp is treated as expired', () => {
    expect(
      htmlChromeModule!.resolveHtmlChromeState('{"sidebarOpen":true,"panelOpen":true}', NOW),
    ).toEqual(DEFAULTS);
  });
});

describe.if(hasDom)('getHtmlChromeState / saveHtmlChromeState (cookie round trip)', () => {
  test('first run reads the defaults', () => {
    expect(htmlChromeModule!.getHtmlChromeState()).toEqual(DEFAULTS);
  });

  test('a "user opened surfaces" state persists across a fresh mount', () => {
    // Session 1: user opens the sidebar and the drawer, then leaves.
    htmlChromeModule!.saveHtmlChromeState({ sidebarOpen: true, panelOpen: true });
    // Session 2 (fresh mount, same cookies): opens exactly as left.
    expect(htmlChromeModule!.getHtmlChromeState()).toEqual({
      sidebarOpen: true,
      panelOpen: true,
    });
  });

  test('a "user re-closed everything" state persists too', () => {
    htmlChromeModule!.saveHtmlChromeState({ sidebarOpen: true, panelOpen: true });
    htmlChromeModule!.saveHtmlChromeState({ sidebarOpen: false, panelOpen: false });
    expect(htmlChromeModule!.getHtmlChromeState()).toEqual(DEFAULTS);
  });
});
