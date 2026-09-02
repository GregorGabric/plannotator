/**
 * Handler exhaustiveness for the review (agent-mode) decision wiring
 * (spec §8C, pure lane — cannot silently skip).
 *
 * Neither app package is typechecked (spec §9), so the contract "every id the
 * spec can emit has a route" is enforced here at runtime: an id added to
 * `decisionSpec.ts` without a branch in `resolveReviewDecisionAction` (or the
 * compact row mapper) returns `undefined` and fails these sweeps.
 */
import { describe, expect, test } from "bun:test";
import {
  buildDecisionSpec,
  type DecisionSpecInput,
} from "@plannotator/ui/utils/decisionSpec";
import {
  compactPrimaryIdForReviewDecision,
  compactRowIdForReviewDecisionItem,
  resolveReviewDecisionAction,
} from "./reviewDecision";

/** Every input combination the review app can hand the spec builder. The
 *  advert is swept both ways even though PR3 hardcodes it false, so the PR5
 *  flip cannot surface an unrouted id. */
function reviewInputs(): DecisionSpecInput[] {
  const inputs: DecisionSpecInput[] = [];
  for (const approvalNotesSupported of [false, true])
    for (const count of [0, 1, 3])
      inputs.push({
        app: "review",
        gate: true,
        count,
        hasFeedback: count > 0,
        approvalNotesSupported,
      });
  return inputs;
}

describe("review decision handler exhaustiveness", () => {
  // Guards a menu item with no handler — the failure mode the missing app
  // typecheck would otherwise catch.
  test("every id the spec can emit resolves to a route", () => {
    for (const input of reviewInputs()) {
      const spec = buildDecisionSpec(input);
      expect(resolveReviewDecisionAction("primary")).toBeDefined();
      for (const item of spec.items) {
        const route = resolveReviewDecisionAction(item.id);
        expect(route).toBeDefined();
        // A composer item routed anywhere but a note-carrying flow would drop
        // the typed note on the floor; a confirm item must be the discard
        // flow (the one remaining guard dialog).
        if (item.composer) {
          expect(["note", "approve-with-notes"]).toContain(route.kind);
        }
        if (item.confirm) expect(route.kind).toBe("discard");
      }
    }
  });

  // Guards the single-transport matrix (spec §3.2/§6.1): request-changes and
  // note-with-feedback differ only by state, never by route, and the
  // approve-carrying ids stay on the capability-gated PR5 path — routing one
  // to the plain-note flow would misdeliver an approval as a change request.
  test("the routes fork only on approved, never on which menu state emitted them", () => {
    expect(resolveReviewDecisionAction("request-changes")).toEqual({ kind: "note" });
    expect(resolveReviewDecisionAction("note-with-feedback"))
      .toEqual(resolveReviewDecisionAction("request-changes"));
    expect(resolveReviewDecisionAction("discard-and-finish")).toEqual({ kind: "discard" });
    expect(resolveReviewDecisionAction("note-with-approval")).toEqual({ kind: "approve-with-notes" });
    expect(resolveReviewDecisionAction("approve-with-notes")).toEqual({ kind: "approve-with-notes" });
  });

  // Guards the compact surface: row ids double as React keys, so a collision
  // hides a decision row on touch — the silent-data-loss class the #1436
  // review flagged (E16-review).
  test("compact row ids are unique per spec and never collide with the primary row", () => {
    for (const input of reviewInputs()) {
      const spec = buildDecisionSpec(input);
      const ids = [
        compactPrimaryIdForReviewDecision(spec.primary),
        ...spec.items.map((item) => compactRowIdForReviewDecisionItem(item.id)),
      ];
      for (const id of ids) expect(id).toBeDefined();
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
