import {
  AppSnapshotSchema,
  ProjectSchema,
  RoomEventPageSchema,
  RoomEventSchema,
  RoomSchema,
  type AppSnapshot,
  type RoomEvent
} from "../../shared/contracts/domain";
import type { BranchestraApi } from "../../shared/contracts/renderer-api";

export interface TimelineState {
  connection: "bootstrapping" | "ready" | "reconnecting" | "error";
  snapshot: AppSnapshot;
  selectedProjectId: string | null;
  selectedRoomId: string | null;
  eventsByRoom: Readonly<Record<string, readonly RoomEvent[]>>;
  error: string | null;
}

export interface TimelineStore {
  getState(): TimelineState;
  subscribe(listener: () => void): () => void;
  hydrate(): Promise<void>;
  selectRoom(roomId: string): Promise<void>;
  addProject(): Promise<void>;
  createRoom(projectId: string, title: string): Promise<void>;
  postMessage(roomId: string, body: string): Promise<void>;
  dispose(): void;
}

const EMPTY_SNAPSHOT: AppSnapshot = { projects: [], rooms: [], roomCursors: {} };
Object.freeze(EMPTY_SNAPSHOT.projects);
Object.freeze(EMPTY_SNAPSHOT.rooms);
Object.freeze(EMPTY_SNAPSHOT.roomCursors);
Object.freeze(EMPTY_SNAPSHOT);

function immutableSnapshot(snapshot: AppSnapshot): AppSnapshot {
  const copy: AppSnapshot = {
    projects: snapshot.projects.map((project) => Object.freeze({ ...project })),
    rooms: snapshot.rooms.map((room) => Object.freeze({ ...room })),
    roomCursors: { ...snapshot.roomCursors }
  };
  Object.freeze(copy.projects);
  Object.freeze(copy.rooms);
  Object.freeze(copy.roomCursors);
  return Object.freeze(copy);
}

function immutableEvent(event: RoomEvent): RoomEvent {
  return Object.freeze({
    ...event,
    payload: Object.freeze({ ...event.payload })
  });
}

