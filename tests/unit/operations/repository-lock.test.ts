import { describe, expect, it } from "vitest";
import { RepositoryLock } from "../../../src/worker/operations/repository-lock";

describe("RepositoryLock", () => {
  it("serializes FIFO operations for the same canonical common dir while allowing a distinct repository", async () => {
    const lock = new RepositoryLock();
    const timeline: string[] = [];
    const gate = Promise.withResolvers<void>();
    const first = lock.withLock("/repo/.git", async () => { timeline.push("a:start"); await gate.promise; timeline.push("a:end"); });
    const second = lock.withLock("/repo/.git", async () => { timeline.push("b:start"); timeline.push("b:end"); });
    const other = lock.withLock("/other/.git", async () => { timeline.push("c:start"); timeline.push("c:end"); });

    await other;
    expect(timeline).toEqual(["a:start", "c:start", "c:end"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(timeline).toEqual(["a:start", "c:start", "c:end", "a:end", "b:start", "b:end"]);
  });

  it("releases a rejected operation so the next same-repository operation can run", async () => {
    const lock = new RepositoryLock();
    const failed = lock.withLock("/repo/.git", async () => { throw new Error("failed mutation"); });
    const following = lock.withLock("/repo/.git", async () => "recovered");

    await expect(failed).rejects.toThrow("failed mutation");
    await expect(following).resolves.toBe("recovered");
  });

  it("cleans up an idle repository key", async () => {
    const lock = new RepositoryLock();
    await lock.withLock("/repo/.git", async () => undefined);

    expect((lock as unknown as { tails: Map<string, Promise<void>> }).tails.size).toBe(0);
  });

  it("requires an absolute canonical common-dir key", async () => {
    await expect(new RepositoryLock().withLock("repo/.git", async () => undefined))
      .rejects.toThrow("REPOSITORY_LOCK_KEY_NOT_ABSOLUTE");
  });
});
