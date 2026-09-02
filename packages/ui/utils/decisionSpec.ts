/**
 * Pure state→spec mapping for the unified header decision control.
 *
 * No React, no DOM, no imports — this is what keeps the state matrix testable
 * in the plain `bun test` lane and keeps "both apps and both states are data,
 * not forked components" true. `DecisionControl.tsx` renders whatever this
 * returns; the apps translate ids into handlers.
 *
 * NOT host-supported surface: like ActionMenu/ConfirmDialog, this module is
 * app-shared chrome and is deliberately absent from the README supported-import
 * list and the strict-consumer tsconfig.
 *
 * Labels, subtitles and confirm strings are the approved prototype's, verbatim
 * (DESIGN_final-proposal.html `spec()`), which is authoritative over any older
 * branch or mock copy.
 */

export type DecisionActionId =
  | 'primary'              // the left segment
  | 'note-with-approval'   // "Done with a note…" / "Approve with a note…"
  | 'request-changes'      // "Request changes…"
  | 'note-with-feedback'   // "Send with a note…"
  | 'approve-with-notes'   // review + gate-annotate; capability-gated
  | 'discard-and-finish';  // "Done/Approve, discard n annotations…"

export type DecisionTone = 'success' | 'primary' | 'destructive';

export interface DecisionPrimary {
  id: 'primary';
  label: string;            // 'Done' | 'Approve' | 'Send Feedback'
  shortLabel?: string;      // 'Send' — the lg-breakpoint label
  mobileLabel?: string;     // compact/touch row label
  title: string;            // tooltip / aria description
  tone: Exclude<DecisionTone, 'destructive'>;
  icon: 'check' | 'send';
  count?: number;           // rendered as the inline pill; omitted when 0
}

export interface DecisionComposer {
  title: string;            // popover back-button title, e.g. 'Send with a note'
  actionLabel: string;      // the composer's own button, e.g. 'Send feedback with note'
  tone: Exclude<DecisionTone, 'destructive'>;
  icon: 'check' | 'send';
  placeholder: string;      // 'Add a note...'
}

export interface DecisionConfirm {
  title: string;
  message: string;
  confirmText: string;
}

export interface DecisionMenuItem {
  id: Exclude<DecisionActionId, 'primary'>;
  label: string;
  subtitle: string;
  tone: DecisionTone;
  icon: 'check' | 'send';
  dividerBefore?: boolean;
  composer?: DecisionComposer;   // present ⇒ the item morphs the popover
  confirm?: DecisionConfirm;     // present ⇒ the item raises one confirm
}

export interface DecisionSpec {
  primary: DecisionPrimary;
  items: DecisionMenuItem[];
}

export interface DecisionSpecInput {
  app: 'annotate' | 'review';
  /** Annotate: `gate`. Review: always true — review's primary decision IS approval. */
  gate: boolean;
  /** The count rendered in the pill and interpolated into labels. */
  count: number;
  /**
   * Whether there is anything to send. Deliberately separate from `count`:
   * annotate counts direct edits / saved-file changes / attachments as
   * feedback with count 0 (`hasFeedbackContent` in the annotate app).
   */
  hasFeedback: boolean;
  /** Does the runtime deliver feedback on approve? Gates every approve-carrying item. */
  approvalNotesSupported: boolean;
  /**
   * M1 ruling: the session's feedback was already delivered through the
   * annotate agent terminal, which is why `hasFeedback` reads false. The
   * empty-flip state keeps its `Done` primary AND its transport (the outer
   * agent's stdout consumer may never have seen the terminal delivery, so
   * the full payload still posts) — only the copy changes, because "reviewed
   * with no feedback" would be a lie in that state. Copy is free prose,
   * NOT frozen.
   */
  feedbackDelivered?: boolean;
}

export const DECISION_NOTE_PLACEHOLDER = 'Add a note...';

function annotationNoun(count: number): string {
  return count === 1 ? 'annotation' : 'annotations';
}

/**
 * The empty state: no feedback to send, the primary is the positive finish.
 * `approvalFlow` (gate annotate, or review) makes it `Approve`; plain annotate
 * gets `Done`.
 */
