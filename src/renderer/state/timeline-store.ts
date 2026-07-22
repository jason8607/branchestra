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
  const catches = new Map<string, Promise<void>>();
  let disposed = false;
  let hydratePromise: Promise<void> | null = null;
  let rehydrateQueued = false;
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
    for (const listener of listeners) listener();
  }

  function patchState(patch: Partial<TimelineState>): void {
    replaceState({ ...state, ...patch });
  }

  function currentSequence(roomId: string): number {
    return state.eventsByRoom[roomId]?.at(-1)?.roomSeq ?? 0;
  }

  function sameEvent(left: RoomEvent, right: RoomEvent): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function acceptEvent(event: RoomEvent): void {
    if (disposed) return;
    const eventWithSameId = Object.values(state.eventsByRoom)
      .flatMap((events) => events)
      .find((candidate) => candidate.id === event.id);
    if (eventWithSameId) {
      if (sameEvent(eventWithSameId, event)) return;
      throw new Error(`Conflicting event ID: ${event.id}`);
    }
    const eventWithSameSequence = state.eventsByRoom[event.roomId]?.find((candidate) => (
      candidate.roomSeq === event.roomSeq
    ));
    if (eventWithSameSequence) {
      throw new Error(`Conflicting event for room sequence ${event.roomSeq}`);
    }
    const current = currentSequence(event.roomId);
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

  async function runCatchUp(roomId: string): Promise<void> {
    while (true) {
      const cursor = currentSequence(roomId);
      const response = await api.request({
        type: "room.replay",
        payload: { roomId, roomSeq: cursor, limit: 200 },
        idempotencyKey: nextId()
      });
      if (disposed) return;
      if (!response.payload.ok) throw new Error(response.payload.message);
      const parsedPage = RoomEventPageSchema.safeParse(response.payload.data);
      if (!parsedPage.success) throw new Error("Unable to replay room events");
      const page = parsedPage.data;
      if (page.roomId !== roomId) throw new Error("Replay response room does not match request");
      for (const event of page.events) {
        acceptEvent(event);
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

  function catchUp(roomId: string): Promise<void> {
    if (disposed) return Promise.resolve();
    const existing = catches.get(roomId);
    if (existing) return existing;
    const running = runCatchUp(roomId).finally(() => {
      if (catches.get(roomId) === running) catches.delete(roomId);
    });
    catches.set(roomId, running);
    return running;
  }

  const unsubscribe = api.subscribe((envelope) => {
    if (disposed) return;
    if (envelope.type === "room.event") {
      const event = envelope.payload;
      const current = currentSequence(event.roomId);
      if (event.roomSeq <= current || event.roomSeq === current + 1) {
        try {
          acceptEvent(event);
        } catch (error) {
          patchState({
            connection: "error",
            error: error instanceof Error ? error.message : "Unable to accept room event"
          });
        }
      } else {
        void catchUp(event.roomId)
          .then(() => acceptEvent(event))
          .catch((error: unknown) => {
            patchState({
              connection: "error",
              error: error instanceof Error ? error.message : "Unable to replay room events"
            });
          });
      }
    } else if (envelope.type === "worker.disconnected") {
      patchState({ connection: "reconnecting", error: null });
    } else if (envelope.type === "worker.ready" && envelope.workerGeneration !== workerGeneration) {
      workerGeneration = envelope.workerGeneration;
      if (hydratePromise) rehydrateQueued = true;
      void hydrate();
    }
  });

  async function runHydrate(): Promise<void> {
    patchState({ connection: hasHydrated ? "reconnecting" : "bootstrapping", error: null });
    try {
      const response = await api.request({
        type: "state.getSnapshot",
        payload: {},
        idempotencyKey: nextId()
      });
      if (disposed) return;
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
      patchState({ snapshot, selectedProjectId, selectedRoomId });
      if (selectedRoomId !== null) await catchUp(selectedRoomId);
      patchState({ connection: "ready", error: null });
      hasHydrated = true;
    } catch (error) {
      patchState({
        connection: "error",
        error: error instanceof Error ? error.message : "Unable to load application state"
      });
    }
  }

  function hydrate(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (hydratePromise) return hydratePromise;
    hydratePromise = runHydrate().finally(() => {
      hydratePromise = null;
      if (rehydrateQueued && !disposed) {
        rehydrateQueued = false;
        void hydrate();
      }
    });
    return hydratePromise;
  }

  async function selectRoom(roomId: string): Promise<void> {
    const selectedRoom = state.snapshot.rooms.find((candidate) => candidate.id === roomId);
    if (!selectedRoom) throw new Error("Room is not present in the current snapshot");
    patchState({ selectedProjectId: selectedRoom.projectId, selectedRoomId: selectedRoom.id });
    await catchUp(selectedRoom.id);
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
      try {
        const response = await api.request({
          type: "project.pickExisting",
          payload: {},
          idempotencyKey: nextId()
        });
        if (!response.payload.ok) {
          patchState({ connection: "error", error: response.payload.message });
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
        if (!disposed) await hydrate();
      } catch (error) {
        patchState({
          connection: "error",
          error: error instanceof Error ? error.message : "Unable to add project"
        });
      }
    },
    async createRoom(projectId, title) {
      const trimmedTitle = title.trim();
      if (trimmedTitle.length === 0) throw new Error("Room title is required");
      try {
        const response = await api.request({
          type: "room.create",
          payload: { projectId, title: trimmedTitle },
          idempotencyKey: nextId()
        });
        if (!response.payload.ok) {
          patchState({ connection: "error", error: response.payload.message });
          return;
        }
        if (response.payload.requestType !== "room.create") {
          throw new Error("Unexpected room creation response");
        }
        const parsedRoom = RoomSchema.safeParse(response.payload.data);
        if (!parsedRoom.success) throw new Error("Unable to create room");
        const createdRoom = parsedRoom.data;
        if (disposed) return;
        await hydrate();
        if (disposed || state.connection === "error") return;
        await selectRoom(createdRoom.id);
      } catch (error) {
        patchState({
          connection: "error",
          error: error instanceof Error ? error.message : "Unable to create room"
        });
      }
    },
    async postMessage(roomId, body) {
      const trimmedBody = body.trim();
      if (trimmedBody.length === 0) throw new Error("Message body is required");
      try {
        const response = await api.request({
          type: "message.post",
          payload: { roomId, body: trimmedBody },
          idempotencyKey: nextId()
        });
        if (!response.payload.ok) {
          patchState({ connection: "error", error: response.payload.message });
          return;
        }
        if (response.payload.requestType !== "message.post") {
          throw new Error("Unexpected message response");
        }
        const parsedEvent = RoomEventSchema.safeParse(response.payload.data);
        if (!parsedEvent.success) throw new Error("Unable to post message");
        acceptEvent(parsedEvent.data);
      } catch (error) {
        patchState({
          connection: "error",
          error: error instanceof Error ? error.message : "Unable to post message"
        });
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      listeners.clear();
    }
  };
}
