import { describe, expect, it } from "vitest";
import { validateCleanupReceipt } from "../../../src/worker/cleanup/cleanup-service";

describe("validateCleanupReceipt", () => {
  it("binds room deletion to the observed event count and sequence", () => {
    expect(() => validateCleanupReceipt(
      { kind: "room", roomId: "room-1", eventCount: 8, throughSeq: 9, activeTaskCount: 0, confirmation: "DELETE room-1" },
      { kind: "room", roomId: "room-1", eventCount: 9, throughSeq: 10, activeTaskCount: 0 },
    )).toThrow("CLEANUP_RECEIPT_STALE");
  });
  it("requires an extra dirty-worktree confirmation", () => {
    expect(() => validateCleanupReceipt(
      { kind: "worktree", worktreeId: "wt-1", headOid: "a".repeat(40), dirtyHash: "sha256:dirty", allowDirtyArchive: false },
      { kind: "worktree", worktreeId: "wt-1", headOid: "a".repeat(40), dirtyHash: "sha256:dirty" },
    )).toThrow("DIRTY_WORKTREE_REQUIRES_ARCHIVE_CONFIRMATION");
  });
});
