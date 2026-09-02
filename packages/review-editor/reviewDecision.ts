import type { DecisionActionId, DecisionMenuItem, DecisionPrimary } from '@plannotator/ui/utils/decisionSpec';
import type { CompactReviewAction } from './components/ReviewHeaderMenu';

/**
 * Pure transport routing for the review (agent-mode) decision control.
 *
 * `buildDecisionSpec` decides WHAT the header offers; this module decides
 * WHERE each choice goes. Review is single-transport (spec §3.2/§6.1): every
 * decision POSTs `/api/feedback`, with `approved` as the only fork — notes
 * commit a `scope:'general'` CodeAnnotation and ride the change-request send,
 * the post-confirm discard is the same plain LGTM the Approve primary posts
 * (`handleApprove` already sends `annotations: []`). Kept pure (no React, no
 * App import) so the §8C handler-exhaustiveness test runs in the plain
 * `bun test` lane: every id the spec can emit must resolve here, and an id
 * added to `decisionSpec.ts` without a route fails the exhaustive switch.
 */
export type ReviewDecisionRoute =
  /** The adaptive primary: Approve at zero, Send Feedback otherwise. */
  | { kind: 'primary' }
  /** Commit the note as a scope:'general' CodeAnnotation, then submit on the
   *  next render (the payload builders close over `allAnnotations`). */
  | { kind: 'note' }
  /** Post-confirm discard: the plain LGTM approve (annotations dropped). */
  | { kind: 'discard' }
  /** Approve with the live feedback riding along. Capability-gated: the spec
   *  emits its ids only when `approvalNotesSupported`, which no review server
   *  advertises until PR5 (spec §6.4) — unreachable today. */
  | { kind: 'approve-with-notes' };

export function resolveReviewDecisionAction(id: DecisionActionId): ReviewDecisionRoute {
  switch (id) {
    case 'primary':
      return { kind: 'primary' };
    case 'request-changes':
    case 'note-with-feedback':
      // The two differ only by state (empty vs feedback), never by transport.
      return { kind: 'note' };
    case 'note-with-approval':
    case 'approve-with-notes':
      // Both approve-carrying items land on the same PR5 delivery path; until
      // the advert flips, neither id is ever emitted.
      return { kind: 'approve-with-notes' };
    case 'discard-and-finish':
      return { kind: 'discard' };
  }
}

/**
 * Compact/touch row ids for the spec-driven decision rows. Ids double as
 * React keys, so they must be unique within any one spec: the composers are
 * `note`, the change-request composer is `feedback` (it IS the change-request
 * send), approve-with-notes is `approve`, the confirm item `discard-finish`.
 */
export function compactRowIdForReviewDecisionItem(
  id: DecisionMenuItem['id'],
): Extract<CompactReviewAction['id'], 'note' | 'feedback' | 'approve' | 'discard-finish'> {
  switch (id) {
    case 'note-with-approval':
    case 'note-with-feedback':
      return 'note';
    case 'request-changes':
      return 'feedback';
    case 'approve-with-notes':
      return 'approve';
    case 'discard-and-finish':
      return 'discard-finish';
  }
}

/** The compact primary row id for the spec's primary (data, not copy: the
 *  send icon marks the Send Feedback state; check marks Approve). */
export function compactPrimaryIdForReviewDecision(
  primary: Pick<DecisionPrimary, 'icon'>,
): Extract<CompactReviewAction['id'], 'feedback' | 'approve'> {
  return primary.icon === 'send' ? 'feedback' : 'approve';
}
