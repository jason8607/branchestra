import React from "react";
import type { RoomEvent } from "../../shared/contracts/domain";
import { SafeMarkdown } from "./safe-markdown";

type ConversationEvent =
  | Extract<RoomEvent, { type: "message.posted" }>
  | Extract<RoomEvent, { type: "agent.run" }>;

function isConversationEvent(event: RoomEvent): event is ConversationEvent {
  return event.type === "message.posted"
    || (event.type === "agent.run" && event.payload.event.type === "assistant.message");
}

function actorLabel(actor: RoomEvent["actor"]): string {
  switch (actor) {
    case "user": return "你";
    case "claude": return "Claude";
    case "codex": return "Codex";
    case "system": return "系統";
  }
}

function messageText(event: ConversationEvent): string {
  if (event.type === "message.posted") return event.payload.body;
  return event.payload.event.type === "assistant.message" ? event.payload.event.text : "";
}

export function Timeline(props: {
  events: readonly RoomEvent[];
}): React.JSX.Element {
  const latestAgentMessageByRun = new Map<string, string>();
  for (const event of props.events) {
    if (event.type === "agent.run" && event.payload.event.type === "assistant.message") {
      latestAgentMessageByRun.set(event.payload.run.id, event.id);
    }
  }
  const messages = props.events.filter((event): event is ConversationEvent => (
    isConversationEvent(event)
    && (event.type === "message.posted"
      || latestAgentMessageByRun.get(event.payload.run.id) === event.id)
  ));
  if (messages.length === 0) {
    return (
      <section className="timeline" data-testid="shared-timeline" aria-label="對話">
        <div className="timeline-empty">
          <span className="timeline-empty-mark" aria-hidden="true">⌁</span>
          <h2>開始對話</h2>
          <p className="empty-copy">輸入 @，選擇 Claude 或 Codex 後傳送訊息。</p>
        </div>
      </section>
    );
  }

  return (
    <section className="timeline" data-testid="shared-timeline" aria-label="對話">
      <ol className="event-list">
        {messages.map((event) => {
          const actor = actorLabel(event.actor);
          return (
            <li className={`event-entry event-entry--${event.actor}`} key={event.id}>
              <article>
                <header className="event-meta">
                  <span className={`event-actor event-actor--${event.actor}`} aria-label={`發言者：${actor}`}>{actor}</span>
                </header>
                <div className="event-body"><SafeMarkdown text={messageText(event)} /></div>
              </article>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
