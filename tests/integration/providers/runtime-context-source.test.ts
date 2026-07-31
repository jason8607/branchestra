import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeContextSource } from "../../../src/worker/context/runtime-context-source";
import { GitArtifactRepository } from "../../../src/worker/git/git-artifact-repository";
import { openTestDatabase } from "../../fixtures/test-database";

describe("RuntimeContextSource", () => {
  const fixtures: ReturnType<typeof openTestDatabase>[] = [];

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) {
      fixture.db.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("selects the newest bounded message window and returns it in timeline order", async () => {
    const fixture = openTestDatabase();
    fixtures.push(fixture);
    const insert = fixture.db.prepare(
      "INSERT INTO room_events(id, room_id, room_seq, event_type, actor, payload_json, created_at) VALUES (?, ?, ?, 'message.posted', 'user', ?, ?)"
    );
    fixture.db.transaction(() => {
      for (let sequence = 1; sequence <= 550; sequence += 1) {
        insert.run(
          `event-${sequence}`,
          fixture.records.room.id,
          sequence,
          JSON.stringify({ body: `message ${sequence}` }),
          `2026-07-31T12:${String(Math.floor(sequence / 60)).padStart(2, "0")}:${String(sequence % 60).padStart(2, "0")}.000Z`
        );
      }
    });
    const source = new RuntimeContextSource(
      fixture.db,
      new GitArtifactRepository(fixture.db)
    );

    const recent = await source.recentMessages(fixture.records.room.id, 40);

    expect(recent).toHaveLength(40);
    expect(recent[0]).toMatchObject({ eventId: "event-511", roomSeq: 511 });
    expect(recent.at(-1)).toMatchObject({ eventId: "event-550", roomSeq: 550 });
  });
});
