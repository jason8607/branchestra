import type {
  AgentRunRecord,
  ApprovalReceipt,
  CheckpointRecord,
  RoomEvent,
  TaskProviderEventSummary,
  TaskRecord,
  WorktreeRecord
} from "../../shared/contracts/domain";
import { ApprovedWorkspace, hashBytes } from "../approvals/approved-workspace";
import { hashCanonical } from "../approvals/canonical-json";
import type { GitArtifactRepository } from "../git/git-artifact-repository";
import type { GitManager } from "../git/git-manager";
import { WorkspacePathGuard } from "../git/workspace-path-guard";
import type { JournaledOperationRunner } from "../operations/journaled-operation-runner";
import type { OperationIntentRecord } from "../operations/operation-journal";
import type { EventStore } from "../storage/event-store";
import type { DomainRepositories } from "../storage/repositories";
import type {
  TaskProviderEvent,
  TaskProviderPort,
  TaskProviderRunHandle
} from "./provider-port";
import { transitionTask } from "./task-state-machine";

export interface TaskEngineOptions {
  repositories: DomainRepositories;
  artifacts: GitArtifactRepository;
  events: EventStore;
  manager: Pick<GitManager, "ensureAgentWorktree" | "createCheckpoint" | "getReadService">;
  provider: TaskProviderPort;
  operations: JournaledOperationRunner;
  workerGeneration: string;
  contextVersion: number;
  contextHash: `sha256:${string}`;
  prepareContext?(input: {
    runId: string;
    task: TaskRecord;
    role: "lead" | "collaborator";
    instruction: string;
    checkpointOid: string | null;
  }): Promise<{
    version: number;
    hash: `sha256:${string}`;
    instruction: string;
    persist?(): void | Promise<void>;
  }>;
  id(): string;
  now(): string;
  publish?(event: RoomEvent): void | Promise<void>;
}

export interface CollaborationProviderRunInput {
  taskId: string;
  checkpoint: CheckpointRecord;
  collaborator: WorktreeRecord;
  purpose: "parallel_implementation" | "review";
  diffFiles: Array<{
    path: string;
    status: string;
    additions: number;
    deletions: number;
  }>;
}

interface ActiveRun {
  handle: TaskProviderRunHandle;
  receipt: Extract<ApprovalReceipt, { kind: "task_scope" }>;
  closeConsumer(): void;
}

interface PendingRun {
  runId: string;
  handle: Promise<TaskProviderRunHandle>;
  receipt: Extract<ApprovalReceipt, { kind: "task_scope" }>;
}

interface RunLifecycle {
  terminal: Promise<TaskRecord>;
  consumerSettled: Promise<void>;
  settle(task: TaskRecord): void;
  settleConsumer(): void;
}

function errorDetails(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    return { code: error.message.split(":")[0] || error.name, message: error.message };
  }
  return { code: "TASK_ENGINE_ERROR", message: String(error) };
}

function summarizeProviderEvent(event: TaskProviderEvent): TaskProviderEventSummary {
  if (event.type === "workspace.writeText") {
    return {
      type: event.type,
      relativePath: event.relativePath,
      contentHash: hashBytes(Buffer.from(event.contents, "utf8"))
    };
  }
  return event;
}

function otherProvider(provider: TaskRecord["leadProvider"]): TaskRecord["leadProvider"] {
  return provider === "claude" ? "codex" : "claude";
}

export class TaskEngine {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly pendingRuns = new Map<string, PendingRun>();
  private readonly cancellationSettlements = new Map<string, Promise<TaskRecord>>();
  private readonly runLifecycles = new Map<string, RunLifecycle>();
  private readonly sideEffectTails = new Map<string, Promise<void>>();

  constructor(private readonly options: TaskEngineOptions) {}

  async startApprovedTask(taskId: string, idempotencyKey: string): Promise<TaskRecord> {
    const requestType = "task.startApproved";
    const requestHash = hashCanonical({ taskId });
    const replay = this.options.repositories.tasks.replayEngineCommand(
      idempotencyKey,
      requestType,
      requestHash
    );
    if (replay) return replay;
    const existingLifecycle = this.runLifecycles.get(taskId);
    if (existingLifecycle) {
      this.options.repositories.tasks.beginEngineCommand({
        idempotencyKey,
        requestType,
        requestHash,
        workerGeneration: this.options.workerGeneration,
        createdAt: this.options.now()
      });
      const result = await existingLifecycle.terminal;
      this.options.repositories.tasks.completeEngineCommand(
        idempotencyKey,
        result,
        this.options.now()
      );
      return result;
    }
    const current = this.options.repositories.tasks.getRequired(taskId);
    if (current.state !== "Preparing") {
      throw new Error(`TASK_NOT_PREPARING:${current.state}`);
    }
    const lifecycle = this.createRunLifecycle(taskId);
    try {
      this.options.repositories.tasks.beginEngineCommand({
        idempotencyKey,
        requestType,
        requestHash,
        workerGeneration: this.options.workerGeneration,
        createdAt: this.options.now()
      });
      const result = await this.runApprovedTask(taskId, idempotencyKey, lifecycle);
      this.options.repositories.tasks.completeEngineCommand(
        idempotencyKey,
        result,
        this.options.now()
      );
      lifecycle.settle(result);
      return result;
    } catch (error) {
      lifecycle.settle(this.options.repositories.tasks.getRequired(taskId));
      throw error;
    } finally {
      if (this.runLifecycles.get(taskId) === lifecycle) {
        this.runLifecycles.delete(taskId);
      }
    }
  }

