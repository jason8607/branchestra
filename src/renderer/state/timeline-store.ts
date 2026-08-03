import {
  AppSnapshotSchema,
  ProjectSchema,
  RoomEventPageSchema,
  RoomEventSchema,
  RoomSchema,
  SnapshotPageSchema,
  type AppSnapshot,
  type RoomEvent
} from "../../shared/contracts/domain";
import { parseAgentMentions } from "../../shared/agents/mention-parser";
import { ProviderHealthSchema, type ProviderHealth, type ProviderId } from "../../shared/contracts/provider";
import type { BranchestraApi } from "../../shared/contracts/renderer-api";
import { ProjectCleanupPreviewSchema, RoomCleanupPreviewSchema, WorktreeCleanupPreviewSchema, type ProjectCleanupPreview, type RoomCleanupPreview, type WorktreeCleanupPreview } from "../../shared/contracts/protocol";

export interface TimelineState {
  connection: "bootstrapping" | "ready" | "reconnecting" | "error";
  snapshot: AppSnapshot;
  selectedProjectId: string | null;
  selectedRoomId: string | null;
  selectedTaskId: string | null;
  eventsByRoom: Readonly<Record<string, readonly RoomEvent[]>>;
  error: string | null;
  providerHealth: readonly ProviderHealth[];
}

export interface TimelineStore {
  getState(): TimelineState;
  subscribe(listener: () => void): () => void;
  hydrate(): Promise<void>;
  selectRoom(roomId: string): Promise<void>;
  selectTask(taskId: string | null): void;
  addProject(): Promise<void>;
  refreshProviderHealth(): Promise<void>;
  pickProviderExecutable(provider: ProviderId): Promise<void>;
  createRoom(projectId: string, title: string): Promise<void>;
  postMessage(roomId: string, body: string): Promise<void>;
  exportDiagnostics(): Promise<{ cancelled: true } | { sha256: string; bytes: number }>;
  previewRoomCleanup(roomId: string): Promise<RoomCleanupPreview>;
  removeRoomCleanup(receipt: RoomCleanupPreview & { confirmation: string }): Promise<void>;
  previewWorktreeCleanup(worktreeId: string): Promise<WorktreeCleanupPreview>;
  archiveWorktreeCleanup(receipt: WorktreeCleanupPreview & { allowDirtyArchive: boolean }): Promise<string>;
  previewProjectCleanup(projectId: string): Promise<ProjectCleanupPreview>;
  removeProjectCleanup(receipt: ProjectCleanupPreview & { confirmation: string }): Promise<void>;
  dispose(): void;
}

const EMPTY_SNAPSHOT: AppSnapshot = { projects: [], rooms: [], tasks: [], roomCursors: {} };
const POST_INTERRUPTED_MESSAGE = "Message delivery was interrupted. Try again.";
const CREATE_ROOM_INTERRUPTED_MESSAGE = "Room creation was interrupted. Try again.";

class WorkerCommandRejectedError extends Error {}
Object.freeze(EMPTY_SNAPSHOT.projects);
Object.freeze(EMPTY_SNAPSHOT.rooms);
Object.freeze(EMPTY_SNAPSHOT.tasks);
Object.freeze(EMPTY_SNAPSHOT.roomCursors);
Object.freeze(EMPTY_SNAPSHOT);

function immutableSnapshot(snapshot: AppSnapshot): AppSnapshot {
  const copy: AppSnapshot = {
    projects: snapshot.projects.map((project) => Object.freeze({ ...project })),
    rooms: snapshot.rooms.map((room) => Object.freeze({ ...room })),
    tasks: snapshot.tasks.map((task) => Object.freeze({ ...task })),
    roomCursors: { ...snapshot.roomCursors }
  };
  Object.freeze(copy.projects);
  Object.freeze(copy.rooms);
  Object.freeze(copy.tasks);
  Object.freeze(copy.roomCursors);
  return Object.freeze(copy);
}

function immutableEvent(event: RoomEvent): RoomEvent {
  return Object.freeze({
    ...event,
    payload: Object.freeze({ ...event.payload })
  }) as RoomEvent;
}

