import React, { useEffect, useSyncExternalStore } from "react";
import { Composer } from "./components/Composer";
import { Inspector } from "./components/Inspector";
import { ProjectRail } from "./components/ProjectRail";
import { Timeline } from "./components/Timeline";
import { useTaskInspector } from "./features/tasks/use-task-inspector";
import type { TimelineStore } from "./state/timeline-store";

export function App({ store }: { store: TimelineStore }): React.JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const taskInspector = useTaskInspector(window.branchestra, state.selectedTaskId);

  useEffect(() => {
    void store.hydrate();
    return () => store.dispose();
  }, [store]);

  const project = state.snapshot.projects.find((item) => item.id === state.selectedProjectId) ?? null;
  const room = state.snapshot.rooms.find((item) => item.id === state.selectedRoomId) ?? null;
  const events = room ? (state.eventsByRoom[room.id] ?? []) : [];

  return (
    <main className="app-shell">
      <ProjectRail
        state={state}
        onAddProject={() => void store.addProject()}
        onSelectRoom={(roomId) => void store.selectRoom(roomId).catch(() => undefined)}
        onCreateRoom={(projectId, title) => store.createRoom(projectId, title)}
      />
      <section className="timeline-column">
        <header className="timeline-header">
          <p className="section-kicker">{room ? room.title : "No room selected"}</p>
          <h1>Shared Timeline</h1>
          {state.error ? <p className="connection-error" role="alert">{state.error}</p> : null}
        </header>
        <Timeline events={events} onSelectTask={(taskId) => store.selectTask(taskId)} />
        <Composer
          disabled={!room || state.connection !== "ready"}
          onSend={(body) => room ? store.postMessage(room.id, body) : Promise.resolve()}
        />
      </section>
      <Inspector
        project={project}
        room={room}
        connection={state.connection}
        taskModel={taskInspector.model}
        taskPending={taskInspector.pending}
        taskError={taskInspector.error}
        requestTask={taskInspector.request}
      />
    </main>
  );
}