  async runLeadRevision(input: {
    taskId: string;
    findings: string[];
    idempotencyKey: string;
  }): Promise<TaskRecord> {
    const requestType = "task.runLeadRevision";
    const requestHash = hashCanonical({ taskId: input.taskId, findings: input.findings });
    const tasks = this.options.repositories.tasks;
    const replay = tasks.replayEngineCommand(input.idempotencyKey, requestType, requestHash);
    if (replay) return replay;
    const task = tasks.getRequired(input.taskId);
    if (task.state !== "Revision") throw new Error(`TASK_NOT_IN_REVISION:${task.state}`);
    const receipt = this.approvedScope(task);
    const project = this.options.repositories.projects.findById(task.projectId);
    if (!project) throw new Error(`PROJECT_NOT_FOUND:${task.projectId}`);
    const worktree = this.options.artifacts.getWorktree(task.id, "lead");
    if (!worktree || worktree.currentCheckpointOid === null) {
      throw new Error("LEAD_CHECKPOINT_REQUIRED");
    }

    const runId = this.options.id();
    const revisionInstruction = JSON.stringify({
      task: task.requestText,
      purpose: "revision",
      findings: input.findings,
      checkpointOid: worktree.currentCheckpointOid
    });
    const context = await this.prepareContext({
      runId,
      task,
      role: "lead",
      instruction: revisionInstruction,
      checkpointOid: worktree.currentCheckpointOid
    });
    tasks.beginEngineCommand({
      idempotencyKey: input.idempotencyKey,
      requestType,
      requestHash,
      workerGeneration: this.options.workerGeneration,
      createdAt: this.options.now()
    });
    const lifecycle = this.createRunLifecycle(task.id);
    const run: AgentRunRecord = {
      id: runId,
      taskId: task.id,
      provider: task.leadProvider,
      role: "lead",
      providerSessionId: null,
      contextVersion: context.version,
      contextHash: context.hash,
      state: "starting",
      startedAt: this.options.now(),
      finishedAt: null
    };
    tasks.insertRun(run);
    await context.persist?.();
    let handle: TaskProviderRunHandle | null = null;
    let closeConsumer = () => {};
    const deadline = setTimeout(() => {
      void this.cancel(task.id, "timeout", `${run.id}:deadline`).catch(() => undefined);
    }, receipt.scope.maxRunMs);
    try {
      const handlePromise = this.options.provider.startRun({
        runId: run.id,
        taskId: task.id,
        roomId: task.roomId,
        provider: task.leadProvider,
        role: "lead",
        worktreePath: worktree.pathRealpath,
        instruction: context.instruction,
        contextVersion: run.contextVersion,
        contextHash: run.contextHash,
        checkpointOid: worktree.currentCheckpointOid,
        approvedCapabilities: {
          workspaceRootRealpath: worktree.pathRealpath,
          readableRootsRealpath: [project.repositoryRoot, worktree.pathRealpath],
          commandClasses: receipt.scope.commandClasses,
          toolNetwork: receipt.scope.toolNetwork,
          allowCollaborator: false,
          maxRunMs: receipt.scope.maxRunMs
        }
      });
      this.pendingRuns.set(task.id, { runId: run.id, handle: handlePromise, receipt });
      const started = await this.raceRunLifecycle(handlePromise, lifecycle);
      if (started.kind === "terminal") {
        this.pendingRuns.delete(task.id);
        lifecycle.settleConsumer();
        void handlePromise.then(
          (lateHandle) => this.retireProviderHandle(lateHandle),
          () => undefined
        );
        return started.task;
      }
      handle = started.value;
      this.pendingRuns.delete(task.id);
      if (tasks.getRequired(task.id).state !== "Revision") {
        this.retireProviderHandle(handle);
        lifecycle.settleConsumer();
        return tasks.getRequired(task.id);
      }
      tasks.updateRunSession(run.id, handle.sessionId, "running");
      const iterator = handle.events[Symbol.asyncIterator]();
      closeConsumer = this.consumerCloser(iterator);
      this.activeRuns.set(task.id, { handle, receipt, closeConsumer });
      const workspace = await this.approvedWorkspace(task, worktree, project.gitCommonDir);
      let terminalEvent: Extract<TaskProviderEvent,
        { type: "run.completed" | "run.failed" }> | null = null;
      while (true) {
        const emitted = await this.raceRunLifecycle(iterator.next(), lifecycle);
        if (emitted.kind === "terminal") {
          closeConsumer();
          lifecycle.settleConsumer();
          return emitted.task;
        }
        if (emitted.value.done) break;
        const event = emitted.value.value;
        const durableTask = tasks.getRequired(task.id);
        if (durableTask.state !== "Revision" && durableTask.state !== "CancelRequested") {
          closeConsumer();
          lifecycle.settleConsumer();
          return durableTask;
        }
        await this.recordProviderEvent(task, tasks.getRun(run.id) ?? run, event);
        if (event.type === "workspace.writeText") {
          await workspace.writeText(event.relativePath, event.contents);
        } else if (event.type === "test.request"
          && !receipt.scope.commandClasses.includes("test")) {
          throw new Error(`TEST_COMMAND_NOT_APPROVED:${event.commandId}`);
        } else if (event.type === "collaborator.request") {
          throw new Error("NESTED_COLLABORATOR_REQUEST_FORBIDDEN");
        } else if (event.type === "run.completed" || event.type === "run.failed") {
          terminalEvent = event;
          closeConsumer();
          break;
        }
      }
      lifecycle.settleConsumer();
      const settled = await this.raceRunLifecycle(handle.completion, lifecycle);
      if (settled.kind === "terminal") return settled.task;
      const current = tasks.getRequired(task.id);
      if (current.state === "CancelRequested") {
        return await this.cancellationSettlements.get(task.id) ?? current;
      }
      if (current.state !== "Revision") return current;
      if (settled.value.outcome === "failed" || terminalEvent?.type === "run.failed") {
        const failure = settled.value.error ?? (terminalEvent?.type === "run.failed"
          ? { code: terminalEvent.code, message: terminalEvent.message }
          : { code: "PROVIDER_FAILED", message: settled.value.summary });
        tasks.updateRunState(run.id, "failed", this.options.now());
        const failed = this.transition(current, { type: "fail", ...failure });
        tasks.completeEngineCommand(input.idempotencyKey, failed, this.options.now());
        return failed;
      }
      if (settled.value.outcome === "cancelled") return current;
      tasks.updateRunState(run.id, "completed", this.options.now());
      const checkpoint = await this.options.manager.createCheckpoint({
        projectId: task.projectId,
        taskId: task.id,
        worktree,
        authorProvider: task.leadProvider,
        purpose: "revision",
        message: terminalEvent?.type === "run.completed"
          ? terminalEvent.summary
          : settled.value.summary,
        checkpointId: this.options.id(),
        workerGeneration: this.options.workerGeneration,
        idempotencyKey: `${input.idempotencyKey}:checkpoint`
      });
      const checkpointEvent = this.options.events.append({
        id: this.options.id(),
        roomId: task.roomId,
        type: "checkpoint.created",
        actor: "system",
        payload: { checkpoint },
        createdAt: this.options.now()
      });
      await this.options.publish?.(checkpointEvent);
      const result = tasks.getRequired(task.id);
      tasks.completeEngineCommand(input.idempotencyKey, result, this.options.now());
      return result;
    } catch (error) {
      closeConsumer();
      const persisted = tasks.getRun(run.id);
      if (persisted?.state === "starting" || persisted?.state === "running") {
        tasks.updateRunState(run.id, "failed", this.options.now());
      }
      if (handle) await this.options.provider.cancelRun(handle.runId, "timeout").catch(() => undefined);
      const current = tasks.getRequired(task.id);
      if (current.state !== "Failed" && current.state !== "Cancelled") {
        const failed = this.transition(current, { type: "fail", ...errorDetails(error) });
        tasks.completeEngineCommand(input.idempotencyKey, failed, this.options.now());
        return failed;
      }
      throw error;
    } finally {
      clearTimeout(deadline);
      this.activeRuns.delete(task.id);
      this.pendingRuns.delete(task.id);
      lifecycle.settleConsumer();
      lifecycle.settle(tasks.getRequired(task.id));
      if (this.runLifecycles.get(task.id) === lifecycle) this.runLifecycles.delete(task.id);
    }
  }

