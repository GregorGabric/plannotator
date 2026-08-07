import React, { useEffect, useRef } from 'react';
import type { SkillCatalogEntry } from '../utils/skillReferences';

const ROOT_LABELS: Record<SkillCatalogEntry['root'], string> = {
  claude: 'claude',
  codex: 'codex',
  universal: 'agents',
};

interface SkillReferenceMenuProps {
  items: SkillCatalogEntry[];
  highlightIndex: number;
  onSelect: (index: number) => void;
  onHighlight: (index: number) => void;
}

/**
 * Dropdown for skill references inside a comment composer. Rendered above the
 * textarea (absolute within a relative wrapper). Human-invocation-only skills
 * stay listed and selectable but render dimmed with a badge, and highlighting
 * one surfaces a plain-language warning in the menu footer.
 */
export const SkillReferenceMenu: React.FC<SkillReferenceMenuProps> = ({
  items,
  highlightIndex,
  onSelect,
  onHighlight,
}) => {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    const row = list?.children[highlightIndex] as HTMLElement | undefined;
    row?.scrollIntoView({ block: 'nearest' });
  }, [highlightIndex]);

  const highlighted = items[highlightIndex];

  return (
    <div
      data-skill-menu="true"
      data-popover-layer="true"
      className="absolute bottom-full left-0 right-0 mb-1 z-[110] bg-popover border border-border rounded-lg shadow-xl overflow-hidden"
    >
      <div ref={listRef} className="max-h-48 overflow-y-auto py-1">
        {items.map((item, index) => (
          <button
            key={item.name}
            type="button"
            data-skill-item={item.name}
            // Insert on pointerdown so the textarea never loses focus.
            onPointerDown={(e) => {
              e.preventDefault();
              onSelect(index);
            }}
            // pointermove, not pointerenter: filtering makes rows shift under a
            // stationary cursor, and enter would steal the keyboard highlight.
            onPointerMove={() => onHighlight(index)}
            className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs ${
              index === highlightIndex ? 'bg-muted' : ''
            } ${item.humanOnly ? 'opacity-50' : ''}`}
          >
            <span className="font-mono text-foreground truncate">{item.name}</span>
            <span className="shrink-0 px-1 py-px rounded border border-border/60 text-[9px] uppercase tracking-wide text-muted-foreground">
              {ROOT_LABELS[item.root]}
            </span>
            {item.humanOnly && (
              <span className="shrink-0 px-1 py-px rounded border border-border/60 text-[9px] uppercase tracking-wide text-muted-foreground">
                human-only
              </span>
            )}
            {item.description && (
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {item.description}
              </span>
            )}
          </button>
        ))}
      </div>
      {highlighted?.humanOnly && (
        <div
          data-skill-menu-warning="true"
          className="px-2.5 py-1.5 border-t border-border/50 text-[11px] leading-snug text-amber-600 dark:text-amber-400"
        >
          This skill can only be run by a person. The agent that receives your
          feedback cannot invoke it, so referencing it will not make the agent
          run it. You can still insert it as context.
        </div>
      )}
      <div className="px-2.5 py-1 border-t border-border/50 text-[10px] text-muted-foreground">
        ↑↓ navigate · Enter insert · Esc dismiss
      </div>
    </div>
  );
};

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
