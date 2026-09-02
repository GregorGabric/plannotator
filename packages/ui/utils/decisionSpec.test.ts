import { describe, expect, it } from 'bun:test';
import {
  buildDecisionSpec,
  type DecisionSpec,
  type DecisionSpecInput,
} from './decisionSpec';

/** Every input combination the spec can receive, for the invariant sweeps. */
function allInputs(): DecisionSpecInput[] {
  const inputs: DecisionSpecInput[] = [];
  for (const app of ['annotate', 'review'] as const)
    for (const gate of [false, true])
      for (const hasFeedback of [false, true])
        for (const approvalNotesSupported of [false, true])
          for (const count of [0, 1, 3])
            inputs.push({ app, gate, count, hasFeedback, approvalNotesSupported });
  return inputs;
}

function itemIds(spec: DecisionSpec): string[] {
  return spec.items.map((item) => item.id);
}

describe('buildDecisionSpec state matrix', () => {
  // Guards the model itself: each row of the spec's state table produces the
  // expected primary and the expected ordered menu.
  it('annotate, no feedback, no gate → Done + note/request-changes', () => {
    const spec = buildDecisionSpec({
      app: 'annotate', gate: false, count: 0, hasFeedback: false, approvalNotesSupported: false,
    });
    expect(spec.primary.label).toBe('Done'); // frozen copy, maintainer-approved
    expect(spec.primary.tone).toBe('success');
    expect(spec.primary.icon).toBe('check');
    expect(itemIds(spec)).toEqual(['note-with-approval', 'request-changes']);
    // Frozen copy (maintainer-approved): 'Request changes…'.
    expect(spec.items[1].label).toBe('Request changes…');
    // "Done with a note…" posts /api/feedback — never capability-gated. The
    // two composers must stay DISTINCT actions (positive finish vs change
    // request) — the labels themselves are free prose.
    expect(spec.items[0].composer?.tone).toBe('success');
    expect(spec.items[1].dividerBefore).toBe(true);
    expect(spec.items[1].composer?.tone).toBe('primary');
    expect(spec.items[0].composer?.actionLabel).not.toBe(spec.items[1].composer?.actionLabel);
  });

  it('annotate, no feedback, gate → Approve; approve-note item only with the capability', () => {
    const withCap = buildDecisionSpec({
      app: 'annotate', gate: true, count: 0, hasFeedback: false, approvalNotesSupported: true,
    });
    expect(withCap.primary.label).toBe('Approve'); // frozen copy, maintainer-approved
    expect(withCap.primary.tone).toBe('success');
    expect(itemIds(withCap)).toEqual(['note-with-approval', 'request-changes']);
    // Free prose except the verb: the gate's positive-note item must speak of
    // approving, not finishing.
    expect(withCap.items[0].label).toContain('Approve');

    const withoutCap = buildDecisionSpec({
      app: 'annotate', gate: true, count: 0, hasFeedback: false, approvalNotesSupported: false,
    });
    expect(itemIds(withoutCap)).toEqual(['request-changes']);
    expect(withoutCap.items[0].dividerBefore).toBe(false);
  });

  it('annotate, feedback (n) → Send Feedback + note/(approve-with-notes)/discard', () => {
    const nonGate = buildDecisionSpec({
      app: 'annotate', gate: false, count: 3, hasFeedback: true, approvalNotesSupported: true,
    });
    expect(nonGate.primary.label).toBe('Send Feedback'); // frozen copy, maintainer-approved
    expect(nonGate.primary.tone).toBe('primary');
    expect(nonGate.primary.icon).toBe('send');
    // No gate ⇒ no approve channel ⇒ no Approve-with-notes, capability or not.
    expect(itemIds(nonGate)).toEqual(['note-with-feedback', 'discard-and-finish']);
    // Label is free prose; the data is the flow verb and the live count.
    expect(nonGate.items[1].label).toContain('Done,');
    expect(nonGate.items[1].label).toContain('3');
    expect(nonGate.items[1].confirm?.confirmText).toBe('Discard & finish'); // frozen copy

    const gate = buildDecisionSpec({
      app: 'annotate', gate: true, count: 3, hasFeedback: true, approvalNotesSupported: true,
    });
    expect(itemIds(gate)).toEqual(['note-with-feedback', 'approve-with-notes', 'discard-and-finish']);
    expect(gate.items[1].label).toBe('Approve with notes'); // frozen copy, maintainer-approved
    expect(gate.items[2].label).toContain('Approve,');
    expect(gate.items[2].label).toContain('3');
    expect(gate.items[2].confirm?.confirmText).toBe('Discard & approve'); // frozen copy

    const gateNoCap = buildDecisionSpec({
      app: 'annotate', gate: true, count: 3, hasFeedback: true, approvalNotesSupported: false,
    });
    expect(itemIds(gateNoCap)).toEqual(['note-with-feedback', 'discard-and-finish']);
  });

  it('review, no feedback → Approve; phase-1 menu is Request changes only', () => {
    const phase1 = buildDecisionSpec({
      app: 'review', gate: true, count: 0, hasFeedback: false, approvalNotesSupported: false,
    });
    expect(phase1.primary.label).toBe('Approve');
    expect(itemIds(phase1)).toEqual(['request-changes']);

    const phase2 = buildDecisionSpec({
      app: 'review', gate: true, count: 0, hasFeedback: false, approvalNotesSupported: true,
    });
    expect(itemIds(phase2)).toEqual(['note-with-approval', 'request-changes']);
    expect(phase2.items[0].label).toContain('Approve');
  });

  it('review, feedback (n) → Send Feedback + note/(approve-with-notes)/discard', () => {
    const phase2 = buildDecisionSpec({
      app: 'review', gate: true, count: 3, hasFeedback: true, approvalNotesSupported: true,
    });
    expect(phase2.primary.label).toBe('Send Feedback');
    expect(phase2.primary.shortLabel).toBe('Send');
    expect(itemIds(phase2)).toEqual(['note-with-feedback', 'approve-with-notes', 'discard-and-finish']);

    const phase1 = buildDecisionSpec({
      app: 'review', gate: true, count: 3, hasFeedback: true, approvalNotesSupported: false,
    });
    expect(itemIds(phase1)).toEqual(['note-with-feedback', 'discard-and-finish']);
    expect(phase1.items[1].dividerBefore).toBe(true);
  });
});

