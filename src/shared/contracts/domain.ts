import { z } from "zod";

const UuidSchema = z.string().uuid();
const TimestampSchema = z.string().datetime({ offset: true });
const GitOidSchema = z.string().regex(/^[0-9a-f]{40,64}$/);
const Sha256Schema = z.string().regex(/^sha256:.+/);
const TargetRefSchema = z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]+$/);
const NonNegativeIntegerSchema = z.number().int().nonnegative();

export const ProjectSchema = z.object({
  id: UuidSchema, repositoryRoot: z.string().min(1), gitCommonDir: z.string().min(1),
  displayName: z.string().min(1).max(200), headOid: GitOidSchema,
  defaultBranch: z.string().min(1).nullable(), createdAt: TimestampSchema
}).strict();

export const RoomSchema = z.object({
  id: UuidSchema, projectId: UuidSchema, title: z.string().trim().min(1).max(120), createdAt: TimestampSchema
}).strict();

export const UserMessageSchema = z.object({
  id: UuidSchema, roomId: UuidSchema, body: z.string().trim().min(1).max(20_000), createdAt: TimestampSchema
}).strict();

export const TASK_STATES = [
  "AwaitingApproval", "Preparing", "Working", "Checkpoint", "Review1", "Revision",
  "Review2", "Candidate", "HumanApproval", "Merging", "CancelRequested", "Interrupted",
  "Reconciling", "Completed", "Cancelled", "Failed"
] as const;
const NON_TERMINAL_TASK_STATES = [
  "AwaitingApproval", "Preparing", "Working", "Checkpoint", "Review1", "Revision",
  "Review2", "Candidate", "HumanApproval", "Merging", "CancelRequested", "Interrupted", "Reconciling"
] as const;
export type TaskState = typeof TASK_STATES[number];
export type AgentProvider = "claude" | "codex";
export type AgentRole = "lead" | "collaborator" | "reviewer";
export type GitOid = string;

export interface TaskCapabilityScope {
  repositoryRootRealpath: string;
  gitCommonDirRealpath: string;
  writableRootsRealpath: string[];
  commandClasses: Array<"build" | "test" | "lint" | "format">;
  allowCollaborator: boolean;
  toolNetwork: boolean;
  maxRunMs: number;
  collaborationRoundBudget: number;
}

export interface FinalApprovalTuple {
  targetRef: string;
  baseOid: GitOid;
  candidateOid: GitOid;
  diffHash: `sha256:${string}`;
  testSetHash: `sha256:${string}`;
}

export interface ApprovalReceipt {
  id: string;
  requestId: string;
  taskId: string;
  kind: "task_scope" | "additional_round" | "external_operation" | "final_merge";
  decision: "approved" | "rejected";
  scope: TaskCapabilityScope | FinalApprovalTuple | { additionalRounds: number } | { operation: string };
  scopeHash: `sha256:${string}`;
  workerGeneration: string;
  survivesWorkerRestart: boolean;
  decidedAt: string;
}

export interface ApprovalRequest {
  id: string;
  taskId: string;
  kind: ApprovalReceipt["kind"];
  scope: ApprovalReceipt["scope"];
  scopeHash: `sha256:${string}`;
  requestedGeneration: string;
  status: "pending" | "decided";
  requestedAt: string;
}

