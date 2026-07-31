import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JournaledProcessRunner } from "../../../src/worker/operations/journaled-process-runner";
import { createRepositories } from "../../../src/worker/storage/repositories";
import { openTestDatabase } from "../../fixtures/test-database";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const testDb = openTestDatabase();
  roots.push(testDb.directory);
  const repositories = createRepositories(testDb.db);
  repositories.tasks.insert(testDb.records.task);
  let sequence = 0;
  const runner = new JournaledProcessRunner({
    journal: repositories.operations,
    id: () => `process-operation-${++sequence}`,
    now: () => new Date().toISOString(),
    terminationGraceMs: 100
  });
  return { ...testDb, repositories, runner };
}

describe("JournaledProcessRunner", () => {
  it("passes literal argv with a controlled credential-free environment and journals hashes", async () => {
    const current = fixture();
    const cwd = mkdtempSync(join(tmpdir(), "branchestra-process-cwd-"));
    roots.push(cwd);
    const literal = "; touch should-not-run";

    const result = await current.runner.run({
      projectId: current.records.project.id,
      taskId: current.records.task.id,
      commonDirRealpath: current.records.project.gitCommonDir,
      workerGeneration: "50000000-0000-4000-8000-000000000001",
      idempotencyKey: "process-literal-argv",
      command: {
        commandId: "unit",
        commandClass: "test",
        executableRealpath: process.execPath,
        argv: ["-e", "process.stdout.write(JSON.stringify({ path: process.env.PATH, lang: process.env.LANG, lcAll: process.env.LC_ALL, ci: process.env.CI, openai: process.env.OPENAI_API_KEY ?? null, anthropic: process.env.ANTHROPIC_API_KEY ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null, value: process.argv[1] }))", literal],
        cwdRealpath: cwd,
        timeoutMs: 5_000
      }
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString("utf8"))).toEqual({
      path: "/usr/bin:/bin",
      lang: "C",
      lcAll: "C",
      ci: "1",
      openai: null,
      anthropic: null,
      nodeOptions: null,
      value: literal
    });
    expect(current.repositories.operations.getByIdempotencyKey("process-literal-argv"))
      .toMatchObject({
        status: "completed",
        observation: {
          outcome: "applied",
          actual: {
            stdoutHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            stderrHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
          }
        }
      });
    current.db.close();
  });

  it("sends TERM then KILL to a timed-out detached process group", async () => {
    const current = fixture();
    const cwd = mkdtempSync(join(tmpdir(), "branchestra-process-timeout-"));
    roots.push(cwd);
    const marker = join(cwd, "term-observed");

    await expect(current.runner.run({
      projectId: current.records.project.id,
      taskId: current.records.task.id,
      commonDirRealpath: current.records.project.gitCommonDir,
      workerGeneration: "50000000-0000-4000-8000-000000000001",
      idempotencyKey: "process-timeout",
      command: {
        commandId: "hang",
        commandClass: "test",
        executableRealpath: process.execPath,
        argv: ["-e", `const fs=require('node:fs'); process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(marker)},'term')); setInterval(()=>{},1000)`],
        cwdRealpath: cwd,
        timeoutMs: 200
      }
    })).rejects.toThrow("PROCESS_TIMEOUT");

    expect(readFileSync(marker, "utf8")).toBe("term");
    expect(current.repositories.operations.getByIdempotencyKey("process-timeout"))
      .toMatchObject({ status: "completed", observation: { outcome: "applied", actual: { timedOut: true } } });
    current.db.close();
  });
});
