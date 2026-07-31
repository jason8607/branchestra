import { z } from "zod";
import { ProjectCleanupPreviewSchema, RoomCleanupPreviewSchema, type ProjectCleanupPreview, type RoomCleanupPreview } from "../../shared/contracts/protocol";
import type { CleanupRepository } from "./cleanup-repository";
import type { Database } from "../storage/database";
import type { DurableCommand, DurableResult, IdempotencyStore } from "../storage/idempotency-store";

const RoomRemovalResultSchema = z.object({
  removed: z.literal(true),
  kind: z.literal("room"),
  id: z.string().uuid()
}).strict();
const ProjectRemovalResultSchema = z.object({
  removed: z.literal(true),
  kind: z.literal("project"),
  id: z.string().uuid()
}).strict();
type RoomRemovalResult = z.infer<typeof RoomRemovalResultSchema>;
type ProjectRemovalResult = z.infer<typeof ProjectRemovalResultSchema>;

export class CleanupCommandService {
  constructor(private readonly options: {
    database: Database;
    repository: Pick<CleanupRepository, "removeRoom" | "removeProjectMetadata">;
    idempotency: IdempotencyStore;
  }) {}

  previewRoom(roomId: string): RoomCleanupPreview {
    const room = this.options.database.prepare("SELECT id FROM rooms WHERE id = ?").get(roomId);
    if (!room) throw new Error(`ROOM_NOT_FOUND:${roomId}`);
    const events = this.options.database.prepare(
      "SELECT COUNT(*) AS eventCount, COALESCE(MAX(room_seq), 0) AS throughSeq FROM room_events WHERE room_id = ?"
    ).get(roomId) as { eventCount: number; throughSeq: number };
    const tasks = this.options.database.prepare(
      "SELECT COUNT(*) AS taskCount FROM tasks WHERE room_id = ?"
    ).get(roomId) as { taskCount: number };
    return RoomCleanupPreviewSchema.parse({
      kind: "room",
      roomId,
      eventCount: Number(events.eventCount),
      throughSeq: Number(events.throughSeq),
      activeTaskCount: Number(tasks.taskCount)
    });
  }

  removeRoom(
    receipt: RoomCleanupPreview & { confirmation: string },
    command: DurableCommand
  ): DurableResult<RoomRemovalResult> {
    const replay = this.options.idempotency.replay(command, RoomRemovalResultSchema);
    if (replay) return replay;
    const current = this.previewRoom(receipt.roomId);
    return this.options.idempotency.execute(command, RoomRemovalResultSchema, () => {
      this.options.repository.removeRoom(receipt, current);
      return { removed: true, kind: "room", id: receipt.roomId };
    });
  }

  previewProject(projectId: string): ProjectCleanupPreview {
    const project = this.options.database.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
    if (!project) throw new Error(`PROJECT_NOT_FOUND:${projectId}`);
    const rooms = this.options.database.prepare(
      "SELECT COUNT(*) AS roomCount FROM rooms WHERE project_id = ?"
    ).get(projectId) as { roomCount: number };
    const tasks = this.options.database.prepare(
      "SELECT COUNT(*) AS taskCount FROM tasks WHERE project_id = ?"
    ).get(projectId) as { taskCount: number };
    return ProjectCleanupPreviewSchema.parse({
      kind: "project",
      projectId,
      roomCount: Number(rooms.roomCount),
      activeTaskCount: Number(tasks.taskCount)
    });
  }

  removeProject(
    receipt: ProjectCleanupPreview & { confirmation: string },
    command: DurableCommand
  ): DurableResult<ProjectRemovalResult> {
    const replay = this.options.idempotency.replay(command, ProjectRemovalResultSchema);
    if (replay) return replay;
    const current = this.previewProject(receipt.projectId);
    return this.options.idempotency.execute(command, ProjectRemovalResultSchema, () => {
      this.options.repository.removeProjectMetadata(receipt, current);
      return { removed: true, kind: "project", id: receipt.projectId };
    });
  }
}