export interface TaskRecord {
  id: string;
  roomId: string;
  projectId: string;
  requestEventId: string;
  requestText: string;
  leadProvider: AgentProvider;
  targetRef: string;
  baseOid: GitOid;
  state: TaskState;
  interruptedFromState: Exclude<TaskState, "Completed" | "Cancelled" | "Failed"> | null;
  collaborationRoundsUsed: number;
  collaborationRoundBudget: number;
  humanRevisionCount: number;
  revisionKind: "agent_review" | "human_directed" | null;
  scopeApprovalId: string | null;
  activeCandidateId: string | null;
  failure: { code: string; message: string } | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type TaskAction =
  | { type: "approveScope"; receiptId: string; collaborationRoundBudget: number }
  | { type: "rejectScope"; receiptId: string }
  | { type: "preparationSucceeded" }
  | { type: "checkpointReady"; checkpointOid: GitOid }
  | { type: "beginReview"; checkpointOid: GitOid }
  | { type: "requestAgentRevision"; findings: string[] }
  | { type: "candidateReady"; candidateId: string }
  | { type: "requestHumanApproval" }
  | { type: "approveMerge"; receiptId: string }
  | { type: "requestHumanRevision"; instruction: string }
  | { type: "grantAdditionalRounds"; receiptId: string; additionalRounds: number }
  | { type: "mergeCompleted" }
  | { type: "approvalInvalidated"; reason: string }
  | { type: "cancel"; reason: "user" | "quit" | "timeout" }
  | { type: "cancelSettled" }
  | { type: "fail"; code: string; message: string }
  | { type: "processLoss"; generation: string }
  | { type: "beginReconciliation" }
  | { type: "resumeRecordedPhase"; target: TaskRecord["interruptedFromState"] | "Completed" | "HumanApproval" | "Cancelled" };

export interface TaskTransition {
  previous: TaskRecord;
  next: TaskRecord;
  event: { type: `task.${string}`; payload: Record<string, unknown> };
}

export interface AgentRunRecord {
  id: string; taskId: string; provider: AgentProvider; role: AgentRole;
  providerSessionId: string | null; contextVersion: number; contextHash: `sha256:${string}`;
  state: "starting" | "running" | "completed" | "cancelled" | "failed" | "interrupted";
  startedAt: string; finishedAt: string | null;
}
export interface WorktreeRecord {
  id: string; taskId: string; role: "lead" | "collaborator"; pathRealpath: string;
  branchRef: string; baseOid: GitOid; currentCheckpointOid: GitOid | null;
  retained: true; createdAt: string;
}
export interface CheckpointRecord {
  id: string; taskId: string; worktreeId: string; authorProvider: AgentProvider;
  purpose: "implementation" | "review" | "revision" | "candidate"; oid: GitOid;
  immutableRef: string; createdAt: string;
}
export interface TestResultRecord {
  id: string; taskId: string; candidateId: string; commandId: string;
  executableRealpath: string; argv: string[]; exitCode: number;
  stdoutHash: `sha256:${string}`; stderrHash: `sha256:${string}`;
  durationMs: number; logReference: string; createdAt: string;
}
export interface IntegrationCandidate {
  id: string; taskId: string; leadWorktreeId: string; targetRef: string;
  baseOid: GitOid; candidateOid: GitOid; immutableRef: string;
  diffHash: `sha256:${string}`; testSetHash: `sha256:${string}`;
  diffSummary: { filesChanged: number; additions: number; deletions: number; files: GitDiffFileSummary[] };
  selectedCheckpointIds: string[]; testResults: TestResultRecord[];
  unresolved: Array<{ source: AgentProvider | "git" | "test"; summary: string }>;
  verificationStatus: "passed" | "failed"; createdAt: string;
}
export interface RecoveryOperationPreview {
  operationId: string; operationType: string;
  outcome: "not_applied" | "applied" | "conflict" | "uncertain";
  expected: Record<string, unknown>; actual: Record<string, unknown>;
}
export interface RecoveryPreview {
  taskId: string; recordedPhase: TaskRecord["interruptedFromState"];
  repositoryAvailable: boolean; worktrees: WorktreeRecord[]; checkpoints: CheckpointRecord[];
  dirtyPaths: string[]; providerSessionResumable: boolean;
  operations: RecoveryOperationPreview[]; previewHash: `sha256:${string}`; createdAt: string;
}
export interface GitDiffFileSummary {
  path: string; status: string; additions: number; deletions: number;
}
export type TaskProviderEventSummary =
  | { type: "assistant.message"; text: string }
  | { type: "workspace.writeText"; relativePath: string; contentHash: `sha256:${string}` }
  | { type: "test.request"; commandId: string }
  | { type: "collaborator.request"; purpose: "parallel_implementation" | "review" }
  | { type: "review.findings"; checkpointOid: string; findings: string[] }
  | { type: "run.completed"; summary: string }
  | { type: "run.failed"; code: string; message: string };

export interface TaskInspectorModel {
  task: TaskRecord;
  scopeReceipt: ApprovalReceipt | null;
  activeRuns: AgentRunRecord[];
  worktrees: WorktreeRecord[];
  checkpoints: CheckpointRecord[];
  candidate: IntegrationCandidate | null;
  pendingApproval: ApprovalRequest | null;
  recovery: RecoveryPreview | null;
}

const TaskStateSchema = z.enum(TASK_STATES);
const NonTerminalTaskStateSchema = z.enum(NON_TERMINAL_TASK_STATES);
const TaskCapabilityScopeSchema = z.object({
  repositoryRootRealpath: z.string().min(1), gitCommonDirRealpath: z.string().min(1),
  writableRootsRealpath: z.array(z.string().min(1)), commandClasses: z.array(z.enum(["build", "test", "lint", "format"])),
  allowCollaborator: z.boolean(), toolNetwork: z.boolean(), maxRunMs: z.number().int().positive(),
  collaborationRoundBudget: NonNegativeIntegerSchema
}).strict();
const FinalApprovalTupleSchema = z.object({
  targetRef: TargetRefSchema, baseOid: GitOidSchema, candidateOid: GitOidSchema,
  diffHash: Sha256Schema, testSetHash: Sha256Schema
}).strict();
const ApprovalScopeSchema = z.union([
  TaskCapabilityScopeSchema, FinalApprovalTupleSchema,
  z.object({ additionalRounds: NonNegativeIntegerSchema }).strict(),
  z.object({ operation: z.string().min(1) }).strict()
]);
const ApprovalReceiptSchema = z.object({
  id: z.string().min(1), requestId: z.string().min(1), taskId: z.string().min(1),
  kind: z.enum(["task_scope", "additional_round", "external_operation", "final_merge"]),
  decision: z.enum(["approved", "rejected"]), scope: ApprovalScopeSchema, scopeHash: Sha256Schema,
  workerGeneration: z.string().min(1), survivesWorkerRestart: z.boolean(), decidedAt: TimestampSchema
}).strict();
const ApprovalRequestSchema = z.object({
  id: z.string().min(1), taskId: z.string().min(1),
  kind: z.enum(["task_scope", "additional_round", "external_operation", "final_merge"]),
  scope: ApprovalScopeSchema, scopeHash: Sha256Schema, requestedGeneration: z.string().min(1),
  status: z.enum(["pending", "decided"]), requestedAt: TimestampSchema
}).strict();
const TaskRecordSchema = z.object({
  id: z.string().min(1), roomId: z.string().min(1), projectId: z.string().min(1), requestEventId: z.string().min(1),
  requestText: z.string(), leadProvider: z.enum(["claude", "codex"]), targetRef: TargetRefSchema, baseOid: GitOidSchema,
  state: TaskStateSchema, interruptedFromState: NonTerminalTaskStateSchema.nullable(),
  collaborationRoundsUsed: NonNegativeIntegerSchema, collaborationRoundBudget: NonNegativeIntegerSchema,
  humanRevisionCount: NonNegativeIntegerSchema, revisionKind: z.enum(["agent_review", "human_directed"]).nullable(),
  scopeApprovalId: z.string().min(1).nullable(), activeCandidateId: z.string().min(1).nullable(),
  failure: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict().nullable(),
  version: NonNegativeIntegerSchema, createdAt: TimestampSchema, updatedAt: TimestampSchema
}).strict();
const AgentRunRecordSchema = z.object({
  id: z.string().min(1), taskId: z.string().min(1), provider: z.enum(["claude", "codex"]), role: z.enum(["lead", "collaborator", "reviewer"]),
  providerSessionId: z.string().min(1).nullable(), contextVersion: NonNegativeIntegerSchema, contextHash: Sha256Schema,
  state: z.enum(["starting", "running", "completed", "cancelled", "failed", "interrupted"]),
  startedAt: TimestampSchema, finishedAt: TimestampSchema.nullable()
}).strict();
const WorktreeRecordSchema = z.object({
  id: z.string().min(1), taskId: z.string().min(1), role: z.enum(["lead", "collaborator"]), pathRealpath: z.string().min(1),
  branchRef: z.string().min(1), baseOid: GitOidSchema, currentCheckpointOid: GitOidSchema.nullable(), retained: z.literal(true), createdAt: TimestampSchema
}).strict();
const CheckpointRecordSchema = z.object({
  id: z.string().min(1), taskId: z.string().min(1), worktreeId: z.string().min(1), authorProvider: z.enum(["claude", "codex"]),
  purpose: z.enum(["implementation", "review", "revision", "candidate"]), oid: GitOidSchema, immutableRef: z.string().min(1), createdAt: TimestampSchema
}).strict();
const TestResultRecordSchema = z.object({
  id: z.string().min(1), taskId: z.string().min(1), candidateId: z.string().min(1), commandId: z.string().min(1),
  executableRealpath: z.string().min(1), argv: z.array(z.string()), exitCode: z.number().int(), stdoutHash: Sha256Schema,
  stderrHash: Sha256Schema, durationMs: NonNegativeIntegerSchema, logReference: z.string().min(1), createdAt: TimestampSchema
}).strict();
const GitDiffFileSummarySchema = z.object({ path: z.string().min(1), status: z.string().min(1), additions: NonNegativeIntegerSchema, deletions: NonNegativeIntegerSchema }).strict();
const IntegrationCandidateSchema = z.object({
  id: z.string().min(1), taskId: z.string().min(1), leadWorktreeId: z.string().min(1), targetRef: TargetRefSchema,
  baseOid: GitOidSchema, candidateOid: GitOidSchema, immutableRef: z.string().min(1), diffHash: Sha256Schema, testSetHash: Sha256Schema,
  diffSummary: z.object({ filesChanged: NonNegativeIntegerSchema, additions: NonNegativeIntegerSchema, deletions: NonNegativeIntegerSchema, files: z.array(GitDiffFileSummarySchema) }).strict(),
  selectedCheckpointIds: z.array(z.string().min(1)), testResults: z.array(TestResultRecordSchema),
  unresolved: z.array(z.object({ source: z.enum(["claude", "codex", "git", "test"]), summary: z.string().min(1) }).strict()),
  verificationStatus: z.enum(["passed", "failed"]), createdAt: TimestampSchema
}).strict();
const RecoveryOperationPreviewSchema = z.object({
  operationId: z.string().min(1), operationType: z.string().min(1), outcome: z.enum(["not_applied", "applied", "conflict", "uncertain"]),
  expected: z.record(z.string(), z.unknown()), actual: z.record(z.string(), z.unknown())
}).strict();
const RecoveryPreviewSchema = z.object({
  taskId: z.string().min(1), recordedPhase: NonTerminalTaskStateSchema.nullable(), repositoryAvailable: z.boolean(),
  worktrees: z.array(WorktreeRecordSchema), checkpoints: z.array(CheckpointRecordSchema), dirtyPaths: z.array(z.string()),
  providerSessionResumable: z.boolean(), operations: z.array(RecoveryOperationPreviewSchema), previewHash: Sha256Schema, createdAt: TimestampSchema
}).strict();
const TaskProviderEventSummarySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("assistant.message"), text: z.string() }).strict(),
  z.object({ type: z.literal("workspace.writeText"), relativePath: z.string().min(1), contentHash: Sha256Schema }).strict(),
  z.object({ type: z.literal("test.request"), commandId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("collaborator.request"), purpose: z.enum(["parallel_implementation", "review"]) }).strict(),
  z.object({ type: z.literal("review.findings"), checkpointOid: z.string().min(1), findings: z.array(z.string()) }).strict(),
  z.object({ type: z.literal("run.completed"), summary: z.string() }).strict(),
  z.object({ type: z.literal("run.failed"), code: z.string().min(1), message: z.string().min(1) }).strict()
]);

