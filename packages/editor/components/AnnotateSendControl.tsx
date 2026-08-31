import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FeedbackButton } from '@plannotator/ui/components/ToolbarButtons';

/**
 * One-step "send with a note" for the annotate surfaces.
 *
 * The note itself is not owned here: App creates it as a GLOBAL_COMMENT at
 * submit time so it rides `exportAnnotations` and the `/api/feedback`
 * annotations array with no server change. This component only owns the
 * affordance — the split Send control, its one-line field, and the typed text
 * (deliberately local, so a keystroke never re-renders the whole header).
 */
export interface AnnotateSubmitNoteControl {
  /** Submit this note together with any annotations already in the session. */
  onSubmit: (text: string) => void;
}

export const ANNOTATE_NOTE_PLACEHOLDER = 'Add a note...';

interface AnnotateNoteComposerProps {
  text: string;
  onTextChange: (value: string) => void;
  onSubmit: (text: string) => void;
  onClose: () => void;
  disabled?: boolean;
  /** `anchored` hangs under the header's Send control; `sheet` is the compact
   *  touch review surface, where there is no header control to hang from. */
  variant?: 'anchored' | 'sheet';
  /** Hint under the field, e.g. what the note will be sent alongside. */
  hint?: string;
  /** Anchored fields open in response to a click and take focus. The compact
   *  sheet is always expanded, so focusing it would raise the touch keyboard
   *  every time the Review surface opens. */
  autoFocus?: boolean;
}

/** The one-line note field plus its send action. Controlled: the owner keeps
 *  the text so closing and reopening does not discard a half-typed note. */
export const AnnotateNoteComposer: React.FC<AnnotateNoteComposerProps> = ({
  text,
  onTextChange,
  onSubmit,
  onClose,
  disabled = false,
  variant = 'anchored',
  hint,
  autoFocus = variant === 'anchored',
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const canSend = text.trim().length > 0;

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        // Stop here: the surrounding surfaces (the HTML pinpoint ladder,
        // popovers, the plan-diff exit) all treat a bare Escape as theirs.
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        // The field is one line, so Enter has no other job. Mod+Enter also
        // lands here rather than reaching the window-level submit shortcut,
        // which deliberately ignores text fields.
        event.preventDefault();
        event.stopPropagation();
        if (!disabled && canSend) onSubmit(text);
      }
    },
    [canSend, disabled, onClose, onSubmit, text],
  );

  return (
    <div
      data-annotate-note-composer={variant}
      className={
        variant === 'anchored'
          ? 'absolute right-0 top-full z-50 mt-2 w-80 rounded-lg border border-border bg-popover p-2 shadow-xl'
          : 'rounded-xl border border-border bg-background/40 p-2'
      }
    >
      <div className="flex items-center gap-1.5">
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={ANNOTATE_NOTE_PLACEHOLDER}
          aria-label={ANNOTATE_NOTE_PLACEHOLDER}
          data-annotate-note-input="true"
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        />
        <button
          type="button"
          data-annotate-note-send="true"
          onClick={() => onSubmit(text)}
          disabled={disabled || !canSend}
          title="Send"
          className="flex-shrink-0 rounded-md bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
        >
          Send
        </button>
      </div>
      <p className="mt-1.5 px-0.5 text-[11px] leading-snug text-muted-foreground">
        {hint ?? 'Enter to send, Esc to close.'}
      </p>
    </div>
  );
};

/** The compact touch review surface's always-expanded note field. Owns its own
 *  text so `CompactPlanReview` stays a presentational list. */
export const AnnotateNoteSheet: React.FC<{
  note: AnnotateSubmitNoteControl;
  disabled?: boolean;
  hint?: string;
}> = ({ note, disabled = false, hint }) => {
  const [text, setText] = useState('');
  return (
    <AnnotateNoteComposer
      text={text}
      onTextChange={setText}
      onSubmit={note.onSubmit}
      onClose={() => setText('')}
      disabled={disabled}
      variant="sheet"
      hint={hint}
      autoFocus={false}
    />
  );
};

interface AnnotateSendControlProps {
  /** True when the session already carries annotations or document edits.
   *  False flips the primary action into the zero-annotation fast path. */
  hasFeedback: boolean;
  disabled?: boolean;
  isLoading?: boolean;
  /** The incumbent Send Feedback action. Unchanged when feedback exists. */
  onSend: () => void;
  note: AnnotateSubmitNoteControl;
}

/**
 * Split Send control for annotate sessions.
 *
 * With feedback present the primary button is the incumbent Send Feedback,
 * unchanged; the caret opens a note that is sent WITH it in one action.
 * With no feedback the primary button opens the note field directly — sending
 * nothing was never useful, which is why the incumbent header hid the button
 * entirely in that state.
 */
export const AnnotateSendControl: React.FC<AnnotateSendControlProps> = ({
  hasFeedback,
  disabled = false,
  isLoading = false,
  onSend,
  note,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  const submit = useCallback(
    (value: string) => {
      setOpen(false);
      setText('');
      note.onSubmit(value);
    },
    [note],
  );

  return (
    <div ref={containerRef} className="relative flex items-center gap-1">
      <FeedbackButton
        onClick={hasFeedback ? onSend : () => setOpen(true)}
        disabled={disabled}
        isLoading={isLoading}
        label="Send Feedback"
        title={hasFeedback ? 'Send Feedback' : 'Send Feedback: write a quick note'}
      />
      <button
        type="button"
        data-annotate-note-toggle="true"
        aria-expanded={open}
        aria-label="Send with a note"
        title="Send with a note"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        className={`flex h-7 w-6 flex-shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 ${
          open ? 'bg-muted text-foreground' : ''
        }`}
      >
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <AnnotateNoteComposer
          text={text}
          onTextChange={setText}
          onSubmit={submit}
          onClose={close}
          disabled={disabled}
          hint={
            hasFeedback
              ? 'Sent with your annotations. Enter to send, Esc to close.'
              : 'Enter to send, Esc to close.'
          }
        />
      )}
    </div>
  );
};
