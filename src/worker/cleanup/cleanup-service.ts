import { hashCanonical } from "../approvals/canonical-json";

export type CleanupPreview =
  | { kind: "room"; roomId: string; eventCount: number; throughSeq: number; activeTaskCount: number }
  | { kind: "project"; projectId: string; roomCount: number; activeTaskCount: number }
  | { kind: "worktree"; worktreeId: string; headOid: string; dirtyHash: string | null };
export type CleanupReceipt =
  | (Extract<CleanupPreview, { kind: "room" }> & { confirmation: string })
  | (Extract<CleanupPreview, { kind: "project" }> & { confirmation: string })
  | (Extract<CleanupPreview, { kind: "worktree" }> & { allowDirtyArchive: boolean });

function binding(value: CleanupPreview | CleanupReceipt): CleanupPreview {
  switch (value.kind) {
    case "room": return { kind: value.kind, roomId: value.roomId, eventCount: value.eventCount, throughSeq: value.throughSeq, activeTaskCount: value.activeTaskCount };
    case "project": return { kind: value.kind, projectId: value.projectId, roomCount: value.roomCount, activeTaskCount: value.activeTaskCount };
    case "worktree": return { kind: value.kind, worktreeId: value.worktreeId, headOid: value.headOid, dirtyHash: value.dirtyHash };
  }
}
export function validateCleanupReceipt(receipt: CleanupReceipt, current: CleanupPreview): void {
  if (hashCanonical(binding(receipt)) !== hashCanonical(binding(current))) throw new Error("CLEANUP_RECEIPT_STALE");
  if (current.kind === "project" && current.activeTaskCount !== 0) throw new Error("PROJECT_HAS_ACTIVE_TASKS");
  if (current.kind === "room" && current.activeTaskCount !== 0) throw new Error("ROOM_HAS_ACTIVE_TASKS");
  if (current.kind === "room" && receipt.kind === "room" && receipt.confirmation !== `DELETE ${current.roomId}`) throw new Error("ROOM_DELETE_CONFIRMATION_MISMATCH");
  if (current.kind === "project" && receipt.kind === "project" && receipt.confirmation !== `DELETE ${current.projectId}`) throw new Error("PROJECT_DELETE_CONFIRMATION_MISMATCH");
  if (current.kind === "worktree" && current.dirtyHash && receipt.kind === "worktree" && !receipt.allowDirtyArchive) throw new Error("DIRTY_WORKTREE_REQUIRES_ARCHIVE_CONFIRMATION");
}
