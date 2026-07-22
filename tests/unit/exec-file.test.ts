import { describe, expect, it } from "vitest";
import { execFileNoShell } from "../../src/worker/process/exec-file";

describe("execFileNoShell", () => {
  it("rejects a timed-out child process", async () => {
    await expect(execFileNoShell(process.execPath, ["-e", "setTimeout(() => {}, 2000)"], {
      timeoutMs: 250,
      maxBufferBytes: 1_024
    })).rejects.toThrow(`Executable failed: ${process.execPath}`);
  });

  it("rejects child output that exceeds maxBuffer", async () => {
    await expect(execFileNoShell(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], {
      timeoutMs: 2_000,
      maxBufferBytes: 32
    })).rejects.toThrow(`Executable failed: ${process.execPath}`);
  });
});
