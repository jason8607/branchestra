import type { GitReadService } from "../git/repository-inspector";
import type { ReadOnlyToolRequest } from "./tool-schemas";

const MAX_RESULT_BYTES = 131_072;

export interface ContextReadRepository {
  search(input: { roomId: string; query: string; limit: number }): Promise<unknown>;
  read(input: { roomId: string; eventIds: string[]; limit: number }): Promise<unknown>;
}

export interface ReadOnlyToolBinding {
  roomId: string;
  taskId: string;
  repositoryRootRealpath: string;
  worktreePathRealpath: string;
  startOid: string;
  checkpointOids: ReadonlySet<string>;
}

export interface ReadOnlyToolResult { content: string; truncated: boolean }

export class ReadOnlyToolService {
  constructor(private readonly deps: { git: GitReadService; context: ContextReadRepository }) {}

  async execute(binding: ReadOnlyToolBinding, request: ReadOnlyToolRequest): Promise<ReadOnlyToolResult> {
    let value: unknown;
    switch (request.name) {
      case "context.search":
        value = await this.deps.context.search({ roomId: binding.roomId, query: request.input.query, limit: request.input.limit });
        break;
      case "context.read":
        value = await this.deps.context.read({ roomId: binding.roomId, eventIds: request.input.eventIds, limit: 50 });
        break;
      case "git.status":
        value = await this.deps.git.status({ repositoryRootRealpath: binding.repositoryRootRealpath, worktreePathRealpath: binding.worktreePathRealpath });
        break;
      case "git.diff":
        this.assertOwned(binding, request.input.fromOid);
        if (request.input.toOid) this.assertOwned(binding, request.input.toOid);
        value = await this.deps.git.diff({ repositoryRootRealpath: binding.repositoryRootRealpath, fromOid: request.input.fromOid, ...(request.input.toOid ? { toOid: request.input.toOid } : {}), ...(request.input.pathspec ? { pathspec: request.input.pathspec } : {}) });
        break;
      case "git.show":
        this.assertOwned(binding, request.input.checkpointOid);
        value = await this.deps.git.show({ repositoryRootRealpath: binding.repositoryRootRealpath, oid: request.input.checkpointOid, ...(request.input.path ? { path: request.input.path } : {}) });
        break;
      case "git.log":
        this.assertOwned(binding, request.input.startOid);
        value = await this.deps.git.log({ repositoryRootRealpath: binding.repositoryRootRealpath, startOid: request.input.startOid, maxCount: request.input.maxCount });
        break;
      default:
        throw new Error(`Unknown read-only tool: ${(request as { name: string }).name}`);
    }
    const encoded = JSON.stringify(value);
    const truncated = Buffer.byteLength(encoded, "utf8") > MAX_RESULT_BYTES;
    return { content: truncated ? Buffer.from(encoded).subarray(0, MAX_RESULT_BYTES).toString("utf8") : encoded, truncated };
  }

  private assertOwned(binding: ReadOnlyToolBinding, oid: string): void {
    if (oid !== binding.startOid && !binding.checkpointOids.has(oid)) throw new Error(`Checkpoint is not owned by task ${binding.taskId}`);
  }
}