function buildEmptySpec(input: DecisionSpecInput, approvalFlow: boolean): DecisionSpec {
  // "Done with a note…" posts /api/feedback like every other non-gated annotate
  // outcome, so it is never capability-gated. "Approve with a note…" carries a
  // note on the approve channel, which four runtimes still discard — it renders
  // only where the advert says delivery works (never an item that silently
  // drops content).
  const positive: DecisionMenuItem | null = approvalFlow
    ? input.approvalNotesSupported
      ? {
          id: 'note-with-approval',
          label: 'Approve with a note…',
          subtitle: 'Approve and send a short note with it',
          tone: 'success',
          icon: 'check',
          composer: {
            title: 'Approve with a note',
            actionLabel: 'Approve — send note',
            tone: 'success',
            icon: 'check',
            placeholder: DECISION_NOTE_PLACEHOLDER,
          },
        }
      : null
    : {
        id: 'note-with-approval',
        label: 'Done with a note…',
        // M1 ruling: with feedback already delivered via the agent terminal
        // this is no longer "the approval" — the note rides the session
        // record. Free prose, NOT frozen.
        subtitle: input.feedbackDelivered
          ? 'Finish and send a short note with the session record'
          : 'Finish and send a short note with the approval',
        tone: 'success',
        icon: 'check',
        composer: {
          title: 'Done with a note',
          actionLabel: 'Done — send note',
          tone: 'success',
          icon: 'check',
          placeholder: DECISION_NOTE_PLACEHOLDER,
        },
      };

  const requestChanges: DecisionMenuItem = {
    id: 'request-changes',
    // Frozen copy (maintainer-approved): 'Request changes…'.
    label: 'Request changes…',
    subtitle: 'Write overall feedback — sent as a change request',
    tone: 'primary',
    icon: 'send',
    dividerBefore: positive !== null,
    composer: {
      title: 'Request changes',
      actionLabel: 'Send as feedback',
      tone: 'primary',
      icon: 'send',
      placeholder: DECISION_NOTE_PLACEHOLDER,
    },
  };

  return {
    primary: approvalFlow
      ? {
          id: 'primary',
          // Frozen copy (maintainer-approved): 'Approve'.
          label: 'Approve',
          title: 'Approve — no changes requested',
          tone: 'success',
          icon: 'check',
        }
      : {
          id: 'primary',
          // Frozen copy (maintainer-approved): 'Done'.
          label: 'Done',
          // M1 ruling: in the agent-terminal delivered state the transport is
          // unchanged (the full payload still posts, because the outer agent
          // on stdout may never have seen the terminal delivery), so the
          // tooltip must not claim "no feedback". Free prose, NOT frozen.
          title: input.feedbackDelivered
            ? 'Finish — sends the session record (feedback already shared in the terminal)'
            : 'Finish — records that you reviewed with no feedback',
          tone: 'success',
          icon: 'check',
        },
    items: positive ? [positive, requestChanges] : [requestChanges],
  };
}

/**
 * The feedback state: something to send, the primary is `Send Feedback`.
 * Identical across apps; only the discard item's verb follows the flow.
 */
function buildFeedbackSpec(input: DecisionSpecInput, approvalFlow: boolean): DecisionSpec {
  const { count } = input;
  const noun = annotationNoun(count);

  const items: DecisionMenuItem[] = [
    {
      id: 'note-with-feedback',
      label: 'Send with a note…',
      subtitle:
        count > 0
          ? `Add an overall note on top of your ${count} ${noun}`
          : 'Add an overall note on top of your feedback',
      tone: 'primary',
      icon: 'send',
      composer: {
        title: 'Send with a note',
        actionLabel: 'Send feedback with note',
        tone: 'primary',
        icon: 'send',
        placeholder: DECISION_NOTE_PLACEHOLDER,
      },
    },
  ];

  // The divider separates "send" alternates from "approve away" alternates —
  // it sits before whichever approve-flavoured item comes first.
  let dividerPending = true;

  // Capability-gated only (F2 ruling, maintainer default pending final
  // confirmation): at count 0 the feedback is direct edits / saved-file
  // changes / attachments, and a capable approve transport delivers those too,
  // so the item stays offered with zero-form copy — no "0 annotations"
  // language. Subtitles are free prose, NOT frozen.
  if (approvalFlow && input.approvalNotesSupported) {
    items.push({
      id: 'approve-with-notes',
      // Frozen copy (maintainer-approved): 'Approve with notes'.
      label: 'Approve with notes',
      subtitle:
        count > 0
          ? `Approve; your ${count} ${noun} ride along as non-blocking guidance`
          : 'Approve; your edits and attachments ride along as non-blocking guidance',
      tone: 'success',
      icon: 'check',
      dividerBefore: dividerPending,
    });
    dividerPending = false;
  }

  // Destructive by definition — it throws the annotations away — so it always
  // carries the one confirm the new model keeps. With count 0 there is nothing
  // to discard and the item is omitted.
  if (count > 0) {
    items.push({
      id: 'discard-and-finish',
      label: approvalFlow
        ? `Approve, discard ${count} ${noun}…`
        : `Done, discard ${count} ${noun}…`,
      subtitle: 'Asks to confirm — the annotations are not sent',
      tone: 'destructive',
      icon: 'check',
      dividerBefore: dividerPending,
      // L5: neutral wording — the count can include findings from other
      // tools, and the non-gate record still carries any direct edits.
      // Free prose, NOT frozen.
      confirm: approvalFlow
        ? {
            title: `Discard ${count} ${noun} and approve?`,
            message:
              'These annotations are change requests, including any from other tools. Approving without them tells the agent no changes are needed.',
            // Frozen copy (maintainer-approved): 'Discard & approve'.
            confirmText: 'Discard & approve',
          }
        : {
            title: `Discard ${count} ${noun} and finish?`,
            message:
              'These annotations are change requests, including any from other tools. Finishing without them sends a positive review record; any direct edits still ride along.',
            // Frozen copy (maintainer-approved): 'Discard & finish'.
            confirmText: 'Discard & finish',
          },
    });
  }

  return {
    primary: {
      id: 'primary',
      // Frozen copy (maintainer-approved): 'Send Feedback'.
      label: 'Send Feedback',
      shortLabel: 'Send',
      mobileLabel: 'Send feedback',
      title: 'Send your feedback to the agent',
      tone: 'primary',
      icon: 'send',
      count: count > 0 ? count : undefined,
    },
    items,
  };
}

export function buildDecisionSpec(input: DecisionSpecInput): DecisionSpec {
  // Review's primary positive decision IS approval, gate flag or not.
  const approvalFlow = input.app === 'review' || input.gate;
  return input.hasFeedback
    ? buildFeedbackSpec(input, approvalFlow)
    : buildEmptySpec(input, approvalFlow);
}
