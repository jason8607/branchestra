import React from "react";
import type { RoomEvent } from "../../shared/contracts/domain";

export function Timeline(props: { events: readonly RoomEvent[] }): React.JSX.Element {
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
              <p className="event-body">{event.type === "message.posted" ? event.payload.body : event.type}</p>
            </article>
          </li>
        ))}
      </ol>
    </section>
  );
}