const roomEvent = <const TType extends string, T extends z.ZodType>(type: TType, payload: T) => z.object({
  id: UuidSchema, roomId: UuidSchema, roomSeq: z.number().int().positive(), type: z.literal(type),
  actor: z.enum(["user", "claude", "codex", "system"]), payload, createdAt: TimestampSchema
}).strict();

export const RoomEventSchema = z.union([
  roomEvent("message.posted", UserMessageSchema),
  roomEvent("task.created", z.object({ task: TaskRecordSchema }).strict()),
  roomEvent("task.transitioned", z.object({ taskId: z.string().min(1), from: TaskStateSchema, to: TaskStateSchema, version: NonNegativeIntegerSchema }).strict()),
  roomEvent("approval.requested", z.object({ request: ApprovalRequestSchema }).strict()),
  roomEvent("approval.decided", z.object({ receipt: ApprovalReceiptSchema }).strict()),
  roomEvent("agent.run", z.object({ run: AgentRunRecordSchema, event: TaskProviderEventSummarySchema }).strict()),
  roomEvent("checkpoint.created", z.object({ checkpoint: CheckpointRecordSchema }).strict()),
  roomEvent("test.completed", z.object({ result: TestResultRecordSchema }).strict()),
  roomEvent("candidate.created", z.object({ candidate: IntegrationCandidateSchema }).strict()),
  roomEvent("task.interrupted", z.object({ taskId: z.string().min(1), from: NonTerminalTaskStateSchema, workerGeneration: z.string().min(1) }).strict()),
  roomEvent("task.recovery", z.object({ preview: RecoveryPreviewSchema }).strict()),
  roomEvent("merge.completed", z.object({ taskId: z.string().min(1), targetRef: TargetRefSchema, previousOid: GitOidSchema, targetOid: GitOidSchema, mode: z.string().min(1) }).strict())
]) as z.ZodType<RoomEvent>;

