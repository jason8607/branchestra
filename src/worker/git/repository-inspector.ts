import { access, realpath } from "node:fs/promises";
import { isAbsolute, sep } from "node:path";
import { TextDecoder } from "node:util";
import { GitCommandRunner } from "./git-command-runner";
import { assertBranchRef, assertGitOid } from "./git-validation";

export interface RepositoryIdentity {
  rootRealpath: string;
  commonDirRealpath: string;
  gitDirRealpath: string;
  headOid: string;
  headRef: string;
}

export interface GitStatus {
  clean: boolean;
  entries: string[];
  inProgressOperation: string | null;
}

export interface GitDiffFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface GitWorktreeOwner {
  pathRealpath: string;
  headOid: string;
  branchRef: string | null;
  locked: boolean;
}

export interface GitLogEntry {
  oid: string;
  parents: string[];
  subject: string;
  authoredAt: string;
}

export class GitReadError extends Error {}

const STATUS_SENTINELS = [
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["REBASE_HEAD", "rebase"],
  ["BISECT_LOG", "bisect"]
] as const;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const DIFF_SAFETY_OPTIONS = ["--no-ext-diff", "--no-textconv"] as const;

function line(output: string): string {
  if (output.endsWith("\r\n")) return output.slice(0, -2);
  if (output.endsWith("\n")) return output.slice(0, -1);
  return output;
}

function decodeUtf8(buffer: Buffer): string {
  try {
    return UTF8_DECODER.decode(buffer);
  } catch (error) {
    throw new GitReadError("GIT_OUTPUT_INVALID_UTF8", { cause: error });
  }
}

function assertPathspec(pathspec: string): void {
  if (pathspec.length === 0 || pathspec.includes("\0") || pathspec.startsWith(":") || isAbsolute(pathspec)) {
    throw new GitReadError("GIT_PATHSPEC_INVALID");
  }
  const components = pathspec.split(sep);
  if (components.some((component) => component === "" || component === "." || component === "..")
    || components[0] === ".git") {
    throw new GitReadError("GIT_PATHSPEC_INVALID");
  }
}

function splitNul(buffer: Buffer): string[] {
  return decodeUtf8(buffer).split("\0").filter((entry) => entry.length > 0);
}

function revisionArguments(fromOid: string, toOid: string | undefined): string[] {
  assertGitOid(fromOid);
  if (toOid !== undefined) assertGitOid(toOid);
  return toOid === undefined ? [fromOid] : [fromOid, toOid];
}

function appendPathspec(argv: string[], pathspec: string[] | undefined): string[] {
  if (pathspec === undefined) return argv;
  for (const path of pathspec) assertPathspec(path);
  return [...argv, "--", ...pathspec];
}

interface NameStatus {
  path: string;
  status: string;
}

function parseNameStatus(buffer: Buffer): NameStatus[] {
  const tokens = splitNul(buffer);
  const entries: NameStatus[] = [];
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index] ?? "";
    const tab = token.indexOf("\t");
    const statusToken = tab === -1 ? token : token.slice(0, tab);
    const firstPath = tab === -1 ? tokens[index + 1] : token.slice(tab + 1);
    if (firstPath === undefined) throw new GitReadError("GIT_OUTPUT_INVALID");
    const renamed = statusToken.startsWith("R") || statusToken.startsWith("C");
    const finalPath = renamed ? tokens[index + (tab === -1 ? 2 : 1)] : firstPath;
    if (finalPath === undefined) throw new GitReadError("GIT_OUTPUT_INVALID");
    entries.push({ path: finalPath, status: statusToken.slice(0, 1) });
    index += tab === -1 ? (renamed ? 3 : 2) : (renamed ? 2 : 1);
  }
  return entries;
}

interface Numstat {
  path: string;
  additions: number;
  deletions: number;
}

function parseNumstat(buffer: Buffer): Numstat[] {
  const tokens = decodeUtf8(buffer).split("\0");
  const entries: Numstat[] = [];
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index];
    if (token === undefined || token === "") {
      index += 1;
      continue;
    }
    const fields = token.split("\t");
    if (fields.length !== 3) throw new GitReadError("GIT_OUTPUT_INVALID");
    const [rawAdditions = "", rawDeletions = "", inlinePath = ""] = fields;
    let path = inlinePath;
    if (path === "") {
      const renamedPath = tokens[index + 2];
      if (renamedPath === undefined || renamedPath === "") throw new GitReadError("GIT_OUTPUT_INVALID");
      path = renamedPath;
      index += 3;
    } else {
      index += 1;
    }
    entries.push({
      path,
      additions: rawAdditions === "-" ? 0 : Number.parseInt(rawAdditions, 10),
      deletions: rawDeletions === "-" ? 0 : Number.parseInt(rawDeletions, 10)
    });
  }
  return entries;
}

