import React, { useState } from "react";
import type { TimelineState } from "../state/timeline-store";

export function ProjectRail(props: {
  state: TimelineState;
  onAddProject(): void;
  onSelectRoom(roomId: string): void;
  onCreateRoom(projectId: string, title: string): void;
}): React.JSX.Element {
  const [roomTitle, setRoomTitle] = useState("");

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
                if (roomTitle.trim().length === 0) return;
                props.onCreateRoom(project.id, roomTitle);
                setRoomTitle("");
              }}
            >
              <label htmlFor={`room-title-${project.id}`}>New room title</label>
              <input
                id={`room-title-${project.id}`}
                data-testid="room-title-input"
                value={roomTitle}
                onChange={(event) => setRoomTitle(event.currentTarget.value)}
                placeholder="Room name"
              />
              <button
                type="submit"
                data-testid="create-room"
                disabled={roomTitle.trim().length === 0}
              >
                Create room
              </button>
            </form> : null}
          </section>
        );
      })}
    </nav>
  );
}
