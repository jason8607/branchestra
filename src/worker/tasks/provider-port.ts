export type TaskProviderName = "claude" | "codex";
export type TaskProviderRole = "lead" | "collaborator" | "reviewer";
export type ApprovedCommandClass = "build" | "test" | "lint" | "format";

export interface ApprovedRunCapabilities {
  workspaceRootRealpath: string;
  readableRootsRealpath: string[];
  commandClasses: ApprovedCommandClass[];
  toolNetwork: boolean;
  allowCollaborator: boolean;
  maxRunMs: number;
}

export interface TaskProviderRunRequest {
  runId: string;
  taskId: string;
  provider: TaskProviderName;
  role: TaskProviderRole;
  worktreePath: string;
  instruction: string;
  contextVersion: number;
  contextHash: string;
  checkpointOid: string | null;
  approvedCapabilities: ApprovedRunCapabilities;
}

export interface TaskProviderResumeRequest extends TaskProviderRunRequest {
  providerSessionId: string;
  recoveryBrief: string;
}

export type TaskProviderEvent =
  | { type: "assistant.message"; text: string }
  | { type: "workspace.writeText"; relativePath: string; contents: string }
  | { type: "test.request"; commandId: string }
  | { type: "collaborator.request"; purpose: "parallel_implementation" | "review" }
  | { type: "review.findings"; checkpointOid: string; findings: string[] }
  | { type: "run.completed"; summary: string }
  | { type: "run.failed"; code: string; message: string };

export interface TaskProviderRunResult {
  outcome: "completed" | "cancelled" | "failed";
  summary: string;
  error: { code: string; message: string } | null;
}

export interface TaskProviderRunHandle {
  runId: string;
  sessionId: string | null;
  events: AsyncIterable<TaskProviderEvent>;
  completion: Promise<TaskProviderRunResult>;
}

export interface TaskProviderPort {
  startRun(request: TaskProviderRunRequest): Promise<TaskProviderRunHandle>;
  resumeRun(request: TaskProviderResumeRequest): Promise<TaskProviderRunHandle>;
  cancelRun(runId: string, reason: "user" | "quit" | "timeout"): Promise<void>;
}
