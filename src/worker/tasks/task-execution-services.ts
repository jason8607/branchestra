import type { RoomEvent } from "../../shared/contracts/domain";
import type { GitArtifactRepository } from "../git/git-artifact-repository";
import type { GitManager } from "../git/git-manager";
import { IntegrationService } from "../git/integration-service";
import type { JournaledOperationRunner } from "../operations/journaled-operation-runner";
import type { EventStore } from "../storage/event-store";
import type { DomainRepositories } from "../storage/repositories";
import { CollaborationCoordinator } from "./collaboration-coordinator";
import type { TaskProviderPort } from "./provider-port";
import { TaskEngine } from "./task-engine";

export interface TaskExecutionServicesOptions {
  repositories: DomainRepositories;
  artifacts: GitArtifactRepository;
  events: EventStore;
  manager: GitManager;
  provider: TaskProviderPort;
  operations: JournaledOperationRunner;
  workerGeneration: string;
  contextVersion: number;
  contextHash: `sha256:${string}`;
  prepareContext?: NonNullable<import("./task-engine").TaskEngineOptions["prepareContext"]>;
  id(): string;
  now(): string;
  publish?(event: RoomEvent): void | Promise<void>;
}

export interface TaskExecutionServices {
  engine: TaskEngine;
  collaboration: CollaborationCoordinator;
  integration: IntegrationService;
}

export function createTaskExecutionServices(
  options: TaskExecutionServicesOptions
): TaskExecutionServices {
  const engine = new TaskEngine({
    repositories: options.repositories,
    artifacts: options.artifacts,
    events: options.events,
    manager: options.manager,
    provider: options.provider,
    operations: options.operations,
    workerGeneration: options.workerGeneration,
    contextVersion: options.contextVersion,
    contextHash: options.contextHash,
    ...(options.prepareContext ? { prepareContext: options.prepareContext } : {}),
    id: options.id,
    now: options.now,
    ...(options.publish ? { publish: options.publish } : {})
  });
  const collaboration = new CollaborationCoordinator({
    repositories: options.repositories,
    artifacts: options.artifacts,
    events: options.events,
    manager: options.manager,
    engine,
    workerGeneration: options.workerGeneration,
    contextVersion: options.contextVersion,
    contextHash: options.contextHash,
    id: options.id,
    now: options.now,
    ...(options.publish ? { publish: options.publish } : {})
  });
  const integration = new IntegrationService({
    artifacts: options.artifacts,
    tasks: options.repositories.tasks,
    projects: options.repositories.projects,
    events: options.events,
    manager: options.manager,
    id: options.id,
    now: options.now,
    ...(options.publish ? { publish: options.publish } : {})
  });
  return { engine, collaboration, integration };
}
