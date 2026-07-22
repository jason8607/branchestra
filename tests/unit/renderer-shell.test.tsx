/// <reference types="node" />
// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
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
import type {
  TimelineState,
  TimelineStore
} from "../../src/renderer/state/timeline-store";

const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
const ROOM_ID = "20000000-0000-4000-8000-000000000001";
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

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
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
    const onCreateRoom = vi.fn();
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
    expect((input as HTMLInputElement).value).toBe("");
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