describe('buildDecisionSpec invariants', () => {
  // Guards the maintainer's hard rule: Approve/Done and Send Feedback never
  // render side by side — there is exactly one primary and the menu never
  // smuggles a second one in.
  it('never yields two primaries, in any input combination', () => {
    for (const input of allInputs()) {
      const spec = buildDecisionSpec(input);
      expect(spec.primary.id).toBe('primary');
      expect(itemIds(spec)).not.toContain('primary');
      // The header shows Send Feedback XOR a positive finish, never both.
      const positiveLabels = ['Done', 'Approve'];
      if (spec.primary.label === 'Send Feedback') {
        expect(positiveLabels).not.toContain(spec.primary.label);
      } else {
        expect(positiveLabels).toContain(spec.primary.label);
      }
    }
  });

  // Guards rendering an item that silently drops content: without the
  // capability advert, no approve-carrying item exists in the approval flows.
  it('approvalNotesSupported: false ⇒ no approve-carrying item anywhere', () => {
    for (const input of allInputs()) {
      if (input.approvalNotesSupported) continue;
      if (input.app === 'annotate' && !input.gate) continue; // no approve channel at all
      const ids = itemIds(buildDecisionSpec(input));
      expect(ids).not.toContain('approve-with-notes');
      expect(ids).not.toContain('note-with-approval');
    }
  });

  // Guards a refactor that drops the one remaining guard dialog.
  it('every discard item carries a confirm', () => {
    for (const input of allInputs()) {
      for (const item of buildDecisionSpec(input).items) {
        if (item.id === 'discard-and-finish') {
          expect(item.confirm).toBeDefined();
          expect(item.tone).toBe('destructive');
        }
      }
    }
  });

  // Guards a stale count in the label after an annotation is deleted.
  it('interpolates the live count into the pill and the discard copy', () => {
    const zero = buildDecisionSpec({
      app: 'annotate', gate: false, count: 0, hasFeedback: true, approvalNotesSupported: false,
    });
    expect(zero.primary.count).toBeUndefined();
    // Nothing to discard at zero — no discard item with a lying "0 annotations".
    expect(itemIds(zero)).not.toContain('discard-and-finish');

    const three = buildDecisionSpec({
      app: 'review', gate: true, count: 3, hasFeedback: true, approvalNotesSupported: true,
    });
    expect(three.primary.count).toBe(3);
    const discard = three.items.find((item) => item.id === 'discard-and-finish')!;
    expect(discard.label).toContain('3');
    expect(discard.confirm!.title).toContain('3');

    const one = buildDecisionSpec({
      app: 'annotate', gate: false, count: 1, hasFeedback: true, approvalNotesSupported: false,
    });
    const discardOne = one.items.find((item) => item.id === 'discard-and-finish')!;
    // The singular form is the data here, not the sentence around it.
    expect(discardOne.label).toContain('1 annotation…');
  });

  // Every composer item must actually be a composer and every plain item must
  // not — the control branches on these fields, so an item with both (or a
  // confirm item with a composer) would render an unreachable surface.
  it('composer and confirm are mutually exclusive per item', () => {
    for (const input of allInputs()) {
      for (const item of buildDecisionSpec(input).items) {
        expect(item.composer && item.confirm).toBeFalsy();
      }
    }
  });
});
