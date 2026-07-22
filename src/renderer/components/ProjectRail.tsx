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
    <nav className="project-rail" data-testid="project-rail" aria-label="Project and room navigation">
      <header>
        <p className="brand-mark">Branchestra</p>
        <div className="rail-heading">
          <h2>Projects</h2>
          <button type="button" onClick={props.onAddProject}>Add Project</button>
        </div>
      </header>
      {props.state.snapshot.projects.map((project) => {
        const rooms = props.state.snapshot.rooms.filter((item) => item.projectId === project.id);
        const isSelected = project.id === props.state.selectedProjectId;
        return (
          <section className="project-group" key={project.id}>
            <h3>{project.displayName}</h3>
            <p className="section-label">Rooms</p>
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
            ) : <p className="empty-copy">Create a room to start a timeline.</p>}
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
                  .catch(() => setCreationError("Room was not created. Check the connection and try again."))
                  .finally(() => setCreatingRoom(false));
              }}
            >
              <label htmlFor={`room-title-${project.id}`}>New room title</label>
              <input
                id={`room-title-${project.id}`}
                data-testid="room-title-input"
                value={roomTitle}
                onChange={(event) => setRoomTitle(event.currentTarget.value)}
                placeholder="Room name"
                aria-describedby={creationError ? `room-creation-error-${project.id}` : undefined}
              />
              <button
                type="submit"
                data-testid="create-room"
                disabled={creatingRoom || roomTitle.trim().length === 0}
              >
                {creatingRoom ? "Creating…" : "Create room"}
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
