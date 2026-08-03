import React, { useEffect, useSyncExternalStore } from "react";
import { Composer } from "./components/Composer";
import { ProjectRail } from "./components/ProjectRail";
import { Timeline } from "./components/Timeline";
import { ProviderHealthStep } from "./features/onboarding/ProviderHealthStep";
import type { TimelineStore } from "./state/timeline-store";

export function App({ store }: { store: TimelineStore }): React.JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);

  useEffect(() => {
    void store.hydrate().then(() => store.refreshProviderHealth()).catch(() => undefined);
    return () => store.dispose();
  }, [store]);

  const room = state.snapshot.rooms.find((item) => item.id === state.selectedRoomId) ?? null;
  const events = room ? (state.eventsByRoom[room.id] ?? []) : [];
  const reconnecting = state.connection === "reconnecting" || state.connection === "error";

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
          <p className="section-kicker">{room ? room.title : "尚未選擇房間"}</p>
          <h1>{room ? "對話" : "開始使用"}</h1>
          {reconnecting
            ? <p className="connection-error" role="status">正在重新連線…</p>
            : null}
        </header>
        {state.snapshot.projects.length === 0
          ? <section className="timeline"><ProviderHealthStep
              health={state.providerHealth}
              onPick={(provider) => void store.pickProviderExecutable(provider)}
              onRefresh={() => void store.refreshProviderHealth()}
            /></section>
          : <Timeline events={events} />}
        <Composer
          disabled={!room || state.connection !== "ready"}
          onSend={(body) => room ? store.postMessage(room.id, body) : Promise.resolve()}
        />
      </section>
    </main>
  );
}
