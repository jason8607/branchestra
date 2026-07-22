import { describe, expect, it, vi } from "vitest";
import { createTimelineStore } from "../../src/renderer/state/timeline-store";
import type {
  AppSnapshot,
  Project,
  Room,
  RoomEvent,
  RoomEventPage
} from "../../src/shared/contracts/domain";
import type { BranchestraApi } from "../../src/shared/contracts/renderer-api";
import type {
  RendererCommand,
  WorkerEventEnvelope,
  WorkerResponseEnvelope
} from "../../src/shared/contracts/protocol";

const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
const ROOM_ID = "20000000-0000-4000-8000-000000000001";
const GENERATION = "50000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-07-21T10:00:00.000Z";

function project(id = PROJECT_ID): Project {
  return {
    id,
    repositoryRoot: "/repo/branchestra",
    gitCommonDir: "/repo/branchestra/.git",
    displayName: "Branchestra",
    headOid: "a".repeat(40),
    defaultBranch: "main",
    createdAt: CREATED_AT
  };
}

function room(id = ROOM_ID, projectId = PROJECT_ID): Room {
  return { id, projectId, title: "Foundation", createdAt: CREATED_AT };
}

function foundationSnapshot(latestRoomSeq = 0): AppSnapshot {
  return {
    projects: [project()],
    rooms: [room()],
    roomCursors: { [ROOM_ID]: latestRoomSeq }
  };
}

function messageEvent(roomSeq: number, options: Partial<RoomEvent> = {}): RoomEvent {
  const suffix = String(roomSeq).padStart(12, "0");
  const eventId = `30000000-0000-4000-8000-${suffix}`;
  return {
    id: eventId,
    roomId: ROOM_ID,
    roomSeq,
    type: "message.posted",
    actor: "user",
    payload: {
      id: `40000000-0000-4000-8000-${suffix}`,
      roomId: ROOM_ID,
      body: `message ${roomSeq}`,
      createdAt: CREATED_AT
    },
    createdAt: CREATED_AT,
    ...options
  };
}

function eventPage(events: readonly RoomEvent[], hasMore: boolean): RoomEventPage {
  return {
    roomId: ROOM_ID,
    events: [...events],
    nextRoomSeq: events.at(-1)?.roomSeq ?? 0,
    hasMore
  };
}

function roomEventEnvelope(event: RoomEvent, generation = GENERATION): WorkerEventEnvelope {
  return {
    v: 1,
    requestId: "60000000-0000-4000-8000-000000000001",
    idempotencyKey: `live-${event.id}`,
    workerGeneration: generation,
    type: "room.event",
    payload: event
  };
}

function workerEvent(
  type: "worker.ready" | "worker.disconnected",
  workerGeneration: string
): WorkerEventEnvelope {
  return {
    v: 1,
    requestId: "60000000-0000-4000-8000-000000000002",
    idempotencyKey: `${type}-${workerGeneration}`,
    workerGeneration,
    type,
    payload: type === "worker.ready" ? { protocolVersion: 1 } : { reason: "worker exited" }
  } as WorkerEventEnvelope;
}

