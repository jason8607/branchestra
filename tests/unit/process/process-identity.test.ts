import { describe, expect, it } from "vitest";
import { identitiesMatch } from "../../../src/worker/process/process-identity";

describe("provider process identity", () => {
  const expected = { runId: "019f842d-e19a-7cc1-9d73-4d287bf40558", pid: 4100, pgid: 4100, runnerExecutableRealpath: "/usr/local/bin/node", providerExecutableRealpath: "/opt/homebrew/bin/codex", startToken: "Tue Jul 21 10:00:00 2026", workerGeneration: "119f842d-e19a-7cc1-9d73-4d287bf40558" };
  it("requires run ID, generation, executable, group leader, and start token", () => {
    expect(identitiesMatch(expected, expected)).toBe(true);
    expect(identitiesMatch(expected, { ...expected, startToken: "Tue Jul 21 10:00:01 2026" })).toBe(false);
    expect(identitiesMatch(expected, { ...expected, runId: "219f842d-e19a-7cc1-9d73-4d287bf40558" })).toBe(false);
  });
});
