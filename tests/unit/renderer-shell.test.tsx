/// <reference types="node" />
// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/App";
import { Composer } from "../../src/renderer/components/Composer";
import { ProjectRail } from "../../src/renderer/components/ProjectRail";
import { Timeline } from "../../src/renderer/components/Timeline";
import type {
  Project,
  Room,
  RoomEvent
} from "../../src/shared/contracts/domain";
import {
  createTimelineStore,
  type TimelineState,
  type TimelineStore
} from "../../src/renderer/state/timeline-store";
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
const rendererStyles = readFileSync("src/renderer/styles.css", "utf8");

function project(): Project {
  return {
    id: PROJECT_ID,
    repositoryRoot: "/repo/branchestra",
    gitCommonDir: "/repo/branchestra/.git",
    displayName: "Branchestra",
    headOid: "a".repeat(40),
    defaultBranch: "main",
    createdAt: CREATED_AT
  };
}

function room(): Room {
  return {
    id: ROOM_ID,
    projectId: PROJECT_ID,
    title: "Foundation",
    createdAt: CREATED_AT
  };
}

function messageEvent(body = "Persisted hello"): RoomEvent {
  return {
    id: "30000000-0000-4000-8000-000000000001",
    roomId: ROOM_ID,
    roomSeq: 1,
    type: "message.posted",
    actor: "user",
    payload: {
      id: "40000000-0000-4000-8000-000000000001",
      roomId: ROOM_ID,
      body,
      createdAt: CREATED_AT
    },
    createdAt: CREATED_AT
  };
}

function timelineState(): TimelineState {
  return {
    connection: "ready",
    snapshot: {
      projects: [project()],
      rooms: [room()],
      roomCursors: { [ROOM_ID]: 1 }
    },
    selectedProjectId: PROJECT_ID,
    selectedRoomId: ROOM_ID,
    eventsByRoom: { [ROOM_ID]: [messageEvent()] },
    error: null
  };
}

