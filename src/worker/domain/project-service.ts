import { basename } from "node:path";
import type { Clock, IdGenerator, Project } from "../../shared/contracts/domain";
import { ProjectSchema } from "../../shared/contracts/domain";
import type { RepositoryInspection } from "../git/inspect-repository";
import { assertBranchName } from "../git/git-validation";
import type {
  DurableCommand,
  DurableResult,
  IdempotencyStore
} from "../storage/idempotency-store";
import type { DomainRepositories } from "../storage/repositories";

export interface ProjectServiceDependencies {
  repositories: DomainRepositories;
  idempotencyStore: IdempotencyStore;
  inspectRepository(path: string): Promise<RepositoryInspection>;
  clock: Clock;
  ids: IdGenerator;
}

export interface ProjectService {
  addExistingProject(
    input: { selectedPath: string },
    metadata: DurableCommand
  ): Promise<DurableResult<Project>>;
}

export function createProjectService(dependencies: ProjectServiceDependencies): ProjectService {
  return {
    async addExistingProject(input, metadata) {
      const replayed = dependencies.idempotencyStore.replay(metadata, ProjectSchema);
      if (replayed) return replayed;
      const inspection = await dependencies.inspectRepository(input.selectedPath);
      if (inspection.defaultBranch !== null) assertBranchName(inspection.defaultBranch);
      return dependencies.idempotencyStore.execute(metadata, ProjectSchema, () => {
        const existing = dependencies.repositories.projects.findByRepositoryRoot(inspection.repositoryRoot);
        if (existing) return existing;
        const displayName = ProjectSchema.shape.displayName.parse(
          basename(inspection.repositoryRoot) || inspection.repositoryRoot
        );
        return dependencies.repositories.projects.insert(ProjectSchema.parse({
          id: dependencies.ids.next(),
          ...inspection,
          displayName,
          createdAt: dependencies.clock.now()
        }));
      });
    }
  };
}
