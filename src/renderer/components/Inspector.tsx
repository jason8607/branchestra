import React from "react";
import type { Project, Room, TaskInspectorModel } from "../../shared/contracts/domain";
import type { TaskWorkerCommand } from "../../shared/contracts/protocol";
import { TaskInspector } from "../features/tasks/task-inspector";
import type { TimelineState } from "../state/timeline-store";
import { CONNECTION_LABEL } from "../locale/zh-TW";

export function Inspector(props: {
  project: Project | null;
  room: Room | null;
  connection: TimelineState["connection"];
  taskModel?: TaskInspectorModel | null;
  taskPending?: boolean;
  taskError?: string | null;
  requestTask?(command: TaskWorkerCommand): Promise<TaskInspectorModel>;
  settings?: React.ReactNode;
}): React.JSX.Element {
  return (
    <aside className="room-inspector" data-testid="room-inspector" aria-labelledby="inspector-title">
      <header>
        <p className="section-kicker">目前工作區</p>
        <h2 id="inspector-title">詳細資訊</h2>
      </header>
      <dl className="inspector-list">
        <div>
          <dt>房間</dt>
          <dd>{props.room?.title ?? "尚未選擇房間"}</dd>
        </div>
        <div>
          <dt>儲存庫位置</dt>
          <dd className="path-value">{props.project?.repositoryRoot ?? "先加入一個專案"}</dd>
        </div>
        <div>
          <dt>連線狀態</dt>
          <dd className={`connection-state connection-${props.connection}`}>
            {CONNECTION_LABEL[props.connection]}
          </dd>
        </div>
        <div>
          <dt>資料來源</dt>
          <dd>這台 Mac 上的本機訊息</dd>
        </div>
      </dl>
      {props.connection === "error" ? (
        <p className="error-guidance">無法重新連上本機工作程序，請稍後再試。</p>
      ) : null}
      {props.taskPending ? <p>正在載入任務…</p> : null}
      {props.taskError ? <p role="alert">{props.taskError}</p> : null}
      {props.taskModel && props.requestTask ? (
        <TaskInspector model={props.taskModel} request={props.requestTask} />
      ) : null}
      {props.settings}
    </aside>
  );
}
