import React, { useState } from "react";
import type { TimelineState } from "../state/timeline-store";

export function ProjectRail(props: {
  state: TimelineState;
  onAddProject(): void;
  onSelectRoom(roomId: string): void;
  onCreateRoom(projectId: string, title: string): Promise<void>;
}): React.JSX.Element {
  const [roomTitle, setRoomTitle] = useState("");
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [creationError, setCreationError] = useState<string | null>(null);

  return (
    <nav className="project-rail" data-testid="project-rail" aria-label="專案與房間導覽">
      <header>
        <div className="brand-lockup">
          <span className="brand-glyph" aria-hidden="true">B</span>
          <div>
            <p className="brand-mark">Branchestra</p>
            <p className="brand-subtitle">本機代理工作台</p>
          </div>
        </div>
        <div className="rail-heading">
          <h2>專案</h2>
          <button className="quiet-button" type="button" onClick={props.onAddProject}>
            <span aria-hidden="true">＋</span> 加入專案
          </button>
        </div>
      </header>
      {props.state.snapshot.projects.map((project) => {
        const rooms = props.state.snapshot.rooms.filter((item) => item.projectId === project.id);
        const isSelected = project.id === props.state.selectedProjectId;
        return (
          <section className="project-group" key={project.id}>
            <h3>{project.displayName}</h3>
            <p className="section-label">房間</p>
            {rooms.length > 0 ? (
              <ul className="room-list">
                {rooms.map((room) => (
                  <li key={room.id}>
                    <button
                      className="room-link"
                      type="button"
                      aria-current={room.id === props.state.selectedRoomId ? "page" : undefined}
                      onClick={() => props.onSelectRoom(room.id)}
                    >
                      {room.title}
                    </button>
                  </li>
                ))}
              </ul>
            ) : <p className="empty-copy">建立一個房間，開始整理這個專案的工作。</p>}
            {isSelected ? <form
              className="room-form"
              onSubmit={(event) => {
                event.preventDefault();
                const submittedDraft = roomTitle;
                const submittedTitle = roomTitle.trim();
                if (submittedTitle.length === 0 || creatingRoom) return;
                setCreatingRoom(true);
                setCreationError(null);
                void props.onCreateRoom(project.id, submittedTitle)
                  .then(() => setRoomTitle((current) => (
                    current === submittedDraft ? "" : current
                  )))
                  .catch(() => setCreationError("無法建立房間，請檢查連線後再試一次。"))
                  .finally(() => setCreatingRoom(false));
              }}
            >
              <label htmlFor={`room-title-${project.id}`}>新房間名稱</label>
              <input
                id={`room-title-${project.id}`}
                data-testid="room-title-input"
                value={roomTitle}
                onChange={(event) => setRoomTitle(event.currentTarget.value)}
                placeholder="例如：首頁改版"
                aria-describedby={creationError ? `room-creation-error-${project.id}` : undefined}
              />
              <button
                type="submit"
                data-testid="create-room"
                disabled={creatingRoom || roomTitle.trim().length === 0}
              >
                {creatingRoom ? "建立中…" : "建立房間"}
              </button>
              {creationError ? (
                <p id={`room-creation-error-${project.id}`} role="alert">{creationError}</p>
              ) : null}
            </form> : null}
          </section>
        );
      })}
    </nav>
  );
}