export class GitReadService {
  constructor(private readonly git: Pick<GitCommandRunner, "run" | "runBuffer">) {}

  async inspectRepository(selectedPath: string, storedRepositoryRootRealpath?: string): Promise<RepositoryIdentity> {
    const selectedRealpath = await realpath(selectedPath);
    const bare = line((await this.git.run(selectedRealpath, ["rev-parse", "--is-bare-repository"])).stdout);
    if (bare === "true") throw new GitReadError("REPOSITORY_BARE");

    const rootOutput = line((await this.git.run(selectedRealpath, [
      "rev-parse", "--path-format=absolute", "--show-toplevel"
    ])).stdout);
    const rootRealpath = await realpath(rootOutput);
    if (storedRepositoryRootRealpath !== undefined
      && rootRealpath !== await realpath(storedRepositoryRootRealpath)) {
      throw new GitReadError("REPOSITORY_IDENTITY_MISMATCH");
    }
    const commonOutput = line((await this.git.run(rootRealpath, [
      "rev-parse", "--path-format=absolute", "--git-common-dir"
    ])).stdout);
    const gitDirOutput = line((await this.git.run(rootRealpath, [
      "rev-parse", "--path-format=absolute", "--git-dir"
    ])).stdout);
    const commonDirRealpath = await realpath(commonOutput);
    const gitDirRealpath = await realpath(gitDirOutput);

    let headOid: string;
    try {
      headOid = line((await this.git.run(rootRealpath, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout);
    } catch (error) {
      throw new GitReadError("REPOSITORY_HEAD_MISSING", { cause: error });
    }
    assertGitOid(headOid);

    let headRef: string;
    try {
      headRef = line((await this.git.run(rootRealpath, ["symbolic-ref", "HEAD"])).stdout);
    } catch (error) {
      throw new GitReadError("REPOSITORY_HEAD_DETACHED", { cause: error });
    }
    assertBranchRef(headRef);
    return { rootRealpath, commonDirRealpath, gitDirRealpath, headOid, headRef };
  }

  async status(input: {
    repositoryRootRealpath: string;
    worktreePathRealpath: string;
  }): Promise<GitStatus> {
    const repositoryRootRealpath = await realpath(input.repositoryRootRealpath);
    const worktreePathRealpath = await realpath(input.worktreePathRealpath);
    const [repositoryIdentity, worktreeIdentity] = await Promise.all([
      this.observeRepositoryLocation(repositoryRootRealpath),
      this.observeRepositoryLocation(worktreePathRealpath)
    ]);
    if (repositoryIdentity.rootRealpath !== repositoryRootRealpath
      || worktreeIdentity.rootRealpath !== worktreePathRealpath
      || repositoryIdentity.commonDirRealpath !== worktreeIdentity.commonDirRealpath) {
      throw new GitReadError("REPOSITORY_IDENTITY_MISMATCH");
    }
    const statusBuffer = await this.git.runBuffer(worktreePathRealpath, [
      "status", "--porcelain=v2", "-z", "--untracked-files=all"
    ]);
    const entries = splitNul(statusBuffer);
    let inProgressOperation: string | null = null;
    for (const [sentinel, operation] of STATUS_SENTINELS) {
      const sentinelPath = line((await this.git.run(worktreePathRealpath, [
        "rev-parse", "--path-format=absolute", "--git-path", sentinel
      ])).stdout);
      try {
        await access(sentinelPath);
        inProgressOperation = operation;
        break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    return { clean: entries.length === 0, entries, inProgressOperation };
  }

  async diff(input: {
    repositoryRootRealpath: string;
    fromOid: string;
    toOid?: string;
    pathspec?: string[];
  }): Promise<{ patch: string; files: GitDiffFile[] }> {
    const revisions = revisionArguments(input.fromOid, input.toOid);
    const patchArgv = appendPathspec(["diff", ...DIFF_SAFETY_OPTIONS, "--binary", ...revisions], input.pathspec);
    const numstatArgv = appendPathspec(["diff", ...DIFF_SAFETY_OPTIONS, "--numstat", "-z", ...revisions], input.pathspec);
    const namesArgv = appendPathspec(["diff", ...DIFF_SAFETY_OPTIONS, "--name-status", "-z", ...revisions], input.pathspec);
    const [patch, numstat, names] = await Promise.all([
      this.git.runBuffer(input.repositoryRootRealpath, patchArgv),
      this.git.runBuffer(input.repositoryRootRealpath, numstatArgv),
      this.git.runBuffer(input.repositoryRootRealpath, namesArgv)
    ]);
    const numbersByPath = new Map(parseNumstat(numstat).map((entry) => [entry.path, entry]));
    const files = parseNameStatus(names).map(({ path, status }) => {
      const numbers = numbersByPath.get(path);
      if (numbers === undefined) throw new GitReadError("GIT_OUTPUT_INVALID");
      return { path, status, additions: numbers.additions, deletions: numbers.deletions };
    });
    return { patch: decodeUtf8(patch), files };
  }

  async show(input: { repositoryRootRealpath: string; oid: string; path?: string }): Promise<string> {
    assertGitOid(input.oid);
    const argv = ["show", ...DIFF_SAFETY_OPTIONS, input.oid];
    if (input.path !== undefined) {
      assertPathspec(input.path);
      argv.push("--", input.path);
    }
    return decodeUtf8(await this.git.runBuffer(input.repositoryRootRealpath, argv));
  }

  async log(input: {
    repositoryRootRealpath: string;
    startOid: string;
    maxCount: number;
  }): Promise<GitLogEntry[]> {
    assertGitOid(input.startOid);
    if (!Number.isInteger(input.maxCount) || input.maxCount < 1 || input.maxCount > 200) {
      throw new GitReadError("GIT_LOG_COUNT_INVALID");
    }
    const oidBuffer = await this.git.runBuffer(input.repositoryRootRealpath, [
      "log",
      ...DIFF_SAFETY_OPTIONS,
      `--max-count=${input.maxCount}`,
      "--format=%H",
      "-z",
      input.startOid
    ]);
    const oids = splitNul(oidBuffer);
    if (oids.length < 1 || oids.length > input.maxCount) throw new GitReadError("GIT_OUTPUT_INVALID");
    for (const oid of oids) assertGitOid(oid);
    const entries: GitLogEntry[] = [];
    for (const oid of oids) {
      const metadata = await this.git.runBuffer(input.repositoryRootRealpath, [
        "show",
        ...DIFF_SAFETY_OPTIONS,
        "--no-patch",
        "--format=%H%n%P%n%aI%n%s",
        oid
      ]);
      entries.push(this.parseLogMetadata(oid, metadata));
    }
    return entries;
  }

  async listWorktrees(repositoryRootRealpath: string): Promise<GitWorktreeOwner[]> {
    const tokens = splitNul(await this.git.runBuffer(repositoryRootRealpath, [
      "worktree", "list", "--porcelain", "-z"
    ]));
    const records: Array<Record<string, string>> = [];
    let current: Record<string, string> = {};
    for (const token of tokens) {
      if (token.startsWith("worktree ") && current.worktree !== undefined) {
        records.push(current);
        current = {};
      }
      const separator = token.indexOf(" ");
      if (separator === -1) current[token] = "";
      else current[token.slice(0, separator)] = token.slice(separator + 1);
    }
    if (current.worktree !== undefined) records.push(current);

    return Promise.all(records.map(async (record) => {
      if (record.worktree === undefined || record.HEAD === undefined) throw new GitReadError("GIT_OUTPUT_INVALID");
      assertGitOid(record.HEAD);
      const branchRef = record.branch ?? null;
      if (branchRef !== null) assertBranchRef(branchRef);
      return {
        pathRealpath: await realpath(record.worktree),
        headOid: record.HEAD,
        branchRef,
        locked: record.locked !== undefined
      };
    }));
  }

  private async observeRepositoryLocation(cwdRealpath: string): Promise<{
    rootRealpath: string;
    commonDirRealpath: string;
  }> {
    const [rootOutput, commonOutput] = await Promise.all([
      this.git.run(cwdRealpath, ["rev-parse", "--path-format=absolute", "--show-toplevel"]),
      this.git.run(cwdRealpath, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    ]);
    return {
      rootRealpath: await realpath(line(rootOutput.stdout)),
      commonDirRealpath: await realpath(line(commonOutput.stdout))
    };
  }

  private parseLogMetadata(expectedOid: string, buffer: Buffer): GitLogEntry {
    const output = line(decodeUtf8(buffer));
    const fields = output.split("\n");
    if (fields.length !== 4) throw new GitReadError("GIT_OUTPUT_INVALID");
    const [oid = "", rawParents = "", authoredAt = "", subject = ""] = fields;
    assertGitOid(oid);
    if (oid !== expectedOid
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?[+-]\d{2}:\d{2}$/.test(authoredAt)
      || Number.isNaN(Date.parse(authoredAt))) {
      throw new GitReadError("GIT_OUTPUT_INVALID");
    }
    const parents = rawParents === "" ? [] : rawParents.split(" ");
    for (const parent of parents) assertGitOid(parent);
    return { oid, parents, subject, authoredAt };
  }
}
