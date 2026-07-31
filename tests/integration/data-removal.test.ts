import { expect, it } from "vitest";
import { CleanupRepository } from "../../src/worker/cleanup/cleanup-repository";
import { openTestDatabase } from "../fixtures/test-database";

it("removes only selected local room metadata and records an ID-only audit", () => {
  const harness = openTestDatabase();
  const cleanup = new CleanupRepository(harness.db, () => "2026-07-31T00:00:00.000Z");
  cleanup.removeRoom(
    { kind: "room", roomId: harness.records.room.id, eventCount: 0, throughSeq: 0, activeTaskCount: 0, confirmation: `DELETE ${harness.records.room.id}` },
    { kind: "room", roomId: harness.records.room.id, eventCount: 0, throughSeq: 0, activeTaskCount: 0 },
  );
  expect(harness.db.prepare("SELECT id FROM rooms WHERE id = ?").get(harness.records.room.id)).toBeUndefined();
  expect(harness.db.prepare("SELECT kind, deleted_id FROM local_deletion_audit").all()).toEqual([{ kind: "room", deleted_id: harness.records.room.id }]);
  expect(harness.db.prepare("SELECT id FROM projects WHERE id = ?").get(harness.records.project.id)).toEqual({ id: harness.records.project.id });
  harness.db.close();
});
