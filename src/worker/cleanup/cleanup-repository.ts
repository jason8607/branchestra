import type { Database } from "../storage/database";
import { validateCleanupReceipt, type CleanupPreview, type CleanupReceipt } from "./cleanup-service";

export class CleanupRepository {
  constructor(private readonly database: Database, private readonly now: () => string) {}
  removeRoom(receipt: Extract<CleanupReceipt, { kind: "room" }>, current: Extract<CleanupPreview, { kind: "room" }>): void {
    validateCleanupReceipt(receipt, current);
    this.database.transaction(() => {
      const result = this.database.prepare("DELETE FROM rooms WHERE id = ?").run(receipt.roomId);
      if (result.changes !== 1) throw new Error("ROOM_NOT_FOUND");
      this.database.prepare("INSERT INTO local_deletion_audit(kind, deleted_id, deleted_at) VALUES (?, ?, ?)").run("room", receipt.roomId, this.now());
    });
  }
  removeProjectMetadata(receipt: Extract<CleanupReceipt, { kind: "project" }>, current: Extract<CleanupPreview, { kind: "project" }>): void {
    validateCleanupReceipt(receipt, current);
    this.database.transaction(() => {
      const result = this.database.prepare("DELETE FROM projects WHERE id = ?").run(receipt.projectId);
      if (result.changes !== 1) throw new Error("PROJECT_NOT_FOUND");
      this.database.prepare("INSERT INTO local_deletion_audit(kind, deleted_id, deleted_at) VALUES (?, ?, ?)").run("project", receipt.projectId, this.now());
    });
  }
}
