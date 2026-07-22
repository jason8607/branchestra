import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startWorker, type WorkerPort } from "../../src/worker/runtime";

function fakePort(): WorkerPort & { sent: unknown[] } {
  const listeners = new Set<(value: unknown) => void>();
  return {
    sent: [],
    postMessage(value) { this.sent.push(value); },
    onMessage(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
}

describe("worker runtime lease", () => {
  it("announces only one ready owner for a database", async () => {
    const root = mkdtempSync(join(tmpdir(), "branchestra-worker-"));
    const dbPath = join(root, "branchestra.sqlite3");
    let first: Awaited<ReturnType<typeof startWorker>> | undefined;
    let second: Awaited<ReturnType<typeof startWorker>> | undefined;
    let third: Awaited<ReturnType<typeof startWorker>> | undefined;

    try {
      const firstPort = fakePort();
      const secondPort = fakePort();
      first = await startWorker({ dbPath, port: firstPort, identity: { ownerInstanceId: "60000000-0000-4000-8000-000000000001", workerGeneration: "50000000-0000-4000-8000-000000000001", pid: 101, startIdentity: "101:1" }, leaseTtlMs: 5_000, heartbeatIntervalMs: 1_000 });
      second = await startWorker({ dbPath, port: secondPort, identity: { ownerInstanceId: "60000000-0000-4000-8000-000000000002", workerGeneration: "50000000-0000-4000-8000-000000000002", pid: 102, startIdentity: "102:1" }, leaseTtlMs: 5_000, heartbeatIntervalMs: 1_000 });
      expect(firstPort.sent).toContainEqual(expect.objectContaining({ type: "worker.ready", workerGeneration: "50000000-0000-4000-8000-000000000001" }));
      expect(secondPort.sent).toContainEqual(expect.objectContaining({ type: "worker.rejected", payload: { code: "LEASE_HELD" } }));
      await first.prepareQuit(Date.now() + 1_000);
      await second.prepareQuit(Date.now() + 1_000);
      const thirdPort = fakePort();
      third = await startWorker({ dbPath, port: thirdPort, identity: { ownerInstanceId: "60000000-0000-4000-8000-000000000002", workerGeneration: "50000000-0000-4000-8000-000000000003", pid: 103, startIdentity: "103:1" }, leaseTtlMs: 5_000, heartbeatIntervalMs: 1_000 });
      expect(thirdPort.sent).toContainEqual(expect.objectContaining({ type: "worker.ready", workerGeneration: "50000000-0000-4000-8000-000000000003" }));
    } finally {
      await third?.prepareQuit(Date.now() + 1_000);
      await second?.prepareQuit(Date.now() + 1_000);
      await first?.prepareQuit(Date.now() + 1_000);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
