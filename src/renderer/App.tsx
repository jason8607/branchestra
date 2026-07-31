import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Composer } from "./components/Composer";
import { Inspector } from "./components/Inspector";
import { ProjectRail } from "./components/ProjectRail";
import { Timeline } from "./components/Timeline";
import { useTaskInspector } from "./features/tasks/use-task-inspector";
import { ProviderHealthStep } from "./features/onboarding/ProviderHealthStep";
import { DiagnosticsPanel } from "./features/settings/diagnostics-panel";
import { DataManagementPanel } from "./features/settings/data-management-panel";
import type { ProjectCleanupPreview, RoomCleanupPreview, WorktreeCleanupPreview } from "../shared/contracts/protocol";
import type { TimelineStore } from "./state/timeline-store";

export function App({ store }: { store: TimelineStore }): React.JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const taskInspector = useTaskInspector(window.branchestra, state.selectedTaskId);
  const [diagnosticPending, setDiagnosticPending] = useState(false);
  const [diagnosticStatus, setDiagnosticStatus] = useState<string | null>(null);
  const [cleanupPreview, setCleanupPreview] = useState<RoomCleanupPreview | null>(null);
  const [cleanupConfirmation, setCleanupConfirmation] = useState("");
  const [cleanupPending, setCleanupPending] = useState(false);
  const [cleanupStatus, setCleanupStatus] = useState<string | null>(null);
  const [worktreePreview, setWorktreePreview] = useState<WorktreeCleanupPreview | null>(null);
  const [allowDirtyArchive, setAllowDirtyArchive] = useState(false);
  const [projectPreview, setProjectPreview] = useState<ProjectCleanupPreview | null>(null);
  const [projectConfirmation, setProjectConfirmation] = useState("");

  useEffect(() => {
    void store.hydrate().then(() => store.refreshProviderHealth()).catch(() => undefined);
    return () => store.dispose();
  }, [store]);

  useEffect(() => {
    setCleanupPreview(null);
    setCleanupConfirmation("");
    setCleanupStatus(null);
    setWorktreePreview(null);
    setAllowDirtyArchive(false);
  }, [state.selectedRoomId]);

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
        {state.snapshot.projects.length === 0
          ? <section className="timeline"><ProviderHealthStep
              health={state.providerHealth}
              onPick={(provider) => void store.pickProviderExecutable(provider)}
              onRefresh={() => void store.refreshProviderHealth()}
            /></section>
          : <Timeline events={events} onSelectTask={(taskId) => store.selectTask(taskId)} />}
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
        settings={<details>
          <summary>Settings</summary>
          <DiagnosticsPanel
            pending={diagnosticPending}
            onExport={() => {
              setDiagnosticPending(true);
              setDiagnosticStatus(null);
              void store.exportDiagnostics().then((result) => {
                setDiagnosticStatus("cancelled" in result
                  ? "Diagnostic export cancelled"
                  : `Diagnostic bundle exported (${result.bytes} bytes)`);
              }).catch((error: unknown) => {
                setDiagnosticStatus(error instanceof Error ? error.message : "Diagnostic export failed");
              }).finally(() => setDiagnosticPending(false));
            }}
          />
          {diagnosticStatus ? <p role="status">{diagnosticStatus}</p> : null}
          <DataManagementPanel
            roomId={room?.id ?? null}
            projectId={project?.id ?? null}
            preview={cleanupPreview}
            confirmation={cleanupConfirmation}
            pending={cleanupPending}
            worktrees={taskInspector.model?.worktrees ?? []}
            worktreePreview={worktreePreview}
            allowDirtyArchive={allowDirtyArchive}
            projectPreview={projectPreview}
            projectConfirmation={projectConfirmation}
            onConfirmation={setCleanupConfirmation}
            onPreviewRoom={() => {
              if (!room) return;
              setCleanupPending(true);
              setCleanupStatus(null);
              void store.previewRoomCleanup(room.id).then((preview) => {
                setCleanupPreview(preview);
                if (preview.activeTaskCount > 0) {
                  setCleanupStatus("Room metadata cannot be removed while it contains tasks.");
                }
              }).catch((error: unknown) => {
                setCleanupStatus(error instanceof Error ? error.message : "Unable to preview room removal");
              }).finally(() => setCleanupPending(false));
            }}
            onRemoveRoom={() => {
              if (!cleanupPreview) return;
              setCleanupPending(true);
              setCleanupStatus(null);
              void store.removeRoomCleanup({ ...cleanupPreview, confirmation: cleanupConfirmation })
                .then(() => {
                  setCleanupPreview(null);
                  setCleanupConfirmation("");
                  setCleanupStatus("Room metadata removed; filesystem backups are the only recovery source");
                }).catch((error: unknown) => {
                  setCleanupStatus(error instanceof Error ? error.message : "Room metadata removal failed");
                }).finally(() => setCleanupPending(false));
            }}
            onPreviewWorktree={(worktreeId) => {
              setCleanupPending(true);
              setCleanupStatus(null);
              setAllowDirtyArchive(false);
              void store.previewWorktreeCleanup(worktreeId).then(setWorktreePreview)
                .catch((error: unknown) => {
                  setCleanupStatus(error instanceof Error ? error.message : "Unable to preview worktree archive");
                }).finally(() => setCleanupPending(false));
            }}
            onAllowDirtyArchive={setAllowDirtyArchive}
            onArchiveWorktree={() => {
              if (!worktreePreview) return;
              setCleanupPending(true);
              setCleanupStatus(null);
              void store.archiveWorktreeCleanup({ ...worktreePreview, allowDirtyArchive })
                .then((recoveryPath) => {
                  setWorktreePreview(null);
                  setAllowDirtyArchive(false);
                  setCleanupStatus(`Worktree archived at ${recoveryPath}`);
                }).catch((error: unknown) => {
                  setCleanupStatus(error instanceof Error ? error.message : "Worktree archive failed");
                }).finally(() => setCleanupPending(false));
            }}
            onProjectConfirmation={setProjectConfirmation}
            onPreviewProject={() => {
              if (!project) return;
              setCleanupPending(true);
              setCleanupStatus(null);
              setProjectConfirmation("");
              void store.previewProjectCleanup(project.id).then(setProjectPreview)
                .catch((error: unknown) => {
                  setCleanupStatus(error instanceof Error ? error.message : "Unable to preview project removal");
                }).finally(() => setCleanupPending(false));
            }}
            onRemoveProject={() => {
              if (!projectPreview) return;
              setCleanupPending(true);
              setCleanupStatus(null);
              void store.removeProjectCleanup({ ...projectPreview, confirmation: projectConfirmation })
                .then(() => {
                  setProjectPreview(null);
                  setProjectConfirmation("");
                  setCleanupStatus("Project metadata removed; the Git repository was not deleted");
                }).catch((error: unknown) => {
                  setCleanupStatus(error instanceof Error ? error.message : "Project metadata removal failed");
                }).finally(() => setCleanupPending(false));
            }}
          />
          {cleanupStatus ? <p role="status">{cleanupStatus}</p> : null}
        </details>}
      />
    </main>
  );
}