function preloadedTimelineStore(): TimelineStore {
  const state = timelineState();
  return {
    getState: () => state,
    subscribe: () => () => undefined,
    hydrate: vi.fn().mockResolvedValue(undefined),
    selectRoom: vi.fn().mockResolvedValue(undefined),
    addProject: vi.fn().mockResolvedValue(undefined),
    createRoom: vi.fn().mockResolvedValue(undefined),
    postMessage: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn()
  };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function successRendererResponse(
  command: RendererCommand,
  data: unknown
): WorkerResponseEnvelope {
  return {
    v: 1,
    requestId: "80000000-0000-4000-8000-000000000001",
    idempotencyKey: command.idempotencyKey,
    workerGeneration: GENERATION,
    type: "response",
    payload: {
      ok: true,
      requestType: command.type,
      data: data as ReturnType<typeof timelineState>["snapshot"],
      replayed: false
    }
  };
}

function realRendererApi(
  post: (command: RendererCommand) => Promise<WorkerResponseEnvelope> | WorkerResponseEnvelope
): {
  api: BranchestraApi;
  commands: RendererCommand[];
  disconnect(): void;
} {
  const commands: RendererCommand[] = [];
  const listeners = new Set<(event: WorkerEventEnvelope) => void>();
  const api: BranchestraApi = {
    async request(command) {
      commands.push(command);
      if (command.type === "message.post") return post(command);
      if (command.type === "state.getSnapshot") {
        return successRendererResponse(command, {
          ...timelineState().snapshot,
          roomCursors: { [ROOM_ID]: 0 }
        });
      }
      if (command.type === "room.replay") {
        return successRendererResponse(command, {
          roomId: ROOM_ID,
          events: [],
          nextRoomSeq: 0,
          hasMore: false
        });
      }
      throw new Error(`Unexpected command: ${command.type}`);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
  return {
    api,
    commands,
    disconnect() {
      const event: WorkerEventEnvelope = {
        v: 1,
        requestId: "60000000-0000-4000-8000-000000000001",
        idempotencyKey: "disconnect-1",
        workerGeneration: GENERATION,
        type: "worker.disconnected",
        payload: { reason: "worker exited" }
      };
      listeners.forEach((listener) => listener(event));
    }
  };
}

afterEach(cleanup);

describe("renderer shell", () => {
  it("renders Project/Room navigation, shared timeline, inspector, and composer", () => {
    const html = renderToStaticMarkup(<App store={preloadedTimelineStore()} />);

    expect(html).toContain("Projects");
    expect(html).toContain("Rooms");
    expect(html).toContain("Shared Timeline");
    expect(html).toContain("Inspector");
    expect(html).toContain("Persisted hello");
    expect(html).toContain("data-testid=\"message-input\"");
  });

  it("controls the room title and creates a room with the entered title", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    const onCreateRoom = vi.fn(() => pending.promise);
    render(
      <ProjectRail
        state={timelineState()}
        onAddProject={vi.fn()}
        onSelectRoom={vi.fn()}
        onCreateRoom={onCreateRoom}
      />
    );

    const input = screen.getByTestId("room-title-input");
    const submit = screen.getByTestId("create-room");
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    await user.type(input, "Roadmap");
    expect((input as HTMLInputElement).value).toBe("Roadmap");
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    await user.click(submit);

    expect(onCreateRoom).toHaveBeenCalledWith(PROJECT_ID, "Roadmap");
    expect((input as HTMLInputElement).value).toBe("Roadmap");
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await act(async () => pending.resolve());
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("retains a room draft and gives accessible guidance when creation rejects", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    const onCreateRoom = vi.fn(() => pending.promise);
    render(<ProjectRail state={timelineState()} onAddProject={vi.fn()} onSelectRoom={vi.fn()} onCreateRoom={onCreateRoom} />);
    const input = screen.getByTestId("room-title-input") as HTMLInputElement;
    const submit = screen.getByTestId("create-room") as HTMLButtonElement;
    await user.type(input, "Keep this room");
    await user.click(submit);
    await user.click(submit);
    expect(onCreateRoom).toHaveBeenCalledOnce();
    await act(async () => pending.reject(new Error("offline")));
    expect(input.value).toBe("Keep this room");
    expect(screen.getByRole("alert").textContent).toContain("not created");
  });

  it("retains a whitespace-different newer room draft when the pending submission resolves", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    render(<ProjectRail
      state={timelineState()}
      onAddProject={vi.fn()}
      onSelectRoom={vi.fn()}
      onCreateRoom={() => pending.promise}
    />);
    const input = screen.getByTestId("room-title-input") as HTMLInputElement;
    await user.type(input, "Roadmap");
    await user.click(screen.getByTestId("create-room"));
    await user.clear(input);
    await user.type(input, " Roadmap ");

    await act(async () => pending.resolve());

    expect(input.value).toBe(" Roadmap ");
  });

  it("exposes the create-room form for a selected empty project", () => {
    const addedProject: Project = {
      ...project(),
      id: "10000000-0000-4000-8000-000000000002",
      repositoryRoot: "/repo/new-project",
      gitCommonDir: "/repo/new-project/.git",
      displayName: "New Project"
    };
    const state: TimelineState = {
      ...timelineState(),
      snapshot: {
        projects: [project(), addedProject],
        rooms: [room()],
        roomCursors: { [ROOM_ID]: 1 }
      },
      selectedProjectId: addedProject.id,
      selectedRoomId: null
    };
    render(
      <ProjectRail
        state={state}
        onAddProject={vi.fn()}
        onSelectRoom={vi.fn()}
        onCreateRoom={vi.fn()}
      />
    );

    expect(screen.getByTestId("room-title-input").id).toBe(`room-title-${addedProject.id}`);
    expect(screen.getByText("Create a room to start a timeline.")).toBeTruthy();
  });

  it("selects a room and opens the native project picker", async () => {
    const user = userEvent.setup();
    const onAddProject = vi.fn();
    const onSelectRoom = vi.fn();
    render(
      <ProjectRail
        state={timelineState()}
        onAddProject={onAddProject}
        onSelectRoom={onSelectRoom}
        onCreateRoom={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Foundation" }));
    await user.click(screen.getByRole("button", { name: "Add Project" }));

    expect(onSelectRoom).toHaveBeenCalledWith(ROOM_ID);
    expect(onAddProject).toHaveBeenCalledOnce();
  });

  it("clears the composer only after sending resolves", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    const onSend = vi.fn(() => pending.promise);
    render(<Composer disabled={false} onSend={onSend} />);

    const input = screen.getByTestId("message-input") as HTMLTextAreaElement;
    const submit = screen.getByTestId("send-message") as HTMLButtonElement;
    await user.type(input, "Ship the timeline");
    await user.click(submit);

    expect(onSend).toHaveBeenCalledWith("Ship the timeline");
    expect(input.value).toBe("Ship the timeline");
    expect(submit.disabled).toBe(true);

    await act(async () => pending.resolve());
    expect(input.value).toBe("");
  });

  it("keeps a newer draft when an earlier message resolves", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    render(<Composer disabled={false} onSend={() => pending.promise} />);

    const input = screen.getByTestId("message-input") as HTMLTextAreaElement;
    await user.type(input, "First message");
    await user.click(screen.getByTestId("send-message"));
    await user.clear(input);
    await user.type(input, "Next draft");

    await act(async () => pending.resolve());

    expect(input.value).toBe("Next draft");
  });

  it("retains the composer draft and gives guidance when sending rejects", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    render(<Composer disabled={false} onSend={() => pending.promise} />);

    const input = screen.getByTestId("message-input") as HTMLTextAreaElement;
    await user.type(input, "Keep this draft");
    await user.click(screen.getByTestId("send-message"));
    await act(async () => pending.reject(new Error("offline")));

    expect(input.value).toBe("Keep this draft");
    expect(screen.getByRole("alert").textContent).toContain("not sent");
  });

  it("retains a newer draft and gives guidance when the submitted message rejects", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    render(<Composer disabled={false} onSend={() => pending.promise} />);

    const input = screen.getByTestId("message-input") as HTMLTextAreaElement;
    await user.type(input, "Submitted message");
    await user.click(screen.getByTestId("send-message"));
    await user.clear(input);
    await user.type(input, "Draft written while sending");
    await act(async () => pending.reject(new Error("offline")));

    expect(input.value).toBe("Draft written while sending");
    expect(screen.getByRole("alert").textContent).toContain("not sent");
  });

  it("retains the App composer draft when the real store receives a failed post response", async () => {
    const user = userEvent.setup();
    const commands: RendererCommand[] = [];
    const api: BranchestraApi = {
      async request(command) {
        commands.push(command);
        const base = {
          v: 1 as const,
          requestId: "80000000-0000-4000-8000-000000000001",
          idempotencyKey: command.idempotencyKey,
          workerGeneration: "50000000-0000-4000-8000-000000000001",
          type: "response" as const
        };
        if (command.type === "message.post") {
          return {
            ...base,
            payload: {
              ok: false,
              requestType: command.type,
              code: "INTERNAL",
              message: "Room is no longer available"
            }
          } satisfies WorkerResponseEnvelope;
        }
        const data = command.type === "state.getSnapshot"
          ? { ...timelineState().snapshot, roomCursors: { [ROOM_ID]: 0 } }
          : {
              roomId: ROOM_ID,
              events: [],
              nextRoomSeq: 0,
              hasMore: false
            };
        return {
          ...base,
          payload: {
            ok: true,
            requestType: command.type,
            data,
            replayed: false
          }
        } as WorkerResponseEnvelope;
      },
      subscribe() {
        return () => undefined;
      }
    };
    let id = 0;
    const store = createTimelineStore(api, () => (
      `70000000-0000-4000-8000-${String(++id).padStart(12, "0")}`
    ));
    render(<App store={store} />);
    const input = screen.getByTestId("message-input") as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));

    await user.type(input, "Keep this through the real store");
    await user.click(screen.getByTestId("send-message"));

    await waitFor(() => expect(screen.getByText("Message was not sent. Try again.")).toBeTruthy());
    expect(input.value).toBe("Keep this through the real store");
    expect(store.getState()).toMatchObject({
      connection: "error",
      error: "Room is no longer available"
    });
    expect(commands.filter((command) => command.type === "message.post")).toHaveLength(1);
  });

  it("retains the real-store draft when an old post succeeds after disconnect", async () => {
    const user = userEvent.setup();
    const pending = deferred<WorkerResponseEnvelope>();
    const fixture = realRendererApi(() => pending.promise);
    let id = 0;
    const store = createTimelineStore(fixture.api, () => (
      `70000000-0000-4000-8000-${String(++id).padStart(12, "0")}`
    ));
    const storeListener = vi.fn();
    store.subscribe(storeListener);
    render(<App store={store} />);
    const input = screen.getByTestId("message-input") as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    await user.type(input, "Draft survives stale success");
    await user.click(screen.getByTestId("send-message"));
    await waitFor(() => expect(
      fixture.commands.filter((command) => command.type === "message.post")
    ).toHaveLength(1));
    const postCommand = fixture.commands.find((command) => command.type === "message.post");
    if (!postCommand) throw new Error("Expected message post command");

    act(() => fixture.disconnect());
    const notificationsAfterDisconnect = storeListener.mock.calls.length;
    await act(async () => pending.resolve(successRendererResponse(
      postCommand,
      messageEvent("Draft survives stale success")
    )));

    await waitFor(() => expect(screen.getByText("Message was not sent. Try again.")).toBeTruthy());
    expect(input.value).toBe("Draft survives stale success");
    expect(store.getState()).toMatchObject({ connection: "reconnecting", error: null });
    expect(storeListener).toHaveBeenCalledTimes(notificationsAfterDisconnect);
    expect(fixture.commands.filter((command) => command.type === "message.post")).toEqual([
      postCommand
    ]);
  });

  it("retains the real-store draft when an old post rejects after disconnect", async () => {
    const user = userEvent.setup();
    const pending = deferred<WorkerResponseEnvelope>();
    const fixture = realRendererApi(() => pending.promise);
    let id = 0;
    const store = createTimelineStore(fixture.api, () => (
      `70000000-0000-4000-8000-${String(++id).padStart(12, "0")}`
    ));
    const storeListener = vi.fn();
    store.subscribe(storeListener);
    render(<App store={store} />);
    const input = screen.getByTestId("message-input") as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    await user.type(input, "Draft survives stale rejection");
    await user.click(screen.getByTestId("send-message"));
    await waitFor(() => expect(
      fixture.commands.filter((command) => command.type === "message.post")
    ).toHaveLength(1));
    const postCommand = fixture.commands.find((command) => command.type === "message.post");
    if (!postCommand) throw new Error("Expected message post command");

    act(() => fixture.disconnect());
    const notificationsAfterDisconnect = storeListener.mock.calls.length;
    await act(async () => pending.reject(new Error("old worker failed")));

    await waitFor(() => expect(screen.getByText("Message was not sent. Try again.")).toBeTruthy());
    expect(input.value).toBe("Draft survives stale rejection");
    expect(store.getState()).toMatchObject({ connection: "reconnecting", error: null });
    expect(storeListener).toHaveBeenCalledTimes(notificationsAfterDisconnect);
    expect(fixture.commands.filter((command) => command.type === "message.post")).toEqual([
      postCommand
    ]);
  });

  it("disables message entry and submission when no connected room is available", () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Composer disabled onSend={onSend} />);

    expect((screen.getByTestId("message-input") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByTestId("send-message") as HTMLButtonElement).disabled).toBe(true);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("renders escaped message text with a semantic actor and actual room sequence", () => {
    const unsafeBody = "<script>alert('branch')</script>";
    const event = {
      ...messageEvent(unsafeBody),
      roomSeq: 42
    };
    const html = renderToStaticMarkup(<Timeline events={[event]} />);

    expect(html).toContain("&lt;script&gt;alert(&#x27;branch&#x27;)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("aria-label=\"Actor: You\"");
    expect(html).toContain("aria-label=\"Room sequence 42\"");
    expect(html).toContain("value=\"42\"");
    expect(html).toContain(">You<");
  });

  it("hydrates once on mount and disposes the store on unmount", () => {
    const store = preloadedTimelineStore();
    const view = render(<App store={store} />);

    expect(store.hydrate).toHaveBeenCalledOnce();
    view.unmount();
    expect(store.dispose).toHaveBeenCalledOnce();
  });

  it("updates the selected timeline from store subscriptions", () => {
    let state = timelineState();
    const listeners = new Set<() => void>();
    const store: TimelineStore = {
      ...preloadedTimelineStore(),
      getState: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    };
    render(<App store={store} />);
    expect(screen.getByText("Persisted hello")).toBeTruthy();

    state = {
      ...state,
      eventsByRoom: { [ROOM_ID]: [messageEvent("Arrived from subscription")] }
    };
    act(() => listeners.forEach((listener) => listener()));

    expect(screen.getByText("Arrived from subscription")).toBeTruthy();
  });

  it("handles a selectRoom rejection while rendering the store error update", async () => {
    const user = userEvent.setup();
    let state = timelineState();
    const listeners = new Set<() => void>();
    const rejectedSelection = Promise.reject(new Error("Room replay failed"));
    void rejectedSelection.catch(() => undefined);
    const catchRejection = vi.spyOn(rejectedSelection, "catch");
    const store: TimelineStore = {
      ...preloadedTimelineStore(),
      getState: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      selectRoom: vi.fn(() => {
        state = { ...state, connection: "error", error: "Room replay failed" };
        listeners.forEach((listener) => listener());
        return rejectedSelection;
      })
    };
    render(<App store={store} />);

    await user.click(screen.getByRole("button", { name: "Foundation" }));

    await waitFor(() => expect(screen.getByText("Room replay failed")).toBeTruthy());
    expect(catchRejection).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({ connection: "error", error: "Room replay failed" });
  });

  it("constructs one timeline store and passes that singleton to the renderer", async () => {
    vi.resetModules();
    document.body.innerHTML = '<div id="root"></div>';
    const store = preloadedTimelineStore();
    const createTimelineStore = vi.fn(() => store);
    const renderRoot = vi.fn();
    const createRoot = vi.fn(() => ({ render: renderRoot }));
    const api = { request: vi.fn(), subscribe: vi.fn() };
    Object.defineProperty(window, "branchestra", { configurable: true, value: api });
    vi.doMock("../../src/renderer/state/timeline-store", () => ({ createTimelineStore }));
    vi.doMock("react-dom/client", () => ({ createRoot }));

    try {
      await import("../../src/renderer/main");
      expect(createTimelineStore).toHaveBeenCalledOnce();
      expect(createTimelineStore).toHaveBeenCalledWith(api);
      expect(createRoot).toHaveBeenCalledOnce();

      const rendered = renderRoot.mock.calls[0]?.[0] as React.ReactElement<{
        children?: React.ReactElement<{ store?: TimelineStore }>;
        store?: TimelineStore;
      }>;
      const app = rendered.props.store ? rendered : rendered.props.children;
      expect(app?.props.store).toBe(store);
    } finally {
      vi.doUnmock("../../src/renderer/state/timeline-store");
      vi.doUnmock("react-dom/client");
    }
  });

  it("keeps the project rail usable when the inspector moves below the timeline", () => {
    expect(rendererStyles).toMatch(
      /@media \(max-width: 979px\)[\s\S]*grid-template-columns: minmax\(220px, 0\.75fr\)/
    );
    expect(rendererStyles).toMatch(
      /@media \(max-width: 979px\)[\s\S]*\.room-form \{\s*grid-template-columns: minmax\(0, 1fr\)/
    );
  });
});
