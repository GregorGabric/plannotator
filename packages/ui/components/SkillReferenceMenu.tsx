import React, { useEffect, useRef } from 'react';
import type { SkillCatalogEntry } from '../utils/skillReferences';

/** Which skill root a row came from, shown as the right-aligned source column. */
const ROOT_LABELS: Record<SkillCatalogEntry['root'], string> = {
  claude: 'Claude',
  codex: 'Codex',
  universal: 'Agents',
};

interface SkillReferenceMenuProps {
  items: SkillCatalogEntry[];
  /** Explicitly activated row, or null — the menu opens with nothing active. */
  activeIndex: number | null;
  onSelect: (index: number) => void;
}

/**
 * Dropdown for skill references inside a comment composer. Rendered above the
 * textarea (absolute within a relative wrapper). Each row: icon, bold name,
 * dimmed inline description (ellipsis-truncated), right-aligned source root.
 * Human-invocation-only skills stay listed and selectable but render dimmed
 * with a badge, and activating one surfaces a plain-language warning footer.
 *
 * Activation is KEYBOARD-ONLY (see useSkillReferenceAutocomplete): the menu
 * floats directly over the composer, exactly where the mouse rests while
 * typing, so pointer hover must never arm the "Enter inserts" state. Hover is
 * a purely visual affordance; a pointer click inserts directly.
 */
export const SkillReferenceMenu: React.FC<SkillReferenceMenuProps> = ({
  items,
  activeIndex,
  onSelect,
}) => {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeIndex === null) return;
    const list = listRef.current;
    const row = list?.children[activeIndex] as HTMLElement | undefined;
    row?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const active = activeIndex !== null ? items[activeIndex] : undefined;

  return (
    <div
      data-skill-menu="true"
      data-popover-layer="true"
      className="absolute bottom-full left-0 right-0 mb-1.5 z-[110] bg-popover border border-border rounded-xl shadow-2xl overflow-hidden"
    >
      <div ref={listRef} className="max-h-64 overflow-y-auto p-1.5 flex flex-col gap-px">
        {items.map((item, index) => (
          <button
            key={item.name}
            type="button"
            data-skill-item={item.name}
            data-skill-item-active={index === activeIndex ? 'true' : undefined}
            // Insert on pointerdown so the textarea never loses focus. A
            // click is explicit selection; hover deliberately does NOT
            // activate the row (see the component docblock).
            onPointerDown={(e) => {
              e.preventDefault();
              onSelect(index);
            }}
            className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-[13px] leading-snug transition-colors ${
              index === activeIndex ? 'bg-muted' : 'hover:bg-muted/50'
            } ${item.humanOnly ? 'opacity-60' : ''}`}
          >
            <SkillIcon />
            <span className="shrink-0 font-semibold text-foreground">{item.name}</span>
            {item.humanOnly && (
              <span className="shrink-0 px-1 py-px rounded border border-border/60 text-[9px] uppercase tracking-wide text-muted-foreground">
                human-only
              </span>
            )}
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {item.description ?? ''}
            </span>
            <span className="shrink-0 pl-3 text-xs text-muted-foreground/80">
              {ROOT_LABELS[item.root]}
            </span>
          </button>
        ))}
      </div>
      {active?.humanOnly && (
        <div
          data-skill-menu-warning="true"
          className="px-3 py-2 border-t border-border/50 text-[11px] leading-snug text-amber-600 dark:text-amber-400"
        >
          This skill can only be run by a person. The agent that receives your
          feedback cannot invoke it, so referencing it will not make the agent
          run it. You can still insert it as context.
        </div>
      )}
    </div>
  );
};

const SkillIcon: React.FC = () => (
  <svg
    className="w-4 h-4 shrink-0 text-muted-foreground"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.7}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
    <path d="M3.29 7 12 12l8.71-5" />
    <path d="M12 22V12" />
  </svg>
);

interface HumanOnlySkillNoticeProps {
  skills: SkillCatalogEntry[];
}

/** Persistent composer notice while human-only skill references are present. */
export const HumanOnlySkillNotice: React.FC<HumanOnlySkillNoticeProps> = ({ skills }) => {
  if (skills.length === 0) return null;
  const names = skills.map((s) => s.name).join(', ');
  return (
    <div
      data-skill-human-only-notice="true"
      className="mt-1 px-1 text-[11px] leading-snug text-amber-600 dark:text-amber-400"
    >
      {skills.length === 1 ? (
        <>
          <span className="font-mono">{names}</span> can only be run by a person. The
          agent cannot invoke it; it will be passed along as context only.
        </>
      ) : (
        <>
          <span className="font-mono">{names}</span> can only be run by a person. The
          agent cannot invoke them; they will be passed along as context only.
        </>
      )}
    </div>
  );
};
