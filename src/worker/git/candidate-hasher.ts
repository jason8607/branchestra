import { createHash } from "node:crypto";
import type { TestResultRecord } from "../../shared/contracts/domain";
import { hashCanonical } from "../approvals/canonical-json";

export class CandidateHasher {
  diffHash(diffBytes: Buffer): `sha256:${string}` {
    return `sha256:${createHash("sha256").update(diffBytes).digest("hex")}`;
  }

  testSetHash(results: readonly TestResultRecord[]): `sha256:${string}` {
    const normalized = results.map((result) => ({
      commandId: result.commandId,
      executableRealpath: result.executableRealpath,
      argv: [...result.argv],
      exitCode: result.exitCode,
      stdoutHash: result.stdoutHash,
      stderrHash: result.stderrHash
    })).sort(({ commandId: left }, { commandId: right }) => left.localeCompare(right, "en"));
    return hashCanonical(normalized);
  }
}