  async runCollaborationProvider(
    input: CollaborationProviderRunInput
  ): Promise<TaskRecord> {
    const tasks = this.options.repositories.tasks;
    const task = tasks.getRequired(input.taskId);
    if (task.state !== "Review1" && task.state !== "Review2") {
      throw new Error(`TASK_NOT_IN_REVIEW:${task.state}`);
    }
    const receipt = this.approvedScope(task);
    const provider = otherProvider(task.leadProvider);
    const role = input.purpose === "review" ? "reviewer" as const : "collaborator" as const;
    const runId = this.options.id();
    const collaborationInstruction = JSON.stringify({
      task: task.requestText,
      purpose: input.purpose,
      immutableLeadCheckpointOid: input.checkpoint.oid,
      readOnlyGit: { diffSummary: input.diffFiles }
    });
    const context = await this.prepareContext({
      runId,
      task,
      role: "collaborator",
      instruction: collaborationInstruction,
      checkpointOid: input.checkpoint.oid
    });
    const run: AgentRunRecord = {
      id: runId,
      taskId: task.id,
      provider,
      role,
      providerSessionId: null,
      contextVersion: context.version,
      contextHash: context.hash,
      state: "starting",
      startedAt: this.options.now(),
      finishedAt: null
    };
    const lifecycle = this.createRunLifecycle(task.id);
    tasks.insertRun(run);
    await context.persist?.();
    let handle: TaskProviderRunHandle | null = null;
    let closeConsumer = () => {};
    const deadline = setTimeout(() => {
      void this.cancel(task.id, "timeout", `${run.id}:deadline`).catch(() => undefined);
    }, receipt.scope.maxRunMs);
    try {
      const handlePromise = this.options.provider.startRun({
        runId: run.id,
        taskId: task.id,
        roomId: task.roomId,
        provider,
        role,
        worktreePath: input.collaborator.pathRealpath,
        instruction: context.instruction,
        contextVersion: run.contextVersion,
        contextHash: run.contextHash,
        checkpointOid: input.checkpoint.oid,
        approvedCapabilities: {
          workspaceRootRealpath: input.collaborator.pathRealpath,
          readableRootsRealpath: [input.collaborator.pathRealpath],
          commandClasses: receipt.scope.commandClasses,
          toolNetwork: receipt.scope.toolNetwork,
          allowCollaborator: false,
          maxRunMs: receipt.scope.maxRunMs
        }
      });
      this.pendingRuns.set(task.id, { runId: run.id, handle: handlePromise, receipt });
      const started = await this.raceRunLifecycle(handlePromise, lifecycle);
      if (started.kind === "terminal") {
        this.pendingRuns.delete(task.id);
        lifecycle.settleConsumer();
        void handlePromise.then(
          (lateHandle) => this.retireProviderHandle(lateHandle),
          () => undefined
        );
        return started.task;
      }
      handle = started.value;
      this.pendingRuns.delete(task.id);
      const iterator = handle.events[Symbol.asyncIterator]();
      closeConsumer = this.consumerCloser(iterator);
      const afterStart = tasks.getRequired(task.id);
      if (!this.collaborationSideEffectsAllowed(afterStart, task.version)) {
        closeConsumer();
        lifecycle.settleConsumer();
        return afterStart;
      }
      tasks.updateRunSession(run.id, handle.sessionId, "running");
      this.activeRuns.set(task.id, { handle, receipt, closeConsumer });
      const workspace = input.purpose === "parallel_implementation"
        ? await this.approvedWorkspace(task, input.collaborator, receipt.scope.gitCommonDirRealpath)
        : null;
      while (true) {
        const emitted = await this.raceRunLifecycle(iterator.next(), lifecycle);
        if (emitted.kind === "terminal") {
          closeConsumer();
          lifecycle.settleConsumer();
          return emitted.task;
        }
        if (emitted.value.done) break;
        const event = emitted.value.value;
        const allowed = await this.withTaskSideEffect(task.id, () =>
          this.collaborationSideEffectsAllowed(
            tasks.getRequired(task.id),
            task.version
          )
        );
        if (!allowed) {
          closeConsumer();
          lifecycle.settleConsumer();
          return tasks.getRequired(task.id);
        }
        await this.recordProviderEvent(task, run, event);
        if (event.type === "workspace.writeText") {
          if (workspace === null) throw new Error("REVIEWER_WORKSPACE_MUTATION_FORBIDDEN");
          await this.withTaskSideEffect(task.id, async () => {
            const current = tasks.getRequired(task.id);
            if (!this.collaborationSideEffectsAllowed(current, task.version)) return;
            await workspace.writeText(event.relativePath, event.contents);
          });
        } else if (event.type === "run.completed" || event.type === "run.failed") {
          closeConsumer();
          break;
        }
      }
      lifecycle.settleConsumer();
      const settled = await this.raceRunLifecycle(handle.completion, lifecycle);
      if (settled.kind === "terminal") return settled.task;
      const current = tasks.getRequired(task.id);
      if (!this.collaborationSideEffectsAllowed(current, task.version)) return current;
      if (settled.value.outcome !== "completed") {
        throw new Error(settled.value.error?.code ?? "COLLABORATOR_RUN_FAILED");
      }
      tasks.updateRunState(run.id, "completed", this.options.now());
      if (input.purpose === "parallel_implementation") {
        await this.withTaskSideEffect(task.id, async () => {
          const beforeCheckpoint = tasks.getRequired(task.id);
          if (!this.collaborationSideEffectsAllowed(beforeCheckpoint, task.version)) return;
          const worktree = this.options.artifacts.getWorktree(task.id, "collaborator");
          if (!worktree) throw new Error("COLLABORATOR_WORKTREE_NOT_FOUND");
          const checkpoint = await this.options.manager.createCheckpoint({
            projectId: task.projectId,
            taskId: task.id,
            worktree,
            authorProvider: provider,
            purpose: "implementation",
            message: `Collaborator round ${task.collaborationRoundsUsed}`,
            checkpointId: this.options.id(),
            workerGeneration: this.options.workerGeneration,
            idempotencyKey: `${run.id}:checkpoint`
          });
          const event = this.options.events.append({
            id: this.options.id(),
            roomId: task.roomId,
            type: "checkpoint.created",
            actor: "system",
            payload: { checkpoint },
            createdAt: this.options.now()
          });
          await this.options.publish?.(event);
        });
      }
      return tasks.getRequired(task.id);
    } catch (error) {
      closeConsumer();
      const persisted = tasks.getRun(run.id);
      if (persisted?.state === "starting" || persisted?.state === "running") {
        tasks.updateRunState(run.id, "failed", this.options.now());
      }
      if (handle) {
        await this.options.provider.cancelRun(handle.runId, "timeout").catch(() => undefined);
      }
      throw error;
    } finally {
      clearTimeout(deadline);
      this.activeRuns.delete(task.id);
      this.pendingRuns.delete(task.id);
      lifecycle.settleConsumer();
      const result = tasks.getRequired(task.id);
      lifecycle.settle(result);
      if (this.runLifecycles.get(task.id) === lifecycle) {
        this.runLifecycles.delete(task.id);
      }
    }
  }

