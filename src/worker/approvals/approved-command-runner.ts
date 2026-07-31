import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { ApprovalReceipt, TestResultRecord } from "../../shared/contracts/domain";
import type { WorkspacePathGuard } from "../git/workspace-path-guard";
import type {
  JournaledProcessRunner,
  ProcessCommand
} from "../operations/journaled-process-runner";
import { ApprovalService } from "./approval-service";

export interface RegisteredProjectCommand extends ProcessCommand {
  displayName: string;
  network: "none" | "allowed";
}

export interface ProjectCommandCatalog {
  get(projectId: string, commandId: string): RegisteredProjectCommand | null;
}

interface ApprovedCommandRunnerOptions {
  catalog: ProjectCommandCatalog;
  processes: Pick<JournaledProcessRunner, "run">;
  id(): string;
  now(): string;
}

function hash(value: Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export class ApprovedCommandRunner {
  private readonly approvals = new ApprovalService();

  constructor(private readonly options: ApprovedCommandRunnerOptions) {}

  async authorize(input: {
    projectId: string;
    taskId: string;
    commandId: string;
    receipt: ApprovalReceipt;
    guard: WorkspacePathGuard;
    workerGeneration: string;
  }): Promise<RegisteredProjectCommand> {
    if (input.receipt.taskId !== input.taskId) throw new Error("TASK_CAPABILITY_TASK_MISMATCH");
    const scope = this.approvals.assertTaskCapability(input.receipt, input.workerGeneration);
    const command = this.options.catalog.get(input.projectId, input.commandId);
    if (!command) throw new Error(`PROJECT_COMMAND_NOT_REGISTERED:${input.commandId}`);
    if (!scope.commandClasses.includes(command.commandClass)) {
      throw new Error(`PROJECT_COMMAND_CLASS_NOT_APPROVED:${command.commandClass}`);
    }
    if (command.timeoutMs > scope.maxRunMs) throw new Error("PROJECT_COMMAND_TIMEOUT_EXCEEDS_SCOPE");
    if (!isAbsolute(command.executableRealpath)) throw new Error("PROJECT_COMMAND_EXECUTABLE_NOT_ABSOLUTE");
    if (!scope.toolNetwork && command.network !== "none") {
      throw new Error("PROJECT_COMMAND_NETWORK_NOT_APPROVED");
    }
    const authorizedCwd = await input.guard.assertChildCwd(command.cwdRealpath);
    if (authorizedCwd !== command.cwdRealpath) throw new Error("PROJECT_COMMAND_CWD_CHANGED");
    return command;
  }

  async run(input: {
    projectId: string;
    taskId: string;
    candidateId: string;
    commandId: string;
    receipt: ApprovalReceipt;
    guard: WorkspacePathGuard;
    commonDirRealpath: string;
    workerGeneration: string;
    idempotencyKey: string;
  }): Promise<TestResultRecord> {
    const command = await this.authorize(input);

    const executed = await this.options.processes.run({
      projectId: input.projectId,
      taskId: input.taskId,
      commonDirRealpath: input.commonDirRealpath,
      command,
      workerGeneration: input.workerGeneration,
      idempotencyKey: input.idempotencyKey
    });
    const id = this.options.id();
    return {
      id,
      taskId: input.taskId,
      candidateId: input.candidateId,
      commandId: command.commandId,
      executableRealpath: command.executableRealpath,
      argv: [...command.argv],
      exitCode: executed.exitCode,
      stdoutHash: hash(executed.stdout),
      stderrHash: hash(executed.stderr),
      durationMs: executed.durationMs,
      logReference: `room-event:${id}`,
      createdAt: this.options.now()
    };
  }
}
