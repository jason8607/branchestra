import { describe, expect, it } from "vitest";
import { assertBranchRef, assertGitOid } from "../../../src/worker/git/git-validation";

describe("exact Git boundary validation", () => {
  it.each(["a".repeat(40), "b".repeat(64)])("accepts exact lowercase hexadecimal OID %s", (oid) => {
    expect(() => assertGitOid(oid)).not.toThrow();
  });

  it.each([
    "a".repeat(39), "a".repeat(41), "a".repeat(63), "a".repeat(65),
    "A".repeat(40), "g".repeat(40), "HEAD", ""
  ])("rejects invalid OID boundary %j", (oid) => {
    expect(() => assertGitOid(oid)).toThrow("GIT_OID_INVALID");
  });

  it.each([
    "refs/heads/a",
    "refs/heads/feature/foo.bar-baz_1",
    "refs/heads/release/2026.07"
  ])("accepts documented ASCII branch ref %s", (ref) => {
    expect(() => assertBranchRef(ref)).not.toThrow();
  });

  it.each([
    "refs/heads/foo.",
    "refs/heads/foo./bar",
    "refs/heads/a.lock/b",
    "refs/heads/foo.lock",
    "refs/heads/.hidden",
    "refs/heads/foo..bar",
    "refs/heads/foo//bar",
    "refs/heads/foo/",
    "refs/heads/foo@{bar",
    "refs/heads/日本語",
    "refs/tags/v1",
    "refs/heads/control\u001fbyte"
  ])("rejects unsupported or Git-invalid branch ref %j", (ref) => {
    expect(() => assertBranchRef(ref)).toThrow("GIT_REF_INVALID");
  });
});
