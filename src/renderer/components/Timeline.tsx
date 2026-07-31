import React from "react";
import type { RoomEvent } from "../../shared/contracts/domain";
import { SafeMarkdown } from "./safe-markdown";

function taskId(event: RoomEvent): string | null {
  if (event.type === "task.created") return event.payload.task.id;
  if ("taskId" in event.payload && typeof event.payload.taskId === "string") return event.payload.taskId;
  if (event.type === "candidate.created") return event.payload.candidate.taskId;
  if (event.type === "approval.requested") return event.payload.request.taskId;
  if (event.type === "approval.decided") return event.payload.receipt.taskId;
  return null;
}

export function Timeline(props: {
  events: readonly RoomEvent[];
  onSelectTask?(taskId: string): void;
}): React.JSX.Element {
  if (props.events.length === 0) {
    return (
      <section className="timeline" data-testid="shared-timeline" aria-label="Shared timeline">
        <p className="empty-copy">No local messages yet. Write the first message below.</p>
      </section>
    );
  }

  return (
    <section className="timeline" data-testid="shared-timeline" aria-label="Shared timeline">
      <ol className="event-list">
        {props.events.map((event) => (
          <li className="event-entry" key={event.id} value={event.roomSeq}>
            <article>
              <header className="event-meta">
                <span className="event-actor" aria-label="Actor: You">You</span>
                <span className="event-sequence" aria-label={`Room sequence ${event.roomSeq}`}>
                  #{String(event.roomSeq).padStart(4, "0")}
                </span>
              </header>
              <div className="event-body">
                {event.type === "message.posted" ? <SafeMarkdown text={event.payload.body} /> : event.type}
              </div>
              {taskId(event) ? (
                <button type="button" onClick={() => props.onSelectTask?.(taskId(event)!)}>Open task</button>
              ) : null}
            </article>
          </li>
        ))}
      </ol>
    </section>
  );
}
