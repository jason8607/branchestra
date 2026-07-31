import { vi } from "vitest";
import type { ProviderRunnerCommand } from "../../src/shared/contracts/provider-runner";

const RUN_ID = "019f842d-e19a-7cc1-9d73-4d287bf40558";

function request(role: "lead" | "collaborator") {
  return {
    taskId: "task-1",
    roomId: "room-1",
    role,
    instruction: "READ-ONLY BRANCHESTRA SNAPSHOT\nfixture context\n\nImplement the fixture",
    worktreePath: `/worktrees/task-1/${role}`,
    contextVersion: 1,
    contextHash: "a".repeat(64),
    approvedCapabilities: {
      workspaceRootRealpath: `/worktrees/task-1/${role}`,
      readableRootsRealpath: [`/worktrees/task-1/${role}`],
      commandClasses: ["build", "test"] as Array<"build" | "test" | "lint" | "format">,
      toolNetwork: false,
      allowCollaborator: true,
      maxRunMs: 60_000,
    },
    deniedWriteRoots: ["/Users/tester"],
    environment: { HOME: "/Users/tester", PATH: "/opt/homebrew/bin:/usr/bin:/bin" },
  };
}

export function claudeRunCommand(providerSessionId: string | null = null): Extract<ProviderRunnerCommand, { type: "run.start" | "run.resume" }> {
  return providerSessionId
    ? { type: "run.resume", runId: RUN_ID, provider: "claude", executableRealpath: "/opt/homebrew/bin/claude", codexConfigLockRealpath: null, providerSessionId, request: request("lead") }
    : { type: "run.start", runId: RUN_ID, provider: "claude", executableRealpath: "/opt/homebrew/bin/claude", codexConfigLockRealpath: null, request: request("lead") };
}

export function codexRunCommand(input: { providerSessionId?: string | null; toolNetwork?: boolean } = {}): Extract<ProviderRunnerCommand, { type: "run.start" | "run.resume" }> {
  const runRequest = request("collaborator");
  runRequest.approvedCapabilities.toolNetwork = input.toolNetwork ?? false;
  const common = { runId: RUN_ID, provider: "codex" as const, executableRealpath: "/opt/homebrew/bin/codex", codexConfigLockRealpath: "/Applications/Branchestra.app/Contents/Resources/codex/0.144.6/subscription.config.lock.toml", request: runRequest };
  return input.providerSessionId
    ? { type: "run.resume", ...common, providerSessionId: input.providerSessionId }
    : { type: "run.start", ...common };
}

export function createClaudeSdkDouble(messages: unknown[] = []) {
  const close = vi.fn();
  const query = vi.fn(() => ({
    close,
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message;
    },
  }));
  return { load: vi.fn(async () => ({ query, tool: vi.fn((...args: unknown[]) => args), createSdkMcpServer: vi.fn((options: unknown) => options) })), query, close };
}

export function createCodexSdkDouble(events: unknown[] = []) {
  const runStreamed = vi.fn(async () => ({ events: (async function* () { for (const event of events) yield event; })() }));
  const thread = { runStreamed };
  const startThread = vi.fn(() => thread);
  const resumeThread = vi.fn(() => thread);
  const create = vi.fn(() => ({ startThread, resumeThread }));
  return { create, startThread, resumeThread, runStreamed };
}
