import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { execFileNoShell } from "../../../src/worker/process/exec-file";
import { ProcessIdentityProbe } from "../../../src/worker/process/process-identity";
import { ProviderProcessSupervisor } from "../../../src/worker/process/provider-process-supervisor";

describe.runIf(process.platform === "darwin" && process.env.BRANCHESTRA_ALLOW_PROCESS_GROUP_TEST === "1")("ProviderProcessSupervisor", () => {
  it("aborts, TERM-signals, then KILL-signals a verified runner group", async () => {
    const signals: string[] = [];
    const supervisor = new ProviderProcessSupervisor({
      probe: new ProcessIdentityProbe(execFileNoShell),
      journal: {
        recordProviderIdentity: vi.fn(),
        recordProviderSignal: async (_runId, signal) => { signals.push(signal); },
        completeProviderProcess: vi.fn(),
      },
      now: () => new Date().toISOString(),
      config: { abortGraceMs: 75, termGraceMs: 75, killWaitMs: 500 },
    });
    const handle = await supervisor.spawn({
      runId: "019f842d-e19a-7cc1-9d73-4d287bf40558",
      workerGeneration: "119f842d-e19a-7cc1-9d73-4d287bf40558",
      runnerEntryRealpath: resolve("tests/fixtures/process/provider-runner-fixture.mjs"),
      providerExecutableRealpath: "/usr/bin/true",
      env: { HOME: "/tmp", PATH: "/usr/bin:/bin" },
    });
    const grandchild = await new Promise<number>((resolvePid, reject) => {
      const timeout = setTimeout(() => reject(new Error("fixture grandchild PID was not reported")), 1_000);
      handle.child.stdout.once("data", (chunk) => {
        clearTimeout(timeout);
        const parsed = JSON.parse(String(chunk).trim().split("\n")[0]!) as { pid: number };
        resolvePid(parsed.pid);
      });
    });
    await supervisor.cancel(handle.runId, "user");
    expect(signals).toEqual(["abort", "SIGTERM", "SIGKILL"]);
    expect(() => process.kill(handle.identity.pid, 0)).toThrow();
    expect(() => process.kill(grandchild, 0)).toThrow();
  });

  it("refuses to signal a mismatched identity", async () => {
    const kill = vi.fn();
    const supervisor = new ProviderProcessSupervisor({
      probe: { read: async (pid, runId, provider, generation) => ({ runId, pid, pgid: pid, runnerExecutableRealpath: process.execPath, providerExecutableRealpath: provider, startToken: "start", workerGeneration: generation }), verify: async () => { throw new Error("Provider process identity no longer matches journal"); } },
      journal: { recordProviderIdentity: vi.fn(), recordProviderSignal: vi.fn(), completeProviderProcess: vi.fn() },
      now: () => new Date().toISOString(), config: { abortGraceMs: 10, termGraceMs: 10, killWaitMs: 10 }, killGroup: kill,
    });
    const handle = await supervisor.spawn({ runId: "219f842d-e19a-7cc1-9d73-4d287bf40558", workerGeneration: "319f842d-e19a-7cc1-9d73-4d287bf40558", runnerEntryRealpath: resolve("tests/fixtures/process/provider-runner-fixture.mjs"), providerExecutableRealpath: "/usr/bin/true", env: { HOME: "/tmp", PATH: "/usr/bin:/bin" } });
    await expect(supervisor.cancel(handle.runId, "timeout")).rejects.toThrow("Provider process identity no longer matches journal");
    expect(kill).not.toHaveBeenCalled();
    handle.child.kill("SIGKILL");
  });
});
