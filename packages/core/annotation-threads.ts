/**
 * Reply threading (`inReplyTo`) rules shared by every consumer: the feedback
 * export, the annotations panel, and the external-annotation ingest.
 *
 * Browser-safe, zero-dep. `inReplyTo` is an additive field whose value can
 * come from anywhere (a browser agent's tool call, a PATCH on
 * /api/external-annotations that merges arbitrary fields), so consumers must
 * never trust it to form a tree. The one rule every consumer applies:
 *
 *   An annotation is a reply only when its `inReplyTo` names a DIFFERENT
 *   annotation in the same list AND following the chain of parents never
 *   comes back to the annotation itself. Everything else is a root: a plain
 *   comment, an orphan whose parent is absent, a self-reference, and every
 *   member of a cycle. Roots keep their original order. A reply to a cycle
 *   member stays a reply: its parent is rendered (as a root).
 *
 * Consequence: no annotation is ever dropped from a threaded rendering, and
 * a reply always hangs under something that is itself rendered.
 */

export interface ThreadableAnnotation {
  id: string;
  inReplyTo?: string | null;
}

/**
 * The effective parent of every annotation in `items`: the `inReplyTo`
 * target for a valid reply, `null` for a root (see the module comment).
 */
export function resolveReplyParents<T extends ThreadableAnnotation>(
  items: readonly T[],
): Map<string, string | null> {
  const byId = new Map<string, T>();
  for (const item of items) byId.set(item.id, item);
  const parents = new Map<string, string | null>();
  for (const item of items) {
    const target = typeof item.inReplyTo === "string" ? item.inReplyTo : null;
    if (!target || target === item.id || !byId.has(target)) {
      parents.set(item.id, null);
      continue;
    }
    // Walk up until the chain leaves the list or ends at a root. Coming back
    // to the item itself means it is a MEMBER of a cycle: a root. A chain
    // that merely leads into a cycle elsewhere leaves the item a reply of
    // its parent, which is itself rendered (as a cycle member, a root).
    const seen = new Set<string>();
    let current: T | undefined = byId.get(target);
    let member = false;
    while (current) {
      if (current.id === item.id) {
        member = true;
        break;
      }
      if (seen.has(current.id)) break;
      seen.add(current.id);
      const next = typeof current.inReplyTo === "string" ? current.inReplyTo : null;
      current = next ? byId.get(next) : undefined;
    }
    parents.set(item.id, member ? null : target);
  }
  return parents;
}

/**
 * Validate an `inReplyTo` value about to be written onto annotation `id`
 * (external-annotation PATCH ingest, both runtimes). A reply must point at
 * an existing, different annotation, and must not close a cycle through the
 * existing chain. `null`/`undefined` clear the field and are always valid.
 * Returns the error message, or `null` when the value may be applied.
 */
export function validateReplyTarget(
  all: readonly ThreadableAnnotation[],
  id: string,
  inReplyTo: unknown,
): string | null {
  if (inReplyTo === undefined || inReplyTo === null) return null;
  if (typeof inReplyTo !== "string" || inReplyTo.length === 0) {
    return 'invalid "inReplyTo": must be the id of an existing annotation';
  }
  if (inReplyTo === id) {
    return 'invalid "inReplyTo": an annotation cannot reply to itself';
  }
  const byId = new Map<string, ThreadableAnnotation>();
  for (const item of all) byId.set(item.id, item);
  if (!byId.has(inReplyTo)) {
    return `invalid "inReplyTo": no annotation with id "${inReplyTo}"`;
  }
  // Would the target's own chain lead back to `id`? Then the write would
  // create a cycle.
  const seen = new Set<string>();
  let current: ThreadableAnnotation | undefined = byId.get(inReplyTo);
  while (current) {
    if (current.id === id) {
      return 'invalid "inReplyTo": the reply chain would form a cycle';
    }
    if (seen.has(current.id)) break; // pre-existing cycle elsewhere; not ours to close
    seen.add(current.id);
    const next = typeof current.inReplyTo === "string" ? current.inReplyTo : null;
    current = next ? byId.get(next) : undefined;
  }
  return null;
}
