import { describe, expect, it, vi } from "vitest";
import { createClaudeRuntime } from "../../../src/provider-runner/claude-runtime";
import { claudeRunCommand, createClaudeSdkDouble } from "../../helpers/provider-sdk-doubles";

describe("Claude provider runtime", () => {
  it("passes the verified external path and restrictive options to query", async () => {
    const sdk = createClaudeSdkDouble();
    const runtime = createClaudeRuntime({ sdk, toolClient: { call: vi.fn() }, now: () => new Date("2026-07-21T10:00:00.000Z") });
    await runtime.start(claudeRunCommand("claude-session-1"), vi.fn());
    expect(sdk.query).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({
      pathToClaudeCodeExecutable: "/opt/homebrew/bin/claude", cwd: "/worktrees/task-1/lead", permissionMode: "default",
      strictMcpConfig: true, settingSources: [], resume: "claude-session-1", allowDangerouslySkipPermissions: false,
      sandbox: expect.objectContaining({ enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false }),
    }) }));
  });

  it("aborts and closes the query exactly once", async () => {
    const sdk = createClaudeSdkDouble();
    const runtime = createClaudeRuntime({ sdk, toolClient: { call: vi.fn() }, now: () => new Date() });
    await runtime.start(claudeRunCommand(), vi.fn());
    await runtime.cancel("user");
    await runtime.cancel("user");
    expect(sdk.close).toHaveBeenCalledTimes(1);
  });
});