export const AppSnapshotSchema = z.object({
  projects: z.array(ProjectSchema), rooms: z.array(RoomSchema), roomCursors: z.record(UuidSchema, NonNegativeIntegerSchema)
}).strict();
export const SnapshotPageSchema = z.object({
  snapshotId: UuidSchema, projects: z.array(ProjectSchema), rooms: z.array(RoomSchema), roomCursors: z.record(UuidSchema, NonNegativeIntegerSchema),
  nextCursor: NonNegativeIntegerSchema, hasMore: z.boolean()
}).strict();
export const RoomEventCursorSchema = z.object({ roomId: UuidSchema, roomSeq: NonNegativeIntegerSchema, limit: z.number().int().min(1).max(500) }).strict();
export const RoomEventPageSchema = z.object({ roomId: UuidSchema, events: z.array(RoomEventSchema), nextRoomSeq: NonNegativeIntegerSchema, hasMore: z.boolean() }).strict();

export type Project = z.infer<typeof ProjectSchema>;
export type Room = z.infer<typeof RoomSchema>;
export type UserMessage = z.infer<typeof UserMessageSchema>;
type RoomEventBase<TType extends string, TPayload> = {
  id: string;
  roomId: string;
  roomSeq: number;
  type: TType;
  actor: "user" | "claude" | "codex" | "system";
  payload: TPayload;
  createdAt: string;
};
export type UserMessageRoomEvent = RoomEventBase<"message.posted", UserMessage>;
export type RoomEvent =
  | UserMessageRoomEvent
  | RoomEventBase<"task.created", { task: TaskRecord }>
  | RoomEventBase<"task.transitioned", { taskId: string; from: TaskState; to: TaskState; version: number }>
  | RoomEventBase<"approval.requested", { request: ApprovalRequest }>
  | RoomEventBase<"approval.decided", { receipt: ApprovalReceipt }>
  | RoomEventBase<"agent.run", { run: AgentRunRecord; event: TaskProviderEventSummary }>
  | RoomEventBase<"checkpoint.created", { checkpoint: CheckpointRecord }>
  | RoomEventBase<"test.completed", { result: TestResultRecord }>
  | RoomEventBase<"candidate.created", { candidate: IntegrationCandidate }>
  | RoomEventBase<"task.interrupted", { taskId: string; from: Exclude<TaskState, "Completed" | "Cancelled" | "Failed">; workerGeneration: string }>
  | RoomEventBase<"task.recovery", { preview: RecoveryPreview }>
  | RoomEventBase<"merge.completed", { taskId: string; targetRef: string; previousOid: GitOid; targetOid: GitOid; mode: string }>;
export type AppSnapshot = z.infer<typeof AppSnapshotSchema>;
export type SnapshotPage = z.infer<typeof SnapshotPageSchema>;
export type RoomEventCursor = z.infer<typeof RoomEventCursorSchema>;
export interface RoomEventPage {
  roomId: string;
  events: RoomEvent[];
  nextRoomSeq: number;
  hasMore: boolean;
}

export interface Clock { now(): string; }
export interface IdGenerator { next(): string; }
