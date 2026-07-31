import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface WorkspaceGuardIdentity {
  repositoryRootRealpath: string;
  worktreeRootRealpath: string;
  gitCommonDirRealpath: string;
}

export class WorkspacePathError extends Error {}

function isContainedBy(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}

function assertValidCandidate(candidate: string): void {
  if (candidate.length === 0 || candidate.includes("\0")) throw new WorkspacePathError("PATH_INVALID");
  const withoutRoot = isAbsolute(candidate) ? candidate.slice(candidate.indexOf(sep) + 1) : candidate;
  if (withoutRoot.split(sep).some((component) => component.length === 0 || component === "." || component === "..")) {
    throw new WorkspacePathError("PATH_INVALID");
  }
}

function isGitMetadataPath(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ".git" || pathFromRoot.startsWith(`.git${sep}`);
}

async function canonicalizeWithMissingLeaf(candidate: string): Promise<string> {
  let ancestor = candidate;
  const missing: string[] = [];
  while (true) {
    try {
      await lstat(ancestor);
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = resolve(ancestor, "..");
      if (parent === ancestor) throw error;
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
  return join(await realpath(ancestor), ...missing);
}

export class WorkspacePathGuard {
  private constructor(
    private readonly identity: WorkspaceGuardIdentity,
    private readonly gitMetadataPaths: readonly string[]
  ) {}

  static async create(identity: WorkspaceGuardIdentity): Promise<WorkspacePathGuard> {
    const canonicalIdentity = {
      repositoryRootRealpath: await realpath(identity.repositoryRootRealpath),
      worktreeRootRealpath: await realpath(identity.worktreeRootRealpath),
      gitCommonDirRealpath: await realpath(identity.gitCommonDirRealpath)
    };
    const gitMetadataPaths = await Promise.all([
      canonicalizeWithMissingLeaf(join(canonicalIdentity.repositoryRootRealpath, ".git")),
      canonicalizeWithMissingLeaf(join(canonicalIdentity.worktreeRootRealpath, ".git"))
    ]);
    return new WorkspacePathGuard(canonicalIdentity, gitMetadataPaths);
  }

  async resolveReadable(candidate: string): Promise<string> {
    const canonical = await this.resolveCandidate(candidate);
    if (!isContainedBy(this.identity.repositoryRootRealpath, canonical)
      && !isContainedBy(this.identity.worktreeRootRealpath, canonical)) {
      throw new WorkspacePathError("PATH_ESCAPES_WORKTREE");
    }
    return canonical;
  }

  async resolveWritable(candidate: string): Promise<string> {
    const canonical = await this.resolveCandidate(candidate);
    if (!isContainedBy(this.identity.worktreeRootRealpath, canonical)) {
      throw new WorkspacePathError("PATH_ESCAPES_WORKTREE");
    }
    return canonical;
  }

  async assertChildCwd(candidate: string): Promise<string> {
    const canonical = await this.resolveWritable(candidate);
    let stats;
    try {
      stats = await lstat(canonical);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new WorkspacePathError("PATH_NOT_DIRECTORY", { cause: error });
      }
      throw error;
    }
    if (!stats.isDirectory()) throw new WorkspacePathError("PATH_NOT_DIRECTORY");
    return canonical;
  }

  private async resolveCandidate(candidate: string): Promise<string> {
    assertValidCandidate(candidate);
    const absoluteCandidate = isAbsolute(candidate)
      ? candidate
      : join(this.identity.worktreeRootRealpath, candidate);
    if (isGitMetadataPath(this.identity.worktreeRootRealpath, absoluteCandidate)
      || isGitMetadataPath(this.identity.repositoryRootRealpath, absoluteCandidate)) {
      throw new WorkspacePathError("PATH_IS_GIT_METADATA");
    }
    const canonical = await canonicalizeWithMissingLeaf(absoluteCandidate);
    if (isContainedBy(this.identity.gitCommonDirRealpath, canonical)
      || this.gitMetadataPaths.some((metadataPath) => isContainedBy(metadataPath, canonical))) {
      throw new WorkspacePathError("PATH_IS_GIT_METADATA");
    }
    return canonical;
  }
}
