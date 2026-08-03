import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { _electron, type Page } from "@playwright/test";

export type E2EScenario = "two-round-success" | "interrupted-run";

export interface LaunchBranchestraE2EOptions {
  scenario: E2EScenario;
  repositoryRoot: string;
  userDataDir?: string;
  providerPaths?: Partial<Record<"claude" | "codex", string>>;
  executablePath?: string;
}

export interface BranchestraE2EApp {
  userDataDir: string;
  firstWindow(): Promise<Page>;
  chooseRepository(): Promise<void>;
  readManagedWorktreeFile(relativePath: string): string;
  writeManagedWorktreeFile(anchorRelativePath: string, relativePath: string, contents: string): void;
  readRecoveryWorktreeFile(relativePath: string): string;
  managedBranchExists(): Promise<boolean>;
  windowCount(): number;
  crashWorkerForTest(): Promise<void>;
  close(): Promise<void>;
}

function findFile(root: string, relativePath: string): string | null {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (!statSync(path).isDirectory()) continue;
    const candidate = join(path, relativePath);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      const nested = findFile(path, relativePath);
      if (nested) return nested;
    }
  }
  return null;
}

export async function launchBranchestraE2E(
  options: LaunchBranchestraE2EOptions
): Promise<BranchestraE2EApp> {
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), "branchestra-task-e2e-"));
  const environment: Record<string, string> = {
    BRANCHESTRA_E2E: "1",
    BRANCHESTRA_E2E_USER_DATA: userDataDir,
    BRANCHESTRA_E2E_PROJECT_PATH: options.repositoryRoot,
    BRANCHESTRA_E2E_MOCK_SCENARIO: options.scenario
  };
  if (options.providerPaths?.claude) environment.BRANCHESTRA_E2E_CLAUDE_PATH = options.providerPaths.claude;
  if (options.providerPaths?.codex) environment.BRANCHESTRA_E2E_CODEX_PATH = options.providerPaths.codex;
  for (const name of ["PATH", "TMPDIR", "LANG", "LC_ALL"] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  const app = options.executablePath
    ? await _electron.launch({ executablePath: options.executablePath, env: environment })
    : await _electron.launch({ args: [process.cwd()], env: environment });
  return {
    userDataDir,
    firstWindow: () => app.firstWindow(),
    async chooseRepository() {
      const page = await app.firstWindow();
      await page.getByRole("button", { name: "加入專案" }).click();
    },
    readManagedWorktreeFile(relativePath) {
      const root = join(userDataDir, "managed-worktrees");
      const path = findFile(root, relativePath);
      if (!path) throw new Error(`Managed worktree file not found: ${relativePath}`);
      return readFileSync(path, "utf8");
    },
    writeManagedWorktreeFile(anchorRelativePath, relativePath, contents) {
      const root = join(userDataDir, "managed-worktrees");
      const anchor = findFile(root, anchorRelativePath);
      if (!anchor) throw new Error(`Managed worktree anchor not found: ${anchorRelativePath}`);
      const target = join(dirname(anchor), relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents, "utf8");
    },
    readRecoveryWorktreeFile(relativePath) {
      const root = join(userDataDir, "recovery", "worktrees");
      const path = findFile(root, relativePath);
      if (!path) throw new Error(`Recovery worktree file not found: ${relativePath}`);
      return readFileSync(path, "utf8");
    },
    async managedBranchExists() {
      const { stdout } = await import("node:child_process").then(({ execFile }) =>
        new Promise<{ stdout: string }>((resolve, reject) => {
          execFile("/usr/bin/git", ["-C", options.repositoryRoot, "for-each-ref", "--format=%(refname)", "refs/heads/branchestra/"], (error, output) => {
            if (error) reject(error);
            else resolve({ stdout: output });
          });
        }));
      return stdout.trim().length > 0;
    },
    windowCount: () => app.windows().length,
    async crashWorkerForTest() {
      await app.evaluate(() => {
        const controls = (globalThis as typeof globalThis & {
          __branchestraE2E?: { crashWorker(): void };
        }).__branchestraE2E;
        if (!controls) throw new Error("Packaged E2E controls are unavailable");
        controls.crashWorker();
      });
    },
    close: () => app.close()
  };
}

export async function createAndApproveTask(
  page: Page,
  app: BranchestraE2EApp,
  message: `@Claude ${string}` | `@Codex ${string}`
): Promise<void> {
  await app.chooseRepository();
  await page.getByTestId("room-title-input").fill("Task room");
  await page.getByTestId("create-room").click();
  await page.getByLabel("訊息").fill(message);
  await page.getByRole("button", { name: "傳送訊息" }).click();
  await page.getByRole("button", { name: "查看任務" }).first().click();
  await page.getByTestId("task-state").waitFor({ state: "visible", timeout: 5_000 }).catch(async (error) => {
    throw new Error(`Task Inspector unavailable:\n${await page.locator("body").innerText()}`, { cause: error });
  });
  await page.getByRole("button", { name: "核准任務範圍" }).click();
}
