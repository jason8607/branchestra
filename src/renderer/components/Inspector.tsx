import React from "react";
import type { Project, Room, TaskInspectorModel } from "../../shared/contracts/domain";
import type { TaskWorkerCommand } from "../../shared/contracts/protocol";
import { TaskInspector } from "../features/tasks/task-inspector";
import type { TimelineState } from "../state/timeline-store";

const CONNECTION_LABEL: Record<TimelineState["connection"], string> = {
  bootstrapping: "Starting",
  ready: "Ready",
  reconnecting: "Reconnecting",
  error: "Needs attention"
};

export function Inspector(props: {
  project: Project | null;
  room: Room | null;
  connection: TimelineState["connection"];
  taskModel?: TaskInspectorModel | null;
  taskPending?: boolean;
  taskError?: string | null;
  requestTask?(command: TaskWorkerCommand): Promise<TaskInspectorModel>;
}): React.JSX.Element {
  return (
    <aside className="room-inspector" data-testid="room-inspector" aria-labelledby="inspector-title">
      <header>
        <p className="section-kicker">Room details</p>
        <h2 id="inspector-title">Inspector</h2>
      </header>
      <dl className="inspector-list">
        <div>
          <dt>Room</dt>
          <dd>{props.room?.title ?? "No room selected"}</dd>
        </div>
        <div>
          <dt>Repository root</dt>
          <dd className="path-value">{props.project?.repositoryRoot ?? "Add a project to begin"}</dd>
        </div>
        <div>
          <dt>Connection</dt>
          <dd className={`connection-state connection-${props.connection}`}>
            {CONNECTION_LABEL[props.connection]}
          </dd>
        </div>
        <div>
          <dt>Timeline source</dt>
          <dd>Local messages</dd>
        </div>
      </dl>
      {props.connection === "error" ? (
        <p className="error-guidance">The timeline could not reconnect. Check the local worker and try again.</p>
      ) : null}
      {props.taskPending ? <p>Loading task…</p> : null}
      {props.taskError ? <p role="alert">{props.taskError}</p> : null}
      {props.taskModel && props.requestTask ? (
        <TaskInspector model={props.taskModel} request={props.requestTask} />
      ) : null}
    </aside>
  );
}
