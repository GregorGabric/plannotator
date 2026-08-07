import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import {
  extractSkillReferences,
  filterSkillCatalog,
  findSkillTrigger,
  insertSkillReference,
  type SkillCatalogEntry,
  type SkillTriggerContext,
} from '../utils/skillReferences';
import { fetchSkillCatalog, getCachedSkillCatalog } from '../utils/skillCatalog';

export interface SkillReferenceMenuState {
  items: SkillCatalogEntry[];
  highlightIndex: number;
  query: string;
}

export interface UseSkillReferenceAutocompleteResult {
  /** Open menu state, or null. Render SkillReferenceMenu from this. */
  menu: SkillReferenceMenuState | null;
  /** Call FIRST in the textarea's onKeyDown; true means the event was consumed. */
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Call from the textarea's onSelect (fires on every caret move + input). */
  onSelect: () => void;
  /** Insert the given menu item at the active trigger. */
  select: (index: number) => void;
  /** Move the highlighted row (mouse hover). */
  setHighlightIndex: (index: number) => void;
  /** Human-only skills currently referenced in the text (drives the composer warning). */
  humanOnlyReferences: SkillCatalogEntry[];
}

/**
 * Skill-reference autocomplete for a comment textarea. Typing `/` or `$` at
 * the start of a word opens a menu of the user's global agent skills; the
 * catalog is fetched lazily (memory-cached, never persisted). With no catalog
 * (endpoint absent, discovery failed, no skills installed) every path here is
 * inert and the textarea behaves exactly as before.
 */
export function useSkillReferenceAutocomplete(options: {
  text: string;
  setText: (text: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  enabled: boolean;
}): UseSkillReferenceAutocompleteResult {
  const { text, setText, textareaRef, enabled } = options;
  const [catalog, setCatalog] = useState<SkillCatalogEntry[]>(getCachedSkillCatalog);
  const [caret, setCaret] = useState<number | null>(null);
  const [highlightIndex, setHighlightIndex] = useState(0);
  // Escape dismisses the menu for the trigger it was open on; the same trigger
  // does not reopen until the user leaves it (new trigger start clears this).
  const [dismissedStart, setDismissedStart] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchSkillCatalog().then((skills) => {
      if (!cancelled) setCatalog(skills);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const trigger: SkillTriggerContext | null = useMemo(() => {
    if (!enabled || catalog.length === 0 || caret === null) return null;
    return findSkillTrigger(text, caret);
  }, [enabled, catalog, text, caret]);

  const items = useMemo(
    () => (trigger ? filterSkillCatalog(catalog, trigger.query) : []),
    [catalog, trigger],
  );

  const open = trigger !== null && items.length > 0 && trigger.start !== dismissedStart;

  // Track the trigger start to reset highlight + dismissal when it changes.
  const lastTriggerStart = useRef<number | null>(null);
  useEffect(() => {
    const start = trigger?.start ?? null;
    if (start !== lastTriggerStart.current) {
      lastTriggerStart.current = start;
      setHighlightIndex(0);
      setDismissedStart(null);
    }
  }, [trigger]);

  // Keep the highlight on a real row as filtering shrinks the list.
  const boundedHighlight = items.length === 0 ? 0 : Math.min(highlightIndex, items.length - 1);

  const readCaret = useCallback(() => {
    const el = textareaRef.current;
    setCaret(el ? el.selectionStart : null);
  }, [textareaRef]);

  const select = useCallback(
    (index: number) => {
      const el = textareaRef.current;
      if (!trigger || !el) return;
      const item = items[index];
      if (!item) return;
      const result = insertSkillReference(text, el.selectionStart, trigger, item);
      setText(result.text);
      setCaret(result.caret);
      // Restore focus + caret after React commits the new value.
      setTimeout(() => {
        if (!el.isConnected) return;
        el.focus();
        el.setSelectionRange(result.caret, result.caret);
      }, 0);
    },
    [items, setText, text, textareaRef, trigger],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open) return false;
      if (e.metaKey || e.ctrlKey || e.altKey) return false;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setHighlightIndex((boundedHighlight + 1) % items.length);
          return true;
        case 'ArrowUp':
          e.preventDefault();
          setHighlightIndex((boundedHighlight - 1 + items.length) % items.length);
          return true;
        case 'Enter':
        case 'Tab':
          e.preventDefault();
          select(boundedHighlight);
          return true;
        case 'Escape':
          e.preventDefault();
          e.stopPropagation();
          if (trigger) setDismissedStart(trigger.start);
          return true;
        default:
          return false;
      }
    },
    [boundedHighlight, items.length, open, select, trigger],
  );

  const humanOnlyReferences = useMemo(
    () => extractSkillReferences(text, catalog).filter((s) => s.humanOnly),
    [text, catalog],
  );

  return {
    menu: open ? { items, highlightIndex: boundedHighlight, query: trigger.query } : null,
    onKeyDown,
    onSelect: readCaret,
    select,
    setHighlightIndex,
    humanOnlyReferences,
  };
}
