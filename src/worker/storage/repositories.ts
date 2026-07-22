import type { Project, Room } from "../../shared/contracts/domain";
import { ProjectSchema, RoomSchema } from "../../shared/contracts/domain";
import { ApprovalRepository } from "../approvals/approval-repository";
import { OperationJournal } from "../operations/operation-journal";
import { TaskRepository } from "../tasks/task-repository";
import type { Database } from "./database";
import { createEventStore } from "./event-store";

export interface ProjectRepository {
  insert(project: Project): Project;
  findByRepositoryRoot(repositoryRoot: string): Project | undefined;
  findById(id: string): Project | undefined;
  list(): Project[];
}

export interface RoomRepository {
  insert(room: Room): Room;
  findById(id: string): Room | undefined;
  list(): Room[];
}

export interface EventStoreRepositories {
  projects: ProjectRepository;
  rooms: RoomRepository;
}

export interface DomainRepositories extends EventStoreRepositories {
  tasks: TaskRepository;
  approvals: ApprovalRepository;
  operations: OperationJournal;
}

interface ProjectRow {
  id: string;
  repository_root: string;
  git_common_dir: string;
  display_name: string;
  head_oid: string;
  default_branch: string | null;
  created_at: string;
}

interface RoomRow {
  id: string;
  project_id: string;
  title: string;
  created_at: string;
}

const mapProject = (row: ProjectRow): Project => ProjectSchema.parse({
  id: row.id,
  repositoryRoot: row.repository_root,
  gitCommonDir: row.git_common_dir,
  displayName: row.display_name,
  headOid: row.head_oid,
  defaultBranch: row.default_branch,
  createdAt: row.created_at
});

const mapRoom = (row: RoomRow): Room => RoomSchema.parse({
  id: row.id,
  projectId: row.project_id,
  title: row.title,
  createdAt: row.created_at
});

export function createRepositories(database: Database): DomainRepositories {
  const projectColumns = "id, repository_root, git_common_dir, display_name, head_oid, default_branch, created_at";
  const roomColumns = "id, project_id, title, created_at";
  const insertProject = database.prepare("INSERT INTO projects(id, repository_root, git_common_dir, display_name, head_oid, default_branch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const insertRoom = database.prepare("INSERT INTO rooms(id, project_id, title, created_at) VALUES (?, ?, ?, ?)");

  const projects: ProjectRepository = {
    insert(input) {
      const project = ProjectSchema.parse(input);
      insertProject.run(project.id, project.repositoryRoot, project.gitCommonDir, project.displayName, project.headOid, project.defaultBranch, project.createdAt);
      return project;
    },
    findByRepositoryRoot(repositoryRoot) {
      const row = database.prepare(`SELECT ${projectColumns} FROM projects WHERE repository_root = ?`).get(repositoryRoot) as ProjectRow | undefined;
      return row ? mapProject(row) : undefined;
    },
    findById(id) {
      const row = database.prepare(`SELECT ${projectColumns} FROM projects WHERE id = ?`).get(id) as ProjectRow | undefined;
      return row ? mapProject(row) : undefined;
    },
    list() {
      return (database.prepare(`SELECT ${projectColumns} FROM projects ORDER BY created_at, id`).all() as unknown as ProjectRow[]).map(mapProject);
    }
  };
  const rooms: RoomRepository = {
    insert(input) {
      const room = RoomSchema.parse(input);
      insertRoom.run(room.id, room.projectId, room.title, room.createdAt);
      return room;
    },
    findById(id) {
      const row = database.prepare(`SELECT ${roomColumns} FROM rooms WHERE id = ?`).get(id) as RoomRow | undefined;
      return row ? mapRoom(row) : undefined;
    },
    list() {
      return (database.prepare(`SELECT ${roomColumns} FROM rooms ORDER BY created_at, id`).all() as unknown as RoomRow[]).map(mapRoom);
    }
  };
  const repositories = { projects, rooms } as DomainRepositories;
  const canonicalEventStore = createEventStore(database, repositories);
  repositories.tasks = new TaskRepository(database, canonicalEventStore);
  repositories.approvals = new ApprovalRepository(database);
  repositories.operations = new OperationJournal(database);
  return repositories;
}