export function createTimelineStore(
  api: BranchestraApi,
  nextId: () => string = () => crypto.randomUUID()
): TimelineStore {
  const listeners = new Set<() => void>();
  const catches = new Map<string, { epoch: number; promise: Promise<void> }>();
  let disposed = false;
  let lifecycleEpoch = 0;
  let hydrateTask: { epoch: number; promise: Promise<void> } | null = null;
  let refreshTail: { epoch: number; promise: Promise<void> } | null = null;
  let workerGeneration: string | null = null;
  let hasHydrated = false;
  let state: TimelineState = Object.freeze({
    connection: "bootstrapping",
    snapshot: EMPTY_SNAPSHOT,
    selectedProjectId: null,
    selectedRoomId: null,
    eventsByRoom: Object.freeze({}),
    error: null
  });

  function replaceState(next: TimelineState): void {
    if (disposed) return;
    state = Object.freeze(next);
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        continue;
      }
    }
  }

  function patchState(patch: Partial<TimelineState>): void {
    replaceState({ ...state, ...patch });
  }

  function isCurrent(epoch: number): boolean {
    return !disposed && epoch === lifecycleEpoch;
  }

  function patchCurrent(epoch: number, patch: Partial<TimelineState>): void {
    if (isCurrent(epoch)) patchState(patch);
  }

  function currentSequence(roomId: string): number {
    return state.eventsByRoom[roomId]?.at(-1)?.roomSeq ?? 0;
  }

  function acceptEvent(event: RoomEvent, epoch = lifecycleEpoch): void {
    if (!isCurrent(epoch)) return;
    const eventWithSameId = Object.values(state.eventsByRoom)
      .flatMap((events) => events)
      .find((candidate) => candidate.id === event.id);
    if (eventWithSameId) return;
    const current = currentSequence(event.roomId);
    if (event.roomSeq <= current) return;
    if (event.roomSeq !== current + 1) {
      throw new Error(`Room event sequence gap after ${current}`);
    }
    const events = Object.freeze([
      ...(state.eventsByRoom[event.roomId] ?? []),
      immutableEvent(event)
    ]);
    patchState({
      eventsByRoom: Object.freeze({ ...state.eventsByRoom, [event.roomId]: events })
    });
  }

  async function runCatchUp(roomId: string, epoch: number): Promise<void> {
    while (true) {
      if (!isCurrent(epoch)) return;
      const cursor = currentSequence(roomId);
      const response = await api.request({
        type: "room.replay",
        payload: { roomId, roomSeq: cursor, limit: 200 },
        idempotencyKey: nextId()
      });
      if (!isCurrent(epoch)) return;
      if (!response.payload.ok) throw new Error(response.payload.message);
      const parsedPage = RoomEventPageSchema.safeParse(response.payload.data);
      if (!parsedPage.success) throw new Error("Unable to replay room events");
      const page = parsedPage.data;
      if (page.roomId !== roomId) throw new Error("Replay response room does not match request");
      if (page.events.some((event) => event.roomId !== roomId)) {
        throw new Error("Replay event room does not match request");
      }
      if (page.nextRoomSeq < cursor) throw new Error("Replay nextRoomSeq regressed");
      const pageTail = page.events.at(-1)?.roomSeq ?? cursor;
      if (page.nextRoomSeq !== pageTail) {
        throw new Error("Replay nextRoomSeq does not match page tail");
      }
      for (const event of page.events) {
        acceptEvent(event, epoch);
      }
      const nextCursor = currentSequence(roomId);
      const needsMore = page.hasMore
        || nextCursor < (state.snapshot.roomCursors[roomId] ?? 0);
      if (nextCursor === cursor && needsMore) {
        throw new Error(`Replay did not advance after room sequence ${cursor}`);
      }
      if (!needsMore) return;
    }
  }

  function catchUp(roomId: string, epoch = lifecycleEpoch): Promise<void> {
    if (!isCurrent(epoch)) return Promise.resolve();
    const existing = catches.get(roomId);
    if (existing?.epoch === epoch) return existing.promise;
    const entry = { epoch, promise: Promise.resolve() };
    entry.promise = runCatchUp(roomId, epoch).finally(() => {
      if (catches.get(roomId) === entry) catches.delete(roomId);
    });
    catches.set(roomId, entry);
    return entry.promise;
  }

  const unsubscribe = api.subscribe((envelope) => {
    if (disposed) return;
    if (envelope.type === "room.event") {
      if (workerGeneration !== null && envelope.workerGeneration !== workerGeneration) return;
      const eventEpoch = lifecycleEpoch;
      const event = envelope.payload;
      const current = currentSequence(event.roomId);
      if (event.roomSeq <= current || event.roomSeq === current + 1) {
        try {
          acceptEvent(event, eventEpoch);
        } catch (error) {
          patchState({
            connection: "error",
            error: error instanceof Error ? error.message : "Unable to accept room event"
          });
        }
      } else {
        void catchUp(event.roomId, eventEpoch)
          .then(() => acceptEvent(event, eventEpoch))
          .catch((error: unknown) => {
            patchCurrent(eventEpoch, {
              connection: "error",
              error: error instanceof Error ? error.message : "Unable to replay room events"
            });
          });
      }
    } else if (envelope.type === "worker.disconnected") {
      if (workerGeneration !== null && envelope.workerGeneration !== workerGeneration) return;
      lifecycleEpoch += 1;
      patchState({ connection: "reconnecting", error: null });
    } else if (envelope.type === "worker.ready" && envelope.workerGeneration !== workerGeneration) {
      workerGeneration = envelope.workerGeneration;
      lifecycleEpoch += 1;
      void hydrateForEpoch(lifecycleEpoch);
    }
  });

  async function runHydrate(epoch: number): Promise<void> {
    patchCurrent(epoch, {
      connection: hasHydrated ? "reconnecting" : "bootstrapping",
      error: null
    });
    try {
      const response = await api.request({
        type: "state.getSnapshot",
        payload: {},
        idempotencyKey: nextId()
      });
      if (!isCurrent(epoch)) return;
      if (!response.payload.ok) throw new Error(response.payload.message);
      const parsedSnapshot = AppSnapshotSchema.safeParse(response.payload.data);
      if (!parsedSnapshot.success) throw new Error("Unable to load application state");
      const snapshot = immutableSnapshot(parsedSnapshot.data);
      const retainedRoom = snapshot.rooms.find((candidate) => candidate.id === state.selectedRoomId);
      const retainedProject = snapshot.projects.find((candidate) => (
        candidate.id === (retainedRoom?.projectId ?? state.selectedProjectId)
      ));
      const selectedProjectId = retainedProject?.id ?? snapshot.projects[0]?.id ?? null;
      const selectedRoomId = retainedRoom?.id ?? snapshot.rooms.find((candidate) => (
        candidate.projectId === selectedProjectId
      ))?.id ?? null;
      patchCurrent(epoch, { snapshot, selectedProjectId, selectedRoomId });
      if (selectedRoomId !== null) await catchUp(selectedRoomId, epoch);
      patchCurrent(epoch, { connection: "ready", error: null });
      if (isCurrent(epoch)) hasHydrated = true;
    } catch (error) {
      patchCurrent(epoch, {
        connection: "error",
        error: error instanceof Error ? error.message : "Unable to load application state"
      });
    }
  }

  function hydrateForEpoch(epoch: number, force = false): Promise<void> {
    if (!isCurrent(epoch)) return Promise.resolve();
    if (!force && hydrateTask?.epoch === epoch) return hydrateTask.promise;
    const task = { epoch, promise: Promise.resolve() };
    task.promise = runHydrate(epoch).finally(() => {
      if (hydrateTask === task) hydrateTask = null;
    });
    hydrateTask = task;
    return task.promise;
  }

  function hydrate(): Promise<void> {
    return hydrateForEpoch(lifecycleEpoch);
  }

  function forceFreshHydrate(epoch: number): Promise<void> {
    if (!isCurrent(epoch)) return Promise.resolve();
    const predecessor = refreshTail?.epoch === epoch
      ? refreshTail.promise
      : Promise.resolve();
    const refresh = { epoch, promise: Promise.resolve() };
    refresh.promise = predecessor.then(async () => {
      const active = hydrateTask;
      if (active?.epoch === epoch) await active.promise;
      if (!isCurrent(epoch)) return;
      await hydrateForEpoch(epoch, true);
    }).finally(() => {
      if (refreshTail === refresh) refreshTail = null;
    });
    refreshTail = refresh;
    return refresh.promise;
  }

  async function selectRoom(roomId: string): Promise<void> {
    if (disposed) return;
    const operationEpoch = lifecycleEpoch;
    const selectedRoom = state.snapshot.rooms.find((candidate) => candidate.id === roomId);
    if (!selectedRoom) throw new Error("Room is not present in the current snapshot");
    patchCurrent(operationEpoch, {
      selectedProjectId: selectedRoom.projectId,
      selectedRoomId: selectedRoom.id
    });
    try {
      await catchUp(selectedRoom.id, operationEpoch);
    } catch (error) {
      if (!isCurrent(operationEpoch)) return;
      const message = error instanceof Error ? error.message : "Unable to replay room events";
      patchCurrent(operationEpoch, { connection: "error", error: message });
      throw new Error(message, { cause: error });
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    hydrate,
    selectRoom,
    async addProject() {
      if (disposed) return;
      const operationEpoch = lifecycleEpoch;
      try {
        const response = await api.request({
          type: "project.pickExisting",
          payload: {},
          idempotencyKey: nextId()
        });
        if (!isCurrent(operationEpoch)) return;
        if (!response.payload.ok) {
          patchCurrent(operationEpoch, { connection: "error", error: response.payload.message });
          return;
        }
        if (response.payload.requestType !== "project.pickExisting") {
          throw new Error("Unexpected project picker response");
        }
        const data = response.payload.data;
        if (
          typeof data === "object"
          && data !== null
          && "cancelled" in data
          && data.cancelled === true
          && Object.keys(data).length === 1
        ) return;
        const parsedProject = ProjectSchema.safeParse(data);
        if (!parsedProject.success) throw new Error("Unable to add project");
        await forceFreshHydrate(operationEpoch);
      } catch (error) {
        patchCurrent(operationEpoch, {
          connection: "error",
          error: error instanceof Error ? error.message : "Unable to add project"
        });
      }
    },
    async createRoom(projectId, title) {
      if (disposed) return;
      const trimmedTitle = title.trim();
      if (trimmedTitle.length === 0) throw new Error("Room title is required");
      const operationEpoch = lifecycleEpoch;
      try {
        const response = await api.request({
          type: "room.create",
          payload: { projectId, title: trimmedTitle },
          idempotencyKey: nextId()
        });
        if (!isCurrent(operationEpoch)) return;
        if (!response.payload.ok) {
          patchCurrent(operationEpoch, { connection: "error", error: response.payload.message });
          return;
        }
        if (response.payload.requestType !== "room.create") {
          throw new Error("Unexpected room creation response");
        }
        const parsedRoom = RoomSchema.safeParse(response.payload.data);
        if (!parsedRoom.success) throw new Error("Unable to create room");
        const createdRoom = parsedRoom.data;
        if (!isCurrent(operationEpoch)) return;
        await forceFreshHydrate(operationEpoch);
        if (!isCurrent(operationEpoch) || state.connection === "error") return;
        await selectRoom(createdRoom.id);
      } catch (error) {
        patchCurrent(operationEpoch, {
          connection: "error",
          error: error instanceof Error ? error.message : "Unable to create room"
        });
      }
    },
    async postMessage(roomId, body) {
      if (disposed) return;
      const trimmedBody = body.trim();
      if (trimmedBody.length === 0) throw new Error("Message body is required");
      const operationEpoch = lifecycleEpoch;
      try {
        const response = await api.request({
          type: "message.post",
          payload: { roomId, body: trimmedBody },
          idempotencyKey: nextId()
        });
        if (!isCurrent(operationEpoch)) return;
        if (!response.payload.ok) {
          patchCurrent(operationEpoch, { connection: "error", error: response.payload.message });
          return;
        }
        if (response.payload.requestType !== "message.post") {
          throw new Error("Unexpected message response");
        }
        const parsedEvent = RoomEventSchema.safeParse(response.payload.data);
        if (!parsedEvent.success) throw new Error("Unable to post message");
        acceptEvent(parsedEvent.data, operationEpoch);
      } catch (error) {
        patchCurrent(operationEpoch, {
          connection: "error",
          error: error instanceof Error ? error.message : "Unable to post message"
        });
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lifecycleEpoch += 1;
      unsubscribe();
      listeners.clear();
    }
  };
}
