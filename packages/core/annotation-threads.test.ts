/**
 * The one threading rule every `inReplyTo` consumer applies. Failures to
 * catch: a cycle member being treated as a reply (and then dropped by a
 * renderer that only walks down from roots), a self-reference threading
 * under itself, and the ingest accepting a write that would close a cycle.
 */
import { describe, expect, test } from "bun:test";
import { resolveReplyParents, validateReplyTarget } from "./annotation-threads";

const a = (id: string, inReplyTo?: string) => ({ id, inReplyTo });

describe("resolveReplyParents", () => {
  test("valid replies keep their parent; roots, orphans and self-references are roots", () => {
    const parents = resolveReplyParents([a("p"), a("r", "p"), a("orphan", "gone"), a("self", "self"), a("deep", "r")]);
    expect(parents.get("p")).toBeNull();
    expect(parents.get("r")).toBe("p");
    expect(parents.get("orphan")).toBeNull();
    expect(parents.get("self")).toBeNull();
    expect(parents.get("deep")).toBe("r");
  });

  test("every member of a cycle is a root, and a reply to a cycle member still threads under it", () => {
    const parents = resolveReplyParents([a("x", "y"), a("y", "x"), a("c", "x"), a("l1", "l3"), a("l2", "l1"), a("l3", "l2")]);
    expect(parents.get("x")).toBeNull();
    expect(parents.get("y")).toBeNull();
    expect(parents.get("c")).toBe("x");
    expect(parents.get("l1")).toBeNull();
    expect(parents.get("l2")).toBeNull();
    expect(parents.get("l3")).toBeNull();
  });

  test("a reply whose parent is an orphan is still a reply (the orphan renders as a root)", () => {
    const parents = resolveReplyParents([a("o", "gone"), a("r", "o")]);
    expect(parents.get("o")).toBeNull();
    expect(parents.get("r")).toBe("o");
  });
});

describe("validateReplyTarget", () => {
  const all = [a("p"), a("r", "p"), a("x", "y"), a("y", "x")];

  test("accepts an existing different target and clearing", () => {
    expect(validateReplyTarget(all, "x", "p")).toBeNull();
    expect(validateReplyTarget(all, "r", null)).toBeNull();
    expect(validateReplyTarget(all, "r", undefined)).toBeNull();
  });

  test("rejects self, missing, non-string and cycle-closing targets", () => {
    expect(validateReplyTarget(all, "p", "p")).toContain("itself");
    expect(validateReplyTarget(all, "p", "nope")).toContain("nope");
    expect(validateReplyTarget(all, "p", 42)).toContain("inReplyTo");
    expect(validateReplyTarget(all, "p", "")).toContain("inReplyTo");
    // r -> p; setting p -> r closes p -> r -> p.
    expect(validateReplyTarget(all, "p", "r")).toContain("cycle");
  });

  test("a pre-existing cycle elsewhere does not block an unrelated reply", () => {
    expect(validateReplyTarget(all, "p", "x")).toBeNull();
  });
});