  private async runApprovedTask(
    taskId: string,
    idempotencyKey: string,
    lifecycle: RunLifecycle
  ): Promise<TaskRecord> {
    let task = this.options.repositories.tasks.getRequired(taskId);
    const receipt = this.approvedScope(task);
    const project = this.options.repositories.projects.findById(task.projectId);
    if (!project) throw new Error(`PROJECT_NOT_FOUND:${task.projectId}`);
    if (receipt.scope.repositoryRootRealpath !== project.repositoryRoot
      || receipt.scope.gitCommonDirRealpath !== project.gitCommonDir) {
      throw new Error("APPROVED_SCOPE_REPOSITORY_MISMATCH");
    }

    let run: AgentRunRecord | null = null;
    try {
      if (task.state !== "Preparing") {
        throw new Error(`TASK_NOT_PREPARING:${task.state}`);
      }
      const worktree = await this.options.manager.ensureAgentWorktree({
        projectId: task.projectId,
        taskId: task.id,
        role: "lead",
        baseOid: task.baseOid,
        repositoryRootRealpath: project.repositoryRoot,
        commonDirRealpath: project.gitCommonDir,
        workerGeneration: this.options.workerGeneration,
        idempotencyKey: `${idempotencyKey}:worktree`
      });
      if (!receipt.scope.writableRootsRealpath.includes(worktree.pathRealpath)) {
        throw new Error("WORKTREE_NOT_IN_APPROVED_SCOPE");
      }
      const preparedTask = this.options.repositories.tasks.getRequired(task.id);
      if (preparedTask.state !== "Preparing" || preparedTask.version !== task.version) {
        return preparedTask;
      }
      task = this.transition(task, { type: "preparationSucceeded" });
      const startedAt = this.options.now();
      const runId = this.options.id();
      const context = await this.prepareContext({
        runId,
        task,
        role: "lead",
        instruction: task.requestText,
        checkpointOid: worktree.currentCheckpointOid
      });
      run = {
        id: runId,
        taskId: task.id,
        provider: task.leadProvider,
        role: "lead",
        providerSessionId: null,
        contextVersion: context.version,
        contextHash: context.hash,
        state: "starting",
        startedAt,
        finishedAt: null
      };
      this.options.repositories.tasks.insertRun(run);
      await context.persist?.();
      const handlePromise = this.options.provider.startRun({
        runId: run.id,
        taskId: task.id,
        roomId: task.roomId,
        provider: task.leadProvider,
        role: "lead",
        worktreePath: worktree.pathRealpath,
        instruction: context.instruction,
        contextVersion: run.contextVersion,
        contextHash: run.contextHash,
        checkpointOid: worktree.currentCheckpointOid,
        approvedCapabilities: {
          workspaceRootRealpath: worktree.pathRealpath,
          readableRootsRealpath: [project.repositoryRoot, worktree.pathRealpath],
          commandClasses: receipt.scope.commandClasses,
          toolNetwork: receipt.scope.toolNetwork,
          allowCollaborator: receipt.scope.allowCollaborator,
          maxRunMs: receipt.scope.maxRunMs
        }
      });
      this.pendingRuns.set(task.id, {
        runId: run.id,
        handle: handlePromise,
        receipt
      });
      const started = await this.raceRunLifecycle(handlePromise, lifecycle);
      if (started.kind === "terminal") {
        this.pendingRuns.delete(task.id);
        lifecycle.settleConsumer();
        void handlePromise.then(
          (lateHandle) => this.retireProviderHandle(lateHandle),
          () => undefined
        );
        return started.task;
      }
      const handle = started.value;
      this.pendingRuns.delete(task.id);
      const taskAfterProviderStart = this.options.repositories.tasks.getRequired(task.id);
      if (taskAfterProviderStart.state !== "Working"
        && taskAfterProviderStart.state !== "CancelRequested") {
        this.retireProviderHandle(handle);
        lifecycle.settleConsumer();
        return taskAfterProviderStart;
      }
      const iterator = handle.events[Symbol.asyncIterator]();
      const closeConsumer = this.consumerCloser(iterator);
      if (taskAfterProviderStart.state === "Working") {
        this.options.repositories.tasks.updateRunSession(run.id, handle.sessionId, "running");
        this.activeRuns.set(task.id, { handle, receipt, closeConsumer });
      }
      run = this.options.repositories.tasks.getRun(run.id);
      if (!run) throw new Error("AGENT_RUN_NOT_FOUND");
      const workspace = await this.approvedWorkspace(task, worktree, project.gitCommonDir);
      let terminalEvent: Extract<TaskProviderEvent,
        { type: "run.completed" | "run.failed" }> | null = null;
      while (true) {
        const emitted = await this.raceRunLifecycle(iterator.next(), lifecycle);
        if (emitted.kind === "terminal") {
          closeConsumer();
          lifecycle.settleConsumer();
          this.activeRuns.delete(task.id);
          return emitted.task;
        }
        if (emitted.value.done) break;
        const event = emitted.value.value;
        const durableTask = this.options.repositories.tasks.getRequired(task.id);
        if (!this.providerSideEffectsAllowed(durableTask)) {
          closeConsumer();
          lifecycle.settleConsumer();
          this.activeRuns.delete(task.id);
          return durableTask;
        }
        run = this.options.repositories.tasks.getRun(run.id) ?? run;
        await this.recordProviderEvent(task, run, event);
        const taskAfterPublish = this.options.repositories.tasks.getRequired(task.id);
        if (!this.providerSideEffectsAllowed(taskAfterPublish)) {
          closeConsumer();
          lifecycle.settleConsumer();
          this.activeRuns.delete(task.id);
          return taskAfterPublish;
        }
        if (event.type === "workspace.writeText") {
          await workspace.writeText(event.relativePath, event.contents);
        } else if (event.type === "test.request"
          && !receipt.scope.commandClasses.includes("test")) {
          throw new Error(`TEST_COMMAND_NOT_APPROVED:${event.commandId}`);
        } else if (event.type === "collaborator.request"
          && !receipt.scope.allowCollaborator) {
          throw new Error("COLLABORATOR_NOT_APPROVED");
        } else if (event.type === "run.completed" || event.type === "run.failed") {
          terminalEvent = event;
          closeConsumer();
          break;
        }
      }
      lifecycle.settleConsumer();
      const settled = await this.raceRunLifecycle(handle.completion, lifecycle);
      if (settled.kind === "terminal") {
        closeConsumer();
        this.activeRuns.delete(task.id);
        return settled.task;
      }
      const completion = settled.value;
      this.activeRuns.delete(task.id);
      const taskAfterCompletion = this.options.repositories.tasks.getRequired(task.id);
      if (taskAfterCompletion.state === "CancelRequested") {
        return await this.cancellationSettlements.get(task.id) ?? taskAfterCompletion;
      }
      if (taskAfterCompletion.state !== "Working") {
        return taskAfterCompletion;
      }
      if (completion.outcome === "cancelled") {
        const persistedRun = this.options.repositories.tasks.getRun(run.id);
        if (persistedRun?.state === "starting" || persistedRun?.state === "running") {
          this.options.repositories.tasks.updateRunState(run.id, "cancelled", this.options.now());
        }
        return this.options.repositories.tasks.getRequired(task.id);
      }
      if (completion.outcome === "failed" || terminalEvent?.type === "run.failed") {
        const failure = completion.error ?? (terminalEvent?.type === "run.failed"
          ? { code: terminalEvent.code, message: terminalEvent.message }
          : { code: "PROVIDER_FAILED", message: completion.summary });
        this.options.repositories.tasks.updateRunState(run.id, "failed", this.options.now());
        return this.transition(task, { type: "fail", ...failure });
      }
      this.options.repositories.tasks.updateRunState(run.id, "completed", this.options.now());
      const checkpoint = await this.options.manager.createCheckpoint({
        projectId: task.projectId,
        taskId: task.id,
        worktree,
        authorProvider: task.leadProvider,
        purpose: "implementation",
        message: terminalEvent?.type === "run.completed"
          ? terminalEvent.summary
          : completion.summary,
        checkpointId: this.options.id(),
        workerGeneration: this.options.workerGeneration,
        idempotencyKey: `${idempotencyKey}:checkpoint`
      });
      const checkpointEvent = this.options.events.append({
        id: this.options.id(),
        roomId: task.roomId,
        type: "checkpoint.created",
        actor: "system",
        payload: { checkpoint },
        createdAt: this.options.now()
      });
      await this.options.publish?.(checkpointEvent);
      return this.transition(task, {
        type: "checkpointReady",
        checkpointOid: checkpoint.oid
      });
    } catch (error) {
      lifecycle.settleConsumer();
      const active = this.activeRuns.get(task.id);
      active?.closeConsumer();
      if (active) {
        try {
          await this.options.provider.cancelRun(active.handle.runId, "timeout");
        } catch {
          // The durable failure below remains authoritative when Provider cancellation fails.
        }
      }
      this.activeRuns.delete(task.id);
      this.pendingRuns.delete(task.id);
      if (run && (run.state === "starting" || run.state === "running")) {
        this.options.repositories.tasks.updateRunState(run.id, "failed", this.options.now());
      }
      const current = this.options.repositories.tasks.getRequired(task.id);
      if (current.state !== "Failed"
        && current.state !== "Cancelled"
        && current.state !== "Completed") {
        return this.transition(current, { type: "fail", ...errorDetails(error) });
      }
      throw error;
    }
  }

