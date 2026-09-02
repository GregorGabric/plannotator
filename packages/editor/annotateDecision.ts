import type { DecisionActionId, DecisionMenuItem, DecisionPrimary } from "@plannotator/ui/utils/decisionSpec";
import type { CompactPlanAction } from "@plannotator/ui/components/PlanHeaderMenu";

/**
 * Pure transport routing for the annotate decision control.
 *
 * `buildDecisionSpec` decides WHAT the header offers; this module decides
 * WHERE each choice goes, on the two legacy transports and nothing else
 * (spec §3.1/§6.1): `Done` and every note stay on `/api/feedback` so
 * `formatAnnotateOutcome` shapes and strict-gate exit codes are untouched,
 * and only gate-mode approvals reach `/api/approve`. Kept pure (no React,
 * no App import) so the §8C handler-exhaustiveness test runs in the plain
 * `bun test` lane: every id the spec can emit must resolve here, and an id
 * added to `decisionSpec.ts` without a route fails the exhaustive switch.
 */
export type AnnotateDecisionRoute =
  | { kind: "primary" }
  /** Commit the note as a GLOBAL_COMMENT, then submit on the next render
   *  (#1436 mechanism). `route` picks the endpoint; `approvalFraming` marks
   *  the non-gated positive finish ("Done with a note…"). */
  | { kind: "note"; route: "feedback" | "approve"; approvalFraming: boolean }
  /** Direct approve with the live feedback riding along (gate + capability). */
  | { kind: "approve-with-notes" }
  /** Post-confirm discard: annotations dropped, positive finish recorded. */
  | { kind: "discard"; route: "feedback" | "approve" };

export function resolveAnnotateDecisionAction(
  id: DecisionActionId,
  ctx: { gate: boolean },
): AnnotateDecisionRoute {
  switch (id) {
    case "primary":
      return { kind: "primary" };
    case "note-with-approval":
      // Gate: the note rides the approval body (/api/approve). Non-gate has
      // no approve channel, so "Done with a note…" posts /api/feedback with
      // the approval-framing sentence — the only place a menu choice changes
      // payload text rather than endpoint (spec §3.1 "framing").
      return ctx.gate
        ? { kind: "note", route: "approve", approvalFraming: false }
        : { kind: "note", route: "feedback", approvalFraming: true };
    case "request-changes":
    case "note-with-feedback":
      // The two differ only by state (empty vs feedback), never by transport.
      return { kind: "note", route: "feedback", approvalFraming: false };
    case "approve-with-notes":
      return { kind: "approve-with-notes" };
    case "discard-and-finish":
      return ctx.gate
        ? { kind: "discard", route: "approve" }
        : { kind: "discard", route: "feedback" };
  }
}

/**
 * Compact/touch row ids for the spec-driven decision rows. Ids double as
 * React keys and the primary-row sort key, so they must be unique within any
 * one spec: the positive-finish composer is `note`, the change-request
 * composer is `feedback` (it IS the change-request send), approve-with-notes
 * is `approve`, and the confirm item is `discard-finish`.
 */
export function compactRowIdForDecisionItem(
  id: DecisionMenuItem["id"],
): Extract<CompactPlanAction["id"], "note" | "feedback" | "approve" | "discard-finish"> {
  switch (id) {
    case "note-with-approval":
    case "note-with-feedback":
      return "note";
    case "request-changes":
      return "feedback";
    case "approve-with-notes":
      return "approve";
    case "discard-and-finish":
      return "discard-finish";
  }
}

/** The compact primary row id for the spec's primary (data, not copy: the
 *  send icon marks the Send Feedback state; check marks Done/Approve). */
export function compactPrimaryIdForDecision(
  primary: Pick<DecisionPrimary, "icon">,
): Extract<CompactPlanAction["id"], "feedback" | "approve"> {
  return primary.icon === "send" ? "feedback" : "approve";
}
