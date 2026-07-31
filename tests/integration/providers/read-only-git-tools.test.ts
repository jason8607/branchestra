import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { GitCommandRunner } from "../../../src/worker/git/git-command-runner";
import { GitReadService } from "../../../src/worker/git/repository-inspector";
import { ReadOnlyToolService } from "../../../src/worker/tools/read-only-tool-service";
import { createGitRepositoryFixture, type GitRepositoryFixture } from "../../fixtures/git-repository";

describe("read-only Git tools", () => {
  const repositories: GitRepositoryFixture[] = [];

  afterEach(async () => {
    for (const repository of repositories.splice(0)) await repository.cleanup();
  });

  it("does not change HEAD, refs, index, or worktree bytes", async () => {
    const repository = await createGitRepositoryFixture();
    repositories.push(repository);
    const git = new GitCommandRunner();
    const service = new ReadOnlyToolService({
      git: new GitReadService(git),
      context: {
        search: async () => [],
        read: async () => []
      }
    });
    const binding = {
      roomId: "room-1",
      taskId: "task-1",
      repositoryRootRealpath: repository.root,
      worktreePathRealpath: repository.root,
      startOid: repository.initialOid,
      checkpointOids: new Set([repository.initialOid])
    };
    const snapshot = async () => ({
      head: (await repository.run(["rev-parse", "HEAD"])).stdout,
      refs: (await repository.run(["for-each-ref", "--format=%(refname):%(objectname)"])).stdout,
      status: (await repository.run(["status", "--porcelain=v1", "-z"])).stdout,
      readme: await readFile(`${repository.root}/README.md`, "utf8")
    });
    const before = await snapshot();

    await service.execute(binding, { name: "git.status", input: {} });
    await service.execute(binding, { name: "git.diff", input: { fromOid: repository.initialOid } });
    await service.execute(binding, { name: "git.show", input: { checkpointOid: repository.initialOid } });
    await service.execute(binding, { name: "git.log", input: { startOid: repository.initialOid, maxCount: 20 } });

    expect(await snapshot()).toEqual(before);
  });
});