  async cancel(
    taskId: string,
    reason: "user" | "quit" | "timeout",
    idempotencyKey: string
  ): Promise<TaskRecord> {
    const cancellation = this.cancelTask(taskId, reason, idempotencyKey);
    this.cancellationSettlements.set(taskId, cancellation);
    try {
      return await cancellation;
    } finally {
      if (this.cancellationSettlements.get(taskId) === cancellation) {
        this.cancellationSettlements.delete(taskId);
      }
    }
  }

  private async cancelTask(
    taskId: string,
    reason: "user" | "quit" | "timeout",
    idempotencyKey: string
  ): Promise<TaskRecord> {
    const requestType = "task.cancel";
    const requestHash = hashCanonical({ taskId, reason });
    const tasks = this.options.repositories.tasks;
    const replay = tasks.replayEngineCommand(idempotencyKey, requestType, requestHash);
    if (replay) return replay;
    tasks.beginEngineCommand({
      idempotencyKey,
      requestType,
      requestHash,
      workerGeneration: this.options.workerGeneration,
      createdAt: this.options.now()
    });
    let task = tasks.getRequired(taskId);
    if (task.state === "Completed" || task.state === "Cancelled" || task.state === "Failed") {
      tasks.completeEngineCommand(idempotencyKey, task, this.options.now());
      this.settleRunLifecycle(taskId, task);
      return task;
    }
    const cancellationTarget = await this.withTaskSideEffect(taskId, () => {
      const transitioned = this.transition(task, { type: "cancel", reason });
      return {
        task: transitioned,
        active: this.activeRuns.get(taskId),
        pending: this.pendingRuns.get(taskId)
      };
    });
    task = cancellationTarget.task;
    if (task.state === "CancelRequested") {
      const { active, pending } = cancellationTarget;
      const receipt = active?.receipt ?? pending?.receipt;
      if (receipt) {
        const runId = active?.handle.runId ?? pending?.runId;
        if (!runId) throw new Error("CANCELLATION_RUN_NOT_FOUND");
        const timeout = Promise.withResolvers<"timeout">();
        const timer = setTimeout(
          () => timeout.resolve("timeout"),
          Math.max(1, Math.min(receipt.scope.maxRunMs, 5_000))
        );
        const failForTimeout = (): TaskRecord => {
          const run = tasks.getRun(runId);
          if (run?.state === "starting" || run?.state === "running") {
            tasks.updateRunState(run.id, "failed", this.options.now());
          }
          task = this.transition(task, {
            type: "fail",
            code: "CANCEL_GRACE_TIMEOUT",
            message: "Provider cancellation did not settle before the approved deadline"
          });
          tasks.completeEngineCommand(idempotencyKey, task, this.options.now());
          this.settleRunLifecycle(taskId, task);
          return task;
        };
        try {
          const cancelRequest = this.options.provider.cancelRun(runId, reason);
          const settlement = cancelRequest.then(async () => {
            const handle = active?.handle ?? await pending!.handle;
            return {
              handle,
              completion: await handle.completion
            };
          });
          const outcome = await Promise.race([settlement, timeout.promise]);
          if (outcome === "timeout") {
            return failForTimeout();
          }
          const consumerSettled = this.runLifecycles.get(taskId)?.consumerSettled;
          if (consumerSettled) {
            const drained = await Promise.race([
              consumerSettled.then(() => "drained" as const),
              timeout.promise
            ]);
            if (drained === "timeout") return failForTimeout();
          }
          const run = tasks.getRun(outcome.handle.runId);
          if (run?.state === "starting" || run?.state === "running") {
            tasks.updateRunState(
              run.id,
              outcome.completion.outcome === "failed" ? "failed" : "cancelled",
              this.options.now()
            );
          }
        } catch (error) {
          const run = tasks.getRun(runId);
          if (run?.state === "starting" || run?.state === "running") {
            tasks.updateRunState(run.id, "failed", this.options.now());
          }
          task = this.transition(task, { type: "fail", ...errorDetails(error) });
          tasks.completeEngineCommand(idempotencyKey, task, this.options.now());
          this.settleRunLifecycle(taskId, task);
          return task;
        } finally {
          clearTimeout(timer);
          this.activeRuns.delete(taskId);
          this.pendingRuns.delete(taskId);
        }
      }
      task = this.transition(task, { type: "cancelSettled" });
    }
    tasks.completeEngineCommand(idempotencyKey, task, this.options.now());
    this.settleRunLifecycle(taskId, task);
    return task;
  }

