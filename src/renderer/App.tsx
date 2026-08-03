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
          <p className="section-kicker">{room ? room.title : "尚未選擇房間"}</p>
          <h1>{room ? "對話" : "開始使用"}</h1>
          {state.error ? <p className="connection-error" role="alert">{state.error}</p> : null}
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
      <Inspector
        project={project}
        room={room}
        connection={state.connection}
        taskModel={taskInspector.model}
        taskPending={taskInspector.pending}
        taskError={taskInspector.error}
        requestTask={taskInspector.request}
        settings={<details>
          <summary>設定與資料</summary>
          <DiagnosticsPanel
            pending={diagnosticPending}
            onExport={() => {
              setDiagnosticPending(true);
              setDiagnosticStatus(null);
              void store.exportDiagnostics().then((result) => {
                setDiagnosticStatus("cancelled" in result
                  ? "已取消匯出診斷資料"
                  : `診斷資料已匯出（${result.bytes} 位元組）`);
              }).catch((error: unknown) => {
                setDiagnosticStatus(error instanceof Error ? error.message : "無法匯出診斷資料");
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
                  setCleanupStatus("房間內仍有任務，無法移除本機資料。");
                }
              }).catch((error: unknown) => {
                setCleanupStatus(error instanceof Error ? error.message : "無法預覽房間資料移除內容");
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
                  setCleanupStatus("房間的本機資料已移除；之後只能從檔案系統備份復原");
                }).catch((error: unknown) => {
                  setCleanupStatus(error instanceof Error ? error.message : "無法移除房間的本機資料");
                }).finally(() => setCleanupPending(false));
            }}
            onPreviewWorktree={(worktreeId) => {
              setCleanupPending(true);
              setCleanupStatus(null);
              setAllowDirtyArchive(false);
              void store.previewWorktreeCleanup(worktreeId).then(setWorktreePreview)
                .catch((error: unknown) => {
                  setCleanupStatus(error instanceof Error ? error.message : "無法預覽 worktree 封存內容");
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
                  setCleanupStatus(`Worktree 已封存至 ${recoveryPath}`);
                }).catch((error: unknown) => {
                  setCleanupStatus(error instanceof Error ? error.message : "無法封存 worktree");
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
                  setCleanupStatus(error instanceof Error ? error.message : "無法預覽專案資料移除內容");
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
                  setCleanupStatus("專案的本機資料已移除；Git 儲存庫未被刪除");
                }).catch((error: unknown) => {
                  setCleanupStatus(error instanceof Error ? error.message : "無法移除專案的本機資料");
                }).finally(() => setCleanupPending(false));
            }}
          />
          {cleanupStatus ? <p role="status">{cleanupStatus}</p> : null}
        </details>}
      />
    </main>
  );
}
