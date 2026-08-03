import React from "react";
import type { RoomEvent } from "../../shared/contracts/domain";
import { SafeMarkdown } from "./safe-markdown";
import { roomEventLabel } from "../locale/zh-TW";

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
      <section className="timeline" data-testid="shared-timeline" aria-label="共享時間軸">
        <div className="timeline-empty">
          <span className="timeline-empty-mark" aria-hidden="true">⌁</span>
          <h2>從第一則訊息開始</h2>
          <p className="empty-copy">這個房間的訊息與任務進度會依序保存在這台 Mac。</p>
        </div>
      </section>
    );
  }

  return (
    <section className="timeline" data-testid="shared-timeline" aria-label="共享時間軸">
      <ol className="event-list">
        {props.events.map((event) => (
          <li className="event-entry" key={event.id} value={event.roomSeq}>
            <article>
              <header className="event-meta">
                <span className="event-actor" aria-label="發言者：你">你</span>
                <span className="event-sequence" aria-label={`房間序號 ${event.roomSeq}`}>
                  #{String(event.roomSeq).padStart(4, "0")}
                </span>
              </header>
              <div className="event-body">
                {event.type === "message.posted" ? <SafeMarkdown text={event.payload.body} /> : roomEventLabel(event)}
              </div>
              {taskId(event) ? (
                <button className="inline-action" type="button" onClick={() => props.onSelectTask?.(taskId(event)!)}>查看任務</button>
              ) : null}
            </article>
          </li>
        ))}
      </ol>
    </section>
  );
}