  private createRunLifecycle(taskId: string): RunLifecycle {
    if (this.runLifecycles.has(taskId)) {
      throw new Error(`RUN_LIFECYCLE_ALREADY_EXISTS:${taskId}`);
    }
    const terminal = Promise.withResolvers<TaskRecord>();
    const consumerSettled = Promise.withResolvers<void>();
    const lifecycle: RunLifecycle = {
      terminal: terminal.promise,
      consumerSettled: consumerSettled.promise,
      settle: terminal.resolve,
      settleConsumer: () => consumerSettled.resolve()
    };
    this.runLifecycles.set(taskId, lifecycle);
    return lifecycle;
  }

  private settleRunLifecycle(taskId: string, task: TaskRecord): void {
    this.runLifecycles.get(taskId)?.settle(task);
  }

  private providerSideEffectsAllowed(task: TaskRecord): boolean {
    return task.state === "Working" || task.state === "CancelRequested";
  }

  private collaborationSideEffectsAllowed(
    task: TaskRecord,
    expectedVersion: number
  ): boolean {
    return (task.state === "Review1" || task.state === "Review2")
      && task.version === expectedVersion;
  }

  private async withTaskSideEffect<T>(
    taskId: string,
    operation: () => T | Promise<T>
  ): Promise<T> {
    const previous = this.sideEffectTails.get(taskId) ?? Promise.resolve();
    const release = Promise.withResolvers<void>();
    const tail = previous.catch(() => undefined).then(() => release.promise);
    this.sideEffectTails.set(taskId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release.resolve();
      if (this.sideEffectTails.get(taskId) === tail) {
        this.sideEffectTails.delete(taskId);
      }
    }
  }