function sequentialIds(): () => string {
  let next = 1;
  return () => `70000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
}

function successResponse(command: RendererCommand, data: unknown): WorkerResponseEnvelope {
  return {
    v: 1,
    requestId: "80000000-0000-4000-8000-000000000001",
    idempotencyKey: command.idempotencyKey,
    workerGeneration: GENERATION,
    type: "response",
    payload: {
      ok: true,
      requestType: command.type,
      data: data as AppSnapshot,
      replayed: false
    }
  };
}

function failureResponse(command: RendererCommand, message: string): WorkerResponseEnvelope {
  return {
    v: 1,
    requestId: "80000000-0000-4000-8000-000000000002",
    idempotencyKey: command.idempotencyKey,
    workerGeneration: GENERATION,
    type: "response",
    payload: {
      ok: false,
      requestType: command.type,
      code: "INTERNAL",
      message
    }
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function apiHarness(
  handle: (command: RendererCommand) => Promise<WorkerResponseEnvelope> | WorkerResponseEnvelope
) {
  const listeners = new Set<(event: WorkerEventEnvelope) => void>();
  const commands: RendererCommand[] = [];
  const unsubscribe = vi.fn();
  const api: BranchestraApi = {
    request(command) {
      commands.push(command);
      return Promise.resolve(handle(command));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    }
  };
  return {
    api,
    commands,
    unsubscribe,
    emit(event: WorkerEventEnvelope) {
      for (const listener of listeners) listener(event);
    }
  };
}

interface TimelineApiFixture {
  api: BranchestraApi;
  replayCursors: number[];
  emit(event: WorkerEventEnvelope): void;
  queueReplay(page: RoomEventPage): void;
  setSnapshot(snapshot: AppSnapshot): void;
  flush(): Promise<void>;
}

function timelineApiFixture(options: {
  snapshot: AppSnapshot;
  replayPages?: readonly RoomEventPage[];
}): TimelineApiFixture {
  const listeners = new Set<(event: WorkerEventEnvelope) => void>();
  const replayPages = [...(options.replayPages ?? [])];
  const replayCursors: number[] = [];
  let snapshot = options.snapshot;
  let requestCount = 0;

  function response(
    command: RendererCommand,
    data: unknown
  ): WorkerResponseEnvelope {
    requestCount += 1;
    return {
      v: 1,
      requestId: `80000000-0000-4000-8000-${String(requestCount).padStart(12, "0")}`,
      idempotencyKey: command.idempotencyKey,
      workerGeneration: GENERATION,
      type: "response",
      payload: {
        ok: true,
        requestType: command.type,
        data: data as AppSnapshot,
        replayed: false
      }
    };
  }

  const api: BranchestraApi = {
    async request(command) {
      if (command.type === "state.getSnapshot") return response(command, snapshot);
      if (command.type === "room.replay") {
        replayCursors.push(command.payload.roomSeq);
        const page = replayPages.shift();
        if (!page) throw new Error("No queued replay page");
        return response(command, page);
      }
      throw new Error(`Unexpected command: ${command.type}`);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }
  };

  return {
    api,
    replayCursors,
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    queueReplay(page) {
      replayPages.push(page);
    },
    setSnapshot(nextSnapshot) {
      snapshot = nextSnapshot;
    },
    async flush() {
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    }
  };
}

describe("timeline store", () => {
  it("hydrates from snapshot, replays by cursor, ignores duplicates, and fills a gap", async () => {
    const fixture = timelineApiFixture({
      snapshot: foundationSnapshot(3),
      replayPages: [
        eventPage([messageEvent(1), messageEvent(2)], true),
        eventPage([messageEvent(3)], false)
      ]
    });
    const store = createTimelineStore(fixture.api, sequentialIds());

    await store.hydrate();

    expect(store.getState().eventsByRoom[ROOM_ID]?.map((event) => event.roomSeq)).toEqual([1, 2, 3]);
    expect(fixture.replayCursors).toEqual([0, 2]);
    fixture.emit(roomEventEnvelope(messageEvent(3)));
    expect(store.getState().eventsByRoom[ROOM_ID]).toHaveLength(3);

    fixture.queueReplay(eventPage([messageEvent(4)], false));
    fixture.emit(roomEventEnvelope(messageEvent(5)));
    await fixture.flush();

    expect(fixture.replayCursors.at(-1)).toBe(3);
    expect(store.getState().eventsByRoom[ROOM_ID]?.map((event) => event.roomSeq)).toEqual([1, 2, 3, 4, 5]);
    store.dispose();
  });

  it("preserves a valid selection and falls back within the selected project", async () => {
    const projectTwo = project("10000000-0000-4000-8000-000000000002");
    const roomTwo = room("20000000-0000-4000-8000-000000000002", projectTwo.id);
    const roomThree = room("20000000-0000-4000-8000-000000000003", projectTwo.id);
    const fixture = timelineApiFixture({
      snapshot: {
        projects: [project(), projectTwo],
        rooms: [room(), roomTwo, roomThree],
        roomCursors: { [ROOM_ID]: 0, [roomTwo.id]: 0, [roomThree.id]: 0 }
      },
      replayPages: [eventPage([], false), { ...eventPage([], false), roomId: roomTwo.id }]
    });
    const store = createTimelineStore(fixture.api, sequentialIds());
    await store.hydrate();

    await store.selectRoom(roomTwo.id);
    expect(store.getState()).toMatchObject({
      selectedProjectId: projectTwo.id,
      selectedRoomId: roomTwo.id
    });

    fixture.setSnapshot({
      projects: [project(), projectTwo],
      rooms: [room(), roomTwo, roomThree],
      roomCursors: { [ROOM_ID]: 0, [roomTwo.id]: 0, [roomThree.id]: 0 }
    });
    fixture.queueReplay({ ...eventPage([], false), roomId: roomTwo.id });
    await store.hydrate();
    expect(store.getState().selectedRoomId).toBe(roomTwo.id);

    fixture.setSnapshot({
      projects: [project(), projectTwo],
      rooms: [room(), roomThree],
      roomCursors: { [ROOM_ID]: 0, [roomThree.id]: 0 }
    });
    fixture.queueReplay({ ...eventPage([], false), roomId: roomThree.id });
    await store.hydrate();
    expect(store.getState()).toMatchObject({
      selectedProjectId: projectTwo.id,
      selectedRoomId: roomThree.id
    });
  });

  it("subscribes once and deduplicates concurrent hydration and room catch-up", async () => {
    const replay = deferred<WorkerResponseEnvelope>();
    const listeners = new Set<(event: WorkerEventEnvelope) => void>();
    const requests: RendererCommand[] = [];
    let subscriptions = 0;
    const api: BranchestraApi = {
      async request(command) {
        requests.push(command);
        if (command.type === "state.getSnapshot") {
          return successResponse(command, foundationSnapshot(1));
        }
        if (command.type === "room.replay") return replay.promise;
        throw new Error(`Unexpected command: ${command.type}`);
      },
      subscribe(listener) {
        subscriptions += 1;
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      }
    };
    const store = createTimelineStore(api, sequentialIds());

    const firstHydrate = store.hydrate();
    const secondHydrate = store.hydrate();
    await Promise.resolve();
    await Promise.resolve();
    const select = store.selectRoom(ROOM_ID);

    expect(subscriptions).toBe(1);
    expect(requests.filter((command) => command.type === "state.getSnapshot")).toHaveLength(1);
    expect(requests.filter((command) => command.type === "room.replay")).toHaveLength(1);

    const replayCommand = requests.find((command) => command.type === "room.replay");
    if (!replayCommand) throw new Error("Expected replay command");
    replay.resolve(successResponse(replayCommand, eventPage([messageEvent(1)], false)));
    await Promise.all([firstHydrate, secondHydrate, select]);
    expect(store.getState().eventsByRoom[ROOM_ID]).toHaveLength(1);
  });

  it("marks disconnects and rehydrates once for each newly ready worker generation", async () => {
    const nextGeneration = "50000000-0000-4000-8000-000000000002";
    const fixture = timelineApiFixture({
      snapshot: foundationSnapshot(0),
      replayPages: [eventPage([], false), eventPage([], false), eventPage([], false)]
    });
    const store = createTimelineStore(fixture.api, sequentialIds());
    await store.hydrate();

    fixture.emit(workerEvent("worker.disconnected", GENERATION));
    expect(store.getState().connection).toBe("reconnecting");

    fixture.emit(workerEvent("worker.ready", GENERATION));
    await fixture.flush();
    fixture.emit(workerEvent("worker.ready", GENERATION));
    await fixture.flush();
    fixture.emit(workerEvent("worker.ready", nextGeneration));
    await fixture.flush();

    expect(fixture.replayCursors).toEqual([0, 0, 0]);
    expect(store.getState()).toMatchObject({ connection: "ready", error: null });
  });

  it("stops replay when a page claims more data without advancing the cursor", async () => {
    const fixture = timelineApiFixture({
      snapshot: foundationSnapshot(1),
      replayPages: [eventPage([], true)]
    });
    const store = createTimelineStore(fixture.api, sequentialIds());

    await store.hydrate();

    expect(fixture.replayCursors).toEqual([0]);
    expect(store.getState()).toMatchObject({
      connection: "error",
      error: "Replay did not advance after room sequence 0"
    });
  });

  it("ignores a different event that reuses an accepted room sequence", async () => {
    const fixture = timelineApiFixture({
      snapshot: foundationSnapshot(1),
      replayPages: [eventPage([messageEvent(1)], false)]
    });
    const store = createTimelineStore(fixture.api, sequentialIds());
    await store.hydrate();

    fixture.emit(roomEventEnvelope(messageEvent(2, { roomSeq: 1 })));

    expect(store.getState()).toMatchObject({ connection: "ready", error: null });
    expect(store.getState().eventsByRoom[ROOM_ID]?.map((event) => event.id)).toEqual([
      messageEvent(1).id
    ]);
  });

  it("creates a room with one trimmed mutation and selects it after refreshing the snapshot", async () => {
    const createdRoom = room("20000000-0000-4000-8000-000000000002");
    let snapshotRequests = 0;
    const fixture = apiHarness((command) => {
      if (command.type === "state.getSnapshot") {
        snapshotRequests += 1;
        return successResponse(command, snapshotRequests === 1
          ? foundationSnapshot(0)
          : {
              projects: [project()],
              rooms: [room(), createdRoom],
              roomCursors: { [ROOM_ID]: 0, [createdRoom.id]: 0 }
            });
      }
      if (command.type === "room.replay") {
        return successResponse(command, {
          roomId: command.payload.roomId,
          events: [],
          nextRoomSeq: command.payload.roomSeq,
          hasMore: false
        });
      }
      if (command.type === "room.create") return successResponse(command, createdRoom);
      throw new Error(`Unexpected command: ${command.type}`);
    });
    const nextId = vi.fn(sequentialIds());
    const store = createTimelineStore(fixture.api, nextId);
    await store.hydrate();

    await store.createRoom(PROJECT_ID, "  New room  ");

    const createCommands = fixture.commands.filter((command) => command.type === "room.create");
    expect(createCommands).toHaveLength(1);
    expect(createCommands[0]).toMatchObject({
      payload: { projectId: PROJECT_ID, title: "New room" },
      idempotencyKey: expect.any(String)
    });
    expect(store.getState()).toMatchObject({
      connection: "ready",
      selectedProjectId: PROJECT_ID,
      selectedRoomId: createdRoom.id
    });
  });

  it("posts one trimmed message and suppresses its later live duplicate", async () => {
    const posted = messageEvent(1);
    const fixture = apiHarness((command) => {
      if (command.type === "state.getSnapshot") {
        return successResponse(command, foundationSnapshot(0));
      }
      if (command.type === "room.replay") {
        return successResponse(command, eventPage([], false));
      }
      if (command.type === "message.post") return successResponse(command, posted);
      throw new Error(`Unexpected command: ${command.type}`);
    });
    const store = createTimelineStore(fixture.api, sequentialIds());
    await store.hydrate();

    await store.postMessage(ROOM_ID, "  hello timeline  ");
    fixture.emit(roomEventEnvelope(posted));

    const postCommands = fixture.commands.filter((command) => command.type === "message.post");
    expect(postCommands).toHaveLength(1);
    expect(postCommands[0]).toMatchObject({
      payload: { roomId: ROOM_ID, body: "hello timeline" },
      idempotencyKey: expect.any(String)
    });
    expect(store.getState().eventsByRoom[ROOM_ID]).toEqual([posted]);
  });

  it("picks an existing project with an empty payload and refreshes after creation", async () => {
    const addedProject = project("10000000-0000-4000-8000-000000000002");
    let snapshotRequests = 0;
    const fixture = apiHarness((command) => {
      if (command.type === "state.getSnapshot") {
        snapshotRequests += 1;
        return successResponse(command, snapshotRequests === 1
          ? foundationSnapshot(0)
          : {
              projects: [project(), addedProject],
              rooms: [room()],
              roomCursors: { [ROOM_ID]: 0 }
            });
      }
      if (command.type === "room.replay") return successResponse(command, eventPage([], false));
      if (command.type === "project.pickExisting") return successResponse(command, addedProject);
      throw new Error(`Unexpected command: ${command.type}`);
    });
    const store = createTimelineStore(fixture.api, sequentialIds());
    await store.hydrate();

    await store.addProject();

    const projectCommands = fixture.commands.filter((command) => (
      command.type === "project.pickExisting"
    ));
    expect(projectCommands).toHaveLength(1);
    expect(projectCommands[0]).toEqual({
      type: "project.pickExisting",
      payload: {},
      idempotencyKey: projectCommands[0]?.idempotencyKey
    });
    expect(store.getState().snapshot.projects).toEqual([project(), addedProject]);
  });

  it("rejects whitespace-only room titles and messages before issuing mutations", async () => {
    const fixture = timelineApiFixture({
      snapshot: foundationSnapshot(0),
      replayPages: [eventPage([], false)]
    });
    const store = createTimelineStore(fixture.api, sequentialIds());
    await store.hydrate();

    await expect(store.createRoom(PROJECT_ID, "   ")).rejects.toThrow("Room title is required");
    await expect(store.postMessage(ROOM_ID, "\n\t ")).rejects.toThrow("Message body is required");
    expect(fixture.replayCursors).toEqual([0]);
  });

  it("exposes a safe mutation error response without retrying with another key", async () => {
    const fixture = apiHarness((command) => {
      if (command.type === "state.getSnapshot") {
        return successResponse(command, foundationSnapshot(0));
      }
      if (command.type === "room.replay") return successResponse(command, eventPage([], false));
      if (command.type === "message.post") {
        return failureResponse(command, "That room is no longer available");
      }
      throw new Error(`Unexpected command: ${command.type}`);
    });
    const store = createTimelineStore(fixture.api, sequentialIds());
    await store.hydrate();

    await store.postMessage(ROOM_ID, "hello");

    expect(fixture.commands.filter((command) => command.type === "message.post")).toHaveLength(1);
    expect(store.getState()).toMatchObject({
      connection: "error",
      error: "That room is no longer available"
    });
  });

  it("uses a safe store error when a successful mutation contains invalid data", async () => {
    const fixture = apiHarness((command) => {
      if (command.type === "state.getSnapshot") {
        return successResponse(command, foundationSnapshot(0));
      }
      if (command.type === "room.replay") return successResponse(command, eventPage([], false));
      if (command.type === "message.post") return successResponse(command, project());
      throw new Error(`Unexpected command: ${command.type}`);
    });
    const store = createTimelineStore(fixture.api, sequentialIds());
    await store.hydrate();

    await store.postMessage(ROOM_ID, "hello");

    expect(store.getState()).toMatchObject({
      connection: "error",
      error: "Unable to post message"
    });
  });

  it("disposes its worker subscription and blocks late hydration work and notifications", async () => {
    const snapshot = deferred<WorkerResponseEnvelope>();
    const listener = vi.fn();
    const fixture = apiHarness((command) => {
      if (command.type === "state.getSnapshot") return snapshot.promise;
      throw new Error(`Late request after disposal: ${command.type}`);
    });
    const store = createTimelineStore(fixture.api, sequentialIds());
    store.subscribe(listener);
    const hydration = store.hydrate();
    await Promise.resolve();
    const snapshotCommand = fixture.commands[0];
    if (!snapshotCommand) throw new Error("Expected snapshot command");
    listener.mockClear();

    store.dispose();
    snapshot.resolve(successResponse(snapshotCommand, foundationSnapshot(1)));
    await hydration;

    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
    expect(fixture.commands).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({
      connection: "bootstrapping",
      selectedProjectId: null,
      selectedRoomId: null
    });
  });

  it("exposes deeply frozen snapshot and event state", async () => {
    const fixture = timelineApiFixture({
      snapshot: foundationSnapshot(1),
      replayPages: [eventPage([messageEvent(1)], false)]
    });
    const store = createTimelineStore(fixture.api, sequentialIds());
    await store.hydrate();
    const state = store.getState();
    const events = state.eventsByRoom[ROOM_ID];

    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.snapshot)).toBe(true);
    expect(Object.isFrozen(state.snapshot.projects)).toBe(true);
    expect(Object.isFrozen(state.snapshot.projects[0])).toBe(true);
    expect(Object.isFrozen(state.eventsByRoom)).toBe(true);
    expect(Object.isFrozen(events)).toBe(true);
    expect(Object.isFrozen(events?.[0])).toBe(true);
    expect(Object.isFrozen(events?.[0]?.payload)).toBe(true);
  });

  it("does not sort replay events across a sequence gap", async () => {
    const fixture = timelineApiFixture({
      snapshot: foundationSnapshot(3),
      replayPages: [eventPage([messageEvent(1), messageEvent(3), messageEvent(2)], false)]
    });
    const store = createTimelineStore(fixture.api, sequentialIds());

    await store.hydrate();

    expect(store.getState().eventsByRoom[ROOM_ID]).toBeUndefined();
    expect(store.getState()).toMatchObject({
      connection: "error",
      error: "Room event sequence gap after 1"
    });
  });

  it("deduplicates a reused event ID regardless of differing content", async () => {
    const fixture = timelineApiFixture({
      snapshot: foundationSnapshot(1),
      replayPages: [eventPage([messageEvent(1)], false)]
    });
    const store = createTimelineStore(fixture.api, sequentialIds());
    await store.hydrate();

    fixture.emit(roomEventEnvelope(messageEvent(2, { id: messageEvent(1).id })));

    expect(store.getState()).toMatchObject({ connection: "ready", error: null });
    expect(store.getState().eventsByRoom[ROOM_ID]).toHaveLength(1);
  });

  it("handles a next live event that races with an in-flight gap replay", async () => {
    const gapReplay = deferred<WorkerResponseEnvelope>();
    let replayRequests = 0;
    const fixture = apiHarness((command) => {
      if (command.type === "state.getSnapshot") {
        return successResponse(command, foundationSnapshot(3));
      }
      if (command.type === "room.replay") {
        replayRequests += 1;
        if (replayRequests === 1) {
          return successResponse(command, eventPage([
            messageEvent(1), messageEvent(2), messageEvent(3)
          ], false));
        }
        return gapReplay.promise;
      }
      throw new Error(`Unexpected command: ${command.type}`);
    });
    const store = createTimelineStore(fixture.api, sequentialIds());
    await store.hydrate();

    fixture.emit(roomEventEnvelope(messageEvent(5)));
    await Promise.resolve();
    fixture.emit(roomEventEnvelope(messageEvent(4)));
    const gapCommand = fixture.commands.filter((command) => command.type === "room.replay")[1];
    if (!gapCommand) throw new Error("Expected gap replay command");
    gapReplay.resolve(successResponse(gapCommand, eventPage([messageEvent(4)], false)));
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();

    expect(store.getState().eventsByRoom[ROOM_ID]?.map((event) => event.roomSeq)).toEqual([
      1, 2, 3, 4, 5
    ]);
    expect(store.getState().connection).toBe("ready");
  });

  it("does not expose validation internals from a malformed snapshot response", async () => {
    const fixture = apiHarness((command) => successResponse(command, { projects: [] }));
    const store = createTimelineStore(fixture.api, sequentialIds());

    await store.hydrate();

    expect(store.getState()).toMatchObject({
      connection: "error",
      error: "Unable to load application state"
    });
  });

  it("starts new-generation hydration without joining an old replay and ignores its rejection", async () => {
    const nextGeneration = "50000000-0000-4000-8000-000000000002";
    const oldReplay = deferred<WorkerResponseEnvelope>();
    const commands: RendererCommand[] = [];
    const listeners = new Set<(event: WorkerEventEnvelope) => void>();
    let snapshotRequests = 0;
    const api: BranchestraApi = {
      async request(command) {
        commands.push(command);
        if (command.type === "state.getSnapshot") {
          snapshotRequests += 1;
          return successResponse(command, foundationSnapshot(snapshotRequests === 1 ? 1 : 0));
        }
        if (command.type === "room.replay") {
          if (command.payload.roomSeq === 0 && snapshotRequests === 1) return oldReplay.promise;
          return successResponse(command, eventPage([], false));
        }
        throw new Error(`Unexpected command: ${command.type}`);
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      }
    };
    const store = createTimelineStore(api, sequentialIds());
    const oldHydration = store.hydrate();
    for (let turn = 0; turn < 3; turn += 1) await Promise.resolve();

    for (const listener of listeners) listener(workerEvent("worker.ready", nextGeneration));
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();

    expect(commands.filter((command) => command.type === "state.getSnapshot")).toHaveLength(2);
    oldReplay.reject(new Error("old replay failed"));
    await oldHydration;
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    expect(store.getState()).toMatchObject({ connection: "ready", error: null });
  });

  it("ignores a mutation rejection from an obsolete worker generation", async () => {
    const nextGeneration = "50000000-0000-4000-8000-000000000002";
    const oldMutation = deferred<WorkerResponseEnvelope>();
    const fixture = apiHarness((command) => {
      if (command.type === "state.getSnapshot") {
        return successResponse(command, foundationSnapshot(0));
      }
      if (command.type === "room.replay") return successResponse(command, eventPage([], false));
      if (command.type === "message.post") return oldMutation.promise;
      throw new Error(`Unexpected command: ${command.type}`);
    });
    const store = createTimelineStore(fixture.api, sequentialIds());
    const listener = vi.fn();
    store.subscribe(listener);
    await store.hydrate();
    const posting = store.postMessage(ROOM_ID, "old generation");
    await Promise.resolve();

    fixture.emit(workerEvent("worker.ready", nextGeneration));
    for (let turn = 0; turn < 20; turn += 1) {
      await Promise.resolve();
      const snapshots = fixture.commands.filter((command) => command.type === "state.getSnapshot");
      if (snapshots.length === 2 && store.getState().connection === "ready") break;
    }
    expect(fixture.commands.filter((command) => command.type === "state.getSnapshot")).toHaveLength(2);
    expect(store.getState().connection).toBe("ready");
    const notificationsBeforeRejection = listener.mock.calls.length;
    oldMutation.reject(new Error("obsolete mutation failed"));
    await posting;

    expect(store.getState()).toMatchObject({ connection: "ready", error: null });
    expect(store.getState().eventsByRoom[ROOM_ID]).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(notificationsBeforeRejection);
  });

  it("ignores a successful mutation response from an obsolete worker generation", async () => {
    const nextGeneration = "50000000-0000-4000-8000-000000000002";
    const oldMutation = deferred<WorkerResponseEnvelope>();
    const fixture = apiHarness((command) => {
      if (command.type === "state.getSnapshot") {
        return successResponse(command, foundationSnapshot(0));
      }
      if (command.type === "room.replay") return successResponse(command, eventPage([], false));
      if (command.type === "message.post") return oldMutation.promise;
      throw new Error(`Unexpected command: ${command.type}`);
    });
    const store = createTimelineStore(fixture.api, sequentialIds());
    await store.hydrate();
    const posting = store.postMessage(ROOM_ID, "old success");
    await Promise.resolve();
    fixture.emit(workerEvent("worker.ready", nextGeneration));
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    const postCommand = fixture.commands.find((command) => command.type === "message.post");
    if (!postCommand) throw new Error("Expected old message mutation");

    oldMutation.resolve(successResponse(postCommand, messageEvent(1)));
    await posting;

    expect(store.getState()).toMatchObject({ connection: "ready", error: null });
    expect(store.getState().eventsByRoom[ROOM_ID]).toBeUndefined();
  });

  it("starts a fresh snapshot after a successful project mutation instead of joining an older hydrate", async () => {
    const preMutationSnapshot = deferred<WorkerResponseEnvelope>();
    const addedProject = project("10000000-0000-4000-8000-000000000002");
    let snapshotRequests = 0;
    const fixture = apiHarness((command) => {
      if (command.type === "state.getSnapshot") {
        snapshotRequests += 1;
        if (snapshotRequests === 1) return preMutationSnapshot.promise;
        return successResponse(command, {
          projects: [project(), addedProject],
          rooms: [room()],
          roomCursors: { [ROOM_ID]: 0 }
        });
      }
      if (command.type === "room.replay") return successResponse(command, eventPage([], false));
      if (command.type === "project.pickExisting") return successResponse(command, addedProject);
      throw new Error(`Unexpected command: ${command.type}`);
    });
    const store = createTimelineStore(fixture.api, sequentialIds());
    const oldHydration = store.hydrate();
    await Promise.resolve();
    const adding = store.addProject();
    for (let turn = 0; turn < 3; turn += 1) await Promise.resolve();
    const firstSnapshotCommand = fixture.commands.find((command) => (
      command.type === "state.getSnapshot"
    ));
    if (!firstSnapshotCommand) throw new Error("Expected pre-mutation snapshot request");

    preMutationSnapshot.resolve(successResponse(firstSnapshotCommand, foundationSnapshot(0)));
    await Promise.all([oldHydration, adding]);

    expect(snapshotRequests).toBe(2);
    expect(store.getState().snapshot.projects).toEqual([project(), addedProject]);
  });

  it("sets an error and rejects selectRoom when its replay response fails", async () => {
    const roomTwo = room("20000000-0000-4000-8000-000000000002");
    const fixture = apiHarness((command) => {
      if (command.type === "state.getSnapshot") {
        return successResponse(command, {
          projects: [project()],
          rooms: [room(), roomTwo],
          roomCursors: { [ROOM_ID]: 0, [roomTwo.id]: 0 }
        });
      }
      if (command.type === "room.replay" && command.payload.roomId === ROOM_ID) {
        return successResponse(command, eventPage([], false));
      }
      if (command.type === "room.replay") return failureResponse(command, "Replay unavailable");
      throw new Error(`Unexpected command: ${command.type}`);
    });
    const store = createTimelineStore(fixture.api, sequentialIds());
    await store.hydrate();

    await expect(store.selectRoom(roomTwo.id)).rejects.toThrow("Replay unavailable");

    expect(store.getState()).toMatchObject({
      connection: "error",
      error: "Replay unavailable",
      selectedRoomId: roomTwo.id
    });
  });

  it("performs no API or ID-generator side effects for public commands after disposal", async () => {
    const fixture = apiHarness((command) => {
      if (command.type === "state.getSnapshot") {
        return successResponse(command, foundationSnapshot(0));
      }
      if (command.type === "room.replay") return successResponse(command, eventPage([], false));
      throw new Error(`Unexpected command after setup: ${command.type}`);
    });
    const nextId = vi.fn(sequentialIds());
    const store = createTimelineStore(fixture.api, nextId);
    await store.hydrate();
    store.dispose();
    fixture.commands.length = 0;
    nextId.mockClear();

    await store.hydrate();
    await store.selectRoom(ROOM_ID);
    await store.addProject();
    await store.createRoom(PROJECT_ID, "Later");
    await store.postMessage(ROOM_ID, "Later");

    expect(fixture.commands).toEqual([]);
    expect(nextId).not.toHaveBeenCalled();
  });

  it("rejects a replay page containing an event for a different room", async () => {
    const otherRoomId = "20000000-0000-4000-8000-000000000002";
    const otherRoomEvent = messageEvent(1, {
      roomId: otherRoomId,
      payload: { ...messageEvent(1).payload, roomId: otherRoomId }
    });
    const fixture = timelineApiFixture({
      snapshot: foundationSnapshot(0),
      replayPages: [{ ...eventPage([otherRoomEvent], false), roomId: ROOM_ID }]
    });
    const store = createTimelineStore(fixture.api, sequentialIds());

    await store.hydrate();

    expect(store.getState()).toMatchObject({
      connection: "error",
      error: "Replay event room does not match request"
    });
    expect(store.getState().eventsByRoom).toEqual({});
  });

  it("rejects a replay page whose next cursor lies about its event tail", async () => {
    const fixture = timelineApiFixture({
      snapshot: foundationSnapshot(1),
      replayPages: [{ ...eventPage([messageEvent(1)], false), nextRoomSeq: 2 }]
    });
    const store = createTimelineStore(fixture.api, sequentialIds());

    await store.hydrate();

    expect(store.getState()).toMatchObject({
      connection: "error",
      error: "Replay nextRoomSeq does not match page tail"
    });
    expect(store.getState().eventsByRoom).toEqual({});
  });

  it("continues notifying and hydrating when one store subscriber throws", async () => {
    const fixture = timelineApiFixture({
      snapshot: foundationSnapshot(0),
      replayPages: [eventPage([], false)]
    });
    const laterListener = vi.fn();
    const store = createTimelineStore(fixture.api, sequentialIds());
    store.subscribe(() => { throw new Error("subscriber failed"); });
    store.subscribe(laterListener);

    await store.hydrate();

    expect(fixture.replayCursors).toEqual([0]);
    expect(laterListener).toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ connection: "ready", error: null });
  });

  it("invalidates pending mutation failures as soon as the worker disconnects", async () => {
    const mutation = deferred<WorkerResponseEnvelope>();
    const fixture = apiHarness((command) => {
      if (command.type === "state.getSnapshot") {
        return successResponse(command, foundationSnapshot(0));
      }
      if (command.type === "room.replay") return successResponse(command, eventPage([], false));
      if (command.type === "message.post") return mutation.promise;
      throw new Error(`Unexpected command: ${command.type}`);
    });
    const store = createTimelineStore(fixture.api, sequentialIds());
    await store.hydrate();
    const posting = store.postMessage(ROOM_ID, "pending");
    await Promise.resolve();

    fixture.emit(workerEvent("worker.disconnected", GENERATION));
    mutation.reject(new Error("disconnected mutation failed"));
    await posting;

    expect(store.getState()).toMatchObject({ connection: "reconnecting", error: null });
  });

  it("refreshes after a room mutation that races an older hydrate before selecting the room", async () => {
    const preMutationSnapshot = deferred<WorkerResponseEnvelope>();
    const createdRoom = room("20000000-0000-4000-8000-000000000002");
    let snapshotRequests = 0;
    const fixture = apiHarness((command) => {
      if (command.type === "state.getSnapshot") {
        snapshotRequests += 1;
        if (snapshotRequests === 1) return preMutationSnapshot.promise;
        return successResponse(command, {
          projects: [project()],
          rooms: [room(), createdRoom],
          roomCursors: { [ROOM_ID]: 0, [createdRoom.id]: 0 }
        });
      }
      if (command.type === "room.replay") {
        return successResponse(command, {
          roomId: command.payload.roomId,
          events: [],
          nextRoomSeq: command.payload.roomSeq,
          hasMore: false
        });
      }
      if (command.type === "room.create") return successResponse(command, createdRoom);
      throw new Error(`Unexpected command: ${command.type}`);
    });
    const store = createTimelineStore(fixture.api, sequentialIds());
    const oldHydration = store.hydrate();
    await Promise.resolve();
    const creating = store.createRoom(PROJECT_ID, "Fresh room");
    for (let turn = 0; turn < 3; turn += 1) await Promise.resolve();
    const firstSnapshotCommand = fixture.commands.find((command) => (
      command.type === "state.getSnapshot"
    ));
    if (!firstSnapshotCommand) throw new Error("Expected pre-mutation snapshot request");

    preMutationSnapshot.resolve(successResponse(firstSnapshotCommand, foundationSnapshot(0)));
    await Promise.all([oldHydration, creating]);

    expect(snapshotRequests).toBe(2);
    expect(store.getState()).toMatchObject({
      connection: "ready",
      selectedRoomId: createdRoom.id
    });
  });

  it("rejects a replay page labeled for a different room", async () => {
    const otherRoomId = "20000000-0000-4000-8000-000000000002";
    const fixture = timelineApiFixture({
      snapshot: foundationSnapshot(0),
      replayPages: [{ ...eventPage([], false), roomId: otherRoomId }]
    });
    const store = createTimelineStore(fixture.api, sequentialIds());

    await store.hydrate();

    expect(store.getState()).toMatchObject({
      connection: "error",
      error: "Replay response room does not match request"
    });
  });

  it("rejects a replay cursor that regresses behind the requested sequence", async () => {
    const fixture = timelineApiFixture({
      snapshot: foundationSnapshot(1),
      replayPages: [eventPage([messageEvent(1)], false)]
    });
    const store = createTimelineStore(fixture.api, sequentialIds());
    await store.hydrate();
    fixture.queueReplay(eventPage([], false));

    await expect(store.selectRoom(ROOM_ID)).rejects.toThrow("Replay nextRoomSeq regressed");

    expect(store.getState()).toMatchObject({
      connection: "error",
      error: "Replay nextRoomSeq regressed"
    });
    expect(store.getState().eventsByRoom[ROOM_ID]).toHaveLength(1);
  });

  it("sets a safe error and rejects selectRoom when replay data fails schema parsing", async () => {
    const roomTwo = room("20000000-0000-4000-8000-000000000002");
    const fixture = apiHarness((command) => {
      if (command.type === "state.getSnapshot") {
        return successResponse(command, {
          projects: [project()],
          rooms: [room(), roomTwo],
          roomCursors: { [ROOM_ID]: 0, [roomTwo.id]: 0 }
        });
      }
      if (command.type === "room.replay" && command.payload.roomId === ROOM_ID) {
        return successResponse(command, eventPage([], false));
      }
      if (command.type === "room.replay") return successResponse(command, project());
      throw new Error(`Unexpected command: ${command.type}`);
    });
    const store = createTimelineStore(fixture.api, sequentialIds());
    await store.hydrate();

    await expect(store.selectRoom(roomTwo.id)).rejects.toThrow("Unable to replay room events");
    expect(store.getState()).toMatchObject({
      connection: "error",
      error: "Unable to replay room events"
    });
  });

  it("ignores late live events from a disconnected generation before the replacement is ready", async () => {
    const nextGeneration = "50000000-0000-4000-8000-000000000002";
    const fixture = timelineApiFixture({
      snapshot: foundationSnapshot(0),
      replayPages: [eventPage([], false), eventPage([], false)]
    });
    const store = createTimelineStore(fixture.api, sequentialIds());
    await store.hydrate();

    fixture.emit(workerEvent("worker.disconnected", GENERATION));
    fixture.emit(roomEventEnvelope(messageEvent(1), GENERATION));
    expect(store.getState().eventsByRoom[ROOM_ID]).toBeUndefined();

    fixture.emit(workerEvent("worker.ready", nextGeneration));
    await fixture.flush();
    expect(store.getState()).toMatchObject({ connection: "ready", error: null });
    expect(store.getState().eventsByRoom[ROOM_ID]).toBeUndefined();
  });

  it("does not let an older hydrate clear a newer room-selection replay error", async () => {
    const roomTwo = room("20000000-0000-4000-8000-000000000002");
    const oldRoomReplay = deferred<WorkerResponseEnvelope>();
    const fixture = apiHarness((command) => {
      if (command.type === "state.getSnapshot") {
        return successResponse(command, {
          projects: [project()],
          rooms: [room(), roomTwo],
          roomCursors: { [ROOM_ID]: 0, [roomTwo.id]: 0 }
        });
      }
      if (command.type === "room.replay" && command.payload.roomId === ROOM_ID) {
        return oldRoomReplay.promise;
      }
      if (command.type === "room.replay") return failureResponse(command, "Room B replay failed");
      throw new Error(`Unexpected command: ${command.type}`);
    });
    const store = createTimelineStore(fixture.api, sequentialIds());
    const oldHydration = store.hydrate();
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();

    await expect(store.selectRoom(roomTwo.id)).rejects.toThrow("Room B replay failed");
    expect(store.getState()).toMatchObject({ connection: "error", error: "Room B replay failed" });
    const oldReplayCommand = fixture.commands.find((command) => (
      command.type === "room.replay" && command.payload.roomId === ROOM_ID
    ));
    if (!oldReplayCommand) throw new Error("Expected older Room A replay");
    oldRoomReplay.resolve(successResponse(oldReplayCommand, eventPage([], false)));
    await oldHydration;

    expect(store.getState()).toMatchObject({
      connection: "error",
      error: "Room B replay failed",
      selectedRoomId: roomTwo.id
    });
  });

  it("rejects an unsorted duplicate tail against the actually accepted cursor atomically", async () => {
    const duplicateTailPage: RoomEventPage = {
      roomId: ROOM_ID,
      events: [messageEvent(1), messageEvent(2), messageEvent(1)],
      nextRoomSeq: 1,
      hasMore: false
    };
    const fixture = timelineApiFixture({
      snapshot: foundationSnapshot(2),
      replayPages: [duplicateTailPage]
    });
    const store = createTimelineStore(fixture.api, sequentialIds());

    await store.hydrate();

    expect(store.getState()).toMatchObject({
      connection: "error",
      error: "Replay nextRoomSeq does not match accepted cursor"
    });
    expect(store.getState().eventsByRoom).toEqual({});
  });

  it("rejects a reused event ID at a higher sequence against the accepted cursor atomically", async () => {
    const reusedIdPage: RoomEventPage = {
      roomId: ROOM_ID,
      events: [messageEvent(1), messageEvent(2, { id: messageEvent(1).id })],
      nextRoomSeq: 2,
      hasMore: false
    };
    const fixture = timelineApiFixture({
      snapshot: foundationSnapshot(2),
      replayPages: [reusedIdPage]
    });
    const store = createTimelineStore(fixture.api, sequentialIds());

    await store.hydrate();

    expect(store.getState()).toMatchObject({
      connection: "error",
      error: "Replay nextRoomSeq does not match accepted cursor"
    });
    expect(store.getState().eventsByRoom).toEqual({});
  });
});