export function createTimelineStore(
  api: BranchestraApi,
  nextId: () => string = () => crypto.randomUUID()
): TimelineStore {
  const listeners = new Set<() => void>();
  const catches = new Map<string, { epoch: number; promise: Promise<void> }>();
  let disposed = false;
  let lifecycleEpoch = 0;
  let statusSequence = 0;
  let publishedStatusSequence = 0;
  let hydrateTask: {
    epoch: number;
    statusOperation: number;
    promise: Promise<void>;
  } | null = null;
  let refreshTail: { epoch: number; started: boolean; promise: Promise<void> } | null = null;
  let workerGeneration: string | null = null;
  let workerReady = false;
  let hasHydrated = false;
  let state: TimelineState = Object.freeze({
    connection: "bootstrapping",
    snapshot: EMPTY_SNAPSHOT,
    selectedProjectId: null,
    selectedRoomId: null,
    selectedTaskId: null,
    eventsByRoom: Object.freeze({}),
    providerHealth: Object.freeze([]),
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

  function beginStatusOperation(): number {
    statusSequence += 1;
    return statusSequence;
  }

  function patchStatus(
    epoch: number,
    operation: number,
    patch: Pick<TimelineState, "connection" | "error">
  ): void {
    if (!isCurrent(epoch) || operation < publishedStatusSequence) return;
    publishedStatusSequence = operation;
    patchState(patch);
  }

  function currentSequence(roomId: string): number {
    return state.eventsByRoom[roomId]?.at(-1)?.roomSeq ?? 0;
  }

  function planAcceptedEvents(
    roomId: string,
    candidates: readonly RoomEvent[]
  ): { events: RoomEvent[]; cursor: number } {
    const seenIds = new Set(Object.values(state.eventsByRoom)
      .flatMap((events) => events)
      .map((event) => event.id));
    const events: RoomEvent[] = [];
    let cursor = currentSequence(roomId);
    for (const event of candidates) {
      if (seenIds.has(event.id)) continue;
      if (event.roomSeq <= cursor) continue;
      if (event.roomSeq !== cursor + 1) {
        throw new Error(`Room event sequence gap after ${cursor}`);
      }
      seenIds.add(event.id);
      events.push(event);
      cursor = event.roomSeq;
    }
    return { events, cursor };
  }

  function commitAcceptedEvents(roomId: string, events: readonly RoomEvent[], epoch: number): void {
    if (!isCurrent(epoch) || events.length === 0) return;
    const roomEvents = Object.freeze([
      ...(state.eventsByRoom[roomId] ?? []),
      ...events.map(immutableEvent)
    ]);
    const createdTask = [...events].reverse().find((event) => event.type === "task.created");
    patchState({
      eventsByRoom: Object.freeze({ ...state.eventsByRoom, [roomId]: roomEvents }),
      ...(createdTask?.type === "task.created"
        ? { selectedTaskId: createdTask.payload.task.id }
        : {})
    });
  }

  function acceptEvent(event: RoomEvent, epoch = lifecycleEpoch): void {
    if (!isCurrent(epoch)) return;
    const plan = planAcceptedEvents(event.roomId, [event]);
    commitAcceptedEvents(event.roomId, plan.events, epoch);
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
      const plan = planAcceptedEvents(roomId, page.events);
      if (page.nextRoomSeq !== plan.cursor) {
        throw new Error("Replay nextRoomSeq does not match accepted cursor");
      }
      commitAcceptedEvents(roomId, plan.events, epoch);
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
      if (!workerReady || envelope.workerGeneration !== workerGeneration) return;
      const eventEpoch = lifecycleEpoch;
      const event = envelope.payload;
      const current = currentSequence(event.roomId);
      if (event.roomSeq <= current || event.roomSeq === current + 1) {
        try {
          acceptEvent(event, eventEpoch);
        } catch (error) {
          patchStatus(eventEpoch, beginStatusOperation(), {
            connection: "error",
            error: error instanceof Error ? error.message : "Unable to accept room event"
          });
        }
      } else {
        const eventStatusOperation = beginStatusOperation();
        void catchUp(event.roomId, eventEpoch)
          .then(() => acceptEvent(event, eventEpoch))
          .catch((error: unknown) => {
            patchStatus(eventEpoch, eventStatusOperation, {
              connection: "error",
              error: error instanceof Error ? error.message : "Unable to replay room events"
            });
          });
      }
    } else if (envelope.type === "worker.disconnected") {
      if (workerGeneration !== null && envelope.workerGeneration !== workerGeneration) return;
      workerReady = false;
      lifecycleEpoch += 1;
      patchStatus(lifecycleEpoch, beginStatusOperation(), {
        connection: "reconnecting",
        error: null
      });
    } else if (
      envelope.type === "worker.ready"
      && (!workerReady || envelope.workerGeneration !== workerGeneration)
    ) {
      const isNewGeneration = envelope.workerGeneration !== workerGeneration;
      workerGeneration = envelope.workerGeneration;
      workerReady = true;
      if (isNewGeneration) lifecycleEpoch += 1;
      void hydrateForEpoch(lifecycleEpoch);
    }
  });

  async function runHydrate(epoch: number, statusOperation: number): Promise<void> {
    patchStatus(epoch, statusOperation, {
      connection: hasHydrated ? "reconnecting" : "bootstrapping",
      error: null
    });
    try {
      let response = await api.request({
        type: "state.getSnapshot",
        payload: {},
        idempotencyKey: nextId()
      });
      if (!isCurrent(epoch)) return;
      if (!response.payload.ok) throw new Error(response.payload.message);
      if (workerGeneration === null) {
        workerGeneration = response.workerGeneration;
        workerReady = true;
      }
      let parsedSnapshot = AppSnapshotSchema.safeParse(response.payload.data);
      if (!parsedSnapshot.success) {
        const accumulated: AppSnapshot = { projects: [], rooms: [], tasks: [], roomCursors: {} };
        let expectedSnapshotId: string | null = null;
        let cursor = 0;
        while (true) {
          const parsedPage = SnapshotPageSchema.safeParse(response.payload.data);
          if (!parsedPage.success) throw new Error("Unable to load application state");
          const page = parsedPage.data;
          if (expectedSnapshotId !== null && page.snapshotId !== expectedSnapshotId) {
            throw new Error("Snapshot generation changed during pagination");
          }
          if (page.nextCursor < cursor || (page.hasMore && page.nextCursor === cursor)) {
            throw new Error("Snapshot pagination did not advance");
          }
          expectedSnapshotId = page.snapshotId;
          for (const project of page.projects) {
            if (accumulated.projects.some((item) => item.id === project.id)) throw new Error("Snapshot contains a duplicate project");
            accumulated.projects.push(project);
          }
          for (const room of page.rooms) {
            if (accumulated.rooms.some((item) => item.id === room.id)) throw new Error("Snapshot contains a duplicate room");
            accumulated.rooms.push(room);
          }
          for (const task of page.tasks) {
            if (accumulated.tasks.some((item) => item.task.id === task.task.id)) throw new Error("Snapshot contains a duplicate task");
            accumulated.tasks.push(task);
          }
          for (const [roomId, roomSeq] of Object.entries(page.roomCursors)) {
            if (roomId in accumulated.roomCursors) throw new Error("Snapshot contains a duplicate room cursor");
            accumulated.roomCursors[roomId] = roomSeq;
          }
          cursor = page.nextCursor;
          if (!page.hasMore) break;
          response = await api.request({
            type: "state.getSnapshot",
            payload: { snapshotId: page.snapshotId, cursor },
            idempotencyKey: nextId()
          });
          if (!isCurrent(epoch)) return;
          if (!response.payload.ok) throw new Error(response.payload.message);
        }
        parsedSnapshot = AppSnapshotSchema.safeParse(accumulated);
      }
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
      const retainedTask = snapshot.tasks.find((candidate) => candidate.task.id === state.selectedTaskId);
      const selectedTaskId = retainedTask?.task.id
        ?? snapshot.tasks.find((candidate) => candidate.task.roomId === selectedRoomId)?.task.id
        ?? null;
      patchCurrent(epoch, { snapshot, selectedProjectId, selectedRoomId, selectedTaskId });
      if (selectedRoomId !== null) await catchUp(selectedRoomId, epoch);
      patchStatus(epoch, statusOperation, { connection: "ready", error: null });
      if (isCurrent(epoch)) hasHydrated = true;
    } catch (error) {
      patchStatus(epoch, statusOperation, {
        connection: "error",
        error: error instanceof Error ? error.message : "Unable to load application state"
      });
    }
  }

  function hydrateForEpoch(epoch: number, force = false): Promise<void> {
    if (!isCurrent(epoch)) return Promise.resolve();
    if (!force && hydrateTask?.epoch === epoch) return hydrateTask.promise;
    const task = {
      epoch,
      statusOperation: beginStatusOperation(),
      promise: Promise.resolve()
    };
    task.promise = runHydrate(epoch, task.statusOperation).finally(() => {
      if (hydrateTask === task) hydrateTask = null;
    });
    hydrateTask = task;
    return task.promise;
  }

  function hydrate(): Promise<void> {
    if (disposed) return Promise.resolve();
    const epoch = lifecycleEpoch;
    const active = hydrateTask?.epoch === epoch ? hydrateTask : null;
    if (active) {
      if (active.statusOperation >= publishedStatusSequence) return active.promise;
      if (refreshTail?.epoch === epoch && !refreshTail.started) return refreshTail.promise;
      return forceFreshHydrate(epoch);
    }
    if (refreshTail?.epoch === epoch) return refreshTail.promise;
    return hydrateForEpoch(lifecycleEpoch);
  }

  function forceFreshHydrate(epoch: number): Promise<void> {
    if (!isCurrent(epoch)) return Promise.resolve();
    const predecessor = refreshTail?.epoch === epoch
      ? refreshTail.promise
      : Promise.resolve();
    const refresh = { epoch, started: false, promise: Promise.resolve() };
    refresh.promise = predecessor.then(async () => {
      const active = hydrateTask;
      if (active?.epoch === epoch) await active.promise;
      if (!isCurrent(epoch)) return;
      refresh.started = true;
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
    const statusOperation = beginStatusOperation();
    const selectedRoom = state.snapshot.rooms.find((candidate) => candidate.id === roomId);
    if (!selectedRoom) throw new Error("Room is not present in the current snapshot");
    patchCurrent(operationEpoch, {
      selectedProjectId: selectedRoom.projectId,
      selectedRoomId: selectedRoom.id,
      selectedTaskId: state.snapshot.tasks.find((candidate) => candidate.task.roomId === selectedRoom.id)?.task.id ?? null
    });
    try {
      await catchUp(selectedRoom.id, operationEpoch);
    } catch (error) {
      if (!isCurrent(operationEpoch)) return;
      const message = error instanceof Error ? error.message : "Unable to replay room events";
      patchStatus(operationEpoch, statusOperation, { connection: "error", error: message });
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
    selectTask(taskId) {
      if (taskId !== null && !state.snapshot.tasks.some((candidate) => candidate.task.id === taskId)) {
        throw new Error("Task is not present in the current snapshot");
      }
      patchState({ selectedTaskId: taskId });
    },
    async refreshProviderHealth() {
      if (disposed) return;
      const epoch = lifecycleEpoch;
      const response = await api.request({ type: "provider.health.list", payload: {}, idempotencyKey: nextId() });
      if (!isCurrent(epoch)) return;
      if (!response.payload.ok) throw new Error(response.payload.message);
      const parsed = ProviderHealthSchema.array().parse(response.payload.data);
      patchCurrent(epoch, { providerHealth: Object.freeze(parsed.map((item) => Object.freeze(item))) });
    },
    async pickProviderExecutable(provider) {
      if (disposed) return;
      const epoch = lifecycleEpoch;
      const response = await api.request({ type: "provider.pickExecutable", payload: { provider }, idempotencyKey: nextId() });
      if (!isCurrent(epoch)) return;
      if (!response.payload.ok) throw new Error(response.payload.message);
      if (response.payload.data && typeof response.payload.data === "object" && "cancelled" in response.payload.data) return;
      await this.refreshProviderHealth();
    },
    async addProject() {
      if (disposed) return;
      const operationEpoch = lifecycleEpoch;
      const statusOperation = beginStatusOperation();
      try {
        const response = await api.request({
          type: "project.pickExisting",
          payload: {},
          idempotencyKey: nextId()
        });
        if (!isCurrent(operationEpoch)) return;
        if (!response.payload.ok) {
          patchStatus(operationEpoch, statusOperation, {
            connection: "error",
            error: response.payload.message
          });
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
        if (!isCurrent(operationEpoch) || state.connection === "error") return;
        const addedProject = state.snapshot.projects.find((candidate) => (
          candidate.id === parsedProject.data.id
        ));
        if (!addedProject) return;
        const firstRoom = state.snapshot.rooms.find((candidate) => (
          candidate.projectId === addedProject.id
        ));
        if (firstRoom) {
          await selectRoom(firstRoom.id);
          return;
        }
        patchCurrent(operationEpoch, {
          selectedProjectId: addedProject.id,
          selectedRoomId: null,
          selectedTaskId: null
        });
      } catch (error) {
        patchStatus(operationEpoch, statusOperation, {
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
      const statusOperation = beginStatusOperation();
      try {
        const response = await api.request({
          type: "room.create",
          payload: { projectId, title: trimmedTitle },
          idempotencyKey: nextId()
        });
        if (!isCurrent(operationEpoch)) throw new Error(CREATE_ROOM_INTERRUPTED_MESSAGE);
        if (!response.payload.ok) {
          throw new Error(response.payload.message);
        }
        if (response.payload.requestType !== "room.create") {
          throw new Error("Unexpected room creation response");
        }
        const parsedRoom = RoomSchema.safeParse(response.payload.data);
        if (!parsedRoom.success) throw new Error("Unable to create room");
        const createdRoom = parsedRoom.data;
        if (!isCurrent(operationEpoch)) throw new Error(CREATE_ROOM_INTERRUPTED_MESSAGE);
        await forceFreshHydrate(operationEpoch);
        if (!isCurrent(operationEpoch)) throw new Error(CREATE_ROOM_INTERRUPTED_MESSAGE);
        if (state.connection === "error") throw new Error(state.error ?? "Unable to refresh rooms");
        await selectRoom(createdRoom.id);
      } catch (error) {
        if (!isCurrent(operationEpoch)) {
          throw new Error(CREATE_ROOM_INTERRUPTED_MESSAGE, { cause: error });
        }
        const message = error instanceof Error ? error.message : "Unable to create room";
        patchStatus(operationEpoch, statusOperation, {
          connection: "error",
          error: message
        });
        throw new Error(message, { cause: error });
      }
    },
    async postMessage(roomId, body) {
      if (disposed) return;
      const trimmedBody = body.trim();
      if (trimmedBody.length === 0) throw new Error("Message body is required");
      const operationEpoch = lifecycleEpoch;
      const statusOperation = beginStatusOperation();
      try {
        const mentions = parseAgentMentions(trimmedBody);
        const response = await api.request({
          type: "message.post",
          payload: {
            roomId,
            body: trimmedBody,
            ...(mentions.length > 1 ? { leadProvider: mentions[0] } : {})
          },
          idempotencyKey: nextId()
        });
        if (!isCurrent(operationEpoch)) throw new Error(POST_INTERRUPTED_MESSAGE);
        if (!response.payload.ok) {
          throw new WorkerCommandRejectedError(response.payload.message);
        }
        if (response.payload.requestType !== "message.post") {
          throw new Error("Unexpected message response");
        }
        const parsedEvent = RoomEventSchema.safeParse(response.payload.data);
        if (!parsedEvent.success) throw new Error("Unable to post message");
        if (parsedEvent.data.roomSeq > currentSequence(roomId) + 1) {
          await catchUp(roomId, operationEpoch);
          if (!isCurrent(operationEpoch)) throw new Error(POST_INTERRUPTED_MESSAGE);
        }
        acceptEvent(parsedEvent.data, operationEpoch);
      } catch (error) {
        if (!isCurrent(operationEpoch)) {
          throw new Error(POST_INTERRUPTED_MESSAGE, { cause: error });
        }
        const message = error instanceof Error ? error.message : "Unable to post message";
        if (!(error instanceof WorkerCommandRejectedError)) {
          patchStatus(operationEpoch, statusOperation, {
            connection: "error",
            error: message
          });
        }
        throw new Error(message, { cause: error });
      }
    },
    async exportDiagnostics() {
      const response = await api.request({
        type: "diagnostics.export",
        payload: {},
        idempotencyKey: nextId()
      });
      if (!response.payload.ok) throw new Error(response.payload.message);
      const data = response.payload.data;
      if (typeof data === "object" && data !== null && "cancelled" in data && data.cancelled === true) {
        return { cancelled: true };
      }
      if (typeof data === "object" && data !== null
        && "sha256" in data && typeof data.sha256 === "string" && /^[a-f0-9]{64}$/.test(data.sha256)
        && "bytes" in data && typeof data.bytes === "number" && Number.isInteger(data.bytes) && data.bytes > 0) {
        return { sha256: data.sha256, bytes: data.bytes };
      }
      throw new Error("Diagnostic export response is invalid");
    },
    async previewRoomCleanup(roomId) {
      const response = await api.request({
        type: "cleanup.room.preview",
        payload: { roomId },
        idempotencyKey: nextId()
      });
      if (!response.payload.ok) throw new Error(response.payload.message);
      const parsed = RoomCleanupPreviewSchema.safeParse(response.payload.data);
      if (!parsed.success || parsed.data.roomId !== roomId) {
        throw new Error("Room cleanup preview is invalid");
      }
      return parsed.data;
    },
    async removeRoomCleanup(receipt) {
      const operationEpoch = lifecycleEpoch;
      const response = await api.request({
        type: "cleanup.room.remove",
        payload: receipt,
        idempotencyKey: nextId()
      });
      if (!response.payload.ok) throw new Error(response.payload.message);
      const data = response.payload.data;
      if (typeof data !== "object" || data === null || !("removed" in data) || data.removed !== true
        || !("kind" in data) || data.kind !== "room" || !("id" in data) || data.id !== receipt.roomId) {
        throw new Error("Room cleanup response is invalid");
      }
      await forceFreshHydrate(operationEpoch);
    },
    async previewWorktreeCleanup(worktreeId) {
      const response = await api.request({
        type: "cleanup.worktree.preview",
        payload: { worktreeId },
        idempotencyKey: nextId()
      });
      if (!response.payload.ok) throw new Error(response.payload.message);
      const parsed = WorktreeCleanupPreviewSchema.safeParse(response.payload.data);
      if (!parsed.success || parsed.data.worktreeId !== worktreeId) {
        throw new Error("Worktree cleanup preview is invalid");
      }
      return parsed.data;
    },
    async archiveWorktreeCleanup(receipt) {
      const response = await api.request({
        type: "cleanup.worktree.archive",
        payload: receipt,
        idempotencyKey: nextId()
      });
      if (!response.payload.ok) throw new Error(response.payload.message);
      const data = response.payload.data;
      if (typeof data !== "object" || data === null || !("archived" in data) || data.archived !== true
        || !("recoveryPath" in data) || typeof data.recoveryPath !== "string") {
        throw new Error("Worktree archive response is invalid");
      }
      return data.recoveryPath;
    },
    async previewProjectCleanup(projectId) {
      const response = await api.request({
        type: "cleanup.project.preview",
        payload: { projectId },
        idempotencyKey: nextId()
      });
      if (!response.payload.ok) throw new Error(response.payload.message);
      const parsed = ProjectCleanupPreviewSchema.safeParse(response.payload.data);
      if (!parsed.success || parsed.data.projectId !== projectId) {
        throw new Error("Project cleanup preview is invalid");
      }
      return parsed.data;
    },
    async removeProjectCleanup(receipt) {
      const operationEpoch = lifecycleEpoch;
      const response = await api.request({
        type: "cleanup.project.remove",
        payload: receipt,
        idempotencyKey: nextId()
      });
      if (!response.payload.ok) throw new Error(response.payload.message);
      const data = response.payload.data;
      if (typeof data !== "object" || data === null || !("removed" in data) || data.removed !== true
        || !("kind" in data) || data.kind !== "project" || !("id" in data) || data.id !== receipt.projectId) {
        throw new Error("Project cleanup response is invalid");
      }
      await forceFreshHydrate(operationEpoch);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      workerReady = false;
      lifecycleEpoch += 1;
      unsubscribe();
      listeners.clear();
    }
  };
}