  private async raceRunLifecycle<T>(
    operation: Promise<T>,
    lifecycle: RunLifecycle
  ): Promise<
    | { kind: "value"; value: T }
    | { kind: "terminal"; task: TaskRecord }
  > {
    return Promise.race([
      operation.then((value) => ({ kind: "value" as const, value })),
      lifecycle.terminal.then((task) => ({ kind: "terminal" as const, task }))
    ]);
  }

  private consumerCloser(iterator: AsyncIterator<TaskProviderEvent>): () => void {
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      try {
        const closing = iterator.return?.();
        if (closing) void Promise.resolve(closing).catch(() => undefined);
      } catch {
        // Durable terminal state remains authoritative if a consumer cannot close cleanly.
      }
    };
  }

  private retireProviderHandle(handle: TaskProviderRunHandle): void {
    try {
      this.consumerCloser(handle.events[Symbol.asyncIterator]())();
    } catch {
      // Durable terminal state remains authoritative if a late handle cannot close cleanly.
    }
  }

  async handleProcessLoss(
    taskId: string,
    lostGeneration: string,
    idempotencyKey: string
  ): Promise<TaskRecord> {
    const requestType = "task.processLoss";
    const requestHash = hashCanonical({ taskId, lostGeneration });
    const tasks = this.options.repositories.tasks;
    const replay = tasks.replayEngineCommand(idempotencyKey, requestType, requestHash);
    if (replay) return replay;
    tasks.beginEngineCommand({
      idempotencyKey,
      requestType,
      requestHash,
      workerGeneration: this.options.workerGeneration,
      createdAt: this.options.now()
    });
    let task = tasks.getRequired(taskId);
    if (task.state === "Completed" || task.state === "Cancelled" || task.state === "Failed") {
      tasks.completeEngineCommand(idempotencyKey, task, this.options.now());
      this.settleRunLifecycle(taskId, task);
      return task;
    }

    const worktree = this.options.artifacts.getWorktree(taskId, "lead");
    if (worktree) {
      const project = this.options.repositories.projects.findById(task.projectId);
      const createdAt = this.options.now();
      const intent: OperationIntentRecord<{
        worktreeId: string;
        path: string;
        lostGeneration: string;
      }> = {
        id: this.options.id(),
        projectId: task.projectId,
        taskId,
        repositoryCommonDirRealpath: project?.gitCommonDir ?? worktree.pathRealpath,
        operationType: "process_loss.git_status",
        idempotencyKey: `${idempotencyKey}:git-status`,
        expected: {
          worktreeId: worktree.id,
          path: worktree.pathRealpath,
          lostGeneration
        },
        status: "intent",
        observation: null,
        workerGeneration: this.options.workerGeneration,
        createdAt,
        updatedAt: createdAt
      };
      try {
        await this.options.operations.run({
          intent,
          execute: async () => {},
          observe: async () => {
            const status = await this.options.manager.getReadService().status({
              repositoryRootRealpath: project?.repositoryRoot ?? worktree.pathRealpath,
              worktreePathRealpath: worktree.pathRealpath
            });
            return {
              outcome: "applied" as const,
              actual: {
                clean: status.clean,
                entries: status.entries,
                inProgressOperation: status.inProgressOperation
              },
              result: undefined
            };
          }
        });
      } catch {
        // The journal retains an uncertain observation when Git status cannot be read.
      }
    }
    for (const run of tasks.listRuns(taskId)) {
      if (run.state === "starting" || run.state === "running") {
        tasks.updateRunState(run.id, "interrupted", this.options.now());
      }
    }
    this.activeRuns.delete(taskId);
    this.pendingRuns.delete(taskId);
    task = this.transition(task, { type: "processLoss", generation: lostGeneration });
    tasks.completeEngineCommand(idempotencyKey, task, this.options.now());
    this.settleRunLifecycle(taskId, task);
    return task;
  }

  private approvedScope(
    task: TaskRecord
  ): Extract<ApprovalReceipt, { kind: "task_scope" }> {
    if (!task.scopeApprovalId) throw new Error("TASK_SCOPE_APPROVAL_REQUIRED");
    const receipt = this.options.repositories.approvals.getRequired(task.scopeApprovalId);
    if (receipt.kind !== "task_scope"
      || receipt.taskId !== task.id
      || receipt.decision !== "approved"
      || receipt.scopeHash !== hashCanonical(receipt.scope)
      || !receipt.survivesWorkerRestart) {
      throw new Error("TASK_SCOPE_APPROVAL_INVALID");
    }
    return receipt;
  }

  private prepareContext(input: {
    runId: string;
    task: TaskRecord;
    role: "lead" | "collaborator";
    instruction: string;
    checkpointOid: string | null;
  }): Promise<{
    version: number;
    hash: `sha256:${string}`;
    instruction: string;
    persist?(): void | Promise<void>;
  }> {
    if (this.options.prepareContext) return this.options.prepareContext(input);
    return Promise.resolve({
      version: this.options.contextVersion,
      hash: this.options.contextHash,
      instruction: input.instruction
    });
  }

  private transition(task: TaskRecord, action: Parameters<typeof transitionTask>[1]): TaskRecord {
    const transition = transitionTask(
      { ...task, updatedAt: this.options.now() },
      action
    );
    return this.options.repositories.tasks.applyTransition(
      transition,
      this.options.id()
    );
  }

  private async approvedWorkspace(
    task: TaskRecord,
    worktree: WorktreeRecord,
    commonDirRealpath: string
  ): Promise<ApprovedWorkspace> {
    const project = this.options.repositories.projects.findById(task.projectId);
    if (!project) throw new Error(`PROJECT_NOT_FOUND:${task.projectId}`);
    const guard = await WorkspacePathGuard.create({
      repositoryRootRealpath: project.repositoryRoot,
      worktreeRootRealpath: worktree.pathRealpath,
      gitCommonDirRealpath: commonDirRealpath
    });
    return new ApprovedWorkspace(guard, this.options.operations, {
      projectId: task.projectId,
      taskId: task.id,
      commonDirRealpath,
      workerGeneration: this.options.workerGeneration,
      nextOperationId: this.options.id,
      now: this.options.now
    });
  }

  private async recordProviderEvent(
    task: TaskRecord,
    run: AgentRunRecord,
    providerEvent: TaskProviderEvent
  ): Promise<void> {
    const event = this.options.events.append({
      id: this.options.id(),
      roomId: task.roomId,
      type: "agent.run",
      actor: run.provider,
      payload: { run, event: summarizeProviderEvent(providerEvent) },
      createdAt: this.options.now()
    });
    await this.options.publish?.(event);
  }
}
